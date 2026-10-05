/**
 * Phase 7 — Memory Health and Maintenance (GOAL.md §21).
 *
 * §21: Veyra automatically identifies memory-quality problems — the nine
 * quality categories (verified / reviewed / unverified / stale / invalid /
 * contradicted / unresolved / negative / protected) and the six maintenance
 * findings (new contradictions, stale knowledge, unresolved investigations,
 * repeated failures, unverified high-value candidates, memories requiring
 * revalidation) — surfaced through the `/veyra health` command and the
 * `veyra_health` tool instead of manual database inspection.
 *
 * Hard rules verified here: the whole surface is read-only (Candidate ≠
 * Truth, findings are evidence not instructions, contradictions stay
 * visible and are never merged away, protected/canonical records still
 * surface when their evidence rots because repository truth outranks
 * protection).
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { memoryHealth, renderHealth } from '../src/health.mjs'
import { openEphemeralStore, openProjectStore, closeAllStores } from '../src/store.mjs'
import { projectIdFor } from '../src/ids.mjs'
import { buildToolDefinitions } from '../src/tools.mjs'
import { handleVeyraCommand } from '../src/commands.mjs'
import { AUTHORITIES, CONFIDENCES, KINDS, RELATIONS, SCOPES, VALIDATIONS } from '../src/types.mjs'

let putSeq = 0
function putRec(store, over = {}, opts = {}) {
  // Unique title+body per call: the store's verbatim-duplicate guard merges
  // identical neighbors, which would collapse fixture records into one.
  putSeq += 1
  return store.put({
    title: `Decision: wrap DatabaseSync writes in a mutex #${putSeq}`,
    body: `The sqlite writer race must be fixed by serializing every write around a critical-section mutex. Variant ${putSeq}.`,
    kind: KINDS.MEMORY,
    authority: AUTHORITIES.DERIVED,
    validation: VALIDATIONS.UNVERIFIED,
    confidence: CONFIDENCES.LOW,
    scope: SCOPES.PROJECT,
    projectId: 'test',
    tags: [],
    relations: [],
    evidence: [],
    source: {},
    ...over,
  }, opts).record
}

// ============================================================ categories

test('§21: nine quality categories are counted (overlapping buckets, not a partition)', () => {
  const store = openEphemeralStore()
  putRec(store, { validation: VALIDATIONS.VERIFIED })
  putRec(store, { validation: VALIDATIONS.REVIEWED })
  putRec(store, { validation: VALIDATIONS.UNVERIFIED })
  putRec(store, { validation: VALIDATIONS.STALE })
  putRec(store, { validation: VALIDATIONS.INVALID })
  putRec(store, { kind: KINDS.UNRESOLVED })
  putRec(store, { kind: KINDS.NEGATIVE })
  putRec(store, { authority: AUTHORITIES.CANONICAL, validation: VALIDATIONS.VERIFIED }, { explicitCanonical: true })

  const report = memoryHealth(store.list({ limit: 50 }), { workspace: '/tmp' })
  assert.equal(report.scanned, 8)
  // Buckets overlap by design: the canonical fixture is also `verified`, and
  // the unresolved/negative fixtures carry the default `unverified` validation.
  assert.deepEqual(report.categories, {
    verified: 2,
    reviewed: 1,
    unverified: 3,
    stale: 1,
    invalid: 1,
    contradicted: 0,
    unresolved: 1,
    negative: 1,
    protected: 1,
  })
})

test('§21: forgotten records are excluded from the scan', () => {
  const store = openEphemeralStore()
  putRec(store, {})
  const gone = putRec(store, { title: 'Gone record' })
  store.forget(gone.id)
  const report = memoryHealth(store.list({ limit: 50 }), { workspace: '/tmp' })
  assert.equal(report.scanned, 1)
  assert.ok(!report.findings.unverifiedHighValueCandidates.some((f) => f.id === gone.id))
})

test('§21: contradictory records land in the contradicted category AND the finding list', () => {
  const store = openEphemeralStore()
  const a = putRec(store, { title: 'Mutex is the fix' })
  const b = putRec(store, { title: 'Queue is the fix' })
  a.relations = [{ type: RELATIONS.CONTRADICTS, targetId: b.id }]

  const report = memoryHealth([a, b], { workspace: '/tmp' })
  assert.equal(report.categories.contradicted, 2, 'both sides counted')
  assert.equal(report.findings.contradictions.length, 1)
  const pair = report.findings.contradictions[0]
  assert.equal(pair.idA, a.id)
  assert.equal(pair.idB, b.id)
  assert.match(pair.banner, /CONTRADICTION/)
  assert.equal(report.counts.contradictions, 1)
})

// ============================================================ findings

test('§21: stale knowledge is listed even after the turn-stop sweep category exists', () => {
  const store = openEphemeralStore()
  const rec = putRec(store, { validation: VALIDATIONS.STALE })
  const report = memoryHealth(store.list({ limit: 50 }), { workspace: '/tmp' })
  assert.equal(report.findings.staleKnowledge.length, 1)
  assert.equal(report.findings.staleKnowledge[0].id, rec.id)
  assert.equal(report.findings.staleKnowledge[0].validation, VALIDATIONS.STALE)
})

test('§21: unresolved investigations are listed by kind', () => {
  const store = openEphemeralStore()
  const rec = putRec(store, { kind: KINDS.UNRESOLVED, title: 'Why does flaky test 42 flake?' })
  const report = memoryHealth(store.list({ limit: 50 }), { workspace: '/tmp' })
  assert.equal(report.findings.unresolvedInvestigations.length, 1)
  assert.equal(report.findings.unresolvedInvestigations[0].id, rec.id)
})

test('§21: repeated failures respect the failure threshold (clamped 2–50)', () => {
  const store = openEphemeralStore()
  const noisy = putRec(store, { source: { feedback: { failures: 3, successes: 1, lastOutcome: 'failure' } } })
  putRec(store, { source: { feedback: { failures: 1 } } })

  const report = memoryHealth(store.list({ limit: 50 }), { workspace: '/tmp', failureThreshold: 2 })
  assert.equal(report.findings.repeatedFailures.length, 1)
  const f = report.findings.repeatedFailures[0]
  assert.equal(f.id, noisy.id)
  assert.equal(f.failures, 3)
  assert.equal(f.attempts, 4)
  assert.equal(f.reliability, 0.25)
  assert.equal(f.lastOutcome, 'failure')

  assert.equal(report.threshold, 2, 'default threshold')
  assert.equal(memoryHealth([], { failureThreshold: 1 }).threshold, 2, 'clamped up')
  assert.equal(memoryHealth([], { failureThreshold: 999 }).threshold, 50, 'clamped down')
})

test('§21: unverified high-value candidates — high confidence OR grounded, never auto-promoted', () => {
  const store = openEphemeralStore()
  const hot = putRec(store, { authority: AUTHORITIES.CANDIDATE, confidence: CONFIDENCES.HIGH })
  const grounded = putRec(store, {
    authority: AUTHORITIES.CANDIDATE,
    confidence: CONFIDENCES.LOW,
    evidence: [{ path: 'src/store.mjs' }],
  })
  putRec(store, { authority: AUTHORITIES.CANDIDATE, confidence: CONFIDENCES.LOW })

  const report = memoryHealth(store.list({ limit: 50 }), { workspace: '/tmp' })
  const ids = report.findings.unverifiedHighValueCandidates.map((f) => f.id)
  assert.deepEqual(ids.sort(), [hot.id, grounded.id].sort())
  const hotFinding = report.findings.unverifiedHighValueCandidates.find((f) => f.id === hot.id)
  assert.equal(hotFinding.confidence, CONFIDENCES.HIGH)
  // Candidate ≠ Truth: the finding carries standing for review, never an authority change.
  assert.equal(hot.authority, AUTHORITIES.CANDIDATE)
  assert.equal(grounded.authority, AUTHORITIES.CANDIDATE)
})

test('§21: revalidation candidates — trusted records whose evidence rots (broken/partial)', () => {
  const store = openEphemeralStore()
  const ws = mkdtempSync(join(tmpdir(), 'veyra-m7-ev-'))
  try {
    const broken = putRec(store, {
      validation: VALIDATIONS.VERIFIED,
      evidence: [{ path: 'no/such/file.mjs' }],
    })
    const healthy = putRec(store, {
      validation: VALIDATIONS.VERIFIED,
      evidence: [{ path: 'index.mjs' }], // will not exist under ws either — distinguished below
    })
    const untrusted = putRec(store, {
      validation: VALIDATIONS.UNVERIFIED,
      evidence: [{ path: 'no/such/file.mjs' }],
    })
    // Healthy record: anchor with an existing path under ws.
    writeFileSync(join(ws, 'ok.mjs'), '// ok\n')
    const good = putRec(store, { validation: VALIDATIONS.REVIEWED, evidence: [{ path: 'ok.mjs' }] })

    const report = memoryHealth([broken, healthy, untrusted, good], { workspace: ws })
    const ids = report.findings.revalidationCandidates.map((f) => f.id)
    assert.ok(ids.includes(broken.id), 'verified + broken evidence → revalidation')
    assert.ok(!ids.includes(good.id), 'reviewed + healthy evidence → not a finding')
    assert.ok(!ids.includes(untrusted.id), 'untrusted records are not revalidation candidates')
    const entry = report.findings.revalidationCandidates.find((f) => f.id === broken.id)
    assert.equal(entry.evidenceStatus, 'broken')
    assert.equal(entry.validation, VALIDATIONS.VERIFIED)
    // Both broken-evidence trusted records surface; protection never hides rot.
    assert.ok(ids.includes(healthy.id))
  } finally {
    rmSync(ws, { recursive: true, force: true })
  }
})

test('§21: canonical (protected) records still surface when evidence rots — repository truth outranks protection', () => {
  const store = openEphemeralStore()
  const protectedRec = putRec(store, {
    authority: AUTHORITIES.CANONICAL,
    validation: VALIDATIONS.VERIFIED,
    evidence: [{ path: 'gone/for/good.mjs' }],
  }, { explicitCanonical: true })
  assert.equal(protectedRec.authority, AUTHORITIES.CANONICAL)

  const report = memoryHealth([protectedRec], { workspace: '/tmp/definitely-empty-ws' })
  assert.equal(report.categories.protected, 1)
  assert.equal(report.findings.revalidationCandidates.length, 1, 'protection is not a shield')
  assert.equal(report.findings.revalidationCandidates[0].id, protectedRec.id)
})

// ============================================================ read-only guarantee

test('§21: memoryHealth is pure — records byte-identical after the scan', () => {
  const store = openEphemeralStore()
  putRec(store, { validation: VALIDATIONS.STALE })
  putRec(store, { kind: KINDS.UNRESOLVED })
  putRec(store, { source: { feedback: { failures: 5 } } })
  const records = store.list({ limit: 50 })
  const before = JSON.parse(JSON.stringify(records))
  const beforeCount = store.count()

  memoryHealth(records, { workspace: '/tmp', failureThreshold: 2 })

  assert.deepEqual(JSON.parse(JSON.stringify(store.list({ limit: 50 }))), before, 'scan never rewrites records')
  assert.equal(store.count(), beforeCount, 'scan never adds or removes records')
})

// ============================================================ /veyra health command

test('/veyra health: success report, categories + findings, store untouched', () => {
  const dir = mkdtempSync(join(tmpdir(), 'veyra-m7-cmd-'))
  const cwd = mkdtempSync(join(tmpdir(), 'veyra-m7-ws-'))
  try {
    const runtime = { veyraHome: dir, fallbackCwd: cwd, recallLimit: 5, includeReusable: true }
    const store = openProjectStore(dir, projectIdFor(cwd))
    putRec(store, { validation: VALIDATIONS.STALE })
    putRec(store, { kind: KINDS.UNRESOLVED })
    const before = JSON.parse(JSON.stringify(store.list({ limit: 50 })))

    const res = handleVeyraCommand(runtime, { text: 'health', agent: { session: { header: { cwd } } } })
    assert.equal(res.kind, 'success')
    assert.match(res.text, /Memory health \(§21\): 2 active record\(s\) scanned/)
    assert.match(res.text, /Categories: .*1 stale/)
    assert.match(res.text, /Findings: .*1 stale knowledge, 1 unresolved investigations/)
    assert.match(res.text, /evidence for review, not instructions/)
    assert.deepEqual(JSON.parse(JSON.stringify(store.list({ limit: 50 }))), before, '/veyra health is read-only')

    // Threshold argument is parsed and reported.
    const th = handleVeyraCommand(runtime, { text: 'health 4', agent: { session: { header: { cwd } } } })
    assert.equal(th.kind, 'success')
    assert.match(th.text, /threshold 4\)/)
  } finally {
    closeAllStores()
    rmSync(dir, { recursive: true, force: true })
    rmSync(cwd, { recursive: true, force: true })
  }
})

test('/veyra health on an empty workspace renders the clean-report line', () => {
  const dir = mkdtempSync(join(tmpdir(), 'veyra-m7-empty-'))
  const cwd = mkdtempSync(join(tmpdir(), 'veyra-m7-ews-'))
  try {
    const runtime = { veyraHome: dir, fallbackCwd: cwd, recallLimit: 5, includeReusable: true }
    const res = handleVeyraCommand(runtime, { text: 'health', agent: { session: { header: { cwd } } } })
    assert.equal(res.kind, 'success')
    assert.match(res.text, /0 active record\(s\) scanned/)
    assert.match(res.text, /No memory-quality problems found/)
  } finally {
    closeAllStores()
    rmSync(dir, { recursive: true, force: true })
    rmSync(cwd, { recursive: true, force: true })
  }
})

test('/veyra help lists the health verb', () => {
  const dir = mkdtempSync(join(tmpdir(), 'veyra-m7-help-'))
  try {
    const runtime = { veyraHome: dir, fallbackCwd: dir, recallLimit: 5, includeReusable: true }
    const res = handleVeyraCommand(runtime, { text: 'help', agent: { session: { header: { cwd: dir } } } })
    assert.equal(res.kind, 'success')
    assert.match(res.text, /\/veyra health \[threshold\]/)
  } finally {
    closeAllStores()
    rmSync(dir, { recursive: true, force: true })
  }
})

// ============================================================ veyra_health tool

test('tools: veyra_health executes §21 end-to-end, renders, and never writes', () => {
  const home = mkdtempSync(join(tmpdir(), 'veyra-m7-tool-'))
  try {
    const defs = buildToolDefinitions({ veyraHome: home, fallbackCwd: home })
    const def = defs.find((d) => d.name === 'veyra_health')
    assert.ok(def, 'veyra_health tool defined')

    const exec = { agent: { session: { id: 's1', header: { cwd: home } }, provider: 'deepseek', model: 'ds-test' } }
    const store = openProjectStore(home, projectIdFor(home))
    const stale = putRec(store, { validation: VALIDATIONS.STALE })
    const failing = putRec(store, { source: { feedback: { failures: 4, successes: 2, lastOutcome: 'failure' } } })
    const before = JSON.parse(JSON.stringify(store.list({ limit: 50 })))

    const report = def.execute({ failureThreshold: 3 }, exec)
    assert.equal(report.ok, true)
    assert.equal(report.scanned, 2)
    assert.equal(report.threshold, 3)
    assert.equal(report.counts.staleKnowledge, 1)
    assert.equal(report.counts.repeatedFailures, 1)
    assert.ok(report.categories.stale >= 1)
    assert.equal(report.findings.repeatedFailures[0].id, failing.id)
    assert.equal(report.findings.staleKnowledge[0].id, stale.id)

    const rendered = def.output.render({ failureThreshold: 3 }, report).map((b) => b.text).join('\n')
    assert.match(rendered, /Memory health \(§21\): 2 active record\(s\) scanned/)
    assert.match(rendered, /1 repeated failures \(threshold 3\)/)
    assert.equal(def.presentCall({ failureThreshold: 3 }).title, 'Memory health')

    assert.deepEqual(JSON.parse(JSON.stringify(store.list({ limit: 50 }))), before, 'tool scan is read-only')
    assert.equal(store.count(), before.length, 'no records created or dropped')
  } finally {
    closeAllStores()
    rmSync(home, { recursive: true, force: true })
  }
})

test('tools: veyra_health on an empty store renders the clean report', () => {
  const emptyHome = mkdtempSync(join(tmpdir(), 'veyra-m7-etool-'))
  try {
    const def = buildToolDefinitions({ veyraHome: emptyHome, fallbackCwd: emptyHome }).find((d) => d.name === 'veyra_health')
    const exec = { agent: { session: { id: 's2', header: { cwd: emptyHome } }, provider: 'deepseek', model: 'ds-test' } }
    const report = def.execute({}, exec)
    assert.equal(report.ok, true)
    assert.equal(report.scanned, 0)
    assert.equal(report.totalFindings, 0)
    const rendered = def.output.render({}, report).map((b) => b.text).join('\n')
    assert.match(rendered, /No memory-quality problems found/)
  } finally {
    closeAllStores()
    rmSync(emptyHome, { recursive: true, force: true })
  }
})

test('§21: renderHealth caps long sections and keeps the read-only disclaimer', () => {
  const many = Array.from({ length: 30 }, (_, i) => ({
    id: `vey_fake_${i}`,
    kind: KINDS.UNRESOLVED,
    status: 'current',
    title: `Open question ${i}`,
    body: 'why',
    tags: [],
    forgotten: false,
    source: {},
  }))
  const report = memoryHealth(many, { workspace: '/tmp' })
  assert.equal(report.findings.unresolvedInvestigations.length, 30, 'all findings collected up to the limit')
  const text = renderHealth(report)
  assert.match(text, /… 10 more/, 'render section caps at 20 visible')
  assert.match(text, /Candidate ≠ Truth/)
  assert.equal(report.totalFindings, 30)
})
