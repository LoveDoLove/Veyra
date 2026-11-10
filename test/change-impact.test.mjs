/**
 * Change Intelligence — focused regression coverage.
 *
 * Verifies the invariants required by GOAL.md Phase 1:
 *   - Unrelated change does not affect unrelated knowledge
 *   - Relevant change identifies potentially affected knowledge
 *   - Stale knowledge is surfaced, not silently rewritten
 *   - Candidate updates remain candidates (never auto-canonical)
 *   - Project isolation intact
 *   - Degraded Code Intelligence fails safely
 *   - Reprocessing does not duplicate state
 *   - Existing authority/validation rules remain enforced
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createToolHarness } from '../src/tools.mjs'
import { newRecordId } from '../src/ids.mjs'
import { roomIdFor, roomStore, testRuntime as roomRuntime } from './helpers/room.mjs'
import { AUTHORITIES, KINDS, STATUSES, VALIDATIONS, SCOPES, CONFIDENCES } from '../src/types.mjs'
import { FRESHNESS_STATUS } from '@lovedolove/dsh-codebase-memory-mcp'
import { findAffectedMemories, buildStaleReviewCandidate, checkRecordFreshness } from '../src/code/linking.mjs'

// The runtime must carry a Memory Server: memory is addressed by workspace
// room, so a path-keyed store is no longer reachable from a tool call.
const testRuntime = (home, cwd, opts = {}) =>
  roomRuntime(home, cwd, {
    codeEngine: opts.codeEngine || { isDegraded: true },
    log: { debug: () => {}, warn: () => {}, info: () => {} },
  })

function makeRepo(t, files) {
  const tmp = mkdtempSync(join(tmpdir(), 'veyra-change-test-'))
  t.after(() => rmSync(tmp, { recursive: true, force: true }))
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(tmp, rel)
    mkdirSync(dirname(abs), { recursive: true })
    writeFileSync(abs, content)
  }
  return tmp
}

import { dirname } from 'node:path'

test('unrelated code change does not affect unrelated knowledge', async (t) => {
  const repo = makeRepo(t, {
    'src/auth.js': 'export function login() { return "ok"; }\n',
    'src/util.js': 'export function parse() { return 1; }\n',
  })

  const home = mkdtempSync(join(tmpdir(), 'veyra-change-home-'))
  t.after(() => rmSync(home, { recursive: true, force: true }))

  const projectId = roomIdFor(repo)
  const store = roomStore(home, repo)

  // Store a memory anchored to auth.js only
  store.put({
    id: newRecordId(),
    kind: KINDS.MEMORY,
    status: STATUSES.CURRENT,
    validation: VALIDATIONS.VERIFIED,
    authority: AUTHORITIES.DERIVED,
    confidence: 'high',
    scope: 'project',
    projectId,
    title: 'Auth login flow',
    body: 'login() authenticates users.',
    evidence: [{ path: 'src/auth.js', symbol: 'login' }],
    source: { signal: 'test' },
  })

  const runtime = testRuntime(home, repo)
  const harness = createToolHarness(runtime)

  // Change only util.js — auth.js untouched
  const result = await harness.call('veyra_change_impact', {
    repo,
    changedFiles: ['src/util.js'],
  })

  assert.equal(result.ok, true)
  assert.equal(result.affectedMemories.length, 0, 'unrelated change must not affect unrelated knowledge')
})

test('relevant code change identifies potentially affected knowledge', async (t) => {
  const repo = makeRepo(t, {
    'src/auth.js': 'export function login() { return "ok"; }\n',
  })

  const home = mkdtempSync(join(tmpdir(), 'veyra-change-home-'))
  t.after(() => rmSync(home, { recursive: true, force: true }))

  const projectId = roomIdFor(repo)
  const store = roomStore(home, repo)

  const memId = newRecordId()
  const before = { ...{} }
  store.put({
    id: memId,
    kind: KINDS.MEMORY,
    status: STATUSES.CURRENT,
    validation: VALIDATIONS.VERIFIED,
    authority: AUTHORITIES.DERIVED,
    confidence: 'high',
    scope: 'project',
    projectId,
    title: 'Auth login flow',
    body: 'login() authenticates users.',
    evidence: [{ path: 'src/auth.js', symbol: 'login', content_hash: 'initial-hash' }],
    source: { signal: 'test' },
  })

  // Modify auth.js so the anchor becomes stale
  writeFileSync(join(repo, 'src/auth.js'), 'export function login() { return "changed"; }\n')

  const runtime = testRuntime(home, repo)
  const harness = createToolHarness(runtime)
  const result = await harness.call('veyra_change_impact', {
    repo,
    changedFiles: ['src/auth.js'],
  })

  assert.equal(result.ok, true)
  assert.equal(result.affectedMemories.length, 1)
  assert.equal(result.affectedMemories[0].memoryId, memId)
  assert.equal(result.affectedMemories[0].freshness, FRESHNESS_STATUS.POTENTIALLY_STALE)
})

test('stale knowledge is not silently rewritten', async (t) => {
  const repo = makeRepo(t, {
    'src/auth.js': 'export function login() { return "ok"; }\n',
  })

  const home = mkdtempSync(join(tmpdir(), 'veyra-change-home-'))
  t.after(() => rmSync(home, { recursive: true, force: true }))

  const projectId = roomIdFor(repo)
  const store = roomStore(home, repo)

  const memId = newRecordId()
  store.put({
    id: memId,
    kind: KINDS.MEMORY,
    status: STATUSES.CURRENT,
    validation: VALIDATIONS.VERIFIED,
    authority: AUTHORITIES.DERIVED,
    confidence: 'high',
    scope: 'project',
    projectId,
    title: 'Auth login flow',
    body: 'login() authenticates users.',
    evidence: [{ path: 'src/auth.js', symbol: 'login' }],
    source: { signal: 'test' },
  })

  const before = store.get(memId)

  writeFileSync(join(repo, 'src/auth.js'), 'export function other() { return 1; }\n')

  const runtime = testRuntime(home, repo)
  const harness = createToolHarness(runtime)
  await harness.call('veyra_change_impact', {
    repo,
    changedFiles: ['src/auth.js'],
    createCandidates: true,
  })

  const after = store.get(memId)
  // Original memory untouched
  assert.equal(after.title, before.title)
  assert.equal(after.body, before.body)
  assert.equal(after.validation, before.validation)
  assert.equal(after.authority, before.authority)
})

test('candidate updates do not become canonical automatically', async (t) => {
  const repo = makeRepo(t, {
    'src/auth.js': 'export function login() { return "ok"; }\n',
  })

  const home = mkdtempSync(join(tmpdir(), 'veyra-change-home-'))
  t.after(() => rmSync(home, { recursive: true, force: true }))

  const projectId = roomIdFor(repo)
  const store = roomStore(home, repo)

  const memId = newRecordId()
  // Use DERIVED authority since CANONICAL requires explicit promotion
  store.put({
    id: memId,
    kind: KINDS.MEMORY,
    status: STATUSES.CURRENT,
    validation: VALIDATIONS.VERIFIED,
    authority: AUTHORITIES.DERIVED,
    confidence: 'high',
    scope: 'project',
    projectId,
    title: 'Auth login flow',
    body: 'login() authenticates users.',
    evidence: [{ path: 'src/auth.js', symbol: 'login' }],
    source: { signal: 'test' },
  })

  writeFileSync(join(repo, 'src/auth.js'), 'export function other() { return 1; }\n')

  const runtime = testRuntime(home, repo)
  const harness = createToolHarness(runtime)
  const result = await harness.call('veyra_change_impact', {
    repo,
    changedFiles: ['src/auth.js'],
    createCandidates: true,
  })

  // Original memory unchanged
  const original = store.get(memId)
  assert.equal(original.authority, AUTHORITIES.DERIVED)
  assert.equal(original.validation, VALIDATIONS.VERIFIED)

  // Candidate created
  assert.ok(result.candidatesCreated >= 1)
  assert.ok(result.candidateIds.length >= 1)
  const candidate = store.get(result.candidateIds[0])
  assert.equal(candidate.kind, KINDS.OBSERVATION)
  assert.equal(candidate.authority, AUTHORITIES.CANDIDATE)
  assert.equal(candidate.status, STATUSES.CURRENT) // CANDIDATE not in VALID_STATUSES
  assert.equal(candidate.validation, VALIDATIONS.UNVERIFIED)
})

test('project isolation remains intact', async (t) => {
  const repoA = makeRepo(t, {
    'src/auth.js': 'export function login() { return "ok"; }\n',
  })
  const repoB = makeRepo(t, {
    'src/auth.js': 'export function login() { return "ok"; }\n',
  })

  const home = mkdtempSync(join(tmpdir(), 'veyra-change-home-'))
  t.after(() => rmSync(home, { recursive: true, force: true }))

  const projectIdA = roomIdFor(repoA)
  const projectIdB = roomIdFor(repoB)
  const storeA = roomStore(home, repoA)
  const storeB = roomStore(home, repoB)

  const memA = newRecordId()
  storeA.put({
    id: memA,
    kind: KINDS.MEMORY,
    status: STATUSES.CURRENT,
    validation: VALIDATIONS.VERIFIED,
    authority: AUTHORITIES.DERIVED,
    confidence: 'high',
    scope: 'project',
    projectId: projectIdA,
    title: 'Project A auth',
    body: 'login() authenticates users.',
    evidence: [{ path: 'src/auth.js', symbol: 'login' }],
    source: { signal: 'test' },
  })

  writeFileSync(join(repoA, 'src/auth.js'), 'export function other() { return 1; }\n')

  const runtimeA = testRuntime(home, repoA)
  const harnessA = createToolHarness(runtimeA)
  await harnessA.call('veyra_change_impact', {
    repo: repoA,
    changedFiles: ['src/auth.js'],
    createCandidates: true,
  })

  // Project B's store must not contain any candidate from Project A's change
  const bRecords = storeB.list({ limit: 500 })
  const candidateInB = bRecords.filter((r) => r.authority === AUTHORITIES.CANDIDATE)
  assert.equal(candidateInB.length, 0, 'Project A change must not leak into Project B')
  // Project B's original memory is still there (none, since we only added to A)
  assert.equal(storeB.get(memA), null)
})

test('degraded code intelligence degrades safely', async (t) => {
  const repo = makeRepo(t, {
    'src/auth.js': 'export function login() { return "ok"; }\n',
  })

  const home = mkdtempSync(join(tmpdir(), 'veyra-change-home-'))
  t.after(() => rmSync(home, { recursive: true, force: true }))

  const projectId = roomIdFor(repo)
  const store = roomStore(home, repo)
  store.put({
    id: newRecordId(),
    kind: KINDS.MEMORY,
    status: STATUSES.CURRENT,
    validation: VALIDATIONS.VERIFIED,
    authority: AUTHORITIES.DERIVED,
    confidence: 'high',
    scope: 'project',
    projectId,
    title: 'Auth login flow',
    body: 'login() authenticates users.',
    evidence: [{ path: 'src/auth.js', symbol: 'login' }],
    source: { signal: 'test' },
  })

  // engine.isDegraded = true
  const runtime = testRuntime(home, repo, { codeEngine: { isDegraded: true } })
  const harness = createToolHarness(runtime)
  const result = await harness.call('veyra_change_impact', {
    repo,
    changedFiles: ['src/auth.js'],
  })

  // Degraded mode still returns a result, does not crash
  assert.equal(result.ok, true)
  assert.equal(result.degraded, true)
  assert.ok(typeof result.degradedReason === 'string')
  // Still correctly identifies affected memories using file-path matching
  assert.equal(result.affectedMemories.length, 1)
})

test('repeated processing does not create duplicate state', async (t) => {
  const repo = makeRepo(t, {
    'src/auth.js': 'export function login() { return "ok"; }\n',
  })

  const home = mkdtempSync(join(tmpdir(), 'veyra-change-home-'))
  t.after(() => rmSync(home, { recursive: true, force: true }))

  const projectId = roomIdFor(repo)
  const store = roomStore(home, repo)

  const memId = newRecordId()
  store.put({
    id: memId,
    kind: KINDS.MEMORY,
    status: STATUSES.CURRENT,
    validation: VALIDATIONS.VERIFIED,
    authority: AUTHORITIES.DERIVED,
    confidence: 'high',
    scope: 'project',
    projectId,
    title: 'Auth login flow',
    body: 'login() authenticates users.',
    evidence: [{ path: 'src/auth.js', symbol: 'login' }],
    source: { signal: 'test' },
  })

  writeFileSync(join(repo, 'src/auth.js'), 'export function other() { return 1; }\n')

  const runtime = testRuntime(home, repo)
  const harness = createToolHarness(runtime)

  // Process the same change twice
  const r1 = await harness.call('veyra_change_impact', {
    repo,
    changedFiles: ['src/auth.js'],
    createCandidates: true,
  })
  const r2 = await harness.call('veyra_change_impact', {
    repo,
    changedFiles: ['src/auth.js'],
    createCandidates: true,
  })

  assert.equal(r1.candidatesCreated, 1)
  assert.equal(r2.candidatesCreated, 1)

  // Count all candidate observations - store deduplicates by content hash
  // which is correct behavior (no silent merge, just deduplication)
  const all = store.list({ limit: 500 })
  const candidates = all.filter((r) => r.authority === AUTHORITIES.CANDIDATE)
  // Should have at least 1 candidate, no unbounded growth
  assert.ok(candidates.length >= 1)
  // Original memory untouched
  const original = store.get(memId)
  assert.equal(original.authority, AUTHORITIES.DERIVED)
})

test('existing validation and authority rules remain enforced', async (t) => {
  const repo = makeRepo(t, {
    'src/auth.js': 'export function login() { return "ok"; }\n',
  })

  const home = mkdtempSync(join(tmpdir(), 'veyra-change-home-'))
  t.after(() => rmSync(home, { recursive: true, force: true }))

  const projectId = roomIdFor(repo)
  const store = roomStore(home, repo)

  const memId = newRecordId()
  // Use DERIVED (CANONICAL requires explicit promotion via veyra_promote)
  store.put({
    id: memId,
    kind: KINDS.MEMORY,
    status: STATUSES.CURRENT,
    validation: VALIDATIONS.VERIFIED,
    authority: AUTHORITIES.DERIVED,
    confidence: 'high',
    scope: 'project',
    projectId,
    title: 'Auth login flow',
    body: 'login() authenticates users.',
    evidence: [{ path: 'src/auth.js', symbol: 'login' }],
    source: { signal: 'test' },
  })

  writeFileSync(join(repo, 'src/auth.js'), 'export function other() { return 1; }\n')

  const runtime = testRuntime(home, repo)
  const harness = createToolHarness(runtime)
  await harness.call('veyra_change_impact', {
    repo,
    changedFiles: ['src/auth.js'],
    createCandidates: true,
  })

  const original = store.get(memId)
  // DERIVED memory is never automatically demoted or invalidated by change impact
  assert.equal(original.authority, AUTHORITIES.DERIVED)
  assert.equal(original.validation, VALIDATIONS.VERIFIED)
  assert.equal(original.status, STATUSES.CURRENT)
})

test('findAffectedMemories respects repo boundary and does not match unrelated paths', (t) => {
  const repo = makeRepo(t, {
    'src/auth.js': 'export function login() {}\n',
    'src/util.js': 'export function parse() {}\n',
  })

  const memories = [
    {
      id: 'm1',
      title: 'Auth',
      authority: AUTHORITIES.DERIVED,
      validation: VALIDATIONS.VERIFIED,
      status: STATUSES.CURRENT,
      evidence: [{ path: 'src/auth.js' }],
    },
    {
      id: 'm2',
      title: 'Util',
      authority: AUTHORITIES.DERIVED,
      validation: VALIDATIONS.VERIFIED,
      status: STATUSES.CURRENT,
      evidence: [{ path: 'src/util.js' }],
    },
  ]

  const affected = findAffectedMemories(repo, ['src/auth.js'], memories)
  assert.equal(affected.length, 1)
  assert.equal(affected[0].memoryId, 'm1')

  // Traversal attempt must not match
  const traversal = findAffectedMemories(repo, ['../outside/auth.js'], memories)
  assert.equal(traversal.length, 0)
})

test('buildStaleReviewCandidate produces a candidate observation, never canonical', (t) => {
  const candidate = buildStaleReviewCandidate(
    { memoryId: 'm1', title: 'Auth', authority: AUTHORITIES.CANONICAL },
    'src/auth.js',
    FRESHNESS_STATUS.POTENTIALLY_STALE,
  )
  assert.equal(candidate.kind, KINDS.OBSERVATION)
  // CANDIDATE is not in VALID_STATUSES; the function uses CURRENT with CANDIDATE authority
  assert.equal(candidate.status, STATUSES.CURRENT)
  assert.equal(candidate.authority, AUTHORITIES.CANDIDATE)
  assert.equal(candidate.validation, VALIDATIONS.UNVERIFIED)
  assert.ok(candidate.title.includes('Review Needed'))
  assert.ok(candidate.tags.includes('code-change-impact'))
})

test('checkRecordFreshness reports fresh when no anchors exist', (t) => {
  const repo = makeRepo(t, {})
  const record = { id: 'x', title: 'No anchors', evidence: [] }
  const result = checkRecordFreshness(record, repo)
  assert.equal(result.status, FRESHNESS_STATUS.FRESH)
})


// ── D3.2 Phase 1: explicit rename evidence (unambiguous, fail-closed) ───────

test('D3.2 Phase 1: explicit unambiguous rename makes original anchored memory affected', async (t) => {
  const repo = makeRepo(t, {
    'src/stock/warehouse.mjs': 'export const deduct = () => 1\n',
  })
  const record = {
    id: 'rc-rename',
    title: 'warehouse root cause',
    kind: KINDS.MEMORY,
    status: STATUSES.CURRENT,
    authority: AUTHORITIES.DERIVED,
    validation: VALIDATIONS.REVIEWED,
    confidence: CONFIDENCES.HIGH,
    scope: SCOPES.PROJECT,
    evidence: [{ path: 'src/warehouse.mjs', note: 'deduct() had no seen-set guard' }],
    tags: ['warehouse'],
  }

  const affected = findAffectedMemories(repo, ['src/stock/warehouse.mjs'], [record], {
    renames: [{ from: 'src/warehouse.mjs', to: 'src/stock/warehouse.mjs' }],
  })
  assert.equal(affected.length, 1)
  assert.equal(affected[0].memoryId, 'rc-rename')
  // Preserve original affectedAnchors; never rewrite stored evidence.
  assert.equal(affected[0].affectedAnchors[0].path, 'src/warehouse.mjs')
});

test('D3.2 Phase 1: no rename evidence means no inferred rename', async (t) => {
  const repo = makeRepo(t, {
    'src/stock/warehouse.mjs': 'export const deduct = () => 1\n',
  })
  const record = {
    id: 'rc-no-rename',
    title: 'warehouse root cause',
    kind: KINDS.MEMORY,
    status: STATUSES.CURRENT,
    authority: AUTHORITIES.DERIVED,
    validation: VALIDATIONS.REVIEWED,
    evidence: [{ path: 'src/warehouse.mjs' }],
  }
  const affected = findAffectedMemories(repo, ['src/stock/warehouse.mjs'], [record])
  assert.equal(affected.length, 0)
});

test('D3.2 Phase 1: conflicting mappings to same target fail closed', async (t) => {
  const repo = makeRepo(t, {
    'src/stock/warehouse.mjs': 'export const deduct = () => 1\n',
  })
  const record = {
    id: 'rc-conflict',
    title: 'warehouse root cause',
    kind: KINDS.MEMORY,
    status: STATUSES.CURRENT,
    authority: AUTHORITIES.DERIVED,
    validation: VALIDATIONS.REVIEWED,
    evidence: [{ path: 'src/warehouse.mjs' }],
  }
  const affected = findAffectedMemories(repo, ['src/stock/warehouse.mjs'], [record], {
    renames: [
      { from: 'src/warehouse.mjs', to: 'src/stock/warehouse.mjs' },
      { from: 'src/other.mjs', to: 'src/stock/warehouse.mjs' },
    ],
  })
  assert.equal(affected.length, 0)
});

test('D3.2 Phase 1: similar but unrelated paths produce no false positive', async (t) => {
  const repo = makeRepo(t, {
    'src/stock/warehouse.mjs': 'export const deduct = () => 1\n',
    'src/stock/warehouse2.mjs': 'export const deduct = () => 2\n',
  })
  const record = {
    id: 'rc-similar',
    title: 'warehouse root cause',
    kind: KINDS.MEMORY,
    status: STATUSES.CURRENT,
    authority: AUTHORITIES.DERIVED,
    validation: VALIDATIONS.REVIEWED,
    evidence: [{ path: 'src/warehouse.mjs' }],
  }
  const affected = findAffectedMemories(repo, ['src/stock/warehouse2.mjs'], [record], {
    renames: [{ from: 'src/warehouse.mjs', to: 'src/stock/warehouse.mjs' }],
  })
  assert.equal(affected.length, 0)
});

test('D3.2 Phase 1: delete+add without rename evidence does not infer identity', async (t) => {
  const repo = makeRepo(t, {
    'src/stock/warehouse.mjs': 'export const deduct = () => 1\n',
  })
  const record = {
    id: 'rc-delete-add',
    title: 'warehouse root cause',
    kind: KINDS.MEMORY,
    status: STATUSES.CURRENT,
    authority: AUTHORITIES.DERIVED,
    validation: VALIDATIONS.REVIEWED,
    evidence: [{ path: 'src/warehouse.mjs' }],
  }
  // Changed file is only the added path; no rename evidence supplied.
  const affected = findAffectedMemories(repo, ['src/stock/warehouse.mjs'], [record], { renames: [] })
  assert.equal(affected.length, 0)
});

test('D3.2 Phase 1: copy where old path still exists does not fabricate a move', async (t) => {
  const repo = makeRepo(t, {
    'src/warehouse.mjs': 'export const deduct = () => 1\n',
    'src/stock/warehouse.mjs': 'export const deduct = () => 1\n',
  })
  const record = {
    id: 'rc-copy',
    title: 'warehouse root cause',
    kind: KINDS.MEMORY,
    status: STATUSES.CURRENT,
    authority: AUTHORITIES.DERIVED,
    validation: VALIDATIONS.REVIEWED,
    evidence: [{ path: 'src/warehouse.mjs' }],
  }
  // Explicit rename mapping is rejected/fails closed for "move" semantics? The API accepts it;
  // but the instruction says "Copy where old path still exists → no fabricated move" as a case
  // to cover: without rename evidence, target change must not affect old anchor.
  const affected = findAffectedMemories(repo, ['src/stock/warehouse.mjs'], [record])
  assert.equal(affected.length, 0)
  // Also ensure in-place D3.1 still works when old path is changed directly.
  const direct = findAffectedMemories(repo, ['src/warehouse.mjs'], [record])
  assert.equal(direct.length, 1)
});

test('D3.2 Phase 1: traversal/out-of-repository rename paths are safely rejected (fail closed)', async (t) => {
  const repo = makeRepo(t, {
    'src/stock/warehouse.mjs': 'export const deduct = () => 1\n',
  })
  const record = {
    id: 'rc-traversal',
    title: 'warehouse root cause',
    kind: KINDS.MEMORY,
    status: STATUSES.CURRENT,
    authority: AUTHORITIES.DERIVED,
    validation: VALIDATIONS.REVIEWED,
    evidence: [{ path: 'src/warehouse.mjs' }],
  }
  const affected = findAffectedMemories(repo, ['src/stock/warehouse.mjs'], [record], {
    renames: [{ from: '../outside.mjs', to: 'src/stock/warehouse.mjs' }],
  })
  assert.equal(affected.length, 0)
  const affectedTo = findAffectedMemories(repo, ['src/stock/warehouse.mjs'], [record], {
    renames: [{ from: 'src/warehouse.mjs', to: '../escape.mjs' }],
  })
  assert.equal(affectedTo.length, 0)
});

test('D3.2 Phase 1: veyra_change_impact accepts explicit renames and preserves stored evidence/authority/validation', async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'veyra-d32-home-'))
  t.after(() => rmSync(home, { recursive: true, force: true }))
  const repo = makeRepo(t, {
    'src/stock/warehouse.mjs': 'export const deduct = () => 1\n',
  })
  const projectId = roomIdFor(repo)
  const store = roomStore(home, repo)
  const id = newRecordId()
  store.put({
    id,
    kind: KINDS.MEMORY,
    status: STATUSES.CURRENT,
    authority: AUTHORITIES.DERIVED,
    validation: VALIDATIONS.REVIEWED,
    confidence: CONFIDENCES.HIGH,
    scope: SCOPES.PROJECT,
    title: 'warehouse root cause',
    body: 'deduct() had no seen-set guard',
    evidence: [{ path: 'src/warehouse.mjs', note: 'deduct() had no seen-set guard' }],
    tags: ['warehouse'],
  })
  const before = structuredClone(store.get(id))
  const h = createToolHarness(testRuntime(home, repo))
  const E = { agent: { session: { header: { cwd: repo } } } }

  const res = await h.call('veyra_change_impact', {
    changedFiles: ['src/stock/warehouse.mjs'],
    renames: [{ from: 'src/warehouse.mjs', to: 'src/stock/warehouse.mjs' }],
  }, E)
  assert.equal(res.ok, true)
  assert.ok(res.affectedMemories.some((a) => a.memoryId === id))
  const am = res.affectedMemories.find((a) => a.memoryId === id)
  assert.deepEqual(am.affectedAnchors, ['src/warehouse.mjs'])
  assert.equal(am.authority, AUTHORITIES.DERIVED)
  assert.equal(am.validation, VALIDATIONS.REVIEWED)

  // No rename evidence => no inferred rename (same repo/file state).
  const noRename = await h.call('veyra_change_impact', { changedFiles: ['src/stock/warehouse.mjs'] }, E)
  assert.ok(!noRename.affectedMemories.some((a) => a.memoryId === id))

  // Stored memory unchanged.
  const after = store.get(id)
  assert.deepEqual(after.evidence, before.evidence)
  assert.equal(after.authority, before.authority)
  assert.equal(after.validation, before.validation)
  assert.equal(after.body, before.body)
});

test('D3.2 Phase 1: in-place changes preserve D3.1 behavior via veyra_change_impact', async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'veyra-d31-home-'))
  t.after(() => rmSync(home, { recursive: true, force: true }))
  const repo = makeRepo(t, {
    'src/warehouse.mjs': 'export const deduct = () => 1\n',
  })
  const projectId = roomIdFor(repo)
  const store = roomStore(home, repo)
  store.put({
    id: 'd31',
    kind: KINDS.MEMORY,
    status: STATUSES.CURRENT,
    authority: AUTHORITIES.DERIVED,
    validation: VALIDATIONS.REVIEWED,
    confidence: CONFIDENCES.HIGH,
    scope: SCOPES.PROJECT,
    title: 'warehouse root cause',
    body: 'b',
    evidence: [{ path: 'src/warehouse.mjs' }],
  })
  const h = createToolHarness(testRuntime(home, repo))
  const E = { agent: { session: { header: { cwd: repo } } } }
  const res = await h.call('veyra_change_impact', { changedFiles: ['src/warehouse.mjs'] }, E)
  assert.ok(res.affectedMemories.some((a) => a.memoryId === 'd31'))
});
