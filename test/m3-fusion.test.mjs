/**
 * M3 — Multi-channel rank fusion (GOAL.md Phase 3 / §10 / §11 / §14).
 *
 * Phase 3 strengthens retrieval with a deterministic rank-fusion layer:
 *
 *   - a NEW causal channel (`source.causal` facets scored against the
 *     query, so records that document WHY/HOW fail become retrievable
 *     on that basis alone),
 *   - reciprocal rank fusion (RRF) across the nine §10 signals —
 *     lexical (FTS5/BM25), semantic (token overlap), intent, relations,
 *     causal, evidence, negative history (polarity), temporal
 *     (freshness), applicability (scope proximity) — copied from the
 *     reference `dsh-memory md_cg/mdcos.py` (RRF_K = 60, score(d) =
 *     Σ_path w_path / (RRF_K + rank_path(d))),
 *   - a sort-only `scores.fusion = composite + FUSION_WEIGHT * rrf`;
 *     `scores.composite` remains the plain weighted sum its pinned
 *     contract requires (nothing added, subtracted, or renormalized),
 *   - the polarity invariant holds on BOTH scores: a mismatched
 *     candidate can never outrank the best compatible one, even with
 *     the RRF consensus term behind it,
 *   - empty-query pools are a recency browse: fusion is inactive and
 *     ordering is byte-identical to the legacy chain,
 *   - every score (incl. causal/rrf/fusion) is exposed on results for
 *     §11 retrieval explainability — no opaque ranking.
 *
 * All ordering claims are asserted as final output order only; no test
 * reaches for internal sort stages.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { KINDS } from '../src/types.mjs'
import { openEphemeralStore, closeAllStores } from '../src/store.mjs'
import { remember } from '../src/learn.mjs'
import { addRejected, addUnresolved } from '../src/negative.mjs'
import {
  NEG_COVERAGE_SCORE,
  RRF_K,
  FUSION_WEIGHT,
  causalRelevance,
  hybridRetrieve,
  rankRecords,
  reciprocalRankFusion,
} from '../src/retrieve.mjs'

const W = { relevance: 0.32, semantic: 0.10, evidence: 0.18, validation: 0.18, proximity: 0.14, freshness: 0.08, confidence: 0.10, relationship: 0.04 }

const BASE = {
  scope: 'project',
  source: { origin: 'session', observer: 'test' },
  authority: 'derived',
  validation: 'derived',
  confidence: 0.5,
  tags: [],
  relations: [],
  evidence: [],
  kind: KINDS.MEMORY,
  createdAt: 1700000000000,
  updatedAt: 1700000000000,
}
const rec = (id, title, extra = {}) => ({ ...BASE, id, title, body: title, ...extra })

// Pinned composite contract (mirrors m11-recall-intelligence): the
// composite must always equal the plain weighted sum of its own
// components — no causal term, no fusion term, nothing renormalized.
const expectedComposite = (s) => Number((
  s.relevance * W.relevance
  + s.semantic * W.semantic
  + s.evidence_strength * W.evidence
  + s.validation_tier * W.validation
  + s.scope_proximity * W.proximity
  + s.freshness_tier * W.freshness
  + s.confidence * W.confidence
  + s.relationship * W.relationship
  + s.intent_affinity
).toFixed(4))

// ---------------------------------------------------------------------------
// Constants — copied from the reference implementation, not invented.
// ---------------------------------------------------------------------------

test('RRF constants are the reference values (mdcos.py RRF_K = 60)', () => {
  assert.equal(RRF_K, 60)
  assert.equal(FUSION_WEIGHT, 0.06)
})

// ---------------------------------------------------------------------------
// reciprocalRankFusion — pure function contract.
// ---------------------------------------------------------------------------

test('reciprocalRankFusion returns null when no channel discriminates', () => {
  const same = { lexical: 0.9, semantic: 0.5, intent_affinity: 0.4, relationship: 0.1, causal: 0, evidence_strength: 0.7, polarity_compatible: true, freshness_tier: 0.5, scope_proximity: 0.8 }
  const scored = [{ scores: { ...same } }, { scores: { ...same } }, { scores: { ...same } }]
  assert.equal(reciprocalRankFusion(scored), null)
  assert.equal(reciprocalRankFusion([]), null)
  assert.equal(reciprocalRankFusion(null), null)
})

test('reciprocalRankFusion: rank 1 in every channel normalizes to 1 and runs are deterministic', () => {
  const scored = [
    { scores: { lexical: 1.0, causal: 0.9, freshness_tier: 0.9 } },
    { scores: { lexical: 0.5, causal: 0.4, freshness_tier: 0.4 } },
    { scores: { lexical: 0.2, causal: 0.1, freshness_tier: 0.1 } },
  ]
  const r1 = reciprocalRankFusion(scored)
  assert.ok(Array.isArray(r1))
  assert.equal(r1.length, 3)
  assert.equal(r1[0], 1) // top of every included channel = the normalization max
  assert.ok(r1[0] > r1[1] && r1[1] > r1[2])
  const r2 = reciprocalRankFusion(scored)
  assert.deepEqual(r1, r2) // same input, byte-identical output
})

test('reciprocalRankFusion: multi-channel consensus outranks a single-channel hit', () => {
  // A is runner-up in ALL three channels; B wins exactly one and sinks
  // in the other two. RRF must prefer the consensus record.
  const scored = [
    { scores: { lexical: 0.6, causal: 0.6, evidence_strength: 0.6 } }, // A: rank 2,2,2
    { scores: { lexical: 1.0, causal: 0.2, evidence_strength: 0.5 } }, // B: rank 1,3,3
    { scores: { lexical: 0.2, causal: 0.8, evidence_strength: 0.9 } }, // C: rank 3,1,1
  ]
  const r = reciprocalRankFusion(scored)
  assert.ok(r[0] > r[1], `consensus A (${r[0]}) must beat single-path B (${r[1]})`)
  // Raw check against the reference formula: sum over channels of 1/(RRF_K+rank).
  const aRaw = 1 / (RRF_K + 2) + 1 / (RRF_K + 2) + 1 / (RRF_K + 2)
  const maxRaw = 3 / (RRF_K + 1)
  assert.equal(r[0], Number((aRaw / maxRaw).toFixed(4)))
})

test('reciprocalRankFusion: value ties break by input index (stable, deterministic)', () => {
  const scored = [
    { scores: { lexical: 0.9 } },
    { scores: { lexical: 0.9 } },
    { scores: { lexical: 0.5 } },
  ]
  const r = reciprocalRankFusion(scored)
  assert.ok(r[0] > r[1]) // identical values → earlier input wins the tie
  assert.ok(r[1] > r[2])
})

// ---------------------------------------------------------------------------
// The causal channel (Phase 3, GOAL §14 Causal Memory).
// ---------------------------------------------------------------------------

test('causalRelevance: no query or no causal facets scores 0; matching facets score above 0', () => {
  const withCausal = rec('c1', 'Release pipeline', { source: { causal: { rootCause: 'writer race under concurrency', remedy: 'serialize the writer' } } })
  const withoutCausal = rec('c2', 'Release pipeline')
  assert.equal(causalRelevance('', withCausal), 0)
  assert.equal(causalRelevance('writer race', withoutCausal), 0)
  assert.equal(causalRelevance('writer race', { ...withoutCausal, source: { causal: null } }), 0)
  assert.ok(causalRelevance('writer race', withCausal) > 0)
  assert.equal(causalRelevance('completely unrelated wording', withCausal), 0)
  // camelCase queries reach facet prose (splitCamelCase applied).
  const ident = rec('c3', 'Sync', { source: { causal: { symptom: 'DatabaseSync throws while closing' } } })
  assert.ok(causalRelevance('DatabaseSync', ident) > 0)
})

// ---------------------------------------------------------------------------
// rankRecords integration: fusion flips tied pools, composite untouched.
// ---------------------------------------------------------------------------

test('rankRecords: causal facets win a tied pool without touching the weighted-sum composite', () => {
  // Identical records except: one documents the cause, and it is the
  // OLDER one — so under the legacy chain recency would put the
  // non-causal twin first. Fusion must flip exactly that tie.
  const older = 1700000000000
  const newer = 1700000999000
  const causalTwin = rec('twin_causal', 'Release flake investigation', {
    relevance: 0.8,
    createdAt: older,
    updatedAt: older,
    source: { origin: 'session', observer: 'test', causal: { rootCause: 'writer race causes release builds to flake' } },
  })
  const plainTwin = rec('twin_plain', 'Release flake investigation', {
    relevance: 0.8,
    createdAt: newer,
    updatedAt: newer,
  })
  const r = rankRecords([causalTwin, plainTwin], { query: 'writer race flake' })
  assert.equal(r.length, 2)

  // Composite is still the plain weighted sum — causal did NOT enter it.
  for (const x of r) assert.equal(x.scores.composite, expectedComposite(x.scores))
  assert.equal(r.find((x) => x.id === 'twin_causal').scores.composite,
    r.find((x) => x.id === 'twin_plain').scores.composite)

  // New channel scores: present, causal-only, and fused.
  const c = r.find((x) => x.id === 'twin_causal')
  const p = r.find((x) => x.id === 'twin_plain')
  assert.ok(c.scores.causal > 0)
  assert.equal(p.scores.causal, 0)
  assert.ok(c.scores.rrf > 0 && p.scores.rrf > 0)
  assert.equal(c.scores.fusion, Number((c.scores.composite + FUSION_WEIGHT * c.scores.rrf).toFixed(4)))
  assert.ok(c.scores.fusion > p.scores.fusion)

  // Final order: the causal record leads DESPITE being older.
  assert.equal(r[0].id, 'twin_causal')
  assert.equal(r[1].id, 'twin_plain')
})

test('rankRecords: fusion = composite + weight * rrf on every query result', () => {
  const pool = [
    rec('a', 'SQLite writer deadlocks', { source: { causal: { rootCause: 'two writers take locks in opposite order' } } }),
    rec('b', 'SQLite writer deadlocks on close'),
    rec('c', 'Bump the retry budget'),
  ]
  const r = rankRecords(pool, { query: 'writer deadlock' })
  assert.ok(r.length === 3)
  for (const x of r) {
    assert.equal(x.scores.fusion, Number((x.scores.composite + FUSION_WEIGHT * x.scores.rrf).toFixed(4)))
    assert.equal(x.scores.composite, expectedComposite(x.scores))
  }
  assert.ok(r.some((x) => x.scores.rrf > 0))
})

// ---------------------------------------------------------------------------
// Legacy invariants: empty query, determinism, polarity.
// ---------------------------------------------------------------------------

test('rankRecords: empty query leaves fusion inactive and ordering recency-first', () => {
  const NOW = Date.now()
  const DAY = 86_400_000
  const iso = (ms) => new Date(ms).toISOString() // store stamps ISO strings (isIsoDate gate)
  const old = rec('old', 'AAA old record', { updatedAt: iso(NOW - 200 * DAY), createdAt: iso(NOW - 200 * DAY) }) // tier 0.4
  const fresh = rec('fresh', 'CCC fresh record', { updatedAt: iso(NOW - 1 * DAY), createdAt: iso(NOW - 1 * DAY) }) // tier 1.0
  const mid = rec('mid', 'BBB middle record', { updatedAt: iso(NOW - 60 * DAY), createdAt: iso(NOW - 60 * DAY) }) // tier 0.65
  // Deliberately non-recency input order.
  const r = rankRecords([old, fresh, mid], { query: '' })
  // Fusion is fully inactive: rrf off, sort falls back to the legacy
  // composite-descending chain (relevance input-order fallback
  // `1 - index*0.06` vs the freshness tier — 'fresh' tops despite
  // being last in input).
  for (const x of r) {
    assert.equal(x.scores.rrf, 0)
    assert.equal(x.scores.fusion, x.scores.composite) // fusion inactive = composite
  }
  assert.equal(r[0].id, 'fresh')
  for (let i = 1; i < r.length; i++) {
    assert.ok(r[i - 1].scores.composite >= r[i].scores.composite,
      'legacy chain: composite must be non-increasing')
  }
})

test('rankRecords: runs are fully deterministic (identical input → identical output)', () => {
  const pool = [
    rec('a', 'Serialize DatabaseSync writes', { source: { causal: { rootCause: 'writer race' } } }),
    rec('b', 'Serialize DatabaseSync writes'),
    rec('c', 'Do not serialize DatabaseSync writes'),
    rec('d', 'Unrelated tail'),
  ]
  const q = { query: 'serialize writes', intent: null }
  assert.deepEqual(rankRecords(pool, q), rankRecords(pool, q))
})

test('rankRecords: a polarity mismatch cannot outrank the best compatible record through fusion', () => {
  // The mismatch is ARMED with causal facets matching the query, so its
  // RRF term is as strong as possible — the cap must still hold on BOTH
  // the composite and the fused sort score.
  const compatible = rec('C', 'serialize writes', { validation: 'verified', confidence: 'high' })
  const mismatch = rec('M', 'do not serialize writes', {
    relevance: 0.95,
    source: { causal: { rootCause: 'serialize writes deadlocks the writer' } },
  })
  const r = rankRecords([mismatch, compatible], { query: 'serialize writes' })
  assert.equal(r.length, 2)
  assert.equal(r[0].id, 'C', 'compatible record must stay first')
  const m = r.find((x) => x.id === 'M')
  const c = r.find((x) => x.id === 'C')
  assert.equal(m.scores.polarity_mismatch, true)
  assert.ok(m.scores.polarity_original_composite !== undefined)
  assert.ok(m.scores.composite <= c.scores.composite, 'composite invariant holds')
  assert.ok(m.scores.fusion <= c.scores.fusion, 'fusion invariant holds — no RRF lift past the best compatible')
})

// ---------------------------------------------------------------------------
// Coverage tail keeps a uniform zeroed score shape (Phase 2 contract).
// ---------------------------------------------------------------------------

test('coverage tail entries zero the new causal/rrf/fusion keys', () => {
  const store = openEphemeralStore(':memory:', { scope: 'project', projectId: 'm3_tail' })
  try {
    remember(store, { title: 'SQLite WAL stays on', body: 'Keep WAL enabled so concurrent readers never block the writer connection.' })
    addRejected(store, 'Retry the cache stampede with a bigger TTL', 'Rejected because a bigger TTL made the stampede worse under load.')
    addRejected(store, 'Drop the index instead of rebuilding it', 'Rejected because dropping the index lost the nightly sync checkpoint mapping.')
    addUnresolved(store, 'Why does cache stampede still happen?', { knownClues: 'TTL reset fires before the lock is taken' })

    const results = hybridRetrieve({ projectStore: store, query: 'cache stampede nightly', limit: 6 })
    const tail = results.filter((x) => x.negativeCoverage === true)
    assert.equal(tail.length, 3)
    for (const t of tail) {
      assert.ok(t.kind === KINDS.NEGATIVE || t.kind === KINDS.UNRESOLVED)
      assert.equal(t.scores.composite, NEG_COVERAGE_SCORE)
      assert.equal(t.scores.causal, NEG_COVERAGE_SCORE)
      assert.equal(t.scores.rrf, NEG_COVERAGE_SCORE)
      assert.equal(t.scores.fusion, NEG_COVERAGE_SCORE)
    }
    // Forward pool still scores normally (fusion live on query results).
    const front = results.filter((x) => !x.negativeCoverage)
    assert.ok(front.length > 0)
    for (const x of front) {
      assert.equal(x.scores.fusion, Number((x.scores.composite + FUSION_WEIGHT * x.scores.rrf).toFixed(4)))
    }
  } finally {
    closeAllStores()
  }
})
