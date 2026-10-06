/**
 * Veyra — §21 Memory Health: the automated maintenance findings surface.
 *
 * Memory Health answers "what is wrong with memory right now?" without a
 * human reading the database: the nine §21 quality categories, and the six
 * §21 findings (new contradictions, stale knowledge, unresolved
 * investigations, repeated failures, unverified high-value candidates,
 * memories requiring revalidation).
 *
 * Hard rules:
 *   - Read-only. memoryHealth() never mutates a record, never re-classifies
 *     authority, never resolves a contradiction. Findings are evidence, not
 *     instructions (§24: Memory → Evidence → Validation → context, never
 *     Memory → Execute).
 *   - Candidate ≠ Truth: an "unverified high-value candidate" is a review
 *     suggestion, never an auto-promotion.
 *   - Contradictions stay visible: they are listed, never merged away.
 *   - "Protected" (§23) maps to CANONICAL standing plus an explicit
 *     `source.protection` mark (see lifecycle.protectionOf) — standing the
 *     automatic maintenance sweeps (markStale / sweepStale) skip and the
 *     write gate never writes on its own. Protection is not a shield:
 *     protected records still appear in findings when their evidence rots,
 *     because repository truth outranks protection.
 */
import { detectContradictions, verifyEvidenceHealth } from './evolve.mjs'
import { feedbackStats } from './feedback.mjs'
import { hasGrounding } from './learn.mjs'
import { protectionOf } from './lifecycle.mjs'
import { AUTHORITIES, CONFIDENCES, KINDS, STATUSES, VALIDATIONS } from './types.mjs'

const FINDING_LIMIT = 100

function finding(record, extra = {}) {
  return { id: record.id, title: record.title, ...extra }
}

/**
 * Build the §21 health report for a set of active records.
 *
 * @param {Array<object>} records  active (non-forgotten) records to scan
 * @param {object} opts
 * @param {string|null} opts.workspace       cwd used to resolve evidence paths
 * @param {number} opts.failureThreshold     failures required for a repeated-
 *                                           failure finding (clamped 2–50)
 * @returns report — see return literal. Pure: no I/O, no mutation.
 */
export function memoryHealth(records, { workspace = null, failureThreshold = 2 } = {}) {
  const rawList = Array.isArray(records)
    ? records
    : (typeof records?.list === 'function' ? records.list() : [])
  const list = rawList.filter((r) => r && !r.forgotten)
  const threshold = Math.max(2, Math.min(50, Number(failureThreshold) || 2))

  // --- §21 categories: signal buckets (validation dimension × kind dimension
  // --- × relation dimension — they intentionally overlap, no partition).
  const categories = {
    verified: 0,
    reviewed: 0,
    unverified: 0,
    stale: 0,
    invalid: 0,
    contradicted: 0,
    unresolved: 0,
    negative: 0,
    protected: 0,
  }

  const { pairs, contradictingIds } = detectContradictions(list)

  for (const record of list) {
    if (record.validation === VALIDATIONS.VERIFIED) categories.verified += 1
    else if (record.validation === VALIDATIONS.REVIEWED) categories.reviewed += 1
    else if (record.validation === VALIDATIONS.UNVERIFIED) categories.unverified += 1
    else if (record.validation === VALIDATIONS.STALE) categories.stale += 1
    else if (record.validation === VALIDATIONS.INVALID) categories.invalid += 1
    if (contradictingIds.has(record.id) && record.status !== STATUSES.SUPERSEDED) categories.contradicted += 1
    if (record.kind === KINDS.UNRESOLVED) categories.unresolved += 1
    if (record.kind === KINDS.NEGATIVE) categories.negative += 1
    if (protectionOf(record).protected) categories.protected += 1
  }

  // --- §21 findings: the quality problems maintenance must react to
  // (six quality issues + §25 corrupted records).
  const contradictions = pairs.slice(0, FINDING_LIMIT).map((pair) => ({
    idA: pair.a,
    idB: pair.b,
    titleA: pair.titleA,
    titleB: pair.titleB,
    banner: pair.banner,
  }))

  const staleKnowledge = []
  const unresolvedInvestigations = []
  const repeatedFailures = []
  const unverifiedHighValueCandidates = []
  const revalidationCandidates = []
  const corruptedRecords = []

  for (const record of list) {
    // §25 — corrupted rows surface in health; they are recall-ineligible
    // (types.mjs gate) and need explicit repair, never silent healing.
    if (corruptedRecords.length < FINDING_LIMIT && Array.isArray(record.corrupt) && record.corrupt.length) {
      corruptedRecords.push(finding(record, { fields: record.corrupt.slice(0, 10) }))
    }
    if (staleKnowledge.length < FINDING_LIMIT && record.validation === VALIDATIONS.STALE) {
      staleKnowledge.push(finding(record, { validation: record.validation }))
    }
    if (unresolvedInvestigations.length < FINDING_LIMIT && record.kind === KINDS.UNRESOLVED) {
      unresolvedInvestigations.push(finding(record))
    }
    if (repeatedFailures.length < FINDING_LIMIT) {
      const stats = feedbackStats(record)
      if (stats.failures >= threshold) {
        repeatedFailures.push(finding(record, {
          failures: stats.failures,
          attempts: stats.attempts,
          reliability: stats.reliability,
          lastOutcome: stats.lastOutcome,
        }))
      }
    }
    if (unverifiedHighValueCandidates.length < FINDING_LIMIT) {
      const highValue = record.authority === AUTHORITIES.CANDIDATE
        && record.validation === VALIDATIONS.UNVERIFIED
        && (record.confidence === CONFIDENCES.HIGH || hasGrounding(record))
      if (highValue) {
        unverifiedHighValueCandidates.push(finding(record, {
          confidence: record.confidence,
          grounded: hasGrounding(record),
        }))
      }
    }
    if (revalidationCandidates.length < FINDING_LIMIT) {
      const trusted = record.validation === VALIDATIONS.VERIFIED
        || record.validation === VALIDATIONS.REVIEWED
        || record.authority === AUTHORITIES.CANONICAL
      if (trusted && record.status !== STATUSES.SUPERSEDED) {
        // Per-record provenance workspace wins: reusable records carry their
        // own repository, and resolving their evidence against this cwd
        // would fabricate "missing" verdicts (same trap as join(ws, abs)).
        const ws = record.source?.provenance?.workspace || workspace
        const health = verifyEvidenceHealth(record, ws)
        if (health.status === 'broken' || health.status === 'partial') {
          revalidationCandidates.push(finding(record, {
            validation: record.validation,
            authority: record.authority,
            evidenceStatus: health.status,
            missingPaths: health.missingPaths.slice(0, 10),
          }))
        }
      }
    }
  }

  const findings = {
    contradictions,
    staleKnowledge,
    unresolvedInvestigations,
    repeatedFailures,
    unverifiedHighValueCandidates,
    revalidationCandidates,
    corruptedRecords,
  }
  const counts = Object.fromEntries(
    Object.entries(findings).map(([name, entries]) => [name, entries.length]),
  )
  const totalFindings = Object.values(counts).reduce((sum, n) => sum + n, 0)

  return { scanned: list.length, threshold, categories, findings, counts, totalFindings }
}

/**
 * Render a health report as plain text (shared by the /veyra health command
 * and the veyra_health tool). Always observational: it names problems and
 * points at ids; it never proposes automatic authority changes.
 */
export function renderHealth(report) {
  const lines = [`Memory health (§21): ${report.scanned} active record(s) scanned.`]
  const cat = report.categories
  lines.push(
    'Categories: '
    + `${cat.verified} verified, ${cat.reviewed} reviewed, ${cat.unverified} unverified, `
    + `${cat.stale} stale, ${cat.invalid} invalid, ${cat.contradicted} contradicted, `
    + `${cat.unresolved} unresolved, ${cat.negative} negative, ${cat.protected} protected`,
  )
  lines.push(
    `Findings: ${report.counts.contradictions} contradictions, `
    + `${report.counts.staleKnowledge} stale knowledge, `
    + `${report.counts.unresolvedInvestigations} unresolved investigations, `
    + `${report.counts.repeatedFailures} repeated failures (threshold ${report.threshold}), `
    + `${report.counts.unverifiedHighValueCandidates} unverified high-value candidates, `
    + `${report.counts.revalidationCandidates} revalidation candidates, `
    + `${report.counts.corruptedRecords ?? 0} corrupted records`,
  )

  const section = (title, entries, line) => {
    if (entries.length === 0) return
    lines.push('', `${title}:`)
    for (const entry of entries.slice(0, 20)) lines.push(`  ${line(entry)}`)
    if (entries.length > 20) lines.push(`  … ${entries.length - 20} more`)
  }

  section('New contradictions', report.findings.contradictions,
    (p) => `'${p.titleA}' ↔ '${p.titleB}' — verify against the repository`)
  section('Stale knowledge', report.findings.staleKnowledge,
    (f) => `${f.id} ${f.title}`)
  section('Unresolved investigations', report.findings.unresolvedInvestigations,
    (f) => `${f.id} ${f.title}`)
  section('Repeated failures', report.findings.repeatedFailures,
    (f) => `${f.id} ${f.title} — ${f.failures} failures / ${f.attempts} attempts`)
  section('Unverified high-value candidates', report.findings.unverifiedHighValueCandidates,
    (f) => `${f.id} ${f.title} — confidence ${f.confidence}, grounded ${f.grounded}`)
  section('Memories requiring revalidation', report.findings.revalidationCandidates,
    (f) => `${f.id} ${f.title} — evidence ${f.evidenceStatus} (${f.missingPaths.length} missing)`)
  section('Corrupted records', report.findings.corruptedRecords ?? [],
    (f) => `${f.id} ${f.title} — invalid: ${f.fields.join(', ')} (repair via veyra_remember repair: true)`)

  if (report.totalFindings === 0) {
    lines.push('', 'No memory-quality problems found in the scanned window.')
  }
  lines.push(
    '',
    'Findings are evidence for review, not instructions: fix or re-validate explicitly '
    + '(Candidate ≠ Truth; contradictions stay visible until resolved against the repository).',
  )
  return lines.join('\n')
}
