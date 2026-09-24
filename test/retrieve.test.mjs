import { test } from 'node:test'
import assert from 'node:assert/strict'
import { AUTHORITIES, KINDS, SCOPES, VALIDATIONS } from '../src/types.mjs'
import { openEphemeralStore } from '../src/store.mjs'
import { rankRecords, recall, summarizeForPrompt } from '../src/retrieve.mjs'

test('ranking exposes a full dimensional breakdown, not an opaque score', () => {
  const ranked = rankRecords([
    {
      id: 'weak',
      title: 'guess',
      body: 'maybe',
      evidence: [],
      validation: VALIDATIONS.UNVERIFIED,
      scope: SCOPES.REUSABLE,
      confidence: 'low',
      updatedAt: '2018-01-01T00:00:00.000Z',
    },
    {
      id: 'strong',
      title: 'verified fix',
      body: 'lock the writer',
      evidence: [{ path: 'src/store.mjs' }, { path: 'test/store.test.mjs' }],
      validation: VALIDATIONS.VERIFIED,
      scope: SCOPES.PROJECT,
      confidence: 'high',
      updatedAt: new Date().toISOString(),
    },
  ])
  assert.ok(ranked[0].scores.composite > ranked[1].scores.composite)
  assert.equal(ranked[0].id, 'strong')
  for (const key of ['composite', 'relevance', 'evidence_strength', 'validation_tier', 'scope_proximity', 'freshness_tier', 'confidence', 'intent_affinity']) {
    assert.equal(typeof ranked[0].scores[key], 'number')
  }
})

test('recall isolates project stores and excludes candidates', () => {
  const projectA = openEphemeralStore()
  projectA.projectId = 'p_aaa'
  const projectB = openEphemeralStore()
  projectB.projectId = 'p_bbb'
  const reusable = openEphemeralStore()
  reusable.projectId = 'reusable'
  reusable.scope = SCOPES.REUSABLE

  projectA.put({
    title: 'Project A uses WAL',
    body: 'Only project A should see this sqlite WAL note.',
    authority: AUTHORITIES.DERIVED,
    projectId: 'p_aaa',
    scope: SCOPES.PROJECT,
  })
  projectA.put({
    title: 'Candidate guess about WAL',
    body: 'Maybe WAL is the problem. Unverified observation.',
    authority: AUTHORITIES.CANDIDATE,
    kind: KINDS.OBSERVATION,
    projectId: 'p_aaa',
  })
  projectB.put({
    title: 'Project B never uses WAL',
    body: 'Project B stores everything in memory. Do not apply A\'s WAL note here.',
    authority: AUTHORITIES.DERIVED,
    projectId: 'p_bbb',
    scope: SCOPES.PROJECT,
  })
  reusable.put({
    title: 'FTS queries must be quoted',
    body: 'Reusable lesson: always quote FTS5 tokens.',
    authority: AUTHORITIES.DERIVED,
    projectId: 'reusable',
    scope: SCOPES.REUSABLE,
  })

  const fromA = recall({ projectStore: projectA, reusableStore: reusable, query: 'WAL sqlite FTS', limit: 10 })
  assert.ok(fromA.some((r) => r.title.includes('Project A')))
  assert.ok(fromA.some((r) => r.title.includes('FTS queries')))
  assert.ok(!fromA.some((r) => r.title.includes('Project B')))
  assert.ok(!fromA.some((r) => r.authority === AUTHORITIES.CANDIDATE))

  const fromB = recall({ projectStore: projectB, reusableStore: reusable, query: 'WAL sqlite', limit: 10 })
  assert.ok(fromB.some((r) => r.title.includes('Project B')))
  assert.ok(!fromB.some((r) => r.title.includes('Project A')))

  const prompt = summarizeForPrompt(fromA)
  assert.ok(prompt.includes('not repository truth'))
  assert.ok(prompt.includes('Similarity is not authority'))
})
