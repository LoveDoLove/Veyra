/**
 * Veyra — Phase 6, GOAL.md §19/§20: outcome feedback loop and recurrence
 * detection.
 *
 * §19 — Retrieve → Apply → Verify → Success/Failure → Feedback → Update Memory.
 * Application is the agent's own work (memory is evidence, never instructions),
 * so the outcome arrives explicitly through `veyra_feedback`:
 *
 *   success → strengthenMemory(): the observation ladder runs (obs count,
 *             validation progression, confidence progression,
 *             promotion-candidate tagging). A successful verified outcome
 *             strengthens useful engineering knowledge.
 *   failure → failure history is recorded (`source.feedback.history`) and
 *             reliability decreases: validation demotes one step
 *             (verified → reviewed → unverified) and confidence demotes one
 *             step (high → medium → low). Canonical records are user-blessed
 *             project truth: for them only the history is recorded — an
 *             agent-reported failure never silently demotes canonical
 *             validation/confidence.
 *
 * The failure NEVER rewrites `causal.verifiedOutcome`: that field documents a
 * historical verified outcome, and the new failure must stay visible as a
 * separate incident (no silent merge; contradictions remain visible).
 *
 * §20 — Recurrence detection: the same root cause / symptom / failed approach /
 * remedy recurring across records, or one record whose application repeatedly
 * failed. A remedy-consistent root-cause cluster can become "a candidate for
 * stronger engineering knowledge" — but only through the existing write gate
 * (Candidate/Authority rules preserved; canonical stays unreachable).
 */

import { AUTHORITIES, CONFIDENCES, KINDS, VALIDATIONS } from './types.mjs'
import { strengthenMemory, writeGate } from './learn.mjs'

const VALID_OUTCOMES = new Set(['success', 'failure'])
const HISTORY_LIMIT = 10

// One-step demotion ladders. STALE/INVALID/UNVERIFIED are already at or below
// the floor; INVALID records are not demoted further.
const VALIDATION_DOWN = Object.freeze({
  [VALIDATIONS.VERIFIED]: VALIDATIONS.REVIEWED,
  [VALIDATIONS.REVIEWED]: VALIDATIONS.UNVERIFIED,
})
const CONFIDENCE_RANK = Object.freeze([CONFIDENCES.LOW, CONFIDENCES.MEDIUM, CONFIDENCES.HIGH])

/**
 * Feedback statistics for a record: attempts, successes/failures and the
 * derived reliability ratio. `reliability` is null before any outcome.
 */
export function feedbackStats(record) {
  const fb = record?.source?.feedback
  const successes = Number(fb?.successes) || 0
  const failures = Number(fb?.failures) || 0
  const attempts = successes + failures
  return {
    successes,
    failures,
    attempts,
    reliability: attempts ? Number((successes / attempts).toFixed(3)) : null,
    lastOutcome: fb?.lastOutcome ?? null,
    lastOutcomeAt: fb?.lastOutcomeAt ?? null,
  }
}

/**
 * §19 — record the outcome of applying a record and update the memory.
 *
 * Returns `{ ok: true, record, feedback }` or `{ ok: false, error }`.
 */
export function recordFeedback(store, { id, outcome, note = null, now = Date.now() } = {}) {
  if (!store) return { ok: false, error: 'no store' }
  if (!id) return { ok: false, error: 'id required' }
  if (!VALID_OUTCOMES.has(outcome)) return { ok: false, error: 'outcome must be success or failure' }

  const rec = store.get(id)
  if (!rec) return { ok: false, error: 'record not found' }
  if (rec.forgotten) return { ok: false, error: 'record is forgotten' }

  const at = new Date(now).toISOString()
  const prev = rec.source?.feedback || {}
  const entry = { outcome, at, ...(note ? { note: String(note).slice(0, 400) } : {}) }
  const feedback = {
    successes: (Number(prev.successes) || 0) + (outcome === 'success' ? 1 : 0),
    failures: (Number(prev.failures) || 0) + (outcome === 'failure' ? 1 : 0),
    lastOutcome: outcome,
    lastOutcomeAt: at,
    history: [...(Array.isArray(prev.history) ? prev.history : []), entry].slice(-HISTORY_LIMIT),
  }

  let next
  if (outcome === 'success') {
    // strengthenMemory early-returns for canonical records, runs the
    // observation ladder for the rest, and never touches authority.
    next = strengthenMemory(rec, { id: 'veyra_feedback:success', evidence: [], source: {} }, {})
  } else {
    const demoteValidation = !VALIDATION_DOWN[rec.validation]
      ? rec.validation
      : VALIDATION_DOWN[rec.validation]
    const rank = CONFIDENCE_RANK.indexOf(rec.confidence)
    const demotedConfidence = rec.authority === AUTHORITIES.CANONICAL
      ? rec.confidence
      : (rank > 0 ? CONFIDENCE_RANK[rank - 1] : rec.confidence)
    next = {
      ...rec,
      validation: rec.authority === AUTHORITIES.CANONICAL ? rec.validation : demoteValidation,
      confidence: demotedConfidence,
    }
  }

  next = {
    ...next,
    source: { ...(next.source || {}), feedback },
  }

  // Authority never changes here — passing explicitCanonical for a record that
  // is ALREADY canonical only acknowledges its standing so store.put() lets the
  // history write through (it throws for any canonical payload without the
  // flag). It is not a promotion: no record can gain canonical here.
  const { record } = store.put(next, { explicitCanonical: next.authority === AUTHORITIES.CANONICAL })
  return {
    ok: true,
    record,
    feedback: feedbackStats(record),
    previous: { validation: rec.validation, confidence: rec.confidence },
  }
}

// ---------------------------------------------------------------- recurrence

function norm(value) {
  if (typeof value !== 'string') return null
  const text = value.toLowerCase().replace(/\s+/g, ' ').trim().replace(/[.;:,\s]+$/, '')
  return text ? text.slice(0, 240) : null
}

function pushGroup(groups, kind, key, record) {
  if (!key) return
  const groupKey = `${kind}\u0000${key}`
  let group = groups.get(groupKey)
  if (!group) {
    group = { kind, key, recordIds: [], remedies: new Set(), verified: false }
    groups.set(groupKey, group)
  }
  if (!group.recordIds.includes(record.id)) group.recordIds.push(record.id)
  const remedy = norm(record.source?.causal?.remedy)
  if (remedy) group.remedies.add(remedy)
  if (record.source?.causal?.verifiedOutcome) group.verified = true
}

/**
 * §20 — cluster records into recurring-engineering-problem findings.
 *
 * Patterns (per GOAL §20):
 *   root-cause        records sharing the same normalized root cause
 *   symptom           records without a root cause sharing the same symptom
 *   failed-approach   negative records (known failed approaches) sharing a title
 *   recurring-remedy  records sharing the same remedy (independent of cause)
 *   recurring-failure one record whose applications failed ≥ threshold times
 *
 * A finding is only returned at `count >= threshold` (default 3, clamped
 * to [2, 50]). Pure function: no store access, no writes.
 */
export function detectRecurrence(records, { threshold = 3 } = {}) {
  const limit = Math.max(2, Math.min(50, Number(threshold) || 3))
  const groups = new Map()

  for (const rec of records || []) {
    if (!rec || !rec.id || rec.forgotten) continue
    const causal = rec.source?.causal
    const rootCause = norm(causal?.rootCause)
    const symptom = norm(causal?.symptom)
    if (rootCause) pushGroup(groups, 'root-cause', rootCause, rec)
    else if (symptom) pushGroup(groups, 'symptom', symptom, rec)

    // §20 "recurring regression": records explicitly tagged `regression`,
    // clustered by their root cause (or symptom when no cause is recorded).
    const regression = Array.isArray(rec.tags)
      && rec.tags.some((t) => String(t).toLowerCase() === 'regression')
    if (regression) pushGroup(groups, 'recurring-regression', rootCause || symptom, rec)

    const remedy = norm(causal?.remedy)
    if (remedy) pushGroup(groups, 'recurring-remedy', remedy, rec)

    if (rec.kind === KINDS.NEGATIVE) {
      pushGroup(groups, 'failed-approach', norm(`${rec.title}`), rec)
    }

    const failures = Number(rec.source?.feedback?.failures) || 0
    if (failures >= limit) {
      const groupKey = `recurring-failure\u0000${rec.id}`
      let group = groups.get(groupKey)
      if (!group) {
        group = { kind: 'recurring-failure', key: rec.id, recordIds: [], remedies: new Set(), verified: false }
        groups.set(groupKey, group)
      }
      group.recordIds.push(rec.id)
      group.failureCount = failures
    }
  }

  const findings = []
  const CAUSAL_KINDS = new Set(['root-cause', 'symptom', 'recurring-regression'])
  for (const group of groups.values()) {
    // recurring-failure clusters a single record by its own outcome count;
    // every other pattern clusters distinct records.
    const count = group.failureCount ?? group.recordIds.length
    if (count < limit) continue
    const remedies = [...group.remedies]
    const causalKind = CAUSAL_KINDS.has(group.kind)
    findings.push({
      kind: group.kind,
      key: group.key,
      count,
      recordIds: [...group.recordIds],
      remedies,
      remedyConsistent: causalKind ? remedies.length === 1 : undefined,
      verifiedRemedy: causalKind ? group.verified : undefined,
      ...(group.failureCount ? { failureCount: group.failureCount } : {}),
    })
  }

  findings.sort((a, b) => b.count - a.count || a.kind.localeCompare(b.kind) || a.key.localeCompare(b.key))
  return findings
}

/**
 * §20 — "candidate for stronger engineering knowledge": justified only for a
 * causal cluster (root cause or recurring regression) whose incidents share
 * ONE remedy and where at least one incident carries a verified outcome
 * (same root cause → same verified remedy). Everything else is reported as a
 * finding, never written.
 */
export function eligibleForCandidate(finding) {
  return Boolean(
    finding
    && (finding.kind === 'root-cause' || finding.kind === 'recurring-regression')
    && finding.count >= 2
    && finding.remedyConsistent
    && finding.verifiedRemedy
    && Array.isArray(finding.remedies)
    && finding.remedies.length === 1,
  )
}

function truncate(value, max) {
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`
}

/**
 * Turn an eligible finding into a write-gate candidate. The candidate is
 * DELIBERATE (`source.automatic === false` — an explicit `veyra_recurrence`
 * action), so it passes the M9 provenance gate like any tool-created record;
 * writeGate decides ACCEPT/MERGE/DROP/DEFER and canonical stays unreachable.
 * DERIVES edges to every member record are seeded as relations.
 *
 * Returns the writeGate result.
 */
export function recurrenceCandidate(store, finding, memberRecords = [], { workspace = null } = {}) {
  if (!store || !eligibleForCandidate(finding)) {
    return { decision: 'DEFER', reason: 'not-eligible', record: null, neighbor: null }
  }
  const members = memberRecords.filter((r) => r && r.id)
  const remedy = finding.remedies[0]
  const label = finding.kind === 'recurring-regression' ? 'Recurring regression' : 'Recurring root cause'
  const title = `${label} (${finding.count} records): ${truncate(finding.key, 140)}`
  const body = `The same root cause has recurred across ${finding.count} engineering memories: `
    + `"${finding.key}". All ${finding.count} incidents share one remedy: "${remedy}". `
    + `Repeated verified recurrence justifies treating this remedy as stronger engineering knowledge: `
    + `apply it as evidence, verify it against repository truth, and keep the incident history visible.`
  const candidate = {
    kind: KINDS.MEMORY,
    scope: members[0]?.scope,
    projectId: members[0]?.projectId,
    title,
    body,
    evidence: [
      { note: `recurrence: ${finding.count} records share one root cause; remedy consistent` },
    ],
    source: {
      automatic: false,
      recurrence: {
        kind: finding.kind,
        count: finding.count,
        members: [...finding.recordIds],
        remedyConsistent: true,
      },
    },
  }
  return writeGate(store, candidate, { related: members, workspace })
}
