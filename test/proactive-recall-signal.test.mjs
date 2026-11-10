/**
 * Task 30 — Proactive Recall Effectiveness (automatic `veyra:recall` context).
 *
 * Defect (reproduced): createContextProvider / the automatic proactive recall
 * path performed a recency browse when the turn carried no task-shaped signal
 * (trivial acknowledgement like "ok"/"continue" with no recovered task intent
 * and no repository change signal). Because hybridRetrieve treats an empty
 * query as a browse, recent-but-unrelated project memories were injected into
 * the agent context before the real task was known — unsuitable memories
 * included (Similarity must not become applicability/authority).
 *
 * Fix: the automatic provider fails closed when there is no task-shaped text
 * signal and no change signal, returning '' instead of a recency browse.
 * Recovered substantive task intent (compaction continuity / taskIntentCache)
 * and repository change signals still produce proactive recall. This does not
 * change buildRecallContext/recall contracts; it gates the automatic
 * provider's decision to inject ambient context.
 */

import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { closeAllStores } from '../src/store.mjs'
import { projectIdFor } from '../src/ids.mjs'
import { AUTHORITIES, KINDS, STATUSES, VALIDATIONS } from '../src/types.mjs'
import { createContextProvider, rememberClaimedPrompt, taskIntentCache } from '../src/context.mjs'
import { roomIdFor, roomStore, testHome, testRuntime } from './helpers/room.mjs'

function mk(t) {
  // Memory is addressed by workspace room, so the home and the workspace are
  // both temp dirs and the seed store is the room the runtime will resolve.
  const home = testHome(t, 'veyra-t30-home-')
  const cwd = testHome(t, 'veyra-t30-cwd-')
  const store = roomStore(home, cwd)
  const base = {
    kind: KINDS.MEMORY, status: STATUSES.CURRENT, validation: VALIDATIONS.VERIFIED,
    authority: AUTHORITIES.DERIVED, confidence: 'high', scope: 'project',
    projectId: roomIdFor(cwd), tags: [], evidence: [], relations: [], source: {},
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    lastRecalledAt: null, forgotten: false,
  }
  store.put({ ...base, id: 'unrelated_recipe', title: 'Unrelated cooking recipe notes', body: 'Use salt and pepper in soup.' })
  return { home, cwd, base }
}

function runtime(home, cwd, extra = {}) {
  // A Memory Server is mandatory now: without one the provider fails closed
  // before recall is attempted, which would make the "injects nothing" tests
  // pass for the wrong reason.
  return testRuntime(home, cwd, {
    recallLimit: 5, includeReusable: false,
    recallChars: 6000, changeSignals: new Map(), ensureWatcher() {}, log: { warn() {} },
    codeEngine: null, ...extra,
  })
}

test('Task 30: trivial prompt with no recovered task intent injects no unrelated recency memories', (t) => {
  const { home, cwd } = mk(t)
  t.after(() => { closeAllStores() })
  const provider = createContextProvider(runtime(home, cwd))
  const out = provider({
    agent: {
      session: { header: { cwd }, deriveMessages: () => [{ role: 'user', content: 'ok', source: { kind: 'user' } }] },
      inbox: {},
    },
  })
  assert.equal(out, '', 'automatic proactive recall must fail closed without task-shaped signal')
  assert.equal(out.includes('cooking recipe'), false)
})

test('Task 30: absent user query with no task intent and no change signal injects nothing', (t) => {
  const { home, cwd } = mk(t)
  t.after(() => { closeAllStores() })
  const provider = createContextProvider(runtime(home, cwd))
  const out = provider({
    agent: {
      session: { header: { cwd }, deriveMessages: () => [] },
      inbox: {},
    },
  })
  assert.equal(out, '')
})

test('Task 30: substantive user query still produces proactive recall', (t) => {
  const { home, cwd } = mk(t)
  t.after(() => { closeAllStores() })
  const provider = createContextProvider(runtime(home, cwd))
  const out = provider({
    agent: {
      session: { header: { cwd }, deriveMessages: () => [{ role: 'user', content: 'help with cooking recipe notes', source: { kind: 'user' } }] },
      inbox: {},
    },
  })
  assert.match(out, /Veyra recalled engineering memory/)
  assert.match(out, /cooking recipe/i)
})

test('Task 30: recovered substantive task intent survives a trivial follow-up prompt', (t) => {
  const { home, cwd } = mk(t)
  t.after(() => { closeAllStores() })
  const session = { header: { cwd }, deriveMessages: () => [{ role: 'user', content: 'ok', source: { kind: 'user' } }] }
  const agent = { session, inbox: {} }
  // Simulate compaction continuity intent already cached for this session.
  taskIntentCache.set(session, { intent: 'help with cooking recipe notes', projectId: projectIdFor(cwd), updatedAt: Date.now() })
  rememberClaimedPrompt(agent, { role: 'user', content: 'ok', source: { kind: 'user' } })
  const provider = createContextProvider(runtime(home, cwd))
  const out = provider({ agent })
  assert.match(out, /cooking recipe/i, 'substantive recovered task intent must still drive proactive recall')
})

test('Task 30: repository change signal without text query still reaches automatic recall (Phase 3 preserved)', (t) => {
  const { home, cwd } = mk(t)
  t.after(() => { closeAllStores() })
  const changeSignals = new Map([[cwd, { repoRoot: cwd, changedFiles: ['src/none.js'], timestamp: Date.now() }]])
  const provider = createContextProvider(runtime(home, cwd, { changeSignals }))
  const out = provider({
    agent: {
      session: { header: { cwd }, deriveMessages: () => [{ role: 'user', content: 'continue', source: { kind: 'user' } }] },
      inbox: {},
    },
  })
  assert.match(out, /Repository changes detected|Veyra recalled engineering memory|No known engineering history/)
  assert.match(out, /src\/none\.js/)
})

after(() => { try { closeAllStores() } catch {} })
