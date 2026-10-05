/**
 * Veyra — memory lifecycle: forgetting with history, and protection (§22, §23).
 *
 * Adapted from dsh-memory `md_cg/protect.py`:
 *   - `guard_forget` → forgetting or tombstoning a protected record requires
 *     an explicit `override`, and the override reason is recorded (a guard
 *     without an audit trail is a black box — 保护不等于黑箱).
 *   - `mark` → an explicit, reasoned protection flag on one record.
 *   - the separate audit file becomes an in-record trail: every retirement
 *     action appends `{action, at, why, …}` to `source.lifecycle`.
 *
 * §22 — forgetting is not unconditional deletion. Where appropriate we
 * preserve: what was invalidated, when, why, what contradicted it, what
 * replaced it. Obsolete knowledge leaves active retrieval (the recall gate
 * in types.mjs drops forgotten / non-current / invalid records) while its
 * lifecycle history stays inspectable.
 *
 * §23 — protection is selective and must NOT override repository truth,
 * a verified contradiction, security requirements, or an invalid state:
 * a protected record can still be invalidated or superseded, so only the
 * retirement-without-a-truth-claim actions (forget, tombstone) are guarded.
 * Canonical authority is implicitly protected — it only exists because a
 * user asked for it explicitly, so removing it must be explicit too.
 */

import { AUTHORITIES, RELATIONS, STATUSES, VALIDATIONS } from './types.mjs'

/** Bounded per-record lifecycle trail — oldest entries roll off. */
const LIFECYCLE_MAX = 10

/** Protection reason / lifecycle why are recorded, unbounded input is not. */
const MAX_REASON_CHARS = 300

function nowIso() {
  return new Date().toISOString()
}

function reasonText(value) {
  return String(value ?? '').trim().slice(0, MAX_REASON_CHARS)
}

function shortId(value) {
  return String(value ?? '').trim().slice(0, 64)
}

/**
 * Append one bounded lifecycle entry to a copy of the record's source bag.
 *
 * @param {object} record    current record (read from the store)
 * @param {string} action    protect | unprotect | invalidate | supersede |
 *                           tombstone | forget
 * @param {object} fields    why / contradictedBy / replacedBy, already shaped
 * @returns {object} a new `source` bag carrying the appended trail
 */
function withLifecycle(record, action, fields = {}) {
  const source = { ...(record.source || {}) }
  const prior = Array.isArray(source.lifecycle) ? source.lifecycle : []
  source.lifecycle = [...prior, { action, at: nowIso(), ...fields }].slice(-LIFECYCLE_MAX)
  return source
}

function entryText(fields) {
  const parts = []
  if (fields.why) parts.push(fields.why)
  if (fields.contradictedBy) parts.push(`contradicted by ${fields.contradictedBy}`)
  if (fields.replacedBy) parts.push(`replaced by ${fields.replacedBy}`)
  return parts.join(' · ')
}

/**
 * Write a lifecycle-touched record back.
 *
 * Lifecycle actions never change authority, but normalizeRecord requires
 * `explicitCanonical` for ANY write whose authority is canonical
 * (assertAuthorityTransition throws when `to === CANONICAL && !explicit`).
 * Passing the flag for an unchanged canonical record asserts "explicit user
 * action, no auto-promotion" — the invariant's actual intent.
 *
 * @param {object} store   project or ephemeral store
 * @param {object} record  full record to persist
 * @returns {object} the stored record
 */
function putResult(store, record) {
  const opts = record.authority === AUTHORITIES.CANONICAL ? { explicitCanonical: true } : {}
  return store.put(record, opts).record
}

/**
 * Is this record protected from forgetting?
 *
 * Two tiers, mirroring dsh-memory's layered guards:
 *   1. explicit mark — `source.protection.protected === true` with a reason
 *   2. implicit — canonical authority (user-granted project truth)
 *
 * An explicit unprotect mark cannot lift the canonical tier; demoting the
 * authority is the way to make such a record forgettable.
 *
 * @param {object|null} record
 * @returns {{protected: boolean, why: string|null}}
 */
export function protectionOf(record) {
  if (!record) return { protected: false, why: null }
  const mark = record.source?.protection
  if (record.authority === AUTHORITIES.CANONICAL) {
    return {
      protected: true,
      why: (mark?.protected === true && mark.why) || 'canonical authority',
    }
  }
  if (mark?.protected === true) return { protected: true, why: mark.why || 'explicit protection' }
  return { protected: false, why: null }
}

/**
 * Explicitly protect a record against forgetting (§23).
 * Protection is recorded with its reason — selective, auditable, reversible.
 *
 * @returns {{ok: true, record: object} | {ok: false, error: string}}
 */
export function protect(store, id, { reason = '' } = {}) {
  const record = store.get(id)
  if (!record) return { ok: false, error: 'not found' }
  const whyText = reasonText(reason)
  const source = withLifecycle(record, 'protect', whyText ? { why: whyText } : {})
  source.protection = { protected: true, at: nowIso(), why: whyText }
  return { ok: true, record: putResult(store, { ...record, source }) }
}

/**
 * Remove the explicit protection mark. Canonical records stay protected by
 * authority — `stillProtected` says so instead of pretending the write landed
 * fully.
 *
 * @returns {{ok: true, record: object, stillProtected: boolean} | {ok: false, error: string}}
 */
export function unprotect(store, id, { reason = '' } = {}) {
  const record = store.get(id)
  if (!record) return { ok: false, error: 'not found' }
  const source = withLifecycle(record, 'unprotect', { why: reasonText(reason) })
  source.protection = { protected: false, at: nowIso(), why: reasonText(reason) }
  const next = putResult(store, { ...record, source })
  return { ok: true, record: next, stillProtected: protectionOf(next).protected }
}

/**
 * Mark a record's validation invalid (§22). Not guarded by protection — a
 * protected memory can still become invalid (§23), because invalidity is a
 * truth claim, not an administrative retirement.
 *
 * The entry records when, why, what contradicted it (contradictedBy) and
 * what replaced it (replacedBy) — the §22 "preserve" list.
 *
 * @returns {{ok: true, record: object, already?: true} | {ok: false, error: string}}
 */
export function invalidate(store, id, { why = '', contradictedBy = '', replacedBy = '' } = {}) {
  const record = store.get(id)
  if (!record) return { ok: false, error: 'not found' }
  if (record.validation === VALIDATIONS.INVALID) return { ok: true, record, already: true }
  const fields = {}
  const whyText = reasonText(why)
  const contradicted = shortId(contradictedBy)
  const replaced = shortId(replacedBy)
  if (whyText) fields.why = whyText
  if (contradicted) fields.contradictedBy = contradicted
  if (replaced) fields.replacedBy = replaced
  const source = withLifecycle(record, 'invalidate', fields)
  return { ok: true, record: putResult(store, { ...record, validation: VALIDATIONS.INVALID, source }) }
}

/**
 * Explicitly retire a record in favour of a replacement (§22 "what replaced
 * it"). Not guarded by protection — a protected memory can still be
 * superseded (§23), and the automatic path in evolve.mjs is unguarded too.
 *
 * Direction follows the M1 contract: retired --supersedes--> replacement,
 * exactly one such edge on the retired record, none on the replacement.
 *
 * @returns {{ok: true, record: object, already?: true} | {ok: false, error: string}}
 */
export function supersede(store, fromId, toId, { why = '' } = {}) {
  const from = store.get(fromId)
  if (!from) return { ok: false, error: 'not found' }
  if (!toId || toId === fromId) return { ok: false, error: 'replacement must be a different record' }
  const to = store.get(toId)
  if (!to) return { ok: false, error: 'replacement not found' }
  const relations = Array.isArray(from.relations) ? [...from.relations] : []
  const linked = relations.some((r) => r?.type === RELATIONS.SUPERSEDES && r?.targetId === toId)
  if (from.status === STATUSES.SUPERSEDED && linked) return { ok: true, record: from, already: true }
  if (!linked) relations.push({ type: RELATIONS.SUPERSEDES, targetId: toId })
  const whyText = reasonText(why)
  const source = withLifecycle(from, 'supersede', whyText ? { why: whyText, replacedBy: toId } : { replacedBy: toId })
  return { ok: true, record: putResult(store, { ...from, status: STATUSES.SUPERSEDED, relations, source }) }
}

/**
 * Guarded retirement with history (§22). Protected records need
 * `override: true`; the guard message names the reason protection applies.
 *
 * @returns {{ok: true, record: object} | {ok: false, error: string}}
 */
function guardedRetire(store, id, { action, why, override }) {
  const record = store.get(id)
  if (!record) return { ok: false, error: 'not found' }
  const guard = protectionOf(record)
  if (guard.protected && !override) {
    return { ok: false, error: `protected (${guard.why}) — ${action} requires override with a reason` }
  }
  return { ok: true, record, guard }
}

/**
 * Soft-forget a record: it leaves active recall but stays inspectable, and
 * the reason is preserved in `source.lifecycle`.
 *
 * @returns {{ok: true, record: object} | {ok: false, error: string}}
 */
export function forget(store, id, { why = '', override = false } = {}) {
  const check = guardedRetire(store, id, { action: 'forget', why, override })
  if (!check.ok) return check
  const { record } = check
  const whyText = reasonText(why)
  const source = withLifecycle(record, 'forget', whyText ? { why: whyText } : {})
  putResult(store, { ...record, source })
  return { ok: true, record: store.forget(id) }
}

/**
 * Tombstone a record: retire it to `historical` — visible in the store as a
 * lifecycle artifact, out of active recall (status ≠ current fails the recall
 * gate), with the reason preserved. Content is never destroyed.
 *
 * @returns {{ok: true, record: object, already?: true} | {ok: false, error: string}}
 */
export function tombstone(store, id, { why = '', override = false } = {}) {
  const check = guardedRetire(store, id, { action: 'tombstone', why, override })
  if (!check.ok) return check
  const { record } = check
  if (record.status === STATUSES.HISTORICAL) return { ok: true, record, already: true }
  const whyText = reasonText(why)
  const source = withLifecycle(record, 'tombstone', whyText ? { why: whyText } : {})
  return { ok: true, record: putResult(store, { ...record, status: STATUSES.HISTORICAL, source }) }
}
