/**
 * Veyra — read-only historical audit of `contradicts` edges (Issue #3, Phase C).
 *
 * Before the Phase A classifier fix, ANY replacement wording ("rather than",
 * "instead of", "switched from", …) was enough to classify two records as a
 * conflict, with no similarity floor and no shared-subject check. Those edges
 * were persisted by `linkConflict()` and survive promotion, so old stores may
 * still carry contradictions that were never real.
 *
 * This module only REPORTS. It is a review surface, not a repair tool:
 *
 *   - read-only: it calls `store.list()` / `store.get()` and nothing else. No
 *     UPDATE, no put(), no unlink, no rewrite, no status/validation/authority
 *     change, no timestamp touch. Repair is a separate, explicit user action
 *     (`/veyra unlink <id> contradicts <targetId>`).
 *   - bounded: it inspects at most `MAX_RECORDS` records per store and renders
 *     at most `MAX_FINDINGS` findings; counts stay exact and truncation is
 *     stated in the report.
 *   - honest about uncertainty: every signal below is a REVIEW INDICATOR, not
 *     proof that an edge came from the defect. Veyra does not record relation
 *     provenance (who created an edge, when, by which classifier), so the audit
 *     cannot attribute an existing edge to this bug — it can only say the edge
 *     looks weak on today's evidence. That limitation is printed in the report.
 */

import { RELATIONS } from './types.mjs'
import { MIN_CONFLICT_SIM, claimText, sharesSubject } from './diff.mjs'
import { hasReplacementLanguage, jaccard } from './text.mjs'

/** Records inspected per store (bounded, exact totals still reported). */
export const MAX_RECORDS = 200
/** Findings rendered (bounded; the flagged count stays exact). */
export const MAX_FINDINGS = 50

/**
 * Collect every distinct `contradicts` pair across the given stores.
 *
 * Deduplicates by sorted id pair, because a real contradiction is stored in
 * both directions and would otherwise be counted twice.
 */
function collectEdges(stores) {
  const byId = new Map()
  for (const { store } of stores) {
    if (!store) continue
    for (const record of store.list({ limit: MAX_RECORDS })) byId.set(record.id, record)
  }

  const edges = []
  const seen = new Set()
  for (const record of byId.values()) {
    for (const rel of record.relations || []) {
      if (rel.type !== RELATIONS.CONTRADICTS) continue
      const key = [record.id, rel.targetId].sort().join('::')
      if (seen.has(key)) continue
      seen.add(key)
      const other = byId.get(rel.targetId) || null
      edges.push({ key, a: record, b: other, targetId: rel.targetId })
    }
  }
  return { edges, byId }
}

/**
 * Score one edge. Returns the review indicators and the reasons it was flagged.
 *
 * Signals (each one is a heuristic, never a verdict):
 *   - lowSimilarity      — claim texts are less alike than the conflict floor
 *                          the classifier now requires (MIN_CONFLICT_SIM)
 *   - noSharedSubject    — no stored path/anchor overlap between the two claims
 *   - replacementOnly    — replacement wording is the only apparent link
 *   - danglingTarget     — the opposing record is not in the audited stores
 */
function scoreEdge(edge) {
  const { a, b } = edge
  const reasons = []
  const signals = {
    similarity: 0,
    lowSimilarity: false,
    sharedSubject: false,
    noSharedSubject: false,
    replacementOnly: false,
    replacementLanguage: { a: false, b: false },
    danglingTarget: false,
  }

  signals.replacementLanguage = {
    a: hasReplacementLanguage(claimText(a)),
    b: b ? hasReplacementLanguage(claimText(b)) : false,
  }

  if (!b) {
    signals.danglingTarget = true
    reasons.push('opposing record is not present in the audited stores')
    return { signals, reasons }
  }

  signals.similarity = jaccard(claimText(a), claimText(b))
  signals.lowSimilarity = signals.similarity < MIN_CONFLICT_SIM
  signals.sharedSubject = sharesSubject(a, b)
  signals.noSharedSubject = !signals.sharedSubject

  if (signals.lowSimilarity) {
    reasons.push(
      `claim similarity ${signals.similarity.toFixed(4)} is below the conflict floor ${MIN_CONFLICT_SIM}`,
    )
  }
  if (signals.noSharedSubject) {
    reasons.push('no shared subject anchor (no common evidence path or source file)')
  }
  if (signals.noSharedSubject && (signals.replacementLanguage.a || signals.replacementLanguage.b)) {
    signals.replacementOnly = true
    const which = signals.replacementLanguage.a
      ? (signals.replacementLanguage.b ? 'both records' : 'record A')
      : 'record B'
    reasons.push(`replacement wording in ${which} with no shared subject — the defect's signature`)
  }

  return { signals, reasons }
}

const pct = (n) => `${(n * 100).toFixed(2)}%`

/**
 * Read-only audit of existing `contradicts` edges.
 *
 * @param {{projectStore?: object, reusableStore?: object}} stores
 * @returns {{
 *   ok: true,
 *   data: {
 *     scanned: number, edges: number, flagged: number, truncated: boolean,
 *     findings: Array<object>, limitations: string[],
 *   },
 *   formatted: string,
 * }}
 */
export function auditContradictionEdges({ projectStore = null, reusableStore = null } = {}) {
  const stores = [
    { scope: 'project', store: projectStore },
    ...(reusableStore ? [{ scope: 'reusable', store: reusableStore }] : []),
  ]
  const { edges, byId } = collectEdges(stores)

  const findings = []
  for (const edge of edges) {
    const { signals, reasons } = scoreEdge(edge)
    const flagged = signals.danglingTarget || signals.lowSimilarity || signals.noSharedSubject

    // Canonical endpoint order (ascending id) so a report is byte-identical
    // across runs regardless of which side happened to be listed first.
    const first = edge.b && edge.b.id < edge.a.id
      ? { record: edge.b, other: edge.a }
      : { record: edge.a, other: edge.b }
    const second = first.other

    findings.push({
      flagged,
      pair: [first.record.id, second ? second.id : edge.targetId],
      a: { id: first.record.id, title: first.record.title || first.record.id },
      b: second
        ? { id: second.id, title: second.title || second.id }
        : { id: edge.targetId, title: '(missing)' },
      direction: {
        aToB: (first.record.relations || []).some(
          (r) => r.type === RELATIONS.CONTRADICTS && r.targetId === (second ? second.id : edge.targetId),
        ),
        bToA: second
          ? (second.relations || []).some(
              (r) => r.type === RELATIONS.CONTRADICTS && r.targetId === first.record.id,
            )
          : false,
      },
      signals,
      reasons,
    })
  }

  // Weakest edges first: no similarity, no subject, replacement-only.
  findings.sort((x, y) => {
    const weight = (f) => (f.signals.danglingTarget ? 0 : 1) + (f.signals.replacementOnly ? 1 : 0) + (f.signals.lowSimilarity ? 1 : 0) + (f.signals.noSharedSubject ? 1 : 0)
    return weight(y) - weight(x) || x.signals.similarity - y.signals.similarity
  })

  const flaggedFindings = findings.filter((f) => f.flagged)
  const shown = flaggedFindings.slice(0, MAX_FINDINGS)

  const lines = [
    '════════════════════════════════════════════════════════════════════════',
    ` VEYRA AUDIT — SUSPICIOUS CONTRADICTION EDGES (read-only, nothing changed)`,
    '════════════════════════════════════════════════════════════════════════',
    ` stores audited : ${stores.filter((s) => s.store).map((s) => s.scope).join(', ') || '(none)'}`,
    ` records scanned: ${byId.size} (max ${MAX_RECORDS} per store)`,
    ` edges found    : ${findings.length}`,
    ` flagged        : ${flaggedFindings.length}`,
  ]

  if (findings.length === 0) {
    lines.push('')
    lines.push(' No contradicts edges recorded. Nothing to review.')
  } else if (shown.length === 0) {
    lines.push('')
    lines.push(' No edge showed a weak-evidence signal. Nothing to review.')
  } else {
    for (const [idx, f] of shown.entries()) {
      lines.push('')
      lines.push(`[Review #${idx + 1}] ${f.a.id} <-> ${f.b.id}`)
      lines.push(`  A: [${f.a.id}] "${f.a.title}"`)
      lines.push(`  B: [${f.b.id}] "${f.b.title}"`)
      lines.push(
        `  direction: ${f.direction.aToB ? `${f.a.id} -> ${f.b.id}` : 'A -> B absent'}, `
        + `${f.direction.bToA ? `${f.b.id} -> ${f.a.id}` : 'B -> A absent'}`,
      )
      lines.push(
        `  similarity: ${pct(f.signals.similarity)} (conflict floor ${pct(MIN_CONFLICT_SIM)})`
        + ` · shared subject: ${f.signals.sharedSubject ? 'yes' : 'no'}`,
      )
      for (const reason of f.reasons) lines.push(`  why flagged: ${reason}`)
      lines.push('  action: review only — nothing was unlinked, rewritten, or demoted.')
      lines.push(`          if the edge is false: /veyra unlink ${f.a.id} ${RELATIONS.CONTRADICTS} ${f.b.id}`)
    }
    if (flaggedFindings.length > shown.length) {
      lines.push('')
      lines.push(` … showing ${shown.length} of ${flaggedFindings.length} flagged edges (bounded report).`)
    }
  }

  const limitations = [
    'Relation provenance is not recorded: the audit cannot prove an edge came from the Issue #3 defect.',
    'Similarity and subject anchors are heuristics; a flagged edge may still be a genuine contradiction.',
    'Only the selected project and reusable stores were read; other databases were not touched or opened.',
  ]
  lines.push('')
  lines.push(' Limitations')
  for (const limitation of limitations) lines.push(`  - ${limitation}`)
  lines.push('════════════════════════════════════════════════════════════════════════')

  return {
    ok: true,
    data: {
      scanned: byId.size,
      edges: findings.length,
      flagged: flaggedFindings.length,
      truncated: flaggedFindings.length > shown.length,
      findings,
      limitations,
    },
    formatted: lines.join('\n'),
  }
}
