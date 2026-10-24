import { test } from 'node:test'
import assert from 'node:assert/strict'
import { RELATIONS, KINDS, AUTHORITIES, SCOPES } from '../src/types.mjs'
import { openEphemeralStore } from '../src/store.mjs'
import { remember } from '../src/learn.mjs'
import { RELATION_POOL_CAP, relationCandidates } from '../src/evolve.mjs'

// The relation-linking pool must be content-relevant, not a recency slice:
// in a mature store the records that extend / update / contradict a new claim
// are usually OLD, and a last-60 recency slice never sees them. See
// relationCandidates in src/evolve.mjs (content tier via FTS + recency
// fallback tier, Jaccard-scored, hard-capped at RELATION_POOL_CAP).

const LINK_TYPES = new Set([RELATIONS.EXTENDS, RELATIONS.UPDATES, RELATIONS.CONTRADICTS, RELATIONS.SUPERSEDES])

function filler(store, i, topic) {
  store.put({
    title: topic + ' filler record ' + i,
    body: topic + ' filler record ' + i + ' about a distinct unrelated matter ' + i,
    authority: AUTHORITIES.DERIVED,
    evidence: [{ path: 'src/learn.mjs' }],
  })
}

test('C1: a new record links to an OLD record by content relevance, not recency', () => {
  const store = openEphemeralStore()
  const oldest = store.put({
    title: 'quantumflux reactor alignment',
    body: 'The quantumflux reactor alignment procedure is: clamp the z axis first.',
    authority: AUTHORITIES.DERIVED,
    evidence: [{ path: 'src/store.mjs' }],
  }).record

  // 250 newer, unrelated records: the oldest record now sits beyond BOTH the
  // legacy last-60 slice and the recency tier's cap (list hard cap is 200),
  // so only the content (FTS) tier can reach it.
  for (let i = 1; i <= 250; i++) filler(store, i, 'zeta')
  assert.ok(!store.list({ limit: 200 }).some((r) => r.id === oldest.id),
    'the oldest record is unreachable by any recency slice (252 rows in store)')

  const res = remember(store, {
    title: 'quantumflux reactor alignment verified',
    kind: KINDS.MEMORY,
    body: 'The quantumflux reactor alignment procedure is: clamp the z axis first, then verify the torque reading.',
  })
  const rec = res.record
  assert.ok(rec, 'remember wrote the new record')
  const edge = (rec.relations || []).find((r) => r.targetId === oldest.id)
  assert.ok(edge, 'new record carries a relation edge to the OLD record')
  assert.ok(LINK_TYPES.has(edge.type), 'edge type is extends/updates/contradicts/supersedes, got: ' + edge.type)
  store.close()
})

test('C2: the candidate pool is hard-bounded at RELATION_POOL_CAP', () => {
  const store = openEphemeralStore()
  for (let i = 1; i <= 150; i++) {
    store.put({
      title: 'quantumflux signal ' + i,
      body: 'quantumflux signal ' + i + ' measurement detail ' + i,
      authority: AUTHORITIES.DERIVED,
      evidence: [{ path: 'src/store.mjs' }],
    })
  }
  for (let i = 1; i <= 150; i++) filler(store, i, 'zeta')
  const pool = relationCandidates(store, { title: 'quantumflux probe', body: 'quantumflux probe' })
  // Chosen cap: 120 = 2x the legacy recency slice of 60, comfortably inside
  // the store's own 200-row list hard cap - bounded, not a full-table scan.
  assert.equal(pool.length, RELATION_POOL_CAP, 'pool respects the hard cap')
  assert.ok(pool.every((r) => r && typeof r.id === 'string'), 'pool entries are store records')
  store.close()
})

test('C3: project isolation holds under the new pool', () => {
  const storeA = openEphemeralStore(':memory:', { scope: SCOPES.PROJECT, projectId: 'pA' })
  const storeB = openEphemeralStore(':memory:', { scope: SCOPES.PROJECT, projectId: 'pB' })
  const onlyA = storeA.put({
    title: 'quantumflux reactor alignment',
    body: 'The quantumflux reactor alignment procedure is: clamp the z axis first.',
    authority: AUTHORITIES.DERIVED,
    evidence: [{ path: 'src/store.mjs' }],
  }).record
  for (let i = 1; i <= 5; i++) filler(storeB, i, 'zeta')
  const poolB = relationCandidates(storeB, { title: 'quantumflux reactor alignment probe', body: 'probe' })
  assert.ok(!poolB.some((r) => r.id === onlyA.id), 'records of another project never enter the pool')
  storeA.close()
  storeB.close()
})

test('C4: forgotten records are never selected by the pool', () => {
  const store = openEphemeralStore()
  const gone = store.put({
    title: 'quantumflux reactor alignment',
    body: 'The quantumflux reactor alignment procedure is: clamp the z axis first.',
    authority: AUTHORITIES.DERIVED,
    evidence: [{ path: 'src/store.mjs' }],
  }).record
  store.forget(gone.id)
  const pool = relationCandidates(store, { title: 'quantumflux probe', body: 'quantumflux probe' })
  assert.ok(!pool.some((r) => r.id === gone.id), 'forgotten record stays out of the candidate pool')
  store.close()
})
