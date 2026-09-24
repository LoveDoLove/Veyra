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

function mergeEvidence(existing, incoming) {
  const seen = new Set()
  const out = []
  for (const item of [...(existing || []), ...(incoming || [])]) {
    if (!item) continue
    const key = typeof item === 'string'
      ? item
      : `${item.path || ''}:${item.note || ''}:${item.uri || ''}:${item.anchor || ''}`
    if (!key || seen.has(key)) continue
    seen.add(key)
    out.push(item)
  }
  return out.slice(0, 32)
}

/**
 * Strengthen an existing derived memory with repeated evidence.
 *
 * Safe evolution:
 *   repeated evidence → stronger validation → promotion candidate → explicit authority decision
 *
 * Never auto-promotes to canonical authority (core boundary preserved).
 */
export function strengthenMemory(neighbor, candidate, { workspace = null } = {}) {
  if (!neighbor || !candidate) return neighbor
  if (neighbor.authority === AUTHORITIES.CANONICAL) return neighbor

  const mergedEvidence = mergeEvidence(neighbor.evidence, candidate.evidence)
  const obsCount = (Number(neighbor.source?.observations) || 1) + 1

  const hasTestEvidence = mergedEvidence.some((e) => {
    const text = typeof e === 'string' ? e : `${e?.path || ''} ${e?.note || ''}`
    return /test-passed|tests-touched|test|spec/i.test(text) && !/test-failed/i.test(text)
  })

  // Validation tier progression:
  // 1 observation: UNVERIFIED (baseline)
  // 2+ observations or passing test evidence: REVIEWED
  // 3+ observations with test evidence: VERIFIED
  let validation = neighbor.validation
  if (obsCount >= 3 && hasTestEvidence) {
    validation = VALIDATIONS.VERIFIED
  } else if (obsCount >= 2 || hasTestEvidence) {
    if (validation === VALIDATIONS.UNVERIFIED || validation === VALIDATIONS.STALE) {
      validation = VALIDATIONS.REVIEWED
    }
  }

  // Confidence progression:
  let confidence = neighbor.confidence
  if (validation === VALIDATIONS.VERIFIED) {
    confidence = CONFIDENCES.HIGH
  } else if (validation === VALIDATIONS.REVIEWED && confidence === CONFIDENCES.LOW) {
    confidence = CONFIDENCES.MEDIUM
  }

  // Promotion candidate tagging:
  const tags = [...(neighbor.tags || [])]
  if (validation === VALIDATIONS.VERIFIED && !tags.includes('promotion-candidate')) {
    tags.push('promotion-candidate')
  }

  const existingCausal = neighbor.source?.causal
  const candidateCausal = candidate.source?.causal
  let mergedCausal = existingCausal || null
  if (existingCausal || candidateCausal) {
    mergedCausal = {
      symptom: existingCausal?.symptom || candidateCausal?.symptom || null,
      rootCause: existingCausal?.rootCause || candidateCausal?.rootCause || null,
      remedy: existingCausal?.remedy || candidateCausal?.remedy || null,
      verifiedOutcome: candidateCausal?.verifiedOutcome || existingCausal?.verifiedOutcome || null,
    }
  }

  return {
    ...neighbor,
    evidence: mergedEvidence,
    validation,
    confidence,
    tags: unique(tags),
    source: {
      ...(neighbor.source || {}),
      observations: obsCount,
      lastConfirmedAt: new Date().toISOString(),
      lastConfirmedBy: candidate.id || null,
      ...(mergedCausal ? { causal: mergedCausal } : {}),
    },
  }
}

/**
 * After a turn, consider promoting a fresh candidate into derived memory
 * when it looks durable, is grounded, and is not a verbatim duplicate of
 * existing knowledge. If it confirms an existing derived memory, strengthen
 * that memory's validation and evidence.
 *
 * Returns the written derived record, or null when nothing new was learned.
 */
export function maybeLearn(store, candidate, { related = [], workspace = null } = {}) {
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
  // learning. Strengthen the existing neighbor with accumulated evidence and
  // observations, while keeping the candidate inspectable.
  if (evolved.action === 'duplicate' && evolved.neighbor) {
    if (candidate.id) {
      store.put({
        ...candidate,
        relations: evolved.record.relations,
      })
    }
    if (evolved.neighbor.authority === AUTHORITIES.DERIVED) {
      const strengthened = strengthenMemory(evolved.neighbor, candidate, { workspace })
      store.put(strengthened)
    }
    return null
  }

  // Update the candidate in place when it already has an id. A new put
  // with the same title/body would collide on content_hash and return
  // the original candidate, so learning would never become recallable.
  const hasPassedTest = (candidate.evidence || []).some((e) => /test-passed/i.test(e?.note || ''))
  const initialValidation = hasPassedTest ? VALIDATIONS.REVIEWED : VALIDATIONS.UNVERIFIED
  const initialConfidence = hasPassedTest ? CONFIDENCES.MEDIUM : (hasGrounding(candidate) ? CONFIDENCES.MEDIUM : CONFIDENCES.LOW)

  const written = store.put({
    id: candidate.id,
    kind: KINDS.MEMORY,
    status: STATUSES.CURRENT,
    validation: initialValidation,
    authority: AUTHORITIES.DERIVED,
    confidence: initialConfidence,
    scope: candidate.scope,
    projectId: candidate.projectId,
    title: candidate.title,
    body: String(candidate.body || '').slice(0, MAX_MEMORY_BODY_CHARS),
    tags: unique([...(candidate.tags || []), 'learned', candidate.source?.signal].filter(Boolean)),
    evidence: candidate.evidence || [],
    relations: evolved.record.relations,
    source: {
      ...(candidate.source || {}),
      observations: 1,
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


