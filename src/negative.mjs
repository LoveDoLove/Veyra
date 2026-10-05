/**
 * Veyra — negative & unresolved memory writers (GOAL.md Phase 2, §8/§9).
 *
 * Ported from dsh-memory (灵枢 LINGSHU v0.7.2, MIT) `md_cg/mdcg.py`:
 *   - `add_rejected`          → `addRejected`  (known failed approach)
 *   - `add_unresolved`        → `addUnresolved` (known open investigation)
 *   - `_ticket_slug`          → `ticketSlug`
 *   - `_refresh_unresolved`   → the re-render path inside `addUnresolved`
 *   - `md_cg/tasks.py:81 slugify` → `slugify`
 *
 * Adaptations from the Python original:
 *   - sha1 → sha256 (`ids.mjs` is sha256-only; same [:10] truncation).
 *   - importance 0.0 / 0.3 → confidence LOW (Veyra has no importance field;
 *     both sit below the medium threshold of the reference scale).
 *   - Layer names (`rejected` / `unresolved`) → kinds
 *     (`KINDS.NEGATIVE` / `KINDS.UNRESOLVED`); front-matter → store fields.
 *
 * Invariants (GOAL.md §8/§9):
 *   - Negative memory is historical evidence — always DERIVED, never
 *     canonical. These writers never take an authority argument.
 *   - Repeated falsification of the same hypothesis is idempotent
 *     (`rej_` id, existing record returned untouched).
 *   - An unresolved investigation keeps its identity across rewording:
 *     same slug → same `unr_` id, body re-rendered in place, createdAt
 *     preserved. Re-retrieval never promotes it to canonical.
 */
import { AUTHORITIES, CONFIDENCES, KINDS, STATUSES, VALIDATIONS } from './types.mjs'
import { sha256Hex } from './ids.mjs'

/** Reference `_ILLEGAL_RE` (tasks.py:76) — filename-safe folding only, no semantics. */
const ILLEGAL_RE = /[^0-9A-Za-z一-鿿_.-]+/g

/**
 * Port of `md_cg/tasks.py:81 slugify`.
 *
 * Only normalization that is safe for file names: path separators and
 * illegal characters fold to `-`, runs of `-` collapse, trim `-.` ends.
 * Deliberately NO semantic rewriting (no translation, no stopword
 * removal) — the slug is an externally visible identity.
 *
 * @param {string} name
 * @returns {string} '' when the name carries no usable identity
 */
export function slugify(name) {
  let s = String(name ?? '').trim()
  if (!s) return ''
  s = s.replace(/\//g, '-').replace(/\\/g, '-').replace(/\.\./g, '-')
  s = s.replace(ILLEGAL_RE, '-')
  s = s.replace(/-{2,}/g, '-').replace(/^[-.]+|[-.]+$/g, '')
  s = s.slice(0, 64)
  return s.replace(/^[-.]+|[-.]+$/g, '')
}

/**
 * Port of `mdcg.py:_ticket_slug` — identity text is the topic when it has
 * one, else the question; whitespace folds to single spaces (so the same
 * ticket with different line wrapping keeps its identity), then slugify.
 */
export function ticketSlug(question, topic) {
  const identity = (topic && String(topic).trim()) ? topic : (question ?? '')
  return slugify(String(identity).split(/\s+/).filter(Boolean).join(' '))
}

function negativeSource(extra = {}) {
  return { tool: 'veyra_remember', automatic: false, ...extra }
}

/**
 * Port of `mdcg.py:2779 add_rejected` — record a falsified hypothesis.
 *
 * Identity = `rej_` + sha1(hypothesis)[:10] (here sha256): idempotent by
 * construction — the same hypothesis cannot be re-falsified into a second
 * record, and an existing rejection is returned untouched (no rewrite).
 *
 * @returns {{record: object, created: boolean, duplicate: boolean, redacted?: boolean}}
 */
export function addRejected(
  store,
  hypothesis,
  reason,
  {
    verificationBasis = 'test',
    tags = [],
    evidence = undefined,
    confidence = CONFIDENCES.LOW,
    scope = undefined,
    projectId = undefined,
    source = undefined,
  } = {},
) {
  const id = `rej_${sha256Hex(String(hypothesis ?? '')).slice(0, 10)}`
  const existing = store.get(id)
  // Idempotent falsification: the record of a refuted hypothesis never
  // changes once written (reference returns the existing node id as-is).
  if (existing) return { record: existing, created: false, duplicate: true }
  return store.put({
    id,
    kind: KINDS.NEGATIVE,
    title: String(hypothesis ?? ''),
    body: [
      `Hypothesis: ${hypothesis}`,
      `Rejected because: ${reason || '(no reason recorded)'}`,
      `Verification basis: ${verificationBasis}`,
    ].join('\n'),
    authority: AUTHORITIES.DERIVED, // §8: historical evidence, never canonical
    status: STATUSES.CURRENT,
    validation: verificationBasis === 'test' ? VALIDATIONS.VERIFIED : VALIDATIONS.UNVERIFIED,
    confidence,
    tags: [...new Set(['negative', ...tags].filter(Boolean))].slice(0, 24),
    evidence,
    scope,
    projectId,
    source: source && typeof source === 'object' ? source : negativeSource(),
  })
}

/**
 * Port of `mdcg.py:2810 add_unresolved` — record an open investigation.
 *
 * Identity = `unr_` + ticket slug (topic truth-value else question), so a
 * reworded-but-same investigation refreshes its body in place instead of
 * forking a new ticket (reference `_refresh_unresolved`: fm/id/created_at
 * untouched, body-only rewrite, zero write when the render is unchanged).
 *
 * @returns {{record: object, created: boolean, duplicate: boolean, redacted?: boolean}}
 */
export function addUnresolved(
  store,
  question,
  {
    knownClues = '',
    goal = '',
    context = '',
    topic = null,
    verificationBasis = 'data',
    tags = [],
    evidence = undefined,
    confidence = CONFIDENCES.LOW,
    scope = undefined,
    projectId = undefined,
    source = undefined,
  } = {},
) {
  const slug = ticketSlug(question, topic)
  const id = slug
    ? `unr_${slug}`
    : `unr_${sha256Hex(String(question ?? '')).slice(0, 10)}`
  const render = () => [
    `Question: ${question}`,
    `Known clues: ${knownClues || '(none)'}`,
    context ? `Context: ${context}` : null,
    `Goal: ${goal || '(not set)'}`,
    `Verification basis: ${verificationBasis}`,
  ].filter(Boolean).join('\n')

  const existing = store.get(id)
  if (existing) {
    const body = render()
    // Zero-write when nothing changed (reference: same text → False, no write).
    if (existing.body === body) return { record: existing, created: false, duplicate: true }
    // Re-render in place: same id, createdAt preserved by normalizeRecord,
    // updatedAt restamped, metadata/relations kept.
    return store.put({ ...existing, body })
  }
  return store.put({
    id,
    kind: KINDS.UNRESOLVED,
    title: String(question ?? ''),
    body: render(),
    authority: AUTHORITIES.DERIVED, // §9: never canonical via retrieval
    status: STATUSES.CURRENT,
    validation: VALIDATIONS.UNVERIFIED, // the investigation is open by definition
    confidence,
    tags: [...new Set(['unresolved', ...tags].filter(Boolean))].slice(0, 24),
    evidence,
    scope,
    projectId,
    source: source && typeof source === 'object' ? source : negativeSource(),
  })
}
