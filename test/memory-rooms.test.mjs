/**
 * Memory Server / Workspace Rooms / Central Memories.
 *
 * These tests exercise the isolation invariant with two real workspaces that
 * live under one git repository (so a path-derived project id collapses them
 * to the same value). Room identity must still separate them.
 *
 * Since the clean break there is exactly one storage model: a room keyed by a
 * DSH WorkspaceId. A host with no workspace registry has no rooms, so the
 * resolver fails closed rather than inventing a legacy binding.
 */

import { afterEach, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { canonicalPath, roomIdForWorkspaceId } from '../src/rooms.mjs'
import { createWorkspaceResolver, RESOLUTION_FAILURES } from '../src/workspace-resolver.mjs'
import { createMemoryRouter, MEMORY_OPERATIONS } from '../src/memory-router.mjs'
import { createMemoryServer } from '../src/memory-server.mjs'
import { promoteRecord, PROMOTION_FAILURES } from '../src/promotion.mjs'
import { openCentralStore, closeAllStores, openRoomStore } from '../src/store.mjs'
import { contentHash, projectDbPath, projectIdFor } from '../src/ids.mjs'

const HOMES = []

afterEach(() => {
  closeAllStores()
  while (HOMES.length) {
    const home = HOMES.pop()
    try {
      // Leave the temp tree for the OS; removing it while SQLite WAL files may
      // still be closing is flakier than letting tmpdir clean itself.
      void home
    } catch {}
  }
})

function makeHome() {
  const home = mkdtempSync(join(tmpdir(), 'veyra-rooms-home-'))
  HOMES.push(home)
  return home
}

function makeWorkspaces() {
  const root = mkdtempSync(join(tmpdir(), 'veyra-rooms-ws-'))
  const repo = join(root, 'repo')
  mkdirSync(join(repo, '.git'), { recursive: true })
  const a = join(repo, 'a')
  const b = join(repo, 'b')
  mkdirSync(a, { recursive: true })
  mkdirSync(b, { recursive: true })
  return { root, repo, a, b }
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

function record(overrides = {}) {
  return {
    kind: 'knowledge',
    status: 'current',
    validation: 'reviewed',
    authority: 'derived',
    confidence: 'medium',
    scope: 'project',
    title: 'Writer timeout',
    body: 'The writer retries with exponential backoff; tests fail if the queue is closed.',
    tags: ['writer'],
    evidence: [{ note: 'observed in test/writer.test.mjs' }],
    source: {},
    ...overrides,
  }
}

describe('workspace resolver', () => {
  test('session membership is authoritative over cwd', () => {
    const { a, b } = makeWorkspaces()
    const idA = '11111111-1111-4111-8111-111111111111'
    const idB = '22222222-2222-4222-8222-222222222222'
    const resolver = createWorkspaceResolver({
      getRegistry: () => registryOf([
        { id: idA, path: a, sessionIds: ['session-a'] },
        { id: idB, path: b, sessionIds: ['session-b'] },
      ]),
    })
    const resolved = resolver.resolve({ session: { id: 'session-b', header: { cwd: a } } })
    assert.equal(resolved.ok, true)
    assert.equal(resolved.binding.workspaceId, idB)
    assert.equal(resolved.binding.roomId, roomIdForWorkspaceId(idB))
    assert.equal(resolved.binding.source, 'session')
  })

  test('canonical path resolves when session membership is absent', () => {
    const { a } = makeWorkspaces()
    const idA = '11111111-1111-4111-8111-111111111111'
    const resolver = createWorkspaceResolver({
      getRegistry: () => registryOf([{ id: idA, path: a }]),
    })
    const resolved = resolver.resolve({ cwd: a })
    assert.equal(resolved.ok, true)
    assert.equal(resolved.binding.workspaceId, idA)
    assert.equal(resolved.binding.source, 'path')
  })

  test('a nested cwd resolves by unique containment', () => {
    const { a } = makeWorkspaces()
    const nested = join(a, 'packages', 'core')
    mkdirSync(nested, { recursive: true })
    const idA = '11111111-1111-4111-8111-111111111111'
    const resolver = createWorkspaceResolver({
      getRegistry: () => registryOf([{ id: idA, path: a }]),
    })
    const resolved = resolver.resolve({ cwd: nested })
    assert.equal(resolved.ok, true)
    assert.equal(resolved.binding.workspaceId, idA)
    assert.equal(resolved.binding.source, 'containment')
  })

  test('ambiguous path fails closed', () => {
    const { a } = makeWorkspaces()
    const resolver = createWorkspaceResolver({
      getRegistry: () => registryOf([
        { id: '11111111-1111-4111-8111-111111111111', path: a },
        { id: '22222222-2222-4222-8222-222222222222', path: a },
      ]),
    })
    const resolved = resolver.resolve({ cwd: a })
    assert.equal(resolved.ok, false)
    assert.equal(resolved.reason, RESOLUTION_FAILURES.AMBIGUOUS_PATH)
  })

  // Clean-break regression: the pre-clean-break resolver answered this input
  // with a fabricated `legacy_*` room derived from the filesystem path. There
  // is no room without a workspace id, so the only correct answer is refusal.
  test('no workspace registry fails closed instead of inventing a room', () => {
    const { a } = makeWorkspaces()
    const resolver = createWorkspaceResolver({ getRegistry: () => null })
    const resolved = resolver.resolve({ cwd: a })
    assert.equal(resolved.ok, false)
    assert.equal(resolved.reason, RESOLUTION_FAILURES.REGISTRY_MISSING)
    assert.equal(resolved.binding, undefined)
    assert.equal(resolver.mode(), 'registry')
  })
})

describe('memory router', () => {
  const binding = {
    roomId: 'w_room-a',
    workspaceId: '11111111-1111-4111-8111-111111111111',
    workspacePath: '/repo/a',
    mode: 'registry',
  }

  test('automatic learning cannot write Central Memories', () => {
    const router = createMemoryRouter()
    const decision = router.decide(MEMORY_OPERATIONS.LEARN_AUTO, binding)
    assert.equal(decision.ok, true)
    assert.deepEqual(
      decision.targets.map((target) => `${target.kind}:${target.access}`),
      ['workspace:write'],
    )
    assert.equal(router.decide(MEMORY_OPERATIONS.LEARN_AUTO, binding, { target: 'central' }).ok, false)
  })

  test('cross-workspace requests are denied', () => {
    const router = createMemoryRouter()
    assert.equal(router.decide(MEMORY_OPERATIONS.RECALL_MANUAL, binding, { roomId: 'w_room-b' }).ok, false)
    assert.equal(
      router.decide(MEMORY_OPERATIONS.RECALL_MANUAL, binding, { workspaceId: 'other' }).ok,
      false,
    )
  })

  test('promotion reads the room and writes Central', () => {
    const router = createMemoryRouter()
    const decision = router.decide(MEMORY_OPERATIONS.PROMOTE, binding)
    assert.equal(decision.ok, true)
    assert.deepEqual(
      decision.targets.map((target) => `${target.kind}:${target.access}`),
      ['workspace:read', 'central:write'],
    )
  })

  test('unknown operations fail closed', () => {
    const router = createMemoryRouter()
    assert.equal(router.decide('delete-everything', binding).ok, false)
  })

  // Clean-break regression: migration was a router operation with a write
  // target outside the room. It no longer exists, so a caller that still asks
  // for it must be refused rather than resurrected.
  test('the removed migration operation is not routable', () => {
    const router = createMemoryRouter()
    assert.equal(MEMORY_OPERATIONS.MIGRATE, undefined)
    assert.equal(router.decide('migrate', binding).ok, false)
    assert.equal(router.decide('migrate', binding).reason, 'unknown-operation')
  })
})

describe('workspace room isolation', () => {
  test('two workspaces on one repository get separate rooms and separate records', () => {
    const home = makeHome()
    const { a, b } = makeWorkspaces()
    const idA = '11111111-1111-4111-8111-111111111111'
    const idB = '22222222-2222-4222-8222-222222222222'
    const registry = registryOf([
      { id: idA, path: a, sessionIds: ['session-a'] },
      { id: idB, path: b, sessionIds: ['session-b'] },
    ])
    const server = createMemoryServer({
      ctx: { get: (name) => (name === 'workspaceRegistry' ? registry : null) },
      runtime: { veyraHome: home, fallbackCwd: a },
    })

    const storesA = server.storesFor({ session: { id: 'session-a' } }, MEMORY_OPERATIONS.WRITE_MANUAL)
    const storesB = server.storesFor({ session: { id: 'session-b' } }, MEMORY_OPERATIONS.WRITE_MANUAL)
    assert.equal(storesA.ok, true)
    assert.equal(storesB.ok, true)
    assert.notEqual(storesA.roomId, storesB.roomId)
    assert.match(storesA.projectStore.filePath, /rooms\/w_/)

    const written = storesA.projectStore.put(record({
      title: 'Only workspace A',
      source: { workspace: canonicalPath(a) },
    }))
    assert.equal(storesA.projectStore.get(written.record.id).title, 'Only workspace A')
    assert.equal(storesB.projectStore.get(written.record.id), null)
    assert.equal(storesB.projectStore.list({ limit: 50 }).length, 0)
  })

  test('an unresolved workspace fails closed instead of borrowing a room', () => {
    const home = makeHome()
    const { a } = makeWorkspaces()
    const registry = registryOf([
      { id: '11111111-1111-4111-8111-111111111111', path: a, sessionIds: ['session-a'] },
    ])
    const server = createMemoryServer({
      ctx: { get: (name) => (name === 'workspaceRegistry' ? registry : null) },
      runtime: { veyraHome: home, fallbackCwd: a },
    })
    const resolved = server.storesFor({ session: { id: 'unknown-session', header: { cwd: '/nowhere' } } })
    assert.equal(resolved.ok, false)
  })
})

describe('legacy data isolation', () => {
  // Legacy Isolation regression. `projects/<projectId>/memory.db` and
  // `reusable/memory.db` are no longer part of the read path: they are never
  // opened, imported, merged, or deleted. This test plants a populated legacy
  // database and proves that (1) nothing reads it, (2) nothing rewrites it,
  // and (3) it is still byte-for-byte on disk afterwards.
  test('a populated legacy project database is never read, migrated or altered', () => {
    const home = makeHome()
    const { a } = makeWorkspaces()
    const legacyProjectId = projectIdFor(a)

    // Written with plain fs, not through the product: this is the shape an old
    // Veyra install left behind, and no product code path may touch it.
    const legacyDir = join(home, 'projects', legacyProjectId)
    mkdirSync(legacyDir, { recursive: true })
    const legacyFile = join(legacyDir, 'memory.db')
    writeFileSync(legacyFile, 'legacy-placeholder-not-a-real-db')
    const before = readdirSync(legacyDir).sort()

    const idA = '11111111-1111-4111-8111-111111111111'
    const registry = registryOf([{ id: idA, path: a, sessionIds: ['session-a'] }])
    const server = createMemoryServer({
      ctx: { get: (name) => (name === 'workspaceRegistry' ? registry : null) },
      runtime: { veyraHome: home, fallbackCwd: a },
    })

    const stores = server.storesFor({ session: { id: 'session-a' } }, MEMORY_OPERATIONS.RECALL_MANUAL)
    assert.equal(stores.ok, true)
    // The room is a different database in a different directory.
    assert.notEqual(stores.projectStore.filePath, legacyFile)
    assert.equal(stores.projectStore.list({ limit: 50 }).length, 0)

    // Nothing new appeared under projects/, and the planted bytes are intact.
    assert.deepEqual(readdirSync(legacyDir).sort(), before)
    assert.equal(readFileSync(legacyFile, 'utf8'), 'legacy-placeholder-not-a-real-db')
    // No migration or central-import ledger was ever created.
    assert.equal(readdirSync(home).includes('migrations'), false)
  })

  test('the health report never claims a legacy mode', () => {
    const home = makeHome()
    const { a } = makeWorkspaces()
    const idA = '11111111-1111-4111-8111-111111111111'
    const registry = registryOf([{ id: idA, path: a, sessionIds: ['session-a'] }])
    const server = createMemoryServer({
      ctx: { get: (name) => (name === 'workspaceRegistry' ? registry : null) },
      runtime: { veyraHome: home, fallbackCwd: a },
    })
    const health = server.health()
    assert.equal(health.mode, 'registry')
    assert.equal(health.registryState, 'available')
  })
})

describe('governed promotion', () => {
  const binding = {
    roomId: 'w_room-a',
    workspaceId: '11111111-1111-4111-8111-111111111111',
    workspacePath: '/repo/a',
    mode: 'registry',
  }

  test('candidates and evidence-less records are refused', () => {
    const home = makeHome()
    const room = openRoomStore(home, binding.roomId)
    const central = openCentralStore(home)

    const candidate = room.put(record({ authority: 'candidate', title: 'Candidate' }))
    const refusedCandidate = promoteRecord({
      workspaceStore: room,
      centralStore: central,
      binding,
      id: candidate.record.id,
    })
    assert.equal(refusedCandidate.ok, false)
    assert.equal(refusedCandidate.reason, PROMOTION_FAILURES.CANDIDATE_NOT_PROMOTABLE)

    const noEvidence = room.put(record({ title: 'No evidence', evidence: [], validation: 'unverified' }))
    const refusedEvidence = promoteRecord({
      workspaceStore: room,
      centralStore: central,
      binding,
      id: noEvidence.record.id,
    })
    assert.equal(refusedEvidence.ok, false)
    assert.equal(refusedEvidence.reason, PROMOTION_FAILURES.INSUFFICIENT_EVIDENCE)
  })

  test('canonical requires explicit user action', () => {
    const home = makeHome()
    const room = openRoomStore(home, binding.roomId)
    const central = openCentralStore(home)
    const written = room.put(record({ title: 'Canonical target' }))
    const refused = promoteRecord({
      workspaceStore: room,
      centralStore: central,
      binding,
      id: written.record.id,
      to: 'canonical',
      explicit: false,
    })
    assert.equal(refused.ok, false)
    assert.equal(refused.reason, PROMOTION_FAILURES.CANONICAL_REQUIRES_EXPLICIT)

    const promoted = promoteRecord({
      workspaceStore: room,
      centralStore: central,
      binding,
      id: written.record.id,
      to: 'canonical',
      explicit: true,
    })
    assert.equal(promoted.ok, true)
    assert.equal(promoted.authority, 'canonical')
    assert.equal(central.get(promoted.centralId).scope, 'reusable')
  })

  test('re-promotion merges evidence without duplicating the central record', () => {
    const home = makeHome()
    const room = openRoomStore(home, binding.roomId)
    const central = openCentralStore(home)
    const written = room.put(record({ title: 'Merge me' }))
    const first = promoteRecord({
      workspaceStore: room,
      centralStore: central,
      binding,
      id: written.record.id,
    })
    assert.equal(first.action, 'created')

    room.put(record({
      id: written.record.id,
      title: 'Merge me',
      evidence: [{ note: 'second observation' }],
    }))
    const second = promoteRecord({
      workspaceStore: room,
      centralStore: central,
      binding,
      id: written.record.id,
    })
    assert.equal(second.action, 'merged')
    assert.equal(second.centralId, first.centralId)
    assert.equal(central.list({ limit: 50 }).length, 1)
    const centralRecord = central.get(first.centralId)
    assert.equal(centralRecord.evidence.length, 2)
    assert.equal(centralRecord.source.promotions.length, 2)
  })

  test('same content under another id is linked, never overwritten', () => {
    const home = makeHome()
    const room = openRoomStore(home, binding.roomId)
    const central = openCentralStore(home)
    const title = 'Shared knowledge'
    const body = 'Identical content in both stores.'
    const existing = central.put(record({ title, body }))

    const roomRecord = room.put(record({ title, body, source: { workspace: '/repo/a' } }))
    assert.equal(contentHash(title, body), roomRecord.record.contentHash)

    const linked = promoteRecord({
      workspaceStore: room,
      centralStore: central,
      binding,
      id: roomRecord.record.id,
    })
    assert.equal(linked.ok, true)
    assert.equal(linked.action, 'linked')
    assert.equal(linked.centralId, existing.record.id)
    assert.equal(central.list({ limit: 50 }).length, 1)
    assert.equal(central.get(existing.record.id).body, body)
  })
})
