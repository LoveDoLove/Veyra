/**
 * Veyra — knowledge evolution without silent merge.
 *
 * Adapted from:
 *   - Mnemon Diff + supersedes demotion
 *   - PMA contradiction banners (never resolve silently)
 *   - OpenViking merge_policy (similarity ≠ identity)
 *
 * Automatic evolution may:
 *   - link records (extends / updates / contradicts / supersedes)
 *   - mark an older derived record superseded ONLY on independent evidence:
 *     a directional replacement claim, absent from the older claim, about a
 *     subject both records share
 *   - mark a record stale when it has sat unused past a threshold
 *
 * Automatic evolution may never:
 *   - assign canonical authority
 *   - delete or merge two records into one
 *   - hide one side of a contradiction
 *   - supersede on similarity alone (Similarity ≠ Authority)
 */

import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { AUTHORITIES, RELATIONS, STATUSES, VALIDATIONS } from './types.mjs'
import { DIFF, diffMemory, replacementEvidence, sharesSubject, strongestMatch } from './diff.mjs'

const STALE_AFTER_MS = 120 * 86_400_000

function uniqueRelations(list) {
  const seen = new Set()
  const out = []
  for (const rel of list || []) {
    if (!rel || !rel.type || !rel.targetId) continue
    const key = `${rel.type}:${rel.targetId}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push({ type: rel.type, targetId: rel.targetId })
  }
  return out.slice(0, 32)
}

function withRelation(record, type, targetId) {
  return uniqueRelations([...(record.relations || []), { type, targetId }])
}

/**
 * Supersede eligibility — independent of how a pair was classified.
 *
 * A lifecycle change requires ALL of:
 *   - the incoming claim states a directional replacement the older one does not
 *   - both records are about a subject they demonstrably share
 *   - the existing authority/lifecycle guards allow it
 *
 * CONFLICT classification is never itself evidence: a plain polarity flip
 * reaches `false` here and therefore never supersedes.
 */
function supersedeEligible(incoming, neighbor) {
  if (!incoming || !neighbor) return false
  if (neighbor.authority === AUTHORITIES.CANONICAL) return false
  if (neighbor.status !== STATUSES.CURRENT) return false
  if (incoming.authority === AUTHORITIES.CANDIDATE) return false
  if (!incoming.id || incoming.id === neighbor.id) return false
  return replacementEvidence(incoming) && !replacementEvidence(neighbor) && sharesSubject(incoming, neighbor)
}

/**
 * Link a conflicting neighbor back to the incoming record, and — only when the
 * independent gate agrees — retire it in the same single write, so the
 * contradicts edge survives alongside the supersede. Best-effort.
 *
 * @returns {boolean} whether a lifecycle change was actually applied
 */
function linkConflict(store, incoming, neighbor, relations) {
  if (store && incoming.id && neighbor?.authority !== AUTHORITIES.CANONICAL) {
    const superseded = supersedeEligible(incoming, neighbor)
    try {
      store.put({
        ...neighbor,
        status: superseded ? STATUSES.SUPERSEDED : neighbor.status,
        // withRelation returns the whole deduped list — compose first, then
        // dedupe once. Nesting it inside uniqueRelations() would flatten to [].
        relations: withRelation(
          {
            relations: [
              ...(neighbor.relations || []),
              ...(superseded ? [{ type: RELATIONS.SUPERSEDES, targetId: incoming.id }] : []),
            ],
          },
          RELATIONS.CONTRADICTS,
          incoming.id,
        ),
      })
      if (superseded) {
        relations.push({ type: RELATIONS.SUPERSEDES, targetId: neighbor.id })
        return true
      }
    } catch {
      // linking is best-effort
    }
  }
  return false
}

/**
 * Link an updated neighbor, retiring it only through the same independent gate.
 *
 * @returns {boolean} whether a lifecycle change was actually applied
 */
function linkUpdate(store, incoming, neighbor, relations) {
  const superseded = store && supersedeEligible(incoming, neighbor)
  if (superseded) {
    try {
      store.put({
        ...neighbor,
        status: STATUSES.SUPERSEDED,
        relations: withRelation(
          {
            relations: [
              ...(neighbor.relations || []),
              { type: RELATIONS.SUPERSEDES, targetId: incoming.id },
            ],
          },
          RELATIONS.UPDATES,
          incoming.id,
        ),
      })
      relations.push({ type: RELATIONS.SUPERSEDES, targetId: neighbor.id })
      return true
    } catch {
      // supersede is best-effort
      return false
    }
  }
  return false
}

/**
 * Attach evolution relations to `incoming` based on existing memory.
 * Optionally mutates a conflicting/updated neighbor (supersede / link
 * back). Never merges rows. Never touches canonical status/authority
 * except to add a contradicts/updates link.
 *
 * @returns {{ record: object, action: string, neighbor: object|null }}
 */
export function evolveAgainst(store, incoming, existing = []) {
  if (!incoming) return { record: incoming, action: 'skip', neighbor: null }
  const known = existing.length ? existing : (store?.list?.({ limit: 60 }) || [])
  const peers = known.filter((r) => r && r.id !== incoming.id && !r.forgotten)
  const diff = diffMemory(incoming, peers)
  const relations = [...(incoming.relations || [])]

  const duplicate = strongestMatch(diff, DIFF.DUPLICATE)
  if (duplicate) {
    relations.push({ type: RELATIONS.EXTENDS, targetId: duplicate.id })
    return {
      record: { ...incoming, relations: uniqueRelations(relations) },
      action: 'duplicate',
      neighbor: duplicate.record,
      diff,
    }
  }

  const conflict = strongestMatch(diff, DIFF.CONFLICT)
  if (conflict) {
    const neighbor = conflict.record
    relations.push({ type: RELATIONS.CONTRADICTS, targetId: conflict.id })

    // Both records are always kept and the contradicts edge is always linked
    // in both directions — including when a lifecycle change also happens, so
    // a replacement never hides that the two claims disagree.
    const superseded = linkConflict(store, incoming, neighbor, relations)

    return {
      record: { ...incoming, relations: uniqueRelations(relations) },
      action: superseded ? 'supersede' : 'conflict',
      neighbor,
      diff,
    }
  }

  const update = strongestMatch(diff, DIFF.UPDATE)
  if (update) {
    relations.push({ type: RELATIONS.UPDATES, targetId: update.id })
    const neighbor = update.record

    // UPDATE is a relationship classification, not a lifecycle verdict.
    // Similarity can link two records; it can never retire one.
    const superseded = linkUpdate(store, incoming, neighbor, relations)

    if (!superseded && neighbor) {
      relations.push({ type: RELATIONS.EXTENDS, targetId: neighbor.id })
    }
    return {
      record: { ...incoming, relations: uniqueRelations(relations) },
      action: superseded ? 'supersede' : 'update',
      neighbor,
      diff,
    }
  }

  const close = diff.matches[0]
  if (close && close.similarity >= 0.35 && close.record) {
    relations.push({ type: RELATIONS.EXTENDS, targetId: close.id })
    return {
      record: { ...incoming, relations: uniqueRelations(relations) },
      action: 'extend',
      neighbor: close.record,
      diff,
    }
  }

  return {
    record: { ...incoming, relations: uniqueRelations(relations) },
    action: 'add',
    neighbor: null,
    diff,
  }
}

/**
 * Verify whether file evidence still exists in the local workspace.
 * Helps prevent deleted/renamed file references from misleading the agent.
 */
export function verifyEvidenceHealth(record, workspace) {
  if (!workspace || !record || !Array.isArray(record.evidence) || record.evidence.length === 0) {
    return { status: 'unknown', missingPaths: [], existingPaths: [] }
  }
  const filePaths = record.evidence
    .map((e) => (typeof e === 'string' ? e : e?.path))
    .filter((p) => typeof p === 'string' && p.trim() && !p.startsWith('sym:') && !p.startsWith('note:'))

  if (filePaths.length === 0) {
    return { status: 'unanchored', missingPaths: [], existingPaths: [] }
  }

  const existingPaths = []
  const missingPaths = []
  for (const rel of filePaths) {
    const full = join(workspace, rel)
    if (existsSync(full)) {
      existingPaths.push(rel)
    } else {
      missingPaths.push(rel)
    }
  }

  if (missingPaths.length > 0 && existingPaths.length === 0) {
    return { status: 'broken', missingPaths, existingPaths }
  }
  if (missingPaths.length > 0) {
    return { status: 'partial', missingPaths, existingPaths }
  }
  return { status: 'healthy', missingPaths, existingPaths }
}

/**
 * Mark long-idle, unverified, non-canonical memories, or memories whose
 * referenced files have all been deleted from the repository, as stale so
 * they leave ambient recall. Canonical and recently active records are
 * left alone. Does not delete anything.
 */
export function markStale(store, { now = Date.now(), olderThanMs = STALE_AFTER_MS, workspace = null } = {}) {
  if (!store) return []
  const changed = []
  const rows = store.list({ limit: 80 })
  for (const rec of rows) {
    if (!rec || rec.forgotten) continue
    if (rec.authority === AUTHORITIES.CANONICAL) continue
    if (rec.validation === VALIDATIONS.STALE || rec.validation === VALIDATIONS.INVALID) continue
    if (rec.status !== STATUSES.CURRENT) continue

    let isStale = false

    // 1. Evidence health check: if all referenced files were removed from repo, mark stale
    if (workspace) {
      const health = verifyEvidenceHealth(rec, workspace)
      if (health.status === 'broken') {
        isStale = true
      }
    }

    // 2. Idle time check
    if (!isStale) {
      const recalled = Date.parse(rec.lastRecalledAt || '')
      const updated = Date.parse(rec.updatedAt || rec.createdAt || '')
      const stamp = Math.max(
        Number.isFinite(recalled) ? recalled : 0,
        Number.isFinite(updated) ? updated : 0,
      )
      if (stamp && now - stamp >= olderThanMs) {
        isStale = true
      }
    }

    if (!isStale) continue

    try {
      const written = store.put({
        ...rec,
        validation: VALIDATIONS.STALE,
      })
      if (written.record) changed.push(written.record)
    } catch {
      // best-effort
    }
  }
  return changed
}

/**
 * Detect contradiction pairs among recalled records.
 * Never drops either side. Adapted from PMA `detectContradictions`.
 */
export function detectContradictions(records) {
  if (!Array.isArray(records) || records.length < 2) {
    return { hasContradictions: false, pairs: [], contradictingIds: new Set() }
  }
  const byId = new Map(records.map((r) => [r.id, r]))
  const pairs = []
  const contradictingIds = new Set()
  const seen = new Set()
  for (const rec of records) {
    for (const rel of rec.relations || []) {
      if (rel.type !== RELATIONS.CONTRADICTS) continue
      const other = byId.get(rel.targetId)
      if (!other || other.id === rec.id) continue
      const key = [rec.id, other.id].sort().join(':::')
      if (seen.has(key)) continue
      seen.add(key)
      contradictingIds.add(rec.id)
      contradictingIds.add(other.id)
      pairs.push({
        a: rec.id,
        b: other.id,
        titleA: rec.title || rec.id,
        titleB: other.title || other.id,
        banner: `[CONTRADICTION: '${rec.title || rec.id}' contradicts '${other.title || other.id}' — verify against the repository]`,
      })
    }
  }
  return { hasContradictions: pairs.length > 0, pairs, contradictingIds }
}

export function annotateContradictions(records) {
  const { hasContradictions, pairs, contradictingIds } = detectContradictions(records)
  if (!hasContradictions) {
    return records.map((r) => ({ ...r, contradictions: [], contradictionBanners: [] }))
  }
  return records.map((rec) => {
    if (!contradictingIds.has(rec.id)) {
      return { ...rec, contradictions: [], contradictionBanners: [] }
    }
    const matching = pairs.filter((p) => p.a === rec.id || p.b === rec.id)
    return {
      ...rec,
      contradictions: matching.map((p) => (p.a === rec.id ? p.b : p.a)),
      contradictionBanners: matching.map((p) => p.banner),
    }
  })
}
