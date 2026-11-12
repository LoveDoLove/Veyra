import test from 'node:test'
import assert from 'node:assert/strict'
import { extractSymbols } from '../src/understand.mjs'

test('real prose yields no symbols', () => {
  const prose = 'I need to check the body signature and the args that the function receives. The const value is undefined here.'
  assert.deepEqual(extractSymbols(prose), [])
})

test('code-shaped declarations still yield symbols', () => {
  assert.deepEqual(extractSymbols('export async function lockWriter() {}'), ['lockWriter'])
  assert.deepEqual(extractSymbols('export function lockWriter() { return 1 }'), ['lockWriter'])
  assert.deepEqual(extractSymbols('const path = 1'), ['path'])
  assert.deepEqual(extractSymbols('class Foo {'), ['Foo'])
})

test('prose mention of a real identifier is not a declaration', () => {
  assert.deepEqual(extractSymbols('Looking at this, the `const body` line matters.'), [])
})

test('live garbage title yields no symbols', () => {
  assert.deepEqual(extractSymbols('Cause: of low quality? Let me verify quickly the actual reason: looksDurable = logic'), [])
})
