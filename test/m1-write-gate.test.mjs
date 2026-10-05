/**
 * M1 — Write gate (GOAL.md Phase 1).
 *
 * Every learning decision must be one of ACCEPT / MERGE / DROP / DEFER and
 * must carry a reason Veyra can explain. The gate is integrated with
 * Candidate / Evidence / Validation / Authority:
 *
 *   - ACCEPT writes a derived record (candidate → derived, unverified or
 *     reviewed when test evidence is present).
 *   - MERGE strengthens an existing derived neighbor instead of writing a
 *     second record.
 *   - DROP rejects noise and verbatim duplicates without touching memory.
 *   - DEFER keeps the record exactly as captured when it is not learnable
 *     now (provenance-gated automatic records, canonical records).
 *
 * The guard chain is unchanged: provenance first, then durability, then the
 * verbatim content-hash check, then evolveAgainst.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  AUTHORITIES,
  KINDS,
  VALIDATIONS,
} from '../src/types.mjs'
import { openEphemeralStore } from '../src/store.mjs'
import { maybeLearn, reviewCandidate, writeGate, WRITE_GATES } from '../src/learn.mjs'

const TITLE = 'Serialize DatabaseSync writes'
const BODY = 'The root cause is concurrent DatabaseSync writes corrupting FTS triggers. The remedy is to serialize every write through a mutex around the shared handle.'

const mkCandidate = (overrides = {}) => ({
  title: overrides.title ?? TITLE,
  body: overrides.body ?? BODY,
  scope: 'project',
  projectId: 'p_m1',
  kind: KINDS.OBSERVATION,
  authority: AUTHORITIES.CANDIDATE,
  tags: ['observation'],
  evidence: [{ path: 'src/store.mjs', note: 'test-passed' }],
  source: { automatic: true, signal: 'decision', provenance: { origins: ['assistant'] } },
  ...overrides,
})

test('writeGate ACCEPTs a durable grounded candidate as new derived knowledge', () => {
  const store = openEphemeralStore()
  const gate = writeGate(store, mkCandidate())
  assert.equal(gate.decision, WRITE_GATES.ACCEPT)
  assert.equal(gate.reason, 'new-derived-knowledge')
  assert.ok(gate.record)
  assert.equal(gate.record.authority, AUTHORITIES.DERIVED)
  assert.equal(gate.record.kind, KINDS.MEMORY)
  // test evidence → reviewed, not unverified
  assert.equal(gate.record.validation, VALIDATIONS.REVIEWED)
  // the verdict is persisted on the record so inspection can explain it
  assert.deepEqual(gate.record.source.writeGate, { decision: WRITE_GATES.ACCEPT, reason: 'new-derived-knowledge' })
  store.close()
})

test('writeGate MERGEs a near-duplicate into the existing derived neighbor', () => {
  const store = openEphemeralStore()
  const neighbor = store.put({
    title: 'Always serialize DatabaseSync writes',
    body: 'Always serialize DatabaseSync writes to avoid FTS corruption.',
    authority: AUTHORITIES.DERIVED,
    evidence: [{ path: 'src/store.mjs' }],
  })
  // near-verbatim restatement (tokenSim > 0.9, not an extension)
  const gate = writeGate(store, mkCandidate({
    title: 'Always serialize DatabaseSync writes',
    body: 'Always serialize DatabaseSync writes to avoid FTS corruption.',
  }))
  assert.equal(gate.decision, WRITE_GATES.MERGE)
  assert.equal(gate.reason, 'near-duplicate-strengthened')
  assert.equal(gate.record, null)
  assert.equal(gate.neighbor.id, neighbor.record.id)
  // the neighbor was strengthened in place: observation count bumped
  const after = store.get(neighbor.record.id)
  assert.ok(after.source.observations >= 2, `expected strengthened observations, got ${after.source.observations}`)
  store.close()
})

test('writeGate DROPs non-durable noise without writing anything', () => {
  const store = openEphemeralStore()
  const gate = writeGate(store, mkCandidate({
    title: 'Looked at files',
    body: 'Opened a few files and listed the directory. Nothing conclusive yet.',
  }))
  assert.equal(gate.decision, WRITE_GATES.DROP)
  assert.equal(gate.reason, 'not-durable')
  assert.equal(gate.record, null)
  assert.equal(store.list({ limit: 10 }).length, 0)
  store.close()
})

test('writeGate MERGEs a verbatim duplicate of existing derived knowledge', () => {
  const store = openEphemeralStore()
  const neighbor = store.put({
    title: TITLE,
    body: BODY,
    authority: AUTHORITIES.DERIVED,
    evidence: [{ path: 'src/store.mjs' }],
  })
  const gate = writeGate(store, mkCandidate())
  assert.equal(gate.decision, WRITE_GATES.MERGE)
  assert.equal(gate.reason, 'near-duplicate-strengthened')
  assert.equal(gate.record, null)
  // still exactly one record — the neighbor was strengthened, not duplicated
  assert.equal(store.list({ limit: 10 }).length, 1)
  const after = store.get(neighbor.record.id)
  assert.ok(after.source.observations >= 2)
  store.close()
})

test('writeGate DEFERs a provenance-gated automatic record, leaving it untouched', () => {
  const store = openEphemeralStore()
  const candidate = mkCandidate({
    source: { automatic: true, signal: 'decision', provenance: { origins: ['user'] } },
  })
  const gate = writeGate(store, candidate)
  assert.equal(gate.decision, WRITE_GATES.DEFER)
  assert.equal(gate.reason, 'provenance-gated')
  assert.equal(gate.record, null)
  // the record is not written by the gate at all — nothing to inspect
  assert.equal(store.list({ limit: 10 }).length, 0)
  store.close()
})

test('writeGate DEFERs a canonical record — automatic path never touches canonical', () => {
  const store = openEphemeralStore()
  const gate = writeGate(store, mkCandidate({ authority: AUTHORITIES.CANONICAL }))
  assert.equal(gate.decision, WRITE_GATES.DEFER)
  assert.equal(gate.reason, 'canonical-requires-explicit-promotion')
  assert.equal(gate.record, null)
  store.close()
})

test('maybeLearn keeps its record|null contract on top of the gate', () => {
  const store = openEphemeralStore()
  const accepted = maybeLearn(store, mkCandidate())
  assert.ok(accepted)
  assert.equal(accepted.authority, AUTHORITIES.DERIVED)

  const dropped = maybeLearn(store, mkCandidate({
    title: 'Looked at files',
    body: 'Opened a few files and listed the directory. Nothing conclusive yet.',
  }))
  assert.equal(dropped, null)
  store.close()
})

test('reviewCandidate surfaces the gate decision on every outcome', () => {
  const store = openEphemeralStore()
  const written = store.put(mkCandidate())
  const r = reviewCandidate(store, written.record)
  assert.equal(r.outcome, 'transitioned')
  assert.equal(r.decision, WRITE_GATES.ACCEPT)
  assert.equal(r.reason, 'new-derived-knowledge')
  assert.equal(r.record.authority, AUTHORITIES.DERIVED)
  store.close()
})

test('reviewCandidate reports DEFER with reason when provenance blocks learning', () => {
  const store = openEphemeralStore()
  const written = store.put(mkCandidate({
    source: { automatic: true, signal: 'decision', provenance: { origins: ['user'] } },
  }))
  const r = reviewCandidate(store, written.record)
  assert.equal(r.outcome, 'unchanged')
  assert.equal(r.decision, WRITE_GATES.DEFER)
  assert.equal(r.reason, 'provenance-gated')
  // candidate preserved exactly as captured
  assert.equal(store.get(written.record.id).authority, AUTHORITIES.CANDIDATE)
  store.close()
})
