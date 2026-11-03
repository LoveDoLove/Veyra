/**
 * Issue #3 Phase C — read-only historical audit of suspicious contradiction
 * edges.
 *
 * Covers remediation coverage item 12 (the audit output does not mutate the
 * store), plus the reporting contract: both endpoints, direction, evidence and
 * the reason each edge was flagged are shown, and repair stays an explicit
 * user action.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { closeAllStores, openEphemeralStore, openProjectStore } from '../src/store.mjs'
import { projectIdFor } from '../src/ids.mjs'
import { handleVeyraCommand } from '../src/commands.mjs'
import { auditContradictionEdges, MAX_FINDINGS, MAX_RECORDS } from '../src/audit.mjs'
import { AUTHORITIES, RELATIONS } from '../src/types.mjs'

let seq = 0

function putRec(store, over = {}) {
  seq += 1
  const result = store.put({
    kind: 'memory',
    title: `Audit fixture ${seq}`,
    body: `Audit fixture body ${seq}: an engineering fact used only by the Issue 3 audit tests.`,
    evidence: [{ path: `src/audit-fixture-${seq}.mjs` }],
    authority: AUTHORITIES.DERIVED,
    ...over,
  })
  assert.ok(result?.record, 'fixture record was stored')
  return result.record
}

/** Link two records with a bidirectional contradicts edge, as evolve does. */
function link(store, aId, bId) {
  const a = store.get(aId)
  const b = store.get(bId)
  store.put({ ...a, relations: [...(a.relations || []), { type: RELATIONS.CONTRADICTS, targetId: bId }] })
  store.put({ ...b, relations: [...(b.relations || []), { type: RELATIONS.CONTRADICTS, targetId: aId }] })
}

/**
 * Byte-level snapshot of every column of every row, plus the FTS index. Any
 * write of any kind — including a timestamp touch — changes this.
 */
function rawDump(store) {
  return JSON.stringify({
    rows: store.db.prepare('SELECT * FROM memory ORDER BY id').all(),
    fts: store.db.prepare('SELECT rowid, id, title, body, tags FROM memory_fts ORDER BY rowid').all(),
  })
}

/** One false edge (the defect signature) and one genuine conflict. */
function seededStore() {
  const store = openEphemeralStore()

  const database = putRec(store, {
    title: 'Local database driver',
    body: 'Use the SQLite driver rather than a networked database for local persistence in the desktop build.',
    evidence: [{ path: 'src/db.mjs' }],
  })
  const typescript = putRec(store, {
    title: 'TypeScript config for consumers',
    body: 'Set declaration to true in the TypeScript config so downstream consumers receive type information from the package.',
    evidence: [{ path: 'tsconfig.json' }],
  })
  link(store, database.id, typescript.id)

  const cache = putRec(store, {
    title: 'Cache invalidation on write',
    body: 'The cache is invalidated on every write so readers never observe stale entries after an update commits.',
    evidence: [{ path: 'src/cache.mjs' }],
  })
  const cacheOpposing = putRec(store, {
    title: 'Cache invalidation must not happen on write',
    body: 'The cache is not invalidated on write so readers keep serving the previous entries after an update commits.',
    evidence: [{ path: 'src/cache.mjs' }],
  })
  link(store, cache.id, cacheOpposing.id)

  return { store, database, typescript, cache, cacheOpposing }
}

test('coverage 12: the audit never mutates the store', () => {
  const { store } = seededStore()
  try {
    const before = rawDump(store)
    const result = auditContradictionEdges({ projectStore: store })
    assert.equal(result.ok, true)
    assert.equal(rawDump(store), before, 'audit wrote to the database')

    // Running it again is equally inert.
    auditContradictionEdges({ projectStore: store })
    assert.equal(rawDump(store), before, 'second audit run wrote to the database')
  } finally {
    store.close()
  }
})

test('audit flags the replacement-only false edge and reports both endpoints', () => {
  const { store, database, typescript } = seededStore()
  try {
    const result = auditContradictionEdges({ projectStore: store })
    assert.equal(result.data.edges, 2, 'both edges are counted once each')
    assert.equal(result.data.flagged, 1, 'only the weak edge is flagged')

    const flagged = result.data.findings.find((f) => f.flagged)
    assert.ok(flagged)
    assert.deepEqual(flagged.pair.slice().sort(), [database.id, typescript.id].sort())
    assert.equal(flagged.signals.lowSimilarity, true)
    assert.equal(flagged.signals.noSharedSubject, true)
    assert.equal(flagged.signals.replacementOnly, true)
    assert.deepEqual(flagged.direction, { aToB: true, bToA: true })
    assert.match(flagged.reasons.join(' '), /below the conflict floor/)
    assert.match(flagged.reasons.join(' '), /no shared subject anchor/)
    assert.match(flagged.reasons.join(' '), /replacement wording/)
  } finally {
    store.close()
  }
})

test('audit leaves a genuine same-subject polarity conflict unflagged', () => {
  const { store, cache, cacheOpposing } = seededStore()
  try {
    const result = auditContradictionEdges({ projectStore: store })
    const genuine = result.data.findings.find((f) => !f.flagged)
    assert.ok(genuine, 'the genuine conflict is present in the report')
    assert.deepEqual(genuine.pair.slice().sort(), [cache.id, cacheOpposing.id].sort())
    assert.equal(genuine.signals.sharedSubject, true)
    assert.equal(genuine.signals.lowSimilarity, false)
    assert.deepEqual(genuine.reasons, [])
  } finally {
    store.close()
  }
})

test('audit reports the dangling-target and provenance limitations honestly', () => {
  const store = openEphemeralStore()
  try {
    const a = putRec(store, { title: 'Dangling contradiction source' })
    store.put({
      ...store.get(a.id),
      relations: [{ type: RELATIONS.CONTRADICTS, targetId: 'gone-record-id' }],
    })

    const result = auditContradictionEdges({ projectStore: store })
    assert.equal(result.data.flagged, 1)
    const finding = result.data.findings[0]
    assert.equal(finding.signals.danglingTarget, true)
    assert.equal(finding.b.id, 'gone-record-id')
    assert.match(result.formatted, /not present in the audited stores/)
    assert.match(result.formatted, /Relation provenance is not recorded/)
    assert.match(result.formatted, /review only — nothing was unlinked, rewritten, or demoted/)
    assert.equal(result.data.limitations.length, 3)
  } finally {
    store.close()
  }
})

test('audit is bounded and says so', () => {
  const store = openEphemeralStore()
  try {
    // More flagged edges than the render cap.
    for (let i = 0; i < MAX_FINDINGS + 3; i += 1) {
      const left = putRec(store, { title: `Bounded left ${i}`, evidence: [{ path: `src/left-${i}.mjs` }] })
      const right = putRec(store, { title: `Bounded right ${i}`, evidence: [{ path: `src/right-${i}.mjs` }] })
      store.put({
        ...store.get(left.id),
        relations: [{ type: RELATIONS.CONTRADICTS, targetId: right.id }],
      })
    }

    const result = auditContradictionEdges({ projectStore: store })
    assert.equal(result.data.flagged, MAX_FINDINGS + 3)
    assert.equal(result.data.truncated, true)
    assert.match(result.formatted, new RegExp(`showing ${MAX_FINDINGS} of ${MAX_FINDINGS + 3} flagged edges`))
    assert.match(result.formatted, new RegExp(`max ${MAX_RECORDS} per store`))
  } finally {
    store.close()
  }
})

test('/veyra audit contradictions end-to-end is read-only', () => {
  const dir = mkdtempSync(join(tmpdir(), 'veyra-issue3-audit-'))
  const cwd = mkdtempSync(join(tmpdir(), 'veyra-issue3-audit-ws-'))
  try {
    const runtime = { veyraHome: dir, fallbackCwd: cwd, recallLimit: 5, includeReusable: true }
    const store = openProjectStore(dir, projectIdFor(cwd))
    const run = (text) => handleVeyraCommand(runtime, {
      text, agent: { session: { header: { cwd } } },
    })

    const database = putRec(store, {
      title: 'Local database driver',
      body: 'Use the SQLite driver rather than a networked database for local persistence in the desktop build.',
      evidence: [{ path: 'src/db.mjs' }],
    })
    const typescript = putRec(store, {
      title: 'TypeScript config for consumers',
      body: 'Set declaration to true in the TypeScript config so downstream consumers receive type information from the package.',
      evidence: [{ path: 'tsconfig.json' }],
    })
    link(store, database.id, typescript.id)

    const before = rawDump(store)

    assert.match(run('help').text, /\/veyra audit contradictions/)

    const ok = run('audit contradictions')
    assert.equal(ok.kind, 'success', ok.text)
    assert.match(ok.text, /VEYRA AUDIT — SUSPICIOUS CONTRADICTION EDGES/)
    assert.match(ok.text, new RegExp(database.id))
    assert.match(ok.text, new RegExp(typescript.id))
    // Endpoint order in the report is canonical (ascending id), so accept
    // the unlink suggestion in either orientation.
    assert.match(
      ok.text,
      new RegExp(`/veyra unlink (${database.id}|${typescript.id}) contradicts (${database.id}|${typescript.id})`),
    )

    const unknown = run('audit nonsense')
    assert.equal(unknown.kind, 'error')
    assert.match(unknown.text, /Unknown audit subcommand/)

    assert.equal(rawDump(store), before, 'the command wrote to the database')
  } finally {
    closeAllStores()
    rmSync(dir, { recursive: true, force: true })
    rmSync(cwd, { recursive: true, force: true })
  }
})
