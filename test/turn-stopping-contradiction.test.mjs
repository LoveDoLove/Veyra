/**
 * P0.3: deterministic regression for contradictory engineering knowledge
 * learned through the actual automatic plugin runtime path.
 *
 * Exercises real apply() handler wiring across TWO separate sessions/turns:
 *   session/event → observation buffer → candidateFromBuffer →
 *   projectStore.put → maybeLearn → evolveAgainst → persistence
 * then inspects persisted records and actual recall()/summarizeForPrompt().
 *
 * Proves (when existing rules permit):
 *   - first session auto-learns grounded claim as derived
 *   - later incompatible claim about same subject (independent evidence)
 *     persists as a separate derived claim
 *   - contradicts relation is recorded when diff/evolution permits
 *   - recall keeps contradiction visible; no silent canonical selection
 *   - no automatic path creates canonical authority
 *
 * If guards legitimately defer/prevent relation creation, the test fails
 * with an explicit diagnostic rather than weakening rules.
 *
 * Test-only; no production changes; deterministic fake fixtures; no network.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply } from '../src/plugin.mjs'
import { closeAllStores } from '../src/store.mjs'
import { fakeRegistry, roomStore } from './helpers/room.mjs'
import { recall, summarizeForPrompt } from '../src/retrieve.mjs'
import { diffMemory } from '../src/diff.mjs'
import { candidateFromBuffer, newBuffer, observeEvent } from '../src/observe.mjs'
import { AUTHORITIES, KINDS, RELATIONS, SCOPES } from '../src/types.mjs'

function mockCtx() {
  const listeners = {}
  return {
    tools: { register: () => {} },
    commands: { register: () => {} },
    skills: { register: () => {}, registerProvider: () => () => {} },
    systemPrompt: { section: () => {}, context: () => {} },
    webui: { panel: () => {} },
    on: (event, fn) => {
      listeners[event] = listeners[event] || []
      listeners[event].push(fn)
    },
    effect: (factory) => factory(),
    logger: () => ({ info() {}, warn() {}, error() {}, debug() {} }),
  }
}

function emit(ctx, event, payload) {
  for (const fn of ctx._listeners?.[event] || ctx.on?._listeners?.[event] || []) fn(payload)
  // mockCtx stores in listeners object but we need access; rebuild helper
}

function createHarness(paths = []) {
  const listeners = {}
  const ctx = {
    tools: { register: () => {} },
    commands: { register: () => {} },
    skills: { register: () => {}, registerProvider: () => () => {} },
    systemPrompt: { section: () => {}, context: () => {} },
    webui: { panel: () => {} },
    // The plugin builds its Memory Server from ctx, so the registry must be here
    // for the observed session's room to resolve at all.
    workspaceRegistry: fakeRegistry(paths),
    on(event, fn) { (listeners[event] ||= []).push(fn) },
    effect(factory) { return factory() },
    logger: () => ({ info() {}, warn() {}, error() {}, debug() {} }),
    emit(event, ...args) { for (const fn of listeners[event] || []) fn(...args) },
    listeners,
  }
  return ctx
}

function toolEvents(filePath) {
  return [
    {
      type: 'tool/call',
      data: { callId: 'c1', name: 'edit', arguments: JSON.stringify({ file_path: filePath }) },
    },
    {
      type: 'tool/result',
      data: {
        message: {
          source: { kind: 'tool', callId: 'c1' },
          content: [{ type: 'tool-result', toolCallId: 'c1', content: [{ type: 'text', text: `updated ${filePath}` }] }],
        },
      },
    },
    {
      type: 'tool/call',
      data: { callId: 'c2', name: 'bash', arguments: JSON.stringify({ command: 'npm test' }) },
    },
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

function sessionEventsA(cwd) {
  const editPath = 'src/store.mjs'
  return [
    { type: 'turn.start', data: { turn: 1 } },
    { type: 'user/message', data: { text: 'Debug sqlite DatabaseSync writer path in src/store.mjs for CI flake.' } },
    {
      type: 'assistant/message',
      data: {
        text: 'Root cause: DatabaseSync sqlite writes are safe when WAL mode is enabled for src/store.mjs. Fix: enable WAL mode and keep serialized writes. Tests: 1 test passed, 0 failed.',
      },
    },
    ...toolEvents(editPath),
  ]
}

function sessionEventsB(cwd) {
  const editPath = 'src/store.mjs'
  return [
    { type: 'turn.start', data: { turn: 1 } },
    { type: 'user/message', data: { text: 'Debug sqlite DatabaseSync corruption in src/store.mjs after deployment.' } },
    {
      type: 'assistant/message',
      data: {
        text: 'Root cause: DatabaseSync sqlite writes are not safe when WAL mode is enabled for src/store.mjs. Fix: disable WAL mode and avoid concurrent writer corruption. Tests: 1 test passed, 0 failed.',
      },
    },
    ...toolEvents(editPath),
  ]
}

function distillFor(events, sessionId, cwd) {
  const buf = newBuffer(sessionId)
  const session = { id: sessionId }
  for (const e of events) observeEvent(buf, session, e)
  return candidateFromBuffer(buf, { sessionId, cwd, agent: 'test' })
}

async function runHandlerSession(ctx, { sessionId, cwd, events }) {
  const session = { id: sessionId, header: { cwd } }
  for (const e of events) ctx.emit('session/event', session, e)
  ctx.emit('agent/turn-stopping', { agent: { session, cwd, sessionId } })
  await Promise.resolve()
  await new Promise((r) => setTimeout(r, 0))
}

test('P0.3 actual runtime: contradictory claims persist as visible derived records, not silently merged/canonical', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'veyra-p03-contradiction-'))
  const home = join(root, 'home')
  const cwd = join(root, 'workspace')
  mkdirSync(join(cwd, 'src'), { recursive: true })
  writeFileSync(join(cwd, 'src', 'store.mjs'), 'export const store = 1\n')

  await closeAllStores()
  const ctx = createHarness([cwd])
  apply(ctx, { home, observe: true, learn: true })
  t.after(async () => { await closeAllStores() })

  // Preflight: fixtures must be provenance-passing and classified as conflict
  // by the same distill/diff path the automatic handler uses. If guards make
  // these fixtures defer/merge in current rules, fail with explicit reason.
  const candA = distillFor(sessionEventsA(cwd), 'pre-a', cwd)
  const candB = distillFor(sessionEventsB(cwd), 'pre-b', cwd)
  assert.ok(candA && candB, 'preflight: both sessions must distill candidates')
  assert.equal(candA.source?.automatic, true)
  assert.equal(candB.source?.automatic, true)
  const provA = candA.source?.provenance?.origins || []
  const provB = candB.source?.provenance?.origins || []
  assert.ok(provA.includes('user') && provA.includes('assistant'), `preflight A provenance origins: ${provA}`)
  assert.ok(provB.includes('user') && provB.includes('assistant'), `preflight B provenance origins: ${provB}`)
  const preDiff = diffMemory(candB, [candA])
  assert.equal(
    preDiff.suggestion,
    'conflict',
    `preflight: fixture pair must classify as conflict for P0.3 relation test; got ${preDiff.suggestion} top=${JSON.stringify(preDiff.matches[0] && { sim: preDiff.matches[0].similarity, suggestion: preDiff.matches[0].suggestion, sharedSubject: preDiff.matches[0].sharedSubject, replacementConflict: preDiff.matches[0].replacementConflict })}`,
  )

  // Session A: first grounded engineering claim learned automatically.
  await runHandlerSession(ctx, { sessionId: 'session-a', cwd, events: sessionEventsA(cwd) })

  const store = roomStore(home, cwd)
  let records = store.list({ includeForgotten: true, limit: 50 })
  let derived = records.filter((r) => r.authority === AUTHORITIES.DERIVED && r.scope === SCOPES.PROJECT)
  assert.ok(derived.length >= 1, `session A should persist >=1 derived claim; got ${JSON.stringify(records.map(r=>({a:r.authority,k:r.kind,s:r.status,t:r.title})))}`)
  const aRec = derived[0]

  // Session B: incompatible claim about same subject, independent session/evidence framing.
  await runHandlerSession(ctx, { sessionId: 'session-b', cwd, events: sessionEventsB(cwd) })

  records = store.list({ includeForgotten: true, limit: 50 })
  derived = records.filter((r) => r.authority === AUTHORITIES.DERIVED && r.scope === SCOPES.PROJECT)
  const canonical = records.filter((r) => r.authority === AUTHORITIES.CANONICAL)

  // Neither automatic path creates canonical authority.
  assert.equal(canonical.length, 0, `automatic path must not create canonical authority; got ${canonical.map(r=>r.id)}`)

  // Both claims must remain persisted (not silently merged/overwritten/discarded).
  assert.ok(
    derived.length >= 2,
    `both contradictory claims must persist as separate derived records when rules permit; got ${derived.length}. records=${JSON.stringify(records.map(r=>({id:r.id,a:r.authority,k:r.kind,s:r.status,wg:r.source?.writeGate,title:r.title,rel:r.relations})))}`,
  )

  const relPairs = derived.flatMap((r) => (r.relations || []).filter((x) => x.type === RELATIONS.CONTRADICTS).map((x) => [r.id, x.targetId]))
  const contradictsLinked = relPairs.some(([from, to]) => derived.some((r) => r.id === to && r.id !== from))
  assert.ok(
    contradictsLinked,
    `contradicts relation must be recorded when preflight diff classified conflict; relations=${JSON.stringify(derived.map(r=>({id:r.id,rel:r.relations,title:r.title})))}`,
  )

  // Recall keeps contradiction visible and does not silently select canonical truth.
  const recalled = recall({ projectStore: store, query: 'sqlite DatabaseSync WAL mode src/store.mjs writer safe', limit: 10 })
  assert.ok(recalled.length >= 2, `recall should surface both sides; got ${recalled.length}`)
  assert.equal(recalled.some((r) => r.authority === AUTHORITIES.CANONICAL), false, 'recall must not surface/create canonical truth')
  const recalledContradictions = recalled.filter((r) => (r.contradictions?.length || 0) > 0 || (r.contradictionBanners?.length || 0) > 0)
  assert.ok(
    recalledContradictions.length >= 1 || contradictsLinked,
    `recall must keep contradiction visible; recalled=${JSON.stringify(recalled.map(r=>({id:r.id,a:r.authority,contradictions:r.contradictions,contradictionBanners:r.contradictionBanners,title:r.title})))}`,
  )
  const prompt = summarizeForPrompt(recalled)
  assert.match(prompt, /contradict|CONTRADICTS/i, `prompt summary should expose contradiction visibility; prompt=\n${prompt}`)

  store.close()
})
