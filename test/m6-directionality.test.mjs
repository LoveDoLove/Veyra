/**
 * M6 directionality guard.
 *
 * This file exists to pin ONE property before any context code is written:
 * the M1 contract `retired --supersedes--> replacement` must survive context
 * composition, and the agent must learn "replacement replaces retired" WITHOUT
 * a reverse edge ever being created.
 *
 * It is intentionally written first, against the shipped baseline, so that any
 * future attempt to make supersession visible by writing
 * `replacement --supersedes--> retired` fails here.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MemoryStore } from '../src/store.mjs'
import { isRecallEligible, AUTHORITIES, VALIDATIONS, STATUSES } from '../src/types.mjs'

const NOW = new Date().toISOString()

function store() {
  const dir = mkdtempSync(join(tmpdir(), 'veyra-m6-dir-'))
  return new MemoryStore(join(dir, 'memory.db'), { scope: 'project', projectId: 'p_m6' })
}

const BASE = {
  kind: 'memory', status: STATUSES.CURRENT, validation: VALIDATIONS.VERIFIED,
  authority: AUTHORITIES.DERIVED, confidence: 'high', scope: 'project',
  tags: [], evidence: [], relations: [], source: {},
  createdAt: NOW, updatedAt: NOW, lastRecalledAt: null, forgotten: false,
}

test('M1 contract: only the retired record carries a supersedes edge', () => {
  const s = store()
  const replacement = s.put({ ...BASE, id: 'REPL', title: 'Deploy switched from rsync to zstd' }).record
  const retired = s.put({
    ...BASE, id: 'RET', status: STATUSES.SUPERSEDED, title: 'Deploy uses rsync',
    relations: [{ type: 'supersedes', targetId: replacement.id }],
  }).record

  const relsRetired = s.get(retired.id).relations
  const relsReplacement = s.get(replacement.id).relations

  assert.equal(relsRetired.filter((r) => r.type === 'supersedes').length, 1, 'retired holds exactly one supersedes edge')
  assert.equal(relsRetired.find((r) => r.type === 'supersedes').targetId, replacement.id)
  assert.deepEqual(relsReplacement, [], 'the replacement holds NO relation at all — no reverse edge')
  s.close()
})

test('the retired record is not recall-eligible; the replacement is', () => {
  const s = store()
  const replacement = s.put({ ...BASE, id: 'REPL', title: 'Deploy switched from rsync to zstd' }).record
  const retired = s.put({
    ...BASE, id: 'RET', status: STATUSES.SUPERSEDED, title: 'Deploy uses rsync',
    relations: [{ type: 'supersedes', targetId: replacement.id }],
  }).record
  assert.equal(isRecallEligible(s.get(retired.id)), false, 'superseded stays excluded from recall')
  assert.equal(isRecallEligible(s.get(replacement.id)), true)
  s.close()
})

test('the predecessor can be found from the replacement by scanning inbound edges', () => {
  // This is the mechanism the context composer will use. It is read-only and
  // must work even though the predecessor is not recall-eligible.
  const s = store()
  const replacement = s.put({ ...BASE, id: 'REPL', title: 'Deploy switched from rsync to zstd' }).record
  const retired = s.put({
    ...BASE, id: 'RET', status: STATUSES.SUPERSEDED, title: 'Deploy uses rsync',
    relations: [{ type: 'supersedes', targetId: replacement.id }],
  }).record

  // Scan the project for records pointing AT the replacement.
  const predecessors = s.list({ limit: 200 })
    .filter((r) => (r.relations || []).some((x) => x.type === 'supersedes' && x.targetId === replacement.id))
    .map((r) => r.id)

  assert.deepEqual(predecessors, [retired.id], 'the retired record is discoverable by an inbound scan')
  assert.equal(isRecallEligible(s.get(predecessors[0])), false, 'even though it is not recall-eligible')

  // And the scan must not have created anything.
  assert.deepEqual(s.get(replacement.id).relations, [], 'still no reverse edge after the scan')
  s.close()
})
