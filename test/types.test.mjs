import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  AUTHORITIES,
  KINDS,
  STATUSES,
  VALIDATIONS,
  assertAuthorityTransition,
  isRecallEligible,
} from '../src/types.mjs'

function rec(over = {}) {
  return {
    kind: KINDS.MEMORY,
    status: STATUSES.CURRENT,
    validation: VALIDATIONS.UNVERIFIED,
    authority: AUTHORITIES.DERIVED,
    forgotten: false,
    ...over,
  }
}

test('candidates are never recall-eligible', () => {
  assert.equal(isRecallEligible(rec({ authority: AUTHORITIES.CANDIDATE })), false)
})

test('observations are never recall-eligible', () => {
  assert.equal(isRecallEligible(rec({ kind: KINDS.OBSERVATION, authority: AUTHORITIES.DERIVED })), false)
})

test('stale, invalid, forgotten, and non-current records are excluded', () => {
  assert.equal(isRecallEligible(rec({ validation: VALIDATIONS.STALE })), false)
  assert.equal(isRecallEligible(rec({ validation: VALIDATIONS.INVALID })), false)
  assert.equal(isRecallEligible(rec({ forgotten: true })), false)
  assert.equal(isRecallEligible(rec({ status: STATUSES.SUPERSEDED })), false)
})

test('derived and canonical current memories are recall-eligible', () => {
  assert.equal(isRecallEligible(rec({ authority: AUTHORITIES.DERIVED })), true)
  assert.equal(isRecallEligible(rec({ authority: AUTHORITIES.CANONICAL, validation: VALIDATIONS.REVIEWED })), true)
})

test('auto-promote to canonical throws', () => {
  assert.throws(
    () => assertAuthorityTransition(AUTHORITIES.DERIVED, AUTHORITIES.CANONICAL, { explicit: false }),
    /refuses to auto-promote/,
  )
})

test('explicit canonical promotion is allowed', () => {
  assert.doesNotThrow(() => {
    assertAuthorityTransition(AUTHORITIES.DERIVED, AUTHORITIES.CANONICAL, { explicit: true })
  })
})
