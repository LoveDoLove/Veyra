/**
 * CTO Task 31 — Task-Relevant Memory Applicability (temporal).
 *
 * Reproducible defect (before fix): a `not_yet_effective` (future
 * `validFrom`) record was treated as temporally applicable
 * (`temporal_validity = 1`) and was never rank-limited, so it could outrank
 * a currently applicable record on text similarity alone. Similarity is not
 * applicability; scheduled/future knowledge is not current truth for the
 * present task.
 *
 * Contract preserved:
 * - not_yet_effective records remain fully recallable (not removed).
 * - When a currently applicable alternative exists, query-driven recall
 *   must not let not_yet_effective outrank it on text similarity.
 * - No eligible current alternative => record stays recallable (fail-safe).
 * - Expired behavior unchanged. Trust/provenance/project isolation preserved.
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { openProjectStore, closeAllStores } from '../src/store.mjs'
import { hybridRetrieve, rankRecords, temporalState } from '../src/retrieve.mjs'
import { SCOPES, KINDS, AUTHORITIES, STATUSES, VALIDATIONS, CONFIDENCES } from '../src/types.mjs'

const FUTURE = new Date(Date.now() + 86400000 * 30).toISOString()
const PAST = '2000-01-01T00:00:00Z'

function rec(id, title, body, extra = {}) {
  return {
    id, kind: KINDS.KNOWLEDGE, status: STATUSES.CURRENT,
    validation: VALIDATIONS.REVIEWED, authority: AUTHORITIES.DERIVED,
    confidence: CONFIDENCES.HIGH, scope: SCOPES.PROJECT, projectId: 'p31',
    title, body, tags: ['auth', 'cli'], evidence: [{ path: 'src/auth.mjs' }],
    updatedAt: new Date().toISOString(), ...extra,
  }
}

test('Task 31: not_yet_effective textually similar record must not outrank a currently applicable alternative', () => {
  // Future-scheduled record is more textually similar to the query.
  const future = rec('future', 'CLI auth implementation uses API token header',
    'CLI auth implementation currently sends x-api-token header on requests',
    { source: { temporal: { validFrom: FUTURE } } })
  // Current record is less textually similar but applicable now.
  const current = rec('current', 'Auth migration planning notes',
    'Planning to move CLI auth to OAuth2 device flow', { source: {} })

  const ranked = rankRecords([future, current], { query: 'CLI auth implementation uses API token header' })
  assert.equal(ranked.length, 2, 'both records remain recallable')
  const fut = ranked.find((r) => r.id === 'future')
  const cur = ranked.find((r) => r.id === 'current')
  assert.equal(temporalState(future), 'not_yet_effective')
  assert.equal(fut.scores.temporal_validity, 0, 'not_yet_effective is not currently applicable')
  assert.equal(fut.scores.rank_limited, true, 'must be held below currently applicable alternative')
  assert.ok(cur.scores.rank_limited !== true, 'current applicable record not rank-limited')
  assert.ok(cur.scores.fusion > fut.scores.fusion, 'currently applicable record ranks first')
})

test('Task 31: sole not_yet_effective record remains recallable when no current alternative exists', () => {
  const future = rec('future-only', 'CLI auth implementation uses API token header',
    'CLI auth implementation currently sends x-api-token header on requests',
    { source: { temporal: { validFrom: FUTURE } } })
  const ranked = rankRecords([future], { query: 'CLI auth implementation uses API token header' })
  assert.equal(ranked.length, 1)
  assert.equal(ranked[0].id, 'future-only', 'scheduled knowledge stays recallable')
  assert.equal(ranked[0].scores.temporal_validity, 0)
  assert.notEqual(ranked[0].scores.rank_limited, true, 'no eligible alternative => no sort-only cap')
})

test('Task 31: hybrid recall surfaces currently applicable record ahead of not_yet_effective match', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'veyra-t31-temporal-'))
  try {
    const proj = openProjectStore(home, 'p31t')
    proj.put(rec('future', 'CLI auth implementation uses API token header',
      'CLI auth implementation currently sends x-api-token header on requests',
      { projectId: 'p31t', source: { temporal: { validFrom: FUTURE } } }))
    proj.put(rec('current', 'Auth migration planning notes',
      'Planning to move CLI auth to OAuth2 device flow',
      { projectId: 'p31t', source: {} }))

    const hits = hybridRetrieve({
      projectStore: proj, reusableStore: null,
      query: 'CLI auth implementation uses API token header',
      includeReusable: false, limit: 5,
    })
    assert.equal(hits.length, 2)
    assert.equal(hits[0].id, 'current', 'currently applicable record is returned first')
    assert.equal(temporalState(hits.find((h) => h.id === 'future')), 'not_yet_effective')
    assert.equal(hits.find((h) => h.id === 'future').scores.rank_limited, true)
  } finally {
    closeAllStores()
    fs.rmSync(home, { recursive: true, force: true })
  }
})

test('Task 31: expired records still rank-limited below current alternatives (regression guard)', () => {
  const expired = rec('expired', 'CLI auth uses legacy cookie', 'Legacy cookie auth',
    { source: { temporal: { validUntil: PAST } } })
  const current = rec('current', 'CLI auth uses bearer token', 'Bearer token auth', { source: {} })
  const ranked = rankRecords([expired, current], { query: 'CLI auth' })
  assert.equal(ranked.find((r) => r.id === 'expired').scores.temporal_validity, 0)
  assert.equal(ranked.find((r) => r.id === 'expired').scores.rank_limited, true)
  assert.ok(ranked[0].id === 'current')
})
