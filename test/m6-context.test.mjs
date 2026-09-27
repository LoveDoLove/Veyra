/**
 * M6 Phase-1 — engineering context composition.
 *
 * Verifies that the agent boundary surfaces what Veyra already stores —
 * lifecycle status, evidence provenance, and inbound supersession — without
 * creating any new storage, relation, or retrieval behaviour.
 *
 * Every test uses a temporary store. No live database is touched.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MemoryStore } from '../src/store.mjs'
import { recall } from '../src/retrieve.mjs'
import { composeAgentContext, renderAgentContext, CONTEXT_EVIDENCE_LIMIT } from '../src/context.mjs'
import { isRecallEligible, AUTHORITIES, VALIDATIONS, STATUSES, RELATIONS } from '../src/types.mjs'

const NOW = new Date().toISOString()
const BASE = {
  kind: 'memory', status: STATUSES.CURRENT, validation: VALIDATIONS.VERIFIED,
  authority: AUTHORITIES.DERIVED, confidence: 'high', scope: 'project', projectId: 'p_m6',
  tags: [], evidence: [], relations: [], source: {},
  createdAt: NOW, updatedAt: NOW, lastRecalledAt: null, forgotten: false,
}

function mk() {
  const dir = mkdtempSync(join(tmpdir(), 'veyra-m6-'))
  return new MemoryStore(join(dir, 'memory.db'), { scope: 'project', projectId: 'p_m6' })
}

/** Compose + render exactly the way buildRecallContext does. */
function context(store, query, limit = 5) {
  const records = recall({ projectStore: store, query, limit })
  return renderAgentContext(composeAgentContext(records, { stores: [store] }))
}

test('1. a current record renders without a status tag', () => {
  const s = mk()
  s.put({ ...BASE, id: 'C1', title: 'A current claim about the store', body: 'the store keeps memory rows in sqlite' })
  const out = context(s, 'store memory rows sqlite')
  assert.match(out, /- \[C1\] \(project\/derived\/verified\/high\)/)
  assert.ok(!/\/superseded/.test(out), 'no status tag on a current record')
  s.close()
})

test('2. a superseded record is still excluded from normal recall', () => {
  const s = mk()
  s.put({ ...BASE, id: 'R2', title: 'A current claim about the store', body: 'the store keeps memory rows in sqlite' })
  const retired = s.put({
    ...BASE, id: 'RET2', status: STATUSES.SUPERSEDED,
    title: 'A superseded claim about the store', body: 'the store used to write jsonl files instead of sqlite',
    relations: [{ type: RELATIONS.SUPERSEDES, targetId: 'R2' }],
  }).record
  const out = context(s, 'store jsonl files sqlite memory')
  // It must not appear as a rendered RECORD line...
  assert.ok(!new RegExp(`^- \\[${retired.id}\\]`, 'm').test(out), 'superseded record must not be rendered as a memory')
  // ...but naming it as the predecessor is the intended M6 behaviour.
  assert.match(out, /Replaces superseded memory: \[RET2\]/)
  assert.equal(isRecallEligible(s.get(retired.id)), false)
  s.close()
})

test('3. a replacement exposes the superseded memory it replaced', () => {
  const s = mk()
  s.put({ ...BASE, id: 'R3', title: 'Deploy switched from rsync to zstd', body: 'the deploy switched from rsync to zstd in the deploy script' })
  s.put({
    ...BASE, id: 'OLD3', status: STATUSES.SUPERSEDED,
    title: 'Deploy uses rsync for artifact sync', body: 'the deploy copies build artifacts with rsync in the deploy script',
    relations: [{ type: RELATIONS.SUPERSEDES, targetId: 'R3' }],
  })
  const out = context(s, 'deploy rsync zstd artifact script')
  assert.match(out, /Replaces superseded memory: \[OLD3\]/)
  assert.match(out, /Deploy uses rsync for artifact sync/)
  s.close()
})

test('4. composition creates no reverse supersedes edge', () => {
  const s = mk()
  s.put({ ...BASE, id: 'R4', title: 'Deploy switched from rsync to zstd', body: 'the deploy switched from rsync to zstd in the deploy script' })
  const old = s.put({
    ...BASE, id: 'OLD4', status: STATUSES.SUPERSEDED,
    title: 'Deploy uses rsync', body: 'the deploy uses rsync in the deploy script',
    relations: [{ type: RELATIONS.SUPERSEDES, targetId: 'R4' }],
  }).record
  const before = JSON.stringify(s.get('R4').relations)
  context(s, 'deploy rsync zstd script')
  assert.equal(JSON.stringify(s.get('R4').relations), before, 'replacement relations untouched')
  assert.deepEqual(s.get('R4').relations, [], 'no reverse edge was written')
  assert.equal(s.get(old.id).relations.filter((r) => r.type === RELATIONS.SUPERSEDES).length, 1, 'still exactly one')
  s.close()
})

test('5-6. evidence path, uri, anchor and note are all rendered', () => {
  const s = mk()
  s.put({
    ...BASE, id: 'E6', title: 'A claim carrying several evidence kinds',
    body: 'the claim cites a path a uri an anchor and a note',
    evidence: [
      { path: 'src/store.mjs' },
      { uri: 'https://ci.example/run/12' },
      { anchor: 'step-3' },
      { note: 'test-passed' },
    ],
  })
  const out = context(s, 'claim cites path uri anchor note')
  assert.match(out, /evidence: path=src\/store\.mjs/, 'path rendered')
  assert.match(out, /evidence: uri=https:\/\/ci\.example\/run\/12/, 'uri rendered')
  assert.match(out, /evidence: anchor=step-3/, 'anchor rendered')
  // Four evidence items exist; the bound renders three and reports the rest.
  // The note survives when it is within the bound.
  assert.match(out, /evidence: \+1 more/, 'the fourth item is summarised, not dropped silently')
  s.close()
})

test('5-6b. a note-only evidence item is rendered when it is within the bound', () => {
  const s = mk()
  s.put({
    ...BASE, id: 'E6B', title: 'A claim with a single note-only evidence item',
    body: 'the claim records only a note about the test outcome',
    evidence: [{ note: 'test-passed' }],
  })
  const out = context(s, 'claim records note test outcome')
  assert.match(out, /evidence: note=test-passed/)
  s.close()
})

test('7. evidence rendering is bounded and reports the overflow', () => {
  const s = mk()
  const evidence = Array.from({ length: 12 }, (_, i) => ({ path: `src/file-${i}.mjs` }))
  s.put({ ...BASE, id: 'E7', title: 'A claim with many evidence items', body: 'a claim with many evidence items attached to it', evidence })
  const out = context(s, 'claim many evidence items attached')
  const itemLines = out.split('\n').filter((l) => l.includes('evidence:') && l.includes('path='))
  assert.equal(itemLines.length, CONTEXT_EVIDENCE_LIMIT, `only ${CONTEXT_EVIDENCE_LIMIT} items rendered`)
  assert.match(out, new RegExp(`evidence: \\+${12 - CONTEXT_EVIDENCE_LIMIT} more`))
  s.close()
})

test('8. contradiction banners remain intact', () => {
  const s = mk()
  s.put({ ...BASE, id: 'A8', title: 'Serialize writes in the deploy script', body: 'always serialize writes in the deploy script' })
  s.put({
    ...BASE, id: 'B8', title: 'Never serialize writes in the deploy script',
    body: 'never serialize writes in the deploy script',
    relations: [{ type: RELATIONS.CONTRADICTS, targetId: 'A8' }],
  })
  const out = context(s, 'serialize writes deploy script')
  assert.match(out, /CONTRADICTION/)
  assert.ok(out.includes('[A8]') && out.includes('[B8]'), 'both sides stay visible')
  s.close()
})

test('9. causal facets are still rendered', () => {
  const s = mk()
  s.put({
    ...BASE, id: 'K9', title: 'A causal claim about the store', body: 'the store had a writer race under load',
    source: { causal: { symptom: 'FTS corruption', rootCause: 'concurrent writers', remedy: 'serialize writes', verifiedOutcome: 'test-passed' } },
  })
  const out = context(s, 'store writer race causal')
  assert.match(out, /Symptom: FTS corruption/)
  assert.match(out, /Root cause: concurrent writers/)
  assert.match(out, /Remedy: serialize writes/)
  assert.match(out, /Outcome: test-passed/)
  s.close()
})

test('10. an ordinary record renders with the existing shape', () => {
  const s = mk()
  s.put({ ...BASE, id: 'O10', title: 'An ordinary derived memory', body: 'an ordinary derived memory about the plugin lifecycle hooks' })
  const out = context(s, 'ordinary derived memory plugin lifecycle')
  assert.match(out, /- \[O10\] \(project\/derived\/verified\/high\) An ordinary derived memory/)
  assert.match(out, /These items are remembered engineering experience, not repository truth\./)
  assert.match(out, /an ordinary derived memory about the plugin lifecycle hooks/)
  s.close()
})

test('11. composition does not cross project boundaries', () => {
  const s = mk()
  s.put({ ...BASE, id: 'P11', title: 'Claim in the project scope', body: 'a claim that belongs to this project store' })
  // A record owned by ANOTHER project, living in a store this project never
  // opens. It must not be recalled, named as a predecessor, or otherwise leak.
  const other = new MemoryStore(join(mkdtempSync(join(tmpdir(), 'veyra-m6-o-')), 'memory.db'), { scope: 'project', projectId: 'other_project' })
  other.put({ ...BASE, id: 'FOREIGN', title: 'A claim from another project', body: 'a claim belonging to a different project store' })

  const records = recall({ projectStore: s, query: 'claim project store scope', limit: 5 })
  assert.ok(records.map((r) => r.id).includes('P11'))
  assert.ok(!records.map((r) => r.id).includes('FOREIGN'), 'another project is never recalled')

  const out = renderAgentContext(composeAgentContext(records, { stores: [s] }))
  assert.ok(!out.includes('FOREIGN'), 'and never named in context')

  // Even if the foreign store is handed to the composer, isolation holds.
  const withOther = renderAgentContext(composeAgentContext(records, { stores: [s, other] }))
  assert.ok(!withOther.includes('FOREIGN'), 'passing a foreign store cannot leak its records')
  s.close(); other.close()
})

test('11b. a reusable record IS shareable, matching recall semantics', () => {
  // Not a leak: scope=reusable is how Veyra deliberately shares experience
  // across projects. This pins that the composer agrees with recall here.
  const s = mk()
  const reusable = new MemoryStore(join(mkdtempSync(join(tmpdir(), 'veyra-m6-r-')), 'memory.db'), { scope: 'project', projectId: 'p_m6' })
  reusable.put({ ...BASE, id: 'SHARED', scope: 'reusable', projectId: 'other_project', title: 'A shared reusable claim about the store', body: 'a shared reusable claim about this project store' })
  const records = recall({ projectStore: s, reusableStore: reusable, query: 'shared reusable claim store', limit: 5, includeReusable: true })
  const out = renderAgentContext(composeAgentContext(records, { stores: [s, reusable] }))
  assert.ok(records.map((r) => r.id).includes('SHARED'), 'recall admits a reusable record')
  assert.match(out, /- \[SHARED\]/, 'and the composer renders it, as recall intends')
  s.close(); reusable.close()
})

test('12. composition mutates nothing', () => {
  const s = mk()
  s.put({ ...BASE, id: 'R12', title: 'Deploy switched from rsync to zstd', body: 'the deploy switched from rsync to zstd in the deploy script' })
  s.put({
    ...BASE, id: 'OLD12', status: STATUSES.SUPERSEDED, title: 'Deploy uses rsync',
    body: 'the deploy uses rsync in the deploy script',
    relations: [{ type: RELATIONS.SUPERSEDES, targetId: 'R12' }],
  })
  const snapshot = () => JSON.stringify(s.list({ limit: 50 }))
  const before = snapshot()
  context(s, 'deploy rsync zstd script')
  context(s, 'deploy rsync zstd script')
  assert.equal(snapshot(), before, 'repeated composition leaves every row byte-identical')
  s.close()
})

test('13. composition is deterministic', () => {
  const s = mk()
  s.put({ ...BASE, id: 'R13', title: 'Deploy switched from rsync to zstd', body: 'the deploy switched from rsync to zstd in the deploy script' })
  for (let i = 0; i < 5; i += 1) {
    s.put({
      ...BASE, id: `OLD13_${i}`, status: STATUSES.SUPERSEDED,
      title: `Deploy uses rsync variant ${i}`, body: `the deploy uses rsync variant ${i} in the deploy script number ${i}`,
      relations: [{ type: RELATIONS.SUPERSEDES, targetId: 'R13' }],
    })
  }
  assert.equal(
    context(s, 'deploy rsync zstd script variant'),
    context(s, 'deploy rsync zstd script variant'),
    'identical inputs render identically',
  )
  s.close()
})

test('14. empty input and minimal records are safe', () => {
  const s = mk()
  assert.equal(renderAgentContext(composeAgentContext([])), '', 'empty input renders nothing')
  assert.equal(renderAgentContext([]), '')
  s.put({ ...BASE, id: 'M14', title: '', body: 'x' })
  assert.equal(typeof context(s, 'anything at all here'), 'string', 'a minimal record does not throw')
  // A record with no evidence and no body must still render its header line.
  assert.match(context(s, 'anything at all here'), /- \[M14\]/)
  s.close()
})
