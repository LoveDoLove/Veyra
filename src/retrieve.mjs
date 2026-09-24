/**
 * Veyra — hybrid recall + transparent ranking.
 *
 * Pipeline adapted from PMA's 6-stage retrieval and ranking:
 *   1. authority gate   — candidates / observations never surface as truth
 *   2. project isolation — hard DB-level split, plus optional reusable
 *   3. FTS5 lexical match
 *   4. lifecycle filter — current only, skip stale/invalid/forgotten
 *   5. 6-D ranking      — relevance, evidence, validation, proximity,
 *                          freshness, confidence (never an opaque score)
 *   6. contradiction flag — related `contradicts` links are annotated
 *
 * Invariant (OpenViking merge_policy / GOAL.md):
 *   Similarity only identifies candidates. It is never sufficient evidence
 *   of identity or authority.
 */

import { AUTHORITIES, CONFIDENCES, DEFAULT_RECALL_LIMIT, SCOPES, VALIDATIONS, isRecallEligible } from './types.mjs'

export function evidenceStrength(evidence) {
  if (!evidence) return 0.1
  const arr = Array.isArray(evidence) ? evidence : []
  if (arr.length === 0) return 0.1
  let hasFile = false
  let hasTest = false
  for (const item of arr) {
    const text = typeof item === 'string'
      ? item
      : String(item?.path || item?.uri || item?.anchor || item?.note || '')
    if (!text) continue
    if (/\.(mjs|js|ts|tsx|py|go|rs|java|kt)\b/.test(text) || text.includes('/') || text.includes('\\')) {
      hasFile = true
    }
    if (/test|spec|fixture/i.test(text)) hasTest = true
  }
  if (hasFile && hasTest) return 1.0
  if (hasFile) return 0.7
  return 0.4
}

export function validationTier(validation) {
  switch (validation) {
    case VALIDATIONS.VERIFIED: return 1.0
    case VALIDATIONS.REVIEWED: return 0.7
    case VALIDATIONS.UNVERIFIED: return 0.25
    case VALIDATIONS.STALE: return 0.15
    case VALIDATIONS.INVALID: return 0.0
    default: return 0.2
  }
}

export function scopeProximity(scope, preferProject = true) {
  if (scope === SCOPES.PROJECT) return preferProject ? 1.0 : 0.7
  if (scope === SCOPES.REUSABLE) return preferProject ? 0.55 : 1.0
  return 0.4
}

export function confidenceScore(confidence) {
  switch (confidence) {
    case CONFIDENCES.HIGH: return 1.0
    case CONFIDENCES.MEDIUM: return 0.6
    case CONFIDENCES.LOW: return 0.3
    default: return 0.5
  }
}

export function freshnessTier(dateStr) {
  if (!dateStr) return 0.5
  const ts = Date.parse(dateStr)
  if (Number.isNaN(ts)) return 0.5
  const days = Math.max(0, (Date.now() - ts) / 86_400_000)
  if (days <= 14) return 1.0
  if (days <= 45) return 0.85
  if (days <= 120) return 0.65
  if (days <= 365) return 0.4
  return 0.2
}

export function relevanceFromRank(record, index) {
  if (typeof record.relevance === 'number') {
    return clamp01(record.relevance)
  }
  if (typeof record.rank === 'number') {
    // FTS5 bm25-style rank: more negative / smaller is better.
    return clamp01(1 / (1 + Math.abs(record.rank)))
  }
  return clamp01(1 - index * 0.06)
}

function clamp01(n) {
  if (!Number.isFinite(n)) return 0
  return Math.min(1, Math.max(0, n))
}

const DEFAULT_WEIGHTS = Object.freeze({
  relevance: 0.32,
  evidence: 0.18,
  validation: 0.18,
  proximity: 0.14,
  freshness: 0.08,
  confidence: 0.10,
})

/**
 * Rank records with a full dimensional breakdown.
 * Never returns a single opaque score.
 */
export function rankRecords(records, { weights = {}, preferProject = true } = {}) {
  if (!Array.isArray(records) || records.length === 0) return []
  const w = { ...DEFAULT_WEIGHTS, ...weights }
  const scored = records.map((rec, idx) => {
    const relevance = relevanceFromRank(rec, idx)
    const evidence = evidenceStrength(rec.evidence)
    const validation = validationTier(rec.validation)
    const proximity = scopeProximity(rec.scope, preferProject)
    const freshness = freshnessTier(rec.updatedAt || rec.createdAt)
    const confidence = confidenceScore(rec.confidence)
    const composite = Number((
      relevance * w.relevance
      + evidence * w.evidence
      + validation * w.validation
      + proximity * w.proximity
      + freshness * w.freshness
      + confidence * w.confidence
    ).toFixed(4))
    return {
      ...rec,
      scores: {
        composite,
        relevance: Number(relevance.toFixed(3)),
        evidence_strength: Number(evidence.toFixed(3)),
        validation_tier: Number(validation.toFixed(3)),
        scope_proximity: Number(proximity.toFixed(3)),
        freshness_tier: Number(freshness.toFixed(3)),
        confidence: Number(confidence.toFixed(3)),
      },
    }
  })
  scored.sort((a, b) => b.scores.composite - a.scores.composite)
  return scored
}

function annotateContradictions(records) {
  const byId = new Map(records.map((r) => [r.id, r]))
  for (const rec of records) {
    const hits = []
    for (const rel of rec.relations || []) {
      if (rel.type === 'contradicts' && byId.has(rel.targetId)) hits.push(rel.targetId)
    }
    rec.contradictions = hits
  }
  return records
}

/**
 * Recall across the project store and (optionally) the reusable store.
 *
 * Project memories always win isolation: reusable hits are tagged and
 * never treated as project truth. Candidates never appear.
 */
export function recall({
  projectStore,
  reusableStore = null,
  query = '',
  limit = DEFAULT_RECALL_LIMIT,
  includeReusable = true,
} = {}) {
  const perStore = Math.max(limit * 3, 8)
  const projectHits = projectStore
    ? projectStore.search(query, { limit: perStore, recallOnly: true })
    : []
  const reusableHits = includeReusable && reusableStore
    ? reusableStore.search(query, { limit: perStore, recallOnly: true })
    : []

  // Isolation: drop any reusable record whose projectId equals the current
  // project (it belongs in the project DB). Drop any project record that
  // somehow leaked into reusable.
  const projectId = projectStore?.projectId
  const isolatedReusable = reusableHits.filter((r) => r.scope === SCOPES.REUSABLE && r.projectId !== projectId)
  const isolatedProject = projectHits.filter((r) => r.projectId === projectId || r.scope === SCOPES.PROJECT)

  const merged = []
  const seen = new Set()
  for (const rec of [...isolatedProject, ...isolatedReusable]) {
    if (!isRecallEligible(rec)) continue
    if (seen.has(rec.id)) continue
    seen.add(rec.id)
    merged.push(rec)
  }

  const ranked = annotateContradictions(rankRecords(merged))
  return ranked.slice(0, Math.max(1, limit))
}

/**
 * Inspect a single record by id, searching project then reusable.
 * Returns the record even if it is a candidate (inspection is not recall).
 */
export function inspect({ projectStore, reusableStore = null, id }) {
  if (!id) return null
  return projectStore?.get(id) || reusableStore?.get(id) || null
}

export function summarizeForPrompt(records, { heading = 'Veyra recalled engineering memory' } = {}) {
  if (!records?.length) return ''
  const lines = [
    heading,
    '',
    'These items are remembered engineering experience, not repository truth.',
    'Verify against the current codebase before acting. Similarity is not authority.',
    '',
  ]
  for (const rec of records) {
    const auth = rec.authority === AUTHORITIES.CANONICAL ? 'canonical' : rec.authority
    const ev = rec.evidence?.length ? `; evidence: ${rec.evidence.length}` : ''
    const contra = rec.contradictions?.length ? `; CONTRADICTS ${rec.contradictions.join(', ')}` : ''
    const scope = rec.scope === SCOPES.REUSABLE ? 'reusable' : 'project'
    lines.push(`- [${rec.id}] (${scope}/${auth}/${rec.validation}/${rec.confidence}${ev}${contra}) ${rec.title}`)
    const body = String(rec.body || '').replace(/\s+/g, ' ').trim()
    if (body) lines.push(`  ${body.slice(0, 360)}`)
  }
  return lines.join('\n')
}
