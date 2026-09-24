/**
 * Veyra — query intent.
 *
 * Adapted from Mnemon `DetectIntent` (WHY / WHEN / ENTITY / GENERAL).
 * Intent only reweights ranking; it never grants authority. Similarity
 * remains a retrieval hint, not identity (OpenViking merge_policy).
 */

export const INTENTS = Object.freeze({
  WHY: 'why',
  WHEN: 'when',
  HOW: 'how',
  ENTITY: 'entity',
  GENERAL: 'general',
  OUTCOME: 'outcome',
  SYMPTOM: 'symptom',
})

const WHY_RE = /\b(why|reason|because|cause|motivation|rationale|root cause)\b|为什么|為什麼|原因|理由/i
const WHEN_RE = /\b(when|timeline|time|date|before|after|during|history|sequence|last time)\b|什么时候|什麼時候|何时|時間|之前|之后/i
const HOW_RE = /\b(how (?:did|do|to|should|can)|how we|lock|serialize|workaround|fix pattern)\b|怎么|如何/i
const ENTITY_RE = /\b(what is|who is|tell me about|describe|about)\b|是什么|是什麼|谁是|关于|介绍/i
const OUTCOME_RE = /\b(did (?:this|it) fix|is (?:it|this) fixed|did (?:the )?tests? pass|was (?:it|this) resolved|was (?:it|this) verified|verified outcome)\b/i
const SYMPTOM_RE = /\b(what happened|what broke|what failed|what went wrong|symptom)\b/i

function score(re, text) {
  return re.test(text) ? 1 : 0
}

/**
 * Bounded lexical intent. Conflicting cues fall back to GENERAL.
 */
export function detectIntent(query) {
  const text = String(query || '')
  if (!text.trim()) return INTENTS.GENERAL
  const why = score(WHY_RE, text)
  const when = score(WHEN_RE, text)
  const how = score(HOW_RE, text)
  const entity = score(ENTITY_RE, text)
  const outcome = score(OUTCOME_RE, text)
  const symptom = score(SYMPTOM_RE, text)
  const hits = [
    [INTENTS.WHY, why],
    [INTENTS.WHEN, when],
    [INTENTS.HOW, how],
    [INTENTS.ENTITY, entity],
    [INTENTS.OUTCOME, outcome],
    [INTENTS.SYMPTOM, symptom],
  ].filter(([, n]) => n > 0)
  if (hits.length === 0) return INTENTS.GENERAL
  if (hits.length > 1) {
    if (outcome && !entity) return INTENTS.OUTCOME
    if (symptom && !entity) return INTENTS.SYMPTOM
    // "why / how did we lock" is a how-to with a causal flavour — prefer HOW
    // when both HOW and WHY fire, otherwise stay GENERAL.
    if (how && why && !when && !entity) return INTENTS.HOW
    return INTENTS.GENERAL
  }
  return hits[0][0]
}

/**
 * Extra ranking weights applied on top of the 6-D base weights.
 * Values are small on purpose so intent cannot drown evidence/authority.
 */
export function intentWeights(intent) {
  switch (intent) {
    case INTENTS.WHY:
      return { relevance: 0.36, evidence: 0.16, validation: 0.16, freshness: 0.06, confidence: 0.12 }
    case INTENTS.WHEN:
      return { freshness: 0.16, relevance: 0.28, evidence: 0.14 }
    case INTENTS.HOW:
      return { evidence: 0.24, relevance: 0.34, validation: 0.16, confidence: 0.12 }
    case INTENTS.ENTITY:
      return { relevance: 0.38, proximity: 0.16, evidence: 0.14 }
    case INTENTS.OUTCOME:
      return { relevance: 0.28, evidence: 0.24, validation: 0.24, confidence: 0.14, freshness: 0.10 }
    case INTENTS.SYMPTOM:
      return { relevance: 0.34, evidence: 0.22, validation: 0.16, freshness: 0.14, confidence: 0.14 }
    default:
      return {}
  }
}

/**
 * Prefer records whose tags/source/title/causal facets match the detected intent.
 * Returns a 0–1 boost, never a veto.
 */
export function intentAffinity(record, intent) {
  if (!record || intent === INTENTS.GENERAL) return 0
  const hay = `${record.title || ''}\n${(record.tags || []).join(' ')}\n${record.source?.signal || ''}`.toLowerCase()
  const causal = record.source?.causal || {}

  if (intent === INTENTS.WHY) {
    if (causal.rootCause || causal.symptom) return 0.16
    return /root-cause|cause|reason|why|rationale/.test(hay) ? 0.12 : 0
  }
  if (intent === INTENTS.HOW) {
    if (causal.remedy) return 0.16
    return /fix|workaround|edited|tested|serialize|lock/.test(hay) ? 0.12 : 0
  }
  if (intent === INTENTS.OUTCOME) {
    if (causal.verifiedOutcome === 'test-passed') return 0.18
    if (causal.verifiedOutcome) return 0.12
    return /verified-test|pass/.test(hay) ? 0.10 : 0
  }
  if (intent === INTENTS.SYMPTOM) {
    if (causal.symptom || causal.verifiedOutcome) return 0.16
    return /symptom|fail|broke|error|issue/.test(hay) ? 0.12 : 0
  }
  if (intent === INTENTS.WHEN) {
    return /history|timeline|last time|when/.test(hay) ? 0.08 : 0
  }
  if (intent === INTENTS.ENTITY) {
    return /architecture|constraint|decision/.test(hay) ? 0.08 : 0
  }
  return 0
}
