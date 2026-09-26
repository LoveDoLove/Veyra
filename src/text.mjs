/**
 * Veyra — lexical helpers.
 *
 * Adapted from Mnemon `internal/memory/search/keyword.go` (Tokenize,
 * JaccardSimilarity, stopwords). No embeddings: token overlap is the
 * only similarity signal, and similarity is never identity.
 */

export const STOPWORDS = new Set([
  'a', 'an', 'the', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
  'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could',
  'should', 'may', 'might', 'shall', 'can', 'to', 'of', 'in', 'for',
  'on', 'with', 'at', 'by', 'from', 'as', 'into', 'about', 'that',
  'this', 'it', 'its', 'or', 'and', 'but', 'if', 'not', 'no', 'so',
  'up', 'out', 'than', 'then', 'too', 'very', 'just', 'also', 'more',
  'some', 'any', 'all', 'each', 'i', 'me', 'my', 'we', 'you', 'your',
  'he', 'she', 'they', 'them', 'his', 'her', 'our', 'their', 'what',
  'which', 'who', 'how', 'when', 'where', 'why',
])

const LATIN_TOKEN = /[a-z0-9_]{2,}/g
const HAN_RUN = /[\u4e00-\u9fff]+/g

/**
 * Lowercase token set with English stopwords removed.
 * CJK runs become character bigrams (Mnemon `flushCJK`).
 */
export function tokenize(text) {
  const tokens = new Set()
  const lower = String(text || '').toLowerCase()
  const words = lower.match(LATIN_TOKEN) || []
  for (const word of words) {
    if (!STOPWORDS.has(word)) tokens.add(word)
  }
  const hans = lower.match(HAN_RUN) || []
  for (const run of hans) {
    if (run.length === 1) tokens.add(run)
    else {
      for (let i = 0; i < run.length - 1; i++) tokens.add(run.slice(i, i + 2))
    }
  }
  return tokens
}

/** Jaccard |A∩B| / |A∪B|. 0 when either side tokenizes to empty. */
export function jaccard(a, b) {
  const ta = tokenize(a)
  const tb = tokenize(b)
  if (ta.size === 0 || tb.size === 0) return 0
  let intersection = 0
  for (const token of ta) {
    if (tb.has(token)) intersection++
  }
  const union = ta.size + tb.size - intersection
  return union === 0 ? 0 : intersection / union
}

export function tokenOverlap(a, b) {
  const ta = tokenize(a)
  const tb = tokenize(b)
  if (ta.size === 0 || tb.size === 0) return { hits: 0, ratio: 0 }
  let hits = 0
  for (const token of tb) {
    if (ta.has(token)) hits++
  }
  return { hits, ratio: hits / tb.size }
}

/**
 * Explicit negation in the raw text. Stopwords strip "not"/"no", so
 * polarity must be read from the original string (Mnemon `hasNegation`).
 *
 * Polarity is NOT replacement. "never use X" is a polarity claim about X;
 * only a directional phrase ("switched from X to Y") can claim that one
 * value replaced another.
 */
const NEGATION_MARKERS = /(^|[^a-z0-9_])(not|no|never|cannot|without|none)([^a-z0-9_]|$)|n['’]t([^a-z0-9_]|$)/i

export function hasNegation(text) {
  return NEGATION_MARKERS.test(String(text || ''))
}

const REPLACEMENT_PHRASES = [
  // Directional replacement only. Plain negation (not / no / never) is polarity
  // evidence and must never, on its own, prove that a claim replaces another.
  'switched from', 'moved from', 'replaced', 'instead of', 'rather than',
  'no longer', 'in favor of', 'deprecated',
  '不再', '取代', '替换为', '改为', '切换到', '放弃',
]

export function hasReplacementLanguage(text) {
  const lower = String(text || '').toLowerCase()
  return REPLACEMENT_PHRASES.some((phrase) => lower.includes(phrase))
}
