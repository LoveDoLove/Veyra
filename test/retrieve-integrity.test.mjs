/**
 * Retrieval-integrity regression coverage for the three focused fixes in
 * src/retrieve.mjs:
 *
 *   D1.1 / D2.1 - evidence-aware ranking: a verified, file-+test-evidenced,
 *                 high-confidence record is not outranked by a no-evidence,
 *                 low-confidence record on an equivalent query.
 *   D1.2        - conservative relevance floor, applied SORT-ONLY: a non-empty
 *                 query that shares no textual signal with a candidate demotes
 *                 it to the recency tier (still returned, sunk to the tail)
 *                 rather than removing it; a partial match stays in the signal
 *                 tier. This preserves the PMA / m11 "nothing is removed"
 *                 contract while keeping weak candidates out of the top slots.
 *   D5.2        - deterministic same-topic contradiction digest: two returned
 *                 candidates that state conflicting accounts of the same
 *                 topic both stay in the result set and each carries a banner.
 *
 * No LLM, no new dependencies, no schema or trust/authority change - these
 * pin sort-only ordering, one filter, and a pure digest pass.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { recall, evidenceSupportGrade, annotateTopicContradictions } from '../src/retrieve.mjs'
import { MemoryStore } from '../src/store.mjs'

function tempStore() {
  const dir = mkdtempSync(join(tmpdir(), 'veyra-retrieval-integrity-'))
  return new MemoryStore(join(dir, 'memory.db'), { scope: 'project', projectId: 'p' })
}

const BASE = {
  kind: 'memory', status: 'current', validation: 'unverified', authority: 'derived',
  confidence: 'low', scope: 'project', projectId: 'p', tags: [], evidence: [],
  relations: [], source: {}, forgotten: false,
  createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
  lastRecalledAt: null,
}

// ---------------------------------------------------------------------------
// evidenceSupportGrade - pure helper mapping
// ---------------------------------------------------------------------------

test('evidenceSupportGrade maps evidence+confidence to a 0..3 grade', () => {
  // file + test evidence (1.0) and high confidence -> top grade
  assert.equal(evidenceSupportGrade({ evidence: [{ path: 'src/x.mjs', note: 'test-passed' }], confidence: 'high' }), 3)
  // file evidence (0.7) but non-high confidence
  assert.equal(evidenceSupportGrade({ evidence: [{ path: 'src/x.mjs' }], confidence: 'medium' }), 2)
  // slash-bearing uri counts as file evidence (0.7); high confidence -> top grade
  assert.equal(evidenceSupportGrade({ evidence: [{ uri: 'https://x.example/doc' }], confidence: 'high' }), 3)
  // no meaningful evidence
  assert.equal(evidenceSupportGrade({ evidence: [], confidence: 'low' }), 0)
})

// ---------------------------------------------------------------------------
// D1.1 / D2.1 - evidence-aware ordering
// ---------------------------------------------------------------------------

test('D1.1: an evidenced high-confidence record outranks a no-evidence low-confidence one', () => {
  const store = tempStore()
  store.put({
    ...BASE, id: 'RC', title: 'warehouse stock drifts low after restart',
    body: 'The idempotency guard was dropped; a redelivered eventId double-deducts stock.',
    validation: 'verified', confidence: 'high',
    evidence: [{ path: 'src/warehouse.mjs', note: 'test-passed' }],
  })
  store.put({
    ...BASE, id: 'GUESS', title: 'warehouse stock drifts low after restart',
    body: 'Probably timer jitter; unconfirmed.',
    confidence: 'low', evidence: [],
  })
  const ranked = recall({ projectStore: store, query: 'warehouse stock drift low after restart root cause', limit: 10 })
  const order = ranked.map((r) => r.id)
  const rcIdx = order.indexOf('RC')
  const guessIdx = order.indexOf('GUESS')
  assert.ok(rcIdx >= 0, 'evidenced record is recalled')
  if (guessIdx >= 0) {
    assert.ok(rcIdx < guessIdx, 'evidenced record ranks above the unsupported one')
  }
  assert.equal(ranked[0].id, 'RC', 'top result is the evidenced record')
  store.close()
})

test('D2.1: on a (\u201cwhy\u201d) query the evidenced record still leads the unsupported one', () => {
  const store = tempStore()
  store.put({
    ...BASE, id: 'RC', title: 'warehouse stock drifts low after restart',
    body: 'Redelivered eventId double-deducts; the idempotency guard was missing.',
    confidence: 'high', evidence: [{ path: 'src/warehouse.mjs', note: 'test-passed' }],
  })
  store.put({
    ...BASE, id: 'NOEV', title: 'warehouse stock drifts low after restart',
    body: 'maybe a rounding bug, no evidence', confidence: 'low', evidence: [],
  })
  const ranked = recall({ projectStore: store, query: 'why does warehouse stock drift low', limit: 10 })
  const order = ranked.map((r) => r.id)
  assert.equal(order[0], 'RC', 'evidenced record leads on the equivalent “why” query')
  store.close()
})

// ---------------------------------------------------------------------------
// D1.2 - conservative relevance floor
// ---------------------------------------------------------------------------

test('D1.2: an unrelated query with zero shared signal is demoted, never emptied (PMA / m11)', () => {
  const store = tempStore()
  store.put({ ...BASE, id: 'A', title: 'sqlite writer race in WAL mode', body: 'serialize DatabaseSync writes under WAL' })
  store.put({ ...BASE, id: 'B', title: 'deploy timings and CI cache', body: 'the build cache expired during the deploy window' })
  const ranked = recall({ projectStore: store, query: 'kubernetes cluster autoscaler tuning', limit: 10 })
  // Sort-only floor: a zero-signal query does NOT empty the result set. Both
  // candidates are demoted to the recency tier but remain present, so both
  // sides of any contradiction stay visible and the recency pool is intact.
  assert.equal(ranked.length, 2, 'zero-signal query is demoted, not emptied')
  assert.deepEqual(ranked.map((r) => r.id).sort(), ['A', 'B'], 'both records remain present')
})

test('D1.2 edge: a genuine partial match still survives the floor', () => {
  const store = tempStore()
  store.put({ ...BASE, id: 'A', title: 'sqlite writer race in WAL mode', body: 'serialize DatabaseSync writes under WAL' })
  store.put({ ...BASE, id: 'B', title: 'deploy timings and CI cache', body: 'the build cache expired during the deploy window' })
  const ranked = recall({ projectStore: store, query: 'sqlite writer race', limit: 10 })
  assert.ok(ranked.map((r) => r.id).includes('A'), 'partial match survives the floor')
})

test('D1.2 edge: an empty query is untouched (recency browse preserved)', () => {
  const store = tempStore()
  store.put({ ...BASE, id: 'A', title: 'sqlite writer race in WAL mode', body: 'serialize DatabaseSync writes under WAL' })
  store.put({ ...BASE, id: 'B', title: 'deploy timings and CI cache', body: 'the build cache expired during the deploy window' })
  const ranked = recall({ projectStore: store, query: '', limit: 10 })
  assert.ok(ranked.length >= 2, 'empty query still surfaces recent records')
})

// ---------------------------------------------------------------------------
// D5.2 - deterministic same-topic contradiction digest
// ---------------------------------------------------------------------------

test('D5.2: two same-topic conflicting accounts both surface and each carries a banner', () => {
  const store = tempStore()
  store.put({
    ...BASE, id: 'R1', title: 'why the warehouse stock drifts low',
    body: 'the idempotency guard was dropped, so a redelivered event double-deducts',
    confidence: 'high', evidence: [{ path: 'src/warehouse.mjs' }],
  })
  store.put({
    ...BASE, id: 'R5', title: 'why the warehouse stock drifts low',
    body: 'it is not a double-deduct, it is a timer jitter in the retry loop',
    confidence: 'medium', evidence: [],
  })
  const ranked = recall({ projectStore: store, query: 'why does warehouse stock drift low', limit: 10 })
  const r1 = ranked.find((r) => r.id === 'R1')
  const r5 = ranked.find((r) => r.id === 'R5')
  assert.ok(r1 && r5, 'both conflicting accounts stay in the result set')
  assert.ok(r1.contradictionBanners?.length >= 1, 'R1 carries a topic-contradiction banner')
  assert.ok(r5.contradictionBanners?.length >= 1, 'R5 carries a topic-contradiction banner')
  assert.ok(r1.contradictionBanners[0].includes('TOPIC-CONTRADICTION'), 'banner is the topic digest')
  assert.ok(r1.contradictions?.includes('R5') && r5.contradictions?.includes('R1'), 'the pair cross-links')
  store.close()
})

test('D5.2 edge: disjoint topics do not trigger a false banner', () => {
  const a = { ...BASE, id: 'X', title: 'sqlite writer race', body: 'serialize DatabaseSync writes under WAL' }
  const b = { ...BASE, id: 'Y', title: 'deploy timings and CI cache', body: 'the build cache expired' }
  const out = annotateTopicContradictions([a, b])
  assert.equal((out.find((r) => r.id === 'X').contradictionBanners ?? []).length, 0, 'no banner for disjoint topics (read [] not undefined)')
  assert.equal((out.find((r) => r.id === 'Y').contradictionBanners ?? []).length, 0, 'no banner for disjoint topics (read [] not undefined)')
})

test('D5.2 edge: the digest never drops or merges either record', () => {
  const a = { ...BASE, id: 'R1', title: 'why the warehouse stock drifts low', body: 'the idempotency guard was dropped' }
  const b = { ...BASE, id: 'R5', title: 'why the warehouse stock drifts low', body: 'it is a timer jitter, not a double-deduct' }
  const out = annotateTopicContradictions([a, b])
  assert.equal(out.length, 2, 'both records survive')
  assert.deepEqual(out.map((r) => r.id).sort(), ['R1', 'R5'])
})
