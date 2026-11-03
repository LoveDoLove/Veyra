/**
 * Veyra — explicit relationship recovery (Issue #3, Phase B).
 *
 * Issue #3 produced false `contradicts` edges: replacement wording in one
 * record was enough to classify another, unrelated record as a conflict, and
 * the edge was then persisted in BOTH directions by `linkConflict()`
 * (src/evolve.mjs). Promoting a canonical record does not repair the edge, so
 * a user needs an explicit, narrowly scoped way to detach ONE relationship.
 *
 * Design constraints taken from docs/issue-3-false-contradiction-edges.md:
 *
 *   - User-invoked only. Nothing here runs automatically, and nothing here
 *     infers intent: the caller names both endpoints and the relation type.
 *   - Narrow. Only `contradicts` is unlinkable. `supersedes` / `updates` /
 *     `extends` / `derives` carry lifecycle meaning and are repaired by their
 *     own commands (`/veyra supersede`, validation, etc.), not by this one.
 *   - Atomic. Both rows are rewritten inside one BEGIN IMMEDIATE transaction
 *     with the observed `relations` value as an exact SQL precondition. If
 *     either row moved, the whole transaction rolls back — there is no state in
 *     which only one side of a bidirectional edge is gone.
 *   - Non-destructive to everything else. Only the `relations` column of the
 *     two named records is written. Content, authority, validation, evidence,
 *     source/history, `created_at`, `updated_at` and `last_recalled_at` are
 *     byte-identical afterwards.
 *
 * Why raw SQL instead of `MemoryStore.put()`: put() routes through
 * normalizeRecord(), which restamps `updatedAt`, and `updatedAt` feeds
 * freshnessTier ranking. A relationship-only repair must not silently refresh
 * a record's ranking freshness. This mirrors the precedent in
 * src/migrate.mjs (see its "Why raw SQL instead of MemoryStore.put()" note).
 *
 * Why no `source.lifecycle` entry is appended: Phase B requires every field
 * other than the relationship to be preserved, and `source` is one of them.
 * The audit trail for this operation is the command's before/after output. A
 * caller that wants a durable trail should record it separately; that is a
 * stated limitation, not a silent omission.
 */

import { RELATIONS, VALID_RELATIONS } from './types.mjs'

/** Relationship types this operation is allowed to remove. */
export const UNLINKABLE_RELATIONS = Object.freeze([RELATIONS.CONTRADICTS])

/** Canonical usage string, shared by the command and its help text. */
export const UNLINK_USAGE = `/veyra unlink <id> ${RELATIONS.CONTRADICTS} <targetId> [why]`

/**
 * Read the raw serialized `relations` value for one row.
 *
 * @param {import('./store.mjs').MemoryStore} store
 * @param {string} id
 * @returns {{found: boolean, json: string|null, relations: Array|null}}
 */
function readRelations(store, id) {
  const row = store.db.prepare('SELECT relations FROM memory WHERE id = ?').get(id)
  if (!row) return { found: false, json: null, relations: null }
  const json = row.relations
  if (typeof json !== 'string') return { found: true, json: null, relations: null }
  let parsed
  try {
    parsed = JSON.parse(json)
  } catch {
    return { found: true, json, relations: null }
  }
  if (!Array.isArray(parsed)) return { found: true, json, relations: null }
  // Entries are kept verbatim (not re-shaped) so a rewrite cannot drop a field
  // this operation does not understand.
  for (const entry of parsed) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      return { found: true, json, relations: null }
    }
    if (typeof entry.type !== 'string' || typeof entry.targetId !== 'string') {
      return { found: true, json, relations: null }
    }
  }
  return { found: true, json, relations: parsed }
}

/** True when `relations` holds `type -> targetId`. */
function hasEdge(relations, type, targetId) {
  return relations.some((r) => r.type === type && r.targetId === targetId)
}

/** Copy of `relations` with every `type -> targetId` entry removed, order kept. */
function withoutEdge(relations, type, targetId) {
  return relations.filter((r) => !(r.type === type && r.targetId === targetId))
}

/**
 * Remove ONE `contradicts` relationship between two records, both directions,
 * atomically. Never touches any other field.
 *
 * @param {import('./store.mjs').MemoryStore} store store holding BOTH records
 * @param {{fromId?: string, relation?: string, targetId?: string, why?: string}} input
 * @returns {{
 *   ok: boolean, error?: string,
 *   relation?: string, fromId?: string, targetId?: string, why?: string,
 *   removed?: {forward: boolean, reciprocal: boolean},
 *   before?: {from: Array, target: Array},
 *   after?: {from: Array, target: Array},
 * }}
 */
export function unlinkRelation(store, input = {}) {
  const { fromId, targetId, why = '' } = input
  const relation = typeof input.relation === 'string' ? input.relation.trim().toLowerCase() : ''

  if (!store || !store.db) return { ok: false, error: 'no store available' }
  if (!fromId || !targetId) return { ok: false, error: `usage: ${UNLINK_USAGE}` }
  if (fromId === targetId) {
    return { ok: false, error: `refusing to unlink ${fromId} from itself` }
  }
  if (!relation) {
    return { ok: false, error: `usage: ${UNLINK_USAGE}` }
  }
  if (!UNLINKABLE_RELATIONS.includes(relation)) {
    const known = VALID_RELATIONS.includes(relation)
    const detail = known
      ? `\"${relation}\" is not an unlinkable relationship`
      : `unknown relationship type \"${relation}\"`
    return {
      ok: false,
      error: `${detail}; only ${UNLINKABLE_RELATIONS.join(', ')} can be unlinked`,
    }
  }

  // Both records must exist. A dangling endpoint is reported, never guessed.
  const from = readRelations(store, fromId)
  if (!from.found) return { ok: false, error: `record ${fromId} not found` }
  const target = readRelations(store, targetId)
  if (!target.found) return { ok: false, error: `record ${targetId} not found` }
  if (!from.relations || !target.relations) {
    const which = !from.relations ? fromId : targetId
    return {
      ok: false,
      error: `record ${which} has malformed relations; refusing to rewrite it`,
    }
  }

  const forward = hasEdge(from.relations, relation, targetId)
  const reciprocal = hasEdge(target.relations, relation, fromId)
  if (!forward && !reciprocal) {
    return { ok: false, error: `no ${relation} relationship between ${fromId} and ${targetId}` }
  }

  const nextFrom = forward ? withoutEdge(from.relations, relation, targetId) : from.relations
  const nextTarget = reciprocal ? withoutEdge(target.relations, relation, fromId) : target.relations

  const update = store.db.prepare('UPDATE memory SET relations = ? WHERE id = ? AND relations = ?')
  let started = false
  try {
    // BEGIN IMMEDIATE takes the write lock up front, closing the read→write
    // window; the per-row `relations` precondition catches any writer that got
    // in anyway, so a half-applied bidirectional removal is impossible.
    store.db.exec('BEGIN IMMEDIATE')
    started = true
    if (forward) {
      const r = update.run(JSON.stringify(nextFrom), fromId, from.json)
      if (r.changes !== 1) throw new Error(`precondition failed for ${fromId}`)
    }
    if (reciprocal) {
      const r = update.run(JSON.stringify(nextTarget), targetId, target.json)
      if (r.changes !== 1) throw new Error(`precondition failed for ${targetId}`)
    }
    store.db.exec('COMMIT')
    started = false
  } catch (err) {
    if (started) {
      try { store.db.exec('ROLLBACK') } catch { /* no active transaction */ }
    }
    const message = err instanceof Error ? err.message : String(err)
    return { ok: false, error: `unlink failed, nothing was changed: ${message}` }
  }

  return {
    ok: true,
    relation,
    fromId,
    targetId,
    why: typeof why === 'string' ? why.trim() : '',
    removed: { forward, reciprocal },
    before: { from: from.relations, target: target.relations },
    after: { from: nextFrom, target: nextTarget },
  }
}

/** Render a one-line relation list for command output. */
export function formatRelations(relations) {
  if (!Array.isArray(relations) || relations.length === 0) return '(none)'
  return relations.map((r) => `${r.type} -> ${r.targetId}`).join(', ')
}
