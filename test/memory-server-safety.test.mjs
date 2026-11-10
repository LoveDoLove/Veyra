/**
 * Memory Server safety: the failure modes that must never widen access.
 *
 * Four groups, all of them about isolation under abnormal conditions:
 *
 *   1. Registry failure must fail closed.
 *   2. Workspace switching must not reuse a room.
 *   3. Nested workspaces must never collapse into the parent.
 *   4. Legacy data must stay invisible to the new architecture.
 *
 * Every test builds its own temp home and temp workspace tree; nothing here
 * touches a real Veyra home.
 *
 * Since the clean break there is exactly one storage model — a room keyed by a
 * DSH WorkspaceId. The pre-clean-break version of this file asserted that a
 * host without a registry fell back to `$VEYRA_HOME/projects/<projectId>`.
 * That fallback is gone: no registry means no room, and the resolver refuses.
 */

import { afterEach, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import {
  createWorkspaceResolver,
  REGISTRY_STATES,
  RESOLUTION_FAILURES,
  RESOLUTION_MODES,
  RESOLUTION_SOURCES,
} from '../src/workspace-resolver.mjs'
import { createMemoryServer } from '../src/memory-server.mjs'
import { roomIdForWorkspaceId } from '../src/rooms.mjs'
import { closeAllStores } from '../src/store.mjs'
import { projectIdFor } from '../src/ids.mjs'

const HOMES = []

afterEach(() => {
  closeAllStores()
  HOMES.length = 0
})

function makeHome() {
  const home = mkdtempSync(join(tmpdir(), 'veyra-safety-home-'))
  HOMES.push(home)
  return home
}

function makeTree() {
  const root = mkdtempSync(join(tmpdir(), 'veyra-safety-ws-'))
  const repo = join(root, 'repo')
  mkdirSync(join(repo, '.git'), { recursive: true })
  const child = join(repo, 'packages', 'app')
  mkdirSync(join(child, 'src'), { recursive: true })
  return { root, repo, child, childSrc: join(child, 'src') }
}

function registryOf(workspaces) {
  return {
    list: () => workspaces.map((workspace) => ({
      id: workspace.id,
      path: workspace.path,
      title: workspace.title || '',
      sessionIds: workspace.sessionIds || [],
    })),
  }
}

const ID_PARENT = '11111111-1111-4111-8111-111111111111'
const ID_CHILD = '22222222-2222-4222-8222-222222222222'

/* ------------------------------------------------------------------ *
 * 1. Registry failure must fail closed
 * ------------------------------------------------------------------ */

describe('registry failure is a fault, not missing capability', () => {
  test('a throwing registry never falls back to the legacy layout', () => {
    const { repo } = makeTree()
    const resolver = createWorkspaceResolver({
      getRegistry: () => { throw new Error('workspace registry is not started yet') },
    })
    const resolved = resolver.resolve({ cwd: repo })
    assert.equal(resolved.ok, false)
    assert.equal(resolved.reason, RESOLUTION_FAILURES.REGISTRY_NOT_READY)
    // A fault has no binding at all — not a legacy one, not an empty one.
    assert.equal(resolved.binding, undefined)
    // There is exactly one storage model now, so the model accessor cannot
    // report a second one. Regressing this to 'legacy' would mean a resolution
    // reached legacy code, which it never can.
    assert.equal(resolver.mode(), RESOLUTION_MODES.REGISTRY)
    assert.equal(resolver.state(), REGISTRY_STATES.UNAVAILABLE)
  })

  test('a registry object without list() is a fault, not empty capability', () => {
    const { repo } = makeTree()
    const resolver = createWorkspaceResolver({ getRegistry: () => ({}) })
    assert.equal(resolver.state(), REGISTRY_STATES.UNAVAILABLE)
    const resolved = resolver.resolve({ cwd: repo })
    assert.equal(resolved.ok, false)
    assert.equal(resolved.reason, RESOLUTION_FAILURES.REGISTRY_NOT_READY)
  })

  test('a registry whose list() throws (not started) fails closed', () => {
    const { repo } = makeTree()
    const resolver = createWorkspaceResolver({
      getRegistry: () => ({ list: () => { throw new Error('workspace registry is not started yet') } }),
    })
    const resolved = resolver.resolve({ cwd: repo })
    assert.equal(resolved.ok, false)
    assert.equal(resolved.reason, RESOLUTION_FAILURES.REGISTRY_UNREADABLE)
    // Regression: the state diagnostic must agree with what resolution did.
    // It used to answer from the getter alone, so a registry that threw from
    // `list()` reported `available` while every resolution failed — a health
    // check that lies in the reassuring direction.
    assert.equal(resolver.state(), REGISTRY_STATES.UNAVAILABLE)
  })

  // Clean Break regression. Before the clean break this case returned
  // `{ ok: true, binding: { mode: 'legacy', roomId: 'legacy_<hash>' } }` and
  // the caller then opened `projects/<projectId>/memory.db`. Both the binding
  // and that store are gone: the absence of a capability is a refusal, not an
  // invitation to guess an identity from a filesystem path.
  test('a genuinely absent registry fails closed instead of inventing a room', () => {
    const { repo } = makeTree()
    for (const getRegistry of [() => null, () => undefined, null]) {
      const resolver = createWorkspaceResolver({ getRegistry })
      // The diagnostic still distinguishes permanent absence from a fault...
      assert.equal(resolver.state(), REGISTRY_STATES.ABSENT)
      // ...but neither may produce a room.
      assert.equal(resolver.mode(), RESOLUTION_MODES.REGISTRY)
      const resolved = resolver.resolve({ cwd: repo })
      assert.equal(resolved.ok, false)
      assert.equal(resolved.reason, RESOLUTION_FAILURES.REGISTRY_MISSING)
      assert.equal(resolved.binding, undefined)
    }
  })

  test('the memory server refuses to fall back when the host declares a broken registry', () => {
    const home = makeHome()
    const { repo } = makeTree()
    // Declared in the reflect table but unobtainable: a fault, not a legacy host.
    const ctx = {
      reflect: { props: { workspaceRegistry: { type: 'service' } } },
      get workspaceRegistry() { throw new Error('cannot get property "workspaceRegistry" without inject') },
    }
    const server = createMemoryServer({ ctx, runtime: { veyraHome: home, fallbackCwd: repo } })
    assert.equal(server.resolver.state(), REGISTRY_STATES.UNAVAILABLE)
    // The decisive assertion: no room may be created for this cwd.
    const resolved = server.resolvePath(repo)
    assert.equal(resolved.ok, false)
    assert.equal(resolved.reason, RESOLUTION_FAILURES.REGISTRY_NOT_READY)
    assert.equal(existsSync(join(home, 'rooms')) && readdirSync(join(home, 'rooms')).length > 0, false)
    // Health must not describe a broken registry as a legacy host.
    assert.equal(server.health().registryState, REGISTRY_STATES.UNAVAILABLE)
  })

  // Regression, found by probe-clean-break.mjs: a registry that exists and has
  // `list` but throws from it (the host's own "not started yet") reported
  // `registryState: available` through health() while every resolvePath failed
  // with `workspace-registry-unreadable`. A health check must not describe a
  // broken registry as a healthy one; that is the failure mode that lets an
  // outage be mistaken for an empty host.
  test('health reports a not-started registry as unavailable, never as available', () => {
    const home = makeHome()
    const { repo } = makeTree()
    const server = createMemoryServer({
      ctx: { workspaceRegistry: { list() { throw new Error('workspace registry is not started yet') } } },
      runtime: { veyraHome: home, fallbackCwd: repo },
    })
    assert.equal(server.health().registryState, REGISTRY_STATES.UNAVAILABLE)
    // Health and resolution must agree. This is the whole point of the check.
    assert.equal(server.health().registryAvailable, false)
    assert.equal(server.resolvePath(repo).reason, RESOLUTION_FAILURES.REGISTRY_UNREADABLE)
  })

  // Clean Break regression, same shape as above for permanent absence: the
  // server is allowed to exist (so /veyra health can explain itself) but every
  // resolution must refuse, and no directory may be created on its behalf.
  test('the memory server accepts a host that never declared a workspace service', () => {
    const home = makeHome()
    const { repo } = makeTree()
    const server = createMemoryServer({
      ctx: { reflect: { props: {} } },
      runtime: { veyraHome: home, fallbackCwd: repo },
    })
    assert.equal(server.resolver.state(), REGISTRY_STATES.ABSENT)
    assert.equal(server.health().mode, RESOLUTION_MODES.REGISTRY)
    assert.equal(server.health().registryState, REGISTRY_STATES.ABSENT)
    const resolved = server.resolvePath(repo)
    assert.equal(resolved.ok, false)
    assert.equal(resolved.reason, RESOLUTION_FAILURES.REGISTRY_MISSING)
    assert.equal(existsSync(join(home, 'projects')), false)
    assert.equal(existsSync(join(home, 'rooms')), false)
  })

  // The room token is derived, never taken from a caller. A workspace id with
  // path characters must be hashed into an opaque token rather than allowed to
  // escape the rooms directory.
  test('a workspace id is never used as a filesystem path', () => {
    const home = makeHome()
    const { repo } = makeTree()
    const traversal = '../../../../etc/veyra'
    const registry = registryOf([{ id: traversal, path: repo, sessionIds: ['session-a'] }])
    const server = createMemoryServer({
      ctx: { get: (name) => (name === 'workspaceRegistry' ? registry : null) },
      runtime: { veyraHome: home, fallbackCwd: repo },
    })
    const resolved = server.resolvePath(repo)
    assert.equal(resolved.ok, true)
    // Not the raw id: prefixing or hashing keeps it inside rooms/.
    assert.notEqual(resolved.binding.roomId, traversal)
    assert.equal(resolved.binding.roomId.includes('..'), false)
    assert.equal(resolved.binding.roomId.includes('/'), false)
    assert.match(resolved.binding.roomId, /^w_/)
  })
})

/* ------------------------------------------------------------------ *
 * 2. Workspace switching must not reuse a room
 * ------------------------------------------------------------------ */

describe('workspace switching', () => {
  test('the same repository resolves to two different rooms for two workspaces', () => {
    const home = makeHome()
    const { repo } = makeTree()
    const registry = registryOf([
      { id: ID_PARENT, path: repo, sessionIds: ['session-a'] },
      { id: ID_CHILD, path: repo, sessionIds: ['session-b'] },
    ])
    const server = createMemoryServer({
      ctx: { get: (name) => (name === 'workspaceRegistry' ? registry : null) },
      runtime: { veyraHome: home, fallbackCwd: repo },
    })
    const a = server.storesFor({ session: { id: 'session-a' } })
    const b = server.storesFor({ session: { id: 'session-b' } })
    assert.equal(a.ok, true)
    assert.equal(b.ok, true)
    assert.equal(a.roomId, roomIdForWorkspaceId(ID_PARENT))
    assert.equal(b.roomId, roomIdForWorkspaceId(ID_CHILD))
    assert.notEqual(a.projectStore.filePath, b.projectStore.filePath)
  })

  test('switching back returns to the first room, with its own binding', () => {
    const home = makeHome()
    const { repo } = makeTree()
    const registry = registryOf([
      { id: ID_PARENT, path: repo, sessionIds: ['session-a'] },
      { id: ID_CHILD, path: join(repo, 'other'), sessionIds: ['session-b'] },
    ])
    mkdirSync(join(repo, 'other'), { recursive: true })
    const server = createMemoryServer({
      ctx: { get: (name) => (name === 'workspaceRegistry' ? registry : null) },
      runtime: { veyraHome: home, fallbackCwd: repo },
    })
    const first = server.storesFor({ session: { id: 'session-a' } })
    const second = server.storesFor({ session: { id: 'session-b' } })
    const back = server.storesFor({ session: { id: 'session-a' } })
    assert.equal(back.roomId, first.roomId)
    assert.notEqual(back.roomId, second.roomId)
    assert.equal(back.projectStore.filePath, first.projectStore.filePath)
  })

  test('a session that moves workspace follows the session, not the stale cwd', () => {
    const home = makeHome()
    const { repo, child } = makeTree()
    const registry = registryOf([
      { id: ID_PARENT, path: repo, sessionIds: ['session-a'] },
      { id: ID_CHILD, path: child },
    ])
    const server = createMemoryServer({
      ctx: { get: (name) => (name === 'workspaceRegistry' ? registry : null) },
      runtime: { veyraHome: home, fallbackCwd: repo },
    })
    // The session id is authoritative. Its header still says `child`, which
    // would resolve to the child room on path evidence alone; membership wins.
    const resolved = server.storesFor({ session: { id: 'session-a', header: { cwd: child } } })
    assert.equal(resolved.ok, true)
    assert.equal(resolved.roomId, roomIdForWorkspaceId(ID_PARENT))
    assert.equal(resolved.binding.source, RESOLUTION_SOURCES.SESSION)
  })
})

/* ------------------------------------------------------------------ *
 * 3. Nested workspaces never collapse into the parent
 * ------------------------------------------------------------------ */

describe('nested workspaces never collapse into the parent', () => {
  test('a cwd inside the child resolves to the child room, not the parent', () => {
    const { repo, child, childSrc } = makeTree()
    const resolver = createWorkspaceResolver({
      getRegistry: () => registryOf([
        { id: ID_PARENT, path: repo },
        { id: ID_CHILD, path: child },
      ]),
    })
    const resolved = resolver.resolve({ cwd: childSrc })
    assert.equal(resolved.ok, true)
    assert.equal(resolved.binding.workspaceId, ID_CHILD)
    assert.equal(resolved.binding.source, RESOLUTION_SOURCES.CONTAINMENT)
  })

  test('the parent workspace still resolves for a cwd outside the child', () => {
    const { repo, child } = makeTree()
    const docs = join(repo, 'docs')
    mkdirSync(docs, { recursive: true })
    const resolver = createWorkspaceResolver({
      getRegistry: () => registryOf([
        { id: ID_PARENT, path: repo },
        { id: ID_CHILD, path: child },
      ]),
    })
    const resolved = resolver.resolve({ cwd: docs })
    assert.equal(resolved.ok, true)
    assert.equal(resolved.binding.workspaceId, ID_PARENT)
    assert.equal(resolved.binding.source, RESOLUTION_SOURCES.CONTAINMENT)
  })

  test('three levels of nesting pick the deepest registered root', () => {
    const { repo, child, childSrc } = makeTree()
    const deep = join(childSrc, 'deep')
    mkdirSync(deep, { recursive: true })
    const resolver = createWorkspaceResolver({
      getRegistry: () => registryOf([
        { id: ID_PARENT, path: repo },
        { id: ID_CHILD, path: child },
        { id: '33333333-3333-4333-8333-333333333333', path: deep },
      ]),
    })
    // Exact path wins before containment is even considered.
    const exact = resolver.resolve({ cwd: deep })
    assert.equal(exact.binding.workspaceId, '33333333-3333-4333-8333-333333333333')
    assert.equal(exact.binding.source, RESOLUTION_SOURCES.PATH)

    // One level up, containment must still pick the deepest containing root.
    const contained = resolver.resolve({ cwd: join(childSrc, 'deeper') })
    assert.equal(contained.binding.workspaceId, ID_CHILD)
  })

  test('a child workspace that is not registered does not invent a room', () => {
    const { repo, childSrc } = makeTree()
    const resolver = createWorkspaceResolver({
      getRegistry: () => registryOf([{ id: ID_PARENT, path: repo }]),
    })
    const resolved = resolver.resolve({ cwd: childSrc })
    assert.equal(resolved.ok, true)
    // The parent IS the only registered root containing this cwd; mapping the
    // path there is correct. What must never happen is inventing a child room.
    assert.equal(resolved.binding.workspaceId, ID_PARENT)
    assert.equal(resolved.binding.roomId, roomIdForWorkspaceId(ID_PARENT))
  })

  test('two workspaces at the same path remain ambiguous (no containment guess)', () => {
    const { repo } = makeTree()
    const resolver = createWorkspaceResolver({
      getRegistry: () => registryOf([
        { id: ID_PARENT, path: repo },
        { id: ID_CHILD, path: repo },
      ]),
    })
    const resolved = resolver.resolve({ cwd: repo })
    assert.equal(resolved.ok, false)
    assert.equal(resolved.reason, RESOLUTION_FAILURES.AMBIGUOUS_PATH)
  })
})

/* ------------------------------------------------------------------ *
 * 4. Legacy data stays invisible
 * ------------------------------------------------------------------ */

describe('legacy data isolation', () => {
  // Legacy Isolation regression, replacing the deleted migration and
  // quarantine suites. The old `projects/` and `reusable/` databases are the
  // one thing the clean break promises never to touch: not read, not migrated,
  // not merged, not deleted. A populated legacy tree is planted with plain fs
  // and must be byte-identical afterwards.
  test('a populated legacy tree is never read, migrated or modified', () => {
    const home = makeHome()
    const { repo } = makeTree()

    const legacyProjectId = projectIdFor(repo)
    const legacyDir = join(home, 'projects', legacyProjectId)
    mkdirSync(legacyDir, { recursive: true })
    const legacyFile = join(legacyDir, 'memory.db')
    writeFileSync(legacyFile, 'legacy-placeholder-not-a-real-db')
    const reusableDir = join(home, 'reusable')
    mkdirSync(reusableDir, { recursive: true })
    const reusableFile = join(reusableDir, 'memory.db')
    writeFileSync(reusableFile, 'legacy-reusable-placeholder')
    const projectsBefore = readdirSync(join(home, 'projects')).sort()
    const homeBefore = readdirSync(home).sort()

    const registry = registryOf([{ id: ID_PARENT, path: repo, sessionIds: ['session-a'] }])
    const server = createMemoryServer({
      ctx: { get: (name) => (name === 'workspaceRegistry' ? registry : null) },
      runtime: { veyraHome: home, fallbackCwd: repo },
    })
    const stores = server.storesFor({ session: { id: 'session-a' } })
    assert.equal(stores.ok, true)
    assert.equal(stores.projectStore.list({ limit: 50 }).length, 0)

    // Nothing outside the new layout appeared; nothing old changed. The new
    // layout is exactly `rooms/` plus `central/`, and neither is inside the
    // legacy trees.
    assert.deepEqual(readdirSync(join(home, 'projects')).sort(), projectsBefore)
    const added = readdirSync(home).filter((name) => !homeBefore.includes(name)).sort()
    assert.deepEqual(added, ['central', 'rooms'])
    assert.equal(readFileSync(legacyFile, 'utf8'), 'legacy-placeholder-not-a-real-db')
    assert.equal(readFileSync(reusableFile, 'utf8'), 'legacy-reusable-placeholder')
    assert.equal(existsSync(join(home, 'migrations')), false)
  })

  test('a legacy host cannot reach old records through a room store', () => {
    const home = makeHome()
    const { repo } = makeTree()
    const legacyProjectId = projectIdFor(repo)
    const legacyDir = join(home, 'projects', legacyProjectId)
    mkdirSync(legacyDir, { recursive: true })
    writeFileSync(join(legacyDir, 'memory.db'), 'not-a-database')

    // No registry: there is no room to open, and the legacy database is not a
    // substitute for one.
    const server = createMemoryServer({
      ctx: { reflect: { props: {} } },
      runtime: { veyraHome: home, fallbackCwd: repo },
    })
    const refused = server.storesFor({ session: { id: 'session-a' } })
    assert.equal(refused.ok, false)
    assert.equal(refused.reason, RESOLUTION_FAILURES.REGISTRY_MISSING)
    assert.equal(refused.projectStore, undefined)
  })
})

/* ------------------------------------------------------------------ *
 * 5. Every model tool refuses cleanly without a Memory Server
 * ------------------------------------------------------------------ */

describe('every veyra tool refuses instead of dereferencing a missing server', () => {
  // Regression, found by /tmp/verify-tools2.mjs during m00186. Every tool went
  // through `storesFor`, which checked for the server first — except
  // `storesForRepository`, which wrote `requireStores(server,
  // server.storesForPath(…))`. Arguments evaluate before the call, so with no
  // server the two repository tools raised a raw TypeError instead of the
  // `VEYRA_MEMORY_UNAVAILABLE` refusal the rest of the surface produces. A
  // caller cannot tell "you have no memory" from "this plugin is broken".
  test('all eleven veyra tools throw VEYRA_MEMORY_UNAVAILABLE, none a TypeError', async () => {
    const { buildToolDefinitions } = await import('../src/tools.mjs')
    const runtime = { veyraHome: '/nonexistent-veyra-home', fallbackCwd: '/nonexistent-cwd' }
    const tools = buildToolDefinitions(runtime).filter((tool) => tool.name.startsWith('veyra_'))
    assert.equal(tools.length, 11, 'the model-facing veyra surface is eleven tools')

    const misfired = []
    for (const tool of tools) {
      try {
        await tool.execute({}, {})
        misfired.push(`${tool.name}: returned instead of refusing`)
      } catch (err) {
        if (err.code !== 'VEYRA_MEMORY_UNAVAILABLE') {
          misfired.push(`${tool.name}: threw ${err.code || err.name} (${String(err.message).slice(0, 80)})`)
        }
      }
    }
    assert.deepEqual(misfired, [], 'every tool must refuse through the same channel')
  })
})
