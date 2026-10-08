/**
 * Veyra — Change-Aware Trusted Context (GOAL.md Phase 2).
 *
 * A read-time classification that answers, for one record:
 * "given the current repository state, a possible code change, and the
 * existing validation/authority/temporal/applicability signals, should a
 * coding agent TRUST this recalled knowledge right now?"
 *
 * Categories (GOAL.md Phase 2):
 *   trusted              — applicable, fresh, sufficient authority + validation
 *   review_required      — relevant but uncertain (changed, unverified, candidate,
 *                          not-yet-effective, applicability mismatch)
 *   stale                — code evidence or temporal validity no longer holds
 *   contradicted         — other knowledge contradicts it (both stay visible)
 *   insufficient_evidence— nothing recorded to verify against
 *
 * Invariants:
 *   - Classification is a PROJECTION. It never writes to any store, never
 *     rewrites a record, and never changes authority or validation.
 *   - Candidate ≠ Truth: a candidate authority can never classify as trusted.
 *   - Similarity ≠ Applicability: captured context mismatch is surfaced, not guessed.
 *   - Repository truth is authoritative: freshness is computed from the actual
 *     files, and degraded Code Intelligence yields reduced evidence — never
 *     fabricated symbol or call-graph relationships.
 */

import { AUTHORITIES, STATUSES, VALIDATIONS } from './types.mjs'
import { FRESHNESS_STATUS } from './code/types.mjs'
import { extractAnchorsFromRecord, checkRecordFreshness } from './code/linking.mjs'
import { resolveSafeRepoPath } from './code/discovery.mjs'
import { temporalState, contextCompatibility } from './retrieve.mjs'

/** The five Phase 2 trust categories (lowercase enum values, like all Veyra enums). */
export const TRUST_CATEGORIES = Object.freeze({
  TRUSTED: 'trusted',
  REVIEW_REQUIRED: 'review_required',
  STALE: 'stale',
  CONTRADICTED: 'contradicted',
  INSUFFICIENT_EVIDENCE: 'insufficient_evidence',
})

/** The explainable action that accompanies each category (GOAL.md §Explainability). */
export const TRUST_ACTIONS = Object.freeze({
  trusted: 'use as context; still verify against the repository',
  review_required: 'review before relying on this knowledge',
  stale: 'revalidate against the repository before relying on this knowledge',
  contradicted: 'both sides stay visible; the repository wins',
  insufficient_evidence: 'gather evidence before relying on this knowledge',
})

/**
 * Category precedence: the strongest signal wins, so a contradiction can never
 * be hidden behind staleness, and staleness can never hide behind uncertainty.
 * TRUSTED is the implicit fallback when no signal fires.
 */
const PRECEDENCE = [
  TRUST_CATEGORIES.CONTRADICTED,
  TRUST_CATEGORIES.STALE,
  TRUST_CATEGORIES.INSUFFICIENT_EVIDENCE,
  TRUST_CATEGORIES.REVIEW_REQUIRED,
]

/** Bounded explainability notes attached to every classification. */
const MAX_EVIDENCE_NOTES = 6
const MAX_ANCHOR_PATHS = 3

function tryFreshness(record, workspace) {
  try {
    return checkRecordFreshness(record, workspace)
  } catch {
    return null
  }
}

/**
 * Classify one record's trust for a coding agent.
 *
 * Pure read-time evaluation over fields the record already persists plus the
 * actual repository state. `changedFiles` adds the Phase 1 change-impact
 * signal: a record whose code anchors match a changed file is flagged for
 * review even when its stored hash happens to still match (the change list is
 * the weaker but broader signal; content freshness still outranks it to STALE).
 *
 * @param {object} record   a memory record (ideally contradiction-annotated)
 * @param {object} [options]
 * @param {string|null} [options.workspace]      repo root used to verify anchors
 * @param {string[]|null} [options.changedFiles] changed paths (repo-relative)
 * @param {boolean} [options.degraded]           Code Intelligence is degraded
 * @param {object}  [options.freshness]          precomputed checkRecordFreshness
 *                                               result (skips a re-read)
 * @returns {object} { category, reasons, evidence, freshness, temporal,
 *                     authority, validation, changed, changedFiles,
 *                     degraded, action }
 */
export function classifyRecordTrust(record, options = {}) {
  const {
    workspace = null,
    changedFiles = null,
    degraded = false,
  } = options
  const hasFreshness = Object.prototype.hasOwnProperty.call(options, 'freshness')

  const signals = [] // { category, reason } — every triggered signal, in evaluation order
  const evidence = [] // explainability notes drawn from stored facts only

  const anchors = extractAnchorsFromRecord(record)

  // ── Freshness (repository truth) ──────────────────────────────────────────
  const freshness = hasFreshness
    ? options.freshness
    : workspace
      ? tryFreshness(record, workspace)
      : null

  if (workspace && !freshness) {
    signals.push({
      category: TRUST_CATEGORIES.REVIEW_REQUIRED,
      reason: 'code freshness could not be evaluated against the workspace',
    })
  }
  if (freshness && freshness.status !== FRESHNESS_STATUS.FRESH) {
    const details = (freshness.anchors || [])
      .filter((a) => a.status !== FRESHNESS_STATUS.FRESH && a.reason)
      .map((a) => a.reason)
    const label = freshness.status === FRESHNESS_STATUS.INVALID ? 'invalid' : 'stale'
    signals.push({
      category: TRUST_CATEGORIES.STALE,
      reason: `code evidence ${label}${details.length ? `: ${details[0]}` : ''}`,
    })
    evidence.push(`freshness: ${freshness.status}`)
  }
  if (!workspace && anchors.length > 0 && !hasFreshness) {
    signals.push({
      category: TRUST_CATEGORIES.REVIEW_REQUIRED,
      reason: 'code anchors present but no workspace was provided to verify them',
    })
  }

  // ── Validation lifecycle ─────────────────────────────────────────────────
  if (record.validation === VALIDATIONS.STALE || record.validation === VALIDATIONS.INVALID) {
    signals.push({
      category: TRUST_CATEGORIES.STALE,
      reason: `validation is ${record.validation}`,
    })
  }

  // ── Temporal validity (§13) ───────────────────────────────────────────────
  const temporal = temporalState(record)
  if (temporal === 'expired') {
    signals.push({
      category: TRUST_CATEGORIES.STALE,
      reason: 'temporal validity expired — not current truth',
    })
  } else if (temporal === 'not_yet_effective') {
    signals.push({
      category: TRUST_CATEGORIES.REVIEW_REQUIRED,
      reason: 'temporal validity not yet effective (valid_from in the future)',
    })
  }

  // ── Contradictions (annotated by recall / annotateContradictions) ─────────
  const contraIds = [...new Set((record.contradictions || []).filter(Boolean))]
  const hasBanners = (record.contradictionBanners || []).length > 0
  if (contraIds.length > 0) {
    signals.push({
      category: TRUST_CATEGORIES.CONTRADICTED,
      reason: `contradicted by ${contraIds.join(', ')} — both sides remain visible`,
    })
    evidence.push(`contradictions: ${contraIds.join(', ')}`)
  } else if (hasBanners) {
    signals.push({
      category: TRUST_CATEGORIES.CONTRADICTED,
      reason: 'contradiction detected — both sides remain visible',
    })
  }

  // ── Evidence sufficiency ─────────────────────────────────────────────────
  const hasEvidence = (record.evidence || []).length > 0 || anchors.length > 0
  if (!hasEvidence) {
    signals.push({
      category: TRUST_CATEGORIES.INSUFFICIENT_EVIDENCE,
      reason: 'no evidence or code anchors recorded — nothing to verify against',
    })
  }

  // ── Symbol-level anchors ─────────────────────────────────────────────────
  // A symbol without a file path cannot be checked against the repository.
  // When Code Intelligence is degraded we must not pretend otherwise.
  const symbolOnly = anchors.filter((a) => a.symbol && !a.path)
  if (symbolOnly.length > 0) {
    signals.push(degraded
      ? {
          category: TRUST_CATEGORIES.INSUFFICIENT_EVIDENCE,
          reason: 'symbol anchor(s) cannot be verified while Code Intelligence is degraded',
        }
      : {
          category: TRUST_CATEGORIES.REVIEW_REQUIRED,
          reason: 'symbol anchor(s) without a file path cannot be verified against the repository',
        })
  }

  // ── Change impact (Phase 1 signal feeding Phase 2 trust) ─────────────────
  const changedSet = workspace && changedFiles && changedFiles.length > 0
    ? new Set(changedFiles.map((f) => resolveSafeRepoPath(workspace, f)).filter(Boolean))
    : null
  let changedMatches = []
  if (changedFiles && changedFiles.length > 0) {
    if (!workspace) {
      signals.push({
        category: TRUST_CATEGORIES.REVIEW_REQUIRED,
        reason: 'changed files were provided but no workspace is available to evaluate anchors',
      })
    } else {
      changedMatches = [...new Set(
        anchors
          .map((a) => (a.path ? resolveSafeRepoPath(workspace, a.path) : null))
          .filter((p) => p && changedSet.has(p)),
      )]
      if (changedMatches.length > 0) {
        signals.push({
          category: TRUST_CATEGORIES.REVIEW_REQUIRED,
          reason: `related repository file changed: ${changedMatches.join(', ')}`,
        })
        evidence.push(`changed anchors: ${changedMatches.join(', ')}`)
      }
    }
  }

  // ── Authority / lifecycle / validation standing ──────────────────────────
  if (record.authority === AUTHORITIES.CANDIDATE) {
    signals.push({
      category: TRUST_CATEGORIES.REVIEW_REQUIRED,
      reason: 'candidate authority — candidates never count as truth',
    })
  }
  if (record.status && record.status !== STATUSES.CURRENT) {
    signals.push({
      category: TRUST_CATEGORIES.REVIEW_REQUIRED,
      reason: `lifecycle status is ${record.status}, not current`,
    })
  }
  if (record.validation === VALIDATIONS.UNVERIFIED) {
    signals.push({
      category: TRUST_CATEGORIES.REVIEW_REQUIRED,
      reason: 'validation is unverified',
    })
  }

  // ── Applicability (§12: Similarity ≠ Applicability) ──────────────────────
  const applicable = contextCompatibility(record) !== 0
  if (!applicable) {
    signals.push({
      category: TRUST_CATEGORIES.REVIEW_REQUIRED,
      reason: 'applicability: captured context conflicts with the current runtime',
    })
  }

  // ── Degraded Code Intelligence stays observable (never silent) ───────────
  if (degraded) {
    evidence.push('code intelligence degraded: evaluated from direct file anchors only; no symbol or call-graph evidence used')
  }
  if (anchors.length > 0) {
    const paths = anchors.map((a) => a.path).filter(Boolean).slice(0, MAX_ANCHOR_PATHS)
    if (paths.length > 0) evidence.push(`anchors: ${paths.join(', ')}`)
  }

  // ── Resolve the category by precedence ───────────────────────────────────
  const category = PRECEDENCE.find((c) => signals.some((s) => s.category === c))
    || TRUST_CATEGORIES.TRUSTED
  const reasons = signals.length > 0
    ? signals.map((s) => s.reason)
    : [
        workspace || anchors.length === 0
          ? 'applicable, fresh, sufficient authority and validation'
          : 'applicable, sufficient authority and validation (no workspace to check code anchors)',
      ]

  return {
    category,
    reasons,
    evidence: evidence.slice(0, MAX_EVIDENCE_NOTES),
    freshness: freshness ? freshness.status : null,
    temporal,
    authority: record.authority ?? null,
    validation: record.validation ?? null,
    changed: changedMatches.length > 0,
    changedFiles: changedMatches,
    degraded: Boolean(degraded),
    action: TRUST_ACTIONS[category],
  }
}
