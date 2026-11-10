/**
 * Veyra — authoritative workspace resolution.
 *
 * DSH already owns workspace identity: `ctx.workspaceRegistry` exposes
 * `Workspace` records whose `id` is a generated UUID, whose `path` is the
 * canonical create-time path, and whose `sessionIds` is a header-validated,
 * synchronous view of the sessions the workspace owns. Veyra must use that
 * registry as the authority for room selection.
 *
 * The resolver is intentionally synchronous. Session membership is a plain
 * array read on the registry's cached view; path matching canonicalizes the
 * candidate and compares strings. It never calls `resolveByPath()` (async,
 * creates nothing) and never falls back to a guessed workspace when the
 * registry is present but ambiguous: ambiguity fails closed.
 *
 * There is exactly one storage model: a room keyed by WorkspaceId. The registry
 * is therefore not a preference, it is a precondition. A host with no workspace
 * capability and a host whose registry is broken both fail closed — the first
 * because Veyra cannot name a room, the second because a transient fault must
 * never be mistaken for a permanent answer. `REGISTRY_STATES` keeps those two
 * apart so the diagnostics stay honest, but both refuse to resolve: the legacy
 * `projects/<projectId>` layout is no longer read, written, or migrated, and
 * nothing in this module can reach it.
 *
 * Path containment only ever narrows a candidate set. It can never move a
 * binding from a deeper workspace to a shallower one: when several registered
 * workspaces contain the cwd, the DEEPEST canonical root wins, because a
 * nested workspace is a distinct room and mapping its paths to the parent room
 * would leak one workspace's memory into another.
 */

import {
  canonicalPath,
  isSafeRoomId,
  pathContains,
  roomIdForWorkspaceId,
} from './rooms.mjs'

export const RESOLUTION_MODES = Object.freeze({
  REGISTRY: 'registry',
})

/**
 * Three states, not two. `AVAILABLE` is the only one that permits resolution;
 * `ABSENT` and `UNAVAILABLE` both fail closed. Collapsing `ABSENT` and
 * `UNAVAILABLE` into a single falsy value is what let a broken registry
 * masquerade as a host that never had one — and what then let a legacy fallback
 * write memory into a store the new architecture will never read again.
 */
export const REGISTRY_STATES = Object.freeze({
  AVAILABLE: 'available',
  ABSENT: 'absent',
  UNAVAILABLE: 'unavailable',
})

export const RESOLUTION_SOURCES = Object.freeze({
  SESSION: 'session',
  PATH: 'path',
  CONTAINMENT: 'containment',
})

export const RESOLUTION_FAILURES = Object.freeze({
  AMBIGUOUS_SESSION: 'ambiguous-session-membership',
  AMBIGUOUS_PATH: 'ambiguous-workspace-path',
  UNRESOLVED: 'workspace-unresolved',
  REGISTRY_UNREADABLE: 'workspace-registry-unreadable',
  REGISTRY_NOT_READY: 'workspace-registry-not-ready',
  REGISTRY_MISSING: 'workspace-registry-unavailable',
  NO_CONTEXT: 'workspace-context-missing',
})

export function sessionIdOf(source) {
  const id = source?.session?.id
    ?? source?.agent?.session?.id
    ?? source?.sessionId
    ?? null
  return typeof id === 'string' && id.trim() ? id.trim() : null
}

export function cwdOf(source) {
  const candidates = [
    source?.session?.header?.cwd,
    source?.agent?.session?.header?.cwd,
    source?.header?.cwd,
    source?.cwd,
    source?.agent?.cwd,
    source?.session?.cwd,
  ]
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.trim()) return candidate.trim()
  }
  return null
}

function workspaceIdOf(workspace) {
  return typeof workspace?.id === 'string' && workspace.id.trim() ? workspace.id.trim() : null
}

function workspacePathOf(workspace) {
  return typeof workspace?.path === 'string' && workspace.path.trim() ? workspace.path : null
}

function workspaceSessionIds(workspace) {
  try {
    const ids = workspace?.sessionIds
    return Array.isArray(ids) ? ids : []
  } catch {
    // `sessionIds` is a getter over validated session headers. A host fault
    // here is an unreadable registry, not a workspace with no sessions.
    throw new Error('workspace sessionIds unreadable')
  }
}

function bindingFor(workspace, source, extra = {}) {
  const workspaceId = workspaceIdOf(workspace)
  const workspacePath = workspacePathOf(workspace)
  if (!workspaceId || !workspacePath) return null
  const roomId = roomIdForWorkspaceId(workspaceId)
  if (!isSafeRoomId(roomId)) return null
  return {
    ok: true,
    binding: {
      workspaceId,
      roomId,
      workspacePath: canonicalPath(workspacePath),
      title: typeof workspace.title === 'string' ? workspace.title : '',
      mode: RESOLUTION_MODES.REGISTRY,
      source,
      sessionId: extra.sessionId ?? null,
    },
  }
}

function fail(reason, detail = {}) {
  return { ok: false, reason, ...detail }
}

export function createWorkspaceResolver({ getRegistry } = {}) {

  /**
   * Probe the host for a workspace registry without collapsing the two ways it
   * can be missing.
   *
   * - `ABSENT`   — the getter returned nothing at all. The host never had the
   *                capability. Veyra cannot name a room without an id, so this
   *                fails closed with `workspace-registry-unavailable`; it does
   *                NOT fall back to a path-keyed store.
   * - `UNAVAILABLE` — the getter threw, or returned something without `list`.
   *                The host has the capability but it is not usable right now.
   *                Also fails closed, with `workspace-registry-not-ready`.
   * - `AVAILABLE` — a `list`-bearing registry we can query.
   *
   * The distinction matters because a caller that reports `ABSENT` to an
   * operator must be telling the truth: a transient fault reported as a
   * permanent absence is how a "temporary" workaround becomes permanent.
   */
  function probe() {
    let value
    try {
      value = typeof getRegistry === 'function' ? getRegistry() : getRegistry
    } catch {
      return { state: REGISTRY_STATES.UNAVAILABLE, registry: null }
    }
    if (value === null || value === undefined) {
      return { state: REGISTRY_STATES.ABSENT, registry: null }
    }
    if (typeof value.list !== 'function') {
      return { state: REGISTRY_STATES.UNAVAILABLE, registry: null }
    }
    return { state: REGISTRY_STATES.AVAILABLE, registry: value }
  }

  /**
   * The operator-facing diagnostic. `probe()` answers whether the host exposes
   * a registry at all; this answers whether that registry actually works.
   *
   * A registry that answers the getter but throws from `list()` is declared but
   * unusable — the host's own "not started yet" signal. Reporting it as
   * `AVAILABLE` would tell an operator the opposite of what every resolution
   * does, which is exactly the kind of diagnostic that makes a fault look like
   * a healthy but empty host.
   */
  function state() {
    const probed = probe()
    if (probed.state !== REGISTRY_STATES.AVAILABLE) return probed.state
    try {
      const workspaces = probed.registry.list()
      return Array.isArray(workspaces) ? REGISTRY_STATES.AVAILABLE : REGISTRY_STATES.UNAVAILABLE
    } catch {
      return REGISTRY_STATES.UNAVAILABLE
    }
  }

  function list() {
    const probed = probe()
    if (probed.state !== REGISTRY_STATES.AVAILABLE) return null
    const reg = probed.registry
    try {
      const workspaces = reg.list()
      if (!Array.isArray(workspaces)) return null
      return workspaces.filter((workspace) => workspaceIdOf(workspace) && workspacePathOf(workspace))
    } catch {
      // `list()` refusing is the host's own "not started yet" signal
      // (`workspace registry is not started yet`). It is a registry fault, not
      // an empty registry, and certainly not absent capability.
      return null
    }
  }

  function resolve(source) {
    const sessionId = sessionIdOf(source)
    const cwd = cwdOf(source)
    const { state } = probe()

    if (state === REGISTRY_STATES.ABSENT) {
      // The host never had workspace capability. There is no id to key a room
      // by and no path-keyed store to fall back to, so this refuses. Old
      // `projects/<projectId>` data stays on disk, untouched and unread: the
      // clean break is deliberate, not a migration that has yet to run.
      return fail(RESOLUTION_FAILURES.REGISTRY_MISSING, { cwd })
    }
    // Declared but unusable: the host HAS workspace capability and it is
    // broken. The room model is the only model, so refuse rather than guess.
    if (state === REGISTRY_STATES.UNAVAILABLE) {
      return fail(RESOLUTION_FAILURES.REGISTRY_NOT_READY, { cwd })
    }

    const workspaces = list()
    if (!workspaces) return fail(RESOLUTION_FAILURES.REGISTRY_UNREADABLE)

    if (sessionId) {
      let bySession
      try {
        bySession = workspaces.filter((workspace) => workspaceSessionIds(workspace).includes(sessionId))
      } catch {
        return fail(RESOLUTION_FAILURES.REGISTRY_UNREADABLE)
      }
      if (bySession.length === 1) {
        const resolved = bindingFor(bySession[0], RESOLUTION_SOURCES.SESSION, { sessionId })
        if (resolved) return resolved
      }
      if (bySession.length > 1) {
        return fail(RESOLUTION_FAILURES.AMBIGUOUS_SESSION, {
          candidates: bySession.map(workspaceIdOf),
          sessionId,
        })
      }
    }

    if (!cwd) return fail(RESOLUTION_FAILURES.NO_CONTEXT, { sessionId })

    const canonical = canonicalPath(cwd)
    const byPath = workspaces.filter((workspace) => canonicalPath(workspacePathOf(workspace)) === canonical)
    if (byPath.length === 1) {
      return bindingFor(byPath[0], RESOLUTION_SOURCES.PATH, { sessionId })
        || fail(RESOLUTION_FAILURES.UNRESOLVED, { cwd: canonical })
    }
    if (byPath.length > 1) {
      return fail(RESOLUTION_FAILURES.AMBIGUOUS_PATH, {
        candidates: byPath.map(workspaceIdOf),
        cwd: canonical,
      })
    }

    // A session cwd can be a subdirectory of the workspace root while still
    // belonging to exactly one workspace. Containment may only NARROW the
    // candidate set, never redirect a binding to a shallower workspace: when
    // several registered roots contain the cwd, the deepest root is the one
    // that actually contains it, and a nested workspace is its own room.
    // Mapping a child workspace's paths to the parent room would leak one
    // workspace's memory into another, so the tie is broken by depth, not by
    // falling back to "ambiguous" or to the first match.
    const contained = workspaces.filter((workspace) => pathContains(workspacePathOf(workspace), canonical))
    if (contained.length === 1) {
      return bindingFor(contained[0], RESOLUTION_SOURCES.CONTAINMENT, { sessionId })
        || fail(RESOLUTION_FAILURES.UNRESOLVED, { cwd: canonical })
    }
    if (contained.length > 1) {
      // Deepest canonical root wins. Equal depth under one cwd is only possible
      // when two distinct workspaces are registered at the same path, which is
      // genuinely ambiguous and must fail closed.
      const ranked = contained
        .map((workspace) => ({ workspace, depth: canonicalPath(workspacePathOf(workspace)).length }))
        .sort((left, right) => right.depth - left.depth)
      const deepest = ranked[0]
      const next = ranked[1]
      if (next && next.depth === deepest.depth) {
        return fail(RESOLUTION_FAILURES.AMBIGUOUS_PATH, {
          candidates: contained.map(workspaceIdOf),
          cwd: canonical,
        })
      }
      return bindingFor(deepest.workspace, RESOLUTION_SOURCES.CONTAINMENT, { sessionId })
        || fail(RESOLUTION_FAILURES.UNRESOLVED, { cwd: canonical })
    }

    return fail(RESOLUTION_FAILURES.UNRESOLVED, { cwd: canonical, sessionId })
  }

  /**
   * Resolve a bare filesystem path (WebUI query, migration). Session
   * membership is unavailable here, so this is path/containment only.
   */
  function resolvePath(cwd) {
    if (!cwd) return fail(RESOLUTION_FAILURES.NO_CONTEXT)
    return resolve({ cwd })
  }

  /**
   * The storage model, which is no longer a question. There is one model; the
   * interesting diagnostic is whether the registry behind it is usable, and
   * that is `state()`. Kept as a function so callers that only care about the
   * model (`health()`) do not have to special-case anything, but it cannot
   * report a second model — a legacy answer here would be a lie, because no
   * resolution can reach one.
   */
  function mode() {
    return RESOLUTION_MODES.REGISTRY
  }

  return {
    resolve,
    resolvePath,
    mode,
    state,
    list,
  }
}
