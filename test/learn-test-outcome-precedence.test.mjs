import { test } from 'node:test'
import assert from 'node:assert/strict'
import { AUTHORITIES, VALIDATIONS } from '../src/types.mjs'
import { openEphemeralStore } from '../src/store.mjs'
import { distillBuffer, newBuffer, observeEvent } from '../src/observe.mjs'
import { writeGate } from '../src/learn.mjs'

// Task 15 — Opportunistic Learning Quality: a failed test execution in the
// same turn must not be overwritten by a later passing result. test-failed
// remains a failed attempt, never completed/verified work.

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

test('testOutcomeFrom/distill: later passing result must not erase an earlier test failure in the same turn', () => {
  const buffer = newBuffer()
  observeEvent(buffer, {}, { type: 'turn/start', data: { turn: 1 } })
  observeEvent(buffer, {}, {
    type: 'user/message',
    data: { content: [{ type: 'text', text: 'Root cause: sqlite writer race caused flaky tests. Fix by serializing writes in the store.' }] },
  })
  observeEvent(buffer, {}, { type: 'tool/call', data: { name: 'bash', arguments: { command: 'node --test test/store.test.mjs' } } })
  observeEvent(buffer, {}, { type: 'tool/result', data: { name: 'bash', output: 'FAIL src/store.test.mjs\n1 failed, 2 passed\n[exit code: 1]' } })
  observeEvent(buffer, {}, { type: 'tool/call', data: { name: 'bash', arguments: { command: 'node --test test/store.test.mjs' } } })
  observeEvent(buffer, {}, { type: 'tool/result', data: { name: 'bash', output: '✔ 3 tests passed\n0 failed' } })
  observeEvent(buffer, {}, { type: 'tool/call', data: { name: 'edit', arguments: { file_path: 'src/store.mjs' } } })

  const c = distillBuffer(buffer, { projectId: 'p_t15', cwd: process.cwd() })
  assert.ok(c, 'expected a causal candidate')
  assert.equal(c.source?.causal?.verifiedOutcome, 'test-failed', 'any observed failure must dominate a later pass')
  const notes = (c.evidence || []).map((e) => e.note).filter(Boolean)
  assert.ok(notes.includes('test-failed'), `expected test-failed evidence, got ${JSON.stringify(notes)}`)
  assert.ok(!notes.includes('test-passed'), `must not record test-passed when a failure was observed, got ${JSON.stringify(notes)}`)
  assert.ok(!(c.tags || []).includes('verified-test'), 'must not tag verified-test when a failure was observed')
})

test('writeGate: a turn with observed failure then later pass is not learned as reviewed/verified success', () => {
  const buffer = newBuffer()
  observeEvent(buffer, {}, { type: 'turn/start', data: { turn: 1 } })
  observeEvent(buffer, {}, {
    type: 'assistant/message',
    data: { content: [{ type: 'text', text: 'Root cause: sqlite writer race caused flaky tests. Fix by serializing writes in the store.' }] },
  })
  observeEvent(buffer, {}, { type: 'tool/call', data: { name: 'edit', arguments: { file_path: 'src/store.mjs' } } })
  observeEvent(buffer, {}, { type: 'tool/call', data: { name: 'bash', arguments: { command: 'node --test test/store.test.mjs' } } })
  observeEvent(buffer, {}, { type: 'tool/result', data: { name: 'bash', output: 'FAIL src/store.test.mjs\n1 failed\n[exit code: 1]' } })
  observeEvent(buffer, {}, { type: 'tool/call', data: { name: 'bash', arguments: { command: 'node --test test/store.test.mjs' } } })
  observeEvent(buffer, {}, { type: 'tool/result', data: { name: 'bash', output: '3 passed, 0 failed' } })

  const c = assistantOnly(distillBuffer(buffer, { projectId: 'p_t15', cwd: process.cwd() }))
  assert.ok(c)
  assert.equal(c.source?.causal?.verifiedOutcome, 'test-failed')

  const store = openEphemeralStore()
  try {
    const gate = writeGate(store, c)
    // If learned, it must never be treated as a verified/passed success.
    if (gate.record) {
      assert.equal(gate.record.authority, AUTHORITIES.DERIVED, 'automatic learning must not create canonical truth')
      assert.notEqual(gate.record.validation, VALIDATIONS.VERIFIED, 'failed-then-passed turn must not be verified')
      assert.ok(!(gate.record.tags || []).includes('verified-test'), 'must not carry verified-test tag')
      const notes = (gate.record.evidence || []).map((e) => e.note).filter(Boolean)
      assert.ok(!notes.includes('test-passed'), 'must not persist test-passed evidence')
    }
    // DEFER/DROP are also acceptable fail-closed outcomes; ACCEPT-as-success is not.
  } finally {
    store.close()
  }
})

test('distill: pass-only turn still records test-passed (no regression)', () => {
  const buffer = newBuffer()
  observeEvent(buffer, {}, { type: 'turn/start', data: { turn: 1 } })
  observeEvent(buffer, {}, {
    type: 'user/message',
    data: { content: [{ type: 'text', text: 'Root cause: sqlite writer race caused flaky tests. Fix by serializing writes in the store.' }] },
  })
  observeEvent(buffer, {}, { type: 'tool/call', data: { name: 'bash', arguments: { command: 'node --test test/store.test.mjs' } } })
  observeEvent(buffer, {}, { type: 'tool/result', data: { name: 'bash', output: '3 passed, 0 failed' } })
  observeEvent(buffer, {}, { type: 'tool/call', data: { name: 'edit', arguments: { file_path: 'src/store.test.mjs' } } })

  const c = distillBuffer(buffer, { projectId: 'p_t15', cwd: process.cwd() })
  assert.ok(c)
  assert.equal(c.source?.causal?.verifiedOutcome, 'test-passed')
  assert.ok((c.evidence || []).some((e) => e.note === 'test-passed'))
  assert.ok((c.tags || []).includes('verified-test'))
})
