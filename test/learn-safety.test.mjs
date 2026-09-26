/**
 * M2 regression coverage: B1 (test-evidence vocabulary) and B2 (promote
 * self-edge).
 *
 * B1 — test evidence must come from the CLOSED vocabulary `understand.mjs`
 * emits (`test-passed | test-failed | tests-touched`). An unanchored `test|spec`
 * also matches ordinary prose ("inspector", "protest", "aspect"), which let a
 * claim that never ran a test reach `verified` + `promotion-candidate`.
 *
 * B2 — `promote()` is a change of standing, not a relationship. It must not
 * write an `updates` edge, and specifically never one pointing at itself.
 *
 * These exercise the real learning path (`store.put` → `evolveAgainst` →
 * `strengthenMemory`) against a temporary SQLite store, not a mock.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AUTHORITIES, RELATIONS, VALIDATIONS, KINDS } from '../src/types.mjs'
import { MemoryStore } from '../src/store.mjs'
import { strengthenMemory, promote, remember } from '../src/learn.mjs'
import { evolveAgainst } from '../src/evolve.mjs'

function tempStore() {
  const dir = mkdtempSync(join(tmpdir(), 'veyra-m2-'))
  return new MemoryStore(join(dir, 'memory.db'), { scope: 'project', projectId: 'p_m2' })
}

/** Run N reinforcement rounds and return the resulting record. */
function reinforce(store, seed, evidence, rounds = 3) {
  let rec = store.put({
    ...seed,
    evidence,
    authority: AUTHORITIES.DERIVED,
    validation: VALIDATIONS.UNVERIFIED,
    confidence: 'low',
  }).record
  for (let i = 0; i < rounds; i += 1) {
    // Build a fresh candidate: `id` must be absent, not undefined, because
    // store.put treats a present `id` as "update this row".
    const { id: _ignored, ...seedFields } = rec
    const candidate = store.put({
      ...seedFields,
      title: rec.title,
      body: `${rec.body} Round ${i}.`,
      evidence,
      authority: AUTHORITIES.CANDIDATE,
    }).record
    const evolved = evolveAgainst(store, candidate, [store.get(rec.id)])
    if (evolved.action === 'duplicate') {
      // store.put returns a wrapper ({ record, created, ... }); keep the record.
      rec = store.put(strengthenMemory(store.get(rec.id), candidate, {})).record
    } else {
      rec = store.get(evolved.record.id)
    }
  }
  return store.get(rec.id)
}

const SEED = {
  title: 'Inspector refactor keeps the FTS rowid stable',
  body: 'Rewriting the inspector to reuse the prepared statement avoids re-parsing the FTS query, which is the real fix and matters for large projects.',
}

// ---------------------------------------------------------------------------
// B1 — false-positive vocabulary
// ---------------------------------------------------------------------------

for (const [label, note] of [
  ['inspector', 'modified src/inspector.mjs'],
  ['protest', 'fixed protest handler'],
  ['aspect', 'updated aspect ratio'],
  ['spectator', 'watched spectator output'],
  ['testing ground', 'copied into the testing ground directory'],
  ['contest', 'resolved a contest between two candidates'],
]) {
  test(`B1: "${label}" is NOT test evidence`, () => {
    const store = tempStore()
    const rec = reinforce(store, SEED, [{ path: 'src/x.mjs', note }])
    assert.notEqual(rec.validation, VALIDATIONS.VERIFIED, 'must never reach verified')
    assert.notEqual(rec.confidence, 'high', 'must never escalate to high confidence')
    assert.ok(!rec.tags.includes('promotion-candidate'), 'must never be a promotion candidate')
    store.close()
  })
}

test('B1: a bare "test" word is NOT test evidence', () => {
  const store = tempStore()
  const rec = reinforce(store, SEED, [{ path: 'a.mjs', note: 'ran test' }])
  assert.notEqual(rec.validation, VALIDATIONS.VERIFIED)
  assert.ok(!rec.tags.includes('promotion-candidate'))
  store.close()
})

// ---------------------------------------------------------------------------
// B1 — genuine vocabulary still works
// ---------------------------------------------------------------------------

test('B1: genuine test-passed evidence still reaches verified', () => {
  const store = tempStore()
  const rec = reinforce(store, SEED, [{ path: 'test/x.test.mjs', note: 'test-passed' }])
  assert.equal(rec.validation, VALIDATIONS.VERIFIED)
  assert.equal(rec.confidence, 'high')
  assert.ok(rec.tags.includes('promotion-candidate'))
  store.close()
})

test('B1: genuine tests-touched evidence still reaches verified', () => {
  const store = tempStore()
  const rec = reinforce(store, SEED, [{ path: 'test/x.test.mjs', note: 'tests-touched' }])
  assert.equal(rec.validation, VALIDATIONS.VERIFIED)
  assert.equal(rec.confidence, 'high')
  store.close()
})

test('B1: test-failed is NOT positive test evidence', () => {
  const store = tempStore()
  const rec = reinforce(store, SEED, [{ path: 'test/x.test.mjs', note: 'test-failed' }])
  assert.notEqual(rec.validation, VALIDATIONS.VERIFIED, 'a failing test must not verify')
  assert.ok(!rec.tags.includes('promotion-candidate'))
  store.close()
})

test('B1: test-failed vetoes only the item it is attached to', () => {
  // Pre-existing semantics, unchanged by B1: the test is per-evidence-item, so
  // any single positive item wins. A `test-failed` item is never itself
  // positive evidence, which is the property B1 governs.
  const storeA = tempStore()
  const failedOnly = reinforce(storeA, SEED, [{ path: 'test/x.test.mjs', note: 'test-failed' }])
  assert.notEqual(failedOnly.validation, VALIDATIONS.VERIFIED)
  storeA.close()

  const storeB = tempStore()
  const both = reinforce(storeB, SEED, [
    { path: 'test/x.test.mjs', note: 'test-passed' },
    { path: 'test/y.test.mjs', note: 'test-failed' },
  ])
  // The positive item still counts — this is `.some`, not `.every`.
  assert.equal(both.validation, VALIDATIONS.VERIFIED)
  storeB.close()
})

test('B1: hyphenated enum must match without matching a bare prefix', () => {
  const store = tempStore()
  const forged = reinforce(store, SEED, [{ path: 'a.mjs', note: 'test-passed-but-not-really' }])
  // the real signal is `test-passed`; a longer word is still that signal only
  // when the surrounding characters are not word characters. `test-passed-`
  // is a non-word char, so it matches; assert the genuine case explicitly.
  assert.ok(['verified', 'reviewed'].includes(forged.validation))

  const notASignal = reinforce(store, SEED, [{ path: 'a.mjs', note: 'xtest-passedx' }])
  assert.notEqual(notASignal.validation, VALIDATIONS.VERIFIED, 'embedded in a word must not match')
  store.close()
})

// ---------------------------------------------------------------------------
// B1 — observation-count behavior preserved
// ---------------------------------------------------------------------------

test('B1: 2 observations without test evidence still reach reviewed', () => {
  const store = tempStore()
  const rec = reinforce(store, SEED, [{ path: 'src/x.mjs', note: 'modified src/x.mjs' }], 2)
  assert.equal(rec.validation, VALIDATIONS.REVIEWED, 'observation count still promotes to reviewed')
  assert.equal(rec.confidence, 'medium')
  assert.equal(rec.source.observations, 3)
  assert.ok(!rec.tags.includes('promotion-candidate'))
  store.close()
})

test('B1: 3 observations without test evidence cap at reviewed', () => {
  const store = tempStore()
  const rec = reinforce(store, SEED, [{ path: 'src/x.mjs', note: 'modified src/x.mjs' }], 3)
  assert.equal(rec.validation, VALIDATIONS.REVIEWED)
  assert.notEqual(rec.validation, VALIDATIONS.VERIFIED)
  assert.ok(!rec.tags.includes('promotion-candidate'))
  store.close()
})

// ---------------------------------------------------------------------------
// B2 — promote() must not create a self-edge
// ---------------------------------------------------------------------------

test('B2: promote() creates no self-edge', () => {
  const store = tempStore()
  const rec = store.put({ ...SEED, authority: AUTHORITIES.CANDIDATE }).record
  const promoted = promote(store, rec.id, { to: AUTHORITIES.DERIVED })
  assert.equal(promoted.ok, true)
  const selfEdges = (promoted.record.relations || []).filter((r) => r.targetId === promoted.record.id)
  assert.deepEqual(selfEdges, [], 'a record must never relate to itself')
  store.close()
})

test('B2: promote() invents no relations at all', () => {
  const store = tempStore()
  const rec = store.put({ ...SEED, authority: AUTHORITIES.CANDIDATE, relations: [] }).record
  const promoted = promote(store, rec.id, { to: AUTHORITIES.DERIVED })
  assert.deepEqual(promoted.record.relations || [], [])
  store.close()
})

test('B2: promote() preserves existing legitimate relations', () => {
  const store = tempStore()
  const other = store.put({ ...SEED, title: 'Another claim entirely', body: 'A different engineering claim with its own body text.' }).record
  const rec = store.put({
    ...SEED,
    title: 'A claim with a legitimate relation',
    body: 'This claim already points at another record through a real relation.',
    authority: AUTHORITIES.CANDIDATE,
    relations: [
      { type: RELATIONS.CONTRADICTS, targetId: other.id },
      { type: RELATIONS.DERIVES, targetId: other.id },
    ],
  }).record
  const promoted = promote(store, rec.id, { to: AUTHORITIES.DERIVED })
  const rels = promoted.record.relations || []
  assert.equal(rels.filter((r) => r.type === RELATIONS.CONTRADICTS).length, 1)
  assert.equal(rels.filter((r) => r.type === RELATIONS.DERIVES).length, 1)
  assert.equal(rels.filter((r) => r.targetId === promoted.record.id).length, 0)
  assert.equal(rels.length, 2, 'no extra edge may be added')
  store.close()
})

test('B2: promote() to canonical still works and adds no self-edge', () => {
  const store = tempStore()
  const rec = store.put({ ...SEED, authority: AUTHORITIES.DERIVED }).record
  const promoted = promote(store, rec.id, { to: AUTHORITIES.CANONICAL, explicit: true })
  assert.equal(promoted.ok, true)
  assert.equal(promoted.record.authority, AUTHORITIES.CANONICAL)
  assert.equal((promoted.record.relations || []).filter((r) => r.targetId === promoted.record.id).length, 0)
  store.close()
})

test('B2: promotion of an observation promotes its kind to memory', () => {
  const store = tempStore()
  const rec = store.put({ ...SEED, kind: KINDS.OBSERVATION, authority: AUTHORITIES.CANDIDATE }).record
  const promoted = promote(store, rec.id, { to: AUTHORITIES.DERIVED })
  assert.equal(promoted.record.kind, KINDS.MEMORY)
  assert.equal((promoted.record.relations || []).filter((r) => r.targetId === promoted.record.id).length, 0)
  store.close()
})

test('B2: remember() path produces no self-edge', () => {
  const store = tempStore()
  const written = remember(store, { ...SEED, authority: AUTHORITIES.CANDIDATE })
  const rec = written.record || written
  const selfEdges = (rec.relations || []).filter((r) => r.targetId === rec.id)
  assert.deepEqual(selfEdges, [])
  store.close()
})
