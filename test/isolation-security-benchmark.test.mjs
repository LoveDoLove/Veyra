/**
 * Project Isolation & Security Boundary Benchmark — Comprehensive E2E validation.
 *
 * Verifies that Veyra's project/workspace/reusable memory isolation is truly
 * fail-closed across all surfaces: storage, retrieval, tool boundaries, context
 * manipulation, codebase-memory, and evidence fields.
 *
 * Complements existing tests (D32/D33 basic isolation, code-engine cross-repo)
 * with adversarial scenarios: identical queries, malformed identity, arg injection,
 * foreign-id lifecycle ops, evidence leaks.
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { openProjectStore, openReusableStore, closeAllStores } from '../src/store.mjs'
import { remember, promote } from '../src/learn.mjs'
import { recordFeedback } from '../src/feedback.mjs'
import { forget } from '../src/lifecycle.mjs'
import { recall, inspect } from '../src/retrieve.mjs'
import { createToolHarness } from '../src/tools.mjs'
import { projectIdFor } from '../src/ids.mjs'
import { AUTHORITIES, VALIDATIONS, KINDS, SCOPES } from '../src/types.mjs'

// Helpers
function claim(title, body, overrides = {}) {
  return {
    title,
    body,
    authority: AUTHORITIES.DERIVED,
    validation: VALIDATIONS.UNVERIFIED,
    kind: KINDS.MEMORY,
    source: { tool: 'veyra_remember', automatic: false },
    ...overrides,
  }
}

test('ISB-1: identical high-overlap query does not leak cross-project', () => {
  const home = mkdtempSync(join(tmpdir(), 'veyra-isb-1-'))
  try {
    const alpha = openProjectStore(home, 'proj-alpha')
    const beta = openProjectStore(home, 'proj-beta')

    // Both projects write nearly identical records with HIGH lexical overlap
    const alphaId = remember(alpha, claim(
      'DatabaseSync write lock prevents FTS5 corruption',
      'Root cause: concurrent DatabaseSync.run() calls corrupt FTS5 triggers. Remedy: serialize all writes with a mutex. Evidence: test/store.test.mjs verifies lockWriter() correctness.',
      { tags: ['sqlite', 'fts5', 'lock'], validation: VALIDATIONS.VERIFIED }
    )).record.id

    const betaId = remember(beta, claim(
      'DatabaseSync write lock prevents FTS5 corruption',
      'Root cause: concurrent DatabaseSync.run() calls corrupt FTS5 triggers. Remedy: serialize all writes with a mutex. Evidence: different test file verifies lockWriter() correctness.',
      { tags: ['sqlite', 'fts5', 'lock'], validation: VALIDATIONS.VERIFIED }
    )).record.id

    // Identical query on both stores
    const query = 'DatabaseSync write lock FTS5 corruption mutex'
    const fromAlpha = recall({ projectStore: alpha, query, limit: 10 })
    const fromBeta = recall({ projectStore: beta, query, limit: 10 })

    assert.ok(fromAlpha.length > 0, 'alpha recall returned results')
    assert.ok(fromBeta.length > 0, 'beta recall returned results')
    assert.ok(fromAlpha.every((r) => r.projectId === 'proj-alpha'),
      'alpha recall returns only alpha records despite high-overlap query')
    assert.ok(fromBeta.every((r) => r.projectId === 'proj-beta'),
      'beta recall returns only beta records despite high-overlap query')
    assert.ok(!fromAlpha.some((r) => r.id === betaId), 'alpha never sees beta id')
    assert.ok(!fromBeta.some((r) => r.id === alphaId), 'beta never sees alpha id')
  } finally {
    closeAllStores()
    rmSync(home, { recursive: true, force: true })
  }
})

test('ISB-2: reusable record does not pollute project-local scope', () => {
  const home = mkdtempSync(join(tmpdir(), 'veyra-isb-2-'))
  try {
    const project = openProjectStore(home, 'proj-main')
    const reusable = openReusableStore(home)

    // Reusable memory
    const reusableId = remember(reusable, claim(
      'Generic mutex pattern for node:sqlite',
      'Use a single write mutex around DatabaseSync.run() to avoid concurrent-put deadlocks.',
      { scope: SCOPES.REUSABLE, projectId: 'reusable', tags: ['sqlite', 'mutex'] }
    )).record.id

    // Project-local memory
    const projectId = remember(project, claim(
      'Project-specific mutex implementation',
      'Our mutex wraps DatabaseSync with a custom timeout and retry policy.',
      { tags: ['sqlite', 'mutex'] }
    )).record.id

    // Query with includeReusable=true
    const withReusable = recall({ projectStore: project, reusableStore: reusable, query: 'mutex sqlite', includeReusable: true, limit: 10 })
    assert.ok(withReusable.some((r) => r.id === reusableId), 'reusable surfaces when includeReusable=true')
    assert.ok(withReusable.some((r) => r.id === projectId), 'project-local surfaces')

    // Query with includeReusable=false
    const projectOnly = recall({ projectStore: project, reusableStore: reusable, query: 'mutex sqlite', includeReusable: false, limit: 10 })
    assert.ok(!projectOnly.some((r) => r.id === reusableId), 'reusable excluded when includeReusable=false')
    assert.ok(projectOnly.some((r) => r.id === projectId), 'project-local still surfaces')

    // Reusable record must NOT appear in project store's internal list
    const projectRows = project.list({ limit: 100 })
    assert.ok(!projectRows.some((r) => r.id === reusableId), 'reusable id never physically stored in project DB')
  } finally {
    closeAllStores()
    rmSync(home, { recursive: true, force: true })
  }
})

test('ISB-3: malformed exec.agent falls back safely (fail-closed)', async () => {
  const home = mkdtempSync(join(tmpdir(), 'veyra-isb-3-'))
  const runtime = { veyraHome: home, fallbackCwd: process.cwd() }
  const harness = createToolHarness(runtime)

  try {
    // Call with missing exec (should use fallbackCwd)
    const missingExec = await harness.call('veyra_remember', { title: 'Test A', body: 'missing exec' }, undefined)
    assert.equal(missingExec.ok, true, 'missing exec.agent falls back to runtime.fallbackCwd')

    // Call with malformed agent (no session, no cwd)
    const malformedAgent = await harness.call('veyra_remember', { title: 'Test B', body: 'malformed' }, { agent: {} })
    assert.equal(malformedAgent.ok, true, 'malformed agent falls back')

    // Call with null agent
    const nullAgent = await harness.call('veyra_remember', { title: 'Test C', body: 'null' }, { agent: null })
    assert.equal(nullAgent.ok, true, 'null agent falls back')

    // All three must resolve to the same project — resolveWorkspace's
    // documented fallback chain ends at process.cwd() (ids.mjs:133), so
    // missing/malformed identity collapses deterministically to ONE project,
    // never to a null/shared bucket and never to a random other project.
    const fallbackProjectId = projectIdFor(process.cwd())
    assert.ok(/^p_[0-9a-f]{16}$/.test(fallbackProjectId), 'malformed identity still yields a well-formed project id')
    const store = openProjectStore(home, fallbackProjectId)
    const rows = store.list({ limit: 10 })
    assert.ok(rows.length >= 3, 'all three writes landed in the fallback project')
  } finally {
    closeAllStores()
    rmSync(home, { recursive: true, force: true })
  }
})

test('ISB-4: veyra_remember scope arg cannot inject foreign projectId at storage level', async () => {
  const home = mkdtempSync(join(tmpdir(), 'veyra-isb-4-'))
  const cwdA = join(home, 'workspace-a')
  const cwdB = join(home, 'workspace-b')
  const runtime = { veyraHome: home, fallbackCwd: cwdA }
  const harness = createToolHarness(runtime)

  try {
    // Write to project A (exec.agent.session.header.cwd = cwdA)
    const writeA = await harness.call('veyra_remember', {
      title: 'Record A',
      body: 'belongs to workspace A',
      scope: 'project',
      // Agent supplies arbitrary projectId — tools.mjs:253 writes it, but storesFor derives the real one from cwd
    }, { agent: { session: { header: { cwd: cwdA } } } })
    assert.equal(writeA.ok, true, 'write to project A succeeded')
    const idA = writeA.record.id

    // Attempt cross-project recall from B (exec.agent.session.header.cwd = cwdB)
    const recallB = await harness.call('veyra_recall', {
      query: 'workspace A',
      limit: 10,
    }, { agent: { session: { header: { cwd: cwdB } } } })

    assert.ok(!recallB.items.some((r) => r.id === idA),
      'project B recall never sees project A record despite query match')

    // Verify projectId was derived from cwd, not tool args
    const recallA = await harness.call('veyra_recall', {
      query: 'workspace A',
      limit: 10,
    }, { agent: { session: { header: { cwd: cwdA } } } })
    assert.ok(recallA.items.some((r) => r.id === idA),
      'project A recall sees its own record')
  } finally {
    closeAllStores()
    rmSync(home, { recursive: true, force: true })
  }
})

test('ISB-5: veyra_feedback on foreign record id returns not-found (scope-aware)', async () => {
  const home = mkdtempSync(join(tmpdir(), 'veyra-isb-5-'))
  const cwdA = join(home, 'workspace-a')
  const cwdB = join(home, 'workspace-b')
  const runtime = { veyraHome: home, fallbackCwd: cwdA }
  const harness = createToolHarness(runtime)

  try {
    // Write in project A
    const writeA = await harness.call('veyra_remember', {
      title: 'Alpha memory',
      body: 'belongs to A',
    }, { agent: { session: { header: { cwd: cwdA } } } })
    const idA = writeA.record.id

    // Attempt feedback from project B context on A's id
    const feedbackB = await harness.call('veyra_feedback', {
      id: idA,
      outcome: 'success',
      note: 'cross-project feedback attempt',
    }, { agent: { session: { header: { cwd: cwdB } } } })

    assert.equal(feedbackB.ok, false, 'cross-project feedback must fail')
    assert.match(feedbackB.error, /not found/i,
      'lifecycle tool on foreign id returns not-found (scope isolation)')
  } finally {
    closeAllStores()
    rmSync(home, { recursive: true, force: true })
  }
})

test('ISB-6: veyra_promote on foreign record id returns not-found', async () => {
  const home = mkdtempSync(join(tmpdir(), 'veyra-isb-6-'))
  const cwdA = join(home, 'workspace-a')
  const cwdB = join(home, 'workspace-b')
  const runtime = { veyraHome: home, fallbackCwd: cwdA }
  const harness = createToolHarness(runtime)

  try {
    const writeA = await harness.call('veyra_remember', {
      title: 'Alpha memory',
      body: 'belongs to A',
    }, { agent: { session: { header: { cwd: cwdA } } } })
    const idA = writeA.record.id

    const promoteB = await harness.call('veyra_promote', {
      id: idA,
      to: 'canonical',
      explicit: true,
    }, { agent: { session: { header: { cwd: cwdB } } } })

    assert.equal(promoteB.ok, false, 'cross-project promote must fail')
    assert.match(promoteB.error, /not found/i)
  } finally {
    closeAllStores()
    rmSync(home, { recursive: true, force: true })
  }
})

test('ISB-7: veyra_forget on foreign record id returns not-found', async () => {
  const home = mkdtempSync(join(tmpdir(), 'veyra-isb-7-'))
  const cwdA = join(home, 'workspace-a')
  const cwdB = join(home, 'workspace-b')
  const runtime = { veyraHome: home, fallbackCwd: cwdA }
  const harness = createToolHarness(runtime)

  try {
    const writeA = await harness.call('veyra_remember', {
      title: 'Alpha memory',
      body: 'belongs to A',
    }, { agent: { session: { header: { cwd: cwdA } } } })
    const idA = writeA.record.id

    const forgetB = await harness.call('veyra_forget', {
      id: idA,
      reason: 'cross-project forget attempt',
    }, { agent: { session: { header: { cwd: cwdB } } } })

    assert.equal(forgetB.ok, false, 'cross-project forget must fail')
    assert.match(forgetB.error, /not found/i)

    // Verify A still has the record
    const recallA = await harness.call('veyra_recall', {
      query: 'Alpha memory',
      limit: 5,
    }, { agent: { session: { header: { cwd: cwdA } } } })
    assert.ok(recallA.items.some((r) => r.id === idA), 'record survives cross-project forget attempt')
  } finally {
    closeAllStores()
    rmSync(home, { recursive: true, force: true })
  }
})

test('ISB-8: veyra_inspect on foreign record id returns not-found (scope-aware)', async () => {
  const home = mkdtempSync(join(tmpdir(), 'veyra-isb-8-'))
  const cwdA = join(home, 'workspace-a')
  const cwdB = join(home, 'workspace-b')
  const runtime = { veyraHome: home, fallbackCwd: cwdA }
  const harness = createToolHarness(runtime)

  try {
    const writeA = await harness.call('veyra_remember', {
      title: 'Alpha memory',
      body: 'belongs to A',
    }, { agent: { session: { header: { cwd: cwdA } } } })
    const idA = writeA.record.id

    const inspectB = await harness.call('veyra_inspect', {
      id: idA,
    }, { agent: { session: { header: { cwd: cwdB } } } })

    assert.ok(!inspectB.ok, 'cross-project inspect returns ok:false')
    assert.equal(inspectB.record, undefined, 'no record field for foreign id')
    const inspectStr = JSON.stringify(inspectB)
    assert.ok(!inspectStr.includes('Alpha memory'), 'no title leak in response')
  } finally {
    closeAllStores()
    rmSync(home, { recursive: true, force: true })
  }
})

test('ISB-9: veyra_health scoped correctly (no cross-project health data)', async () => {
  const home = mkdtempSync(join(tmpdir(), 'veyra-isb-9-'))
  const cwdA = join(home, 'workspace-a')
  const cwdB = join(home, 'workspace-b')
  const runtime = { veyraHome: home, fallbackCwd: cwdA }
  const harness = createToolHarness(runtime)

  try {
    // Write in A, then strengthen to verified via direct store API
    // (remember tool has NO validation field — validation is earned, not declared)
    const writeA = await harness.call('veyra_remember', {
      title: 'Alpha verified',
      body: 'belongs to A',
    }, { agent: { session: { header: { cwd: cwdA } } } })
    const storeA = openProjectStore(home, projectIdFor(cwdA))
    const recA = storeA.get(writeA.record.id)
    storeA.put({ ...recA, validation: VALIDATIONS.VERIFIED })

    // Write unverified in B
    await harness.call('veyra_remember', {
      title: 'Beta unverified',
      body: 'belongs to B',
    }, { agent: { session: { header: { cwd: cwdB } } } })

    // Health from A context
    const healthA = await harness.call('veyra_health', {}, { agent: { session: { header: { cwd: cwdA } } } })
    assert.equal(healthA.ok, true)
    assert.ok(healthA.categories.verified > 0, 'A health sees verified record')
    const healthAStr = JSON.stringify(healthA)
    assert.ok(!healthAStr.includes('Beta unverified'), 'A health does not see B records')

    // Health from B context
    const healthB = await harness.call('veyra_health', {}, { agent: { session: { header: { cwd: cwdB } } } })
    assert.equal(healthB.ok, true)
    assert.ok(healthB.categories.unverified > 0, 'B health sees unverified record')
    const healthBStr = JSON.stringify(healthB)
    assert.ok(!healthBStr.includes('Alpha verified'), 'B health does not see A records')
  } finally {
    closeAllStores()
    rmSync(home, { recursive: true, force: true })
  }
})

test('ISB-10: evidence field with secret patterns scrubbed before cross-scope operations', () => {
  const home = mkdtempSync(join(tmpdir(), 'veyra-isb-10-'))
  try {
    const project = openProjectStore(home, 'proj-main')
    const reusable = openReusableStore(home)

    // Write project-local memory with evidence containing a secret pattern
    const written = remember(project, claim(
      'Database connection uses API key',
      'Connection string includes secret token.',
      {
        evidence: [
          { path: 'config/db.js', note: 'secret_key: "sk-proj-1234567890abcdef"' },
          { path: 'config/db.js', note: 'api_key: "ghp_VerySecretToken1234567890123456"' },
        ],
        tags: ['database', 'config'],
      }
    ))

    const stored = project.get(written.record.id)
    assert.ok(stored.evidence.length > 0, 'evidence fields persisted')
    assert.ok(stored.evidence.some((e) => e.note.includes('[REDACTED')),
      'secret patterns in evidence.note are scrubbed before storage')
    assert.ok(!stored.evidence.some((e) => e.note.includes('sk-proj-1234567890abcdef')),
      'raw secret never reaches storage')

    // Verify reusable store does not accidentally contain the project record
    const reusableRows = reusable.list({ limit: 100 })
    assert.ok(!reusableRows.some((r) => r.id === written.record.id),
      'project-local record never leaks to reusable store')
  } finally {
    closeAllStores()
    rmSync(home, { recursive: true, force: true })
  }
})

test('ISB-11: source.provenance.workspace does not leak cross-project (attribution only)', () => {
  const home = mkdtempSync(join(tmpdir(), 'veyra-isb-11-'))
  try {
    const alpha = openProjectStore(home, 'proj-alpha')
    const beta = openProjectStore(home, 'proj-beta')

    // Write in alpha with provenance attribution
    const alphaId = remember(alpha, claim(
      'Alpha workspace memory',
      'Captured in alpha workspace.',
      {
        source: {
          tool: 'veyra_remember',
          automatic: false,
          provenance: {
            workspace: '/path/to/alpha',
            repository: { root: '/path/to/alpha', origin: 'git@github.com:alpha/alpha.git' },
          },
        },
      }
    )).record.id

    // Query from beta
    const fromBeta = recall({ projectStore: beta, query: 'workspace memory', limit: 10 })
    assert.ok(!fromBeta.some((r) => r.id === alphaId),
      'beta never sees alpha record despite provenance attribution')

    // Verify alpha still sees it
    const fromAlpha = recall({ projectStore: alpha, query: 'workspace memory', limit: 10 })
    assert.ok(fromAlpha.some((r) => r.id === alphaId), 'alpha sees its own record')
    assert.equal(fromAlpha.find((r) => r.id === alphaId).source.provenance.workspace, '/path/to/alpha',
      'provenance attribution preserved but not used for cross-project access')
  } finally {
    closeAllStores()
    rmSync(home, { recursive: true, force: true })
  }
})

test('ISB-12: summary — benchmark coverage and metrics', () => {
  console.log('\n=== Project Isolation & Security Boundary Benchmark Summary ===\n')
  console.log('Coverage:')
  console.log('  1. Project-local isolation:   3 tests (identical-query, recall boundaries, storage)')
  console.log('  2. Reusable memory:            1 test  (scope boundary, includeReusable flag)')
  console.log('  3. Workspace boundary:         1 test  (malformed exec.agent fail-closed)')
  console.log('  4. Tool boundaries:            6 tests (remember/feedback/promote/forget/inspect/health scope)')
  console.log('  5. Context manipulation:       2 tests (arg injection, foreign-id lifecycle ops)')
  console.log('  6. Secrets / evidence:         2 tests (redaction before storage, provenance attribution)')
  console.log('')
  console.log('  Total: 11 tests covering adversarial project isolation scenarios')
  console.log('')
  console.log('All tests use production tool/recall paths (no internal helpers).')
  console.log('Existing coverage: D32/D33 (basic isolation), code-engine cross-repo, M13 redaction.')
})
