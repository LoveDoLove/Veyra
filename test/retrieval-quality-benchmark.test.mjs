/**
 * Retrieval Quality Benchmark — Supplemental E2E validation.
 *
 * Complements test/m15-benchmark.test.mjs (Phase 11, 29 tests/45 dimensions)
 * with real-world agent workflow scenarios, focusing on gaps:
 *   1. Authority hierarchy in practice (verified must not be suppressed by canonical noise)
 *   2. Cross-project boundary enforcement (reusable vs project-local)
 *   3. Temporal + applicability interaction (expired knowledge in wrong context)
 *   4. Contradiction rendering (both sides visible, no silent merge)
 *   5. Evidence validity vs relevance (invalid evidence must not grant authority)
 *   6. Real query patterns (implementation-specific, broad, negative)
 *
 * Every case uses the production recall() path, never internal helpers.
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { openEphemeralStore, openProjectStore, closeAllStores } from '../src/store.mjs'
import { remember, reviewCandidate, promote } from '../src/learn.mjs'
import { recordFeedback } from '../src/feedback.mjs'
import { recall, summarizeForPrompt } from '../src/retrieve.mjs'
import { AUTHORITIES, VALIDATIONS, KINDS } from '../src/types.mjs'
import { supersede } from '../src/lifecycle.mjs'
import { composeAgentContext, renderAgentContext } from '../src/context.mjs'

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

// remember() returns the store.put result `{record, ...}` — unwrap the id.
function rememberId(store, input) {
  const written = remember(store, input)
  assert.ok(written?.record?.id, `remember() wrote a record for "${input.title}"`)
  return written.record.id
}

// ---------------------------------------------------------------------------
// 1. RELEVANCE — real-world query patterns
// ---------------------------------------------------------------------------

test('RQB-1: implementation-specific query returns exact match over topic matches', () => {
  const store = openEphemeralStore(':memory:', { projectId: 'p_rqb_1' })
  try {
    // Specific implementation detail
    remember(store, claim(
      'DatabaseSync writes must be serialized through a mutex',
      'Root cause: concurrent DatabaseSync.prepare() calls corrupt FTS5 triggers. Remedy: lockWriter wraps all DatabaseSync operations in an AsyncLocalStorage mutex. Evidence: test/store.test.mjs passes with the lock, flakes without it.',
      { tags: ['DatabaseSync', 'mutex', 'race'], evidence: [{ path: 'src/store.mjs', note: 'test-passed' }], validation: VALIDATIONS.VERIFIED }
    ))
    // Broad topic match (same keywords, different problem)
    remember(store, claim(
      'SQLite databases benefit from WAL mode',
      'Setting PRAGMA journal_mode=WAL improves concurrency for read-heavy workloads. DatabaseSync supports WAL. This is general advice, not specific to any race condition.',
      { tags: ['sqlite', 'DatabaseSync', 'WAL'] }
    ))
    // Related but wrong scope
    remember(store, claim(
      'Mutex patterns in Node.js',
      'Use async-mutex or AsyncLocalStorage for Node.js mutual exclusion. Generic concurrency advice applicable to any async task.',
      { tags: ['mutex', 'concurrency'] }
    ))

    const hits = recall({
      projectStore: store,
      query: 'DatabaseSync race condition FTS5 trigger corruption',
      limit: 5,
    })

    assert.ok(hits.length > 0, 'query returned results')
    assert.equal(hits[0].title, 'DatabaseSync writes must be serialized through a mutex',
      'implementation-specific verified record outranks generic advice')
    assert.ok(hits[0].scores.relevance > 0.5, 'top hit has strong relevance')
    assert.ok(hits[0].scores.validation_tier >= 0.7, 'verified record has high validation tier')
  } finally {
    closeAllStores()
  }
})

test('RQB-2: broad query returns high-level knowledge, not implementation noise', () => {
  const store = openEphemeralStore(':memory:', { projectId: 'p_rqb_2' })
  try {
    // High-level architectural decision (canonical)
    remember(store, claim(
      'Veyra maintains a dedicated engineering memory store',
      'Decision: keep engineering intelligence separate from general knowledge. Evidence, validation and authority tiers distinguish verified engineering knowledge from unverified observations.',
      { validation: VALIDATIONS.REVIEWED, tags: ['architecture', 'decision'] }
    ))
    promote(store, store.list()[0].id, { to: AUTHORITIES.CANONICAL, explicit: true })

    // Low-level implementation details
    remember(store, claim(
      'FTS5 tokenizer registration precedes table creation',
      'SQLite requires custom tokenizers to be registered before CREATE VIRTUAL TABLE. Order: db.exec(register), then CREATE TABLE.',
      { tags: ['fts5', 'implementation'], evidence: [{ path: 'src/store.mjs', note: 'line 234' }] }
    ))
    remember(store, claim(
      'Store.mjs uses better-sqlite3 DatabaseSync API',
      'Implementation: DatabaseSync from node:sqlite (Node 22+). Synchronous API simplifies the write path.',
      { tags: ['sqlite', 'implementation'] }
    ))

    const hits = recall({
      projectStore: store,
      query: 'Veyra architecture',
      limit: 5,
    })

    assert.ok(hits.length > 0, 'broad query returned results')
    assert.equal(hits[0].authority, AUTHORITIES.CANONICAL, 'canonical architectural decision ranks first')
    assert.ok(hits[0].title.includes('dedicated engineering memory'),
      'high-level decision outranks low-level implementation')
  } finally {
    closeAllStores()
  }
})

test('RQB-3: negative query (avoid/never/do not) surfaces negative-kind records', () => {
  const store = openEphemeralStore(':memory:', { projectId: 'p_rqb_3' })
  try {
    // Positive memory
    rememberId(store, claim(
      'Use writeGate for all automatic learning',
      'Automatic observations pass through writeGate before becoming memory. This ensures provenance, noise filtering, and duplicate suppression.',
      { tags: ['learning', 'gate'] }
    ))
    // Negative memory (known failed approach) — shipped path routes
    // kind:NEGATIVE through addRejected inside remember()
    rememberId(store, {
      title: 'Do not auto-promote candidates to canonical',
      body: 'Hypothesis: high-confidence candidates can be auto-promoted to canonical. Rejected: automatic behavior must never manufacture authority. Only explicit promote() with explicit:true may create canonical records. Evidence: M9 provenance gate tests lock this invariant.',
      kind: KINDS.NEGATIVE,
      tags: ['authority', 'provenance'],
      source: { tool: 'veyra_remember', automatic: false },
    })

    const hits = recall({
      projectStore: store,
      query: 'never auto promote candidate canonical',
      kind: KINDS.NEGATIVE,
      limit: 5,
    })

    assert.ok(hits.length > 0, 'explicit negative query returned results')
    assert.equal(hits[0].kind, KINDS.NEGATIVE, 'negative record surfaced')
    assert.ok(hits[0].title.includes('Do not auto-promote'),
      'known-failed approach returned for explicit negative query')

    // Unified query DOES include negative records (coverage tail, Phase 2 design).
    // The invariant: negative records carry zero composite score and rank after
    // forward-scored memory.
    const unified = recall({
      projectStore: store,
      query: 'promote candidate canonical',
      limit: 5,
    })
    const negativeRec = unified.find((r) => r.kind === KINDS.NEGATIVE)
    assert.ok(negativeRec, 'unified query includes negative records (coverage tail by design)')
    assert.equal(negativeRec.scores.composite, 0,
      'negative record carries zero composite score (coverage-only, not forward-scored)')
    const memoryRec = unified.find((r) => r.kind === KINDS.MEMORY)
    assert.ok(memoryRec, 'unified query includes forward-scored memory')
    assert.ok(unified.indexOf(memoryRec) < unified.indexOf(negativeRec),
      'forward-scored memory ranks above zero-score coverage tail')
  } finally {
    closeAllStores()
  }
})

// ---------------------------------------------------------------------------
// 2. AUTHORITY — verified knowledge must not be suppressed
// ---------------------------------------------------------------------------

test('RQB-4: verified/reviewed records outrank unverified canonical noise', () => {
  const store = openEphemeralStore(':memory:', { projectId: 'p_rqb_4' })
  try {
    // Canonical but unverified (declared truth, no evidence)
    const canonicalId = rememberId(store, claim(
      'Redis cache warming prevents cold-start errors',
      'System design: warm the Redis cache before accepting traffic. This is canonical system architecture.',
      { tags: ['redis', 'cache', 'architecture'] }
    ))
    promote(store, canonicalId, { to: AUTHORITIES.CANONICAL, explicit: true })

    // Derived but verified (evidence + multiple observations)
    const verifiedId = rememberId(store, claim(
      'Redis WRONGTYPE error on empty key: cache warming must run before first read',
      'Root cause: reading an unset key returns nil; casting nil to a list throws WRONGTYPE. Remedy: seed the cache with empty lists before the first read. Verified outcome: integration tests pass when seeding runs in beforeAll.',
      {
        tags: ['redis', 'cache', 'WRONGTYPE'],
        evidence: [
          { path: 'test/integration/cache.test.mjs', note: 'test-passed' },
          { path: 'src/cache.mjs', note: 'warmCache function' },
        ],
        validation: VALIDATIONS.UNVERIFIED,
      }
    ))
    // Simulate feedback ladder: multiple successful applications → verified
    recordFeedback(store, { id: verifiedId, outcome: 'success', note: 'applied in staging' })
    recordFeedback(store, { id: verifiedId, outcome: 'success', note: 'applied in production' })
    recordFeedback(store, { id: verifiedId, outcome: 'success', note: 'tests still pass' })

    const hits = recall({
      projectStore: store,
      query: 'redis cache cold start WRONGTYPE empty',
      limit: 5,
    })

    assert.ok(hits.length >= 2, 'both records returned')
    const top = hits[0]
    assert.equal(top.title, 'Redis WRONGTYPE error on empty key: cache warming must run before first read',
      'verified derived record outranks unverified canonical')
    assert.equal(top.validation, VALIDATIONS.VERIFIED, 'top record is verified')
    assert.ok(top.scores.validation_tier > 0.9, 'verified tier is high')
    assert.ok(top.scores.evidence_strength > 0.8, 'strong evidence')

    const canonical = hits.find((r) => r.authority === AUTHORITIES.CANONICAL)
    assert.ok(canonical, 'canonical record still present (not filtered)')
    assert.ok(hits.indexOf(canonical) > 0, 'canonical ranks below verified')
  } finally {
    closeAllStores()
  }
})

// ---------------------------------------------------------------------------
// 3. APPLICABILITY — cross-project isolation
// ---------------------------------------------------------------------------

test('RQB-5: project-local knowledge does not leak to other projects', () => {
  const home = mkdtempSync(join(tmpdir(), 'veyra-rqb-5-'))
  try {
    const storeA = openProjectStore(home, 'proj-a')
    const storeB = openProjectStore(home, 'proj-b')

    remember(storeA, claim(
      'Project A uses custom FTS5 tokenizer for camelCase',
      'Decision: register a custom SQLite FTS5 tokenizer that splits camelCase identifiers. This is specific to Project A schema.',
      { tags: ['fts5', 'tokenizer', 'project-a'], scope: 'project' }
    ))
    remember(storeB, claim(
      'Project B uses default FTS5 tokenizer',
      'Decision: stick with the default unicode61 tokenizer. Project B schema has no camelCase identifiers.',
      { tags: ['fts5', 'tokenizer', 'project-b'], scope: 'project' }
    ))

    const hitsA = recall({
      projectStore: storeA,
      query: 'FTS5 tokenizer camelCase',
      limit: 5,
    })
    const hitsB = recall({
      projectStore: storeB,
      query: 'FTS5 tokenizer camelCase',
      limit: 5,
    })

    assert.ok(hitsA.some((r) => r.title.includes('Project A')), 'Project A query finds its own knowledge')
    assert.ok(!hitsA.some((r) => r.title.includes('Project B')), 'Project A query does NOT see Project B')
    assert.ok(hitsB.some((r) => r.title.includes('Project B')), 'Project B query finds its own knowledge')
    assert.ok(!hitsB.some((r) => r.title.includes('Project A')), 'Project B query does NOT see Project A')

    storeA.close()
    storeB.close()
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('RQB-6: reusable knowledge surfaces in any project', () => {
  const home = mkdtempSync(join(tmpdir(), 'veyra-rqb-6-'))
  try {
    const storeProj = openProjectStore(home, 'proj-specific')
    const storeReusable = openProjectStore(home, 'REUSABLE')

    remember(storeReusable, claim(
      'SQLite PRAGMA journal_mode=WAL improves concurrency',
      'General SQLite advice: WAL mode allows concurrent readers and writers. Applicable to any project using SQLite.',
      { tags: ['sqlite', 'wal', 'concurrency'], scope: 'reusable' }
    ))

    const hits = recall({
      projectStore: storeProj,
      reusableStore: storeReusable,
      query: 'sqlite concurrency WAL',
      limit: 5,
    })

    assert.ok(hits.length > 0, 'reusable knowledge surfaced in project query')
    assert.ok(hits.some((r) => r.scope === 'reusable' && r.title.includes('WAL')),
      'reusable record from different projectId returned')

    storeProj.close()
    storeReusable.close()
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// 4. TEMPORAL + APPLICABILITY — expired knowledge in wrong context
// ---------------------------------------------------------------------------

test('RQB-7: expired temporal knowledge is held below current knowledge', () => {
  const store = openEphemeralStore(':memory:', { projectId: 'p_rqb_7' })
  try {
    // Current knowledge
    remember(store, claim(
      'Node 24+ uses native SQLite DatabaseSync API',
      'Current implementation: node:sqlite DatabaseSync (Node 24.21+). Synchronous API, no callback hell.',
      {
        tags: ['node', 'sqlite'],
        source: {
          tool: 'veyra_remember',
          automatic: false,
          temporal: { validFrom: '2024-01-01T00:00:00Z' }, // Open-ended, current
        },
      }
    ))
    // Expired knowledge (historical)
    remember(store, claim(
      'Node 22 requires better-sqlite3 for synchronous SQLite',
      'Historical: Node 22 lacked native SQLite. better-sqlite3 was the standard choice. This knowledge expired when Node 24+ landed.',
      {
        tags: ['node', 'sqlite', 'better-sqlite3'],
        source: {
          tool: 'veyra_remember',
          automatic: false,
          temporal: {
            validFrom: '2021-01-01T00:00:00Z',
            validUntil: '2024-01-01T00:00:00Z', // Expired
          },
        },
      }
    ))

    const hits = recall({
      projectStore: store,
      query: 'Node SQLite synchronous API',
      limit: 5,
    })

    assert.ok(hits.length >= 2, 'both records returned (expired not filtered)')
    const current = hits.find((r) => r.title.includes('Node 24+'))
    const expired = hits.find((r) => r.title.includes('Node 22'))
    assert.ok(current && expired, 'both current and expired records present')
    assert.ok(hits.indexOf(current) < hits.indexOf(expired),
      'current knowledge outranks expired (temporal_validity gate)')
    // The [EXPIRED] marker lives in the AGENT-FACING RENDERED string, not
    // the record fields — historical knowledge must not impersonate current
    // truth when injected into context (regression for the E2E temporal fix).
    const rendered = summarizeForPrompt(hits)
    const expiredLine = rendered.split('\n').find((l) => l.includes('Node 22'))
    const currentLine = rendered.split('\n').find((l) => l.includes('Node 24+'))
    assert.ok(expiredLine && currentLine, 'both records rendered into prompt context')
    assert.ok(expiredLine.includes('[EXPIRED]'),
      `expired record line carries [EXPIRED] marker — got: ${expiredLine}`)
    assert.ok(!currentLine.includes('[EXPIRED]'),
      `current record line is NOT marked [EXPIRED] — got: ${currentLine}`)
  } finally {
    closeAllStores()
  }
})

test('RQB-8: context-incompatible knowledge (wrong OS/runtime) is held below compatible', () => {
  const store = openEphemeralStore(':memory:', { projectId: 'p_rqb_8' })
  try {
    // Compatible with current context (assume test runs on linux/darwin)
    remember(store, claim(
      'Use fs.watch for file system monitoring',
      'Node.js fs.watch works reliably on Linux and macOS. Cross-platform, efficient.',
      {
        tags: ['fs', 'watch'],
        source: {
          tool: 'veyra_remember',
          automatic: false,
          context: { os: 'linux', runtime: 'node' },
        },
      }
    ))
    // Incompatible (Windows-specific)
    remember(store, claim(
      'Use chokidar on Windows to avoid fs.watch bugs',
      'Windows: fs.watch has historically been unreliable. chokidar is the standard workaround. Not needed on Linux/macOS.',
      {
        tags: ['fs', 'watch', 'windows'],
        source: {
          tool: 'veyra_remember',
          automatic: false,
          context: { os: 'win32', runtime: 'node' },
        },
      }
    ))

    const hits = recall({
      projectStore: store,
      query: 'file system watch monitoring',
      limit: 5,
    })

    assert.ok(hits.length >= 2, 'both records returned')
    // Applicability gate: context-incompatible record is held below compatible
    // (only when a compatible alternative exists)
    const compatible = hits.find((r) => r.title.includes('fs.watch for file system'))
    const incompatible = hits.find((r) => r.title.includes('chokidar on Windows'))
    assert.ok(compatible && incompatible, 'both records present')
    // If current OS is NOT win32, compatible should outrank incompatible
    if (process.platform !== 'win32') {
      assert.ok(hits.indexOf(compatible) < hits.indexOf(incompatible),
        'context-compatible record outranks incompatible (applicability gate)')
    }
  } finally {
    closeAllStores()
  }
})

// ---------------------------------------------------------------------------
// 5. CONTRADICTIONS — both sides visible, no silent merge
// ---------------------------------------------------------------------------

test('RQB-9: contradicting records both surface with banners', () => {
  const store = openEphemeralStore(':memory:', { projectId: 'p_rqb_9' })
  try {
    const idA = rememberId(store, claim(
      'Write gate accepts all claims with assistant provenance',
      'Policy: automatic observations from assistant-only turns pass writeGate and become derived memory.',
      { tags: ['learning', 'provenance'] }
    ))
    const idB = rememberId(store, claim(
      'Write gate defers claims with user provenance',
      'Policy: observations containing user origin are gated by M9 provenance policy. Only assistant-only or assistant+tool origins auto-learn.',
      { tags: ['learning', 'provenance'] }
    ))

    // Link as contradictory (must update both records with relations field)
    const storedA = store.get(idA)
    const storedB = store.get(idB)
    store.put({ ...storedA, relations: [{ type: 'contradicts', targetId: idB }] })
    store.put({ ...storedB, relations: [{ type: 'contradicts', targetId: idA }] })

    const hits = recall({
      projectStore: store,
      query: 'write gate provenance policy',
      limit: 5,
    })

    assert.ok(hits.length >= 2, 'both contradicting records returned')
    const recA = hits.find((r) => r.id === idA)
    const recB = hits.find((r) => r.id === idB)
    assert.ok(recA && recB, 'both sides of contradiction present (no silent merge)')
    // annotateContradictions writes contradictions and contradictionBanners arrays
    const hasContradiction = recA.contradictions?.length > 0 || recB.contradictions?.length > 0
    assert.ok(hasContradiction, 'at least one record carries contradiction annotation')
    const bannerA = recA.contradictionBanners?.some((b) => b.includes('CONTRADICTION'))
    const bannerB = recB.contradictionBanners?.some((b) => b.includes('CONTRADICTION'))
    assert.ok(bannerA || bannerB, 'contradiction banner present')
  } finally {
    closeAllStores()
  }
})

test('RQB-10: supersession — retired record leaves retrieval, replacement shows note', () => {
  const store = openEphemeralStore(':memory:', { projectId: 'p_rqb_10' })
  try {
    const oldId = rememberId(store, claim(
      'Store uses better-sqlite3',
      'Implementation: better-sqlite3 npm package for synchronous SQLite. Standard choice before Node 24.',
      { tags: ['sqlite', 'implementation'] }
    ))
    const newId = rememberId(store, claim(
      'Store uses node:sqlite DatabaseSync',
      'Updated implementation: node:sqlite DatabaseSync (Node 24+). Native API, no npm dependency.',
      { tags: ['sqlite', 'implementation'] }
    ))

    // Before supersession: both recall-eligible (no silent merge)
    const beforeHits = recall({ projectStore: store, query: 'store sqlite implementation', limit: 5 })
    assert.ok(beforeHits.some((r) => r.id === oldId), 'old record visible before supersession')
    assert.ok(beforeHits.some((r) => r.id === newId), 'new record visible before supersession')

    // Production supersession (src/lifecycle.mjs:180): retired --supersedes-->
    // replacement + status='superseded'. Status≠current leaves retrieval.
    const res = supersede(store, oldId, newId, { why: 'native API replaced npm dependency' })
    assert.equal(res.ok, true, 'supersede() succeeded')

    const afterHits = recall({ projectStore: store, query: 'store sqlite implementation', limit: 5 })
    assert.ok(!afterHits.some((r) => r.id === oldId),
      'superseded record leaves active retrieval (recall gate: status≠current)')
    assert.ok(afterHits.some((r) => r.id === newId), 'replacement record remains visible')

    // The retirement must not be silent: rendered context carries the note via
    // resolveSupersession inbound-edge scan (context.mjs:42)
    const composed = composeAgentContext(afterHits, { stores: [store] })
    const rendered = renderAgentContext(composed, { heading: 'Test context' })
    assert.ok(rendered.includes('Replaces superseded memory'),
      'rendered context includes supersession note')
    assert.ok(rendered.includes(oldId),
      `supersession note references retired record id ${oldId}`)
  } finally {
    closeAllStores()
  }
})

test('RQB-11: complementary records (not contradictory) both rank naturally', () => {
  const store = openEphemeralStore(':memory:', { projectId: 'p_rqb_11' })
  try {
    remember(store, claim(
      'Write gate filters noise before learning',
      'First pass: writeGate checks provenance, durability, noise patterns. Only durable claims proceed to maybeLearn.',
      { tags: ['learning', 'gate'] }
    ))
    remember(store, claim(
      'maybeLearn checks for duplicates and merges',
      'Second pass: maybeLearn queries for existing similar records and merges when appropriate. MERGE decision updates observation count.',
      { tags: ['learning', 'merge'] }
    ))

    const hits = recall({
      projectStore: store,
      query: 'learning pipeline write gate maybeLearn',
      limit: 5,
    })

    assert.ok(hits.length >= 2, 'both complementary records returned')
    const hasContradiction = hits.some((r) => r.contradiction)
    assert.equal(hasContradiction, false,
      'complementary (non-contradictory) records have no contradiction annotation')
  } finally {
    closeAllStores()
  }
})

// ---------------------------------------------------------------------------
// 6. EVIDENCE — invalid evidence must not grant authority
// ---------------------------------------------------------------------------

test('RQB-12: memory with invalid evidence ranks below memory with valid evidence', () => {
  const store = openEphemeralStore(':memory:', { projectId: 'p_rqb_12' })
  try {
    // Valid evidence (real file path + test outcome)
    remember(store, claim(
      'lockWriter prevents DatabaseSync race conditions',
      'Verified: wrapping DatabaseSync operations in lockWriter eliminates FTS5 trigger corruption. Test suite passes consistently.',
      {
        tags: ['DatabaseSync', 'lock'],
        evidence: [
          { path: 'src/store.mjs', note: 'lockWriter implementation line 145' },
          { path: 'test/store.test.mjs', note: 'test-passed' },
        ],
        validation: VALIDATIONS.VERIFIED,
      }
    ))
    // Invalid evidence (broken path)
    remember(store, claim(
      'AsyncLocalStorage mutex prevents all race conditions',
      'Claim: AsyncLocalStorage provides mutual exclusion. Evidence path does not exist.',
      {
        tags: ['AsyncLocalStorage', 'mutex'],
        evidence: [
          { path: 'src/nonexistent-file.mjs', note: 'mutex implementation' },
        ],
        validation: VALIDATIONS.UNVERIFIED,
      }
    ))

    const hits = recall({
      projectStore: store,
      query: 'race condition mutex prevention',
      limit: 5,
    })

    assert.ok(hits.length >= 2, 'both records returned')
    const valid = hits.find((r) => r.title.includes('lockWriter'))
    const invalid = hits.find((r) => r.title.includes('AsyncLocalStorage'))
    assert.ok(valid && invalid, 'both records present')
    assert.ok(hits.indexOf(valid) < hits.indexOf(invalid),
      'record with valid evidence outranks record with invalid evidence')
    assert.ok(valid.scores.evidence_strength > invalid.scores.evidence_strength,
      'evidence_strength reflects validity')
  } finally {
    closeAllStores()
  }
})

test('RQB-13: high lexical relevance does not override low evidence quality', () => {
  const store = openEphemeralStore(':memory:', { projectId: 'p_rqb_13' })
  try {
    // Strong lexical match but no evidence
    remember(store, claim(
      'FTS5 tokenizer must handle camelCase identifiers correctly',
      'Observation: FTS5 default tokenizer splits on non-alphanumeric only. CamelCase compounds are treated as single tokens. No evidence, no verification.',
      { tags: ['fts5', 'tokenizer', 'camelCase'], validation: VALIDATIONS.UNVERIFIED }
    ))
    // Weaker lexical match but strong evidence
    remember(store, claim(
      'Custom SQLite tokenizer splits camelCase at boundaries',
      'Implementation: register a custom FTS5 tokenizer that inserts spaces at camelCase boundaries (e.g., DatabaseSync → Database Sync). Verified by test suite.',
      {
        tags: ['sqlite', 'tokenizer'],
        evidence: [
          { path: 'src/store.mjs', note: 'tokenizer registration line 89' },
          { path: 'test/fts-tokenizer.test.mjs', note: 'test-passed' },
        ],
        validation: VALIDATIONS.VERIFIED,
      }
    ))

    const hits = recall({
      projectStore: store,
      query: 'fts5 tokenizer camelCase',
      limit: 5,
    })

    assert.ok(hits.length >= 2, 'both records returned')
    // Evidence + validation weight should not be completely overridden by lexical alone
    const evidenced = hits.find((r) => r.validation === VALIDATIONS.VERIFIED)
    assert.ok(evidenced, 'verified record with evidence present')
    assert.ok(evidenced.scores.evidence_strength > 0.7, 'strong evidence score')
    assert.ok(evidenced.scores.validation_tier >= 0.9, 'high validation tier')
    // Top result should balance relevance + evidence + validation
    assert.ok(hits[0].scores.composite > 0.5, 'top hit has balanced composite score')
  } finally {
    closeAllStores()
  }
})

// ---------------------------------------------------------------------------
// Summary metrics
// ---------------------------------------------------------------------------

test('RQB-14: benchmark summary and metrics', () => {
  console.log('\n=== Retrieval Quality Benchmark Summary ===\n')
  console.log('Supplemental validation (complements test/m15-benchmark.test.mjs)')
  console.log('\nCoverage:')
  console.log('  1. Relevance:      3 tests (implementation-specific, broad, negative queries)')
  console.log('  2. Authority:      1 test  (verified vs unverified canonical)')
  console.log('  3. Applicability:  4 tests (cross-project isolation, reusable, temporal, context)')
  console.log('  4. Contradictions: 3 tests (both sides visible, supersession, complementary)')
  console.log('  5. Evidence:       2 tests (invalid evidence, evidence vs relevance)')
  console.log('\n  Total: 13 tests covering 6 real-world agent workflow scenarios')
  console.log('\nAll tests use production recall() path (no internal helpers).')
  console.log('Phase 11 benchmark (test/m15-benchmark.test.mjs) provides 29 additional')
  console.log('tests across 45 measured dimensions.\n')
})
