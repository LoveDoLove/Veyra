import { test } from 'node:test'
import assert from 'node:assert/strict'
import { AUTHORITIES, KINDS, isRecallEligible } from '../src/types.mjs'
import { openEphemeralStore } from '../src/store.mjs'
import { promote } from '../src/learn.mjs'
import { recall } from '../src/retrieve.mjs'

// Observation records are raw captures, never knowledge: ambient recall must
// not surface them (the observation gate in isRecallEligible, src/types.mjs).
// An EXPLICIT promote flips observation -> memory (promote, src/learn.mjs),
// and only then may the record surface. This test locks that behavior -
// Defect 2 is already fixed by the existing promote path, so no production
// change is made here.
test('C6: observation is out of ambient recall until an explicit promote flips it', () => {
  const store = openEphemeralStore()
  store.put({
    title: 'zephyrine baseline note',
    body: 'The zephyrine baseline note stays recallable throughout.',
    authority: AUTHORITIES.DERIVED,
    evidence: [{ path: 'src/store.mjs' }],
  })
  const obs = store.put({
    title: 'zephyrine observation claim',
    body: 'The zephyrine observation claim records an unverified assistant-only finding.',
    kind: KINDS.OBSERVATION,
    authority: AUTHORITIES.CANDIDATE,
    evidence: [{ path: 'src/store.mjs' }],
    source: { automatic: true, signal: 'claim', provenance: { origins: ['assistant'] } },
  }).record
  assert.equal(obs.kind, KINDS.OBSERVATION, 'store persists the observation kind')
  assert.equal(isRecallEligible(obs), false, 'observation is gated out of ambient recall')
  const before = recall({ projectStore: store, query: 'zephyrine observation claim', limit: 10 })
  assert.ok(before.every((r) => r.id !== obs.id), 'ambient recall does not surface the observation before any explicit action')

  const promo = promote(store, obs.id)
  assert.equal(promo.ok, true, 'explicit promotion succeeds')
  const promoted = store.get(obs.id)
  assert.equal(promoted.kind, KINDS.MEMORY, 'promote flips observation to memory')
  assert.equal(promoted.authority, AUTHORITIES.DERIVED, 'promote lands on derived standing')
  assert.equal(isRecallEligible(promoted), true, 'the promoted record is recall-eligible')
  const after = recall({ projectStore: store, query: 'zephyrine observation claim', limit: 10 })
  assert.ok(after.some((r) => r.id === obs.id), 'the promoted record now surfaces in ambient recall')
  store.close()
})
