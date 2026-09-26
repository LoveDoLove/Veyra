import { test } from 'node:test'
import assert from 'node:assert/strict'
import { AUTHORITIES, KINDS, RELATIONS, VALIDATIONS } from '../src/types.mjs'
import { openEphemeralStore } from '../src/store.mjs'
import { expandEligibleNeighbors, localGraph, overviewGraph, projectNode, GRAPH_LIMITS } from '../src/graph.mjs'
import { hybridRetrieve, summarizeForPrompt } from '../src/retrieve.mjs'
import { observatoryLocalGraph } from '../src/observatory.mjs'
import { handleVeyraCommand } from '../src/commands.mjs'
import { closeAllStores, openProjectStore } from '../src/store.mjs'
import { projectIdFor } from '../src/ids.mjs'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

function seedLinked(store, projectId = store.projectId) {
  const root = store.put({
    title: 'WAL is required',
    body: 'Always enable WAL for DatabaseSync.',
    authority: AUTHORITIES.DERIVED,
    validation: VALIDATIONS.VERIFIED,
    projectId,
  })
  const child = store.put({
    title: 'FTS5 triggers follow WAL',
    body: 'FTS triggers must stay in the same WAL writer.',
    authority: AUTHORITIES.DERIVED,
    validation: VALIDATIONS.VERIFIED,
    projectId,
    relations: [{ type: RELATIONS.UPDATES, targetId: root.record.id }],
  })
  const candidate = store.put({
    title: 'Guess about WAL',
    body: 'Maybe WAL is optional. Unverified observation.',
    authority: AUTHORITIES.CANDIDATE,
    kind: KINDS.OBSERVATION,
    projectId,
    relations: [{ type: RELATIONS.EXTENDS, targetId: root.record.id }],
  })
  const stale = store.put({
    title: 'Old WAL note',
    body: 'Idle unverified note that should not enter trusted context.',
    authority: AUTHORITIES.DERIVED,
    validation: VALIDATIONS.STALE,
    projectId,
    relations: [{ type: RELATIONS.EXTENDS, targetId: root.record.id }],
  })
  const forgotten = store.put({
    title: 'Forgotten WAL aside',
    body: 'Soft-forgotten, inspectable only.',
    authority: AUTHORITIES.DERIVED,
    validation: VALIDATIONS.VERIFIED,
    projectId,
    forgotten: true,
    relations: [{ type: RELATIONS.EXTENDS, targetId: root.record.id }],
  })
  return { root: root.record, child: child.record, candidate: candidate.record, stale: stale.record, forgotten: forgotten.record }
}

test('localGraph projects stored rows and both directions without inventing nodes', () => {
  const store = openEphemeralStore()
  store.projectId = 'p_graph'
  const { root, child, candidate } = seedLinked(store)

  const graph = localGraph({ projectStore: store, id: root.id, hops: 1 })
  assert.equal(graph.center.id, root.id)
  assert.ok(graph.nodes.some((n) => n.id === child.id))
  assert.ok(graph.nodes.some((n) => n.id === candidate.id))
  assert.ok(graph.edges.some((e) => e.fromId === child.id && e.type === RELATIONS.UPDATES && e.targetId === root.id))
  assert.equal(graph.nodes.find((n) => n.id === child.id).trusted, true)
  assert.equal(graph.nodes.find((n) => n.id === candidate.id).trusted, false)
  assert.equal(projectNode(root).trusted, true)

  store.close()
})

test('trustedOnly and hop bound keep candidates, stale, and 2-hop nodes out of agent expansion', () => {
  const store = openEphemeralStore()
  store.projectId = 'p_trust'
  const { root, child, candidate, stale } = seedLinked(store)
  const far = store.put({
    title: 'Two hops away',
    body: 'Should not appear at hop=1.',
    authority: AUTHORITIES.DERIVED,
    validation: VALIDATIONS.VERIFIED,
    projectId: 'p_trust',
    relations: [{ type: RELATIONS.EXTENDS, targetId: child.id }],
  })

  const trusted = localGraph({ projectStore: store, id: root.id, hops: 1, trustedOnly: true })
  assert.ok(trusted.nodes.some((n) => n.id === child.id))
  assert.ok(!trusted.nodes.some((n) => n.id === candidate.id))
  assert.ok(!trusted.nodes.some((n) => n.id === stale.id))
  assert.ok(!trusted.nodes.some((n) => n.id === far.record.id))

  const extras = expandEligibleNeighbors({ projectStore: store, records: [root] })
  assert.ok(extras.some((r) => r.id === child.id))
  assert.ok(!extras.some((r) => r.id === candidate.id))
  assert.ok(!extras.some((r) => r.id === stale.id))
  assert.ok(!extras.some((r) => r.id === far.record.id))
  assert.ok(extras.length <= 4)

  store.close()
})

test('graph projection stays inside the opened project store', () => {
  const projectA = openEphemeralStore()
  projectA.projectId = 'p_aaa'
  const projectB = openEphemeralStore()
  projectB.projectId = 'p_bbb'
  const a = projectA.put({
    title: 'A only',
    body: 'Project A decision.',
    authority: AUTHORITIES.DERIVED,
    projectId: 'p_aaa',
    relations: [{ type: RELATIONS.EXTENDS, targetId: 'vey_missing_other_project' }],
  })
  projectB.put({
    title: 'B only',
    body: 'Must not leak into A graph.',
    authority: AUTHORITIES.DERIVED,
    projectId: 'p_bbb',
  })

  const graph = localGraph({ projectStore: projectA, id: a.record.id })
  assert.ok(graph.nodes.every((n) => n.projectId === 'p_aaa'))
  assert.ok(graph.unresolved.some((e) => e.targetId === 'vey_missing_other_project'))
  assert.ok(!graph.nodes.some((n) => n.title.includes('B only')))

  projectA.close()
  projectB.close()
})

test('overviewGraph projects visible rows, stored edges, and unresolved targets only', () => {
  const dir = mkdtempSync(join(tmpdir(), 'veyra-ov-'))
  const cwdA = join(dir, 'proj-a')
  const cwdB = join(dir, 'proj-b')
  const aId = projectIdFor(cwdA)
  const bId = projectIdFor(cwdB)
  const storeA = openProjectStore(dir, aId)
  const storeB = openProjectStore(dir, bId)
  const { root, child, candidate } = seedLinked(storeA, aId)
  storeB.put({
    title: 'B only',
    body: 'Isolated project B record.',
    authority: AUTHORITIES.DERIVED,
    projectId: bId,
  })
  storeA.put({
    title: 'Points nowhere',
    body: 'Relation to a record that does not exist.',
    authority: AUTHORITIES.DERIVED,
    projectId: aId,
    relations: [{ type: RELATIONS.EXTENDS, targetId: 'vey_does_not_exist' }],
  })

  const graph = overviewGraph({ projectStore: storeA })
  assert.equal(graph.center, null)
  assert.ok(graph.nodes.some((n) => n.id === root.id))
  assert.ok(graph.nodes.some((n) => n.id === child.id))
  assert.ok(graph.nodes.some((n) => n.id === candidate.id && n.trusted === false))
  assert.ok(graph.nodes.every((n) => n.projectId === aId))
  assert.ok(!graph.nodes.some((n) => n.title.includes('B only')))
  assert.ok(graph.edges.some((e) => e.fromId === child.id && e.type === RELATIONS.UPDATES && e.targetId === root.id))
  assert.ok(graph.unresolved.some((e) => e.targetId === 'vey_does_not_exist'))
  assert.ok(!graph.nodes.some((n) => n.id === 'vey_does_not_exist'))

  const ids = graph.nodes.map((n) => n.id)
  assert.deepEqual(ids, [...ids].sort())
  assert.ok(graph.nodes.length <= GRAPH_LIMITS.maxNodes)
  assert.ok(graph.edges.length <= GRAPH_LIMITS.maxEdges)

  closeAllStores()
  rmSync(dir, { recursive: true, force: true })
})

test('overviewGraph stays bounded on a large store and empty on an empty store', () => {
  const store = openEphemeralStore()
  store.projectId = 'p_cap_ov'
  let prev = store.put({
    title: 'Cap root',
    body: 'First record of the cap chain.',
    authority: AUTHORITIES.DERIVED,
    projectId: 'p_cap_ov',
  }).record.id
  for (let i = 0; i < 44; i++) {
    prev = store.put({
      title: `Cap ${i}`,
      body: `Record ${i} of the overview cap test chain.`,
      authority: AUTHORITIES.DERIVED,
      projectId: 'p_cap_ov',
      relations: [{ type: RELATIONS.EXTENDS, targetId: prev }],
    }).record.id
  }
  const capped = overviewGraph({ projectStore: store })
  assert.ok(capped.nodes.length <= GRAPH_LIMITS.maxNodes)
  assert.ok(capped.edges.length <= GRAPH_LIMITS.maxEdges)
  assert.ok(capped.nodes.length > 0)

  const emptyStore = openEphemeralStore()
  emptyStore.projectId = 'p_empty_ov'
  const empty = overviewGraph({ projectStore: emptyStore })
  assert.deepEqual(empty, { center: null, nodes: [], edges: [], unresolved: [] })

  store.close()
  emptyStore.close()
})

test('overviewGraph seeds relation partners so older network records stay visible', async () => {
  const store = openEphemeralStore()
  store.projectId = 'p_seed_ov'
  const opts = (title) => ({ title, body: title + ' body for the overview seed test.', authority: AUTHORITIES.DERIVED, projectId: 'p_seed_ov' })
  const oldest = store.put(opts('Oldest target')).record
  store.put(opts('Second oldest'))
  const holder = store.put({
    ...opts('Old relation holder'),
    relations: [{ type: RELATIONS.EXTENDS, targetId: oldest.id }],
  }).record
  // Strictly newer timestamps so the holder + target really fall outside the newest-40 slice.
  await new Promise((resolve) => setTimeout(resolve, 5))
  for (let i = 0; i < 42; i++) store.put(opts('Filler ' + i))

  // holder + target are the oldest records, outside the newest-40 slice…
  const list = store.list({ limit: 200 })
  const rank = new Map(list.map((r, i) => [r.id, i]))
  assert.ok(rank.get(oldest.id) >= GRAPH_LIMITS.maxNodes)
  assert.ok(rank.get(holder.id) >= GRAPH_LIMITS.maxNodes)

  // …but the overview still seeds them and keeps the stored edge.
  const graph = overviewGraph({ projectStore: store })
  assert.ok(graph.nodes.length <= GRAPH_LIMITS.maxNodes)
  assert.ok(graph.nodes.some((n) => n.id === oldest.id))
  assert.ok(graph.nodes.some((n) => n.id === holder.id))
  assert.ok(graph.edges.some((e) => e.fromId === holder.id && e.type === RELATIONS.EXTENDS && e.targetId === oldest.id))

  store.close()
})

test('hybridRetrieve 1-hop includes eligible neighbors and explains via', () => {
  const store = openEphemeralStore()
  store.projectId = 'p_hop'
  const { root, child, candidate } = seedLinked(store)

  const hits = hybridRetrieve({
    projectStore: store,
    query: 'FTS5 triggers WAL writer',
    limit: 1,
  })
  assert.ok(hits.some((h) => h.id === child.id))
  assert.ok(hits.some((h) => h.id === root.id))
  assert.ok(!hits.some((h) => h.id === candidate.id))
  const viaRoot = hits.find((h) => h.id === root.id)
  assert.equal(viaRoot?.via?.type, RELATIONS.UPDATES)
  const prompt = summarizeForPrompt(hits)
  assert.ok(prompt.includes(`via ${RELATIONS.UPDATES}`))

  store.close()
})

test('observatory local graph is read-only text and slash graph <id> uses it', () => {
  const store = openEphemeralStore()
  store.projectId = 'p_obs_g'
  const { root, child } = seedLinked(store)

  const view = observatoryLocalGraph({ projectStore: store, id: root.id })
  assert.equal(view.ok, true)
  assert.ok(view.formatted.includes('VEYRA OBSERVATORY — LOCAL GRAPH'))
  assert.ok(view.formatted.includes(child.id))
  assert.ok(view.formatted.includes('Graph is a projection'))
  assert.equal(view.data.nodes.length >= 2, true)

  const dir = mkdtempSync(join(tmpdir(), 'veyra-graph-cmd-'))
  const cwd = join(dir, 'workspace')
  const runtime = { veyraHome: dir, fallbackCwd: cwd, recallLimit: 5, includeReusable: true }
  const invocation = { agent: { session: { header: { cwd } } } }
  const missing = handleVeyraCommand(runtime, { ...invocation, rawInput: 'observatory local' })
  assert.equal(missing.kind, 'error')
  closeAllStores()
  rmSync(dir, { recursive: true, force: true })
  store.close()
})

test('slash search → record → local graph stays inside handleVeyraCommand', () => {
  const dir = mkdtempSync(join(tmpdir(), 'veyra-graph-slash-'))
  const cwd = join(dir, 'workspace')
  const runtime = { veyraHome: dir, fallbackCwd: cwd, recallLimit: 5, includeReusable: true }
  const invocation = { agent: { session: { header: { cwd } } } }
  const projectId = projectIdFor(cwd)
  const store = openProjectStore(dir, projectId)
  const { root, child } = seedLinked(store, projectId)

  const search = handleVeyraCommand(runtime, { ...invocation, rawInput: 'observatory search FTS5 triggers WAL' })
  assert.equal(search.kind, 'success')
  assert.ok(search.text.includes('HYBRID SEARCH'))
  assert.ok(search.text.includes(`/veyra observatory local ${child.id}`) || search.text.includes(`/veyra observatory local ${root.id}`))

  const record = handleVeyraCommand(runtime, { ...invocation, rawInput: `observatory record ${root.id}` })
  assert.equal(record.kind, 'success')
  assert.ok(record.text.includes(`/veyra observatory local ${root.id}`))

  const graph = handleVeyraCommand(runtime, { ...invocation, rawInput: `observatory graph ${root.id}` })
  assert.equal(graph.kind, 'success')
  assert.ok(graph.text.includes('VEYRA OBSERVATORY — LOCAL GRAPH'))
  assert.ok(graph.text.includes(child.id))
  assert.equal(graph.text.includes('Veyra — Engineering Brain for DSH'), false)

  closeAllStores()
  rmSync(dir, { recursive: true, force: true })
})
