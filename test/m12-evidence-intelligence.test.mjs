import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  EVIDENCE_RELATIONS, TEST_OUTCOMES,
  subjectsCompatible, evidenceOutcomes, classifyEvidenceRelation,
} from '../src/evidence.mjs'
import { AUTHORITIES, STATUSES, VALIDATIONS, KINDS } from '../src/types.mjs'

// ============================================================================
// M12 C1 — Evidence Intelligence (pure, read-only relationship classifier)
//
// Core safety rule under test:
//   test-failed NEVER becomes an authority/validation/status change; path is
//   test-failed -> possibly contradicts, only after subject/claim
//   compatibility. An unrelated failure stays `unrelated`; mixed -> `ambiguous`.
// The classifier returns RELATIONSHIP labels only — never authority states.
// ============================================================================

const claim = (over = {}) => ({
  title: 'Serialize DatabaseSync writes with a mutex',
  body: 'Concurrent DatabaseSync writes corrupt FTS triggers under load.',
  evidence: [{ path: 'src/store.mjs' }],
  source: { files: ['src/store.mjs'] },
  ...over,
})

// Same subject as `claim` (shares src/store.mjs).
const relEvidence = (over = {}) => ({
  title: 'Concurrent write race on the same row',
  body: 'observed under load',
  evidence: [{ path: 'src/store.mjs' }],
  source: { files: ['src/store.mjs'] },
  ...over,
})

// Different subject (no shared path, titles do not echo).
const unrelatedEvidence = (over = {}) => ({
  title: 'Refresh the README badge links',
  body: 'docs housekeeping',
  evidence: [{ path: 'docs/readme.md' }],
  source: { files: ['docs/readme.md'] },
  ...over,
})

// -- Mandated gold set ------------------------------------------------------

test('C1 gold: test-failed on a DIFFERENT subject stays `unrelated`', () => {
  const ev = unrelatedEvidence({ evidence: [{ path: 'docs/readme.md', note: 'test-failed' }] })
  assert.equal(classifyEvidenceRelation(claim(), ev), EVIDENCE_RELATIONS.UNRELATED)
})

test('C1 gold: test-failed on the SAME subject -> `contradicts`', () => {
  const ev = relEvidence({ evidence: [{ path: 'src/store.mjs', note: 'test-failed' }] })
  assert.equal(classifyEvidenceRelation(claim(), ev), EVIDENCE_RELATIONS.CONTRADICTS)
})

test('C1 gold: mixed passed+failed on the SAME subject -> `ambiguous`', () => {
  const passEv = relEvidence({ evidence: [{ path: 'src/store.mjs', note: 'test-passed' }] })
  const failEv = relEvidence({ evidence: [{ path: 'src/store.mjs', note: 'test-failed' }] })
  assert.equal(
    classifyEvidenceRelation(claim(), [passEv, failEv]),
    EVIDENCE_RELATIONS.AMBIGUOUS,
  )
})

// -- Relationship vocabulary (relationship labels only, never authority) -----

test('C1: classifier only ever returns relationship labels, never authority/status/validation states', () => {
  const forbidden = new Set([
    ...Object.values(AUTHORITIES), ...Object.values(STATUSES),
    ...Object.values(VALIDATIONS), ...Object.values(KINDS),
    'candidate', 'canonical', 'verified', 'invalid', 'stale', 'forgotten',
  ])
  const ev = relEvidence({ evidence: [{ path: 'src/store.mjs', note: 'test-failed' }] })
  const result = classifyEvidenceRelation(claim(), ev)
  assert.ok(Object.values(EVIDENCE_RELATIONS).includes(result), `known relation: ${result}`)
  assert.ok(!forbidden.has(result), `relation must not be an authority-like state: ${result}`)
})

test('C1: EVIDENCE_RELATIONS and TEST_OUTCOMES are frozen and complete', () => {
  assert.ok(Object.isFrozen(EVIDENCE_RELATIONS))
  assert.ok(Object.isFrozen(TEST_OUTCOMES))
  assert.deepEqual(Object.values(EVIDENCE_RELATIONS).sort(),
    ['ambiguous', 'contradicts', 'insufficient', 'supports', 'unrelated'])
  assert.deepEqual(Object.values(TEST_OUTCOMES).sort(),
    ['test-failed', 'test-passed', 'tests-touched'])
})

// -- Remaining classification states ---------------------------------------

test('C1: no signal at all -> `insufficient`', () => {
  const ev = { title: 'Refresh the README badge links', body: 'docs housekeeping', evidence: [], source: {} }
  assert.equal(classifyEvidenceRelation(claim(), ev), EVIDENCE_RELATIONS.INSUFFICIENT)
})

test('C1: test-passed on the same subject -> `supports`', () => {
  const ev = relEvidence({ evidence: [{ path: 'src/store.mjs', note: 'test-passed' }] })
  assert.equal(classifyEvidenceRelation(claim(), ev), EVIDENCE_RELATIONS.SUPPORTS)
})

test('C1: structural-only evidence on the same subject -> `insufficient` (honest not-enough)', () => {
  const ev = relEvidence({ evidence: [{ path: 'src/store.mjs' }] }) // path but no pass/fail note
  assert.equal(classifyEvidenceRelation(claim(), ev), EVIDENCE_RELATIONS.INSUFFICIENT)
})

test('C1: tests-touched (with structural path) on the same subject -> `insufficient`', () => {
  const ev = relEvidence({ evidence: [{ path: 'src/store.mjs', note: 'tests-touched' }] })
  assert.equal(classifyEvidenceRelation(claim(), ev), EVIDENCE_RELATIONS.INSUFFICIENT)
})

test('C1: default subject compatibility fails closed (distinct subjects -> false)', () => {
  assert.equal(subjectsCompatible(claim(), unrelatedEvidence()), false)
})

test('C1: subject compatibility via shared evidence path', () => {
  assert.equal(subjectsCompatible(claim(), relEvidence()), true)
})

test('C1: subject compatibility via conservative title echo (long mutual containment)', () => {
  const c = { title: 'The sqlite writer race condition is a real bug here', evidence: [], source: {} }
  const e = { title: 'The sqlite writer race condition is a real bug here', evidence: [], source: {} }
  assert.equal(subjectsCompatible(c, e), true)
})

// -- Purity: classification never mutates its inputs ------------------------

test('C1: classifyEvidenceRelation is pure (inputs deep-equal before/after)', () => {
  const c = claim()
  const ev = relEvidence({ evidence: [{ path: 'src/store.mjs', note: 'test-failed' }] })
  const cBefore = JSON.parse(JSON.stringify(c))
  const evBefore = JSON.parse(JSON.stringify(ev))
  classifyEvidenceRelation(c, ev)
  classifyEvidenceRelation(c, [ev])
  assert.deepEqual(c, cBefore, 'claim unchanged')
  assert.deepEqual(ev, evBefore, 'evidence unchanged')
})

test('C1: evidenceOutcomes reads only structured signals (never body prose)', () => {
  const r = relEvidence({ body: 'the tests failed badly somewhere', evidence: [{ path: 'src/store.mjs' }] })
  const o = evidenceOutcomes(r)
  assert.equal(o.failed, false, 'prose mentioning tests must not count as test-failed')
  assert.equal(o.passed, false)
  assert.deepEqual(o.outcomes, [])
})

test('C1: evidenceOutcomes collects source.causal.verifiedOutcome and evidence[].note literals', () => {
  const r = relEvidence({
    source: { files: ['src/store.mjs'], causal: { verifiedOutcome: 'test-passed' } },
    evidence: [{ path: 'src/store.mjs', note: 'test-failed' }, { path: 'src/store.mjs', note: 'not-an-outcome' }],
  })
  const o = evidenceOutcomes(r)
  assert.equal(o.passed, true)
  assert.equal(o.failed, true)
  assert.ok(o.outcomes.includes('test-passed'))
  assert.ok(o.outcomes.includes('test-failed'))
  assert.ok(!o.outcomes.includes('not-an-outcome'), 'non-literal note ignored')
})

// ----------------------------------------------------------------------------
// M12 C1 — Phase 3 production diagnosis (documented behaviour, pinned as tests)
//
// Two production observations that are CORRECT as-is and must not be
// "balanced" by changing the classifier:
//
//   1. `unrelated` in the audit comes from the harness pairing each record
//      with ITSELF: classifyEvidenceRelation(r, r). A record carrying only
//      note-shaped evidence (evidence:[{note}], source.files:[]) and a title
//      that normalises below the 10-char title-echo floor ("Used bash" -> 9)
//      has no path evidence and no title echo, so subjectsCompatible fails
//      closed. That is the fail-closed design working, not a scoping bug —
//      and self-pairing is NOT a production call path (evidence.mjs has no
//      importer under src/).
//
//   2. `ambiguous` is 0 because a record can carry at most one
//      source.causal.verifiedOutcome, and bothOutcomes measured 0 across the
//      whole corpus. ambiguous is therefore reachable only when two different
//      evidence items genuinely disagree — which is the correct semantics.
//
// Neither observation authorises converting `contradicts` into `invalid`,
// or any authority/validation/status mutation.
// ----------------------------------------------------------------------------

test('C1 diagnosis: self-compatibility fails closed for note-only evidence (audit `unrelated`)', () => {
  // Production shape observed in p_2d59: note-only evidence, no files.
  const noteOnly = {
    title: 'Used bash',
    body: 'ran a command in the workspace',
    evidence: [{ note: 'test-passed' }],
    source: { files: [] },
  }
  // No shared path AND title echo below the 10-char floor -> fail closed.
  assert.equal(subjectsCompatible(noteOnly, noteOnly), false)
  assert.equal(classifyEvidenceRelation(noteOnly, noteOnly), EVIDENCE_RELATIONS.UNRELATED)

  // The very same record becomes compatible — and its signal honoured — the
  // moment it carries anchored path evidence. The classifier is not biased
  // against the record; it simply refuses to guess a subject without proof.
  const withPath = {
    ...noteOnly,
    evidence: [{ path: 'src/store.mjs', note: 'test-passed' }],
    source: { files: ['src/store.mjs'] },
  }
  assert.equal(subjectsCompatible(withPath, withPath), true)
  assert.equal(classifyEvidenceRelation(withPath, withPath), EVIDENCE_RELATIONS.SUPPORTS)

  // A failing record on the same anchored subject still lands on `contradicts`
  // — never on `invalid`, never on an authority change.
  const failedWithPath = { ...withPath, evidence: [{ path: 'src/store.mjs', note: 'test-failed' }] }
  assert.equal(classifyEvidenceRelation(failedWithPath, failedWithPath), EVIDENCE_RELATIONS.CONTRADICTS)
})

test('C1 diagnosis: `ambiguous` needs BOTH outcomes — one verifiedOutcome never splits', () => {
  for (const note of [TEST_OUTCOMES.PASSED, TEST_OUTCOMES.FAILED]) {
    const r = claim({
      source: { files: ['src/store.mjs'], causal: { verifiedOutcome: note } },
      evidence: [{ path: 'src/store.mjs', note }],
    })
    const o = evidenceOutcomes(r)
    assert.equal(o.passed && o.failed, false, `single outcome ${note} yields both flags`)
    assert.equal(
      classifyEvidenceRelation(r, r),
      note === TEST_OUTCOMES.PASSED ? EVIDENCE_RELATIONS.SUPPORTS : EVIDENCE_RELATIONS.CONTRADICTS,
    )
  }

  // ambiguous is reachable only when two evidence items genuinely disagree.
  const disagree = claim({
    source: { files: ['src/store.mjs'], causal: { verifiedOutcome: TEST_OUTCOMES.PASSED } },
    evidence: [{ path: 'src/store.mjs', note: TEST_OUTCOMES.FAILED }],
  })
  const o = evidenceOutcomes(disagree)
  assert.equal(o.passed && o.failed, true)
  assert.equal(classifyEvidenceRelation(disagree, disagree), EVIDENCE_RELATIONS.AMBIGUOUS)
})
