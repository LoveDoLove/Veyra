/**
 * Veyra — Hybrid Search + Transparent Ranking.
 *
 * Combines:
 *   1. Authority & lifecycle gate — candidates, observations, stale, invalid never surface
 *   2. Project isolation — strict DB-level split, plus scoped reusable
 *   3. Lexical retrieval — SQLite FTS5 BM25 match + exact token/symbol/path match
 *   4. Semantic retrieval — query coverage + token-level Jaccard overlap
 *   5. Memory & Causal retrieval — intent affinity (why/how/outcome/symptom), validation, confidence, freshness
 *   6. Relationship retrieval — graph cohesion, structural connections (updates, extends, derives, resolves)
 *   7. Unified RAG + Engineering Memory — retrieves Knowledge Base docs and Engineering Memory together
 *   8. Provenance preservation — origin, document/file path, session, and verification tracked
 *   9. Contradiction banners — both sides stay visible (never silently resolved)
 *
 * Invariant (GOAL.md / Core Invariants):
 *   Retrieval != authority. Similarity != identity. Memory != truth.
 */

import { AUTHORITIES, CONFIDENCES, DEFAULT_RECALL_LIMIT, KINDS, SCOPES, VALIDATIONS, isRecallEligible } from './types.mjs'
import { detectIntent, intentAffinity, intentWeights } from './intent.mjs'
import { annotateContradictions } from './evolve.mjs'
import { jaccard, tokenOverlap } from './text.mjs'

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
    if (/test-passed|tests-touched|test|spec|fixture/i.test(text) && !/test-failed/i.test(text)) {
      hasTest = true
    }
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

export function relevanceFromRank(record, index, hasQuery = false) {
  if (typeof record.relevance === 'number') {
    return clamp01(record.relevance)
  }
  if (typeof record.rank === 'number') {
    // FTS5 bm25-style rank: more negative is a stronger match.
    const r = record.rank < 0 ? -record.rank : Math.abs(record.rank)
    return clamp01(r / (1 + r))
  }
  if (hasQuery) {
    return 0
  }
  return clamp01(1 - index * 0.06)
}

function clamp01(n) {
  if (!Number.isFinite(n)) return 0
  return Math.min(1, Math.max(0, n))
}

/**
 * Exact token, identifier, and path matching boost on top of FTS5.
 */
export function lexicalScore(record, query, index = 0) {
  const hasQuery = Boolean(query && String(query).trim())
  const base = relevanceFromRank(record, index, hasQuery)
  if (!hasQuery) return base
  const qLower = String(query).toLowerCase().trim()
  const titleLower = String(record.title || '').toLowerCase()
  const bodyLower = String(record.body || '').toLowerCase()
  let boost = 0
  if (qLower && (titleLower.includes(qLower) || bodyLower.includes(qLower))) {
    boost += 0.2
  }
  const symbols = record.tags || []
  for (const sym of symbols) {
    if (sym && qLower.includes(String(sym).toLowerCase())) {
      boost += 0.15
      break
    }
  }
  return Number(Math.min(1.0, Math.max(0, base + boost)).toFixed(3))
}

/**
 * Token-level semantic overlap and query coverage.
 */
export function semanticSimilarity(query, record) {
  if (!query || !record) return 0
  const hay = `${record.title || ''} ${record.body || ''} ${(record.tags || []).join(' ')}`
  const jc = jaccard(query, hay)
  const overlap = tokenOverlap(hay, query)
  const sim = overlap.ratio * 0.6 + jc * 0.4
  return Number(Math.min(1, Math.max(0, sim)).toFixed(3))
}

/**
 * Relationship graph connection strength within a candidate pool.
 */
export function relationshipScore(record, poolIds = new Set()) {
  if (!record?.relations?.length) return 0.1
  let count = 0
  let interconnected = 0
  for (const rel of record.relations) {
    if (!rel || !rel.type) continue
    count++
    if (poolIds.has(rel.targetId)) {
      interconnected++
    }
  }
  const base = Math.min(0.5, count * 0.1)
  const boost = Math.min(0.5, interconnected * 0.25)
  return Number(Math.min(1.0, base + boost).toFixed(3))
}

const DEFAULT_WEIGHTS = Object.freeze({
  relevance: 0.32,
  evidence: 0.18,
  validation: 0.18,
  proximity: 0.14,
  freshness: 0.08,
  confidence: 0.10,
  semantic: 0.10,
  relationship: 0.04,
})

/**
 * Rank records with a full dimensional breakdown.
 * Never returns a single opaque score.
 */
export function rankRecords(records, { weights = {}, preferProject = true, intent = null, query = '' } = {}) {
  if (!Array.isArray(records) || records.length === 0) return []
  const w = { ...DEFAULT_WEIGHTS, ...intentWeights(intent), ...weights }
  const poolIds = new Set(records.map((r) => r.id).filter(Boolean))
  const scored = records.map((rec, idx) => {
    const lex = lexicalScore(rec, query, idx)
    const sem = semanticSimilarity(query, rec)
    const relevance = lex
    const evidence = evidenceStrength(rec.evidence)
    const validation = validationTier(rec.validation)
    const proximity = scopeProximity(rec.scope, preferProject)
    const freshness = freshnessTier(rec.updatedAt || rec.createdAt)
    const confidence = confidenceScore(rec.confidence)
    const affinity = intentAffinity(rec, intent)
    const rel = relationshipScore(rec, poolIds)
    const composite = Number((
      relevance * w.relevance
      + sem * (w.semantic ?? 0.10)
      + evidence * w.evidence
      + validation * w.validation
      + proximity * w.proximity
      + freshness * w.freshness
      + confidence * w.confidence
      + rel * (w.relationship ?? 0.04)
      + affinity
    ).toFixed(4))
    return {
      ...rec,
      intent: intent || undefined,
      scores: {
        composite,
        relevance: Number(relevance.toFixed(3)),
        lexical: Number(lex.toFixed(3)),
        semantic: Number(sem.toFixed(3)),
        evidence_strength: Number(evidence.toFixed(3)),
        validation_tier: Number(validation.toFixed(3)),
        scope_proximity: Number(proximity.toFixed(3)),
        freshness_tier: Number(freshness.toFixed(3)),
        confidence: Number(confidence.toFixed(3)),
        intent_affinity: Number(affinity.toFixed(3)),
        relationship: Number(rel.toFixed(3)),
      },
    }
  })
  scored.sort((a, b) => b.scores.composite - a.scores.composite)
  return scored
}

/**
 * Unified Hybrid Retrieval across Project Store and Reusable Store.
 *
 * Combines:
 *   - FTS5 lexical matching + exact token matching
 *   - Semantic similarity
 *   - Intent affinity and causal prioritization
 *   - Relationship graph traversal
 *   - RAG Knowledge and Engineering Memory unification
 *   - Strict lifecycle & authority filtering
 *   - Contradiction surfacing
 */
export function hybridRetrieve({
  projectStore,
  reusableStore = null,
  query = '',
  limit = DEFAULT_RECALL_LIMIT,
  includeReusable = true,
  intent = null,
  kind = null,
} = {}) {
  const detectedIntent = intent || detectIntent(query)
  const perStore = Math.max(limit * 3, 12)
  const projectFtsHits = projectStore
    ? projectStore.search(query, { limit: perStore, recallOnly: true })
    : []
  const reusableFtsHits = includeReusable && reusableStore
    ? reusableStore.search(query, { limit: perStore, recallOnly: true })
    : []

  // Candidate pooling: include recent records so semantic/intent matches
  // with differing lexical stems can also be scored and recalled.
  const projectRecent = projectStore ? projectStore.list({ limit: perStore }) : []
  const reusableRecent = includeReusable && reusableStore ? reusableStore.list({ limit: perStore }) : []

  const projectId = projectStore?.projectId
  const candidateMap = new Map()

  const addCandidate = (rec, fromReusable = false) => {
    if (!rec || !isRecallEligible(rec)) return
    if (fromReusable) {
      if (rec.scope !== SCOPES.REUSABLE || rec.projectId === projectId) return
    } else {
      if (rec.projectId !== projectId && rec.scope !== SCOPES.PROJECT) return
    }
    if (kind && rec.kind !== kind) return
    if (!candidateMap.has(rec.id)) {
      candidateMap.set(rec.id, rec)
    }
  }

  for (const r of projectFtsHits) addCandidate(r, false)
  for (const r of reusableFtsHits) addCandidate(r, true)
  for (const r of projectRecent) addCandidate(r, false)
  for (const r of reusableRecent) addCandidate(r, true)

  const merged = Array.from(candidateMap.values())
  const ranked = annotateContradictions(rankRecords(merged, { query, intent: detectedIntent, preferProject: true }))
  const limited = ranked.slice(0, Math.max(1, limit))

  // PMA invariant: never hide one side of a contradiction.
  // Pull opposing recall-eligible records even if search missed them.
  const seen = new Set(limited.map((r) => r.id))
  const extras = []
  for (const rec of limited) {
    for (const rel of rec.relations || []) {
      if (rel.type !== 'contradicts' || seen.has(rel.targetId)) continue
      const extra = projectStore?.get(rel.targetId) || reusableStore?.get(rel.targetId)
      if (!extra || !isRecallEligible(extra)) continue
      seen.add(extra.id)
      extras.push(extra)
    }
  }
  if (extras.length === 0) return limited
  return annotateContradictions(rankRecords([...limited, ...extras], { query, intent: detectedIntent, preferProject: true }))
}

/**
 * Recall across the project store and (optionally) the reusable store.
 * Delegates to hybridRetrieve.
 */
export function recall(options = {}) {
  return hybridRetrieve(options)
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
    for (const banner of rec.contradictionBanners || []) {
      lines.push(`> ⚠️ ${banner}`)
    }
    const kindTag = rec.kind === KINDS.KNOWLEDGE ? ' [KNOWLEDGE]' : ''
    lines.push(`- [${rec.id}] (${scope}/${auth}/${rec.validation}/${rec.confidence}${ev}${contra})${kindTag} ${rec.title}`)
    const causal = rec.source?.causal
    if (causal && (causal.symptom || causal.rootCause || causal.remedy || causal.verifiedOutcome)) {
      if (causal.symptom) lines.push(`  • Symptom: ${causal.symptom}`)
      if (causal.rootCause) lines.push(`  • Root cause: ${causal.rootCause}`)
      if (causal.remedy) lines.push(`  • Remedy: ${causal.remedy}`)
      if (causal.verifiedOutcome) lines.push(`  • Outcome: ${causal.verifiedOutcome}`)
    } else {
      const docPath = rec.source?.docPath || rec.source?.uri || rec.evidence?.[0]?.path
      if (rec.kind === KINDS.KNOWLEDGE && docPath) {
        lines.push(`  • Source: ${docPath}`)
      }
      const body = String(rec.body || '').replace(/\s+/g, ' ').trim()
      if (body) lines.push(`  ${body.slice(0, 360)}`)
    }
  }
  return lines.join('\n')
}
