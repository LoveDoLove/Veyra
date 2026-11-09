import { test } from 'node:test'
import assert from 'node:assert/strict'
import { AUTHORITIES, VALIDATIONS } from '../src/types.mjs'
import { openEphemeralStore } from '../src/store.mjs'
import { distillBuffer, newBuffer, observeEvent } from '../src/observe.mjs'
import { writeGate } from '../src/learn.mjs'

// Task 16 — Learning Outcome Semantics.
// Historical failure must be preserved. A later pass represents final
// verification only when existing ordered evidence shows:
//   initial test failure -> identifiable corrective action -> passing test.
// Without corrective action, or with ambiguous/incomplete output, do not
// infer verified recovery.

const CLAIM = 'Root cause: sqlite writer race caused flaky tests. Fix by serializing writes in the store.'

function assistantOnly(c) {
  return {
    ...c,
    source: {
      ...c.source,
      automatic: true,
      userContextOnly: false,
      provenance: { origins: ['assistant', 'tool'] },
    },
  }
}

function mkTurn(steps, { cwd = process.cwd() } = {}) {
  const buffer = newBuffer()
  observeEvent(buffer, {}, { type: 'turn/start', data: { turn: 1 } })
  observeEvent(buffer, {}, {
    type: 'assistant/message',
    data: { content: [{ type: 'text', text: CLAIM }] },
  })
  for (const s of steps) {
    if (s.edit) {
      observeEvent(buffer, {}, {
        type: 'tool/call',
        data: { name: typeof s.edit === 'string' ? 'edit' : s.edit.name, arguments: typeof s.edit === 'string' ? { file_path: s.edit } : s.edit.args },
      })
    }
    if (s.cmd) observeEvent(buffer, {}, { type: 'tool/call', data: { name: 'bash', arguments: { command: s.cmd } } })
    if (s.out) observeEvent(buffer, {}, { type: 'tool/result', data: { name: 'bash', output: s.out } })
  }
  return distillBuffer(buffer, { projectId: 'p_t16', cwd })
}

function notes(c) { return (c.evidence || []).map((e) => e.note).filter(Boolean) }

test('A: failure only is not successful and preserves failure evidence', () => {
  const c = mkTurn([{ cmd: 'node --test test/store.test.mjs', out: 'FAIL src/store.test.mjs\n1 failed\n[exit code: 1]' }])
  assert.ok(c)
  assert.equal(c.source?.causal?.verifiedOutcome, 'test-failed')
  assert.ok(notes(c).includes('test-failed'))
  assert.ok(!notes(c).includes('test-passed'))
  assert.ok(!(c.tags || []).includes('verified-test'))

  const store = openEphemeralStore()
  const gate = writeGate(store, assistantOnly(c), { cwd: process.cwd() })
  assert.equal(gate.decision, 'ACCEPT')
  assert.notEqual(gate.record?.validation, VALIDATIONS.VERIFIED)
  store.close()
})

test('B: pass only preserves existing successful-test behavior', () => {
  const c = mkTurn([{ cmd: 'node --test test/store.test.mjs', out: '✔ 58 tests pass\n0 failed' }])
  assert.ok(c)
  assert.equal(c.source?.causal?.verifiedOutcome, 'test-passed')
  assert.ok(notes(c).includes('test-passed'))
  assert.ok(!notes(c).includes('test-failed'))
  assert.ok((c.tags || []).includes('verified-test'))
})

test('C: failure -> corrective action -> pass preserves failure history and allows final verified recovery only with evidence', () => {
  const c = mkTurn([
    { cmd: 'node --test test/store.test.mjs', out: 'FAIL src/store.test.mjs\n1 failed\n[exit code: 1]' },
    { edit: 'src/store.mjs' },
    { cmd: 'node --test test/store.test.mjs', out: '✔ 58 tests pass\n0 failed' },
  ])
  assert.ok(c)
  assert.equal(c.source?.causal?.verifiedOutcome, 'test-passed', 'final verification supported by failure->corrective->pass')
  assert.ok(notes(c).includes('test-failed'), 'historical failure preserved')
  assert.ok(notes(c).includes('test-passed'), 'later verified pass recorded')
  assert.ok((c.tags || []).includes('verified-test'))
  assert.ok((c.tags || []).includes('edited'))

  const store = openEphemeralStore()
  const gate = writeGate(store, assistantOnly(c), { cwd: process.cwd() })
  assert.equal(gate.decision, 'ACCEPT')
  // Failure history is present in evidence; candidate is not auto-canonical.
  assert.notEqual(gate.record?.authority, AUTHORITIES.CANONICAL)
  assert.ok(notes(gate.record || c).includes('test-failed'))
  store.close()
})

test('D: failure -> pass without identifiable corrective action is conservative (no inferred resolution)', () => {
  const c = mkTurn([
    { cmd: 'node --test test/store.test.mjs', out: 'FAIL src/store.test.mjs\n1 failed\n[exit code: 1]' },
    { cmd: 'node --test test/store.test.mjs', out: '✔ 58 tests pass\n0 failed' },
  ])
  assert.ok(c)
  assert.equal(c.source?.causal?.verifiedOutcome, 'test-failed')
  assert.ok(notes(c).includes('test-failed'))
  assert.ok(!notes(c).includes('test-passed'))
  assert.ok(!(c.tags || []).includes('verified-test'))

  const store = openEphemeralStore()
  const gate = writeGate(store, assistantOnly(c), { cwd: process.cwd() })
  assert.equal(gate.decision, 'ACCEPT')
  assert.notEqual(gate.record?.validation, VALIDATIONS.VERIFIED)
  store.close()
})

test('D (conservative): run_code without explicit edit/write signal is not treated as corrective action', () => {
  const c = mkTurn([
    { cmd: 'node --test test/store.test.mjs', out: 'FAIL src/store.test.mjs\n1 failed\n[exit code: 1]' },
    { edit: { name: 'run_code', args: { description: 'inspect state', code: 'console.log(1)' } } },
    { cmd: 'node --test test/store.test.mjs', out: '✔ 58 tests pass\n0 failed' },
  ])
  assert.ok(c)
  assert.equal(c.source?.causal?.verifiedOutcome, 'test-failed')
  assert.ok(notes(c).includes('test-failed'))
  assert.ok(!notes(c).includes('test-passed'))
})

test('E: ambiguous or incomplete test output does not infer verified success', () => {
  const c = mkTurn([
    { cmd: 'node --test test/store.test.mjs', out: 'running tests... done maybe' },
  ])
  assert.ok(c)
  assert.equal(c.source?.causal?.verifiedOutcome, null)
  assert.ok(notes(c).includes('tests-touched'))
  assert.ok(!notes(c).includes('test-passed'))
  assert.ok(!notes(c).includes('test-failed'))
  assert.ok(!(c.tags || []).includes('verified-test'))
})
