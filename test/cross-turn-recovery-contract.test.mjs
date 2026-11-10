/**
 * Task 33 — cross-turn recovery evidence contracts.
 *
 * Cross-turn duplicate strengthening lacks Task 16's same-turn ordered
 * corrective-action evidence. These tests document safe boundaries:
 * - failure history is preserved (Task 32)
 * - unrelated later success must not strengthen the failed record
 * - missing/ambiguous provenance must not enable automatic strengthening
 * - a later duplicate that looks like recovery is NOT auto-promoted to a
 *   verified successful solution without safely established cross-turn
 *   recovery evidence (avoids inventing recovery inference)
 *
 * Temporary stores only.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import os from 'node:os'
import fs from 'node:fs/promises'
import path from 'node:path'

import { openProjectStore } from '../src/store.mjs'
import { evolveAgainst } from '../src/evolve.mjs'
import { strengthenMemory, provenanceAllowsLearning } from '../src/learn.mjs'
import { AUTHORITIES, CONFIDENCES, KINDS, STATUSES, VALIDATIONS } from '../src/types.mjs'

const BASE_CAUSAL = {
  rootCause: 'concurrent DatabaseSync writes unsynchronized',
  remedy: 'serialize put() calls with a write mutex',
  verifiedOutcome: 'test-failed',
}
const PROV = { automatic: true, provenance: { origins: ['assistant', 'tool'] }, observations: 1, cwd: '/tmp/p33' }

async function withStore(fn) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'veyra-task33-'))
  try { return await fn(openProjectStore(home, 'p33')) }
  finally { await fs.rm(home, { recursive: true, force: true }) }
}

function seedFailed(store) {
  return store.put({
    title: 'Fix: sqlite writer lock contention',
    body: 'Root cause: concurrent DatabaseSync writes unsynchronized. Remedy: serialize put() calls with a write mutex. Verified outcome: test-failed.',
    kind: KINDS.MEMORY, scope: 'project', projectId: 'p33',
    authority: AUTHORITIES.DERIVED, status: STATUSES.CURRENT,
    validation: VALIDATIONS.UNVERIFIED, confidence: CONFIDENCES.MEDIUM,
    evidence: [{ path: 'src/store.mjs', note: 'edit-attempt' }, { note: 'test-failed' }],
    tags: ['learned'], source: { ...PROV, causal: BASE_CAUSAL },
  }).record
}

test('genuine-looking cross-turn recovery duplicate preserves failure history and does not invent verified success', async () => {
  await withStore(async (store) => {
    const failed = seedFailed(store)
    const recoveryCand = store.put({
      title: failed.title,
      body: failed.body.replace('test-failed', 'test-passed'),
      kind: KINDS.OBSERVATION, scope: 'project', projectId: 'p33',
      authority: AUTHORITIES.CANDIDATE, status: STATUSES.CURRENT, validation: VALIDATIONS.UNVERIFIED,
      evidence: [{ path: 'src/store.mjs', note: 'edit' }, { note: 'test-passed' }],
      tags: ['edited', 'verified-test'],
      source: { ...PROV, causal: { ...BASE_CAUSAL, verifiedOutcome: 'test-passed' } },
    }).record
    const evolved = evolveAgainst(store, recoveryCand, [store.get(failed.id)])
    assert.equal(evolved.action, 'duplicate')
    assert.equal(provenanceAllowsLearning(recoveryCand), true)
    const s = strengthenMemory(evolved.neighbor, recoveryCand, {})
    assert.equal(s.source?.causal?.verifiedOutcome, 'test-failed', 'failure history preserved; cross-turn recovery not safely inferable from duplicate')
    assert.notEqual(s.validation, VALIDATIONS.VERIFIED)
    assert.ok(!s.tags?.includes('promotion-candidate'))
    assert.ok(s.evidence?.some((e) => e?.note === 'test-failed'))
  })
})

test('unrelated later test success does not strengthen the failed record', async () => {
  await withStore(async (store) => {
    const failed = seedFailed(store)
    const unrelated = store.put({
      title: 'Fix: cache key collision in http client',
      body: 'Root cause: cache key omitted query params. Remedy: include normalized query in key. Verified outcome: test-passed.',
      kind: KINDS.OBSERVATION, scope: 'project', projectId: 'p33',
      authority: AUTHORITIES.CANDIDATE, status: STATUSES.CURRENT, validation: VALIDATIONS.UNVERIFIED,
      evidence: [{ path: 'src/http-cache.mjs', note: 'edit' }, { note: 'test-passed' }],
      tags: ['edited', 'verified-test'],
      source: { ...PROV, causal: { rootCause: 'cache key omitted query params', remedy: 'include normalized query in key', verifiedOutcome: 'test-passed' } },
    }).record
    const evolved = evolveAgainst(store, unrelated, [store.get(failed.id)])
    assert.notEqual(evolved.action, 'duplicate')
    const still = store.get(failed.id)
    assert.equal(still.source?.causal?.verifiedOutcome, 'test-failed')
    assert.equal(still.validation, VALIDATIONS.UNVERIFIED)
  })
})

test('missing or ambiguous provenance blocks automatic strengthening path', async () => {
  await withStore(async (store) => {
    const failed = seedFailed(store)
    // Assert on candidate objects (plugin checks provenanceAllowsLearning(candidate)
    // before duplicate strengthening). store.put may dedupe identical content to the
    // existing record; provenance guard must still reject ambiguous candidates.
    const missingProv = {
      title: failed.title, body: failed.body.replace('test-failed', 'test-passed'),
      kind: KINDS.OBSERVATION, scope: 'project', projectId: 'p33',
      authority: AUTHORITIES.CANDIDATE, status: STATUSES.CURRENT, validation: VALIDATIONS.UNVERIFIED,
      evidence: [{ path: 'src/store.mjs', note: 'edit' }, { note: 'test-passed' }],
      source: { automatic: true, observations: 1, cwd: '/tmp/p33', causal: { ...BASE_CAUSAL, verifiedOutcome: 'test-passed' } },
    }
    assert.equal(provenanceAllowsLearning(missingProv), false)
    const userIncluded = {
      title: failed.title, body: failed.body.replace('test-failed', 'test-passed different text'),
      kind: KINDS.OBSERVATION, scope: 'project', projectId: 'p33',
      authority: AUTHORITIES.CANDIDATE, status: STATUSES.CURRENT, validation: VALIDATIONS.UNVERIFIED,
      evidence: [{ path: 'src/store.mjs', note: 'edit' }, { note: 'test-passed' }],
      source: { automatic: true, provenance: { origins: ['user', 'assistant', 'tool'] }, observations: 1, cwd: '/tmp/p33', causal: { ...BASE_CAUSAL, verifiedOutcome: 'test-passed' } },
    }
    assert.equal(provenanceAllowsLearning(userIncluded), false)
    assert.equal(store.get(failed.id).source?.causal?.verifiedOutcome, 'test-failed')
  })
})
