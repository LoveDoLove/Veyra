/**
 * Veyra — M12 C1: Evidence Intelligence.
 *
 * A deterministic, pure classifier for the RELATIONSHIP between a piece of
 * evidence and a claim. It returns one of five states:
 *
 *   supports    — subject-compatible evidence whose test outcome passed
 *   contradicts — subject-compatible evidence whose test outcome failed
 *   unrelated   — a signal that is NOT about the claim's subject
 *   insufficient— subject-compatible but carries no pass/fail signal (or nothing to judge)
 *   ambiguous   — subject-compatible evidence carrying BOTH a pass and a fail
 *
 * Invariants (M12 safety):
 *   - This classifies evidence RELATIONSHIPS only. It never assigns authority,
 *     validation, status, forgotten, or truth. `test-failed` is a test signal,
 *     NOT a verdict about record validity.
 *   - The path to `contradicts` from `test-failed` requires subject/claim
 *     compatibility to be established FIRST. An unrelated failure stays
 *     `unrelated`. Mixed relevant pass+fail is `ambiguous`, never a silent call.
 *   - Pure: no store access, no side effects, no mutation of its inputs.
 *
 * Subject compatibility reuses the existing `sharesSubject` path/source.files
 * overlap (Similarity ≠ Authority; a bare overlap is only compatibility, not
 * proof). It does NOT introduce a second scoring engine.
 */

import { sharesSubject } from './diff.mjs'

/** The five evidence-relationship states. A closed vocabulary. */
export const EVIDENCE_RELATIONS = Object.freeze({
  SUPPORTS: 'supports',
  CONTRADICTS: 'contradicts',
  UNRELATED: 'unrelated',
  INSUFFICIENT: 'insufficient',
  AMBIGUOUS: 'ambiguous',
})

/** Verified test outcomes, matching the literals used across the pipeline. */
export const TEST_OUTCOMES = Object.freeze({
  PASSED: 'test-passed',
  FAILED: 'test-failed',
  TOUCHED: 'tests-touched',
})

const OUTCOME_VALUES = new Set([TEST_OUTCOMES.PASSED, TEST_OUTCOMES.FAILED, TEST_OUTCOMES.TOUCHED])

/** Normalized title used for conservative subject echo. */
function normTitle(record) {
  const t = typeof record?.title === 'string' ? record.title : ''
  return t.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim()
}

/**
 * Subject/claim compatibility between a claim and one evidence item.
 *
 * Order:
 *   1. explicit override (`opts.subjectCompatible`) — caller precomputed
 *   2. existing `sharesSubject` — evidence path / source.files overlap
 *   3. conservative normalized-title echo (one contains the other, min length)
 *
 * Returns a boolean. Default is NOT compatible (fail toward `unrelated`,
 * which never accuses the claim of contradiction without shared subject).
 */
export function subjectsCompatible(claim, evidence, opts = {}) {
  if (typeof opts.subjectCompatible === 'boolean') return opts.subjectCompatible
  if (sharesSubject(claim, evidence)) return true
  const a = normTitle(claim)
  const b = normTitle(evidence)
  if (a.length >= 10 && b.length >= 10 && (a.includes(b) || b.includes(a))) return true
  return false
}

/**
 * Gather verified test outcomes from a record's structured signals:
 *   - `source.causal.verifiedOutcome`
 *   - `evidence[].note` when it is one of the three outcome literals
 *
 * Only structured signals are read (never a body-text scan) to avoid matching
 * prose that merely mentions a test.
 *
 * @returns {{ passed: boolean, failed: boolean, touched: boolean, outcomes: string[] }}
 */
export function evidenceOutcomes(record) {
  const outcomes = []
  const push = (v) => {
    if (typeof v === 'string' && OUTCOME_VALUES.has(v)) outcomes.push(v)
  }
  push(record?.source?.causal?.verifiedOutcome)
  for (const e of record?.evidence || []) push(e?.note)
  return {
    passed: outcomes.includes(TEST_OUTCOMES.PASSED),
    failed: outcomes.includes(TEST_OUTCOMES.FAILED),
    touched: outcomes.includes(TEST_OUTCOMES.TOUCHED),
    outcomes: [...new Set(outcomes)],
  }
}

/** True when the record has anchored structural evidence (path/uri or source files). */
function structuralEvidence(record) {
  const ev = record?.evidence || []
  const hasPath = ev.some((e) => (typeof e === 'string' ? e.trim() : (e?.path || e?.uri)))
  const files = record?.source?.files
  const hasFiles = Array.isArray(files) && files.length > 0
  return hasPath || hasFiles
}

/**
 * Classify the relationship between a claim and a set of evidence.
 *
 * @param {object} claim    record under test (`{ title, body, evidence, source }`)
 * @param {object|object[]} evidence  one record or an array of evidence records
 * @param {object} [opts]   `{ subjectCompatible?: boolean }` explicit override
 * @returns {string} one of `EVIDENCE_RELATIONS`
 */
export function classifyEvidenceRelation(claim, evidence, opts = {}) {
  const items = (Array.isArray(evidence) ? evidence : [evidence]).filter(Boolean)

  let passed = false
  let failed = false
  let structural = false
  let sawSignal = false

  for (const item of items) {
    const o = evidenceOutcomes(item)
    const itemStructural = structuralEvidence(item)
    const hasSignal = o.passed || o.failed || o.touched || itemStructural
    if (!hasSignal) continue
    sawSignal = true

    if (!subjectsCompatible(claim, item, opts)) continue // unrelated signal: never tallied

    if (o.passed) passed = true
    if (o.failed) failed = true
    if (itemStructural) structural = true
  }

  // No signal at all → nothing to judge.
  if (!sawSignal) return EVIDENCE_RELATIONS.INSUFFICIENT

  // Determine whether ANY compatible signal existed. If every signal was about
  // a different subject, the relationship is `unrelated` (a failure here stays
  // unrelated — the spec's core safety rule).
  const anyCompatible = passed || failed || structural
  if (!anyCompatible) return EVIDENCE_RELATIONS.UNRELATED

  // Subject-compatible:
  if (passed && failed) return EVIDENCE_RELATIONS.AMBIGUOUS
  if (failed) return EVIDENCE_RELATIONS.CONTRADICTS
  if (passed) return EVIDENCE_RELATIONS.SUPPORTS
  // Compatible but structural-only (no pass/fail) → honest "not enough to call it".
  return EVIDENCE_RELATIONS.INSUFFICIENT
}
