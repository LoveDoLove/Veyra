/**
 * Task 32 — automatic learning must not strengthen a failed attempt into
 * a successful/verified solution via a later duplicate.
 *
 * Scenario: a derived memory was learned from a test-failed turn
 * (verifiedOutcome/test-failed evidence). A later automatic duplicate
 * candidate carries test-passed evidence for the same claim. Strengthening
 * the duplicate must preserve failure history and must not represent the
 * record as a successful solution (no test-passed verifiedOutcome, no
 * verification/promotion-candidate escalation from the passed duplicate).
 *
 * Uses temporary stores only. No prod/runtime/DB access.
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

async function withStore(fn) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'veyra-task32-'))
  try {
    const store = openProjectStore(home, 'p_task32')
    return await fn(store)
  } finally {
    await fs.rm(home, { recursive: true, force: true })
  }
}

function failedDerived() {
  return {
    title: 'Fix: sqlite writer lock contention',
    body: 'Root cause: concurrent writes to DatabaseSync. Remedy: serialize put() calls with a write mutex. Verified outcome: test-failed.',
    kind: KINDS.MEMORY,
    scope: 'project',
    projectId: 'p_task32',
    authority: AUTHORITIES.DERIVED,
    status: STATUSES.CURRENT,
    validation: VALIDATIONS.UNVERIFIED,
    confidence: CONFIDENCES.MEDIUM,
    evidence: [{ path: 'src/store.mjs', note: 'edit' }, { note: 'test-failed' }],
    tags: ['learned'],
    source: {
      automatic: true,
      provenance: { origins: ['assistant', 'tool'] },
      observations: 1,
      cwd: '/tmp/p_task32',
      causal: {
        rootCause: 'concurrent writes to DatabaseSync',
        remedy: 'serialize put() calls with a write mutex',
        verifiedOutcome: 'test-failed',
      },
    },
  }
}

function passedDuplicateCandidate(neighbor) {
  return {
    id: 'cand_pass_dup',
    title: neighbor.title,
    body: 'Root cause: concurrent writes to DatabaseSync. Remedy: serialize put() calls with a write mutex. Verified outcome: test-passed.',
    kind: KINDS.OBSERVATION,
    scope: 'project',
    projectId: 'p_task32',
    authority: AUTHORITIES.CANDIDATE,
    status: STATUSES.CURRENT,
    validation: VALIDATIONS.UNVERIFIED,
    evidence: [{ path: 'src/store.mjs', note: 'edit' }, { note: 'test-passed' }],
    tags: [],
    source: {
      automatic: true,
      provenance: { origins: ['assistant', 'tool'] },
      observations: 1,
      cwd: '/tmp/p_task32',
      causal: {
        rootCause: 'concurrent writes to DatabaseSync',
        remedy: 'serialize put() calls with a write mutex',
        verifiedOutcome: 'test-passed',
      },
    },
  }
}

test('duplicate strengthen must not rewrite a test-failed derived memory into test-passed/verified success', async () => {
  await withStore(async (store) => {
    const seeded = store.put(failedDerived()).record
    const candidate = store.put(passedDuplicateCandidate(seeded)).record
    const evolved = evolveAgainst(store, candidate, [store.get(seeded.id)])
    assert.equal(evolved.action, 'duplicate', 'test setup: later candidate should be a duplicate')
    assert.equal(provenanceAllowsLearning(candidate), true)

    // Simulate plugin turn-stopping duplicate path: strengthen + put.
    const strengthened = strengthenMemory(evolved.neighbor, candidate, { workspace: '/tmp/p_task32' })
    const saved = store.put(strengthened).record

    assert.equal(saved.authority, AUTHORITIES.DERIVED, 'authority unchanged, never promoted to canonical')
    assert.notEqual(saved.validation, VALIDATIONS.VERIFIED, 'failed history must not become verified by a passed duplicate')
    assert.ok(!saved.tags?.includes('promotion-candidate'), 'failed history must not become promotion-candidate')
    assert.equal(saved.source?.causal?.verifiedOutcome, 'test-failed', 'failed verifiedOutcome must not be overwritten by test-passed duplicate')
    assert.ok(saved.evidence?.some((e) => e?.note === 'test-failed'), 'failure evidence preserved')
    assert.ok(saved.evidence?.some((e) => e?.note === 'test-passed'), 'later observation evidence may be merged, but must not rewrite outcome')
  })
})

test('candidate with test-failed outcome must not gain verified/passed outcome when strengthening a prior record', async () => {
  await withStore(async (store) => {
    const base = store.put({
      ...failedDerived(),
      validation: VALIDATIONS.REVIEWED,
      evidence: [{ path: 'src/store.mjs', note: 'edit' }, { note: 'tests-touched' }],
      source: {
        automatic: true,
        provenance: { origins: ['assistant', 'tool'] },
        observations: 2,
        cwd: '/tmp/p_task32',
        causal: { rootCause: 'concurrent writes', remedy: 'serialize writes', verifiedOutcome: null },
      },
    }).record
    const failedCandidate = {
      ...passedDuplicateCandidate(base),
      id: 'cand_fail_dup',
      body: base.body,
      evidence: [{ path: 'src/store.mjs', note: 'edit' }, { note: 'test-failed' }],
      source: {
        automatic: true,
        provenance: { origins: ['assistant', 'tool'] },
        observations: 1,
        cwd: '/tmp/p_task32',
        causal: { rootCause: 'concurrent writes', remedy: 'serialize writes', verifiedOutcome: 'test-failed' },
      },
    }
    const s = strengthenMemory(base, failedCandidate, {})
    assert.notEqual(s.validation, VALIDATIONS.VERIFIED)
    assert.equal(s.source?.causal?.verifiedOutcome, 'test-failed')
    assert.ok(!s.tags?.includes('promotion-candidate'))
  })
})
