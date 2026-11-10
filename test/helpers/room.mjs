/**
 * Test fixtures for the workspace-room architecture.
 *
 * Production resolves a workspace from the DSH registry; tests need the same
 * shape without booting a host. `fakeRegistry()` answers exactly the surface
 * `src/workspace-resolver.mjs` reads — `list()` returning `{ id, path,
 * sessionIds, title }` — so a test drives the real resolver, the real router,
 * and the real Memory Server instead of a shim that would pass while
 * production breaks.
 *
 * These are TEST-ONLY conveniences. Nothing here is exported from `src/`, and
 * no production path can reach it.
 */

import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createMemoryServer } from '../../src/memory-server.mjs'
import { openCentralStore, openRoomStore } from '../../src/store.mjs'
import { canonicalPath, roomIdForWorkspaceId } from '../../src/rooms.mjs'

/** Deterministic, filesystem-safe workspace id for a path. */
export function testWorkspaceId(path) {
  const digest = createHash('sha256').update(canonicalPath(path)).digest('hex').slice(0, 24)
  return `test-${digest}`
}

/**
 * A registry stand-in over the given paths.
 *
 * `workspaces` is a list of paths, or of `{ path, id }` when a test needs an
 * explicit identity (for example, two workspaces sharing one directory).
 */
export function fakeRegistry(workspaces = []) {
  const entries = workspaces.map((entry) => {
    const path = typeof entry === 'string' ? entry : entry.path
    const id = typeof entry === 'string' ? testWorkspaceId(path) : entry.id || testWorkspaceId(path)
    return {
      id,
      path: canonicalPath(path),
      sessionIds: typeof entry === 'object' && entry !== null ? entry.sessionIds || [] : [],
      title: typeof entry === 'object' && entry !== null ? entry.title || 'test workspace' : 'test workspace',
    }
  })
  return {
    list() {
      return entries.map((entry) => ({ ...entry, sessionIds: [...entry.sessionIds] }))
    },
  }
}

/** The ctx a Memory Server needs when it only has to resolve workspaces. */
export function fakeContext(workspaces = []) {
  return { workspaceRegistry: fakeRegistry(workspaces) }
}

/** Room store for the workspace that owns `path`. */
export function roomStore(home, path) {
  return openRoomStore(home, roomIdForWorkspaceId(testWorkspaceId(path)))
}

/** Central Memories store. */
export function centralStore(home) {
  return openCentralStore(home)
}

/**
 * A temporary Veyra home plus the workspace paths registered in it.
 *
 * Removes itself on `t.after`, so callers never leak SQLite files.
 */
export function testHome(t, prefix = 'veyra-room-') {
  const home = mkdtempSync(join(tmpdir(), prefix))
  mkdirSync(home, { recursive: true })
  t.after(() => rmSync(home, { recursive: true, force: true }))
  return home
}

/**
 * A runtime wired to a real Memory Server over `paths`.
 *
 * `paths` defaults to `[cwd]`, which is what almost every tool test wants: the
 * agent's own workspace is the only room in the registry, so a resolved store
 * is unambiguous.
 *
 * Tool tests habitually call `execute(args, exec)` with an `exec` that carries
 * no agent session, because the legacy path-keyed store needed no identity.
 * Production always has an agent with a `session.header.cwd`, so the server's
 * `storesFor()` is wrapped to stand in that missing context with the workspace
 * the fixture registered. The fallback fires ONLY on `workspace-context-missing`
 * — a registry fault, an ambiguous path, or any other refusal still propagates
 * untouched, so this convenience can never mask a real resolution failure.
 * Tests that want the genuine session path pass `agentFor(cwd)` themselves.
 */
export function testRuntime(home, cwd, options = {}) {
  const { paths, log, ...runtimeOptions } = options
  const workspaces = paths || [cwd]
  const ctx = fakeContext(workspaces)
  const runtime = {
    veyraHome: home,
    fallbackCwd: cwd,
    codeEngine: { isDegraded: true },
    log: log || { debug: () => {}, warn: () => {}, info: () => {} },
    ...runtimeOptions,
  }
  const server = createMemoryServer({ ctx, runtime })

  const rawStoresFor = server.storesFor.bind(server)
  server.storesFor = (agent, operation) => {
    const resolved = rawStoresFor(agent, operation)
    if (resolved.ok || resolved.reason !== 'workspace-context-missing') return resolved
    return server.storesForPath(cwd, operation)
  }

  runtime.memoryServer = server
  runtime.server = server
  return runtime
}

/** An agent source the resolver will accept for `cwd`. */
export function agentFor(cwd, sessionId = 'test-session') {
  return { session: { id: sessionId, header: { cwd } } }
}

/**
 * Runtime plus the stores a test usually seeds.
 *
 * Returned together because a test that seeds into one store and drives a
 * runtime with another would pass while proving nothing.
 */
export function testRuntimeWithStores(t, cwd, options = {}) {
  const home = testHome(t, options.prefix)
  const runtime = testRuntime(home, cwd, options)
  return {
    home,
    runtime,
    roomId: roomIdForWorkspaceId(testWorkspaceId(cwd)),
    store: roomStore(home, cwd),
    central: centralStore(home),
  }
}

/** Room id for the workspace that owns `path`. */
export function roomIdFor(path) {
  return roomIdForWorkspaceId(testWorkspaceId(path))
}
