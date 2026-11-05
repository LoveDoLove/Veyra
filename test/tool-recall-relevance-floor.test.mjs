/**
 * Tool-level relevance floor for `veyra_recall` (Change B).
 *
 * The library keeps zero-signal candidates recallable on purpose: an
 * empty-signal query falls back to the recency pool, ordered so weak
 * candidates sit at the tail (src/retrieve.mjs:1228-1232). At the tool
 * surface that fallback reads as an answer to a question it did not answer.
 *
 * The tool therefore returns nothing when a NON-EMPTY query has no genuine
 * signal anywhere in the result set: no negative-coverage marker, no real
 * token overlap (stopwords stripped), and no semantic score at or above
 * RELEVANCE_SEM_FLOOR. FTS relevance is not used as the signal test because
 * `toFtsQuery` OR-joins stopwords ("and"), which match almost every body and
 * report relevance 1.
 *
 * The rule is all-or-nothing: when any result carries signal, every
 * candidate stays visible, so contradiction pairs, negative-coverage tails
 * and partial matches are never split apart.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createToolHarness } from '../src/tools.mjs'
import { closeAllStores, openProjectStore } from '../src/store.mjs'

function setup() {
  const home = mkdtempSync(join(tmpdir(), 'veyra-toolfloor-'))
  const cwd = mkdtempSync(join(tmpdir(), 'veyra-toolfloor-ws-'))
  const h = createToolHarness({ veyraHome: home, fallbackCwd: cwd })
  const E = { agent: { session: { id: 'toolfloor-' + Math.random().toString(36).slice(2), header: { cwd } } } }
  return {
    home,
    cwd,
    call: (name, args) => h.call(name, args, E),
    remember: (args) => h.call('veyra_remember', args, E),
    recall: (args) => h.call('veyra_recall', args, E),
    cleanup: () => {
      closeAllStores()
      rmSync(home, { recursive: true, force: true })
      rmSync(cwd, { recursive: true, force: true })
    },
  }
}

test('a zero-overlap query returns nothing even when a body contains "and"', async () => {
  const t = setup()
  try {
    const a = (await t.remember({
      kind: 'memory',
      title: 'Warehouse idempotency guard for deduct()',
      body: 'Guard deduct() with a seen-set keyed on eventId and keep the stock map stable across restarts.',
      confidence: 'high',
      tags: ['warehouse', 'idempotency'],
    })).record
    const r = await t.recall({ query: 'kubernetes ingress routing and TLS termination' })
    assert.equal(r.ok, true)
    assert.equal(r.count, 0)
    assert.deepEqual(r.items, [])
    assert.ok(a.id)
  } finally {
    t.cleanup()
  }
})

test('a partial match keeps every candidate, with the matching record first', async () => {
  const t = setup()
  try {
    const a = (await t.remember({
      kind: 'memory',
      title: 'Warehouse idempotency guard for deduct()',
      body: 'Guard deduct() with a seen-set keyed on eventId so a redelivered event is ignored.',
      confidence: 'high',
    })).record
    const b = (await t.remember({
      kind: 'knowledge',
      title: 'Kubernetes ingress routing uses TLS termination at the edge',
      body: 'Ingress terminates TLS and routes by host header.',
      confidence: 'medium',
    })).record
    const r = await t.recall({ query: 'warehouse idempotency guard' })
    assert.equal(r.count, 2)
    const ids = r.items.map((i) => i.id)
    assert.equal(ids[0], a.id)
    assert.ok(ids.includes(b.id))
  } finally {
    t.cleanup()
  }
})

test('an empty query keeps the recency pool', async () => {
  const t = setup()
  try {
    const a = (await t.remember({ kind: 'memory', title: 'First note', body: 'Alpha body text.' })).record
    const b = (await t.remember({ kind: 'memory', title: 'Second note', body: 'Beta body text.' })).record
    const r = await t.recall({ query: '' })
    assert.equal(r.count, 2)
    assert.deepEqual(new Set(r.items.map((i) => i.id)), new Set([a.id, b.id]))
  } finally {
    t.cleanup()
  }
})

test('a contradiction pair stays visible when the query matches both sides', async () => {
  const t = setup()
  try {
    const a = (await t.remember({
      kind: 'memory',
      title: 'Root cause of stock drift: event redelivery without idempotency',
      body: 'Redelivered eventIds deduct twice; a seen-set fixes it.',
      confidence: 'high',
    })).record
    const b = (await t.remember({
      kind: 'memory',
      title: 'Root cause of stock drift: a stale inventory cache',
      body: 'The cache holds stale quantities; invalidate it on write.',
      confidence: 'medium',
    })).record
    const r = await t.recall({ query: 'root cause of stock drift' })
    const ids = r.items.map((i) => i.id)
    assert.ok(ids.includes(a.id), 'first account must stay visible')
    assert.ok(ids.includes(b.id), 'opposing account must stay visible')
  } finally {
    t.cleanup()
  }
})

test('negative coverage survives the tool floor', async () => {
  const t = setup()
  try {
    const neg = (await t.remember({
      kind: 'negative',
      title: 'An in-process mutex around deduct() does not fix the drift',
      body: 'Tried a mutex; the duplicate deduction still happened.',
      confidence: 'high',
    })).record
    const r = await t.recall({ query: 'mutex deduct drift' })
    const hit = r.items.find((i) => i.id === neg.id)
    assert.ok(hit, 'negative record must remain visible as coverage')
    assert.equal(hit.negativeCoverage, true)
  } finally {
    t.cleanup()
  }
})

test('records hidden by the floor are not touched', async () => {
  const t = setup()
  try {
    const a = (await t.remember({
      kind: 'memory',
      title: 'Warehouse idempotency guard for deduct()',
      body: 'Guard deduct() with a seen-set keyed on eventId.',
      confidence: 'high',
    })).record
    const b = (await t.remember({
      kind: 'knowledge',
      title: 'Kubernetes ingress routing uses TLS termination',
      body: 'Ingress terminates TLS at the edge.',
    })).record
    const store = openProjectStore(t.home, a.projectId)

    const empty = await t.recall({ query: 'quantum entanglement decoherence' })
    assert.equal(empty.count, 0)
    assert.ok(!store.get(a.id).lastRecalledAt, 'filtered records must not be touched')
    assert.ok(!store.get(b.id).lastRecalledAt)

    const hit = await t.recall({ query: 'warehouse idempotency guard' })
    assert.equal(hit.count, 2)
    assert.ok(store.get(a.id).lastRecalledAt, 'visible records are touched')
    assert.ok(store.get(b.id).lastRecalledAt, 'kept candidates are visible and touched')
  } finally {
    t.cleanup()
  }
})
