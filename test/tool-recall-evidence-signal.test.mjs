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
import { createToolHarness } from '../src/tools.mjs'
import { closeAllStores } from '../src/store.mjs'
import { agentFor, roomIdFor, roomStore, testHome, testRuntime } from './helpers/room.mjs'

function setup(t) {
  // The room store seeded here is the one the runtime resolves for this
  // workspace: `veyra_recall` fails closed without a Memory Server, and a seed
  // in any other store would be invisible to the tool.
  const home = testHome(t, 'veyra-toolevidence-')
  const cwd = testHome(t, 'veyra-toolevidence-ws-')
  const projectId = roomIdFor(cwd)
  const projectStore = roomStore(home, cwd)
  const h = createToolHarness(testRuntime(home, cwd))
  const exec = { agent: agentFor(cwd) }
  return {
    home, cwd, projectId, projectStore,
    recall: (args) => h.call('veyra_recall', args, exec),
    cleanup: () => { closeAllStores() },
  }
}

test('veyra_recall keeps an evidence-matched FTS hit when title/body/tags lack query tokens', async (tc) => {
  const t = setup(tc)
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

test('veyra_recall still returns nothing for a stopword-only query with no real signal', async (tc) => {
  const t = setup(tc)
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
