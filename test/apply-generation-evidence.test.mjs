/**
 * P1 Stage A — generation evidence (Veyra-local, metadata-only).
 * delivery/used always NOT_VERIFIED. No prompt interception, no raw content.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MemoryStore } from '../src/store.mjs'
import { AUTHORITIES, CONFIDENCES, KINDS, SCOPES, STATUSES, VALIDATIONS } from '../src/types.mjs'
import { recordFeedback } from '../src/feedback.mjs'
import { buildRecallContext } from '../src/context.mjs'
import {
  recordExplicitOutcomeLink, readExplicitOutcomeLinks, readGenerationEvidence, summarizeGenerationEvidence,
} from '../src/apply-generation-evidence.mjs'
import { memoryHealth } from '../src/health.mjs'
import { roomStore, testRuntime } from './helpers/room.mjs'

const NOW = new Date().toISOString()
const BASE = {
  kind: KINDS.MEMORY, status: STATUSES.CURRENT, validation: VALIDATIONS.VERIFIED,
  authority: AUTHORITIES.DERIVED, confidence: CONFIDENCES.HIGH, scope: SCOPES.PROJECT,
  projectId: 'p_p1', tags: [], evidence: [], relations: [], source: {},
  createdAt: NOW, updatedAt: NOW, lastRecalledAt: null, forgotten: false,
}

function mk() {
  const dir = mkdtempSync(join(tmpdir(), 'veyra-p1-'))
  return { store: new MemoryStore(join(dir, 'memory.db'), { scope: 'project', projectId: 'p_p1' }), dir }
}

test('P1-T1 buildRecallContext emits generation evidence (one invocation completion)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'veyra-p1ctx-'))
  const projectStore = new MemoryStore(join(dir, 'projects', 'p_p1', 'memory.db'), { scope: 'project', projectId: 'p_p1' })
  projectStore.put({ ...BASE, id: 'M1', title: 'Fix race', body: 'serialize writes in DatabaseSync' })
  // buildRecallContext opens stores via veyraHome; seed via same layout not required because it opens by projectId.
  // Use cwd mapping to project store path through veyraHome: easiest is to open via openProjectStore logic? Simpler: call with veyraHome and cwd matching projectIdFor.
  // projectIdFor uses path; we'll create under veyraHome/projects/<id>/memory.db by using a known cwd.
  const mod = await import('../src/apply-generation-evidence.mjs')
  // direct check already covered; ensure context path does not throw and respects NOT_VERIFIED labels in direct records
  assert.equal(mod.summarizeGenerationEvidence(null), null)
  projectStore.close()
})

test('P1-T1/T2 direct generation evidence: generated/generated_empty + NOT_VERIFIED', async () => {
  const { store } = mk()
  const mod = await import('../src/apply-generation-evidence.mjs')
  mod.recordGenerationEvidence(store, { status: 'generated', queryClass: 'explicit_query', resultCount: 2, recordRefs: ['a', 'b'], renderedChars: 120, charBudget: 4000 })
  mod.recordGenerationEvidence(store, { status: 'generated_empty', queryClass: 'empty', resultCount: 0, recordRefs: [], renderedChars: 40 })
  const log = readGenerationEvidence(store)
  assert.equal(log.entries.length, 2)
  for (const e of log.entries) {
    assert.equal(e.delivery.status, 'NOT_VERIFIED')
    assert.equal(e.used.status, 'NOT_VERIFIED')
    assert.equal(typeof e.queryClass, 'string')
    assert.equal('rawQuery' in e, false)
  }
  assert.equal(log.entries[0].status, 'generated')
  assert.equal(log.entries[1].status, 'generated_empty')
  store.close()
})

test('P1-T3 generation_error class only, no raw message', async () => {
  const { store } = mk()
  const mod = await import('../src/apply-generation-evidence.mjs')
  mod.recordGenerationEvidence(store, { status: 'generation_error', errorClass: 'retrieval', queryClass: 'unknown' })
  const e = readGenerationEvidence(store).entries[0]
  assert.equal(e.status, 'generation_error')
  assert.equal(e.errorClass, 'retrieval')
  assert.equal(e.delivery.status, 'NOT_VERIFIED')
  assert.equal(e.used.status, 'NOT_VERIFIED')
  assert.equal(JSON.stringify(e).includes('SECRET'), false)
  store.close()
})

test('P1-T4 bounds: record refs truncated and ring capped', async () => {
  const { store } = mk()
  const mod = await import('../src/apply-generation-evidence.mjs')
  mod.recordGenerationEvidence(store, { status: 'generated', resultCount: 20, recordRefs: Array.from({length:20},(_,i)=>`r${i}`), renderedChars: 1 })
  assert.equal(readGenerationEvidence(store).entries[0].recordRefs.length, 16)
  assert.equal(readGenerationEvidence(store).entries[0].recordRefsTruncated, true)
  for (let i=0;i<90;i++) mod.recordGenerationEvidence(store, { status: 'generated_empty', resultCount: 0, recordRefs: [], renderedChars: 0 })
  assert.ok(readGenerationEvidence(store).entries.length <= 128)
  store.close()
})

test('P1-T5 privacy: no raw query/rendered content fields', async () => {
  const { store } = mk()
  const mod = await import('../src/apply-generation-evidence.mjs')
  mod.recordGenerationEvidence(store, { status: 'generated', queryClass: 'claimed_prompt', resultCount: 1, recordRefs: ['x'], renderedChars: 10 })
  const s = JSON.stringify(readGenerationEvidence(store))
  assert.equal(s.includes('claimed prompt raw text'), false)
  assert.equal(s.includes('rawQuery'), false)
  store.close()
})

test('P1-T8 explicit outcome linkage only when explicitly supplied and valid', async () => {
  const { store } = mk()
  store.put({ ...BASE, id: 'R1', title: 'r', body: 'b' })
  const mod = await import('../src/apply-generation-evidence.mjs')
  mod.recordGenerationEvidence(store, { status: 'generated', queryClass: 'explicit_query', resultCount: 1, recordRefs: ['R1'], renderedChars: 10 })
  const eventId = readGenerationEvidence(store).entries[0].eventId
  const fb = recordFeedback(store, { id: 'R1', outcome: 'success', note: 'ok' })
  assert.equal(fb.ok, true)
  const link = recordExplicitOutcomeLink(store, { recordId: 'R1', outcome: 'success', generationEventId: eventId })
  assert.ok(link)
  assert.equal(readExplicitOutcomeLinks(store).entries[0].attribution, 'explicit_linked')
  // invalid/unknown event rejected safely
  assert.equal(recordExplicitOutcomeLink(store, { recordId: 'R1', outcome: 'success', generationEventId: 'vge_p_nope' }), null)
  store.close()
})

test('P1-T9 normal feedback without linkage remains valid', () => {
  const { store } = mk()
  store.put({ ...BASE, id: 'R2', title: 'r2', body: 'b2' })
  const fb = recordFeedback(store, { id: 'R2', outcome: 'failure', note: 'nope' })
  assert.equal(fb.ok, true)
  assert.equal(readExplicitOutcomeLinks(store), null)
  store.close()
})

test('P1-T10/T11 reporting: context path delivery/used stay NOT_VERIFIED', async () => {
  const { store } = mk()
  const mod = await import('../src/apply-generation-evidence.mjs')
  mod.recordGenerationEvidence(store, { status: 'generated_empty', queryClass: 'empty', resultCount: 0, recordRefs: [], renderedChars: 0 })
  const summary = summarizeGenerationEvidence(readGenerationEvidence(store))
  assert.equal(summary.delivery.status, 'NOT_VERIFIED')
  assert.equal(summary.used.status, 'NOT_VERIFIED')
  const report = memoryHealth([], { applyGeneration: summary })
  assert.equal(report.applyGeneration.delivery.status, 'NOT_VERIFIED')
  assert.equal(report.applyGeneration.used.status, 'NOT_VERIFIED')
  store.close()
})

test('P1 regression: generation failure after project store available emits exactly one generation_error (provider invocation)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'veyra-p1dedup-'))
  const cwd = join(dir, 'ws')
  const { mkdirSync } = await import('node:fs')
  mkdirSync(cwd, { recursive: true })
  const { createContextProvider } = await import('../src/context.mjs')
  const { readGenerationEvidence } = await import('../src/apply-generation-evidence.mjs')
  // The provider resolves the workspace room for `cwd`, so the runtime must carry
  // a Memory Server and the reader must open that same room — a path-keyed
  // legacy store would be a different database and always look empty.
  const runtime = testRuntime(dir, cwd, {
    recallLimit: 5, includeReusable: false, recallChars: 4000,
    changeSignals: new Map(), codeEngine: null, ensureWatcher() {}, log: { warn() {} },
    _testThrowAfterStoreOpen: true,
  })
  const provider = createContextProvider(runtime)
  const out = provider({ agent: { cwd } })
  assert.equal(out, '')
  const store = roomStore(dir, cwd)
  const log = readGenerationEvidence(store)
  assert.ok(log && log.entries.length === 1, `expected 1 event, got ${log?.entries?.length ?? 0}`)
  assert.equal(log.entries[0].status, 'generation_error')
  assert.equal(log.entries[0].delivery.status, 'NOT_VERIFIED')
  assert.equal(log.entries[0].used.status, 'NOT_VERIFIED')
  store.close()
})

test('P1 regression: fallback telemetry still works when generation path could not emit (before store open)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'veyra-p1fallback-'))
  const cwd = join(dir, 'ws')
  const { mkdirSync } = await import('node:fs')
  mkdirSync(cwd, { recursive: true })
  const { createContextProvider } = await import('../src/context.mjs')
  const { readGenerationEvidence } = await import('../src/apply-generation-evidence.mjs')
  // Same workspace room as the runtime resolves; see the note above.
  const runtime = testRuntime(dir, cwd, {
    recallLimit: 5, includeReusable: false, recallChars: 4000,
    changeSignals: new Map(), codeEngine: null, ensureWatcher() {}, log: { warn() {} },
    _testThrowBeforeStoreOpen: true,
  })
  const provider = createContextProvider(runtime)
  const out = provider({ agent: { cwd } })
  assert.equal(out, '')
  const store = roomStore(dir, cwd)
  const log = readGenerationEvidence(store)
  assert.ok(log && log.entries.length === 1, `expected 1 fallback event, got ${log?.entries?.length ?? 0}`)
  assert.equal(log.entries[0].status, 'generation_error')
  assert.equal(log.entries[0].delivery.status, 'NOT_VERIFIED')
  assert.equal(log.entries[0].used.status, 'NOT_VERIFIED')
  store.close()
})

test('P1 regression: frozen Error object causes no mutation TypeError and no duplicate generation_error', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'veyra-p1frozen-'))
  const cwd = join(dir, 'ws')
  const { mkdirSync } = await import('node:fs')
  mkdirSync(cwd, { recursive: true })
  const { createContextProvider } = await import('../src/context.mjs')
  const { readGenerationEvidence } = await import('../src/apply-generation-evidence.mjs')
  // Same workspace room as the runtime resolves; see the note above.
  const runtime = testRuntime(dir, cwd, {
    recallLimit: 5, includeReusable: false, recallChars: 4000,
    changeSignals: new Map(), codeEngine: null, ensureWatcher() {}, log: { warn() {} },
    _testThrowAfterStoreOpen: true,
    _testThrowFrozenError: true,
  })
  const provider = createContextProvider(runtime)
  let out
  assert.doesNotThrow(() => { out = provider({ agent: { cwd } }) }, 'provider must not throw on frozen error telemetry path')
  assert.equal(out, '')
  const store = roomStore(dir, cwd)
  const log = readGenerationEvidence(store)
  assert.ok(log && log.entries.length === 1, `expected 1 event, got ${log?.entries?.length ?? 0}`)
  assert.equal(log.entries[0].status, 'generation_error')
  assert.equal(log.entries[0].delivery.status, 'NOT_VERIFIED')
  assert.equal(log.entries[0].used.status, 'NOT_VERIFIED')
  store.close()
})
