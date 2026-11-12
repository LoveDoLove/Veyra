import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createToolHarness } from '../src/tools.mjs'
import { readExplicitOutcomeLinks } from '../src/apply-generation-evidence.mjs'
import { agentFor, testRuntimeWithStores } from './helpers/room.mjs'

const NOW = new Date().toISOString()

async function makeHarnessWithDeliveredRecall(t) {
  const dir = mkdtempSync(join(tmpdir(), 'veyra-fb-'))
  const cwd = join(dir, 'ws')
  mkdirSync(cwd, { recursive: true })
  const { runtime, store } = testRuntimeWithStores(t, cwd)
  store.put({
    id: 'vey_lock', kind: 'memory', status: 'current', validation: 'verified',
    authority: 'derived', confidence: 'high', scope: 'project',
    title: 'lockWriter serializes writes', body: 'lockWriter guards the writer',
    tags: [], evidence: [], relations: [], source: {},
    createdAt: NOW, updatedAt: NOW, lastRecalledAt: null, forgotten: false,
  })
  const harness = createToolHarness(runtime)
  const exec = { agent: agentFor(cwd) }
  const recallResult = await harness.call('veyra_recall', { query: 'lockWriter' }, exec)
  return {
    call: (name, args) => harness.call(name, args, exec),
    recordId: 'vey_lock',
    recallResult,
    links: () => readExplicitOutcomeLinks(store)?.entries ?? [],
  }
}

test('declared generationEventId reaches the outcome link', async (t) => {
  const h = await makeHarnessWithDeliveredRecall(t)
  const gen = h.recallResult.generationEventId
  assert.ok(gen, 'recall must return a generation event id')
  const res = await h.call('veyra_feedback', { id: h.recordId, outcome: 'success', generationEventId: gen })
  assert.equal(res.attribution, 'explicit_linked')
  assert.equal(h.links().length, 1)
})

test('an unknown generationEventId links nothing but still records feedback', async (t) => {
  const h = await makeHarnessWithDeliveredRecall(t)
  const res = await h.call('veyra_feedback', { id: h.recordId, outcome: 'success', generationEventId: 'vge_p_nope' })
  assert.equal(res.attribution, 'none')
  assert.equal(h.links().length, 0)
  assert.equal(res.feedback.successes >= 1, true)
})
