/**
 * Veyra — domain constants.
 *
 * Adapted from Project-Memory-Agent's 4-D EKU model
 * (`LIFECYCLE_STATES`, `VALIDATION_STATES`, `AUTHORITY_LEVELS`,
 * `CONFIDENCE_LEVELS`) and supermemory's relation types. Veyra keeps the
 * orthogonal dimensions that matter for an engineering brain and drops
 * PMA's documentation-system extras (draft/abandoned, quarantined, etc.).
 */

export const KINDS = Object.freeze({
  OBSERVATION: 'observation',
  MEMORY: 'memory',
  KNOWLEDGE: 'knowledge',
  EVIDENCE: 'evidence',
})

export const STATUSES = Object.freeze({
  CURRENT: 'current',
  DEPRECATED: 'deprecated',
  SUPERSEDED: 'superseded',
  HISTORICAL: 'historical',
})

export const VALIDATIONS = Object.freeze({
  UNVERIFIED: 'unverified',
  REVIEWED: 'reviewed',
  VERIFIED: 'verified',
  STALE: 'stale',
  INVALID: 'invalid',
})

export const AUTHORITIES = Object.freeze({
  CANDIDATE: 'candidate',
  DERIVED: 'derived',
  CANONICAL: 'canonical',
})

export const CONFIDENCES = Object.freeze({
  LOW: 'low',
  MEDIUM: 'medium',
  HIGH: 'high',
})

export const SCOPES = Object.freeze({
  PROJECT: 'project',
  REUSABLE: 'reusable',
})

export const RELATIONS = Object.freeze({
  UPDATES: 'updates',
  EXTENDS: 'extends',
  DERIVES: 'derives',
  CONTRADICTS: 'contradicts',
  SUPERSEDES: 'supersedes',
})

export const VALID_KINDS = Object.freeze(Object.values(KINDS))
export const VALID_STATUSES = Object.freeze(Object.values(STATUSES))
export const VALID_VALIDATIONS = Object.freeze(Object.values(VALIDATIONS))
export const VALID_AUTHORITIES = Object.freeze(Object.values(AUTHORITIES))
export const VALID_CONFIDENCES = Object.freeze(Object.values(CONFIDENCES))
export const VALID_SCOPES = Object.freeze(Object.values(SCOPES))
export const VALID_RELATIONS = Object.freeze(Object.values(RELATIONS))

export const SCHEMA_VERSION = 1

/** Default number of memories injected into the per-turn context. */
export const DEFAULT_RECALL_LIMIT = 5

/** Observations shorter than this are treated as noise. */
export const MIN_OBSERVATION_CHARS = 40

/** Auto-learned derived memories stay below this body size. */
export const MAX_MEMORY_BODY_CHARS = 4000

/**
 * Authority gate for active recall.
 *
 * Invariant (GOAL.md): Candidate ≠ Truth. Automatic behavior must not
 * silently create authoritative truth. Candidates and unverified
 * observations never appear in ambient recall.
 */
export function isRecallEligible(record) {
  if (!record) return false
  if (record.forgotten) return false
  if (record.status !== STATUSES.CURRENT) return false
  if (record.validation === VALIDATIONS.INVALID || record.validation === VALIDATIONS.STALE) {
    return false
  }
  if (record.authority === AUTHORITIES.CANDIDATE) return false
  if (record.kind === KINDS.OBSERVATION) return false
  return record.authority === AUTHORITIES.DERIVED || record.authority === AUTHORITIES.CANONICAL
}

/**
 * Canonical authority is never assigned automatically.
 * Only an explicit user-facing promote action may set it.
 */
export function assertAuthorityTransition(from, to, { explicit = false } = {}) {
  if (to === AUTHORITIES.CANONICAL && !explicit) {
    throw new Error('Veyra refuses to auto-promote memory to canonical authority')
  }
  if (from === AUTHORITIES.CANONICAL && to === AUTHORITIES.CANDIDATE) {
    throw new Error('canonical memory cannot be demoted to a candidate')
  }
}

export function normalizeEnum(value, allowed, fallback) {
  if (typeof value === 'string' && allowed.includes(value)) return value
  return fallback
}
