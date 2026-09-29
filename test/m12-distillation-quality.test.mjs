import { test } from 'node:test'
import assert from 'node:assert/strict'
import { extractCausalFacets, distillBuffer, qualityGateFacet } from '../src/understand.mjs'
import { newBuffer, observeEvent } from '../src/observe.mjs'

// ============================================================================
// M12 C2 — Distillation Quality Gate
//
// The gate drops malformed facets at the capture boundary. Invariants tested
// here: never fabricate, never rewrite, drop only the invalid facet while
// preserving valid siblings, and preserve raw evidence/provenance unchanged.
// ============================================================================

// -- Baseline: structurally sound facets are preserved (gate must not over-drop)

test('C2: complete valid facet set is preserved', () => {
  const user = 'The issue is flaky tests crashing with SQLITE_BUSY. The root cause is concurrent DatabaseSync calls corrupting FTS triggers. The remedy is to serialize writes using a mutex.'
  const { facets } = extractCausalFacets({ user, tools: [], files: ['src/store.mjs'] })
  assert.ok(facets)
  assert.equal(facets.symptom, 'flaky tests crashing with SQLITE_BUSY')
  assert.equal(facets.rootCause, 'concurrent DatabaseSync calls corrupting FTS triggers')
  assert.ok(facets.remedy)
  assert.equal(facets.verifiedOutcome, null)
})

// -- Adversarial: mid-word truncation (leading bare suffix fragment, R4)

test('C2: mid-word truncated remedy is dropped while valid siblings survive', () => {
  const user = 'The issue is flaky tests deadlocking under load. The root cause is concurrent DatabaseSync writes without a busy timeout. The remedy is ing the filter and letting SQLite checkpoint the writes.'
  const { facets } = extractCausalFacets({ user, tools: [], files: [] })
  assert.ok(facets, 'a core explanation remains so facets must survive')
  assert.equal(facets.remedy, null, 'mid-word capture must be dropped, not fabricated')
  assert.ok(facets.symptom, 'valid symptom sibling is preserved')
  assert.ok(facets.rootCause, 'valid rootCause sibling is preserved')
})

// -- Adversarial: punctuation boundary (leading non-letter, R3)

test('C2: leading-punctuation symptom is dropped while valid siblings survive', () => {
  const user = 'The issue is , leading comma artifact here. The root cause is concurrent writes racing on the lock. The remedy is to serialize with a write mutex.'
  const { facets } = extractCausalFacets({ user, tools: [], files: [] })
  assert.ok(facets)
  assert.equal(facets.symptom, null, 'facet starting with punctuation must be dropped')
  assert.ok(facets.rootCause)
  assert.ok(facets.remedy)
})

// -- Adversarial: unbalanced delimiters (R6)

test('C2: unbalanced-parenthesis rootCause is dropped while valid siblings survive', () => {
  const user = 'The issue is flaky tests deadlocking under load. The root cause is about concurrent put), remedyRec (wrap mutex), still broken. The remedy is to serialize with a write mutex.'
  const { facets } = extractCausalFacets({ user, tools: [], files: [] })
  assert.ok(facets)
  assert.equal(facets.rootCause, null, 'unbalanced delimiters must be dropped')
  assert.ok(facets.symptom)
  assert.ok(facets.remedy)
})

// -- Adversarial: truncated last-word stub (R7)

test('C2: remedy ending in a truncated stub word is dropped', () => {
  const user = 'The issue is flaky tests deadlocking under load. The root cause is concurrent writes racing on the lock. The solution is to fix db'
  const { facets } = extractCausalFacets({ user, tools: [], files: [] })
  assert.ok(facets)
  assert.equal(facets.remedy, null, 'stub last word must be dropped')
  assert.ok(facets.symptom)
  assert.ok(facets.rootCause)
})

// -- Adversarial: single-character first word (R4)

test('C2: rootCause beginning with a single-character word is dropped', () => {
  const user = 'The issue is flaky tests deadlocking under load. The root cause is a b c d e words here. The remedy is to serialize with a write mutex.'
  const { facets } = extractCausalFacets({ user, tools: [], files: [] })
  assert.ok(facets)
  assert.equal(facets.rootCause, null, 'single-char first word must be dropped')
  assert.ok(facets.symptom)
  assert.ok(facets.remedy)
})

// -- Missing facets: partial causal records keep what is valid, null the rest

test('C2: partial record (symptom + rootCause) keeps valid facets, remedy stays null', () => {
  const user = 'The issue is flaky test flaking on database lock. The root cause is missing PRAGMA busy_timeout on open.'
  const { facets } = extractCausalFacets({ user, tools: [], files: [] })
  assert.ok(facets)
  assert.ok(facets.symptom)
  assert.ok(facets.rootCause)
  assert.equal(facets.remedy, null)
})

// -- No fabrication: a symptom alone never manufactures a causal explanation

test('C2: symptom without core explanation yields null facets (never fabricated)', () => {
  const user = 'The issue is flaky tests under load.'
  const { facets } = extractCausalFacets({ user, tools: [], files: [] })
  assert.equal(facets, null, 'no rootCause/remedy means no causal record')
})

// -- Temporal adjacency is never causality (adjacent non-causal sentences)

test('C2: adjacent fail->edit->pass sentences with no causal claim stay null', () => {
  const user = 'The issue is flaky tests. Tests failed then I edited the store then tests passed.'
  const tools = [{ name: 'bash:result', preview: '✔ 58 tests passed (110ms)\n[exit code: 0]' }]
  const { facets } = extractCausalFacets({ user, tools, files: ['src/store.mjs'] })
  assert.equal(facets, null, 'outcome + symptom without rootCause/remedy is not causality')
})

// -- Valid verifiedOutcome enum survives the gate (not treated as malformed)

test('C2: valid test-passed outcome is preserved alongside valid facets', () => {
  const user = 'The issue is flaky tests crashing with SQLITE_BUSY. The root cause is concurrent DatabaseSync calls corrupting FTS triggers. The remedy is to serialize writes using a mutex.'
  const tools = [{ name: 'bash:result', preview: '✔ 58 tests passed (110ms)\n[exit code: 0]' }]
  const { facets } = extractCausalFacets({ user, tools, files: ['src/store.mjs'] })
  assert.ok(facets)
  assert.equal(facets.verifiedOutcome, 'test-passed')
  assert.ok(facets.rootCause)
})

// -- Multiline input separates cleanly per line (no cross-line facet bleed)

test('C2: multiline capture keeps rootCause and remedy on their own lines', () => {
  const user = 'The root cause is concurrent write contention\nThe remedy is to add a busy timeout pragma on open'
  const { facets } = extractCausalFacets({ user, tools: [], files: [] })
  assert.ok(facets)
  assert.equal(facets.rootCause, 'concurrent write contention')
  assert.ok(facets.remedy)
  assert.ok(!facets.rootCause.includes('remedy'), 'no bleed into rootCause')
  assert.ok(!facets.remedy.toLowerCase().includes('root cause'), 'no bleed into remedy')
})

// -- distillBuffer: raw evidence + provenance survive even when facets shrink

test('C2: distillBuffer preserves evidence[] and source provenance when a facet is gated out', () => {
  const buffer = newBuffer()
  observeEvent(buffer, {}, { type: 'turn/start', data: { turn: 1 } })
  observeEvent(buffer, {}, {
    type: 'user/message',
    data: { content: [{ type: 'text', text: 'The issue is , broken capture at start. The root cause is concurrent DatabaseSync writes racing. The remedy is to wrap writes in a mutex.' }] },
  })
  observeEvent(buffer, {}, {
    type: 'tool/call',
    data: { callId: 'c1', name: 'bash', arguments: JSON.stringify({ command: 'npm test' }) },
  })
  observeEvent(buffer, {}, {
    type: 'tool/result',
    data: { callId: 'c1', name: 'bash', output: '✔ 58 tests passed\n[exit code: 0]' },
  })

  const record = distillBuffer(buffer, { projectId: 'p_test', sessionId: 's1' })
  assert.ok(record, 'a record is still produced from the raw capture')
  // raw evidence + provenance survive
  assert.ok(Array.isArray(record.evidence), 'evidence[] present')
  assert.ok(record.source, 'source present')
  assert.ok(record.source.causal, 'source.causal provenance present')
  assert.equal(record.source.causal.rootCause, 'concurrent DatabaseSync writes racing')
  // provenance records the symptom as gated (dropped, not fabricated)
  assert.equal(record.source.causal.symptom, null, 'gated symptom is null in provenance')
  // the derived facet line is never fabricated, while raw capture prose (evidence) stays
  assert.ok(!record.body.includes('Symptom: , broken'), 'derived Symptom line not fabricated')
  assert.ok(record.body.includes(', broken capture at start'), 'raw capture prose preserved as evidence')
  assert.ok(record.body.includes('Root cause: concurrent DatabaseSync writes racing'), 'valid sibling facet still emitted')
})


// ============================================================================
// M12 C2 — Adversarial review of qualityGateFacet()
//
// The gate must reject malformed capture artifacts WITHOUT rejecting
// legitimate engineering causal statements, and it must never rewrite one.
// Two invariants are pinned below:
//   - KEEP list: every legitimate statement class is returned verbatim
//   - DROP list: every malformed class is rejected
// Failure mode is drop-only: the raw observation (body, evidence[], source.*)
// is preserved upstream by distillBuffer, so a drop never destroys evidence
// and never fabricates a replacement facet.
// ============================================================================

test('C2 adversarial: legitimate engineering statements are never rejected', () => {
  const keep = [
    // 1. short engineering terms (>= the documented 5-char floor)
    'deadlock on write', 'OOM kill', 'heap leak',
    // 2. valid commands
    'npm test', 'rm -rf node_modules and reinstall', 'git rebase -i HEAD~3',
    'node --check src/evolve.mjs', 'sqlite3 memory.db PRAGMA integrity_check',
    'npx tsc --noEmit',
    // 3. filenames
    'src/store.mjs', 'test/m12-consolidation.test.mjs', 'package.json',
    'src/evidence.mjs is new',
    // 4. identifiers
    'supersedeEligible() returns false', 'MAX_MEMORY_BODY_CHARS is 4000',
    'qualityGateFacet(value)', 'evolveAgainst() short-circuits to add',
    // 5. abbreviations
    'WAL checkpoint blocked writers', 'FTS5 index rebuild',
    'SQLITE_BUSY under load', 'CJK tokenization applied',
    // 6. version strings
    'Node 24.21.0 crashed', 'upgraded to 0.1.33', 'v2 API removed the field',
    'pinned sqlite 3.50',
    // 7. parenthesized technical expressions
    'the mutex (DatabaseSync) was missing', 'used splice(0, 1) to remove it',
    'NOTE (M12) read-only pass',
    // 8. quoted technical terms
    'the "deleted row" claim was wrong', 'flagged as "stale" by the sweep',
    'entered "use strict" mode', 'reported "database is locked" error',
    // 9. causal statements ending in a short (but complete) word
    'the pragma no longer applied to it', 'writers held the lock',
    'the retry surfaced SQLITE_BUSY', 'the facet was dropped for the test',
    'writers stalled because of it', 'the flush returned before it',
  ]
  for (const s of keep) assert.equal(qualityGateFacet(s), s, `must KEEP: ${s}`)
})

test('C2 adversarial: malformed fragments are rejected (suffix, truncation, stubs)', () => {
  const drop = [
    // 10. bare suffix fragments (capture began mid-word)
    'ing the filter and letting SQLite checkpoint', 'tion of the WAL segment',
    'ness of the write path', 'ous behaviour after the change',
    'ation completed but the row stayed', 'able to reproduce it',
    // 11. unbalanced / truncated fragments
    'the mutex (DatabaseSync', 'he said "the row', 'previously)',
    'the lock was released ea', 'grep: write error: Broken pi',
    'a b c d e words here',
    // structural floors (documented rules)
    'OOM', 'race', 'ab', '5',                       // R2: below the 5-char floor
    ', leading comma artifact here',                 // R3: leading punctuation
    '12345678901234567890',                         // R3: not an ASCII letter start
  ]
  for (const s of drop) assert.equal(qualityGateFacet(s), null, `must DROP: ${s}`)
})

test('C2 adversarial: gate returns input verbatim and only ever drops', () => {
  const raw = '  the retry surfaced SQLITE_BUSY  '
  const kept = qualityGateFacet(raw)
  assert.equal(kept, raw.trim(), 'only trim() is applied — no rewriting')
  assert.notEqual(kept, raw, 'trim is the sole normalization')
  assert.equal(qualityGateFacet('the mutex (DatabaseSync'), null, 'invalid facet is dropped, never repaired')
  // non-string input is rejected outright rather than coerced
  assert.equal(qualityGateFacet(null), null)
  assert.equal(qualityGateFacet(undefined), null)
  assert.equal(qualityGateFacet(42), null)
  assert.equal(qualityGateFacet(['a']), null)
})
