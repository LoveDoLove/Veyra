/**
 * Narrative-quality gate regression tests.
 *
 * Covers two fixes from the Continuous Learning evaluation (2026-10-31):
 * 1. Narrative-only records (body starts with "Agent:" and lacks root cause /
 *    remedy / decision) must NOT be promoted to REVIEWED even with test-passed
 *    evidence — neither in writeGate nor via strengthenMemory.
 * 2. In recall ranking, narrative-only records sort below actionable ones at
 *    equal fusion score (sort-only tiebreaker, no score mutation).
 *
 * All tests use isolated temp SQLite stores — the real DSH memory DB is never touched.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AUTHORITIES, VALIDATIONS, KINDS, STATUSES } from '../src/types.mjs'
import { MemoryStore } from '../src/store.mjs'
import { isNarrativeOnly, writeGate, strengthenMemory } from '../src/learn.mjs'
import { recall, rankRecords } from '../src/retrieve.mjs'

function tempStore() {
  const dir = mkdtempSync(join(tmpdir(), 'veyra-narr-'))
  return new MemoryStore(join(dir, 'memory.db'), { scope: 'project', projectId: 'p_narr' })
}

const NARRATIVE_BODY = 'Agent: We observed a race condition in the build pipeline — a symptom of deeper architecture issues with the migration layer. Let me explore src/learn.mjs and src/understand.mjs to understand the deadlock patterns here.'
const ACTIONABLE_BODY = 'Root cause: writeGate promoted narrative records to REVIEWED via test-passed. Remedy: cap validation at UNVERIFIED when isNarrativeOnly(body).'

// ── isNarrativeOnly unit tests ──────────────────────────────────────────────

test('isNarrativeOnly: Agent: prefix without actionable markers → true', () => {
  assert.equal(isNarrativeOnly(NARRATIVE_BODY), true)
})

test('isNarrativeOnly: Agent: prefix WITH root cause/remedy → false', () => {
  assert.equal(isNarrativeOnly('Agent: The root cause was a missing gate. Remedy: add isNarrativeOnly check.'), false)
})

test('isNarrativeOnly: actionable body without Agent: prefix → false', () => {
  assert.equal(isNarrativeOnly(ACTIONABLE_BODY), false)
})

test('isNarrativeOnly: non-string / empty → false', () => {
  assert.equal(isNarrativeOnly(''), false)
  assert.equal(isNarrativeOnly(null), false)
  assert.equal(isNarrativeOnly(undefined), false)
})

// ── writeGate: narrative cap ────────────────────────────────────────────────

test('writeGate: narrative candidate with test-passed stays UNVERIFIED', () => {
  const store = tempStore()
  const result = writeGate(store, {
    title: 'Provenance gate lesson: must always verify origins before learning',
    body: NARRATIVE_BODY,
    kind: KINDS.OBSERVATION,
    authority: AUTHORITIES.CANDIDATE,
    validation: VALIDATIONS.UNVERIFIED,
    scope: 'project',
    projectId: 'p_narr',
    evidence: [{ note: 'test-passed' }, { path: 'src/learn.mjs' }],
    source: { provenance: { origins: ['assistant'] } },
  })
  assert.equal(result.decision, 'ACCEPT')
  assert.equal(result.record.validation, VALIDATIONS.UNVERIFIED, 'narrative + test-passed must NOT reach REVIEWED')
  store.close()
})

test('writeGate: actionable candidate with test-passed reaches REVIEWED', () => {
  const store = tempStore()
  const result = writeGate(store, {
    title: 'Fix: narrative promotion bug',
    body: ACTIONABLE_BODY,
    kind: KINDS.MEMORY,
    authority: AUTHORITIES.CANDIDATE,
    validation: VALIDATIONS.UNVERIFIED,
    scope: 'project',
    projectId: 'p_narr',
    evidence: [{ note: 'test-passed' }, { path: 'src/learn.mjs' }],
    source: { provenance: { origins: ['assistant'] } },
  })
  assert.equal(result.decision, 'ACCEPT')
  assert.equal(result.record.validation, VALIDATIONS.REVIEWED, 'actionable + test-passed should reach REVIEWED')
  store.close()
})

// ── strengthenMemory: narrative cap ─────────────────────────────────────────

test('strengthenMemory: narrative neighbor never escalates past UNVERIFIED', () => {
  const store = tempStore()
  // Seed a derived record with narrative body
  const seeded = store.put({
    title: 'Race condition regression in build pipeline',
    body: NARRATIVE_BODY,
    kind: KINDS.MEMORY,
    status: STATUSES.CURRENT,
    authority: AUTHORITIES.DERIVED,
    validation: VALIDATIONS.UNVERIFIED,
    confidence: 'low',
    scope: 'project',
    projectId: 'p_narr',
    evidence: [{ path: 'src/learn.mjs' }],
    source: { observations: 1, provenance: { origins: ['assistant'] } },
  }).record

  // Strengthen 3 times with test-passed evidence — would normally reach VERIFIED
  const strengthened = strengthenMemory(seeded, {
    title: seeded.title,
    body: NARRATIVE_BODY + ' More narration.',
    evidence: [{ note: 'test-passed' }],
    source: { provenance: { origins: ['assistant'] } },
  })
  // Simulate 3 observations
  const s2 = strengthenMemory({ ...strengthened, source: { ...strengthened.source, observations: 3 } }, {
    title: seeded.title,
    body: NARRATIVE_BODY,
    evidence: [{ note: 'test-passed' }],
    source: { provenance: { origins: ['assistant'] } },
  })
  assert.equal(s2.validation, VALIDATIONS.UNVERIFIED, 'narrative neighbor capped at UNVERIFIED despite 3+ obs + test-passed')
  store.close()
})

test('strengthenMemory: actionable neighbor still escalates normally', () => {
  const store = tempStore()
  const seeded = store.put({
    title: 'Fix: real bug',
    body: ACTIONABLE_BODY,
    kind: KINDS.MEMORY,
    status: STATUSES.CURRENT,
    authority: AUTHORITIES.DERIVED,
    validation: VALIDATIONS.UNVERIFIED,
    confidence: 'low',
    scope: 'project',
    projectId: 'p_narr',
    evidence: [{ path: 'src/learn.mjs' }],
    source: { observations: 2, provenance: { origins: ['assistant'] } },
  }).record

  const strengthened = strengthenMemory(seeded, {
    title: seeded.title,
    body: ACTIONABLE_BODY,
    evidence: [{ note: 'test-passed' }],
    source: { provenance: { origins: ['assistant'] } },
  })
  // 3 observations + test-passed → VERIFIED for actionable
  assert.ok(
    strengthened.validation === VALIDATIONS.VERIFIED || strengthened.validation === VALIDATIONS.REVIEWED,
    'actionable neighbor should escalate (got ' + strengthened.validation + ')'
  )
  store.close()
})

// ── recall ranking: narrative sort demotion ─────────────────────────────────

test('rankRecords: narrative-only sorts below actionable at equal fusion', () => {
  const narrative = {
    id: 'n1', title: 'Engineering observation', body: NARRATIVE_BODY,
    authority: 'derived', validation: 'reviewed', confidence: 'medium',
    scope: 'project', tags: ['test'], evidence: [],
    scores: { fusion: 0.5, composite: 0.5, relevance: 0.3, semantic: 0.2, authority: 0.5 },
  }
  const actionable = {
    id: 'a1', title: 'Fix: bug', body: ACTIONABLE_BODY,
    authority: 'derived', validation: 'reviewed', confidence: 'medium',
    scope: 'project', tags: ['test'], evidence: [],
    scores: { fusion: 0.5, composite: 0.5, relevance: 0.3, semantic: 0.2, authority: 0.5 },
  }
  // rankRecords expects pre-scored records? No — it scores them. Let me use recall instead.
  // Actually rankRecords takes raw records and scores them. The narrative tiebreak
  // is inside the sort. Let's test via rankRecords with a query that matches both equally.
  const ranked = rankRecords([narrative, actionable], { query: 'test fix bug learn' })
  assert.equal(ranked[0].id, 'a1', 'actionable should rank first at equal scores')
  assert.equal(ranked[1].id, 'n1', 'narrative should rank second')
})

test('rankRecords: composite/scores are NOT mutated by narrative tiebreak', () => {
  const narrative = {
    id: 'n1', title: 'Obs', body: NARRATIVE_BODY,
    authority: 'derived', validation: 'reviewed', confidence: 'medium',
    scope: 'project', tags: [], evidence: [],
  }
  const actionable = {
    id: 'a1', title: 'Fix', body: ACTIONABLE_BODY,
    authority: 'derived', validation: 'reviewed', confidence: 'medium',
    scope: 'project', tags: [], evidence: [],
  }
  const ranked = rankRecords([narrative, actionable], { query: 'fix learn' })
  // Find the narrative record and check its composite wasn't penalized
  const narrRec = ranked.find(r => r.id === 'n1')
  assert.ok(narrRec.scores.composite !== undefined, 'composite preserved')
  assert.ok(!('narrative_penalty' in narrRec.scores), 'no penalty field added to scores')
})

// ── recall integration: candidate/stale exclusion still works ────────────────

test('recall: candidate and stale records still excluded (no regression)', () => {
  const store = tempStore()
  // Seed candidate
  store.put({
    title: 'Candidate noise', body: 'some observation',
    kind: KINDS.OBSERVATION, authority: AUTHORITIES.CANDIDATE,
    validation: VALIDATIONS.UNVERIFIED, scope: 'project', projectId: 'p_narr',
    tags: ['bug', 'fix'], evidence: [], source: { provenance: { origins: ['assistant'] } },
  })
  // Seed stale derived
  store.put({
    title: 'Stale fix', body: 'Root cause: old bug. Remedy: old fix.',
    kind: KINDS.MEMORY, authority: AUTHORITIES.DERIVED,
    validation: VALIDATIONS.STALE, status: STATUSES.CURRENT, scope: 'project', projectId: 'p_narr',
    tags: ['bug', 'fix'], evidence: [], source: { provenance: { origins: ['assistant'] } },
  })
  // Seed good derived
  store.put({
    title: 'Good fix', body: ACTIONABLE_BODY,
    kind: KINDS.MEMORY, authority: AUTHORITIES.DERIVED,
    validation: VALIDATIONS.REVIEWED, status: STATUSES.CURRENT, scope: 'project', projectId: 'p_narr',
    tags: ['bug', 'fix'], evidence: [{ note: 'test-passed' }], source: { provenance: { origins: ['assistant'] } },
  })
  const results = recall({ projectStore: store, query: 'bug fix root cause remedy', limit: 10 })
  const ids = results.map(r => r.title)
  assert.ok(ids.includes('Good fix'), 'good derived record recalled')
  assert.ok(!ids.includes('Candidate noise'), 'candidate excluded')
  assert.ok(!ids.includes('Stale fix'), 'stale excluded')
  store.close()
})

test('recall: narrative derived ranks below actionable derived for same query', () => {
  const store = tempStore()
  // Seed narrative derived (reviewed but narrative body)
  store.put({
    title: 'Narrative obs', body: NARRATIVE_BODY,
    kind: KINDS.MEMORY, authority: AUTHORITIES.DERIVED,
    validation: VALIDATIONS.REVIEWED, status: STATUSES.CURRENT, confidence: 'high',
    scope: 'project', projectId: 'p_narr',
    tags: ['provenance', 'gate', 'learn'], evidence: [{ path: 'src/learn.mjs', note: 'test-passed' }],
    source: { provenance: { origins: ['assistant'] } },
  })
  // Seed actionable derived
  store.put({
    title: 'Provenance gate fix', body: 'Root cause: provenance gate allowed user-origin. Remedy: block user origins in learningGuards. Decision: always require assistant-only provenance for auto-learning.',
    kind: KINDS.MEMORY, authority: AUTHORITIES.DERIVED,
    validation: VALIDATIONS.REVIEWED, status: STATUSES.CURRENT, confidence: 'high',
    scope: 'project', projectId: 'p_narr',
    tags: ['provenance', 'gate', 'learn'], evidence: [{ path: 'src/learn.mjs', note: 'test-passed' }],
    source: { provenance: { origins: ['assistant'] } },
  })
  const results = recall({ projectStore: store, query: 'provenance gate learn fix', limit: 5 })
  assert.ok(results.length >= 2, 'both records recalled: ' + results.length)
  assert.equal(results[0].title, 'Provenance gate fix', 'actionable should rank above narrative')
  store.close()
})
