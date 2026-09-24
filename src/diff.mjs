/**
 * Veyra — how a new claim relates to existing memory.
 *
 * Adapted from Mnemon `Diff` (ADD / DUPLICATE / CONFLICT / UPDATE) using
 * Jaccard token overlap only. OpenViking merge_policy is the hard rule:
 * similarity identifies review candidates; it is never identity and
 * never permission to silently merge or drop a fact.
 */

import { jaccard, hasNegation, hasReplacementLanguage } from './text.mjs'

export const DIFF = Object.freeze({
  ADD: 'add',
  DUPLICATE: 'duplicate',
  CONFLICT: 'conflict',
  UPDATE: 'update',
})

function recordText(record) {
  if (!record) return ''
  return `${record.title || ''}\n${record.body || ''}`
}

function classify(tokenSim, newText, existingText) {
  if (tokenSim < 0.5) return DIFF.ADD

  const isExtension = newText.length > existingText.length + existingText.length / 4
  const polarityMismatch = hasNegation(newText) !== hasNegation(existingText)

  if (tokenSim > 0.9 && !isExtension) {
    return polarityMismatch ? DIFF.CONFLICT : DIFF.DUPLICATE
  }

  if (tokenSim >= 0.7) {
    if (hasReplacementLanguage(newText) || hasReplacementLanguage(existingText) || polarityMismatch) {
      return DIFF.CONFLICT
    }
  }

  if (tokenSim > 0.9 && !isExtension) {
    return polarityMismatch ? DIFF.CONFLICT : DIFF.DUPLICATE
  }
  return DIFF.UPDATE
}

/**
 * Compare `incoming` against `records`. Returns the strongest match and
 * an overall suggestion. Never merges records.
 */
export function diffMemory(incoming, records, { limit = 8 } = {}) {
  const newText = typeof incoming === 'string' ? incoming : recordText(incoming)
  const list = Array.isArray(records) ? records : []
  const matches = []
  for (const rec of list) {
    if (!rec || rec.forgotten) continue
    const existingText = recordText(rec)
    const similarity = jaccard(newText, existingText)
    if (similarity <= 0) continue
    matches.push({
      id: rec.id,
      record: rec,
      similarity,
      suggestion: classify(similarity, newText, existingText),
    })
  }
  matches.sort((a, b) => b.similarity - a.similarity)
  const top = matches.slice(0, Math.max(1, limit))
  let suggestion = DIFF.ADD
  if (top.length > 0) {
    suggestion = top[0].suggestion
    if (top.some((m) => m.suggestion === DIFF.DUPLICATE)) suggestion = DIFF.DUPLICATE
    else if (top.some((m) => m.suggestion === DIFF.CONFLICT) && suggestion !== DIFF.DUPLICATE) {
      suggestion = DIFF.CONFLICT
    }
  }
  return { suggestion, matches: top }
}

export function strongestMatch(diff, kind) {
  return (diff?.matches || []).find((m) => m.suggestion === kind) || null
}
