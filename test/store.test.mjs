import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AUTHORITIES, KINDS, VALIDATIONS } from '../src/types.mjs'
import { MemoryStore, openEphemeralStore, toFtsQuery } from '../src/store.mjs'

test('toFtsQuery keeps only safe tokens', () => {
  assert.equal(toFtsQuery('sqlite writer race AND "drop table"'), '"sqlite" OR "writer" OR "race" OR "and" OR "drop" OR "table"')
  assert.equal(toFtsQuery('???'), '')
})

test('put/get/forget round-trip and content-hash dedup', () => {
  const store = openEphemeralStore()
  const first = store.put({
    title: 'Serialize sqlite writes',
    body: 'The node:sqlite DatabaseSync connection is not safe for concurrent writers.',
    authority: AUTHORITIES.DERIVED,
  })
  assert.equal(first.created, true)
  assert.equal(first.record.authority, AUTHORITIES.DERIVED)
  const again = store.put({
    title: 'Serialize sqlite writes',
    body: 'The node:sqlite DatabaseSync connection is not safe for concurrent writers.',
    authority: AUTHORITIES.DERIVED,
  })
  assert.equal(again.duplicate, true)
  assert.equal(again.record.id, first.record.id)
  const forgotten = store.forget(first.record.id)
  assert.equal(forgotten.forgotten, true)
  assert.equal(store.search('sqlite', { recallOnly: true }).length, 0)
  store.close()
})

test('refuses to create canonical memory without explicit flag', () => {
  const store = openEphemeralStore()
  assert.throws(
    () => store.put({ title: 'truth', body: 'should not auto-canonize', authority: AUTHORITIES.CANONICAL }),
    /refuses to auto-promote/,
  )
  store.close()
})

test('explicit canonical put is allowed and recall-eligible', () => {
  const store = openEphemeralStore()
  const written = store.put({
    title: 'Project uses node:sqlite',
    body: 'No better-sqlite3. Confirmed in package.json engines.',
    authority: AUTHORITIES.CANONICAL,
    validation: VALIDATIONS.VERIFIED,
    kind: KINDS.KNOWLEDGE,
  }, { explicitCanonical: true })
  assert.equal(written.record.authority, AUTHORITIES.CANONICAL)
  const hits = store.search('sqlite', { recallOnly: true })
  assert.equal(hits.length, 1)
  store.close()
})

test('candidates never appear in recallOnly search', () => {
  const store = openEphemeralStore()
  store.put({
    title: 'Maybe the cache is stale',
    body: 'Saw an odd FTS miss once. Not sure why.',
    authority: AUTHORITIES.CANDIDATE,
    kind: KINDS.OBSERVATION,
  })
  store.put({
    title: 'FTS query must quote tokens',
    body: 'Unquoted user text can break MATCH. Always run toFtsQuery.',
    authority: AUTHORITIES.DERIVED,
  })
  const raw = store.search('FTS', { recallOnly: false })
  const gated = store.search('FTS', { recallOnly: true })
  assert.ok(raw.some((r) => r.authority === AUTHORITIES.CANDIDATE))
  assert.ok(gated.every((r) => r.authority !== AUTHORITIES.CANDIDATE))
  assert.equal(gated.length, 1)
  store.close()
})

test('secrets are redacted on write', () => {
  const store = openEphemeralStore()
  const written = store.put({
    title: 'CI token note',
    body: 'Do not commit api_key = "supersecretvalue" into the docs.',
    authority: AUTHORITIES.DERIVED,
  })
  assert.equal(written.redacted, true)
  assert.equal(written.record.body.includes('supersecretvalue'), false)
  assert.ok(written.record.body.includes('[REDACTED_SECRET]'))
  store.close()
})

test('file-backed store survives close/reopen (session A → session B)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'veyra-store-'))
  const file = join(dir, 'memory.db')
  const a = new MemoryStore(file, { scope: 'project', projectId: 'p_demo' })
  const saved = a.put({
    title: 'WAL mode is on',
    body: 'Veyra opens each project DB with PRAGMA journal_mode = WAL.',
    authority: AUTHORITIES.DERIVED,
  })
  a.close()
  const b = new MemoryStore(file, { scope: 'project', projectId: 'p_demo' })
  const found = b.get(saved.record.id)
  assert.equal(found.title, 'WAL mode is on')
  const recalled = b.search('WAL journal', { recallOnly: true })
  assert.ok(recalled.some((r) => r.id === saved.record.id))
  b.close()
  rmSync(dir, { recursive: true, force: true })
})
