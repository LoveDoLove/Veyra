/**
 * Task 8 — a turn that passes tests records a non-causal outcome signal.
 *
 * `test-passed` / `test-failed` are evidence notes Veyra derives from test-runner
 * output, never tool text, so the signal comes from `testOutcomeFrom`, the same
 * analysis recall scoring uses. The signal is written to its own bounded log and
 * must never touch confidence, validation, or authority.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { apply } from '../src/plugin.mjs'
import { closeAllStores } from '../src/store.mjs'
import { fakeRegistry, roomStore } from './helpers/room.mjs'
import { AUTO_OUTCOME, DELIVERY, readAutoOutcomeSignals, recordGenerationEvidence } from '../src/apply-generation-evidence.mjs'

const PASSING = 'ℹ tests 1113\nℹ pass 1113\nℹ fail 0'
const FAILING = 'ℹ tests 1113\nℹ pass 1111\nℹ fail 2\n✖ failing tests:'

function repoWith(files) {
  const dir = mkdtempSync(join(tmpdir(), 'veyra-outcome-'))
  for (const [rel, text] of Object.entries(files)) {
    const abs = join(dir, rel)
    mkdirSync(dirname(abs), { recursive: true })
    writeFileSync(abs, text)
  }
  return dir
}

function mockCtx(paths) {
  const listeners = {}
  return {
    tools: { register: () => {} },
    commands: { register: () => {} },
    skills: { register: () => {}, registerProvider: () => () => {} },
    systemPrompt: { section: () => {}, context: () => {} },
    workspaceRegistry: fakeRegistry(paths),
    webServer: null,
    on: (event, fn) => {
      listeners[event] = listeners[event] || []
      listeners[event].push(fn)
      return () => {
        listeners[event] = (listeners[event] || []).filter((x) => x !== fn)
      }
    },
    effect: (factory) => factory(),
    _listeners: listeners,
  }
}

const emit = (ctx, event, ...args) => {
  for (const fn of ctx._listeners[event] || []) fn(...args)
}

function toolResult(callId, text) {
  return {
    type: 'tool/result',
    data: {
      message: {
        source: { kind: 'tool', callId },
        content: [{ type: 'tool-result', toolCallId: callId, content: [{ type: 'text', text }] }],
      },
    },
  }
}

const bashCall = (callId, command) => ({
  type: 'tool/call',
  data: { callId, name: 'bash', arguments: JSON.stringify({ command }) },
})

const editCall = (callId, filePath) => ({
  type: 'tool/call',
  data: { callId, name: 'edit', arguments: JSON.stringify({ file_path: filePath }) },
})

async function runTurn(ctx, session, agent, events) {
  for (const ev of events) emit(ctx, 'session/event', session, ev)
  await Promise.resolve()
  emit(ctx, 'agent/turn-stopping', { agent })
  await Promise.resolve()
}

/** A workspace whose room already carries one delivered recall of `recId`. */
function deliveredRoom(t, recId = 'vey_seed') {
  const repo = repoWith({ 'src/lock.mjs': 'export function lockWriter() {}\n' })
  const home = mkdtempSync(join(tmpdir(), 'veyra-outcome-home-'))
  const store = roomStore(home, repo)
  t.after(() => {
    try { store.close() } catch {}
    closeAllStores()
  })
  store.put({
    id: recId,
    title: 'Writer lock ordering inverted',
    body: 'Root cause: the writer lock ordering is inverted.',
    kind: 'memory', authority: 'derived', validation: 'unverified',
    confidence: 'medium', status: 'current', scope: 'project',
    tags: [], relations: [], evidence: [{ path: 'src/lock.mjs' }], source: {},
  })
  recordGenerationEvidence(store, {
    status: 'generated',
    resultCount: 1,
    recordRefs: [recId],
    // `source` is the field checked against DELIVERABLE_SOURCES; delivery.source
    // is only the free-text label stored inside the delivery object.
    source: 'tool',
    delivery: { status: DELIVERY.DELIVERED, source: 'tool-dispatch' },
  })
  return { repo, home, store }
}

test('a delivered record plus passing tests records PLAUSIBLE_CORRELATION', async (t) => {
  const { repo, home, store } = deliveredRoom(t)
  const ctx = mockCtx([repo])
  apply(ctx, { home, observe: true, learn: false })
  const session = { id: 's-pass', header: {} }
  await runTurn(ctx, session, { session, cwd: repo }, [
    { type: 'turn.start', data: { turn: 1 } },
    bashCall('c1', 'node --test test/*.test.mjs'),
    toolResult('c1', PASSING),
  ])

  const signals = readAutoOutcomeSignals(store)
  assert.equal(signals.count, 1)
  assert.equal(signals.entries.at(-1).signal, AUTO_OUTCOME.PLAUSIBLE)
  assert.equal(signals.entries.at(-1).attribution, 'turn_test_evidence')
  assert.equal(signals.entries.at(-1).recordId, 'vey_seed')
  assert.equal(signals.entries.at(-1).kind, 'veyra.apply.auto_outcome')
})

test('auto outcome never changes confidence or validation', async (t) => {
  const { repo, home, store } = deliveredRoom(t, 'vey_stable')
  const before = store.get('vey_stable')
  const ctx = mockCtx([repo])
  apply(ctx, { home, observe: true, learn: false })
  const session = { id: 's-stable', header: {} }
  await runTurn(ctx, session, { session, cwd: repo }, [
    bashCall('c1', 'node --test test/*.test.mjs'),
    toolResult('c1', PASSING),
  ])
  const after = store.get('vey_stable')
  assert.equal(readAutoOutcomeSignals(store).count, 1, 'precondition: a signal was recorded')
  assert.equal(after.confidence, before.confidence)
  assert.equal(after.validation, before.validation)
  assert.equal(after.authority, before.authority)
})

test('failing tests record CONTRADICTED', async (t) => {
  const { repo, home, store } = deliveredRoom(t, 'vey_fail')
  const ctx = mockCtx([repo])
  apply(ctx, { home, observe: true, learn: false })
  const session = { id: 's-fail', header: {} }
  await runTurn(ctx, session, { session, cwd: repo }, [
    bashCall('c1', 'node --test test/*.test.mjs'),
    toolResult('c1', FAILING),
  ])
  const signals = readAutoOutcomeSignals(store)
  assert.equal(signals.count, 1)
  assert.equal(signals.entries.at(-1).signal, AUTO_OUTCOME.CONTRADICTED)
})

test('a turn that only touches test files records no signal', async (t) => {
  const { repo, home, store } = deliveredRoom(t, 'vey_touched')
  const ctx = mockCtx([repo])
  apply(ctx, { home, observe: true, learn: false })
  const session = { id: 's-touched', header: {} }
  await runTurn(ctx, session, { session, cwd: repo }, [
    editCall('c1', 'test/foo.test.mjs'),
    toolResult('c1', 'updated test/foo.test.mjs'),
  ])
  // tests-touched means test files were in play, not that anything passed.
  assert.equal(readAutoOutcomeSignals(store).count, 0)
})

test('no delivered recall means no signal', async (t) => {
  const repo = repoWith({ 'src/lock.mjs': 'export function lockWriter() {}\n' })
  const home = mkdtempSync(join(tmpdir(), 'veyra-outcome-empty-'))
  const store = roomStore(home, repo)
  t.after(() => {
    try { store.close() } catch {}
    closeAllStores()
  })
  const ctx = mockCtx([repo])
  apply(ctx, { home, observe: true, learn: false })
  const session = { id: 's-none', header: {} }
  await runTurn(ctx, session, { session, cwd: repo }, [
    bashCall('c1', 'node --test test/*.test.mjs'),
    toolResult('c1', PASSING),
  ])
  const signals = readAutoOutcomeSignals(store)
  assert.equal(signals.available, false)
  assert.equal(signals.count, 0)
})
