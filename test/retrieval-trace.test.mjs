/**
 * test/retrieval-trace.test.mjs
 *
 * Tests for Structured Retrieval Trace (opt-in diagnostic).
 * Three contracts verified:
 *  1. Off behavior consistency: trace=false (default) returns bare array.
 *  2. On result consistency: trace=true returns same results as trace=false.
 *  3. Trace data accuracy: trace fields reflect real execution (not simulated).
 *
 * Uses real recall() / hybridRetrieve() with openEphemeralStore (in-memory).
 * Ground truth used only for post-retrieval assertions.
 */

import { strict as assert } from 'node:assert'
import { describe, it, before } from 'node:test'
import { openEphemeralStore } from '../src/store.mjs'
import { remember } from '../src/learn.mjs'
import { recall, hybridRetrieve } from '../src/retrieve.mjs'

// ──────────────────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────────────────

function makeStore() {
  return openEphemeralStore(':memory:', { scope: 'project', projectId: 'trace-test-workspace' })
}

// remember(store, input) — store is first arg, not { projectStore }
async function seedStore(store, memories) {
  const ids = []
  for (const m of memories) {
    const r = await remember(store, m)
    ids.push(r.record.id)
  }
  return ids
}

// ──────────────────────────────────────────────────────────────────────────
// Fixtures
// ──────────────────────────────────────────────────────────────────────────

const MEMORIES = [
  {
    title: 'Hybrid search combines 7 retrieval dimensions',
    body: 'Veyra combines lexical FTS5, semantic Jaccard, causal, relationship, authority, validation, and confidence into a composite score.',
    kind: 'knowledge',
    evidence: [{ path: 'src/retrieve.mjs', symbol: 'rankRecords', startLine: 709, endLine: 800, note: 'core scoring' }],
  },
  {
    title: 'Candidates are never auto-recalled',
    body: 'Only derived and canonical records qualify for recall. Candidates stay in write-gate pending review.',
    kind: 'memory',
    evidence: [{ path: 'src/tools.mjs', note: 'candidate gate in recall filter' }],
  },
  {
    title: 'Workspace isolation via DSH WorkspaceId',
    body: 'Rooms are keyed by DSH WorkspaceId, never by filesystem path. Two workspaces on the same repo are two rooms.',
    kind: 'knowledge',
    evidence: [{ path: 'src/rooms.mjs', symbol: 'resolveRoom', startLine: 54, endLine: 137, note: 'test-passed' }],
  },
  {
    title: 'Evidence anchors support function-level precision',
    body: 'Adding symbol + startLine + endLine to an evidence anchor elevates evidence strength from 0.6 to 0.7.',
    kind: 'knowledge',
    evidence: [{ path: 'src/retrieve.mjs', symbol: 'evidenceStrength', startLine: 27, endLine: 65, note: 'core scoring' }],
  },
  {
    title: 'Unrelated record about configuration',
    body: 'Configuration is loaded from DSH_HOME and respects environment variable overrides.',
    kind: 'memory',
    evidence: [{ uri: 'https://docs.example.com/config', note: 'configuration reference' }],
  },
]

// ──────────────────────────────────────────────────────────────────────────
// Test suite
// ──────────────────────────────────────────────────────────────────────────

describe('Structured Retrieval Trace', () => {
  let store
  let ids

  before(async () => {
    store = makeStore()
    ids = await seedStore(store, MEMORIES)
    assert.equal(ids.length, 5, 'Expected 5 memories seeded')
  })

  // ── 1. Off (default) — bare array, no trace field ──────────────────────
  describe('off behavior (trace=false / omitted)', () => {
    it('recall() with no trace option returns a bare array', () => {
      // recall() is synchronous (wraps hybridRetrieve which is sync)
      const result = recall({ projectStore: store, query: 'retrieval dimensions' })
      assert.ok(Array.isArray(result), 'Expected bare array when trace not set')
    })

    it('hybridRetrieve(trace:false) returns a bare array', () => {
      const result = hybridRetrieve({ projectStore: store, query: 'retrieval dimensions', trace: false })
      assert.ok(Array.isArray(result), 'Expected bare array when trace=false')
    })

    it('hybridRetrieve(trace:false) does not attach a trace property', () => {
      const result = hybridRetrieve({ projectStore: store, query: 'workspace isolation', trace: false })
      assert.ok(Array.isArray(result), 'Should be array')
      assert.equal(typeof result.trace, 'undefined', 'No .trace property on bare array')
    })
  })

  // ── 2. On — {results, trace} shape + result consistency ────────────────
  describe('on behavior (trace=true)', () => {
    it('hybridRetrieve(trace:true) returns {results, trace}', () => {
      const ret = hybridRetrieve({ projectStore: store, query: 'retrieval dimensions', trace: true })
      assert.ok(ret && typeof ret === 'object' && !Array.isArray(ret), 'Expected object, not array')
      assert.ok(Array.isArray(ret.results), '.results should be an array')
      assert.ok(ret.trace && typeof ret.trace === 'object', '.trace should be an object')
    })

    it('trace:true returns the SAME results as trace:false (result consistency)', () => {
      const withTrace = hybridRetrieve({ projectStore: store, query: 'retrieval dimensions', trace: true })
      const withoutTrace = hybridRetrieve({ projectStore: store, query: 'retrieval dimensions', trace: false })
      assert.deepEqual(
        withTrace.results.map((r) => r.id),
        withoutTrace.map((r) => r.id),
        'Results must be identical regardless of trace flag'
      )
    })

    it('trace:true and trace:false return the same count of results', () => {
      const withTrace = hybridRetrieve({ projectStore: store, query: 'candidates workspace', trace: true })
      const withoutTrace = hybridRetrieve({ projectStore: store, query: 'candidates workspace', trace: false })
      assert.equal(
        withTrace.results.length,
        withoutTrace.length,
        'Result count must be identical regardless of trace flag'
      )
    })
  })

  // ── 3. Trace data accuracy ─────────────────────────────────────────────
  describe('trace data accuracy (real execution path)', () => {
    let trace
    let results

    before(() => {
      const ret = hybridRetrieve({ projectStore: store, query: 'retrieval dimensions candidates', trace: true, limit: 5 })
      results = ret.results
      trace = ret.trace
    })

    it('trace.query matches the query string', () => {
      assert.equal(trace.query, 'retrieval dimensions candidates')
    })

    it('trace.limit matches the requested limit', () => {
      assert.equal(trace.limit, 5)
    })

    it('trace.candidatePool.total is a non-negative integer', () => {
      assert.ok(Number.isInteger(trace.candidatePool.total), 'candidatePool.total should be integer')
      assert.ok(trace.candidatePool.total >= 0, 'candidatePool.total should be >= 0')
    })

    it('trace.candidatePool.total >= results.length', () => {
      assert.ok(trace.candidatePool.total >= results.length,
        `pool ${trace.candidatePool.total} should be >= results ${results.length}`)
    })

    it('trace.scoredPool entries match candidatePool.total count', () => {
      assert.equal(trace.scoredPool.length, trace.candidatePool.total,
        'scoredPool entry count must equal candidatePool.total')
    })

    it('trace.scoredPool entries have id, title, scores fields', () => {
      for (const entry of trace.scoredPool) {
        assert.ok(typeof entry.id === 'string', 'scoredPool entry.id must be string')
        assert.ok(typeof entry.title === 'string', 'scoredPool entry.title must be string')
        assert.ok(entry.scores && typeof entry.scores === 'object', 'scoredPool entry.scores must be object')
      }
    })

    it('trace.scoredPool evidence_strength values are in valid range [0,1] if defined', () => {
      for (const entry of trace.scoredPool) {
        const es = entry.scores.evidence_strength
        if (es !== undefined) {
          assert.ok(typeof es === 'number' && es >= 0 && es <= 1.0001,
            `evidence_strength ${es} out of range for ${entry.id}`)
        }
      }
    })

    it('trace.assembly.ranked is an array of strings', () => {
      assert.ok(Array.isArray(trace.assembly.ranked))
      assert.ok(trace.assembly.ranked.every((x) => typeof x === 'string'), 'ranked must contain strings')
    })

    it('trace.assembly.ranked ids match scoredPool ids in same order', () => {
      const poolIds = trace.scoredPool.map((e) => e.id)
      assert.deepEqual(trace.assembly.ranked, poolIds,
        'assembly.ranked must be the IDs in the same order as scoredPool')
    })

    it('trace.assembly.selected is a subset of assembly.ranked', () => {
      const rankedSet = new Set(trace.assembly.ranked)
      for (const id of trace.assembly.selected) {
        assert.ok(rankedSet.has(id), `selected ID ${id} not in ranked set`)
      }
    })

    it('trace.assembly.limitedIds is a subset of assembly.selected', () => {
      const selectedSet = new Set(trace.assembly.selected)
      for (const id of trace.assembly.limitedIds) {
        assert.ok(selectedSet.has(id), `limitedId ${id} not in selected set`)
      }
    })

    it('trace.assembly.assemblyPath is no-extras or extras-merged', () => {
      assert.ok(['no-extras', 'extras-merged'].includes(trace.assembly.assemblyPath),
        `assemblyPath expected no-extras or extras-merged, got ${trace.assembly.assemblyPath}`)
    })

    it('trace.final.resultIds match the actual results array', () => {
      assert.deepEqual(
        trace.final.resultIds,
        results.map((r) => r.id),
        'final.resultIds must match actual results in order'
      )
    })

    it('trace.final.total matches results.length', () => {
      assert.equal(trace.final.total, results.length)
    })

    it('trace.final.overLimit is true only when results exceed limit', () => {
      const expected = results.length > 5
      assert.equal(trace.final.overLimit, expected)
    })

    it('detectedIntent is a string or null', () => {
      assert.ok(
        trace.detectedIntent === null || typeof trace.detectedIntent === 'string',
        'detectedIntent must be string or null'
      )
    })
  })

  // ── 4. Evidence strength signal visible in trace ───────────────────────
  describe('evidence strength in scoredPool', () => {
    it('function-level anchor record scores at least 0.7 evidence_strength', () => {
      // MEMORIES[0] has path+symbol+startLine+endLine → 0.7
      const ret = hybridRetrieve({ projectStore: store, query: 'hybrid search retrieval', trace: true })
      const trace = ret.trace
      // find the seeded memory by title
      const entry = trace.scoredPool.find((e) => e.title.includes('Hybrid search'))
      if (!entry) return // seeded memory may not surface if FTS has no match - OK
      const es = entry.scores.evidence_strength
      if (es !== undefined) {
        assert.ok(es >= 0.7, `Function-level anchor should score >= 0.7, got ${es}`)
      }
    })

    it('URI-only anchor record scores lower than file-level anchor records', () => {
      const ret = hybridRetrieve({ projectStore: store, query: 'configuration workspace candidates', trace: true })
      const trace = ret.trace
      const uriOnly = trace.scoredPool.find((e) => e.title.includes('configuration'))
      const fileLevel = trace.scoredPool.find((e) => e.title.includes('Candidates'))
      if (!uriOnly || !fileLevel) return // both must surface to compare
      const esUri = uriOnly.scores.evidence_strength ?? 0
      const esFile = fileLevel.scores.evidence_strength ?? 0
      assert.ok(esUri <= esFile,
        `URI-only evidence_strength ${esUri} should be <= file-level ${esFile}`)
    })
  })

  // ── 5. Edge cases ──────────────────────────────────────────────────────
  describe('edge cases', () => {
    it('trace:true with empty store returns {results:[], trace:{...}}', () => {
      const emptyStore = makeStore()
      const ret = hybridRetrieve({ projectStore: emptyStore, query: 'anything', trace: true })
      assert.ok(Array.isArray(ret.results), '.results should be array even when empty')
      assert.equal(ret.results.length, 0)
      assert.ok(ret.trace, '.trace should exist even when no results')
      assert.equal(ret.trace.candidatePool.total, 0)
      assert.equal(ret.trace.scoredPool.length, 0)
      assert.equal(ret.trace.final.total, 0)
    })

    it('trace:false with empty store returns [] without throwing', () => {
      const emptyStore = makeStore()
      const ret = hybridRetrieve({ projectStore: emptyStore, query: 'anything', trace: false })
      assert.ok(Array.isArray(ret))
      assert.equal(ret.length, 0)
    })

    it('trace:true with limit:0 returns bare [] (early return before _tc)', () => {
      // limit=0 hits the early-return path before _tc is initialized
      const ret = hybridRetrieve({ projectStore: store, query: 'retrieval', trace: true, limit: 0 })
      assert.ok(Array.isArray(ret), 'limit=0 should return bare array (early return path)')
    })
  })
})
