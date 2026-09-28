/**
 * M11 — Recall Intelligence.
 *
 * Two deterministic improvements to the recall selection path, each pinned
 * here together with the semantics it must NOT change:
 *
 *  1. Zero-signal demotion tier (sort-only): under a non-empty query, a
 *     record with no textual signal (relevance 0 AND semantic 0) can no
 *     longer outrank any record that does match — regardless of metadata
 *     strength. Scores are never mutated and zero-signal records remain
 *     fully recallable (the recency pool still fills context when nothing
 *     matches).
 *
 *  2. Near-duplicate suppression (selection-only): before the top-K cut,
 *     a record whose claim is a near-superset of an already-selected claim
 *     (containment >= 0.5, >= 4 shared tokens) is dropped so freed slots go
 *     to distinct facts. Relation-linked pairs, contradiction partners,
 *     differing-negation claims, and short claims are never suppressed.
 *
 * Everything else — lifecycle eligibility, project isolation, contradiction
 * surfacing, polarity caps, provenance, recency feedback, determinism — is
 * asserted unchanged.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { rankRecords, recall } from '../src/retrieve.mjs'
import { detectIntent, intentWeights } from '../src/intent.mjs'
import { MemoryStore } from '../src/store.mjs'
import { composeAgentContext, renderAgentContext } from '../src/context.mjs'

const BASE = {
  kind: 'memory', status: 'current', validation: 'unverified',
  authority: 'derived', confidence: 'low', scope: 'project', projectId: 'p',
  tags: [], evidence: [], relations: [], source: {},
  createdAt: '2024-01-01T00:00:00.000Z', updatedAt: '2024-01-01T00:00:00.000Z',
}

const rec = (id, title, extra = {}) => ({ ...BASE, id, title, body: title, ...extra })

function tempStore() {
  const dir = mkdtempSync(join(tmpdir(), 'veyra-m11-'))
  return new MemoryStore(join(dir, 'memory.db'), { scope: 'project', projectId: 'p' })
}

// Weighted-sum reference: composite must always equal the plain weighted sum
// of its own components (nothing is added, subtracted, or renormalized).
const W = { relevance: 0.32, evidence: 0.18, validation: 0.18, proximity: 0.14,
            freshness: 0.08, confidence: 0.10, semantic: 0.10, relationship: 0.04 }
const expectedComposite = (s, intent = null) => {
  const w = { ...W, ...intentWeights(intent) }
  return Number((
    s.relevance * w.relevance + s.semantic * w.semantic
    + s.evidence_strength * w.evidence + s.validation_tier * w.validation
    + s.scope_proximity * w.proximity + s.freshness_tier * w.freshness
    + s.confidence * w.confidence + s.relationship * w.relationship
    + s.intent_affinity
  ).toFixed(4))
}

const FRESH = () => new Date().toISOString()

// ---------------------------------------------------------------------------
// 1. Zero-signal demotion tier
// ---------------------------------------------------------------------------

test('a zero-signal record with perfect metadata cannot outrank a genuine match', () => {
  const s = tempStore()
  s.put({ ...BASE, id: 'GENUINE', title: 'CI flake from writer race',
    body: 'CI jobs fail intermittently when two writers race on the queue.',
    createdAt: '2025-06-01T00:00:00.000Z', updatedAt: '2025-06-01T00:00:00.000Z' })
  s.put({ ...BASE, id: 'PERFECT_META', title: 'Release branch naming convention',
    body: 'Release branches use release/x.y.z prefixes and are tagged before merging to main.',
    validation: 'verified', confidence: 'high',
    evidence: [{ path: 'src/ci.yml', note: 'test-passed' }],
    createdAt: FRESH(), updatedAt: FRESH(),
    source: { causal: {
      symptom: 'CI jobs fail intermittently on release builds',
      rootCause: 'writer race on the shared queue',
      remedy: 'serialize queue writes per runner',
      verifiedOutcome: 'test-passed',
    } } })
  const r = recall({ projectStore: s, query: 'why does CI fail intermittently', limit: 5 })
  assert.equal(r.length, 2, 'both records stay recallable — nothing is removed')
  assert.equal(r[0].id, 'GENUINE', 'the record that matches the query comes first')
  const meta = r.find((x) => x.id === 'PERFECT_META')
  assert.equal(Number(meta.scores.relevance), 0)
  assert.equal(Number(meta.scores.semantic), 0)
  // Demotion is sort-only: every dimensional score and the composite
  // remain the plain weighted sum.
  for (const x of r) {
    assert.equal(x.scores.composite, expectedComposite(x.scores, 'why'),
      `${x.id} composite must be the unmodified intent-weighted sum`)
    assert.equal(x.scores.polarity_mismatch, undefined, 'the tier is not a polarity cap')
    assert.equal(x.status, 'current')
    assert.equal(x.authority, 'derived')
  }
  s.close()
})

test('a weak-signal record outranks a zero-signal maximum-metadata record', () => {
  const s = tempStore()
  s.put({ ...BASE, id: 'DECOY', title: 'wal contention note',
    body: 'The wal frames replay from the archive directory after crash recovery.',
    evidence: [{ note: 'wal recovery note' }],
    createdAt: '2024-03-01T00:00:00.000Z', updatedAt: '2024-03-01T00:00:00.000Z' })
  s.put({ ...BASE, id: 'STRONG', title: 'api gateway timeouts',
    body: 'The gateway returns 504 during peak traffic windows.',
    validation: 'verified', confidence: 'high',
    evidence: [{ path: 'src/gw.ts', note: 'tests-touched' }],
    createdAt: FRESH(), updatedAt: FRESH() })
  const r = recall({ projectStore: s, query: 'wal deadlock', limit: 5 })
  assert.equal(r.length, 2)
  assert.equal(r[0].id, 'DECOY', 'textual signal beats metadata strength')
  const strong = r.find((x) => x.id === 'STRONG')
  assert.ok(strong, 'the zero-signal record remains recallable')
  assert.equal(Number(strong.scores.relevance), 0)
  assert.equal(Number(strong.scores.semantic), 0)
  s.close()
})

test('zero-signal records all share one tier, so their composite order is untouched', () => {
  // Nothing matches the query: the tier is uniform, so ordering falls back
  // to composite/recency exactly as before — the recency pool still fills
  // the context.
  const s = tempStore()
  s.put({ ...BASE, id: 'R1', title: 'ordinary note one', body: 'first ordinary note about widgets' })
  s.put({ ...BASE, id: 'R2', title: 'ordinary note two', body: 'second ordinary note about gears',
    createdAt: '2024-02-01T00:00:00.000Z', updatedAt: '2024-02-01T00:00:00.000Z' })
  s.put({ ...BASE, id: 'R3', title: 'ordinary note three', body: 'third ordinary note about pulleys',
    createdAt: '2024-03-01T00:00:00.000Z', updatedAt: '2024-03-01T00:00:00.000Z' })
  const r = recall({ projectStore: s, query: 'quantum blockchain', limit: 5 })
  assert.deepEqual(r.map((x) => x.id), ['R3', 'R2', 'R1'], 'recency order preserved when nothing matches')
  for (const x of r) {
    assert.equal(Number(x.scores.relevance), 0)
    assert.equal(Number(x.scores.semantic), 0)
  }
  s.close()
})

test('empty query keeps recency semantics (tier is inactive without a query)', () => {
  const s = tempStore()
  s.put({ ...BASE, id: 'OLD', title: 'older row', body: 'the older row in the store',
    createdAt: '2024-01-01T00:00:00.000Z', updatedAt: '2024-01-01T00:00:00.000Z' })
  s.put({ ...BASE, id: 'NEW', title: 'newer row', body: 'the newer row in the store',
    createdAt: '2025-01-01T00:00:00.000Z', updatedAt: '2025-01-01T00:00:00.000Z' })
  const r = recall({ projectStore: s, query: '', limit: 5 })
  assert.deepEqual(r.map((x) => x.id), ['NEW', 'OLD'])
  s.close()
})

test('the demotion tier is deterministic across repeated runs', () => {
  const build = () => {
    const s = tempStore()
    s.put({ ...BASE, id: 'GENUINE', title: 'CI flake from writer race',
      body: 'CI jobs fail intermittently when two writers race on the queue.',
      createdAt: '2025-06-01T00:00:00.000Z', updatedAt: '2025-06-01T00:00:00.000Z' })
    s.put({ ...BASE, id: 'PERFECT_META', title: 'Release branch naming convention',
      body: 'Release branches use release/x.y.z prefixes and are tagged before merging to main.',
      validation: 'verified', confidence: 'high',
      evidence: [{ path: 'src/ci.yml', note: 'test-passed' }],
      createdAt: FRESH(), updatedAt: FRESH() })
    return s
  }
  const s = build()
  const runs = []
  for (let i = 0; i < 5; i++) {
    runs.push(JSON.stringify(recall({ projectStore: s, query: 'why does CI fail intermittently', limit: 5 })
      .map((x) => [x.id, x.scores.composite])))
  }
  assert.equal(new Set(runs).size, 1, 'five runs produce identical ids and composites')
  s.close()
})

// ---------------------------------------------------------------------------
// 2. Near-duplicate redundancy suppression
// ---------------------------------------------------------------------------

const NEAR_BODIES = [
  'The migration runner must lock the schema mutex before applying any DDL change to the database.',
  'Before any DDL change reaches the database, the migration runner locks the schema mutex.',
  'Lock the schema mutex in the migration runner prior to applying DDL changes to the database.',
]
const putNear = (s) => NEAR_BODIES.forEach((body, i) => s.put({
  ...BASE, id: `NEAR${i + 1}`, title: `Migration lock ${i + 1}`, body,
  createdAt: '2025-01-01T00:00:00.000Z', updatedAt: `2025-01-0${i + 1}T00:00:00.000Z`,
}))

test('near-duplicate wordings collapse to one; freed slots go to distinct facts', () => {
  const s = tempStore()
  putNear(s)
  s.put({ ...BASE, id: 'D1', title: 'Rollback snapshot',
    body: 'Snapshot the schema table before rollback in the migration tool.',
    createdAt: '2025-02-01T00:00:00.000Z', updatedAt: '2025-02-01T00:00:00.000Z' })
  s.put({ ...BASE, id: 'D2', title: 'Locked error symptom',
    body: 'Mutex contention shows up as database locked errors under load.',
    createdAt: '2025-03-01T00:00:00.000Z', updatedAt: '2025-03-01T00:00:00.000Z' })
  const r = recall({ projectStore: s, query: 'migration schema mutex', limit: 4 })
  const ids = r.map((x) => x.id)
  const near = ids.filter((id) => id.startsWith('NEAR'))
  assert.equal(near.length, 1, 'only one wording survives')
  assert.ok(near[0] >= 'NEAR1' && near[0] <= 'NEAR3', 'the survivor is one of the wordings')
  assert.ok(ids.includes('D1') && ids.includes('D2'), 'freed slots are backfilled with distinct facts')
  assert.ok(r.length <= 4, 'suppression never grows the result')
  // Suppression is reflected in the composed agent context too.
  const out = renderAgentContext(composeAgentContext(r, { stores: [s] }))
  for (const id of ['NEAR1', 'NEAR2', 'NEAR3']) {
    assert.equal(out.includes(`[${id}]`), id === near[0], `context renders only the surviving wording (${near[0]})`)
  }
  s.close()
})

test('guard: records connected by a relation are never suppressed', () => {
  const s = tempStore()
  s.put({ ...BASE, id: 'AFFIRM', title: 'serialize writes', body: 'Always serialize DatabaseSync writes.' })
  s.put({ ...BASE, id: 'NEGATE', title: 'do not serialize writes', body: 'Do not serialize DatabaseSync writes.' })
  const a = s.get('AFFIRM'); s.put({ ...a, relations: [{ type: 'contradicts', targetId: 'NEGATE' }] })
  const n = s.get('NEGATE'); s.put({ ...n, relations: [{ type: 'contradicts', targetId: 'AFFIRM' }] })
  const r = recall({ projectStore: s, query: 'serialize writes', limit: 5 })
  assert.equal(r.length, 2, 'both sides of the contradiction stay visible')
  for (const x of r) assert.ok(x.contradictionBanners?.length > 0, `${x.id} keeps its banner`)
  s.close()
})

test('guard: an unannotated negation pair is never suppressed', () => {
  // "serialize writes" vs "do not serialize writes" are opposing claims,
  // not duplicates — negation parity must hold even though the texts are
  // nearly identical after stopword removal.
  const s = tempStore()
  s.put({ ...BASE, id: 'AFFIRM', title: 'serialize writes', body: 'Always serialize DatabaseSync writes.' })
  s.put({ ...BASE, id: 'NEGATE', title: 'do not serialize writes', body: 'Do not serialize DatabaseSync writes.' })
  const r = recall({ projectStore: s, query: 'serialize writes', limit: 5 })
  assert.equal(r.length, 2, 'both polarity directions remain recallable')
  assert.equal(r[0].id, 'AFFIRM')
  s.close()
})

test('guard: short claims (fewer than 4 shared tokens) are never suppressed', () => {
  const s = tempStore()
  s.put({ ...BASE, id: 'S1', title: 'sqlite wal lock', body: 'sqlite wal lock held during checkpoint' })
  s.put({ ...BASE, id: 'S2', title: 'sqlite wal lock here', body: 'sqlite wal lock here after restart' })
  const r = recall({ projectStore: s, query: 'sqlite wal lock', limit: 5 })
  assert.equal(r.length, 2, 'coarse short claims are too imprecise to dedupe')
  s.close()
})

// ---------------------------------------------------------------------------
// 3. Unchanged semantics: lifecycle, isolation, provenance, feedback, intents
// ---------------------------------------------------------------------------

test('lifecycle: ineligible records are still excluded from recall', () => {
  const s = tempStore()
  s.put({ ...BASE, id: 'OK', title: 'live knowledge about locking', body: 'Lock the writer before writing pages.' })
  s.put({ ...BASE, id: 'FORGOTTEN', title: 'live knowledge about locking', body: 'Forgotten copy about locking pages.', forgotten: true })
  s.put({ ...BASE, id: 'STALE', title: 'live knowledge about locking', body: 'Stale copy about locking pages.', validation: 'stale' })
  s.put({ ...BASE, id: 'INVALID', title: 'live knowledge about locking', body: 'Invalid copy about locking pages.', validation: 'invalid' })
  s.put({ ...BASE, id: 'CANDIDATE', title: 'live knowledge about locking', body: 'Candidate copy about locking pages.', authority: 'candidate' })
  s.put({ ...BASE, id: 'OBS', title: 'live knowledge about locking', body: 'Observation copy about locking pages.', kind: 'observation' })
  const r = recall({ projectStore: s, query: 'locking writer knowledge', limit: 10 })
  assert.deepEqual(r.map((x) => x.id), ['OK'])
  s.close()
})

test('project isolation: a near-duplicate reusable copy never displaces the project record, distinct reusable records still arrive', () => {
  const s = tempStore()
  s.put({ ...BASE, id: 'P1', title: 'claim about the project store',
    body: 'a claim that belongs to this project store and is owned here' })
  const rdir = mkdtempSync(join(tmpdir(), 'veyra-m11-r-'))
  const reusable = new MemoryStore(join(rdir, 'memory.db'), { scope: 'project', projectId: 'p' })
  // Byte-identical reusable copy of the project claim → suppressed as a duplicate.
  reusable.put({ ...BASE, id: 'R_COPY', scope: 'reusable', projectId: 'other_project',
    title: 'claim about the project store',
    body: 'a claim that belongs to this project store and is owned here' })
  // Distinct reusable knowledge → must still be recalled.
  reusable.put({ ...BASE, id: 'R_DISTINCT', scope: 'reusable', projectId: 'other_project',
    title: 'shared lesson about checkpoints',
    body: 'run wal checkpoints manually when the disk fills up' })
  const r = recall({ projectStore: s, reusableStore: reusable,
    query: 'project store claim checkpoint', limit: 5, includeReusable: true })
  const ids = r.map((x) => x.id)
  assert.ok(ids.includes('P1'), 'the project record is recalled')
  assert.ok(ids.includes('R_DISTINCT'), 'deliberate reusable knowledge is still shareable')
  assert.ok(!ids.includes('R_COPY'), 'a duplicate copy adds nothing over the project record')
  s.close(); reusable.close()
})

test('provenance: M8-carrying records recall normally and keep their origins', () => {
  const s = tempStore()
  s.put({ ...BASE, id: 'PROV', title: 'capture boundary lesson',
    body: 'tool preview text must not become a claim without provenance',
    source: { provenance: { origins: ['user', 'tool'] } } })
  const r = recall({ projectStore: s, query: 'capture boundary provenance claim', limit: 5 })
  assert.equal(r.length, 1)
  assert.deepEqual(r[0].source.provenance.origins, ['user', 'tool'])
  s.close()
})

test('recall feedback: last_recalled_at is written by touch but has no ranking effect', () => {
  const s = tempStore()
  s.put({ ...BASE, id: 'A', title: 'alpha row about timers', body: 'a row about timers alpha' })
  s.put({ ...BASE, id: 'B', title: 'beta row about timers', body: 'a row about timers beta' })
  // (a) no ranking effect
  const touched = rec('A', 'alpha row about timers', { lastRecalledAt: FRESH() })
  const untouched = rec('B', 'beta row about timers', { lastRecalledAt: null })
  const [x, y] = rankRecords([touched, untouched], { query: 'row about timers' })
  assert.equal(x.scores.composite, y.scores.composite, 'recency feedback never changes the score')
  // (b) touch still writes the field (observable feedback loop)
  const before = s.get('A').lastRecalledAt
  s.touch(['A'])
  const after = s.get('A').lastRecalledAt
  assert.ok(!before, 'not recalled yet')
  assert.ok(after, 'touch writes last_recalled_at')
  s.close()
})

test('intent extraction is unchanged: why/how/symptom still classify', () => {
  assert.equal(detectIntent('why does CI fail intermittently'), 'why')
  assert.equal(detectIntent('how do I serialize writes'), 'how')
  assert.equal(detectIntent('sqlite wal deadlock symptom'), 'symptom')
})

test('tie-breaking stays stable: equal composites keep input order', () => {
  const a = rec('A', 'same title about pipes')
  const b = rec('B', 'same title about pipes')
  const r1 = rankRecords([a, b], { query: 'title pipes' })
  const r2 = rankRecords([b, a], { query: 'title pipes' })
  assert.equal(r1[0].id, 'A')
  assert.equal(r2[0].id, 'B')
})

test('limit: 0 still short-circuits to no recall', () => {
  const s = tempStore()
  putNear(s)
  assert.deepEqual(recall({ projectStore: s, query: 'migration schema mutex', limit: 0 }), [])
  s.close()
})

test('contradiction extras still exceed the limit when a linked side would be cut', () => {
  const s = tempStore()
  s.put({ ...BASE, id: 'AFFIRM', title: 'serialize writes', body: 'Always serialize DatabaseSync writes.' })
  s.put({ ...BASE, id: 'NEGATE', title: 'do not serialize writes', body: 'Do not serialize DatabaseSync writes.' })
  const a = s.get('AFFIRM'); s.put({ ...a, relations: [{ type: 'contradicts', targetId: 'NEGATE' }] })
  const n = s.get('NEGATE'); s.put({ ...n, relations: [{ type: 'contradicts', targetId: 'AFFIRM' }] })
  const r = recall({ projectStore: s, query: 'serialize writes', limit: 1 })
  const ids = r.map((x) => x.id)
  assert.ok(ids.length >= 2, 'the linked contradiction side is appended past the limit')
  assert.ok(ids.includes('AFFIRM') && ids.includes('NEGATE'))
  s.close()
})
