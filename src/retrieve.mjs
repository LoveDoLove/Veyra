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

import { AUTHORITIES, CONFIDENCES, DEFAULT_RECALL_LIMIT, KINDS, SCOPES, VALIDATIONS, isLifecycleEligible, isRecallEligible } from './types.mjs'
import { detectIntent, intentAffinity, intentWeights } from './intent.mjs'
import { injectionWarning } from './redact.mjs'
import { annotateContradictions } from './evolve.mjs'
import { expandEligibleNeighbors } from './graph.mjs'
import { jaccard, tokenOverlap, hasNegation, tokenize } from './text.mjs'

export function evidenceStrength(evidence) {
  if (!evidence) return 0.1
  const arr = Array.isArray(evidence) ? evidence : []
  if (arr.length === 0) return 0.1
  let hasFile = false
  let hasTest = false
  for (const item of arr) {
    // Compose every available field. Reading only `path || uri || anchor ||
    // note` kept the first truthy field and discarded the rest, so the note
    // carrying the test outcome was ignored whenever a path was present. The
    // effect: `hasTest` was really "does some path contain test/spec/fixture",
    // so a memory that merely opened a file under test/ scored 1.0 while a
    // memory recording a genuine outcome under an ordinary path scored 0.7.
    const text = typeof item === 'string'
      ? item
      : [item?.path, item?.uri, item?.anchor, item?.note]
        .filter((part) => typeof part === 'string' && part.trim())
        .join(' ')
    if (!text) continue
    if (/\.(mjs|js|ts|tsx|py|go|rs|java|kt)\b/.test(text) || text.includes('/') || text.includes('\\')) {
      hasFile = true
    }
    // Closed vocabulary, as in the learning path: an unanchored `test|spec`
    // also matches ordinary prose such as "inspector", "protest" or "aspect".
    if (/(^|[^a-z0-9-])(test-passed|tests-touched)([^a-z0-9-]|$)/i.test(text)
      && !/(^|[^a-z0-9-])test-failed([^a-z0-9-]|$)/i.test(text)) {
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
  if (typeof record.ftsPosition === 'number') {
    // Rank-position calibration. SQLite's bm25() magnitude is corpus-dependent:
    // for a common term in a small memory store it collapses toward ~1e-6, so the
    // previous abs(rank)/(1+abs(rank)) mapping reported ~0 for a genuine match
    // and left the 0.32-weight dimension to the substring bonus. Position is the
    // ordering signal that stays bounded and independent of corpus size.
    // Reciprocal rank: 0 -> 1, 1 -> 0.5, 2 -> 1/3, 4 -> 0.2.
    return clamp01(1 / (1 + record.ftsPosition))
  }
  if (typeof record.rank === 'number') {
    // A rank with no stamped position (an older caller) is treated as the best
    // FTS result rather than silently discarded.
    return 1
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
 * Insert spaces at CamelCase boundaries so a compound identifier tokenizes
 * into its parts.
 *
 *   DatabaseSync        -> Database Sync
 *   applyMirrorRemoval  -> apply Mirror Removal
 *   MemoryStore         -> Memory Store
 *
 * Acronyms are handled conservatively: a run of capitals is kept whole and only
 * its trailing word is released.
 *
 *   HTTPServer   -> HTTP Server        (not H T T P Server)
 *   XMLParser    -> XML Parser
 *   FTSPosition  -> FTS Position
 *
 * Two boundaries, applied over each run of letters/digits:
 *   lower|digit -> Upper   : split        (foo|Bar)
 *   Upper       -> Upper+lower : split    (HT|Server -> HTTP Server)
 *
 * Deterministic and purely local: the stored text is unchanged, and this only
 * affects the strings handed to `semanticSimilarity`. `tokenize()`, the FTS5
 * tokenizer, candidate discovery, and every other scorer are untouched, so
 * splitting can never change WHICH records are found — only how strongly an
 * already-discovered one scores.
 */
function splitCamelCase(text) {
  return String(text || '').replace(
    /([a-z0-9])([A-Z])|([A-Z]+)([A-Z][a-z])/g,
    (m, lowerUpper, upperAfterLower, acr, acrTail) => {
      if (lowerUpper && upperAfterLower) return `${lowerUpper} ${upperAfterLower}`
      return `${acr} ${acrTail}`
    },
  )
}

/**
 * Token-level semantic overlap and query coverage.
 *
 * Both sides pass through `splitCamelCase` first, so a natural-language query
 * can match a stored identifier. Without it "apply mirror" shares no token with
 * "applyMirrorRemoval" and scores 0, leaving the correct record sitting at the
 * same composite as unrelated memory.
 */
export function semanticSimilarity(query, record) {
  if (!query || !record) return 0
  const hay = splitCamelCase(`${record.title || ''} ${record.body || ''} ${(record.tags || []).join(' ')}`)
  const q = splitCamelCase(query)
  const jc = jaccard(q, hay)
  const overlap = tokenOverlap(hay, q)
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
 * Textual claim of a record, in the same projection `semanticSimilarity`
 * uses. Polarity lives in the RAW text, because `not`/`no`/`never` are
 * stopwords and do not survive tokenization.
 */
function claimText(record) {
  return `${record?.title || ''} ${record?.body || ''} ${(record?.tags || []).join(' ')}`
}

/**
 * Polarity compatibility between a query and a candidate.
 *
 * `not`/`no`/`never` are stopwords, so "serialize writes" and "do not
 * serialize writes" tokenize to the SAME set and score 1.0 on textual
 * similarity. `semanticSimilarity` is deliberately left alone — polarity is
 * not a property of one text, it is a relationship between two.
 *
 * Both sides matter:
 *   - a NEGATED QUERY prefers negated records and must not be answered by the
 *     affirmative claim it is negating;
 *   - a NEUTRAL QUERY must not be answered by a record asserting the opposite
 *     of what was asked, so a negated record does not outrank the plain one.
 * When neither side is negated there is nothing to reconcile and every
 * candidate is compatible, so existing behaviour is untouched.
 *
 * This is a RANKING COMPATIBILITY CONSTRAINT, not a trust signal. A
 * polarity-mismatched candidate keeps every metadata component and stays
 * fully recallable; it simply cannot outrank the best candidate that agrees
 * with the query's polarity. Subtracting or zeroing the textual score is not
 * enough: the remaining metadata floor is large enough to let a mismatched
 * record outrank a plain affirmative.
 */
function polarityCompatible(query, record) {
  return hasNegation(query) === hasNegation(claimText(record))
}

/**
 * Causal-channel text (GOAL.md Phase 3, §14 Causal Memory).
 * The searchable half of `record.source.causal` — symptom, root cause,
 * remedy, verified outcome. Null/absent facets are skipped; a record
 * without causal facets contributes '' and scores 0 on this channel.
 */
function causalText(record) {
  const c = record?.source?.causal
  if (!c || typeof c !== 'object') return ''
  return [c.symptom, c.rootCause, c.remedy, c.verifiedOutcome]
    .filter((v) => typeof v === 'string' && v.trim())
    .join(' ')
}

/**
 * Causal relevance (GOAL.md Phase 3: Causal as a ranking signal).
 *
 * Fraction of the query tokens the record's causal facets explain, so a
 * record that documents WHY/HOW a failure happens beats an equally
 * title-matched record that does not. camelCase split applied so identifier
 * queries still reach facet prose. Not part of the weighted composite —
 * it participates through rank fusion below, keeping `composite` the plain
 * weighted sum its contract (and its pinned test) requires.
 */
export function causalRelevance(query, record) {
  const q = String(query || '').trim()
  const c = record?.source?.causal
  const text = causalText(record)
  if (!q || !text) return 0
  const { ratio } = tokenOverlap(splitCamelCase(text), splitCamelCase(q))
  // §14 — prioritize verified historical cause/effect chains: a chain
  // that recorded its outcome outweighs a suspected one, and documenting
  // more of the chain (symptom → root cause → remedy) raises the channel
  // proportionally. A verified, complete chain keeps quality at exactly
  // 1 (unchanged legacy behavior); fragments and unverified chains rank
  // strictly below it — never at 0, so an explaining record still beats
  // a silent one.
  const documented = [c?.symptom, c?.rootCause, c?.remedy]
    .filter((v) => typeof v === 'string' && v.trim()).length
  const verified = typeof c?.verifiedOutcome === 'string' && c.verifiedOutcome.trim() ? 1 : 0
  const quality = 0.5 + 0.3 * verified + 0.2 * (documented / 3)
  return Number(Math.min(1, Math.max(0, ratio * quality)).toFixed(3))
}

/** Goal-term coverage weight — the surviving leg of the reference formula. */
export const GOAL_WEIGHT = 0.7

/**
 * Goal-directed retrieval affinity (GOAL.md Phase 10).
 *
 * Adapted from dsh-memory `md_cg/mdcos.py:1411` `_path_goal`:
 *     score = min(1.0, 0.7·goal_term_coverage + 0.3·domain_affinity)
 * Only the first leg survives the copy. `routing.big_domain_score_weighted`
 * has no Veyra counterpart — Veyra has no `goals` layer, no domain graph
 * and no topic router (Phase 10 capability evaluation, see
 * docs/capability-matrix.md) — so the domain term is dropped rather than
 * faked with an invented signal. What remains is goal-term coverage over
 * the record's claim text, using the same `tokenOverlap` the semantic
 * channel already uses.
 *
 * Invariant (GOAL.md Phase 10, Core Invariants): a goal is a DIRECTION,
 * not an answer and not an authority. This value only routes ordering; it
 * never promotes, never changes authority/validation/confidence, and is
 * inert without an explicit goal (Similarity ≠ Authority, and a goal is
 * weaker evidence than a verified record — never stronger).
 */
export function goalAffinity(goal, record) {
  const g = String(goal ?? '').trim()
  if (!g) return 0
  const text = claimText(record)
  if (!text) return 0
  const { ratio } = tokenOverlap(splitCamelCase(text), splitCamelCase(g))
  return Number(clamp01(ratio * GOAL_WEIGHT).toFixed(3))
}

/**
 * Temporal validity bounds (GOAL.md Phase 4, §13).
 *
 * Canonical shape lives on `source.temporal` — same JSON-bag precedent as
 * `source.causal`: the row schema is fixed-column and bumping
 * schema_version fails closed on every existing database. Top-level
 * `validFrom`/`validUntil` and snake_case `valid_from`/`valid_until` are
 * read-side aliases, mirroring dsh-memory's canonical-key + read-fallback
 * discipline (md_cg/nodefile.py:133-138 — new writes land canonical,
 * legacy shapes keep reading, zero migration). Unparseable endpoints are
 * dropped here so `temporalState` fails open to `current` — never guess
 * (dsh-memory mdcos.py: 时间轴缺失/端点不可解析 → 不过滤).
 */
export function temporalBounds(record) {
  const bag = record?.source?.temporal
  const t = bag && typeof bag === 'object' ? bag : {}
  const raw = [
    record?.validFrom ?? record?.valid_from ?? t.validFrom ?? t.valid_from ?? null,
    record?.validUntil ?? record?.valid_until ?? t.validUntil ?? t.valid_until ?? null,
  ]
  const valid = raw.map((v) => (typeof v === 'string' && Number.isFinite(Date.parse(v)) ? v : null))
  return { validFrom: valid[0], validUntil: valid[1] }
}

/**
 * The §13 validity state on the temporal axis: `current` |
 * `not_yet_effective` | `expired`.
 *
 * Copied semantics from dsh-memory (mdcg/mdcos.py:763-765): a passed
 * `valid_until` is expired; a future `valid_from` is NOT an expiry —
 * scheduled knowledge must stay recallable before it takes effect
 * ("valid_from 绝不并入 _EXPIRY_KEYS"). Absent window → `current`.
 */
export function temporalState(record, now = Date.now()) {
  const { validFrom, validUntil } = temporalBounds(record)
  if (validUntil && now > Date.parse(validUntil)) return 'expired'
  if (validFrom && now < Date.parse(validFrom)) return 'not_yet_effective'
  return 'current'
}

/**
 * Captured applicability context (GOAL.md Phase 4, §12). Written at
 * remember() time: the runtime auto-stamps the environment facts it knows
 * (os, runtime) and agent-supplied keys (toolchain, version, taskType, …)
 * ride alongside on `source.context`.
 */
export function recordContext(record) {
  const c = record?.source?.context
  return c && typeof c === 'object' ? c : null
}

/** The environment facts THIS runtime states, compared against captures. */
export function currentAppContext() {
  return { os: process.platform, runtime: process.version }
}

function contextValueMatches(key, current, captured) {
  if (key === 'runtime') {
    // Same major = same toolchain line; patch/minor drift is not a context
    // change (a v24.8 capture applies on v24.21 alike).
    const major = (v) => String(v).match(/\d+/)?.[0] ?? String(v)
    return major(current) === major(captured)
  }
  return String(current) === String(captured)
}

/**
 * Context compatibility: 1 (compatible or unknown) / 0 (contradiction).
 *
 * §12 invariant: Similarity ≠ Applicability. Only keys BOTH sides state
 * can contradict — a capture is a statement of where it was observed, not
 * a claim that nowhere else applies, so absent context stays neutral and
 * keys only the record carries (toolchain vs current {os, runtime}) are
 * never guessed at. Fail-open, same discipline as dsh-memory validity.
 */
export function contextCompatibility(record, current = currentAppContext()) {
  const ctx = recordContext(record)
  if (!ctx) return 1
  for (const key of Object.keys(current)) {
    const captured = ctx[key]
    if (captured == null || captured === '') continue
    if (!contextValueMatches(key, current[key], captured)) return 0
  }
  return 1
}

/**
 * RRF fusion (GOAL.md Phase 3, §10 Multi-Channel Retrieval).
 *
 * Copied from the reference implementation: score(d) = Σ_path w_path /
 * (RRF_K + rank_path(d)) — dsh-memory md_cg/mdcos.py:64 (RRF_K = 60) and
 * :1454 search_rrf. Multi-channel consensus (top-ranked by several
 * channels) outranks a single-path hit; every contribution is
 * deterministic — no learned weights, no vectors.
 *
 * Channels are the named signals of §10, each ranking the SAME candidate
 * pool by its own scores field: FTS5/BM25 (lexical), token overlap
 * (semantic), intent, relations (relationship), causal (new), evidence,
 * negative history (polarity_compatible), temporal (freshness_tier) and
 * applicability (scope_proximity).
 *
 * A channel whose values are identical across the pool carries no rank
 * information (e.g. every candidate polarity-compatible, or all-equal
 * freshness in a single-record pool) and is excluded for that pool — so a
 * pool with no discriminative channel gets null and the caller falls back
 * to the plain composite ordering untouched.
 *
 * Returns an array aligned with `scored`: normalized RRF in (0, 1],
 * where 1.0 = rank 1 in every included channel. Fully deterministic:
 * value desc, input-index asc tiebreak.
 */
export const RRF_K = 60
export const FUSION_WEIGHT = 0.06

const FUSION_CHANNELS = Object.freeze([
  'lexical',             // FTS5 / BM25
  'semantic',            // token overlap
  'intent_affinity',     // intent
  'relationship',        // relations
  'causal',              // causal relevance (Phase 3, new)
  'evidence_strength',   // evidence strength
  'polarity_compatible', // negative / polarity history
  'freshness_tier',      // recency tiers
  'scope_proximity',     // scope applicability
  'applicability',       // §12 context compatibility (Phase 4, new)
  'temporal_validity',   // §13 validity window (Phase 4, new)
  'goal_affinity',       // explicit-goal routing (Phase 10, new; flat → inactive)
])

export function reciprocalRankFusion(scored) {
  if (!Array.isArray(scored) || scored.length === 0) return null
  const n = scored.length
  const channelRanks = []
  for (const key of FUSION_CHANNELS) {
    const values = scored.map((r) => {
      const v = r?.scores?.[key]
      if (typeof v === 'boolean') return v ? 1 : 0
      return Number.isFinite(v) ? v : 0
    })
    if (Math.max(...values) === Math.min(...values)) continue // flat = no signal
    const order = values.map((v, i) => i).sort((a, b) => (values[b] - values[a]) || (a - b))
    const ranks = new Array(n)
    order.forEach((idx, pos) => { ranks[idx] = pos + 1 })
    channelRanks.push(ranks)
  }
  if (channelRanks.length === 0) return null
  const maxRaw = channelRanks.length / (RRF_K + 1) // rank 1 in every channel
  return scored.map((_, i) => {
    let raw = 0
    for (const ranks of channelRanks) raw += 1 / (RRF_K + ranks[i])
    return Number((raw / maxRaw).toFixed(4))
  })
}

/**
 * Rank records with a full dimensional breakdown.
 * Never returns a single opaque score.
 */
export function rankRecords(records, { weights = {}, preferProject = true, intent = null, query = '', goal = null } = {}) {
  if (!Array.isArray(records) || records.length === 0) return []
  const w = { ...DEFAULT_WEIGHTS, ...intentWeights(intent), ...weights }
  const hasQuery = Boolean(String(query ?? '').trim())
  const hasGoal = Boolean(String(goal ?? '').trim())
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
    const compatible = polarityCompatible(query, rec)
    const causal = causalRelevance(query, rec)
    // Phase 10 §goal — sort-only, and only when an explicit goal was
    // supplied: without one every value is 0, the channel is flat, and it
    // drops out of the RRF exactly like the other neutral channels.
    const goalHit = hasGoal ? goalAffinity(goal, rec) : 0
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
        causal: Number(causal.toFixed(3)),
        polarity_compatible: compatible,
        // Phase 4 §12/§13 — sort-only channels, composite untouched:
        // unknown context / absent window are neutral (1), so pools
        // without applicability or validity signal stay flat and the
        // channels drop out of the RRF for that pool.
        applicability: contextCompatibility(rec),
        temporal_validity: temporalState(rec) === 'expired' ? 0 : 1,
        goal_affinity: Number(goalHit.toFixed(3)),
      },
    }
  })

  // RRF consensus (GOAL.md Phase 3, §10): rank the pool once per channel and
  // fuse with reciprocal-rank fusion. Query-driven retrieval only — an
  // empty-query pool is a recency browse where fusion adds nothing — and a
  // pool with no discriminative channel gets null (all rrf = 0). `composite`
  // stays the plain weighted sum its contract requires; `fusion` is a
  // separate sort-only score, same discipline as the polarity cap and the
  // signal tier below.
  const rrfs = hasQuery ? reciprocalRankFusion(scored) : null
  for (let i = 0; i < scored.length; i++) {
    const rrf = rrfs ? rrfs[i] : 0
    scored[i].scores.rrf = rrf
    scored[i].scores.fusion = Number((scored[i].scores.composite + FUSION_WEIGHT * rrf).toFixed(4))
  }

  // Applied after scoring so every component above is preserved verbatim.
  // A polarity-mismatched candidate is capped just below the best compatible
  // one; it is never removed, invalidated, or demoted in lifecycle terms.
  //
  // Several mismatches can land on the SAME capped value, which would make
  // their relative order fall back to input (Map insertion) order. The pre-cap
  // composite is therefore retained as a SORT KEY ONLY for those rows — it is
  // never added to the weighted score and is not a ranking signal of its own.
  const compatibleScores = scored.filter((r) => r.scores.polarity_compatible)
  if (compatibleScores.length > 0 && compatibleScores.length < scored.length) {
    const best = Math.max(...compatibleScores.map((r) => r.scores.composite))
    // The same invariant must hold on the sort score: the RRF consensus
    // term must not lift a mismatched candidate above the best compatible
    // one either, so `fusion` is capped by the same rule.
    const bestFusion = Math.max(...compatibleScores.map((r) => r.scores.fusion))
    for (const r of scored) {
      if (r.scores.polarity_compatible) continue
      r.scores.polarity_mismatch = true
      r.scores.polarity_original_composite = r.scores.composite
      if (r.scores.composite >= best) r.scores.composite = Number((best - 0.0001).toFixed(4))
      // Re-derive fusion from the (possibly capped) composite so the two
      // never disagree, then hold the same invariant on it.
      r.scores.fusion = Number((r.scores.composite + FUSION_WEIGHT * r.scores.rrf).toFixed(4))
      if (r.scores.fusion > bestFusion) r.scores.fusion = Number((bestFusion - 0.0001).toFixed(4))
    }
  }

  // Phase 4 §12/§13 — applicability and temporal validity guards, same
  // sort-only discipline: `composite` and the dimensional breakdown stay
  // verbatim, only `fusion` is held below the best fully-eligible
  // alternative. An expired or context-incompatible record remains fully
  // recallable (historical knowledge stays available) but cannot outrank
  // the best valid, applicable one on text similarity alone — Similarity
  // ≠ Applicability, historical ≠ current truth. Sequential with the
  // polarity cap above (each step only lowers, so the result is the min
  // of all applicable ceilings). Inactive when no eligible alternative
  // exists (nothing to protect) and, like fusion itself, query-only: an
  // empty-query pool is a browse where availability wins.
  if (hasQuery) {
    const eligible = scored.filter((r) => r.scores.applicability === 1 && r.scores.temporal_validity === 1)
    if (eligible.length > 0 && eligible.length < scored.length) {
      const ceiling = Number((Math.max(...eligible.map((r) => r.scores.fusion)) - 0.0001).toFixed(4))
      for (const r of scored) {
        if (r.scores.applicability === 1 && r.scores.temporal_validity === 1) continue
        r.scores.rank_limited = true // §11 explainability: why this row was held back
        if (r.scores.fusion > ceiling) r.scores.fusion = ceiling
      }
    }
  }

  // Phase 10 §28 — explicit-goal routing, the same sort-only discipline as
  // the Phase 4 guards above. An explicit goal is a DIRECTION the caller
  // states, not an authority claim, so it may reorder recall but it must
  // never touch `composite` or any lifecycle field: a goal cannot promote,
  // demote, validate, or resurrect anything.
  //
  // RRF alone cannot deliver this. `goal_affinity` enters fusion as one of
  // twelve channels, and RRF is rank-based, so a full one-position swing in
  // one channel moves `fusion` by roughly FUSION_WEIGHT × 1/(RRF_K + 1) —
  // about 0.001 — while the composite differences the goal is meant to
  // overrule routinely exceed that. Measured on a two-record pool where
  // both tie on ten of twelve channels: goal affinity 0.525 vs 0.262 and the
  // lower-affinity record still led, because its composite gap was ~3× the
  // entire reachable fusion term. So the goal leg gets its own sort key
  // ABOVE the query-signal tier, graded by affinity rather than binary: two
  // records can both carry goal signal and still differ, so a pass/fail band
  // would hand the decision straight back to composite. Records with no goal
  // signal never lead a goal-directed recall — a record that does not
  // mention the direction the caller stated is not an answer to it — but
  // they stay fully recallable, and within one affinity the normal
  // fusion/composite order is completely untouched.
  const goalKey = (r) => r.scores.goal_affinity || 0
  const hasGoalSignal = hasGoal && scored.some((r) => goalKey(r) > 0)

  // Primary: the fused score — composite plus the RRF consensus term
  // (identical to the capped composite whenever fusion is inactive, so the
  // legacy ordering is byte-identical). Secondary, on ties: the (possibly
  // capped) composite, then the pre-cap composite, so capped rows keep
  // their true relative order regardless of the order they entered
  // rankRecords. Records without the key fall back to their own composite,
  // so matching-polarity behaviour is byte-identical to before.
  const sortKey = (r) => r.scores.polarity_original_composite ?? r.scores.composite

  // Query-signal tier: for a non-empty query, a record with NO textual signal
  // (no FTS position, no substring, no shared token => relevance 0 AND
  // semantic 0) must not outrank any record that does match the query,
  // no matter how strong its metadata scores are. Without this, a
  // zero-signal record with perfect metadata (evidence 1.0, verified,
  // fresh, high confidence) composes ~0.75 and beats a genuine match that
  // has weak metadata — contamination by metadata alone.
  //
  // Like the polarity cap this is a SORT-ONLY constraint: no score is
  // mutated, so the dimensional breakdown stays verbatim and every
  // zero-signal record remains fully recallable (the recency pool is a
  // deliberate design: when NOTHING matches, all records share tier 0 and
  // the composite order — recency — is untouched). Empty query: no query
  // to have signal against, so the tier is inactive by construction.
  const signalTier = (r) => ((r.scores.relevance > 0 || r.scores.semantic > 0) ? 1 : 0)
  scored.sort((a, b) => {
    // Goal routing sits ABOVE the query-signal tier: the caller has stated
    // what they are trying to do, which is stronger evidence about what to
    // surface than the query's own token overlap. Inside one affinity the
    // ordering is untouched, so the goal decides the band, never the
    // order within it.
    if (hasGoalSignal) {
      const goalT = goalKey(b) - goalKey(a)
      if (goalT !== 0) return goalT
    }
    if (hasQuery) {
      const tier = signalTier(b) - signalTier(a)
      if (tier !== 0) return tier
    }
    return (b.scores.fusion - a.scores.fusion) || (b.scores.composite - a.scores.composite) || (sortKey(b) - sortKey(a))
  })
  return scored
}

// ---------------------------------------------------------------------------
// Near-duplicate suppression (top-K selection only).
//
// Evidence (probe p9): three wordings of one fact occupied 3 of 4 recall
// slots; nothing in the pipeline ever compared two selected records against
// each other. Threshold calibrated on probe p15 (8 same-fact rewordings vs
// 12 different-fact pairs, incl. same-topic pairs): containment >= 0.5 caught
// 6/8 rewordings with 0/12 false positives (max different-fact containment
// was 0.429), so 0.5 sits in the measured gap. containment =
// |A AND B| / min(|A|, |B|) — one claim being (mostly) a subset of the other,
// which is exactly what "redundant restatement" means; plain Jaccard cannot
// separate the classes (probe p13).
//
// Hard guards, each preserving a semantics this must never break:
//   - relation-connected pairs are never suppressed (contradiction pairs,
//     supersession chains, updates/derives all keep both sides visible);
//   - annotated contradiction partners are never suppressed;
//   - differing claim negation is never suppressed ("do X" vs "X" are
//     opposing statements, not duplicates — polarity semantics);
//   - fewer than 4 shared tokens never suppresses (short claims are too
//     coarse for containment to be meaningful).
//
// Suppression happens BEFORE the top-K slice so freed slots go to the next
// distinct record. It never mutates scores, never filters lifecycle states,
// and is deterministic: ranked order drives the greedy keep-first pass.
// ---------------------------------------------------------------------------
const REDUNDANCY_CONTAINMENT = 0.5
const REDUNDANCY_MIN_SHARED = 4

function sharesRelation(a, b) {
  for (const rel of a.relations || []) if (rel.targetId === b.id) return true
  for (const rel of b.relations || []) if (rel.targetId === a.id) return true
  if ((a.contradictions || []).includes(b.id)) return true
  if ((b.contradictions || []).includes(a.id)) return true
  return false
}

function suppressNearDuplicates(records) {
  const kept = []
  const keptTokens = []
  for (const rec of records) {
    const claim = claimText(rec)
    const tokens = tokenize(claim)
    let redundant = false
    for (let i = 0; i < kept.length && !redundant; i++) {
      const other = kept[i]
      if (sharesRelation(rec, other)) continue
      if (hasNegation(claim) !== hasNegation(claimText(other))) continue
      const otherTokens = keptTokens[i]
      const smaller = Math.min(tokens.size, otherTokens.size)
      if (smaller < REDUNDANCY_MIN_SHARED) continue
      let shared = 0
      for (const t of tokens) if (otherTokens.has(t)) shared++
      if (shared < REDUNDANCY_MIN_SHARED) continue
      if (shared / smaller >= REDUNDANCY_CONTAINMENT) redundant = true
    }
    if (!redundant) {
      kept.push(rec)
      keptTokens.push(tokens)
    }
  }
  return kept
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
/**
 * GOAL.md Phase 2 — negative-coverage tail budget. Matches the reference
 * dsh-memory `NEG_COVERAGE_MAX`: at most this many known-failed/unresolved
 * entries may surface per recall, and they always come last.
 */
export const NEG_COVERAGE_MAX = 3

/** Sentinel score for coverage entries (reference `NEG_COVERAGE_SCORE = 0.0`). */
export const NEG_COVERAGE_SCORE = 0

const COVERAGE_ZERO_SCORES = Object.freeze({
  composite: NEG_COVERAGE_SCORE,
  relevance: NEG_COVERAGE_SCORE,
  lexical: NEG_COVERAGE_SCORE,
  semantic: NEG_COVERAGE_SCORE,
  evidence_strength: NEG_COVERAGE_SCORE,
  validation_tier: NEG_COVERAGE_SCORE,
  scope_proximity: NEG_COVERAGE_SCORE,
  freshness_tier: NEG_COVERAGE_SCORE,
  confidence: NEG_COVERAGE_SCORE,
  intent_affinity: NEG_COVERAGE_SCORE,
  relationship: NEG_COVERAGE_SCORE,
  polarity_compatible: NEG_COVERAGE_SCORE,
  causal: NEG_COVERAGE_SCORE,
  rrf: NEG_COVERAGE_SCORE,
  fusion: NEG_COVERAGE_SCORE,
  goal_affinity: NEG_COVERAGE_SCORE,
})

/**
 * Known failed solutions / known open investigations (GOAL.md Phase 2).
 *
 * These records are deliberately NOT forward-scored: negative memory is
 * historical evidence, not a match to repeat (reference dsh-memory emits
 * them as zero-score tail entries after the primary cut, `_neg_tail`).
 * Matching here is simple term overlap against title+body — coverage,
 * not relevance — and they surface only on unified queries.
 */
function negativeCoverageTail({ projectStore, reusableStore, includeReusable, projectId, query, limit }) {
  const wanted = Math.min(NEG_COVERAGE_MAX, Math.max(0, limit))
  if (wanted === 0 || !query?.trim()) return []
  const fetch = Math.max(wanted * 4, 12)
  const pools = []
  if (projectStore) {
    pools.push(
      ...projectStore.list({ limit: fetch, kind: KINDS.NEGATIVE }).map((r) => [r, false]),
      ...projectStore.list({ limit: fetch, kind: KINDS.UNRESOLVED }).map((r) => [r, false]),
    )
  }
  if (includeReusable && reusableStore) {
    pools.push(
      ...reusableStore.list({ limit: fetch, kind: KINDS.NEGATIVE }).map((r) => [r, true]),
      ...reusableStore.list({ limit: fetch, kind: KINDS.UNRESOLVED }).map((r) => [r, true]),
    )
  }
  const seen = new Set()
  const matched = []
  for (const [rec, fromReusable] of pools) {
    if (!rec || seen.has(rec.id)) continue
    seen.add(rec.id)
    // Same lifecycle + scope isolation as the forward pool (addCandidate).
    if (!isLifecycleEligible(rec)) continue
    if (fromReusable) {
      if (rec.scope !== SCOPES.REUSABLE || rec.projectId === projectId) continue
    } else {
      if (rec.projectId !== projectId && rec.scope !== SCOPES.PROJECT) continue
    }
    const hits = tokenOverlap(query, `${rec.title || ''} ${rec.body || ''}`).hits
    if (hits <= 0) continue
    matched.push({ rec, hits })
  }
  matched.sort((a, b) => (
    b.hits - a.hits
    || String(b.rec.updatedAt || b.rec.createdAt || '').localeCompare(String(a.rec.updatedAt || a.rec.createdAt || ''))
    || String(a.rec.id).localeCompare(String(b.rec.id))
  ))
  return matched.slice(0, wanted).map(({ rec }) => ({
    ...rec,
    negativeCoverage: true,
    negLayer: rec.kind,
    scores: { ...COVERAGE_ZERO_SCORES },
  }))
}

export function hybridRetrieve({
  projectStore,
  reusableStore = null,
  query = '',
  limit = DEFAULT_RECALL_LIMIT,
  includeReusable = true,
  intent = null,
  kind = null,
  goal = null,
} = {}) {
  const detectedIntent = intent || detectIntent(query)
  // Phase 10 — an explicit goal is caller-supplied routing context, not a
  // stored fact: nothing here reads a goal layer, and with no goal the
  // ranking path is byte-identical to before.
  const activeGoal = String(goal ?? '').trim() ? goal : null
  if (limit === 0) return []
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
    // GOAL.md Phase 2: negative/unresolved never enter the forward-scored
    // pool on a unified query (reference treats them as coverage only);
    // an explicit kind query is the deliberate exception.
    if (!kind && (rec.kind === KINDS.NEGATIVE || rec.kind === KINDS.UNRESOLVED)) return
    if (!candidateMap.has(rec.id)) {
      candidateMap.set(rec.id, rec)
    }
  }

  for (const r of projectFtsHits) addCandidate(r, false)
  for (const r of reusableFtsHits) addCandidate(r, true)
  for (const r of projectRecent) addCandidate(r, false)
  for (const r of reusableRecent) addCandidate(r, true)

  const merged = Array.from(candidateMap.values())
  const ranked = annotateContradictions(rankRecords(merged, { query, intent: detectedIntent, preferProject: true, goal: activeGoal }))
  // Deduplicate before the top-K cut so freed slots go to the next distinct
  // record; contradiction extras and graph expansion below still see only
  // what survived, and both sides of a contradiction are relation-connected
  // so they can never be suppressed.
  const selected = suppressNearDuplicates(ranked)
  // GOAL.md Phase 2 — coverage tail: known-failed/unresolved entries are
  // appended after the primary cut and consume budget slots (reference
  // `_primary_slots` = max(0, k - n_tail)).
  const negTail = kind
    ? []
    : negativeCoverageTail({ projectStore, reusableStore, includeReusable, projectId, query, limit })
  const limited = selected.slice(0, Math.max(0, limit - negTail.length))
  const withCoverage = (base) => {
    if (negTail.length === 0) return base
    const baseIds = new Set(base.map((r) => r.id))
    return [...base, ...negTail.filter((r) => !baseIds.has(r.id))]
  }

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

  // 1-hop eligible neighbors (updates/extends/derives/supersedes). Bounded.
  const neighbors = expandEligibleNeighbors({
    projectStore,
    reusableStore,
    records: [...limited, ...extras],
    includeReusable,
  }).filter((rec) => !kind || rec.kind === kind)
  extras.push(...neighbors)

  if (extras.length === 0) return withCoverage(limited)
  return withCoverage(annotateContradictions(rankRecords([...limited, ...extras], { query, intent: detectedIntent, preferProject: true, goal: activeGoal })))
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
    const kindTag = rec.kind === KINDS.KNOWLEDGE
      ? ' [KNOWLEDGE]'
      : rec.kind === KINDS.NEGATIVE
        ? ' [NEGATIVE · known failed solution]'
        : rec.kind === KINDS.UNRESOLVED
          ? ' [UNRESOLVED · known open investigation]'
          : ''
    lines.push(`- [${rec.id}] (${scope}/${auth}/${rec.validation}/${rec.confidence}${ev}${contra})${kindTag} ${rec.title}`)
    // §24 — instruction-shaped remembered text is labeled at render time
    // (memory is evidence, never instructions). Warning only; nothing stored.
    const causalForScan = rec.source?.causal
    const warn = injectionWarning([
      rec.title,
      rec.body ?? '',
      causalForScan?.symptom ?? '',
      causalForScan?.rootCause ?? '',
      causalForScan?.remedy ?? '',
      causalForScan?.verifiedOutcome ?? '',
    ].join('\n'))
    if (warn) lines.push(`  • ${warn}`)
    if (rec.via?.type && rec.via.fromId) {
      lines.push(`  • via ${rec.via.type} ← [${rec.via.fromId}]`)
    }
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
