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
  PROVENANCE_ORIGINS,
  RELATIONS,
  STATUSES,
  VALIDATIONS,
  isRecallEligible,
  provenanceOrigins,
} from './types.mjs'
import { contentHash } from './ids.mjs'
import { looksLikeClaim } from './understand.mjs'
import { evolveAgainst } from './evolve.mjs'
import { addRejected, addUnresolved } from './negative.mjs'

export function looksDurable(text) {
  return looksLikeClaim(text) && typeof text === 'string' && text.length >= 60
}

/**
 * Write-gate verdicts (GOAL.md Phase 1). Every learning decision is one of
 * these four, and every one carries a human-readable reason so Veyra can
 * explain why an observation was accepted, merged, rejected, or deferred.
 *
 *   ACCEPT — new derived knowledge was written.
 *   MERGE  — near-duplicate of existing derived knowledge; the neighbor was
 *            strengthened instead of writing a second record.
 *   DROP   — rejected: noise, verbatim duplicate, or nothing to learn.
 *   DEFER  — not rejected, not accepted now: the record stays exactly as
 *            captured and may become learnable later (provenance-gated
 *            automatic records, canonical records that need an explicit
 *            user promotion).
 */
export const WRITE_GATES = Object.freeze({
  ACCEPT: 'ACCEPT',
  MERGE: 'MERGE',
  DROP: 'DROP',
  DEFER: 'DEFER',
})

export function hasGrounding(candidate) {
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

  // Test evidence is the CLOSED vocabulary emitted by `understand.mjs`:
  //   test-passed | test-failed | tests-touched
  // Matching the whole word "test" (or "spec") here is a false-positive
  // generator: an unanchored `test|spec` also matches ordinary prose such as
  // "inspector", "protest" and "aspect", which would let a claim that never ran
  // a test reach `verified` / `promotion-candidate` — the exact state a human
  // trusts when deciding a canonical promotion. Anchoring to the enum removes
  // the forgery without narrowing any genuine signal.
  const hasTestEvidence = mergedEvidence.some((e) => {
    const text = typeof e === 'string' ? e : `${e?.path || ''} ${e?.note || ''}`
    return /(^|[^a-z0-9-])(test-passed|tests-touched)([^a-z0-9-]|$)/i.test(text)
      && !/(^|[^a-z0-9-])test-failed([^a-z0-9-]|$)/i.test(text)
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
 * M9 — provenance gate for the automatic learning path.
 *
 * Answers only "May this automatically enter the learning pipeline?" —
 * never "Is this fact true?" (provenance ≠ semantic truth, provenance ≠
 * claim classification, similarity ≠ authority, classification ≠
 * lifecycle action).
 *
 * Deliberate records (`source.automatic === false`, written by the explicit
 * `veyra_remember` tool) are never gated here. Every other record reaching
 * the automatic learning path must prove assistant-only provenance, failing
 * closed on anything unknown:
 *
 *   allowed  origins ["assistant"], ["assistant", "tool"]
 *   blocked  anything containing "user", ["tool"] alone, provenance absent,
 *            provenance malformed, origins === [], unknown origin value
 *
 * A blocked record is only not learned: it stays exactly as captured — no
 * deletion, no invalidation, no new status, no provenance rewrite, no
 * lifecycle effect.
 */
export function provenanceAllowsLearning(record) {
  const source = record?.source
  if (source && source.automatic === false) return true
  const origins = provenanceOrigins(source)
  if (!Array.isArray(origins)) return false
  if (!origins.every((o) => PROVENANCE_ORIGINS.includes(o))) return false
  return origins.includes('assistant') && !origins.includes('user')
}

/**
 * The shared learning guard chain.
 *
 * Returns null when the record must not become derived knowledge, otherwise
 * the record to evolve plus the peers it was compared against.
 *
 * This is the ONLY place a candidate is allowed to reach `derived`, for both
 * the per-turn path (`maybeLearn`) and the maintenance re-review
 * (`reviewCandidate`). It is deliberately unchanged and deliberately strict:
 *
 *   - `looksLikeClaim` is load-bearing. Test evidence is NOT sufficient on its
 *     own: `evidenceFrom` attaches `test-passed` / `tests-touched` to whatever
 *     tool activity a turn contained, including harness and conversational
 *     traffic, so those notes appear on candidates that are not claims.
 *   - provenance (M9) is the first real guard: unless the record is
 *     deliberate (`source.automatic === false`), `provenanceAllowsLearning`
 *     must pass first. Automatic records with unknown provenance fail closed
 *     and never reach evolveAgainst.
 *   - observation count, age, retrieval count, similarity, confidence and
 *     frequency are never consulted here.
 *
 * Returns `{ hash, existing }` on pass, or `{ blocked: { decision, reason } }`.
 */
function learningGuards(store, candidate, { limit = 60 } = {}) {
  if (!store || !candidate) return { blocked: { decision: WRITE_GATES.DROP, reason: 'no-record' } }
  if (!provenanceAllowsLearning(candidate)) {
    return { blocked: { decision: WRITE_GATES.DEFER, reason: 'provenance-gated' } }
  }
  if (candidate.authority === AUTHORITIES.CANONICAL) {
    return { blocked: { decision: WRITE_GATES.DEFER, reason: 'canonical-requires-explicit-promotion' } }
  }
  if (!looksDurable(`${candidate.title}\n${candidate.body}`)) {
    return { blocked: { decision: WRITE_GATES.DROP, reason: 'not-durable' } }
  }

  const hash = contentHash(candidate.title, candidate.body)
  const existing = store.list({ limit }).filter((r) => !r.forgotten)
  return { hash, existing }
}

/**
 * The write gate (GOAL.md Phase 1). Runs the full guard chain and the
 * evolution decision, performs the write, and returns the verdict with a
 * human-readable reason so Veyra can explain every learning decision:
 *
 *   ACCEPT — new derived knowledge was written (`record`).
 *   MERGE  — near-duplicate; the existing derived neighbor was strengthened
 *            (`neighbor`), no second record written.
 *   DROP   — rejected: noise, verbatim duplicate, or nothing to learn.
 *   DEFER  — not rejected, not accepted now: the record stays exactly as
 *            captured and may become learnable later.
 *
 * `maybeLearn` is the compatibility wrapper: it returns the written record or
 * null, exactly as before.
 */
export function writeGate(store, candidate, { related = [], workspace = null } = {}) {
  const guards = learningGuards(store, candidate)
  if (guards.blocked) {
    return { decision: guards.blocked.decision, reason: guards.blocked.reason, record: null, neighbor: null, evolveAction: null }
  }
  const { hash, existing } = guards

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
    return {
      decision: WRITE_GATES.MERGE,
      reason: 'near-duplicate-strengthened',
      record: null,
      neighbor: evolved.neighbor,
      evolveAction: evolved.action,
    }
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
      writeGate: { decision: WRITE_GATES.ACCEPT, reason: 'new-derived-knowledge' },
    },
  })
  return {
    decision: WRITE_GATES.ACCEPT,
    reason: 'new-derived-knowledge',
    record: written.record,
    neighbor: null,
    evolveAction: evolved.action,
  }
}

/**
 * After a turn, consider promoting a fresh candidate into derived memory
 * when it looks durable, is grounded, and is not a verbatim duplicate of
 * existing knowledge. If it confirms an existing derived memory, strengthen
 * that memory's validation and evidence.
 *
 * Returns the written derived record, or null when nothing new was learned.
 * Use `writeGate` when the verdict and its reason are needed.
 */
export function maybeLearn(store, candidate, { related = [], workspace = null } = {}) {
  return writeGate(store, candidate, { related, workspace }).record ?? null
}

/**
 * Explicit remember path. Agents / users call this to keep durable
 * knowledge. Still refuses canonical unless `explicitCanonical` is set
 * (only `veyra_promote` does that). Evolves relations against neighbors
 * without merging them.
 */
export function remember(store, input, { explicitCanonical = false, repair = false } = {}) {
  // GOAL.md Phase 2 / §8 / §9 — negative and unresolved are first-class
  // kinds with idempotent writers. They are never coerced to memory, never
  // carry canonical authority, and skip evolveAgainst: a known failed
  // approach must not supersede positive memory by content match, and an
  // open investigation keeps its identity across rewording.
  if (input?.kind === KINDS.NEGATIVE) {
    return addRejected(store, input.title, input.body, {
      tags: input.tags,
      evidence: input.evidence,
      confidence: input.confidence,
      scope: input.scope,
      projectId: input.projectId,
      source: input.source,
    })
  }
  if (input?.kind === KINDS.UNRESOLVED) {
    return addUnresolved(store, input.title, {
      knownClues: input.body,
      tags: input.tags,
      evidence: input.evidence,
      confidence: input.confidence,
      scope: input.scope,
      projectId: input.projectId,
      source: input.source,
    })
  }
  // GOAL.md Phase 4 §12/§13 — applicability context and temporal validity
  // ride the `source` JSON bag (precedent: source.causal / source.provenance):
  // the row schema is fixed-column and bumping schema_version fails closed
  // on every existing database. The runtime auto-stamps the environment
  // facts it knows for free (§12: os, runtime); agent-supplied keys ride
  // alongside and win on conflict. validFrom/validUntil land canonical
  // camelCase under source.temporal — snake_case stays a read-side alias
  // only (dsh-memory nodefile.py:133-138 discipline).
  // ponytail: negative/unresolved kinds return above without auto-context —
  // their routing is the coverage tail, not applicability scoring.
  if (input?.kind !== KINDS.NEGATIVE && input?.kind !== KINDS.UNRESOLVED) {
    const source = { ...(input.source && typeof input.source === 'object' ? input.source : {}) }
    const validFrom = input.validFrom ?? input.valid_from ?? null
    const validUntil = input.validUntil ?? input.valid_until ?? null
    if (validFrom || validUntil) {
      source.temporal = {
        ...(validFrom ? { validFrom } : {}),
        ...(validUntil ? { validUntil } : {}),
      }
    }
    source.context = {
      os: process.platform,
      runtime: process.version,
      ...(input.context && typeof input.context === 'object' ? input.context : {}),
    }
    input = { ...input, source }
  }
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
  }, { explicitCanonical, repair })
  if (!written.record || written.duplicate) return written

  const existing = store.list({ limit: 60 }).filter((r) => !r.forgotten && r.id !== written.record.id)
  const evolved = evolveAgainst(store, written.record, existing)
  const before = JSON.stringify(written.record.relations || [])
  const after = JSON.stringify(evolved.record.relations || [])
  if (before === after) return written
  const updated = store.put({
    ...written.record,
    relations: evolved.record.relations,
  }, { explicitCanonical, repair })
  return { ...updated, created: written.created, duplicate: written.duplicate }
}

/**
 * Re-review an EXISTING candidate record under the same guard chain the
 * per-turn path uses.
 *
 * This is maintenance, not a second learning rule. It calls `maybeLearn`, so
 * every guard in `learningGuards` applies unchanged: `looksLikeClaim` first,
 * then the verbatim-duplicate check, then `evolveAgainst`. Age, observation
 * count, retrieval count, similarity, confidence and frequency are never
 * consulted, and test evidence alone can never promote — `evidenceFrom`
 * attaches those notes to any turn with test-looking tool activity, including
 * harness traffic.
 *
 * The record is only ever candidate -> derived, or left alone, or confirmed
 * against an existing derived neighbour via the normal strengthening path.
 * Canonical is unreachable: `maybeLearn` returns null for canonical input and
 * never calls `promote`.
 */
export function reviewCandidate(store, record, { workspace = null } = {}) {
  if (!store || !record) return { outcome: 'blocked', reason: 'no record' }
  if (record.authority !== AUTHORITIES.CANDIDATE) {
    return { outcome: 'skipped', reason: 'not a candidate' }
  }
  if (record.forgotten) {
    return { outcome: 'skipped', reason: 'forgotten' }
  }
  if (!looksDurable(`${record.title}\n${record.body}`)) {
    return { outcome: 'blocked', reason: 'not durable' }
  }

  // maybeLearn writes the derived record in place when the candidate has an id.
  const before = store.get(record.id)
  const gate = writeGate(store, record, { workspace })
  const after = store.get(record.id)

  if (after && before && after.authority !== before.authority) {
    return { outcome: 'transitioned', authority: after.authority, decision: gate.decision, reason: gate.reason, record: after }
  }
  if (gate.record) {
    return { outcome: 'transitioned', authority: 'derived', decision: gate.decision, reason: gate.reason, record: gate.record }
  }
  return { outcome: 'unchanged', decision: gate.decision, reason: gate.reason, record: after || record }
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
    // Promotion is a change of standing, not a relationship. It must not
    // invent an `updates` edge — least of all one pointing at the record
    // itself, which is not a fact about any other memory. Existing relations
    // are carried over untouched.
    relations: existing.relations || [],
  }, { explicitCanonical: explicit && to === AUTHORITIES.CANONICAL })
  return { ok: true, record: written.record }
}

function unique(arr) {
  return [...new Set(arr.filter(Boolean))]
}


