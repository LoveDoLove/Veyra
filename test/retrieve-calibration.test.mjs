/**
 * F4-A regression coverage: rank-position lexical calibration.
 *
 * `relevanceFromRank` used `abs(bm25)/(1+abs(bm25))`. SQLite's bm25 magnitude
 * is corpus-dependent and collapses toward ~1e-6 for common terms in a small
 * memory store, so a genuine FTS match reported relevance ~0 and the 0.32-weight
 * dimension was left to the substring bonus. It now reads the zero-based FTS
 * result position: 1/(1+position).
 *
 * These tests pin the calibration AND the non-behaviour: recency-fallback rows
 * must not receive an artificial position, the duplicate merge must keep the
 * FTS-ranked copy, and the existing bonuses are untouched.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { relevanceFromRank, lexicalScore, recall, RELEVANCE_SEM_FLOOR } from '../src/retrieve.mjs'
import { MemoryStore } from '../src/store.mjs'

const BASE = {
  kind: 'memory', status: 'current', validation: 'unverified', authority: 'derived',
  confidence: 'low', scope: 'project', projectId: 'p', tags: [], evidence: [{ path: 'a.mjs' }],
  relations: [], source: {}, forgotten: false,
  createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
  lastRecalledAt: null,
}

function tempStore() {
  const dir = mkdtempSync(join(tmpdir(), 'veyra-f4a-'))
  return new MemoryStore(join(dir, 'memory.db'), { scope: 'project', projectId: 'p' })
}

// ---------------------------------------------------------------------------
// 1. Position calibration
// ---------------------------------------------------------------------------

test('relevance is 1/(1+position) for the documented positions', () => {
  assert.equal(relevanceFromRank({ ftsPosition: 0 }, 0, true), 1)
  assert.equal(relevanceFromRank({ ftsPosition: 1 }, 0, true), 0.5)
  assert.ok(Math.abs(relevanceFromRank({ ftsPosition: 2 }, 0, true) - 1 / 3) < 1e-12)
  assert.ok(Math.abs(relevanceFromRank({ ftsPosition: 4 }, 0, true) - 0.2) < 1e-12)
})

test('relevance does not read raw bm25 magnitude', () => {
  // A genuine-but-tiny rank must NOT collapse relevance toward zero anymore.
  assert.equal(relevanceFromRank({ ftsPosition: 0, rank: -0.0000036 }, 0, true), 1)
  assert.equal(relevanceFromRank({ ftsPosition: 1, rank: -0.0000036 }, 0, true), 0.5)
})

// ---------------------------------------------------------------------------
// 2. No result-count inflation
// ---------------------------------------------------------------------------

for (const hits of [1, 3, 10, 30]) {
  test(`top result scores 1 with ${hits} FTS hit(s)`, () => {
    const store = tempStore()
    store.put({ ...BASE, id: 'TOP', title: 'zebra crossing bug', body: 'the exact answer' })
    for (let i = 1; i < hits; i += 1) {
      store.put({ ...BASE, id: `M${i}`, title: `zebra partial ${i}`, body: `padding ${i}` })
    }
    const found = store.search('zebra crossing bug', { limit: 100, recallOnly: true })
    const top = found.find((r) => r.id === 'TOP')
    assert.ok(top, 'top must be discovered')
    assert.equal(top.ftsPosition, 0)
    assert.equal(relevanceFromRank(top, 0, true), 1, 'top relevance must not depend on hit count')
    store.close()
  })
}

// ---------------------------------------------------------------------------
// 3. Ordering is monotonic with FTS position
// ---------------------------------------------------------------------------

test('earlier FTS positions always score >= later ones', () => {
  const store = tempStore()
  store.put({ ...BASE, id: 'A', title: 'zebra crossing bug', body: 'a' })
  for (let i = 1; i < 12; i += 1) {
    store.put({ ...BASE, id: `M${i}`, title: `zebra padding ${i}`, body: `b${i}` })
  }
  const found = store.search('zebra crossing bug', { limit: 100, recallOnly: true })
  const rels = found.map((r) => relevanceFromRank(r, 0, true))
  for (let i = 1; i < rels.length; i += 1) {
    assert.ok(rels[i - 1] >= rels[i], `position ${i - 1} must score >= position ${i}`)
  }
  assert.ok(rels.every((v) => v > 0 && v <= 1), 'relevance stays bounded in (0,1]')
  store.close()
})

// ---------------------------------------------------------------------------
// 4. Fallback isolation
// ---------------------------------------------------------------------------

test('recency-fallback rows receive no FTS position and score 0 under a query', () => {
  const store = tempStore()
  for (let i = 0; i < 5; i += 1) {
    store.put({ ...BASE, id: `U${i}`, title: `unrelated ${i}`, body: `nothing matches ${i}` })
  }
  // A query whose tokens appear in no document -> FTS returns nothing ->
  // search() falls back to the recency listing.
  const found = store.search('zzqqxx', { limit: 50, recallOnly: true })
  assert.equal(found.length, 5)
  for (const r of found) {
    assert.equal(r.ftsPosition, undefined, 'fallback rows must not get a position')
    assert.equal(relevanceFromRank(r, 0, true), 0)
  }
  const ranked = recall({ projectStore: store, query: 'zzqqxx', limit: 5 })
  for (const r of ranked) assert.equal(r.scores.relevance, 0)
  store.close()
})

test('a recency-only record is demoted, not removed, in a real recall', () => {
  const store = tempStore()
  store.put({ ...BASE, id: 'HIT', title: 'sqlite writer race', body: 'a' })
  store.put({ ...BASE, id: 'NEAR', title: 'deploy timings', body: 'unrelated prose' })
  const ranked = recall({ projectStore: store, query: 'sqlite writer race', limit: 10 })
  const hit = ranked.find((r) => r.id === 'HIT')
  assert.ok(hit, 'the matching record is still recalled')
  // Sort-only relevance floor: an unrelated recency-only record shares no
  // textual signal with the query (relevance 0 AND semantic < floor), so it is
  // demoted to the recency tier and sinks to the tail — but it is still
  // returned (PMA / m11 "nothing is removed"), and the matching record ranks
  // above it. Before this contract it contaminated the top with relevance 0;
  // the floor now pins it to the tail instead.
  const near = ranked.find((r) => r.id === 'NEAR')
  assert.ok(near, 'unrelated recency-only record is demoted, not removed')
  assert.ok(
    ranked.findIndex((r) => r.id === 'HIT') < ranked.findIndex((r) => r.id === 'NEAR'),
    'the matching record ranks above the demoted recency-only one',
  )
  // The floor predicate governs the tier: the matching record sits in the
  // signal tier, the demoted one fails it.
  assert.ok(hit.scores.relevance > 0 || hit.scores.semantic >= RELEVANCE_SEM_FLOOR, 'the matching record sits in the signal tier')
  assert.ok(!(near.scores.relevance > 0 || near.scores.semantic >= RELEVANCE_SEM_FLOOR), 'the demoted record fails the floor, so it is tiered low')
  store.close()
})

// ---------------------------------------------------------------------------
// 5. Duplicate merge keeps the FTS-ranked copy
// ---------------------------------------------------------------------------

test('a record discovered by both FTS and recency keeps its FTS position', () => {
  const store = tempStore()
  store.put({ ...BASE, id: 'A', title: 'sqlite writer race in WAL mode', body: 'a sqlite writer race corrupts the index' })
  store.put({ ...BASE, id: 'B', title: 'deploy timings', body: 'unrelated' })
  const ranked = recall({ projectStore: store, query: 'sqlite writer race', limit: 10 })
  const a = ranked.find((r) => r.id === 'A')
  assert.equal(a.ftsPosition, 0, 'the FTS copy must win the merge')
  assert.equal(a.scores.relevance, 1)
  // Exactly one copy, never two.
  assert.equal(ranked.filter((r) => r.id === 'A').length, 1)
  store.close()
})

// ---------------------------------------------------------------------------
// 6/7. F4 fixtures
// ---------------------------------------------------------------------------

function f4Fixture(weakOverrides) {
  const store = tempStore()
  store.put({
    ...BASE, id: 'REL', validation: 'unverified', confidence: 'low',
    title: 'sqlite writer race in WAL mode',
    body: 'A sqlite writer race corrupts the FTS index; serialize DatabaseSync writes under WAL.',
    evidence: [{ path: 'src/store.mjs' }],
  })
  store.put({
    ...BASE, id: 'WEAK',
    title: 'deploy pipeline timings',
    body: 'The deploy pipeline finished in four minutes and released the branch today.',
    ...weakOverrides,
  })
  return store
}

test('F4-E: an all-strong weak record no longer outranks the genuine match', () => {
  // First line of defence is the relevance floor, applied SORT-ONLY: WEAK
  // shares no textual signal with the query (relevance 0, semantic 0), so it is
  // demoted to the recency tier and sinks to the tail, but it is still returned
  // (PMA / m11 "nothing is removed") — the genuine match leads.
  const store = f4Fixture({
    validation: 'verified', confidence: 'high',
    evidence: [{ path: 'test/deploy.test.mjs', note: 'test-passed' }],
    updatedAt: new Date().toISOString(),
  })
  const r = recall({ projectStore: store, query: 'sqlite writer race', limit: 5 })
  assert.equal(r[0].id, 'REL', 'the genuine match leads even with a fully-armed weak record demoted behind it')
  assert.ok(r.map((x) => x.id).includes('WEAK'), 'the weak record is demoted, not removed (PMA / m11)')
  // The floor governs the tier: REL sits in the signal tier, WEAK fails it and
  // is therefore demoted to the tail.
  const relDef = r.find((x) => x.id === 'REL')
  const weakDef = r.find((x) => x.id === 'WEAK')
  assert.ok(relDef.scores.relevance > 0 || relDef.scores.semantic >= RELEVANCE_SEM_FLOOR, 'REL sits in the signal tier')
  assert.ok(!(weakDef.scores.relevance > 0 || weakDef.scores.semantic >= RELEVANCE_SEM_FLOOR), 'WEAK fails the floor, so it is demoted')

  // Ordering is the invariant that matters, and it survives with the floor
  // switched off — nothing is dropped from ranking, it is only filtered out of
  // the answer. REL's absolute composite moves with the fixture's freshness
  // (the experiment harness gave both records the same 400-day age, which is
  // why it read 0.815 rather than 0.767), so the test pins the winner and the
  // margin rather than a magic number.
  const unfiltered = recall({
    projectStore: store, query: 'sqlite writer race', limit: 5, relevanceFloor: 0,
  })
  const rel = unfiltered.find((x) => x.id === 'REL')
  const weak = unfiltered.find((x) => x.id === 'WEAK')
  assert.ok(weak, 'with the floor off the weak record is still ranked')

  // WEAK reproduces the audited value exactly: its score is entirely metadata,
  // and calibration must not change any metadata component.
  assert.ok(Math.abs(weak.scores.composite - 0.684) < 0.005, `WEAK ~0.684, got ${weak.scores.composite}`)

  assert.equal(unfiltered[0].id, 'REL', 'the genuinely relevant record must rank first')
  assert.ok(rel.scores.composite > weak.scores.composite)
  assert.ok(
    weak.scores.composite - rel.scores.composite < 0,
    'the weak record must not win on metadata alone',
  )
  // REL wins because it is the only one with any textual signal at all.
  assert.ok(rel.scores.relevance > 0 && rel.scores.semantic > 0)
  assert.equal(weak.scores.relevance, 0)
  store.close()
})

test('F4-B: high validation alone no longer inverts the order', () => {
  const store = f4Fixture({ validation: 'verified' })
  // Default recall: the no-signal record is demoted to the tail, never
  // removed — the genuine textual match leads.
  const r = recall({ projectStore: store, query: 'sqlite writer race', limit: 5 })
  assert.equal(r[0].id, 'REL', 'the genuine match leads; the no-signal record is demoted behind it')
  assert.ok(r.map((x) => x.id).includes('WEAK'), 'the no-signal record is demoted, not removed (PMA / m11)')
  // With the floor off it is ranked, and validation alone still cannot invert
  // the order: the genuine textual match keeps the top position.
  const unfiltered = recall({
    projectStore: store, query: 'sqlite writer race', limit: 5, relevanceFloor: 0,
  })
  assert.equal(unfiltered[0].id, 'REL')
  assert.ok(
    unfiltered.find((x) => x.id === 'REL').scores.composite
      > unfiltered.find((x) => x.id === 'WEAK').scores.composite,
  )
  store.close()
})

// ---------------------------------------------------------------------------
// 8/9. Existing bonuses still apply
// ---------------------------------------------------------------------------

test('the substring bonus still applies after rank calibration', () => {
  const withBonus = lexicalScore({ ...BASE, ftsPosition: 1, title: 'zebra crossing bug', body: 'x' }, 'zebra crossing bug', 0)
  const withoutBonus = lexicalScore({ ...BASE, ftsPosition: 1, title: 'zebra', body: 'x' }, 'zebra crossing bug', 0)
  assert.equal(withoutBonus, 0.5)
  assert.equal(withBonus, 0.7, '0.5 from position 1 plus the 0.2 substring bonus')
})

test('the tag bonus still contributes independently of FTS position', () => {
  const withTag = lexicalScore({ ...BASE, ftsPosition: 1, title: 'x', body: 'x', tags: ['zebra crossing bug'] }, 'zebra crossing bug', 0)
  const withoutTag = lexicalScore({ ...BASE, ftsPosition: 1, title: 'x', body: 'x', tags: [] }, 'zebra crossing bug', 0)
  assert.equal(withoutTag, 0.5)
  assert.equal(withTag, 0.65, '0.5 from position 1 plus the 0.15 tag bonus')
})
