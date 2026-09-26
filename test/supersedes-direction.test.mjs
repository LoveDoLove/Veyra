/**
 * Regression coverage for the approved `supersedes` direction decision.
 *
 *   retired --supersedes--> replacement
 *
 * Exactly one `supersedes` edge exists per supersede event. The replacement
 * carries none. `contradicts` is unaffected and stays bidirectional.
 *
 * These tests assert DIRECTION and COUNT only. They deliberately do not assert
 * supersede eligibility, authority handling, or second-supersede policy —
 * those are separate concerns and are covered elsewhere.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AUTHORITIES, RELATIONS, STATUSES } from '../src/types.mjs'
import { MemoryStore, openEphemeralStore } from '../src/store.mjs'
import { evolveAgainst } from '../src/evolve.mjs'
import { planProject, planAll, formatPlan } from '../src/migrate.mjs'

const OLD_CLAIM = {
  title: 'Deploy uses rsync for artifact sync',
  body: 'The release pipeline copies build artifacts to the edge hosts with rsync from the deploy script, which keeps the upload deterministic and resumable across every host in the fleet today.',
  evidence: [{ path: 'scripts/deploy.sh' }],
  authority: AUTHORITIES.DERIVED,
}

// Directional replacement wording: this is what authorizes supersession.
const NEW_CLAIM = {
  title: 'Deploy switched from rsync to zstd for artifact sync',
  body: 'The release pipeline switched from rsync to zstd streaming for artifact sync in the deploy script, which removes the double temp-file pass and keeps the upload resumable across every host in the fleet today.',
  evidence: [{ path: 'scripts/deploy.sh' }],
  authority: AUTHORITIES.DERIVED,
}

// Polarity flip + directional replacement. Title AND body must both differ
// from OLD_CLAIM: store.put dedupes on content_hash, so an identical body
// would collapse the two claims into a single record.
const CONFLICT_CLAIM = {
  title: 'Deploy no longer uses rsync for artifact sync',
  body: 'The release pipeline stopped copying build artifacts to the edge hosts with rsync, and switched from rsync to zstd streaming inside the deploy script, which removes the redundant temp-file pass and keeps every host resumable today.',
  evidence: [{ path: 'scripts/deploy.sh' }],
  authority: AUTHORITIES.DERIVED,
}

const supEdges = (record) => (record?.relations || []).filter((r) => r.type === RELATIONS.SUPERSEDES)
const conEdges = (record) => (record?.relations || []).filter((r) => r.type === RELATIONS.CONTRADICTS)

/** Persist an older claim, then evolve a replacement against it. */
function supersedeVia(store, incoming = NEW_CLAIM) {
  const old = store.put(OLD_CLAIM).record
  const replacement = store.put(incoming).record
  const evolved = evolveAgainst(store, replacement, [old])
  store.put(evolved.record)
  return {
    action: evolved.action,
    oldId: old.id,
    replacementId: replacement.id,
    retired: store.get(old.id),
    replacement: store.get(replacement.id),
  }
}

test('supersede is directed retired -> replacement on the UPDATE path', () => {
  const store = openEphemeralStore()
  const r = supersedeVia(store)
  assert.equal(r.action, 'supersede')

  // (1) retired record has exactly one supersedes edge, pointing at the replacement
  assert.equal(supEdges(r.retired).length, 1)
  assert.equal(supEdges(r.retired)[0].targetId, r.replacementId)
  assert.equal(r.retired.status, STATUSES.SUPERSEDED)

  // replacement carries no supersedes edge
  assert.equal(supEdges(r.replacement).length, 0)
  store.close()
})

test('supersede is directed retired -> replacement on the CONFLICT path', () => {
  const store = openEphemeralStore()
  // Polarity flip with a directional replacement word: classified CONFLICT,
  // but authorized by the same independent gate.
  const r = supersedeVia(store, CONFLICT_CLAIM)
  assert.equal(r.action, 'supersede')

  assert.equal(supEdges(r.retired).length, 1)
  assert.equal(supEdges(r.retired)[0].targetId, r.replacementId)
  assert.equal(supEdges(r.replacement).length, 0)
  store.close()
})

test('contradicts stays bidirectional after a conflict-triggered supersede', () => {
  const store = openEphemeralStore()
  const r = supersedeVia(store, CONFLICT_CLAIM)

  // (3) contradicts must remain in BOTH directions even when a supersede fires
  assert.equal(conEdges(r.retired).length, 1)
  assert.equal(conEdges(r.retired)[0].targetId, r.replacementId)
  assert.equal(conEdges(r.replacement).length, 1)
  assert.equal(conEdges(r.replacement)[0].targetId, r.oldId)
  store.close()
})

test('exactly one supersedes edge exists per supersede event, repo-wide', () => {
  const store = openEphemeralStore()
  const r = supersedeVia(store)
  const all = store.list({ limit: 50 })
  const total = all.reduce((n, rec) => n + supEdges(rec).length, 0)
  assert.equal(total, 1, 'a single supersede event must produce exactly one edge')
  store.close()
})

test('supersede never creates a self-edge', () => {
  const store = openEphemeralStore()
  const r = supersedeVia(store)
  for (const rec of [r.retired, r.replacement]) {
    for (const edge of supEdges(rec)) {
      assert.notEqual(edge.targetId, rec.id, 'a record must not supersede itself')
    }
  }
  store.close()
})

test('repeated supersede of the same pair does not duplicate the edge', () => {
  const store = openEphemeralStore()
  const old = store.put(OLD_CLAIM).record
  const replacement = store.put(NEW_CLAIM).record

  const first = evolveAgainst(store, replacement, [old])
  store.put(first.record)
  // Re-running the same evolution must be idempotent for the edge set.
  const second = evolveAgainst(store, store.get(replacement.id), [store.get(old.id)])
  store.put(second.record)

  const retired = store.get(old.id)
  assert.equal(supEdges(retired).length, 1, 'edge must not be duplicated')
  assert.equal(supEdges(store.get(replacement.id)).length, 0)
  store.close()
})

test('two independent supersede events produce no mirror or cross edges', () => {
  const store = openEphemeralStore()
  const r1 = supersedeVia(store)
  store.close()

  // A second, unrelated pair in a separate store so ids stay comparable.
  const store2 = openEphemeralStore()
  const oldA = store2.put({ ...OLD_CLAIM, title: 'Alpha uses rsync for artifact sync' }).record
  const oldB = store2.put({ ...OLD_CLAIM, title: 'Bravo uses rsync for artifact sync' }).record
  const repA = store2.put({ ...NEW_CLAIM, title: 'Alpha switched from rsync to zstd for artifact sync' }).record
  const repB = store2.put({ ...NEW_CLAIM, title: 'Bravo switched from rsync to zstd for artifact sync' }).record

  evolveAgainst(store2, repA, [oldA])
  store2.put({ ...repA })
  evolveAgainst(store2, repB, [oldB])
  store2.put({ ...repB })

  const total = store2.list({ limit: 50 }).reduce((n, rec) => n + supEdges(rec).length, 0)
  assert.equal(total, 2, 'two independent events must yield exactly two edges')

  // Neither replacement may carry an edge to the other pair.
  const a = store2.get(oldA.id)
  const b = store2.get(oldB.id)
  for (const retired of [a, b]) {
    for (const edge of supEdges(retired)) {
      assert.ok(
        [oldA.id, repA.id].includes(retired.id) ? edge.targetId === repA.id : edge.targetId === repB.id,
        'edge must stay within its own pair',
      )
    }
    assert.equal(supEdges(store2.get(retired.id === a.id ? repA.id : repB.id)).length, 0)
  }
  store2.close()
  assert.equal(r1.action, 'supersede')
})

test('ANOMALY: a pair where both endpoints are already superseded is detected, not silently resolved', () => {
  const dir = mkdtempSync(join(tmpdir(), 'veyra-anomaly-'))
  const { file } = seedPair(dir, (store, a, b) => {
    // Pre-existing inconsistency: BOTH endpoints superseded, with the
    // pre-decision bidirectional pair. Direction is not decidable from
    // status, so the planner must quarantine rather than guess.
    store.put({ ...a, status: STATUSES.SUPERSEDED, relations: [{ type: RELATIONS.SUPERSEDES, targetId: b.id }] })
    store.put({
      ...b,
      status: STATUSES.SUPERSEDED,
      relations: [{ type: RELATIONS.SUPERSEDES, targetId: a.id }],
    })
    return store.list({ includeForgotten: true, limit: 200 })
  })
  const plan = planProject(file)

  assert.equal(plan.stats.quarantined, 1, 'the anomalous pair must be quarantined')
  assert.equal(plan.stats.kept, 0, 'no side may be silently chosen')
  assert.equal(plan.deletions.length, 0, 'nothing may be deleted from an undecidable pair')
  assert.match(plan.quarantined[0].reason, /both endpoints are status=superseded/)
})

/**
 * Materialize rows into a real on-disk store the planner can open read-only.
 * Uses the real MemoryStore so the schema is the production schema — the
 * planner is never tested against a hand-rolled table.
 */
function planFor(rows, dir) {
  const file = join(dir, 'memory.db')
  const store = new MemoryStore(file, { scope: 'project', projectId: 'p_plan' })
  for (const rec of rows) store.put(rec)
  store.close()
  return file
}

function seedPair(dir, mutate) {
  const store = openEphemeralStore()
  const a = store.put(OLD_CLAIM).record
  const b = store.put(NEW_CLAIM).record
  const rows = mutate(store, a, b) ?? store.list({ includeForgotten: true, limit: 200 })
  const file = planFor(rows, dir)
  store.close()
  // Materializing re-derives ids, so the caller must compare against the ids
  // actually present in the planned database.
  return { file, a, b }
}

test('planner retains the retired-originated edge and removes only the mirror', () => {
  const dir = mkdtempSync(join(tmpdir(), 'veyra-plan-'))
  const { file, a, b } = seedPair(dir, (store, sa, sb) => {
    // Pre-decision shape: both directions, loser is superseded.
    store.put({ ...sa, status: STATUSES.SUPERSEDED, relations: [{ type: RELATIONS.SUPERSEDES, targetId: sb.id }] })
    store.put({ ...sb, relations: [{ type: RELATIONS.SUPERSEDES, targetId: sa.id }] })
    return store.list({ includeForgotten: true, limit: 200 })
  })
  const plan = planProject(file)

  assert.equal(plan.stats.totalEdges, 2)
  assert.equal(plan.stats.kept, 1)
  assert.equal(plan.stats.removed, 1)
  assert.equal(plan.retained[0].from, a.id)
  assert.equal(plan.retained[0].to, b.id)
  assert.equal(plan.deletions[0].from, b.id)
  assert.equal(plan.deletions[0].to, a.id)
  assert.equal(plan.stats.quarantined, 0)
})

test('planner leaves a dangling edge untouched and fabricates no node', () => {
  const dir = mkdtempSync(join(tmpdir(), 'veyra-dangling-'))
  const { file } = seedPair(dir, (store, sa) => {
    store.put({ ...sa, status: STATUSES.SUPERSEDED, relations: [{ type: RELATIONS.SUPERSEDES, targetId: 'vey_missing_target' }] })
    return store.list({ includeForgotten: true, limit: 200 })
  })
  const plan = planProject(file)

  assert.equal(plan.stats.dangling, 1)
  assert.equal(plan.dangling[0].to, 'vey_missing_target')
  assert.equal(plan.deletions.length, 0, 'a dangling edge must not be deleted')
  assert.equal(plan.retained.length, 0)
})

test('planner is deterministic and idempotent, and never writes', () => {
  const dir = mkdtempSync(join(tmpdir(), 'veyra-idem-'))
  const { file } = seedPair(dir, (store, sa, sb) => {
    store.put({ ...sa, status: STATUSES.SUPERSEDED, relations: [{ type: RELATIONS.SUPERSEDES, targetId: sb.id }] })
    store.put({ ...sb, relations: [{ type: RELATIONS.SUPERSEDES, targetId: sa.id }] })
    return store.list({ includeForgotten: true, limit: 200 })
  })

  const first = planProject(file)
  const second = planProject(file)
  assert.deepEqual(first, second, 'planning must be deterministic and idempotent')
  assert.ok(!('applied' in first) && !('write' in first), 'planner must be read-only')
})

test('planner tolerates a missing database and formats a report', () => {
  const plan = planProject(join(tmpdir(), 'veyra-does-not-exist', 'memory.db'))
  assert.equal(plan.exists, false)
  assert.equal(plan.stats.totalEdges, 0)

  const dir = mkdtempSync(join(tmpdir(), 'veyra-empty-'))
  const empty = planAll(dir)
  assert.deepEqual(empty.totals, {
    totalEdges: 0, pairs: 0, kept: 0, removed: 0, quarantined: 0, dangling: 0,
  })
  assert.ok(formatPlan(empty).includes('READ-ONLY'))
})
