/**
 * Issue #3 Phase B — explicit relationship recovery (`/veyra unlink`).
 *
 * Covers remediation coverage items 8–11:
 *   8. unlink isolation — unrelated relationships and every other field survive
 *   9. bidirectional consistency — both reciprocal representations are removed
 *      in one transaction, and a failed second write rolls the first back
 *  10. post-recovery trust is recalculated (contradicted -> not contradicted)
 *  11. safety / preconditions — missing records, unsupported types and absent
 *      edges fail clearly with no partial mutation
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { closeAllStores, openEphemeralStore, openProjectStore } from '../src/store.mjs'
import { projectIdFor } from '../src/ids.mjs'
import { handleVeyraCommand } from '../src/commands.mjs'
import { annotateContradictions } from '../src/evolve.mjs'
import { classifyRecordTrust, TRUST_CATEGORIES } from '../src/trust.mjs'
import { unlinkRelation, UNLINK_USAGE } from '../src/relationships.mjs'
import { AUTHORITIES, RELATIONS } from '../src/types.mjs'

let seq = 0

/** Insert one record with a unique title/body (the store merges verbatim twins). */
function putRec(store, over = {}) {
  seq += 1
  const input = {
    kind: 'memory',
    title: `Issue 3 fixture ${seq}`,
    body: `Fixture body ${seq}: a durable engineering fact used only by the Issue 3 relationship tests.`,
    evidence: [{ path: `src/fixture-${seq}.mjs` }],
    authority: AUTHORITIES.DERIVED,
    ...over,
  }
  const result = store.put(input)
  assert.ok(result?.record, 'fixture record was stored')
  return result.record
}

/** Full field snapshot minus `relations` — used to prove nothing else moved. */
function snapshot(record) {
  const { relations, ...rest } = record
  return JSON.parse(JSON.stringify(rest))
}

const typesOf = (record) => (record.relations || []).map((r) => `${r.type}:${r.targetId}`).sort()

/** A record pair holding a reciprocal contradicts edge plus unrelated edges. */
function contradictingPair(store) {
  const other = putRec(store, { title: 'Unrelated upstream note' })
  const a = putRec(store, { title: 'Cache invalidation policy' })
  const b = putRec(store, { title: 'Cache invalidation policy (opposing)' })
  // Real shape written by evolve.linkConflict(): both directions.
  store.put({
    ...store.get(a.id),
    relations: [
      { type: RELATIONS.CONTRADICTS, targetId: b.id },
      { type: RELATIONS.UPDATES, targetId: other.id },
    ],
  })
  store.put({
    ...store.get(b.id),
    relations: [
      { type: RELATIONS.CONTRADICTS, targetId: a.id },
      { type: RELATIONS.EXTENDS, targetId: other.id },
    ],
  })
  return { a: store.get(a.id), b: store.get(b.id), other: store.get(other.id) }
}

test('coverage 8: unlink removes only the named edge and preserves everything else', () => {
  const store = openEphemeralStore()
  try {
    const { a, b, other } = contradictingPair(store)
    const beforeA = snapshot(a)
    const beforeB = snapshot(b)
    const expectedA = [`${RELATIONS.UPDATES}:${other.id}`]
    const expectedB = [`${RELATIONS.EXTENDS}:${other.id}`]

    const result = unlinkRelation(store, {
      fromId: a.id,
      relation: RELATIONS.CONTRADICTS,
      targetId: b.id,
      why: 'false edge from replacement wording',
    })
    assert.equal(result.ok, true, result.error)
    assert.deepEqual(result.removed, { forward: true, reciprocal: true })

    const afterA = store.get(a.id)
    const afterB = store.get(b.id)

    // The contradicts edge is gone in both directions ...
    assert.equal(typesOf(afterA).some((t) => t.startsWith(`${RELATIONS.CONTRADICTS}:`)), false)
    assert.equal(typesOf(afterB).some((t) => t.startsWith(`${RELATIONS.CONTRADICTS}:`)), false)
    // ... and every unrelated relationship survives.
    assert.deepEqual(typesOf(afterA), expectedA)
    assert.deepEqual(typesOf(afterB), expectedB)

    // Every other field is byte-identical, including timestamps.
    assert.deepEqual(snapshot(afterA), beforeA)
    assert.deepEqual(snapshot(afterB), beforeB)
    assert.equal(afterA.updatedAt, a.updatedAt)
    assert.equal(afterA.createdAt, a.createdAt)
    assert.equal(afterB.updatedAt, b.updatedAt)
    assert.equal(afterB.createdAt, b.createdAt)
  } finally {
    store.close()
  }
})

test('coverage 9: both reciprocal edges are removed atomically, or none are', () => {
  const store = openEphemeralStore()
  try {
    const { a, b } = contradictingPair(store)
    const beforeA = snapshot(a)

    // Force the second row's write to miss its `relations` precondition, which
    // is exactly what a concurrent writer would cause. The first row must be
    // rolled back, never left half-unlinked.
    const realPrepare = store.db.prepare.bind(store.db)
    store.db.prepare = (sql) => {
      const stmt = realPrepare(sql)
      if (!String(sql).startsWith('UPDATE memory SET relations')) return stmt
      return {
        run: (...args) => (args[1] === b.id ? { changes: 0 } : stmt.run(...args)),
      }
    }

    const failed = unlinkRelation(store, {
      fromId: a.id,
      relation: RELATIONS.CONTRADICTS,
      targetId: b.id,
    })
    store.db.prepare = realPrepare

    assert.equal(failed.ok, false)
    assert.match(failed.error, /nothing was changed/)
    assert.match(failed.error, new RegExp(`precondition failed for ${b.id}`))

    const stillA = store.get(a.id)
    const stillB = store.get(b.id)
    assert.ok(typesOf(stillA).includes(`${RELATIONS.CONTRADICTS}:${b.id}`), 'forward edge restored')
    assert.ok(typesOf(stillB).includes(`${RELATIONS.CONTRADICTS}:${a.id}`), 'reciprocal edge intact')
    assert.deepEqual(snapshot(stillA), beforeA)

    // And a clean retry succeeds, proving the rollback left a usable state.
    const retry = unlinkRelation(store, {
      fromId: a.id,
      relation: RELATIONS.CONTRADICTS,
      targetId: b.id,
    })
    assert.equal(retry.ok, true, retry.error)
    assert.equal(typesOf(store.get(a.id)).includes(`${RELATIONS.CONTRADICTS}:${b.id}`), false)
    assert.equal(typesOf(store.get(b.id)).includes(`${RELATIONS.CONTRADICTS}:${a.id}`), false)
  } finally {
    store.close()
  }
})

test('coverage 9b: a one-sided edge is removed and reported, not invented', () => {
  const store = openEphemeralStore()
  try {
    const a = putRec(store, { title: 'One-sided contradiction source' })
    const b = putRec(store, { title: 'One-sided contradiction target' })
    store.put({ ...store.get(a.id), relations: [{ type: RELATIONS.CONTRADICTS, targetId: b.id }] })

    const result = unlinkRelation(store, {
      fromId: a.id,
      relation: RELATIONS.CONTRADICTS,
      targetId: b.id,
    })
    assert.equal(result.ok, true, result.error)
    assert.deepEqual(result.removed, { forward: true, reciprocal: false })
    assert.deepEqual(typesOf(store.get(a.id)), [])
    assert.deepEqual(typesOf(store.get(b.id)), [])
  } finally {
    store.close()
  }
})

test('coverage 10: trust is recalculated after recovery', () => {
  const store = openEphemeralStore()
  try {
    const { a, b } = contradictingPair(store)
    const records = () => [store.get(a.id), store.get(b.id)]

    const before = classifyRecordTrust(annotateContradictions(records())[0])
    assert.equal(before.category, TRUST_CATEGORIES.CONTRADICTED)
    assert.match(before.reasons.join(' '), /contradicted by/)

    const result = unlinkRelation(store, {
      fromId: a.id,
      relation: RELATIONS.CONTRADICTS,
      targetId: b.id,
    })
    assert.equal(result.ok, true, result.error)

    const annotated = annotateContradictions(records())
    for (const record of annotated) {
      assert.deepEqual(record.contradictions, [], 'no contradiction annotation survives')
      assert.deepEqual(record.contradictionBanners, [])
      assert.notEqual(classifyRecordTrust(record).category, TRUST_CATEGORIES.CONTRADICTED)
    }
  } finally {
    store.close()
  }
})

test('coverage 11: preconditions fail clearly and never mutate', () => {
  const store = openEphemeralStore()
  try {
    const { a, b, other } = contradictingPair(store)
    const beforeA = snapshot(a)
    const beforeB = snapshot(b)
    const beforeOther = snapshot(other)

    const cases = [
      [{ fromId: 'missing-from', relation: RELATIONS.CONTRADICTS, targetId: b.id }, /record missing-from not found/],
      [{ fromId: a.id, relation: RELATIONS.CONTRADICTS, targetId: 'missing-target' }, /record missing-target not found/],
      [{ fromId: a.id, relation: RELATIONS.SUPERSEDES, targetId: b.id }, /only contradicts can be unlinked/],
      [{ fromId: a.id, relation: 'bogus', targetId: b.id }, /unknown relationship type/],
      [{ fromId: a.id, relation: RELATIONS.CONTRADICTS, targetId: a.id }, /refusing to unlink .* from itself/],
      [{ fromId: a.id, relation: RELATIONS.CONTRADICTS, targetId: other.id }, /no contradicts relationship/],
      [{ fromId: a.id, targetId: b.id }, new RegExp(UNLINK_USAGE.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))],
    ]
    for (const [input, pattern] of cases) {
      const result = unlinkRelation(store, input)
      assert.equal(result.ok, false, `expected refusal for ${JSON.stringify(input)}`)
      assert.match(result.error, pattern)
    }

    // Nothing was written by any refused call.
    assert.deepEqual(snapshot(store.get(a.id)), beforeA)
    assert.deepEqual(snapshot(store.get(b.id)), beforeB)
    assert.deepEqual(snapshot(store.get(other.id)), beforeOther)
    assert.ok(typesOf(store.get(a.id)).includes(`${RELATIONS.CONTRADICTS}:${b.id}`))
    assert.ok(typesOf(store.get(b.id)).includes(`${RELATIONS.CONTRADICTS}:${a.id}`))
  } finally {
    store.close()
  }
})

test('/veyra unlink end-to-end: usage, cross-store, success output', () => {
  const dir = mkdtempSync(join(tmpdir(), 'veyra-issue3-unlink-'))
  const cwd = mkdtempSync(join(tmpdir(), 'veyra-issue3-ws-'))
  try {
    const runtime = { veyraHome: dir, fallbackCwd: cwd, recallLimit: 5, includeReusable: true }
    const store = openProjectStore(dir, projectIdFor(cwd))
    const run = (text) => handleVeyraCommand(runtime, {
      text, agent: { session: { header: { cwd } } },
    })

    const help = run('help')
    assert.match(help.text, /\/veyra unlink <id> contradicts <targetId>/)

    const { a, b } = contradictingPair(store)

    const usage = run(`unlink ${a.id}`)
    assert.equal(usage.kind, 'error')
    assert.match(usage.text, /usage: \/veyra unlink/)

    const missing = run(`unlink ${a.id} contradicts nope`)
    assert.equal(missing.kind, 'error')
    assert.match(missing.text, /record nope not found/)

    const wrongType = run(`unlink ${a.id} supersedes ${b.id}`)
    assert.equal(wrongType.kind, 'error')
    assert.match(wrongType.text, /only contradicts can be unlinked/)

    const ok = run(`unlink ${a.id} contradicts ${b.id} false edge`)
    assert.equal(ok.kind, 'success', ok.text)
    assert.match(ok.text, new RegExp(`Unlinked contradicts: ${a.id} <-> ${b.id}`))
    assert.match(ok.text, new RegExp(`removed: ${a.id} -> ${b.id}, ${b.id} -> ${a.id}`))
    assert.match(ok.text, /no other field, timestamp, or relationship was changed/)
    assert.match(ok.text, /why: false edge/)

    assert.equal(typesOf(store.get(a.id)).includes(`${RELATIONS.CONTRADICTS}:${b.id}`), false)
    assert.equal(typesOf(store.get(b.id)).includes(`${RELATIONS.CONTRADICTS}:${a.id}`), false)

    // A second identical unlink is refused, not silently repeated.
    const again = run(`unlink ${a.id} contradicts ${b.id}`)
    assert.equal(again.kind, 'error')
    assert.match(again.text, /no contradicts relationship/)
  } finally {
    closeAllStores()
    rmSync(dir, { recursive: true, force: true })
    rmSync(cwd, { recursive: true, force: true })
  }
})
