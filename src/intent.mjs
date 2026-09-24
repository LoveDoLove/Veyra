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
})

const WHY_RE = /\b(why|reason|because|cause|motivation|rationale|root cause)\b|为什么|為什麼|原因|理由/i
const WHEN_RE = /\b(when|timeline|time|date|before|after|during|history|sequence|last time)\b|什么时候|什麼時候|何时|時間|之前|之后/i
const HOW_RE = /\b(how (?:did|do|to|should|can)|how we|lock|serialize|workaround|fix pattern)\b|怎么|如何/i
const ENTITY_RE = /\b(what is|who is|tell me about|describe|about)\b|是什么|是什麼|谁是|关于|介绍/i

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
  const hits = [
    [INTENTS.WHY, why],
    [INTENTS.WHEN, when],
    [INTENTS.HOW, how],
    [INTENTS.ENTITY, entity],
  ].filter(([, n]) => n > 0)
  if (hits.length === 0) return INTENTS.GENERAL
  if (hits.length > 1) {
    // "why / how did we lock" is a how-to with a causal flavour — prefer HOW
    // when both HOW and WHY fire, otherwise stay GENERAL.
    if (how && why && !when && !entity) return INTENTS.HOW
    if (hits.length > 1) return INTENTS.GENERAL
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
    default:
      return {}
  }
}

/**
 * Prefer records whose tags/source/title match the detected intent.
 * Returns a 0–1 boost, never a veto.
 */
export function intentAffinity(record, intent) {
  if (!record || intent === INTENTS.GENERAL) return 0
  const hay = `${record.title || ''}\n${(record.tags || []).join(' ')}\n${record.source?.signal || ''}`.toLowerCase()
  if (intent === INTENTS.WHY) {
    return /root-cause|cause|reason|why|rationale/.test(hay) ? 0.12 : 0
  }
  if (intent === INTENTS.HOW) {
    return /fix|workaround|edited|tested|serialize|lock/.test(hay) ? 0.12 : 0
  }
  if (intent === INTENTS.WHEN) {
    return /history|timeline|last time|when/.test(hay) ? 0.08 : 0
  }
  if (intent === INTENTS.ENTITY) {
    return /architecture|constraint|decision/.test(hay) ? 0.08 : 0
  }
  return 0
}
