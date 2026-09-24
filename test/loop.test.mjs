import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply } from '../src/plugin.mjs'
import { createContextProvider, queryFromAssemble, rememberClaimedPrompt } from '../src/context.mjs'
import { closeAllStores } from '../src/store.mjs'
import { AUTHORITIES } from '../src/types.mjs'

function mockCtx() {
  const listeners = {}
  return {
    tools: { register: () => {} },
    commands: { register: () => {} },
    skills: { register: () => {}, registerProvider: () => () => {} },
    systemPrompt: { section: () => {}, context: () => {} },
    on: (event, fn) => {
      listeners[event] = listeners[event] || []
      listeners[event].push(fn)
    },
    effect: (factory) => factory(),
    _listeners: listeners,
  }
}

function emit(ctx, event, ...args) {
  for (const fn of ctx._listeners[event] || []) fn(...args)
}

function userMessage(text) {
  return {
    role: 'user',
    source: { kind: 'user' },
    content: [{ type: 'text', text }],
  }
}

test('queryFromAssemble prefers claimed inbox text over deriveMessages()', () => {
  const agent = {
    session: {
      deriveMessages: () => [userMessage('older history about fonts')],
    },
    inbox: { nextStep: [], nextTurn: [] },
  }
  rememberClaimedPrompt(agent, userMessage('Diagnose the sqlite writer race and lock DatabaseSync writes.'))
  assert.match(queryFromAssemble({ agent }), /sqlite writer race/)
})

test('queryFromAssemble falls back to deriveMessages when nothing is claimed', () => {
  const agent = {
    session: {
      deriveMessages: () => [
        { role: 'user', source: { kind: 'plugin', plugin: 'veyra' }, content: [{ type: 'text', text: 'Veyra recalled engineering memory' }] },
        userMessage('Where does Veyra persist memory outside the repo?'),
      ],
    },
    inbox: { nextStep: [], nextTurn: [] },
  }
  assert.match(queryFromAssemble({ agent }), /persist memory/)
})

test('session A work is observed, learned, and recalled on session B assemble', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'veyra-e2e-'))
  const cwd = process.cwd()
  const ctx = mockCtx()
  const dispose = apply(ctx, { home: dir, observe: true, learn: true })

  const sessionA = { id: 'session-a', header: { cwd } }
  const agentA = { session: sessionA }

  emit(ctx, 'session/event', sessionA, { type: 'turn/start', data: { turn: 1 } })
  emit(ctx, 'session/event', sessionA, {
    type: 'user/message',
    data: userMessage('The root cause is a sqlite writer race. Always serialize DatabaseSync writes so FTS triggers stop corrupting.'),
  })
  emit(ctx, 'session/event', sessionA, {
    type: 'assistant/message',
    data: {
      turn: 1,
      step: 1,
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: 'I will lock the writer. The decision is to serialize DatabaseSync writes.' }],
      },
    },
  })
  emit(ctx, 'session/event', sessionA, {
    type: 'tool/call',
    data: {
      turn: 1,
      step: 1,
      callId: 'call_1',
      name: 'edit',
      arguments: JSON.stringify({ file_path: 'src/store.mjs' }),
    },
  })
  emit(ctx, 'session/event', sessionA, {
    type: 'tool/result',
    data: {
      turn: 1,
      step: 1,
      message: {
        role: 'user',
        source: { kind: 'tool', callId: 'call_1' },
        content: [{ type: 'tool-result', toolCallId: 'call_1', content: [{ type: 'text', text: 'updated src/store.mjs' }] }],
      },
    },
  })
  emit(ctx, 'agent/turn-stopping', { agent: agentA })

  closeAllStores()

  const sessionB = {
    id: 'session-b',
    header: { cwd },
    deriveMessages: () => [],
  }
  const agentB = { session: sessionB, inbox: { nextStep: [], nextTurn: [] } }
  emit(ctx, 'agent/inbox/claimed', {
    agent: agentB,
    message: userMessage('The sqlite writer is racing again. How did we lock DatabaseSync last time?'),
  })

  const provider = createContextProvider({
    veyraHome: dir,
    fallbackCwd: cwd,
    recallLimit: 5,
    includeReusable: true,
  })
  const injected = provider({ agent: agentB })
  assert.ok(injected.includes('not repository truth'))
  assert.match(injected, /sqlite|DatabaseSync|writer/i)
  assert.ok(!injected.includes(AUTHORITIES.CANDIDATE))

  dispose?.()
  closeAllStores()
  rmSync(dir, { recursive: true, force: true })
})
