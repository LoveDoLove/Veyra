/**
 * Write-gate observability (GOAL.md §7 "engineering intelligence", §4 no
 * silent behaviour).
 *
 * Veyra already computes a four-state verdict (ACCEPT / MERGE / DROP / DEFER)
 * plus a reason on EVERY automatic learning decision, and \`src/learn.mjs\`
 * documents that writeGate returns it "so Veyra can explain every learning
 * decision". Before this test existed the automatic path threw it away:
 * \`maybeLearn\` returns \`record ?? null\`, ACCEPT persists
 * \`source.writeGate\`, and DROP / DEFER / MERGE left no trace at all — so
 * "why was this turn not learned?" was unanswerable from the outside.
 *
 * The fix reuses existing surfaces instead of adding a subsystem: the tally
 * rides the store's existing \`meta\` key/value table (no schema change, no
 * migration) and is surfaced through the existing read-only health report.
 *
 * Hard rules verified here:
 *   - a verdict ledger must never become a memory row (the m1 DROP / DEFER
 *     tests assert \`store.list()\` stays empty);
 *   - the ledger stores decision + reason only, never record content, so it
 *     opens no new unredacted persistence path;
 *   - recording is best-effort: a ledger failure must never break learning;
 *   - the health report stays read-only and \`totalFindings\` keeps meaning
 *     "sum of the memory-quality findings".
 *
 * Reference: dsh-engram \`src/write-disposition.ts\` treats every write
 * disposition as an observable event (MIT); tencentdb-agent-memory
 * \`MemoryCore/src/core/hooks/auto-recall.ts:908-911\` logs exact
 * truncated/dropped accounting. Veyra adopts the accounting idea only.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  maybeLearn,
  readWriteGateLedger,
  recordWriteGateVerdict,
  writeGate,
  WRITE_GATES,
} from '../src/learn.mjs'
import { memoryHealth, renderHealth } from '../src/health.mjs'
import { openEphemeralStore, openProjectStore, closeAllStores } from '../src/store.mjs'
import { AUTHORITIES, KINDS } from '../src/types.mjs'
import { buildToolDefinitions } from '../src/tools.mjs'

const TITLE = 'Serialize DatabaseSync writes'
const BODY = 'The root cause is concurrent DatabaseSync writes corrupting FTS triggers. The remedy is to serialize every write through a mutex around the shared handle.'

const mkCandidate = (overrides = {}) => ({
  title: TITLE,
  body: BODY,
  scope: 'project',
  projectId: 'p_wg',
  kind: KINDS.OBSERVATION,
  authority: AUTHORITIES.CANDIDATE,
  tags: ['observation'],
  evidence: [{ path: 'src/store.mjs', note: 'test-passed' }],
  source: { automatic: true, signal: 'decision', provenance: { origins: ['assistant'] } },
  ...overrides,
})

const DROP_CANDIDATE = { title: 'Short', body: 'Too short.' }
const DEFER_CANDIDATE = {
  source: { automatic: true, signal: 'decision', provenance: { origins: ['user'] } },
}

test('every automatic verdict is tallied with its reason', () => {
  const store = openEphemeralStore()
  writeGate(store, mkCandidate())                       // ACCEPT
  writeGate(store, mkCandidate())                       // MERGE (same content)
  writeGate(store, mkCandidate(DROP_CANDIDATE))         // DROP not-durable
  writeGate(store, mkCandidate(DEFER_CANDIDATE))        // DEFER provenance-gated

  const ledger = readWriteGateLedger(store)
  assert.ok(ledger, 'a ledger is recorded for the project store')
  assert.equal(ledger.total, 4)
  assert.deepEqual(ledger.decisions, { accept: 1, merge: 1, drop: 1, defer: 1 })
  assert.equal(ledger.reasons['accept/new-derived-knowledge'], 1)
  assert.equal(ledger.reasons['merge/near-duplicate-strengthened'], 1)
  assert.equal(ledger.reasons['drop/not-durable'], 1)
  assert.equal(ledger.reasons['defer/provenance-gated'], 1)
})

test('the ledger is not a memory row and records no record content', () => {
  const store = openEphemeralStore()
  writeGate(store, mkCandidate(DROP_CANDIDATE))
  writeGate(store, mkCandidate(DEFER_CANDIDATE))
  // DROP / DEFER write nothing at all (m1 contract).
  assert.equal(store.list({ limit: 10 }).length, 0)
  assert.equal(store.count(), 0)

  writeGate(store, mkCandidate())
  assert.equal(store.list({ limit: 10 }).length, 1, 'only the accepted record is a memory row')

  const raw = JSON.stringify(readWriteGateLedger(store))
  assert.ok(!raw.includes(TITLE), 'the ledger stores no record title')
  assert.ok(!raw.includes('mutex'), 'the ledger stores no record body')
  assert.ok(!raw.includes('src/store.mjs'), 'the ledger stores no evidence path')
})

test('the ledger survives reopening the store', () => {
  const home = mkdtempSync(join(tmpdir(), 'veyra-wg-ledger-'))
  try {
    const store = openProjectStore(home, 'p_persist')
    writeGate(store, mkCandidate())
    writeGate(store, mkCandidate(DROP_CANDIDATE))
    const before = readWriteGateLedger(store)
    assert.equal(before.total, 2)

    closeAllStores()
    const reopened = openProjectStore(home, 'p_persist')
    const after = readWriteGateLedger(reopened)
    assert.equal(after.total, 2)
    assert.deepEqual(after.decisions, { accept: 1, merge: 0, drop: 1, defer: 0 })
  } finally {
    closeAllStores()
    rmSync(home, { recursive: true, force: true })
  }
})

test('a ledger failure never breaks learning', () => {
  const store = openEphemeralStore()
  const realPrepare = store.db.prepare.bind(store.db)
  store.db.prepare = (sql) => {
    if (String(sql).includes('meta')) throw new Error('ledger unavailable')
    return realPrepare(sql)
  }
  try {
    const gate = writeGate(store, mkCandidate())
    assert.equal(gate.decision, WRITE_GATES.ACCEPT, 'the learning decision still happens')
    assert.ok(gate.record, 'the record is still written')
    assert.equal(store.list({ limit: 10 }).length, 1)
    assert.equal(readWriteGateLedger(store), null, 'the ledger degrades to absent')
  } finally {
    store.db.prepare = realPrepare
  }
})

test('the ledger is bounded: distinct reasons collapse and recent verdicts are a ring', () => {
  const store = openEphemeralStore()
  for (let i = 0; i < 60; i += 1) {
    recordWriteGateVerdict(store, { decision: WRITE_GATES.DROP, reason: `synthetic-${i}` })
  }
  const ledger = readWriteGateLedger(store)
  assert.equal(ledger.total, 60)
  assert.ok(Object.keys(ledger.reasons).length <= 25,
    `reasons stay bounded, got ${Object.keys(ledger.reasons).length}`)
  assert.ok(ledger.reasons['other'] > 0, 'overflow lands in an explicit other bucket')
  assert.ok(ledger.recent.length <= 8, `recent is a ring, got ${ledger.recent.length}`)
})

test('the health report surfaces the verdict accounting without changing totalFindings', () => {
  const store = openEphemeralStore()
  writeGate(store, mkCandidate())
  writeGate(store, mkCandidate(DROP_CANDIDATE))
  const ledger = readWriteGateLedger(store)

  const report = memoryHealth([], { writeGate: ledger })
  assert.equal(report.totalFindings, 0, 'the ledger is not a memory-quality finding')
  assert.equal(report.writeGate.total, 2)

  const text = renderHealth(report)
  assert.match(text, /Write gate/)
  assert.match(text, /accept 1/)
  assert.match(text, /drop 1/)
  assert.match(text, /drop\/not-durable/)
  assert.match(text, /No memory-quality problems found/)
  assert.match(text, /evidence for review, not instructions/)
})

test('a store with no learning activity renders no write-gate section', () => {
  const store = openEphemeralStore()
  const report = memoryHealth(store, { writeGate: readWriteGateLedger(store) })
  assert.equal(report.writeGate, null)
  assert.doesNotMatch(renderHealth(report), /Write gate/)
})

test('the health surface stays read-only', () => {
  const store = openEphemeralStore()
  writeGate(store, mkCandidate())
  writeGate(store, mkCandidate(DROP_CANDIDATE))
  const rowsBefore = JSON.stringify(store.list({ limit: 50 }))
  const ledgerBefore = JSON.stringify(readWriteGateLedger(store))

  const report = memoryHealth(store.list({ limit: 50 }), { writeGate: readWriteGateLedger(store) })
  renderHealth(report)

  assert.equal(JSON.stringify(store.list({ limit: 50 })), rowsBefore, 'scan never rewrites records')
  assert.equal(JSON.stringify(readWriteGateLedger(store)), ledgerBefore, 'scan never rewrites the ledger')
})

test('maybeLearn keeps its compatibility contract', () => {
  const store = openEphemeralStore()
  assert.ok(maybeLearn(store, mkCandidate()), 'ACCEPT still returns the record')
  assert.equal(maybeLearn(store, mkCandidate(DROP_CANDIDATE)), null, 'DROP still returns null')
  assert.equal(maybeLearn(store, mkCandidate(DEFER_CANDIDATE)), null, 'DEFER still returns null')
  assert.equal(readWriteGateLedger(store).total, 3, 'and all three are still counted')
})

test('the veyra_health output schema avoids JSON Schema type arrays', () => {
  // DSH's real assertSupportedJsonSchema rejects `type: ['object', 'null']`
  // ("type arrays are not supported"); the local mirror in plugin.test.mjs only
  // compares type as a string, so it cannot catch that shape. Nullability must
  // use oneOf instead, and no schema node may declare an array type.
  const def = buildToolDefinitions({}).find((d) => d.name === 'veyra_health')
  assert.ok(def, 'veyra_health definition exists')
  const walk = (node, path) => {
    if (!node || typeof node !== 'object') return
    if (Array.isArray(node.type)) {
      assert.fail(`${path}.type must be a single string, not an array`)
    }
    if (node.properties && typeof node.properties === 'object') {
      for (const [key, child] of Object.entries(node.properties)) walk(child, `${path}.properties.${key}`)
    }
    if (node.items) walk(node.items, `${path}.items`)
    if (Array.isArray(node.oneOf)) node.oneOf.forEach((child, i) => walk(child, `${path}.oneOf[${i}]`))
  }
  walk(def.output.schema, 'schema')
  const gate = def.output.schema.properties.writeGate
  assert.ok(Array.isArray(gate.oneOf) && gate.oneOf.length >= 2, 'nullable writeGate uses oneOf')
  assert.equal(gate.oneOf[1].type, 'null')
})
