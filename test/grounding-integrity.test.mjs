import test from 'node:test'
import assert from 'node:assert/strict'
import { hasGrounding } from '../src/learn.mjs'

test('symbol-only evidence is not grounding', () => {
  assert.equal(hasGrounding({ evidence: [{ note: 'sym:receives' }, { note: 'sym:value' }] }), false)
})

test('a real path is grounding', () => {
  assert.equal(hasGrounding({ evidence: [{ path: 'src/store.mjs' }] }), true)
})

test('a test signal is grounding', () => {
  assert.equal(hasGrounding({ evidence: [{ note: 'test-passed: 42 pass' }] }), true)
})

test('path plus symbol is grounding', () => {
  assert.equal(hasGrounding({ evidence: [{ path: 'src/x.mjs' }, { note: 'sym:lockWriter' }] }), true)
})
