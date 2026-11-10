/**
 * P0.1: deterministic regression coverage for the actual plugin
 * `agent/turn-stopping` learning persistence path (src/plugin.mjs).
 *
 * Exercises the real handler wiring through apply() + ctx event emission:
 * session/event observation → buffer → candidateFromBuffer → projectStore.put
 * → maybeLearn / strengthenMemory guarded by provenanceAllowsLearning.
 *
 * The three required branches (src/plugin.mjs turn-stopping handler):
 *   1. written.created        → maybeLearn(...) writes derived learning.
 *   2. written.duplicate
 *      && written.record.authority === DERIVED
 *      && provenanceAllowsLearning(candidate)
 *        → strengthenMemory(...) + projectStore.put(...).
 *   3. same duplicate-derived shape but candidate FAILS provenance validation
 *        → existing derived record is NOT strengthened.
 *
 * No network, model, or eval harness. Test-only; no production changes.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { apply, _resetMaintenanceCounter } from '../src/plugin.mjs'
import { closeAllStores } from '../src/store.mjs'
import { fakeRegistry, roomIdFor, roomStore } from './helpers/room.mjs'
import { AUTHORITIES, CONFIDENCES, KINDS, SCOPES, STATUSES, VALIDATIONS } from '../src/types.mjs'
import { provenanceAllowsLearning } from '../src/learn.mjs'

function prepareWorkspace(dir, paths = ['src/store.mjs']) {
  for (const p of paths) {
    const abs = join(dir, p)
    mkdirSync(dirname(abs), { recursive: true })
    writeFileSync(abs, '// test fixture\nexport function store() {}\n')
  }
}

function mockCtx(paths = []) {
  const listeners = {}
  return {
    tools: { register: () => {} },
    commands: { register: () => {} },
    skills: { register: () => {}, registerProvider: () => () => {} },
    systemPrompt: { section: () => {}, context: () => {} },
    // The plugin builds its Memory Server from ctx, so the registry must be here
    // for the observed session's room to resolve at all.
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

function emit(ctx, event, ...args) {
  for (const fn of ctx._listeners[event] || []) fn(...args)
}

// Event shapes accepted by observeEvent (src/observe.mjs): data.text for
// user/assistant; tool/call + tool/result with callId linkage for tool signal.
function durableFixEvents({
  editPath = 'src/store.mjs',
  bashCmd = 'npm test -- store',
  bashOutput = '1 test passed, 0 failed',
  userText = 'The flaky test in src/store.mjs keeps timing out intermittently during CI runs.',
  assistantText = 'Root cause: sqlite writer race corrupts concurrent writes in src/store.mjs. Fix: serialize DatabaseSync writes through a single connection lock to prevent the race condition.',
} = {}) {
  return [
    { type: 'turn.start', data: { turn: 1 } },
    { type: 'user/message', data: { text: userText } },
    { type: 'assistant/message', data: { text: assistantText } },
    { type: 'tool/call', data: { callId: 'c1', name: 'edit', arguments: JSON.stringify({ file_path: editPath }) } },
    {
      type: 'tool/result',
      data: {
        message: {
          source: { kind: 'tool', callId: 'c1' },
          content: [{ type: 'tool-result', toolCallId: 'c1', content: [{ type: 'text', text: `updated ${editPath}` }] }],
        },
      },
    },
    { type: 'tool/call', data: { callId: 'c2', name: 'bash', arguments: JSON.stringify({ command: bashCmd }) } },
    {
      type: 'tool/result',
      data: {
        message: {
          source: { kind: 'tool', callId: 'c2' },
          content: [{ type: 'tool-result', toolCallId: 'c2', content: [{ type: 'text', text: bashOutput }] }],
        },
      },
    },
  ]
}

// Provenance-invalid candidate shape for the handler's duplicate branch:
// no assistant stream → distill produces origins=['tool'] (no 'assistant'),
// so provenanceAllowsLearning() fails closed. With the same user+tool signal
// as below, distill yields a stable title/body used for duplicate seeding.
function provenanceInvalidDuplicateEvents({
  editPath = 'src/store.mjs',
  userText = 'The flaky test in src/store.mjs keeps timing out intermittently during CI runs.',
} = {}) {
  return [
    { type: 'turn.start', data: { turn: 1 } },
    { type: 'user/message', data: { text: userText } },
    // intentionally no assistant.message
    { type: 'tool/call', data: { callId: 'c1', name: 'edit', arguments: JSON.stringify({ file_path: editPath }) } },
    {
      type: 'tool/result',
      data: {
        message: {
          source: { kind: 'tool', callId: 'c1' },
          content: [{ type: 'tool-result', toolCallId: 'c1', content: [{ type: 'text', text: `updated ${editPath}` }] }],
        },
      },
    },
    { type: 'tool/call', data: { callId: 'c2', name: 'bash', arguments: JSON.stringify({ command: 'npm test -- store' }) } },
    {
      type: 'tool/result',
      data: {
        message: {
          source: { kind: 'tool', callId: 'c2' },
          content: [{ type: 'tool-result', toolCallId: 'c2', content: [{ type: 'text', text: '1 test passed, 0 failed' }] }],
        },
      },
    },
  ]
}

function makeSession(id = 's1') {
  return { id, header: {} }
}
function makeAgent(session, cwd) {
  return { session, cwd, sessionId: session.id }
}

async function runTurn(ctx, session, agent, events) {
  for (const ev of events) emit(ctx, 'session/event', session, ev)
  await Promise.resolve()
  emit(ctx, 'agent/turn-stopping', { agent })
  await Promise.resolve()
}

test('P0.1 turn-stopping wiring: new candidate -> automatic derived learning', async (t) => {
  _resetMaintenanceCounter()
  const dir = mkdtempSync(join(tmpdir(), 'veyra-p01-new-'))
  // The handler runs markStale() after learning with workspace=agent.cwd.
  // Create the referenced file so evidence remains valid and the test proves
  // the created→maybeLearn branch result, not post-learning path invalidation.
  prepareWorkspace(dir, ['src/store.mjs'])
  const ctx = mockCtx([dir])
  apply(ctx, { home: dir, observe: true, learn: true })

  const session = makeSession('s-new')
  const agent = makeAgent(session, dir)
  await runTurn(ctx, session, agent, durableFixEvents())

  const store = roomStore(dir, dir)
  t.after(() => { try { store.close() } catch {} closeAllStores() })
  const all = store.list({ includeForgotten: true, limit: 50 })
  const derived = all.filter((r) => r.authority === AUTHORITIES.DERIVED)
  assert.ok(derived.length >= 1,
    `expected >=1 derived record via actual handler (created→maybeLearn); got authorities=[${all.map((r) => r.authority).join(',')}]`)
  assert.ok(all.every((r) => r.authority !== AUTHORITIES.CANONICAL), 'turn-stopping must never auto-create canonical')
  const learned = derived[0]
  assert.equal(learned.authority, AUTHORITIES.DERIVED)
  assert.equal(learned.kind, KINDS.MEMORY)
  assert.ok(learned.source?.writeGate?.decision === 'ACCEPT' || learned.source?.writeGate?.decision === 'MERGE',
    `expected write-gate acceptance/merge on learned record; got ${JSON.stringify(learned.source?.writeGate)}`)
})

test('P0.1 turn-stopping wiring: eligible duplicate strengthens existing derived', async (t) => {
  _resetMaintenanceCounter()
  const dir = mkdtempSync(join(tmpdir(), 'veyra-p01-dupok-'))
  prepareWorkspace(dir, ['src/store.mjs'])
  const ctx = mockCtx([dir])
  apply(ctx, { home: dir, observe: true, learn: true })

  const events = durableFixEvents()
  // Turn 1: actual handler creates candidate and learns derived knowledge.
  const s1 = makeSession('s-dupok-1')
  await runTurn(ctx, s1, makeAgent(s1, dir), events)

  const store = roomStore(dir, dir)
  t.after(() => { try { store.close() } catch {} closeAllStores() })
  const afterFirst = store.list({ includeForgotten: true, limit: 50 })
  const derivedBefore = afterFirst.find((r) => r.authority === AUTHORITIES.DERIVED)
  assert.ok(derivedBefore, `precondition: turn 1 must create derived record; got [${afterFirst.map((r) => r.authority).join(',')}]`)
  const obsBefore = Number(derivedBefore.source?.observations) || 1

  // Turn 2: same content/session-distilled shape → duplicate put. Handler must
  // take the branch: duplicate && existing derived && provenanceAllowsLearning(candidate)
  // → strengthenMemory(...) + projectStore.put(strengthened).
  const s2 = makeSession('s-dupok-2')
  await runTurn(ctx, s2, makeAgent(s2, dir), events)

  const afterSecond = store.list({ includeForgotten: true, limit: 50 })
  const derivedAfter = afterSecond.filter((r) => r.authority === AUTHORITIES.DERIVED)
  // Strengthening updates the existing derived record in place (same content hash/id path),
  // so count should not grow as an extra canonical/duplicate authority; observations grow.
  const strengthened = derivedAfter.find((r) => r.id === derivedBefore.id) || derivedAfter[0]
  assert.ok(strengthened, 'derived record must still exist after duplicate turn')
  const obsAfter = Number(strengthened.source?.observations) || 1
  assert.ok(obsAfter > obsBefore,
    `eligible duplicate via actual handler must strengthen observations (${obsBefore} -> ${obsAfter}); records=${JSON.stringify(afterSecond.map((r) => ({ id: r.id, a: r.authority, obs: r.source?.observations })))}`)
  assert.equal(strengthened.authority, AUTHORITIES.DERIVED)
})

test('P0.1 turn-stopping wiring: ineligible duplicate does not strengthen derived', async (t) => {
  _resetMaintenanceCounter()
  const dir = mkdtempSync(join(tmpdir(), 'veyra-p01-dupno-'))
  // Keep file present so post-handler markStale does not mutate the seeded
  // record in unrelated ways; the assertion targets strengthen behavior.
  prepareWorkspace(dir, ['src/store.mjs'])
  const ctx = mockCtx([dir])
  apply(ctx, { home: dir, observe: true, learn: true })

  const invalidEvents = provenanceInvalidDuplicateEvents()
  // The incoming candidate produced by the handler for invalidEvents must fail
  // provenance validation (origins include no 'assistant' → fail closed).
  // We assert that contract using the same pure predicate the handler uses.
  const badCandidateProbe = {
    source: { automatic: true, provenance: { origins: ['tool'] } },
  }
  assert.equal(provenanceAllowsLearning(badCandidateProbe), false, 'probe: tool-only automatic provenance must fail')

  // Seed an existing DERIVED record whose content hash matches the candidate
  // the handler will distill from invalidEvents. This makes projectStore.put()
  // return duplicate+existing derived, so the handler reaches the provenance
  // branch guard: provenanceAllowsLearning(candidate) is false => no strengthen.
  // The seed store MUST be the same workspace room the plugin resolves, and the
  // record's projectId is that room's id (never a path-derived legacy id).
  const projectId = roomIdFor(dir)
  const store = roomStore(dir, dir)
  t.after(() => { try { store.close() } catch {} closeAllStores() })
  // Title/body match the stable distill output for this tool-only event shape.
  const seeded = store.put({
    title: 'Engineering observation',
    body: 'Files touched: src/store.mjs\n\nTools: edit, edit:result, bash, bash:result',
    kind: KINDS.OBSERVATION,
    status: STATUSES.CURRENT,
    validation: VALIDATIONS.REVIEWED,
    authority: AUTHORITIES.DERIVED,
    confidence: CONFIDENCES.MEDIUM,
    scope: SCOPES.PROJECT,
    projectId,
    evidence: [{ path: 'src/store.mjs' }, { note: 'test-passed' }],
    source: { automatic: false, observations: 1 },
  })
  assert.equal(seeded.created, true)
  assert.equal(seeded.record.authority, AUTHORITIES.DERIVED)
  const obsBefore = Number(seeded.record.source?.observations) || 1

  // Run the actual handler. It distills a provenance-invalid duplicate
  // candidate; put() finds the seeded derived duplicate; the handler must NOT
  // strengthen because provenanceAllowsLearning(candidate) is false.
  const session = makeSession('s-dupno')
  await runTurn(ctx, session, makeAgent(session, dir), invalidEvents)

  const after = store.list({ includeForgotten: true, limit: 50 })
  const derived = after.filter((r) => r.authority === AUTHORITIES.DERIVED)
  assert.equal(derived.length, 1, `ineligible duplicate must not create extra records; got ${JSON.stringify(after.map((r) => ({ a: r.authority, v: r.validation })))}`)
  const obsAfter = Number(derived[0].source?.observations) || 1
  assert.equal(obsAfter, obsBefore,
    `ineligible duplicate (provenance validation fails) must not strengthen; observations ${obsBefore} -> ${obsAfter}`)
  assert.equal(derived[0].id, seeded.record.id)
})
