/**
 * Veyra — evidence-aware learning.
 *
 * Repeated observations, successful solutions, and explicit remember
 * calls can become derived knowledge. Learning never manufactures
 * canonical authority (GOAL.md: Automatic behavior must not silently
 * create authoritative truth).
 *
 * Understand (distill) decides what the turn claimed. Evolve (diff)
 * decides how that claim relates to existing memory. Similarity never
 * merges two records (OpenViking merge_policy).
 */

import {
  AUTHORITIES,
  CONFIDENCES,
  KINDS,
  MAX_MEMORY_BODY_CHARS,
  RELATIONS,
  STATUSES,
  VALIDATIONS,
  isRecallEligible,
} from './types.mjs'
import { contentHash } from './ids.mjs'
import { looksLikeClaim } from './understand.mjs'
import { evolveAgainst } from './evolve.mjs'

export function looksDurable(text) {
  return looksLikeClaim(text) && typeof text === 'string' && text.length >= 60
}

function hasGrounding(candidate) {
  const evidence = candidate?.evidence || []
  if (evidence.some((item) => item && (item.path || item.uri || item.anchor || item.note))) {
    return true
  }
  const files = candidate?.source?.files || []
  return files.length > 0
}

/**
 * After a turn, consider promoting a fresh candidate into derived memory
 * when it looks durable, is grounded, and is not a verbatim duplicate of
 * existing knowledge.
 *
 * Returns the written derived record, or null when nothing was learned.
 */
export function maybeLearn(store, candidate, { related = [] } = {}) {
  if (!store || !candidate) return null
  if (candidate.authority === AUTHORITIES.CANONICAL) return null
  if (!looksDurable(`${candidate.title}\n${candidate.body}`)) return null

  const hash = contentHash(candidate.title, candidate.body)
  const existing = store.list({ limit: 60 }).filter((r) => !r.forgotten)
  if (existing.some((r) => r.contentHash === hash && r.authority !== AUTHORITIES.CANDIDATE && r.id !== candidate.id)) {
    return null
  }

  const seedRelations = []
  for (const other of related) {
    if (other?.id) seedRelations.push({ type: RELATIONS.DERIVES, targetId: other.id })
  }

  const evolved = evolveAgainst(store, {
    ...candidate,
    authority: AUTHORITIES.DERIVED,
    relations: [...(candidate.relations || []), ...seedRelations],
  }, existing)

  // A near-verbatim restatement of existing derived knowledge is not new
  // learning. Keep the candidate as a candidate (inspectable) and link it.
  if (evolved.action === 'duplicate' && evolved.neighbor && isRecallEligible(evolved.neighbor)) {
    if (candidate.id) {
      store.put({
        ...candidate,
        relations: evolved.record.relations,
      })
    }
    return null
  }

  // Update the candidate in place when it already has an id. A new put
  // with the same title/body would collide on content_hash and return
  // the original candidate, so learning would never become recallable.
  const written = store.put({
    id: candidate.id,
    kind: KINDS.MEMORY,
    status: STATUSES.CURRENT,
    validation: VALIDATIONS.UNVERIFIED,
    authority: AUTHORITIES.DERIVED,
    confidence: hasGrounding(candidate) ? CONFIDENCES.MEDIUM : CONFIDENCES.LOW,
    scope: candidate.scope,
    projectId: candidate.projectId,
    title: candidate.title,
    body: String(candidate.body || '').slice(0, MAX_MEMORY_BODY_CHARS),
    tags: unique([...(candidate.tags || []), 'learned', candidate.source?.signal].filter(Boolean)),
    evidence: candidate.evidence || [],
    relations: evolved.record.relations,
    source: {
      ...(candidate.source || {}),
      learnedFrom: candidate.id || null,
      evolveAction: evolved.action,
    },
  })
  return written.record
}

/**
 * Explicit remember path. Agents / users call this to keep durable
 * knowledge. Still refuses canonical unless `explicitCanonical` is set
 * (only `veyra_promote` does that). Evolves relations against neighbors
 * without merging them.
 */
export function remember(store, input, { explicitCanonical = false } = {}) {
  const kind = input.kind === KINDS.KNOWLEDGE || input.kind === KINDS.EVIDENCE
    ? input.kind
    : KINDS.MEMORY
  const authority = explicitCanonical
    ? AUTHORITIES.CANONICAL
    : (input.authority === AUTHORITIES.CANONICAL ? AUTHORITIES.DERIVED : (input.authority || AUTHORITIES.DERIVED))
  const written = store.put({
    ...input,
    kind,
    authority,
    validation: input.validation || VALIDATIONS.UNVERIFIED,
    confidence: input.confidence || CONFIDENCES.MEDIUM,
    status: input.status || STATUSES.CURRENT,
  }, { explicitCanonical })
  if (!written.record || written.duplicate) return written

  const existing = store.list({ limit: 60 }).filter((r) => !r.forgotten && r.id !== written.record.id)
  const evolved = evolveAgainst(store, written.record, existing)
  const before = JSON.stringify(written.record.relations || [])
  const after = JSON.stringify(evolved.record.relations || [])
  if (before === after) return written
  const updated = store.put({
    ...written.record,
    relations: evolved.record.relations,
  }, { explicitCanonical })
  return { ...updated, created: written.created, duplicate: written.duplicate }
}

/**
 * Promote an existing record. Canonical requires an explicit user action.
 * Promoting a candidate to derived is allowed automatically (the agent
 * judged it useful). Promoting to canonical is never automatic.
 */
export function promote(store, id, { to = AUTHORITIES.DERIVED, explicit = false } = {}) {
  const existing = store.get(id)
  if (!existing) return { ok: false, error: 'not found' }
  if (existing.forgotten) return { ok: false, error: 'forgotten' }
  if (to === AUTHORITIES.CANONICAL && !explicit) {
    return { ok: false, error: 'canonical promotion requires an explicit user action' }
  }
  const nextValidation = to === AUTHORITIES.CANONICAL
    ? VALIDATIONS.REVIEWED
    : (existing.validation === VALIDATIONS.UNVERIFIED ? VALIDATIONS.REVIEWED : existing.validation)
  const written = store.put({
    ...existing,
    authority: to,
    validation: nextValidation,
    kind: existing.kind === KINDS.OBSERVATION ? KINDS.MEMORY : existing.kind,
    relations: [
      ...(existing.relations || []),
      { type: RELATIONS.UPDATES, targetId: existing.id },
    ],
  }, { explicitCanonical: explicit && to === AUTHORITIES.CANONICAL })
  return { ok: true, record: written.record }
}

function unique(arr) {
  return [...new Set(arr.filter(Boolean))]
}


