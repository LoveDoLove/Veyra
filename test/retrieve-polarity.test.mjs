/**
 * M4.3 D1 — polarity blindness in retrieval ranking.
 *
 * `not`/`no`/`never` are stopwords, so "serialize writes" and "do not
 * serialize writes" tokenize identically and scored 1.0 on textual
 * similarity, letting a negated record outrank the affirmative one.
 *
 * The fix is a RANKING COMPATIBILITY CONSTRAINT in `rankRecords`, not a change
 * to `semanticSimilarity` (which stays purely textual) and not a change to the
 * `hasNegation` detector (which stays exactly as it was).
 *
 * These tests pin the behaviour AND the non-behaviour: a mismatched candidate
 * must still be recallable, must keep every metadata component, and must not
 * be removed, invalidated, or demoted.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { rankRecords, recall, semanticSimilarity } from '../src/retrieve.mjs'
import { hasNegation } from '../src/text.mjs'
import { MemoryStore } from '../src/store.mjs'

const BASE = {
  kind: 'memory', status: 'current', validation: 'unverified',
  authority: 'derived', confidence: 'low', scope: 'project', projectId: 'p',
  tags: [], evidence: [], relations: [], source: {},
  createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
}

const rec = (id, title, extra = {}) => ({ ...BASE, id, title, body: title, ...extra })

const AFFIRM = rec('AFFIRM', 'serialize writes')
const NEGATE = rec('NEGATE', 'do not serialize writes')

function tempStore() {
  const dir = mkdtempSync(join(tmpdir(), 'veyra-m43-'))
  return new MemoryStore(join(dir, 'memory.db'), { scope: 'project', projectId: 'p' })
}

// ---------------------------------------------------------------------------
// semanticSimilarity itself must NOT change
// ---------------------------------------------------------------------------

test('semanticSimilarity is untouched: it remains purely textual', () => {
  assert.equal(semanticSimilarity('serialize writes', { title: 'serialize writes', body: '', tags: [] }), 1)
  // The underlying confusion still exists — that is deliberate. The fix is at
  // the ranking layer, so this test would FAIL if someone "fixed" it here.
  assert.equal(semanticSimilarity('serialize writes', { title: 'do not serialize writes', body: '', tags: [] }), 1)
})

// ---------------------------------------------------------------------------
// Basic polarity ranking
// ---------------------------------------------------------------------------

test('affirmative query ranks the affirmative record first', () => {
  const r = rankRecords([NEGATE, AFFIRM], { query: 'serialize writes' })
  assert.equal(r[0].id, 'AFFIRM')
  assert.equal(r[0].scores.polarity_compatible, true)
})

test('affirmative query cannot be answered by the negated record', () => {
  const r = rankRecords([NEGATE, AFFIRM], { query: 'serialize writes' })
  const negate = r.find((x) => x.id === 'NEGATE')
  assert.equal(negate.scores.polarity_compatible, false)
  assert.ok(negate.scores.polarity_mismatch, 'the mismatch must be visible in the scores')
})

test('negated query is answered by the negated record (symmetric)', () => {
  const r = rankRecords([AFFIRM, NEGATE], { query: 'do not serialize writes' })
  assert.equal(r[0].id, 'NEGATE')
  const affirm = r.find((x) => x.id === 'AFFIRM')
  assert.equal(affirm.scores.polarity_compatible, false)
})

test('negated query with negated record ranks normally, not capped', () => {
  const r = rankRecords([AFFIRM, NEGATE], { query: 'do not serialize writes' })
  const negate = r.find((x) => x.id === 'NEGATE')
  assert.equal(negate.scores.polarity_compatible, true)
  assert.equal(negate.scores.polarity_mismatch, undefined)
})

// ---------------------------------------------------------------------------
// Every marker form in the existing detector
// ---------------------------------------------------------------------------

for (const marker of ['do not', 'never', 'no', 'cannot', 'without', 'none', "don't", "doesn't", "can't"]) {
  test(`marker "${marker}" is treated as negation on the record side`, () => {
    const negated = rec('NEG', `${marker} serialize writes`)
    assert.equal(hasNegation(negated.title), true, 'detector must recognise the marker')
    const r = rankRecords([negated, AFFIRM], { query: 'serialize writes' })
    assert.equal(r[0].id, 'AFFIRM', `record with "${marker}" must not outrank the affirmative`)
    assert.equal(r.find((x) => x.id === 'NEG').scores.polarity_compatible, false)
  })
}

test('marker forms on the QUERY side are also honoured', () => {
  for (const q of ['do not serialize writes', 'never serialize writes', "don't serialize writes"]) {
    const r = rankRecords([AFFIRM, NEGATE], { query: q })
    assert.equal(r[0].id, 'NEGATE', `query "${q}" must prefer the negated record`)
  }
})

// ---------------------------------------------------------------------------
// Negation placement
// ---------------------------------------------------------------------------

for (const text of [
  'do not write concurrently',
  'never serialize database writes',
  'writes should not be serialized',
  'without serialization',
  'none of the writes',
]) {
  test(`placement "${text}" is detected`, () => {
    assert.equal(hasNegation(text), true)
    const r = rankRecords([rec('NEG', text), rec('AFF', 'write concurrently')], { query: 'write concurrently' })
    assert.equal(r.find((x) => x.id === 'NEG').scores.polarity_compatible, false)
  })
}

// ---------------------------------------------------------------------------
// False-positive regression — the detector must not broaden
// ---------------------------------------------------------------------------

for (const word of ['notebook', 'notification', 'notation', 'no_op']) {
  test(`"${word}" is NOT negation (detector must not broaden)`, () => {
    assert.equal(hasNegation(word), false, 'hasNegation must stay exactly as it was')
    const r = rankRecords([rec('A', `${word} serialize writes`), AFFIRM], { query: 'serialize writes' })
    assert.equal(r.find((x) => x.id === 'A').scores.polarity_compatible, true)
  })
}

test('"no-op" stays an accepted existing false positive (pinned, not changed)', () => {
  // Hyphen is the one unguarded separator in NEGATION_MARKERS. This is
  // pre-existing behaviour and is deliberately NOT changed by D1.
  assert.equal(hasNegation('no-op change'), true)
  const r = rankRecords([rec('A', 'no-op change'), AFFIRM], { query: 'serialize writes' })
  assert.equal(r.find((x) => x.id === 'A').scores.polarity_compatible, false)
})

// ---------------------------------------------------------------------------
// The constraint is a cap, not a deletion
// ---------------------------------------------------------------------------

test('a polarity-mismatched candidate stays fully recallable', () => {
  const store = tempStore()
  store.put({ ...BASE, id: 'AFFIRM', title: 'serialize writes', body: 'Always serialize DatabaseSync writes.' })
  store.put({ ...BASE, id: 'NEGATE', title: 'do not serialize writes', body: 'Do not serialize DatabaseSync writes.' })
  const r = recall({ projectStore: store, query: 'serialize writes', limit: 5 })
  assert.equal(r.length, 2, 'both records must remain recallable')
  assert.equal(r[0].id, 'AFFIRM')
  store.close()
})

test('metadata components are preserved on a mismatched candidate', () => {
  const strong = rec('NEG', 'do not serialize writes', {
    validation: 'verified', confidence: 'high', evidence: [{ path: 'src/store.mjs', note: 'test-passed' }],
  })
  const r = rankRecords([strong, AFFIRM], { query: 'serialize writes' })
  const neg = r.find((x) => x.id === 'NEG')
  assert.equal(neg.status, 'current', 'lifecycle status is untouched')
  assert.equal(neg.authority, 'derived', 'authority is untouched')
  assert.equal(neg.validation, 'verified', 'validation is untouched')
  assert.equal(neg.confidence, 'high', 'confidence is untouched')
  assert.equal(neg.scores.validation_tier, 1.0, 'validation tier is untouched')
  assert.equal(neg.scores.evidence_strength, 1.0, 'evidence is untouched')
  assert.equal(neg.scores.confidence, 1.0, 'confidence score is untouched')
})

test('the mismatch cannot be overridden by strong metadata', () => {
  // A polarity-mismatched record with maximum metadata still must not win.
  const strong = rec('NEG', 'do not serialize writes', {
    validation: 'verified', confidence: 'high',
    evidence: [{ path: 'src/store.mjs', note: 'test-passed' }],
    updatedAt: new Date().toISOString(),
  })
  const r = rankRecords([strong, AFFIRM], { query: 'serialize writes' })
  assert.equal(r[0].id, 'AFFIRM', 'metadata must not lift a mismatched record above a matching one')
})

// ---------------------------------------------------------------------------
// Existing contradiction behaviour must be preserved
// ---------------------------------------------------------------------------

test('records with a contradicts relation keep their banner and stay visible', () => {
  const store = tempStore()
  store.put({ ...BASE, id: 'AFFIRM', title: 'serialize writes', body: 'Always serialize DatabaseSync writes.' })
  store.put({ ...BASE, id: 'NEGATE', title: 'do not serialize writes', body: 'Do not serialize DatabaseSync writes.' })
  // Simulate the edge that diff.mjs would have written.
  const a = store.get('AFFIRM')
  store.put({ ...a, relations: [{ type: 'contradicts', targetId: 'NEGATE' }] })
  const n = store.get('NEGATE')
  store.put({ ...n, relations: [{ type: 'contradicts', targetId: 'AFFIRM' }] })

  const r = recall({ projectStore: store, query: 'serialize writes', limit: 5 })
  assert.equal(r.length, 2, 'both sides stay visible')
  for (const x of r) {
    assert.ok(x.contradictionBanners && x.contradictionBanners.length > 0, `${x.id} keeps its banner`)
  }
  store.close()
})

// ---------------------------------------------------------------------------
// Non-polarity regression
// ---------------------------------------------------------------------------

test('candidates with matching polarity are scored exactly as before', () => {
  const a = rec('A', 'serialize writes')
  const b = rec('B', 'deploy pipeline runs weekly')
  const r = rankRecords([a, b], { query: 'serialize writes' })
  for (const x of r) {
    assert.equal(x.scores.polarity_compatible, true)
    assert.equal(x.scores.polarity_mismatch, undefined, 'no cap is applied')
  }
  // The composite must equal the plain weighted sum of its own components —
  // i.e. nothing was added to or subtracted from the score.
  const w = { relevance: 0.32, evidence: 0.18, validation: 0.18, proximity: 0.14,
              freshness: 0.08, confidence: 0.10, semantic: 0.10, relationship: 0.04 }
  for (const x of r) {
    const s = x.scores
    const expected = Number((
      s.relevance * w.relevance + s.semantic * w.semantic
      + s.evidence_strength * w.evidence + s.validation_tier * w.validation
      + s.scope_proximity * w.proximity + s.freshness_tier * w.freshness
      + s.confidence * w.confidence + s.relationship * w.relationship
      + s.intent_affinity
    ).toFixed(4))
    assert.equal(s.composite, expected, `${x.id} composite must be the unmodified weighted sum`)
  }
})

test('a query with no negation imposes no constraint at all', () => {
  const r = rankRecords([
    rec('A', 'notebook handling is fine'),
    rec('B', 'notification preferences are stored'),
    rec('C', 'serialize writes'),
  ], { query: 'serialize writes' })
  assert.equal(r.length, 3)
  for (const x of r) assert.equal(x.scores.polarity_compatible, true)
})

// ---------------------------------------------------------------------------
// Ceiling tie-break: capped records must not inherit input/Map insertion order
// ---------------------------------------------------------------------------

test('capped mismatches keep their true relative order via the pre-cap key', () => {
  // Both mismatches land on the same ceiling value; their originals differ.
  const m1 = rec('M1', 'do not serialize writes', { validation: 'verified' })
  const m2 = rec('M2', 'never serialize writes', { validation: 'reviewed' })
  const c = rec('C', 'serialize writes')
  const r = rankRecords([m1, m2, c], { query: 'serialize writes' })
  assert.deepEqual(r.map((x) => x.id), ['C', 'M1', 'M2'])
  const x1 = r.find((x) => x.id === 'M1')
  const x2 = r.find((x) => x.id === 'M2')
  assert.equal(x1.scores.composite, x2.scores.composite, 'both are capped to the same value')
  assert.ok(x1.scores.polarity_original_composite > x2.scores.polarity_original_composite)
})

test('reversing candidate insertion order produces an identical ranking', () => {
  const m1 = rec('M1', 'do not serialize writes', { validation: 'verified' })
  const m2 = rec('M2', 'never serialize writes', { validation: 'reviewed' })
  const c = rec('C', 'serialize writes')
  const orders = [
    [m1, m2, c],
    [m2, m1, c],
    [c, m1, m2],
    [c, m2, m1],
    [m1, c, m2],
    [m2, c, m1],
  ]
  const results = orders.map((set) => rankRecords(set, { query: 'serialize writes' }).map((x) => x.id))
  for (const res of results) {
    assert.deepEqual(res, results[0], 'every insertion order must rank identically')
    assert.deepEqual(res, ['C', 'M1', 'M2'])
  }
})

test('two mismatches with equal original composite remain a stable tie', () => {
  // Identical polarity text and identical metadata -> identical originals.
  const m1 = rec('M1', 'do not serialize writes')
  const m2 = rec('M2', 'do not serialize writes')
  const c = rec('C', 'serialize writes')
  const a = rankRecords([m1, m2, c], { query: 'serialize writes' })
  const b = rankRecords([m2, m1, c], { query: 'serialize writes' })
  const x1 = a.find((x) => x.id === 'M1')
  const x2 = a.find((x) => x.id === 'M2')
  assert.equal(x1.scores.polarity_original_composite, x2.scores.polarity_original_composite)
  // A true tie has no defensible winner, so it is left stable rather than
  // invented; only the SET of ranked ids is asserted.
  assert.deepEqual([...a.map((x) => x.id)].sort(), [...b.map((x) => x.id)].sort())
  assert.equal(a[0].id, 'C', 'the compatible candidate still ranks first')
})

test('a mismatch below the ceiling is not modified', () => {
  const c = rec('C', 'serialize writes', { validation: 'verified', confidence: 'high' })
  const low = rec('LOW', 'without serialize writes', { validation: 'unverified', confidence: 'low' })
  const r = rankRecords([low, c], { query: 'serialize writes' })
  const m = r.find((x) => x.id === 'LOW')
  assert.equal(m.scores.composite, m.scores.polarity_original_composite, 'value must be untouched')
  assert.equal(m.scores.polarity_mismatch, true, 'the flag is still set honestly')
})

test('the pre-cap key is recorded but never added to the weighted score', () => {
  const m1 = rec('M1', 'do not serialize writes', { validation: 'verified' })
  const c = rec('C', 'serialize writes')
  const r = rankRecords([m1, c], { query: 'serialize writes' })
  const m = r.find((x) => x.id === 'M1')
  const compatible = r.find((x) => x.id === 'C')
  // The reported composite is the capped value, not the original.
  assert.equal(m.scores.composite, Number((compatible.scores.composite - 0.0001).toFixed(4)))
  assert.notEqual(m.scores.composite, m.scores.polarity_original_composite)
  // The compatible candidate is completely untouched by the ceiling block.
  assert.equal(compatible.scores.polarity_original_composite, undefined)
})

test('no-compatible-candidate set is unchanged and deterministic', () => {
  const only = [rec('N1', 'do not serialize writes'), rec('N2', 'never serialize writes')]
  const a = rankRecords(only, { query: 'serialize writes' })
  const b = rankRecords([...only].reverse(), { query: 'serialize writes' })
  for (const x of a) {
    assert.equal(x.scores.polarity_original_composite, undefined, 'no key is written')
    assert.equal(x.scores.polarity_mismatch, undefined, 'no flag is written')
    assert.ok(Number.isFinite(x.scores.composite), 'composite must stay finite')
    assert.ok(x.scores.composite > 0, 'composite must stay positive')
  }
  assert.deepEqual(a.map((x) => x.id), b.map((x) => x.id), 'ordering is score-determined')
})

test('a negated query with only affirmative candidates stays deterministic', () => {
  const only = [rec('A1', 'serialize writes'), rec('A2', 'serialize database writes')]
  const a = rankRecords(only, { query: 'do not serialize writes' })
  assert.equal(a.length, 2, 'both remain recallable')
  for (const x of a) assert.ok(Number.isFinite(x.scores.composite))
  assert.equal(a[0].id, 'A1')
})
