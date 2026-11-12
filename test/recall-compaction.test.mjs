import test from 'node:test'
import assert from 'node:assert/strict'
import { buildRecallContext, COMPACT_AFTER_REPEATS, RENDER_MEMORY_CAP } from '../src/context.mjs'
import { testHome, roomStore } from './helpers/room.mjs'

function seed(store, n = 5) {
  for (let i = 0; i < n; i++) {
    store.put({
      title: `Lesson ${i}: writer lock ordering`,
      body: `Root cause: the writer lock ordering is inverted. ${'Detail sentence. '.repeat(20)}`,
      kind: 'memory', authority: 'derived', validation: 'unverified',
      confidence: 'medium', status: 'current', scope: 'project',
      tags: [], relations: [], evidence: [{ path: `src/f${i}.mjs` }], source: {},
    })
  }
}

const idsOf = (text) => text.match(/\[vey_[a-z0-9_]+\]/g) || []

function fixture(t, name = 'compact-a') {
  const home = testHome(t)
  const workspace = `/repo/${name}`
  const store = roomStore(home, workspace)
  seed(store)
  return {
    store, workspace,
    render: () => buildRecallContext({
      projectStore: store, workspace, query: '', changedFiles: ['src/a.mjs'], limit: 5,
    }),
  }
}

test('a repeated set renders compact and keeps every id', (t) => {
  const f = fixture(t)
  const first = f.render()
  f.render()
  const third = f.render()
  assert.ok(third.length < first.length * 0.75, `expected compaction, got ${third.length} vs ${first.length}`)
  assert.ok(!third.includes('Detail sentence.'), 'compaction must drop the body')
  for (const id of idsOf(first)) assert.ok(third.includes(id), `compacted output dropped ${id}`)
})

test('the first and second render are still full', (t) => {
  const f = fixture(t, 'compact-b')
  const first = f.render()
  const second = f.render()
  assert.equal(COMPACT_AFTER_REPEATS, 2)
  assert.ok(RENDER_MEMORY_CAP > 0)
  assert.ok(second.length > first.length * 0.9)
})

test('a changed set renders full again', (t) => {
  const f = fixture(t, 'compact-c')
  f.render(); f.render(); f.render()
  f.store.put({
    title: 'Lesson new: unrelated indexing bug',
    body: 'Root cause: the index was not rebuilt. '.repeat(20),
    kind: 'memory', authority: 'derived', validation: 'unverified',
    confidence: 'medium', status: 'current', scope: 'project',
    tags: [], relations: [], evidence: [{ path: 'src/new.mjs' }], source: {},
  })
  const changed = f.render()
  assert.ok(changed.length > 600, 'compact form leaked into a changed set')
})

test('a different workspace is not compacted', (t) => {
  const f = fixture(t, 'compact-d')
  f.render(); f.render(); f.render()
  const other = fixture(t, 'compact-e')
  assert.ok(other.render().length > 600)
})

test('render memory is bounded', (t) => {
  assert.equal(RENDER_MEMORY_CAP, 32)
})

// Regression guard for the banner-before-header ordering in renderAgentContext.
// A contradicted record renders `> ⚠️ …` lines BEFORE `- [id] (…) title`, so any
// compact transform that keeps `lines[0]` keeps the warning and drops the id.
test('a contradicted record keeps its id in the compact form', (t) => {
  const home = testHome(t)
  const workspace = '/repo/compact-f'
  const store = roomStore(home, workspace)
  const now = new Date().toISOString()
  const base = {
    kind: 'memory', authority: 'derived', validation: 'unverified',
    confidence: 'medium', status: 'current', scope: 'project',
    tags: [], evidence: [{ path: 'src/lock.mjs' }], source: {},
    createdAt: now, updatedAt: now, lastRecalledAt: null, forgotten: false,
  }
  store.put({
    ...base, id: 'vey_aaa', title: 'Writer lock ordering inverted',
    body: 'Root cause: the writer lock ordering is inverted.',
    relations: [{ type: 'contradicts', targetId: 'vey_bbb' }],
  })
  store.put({
    ...base, id: 'vey_bbb', title: 'Writer lock ordering is fine',
    body: 'Root cause: the writer lock ordering is correct.',
    relations: [{ type: 'contradicts', targetId: 'vey_aaa' }],
  })
  const render = () => buildRecallContext({
    projectStore: store, workspace, query: '', changedFiles: ['src/a.mjs'], limit: 6,
  })
  const first = render()
  render()
  const third = render()
  assert.ok(first.includes('> ⚠️'), 'fixture must render a contradiction banner')
  for (const id of idsOf(first)) {
    assert.ok(third.includes(`- [${id.slice(1, -1)}]`), `compacted output dropped the header for ${id}`)
  }
})
