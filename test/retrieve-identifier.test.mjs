/**
 * D2 regression coverage: CamelCase-aware semantic projection.
 *
 * `semanticSimilarity` previously handed raw text to `tokenize()`, whose
 * /[a-z0-9_]{2,}/ pattern makes a compound identifier one atomic token. So
 * "apply mirror" shared nothing with "applyMirrorRemoval" and scored 0, leaving
 * the correct record at the same composite as unrelated memory.
 *
 * The fix is a text projection applied to BOTH sides inside semanticSimilarity
 * only. tokenize(), the FTS5 tokenizer, candidate discovery, and every other
 * scorer are untouched, so splitting cannot change WHICH records are found.
 *
 * Two boundaries are measured and pinned, both recorded after verification
 * rather than assumed:
 *
 *   - "memory store" does NOT match "memory_store" (score 0). tokenize() keeps
 *     "_", so the two forms share no token. That is the D3 tokenizer
 *     divergence and is deliberately not fixed here.
 *   - "store" DOES now match "MemoryStore" (score 0.8, up from 0.667), because
 *     the split produces a real "store" token. Partial identifier queries
 *     improve, but the three *Store* records stay close together because
 *     nothing in the current signals separates MemoryStore from FileStore.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { semanticSimilarity, recall } from '../src/retrieve.mjs'
import { tokenize } from '../src/text.mjs'
import { MemoryStore } from '../src/store.mjs'

const rec = (title, body = '', tags = []) => ({ title, body, tags })
const sem = (q, title, body = '') => semanticSimilarity(q, rec(title, body))

const BASE = {
  kind: 'memory', status: 'current', validation: 'unverified', authority: 'derived',
  confidence: 'low', scope: 'project', projectId: 'p', tags: [],
  evidence: [{ path: 'src/x.mjs' }], relations: [], source: [], forgotten: false,
  createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
  lastRecalledAt: null,
}

function tempStore() {
  const dir = mkdtempSync(join(tmpdir(), 'veyra-d2-'))
  return new MemoryStore(join(dir, 'memory.db'), { scope: 'project', projectId: 'p' })
}

// ---------------------------------------------------------------------------
// CamelCase recovery
// ---------------------------------------------------------------------------

for (const [query, identifier] of [
  ['database sync', 'DatabaseSync'],
  ['apply mirror removal', 'applyMirrorRemoval'],
  ['memory store', 'MemoryStore'],
  ['relationship verification', 'RelationshipVerification'],
  ['project memory agent', 'ProjectMemoryAgent'],
  ['evolve against', 'evolveAgainst'],
  ['strengthen memory', 'strengthenMemory'],
  ['fts position', 'ftsPosition'],
]) {
  test(`"${query}" now matches "${identifier}"`, () => {
    const score = sem(query, identifier)
    assert.ok(score > 0.5, `expected meaningful similarity, got ${score}`)
  })
}

// ---------------------------------------------------------------------------
// Exact identifiers must not regress
// ---------------------------------------------------------------------------

for (const identifier of [
  'DatabaseSync', 'MemoryStore', 'applyMirrorRemoval', 'src/store.mjs',
  'database_sync', 'memory-store', '@lovedolove/veyra', 'applyMirrorRemoval()',
  'last_recalled_at', 'DEFAULT_WEIGHTS', 'test/a.test.mjs', 'ftsPosition',
]) {
  test(`exact match "${identifier}" still scores 1.0`, () => {
    assert.equal(sem(identifier, identifier), 1)
  })
}

// ---------------------------------------------------------------------------
// Existing technical forms keep their behaviour
// ---------------------------------------------------------------------------

test('snake_case, kebab-case, paths and scoped packages are unaffected', () => {
  // Verified values. `memory store` vs `memory_store` is 0 and is a PRE-EXISTING
  // gap: tokenize() keeps "_", so "memory_store" is one token and shares nothing
  // with "memory store". That is the D3 tokenizer divergence, explicitly not
  // addressed here — this pins current behaviour rather than asserting a fix
  // that was not made.
  assert.equal(sem('database_sync', 'database_sync', 'is the lock target'), 0.733)
  assert.equal(sem('memory store', 'memory_store', 'opens the project database'), 0)
  assert.ok(sem('store mjs', 'src/store.mjs', 'holds the class') > 0.5)
  assert.ok(sem('veyra lovedolove', '@lovedolove/veyra', 'is the package') > 0.5)
  // last_recalled_at vs "last recalled" is 0 for the same underscore reason.
  assert.equal(sem('last recalled', 'last_recalled_at', 'records the time'), 0)
})

// ---------------------------------------------------------------------------
// Acronyms
// ---------------------------------------------------------------------------

test('acronym prefixes are released as a whole, not letter by letter', () => {
  for (const [query, identifier] of [
    ['http server', 'HTTPServer'],
    ['xml parser', 'XMLParser'],
    ['fts position', 'FTSPosition'],
  ]) {
    const score = sem(query, identifier)
    assert.ok(score > 0.5, `${identifier} should match "${query}", got ${score}`)
  }
})

test('the projection does not emit single-letter fragments', () => {
  // A pathological split would give "HTTPServer" -> "H T T P Server" and
  // therefore a different token set from "http server". Matching instead
  // proves the acronym stayed whole.
  assert.equal(sem('http server', 'HTTPServer'), 1)
  assert.equal(sem('xml parser', 'XMLParser'), 1)
})

// ---------------------------------------------------------------------------
// False-positive boundary — the measured limit, pinned deliberately
// ---------------------------------------------------------------------------

test('the projection creates a real "store" token from MemoryStore', () => {
  // CORRECTED after measurement. An earlier draft of this file claimed "store"
  // was a partial token that still would not match. That was wrong: the fix
  // splits MemoryStore into "Memory Store", so "store" now matches a genuine
  // token and the score rises from 0.667 to 0.8. The behaviour is intended.
  const score = sem('store', 'MemoryStore')
  assert.ok(score > 0.5, `"store" should now match MemoryStore, got ${score}`)
  // It is still not 1.0, because the other half of the identifier does not match.
  assert.ok(score < 1, 'a partial match must not equal a full one')
})

test('the three *Store* records remain close together under a partial query', () => {
  const a = sem('store', 'MemoryStore')
  const b = sem('store', 'FileStore')
  const c = sem('store', 'StoreManager')
  // No invented ranking rule: the fix must not fabricate a separation it
  // cannot justify. These stay within a narrow band.
  assert.ok(Math.abs(a - b) < 0.15, `MemoryStore ${a} vs FileStore ${b} must stay close`)
  assert.ok(Math.abs(a - c) < 0.15, `MemoryStore ${a} vs StoreManager ${c} must stay close`)
})

test('"apply" still resolves to applyMirrorRemoval over the Store records', () => {
  const target = sem('apply', 'applyMirrorRemoval')
  const others = sem('apply', 'MemoryStore')
  assert.ok(target > others, `applyMirrorRemoval ${target} should beat MemoryStore ${others}`)
})

// ---------------------------------------------------------------------------
// Real retrieval path
// ---------------------------------------------------------------------------

test('a decomposed query retrieves the CamelCase record first via recall()', () => {
  const store = tempStore()
  store.put({ ...BASE, id: 'CAMEL', title: 'applyMirrorRemoval', body: 'applyMirrorRemoval strips the mirrored supersedes edge.' })
  store.put({ ...BASE, id: 'STORE', title: 'MemoryStore', body: 'MemoryStore persists memory rows to a project database.' })
  store.put({ ...BASE, id: 'NOISE', title: 'deploy timings', body: 'The deploy pipeline finished in four minutes today.' })

  for (const q of ['apply mirror', 'apply mirror removal', 'memory store']) {
    const r = recall({ projectStore: store, query: q, limit: 5 })
    const expected = q.startsWith('apply') ? 'CAMEL' : 'STORE'
    assert.equal(r[0].id, expected, `query "${q}" should rank ${expected} first`)
    assert.ok(r[0].scores.semantic > 0, `query "${q}" must give the target a real semantic score`)
  }
  store.close()
})

test('the target is no longer merely at the metadata floor', () => {
  const store = tempStore()
  store.put({ ...BASE, id: 'CAMEL', title: 'applyMirrorRemoval', body: 'applyMirrorRemoval strips the mirrored supersedes edge.' })
  store.put({ ...BASE, id: 'NOISE', title: 'deploy timings', body: 'The deploy pipeline finished in four minutes today.' })
  const r = recall({ projectStore: store, query: 'apply mirror', limit: 5 })
  const camel = r.find((x) => x.id === 'CAMEL')
  const noise = r.find((x) => x.id === 'NOISE')
  assert.ok(camel.scores.composite > noise.scores.composite)
  store.close()
})

// ---------------------------------------------------------------------------
// Non-regression: candidate discovery is untouched
// ---------------------------------------------------------------------------

test('splitting does not change which records FTS can find', () => {
  const store = tempStore()
  store.put({ ...BASE, id: 'A', title: 'applyMirrorRemoval', body: 'strips the mirrored edge' })
  const found = store.search('applyMirrorRemoval', { limit: 10, recallOnly: true })
  assert.equal(found.length, 1)
  assert.equal(found[0].ftsPosition, 0, 'FTS position behaviour is unchanged')
  store.close()
})
