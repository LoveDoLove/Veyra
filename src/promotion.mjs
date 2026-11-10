/**
 * Veyra — governed promotion into Central Memories.
 *
 * Promotion is the only path that writes Central Memories. It is deliberately
 * conservative:
 *
 *   - candidates, observations, retired records, and corrupt records are not
 *     promotable;
 *   - `canonical` still requires an explicit user action (the existing
 *     authority invariant is unchanged);
 *   - a record is only promoted when it carries evidence or is verified;
 *   - an existing Central record with the same id is merged (evidence union,
 *     strongest authority wins) rather than overwritten;
 *   - an existing Central record with the same content hash is *linked*, not
 *     duplicated and not silently replaced;
 *   - every promotion appends a ledger entry to `source.promotions`.
 *
 * The workspace record itself is not modified here; callers decide whether the
 * local authority should also advance.
 */

import {
  AUTHORITIES,
  CONFIDENCES,
  KINDS,
  RELATIONS,
  SCOPES,
  STATUSES,
  VALIDATIONS,
} from './types.mjs'
import { canonicalPath } from './rooms.mjs'

export const PROMOTION_FAILURES = Object.freeze({
  NOT_FOUND: 'promotion/not-found',
  CORRUPT: 'promotion/corrupt-record',
  FORGOTTEN: 'promotion/forgotten',
  RETIRED: 'promotion/retired-status',
  INELIGIBLE_KIND: 'promotion/ineligible-kind',
  CANDIDATE_NOT_PROMOTABLE: 'promotion/candidate-not-promotable',
  INSUFFICIENT_EVIDENCE: 'promotion/insufficient-evidence',
  CANONICAL_REQUIRES_EXPLICIT: 'promotion/canonical-requires-explicit',
  CROSS_WORKSPACE_SOURCE: 'promotion/cross-workspace-source',
  INVALID_TARGET: 'promotion/invalid-target',
})

const PROMOTABLE_KINDS = new Set([
  KINDS.MEMORY,
  KINDS.KNOWLEDGE,
  KINDS.EVIDENCE,
])

const CONFIDENCE_RANK = { [CONFIDENCES.LOW]: 0, [CONFIDENCES.MEDIUM]: 1, [CONFIDENCES.HIGH]: 2 }
const AUTHORITY_RANK = { [AUTHORITIES.CANDIDATE]: 0, [AUTHORITIES.DERIVED]: 1, [AUTHORITIES.CANONICAL]: 2 }

function deny(reason, detail = {}) {
  return { ok: false, reason, ...detail }
}

function strongerAuthority(a, b) {
  return (AUTHORITY_RANK[a] ?? 0) >= (AUTHORITY_RANK[b] ?? 0) ? a : b
}

function strongerConfidence(a, b) {
  return (CONFIDENCE_RANK[a] ?? 0) >= (CONFIDENCE_RANK[b] ?? 0) ? a : b
}

function mergeEvidence(left = [], right = []) {
  const seen = new Set()
  const merged = []
  for (const entry of [...left, ...right]) {
    const key = typeof entry === 'string' ? entry : JSON.stringify(entry)
    if (seen.has(key)) continue
    seen.add(key)
    merged.push(entry)
    if (merged.length >= 32) break
  }
  return merged
}

function sameWorkspace(record, binding) {
  const provenance = record?.source?.workspace || record?.source?.context?.workspace
  if (!provenance) return true
  const expected = binding?.workspacePath
  if (!expected) return false
  try {
    return canonicalPath(provenance) === canonicalPath(expected)
  } catch {
    return String(provenance) === String(expected)
  }
}

export function evaluatePromotion(record, { binding, to = AUTHORITIES.DERIVED, explicit = false } = {}) {
  if (!record) return deny(PROMOTION_FAILURES.NOT_FOUND)
  if (Array.isArray(record.corrupt) && record.corrupt.length) return deny(PROMOTION_FAILURES.CORRUPT)
  if (record.forgotten) return deny(PROMOTION_FAILURES.FORGOTTEN)
  if (record.status !== STATUSES.CURRENT) return deny(PROMOTION_FAILURES.RETIRED, { status: record.status })
  if (!PROMOTABLE_KINDS.has(record.kind)) return deny(PROMOTION_FAILURES.INELIGIBLE_KIND, { kind: record.kind })
  if (record.authority === AUTHORITIES.CANDIDATE) {
    return deny(PROMOTION_FAILURES.CANDIDATE_NOT_PROMOTABLE)
  }
  if (to !== AUTHORITIES.DERIVED && to !== AUTHORITIES.CANONICAL) {
    return deny(PROMOTION_FAILURES.INVALID_TARGET, { to })
  }
  if (to === AUTHORITIES.CANONICAL && !explicit) {
    return deny(PROMOTION_FAILURES.CANONICAL_REQUIRES_EXPLICIT)
  }
  if (!sameWorkspace(record, binding)) {
    return deny(PROMOTION_FAILURES.CROSS_WORKSPACE_SOURCE)
  }
  const evidence = Array.isArray(record.evidence) ? record.evidence : []
  const verified = record.validation === VALIDATIONS.VERIFIED
  if (!evidence.length && !verified) {
    return deny(PROMOTION_FAILURES.INSUFFICIENT_EVIDENCE)
  }
  return { ok: true, to }
}

function findCentralMatch(centralStore, record) {
  const byId = centralStore.get(record.id)
  if (byId) return { kind: 'id', record: byId }
  const hash = record.contentHash
  if (!hash) return null
  let candidates = []
  try {
    candidates = centralStore.search(record.title || '', { limit: 20, includeForgotten: true })
  } catch {
    candidates = []
  }
  const match = candidates.find((candidate) => candidate.contentHash === hash)
  return match ? { kind: 'content-hash', record: match } : null
}

/**
 * @returns {{ok:boolean, reason?:string, action?:'created'|'merged'|'linked',
 *   centralId?:string, authority?:string}}
 */
export function promoteRecord({
  workspaceStore,
  centralStore,
  binding,
  id,
  to = AUTHORITIES.DERIVED,
  explicit = false,
  reason = '',
  now = new Date().toISOString(),
} = {}) {
  if (!workspaceStore || !centralStore) return deny(PROMOTION_FAILURES.NOT_FOUND)
  if (!binding?.roomId) return deny(PROMOTION_FAILURES.CROSS_WORKSPACE_SOURCE)
  const record = workspaceStore.get(id)
  const verdict = evaluatePromotion(record, { binding, to, explicit })
  if (!verdict.ok) return verdict

  const entry = {
    at: now,
    fromRoom: binding.roomId,
    workspaceId: binding.workspaceId ?? null,
    to,
    explicit: Boolean(explicit),
    reason: typeof reason === 'string' ? reason : '',
  }

  const match = findCentralMatch(centralStore, record)
  if (match?.kind === 'content-hash' && match.record.id !== record.id) {
    // Same knowledge already exists in Central under another id. Link instead
    // of creating a duplicate or replacing the existing body.
    return {
      ok: true,
      action: 'linked',
      centralId: match.record.id,
      authority: match.record.authority,
    }
  }

  if (match?.kind === 'id') {
    const existing = match.record
    const merged = {
      ...existing,
      authority: strongerAuthority(existing.authority, to),
      confidence: strongerConfidence(existing.confidence, record.confidence),
      validation: existing.validation === VALIDATIONS.VERIFIED || record.validation === VALIDATIONS.VERIFIED
        ? VALIDATIONS.VERIFIED
        : existing.validation,
      evidence: mergeEvidence(existing.evidence, record.evidence),
      relations: mergeRelations(existing.relations, record.relations, RELATIONS.DERIVES, record.id),
      source: {
        ...existing.source,
        promotions: [...(Array.isArray(existing.source?.promotions) ? existing.source.promotions : []), entry],
      },
    }
    const written = centralStore.put(merged, {
      explicitCanonical: merged.authority === AUTHORITIES.CANONICAL,
    })
    return {
      ok: true,
      action: 'merged',
      centralId: written.record.id,
      authority: written.record.authority,
    }
  }

  const promoted = {
    ...record,
    projectId: 'reusable',
    scope: SCOPES.REUSABLE,
    authority: to,
    relations: mergeRelations(record.relations, [], RELATIONS.DERIVES, record.id),
    source: {
      ...record.source,
      promotions: [...(Array.isArray(record.source?.promotions) ? record.source.promotions : []), entry],
    },
  }
  const written = centralStore.put(promoted, {
    explicitCanonical: to === AUTHORITIES.CANONICAL && explicit,
  })
  return {
    ok: true,
    action: 'created',
    centralId: written.record.id,
    authority: written.record.authority,
  }
}

function mergeRelations(existing = [], incoming = [], type, targetId) {
  const list = Array.isArray(existing) ? existing.slice() : []
  for (const relation of Array.isArray(incoming) ? incoming : []) {
    if (!list.some((item) => item?.type === relation?.type && item?.targetId === relation?.targetId)) {
      list.push(relation)
    }
  }
  if (targetId && !list.some((item) => item?.type === type && item?.targetId === targetId)) {
    list.push({ type, targetId })
  }
  return list
}
