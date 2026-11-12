import test from 'node:test'
import assert from 'node:assert/strict'
import { diffMemory, extractCauseLine, DIFF, CAUSE_FACET_SIM } from '../src/diff.mjs'

// Verbatim from two live records whose Root cause lines are identical.
const CAUSE_A = 'client-side resolveActiveWorkspaceCwd depends on bestEffortActiveSessionId which reads a non-existent active.sessionId'
const a = {
  id: 'vey_a',
  title: 'Cause: client-side — resolveActiveWorkspaceCwd depends on bestEffortActiveSessionId',
  body: `Symptom: cwd is wrong.\nRoot cause: ${CAUSE_A}\nFiles touched: src/workspace.mjs, src/session.mjs, src/index.mjs\nTools: bash, read, edit`,
}
const b = {
  id: 'vey_b',
  title: 'Cause: client-side resolveActiveWorkspaceCwd depends on bestEffortActiveSessionId',
  body: `Root cause: ${CAUSE_A}\nFiles touched: src/workspace.mjs\nTools: bash`,
}

test('extractCauseLine returns the Root cause facet', () => {
  assert.equal(extractCauseLine(a), CAUSE_A)
  assert.equal(extractCauseLine({ title: 'Engineering observation', body: 'no facet here' }), '')
})

test('an identical root cause is a duplicate despite a much shorter body', () => {
  assert.equal(diffMemory(b, [a]).suggestion, DIFF.DUPLICATE)
})

test('a reworded root cause is still a duplicate', () => {
  const c = { ...b, id: 'vey_c', body: `Root cause: resolveActiveWorkspaceCwd depends on bestEffortActiveSessionId, which reads a non-existent active.sessionId\nTools: bash` }
  assert.equal(diffMemory(c, [a]).suggestion, DIFF.DUPLICATE)
})

test('a different root cause is never a duplicate', () => {
  const d = {
    id: 'vey_d',
    title: 'Cause: writer lock is never released on timeout',
    body: 'Root cause: the writer lock is never released when the timeout fires, so the next turn deadlocks.\nTools: bash',
  }
  assert.notEqual(diffMemory(d, [a]).suggestion, DIFF.DUPLICATE)
  assert.equal(diffMemory(d, [a]).causeDuplicate, false)
})

test('records without a root cause are never cause-duplicates', () => {
  const e = { id: 'vey_e', title: 'Engineering observation', body: 'General note about writer locks.' }
  const f = { id: 'vey_f', title: 'Engineering observation', body: 'General note about writer locks.' }
  assert.equal(diffMemory(f, [e]).causeDuplicate, false)
})

test('the threshold is a named constant in a defensible band', () => {
  assert.equal(CAUSE_FACET_SIM, 0.7)
})

test('a cause-duplicate reaches the merge decision, not just the diff', async () => {
  const { evolveAgainst } = await import('../src/evolve.mjs')
  const res = evolveAgainst(null, b, [a])
  assert.equal(res.action, 'duplicate', 'the write gate merges on this action')
  assert.equal(res.neighbor.id, 'vey_a')
  assert.deepEqual(res.record.relations, [{ type: 'extends', targetId: 'vey_a' }])
})
