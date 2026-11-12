import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { recordGenerationEvidence, readGenerationEvidence, summarizeGenerationEvidence, DELIVERY } from '../src/apply-generation-evidence.mjs'
import { createToolHarness } from '../src/tools.mjs'
import { agentFor, roomStore, testHome, testRuntimeWithStores } from './helpers/room.mjs'

const NOW = new Date().toISOString()
const RECORD = {
  id: 'vey_x', kind: 'memory', status: 'current', validation: 'verified',
  authority: 'derived', confidence: 'high', scope: 'project',
  title: 't', body: 'b', tags: [], evidence: [], relations: [], source: {},
  createdAt: NOW, updatedAt: NOW, lastRecalledAt: null, forgotten: false,
}

test('a tool dispatch records DELIVERED with tool provenance', async (t) => {
  const home = testHome(t)
  const store = roomStore(home, '/repo/a')
  store.put({ ...RECORD })
  recordGenerationEvidence(store, {
    status: 'generated', source: 'tool', queryClass: 'explicit_query',
    resultCount: 1, recordRefs: ['vey_x'], renderedChars: 120,
    delivery: { status: DELIVERY.DELIVERED, source: 'tool-dispatch' },
  })
  const entry = readGenerationEvidence(store).entries.at(-1)
  assert.equal(entry.delivery.status, 'DELIVERED')
  assert.equal(entry.used.status, 'NOT_VERIFIED')
})

test('the default stays NOT_VERIFIED', async (t) => {
  const home = testHome(t)
  const store = roomStore(home, '/repo/b')
  recordGenerationEvidence(store, { status: 'generated', queryClass: 'change_signal' })
  assert.equal(readGenerationEvidence(store).entries.at(-1).delivery.status, 'NOT_VERIFIED')
})

test('veyra_recall returns the event id and records DELIVERED', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'veyra-delivery-'))
  const cwd = join(dir, 'ws')
  mkdirSync(cwd, { recursive: true })
  const { runtime, store } = testRuntimeWithStores(t, cwd)
  store.put({ ...RECORD, id: 'vey_lock', title: 'lockWriter serializes writes', body: 'lockWriter guards the writer' })
  const harness = createToolHarness(runtime)
  const res = await harness.call('veyra_recall', { query: 'lockWriter' }, { agent: agentFor(cwd) })
  assert.equal(res.count, 1)
  assert.match(res.generationEventId, /^vge_/)
  const entry = readGenerationEvidence(store).entries.at(-1)
  assert.equal(entry.eventId, res.generationEventId)
  assert.equal(entry.delivery.status, DELIVERY.DELIVERED)
  assert.equal(entry.delivery.source, 'tool-dispatch')
  assert.equal(entry.source, 'tool')
  assert.equal(entry.used.status, 'NOT_VERIFIED')
  const summary = summarizeGenerationEvidence(readGenerationEvidence(store))
  assert.equal(summary.delivery.status, DELIVERY.DELIVERED, 'the reporting surface must not keep saying NOT_VERIFIED')
  assert.equal(summary.delivery.count, 1)
})
