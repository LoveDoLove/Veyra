import { test } from 'node:test'
import assert from 'node:assert/strict'
import { AUTHORITIES, CONFIDENCES, KINDS, RELATIONS, STATUSES, VALIDATIONS } from '../src/types.mjs'
import { openEphemeralStore } from '../src/store.mjs'
import { newBuffer, observeEvent } from '../src/observe.mjs'
import { distillBuffer, extractCausalFacets } from '../src/understand.mjs'
import { INTENTS, detectIntent } from '../src/intent.mjs'
import { maybeLearn, promote, remember, strengthenMemory } from '../src/learn.mjs'
import { recall, summarizeForPrompt } from '../src/retrieve.mjs'
import { annotateContradictions, evolveAgainst } from '../src/evolve.mjs'

// ============================================================================
// Positive Causal Extraction Tests
// ============================================================================

test('extractCausalFacets extracts complete symptom → rootCause → remedy → verifiedOutcome', () => {
  const user = 'The issue is flaky tests crashing with SQLITE_BUSY. The root cause is concurrent DatabaseSync calls corrupting FTS triggers. The fix is to serialize writes using a mutex.'
  const tools = [
    { name: 'edit', arguments: { file_path: 'src/store.mjs' } },
    { name: 'bash:result', preview: '✔ 58 tests passed (110ms)\n[exit code: 0]' },
  ]
  const facets = extractCausalFacets({ user, tools, files: ['src/store.mjs'] })
  assert.ok(facets)
  assert.equal(facets.symptom, 'flaky tests crashing with SQLITE_BUSY')
  assert.equal(facets.rootCause, 'concurrent DatabaseSync calls corrupting FTS triggers')
  assert.equal(facets.remedy, 'serialize writes using a mutex')
  assert.equal(facets.verifiedOutcome, 'test-passed')
})

test('extractCausalFacets handles partial causal records (symptom + rootCause without remedy)', () => {
  const user = 'Investigating test failure: flaky test flaking on database lock. The root cause is missing PRAGMA busy_timeout on open.'
  const facets = extractCausalFacets({ user, tools: [], files: ['src/store.mjs'] })
  assert.ok(facets)
  assert.equal(facets.symptom, 'flaky test flaking on database lock')
  assert.equal(facets.rootCause, 'missing PRAGMA busy_timeout on open')
  assert.equal(facets.remedy, null)
  assert.equal(facets.verifiedOutcome, null)
})

test('extractCausalFacets handles partial causal records (remedy + verifiedOutcome without explicit rootCause)', () => {
  const user = 'The fix is to serialize DatabaseSync calls with a promise queue.'
  const tools = [
    { name: 'edit', arguments: { file_path: 'src/store.mjs' } },
    { name: 'bash:result', preview: '✔ all 12 tests pass\n[exit code: 0]' },
  ]
  const facets = extractCausalFacets({ user, tools, files: ['src/store.mjs'] })
  assert.ok(facets)
  assert.equal(facets.rootCause, null)
  assert.equal(facets.remedy, 'serialize DatabaseSync calls with a promise queue')
  assert.equal(facets.verifiedOutcome, 'test-passed')
})

test('distillBuffer formats causal facets in body, tags, and source provenance', () => {
  const buffer = newBuffer()
  observeEvent(buffer, {}, { type: 'turn/start', data: { turn: 1 } })
  observeEvent(buffer, {}, {
    type: 'user/message',
    data: { content: [{ type: 'text', text: 'The bug is sqlite writer race. The root cause is concurrent DatabaseSync writes. The fix is to wrap writes in a mutex.' }] },
  })
  observeEvent(buffer, {}, {
    type: 'tool/call',
    data: { callId: 'c1', name: 'bash', arguments: JSON.stringify({ command: 'npm test' }) },
  })
  observeEvent(buffer, {}, {
    type: 'tool/result',
    data: { callId: 'c1', name: 'bash', output: '✔ 58 tests passed\n[exit code: 0]' },
  })

  const distilled = distillBuffer(buffer, { projectId: 'p_test', sessionId: 's1' })
  assert.ok(distilled)
  assert.equal(distilled.authority, AUTHORITIES.CANDIDATE)
  assert.ok(distilled.source.causal)
  assert.equal(distilled.source.causal.rootCause, 'concurrent DatabaseSync writes')
  assert.equal(distilled.source.causal.remedy, 'wrap writes in a mutex')
  assert.equal(distilled.source.causal.verifiedOutcome, 'test-passed')
  assert.ok(distilled.tags.includes('causal'))
  assert.ok(distilled.tags.includes('has-root-cause'))
  assert.ok(distilled.tags.includes('has-remedy'))
  assert.ok(distilled.body.includes('Root cause: concurrent DatabaseSync writes'))
  assert.ok(distilled.body.includes('Remedy: wrap writes in a mutex'))
  assert.ok(distilled.body.includes('Verified outcome: test-passed'))
})

test('multi-step troubleshooting turn accumulates complete causal lifecycle', () => {
  const buffer = newBuffer()
  observeEvent(buffer, {}, { type: 'turn/start', data: { turn: 1 } })
  // 1. Initial test failure observed
  observeEvent(buffer, {}, {
    type: 'tool/call',
    data: { callId: 't1', name: 'bash', arguments: JSON.stringify({ command: 'npm test' }) },
  })
  observeEvent(buffer, {}, {
    type: 'tool/result',
    data: { callId: 't1', name: 'bash', output: 'FAIL test/store.test.mjs: database is locked\n[exit code: 1]' },
  })
  // 2. Root cause identified and fix applied
  observeEvent(buffer, {}, {
    type: 'user/message',
    data: { content: [{ type: 'text', text: 'The root cause is missing PRAGMA busy_timeout. The fix is to add busy_timeout = 5000 in openDatabase.' }] },
  })
  observeEvent(buffer, {}, {
    type: 'tool/call',
    data: { callId: 't2', name: 'edit', arguments: JSON.stringify({ file_path: 'src/store.mjs' }) },
  })
  // 3. Tests verify fix
  observeEvent(buffer, {}, {
    type: 'tool/call',
    data: { callId: 't3', name: 'bash', arguments: JSON.stringify({ command: 'npm test' }) },
  })
  observeEvent(buffer, {}, {
    type: 'tool/result',
    data: { callId: 't3', name: 'bash', output: '✔ 58 tests pass\n[exit code: 0]' },
  })

  const distilled = distillBuffer(buffer, { projectId: 'p_multi' })
  assert.ok(distilled)
  assert.ok(distilled.source.causal)
  assert.equal(distilled.source.causal.rootCause, 'missing PRAGMA busy_timeout')
  assert.equal(distilled.source.causal.remedy, 'add busy_timeout = 5000 in openDatabase')
  assert.equal(distilled.source.causal.verifiedOutcome, 'test-passed')

  // Learning progression: candidate → derived
  const store = openEphemeralStore()
  const written = store.put(distilled)
  assert.equal(written.record.authority, AUTHORITIES.CANDIDATE)

  const learned = maybeLearn(store, written.record)
  assert.ok(learned)
  assert.equal(learned.authority, AUTHORITIES.DERIVED)
  assert.equal(learned.source.causal.verifiedOutcome, 'test-passed')
  // Because it had test-passed, initial validation tier is REVIEWED
  assert.equal(learned.validation, VALIDATIONS.REVIEWED)

  // Promotion to canonical requires explicit flag; auto-promote fails
  const denied = promote(store, learned.id, { to: AUTHORITIES.CANONICAL, explicit: false })
  assert.equal(denied.ok, false)
  assert.ok(denied.error.includes('explicit user action'))
  const promoted = promote(store, learned.id, { to: AUTHORITIES.CANONICAL, explicit: true })
  assert.equal(promoted.ok, true)
  assert.equal(promoted.record.authority, AUTHORITIES.CANONICAL)

  store.close()
})

// ============================================================================
// Negative Causality Requirements (Mandatory per Spec)
// ============================================================================

test('negative requirement: temporal adjacency alone creates NO causal relationship', () => {
  // Test fails, file is edited, test passes, but user makes NO causal claim or explanation
  const user = 'Ran tests, updated store.mjs, ran tests again.'
  const tools = [
    { name: 'bash:result', preview: 'FAIL test/store.test.mjs\n[exit code: 1]' },
    { name: 'edit', arguments: { file_path: 'src/store.mjs' } },
    { name: 'bash:result', preview: '✔ all tests pass\n[exit code: 0]' },
  ]
  const facets = extractCausalFacets({ user, tools, files: ['src/store.mjs'] })
  // Invariant: Temporal proximity alone without core causal explanation (rootCause or remedy) yields null
  assert.equal(facets, null)
})

test('negative requirement: simultaneous changes do not arbitrarily identify one root cause', () => {
  const user = 'Worked on refactoring across store.mjs, ids.mjs, and plugin.mjs.'
  const tools = [
    { name: 'edit', arguments: { file_path: 'src/store.mjs' } },
    { name: 'edit', arguments: { file_path: 'src/ids.mjs' } },
    { name: 'edit', arguments: { file_path: 'src/plugin.mjs' } },
    { name: 'bash:result', preview: '✔ 58 tests pass\n[exit code: 0]' },
  ]
  const facets = extractCausalFacets({
    user,
    tools,
    files: ['src/store.mjs', 'src/ids.mjs', 'src/plugin.mjs'],
  })
  assert.equal(facets, null)
})

test('negative requirement: unstructured chatter creates no causal record', () => {
  const user = 'Hey, can you take a look at the project and let me know what you think?'
  const assistant = 'Sure, everything looks organized and ready for development.'
  const facets = extractCausalFacets({ user, assistant, tools: [], files: [] })
  assert.equal(facets, null)
})

test('negative requirement: a failed remedy is NOT a verified remedy', () => {
  const user = 'The bug was a deadlock. The remedy is to add setTimeout before open.'
  const tools = [
    { name: 'edit', arguments: { file_path: 'src/store.mjs' } },
    { name: 'bash:result', preview: 'FAIL test/store.test.mjs: timeout reached\n[exit code: 1]' },
  ]
  const facets = extractCausalFacets({ user, tools, files: ['src/store.mjs'] })
  assert.ok(facets)
  assert.equal(facets.remedy, 'add setTimeout before open')
  assert.equal(facets.verifiedOutcome, 'test-failed') // NOT test-passed!

  // Buffer distillation test
  const buffer = newBuffer()
  observeEvent(buffer, {}, { type: 'turn/start', data: { turn: 1 } })
  observeEvent(buffer, {}, {
    type: 'user/message',
    data: { content: [{ type: 'text', text: user }] },
  })
  for (const t of tools) {
    observeEvent(buffer, {}, { type: 'tool/result', data: t })
  }
  const distilled = distillBuffer(buffer, { projectId: 'p_fail' })
  assert.ok(distilled)
  assert.ok(!distilled.tags.includes('verified-test'))

  const store = openEphemeralStore()
  const candidate = store.put(distilled)
  const learned = maybeLearn(store, candidate.record)
  if (learned) {
    // A failed remedy must stay unverified!
    assert.equal(learned.validation, VALIDATIONS.UNVERIFIED)
    assert.notEqual(learned.validation, VALIDATIONS.VERIFIED)
    assert.notEqual(learned.validation, VALIDATIONS.REVIEWED)
  }
  store.close()
})

test('negative requirement: contradictory outcomes remain conflict rather than being silently resolved', () => {
  const store = openEphemeralStore()
  store.projectId = 'p_conflict'

  // Memory 1: Serialize DatabaseSync writes with mutex to prevent corruption
  const rec1 = remember(store, {
    title: 'Serialize DatabaseSync writes with mutex to prevent corruption',
    body: 'The decision is to serialize DatabaseSync writes with mutex to prevent corruption.',
    projectId: 'p_conflict',
    evidence: [{ path: 'src/store.mjs' }, { note: 'test-passed' }],
    source: {
      causal: {
        rootCause: 'concurrent DatabaseSync writes',
        remedy: 'serialize writes with a mutex',
        verifiedOutcome: 'test-passed',
      },
    },
  })

  // Memory 2: Contradictory claim — must not serialize
  const rec2 = remember(store, {
    title: 'Do not serialize DatabaseSync writes with mutex to prevent corruption',
    body: 'The decision is not to serialize DatabaseSync writes with mutex to prevent corruption.',
    projectId: 'p_conflict',
    evidence: [{ path: 'src/store.mjs' }],
    source: {
      causal: {
        rootCause: 'concurrent DatabaseSync writes',
        remedy: 'do not serialize writes with a mutex',
        verifiedOutcome: 'test-passed',
      },
    },
  })

  assert.notEqual(rec1.record.id, rec2.record.id)
  const left = store.get(rec1.record.id)
  const right = store.get(rec2.record.id)

  // Must be linked as CONTRADICTS
  const linked = [left, right].some((r) => (r.relations || []).some((rel) => rel.type === RELATIONS.CONTRADICTS))
  assert.equal(linked, true)

  // Neither side was deleted or merged
  assert.equal(store.count(), 2)

  // Recall shows contradiction banners on prompt summary
  const hits = recall({ projectStore: store, query: 'serialize DatabaseSync writes' })
  const annotated = annotateContradictions(hits)
  const prompt = summarizeForPrompt(annotated)
  assert.ok(prompt.includes('CONTRADICTS') || prompt.includes('⚠️'))

  store.close()
})

// ============================================================================
// Retrieval and Intent Affinity Tests
// ============================================================================

test('intent detection distinguishes why, how, outcome, and symptom', () => {
  assert.equal(detectIntent('why did the sqlite writer race happen'), INTENTS.WHY)
  assert.equal(detectIntent('how do we serialize DatabaseSync writes'), INTENTS.HOW)
  assert.equal(detectIntent('did this fix it'), INTENTS.OUTCOME)
  assert.equal(detectIntent('did the tests pass after the fix'), INTENTS.OUTCOME)
  assert.equal(detectIntent('what happened during the test failure'), INTENTS.SYMPTOM)
  assert.equal(detectIntent('what broke in store.mjs'), INTENTS.SYMPTOM)
})

test('recall prioritizes root-cause on why, remedy on how, and outcome on did this fix it', () => {
  const store = openEphemeralStore()
  store.projectId = 'p_intent'

  // Cause-focused memory
  const causeRec = store.put({
    title: 'Root cause: DatabaseSync writer race in concurrent sessions',
    body: 'The root cause was concurrent put() calls corrupting SQLite WAL triggers.',
    authority: AUTHORITIES.DERIVED,
    validation: VALIDATIONS.VERIFIED,
    projectId: 'p_intent',
    tags: ['causal', 'has-root-cause'],
    source: {
      signal: 'root-cause',
      causal: {
        symptom: 'corrupting SQLite WAL triggers',
        rootCause: 'concurrent put() calls',
        remedy: null,
        verifiedOutcome: null,
      },
    },
    evidence: [{ path: 'src/store.mjs' }, { note: 'test-passed' }],
  })

  // Remedy-focused memory
  const remedyRec = store.put({
    title: 'Remedy: wrap DatabaseSync in write mutex',
    body: 'The remedy is to wrap DatabaseSync in write mutex and serialize writes.',
    authority: AUTHORITIES.DERIVED,
    validation: VALIDATIONS.VERIFIED,
    projectId: 'p_intent',
    tags: ['causal', 'has-remedy'],
    source: {
      signal: 'fix',
      causal: {
        symptom: null,
        rootCause: null,
        remedy: 'wrap DatabaseSync in write mutex and serialize writes',
        verifiedOutcome: null,
      },
    },
    evidence: [{ path: 'src/store.mjs' }, { note: 'test-passed' }],
  })

  // Outcome-focused memory
  const outcomeRec = store.put({
    title: 'Verified test outcome: 58 unit tests passing',
    body: 'Verified that busy_timeout resolved database locked errors.',
    authority: AUTHORITIES.DERIVED,
    validation: VALIDATIONS.VERIFIED,
    projectId: 'p_intent',
    tags: ['causal', 'verified-test'],
    source: {
      signal: 'tested',
      causal: {
        symptom: 'database locked errors',
        rootCause: null,
        remedy: 'busy_timeout',
        verifiedOutcome: 'test-passed',
      },
    },
    evidence: [{ path: 'src/store.mjs' }, { note: 'test-passed' }],
  })

  // 1. WHY query
  const whyHits = recall({ projectStore: store, query: 'why did the DatabaseSync writer race happen', limit: 3 })
  assert.ok(whyHits.length >= 2)
  assert.equal(whyHits[0].id, causeRec.record.id)

  // 2. HOW query
  const howHits = recall({ projectStore: store, query: 'how do we wrap DatabaseSync in mutex', limit: 3 })
  assert.ok(howHits.length >= 2)
  assert.equal(howHits[0].id, remedyRec.record.id)

  // 3. OUTCOME query
  const outcomeHits = recall({ projectStore: store, query: 'did this fix it and pass tests', limit: 3 })
  assert.ok(outcomeHits.length >= 1)
  assert.equal(outcomeHits[0].id, outcomeRec.record.id)

  // 4. Summarize for prompt includes structured facets
  const prompt = summarizeForPrompt(whyHits)
  assert.ok(prompt.includes('• Symptom:') || prompt.includes('• Root cause:'))

  store.close()
})

test('strengthenMemory enriches existing causal facets on duplicate confirmation', () => {
  const store = openEphemeralStore()
  const base = store.put({
    title: 'Always serialize DatabaseSync writes',
    body: 'The decision is to serialize DatabaseSync writes.',
    authority: AUTHORITIES.DERIVED,
    validation: VALIDATIONS.UNVERIFIED,
    source: {
      causal: {
        rootCause: 'concurrent DatabaseSync writes',
        remedy: 'serialize DatabaseSync writes',
        verifiedOutcome: null,
      },
    },
    evidence: [{ path: 'src/store.mjs' }],
  })

  const confirmCandidate = {
    id: 'vey_conf',
    title: 'Always serialize DatabaseSync writes',
    body: 'The decision is to serialize DatabaseSync writes, confirmed.',
    authority: AUTHORITIES.CANDIDATE,
    evidence: [{ path: 'src/store.mjs' }, { note: 'test-passed' }],
    source: {
      causal: {
        verifiedOutcome: 'test-passed',
      },
    },
  }

  const strengthened = strengthenMemory(base.record, confirmCandidate)
  assert.equal(strengthened.source.causal.rootCause, 'concurrent DatabaseSync writes')
  assert.equal(strengthened.source.causal.remedy, 'serialize DatabaseSync writes')
  assert.equal(strengthened.source.causal.verifiedOutcome, 'test-passed')
  assert.equal(strengthened.source.observations, 2)
  assert.equal(strengthened.validation, VALIDATIONS.REVIEWED)

  store.close()
})
