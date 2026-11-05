/**
 * veyra_stale_ledger — read-only runtime diagnostic (tooling).
 *
 * Enumerates every record with validation=stale from the same stores as
 * veyra_health, with bounded pagination and complete record fields plus
 * evidence/freshness/path-resolution diagnostics. Strictly read-only.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { openProjectStore, openReusableStore, closeAllStores } from '../src/store.mjs'
import { projectIdFor } from '../src/ids.mjs'
import { createToolHarness } from '../src/tools.mjs'
import { AUTHORITIES, CONFIDENCES, KINDS, SCOPES, VALIDATIONS } from '../src/types.mjs'

let putSeq = 0
function putRec(store, over = {}) {
  putSeq += 1
  return store.put({
    title: `Stale ledger fixture #${putSeq}`,
    body: `Body variant ${putSeq} for stale-ledger coverage.`,
    kind: KINDS.MEMORY,
    authority: AUTHORITIES.DERIVED,
    validation: VALIDATIONS.STALE,
    confidence: CONFIDENCES.MEDIUM,
    scope: SCOPES.PROJECT,
    projectId: 'test',
    tags: [],
    relations: [],
    evidence: [],
    source: {},
    ...over,
  }).record
}

function runtimeFor(home, cwd) {
  return { veyraHome: home, fallbackCwd: cwd, recallLimit: 5, includeReusable: true }
}
function execFor(cwd) {
  return { agent: { session: { id: 's-ledger', header: { cwd } }, provider: 'deepseek', model: 'ds-test' } }
}

test('veyra_stale_ledger: filters stale only, uses same stores as veyra_health, read-only', async () => {
  const home = mkdtempSync(join(tmpdir(), 'veyra-stale-ledger-'))
  const cwd = mkdtempSync(join(tmpdir(), 'veyra-stale-ledger-ws-'))
  try {
    const projectStore = openProjectStore(home, projectIdFor(cwd))
    const reusableStore = openReusableStore(home)
    const staleA = putRec(projectStore, { validation: VALIDATIONS.STALE, title: 'Stale A unique title' })
    putRec(projectStore, { validation: VALIDATIONS.REVIEWED, title: 'Reviewed B unique title' })
    putRec(projectStore, { validation: VALIDATIONS.UNVERIFIED, title: 'Unverified C unique title' })
    putRec(projectStore, { validation: VALIDATIONS.VERIFIED, title: 'Verified D unique title' })
    const staleReusable = putRec(reusableStore, { validation: VALIDATIONS.STALE, scope: SCOPES.REUSABLE, projectId: null, title: 'Stale reusable E unique' })
    putRec(reusableStore, { validation: VALIDATIONS.REVIEWED, scope: SCOPES.REUSABLE, projectId: null, title: 'Reviewed reusable F unique' })

    const beforeProject = JSON.parse(JSON.stringify(projectStore.list({ limit: 1000 })))
    const beforeReusable = JSON.parse(JSON.stringify(reusableStore.list({ limit: 1000 })))
    const beforeCounts = { project: projectStore.count(), reusable: reusableStore.count() }

    const harness = createToolHarness(runtimeFor(home, cwd))
    const ledger = await harness.call('veyra_stale_ledger', { offset: 0, limit: 50 }, execFor(cwd))
    const health = await harness.call('veyra_health', {}, execFor(cwd))

    assert.equal(ledger.ok, true)
    assert.equal(ledger.scope, 'project')
    assert.equal(ledger.workspace, cwd)
    assert.equal(ledger.totalStale, 2)
    assert.equal(ledger.returned, 2)
    assert.equal(ledger.complete, true)
    assert.deepEqual(new Set(ledger.items.map((i) => i.record.id)), new Set([staleA.id, staleReusable.id]))
    for (const item of ledger.items) {
      assert.equal(item.record.validation, VALIDATIONS.STALE)
      assert.ok(item.record.id)
      assert.ok(typeof item.record.title === 'string')
      assert.ok('body' in item.record)
      assert.ok(Array.isArray(item.record.evidence))
      assert.ok(item.diagnostics && typeof item.diagnostics === 'object')
      assert.equal(item.diagnostics.available, true)
      assert.equal(item.diagnostics.workspace, cwd)
      assert.ok(Array.isArray(item.diagnostics.evidenceAnchors))
      assert.ok(item.diagnostics.recordFreshness && typeof item.diagnostics.recordFreshness.status === 'string')
      assert.ok(Array.isArray(item.diagnostics.pathResolution))
    }

    // Same runtime store resolution / dataset as veyra_health (project scope includes reusable).
    assert.equal(health.ok, true)
    assert.equal(health.categories.stale, ledger.totalStale)

    // Strictly read-only.
    assert.deepEqual(JSON.parse(JSON.stringify(projectStore.list({ limit: 1000 }))), beforeProject)
    assert.deepEqual(JSON.parse(JSON.stringify(reusableStore.list({ limit: 1000 }))), beforeReusable)
    assert.deepEqual({ project: projectStore.count(), reusable: reusableStore.count() }, beforeCounts)
  } finally {
    closeAllStores()
    rmSync(home, { recursive: true, force: true })
    rmSync(cwd, { recursive: true, force: true })
  }
})

test('veyra_stale_ledger: pagination enumerates all stale without omissions or duplicates', async () => {
  const home = mkdtempSync(join(tmpdir(), 'veyra-stale-ledger-page-'))
  const cwd = mkdtempSync(join(tmpdir(), 'veyra-stale-ledger-page-ws-'))
  try {
    const projectStore = openProjectStore(home, projectIdFor(cwd))
    const expected = []
    for (let i = 0; i < 7; i++) expected.push(putRec(projectStore, { validation: VALIDATIONS.STALE, title: `Paged stale ${i} unique` }).id)
    putRec(projectStore, { validation: VALIDATIONS.REVIEWED, title: 'Paged reviewed control' })

    const harness = createToolHarness(runtimeFor(home, cwd))
    const seen = new Set()
    let offset = 0
    let pages = 0
    while (true) {
      const page = await harness.call('veyra_stale_ledger', { offset, limit: 3 }, execFor(cwd))
      assert.equal(page.ok, true)
      assert.equal(page.totalStale, 7)
      assert.ok(page.returned <= 3)
      for (const item of page.items) {
        assert.equal(item.record.validation, VALIDATIONS.STALE)
        assert.ok(!seen.has(item.record.id), `duplicate id ${item.record.id}`)
        seen.add(item.record.id)
      }
      pages += 1
      if (page.complete) {
        assert.equal(page.nextOffset, undefined)
        break
      }
      assert.equal(typeof page.nextOffset, 'number')
      offset = page.nextOffset
      assert.ok(pages < 20, 'pagination did not complete')
    }
    assert.equal(seen.size, 7)
    assert.deepEqual(seen, new Set(expected))
  } finally {
    closeAllStores()
    rmSync(home, { recursive: true, force: true })
    rmSync(cwd, { recursive: true, force: true })
  }
})

test('veyra_stale_ledger: diagnostics mark unavailable/unresolved explicitly without inferring', async () => {
  const home = mkdtempSync(join(tmpdir(), 'veyra-stale-ledger-diag-'))
  const cwd = mkdtempSync(join(tmpdir(), 'veyra-stale-ledger-diag-ws-'))
  try {
    const projectStore = openProjectStore(home, projectIdFor(cwd))
    putRec(projectStore, {
      validation: VALIDATIONS.STALE,
      title: 'Stale with anchors unique diag',
      evidence: [{ path: '/definitely/outside/repo/file.mjs', note: 'absolute path' }, { note: 'no path anchor' }],
    })
    const harness = createToolHarness(runtimeFor(home, cwd))
    const ledger = await harness.call('veyra_stale_ledger', { offset: 0, limit: 10 }, execFor(cwd))
    assert.equal(ledger.totalStale, 1)
    const diag = ledger.items[0].diagnostics
    assert.equal(diag.available, true)
    assert.ok(diag.evidenceAnchors.length >= 1)
    assert.ok(diag.pathResolution.length >= 1)
    for (const pr of diag.pathResolution) {
      assert.ok(typeof pr.status === 'string')
      assert.ok(typeof pr.reason === 'string')
      // Never inferred: must report an explicit status/reason.
      assert.ok(pr.reason.length > 0)
    }
    const noPath = diag.pathResolution.find((p) => !p.anchor || !p.anchor.path)
    if (noPath) {
      assert.equal(noPath.status, 'unavailable')
      assert.match(noPath.reason, /No file path/i)
    }
  } finally {
    closeAllStores()
    rmSync(home, { recursive: true, force: true })
    rmSync(cwd, { recursive: true, force: true })
  }
})
