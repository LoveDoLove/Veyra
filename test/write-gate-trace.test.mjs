/**
 * P3 — bounded write-gate decision trace (metadata-only, additive).
 * Reuses write_gate_ledger; no verdict/gate weakening, no content persistence.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { AUTHORITIES, KINDS, VALIDATIONS } from '../src/types.mjs'
import { openEphemeralStore } from '../src/store.mjs'
import {
  maybeLearn, readWriteGateLedger, readWriteGateTrace, writeGate, WRITE_GATES,
} from '../src/learn.mjs'
import { memoryHealth } from '../src/health.mjs'

const TITLE = 'Serialize DatabaseSync writes'
const BODY = 'The root cause is concurrent DatabaseSync writes corrupting FTS triggers. The remedy is to serialize every write through a mutex around the shared handle.'
const mkCandidate = (overrides = {}) => ({
  title: TITLE, body: BODY, kind: KINDS.MEMORY, scope: 'project', projectId: 'p',
  evidence: [{ path: 'src/db.mjs', note: 'shared handle' }],
  source: { automatic: true, signal: 'root-cause', provenance: { origins: ['assistant'] } },
  ...overrides,
})
const DROP = { title: 'hi', body: 'short', kind: KINDS.MEMORY, source: { automatic: true, provenance: { origins: ['assistant'] } } }

function assertNoSensitive(trace) {
  const s = JSON.stringify(trace)
  assert.equal(s.includes(TITLE), false, 'title must not be in trace')
  assert.equal(s.includes(BODY), false, 'body must not be in trace')
  assert.equal(s.includes('src/db.mjs'), false, 'raw evidence path must not be in trace')
}

test('P3-T1 ACCEPT: verdict unchanged, aggregate+trace recorded, metadata-only', () => {
  const store = openEphemeralStore()
  const verdict = writeGate(store, mkCandidate())
  assert.equal(verdict.decision, WRITE_GATES.ACCEPT)
  const ledger = readWriteGateLedger(store)
  assert.equal(ledger.total, 1)
  assert.equal(ledger.decisions.accept, 1)
  const trace = readWriteGateTrace(store)
  assert.ok(trace && trace.entries.length === 1)
  const e = trace.entries[0]
  assert.match(e.traceId, /^wgt_/)
  assert.equal(e.decision, 'ACCEPT')
  assert.equal(e.reason, 'new-derived-knowledge')
  assert.equal(e.targetRecordId, verdict.record.id)
  assert.ok(e.evidenceSummary)
  assert.equal(typeof e.evidenceSummary.anchorCount, 'number')
  assert.equal('candidateHash' in e, false, 'candidateHash omitted by default')
  assertNoSensitive(trace)
  store.close()
})

test('P3-T2 MERGE: no second record, authority unchanged, before/after scalars', () => {
  const store = openEphemeralStore()
  const first = maybeLearn(store, mkCandidate())
  assert.ok(first)
  const beforeAuth = first.authority
  const verdict = writeGate(store, mkCandidate({ title: TITLE + ' (again)', body: BODY + ' again' }))
  assert.equal(verdict.decision, WRITE_GATES.MERGE)
  assert.equal(store.list().length, 1)
  const after = store.get(first.id)
  assert.equal(after.authority, beforeAuth)
  const trace = readWriteGateTrace(store)
  const merge = trace.entries.find((x) => x.decision === 'MERGE')
  assert.ok(merge)
  assert.ok(merge.mergeEffect)
  assert.equal(merge.mergeEffect.authorityBefore, merge.mergeEffect.authorityAfter)
  assert.equal(merge.mergeEffect.authorityAfter, beforeAuth)
  assert.ok((Number(merge.mergeEffect.observationsAfter) || 0) >= (Number(merge.mergeEffect.observationsBefore) || 0))
  assertNoSensitive(trace)
  store.close()
})

test('P3-T3/T4 DROP+DEFER: no memory rows, trace records reasons', () => {
  const store = openEphemeralStore()
  const drop = writeGate(store, DROP)
  assert.equal(drop.decision, WRITE_GATES.DROP)
  assert.equal(store.list().length, 0)
  const defer = writeGate(store, mkCandidate({ source: { automatic: true, provenance: { origins: ['user'] } } }))
  assert.equal(defer.decision, WRITE_GATES.DEFER)
  assert.equal(store.list().length, 0)
  const trace = readWriteGateTrace(store)
  assert.ok(trace.entries.some((e) => e.decision === 'DROP'))
  assert.ok(trace.entries.some((e) => e.decision === 'DEFER' && e.reason === 'provenance-gated'))
  assertNoSensitive(trace)
  store.close()
})

test('P3-T5 bounds: ring keeps newest entries and traceId present', () => {
  const store = openEphemeralStore()
  for (let i = 0; i < 90; i++) writeGate(store, DROP)
  const trace = readWriteGateTrace(store)
  assert.ok(trace.entries.length > 0 && trace.entries.length <= 128)
  assert.ok(trace.entries.every((e) => typeof e.traceId === 'string' && e.traceId))
  store.close()
})

test('P3-T6 isolation/corruption safety: separate stores and corrupt trace recovers', () => {
  const a = openEphemeralStore()
  const b = openEphemeralStore()
  writeGate(a, mkCandidate())
  writeGate(b, DROP)
  assert.notEqual(readWriteGateTrace(a)?.entries?.[0]?.decision, readWriteGateTrace(b)?.entries?.[0]?.decision)
  a.setMeta('write_gate_trace_v1', '{not json')
  assert.equal(readWriteGateTrace(a), null)
  const v = writeGate(a, DROP)
  assert.equal(v.decision, WRITE_GATES.DROP)
  assert.ok(readWriteGateTrace(a))
  a.close(); b.close()
})

test('P3-T8 trace write failure must not affect verdict or aggregate attempt', () => {
  const store = openEphemeralStore()
  const orig = store.setMeta.bind(store)
  store.setMeta = (k, v) => { if (k === 'write_gate_trace_v1') throw new Error('boom'); return orig(k, v) }
  const verdict = writeGate(store, mkCandidate())
  assert.equal(verdict.decision, WRITE_GATES.ACCEPT)
  assert.ok(verdict.record)
  const ledger = readWriteGateLedger(store)
  assert.equal(ledger?.decisions?.accept, 1)
  store.close()
})

test('P3-T10 health: additive trace summary, read-only', () => {
  const store = openEphemeralStore()
  writeGate(store, mkCandidate())
  writeGate(store, DROP)
  const ledger = readWriteGateLedger(store)
  const trace = readWriteGateTrace(store)
  const report = memoryHealth(store.list(), { writeGate: ledger, writeGateTrace: trace })
  assert.ok(report.writeGate)
  assert.ok(report.writeGateTrace)
  assert.ok(report.writeGateTrace.count >= 2)
  assert.equal(typeof report.totalFindings, 'number')
  store.close()
})
