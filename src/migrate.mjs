/**
 * Veyra — one-time historical correction for `supersedes` edge direction.
 *
 * APPROVED ARCHITECTURE DECISION
 * ------------------------------
 *   `supersedes` is directed from the retired claim to its replacement:
 *
 *       retired --supersedes--> replacement
 *
 *   Exactly one `supersedes` edge exists per supersede event.
 *   `contradicts` is unaffected and remains bidirectional.
 *
 * WHY A PLANNER EXISTS AT ALL
 * ---------------------------
 * Before the decision, every supersede wrote BOTH directions. The stored
 * data therefore cannot answer "which endpoint retired the other" from the
 * edge alone, and it is ambiguous by construction.
 *
 * The pair is reconstructed from `status` — which is a MUTABLE field and is
 * NOT a runtime dependency of this migration. It is a one-shot correction:
 * the two values were written in the same `store.put`, so a pair written by
 * the old symmetric path has exactly one endpoint with `status = 'superseded'`.
 *
 * This module deliberately does NOT teach the runtime anything about
 * direction. `supersedes` is written by the lifecycle gate in `evolve.mjs`
 * and is never read back by it. Nothing here runs at runtime.
 *
 * DELIBERATE NON-GOALS
 * --------------------
 *   - no schema change, no version table, no lineage_root, no revision
 *     subsystem, no isLatest flag
 *   - no graph database, no embeddings, no background worker
 *   - no LLM classification
 *   - no second-supersede policy change
 *
 * A pair whose direction cannot be decided from `status` is QUARANTINED, not
 * guessed. Choosing a side would be exactly the silent wrong answer the
 * fail-closed design exists to prevent.
 */

import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { STATUSES, RELATIONS } from './types.mjs'

/**
 * Load every live supersedes edge, including forgotten rows.
 *
 * Forgotten rows are loaded deliberately: a forgotten record can still own a
 * supersedes edge (verified in live data — see the report), and hiding it
 * would let a mirror edge survive unnoticed. Rows are reported with their
 * `forgotten` flag so the caller can decide.
 *
 * @returns {Array<{id:string,status:string,forgotten:boolean,relations:Array}>}
 */
function loadRows(db) {
  const rows = db.prepare(
    'SELECT id, status, forgotten, relations FROM memory',
  ).all()
  const out = []
  for (const row of rows) {
    let relations = []
    try {
      const parsed = JSON.parse(row.relations || '[]')
      if (Array.isArray(parsed)) relations = parsed
    } catch {
      // Unparseable relations are not this planner's business; the row is
      // skipped by the caller because it yields no supersedes edge.
    }
    out.push({
      id: row.id,
      status: row.status,
      forgotten: Boolean(row.forgotten),
      relations,
    })
  }
  return out
}

function supersedesEdges(row) {
  return row.relations.filter(
    (rel) => rel && rel.type === 'supersedes' && typeof rel.targetId === 'string' && rel.targetId,
  )
}

/**
 * Plan the direction correction for a single project database.
 *
 * Pure: performs no writes. Deterministic: output is sorted and contains no
 * timestamps, so repeated runs over unchanged data produce byte-identical
 * plans.
 *
 * @param {string} filePath absolute path to memory.db
 * @returns {object} auditable plan
 */
export function planProject(filePath) {
  const plan = {
    file: filePath,
    exists: false,
    retained: [],   // edges kept, with the reason they are authoritative
    deletions: [],  // mirror edges the correction would remove
    quarantined: [],// pairs whose direction cannot be decided
    dangling: [],   // edges whose target is not a stored row; left untouched
    stats: { totalEdges: 0, pairs: 0, kept: 0, removed: 0, quarantined: 0, dangling: 0 },
  }

  if (!existsSync(filePath)) return plan
  plan.exists = true

  const db = new DatabaseSync(filePath, { readOnly: true })
  let rows
  try {
    rows = loadRows(db)
  } finally {
    db.close()
  }

  const byId = new Map(rows.map((r) => [r.id, r]))

  // Collect every supersedes edge, keyed by unordered endpoint pair.
  /** @type {Map<string, {a:string,b:string,froms:string[]}>} */
  const pairs = new Map()
  for (const row of rows) {
    for (const edge of supersedesEdges(row)) {
      const key = [row.id, edge.targetId].sort().join(':::')
      let entry = pairs.get(key)
      if (!entry) {
        entry = { a: row.id, b: edge.targetId, froms: [] }
        pairs.set(key, entry)
      }
      entry.froms.push(row.id)
    }
  }
  plan.stats.totalEdges = [...pairs.values()].reduce((n, p) => n + p.froms.length, 0)

  const pairList = [...pairs.values()].sort((x, y) => (x.a < y.a ? -1 : x.a > y.a ? 1 : 0))

  for (const pair of pairList) {
    const source = byId.get(pair.a)
    const target = byId.get(pair.b)

    // --- dangling: target row is absent. Leave untouched, fabricate nothing.
    if (!target) {
      plan.dangling.push({
        from: pair.a,
        to: pair.b,
        reason: 'target row not present; edge left untouched',
        sourceForgotten: Boolean(source?.forgotten),
      })
      plan.stats.dangling += 1
      continue
    }

    const bothLive = source && target
    const sourceSuperseded = source?.status === STATUSES.SUPERSEDED
    const targetSuperseded = target.status === STATUSES.SUPERSEDED

    // --- decided: exactly one endpoint is superseded.
    if (sourceSuperseded !== targetSuperseded) {
      const retiredId = sourceSuperseded ? pair.a : pair.b
      const replacementId = sourceSuperseded ? pair.b : pair.a
      plan.stats.pairs += 1
      plan.retained.push({
        from: retiredId,
        to: replacementId,
        reason: 'origin endpoint has status=superseded',
        sourceForgotten: Boolean(source.forgotten),
        targetForgotten: Boolean(target.forgotten),
      })
      plan.stats.kept += 1

      // Every other originating endpoint in this pair is a mirror to remove.
      for (const fromId of [...new Set(pair.froms)].sort()) {
        if (fromId === retiredId) continue
        plan.deletions.push({
          from: fromId,
          to: fromId === pair.a ? pair.b : pair.a,
          reason: `mirror of retained ${retiredId} -[supersedes]-> ${replacementId}`,
        })
        plan.stats.removed += 1
      }
      continue
    }

    // --- undecidable: both or neither superseded. Quarantine, never guess.
    plan.quarantined.push({
      a: pair.a,
      b: pair.b,
      sourceStatus: source?.status ?? null,
      targetStatus: target.status,
      reason: sourceSuperseded && targetSuperseded
        ? 'both endpoints are status=superseded; direction is not decidable from status'
        : 'neither endpoint is status=superseded; direction is not decidable from status',
    })
    plan.stats.quarantined += 1
  }

  // Deterministic ordering.
  plan.retained.sort((x, y) => (x.from < y.from ? -1 : x.from > y.from ? 1 : 0))
  plan.deletions.sort((x, y) => (x.from < y.from ? -1 : x.from > y.from ? 1 : 0))
  plan.dangling.sort((x, y) => (x.from < y.from ? -1 : x.from > y.from ? 1 : 0))
  plan.quarantined.sort((x, y) => (x.a < y.a ? -1 : x.a > y.a ? 1 : 0))

  const ambiguous = (plan.retained.length !== plan.stats.kept)
  return { ...plan, ambiguous }
}

/**
 * Plan every database under a Veyra home. Read-only.
 *
 * @param {string} veyraHome path to $DSH_HOME/veyra
 */
export function planAll(veyraHome) {
  const plans = []
  const projectsDir = join(veyraHome, 'projects')
  if (existsSync(projectsDir)) {
    for (const entry of readdirSync(projectsDir).sort()) {
      const file = join(projectsDir, entry, 'memory.db')
      if (existsSync(file)) plans.push(planProject(file))
    }
  }
  const reusable = join(veyraHome, 'reusable', 'memory.db')
  if (existsSync(reusable)) plans.push(planProject(reusable))

  const totals = plans.reduce(
    (acc, p) => {
      acc.totalEdges += p.stats.totalEdges
      acc.pairs += p.stats.pairs
      acc.kept += p.stats.kept
      acc.removed += p.stats.removed
      acc.quarantined += p.stats.quarantined
      acc.dangling += p.stats.dangling
      return acc
    },
    { totalEdges: 0, pairs: 0, kept: 0, removed: 0, quarantined: 0, dangling: 0 },
  )
  return { veyraHome, plans, totals }
}

/** Render a plan as a human-readable, deterministic report. */
export function formatPlan(result) {
  const lines = []
  lines.push(`Veyra supersedes-direction plan (READ-ONLY) — ${result.veyraHome}`)
  lines.push('')
  for (const plan of result.plans) {
    if (plan.stats.totalEdges === 0) {
      lines.push(`  ${plan.file}: no supersedes edges`)
      continue
    }
    lines.push(`  ${plan.file}`)
    lines.push(`    total supersedes edges : ${plan.stats.totalEdges}`)
    lines.push(`    decided pairs          : ${plan.stats.pairs}`)
    lines.push(`    edges retained         : ${plan.stats.kept}`)
    lines.push(`    mirror edges to remove : ${plan.stats.removed}`)
    lines.push(`    quarantined pairs      : ${plan.stats.quarantined}`)
    lines.push(`    dangling (untouched)   : ${plan.stats.dangling}`)
    for (const r of plan.retained) {
      lines.push(`      KEEP    ${r.from} -[supersedes]-> ${r.to}   (${r.reason})`)
    }
    for (const d of plan.deletions) {
      lines.push(`      REMOVE  ${d.from} -[supersedes]-> ${d.to}   (${d.reason})`)
    }
    for (const q of plan.quarantined) {
      lines.push(`      QUARANTINE ${q.a} <-> ${q.b}   (${q.reason})`)
    }
    for (const g of plan.dangling) {
      lines.push(`      UNTOUCHED ${g.from} -[supersedes]-> ${g.to}   (${g.reason})`)
    }
  }
  lines.push('')
  lines.push(`  TOTAL edges ${result.totals.totalEdges} -> retained ${result.totals.kept} + removed ${result.totals.removed}`)
  lines.push(`  decided pairs ${result.totals.pairs} | quarantined ${result.totals.quarantined} | dangling ${result.totals.dangling}`)
  return lines.join('\n')
}

// ---------------------------------------------------------------------------
// ONE-TIME APPLY
//
// Migration-only. Not wired into the plugin, the startup path, or any
// automatic execution path — it is called once, by hand, and never again.
//
// Why raw SQL instead of MemoryStore.put(): put() routes through
// normalizeRecord(), which restamps `updatedAt` (store.mjs:210-212).
// `updatedAt` feeds freshnessTier in ranking, so a relation-only edit through
// put() would silently change the record's ranking freshness. This function
// therefore writes exactly one column and touches nothing else.
//
// Concurrency: BEGIN IMMEDIATE takes SQLite's write lock at BEGIN rather than
// at first write, closing the read→write window. Every UPDATE additionally
// carries the relations value observed before BEGIN as an exact SQL
// precondition, so a concurrent writer that changed the row in between makes
// the UPDATE match 0 rows and the whole transaction rolls back. Because the
// precondition is the serialized `relations` value, a row whose mirror edge is
// already gone matches nothing and is reported rather than rewritten — so a
// repeated run is a safe no-op.
//
// CROSS-DATABASE LIMITATION, stated rather than hidden: the approved M1 set
// spans two databases. SQLite cannot make two databases one transaction.
// Each database is applied in its own transaction; if one commits and the
// other fails, callers must report the partial state. Re-running is safe,
// because every deletion is guarded and idempotent.
// ---------------------------------------------------------------------------

/**
 * Remove the mirrored `supersedes` edges for ONE database, transactionally.
 *
 * @param {string} filePath absolute path to memory.db (opened read-write)
 * @param {Array<{from:string,to:string}>} deletions target mirror edges; each
 *   `from` record must currently hold a `supersedes` edge to `to`
 * @returns {{file:string, applied:Array, skipped:Array, committed:boolean, error:string|null}}
 */
export function applyMirrorRemoval(filePath, deletions) {
  const result = {
    file: filePath,
    applied: [],
    skipped: [],
    committed: false,
    error: null,
  }
  if (!deletions || deletions.length === 0) return result

  const db = new DatabaseSync(filePath)
  const select = db.prepare('SELECT status, forgotten, relations FROM memory WHERE id = ?')
  const update = db.prepare('UPDATE memory SET relations = ? WHERE id = ? AND relations = ?')

  try {
    // Observe first, then take the write lock. A concurrent writer between
    // these two points is caught by the UPDATE precondition, not by a race.
    const observed = []
    const absent = []
    for (const d of deletions) {
      const row = select.get(d.from)
      if (!row) {
        // A migration must never silently skip: an unresolvable entry is a
        // blocker, so the whole database is left untouched.
        result.error = `source record not found: ${d.from}`
        return result
      }
      let relations
      try {
        relations = JSON.parse(row.relations || '[]')
      } catch {
        result.error = `source relations are not valid JSON: ${d.from}`
        return result
      }
      const next = relations.filter(
        (r) => !(r && r.type === RELATIONS.SUPERSEDES && r.targetId === d.to),
      )
      if (next.length === relations.length) {
        absent.push(d)
        continue
      }
      observed.push({ ...d, nextJson: JSON.stringify(next), observedJson: row.relations })
    }

    // Idempotency, but never a partial apply.
    //   - every entry already absent  -> clean no-op (a re-run after success)
    //   - some absent, some present   -> INCONSISTENT state; refuse to apply,
    //     because applying the remainder would silently half-migrate.
    if (absent.length > 0) {
      if (observed.length === 0) {
        for (const d of absent) result.skipped.push({ ...d, reason: 'mirror edge already absent' })
        result.skipped.push({ from: null, to: null, reason: 'nothing to do' })
        return result
      }
      result.error =
        `inconsistent state: ${absent.length} of ${deletions.length} mirror edges are already absent `
        + `(${absent.map((d) => `${d.from}->${d.to}`).join(', ')}); refusing a partial apply`
      return result
    }

    if (observed.length === 0) {
      result.skipped.push({ from: null, to: null, reason: 'nothing to do' })
      return result
    }

    db.exec('BEGIN IMMEDIATE')
    for (const item of observed) {
      const r = update.run(item.nextJson, item.from, item.observedJson)
      if (r.changes !== 1) {
        // State moved under us. Undo everything in this database.
        db.exec('ROLLBACK')
        result.error = `precondition failed for ${item.from} -[supersedes]-> ${item.to}`
        return result
      }
      result.applied.push({ from: item.from, to: item.to })
    }
    db.exec('COMMIT')
    result.committed = true
    return result
  } catch (err) {
    try {
      db.exec('ROLLBACK')
    } catch {
      // no active transaction — nothing to undo
    }
    result.error = err instanceof Error ? err.message : String(err)
    return result
  } finally {
    db.close()
  }
}
