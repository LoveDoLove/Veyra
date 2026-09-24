import { test } from 'node:test'
import assert from 'node:assert/strict'
import { AUTHORITIES, CONFIDENCES, KINDS, RELATIONS, SCOPES, VALIDATIONS } from '../src/types.mjs'
import { openEphemeralStore } from '../src/store.mjs'
import {
  evidenceStrength,
  hybridRetrieve,
  lexicalScore,
  rankRecords,
  recall,
  relationshipScore,
  semanticSimilarity,
  summarizeForPrompt,
} from '../src/retrieve.mjs'
import {
  observatoryCausality,
  observatoryContradictions,
  observatoryLocalGraph,
  observatoryOverview,
  observatoryRecord,
  observatoryRelationships,
  observatorySearch,
} from '../src/observatory.mjs'
import { handleVeyraCommand } from '../src/commands.mjs'
import { buildToolDefinitions, createToolHarness } from '../src/tools.mjs'

test('hybrid search: transparent dimensional score breakdown and ranking', () => {
  const store = openEphemeralStore()
  store.projectId = 'p_hybrid'

  const recA = store.put({
    title: 'Serialize DatabaseSync writes with a mutex',
    body: 'To prevent SQLite lock errors in WAL mode, serialize writes with an async mutex.',
    authority: AUTHORITIES.DERIVED,
    validation: VALIDATIONS.VERIFIED,
    confidence: CONFIDENCES.HIGH,
    projectId: 'p_hybrid',
    tags: ['sqlite', 'mutex', 'wal'],
    evidence: [{ path: 'src/store.mjs' }, { note: 'test-passed' }],
    source: {
      causal: {
        symptom: 'SQLite lock errors',
        rootCause: 'concurrent DatabaseSync writes',
        remedy: 'serialize writes with an async mutex',
        verifiedOutcome: 'test-passed',
      },
    },
  })

  const recB = store.put({
    title: 'Docker deployment for Cloudflare worker bridge',
    body: 'How to containerize the bridge service for deployment.',
    authority: AUTHORITIES.DERIVED,
    validation: VALIDATIONS.UNVERIFIED,
    confidence: CONFIDENCES.LOW,
    projectId: 'p_hybrid',
    tags: ['docker', 'deploy'],
    evidence: [],
  })

  const results = hybridRetrieve({
    projectStore: store,
    query: 'sqlite mutex lock',
    limit: 5,
  })

  assert.ok(results.length >= 1)
  const top = results[0]
  assert.equal(top.id, recA.record.id)

  // Verify full transparent score breakdown
  const sc = top.scores
  assert.equal(typeof sc.composite, 'number')
  assert.equal(typeof sc.lexical, 'number')
  assert.equal(typeof sc.semantic, 'number')
  assert.equal(typeof sc.evidence_strength, 'number')
  assert.equal(typeof sc.validation_tier, 'number')
  assert.equal(typeof sc.scope_proximity, 'number')
  assert.equal(typeof sc.freshness_tier, 'number')
  assert.equal(typeof sc.confidence, 'number')
  assert.equal(typeof sc.intent_affinity, 'number')
  assert.equal(typeof sc.relationship, 'number')

  // Top result has strong lexical and semantic overlap
  assert.ok(sc.semantic > 0.3)
  assert.ok(sc.evidence_strength >= 0.7)
  assert.ok(sc.composite > 0.7)

  store.close()
})

test('unified RAG + Engineering Memory retrieval with distinct provenance', () => {
  const store = openEphemeralStore()
  store.projectId = 'p_rag'

  // RAG / Knowledge Item
  const docRec = store.put({
    title: 'Cordis Plugin Architecture Specification',
    body: 'Cordis plugins use ctx.provide and ctx.inject to declare lifecycle dependencies.',
    kind: KINDS.KNOWLEDGE,
    authority: AUTHORITIES.CANONICAL,
    validation: VALIDATIONS.REVIEWED,
    confidence: CONFIDENCES.HIGH,
    projectId: 'p_rag',
    tags: ['cordis', 'architecture', 'spec'],
    evidence: [{ path: 'docs/architecture.md' }],
    source: {
      kind: 'knowledge',
      docPath: 'docs/architecture.md',
      uri: 'file://docs/architecture.md',
    },
  }, { explicitCanonical: true })

  // Engineering Memory Item
  const memRec = store.put({
    title: 'Fix: cordis plugin loading order in DSH boot',
    body: 'Root cause was circular injection between systemPrompt and tools. Remedy: inject services lazily.',
    kind: KINDS.MEMORY,
    authority: AUTHORITIES.DERIVED,
    validation: VALIDATIONS.VERIFIED,
    confidence: CONFIDENCES.HIGH,
    projectId: 'p_rag',
    tags: ['cordis', 'plugin', 'fix'],
    evidence: [{ path: 'src/plugin.mjs' }, { note: 'test-passed' }],
    source: {
      sessionId: 'session_123',
      tool: 'session-distiller',
      causal: {
        symptom: 'cordis plugin deadlock on boot',
        rootCause: 'circular injection between systemPrompt and tools',
        remedy: 'inject services lazily',
        verifiedOutcome: 'test-passed',
      },
    },
  })

  // 1. Unified retrieval brings back both RAG knowledge and Engineering Memory
  const allHits = hybridRetrieve({
    projectStore: store,
    query: 'cordis plugin',
    limit: 5,
  })
  assert.equal(allHits.length, 2)
  const kinds = allHits.map((h) => h.kind)
  assert.ok(kinds.includes(KINDS.KNOWLEDGE))
  assert.ok(kinds.includes(KINDS.MEMORY))

  // 2. Filter specifically for RAG knowledge
  const ragOnly = hybridRetrieve({
    projectStore: store,
    query: 'cordis',
    kind: KINDS.KNOWLEDGE,
    limit: 5,
  })
  assert.equal(ragOnly.length, 1)
  assert.equal(ragOnly[0].id, docRec.record.id)
  assert.equal(ragOnly[0].source.docPath, 'docs/architecture.md')

  // 3. Filter specifically for Engineering Memory
  const memOnly = hybridRetrieve({
    projectStore: store,
    query: 'cordis',
    kind: KINDS.MEMORY,
    limit: 5,
  })
  assert.equal(memOnly.length, 1)
  assert.equal(memOnly[0].id, memRec.record.id)
  assert.equal(memOnly[0].source.causal.rootCause, 'circular injection between systemPrompt and tools')

  // 4. Summarize for prompt distinguishes [KNOWLEDGE] and [MEMORY]
  const promptSummary = summarizeForPrompt(allHits)
  assert.ok(promptSummary.includes('[KNOWLEDGE] Cordis Plugin Architecture Specification'))
  assert.ok(promptSummary.includes('• Source: docs/architecture.md'))
  assert.ok(promptSummary.includes('• Root cause: circular injection between systemPrompt and tools'))
  assert.ok(promptSummary.includes('• Remedy: inject services lazily'))

  store.close()
})

test('relationship scoring boosts connected graph knowledge', () => {
  const store = openEphemeralStore()
  store.projectId = 'p_rel'

  const baseRec = store.put({
    title: 'Base SQLite schema definition',
    body: 'Initial table schema for SQLite memory storage.',
    authority: AUTHORITIES.DERIVED,
    validation: VALIDATIONS.VERIFIED,
    projectId: 'p_rel',
  })

  const childRec = store.put({
    title: 'FTS5 trigger update for SQLite schema',
    body: 'Add FTS5 triggers to sync memory inserts and updates.',
    authority: AUTHORITIES.DERIVED,
    validation: VALIDATIONS.VERIFIED,
    projectId: 'p_rel',
    relations: [{ type: RELATIONS.UPDATES, targetId: baseRec.record.id }],
  })

  const isolatedRec = store.put({
    title: 'Isolated note without connections',
    body: 'Random note without any links to other knowledge.',
    authority: AUTHORITIES.DERIVED,
    validation: VALIDATIONS.VERIFIED,
    projectId: 'p_rel',
    relations: [],
  })

  const poolIds = new Set([baseRec.record.id, childRec.record.id, isolatedRec.record.id])
  const childRelScore = relationshipScore(childRec.record, poolIds)
  const isoRelScore = relationshipScore(isolatedRec.record, poolIds)

  assert.ok(childRelScore > isoRelScore, 'Interconnected record has higher relationship score')

  store.close()
})

test('knowledge observatory: overview, record deep inspection, causality, relations, and contradictions', () => {
  const projectStore = openEphemeralStore()
  projectStore.projectId = 'p_obs'
  const reusableStore = openEphemeralStore()
  reusableStore.projectId = 'reusable'

  // Seed project memories with causal and contradiction links
  const mem1 = projectStore.put({
    title: 'Fix: DatabaseSync writer race condition',
    body: 'Serialization of writes resolved the race condition in node:sqlite.',
    kind: KINDS.MEMORY,
    authority: AUTHORITIES.DERIVED,
    validation: VALIDATIONS.VERIFIED,
    confidence: CONFIDENCES.HIGH,
    projectId: 'p_obs',
    tags: ['sqlite', 'mutex', 'causal'],
    evidence: [{ path: 'src/store.mjs' }, { note: 'test-passed' }],
    source: {
      sessionId: 'sess_abc',
      tool: 'veyra_remember',
      causal: {
        symptom: 'database locked error',
        rootCause: 'concurrent put() calls',
        remedy: 'async write mutex',
        verifiedOutcome: 'test-passed',
      },
    },
  })

  const mem2 = projectStore.put({
    title: 'Conflicting claim: do not use mutex for DatabaseSync',
    body: 'Using mutex causes thread pool contention and slows down throughput.',
    kind: KINDS.MEMORY,
    authority: AUTHORITIES.DERIVED,
    validation: VALIDATIONS.UNVERIFIED,
    confidence: CONFIDENCES.LOW,
    projectId: 'p_obs',
    tags: ['sqlite', 'performance'],
    relations: [{ type: RELATIONS.CONTRADICTS, targetId: mem1.record.id }],
  })

  // Seed RAG knowledge doc
  const doc1 = projectStore.put({
    title: 'SQLite WAL Mode Guide',
    body: 'WAL mode allows concurrent readers while one writer is active.',
    kind: KINDS.KNOWLEDGE,
    authority: AUTHORITIES.CANONICAL,
    validation: VALIDATIONS.REVIEWED,
    confidence: CONFIDENCES.HIGH,
    projectId: 'p_obs',
    evidence: [{ path: 'docs/wal.md' }],
    source: { docPath: 'docs/wal.md' },
    relations: [{ type: RELATIONS.EXTENDS, targetId: mem1.record.id }],
  }, { explicitCanonical: true })

  // 1. Overview
  const ov = observatoryOverview({
    projectStore,
    reusableStore,
    cwd: '/workspace/test',
    projectId: 'p_obs',
    veyraHome: '/tmp/veyra-home',
  })
  assert.equal(ov.ok, true)
  assert.equal(ov.data.activeRecords, 3)
  assert.equal(ov.data.kindCounts.memory, 2)
  assert.equal(ov.data.kindCounts.knowledge, 1)
  assert.equal(ov.data.authorityCounts.canonical, 1)
  assert.equal(ov.data.authorityCounts.derived, 2)
  assert.equal(ov.data.causalRecordsCount, 1)
  assert.equal(ov.data.contradictionCount, 1)
  assert.ok(ov.formatted.includes('VEYRA KNOWLEDGE OBSERVATORY — OVERVIEW'))
  assert.ok(ov.formatted.includes('Knowledge / RAG    : 1'))

  // 2. Record Detail (Answers the 6 Questions)
  const detail = observatoryRecord({
    projectStore,
    reusableStore,
    id: mem1.record.id,
  })
  assert.equal(detail.ok, true)
  assert.ok(detail.formatted.includes('1. WHAT DOES VEYRA KNOW?'))
  assert.ok(detail.formatted.includes('2. WHY DOES VEYRA KNOW IT?'))
  assert.ok(detail.formatted.includes('3. WHERE DID IT COME FROM? (PROVENANCE)'))
  assert.ok(detail.formatted.includes('4. WHEN WAS IT OBSERVED?'))
  assert.ok(detail.formatted.includes('5. WHAT EVIDENCE SUPPORTS IT?'))
  assert.ok(detail.formatted.includes('6. WHAT VALIDATION OCCURRED?'))
  assert.ok(detail.formatted.includes('Causal Facets (Four-Facet Lifecycle)'))
  assert.ok(detail.formatted.includes('Symptom          : database locked error'))
  assert.ok(detail.formatted.includes('Root Cause   : concurrent put() calls'))
  assert.ok(detail.formatted.includes('Remedy       : async write mutex'))
  assert.ok(detail.formatted.includes('Outcome      : test-passed'))
  assert.ok('incomingRelations' in detail.data)
  assert.ok(detail.formatted.includes(`/veyra observatory local ${mem1.record.id}`))

  // 3. Search Inspection
  const sRes = observatorySearch({
    projectStore,
    reusableStore,
    query: 'database lock mutex',
  })
  assert.equal(sRes.ok, true)
  assert.ok(sRes.hits.length >= 1)
  assert.ok(sRes.formatted.includes('Signals    : Lexical='))
  assert.ok(sRes.formatted.includes('Semantic='))
  assert.ok(sRes.formatted.includes('Invariant: Search scores reflect contextual relevance, not authority.'))
  assert.ok(sRes.formatted.includes(`/veyra observatory record ${sRes.hits[0].id}`))
  assert.ok(sRes.formatted.includes(`/veyra observatory local ${sRes.hits[0].id}`))

  // 4. Causality Map
  const caus = observatoryCausality({ projectStore, reusableStore })
  assert.equal(caus.ok, true)
  assert.equal(caus.data.length, 1)
  assert.ok(caus.formatted.includes('CAUSAL KNOWLEDGE MAP (1 records)'))
  assert.ok(caus.formatted.includes('Symptom          : database locked error'))
  assert.ok(caus.formatted.includes('Invariant: Temporal adjacency alone never creates causality.'))

  // 5. Relationships Graph
  const rels = observatoryRelationships({ projectStore, reusableStore })
  assert.equal(rels.ok, true)
  assert.equal(rels.data.length, 2)
  assert.ok(rels.formatted.includes('RELATIONSHIP GRAPH (2 edges)'))
  assert.ok(rels.formatted.includes('CONTRADICTS'))
  assert.ok(rels.formatted.includes('EXTENDS'))

  const local = observatoryLocalGraph({ projectStore, reusableStore, id: mem1.record.id })
  assert.equal(local.ok, true)
  assert.ok(local.formatted.includes('VEYRA OBSERVATORY — LOCAL GRAPH'))
  assert.ok(local.data.nodes.some((n) => n.id === mem2.record.id))
  assert.ok(local.data.nodes.some((n) => n.id === doc1.record.id))

  // 6. Contradictions Inspection (Both sides kept, side-by-side)
  const contra = observatoryContradictions({ projectStore, reusableStore })
  assert.equal(contra.ok, true)
  assert.equal(contra.data.length, 1)
  assert.ok(contra.formatted.includes('CONTRADICTION INSPECTION (1 conflicts)'))
  assert.ok(contra.formatted.includes('Side A:'))
  assert.ok(contra.formatted.includes('Side B:'))
  assert.ok(contra.formatted.includes('Action: Do not resolve automatically. Verify against codebase or tests.'))

  projectStore.close()
  reusableStore.close()
})

test('tools veyra_recall kind parameter and inspect causal views', async () => {
  const store = openEphemeralStore()
  const runtime = {
    veyraHome: '/tmp/veyra-tool-test-' + Date.now(),
    fallbackCwd: process.cwd(),
    recallLimit: 5,
    includeReusable: true,
  }
  const harness = createToolHarness(runtime)

  // Store engineering memory
  const rMem = await harness.call('veyra_remember', {
    title: 'Decision: SQLite WAL mode',
    body: 'Always enable WAL mode in DatabaseSync.',
    kind: 'memory',
  })
  assert.equal(rMem.ok, true)
  assert.equal(rMem.record.kind, 'memory')

  // Store RAG knowledge
  const rDoc = await harness.call('veyra_remember', {
    title: 'Architecture Guide for SQLite',
    body: 'SQLite documentation and operational guidelines.',
    kind: 'knowledge',
  })
  assert.equal(rDoc.ok, true)
  assert.equal(rDoc.record.kind, 'knowledge')

  // Recall with kind='knowledge'
  const recallDoc = await harness.call('veyra_recall', {
    query: 'SQLite',
    kind: 'knowledge',
  })
  assert.equal(recallDoc.ok, true)
  assert.ok(recallDoc.items.every((it) => it.kind === 'knowledge'))

  // Inspect record
  const inspected = await harness.call('veyra_inspect', {
    id: rMem.record.id,
  })
  assert.equal(inspected.ok, true)
  assert.equal(inspected.record.id, rMem.record.id)
  assert.ok('source' in inspected.record)
  assert.ok('relations' in inspected.record)
  assert.ok('evidence' in inspected.record)
})
