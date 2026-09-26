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

/**
 * Capture-template lines emitted by `distillBuffer` describe WHAT was touched,
 * not WHAT was asserted. Comparing them measures the capture template, not the
 * engineering fact, so they are excluded from claim comparison only.
 *
 * `Verified outcome:` is excluded because `testOutcomeFrom` can only ever emit
 * the fixed enum `test-passed` / `test-failed` — it carries no claim text.
 * `Symptom:` / `Root cause:` / `Remedy:` DO carry asserted content and are kept.
 *
 * Nothing is removed from the record: `evidence[]`, `source.files`,
 * `source.tools` and `source.symbols` remain byte-for-byte unchanged and are
 * used only as supporting subject evidence by `evolve.mjs`.
 */
const TEMPLATE_LINES = /^(Files touched|Tools|Symbols|Verified outcome|Agent)\s*:/i

/** Titles that only echo a path or a tool call carry no assertion. */
const TITLE_ECHO = /^(Worked on|Fix: work on|Used veyra_\w+)\b/i

function claimText(record) {
  if (typeof record === 'string') return record
  if (!record) return ''
  const kept = []
  for (const line of String(record.body || '').split('\n')) {
    const text = line.trim()
    if (!text || TEMPLATE_LINES.test(text)) continue
    kept.push(text)
  }
  const rawTitle = String(record.title || '').trim()
  const title = TITLE_ECHO.test(rawTitle) ? '' : rawTitle
  return [title, ...kept].filter(Boolean).join('\n')
}

function recordText(record) {
  return claimText(record)
}

function classify(tokenSim, newText, existingText) {
  const isExtension = newText.length > existingText.length + existingText.length / 4
  const polarityMismatch = hasNegation(newText) !== hasNegation(existingText)
  const replacementNew = hasReplacementLanguage(newText)
  const replacementExisting = hasReplacementLanguage(existingText)

  // Near-verbatim restatement, not a new fact and not an extension.
  if (tokenSim > 0.9 && !isExtension) {
    return polarityMismatch ? DIFF.CONFLICT : DIFF.DUPLICATE
  }

  // Semantic signals are read BEFORE the lexical floor. A low token overlap
  // only proves different wording — it cannot prove irrelevance, and it is
  // exactly what an explicit replacement looks like.
  if (polarityMismatch) return DIFF.CONFLICT
  if (replacementNew || replacementExisting) return DIFF.CONFLICT

  if (tokenSim < 0.5) return DIFF.ADD
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
    // Zero lexical overlap must not discard the pair outright: an explicit
    // replacement ("switched from X to Y") is defined by differing words.
    // Pairs with no claim text on either side have nothing to relate.
    if (similarity <= 0 && (!newText.trim() || !existingText.trim())) continue
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

/**
 * Directional replacement evidence: the incoming claim states a replacement
 * the older one does not. Symmetric markers ("never") are polarity, not
 * replacement, so requiring the asymmetry is what keeps a plain polarity flip
 * from ever authorizing a lifecycle change.
 */
export function replacementEvidence(record) {
  return hasReplacementLanguage(claimText(record))
}

/**
 * Subject compatibility, derived ONLY from stored provenance. Supporting
 * evidence for a lifecycle decision — it never contributes to claim
 * similarity and can never by itself produce an UPDATE.
 */
export function sharesSubject(a, b) {
  const paths = (record) => {
    const out = new Set()
    for (const item of record?.evidence || []) {
      if (item && typeof item.path === 'string' && item.path) out.add(item.path)
    }
    for (const item of record?.source?.files || []) {
      if (typeof item === 'string' && item) out.add(item)
    }
    return out
  }
  const left = paths(a)
  const right = paths(b)
  if (!left.size || !right.size) return false
  for (const path of left) if (right.has(path)) return true
  return false
}
