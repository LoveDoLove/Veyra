/**
 * Change-Aware Trusted Context — focused regression coverage (GOAL.md Phase 2).
 *
 * Verifies the invariants required by Phase 2:
 *   - fresh relevant knowledge classifies as trusted
 *   - changed / stale knowledge classifies as review_required or stale
 *   - contradictions remain visible (both sides, never hidden)
 *   - candidates never become canonical through change processing
 *   - applicability / temporal rules are enforced in classification
 *   - degraded Code Intelligence is safe (reduced evidence, nothing fabricated)
 *   - project isolation stays intact
 *   - repeated processing creates no duplicate state or silent merges
 *   - the agent-facing render states the trust category with reasons
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { createToolHarness } from '../src/tools.mjs'
import { openProjectStore } from '../src/store.mjs'
import { projectIdFor, newRecordId } from '../src/ids.mjs'
import { AUTHORITIES, KINDS, STATUSES, VALIDATIONS } from '../src/types.mjs'
import { classifyRecordTrust, TRUST_CATEGORIES, TRUST_ACTIONS } from '../src/trust.mjs'
import { composeAgentContext, renderAgentContext, buildRecallContext } from '../src/context.mjs'
import { annotateContradictions } from '../src/evolve.mjs'

const testRuntime = (home, cwd, opts = {}) => ({
  veyraHome: home,
  fallbackCwd: cwd,
  codeEngine: opts.codeEngine || { isDegraded: true },
  log: { debug: () => {}, warn: () => {}, info: () => {} },
})

function makeRepo(t, files) {
  const tmp = mkdtempSync(join(tmpdir(), 'veyra-trust-test-'))
  t.after(() => rmSync(tmp, { recursive: true, force: true }))
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(tmp, rel)
    mkdirSync(dirname(abs), { recursive: true })
    writeFileSync(abs, content)
  }
  return tmp
}

function makeHome(t) {
  const home = mkdtempSync(join(tmpdir(), 'veyra-trust-home-'))
  t.after(() => rmSync(home, { recursive: true, force: true }))
  return home
}

function record(overrides = {}) {
  return {
    id: newRecordId(),
    kind: KINDS.KNOWLEDGE,
    status: STATUSES.CURRENT,
    validation: VALIDATIONS.VERIFIED,
    authority: AUTHORITIES.DERIVED,
    confidence: 'high',
    scope: 'project',
    title: 'Knowledge',
    body: 'body',
    evidence: [],
    source: { signal: 'test' },
    ...overrides,
  }
}

// ── classifyRecordTrust unit behaviour ───────────────────────────────────────

test('fresh relevant knowledge classifies as trusted', (t) => {
  const repo = makeRepo(t, { 'src/a.js': 'export const a = 1\n' })
  const rec = record({ evidence: [{ path: 'src/a.js' }] })
  const out = classifyRecordTrust(rec, { workspace: repo })
  assert.equal(out.category, TRUST_CATEGORIES.TRUSTED)
  assert.match(out.reasons.join(' '), /fresh/)
  assert.equal(out.action, TRUST_ACTIONS.trusted)
  assert.equal(out.degraded, false)
})

test('unrelated change list does not untrust an untouched record', (t) => {
  const repo = makeRepo(t, {
    'src/a.js': 'export const a = 1\n',
    'src/b.js': 'export const b = 2\n',
  })
  const rec = record({ evidence: [{ path: 'src/a.js' }] })
  const out = classifyRecordTrust(rec, { workspace: repo, changedFiles: ['src/b.js'] })
  assert.equal(out.category, TRUST_CATEGORIES.TRUSTED, 'unrelated change must not downgrade unrelated knowledge')
  assert.equal(out.changed, false)
  assert.deepEqual(out.changedFiles, [])
})

test('changed repository file downgrades the anchored record to review_required', (t) => {
  const repo = makeRepo(t, { 'src/a.js': 'export const a = 1\n' })
  const rec = record({ evidence: [{ path: 'src/a.js' }] })
  const out = classifyRecordTrust(rec, { workspace: repo, changedFiles: ['src/a.js'] })
  assert.equal(out.category, TRUST_CATEGORIES.REVIEW_REQUIRED)
  assert.match(out.reasons.join(' '), /related repository file changed/)
  assert.equal(out.changed, true)
  assert.deepEqual(out.changedFiles, ['src/a.js'])
})

test('stale code evidence classifies as stale, with the anchor reason kept', (t) => {
  const repo = makeRepo(t, { 'src/a.js': 'export const a = 2\n' })
  // hash recorded for different content → potentially_stale
  const rec = record({ evidence: [{ path: 'src/a.js', content_hash: 'deadbeef' }] })
  const out = classifyRecordTrust(rec, { workspace: repo })
  assert.equal(out.category, TRUST_CATEGORIES.STALE)
  assert.equal(out.freshness, 'potentially_stale')
  assert.equal(out.action, TRUST_ACTIONS.stale)
})

test('missing anchored file classifies as stale (invalid)', (t) => {
  const repo = makeRepo(t, { 'src/a.js': 'export const a = 1\n' })
  const rec = record({ evidence: [{ path: 'src/gone.js' }] })
  const out = classifyRecordTrust(rec, { workspace: repo })
  assert.equal(out.category, TRUST_CATEGORIES.STALE)
  assert.equal(out.freshness, 'invalid')
  assert.match(out.reasons.join(' '), /code evidence invalid/)
})

test('contradictions win precedence and both ids stay named', () => {
  const rec = record({
    evidence: [{ path: 'src/a.js' }],
    contradictions: ['other_id'],
    contradictionBanners: ['[CONTRADICTION: x contradicts y — verify against the repository]'],
  })
  const out = classifyRecordTrust(rec)
  assert.equal(out.category, TRUST_CATEGORIES.CONTRADICTED)
  assert.match(out.reasons.join(' '), /other_id/)
  assert.match(out.reasons.join(' '), /both sides remain visible/)
  assert.equal(out.action, TRUST_ACTIONS.contradicted)
})

test('candidate authority never classifies as trusted', () => {
  const rec = record({
    authority: AUTHORITIES.CANDIDATE,
    validation: VALIDATIONS.UNVERIFIED,
    evidence: [{ path: 'src/a.js' }],
  })
  const out = classifyRecordTrust(rec)
  assert.notEqual(out.category, TRUST_CATEGORIES.TRUSTED)
  assert.equal(out.category, TRUST_CATEGORIES.REVIEW_REQUIRED)
  assert.match(out.reasons.join(' '), /candidate/)
  assert.match(out.reasons.join(' '), /unverified/)
})

test('expired temporal validity classifies as stale; future validity as review_required', () => {
  const expired = record({ validUntil: '2020-01-01T00:00:00.000Z', evidence: [{ path: 'src/a.js' }] })
  const outExpired = classifyRecordTrust(expired)
  assert.equal(outExpired.category, TRUST_CATEGORIES.STALE)
  assert.equal(outExpired.temporal, 'expired')

  const future = record({ validFrom: '2999-01-01T00:00:00.000Z', evidence: [{ path: 'src/a.js' }] })
  const outFuture = classifyRecordTrust(future)
  assert.equal(outFuture.category, TRUST_CATEGORIES.REVIEW_REQUIRED)
  assert.equal(outFuture.temporal, 'not_yet_effective')
})

test('applicability mismatch (captured context vs current runtime) downgrades', () => {
  const rec = record({
    evidence: [{ path: 'src/a.js' }],
    source: { signal: 'test', context: { runtime: 'v0.1.0' } },
  })
  const out = classifyRecordTrust(rec)
  assert.equal(out.category, TRUST_CATEGORIES.REVIEW_REQUIRED)
  assert.match(out.reasons.join(' '), /applicability/)
})

test('no evidence at all classifies as insufficient_evidence', () => {
  const rec = record({ evidence: [] })
  const out = classifyRecordTrust(rec)
  assert.equal(out.category, TRUST_CATEGORIES.INSUFFICIENT_EVIDENCE)
  assert.match(out.reasons.join(' '), /no evidence or code anchors/)
  assert.equal(out.action, TRUST_ACTIONS.insufficient_evidence)
})

test('degraded Code Intelligence stays observable and never fabricates symbol evidence', (t) => {
  const repo = makeRepo(t, { 'src/a.js': 'export const a = 1\n' })
  const withPath = record({ evidence: [{ path: 'src/a.js', symbol: 'a' }] })
  const out = classifyRecordTrust(withPath, { workspace: repo, degraded: true })
  assert.equal(out.degraded, true)
  assert.ok(out.evidence.some((e) => /degraded/.test(e)), 'degraded state must be stated')
  assert.ok(out.evidence.some((e) => /no symbol or call-graph evidence/.test(e)))
  assert.deepEqual(out.changedFiles, [], 'degraded run invents no changed anchors')

  // symbol anchor without a path cannot be verified → no fabricated trust
  const symbolOnly = record({ evidence: [{ symbol: 'login' }] })
  const outSym = classifyRecordTrust(symbolOnly, { workspace: repo, degraded: true })
  assert.equal(outSym.category, TRUST_CATEGORIES.INSUFFICIENT_EVIDENCE)
  assert.match(outSym.reasons.join(' '), /degraded/)
})

// ── agent-facing rendering ───────────────────────────────────────────────────

test('renderAgentContext states the trust category and reason for each record', (t) => {
  const repo = makeRepo(t, { 'src/a.js': 'export const a = 1\n' })
  const trusted = record({ title: 'Fresh knowledge', evidence: [{ path: 'src/a.js' }] })
  const stale = record({ title: 'Stale knowledge', evidence: [{ path: 'src/gone.js' }] })
  const composed = composeAgentContext([trusted, stale], { workspace: repo })
  const text = renderAgentContext(composed)
  assert.match(text, /trust: TRUSTED/)
  assert.match(text, /⚠️ trust: STALE/)
  assert.match(text, /action: revalidate against the repository/)
  // hand-built entries without a classification still render (regression)
  const plain = renderAgentContext([{ record: trusted, status: 'current' }])
  assert.ok(plain.includes(trusted.id))
  assert.ok(!plain.includes('trust:'), 'no trust line without a classification')
})

test('composeAgentContext classifies without a workspace (no false freshness claims)', () => {
  const rec = record({ evidence: [{ path: 'src/a.js' }] })
  const composed = composeAgentContext([rec], {})
  assert.equal(composed.length, 1)
  assert.equal(composed[0].codeFreshness, null, 'no workspace → no freshness claim')
  assert.equal(composed[0].trust.category, TRUST_CATEGORIES.REVIEW_REQUIRED)
  assert.match(composed[0].trust.reasons.join(' '), /no workspace/)
})

// ── end-to-end via veyra_change_impact ───────────────────────────────────────

test('change impact classifies fresh unrelated knowledge as trusted next to affected review knowledge', async (t) => {
  const repo = makeRepo(t, {
    'src/auth.js': 'export function login() { return "ok"; }\n',
    'src/util.js': 'export function parse() { return 1; }\n',
  })
  const home = makeHome(t)
  const projectId = projectIdFor(repo)
  const store = openProjectStore(home, projectId)

  const affectedId = newRecordId()
  store.put(record({
    id: affectedId,
    title: 'Auth login flow',
    body: 'login() authenticates users.',
    evidence: [{ path: 'src/auth.js', symbol: 'login' }],
    scope: 'project',
    projectId,
  }))
  const unrelatedId = newRecordId()
  store.put(record({
    id: unrelatedId,
    title: 'Parser utility notes',
    body: 'parse() converts input.',
    evidence: [{ path: 'src/util.js' }],
    scope: 'project',
    projectId,
  }))

  const runtime = testRuntime(home, repo)
  const harness = createToolHarness(runtime)
  const result = await harness.call('veyra_change_impact', {
    repo,
    changedFiles: ['src/auth.js'],
    query: 'auth login and parser utility notes',
  })

  assert.equal(result.ok, true)
  const byId = new Map(result.context.map((c) => [c.memoryId, c]))
  assert.ok(byId.has(affectedId), 'affected knowledge is classified')
  assert.equal(byId.get(affectedId).category, TRUST_CATEGORIES.REVIEW_REQUIRED)
  assert.equal(byId.get(affectedId).affected, true)
  assert.match(byId.get(affectedId).reasons.join(' '), /related repository file changed/)

  assert.ok(byId.has(unrelatedId), 'retrieval-relevant untouched knowledge is classified too')
  assert.equal(byId.get(unrelatedId).category, TRUST_CATEGORIES.TRUSTED)
  assert.equal(byId.get(unrelatedId).affected, false)

  assert.equal(typeof result.summary.trusted, 'number')
  assert.equal(result.summary.trusted + result.summary.reviewRequired + result.summary.stale
    + result.summary.contradicted + result.summary.insufficientEvidence, result.context.length)
})

test('stale knowledge is reported stale, not silently rewritten', async (t) => {
  const repo = makeRepo(t, { 'src/a.js': 'export const a = 2\n' })
  const home = makeHome(t)
  const projectId = projectIdFor(repo)
  const store = openProjectStore(home, projectId)

  const memId = newRecordId()
  store.put(record({
    id: memId,
    title: 'Anchored fact',
    evidence: [{ path: 'src/a.js', content_hash: 'deadbeef' }],
    scope: 'project',
    projectId,
  }))
  const before = store.get(memId)

  const harness = createToolHarness(testRuntime(home, repo))
  const result = await harness.call('veyra_change_impact', { repo })

  const entry = result.context.find((c) => c.memoryId === memId)
  assert.ok(entry, 'record is classified')
  assert.equal(entry.category, TRUST_CATEGORIES.STALE)
  assert.equal(entry.freshness, 'potentially_stale')

  const after = store.get(memId)
  assert.deepEqual(after, before, 'classification never mutates the stored record')
  assert.equal(after.authority, AUTHORITIES.DERIVED)
  assert.equal(after.validation, VALIDATIONS.VERIFIED)
})

test('contradictions stay visible through change processing', async (t) => {
  const repo = makeRepo(t, { 'src/a.js': 'export const a = 1\n' })
  const home = makeHome(t)
  const projectId = projectIdFor(repo)
  const store = openProjectStore(home, projectId)

  const idA = newRecordId()
  const idB = newRecordId()
  store.put(record({
    id: idA,
    title: 'Claim A',
    evidence: [{ path: 'src/a.js' }],
    scope: 'project',
    projectId,
    relations: [{ type: 'contradicts', targetId: idB }],
  }))
  store.put(record({
    id: idB,
    title: 'Claim B',
    evidence: [{ path: 'src/a.js' }],
    scope: 'project',
    projectId,
    relations: [{ type: 'contradicts', targetId: idA }],
  }))

  const harness = createToolHarness(testRuntime(home, repo))
  const result = await harness.call('veyra_change_impact', { repo })

  const a = result.context.find((c) => c.memoryId === idA)
  const b = result.context.find((c) => c.memoryId === idB)
  assert.equal(a?.category, TRUST_CATEGORIES.CONTRADICTED)
  assert.equal(b?.category, TRUST_CATEGORIES.CONTRADICTED)
  assert.match(a.reasons.join(' '), new RegExp(idB), 'the contradicting partner stays named')

  // both sides survive; nothing merged or hidden
  assert.ok(store.get(idA), 'side A still stored')
  assert.ok(store.get(idB), 'side B still stored')

  const annotated = annotateContradictions(store.list({ limit: 50 }))
  const text = renderAgentContext(composeAgentContext(annotated, { workspace: repo }))
  assert.match(text, /CONTRADICTION/)
})

test('change processing never turns candidates canonical', async (t) => {
  const repo = makeRepo(t, { 'src/a.js': 'export const a = 1\n' })
  const home = makeHome(t)
  const projectId = projectIdFor(repo)
  const store = openProjectStore(home, projectId)

  const memId = newRecordId()
  store.put(record({
    id: memId,
    title: 'Anchored fact',
    evidence: [{ path: 'src/a.js', content_hash: 'deadbeef' }],
    scope: 'project',
    projectId,
  }))

  const harness = createToolHarness(testRuntime(home, repo))
  const result = await harness.call('veyra_change_impact', { repo, createCandidates: true })
  assert.ok(result.candidatesCreated >= 1, 'a review candidate was created')

  const all = store.list({ limit: 200, includeForgotten: false })
  const canonical = all.filter((r) => r.authority === AUTHORITIES.CANONICAL)
  assert.equal(canonical.length, 0, 'no record became canonical')
  const candidates = all.filter((r) => r.authority === AUTHORITIES.CANDIDATE)
  assert.ok(candidates.length >= 1)
  for (const c of candidates) {
    assert.equal(c.validation, VALIDATIONS.UNVERIFIED, 'candidates stay unverified')
    const entry = result.context.find((x) => x.memoryId === c.id)
    if (entry) assert.notEqual(entry.category, TRUST_CATEGORIES.TRUSTED)
  }
  // the original record is untouched
  const original = store.get(memId)
  assert.equal(original.authority, AUTHORITIES.DERIVED)
  assert.equal(original.validation, VALIDATIONS.VERIFIED)
})

test('project isolation: another project\'s knowledge is never classified into this context', async (t) => {
  const repo = makeRepo(t, { 'src/a.js': 'export const a = 1\n' })
  const otherRepo = makeRepo(t, { 'src/a.js': 'export const a = 1\n' })
  const home = makeHome(t)

  const projectId = projectIdFor(repo)
  const otherId = projectIdFor(otherRepo)

  const mine = openProjectStore(home, projectId)
  const other = openProjectStore(home, otherId)
  const mineId = newRecordId()
  mine.put(record({ id: mineId, title: 'Mine', evidence: [{ path: 'src/a.js' }], scope: 'project', projectId }))
  const foreignId = newRecordId()
  other.put(record({ id: foreignId, title: 'FOREIGN', evidence: [{ path: 'src/a.js' }], scope: 'project', projectId: otherId }))

  const harness = createToolHarness(testRuntime(home, repo))
  const result = await harness.call('veyra_change_impact', { repo })
  const ids = result.context.map((c) => c.memoryId)
  assert.ok(ids.includes(mineId))
  assert.ok(!ids.includes(foreignId), 'foreign project knowledge never enters the context')
})

test('degraded Code Intelligence yields a safe, observable degraded result', async (t) => {
  const repo = makeRepo(t, { 'src/a.js': 'export const a = 1\n' })
  const home = makeHome(t)
  const projectId = projectIdFor(repo)
  const store = openProjectStore(home, projectId)
  store.put(record({
    id: newRecordId(),
    title: 'Anchored fact',
    evidence: [{ path: 'src/a.js', symbol: 'a' }],
    scope: 'project',
    projectId,
  }))

  const runtime = testRuntime(home, repo, { codeEngine: { isDegraded: true } })
  const harness = createToolHarness(runtime)
  const result = await harness.call('veyra_change_impact', { repo, changedFiles: ['src/a.js'] })

  assert.equal(result.ok, true, 'degraded is not a failure')
  assert.equal(result.degraded, true)
  assert.ok(result.degradedReason, 'degraded state carries a reason')

  // degraded + changed anchor path still classifies (path matching only),
  // with no fabricated symbol or call-graph claims
  for (const c of result.context) {
    assert.ok(!('symbols' in c), 'no fabricated symbol evidence in degraded output')
    assert.ok(!('callGraph' in c), 'no fabricated call-graph evidence in degraded output')
    assert.match(c.reasons.join(' ') + c.evidence.join(' '), /./)
  }

  // ambient context reports degraded state via the classification evidence
  const memories = store.list({ limit: 50 })
  const annotated = annotateContradictions(memories)
  const composed = composeAgentContext(annotated, { workspace: repo, degraded: true })
  assert.ok(composed[0].trust.degraded, 'agent-facing context shows the degraded flag')
})

test('repeated processing is idempotent: same classification, no duplicate state', async (t) => {
  const repo = makeRepo(t, { 'src/a.js': 'export const a = 1\n' })
  const home = makeHome(t)
  const projectId = projectIdFor(repo)
  const store = openProjectStore(home, projectId)
  store.put(record({
    id: newRecordId(),
    title: 'Anchored fact',
    evidence: [{ path: 'src/a.js', content_hash: 'deadbeef' }],
    scope: 'project',
    projectId,
  }))

  const harness = createToolHarness(testRuntime(home, repo))
  const r1 = await harness.call('veyra_change_impact', { repo, createCandidates: true })
  const snapshot = () => JSON.stringify(
    store.list({ limit: 200, includeForgotten: false })
      .map((r) => ({ id: r.id, authority: r.authority, validation: r.validation, title: r.title, body: r.body }))
      .sort((a, b) => a.id.localeCompare(b.id)),
  )
  const after1 = snapshot()
  const r2 = await harness.call('veyra_change_impact', { repo, createCandidates: true })
  const after2 = snapshot()
  const r3 = await harness.call('veyra_change_impact', { repo, createCandidates: true })
  const after3 = snapshot()

  assert.deepEqual(after2, after1, 'second run changes no stored state')
  assert.deepEqual(after3, after2, 'third run changes no stored state')
  assert.deepEqual(
    r3.context.map((c) => ({ id: c.memoryId, category: c.category })),
    r2.context.map((c) => ({ id: c.memoryId, category: c.category })),
    'classification is deterministic across settled runs',
  )
  assert.deepEqual(r3.summary, r2.summary, 'summary is deterministic across settled runs')
  // the first run's candidate is already reflected in run 2 — nothing new
  // appears afterwards, and every pre-existing record classifies identically
  const catMap = (r) => new Map(r.context.map((c) => [c.memoryId, c.category]))
  const m1 = catMap(r1)
  const m2 = catMap(r2)
  for (const [id, category] of m1) {
    assert.ok(m2.has(id), 'run 1 records remain classified')
    assert.equal(m2.get(id), category, `record ${id} classifies identically after candidate creation`)
  }
  assert.equal(m2.size, m1.size + 1, 'run 2 gains exactly the candidate created by run 1')

  const all = store.list({ limit: 200, includeForgotten: false })
  assert.equal(all.filter((r) => r.authority === AUTHORITIES.CANONICAL).length, 0, 'still nothing canonical')
  // no silent merge: the original and its candidate are distinct records
  const original = all.find((r) => r.title === 'Anchored fact')
  const candidate = all.find((r) => r.authority === AUTHORITIES.CANDIDATE)
  assert.ok(original && candidate, 'both records survive side by side')
  assert.notEqual(original.id, candidate.id, 'no silent merge')
})

test('ambient recall context carries trust lines end-to-end', async (t) => {
  const repo = makeRepo(t, { 'src/a.js': 'export const a = 1\n' })
  const home = makeHome(t)
  const projectId = projectIdFor(repo)
  const store = openProjectStore(home, projectId)
  store.put(record({
    id: newRecordId(),
    title: 'Trusted ambient knowledge about veyra persist memory',
    body: 'records live in a sqlite store',
    evidence: [{ path: 'src/a.js' }],
    scope: 'project',
    projectId,
  }))

  const text = buildRecallContext({
    veyraHome: home,
    cwd: repo,
    query: 'where does veyra persist memory records',
  })
  assert.ok(text.length > 0)
  assert.match(text, /trust: (TRUSTED|⚠️ trust:)/)
})
