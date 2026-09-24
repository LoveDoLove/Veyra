/**
 * Veyra — evidence-aware learning.
 *
 * Repeated observations, successful solutions, and explicit remember
 * calls can become derived knowledge. Learning never manufactures
 * canonical authority (GOAL.md: Automatic behavior must not silently
 * create authoritative truth).
 *
 * Adapted in spirit from PMA knowledge-compounding and supermemory
 * `updates` / `extends` / `derives` relations.
 */

import { AUTHORITIES, CONFIDENCES, KINDS, MAX_MEMORY_BODY_CHARS, RELATIONS, STATUSES, VALIDATIONS } from './types.mjs'
import { contentHash } from './ids.mjs'
import { isRecallEligible } from './types.mjs'

const LEARN_HINTS = [
  /\b(decided|decision|always|never|must|should not|root cause|workaround|fix was|the cause|lesson)\b/i,
  /\b(architecture|constraint|regression|race|deadlock|migration)\b/i,
]

export function looksDurable(text) {
  if (typeof text !== 'string' || text.length < 60) return false
  return LEARN_HINTS.some((re) => re.test(text))
}

/**
 * After a turn, consider promoting a fresh candidate into derived memory
 * when it looks durable and is not a duplicate of existing knowledge.
 *
 * Returns the written derived record, or null when nothing was learned.
 */
export function maybeLearn(store, candidate, { related = [] } = {}) {
  if (!store || !candidate) return null
  if (candidate.authority === AUTHORITIES.CANONICAL) return null
  if (!looksDurable(`${candidate.title}\n${candidate.body}`)) return null

  const hash = contentHash(candidate.title, candidate.body)
  const existing = store.list({ limit: 40 }).filter((r) => !r.forgotten)
  if (existing.some((r) => r.contentHash === hash && r.authority !== AUTHORITIES.CANDIDATE)) {
    return null
  }

  // If a similar derived/canonical memory exists, link rather than clone.
  const neighbor = existing.find((r) => (
    isRecallEligible(r)
    && sharesTokens(r.title, candidate.title)
  ))

  const relations = []
  if (neighbor) {
    relations.push({ type: RELATIONS.EXTENDS, targetId: neighbor.id })
  }
  for (const other of related) {
    if (other?.id) relations.push({ type: RELATIONS.DERIVES, targetId: other.id })
  }

  const written = store.put({
    kind: KINDS.MEMORY,
    status: STATUSES.CURRENT,
    validation: VALIDATIONS.UNVERIFIED,
    authority: AUTHORITIES.DERIVED,
    confidence: CONFIDENCES.LOW,
    scope: candidate.scope,
    projectId: candidate.projectId,
    title: candidate.title,
    body: String(candidate.body || '').slice(0, MAX_MEMORY_BODY_CHARS),
    tags: unique([...(candidate.tags || []), 'learned']),
    evidence: candidate.evidence || [],
    relations,
    source: { ...(candidate.source || {}), learnedFrom: candidate.id || null },
  })
  return written.record
}

/**
 * Explicit remember path. Agents / users call this to keep durable
 * knowledge. Still refuses canonical unless `explicitCanonical` is set
 * (only `veyra_promote` does that).
 */
export function remember(store, input, { explicitCanonical = false } = {}) {
  const kind = input.kind === KINDS.KNOWLEDGE || input.kind === KINDS.EVIDENCE
    ? input.kind
    : KINDS.MEMORY
  return store.put({
    ...input,
    kind,
    authority: explicitCanonical ? AUTHORITIES.CANONICAL : (input.authority === AUTHORITIES.CANONICAL ? AUTHORITIES.DERIVED : (input.authority || AUTHORITIES.DERIVED)),
    validation: input.validation || VALIDATIONS.UNVERIFIED,
    confidence: input.confidence || CONFIDENCES.MEDIUM,
    status: input.status || STATUSES.CURRENT,
  }, { explicitCanonical })
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

function sharesTokens(a, b) {
  const ta = new Set(String(a || '').toLowerCase().match(/[a-z0-9_]{4,}/g) || [])
  const tb = String(b || '').toLowerCase().match(/[a-z0-9_]{4,}/g) || []
  if (ta.size === 0 || tb.length === 0) return false
  let hits = 0
  for (const t of tb) if (ta.has(t)) hits++
  return hits >= 2
}
