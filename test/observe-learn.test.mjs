import { test } from 'node:test'
import assert from 'node:assert/strict'
import { AUTHORITIES, KINDS } from '../src/types.mjs'
import { openEphemeralStore } from '../src/store.mjs'
import { candidateFromBuffer, isNoiseText, newBuffer, observeEvent } from '../src/observe.mjs'
import { looksDurable, maybeLearn, promote, remember } from '../src/learn.mjs'
import { isRecallEligible } from '../src/types.mjs'

test('short or slash-command text is noise', () => {
  assert.equal(isNoiseText('ok'), true)
  assert.equal(isNoiseText('/veyra status'), true)
  assert.equal(isNoiseText('These items are remembered engineering experience, not repository truth.'), true)
  assert.equal(isNoiseText('Please diagnose the sqlite writer race and lock the connection.'), false)
})

test('observe → candidate is never recall-eligible', () => {
  const buffer = newBuffer()
  observeEvent(buffer, {}, { type: 'turn/start', data: { turn: 1 } })
  observeEvent(buffer, {}, {
    type: 'user/message',
    data: { content: [{ type: 'text', text: 'Diagnose the sqlite writer race and lock the connection so tests stop flaking.' }] },
  })
  observeEvent(buffer, {}, {
    type: 'tool/call',
    data: { name: 'edit', arguments: { path: 'src/store.mjs' } },
  })
  const candidate = candidateFromBuffer(buffer, { projectId: 'p_test', sessionId: 's1' })
  assert.ok(candidate)
  assert.equal(candidate.authority, AUTHORITIES.CANDIDATE)
  assert.equal(candidate.kind, KINDS.OBSERVATION)
  assert.equal(isRecallEligible(candidate), false)
})

test('learning promotes durable candidates to derived, never canonical', () => {
  const store = openEphemeralStore()
  const learned = maybeLearn(store, {
    title: 'Root cause: sqlite writer race',
    body: 'The decision is to always serialize DatabaseSync writes. The root cause was concurrent put() calls corrupting FTS triggers.',
    scope: 'project',
    projectId: 'p_test',
    tags: ['observation'],
    evidence: [{ path: 'src/store.mjs' }],
    source: { automatic: true },
  })
  assert.ok(learned)
  assert.equal(learned.authority, AUTHORITIES.DERIVED)
  assert.ok(isRecallEligible(learned))
  store.close()
})

test('non-durable observations are not learned', () => {
  const store = openEphemeralStore()
  const learned = maybeLearn(store, {
    title: 'Looked at files',
    body: 'Opened a few files and listed the directory. Nothing conclusive yet.',
    scope: 'project',
    projectId: 'p_test',
  })
  assert.equal(learned, null)
  store.close()
})

test('remember refuses to store canonical unless explicit', () => {
  const store = openEphemeralStore()
  const written = remember(store, {
    title: 'Use FTS5 quotes',
    body: 'Always quote tokens before MATCH.',
    authority: AUTHORITIES.CANONICAL,
  })
  assert.equal(written.record.authority, AUTHORITIES.DERIVED)
  const blocked = promote(store, written.record.id, { to: AUTHORITIES.CANONICAL, explicit: false })
  assert.equal(blocked.ok, false)
  const ok = promote(store, written.record.id, { to: AUTHORITIES.CANONICAL, explicit: true })
  assert.equal(ok.ok, true)
  assert.equal(ok.record.authority, AUTHORITIES.CANONICAL)
  store.close()
})

test('looksDurable detects engineering lessons', () => {
  assert.equal(looksDurable('The root cause was a missing WAL checkpoint after crash recovery.'), true)
  assert.equal(looksDurable('hello world this is a short note without signal words present'), false)
})
