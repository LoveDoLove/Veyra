import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openProjectStore, closeAllStores } from '../src/store.mjs'
import { supersede, invalidate } from '../src/lifecycle.mjs'
import { sweepStale, detectContradictions, annotateContradictions } from '../src/evolve.mjs'
import { AUTHORITIES, CONFIDENCES, KINDS, RELATIONS, STATUSES, VALIDATIONS, isRecallEligible } from '../src/types.mjs'

function mem(over = {}) {
  return {
    kind: KINDS.MEMORY,
    authority: AUTHORITIES.DERIVED,
    validation: VALIDATIONS.UNVERIFIED,
    confidence: CONFIDENCES.MEDIUM,
    status: STATUSES.CURRENT,
    ...over,
  }
}

test('Task 18 lifecycle maintenance: superseded history preserved; single replacement edge; repeated/idempotent safety', () => {
  const home = mkdtempSync(join(tmpdir(), 'veyra-t18-life-'))
  const store = openProjectStore(home, 'veyra_1a1b546b0bb')
  try {
    const oldR = store.put(mem({ title: 'Use X', body: 'Use X for sync', evidence: [{ path: 'src/a.mjs', note: 'old' }] })).record
    const newR = store.put(mem({ title: 'Use Z', body: 'Use Z instead of X for sync', evidence: [{ path: 'src/a.mjs', note: 'new' }] })).record

    const sup = supersede(store, oldR.id, newR.id, { why: 'replaced by verified fix' })
    assert.equal(sup.ok, true)
    const oldAfter = store.get(oldR.id)
    const newAfter = store.get(newR.id)
    assert.equal(oldAfter.status, STATUSES.SUPERSEDED)
    assert.equal(newAfter.status, STATUSES.CURRENT)
    const edges = (oldAfter.relations || []).filter(r => r.type === RELATIONS.SUPERSEDES)
    assert.equal(edges.length, 1, 'exactly one supersedes edge per event')
    assert.equal(edges[0].targetId, newR.id)
    assert.equal((newAfter.relations || []).filter(r => r.type === RELATIONS.SUPERSEDES).length, 0)
    assert.equal(oldAfter.forgotten, false, 'historical record remains inspectable')
    assert.equal(oldAfter.evidence[0].path, 'src/a.mjs')
    assert.equal(oldAfter.source.lifecycle.at(-1).action, 'supersede')
    assert.equal(oldAfter.source.lifecycle.at(-1).replacedBy, newR.id)
    assert.equal(isRecallEligible(oldAfter), false, 'superseded record not recall-eligible as current')
    assert.equal(isRecallEligible(newAfter), true)

    const again = supersede(store, oldR.id, newR.id, { why: 'repeat' })
    assert.equal(again.ok, true)
    assert.equal(again.already, true)
    const oldAgain = store.get(oldR.id)
    assert.equal((oldAgain.relations || []).filter(r => r.type === RELATIONS.SUPERSEDES).length, 1)
    assert.equal(oldAgain.source.lifecycle.filter(e => e.action === 'supersede').length, 1, 'idempotent repeat does not append duplicate lifecycle events')

    const third = store.put(mem({ title: 'Use W', body: 'Use W now' })).record
    const conflict = supersede(store, oldR.id, third.id, { why: 'different replacement' })
    assert.equal(conflict.ok, false, 'must not create ambiguous second replacement')
    assert.match(conflict.error, /already superseded/)
    const oldFinal = store.get(oldR.id)
    assert.deepEqual((oldFinal.relations || []).filter(r => r.type === RELATIONS.SUPERSEDES).map(r => r.targetId), [newR.id])
  } finally {
    closeAllStores()
    rmSync(home, { recursive: true, force: true })
  }
})

test('Task 18 lifecycle maintenance: stale/invalid not current truth; contradictions visible; repeated sweep safe', () => {
  const home = mkdtempSync(join(tmpdir(), 'veyra-t18-maint-'))
  const store = openProjectStore(home, 'veyra_1a1b546b0bb')
  try {
    const inv = store.put(mem({
      title: 'Invalidated claim',
      body: 'bad claim',
      validation: VALIDATIONS.INVALID,
      updatedAt: '2000-01-01T00:00:00.000Z',
      createdAt: '2000-01-01T00:00:00.000Z',
    })).record
    const idle = store.put(mem({
      title: 'Idle unverified claim',
      body: 'old unverified',
      validation: VALIDATIONS.UNVERIFIED,
      updatedAt: '2000-01-01T00:00:00.000Z',
      createdAt: '2000-01-01T00:00:00.000Z',
    })).record

    const first = sweepStale(store, { now: Date.now(), olderThanMs: 1 })
    assert.equal(first.error, null)
    const invAfter = store.get(inv.id)
    const idleAfter = store.get(idle.id)
    assert.equal(invAfter.validation, VALIDATIONS.INVALID, 'invalid remains invalid, not silently promoted/current truth')
    assert.equal(idleAfter.validation, VALIDATIONS.STALE)
    assert.equal(isRecallEligible(idleAfter), false)
    const second = sweepStale(store, { now: Date.now(), olderThanMs: 1 })
    assert.equal(second.error, null)
    assert.equal(store.get(idle.id).validation, VALIDATIONS.STALE, 'repeated maintenance idempotent')
    assert.ok(second.marked <= first.marked)

    const c1 = store.put(mem({ title: 'Use foo', body: 'always use foo' })).record
    const c2 = store.put(mem({ title: 'Avoid foo', body: 'never use foo' })).record
    store.put({ ...c1, relations: [{ type: RELATIONS.CONTRADICTS, targetId: c2.id }] })
    store.put({ ...c2, relations: [{ type: RELATIONS.CONTRADICTS, targetId: c1.id }] })
    const records = store.list({ limit: 200 }).filter(r => r.id === c1.id || r.id === c2.id)
    const det = detectContradictions(records)
    assert.equal(det.hasContradictions, true)
    assert.equal(det.pairs.length, 1)
    const ann = annotateContradictions(records)
    assert.equal(ann.find(r => r.id === c1.id).contradictions[0], c2.id)
    assert.equal(ann.find(r => r.id === c2.id).contradictions[0], c1.id)
    assert.ok(ann.every(r => !r.forgotten))
  } finally {
    closeAllStores()
    rmSync(home, { recursive: true, force: true })
  }
})
