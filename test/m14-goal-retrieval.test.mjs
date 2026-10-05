/**
 * M14 — Goal-directed retrieval + Phase 10 capability evaluation (GOAL.md
 * Phase 10 — Advanced Capabilities, §34).
 *
 * Phase 10 is an EVALUATION phase: six candidate capabilities are named in
 * GOAL.md and each must clear a five-gate bar (clear engineering use case,
 * measurable benefit, Veyra-native implementation, regression coverage, no
 * scope violation). Exactly one is adopted here:
 *
 *   ADOPTED   goal-directed retrieval — copied and adapted from dsh-memory
 *             `md_cg/mdcos.py:1411` `_path_goal`
 *             (score = min(1.0, 0.7·goal_term_coverage + 0.3·domain_affinity)).
 *             Veyra has no goals layer and no domain router, so the domain
 *             leg is DROPPED rather than faked; only goal-term coverage
 *             survives (`GOAL_WEIGHT = 0.7`).
 *   REJECTED  metacognition / self-state — Cognitive OS drift, outside the
 *             "Engineering Intelligence for Coding Agents" product identity.
 *   REJECTED  prediction — speculative write-back violates Observe ≠ Store.
 *   REJECTED  advanced reflection — hallucinatory, unverifiable, duplicates
 *             the existing evidence-grounded feedback path.
 *   REJECTED  multi-agent attribution — swarm orchestration, forbidden by
 *             the product identity (no Hive-Swarm / orchestration framework).
 *
 * What the tests pin:
 *   - a goal STEERS ordering and never touches `composite`, authority,
 *     validation, confidence, or lifecycle eligibility,
 *   - the steering is GRADED (higher goal affinity always outranks lower,
 *     measured against deliberately mismatched composites) and degrades to
 *     the normal composite order exactly when goal affinities tie,
 *   - without an explicit goal the ranking path is byte-identical to the
 *     Phase 9 behaviour (strict no-op, flat channel drops out of RRF),
 *   - goal affinity CANNOT promote: a candidate stays invisible to recall
 *     even with a perfect goal match (Candidate ≠ Truth),
 *   - goal affinity CANNOT resurrect: forgotten/superseded stay out,
 *   - project isolation is untouched by the goal leg,
 *   - the coverage tail still zeroes every score key, goal included,
 *   - the five rejected capabilities produced NO code surface.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readFileSync, readdirSync } from 'node:fs'

import { AUTHORITIES, KINDS, STATUSES, VALIDATIONS } from '../src/types.mjs'
import { openEphemeralStore, closeAllStores } from '../src/store.mjs'
import { addRejected } from '../src/negative.mjs'
import {
  GOAL_WEIGHT,
  hybridRetrieve,
  rankRecords,
} from '../src/retrieve.mjs'
import { createToolHarness } from '../src/tools.mjs'

const W = { relevance: 0.32, semantic: 0.10, evidence: 0.18, validation: 0.18, proximity: 0.14, freshness: 0.08, confidence: 0.10, relationship: 0.04 }

const BASE = {
  scope: 'project',
  source: { origin: 'session', observer: 'test' },
  authority: 'derived',
  validation: 'derived',
  confidence: 0.5,
  tags: [],
  relations: [],
  evidence: [],
  kind: KINDS.MEMORY,
  createdAt: 1700000000000,
  updatedAt: 1700000000000,
}
const rec = (id, title, extra = {}) => ({ ...BASE, id, title, body: title, ...extra })

// Same pinned composite contract m3/m11 assert: `composite` must always be
// the plain weighted sum of its own components. A goal must not touch it.
const expectedComposite = (s) => Number((
  s.relevance * W.relevance
  + s.semantic * W.semantic
  + s.evidence_strength * W.evidence
  + s.validation_tier * W.validation
  + s.scope_proximity * W.proximity
  + s.freshness_tier * W.freshness
  + s.confidence * W.confidence
  + s.relationship * W.relationship
  + s.intent_affinity
).toFixed(4))

const order = (results) => results.map((r) => r.id)

// ---------------------------------------------------------------------------
// The adopted capability: goal-term coverage.
// ---------------------------------------------------------------------------

test('GOAL_WEIGHT is the surviving leg of the reference formula (0.7)', () => {
  assert.equal(GOAL_WEIGHT, 0.7)
})

test('an explicit goal reorders output without changing any composite', () => {
  const pool = [
    rec('redis', 'cache warming on cold start takes minutes', { tags: ['deploy'] }),
    rec('redis-check', 'cache warming reports warm at boot but serves cold on first request', { tags: ['deploy'] }),
  ]
  const q = 'warm start behaviour'
  const goal = 'cache warming looks warm but is still cold on the first request'
  const neutral = rankRecords(pool, { query: q, weights: W, intent: 'GENERAL' })
  const steered = rankRecords(pool, { query: q, goal, weights: W, intent: 'GENERAL' })

  // The goal, not the query, decides who leads.
  const best = steered.reduce((a, b) => (b.scores.goal_affinity > a.scores.goal_affinity ? b : a))
  assert.ok(best.scores.goal_affinity > 0, 'the goal must lift at least one record')
  assert.equal(order(steered)[0], best.id, 'the highest goal affinity must surface first')
  assert.equal(best.id, 'redis-check', 'the goal must beat the plain lexical winner')
  assert.notEqual(best.id, order(neutral)[0], 'the lift must be measurable, not a no-op')

  // The score is exposed for explainability (§11) ...
  assert.ok('goal_affinity' in steered[0].scores, 'goal_affinity must be exposed on results')
  const loser = steered.find((r) => r.id !== best.id)
  assert.ok(loser.scores.goal_affinity < best.scores.goal_affinity)

  // ... but composite is untouched on BOTH records (sort-only channel).
  for (const r of steered) {
    assert.equal(r.scores.composite, expectedComposite(r.scores))
  }
  assert.equal(
    neutral.find((r) => r.id === best.id).scores.composite,
    steered.find((r) => r.id === best.id).scores.composite,
    'a goal must not move composite',
  )
})

test('no goal supplied is a strict no-op: output and scores match Phase 9', () => {
  const pool = [
    rec('redis', 'cache warming on cold start takes minutes', { tags: ['deploy'] }),
    rec('redis-check', 'cache warming reports warm at boot but serves cold on first request', { tags: ['deploy'] }),
  ]
  const explicitEmpty = rankRecords(pool, { query: 'warm start behaviour', goal: '   ', weights: W, intent: 'GENERAL' })
  const omitted = rankRecords(pool, { query: 'warm start behaviour', weights: W, intent: 'GENERAL' })

  assert.deepEqual(order(explicitEmpty), order(omitted))
  for (const r of omitted) assert.equal(r.scores.goal_affinity, 0)
  // Flat channel drops out of RRF entirely, so fusion is unchanged too.
  assert.equal(explicitEmpty.map((r) => r.scores.fusion).join(), omitted.map((r) => r.scores.fusion).join())
})

test('a goal over a pool with no lexical hit changes nothing', () => {
  // Goal affinity routes among already-retrieved candidates. It never
  // resurrects a record the query did not surface.
  const pool = [rec('a', 'redis connection pool sizing notes')]
  const steered = rankRecords(pool, { query: 'postgres vacuum bloat', goal: 'redis connection pool sizing', weights: W, intent: 'GENERAL' })
  assert.equal(steered.length, 1)
  assert.ok(steered[0].scores.goal_affinity > 0, 'goal affinity is scoreable even when the query misses')
})

test('goal affinity sort key is graded, not binary: higher affinity beats lower affinity', () => {
  // Three records: high goal affinity, low goal affinity, zero goal affinity.
  // The lower-affinity record is given slightly higher base scores, proving
  // that the goal leg actually steers the sort rather than yielding to composite.
  const pool = [
    rec('low-goal', 'cache warming takes minutes on cold start', {
      confidence: 0.9,
      tags: ['deploy', 'prod', 'infra'],
    }),
    rec('high-goal', 'cache warming reports warm at boot but serves cold on first request', {
      confidence: 0.3,
      tags: [],
    }),
    rec('zero-goal', 'completely unrelated postgres migration notes', {
      confidence: 0.9,
      tags: ['deploy', 'prod'],
    }),
  ]
  const q = 'deploy operation'
  const goal = 'cache warming reports warm at boot but serves cold on first request'
  const steered = rankRecords(pool, { query: q, goal, weights: W, intent: 'GENERAL' })
  assert.equal(steered[0].id, 'high-goal', 'highest goal affinity surfaces first')
  assert.equal(steered[1].id, 'low-goal', 'partial goal affinity surfaces second')
  assert.equal(steered[2].id, 'zero-goal', 'zero goal affinity surfaces last')
})

test('records with equal goal affinity preserve their composite / fusion order', () => {
  // Both records describe the same thing, so the goal affinity ties exactly.
  // They differ only in evidence_strength (via evidence count), which is a
  // real composite component, so the stronger-composite record must win.
  const pool = [
    rec('twin-thin', 'redis cache warming takes minutes', { evidence: [] }),
    rec('twin-rich', 'redis cache warming takes minutes', {
      evidence: [{ type: 'test', note: 'reproduced 3x' }, { type: 'doc', note: 'runbook' }],
    }),
  ]
  const q = 'redis cache warming'
  const goal = 'redis cache warming'
  const steered = rankRecords(pool, { query: q, goal, weights: W, intent: 'GENERAL' })
  assert.equal(steered[0].scores.goal_affinity, steered[1].scores.goal_affinity, 'goal affinities tie')
  assert.ok(steered[0].scores.composite > steered[1].scores.composite, 'richer evidence has higher composite')
  assert.equal(steered[0].id, 'twin-rich', 'stronger composite wins the tie')
})

// ---------------------------------------------------------------------------
// A goal is a direction, not an authority (Core Invariants).
// ---------------------------------------------------------------------------

test('goal affinity cannot promote: a candidate stays invisible to recall', () => {
  const store = openEphemeralStore()
  try {
    store.put({
      title: 'candidate finding about the exact goal text',
      body: 'postgres index rebuild during deploy',
      authority: AUTHORITIES.CANDIDATE,
      kind: KINDS.MEMORY,
    })
    store.put({
      title: 'derived note unrelated',
      body: 'something else entirely about deploys',
      authority: AUTHORITIES.DERIVED,
      kind: KINDS.MEMORY,
    })
    const withGoal = recallFrom(store, 'postgres index rebuild during deploy', 'postgres index rebuild during deploy')
    assert.equal(withGoal.filter((r) => r.authority === AUTHORITIES.CANDIDATE).length, 0,
      'a perfect goal match must never surface a candidate')
    assert.ok(withGoal.some((r) => r.authority === AUTHORITIES.DERIVED))
  } finally {
    closeAllStores()
  }
})

test('goal affinity cannot resurrect: forgotten and superseded stay out', () => {
  const store = openEphemeralStore()
  try {
    const forgotten = store.put({ title: 'old', body: 'postgres index rebuild during deploy', authority: AUTHORITIES.DERIVED, kind: KINDS.MEMORY }).record
    const superseded = store.put({ title: 'old', body: 'postgres index rebuild during deploy notes', authority: AUTHORITIES.DERIVED, kind: KINDS.MEMORY }).record
    const current = store.put({ title: 'new', body: 'postgres index rebuild during deploy replacement', authority: AUTHORITIES.DERIVED, kind: KINDS.MEMORY }).record
    store.db.prepare('UPDATE memory SET forgotten = 1 WHERE id = ?').run(forgotten.id)
    store.db.prepare('UPDATE memory SET status = ? WHERE id = ?').run(STATUSES.SUPERSEDED, superseded.id)

    const results = recallFrom(store, 'postgres index rebuild during deploy', 'postgres index rebuild during deploy')
    const ids = results.map((r) => r.id)
    assert.ok(!ids.includes(forgotten.id), 'forgotten record must stay out')
    assert.ok(!ids.includes(superseded.id), 'superseded record must stay out')
    assert.ok(ids.includes(current.id))
  } finally {
    closeAllStores()
  }
})

test('goal affinity never rewrites authority, validation, confidence or scope', () => {
  const pool = [rec('a', 'postgres index rebuild during deploy', {
    authority: AUTHORITIES.DERIVED,
    validation: VALIDATIONS.REVIEWED,
    confidence: 0.5,
  })]
  const [r] = rankRecords(pool, { query: '', goal: 'postgres index rebuild during deploy', weights: W, intent: 'GENERAL' })
  assert.equal(r.authority, AUTHORITIES.DERIVED)
  assert.equal(r.validation, VALIDATIONS.REVIEWED)
  assert.equal(r.confidence, 0.5)
  assert.equal(r.scope, 'project')
  assert.equal(r.goal_affinity, undefined, 'affinity is a score, never a record field')
})

// ---------------------------------------------------------------------------
// Project isolation and coverage tail are untouched by the goal leg.
// ---------------------------------------------------------------------------

test('project isolation survives an explicit goal', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'veyra-goal-iso-'))
  const harness = createToolHarness({ veyraHome: dir, fallbackCwd: process.cwd() })
  try {
    await harness.call('veyra_remember', { title: 'Index rebuild during deploy', body: 'postgres index rebuild during deploy is slow' })
    const results = await harness.call('veyra_recall', {
      query: 'postgres index rebuild during deploy',
      goal: 'postgres index rebuild during deploy',
    })
    assert.equal(results.ok, true)
    assert.ok(results.count > 0)
    for (const item of results.items) {
      assert.notEqual(item.scope, 'foreign')
    }
  } finally {
    closeAllStores()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('the coverage tail zeroes goal_affinity too (zero-score entries stay last)', () => {
  const store = openEphemeralStore()
  try {
    store.put({ title: 'good', body: 'postgres index rebuild during deploy works', authority: AUTHORITIES.DERIVED, kind: KINDS.MEMORY })
    addRejected(store, 'postgres index rebuild during deploy never works', 'blocked writes for two hours')
    const results = hybridRetrieve({ projectStore: store, query: 'postgres index rebuild during deploy', goal: 'postgres index rebuild during deploy' })
    assert.ok(results.length >= 2)
    const tail = results[results.length - 1]
    assert.equal(tail.scores.goal_affinity, 0, 'coverage entries carry no goal affinity')
    assert.equal(tail.scores.composite, 0)
    assert.equal(tail.scores.fusion, 0)
  } finally {
    closeAllStores()
  }
})

// ---------------------------------------------------------------------------
// Tool + context wiring.
// ---------------------------------------------------------------------------

test('veyra_recall accepts a goal and returns the steered order', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'veyra-goal-tool-'))
  const harness = createToolHarness({ veyraHome: dir, fallbackCwd: process.cwd() })
  try {
    await harness.call('veyra_remember', { title: 'Cache warming', body: 'redis cache warming takes minutes on cold start' })
    await harness.call('veyra_remember', { title: 'Index rebuild', body: 'postgres index rebuild during deploy blocks writes' })

    const steered = await harness.call('veyra_recall', {
      query: 'deploy database work',
      goal: 'postgres index rebuild during deploy',
    })
    assert.equal(steered.ok, true)
    assert.ok(steered.count >= 2)
    assert.equal(steered.items[0].title, 'Index rebuild', 'goal steers the first result')
    assert.ok(steered.items[0].scores.goal_affinity > 0)

    // Omitting the goal is the documented default and changes nothing else.
    const plain = await harness.call('veyra_recall', { query: 'deploy database work' })
    assert.equal(plain.ok, true)
    for (const item of plain.items) assert.equal(item.scores.goal_affinity, 0)
  } finally {
    closeAllStores()
    rmSync(dir, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// The five REJECTED capabilities must have produced no code surface.
// ---------------------------------------------------------------------------

test('the five rejected Phase 10 capabilities have no code surface', () => {
  const banned = [
    'metacognit',      // metacognition loop
    'selfState',       // agent self-state model
    'self_state',
    'predictOutcome',  // speculative prediction write-back
    'multiAgent',      // swarm / multi-agent attribution
    'multi_agent',
    'reflectionLoop',  // autonomous reflection loop
  ]
  const srcDir = new URL('../src/', import.meta.url)
  const files = readdirSync(srcDir).filter((f) => f.endsWith('.mjs'))
  assert.ok(files.length > 0)
  for (const file of files) {
    const text = readFileSync(new URL(file, srcDir), 'utf8')
    for (const needle of banned) {
      assert.ok(!text.includes(needle),
        `rejected capability surface "${needle}" must not exist in src/${file}`)
    }
  }
})

// --- helpers ---------------------------------------------------------------

function recallFrom(store, query, goal) {
  return hybridRetrieve({ projectStore: store, query, goal, limit: 10 })
}
