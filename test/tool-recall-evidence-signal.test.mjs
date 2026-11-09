/**
 * Tool-level `veyra_recall` signal check must not drop evidence-matched
 * FTS hits (Task 14).
 *
 * `veyra_search_text` indexes evidence note/path/uri/anchor, so FTS can
 * legitimately return a record whose title/body/tags share no tokens with
 * the query. The tool's zero-signal floor previously inspected only
 * title/body/tags overlap and semantic score, returning nothing even when
 * `hybridRetrieve` surfaced the evidence-matched record.
 *
 * Invariants preserved: Candidate≠Truth (derived record unchanged),
 * Similarity≠Authority/Applicability (no ranking change), project
 * isolation, stopword-only queries still return nothing, empty recall
 * does not block.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createToolHarness } from '../src/tools.mjs'
import { closeAllStores, openProjectStore } from '../src/store.mjs'
import { projectIdFor } from '../src/ids.mjs'

function setup() {
  const home = mkdtempSync(join(tmpdir(), 'veyra-toolevidence-'))
  const cwd = join(home, 'ws')
  const projectId = projectIdFor(cwd)
  const projectStore = openProjectStore(home, projectId)
  const h = createToolHarness({ veyraHome: home })
  const exec = { agent: { session: { header: { cwd } } } }
  return {
    home, cwd, projectId, projectStore,
    recall: (args) => h.call('veyra_recall', args, exec),
    cleanup: () => { closeAllStores(); rmSync(home, { recursive: true, force: true }) },
  }
}

test('veyra_recall keeps an evidence-matched FTS hit when title/body/tags lack query tokens', async () => {
  const t = setup()
  try {
    t.projectStore.put({
      id: 'veyra_probe_evidence_match',
      kind: 'memory',
      scope: 'project',
      projectId: t.projectId,
      title: 'Build output packaging decision',
      body: 'Chose deterministic bundle layout for release artifacts.',
      tags: ['build', 'release'],
      evidence: [{ note: 'handoffPipeline timeout under concurrent worker load', path: 'src/handoffPipeline.mjs' }],
      authority: 'derived',
      validation: 'reviewed',
      confidence: 0.8,
    })
    const r = await t.recall({ query: 'handoffPipeline timeout concurrent worker', limit: 5, include_reusable: false })
    assert.equal(r.ok, true)
    assert.equal(r.count, 1)
    assert.equal(r.items[0].id, 'veyra_probe_evidence_match')
  } finally {
    t.cleanup()
  }
})

test('veyra_recall still returns nothing for a stopword-only query with no real signal', async () => {
  const t = setup()
  try {
    t.projectStore.put({
      id: 'veyra_probe_stopword',
      kind: 'memory',
      scope: 'project',
      projectId: t.projectId,
      title: 'Unrelated record',
      body: 'and and and this body contains nothing else',
      tags: [],
      evidence: [],
      authority: 'derived',
      validation: 'reviewed',
      confidence: 0.8,
    })
    const r = await t.recall({ query: 'and and and', limit: 5, include_reusable: false })
    assert.equal(r.ok, true)
    assert.equal(r.count, 0)
  } finally {
    t.cleanup()
  }
})
