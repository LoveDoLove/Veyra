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
import { relevanceFromRank, lexicalScore, recall } from '../src/retrieve.mjs'
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

test('a recency-only record is not given a position in a real recall', () => {
  const store = tempStore()
  store.put({ ...BASE, id: 'HIT', title: 'sqlite writer race', body: 'a' })
  store.put({ ...BASE, id: 'NEAR', title: 'deploy timings', body: 'unrelated prose' })
  const ranked = recall({ projectStore: store, query: 'sqlite writer race', limit: 10 })
  const near = ranked.find((r) => r.id === 'NEAR')
  assert.ok(near, 'near record is still recallable')
  assert.equal(near.ftsPosition, undefined)
  assert.equal(near.scores.relevance, 0, 'no artificial relevance for a non-FTS candidate')
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
  const store = f4Fixture({
    validation: 'verified', confidence: 'high',
    evidence: [{ path: 'test/deploy.test.mjs', note: 'test-passed' }],
    updatedAt: new Date().toISOString(),
  })
  const r = recall({ projectStore: store, query: 'sqlite writer race', limit: 5 })
  const rel = r.find((x) => x.id === 'REL')
  const weak = r.find((x) => x.id === 'WEAK')

  // WEAK reproduces the audited value exactly: its score is entirely metadata,
  // and calibration must not change any metadata component.
  assert.ok(Math.abs(weak.scores.composite - 0.684) < 0.005, `WEAK ~0.684, got ${weak.scores.composite}`)

  // The ordering is the invariant that matters. REL's absolute composite moves
  // with the fixture's freshness (the experiment harness gave both records the
  // same 400-day age, which is why it read 0.815 rather than 0.767), so the
  // test pins the winner and the margin rather than a magic number.
  assert.equal(r[0].id, 'REL', 'the genuinely relevant record must rank first')
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
  const r = recall({ projectStore: store, query: 'sqlite writer race', limit: 5 })
  assert.equal(r[0].id, 'REL')
  assert.ok(r.find((x) => x.id === 'REL').scores.composite > r.find((x) => x.id === 'WEAK').scores.composite)
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
