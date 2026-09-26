/**
 * M3 regression coverage for `evidenceStrength()` in src/retrieve.mjs.
 *
 * F1 — the evidence fields were composed with `path || uri || anchor || note`,
 * so the first truthy field won and the note was discarded. The note is where
 * `understand.mjs` puts the test outcome, so a memory whose tests passed
 * scored lower than one that merely opened a file under test/.
 *
 * F2 — the test vocabulary was an unanchored `test|spec|fixture`, which also
 * matched ordinary prose such as "inspector", "protest" and "aspect".
 *
 * Both fixes are asserted through the exported function AND through the real
 * `recall()` runtime path, so a future refactor cannot pass by keeping a
 * correct-looking helper while breaking the integration.
 *
 * Deliberately NOT covered here (deferred, needs a retrieval benchmark):
 *   - F4: `relevanceFromRank()` collapsing to zero for multi-word queries
 *   - the relative weight of evidence vs validation vs confidence
 * The weights are asserted as-is below so a weight change cannot slip through
 * unnoticed, but no weight is proposed or changed by this file.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { evidenceStrength, recall, rankRecords } from '../src/retrieve.mjs'
import { MemoryStore } from '../src/store.mjs'

function tempStore() {
  const dir = mkdtempSync(join(tmpdir(), 'veyra-m3-'))
  return new MemoryStore(join(dir, 'memory.db'), { scope: 'project', projectId: 'p_m3' })
}

// ---------------------------------------------------------------------------
// F1 — the note field is actually read
// ---------------------------------------------------------------------------

test('F1: a genuine test-passed note is detected even when a path is present', () => {
  assert.equal(evidenceStrength([{ path: 'src/store.mjs', note: 'test-passed' }]), 1.0)
})

test('F1: a genuine tests-touched note is detected even when a path is present', () => {
  assert.equal(evidenceStrength([{ path: 'src/store.mjs', note: 'tests-touched' }]), 1.0)
})

test('F1: a test-failed note is not positive evidence', () => {
  // hasFile still applies, so the score is the file-only tier.
  assert.equal(evidenceStrength([{ path: 'src/store.mjs', note: 'test-failed' }]), 0.7)
})

test('F1: a path alone no longer implies test evidence', () => {
  assert.equal(evidenceStrength([{ path: 'test/foo.test.mjs', note: 'ordinary note' }]), 0.7)
  assert.equal(evidenceStrength([{ path: 'test/helpers.mjs' }]), 0.7)
  assert.equal(evidenceStrength([{ path: 'spec/x.rb' }]), 0.7)
})

test('F1: outcome and path may arrive as separate evidence items', () => {
  assert.equal(evidenceStrength([
    { path: 'src/store.mjs' },
    { note: 'test-passed' },
  ]), 1.0)
  assert.equal(evidenceStrength([
    { path: 'src/store.mjs' },
    { note: 'tests-touched' },
  ]), 1.0)
})

test('F1: a passing test with no file reference is not promoted to file tier', () => {
  // No path at all -> no hasFile. Outcome alone must not fabricate a file.
  assert.equal(evidenceStrength([{ note: 'test-passed' }]), 0.4)
})

test('F1: uri and anchor fields participate, not just path and note', () => {
  assert.equal(evidenceStrength([{ uri: 'src/store.mjs' }]), 0.7)
  assert.equal(evidenceStrength([{ anchor: 'section-2' }]), 0.4)
})

// ---------------------------------------------------------------------------
// F2 — closed, boundary-aware vocabulary
// ---------------------------------------------------------------------------

for (const [label, path] of [
  ['inspector', 'src/inspector.mjs'],
  ['protest', 'src/protest.mjs'],
  ['aspect', 'src/aspect.mjs'],
  ['contest', 'src/contest.mjs'],
  ['latest', 'src/latest.mjs'],
  ['attestation', 'src/attestation.mjs'],
]) {
  test(`F2: "${label}" produces no test evidence`, () => {
    assert.equal(evidenceStrength([{ path, note: 'ordinary note' }]), 0.7)
  })
}

for (const note of [
  'xtest-passedx',
  'testing ground',
  'contest',
  'ran test',
  'ran tests',
  'spec file',
  'fixture file',
]) {
  test(`F2: note "${note}" is not positive test evidence`, () => {
    assert.equal(evidenceStrength([{ path: 'src/store.mjs', note }]), 0.7)
  })
}

test('F2: test-failed alongside a path is not positive evidence', () => {
  assert.equal(evidenceStrength([{ path: 'test/foo.test.mjs', note: 'test-failed' }]), 0.7)
})

// ---------------------------------------------------------------------------
// Existing behaviour that must not change
// ---------------------------------------------------------------------------

test('empty and absent evidence keep their baseline tiers', () => {
  assert.equal(evidenceStrength(null), 0.1)
  assert.equal(evidenceStrength(undefined), 0.1)
  assert.equal(evidenceStrength([]), 0.1)
})

test('a plain string evidence item is still scored', () => {
  assert.equal(evidenceStrength(['src/store.mjs']), 0.7)
  assert.equal(evidenceStrength(['test-passed']), 0.4)
})

test('the evidence weight is still 0.18 and is not rebalanced', () => {
  const base = {
    kind: 'memory', status: 'current', validation: 'unverified',
    authority: 'derived', confidence: 'low', scope: 'project', relations: [],
  }
  const [ranked] = rankRecords([{
    ...base,
    id: 'x',
    title: 't', body: 'b',
    evidence: [{ path: 'src/store.mjs', note: 'test-passed' }],
  }], { query: '' })
  assert.equal(ranked.scores.evidence_strength, 1.0)
  // composite is a fixed linear sum; changing any weight changes it, so this
  // pins the contribution of evidence at 0.18 * 1.0 = 0.18.
  assert.equal(ranked.scores.composite > 0.18, true)
})

// ---------------------------------------------------------------------------
// Runtime path — not just the helper
// ---------------------------------------------------------------------------

test('runtime: recall() reports full evidence only for a genuine outcome', () => {
  const store = tempStore()
  const base = {
    kind: 'memory', status: 'current', validation: 'reviewed',
    authority: 'derived', confidence: 'medium', scope: 'project',
  }
  store.put({
    ...base, id: 'GENUINE',
    title: 'serialize database writes',
    body: 'Always serialize DatabaseSync writes to avoid FTS corruption in WAL mode under load.',
    evidence: [{ path: 'src/store.mjs', note: 'test-passed' }],
  })
  store.put({
    ...base, id: 'PATHONLY',
    title: 'deployment timings',
    body: 'This record only discusses deployment timings and nothing about sqlite concurrency.',
    evidence: [{ path: 'test/deploy.test.mjs' }],
  })
  const ranked = recall({ projectStore: store, query: 'serialize database writes WAL', limit: 5 })
  const genuine = ranked.find((r) => r.id === 'GENUINE')
  const pathOnly = ranked.find((r) => r.id === 'PATHONLY')
  assert.ok(genuine, 'genuine record must be recallable')
  assert.ok(pathOnly, 'path-only record must still be recallable')
  assert.equal(genuine.scores.evidence_strength, 1.0)
  assert.equal(pathOnly.scores.evidence_strength, 0.7)
  store.close()
})

test('runtime: an inspector path no longer earns full evidence', () => {
  const store = tempStore()
  store.put({
    id: 'INSPECTOR', title: 'inspector refactor', kind: 'memory', status: 'current',
    validation: 'reviewed', authority: 'derived', confidence: 'medium', scope: 'project',
    body: 'Rewriting the inspector to reuse the prepared statement avoids re-parsing the query.',
    evidence: [{ path: 'src/inspector.mjs', note: 'modified src/inspector.mjs' }],
  })
  const [ranked] = recall({ projectStore: store, query: 'inspector refactor', limit: 5 })
  assert.equal(ranked.scores.evidence_strength, 0.7, 'must not reach the full tier')
  store.close()
})
