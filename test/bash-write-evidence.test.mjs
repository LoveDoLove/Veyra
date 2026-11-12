import test from 'node:test'
import assert from 'node:assert/strict'
import { observeEvent, newBuffer } from '../src/observe.mjs'

function call(buffer, name, args) {
  observeEvent(buffer, {}, { type: 'tool/call', data: { name, arguments: JSON.stringify(args), callId: 'c1' } })
}

test('sed -i records the edited file', () => {
  const b = newBuffer()
  call(b, 'bash', { command: "sed -i 's/a/b/' src/store.mjs" })
  assert.ok(b.files.has('src/store.mjs'))
})

test('shell redirection records the target file', () => {
  const b = newBuffer()
  call(b, 'bash', { command: 'echo "x" > src/new.mjs' })
  assert.ok(b.files.has('src/new.mjs'))
})

test('tee records its target file', () => {
  const b = newBuffer()
  call(b, 'bash', { command: 'cat a | tee src/out.mjs' })
  assert.ok(b.files.has('src/out.mjs'))
})

test('scratch and device paths are not evidence', () => {
  const b = newBuffer()
  call(b, 'bash', { command: 'node probe.cjs > /dev/null 2>&1' })
  call(b, 'bash', { command: 'echo x > /tmp/probe.cjs' })
  assert.deepEqual([...b.files], [])
})

test('a read-only bash command records nothing', () => {
  const b = newBuffer()
  call(b, 'bash', { command: 'grep -rn lockWriter src/' })
  assert.deepEqual([...b.files], [])
})

test('a redirect inside quotes is not a write', () => {
  const b = newBuffer()
  call(b, 'bash', { command: 'grep -rn "foo>bar" src/' })
  assert.deepEqual([...b.files], [], 'a quoted > is an argument, and a bogus path still grounds a record')
})
