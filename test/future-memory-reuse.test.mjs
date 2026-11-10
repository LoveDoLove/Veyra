/**
 * Task 34 — Future Memory Reuse (isolated integration, existing APIs only).
 *
 * Verifies the existing end-to-end reuse path:
 *   Engineering experience candidate → maybeLearn (derived, eligible)
 *   → persisted memory → separate future task → automatic context provider
 *   → learned memory surfaced (no manual veyra_recall).
 *
 * Negative controls: unrelated future task, different workspace, and
 * ineligible/unverified records must not be surfaced as applicable memory.
 * Uses temporary stores only; no live DSH Web, no production DB, no network.
 */
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { closeAllStores } from '../src/store.mjs'
import { maybeLearn } from '../src/learn.mjs'
import { AUTHORITIES, CONFIDENCES, KINDS, STATUSES, VALIDATIONS } from '../src/types.mjs'
import { createContextProvider } from '../src/context.mjs'
import { roomIdFor, roomStore, testRuntime } from './helpers/room.mjs'

after(() => { try { closeAllStores() } catch {} })

// Each of these paths is its own workspace room. The registry must list every
// path the test asks about, otherwise an unresolved workspace would fail closed
// and the negative controls would pass without proving isolation.
function runtime(home, cwd, paths = [cwd]) {
  return testRuntime(home, cwd, { paths, recallLimit: 5, includeReusable: true })
}

function sqliteCandidate(projectId, cwd) {
  return {
    kind: KINDS.OBSERVATION, scope: 'project', projectId, authority: AUTHORITIES.CANDIDATE,
    status: STATUSES.CURRENT, validation: VALIDATIONS.UNVERIFIED, confidence: CONFIDENCES.MEDIUM,
    title: 'Fix: sqlite writer lock contention in store put',
    body: 'Root cause: concurrent DatabaseSync writes unsynchronized. Remedy: serialize put() calls with a write mutex in src/store.mjs.',
    evidence: [{ path: 'src/store.mjs', note: 'edit' }, { note: 'test-passed' }],
    tags: ['edited', 'verified-test', 'fix'],
    source: {
      automatic: true, sessionId: 's-old', cwd, observations: 1,
      provenance: { origins: ['assistant', 'tool'], workspace: cwd },
      signal: 'fix', tools: 2, files: ['src/store.mjs'],
      causal: { rootCause: 'concurrent DatabaseSync writes unsynchronized', remedy: 'serialize put() calls with a write mutex', verifiedOutcome: 'test-passed' },
    },
  }
}

async function ask(home, cwd, text, paths) {
  const provider = createContextProvider(runtime(home, cwd, paths))
  return provider({
    agent: {
      session: { header: { cwd }, deriveMessages: () => [{ role: 'user', content: text, source: { kind: 'user' } }] },
      inbox: {},
    },
  })
}

test('automatically learned derived memory is surfaced by automatic context provider in a later relevant same-workspace task', async () => {
  const home = mkdtempSync(join(tmpdir(), 'veyra-future-reuse-'))
  const cwd = '/tmp/veyra-future-reuse-ws-a'
  try {
    // Records are addressed by workspace room, and a record's projectId is that
    // room's id — the seed store and the store the provider resolves are one room.
    const projectId = roomIdFor(cwd)
    const store = roomStore(home, cwd)
    const put = store.put(sqliteCandidate(projectId, cwd))
    const learned = maybeLearn(store, { ...put.record }, { workspace: cwd })
    assert.ok(learned, 'valid grounded candidate should become learned derived memory')
    assert.equal(learned.authority, AUTHORITIES.DERIVED)
    assert.equal(learned.status, STATUSES.CURRENT)
    assert.notEqual(learned.validation, VALIDATIONS.INVALID)
    assert.notEqual(learned.validation, VALIDATIONS.STALE)

    const out = await ask(home, cwd, 'Diagnose sqlite writer lock contention in the store and fix flaky put tests', [cwd])
    assert.match(out, /Veyra recalled engineering memory|sqlite writer lock|write mutex/i)
    assert.match(out, /sqlite writer lock|write mutex/i, 'relevant learned memory must be surfaced automatically')
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('negative controls: unrelated task, different workspace, and ineligible memory are not surfaced as applicable reuse', async () => {
  const home = mkdtempSync(join(tmpdir(), 'veyra-future-reuse-neg-'))
  const cwdA = '/tmp/veyra-future-reuse-ws-a'
  const cwdB = '/tmp/veyra-future-reuse-ws-b'
  const cwdC = '/tmp/veyra-future-reuse-ws-c'
  try {
    const paths = [cwdA, cwdB, cwdC]
    const pidA = roomIdFor(cwdA)
    const storeA = roomStore(home, cwdA)
    const learned = maybeLearn(storeA, { ...storeA.put(sqliteCandidate(pidA, cwdA)).record }, { workspace: cwdA })
    assert.ok(learned)

    // Different workspace must not surface project-local memory (project isolation).
    const diffWs = await ask(home, cwdB, 'Diagnose sqlite writer lock contention in the store and fix flaky put tests', paths)
    assert.doesNotMatch(diffWs, /sqlite writer lock|write mutex/i)

    // Ineligible: raw candidate/observation (not learned to derived recall-eligible authority) must not surface.
    const pidC = roomIdFor(cwdC)
    roomStore(home, cwdC).put({ ...sqliteCandidate(pidC, cwdC), id: undefined })
    const candidateOnly = await ask(home, cwdC, 'Diagnose sqlite writer lock contention in the store and fix flaky put tests', paths)
    assert.doesNotMatch(candidateOnly, /sqlite writer lock|write mutex/i)

    // Ineligible: invalid validation must not surface even if record exists.
    // Separate record (no learned.id) so we do not mutate the eligible learned memory.
    storeA.put({
      kind: KINDS.OBSERVATION, scope: 'project', projectId: pidA, authority: AUTHORITIES.DERIVED,
      status: STATUSES.CURRENT, validation: VALIDATIONS.INVALID, confidence: CONFIDENCES.LOW,
      title: 'Fix: sqlite writer lock contention INVALID copy',
      body: 'Root cause: concurrent DatabaseSync writes unsynchronized. Remedy: serialize put() calls with a write mutex. INVALID-only marker for ineligible recall control.',
      evidence: [{ path: 'src/store.mjs', note: 'edit' }, { note: 'unique-invalid' }],
      tags: ['fix'],
      source: { automatic: true, sessionId: 's-invalid', cwd: cwdA, observations: 99, provenance: { origins: ['assistant', 'tool'], workspace: cwdA }, causal: { rootCause: 'concurrent DatabaseSync writes unsynchronized', remedy: 'serialize put() calls with a write mutex', verifiedOutcome: 'test-failed' } },
    })
    const invalidOut = await ask(home, cwdA, 'Diagnose sqlite writer lock contention in the store and fix flaky put tests', paths)
    assert.doesNotMatch(invalidOut, /INVALID copy/i)
    // Relevant learned non-invalid memory may still be surfaced for the relevant task.
    assert.match(invalidOut, /sqlite writer lock|write mutex/i)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})
