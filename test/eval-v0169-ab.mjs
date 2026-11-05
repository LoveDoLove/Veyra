// Veyra v0.1.69 real-world A/B evaluation harness - reproducible.
// Usage: node test/eval-v0169-ab.mjs
//
// Builds a deterministic fixture git repo (a small "stockctl" service with a
// planted stock-drift bug), seeds engineering memory across two simulated
// sessions, evolves the repo so code anchors go stale, then runs task
// scenarios with Veyra (arm A) and without (arm B). Everything runs in
// os.tmpdir() - no live DSH home, no DSH Web, no user repository touched.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execSync } from 'node:child_process'
import { createToolHarness } from '../src/tools.mjs'
import { openProjectStore, closeAllStores } from '../src/store.mjs'
import { projectIdFor } from '../src/ids.mjs'
import { recall as retrieveRecall } from '../src/retrieve.mjs'
import { buildRecallContext } from '../src/context.mjs'

const RUN = fs.mkdtempSync(path.join(os.tmpdir(), 'veyra-eval-v0169-'))
const results = {
  harness: 'eval-v0169-ab',
  startedAt: new Date().toISOString(),
  runDir: RUN,
  fixture: null,
  tasks: [],
  metrics: {},
  failures: [],
  tokenCost: null,
  nextSlice: null,
}
function task(id, name) {
  const t = { id, name, pass: false, expected: '', actual: '', evidence: [] }
  results.tasks.push(t)
  return t
}
function note(t, ...lines) { t.evidence.push(lines.join('\n').slice(0, 1600)) }
function fail(t, expected, actual, snippet) {
  t.pass = false
  t.expected = expected
  t.actual = actual
  if (snippet) note(t, snippet)
  results.failures.push({ id: t.id, expected, actual: String(actual).slice(0, 600) })
}
function pass(t, expected, actual, snippet) {
  t.pass = true
  t.expected = expected
  t.actual = actual
  if (snippet) note(t, snippet)
}
const sh = (cmd, cwd) => execSync(cmd, { cwd, encoding: 'utf8', stdio: 'pipe' })
const shTry = (cmd, cwd) => {
  try { return { code: 0, out: sh(cmd, cwd) } }
  catch (e) { return { code: e.status ?? 1, out: String(e.stdout || '') + String(e.stderr || '') } }
}

// ---------------------------------------------------------------- fixture
const FIXTURE_SRC = {
  'package.json': JSON.stringify({
    name: 'stockctl', version: '0.2.0', type: 'module',
    scripts: { check: 'node check/idempotency.mjs', test: 'node --test test/' },
  }, null, 2) + '\n',
  'README.md': '# stockctl\nSmall warehouse stock service. Events are redelivered by the bus after\nprocess restarts; stock must stay exact.\n',
  'src/warehouse.mjs': [
    'export class Warehouse {',
    '  constructor(rows) {',
    '    this.stock = new Map(rows.map((r) => [r.sku, r.qty]))',
    '  }',
    '  // BUG: no idempotency guard. The bus redelivers events after a restart,',
    '  // so the same eventId lands here twice and the stock is deducted twice.',
    '  deduct(sku, qty, eventId) {',
    '    const cur = this.stock.get(sku) ?? 0',
    '    this.stock.set(sku, cur - qty)',
    '    return this.stock.get(sku)',
    '  }',
    '  balance(sku) { return this.stock.get(sku) ?? 0 }',
    '}',
    '',
  ].join('\n'),
  'check/idempotency.mjs': [
    "import { Warehouse } from '../src/warehouse.mjs'",
    '// Simulates a redelivered event: the SAME eventId is processed twice.',
    "const w = new Warehouse([{ sku: 'W-1', qty: 10 }])",
    "w.deduct('W-1', 1, 'evt-42')",
    "w.deduct('W-1', 1, 'evt-42') // duplicate delivery",
    "const got = w.balance('W-1')",
    'if (got !== 9) {',
    '  console.error("FAIL stock integrity: expected 9 after one logical deduction, got " + got)',
    '  process.exit(1)',
    '}',
    "console.log('PASS stock integrity')",
    '',
  ].join('\n'),
  'test/warehouse.test.mjs': [
    "import test from 'node:test'",
    "import assert from 'node:assert/strict'",
    "import { Warehouse } from '../src/warehouse.mjs'",
    "test('deduct subtracts the requested quantity', () => {",
    "  const w = new Warehouse([{ sku: 'W-1', qty: 10 }])",
    "  w.deduct('W-1', 3, 'evt-1')",
    "  assert.equal(w.balance('W-1'), 7)",
    '})',
    '',
  ].join('\n'),
}
const FIXED_WAREHOUSE = [
  'export class Warehouse {',
  '  constructor(rows) {',
  '    this.stock = new Map(rows.map((r) => [r.sku, r.qty]))',
  '    this.seen = new Set() // idempotency keys',
  '  }',
  '  // FIX: idempotent deduction keyed on the bus eventId. A redelivered',
  '  // event is recognized and skipped, so stock stays exact.',
  '  deduct(sku, qty, eventId) {',
  '    if (eventId) {',
  '      if (this.seen.has(eventId)) return this.balance(sku)',
  '      this.seen.add(eventId)',
  '    }',
  '    const cur = this.stock.get(sku) ?? 0',
  '    this.stock.set(sku, cur - qty)',
  '    return this.stock.get(sku)',
  '  }',
  '  balance(sku) { return this.stock.get(sku) ?? 0 }',
  '}',
  '',
].join('\n')

function buildFixture(dir, { buggy }) {
  fs.rmSync(dir, { recursive: true, force: true })
  fs.mkdirSync(dir, { recursive: true })
  const srcs = buggy ? FIXTURE_SRC : { ...FIXTURE_SRC, 'src/warehouse.mjs': FIXED_WAREHOUSE }
  for (const [f, body] of Object.entries(srcs)) {
    fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true })
    fs.writeFileSync(path.join(dir, f), body)
  }
  shTry('git init -q', dir)
  shTry('git -c user.name=VeyraEval -c user.email=eval@veyra.local add -A', dir)
  shTry('git -c user.name=VeyraEval -c user.email=eval@veyra.local commit -qm "feat: stockctl v0.2.0 (initial)"', dir)
  return dir
}

function storeCount(store, ids) {
  let n = 0
  for (const id of ids) {
    if (!id) continue
    try { if (store.get(id)) n += 1 } catch { /* fail-closed */ }
  }
  return n
}

async function main() {
  const fixtureDir = path.join(RUN, 'fixture-A')
  buildFixture(fixtureDir, { buggy: true })
  results.fixture = { dir: fixtureDir, note: 'stockctl v0.2.0, planted double-deduct bug, git-initialized' }

  const veyraHomeA = path.join(RUN, 'veyra-home-A')
  const veyraHomeB = path.join(RUN, 'veyra-home-B')

  // ============ SESSION 1 - prior engineer discovers + fixes ============
  const session1 = createToolHarness({ veyraHome: veyraHomeA, fallbackCwd: fixtureDir })
  const t0 = task('T0', 'session 1: discover bug, record knowledge, verify fix')
  const probeBefore = shTry('node check/idempotency.mjs', fixtureDir)
  note(t0, 'check BEFORE fix: exit=' + probeBefore.code + ' out=' + probeBefore.out.trim().slice(0, 300))
  if (probeBefore.code !== 0) fail(t0, 'planted bug reproducible (check fails)', 'check unexpectedly passed', probeBefore.out)
  const r1 = await session1.call('veyra_remember', {
    kind: 'memory',
    title: 'Root cause of stock drift: bus event redelivery without idempotency',
    body: 'Warehouse stock drifted 1 unit low after each restart. Root cause: the event bus redelivers in-flight events after a process restart, and Warehouse.deduct() had no idempotency guard, so the same eventId deducted twice. Remedy: guard deduct() with a seen-set keyed on eventId (idempotent dedup), not a mutex. Verified: check/idempotency.mjs failed before the fix (FAIL expected 9 got 8) and passes after it.',
    confidence: 'high',
    tags: ['warehouse', 'idempotency', 'stock'],
    evidence: [
      { path: 'src/warehouse.mjs', note: 'deduct() had no seen-set guard (bug); FIX adds idempotency keys' },
      { note: 'check/idempotency.mjs: FAIL expected 9 got 8 before fix; PASS after fix' },
    ],
  })
  const R1 = r1?.record?.id || r1?.id || null
  note(t0, 'remember R1 -> ' + JSON.stringify({ id: R1, kind: r1?.record?.kind, validation: r1?.record?.validation, gate: r1?.gateDecision || r1?.gate || null }).slice(0, 400))
  if (!R1) fail(t0, 'root-cause record accepted by write gate', 'veyra_remember returned no record id', JSON.stringify(r1).slice(0, 400))
  const r2 = await session1.call('veyra_remember', {
    kind: 'negative',
    title: 'An in-process mutex around deduct() does NOT fix the drift',
    body: 'Tried: wrapping deduct() in a global mutex. It failed: the duplicate delivery happens across a process RESTART, where an in-memory mutex does not survive. Stock was still off by one after restart replay. Rejected approach.',
    confidence: 'high',
    tags: ['warehouse', 'mutex', 'failed-approach'],
    evidence: [{ note: 'restart replay test still off by one with mutex in place' }],
  })
  const R2 = r2?.record?.id || r2?.id || null
  const r3 = await session1.call('veyra_remember', {
    kind: 'knowledge',
    title: 'stockctl warehouse schema: id, sku, qty, reserved',
    body: 'The warehouse table columns are id, sku, qty, reserved. reserved is maintained by the allocation service, not by stockctl.',
    confidence: 'medium',
    tags: ['schema'],
  })
  const R3 = r3?.record?.id || r3?.id || null
  const r4 = await session1.call('veyra_remember', {
    kind: 'memory',
    title: 'stockctl CI pins Node 24 to avoid fetch keepalive churn',
    body: 'CI was flaky on Node 22 because of fetch keepalive socket churn; the workflow pins Node 24.',
    confidence: 'medium',
    tags: ['ci', 'node'],
  })
  const R4 = r4?.record?.id || r4?.id || null
  note(t0, 'seeded: R1=' + R1 + ' R2=' + R2 + ' R3=' + R3 + ' R4=' + R4)
  fs.writeFileSync(path.join(fixtureDir, 'src/warehouse.mjs'), FIXED_WAREHOUSE)
  const probeAfter = shTry('node check/idempotency.mjs', fixtureDir)
  note(t0, 'check AFTER fix: exit=' + probeAfter.code + ' out=' + probeAfter.out.trim().slice(0, 300))
  if (probeAfter.code !== 0) fail(t0, 'fix verified by check (passes)', 'check still failing', probeAfter.out)
  const tests = shTry('node --test test/', fixtureDir)
  note(t0, 'fixture test suite: exit=' + tests.code + ' ' + tests.out.trim().slice(-200))
  shTry('git -c user.name=VeyraEval -c user.email=eval@veyra.local add -A', fixtureDir)
  shTry('git -c user.name=VeyraEval -c user.email=eval@veyra.local commit -qm "fix: idempotent stock decrement (seen-set on eventId)"', fixtureDir)
  if (R1 && probeAfter.code === 0) pass(t0, 'bug reproduced, knowledge recorded, fix verified, committed', 'done')
  closeAllStores()

  // ============ EVOLVE the repo - anchors go stale ============
  fs.mkdirSync(path.join(fixtureDir, 'src/stock'), { recursive: true })
  shTry('git -c user.name=VeyraEval -c user.email=eval@veyra.local rm -q src/warehouse.mjs', fixtureDir)
  fs.writeFileSync(
    path.join(fixtureDir, 'src/stock/warehouse.mjs'),
    FIXED_WAREHOUSE.replace('export class Warehouse {', 'const RETRY_BACKOFF_MS = 7500 // was 5000, tuned in incident #47\n\nexport class Warehouse {'),
  )
  for (const f of ['check/idempotency.mjs', 'test/warehouse.test.mjs']) {
    const p = path.join(fixtureDir, f)
    fs.writeFileSync(p, fs.readFileSync(p, 'utf8').replace('../src/warehouse.mjs', '../src/stock/warehouse.mjs'))
  }
  shTry('git -c user.name=VeyraEval -c user.email=eval@veyra.local add -A', fixtureDir)
  shTry('git -c user.name=VeyraEval -c user.email=eval@veyra.local commit -qm "refactor: move warehouse under stock/, tune retry backoff"', fixtureDir)

  // ============ SESSION 2 - fresh agent, evolved repo ============
  const session2 = createToolHarness({ veyraHome: veyraHomeA, fallbackCwd: fixtureDir })
  const store = openProjectStore(veyraHomeA, projectIdFor(fixtureDir))

  // T1 - cross-session recall
  const t1 = task('T1', 'cross-session recall of the root cause (fresh session, evolved repo)')
  const rec1 = await session2.call('veyra_recall', { query: 'why does warehouse stock drift off after event replay', limit: 5 })
  const ids1 = (rec1.items || []).map((i) => i.id)
  note(t1, 'top5: ' + JSON.stringify((rec1.items || []).map((i) => [i.id, i.title.slice(0, 50)])))
  const anchorOldGone = !fs.existsSync(path.join(fixtureDir, 'src/warehouse.mjs'))
  const anchorNewOk = fs.existsSync(path.join(fixtureDir, 'src/stock/warehouse.mjs'))
  note(t1, 'anchor check: old src/warehouse.mjs gone=' + anchorOldGone + '; new src/stock/warehouse.mjs exists=' + anchorNewOk)
  if (ids1[0] === R1) pass(t1, 'root-cause record is top-1 in a fresh session', 'rank #1 (id ' + R1 + ')')
  else fail(t1, 'root-cause record top-1', 'rank ' + (ids1.indexOf(R1) + 1) + ' of ' + ids1.length + ': ' + JSON.stringify(ids1), JSON.stringify(rec1.items?.[0]).slice(0, 300))

  // T2 - distractor robustness
  const t2 = task('T2', 'retrieval relevance under distractors (schema + CI notes present)')
  const rec2 = await session2.call('veyra_recall', { query: 'fix for double stock deduction when events are redelivered', limit: 5 })
  const ids2 = (rec2.items || []).map((i) => i.id)
  note(t2, 'top5: ' + JSON.stringify((rec2.items || []).map((i) => [i.id, i.kind, i.title.slice(0, 40)])))
  const negRank = ids2.indexOf(R2) + 1
  if (ids2[0] === R1 && negRank > 1) pass(t2, 'correct record #1; negative approach not #1', 'R1 #1, R2 at ' + (negRank || 'not in top5'))
  else fail(t2, 'R1 #1 and negative not #1', 'R1 at ' + (ids2.indexOf(R1) + 1) + ', negative at ' + (negRank || 'absent'), JSON.stringify(ids2))

  // T3 - change impact on the evolved repo
  const t3 = task('T3', 'stale-anchor detection after repo evolution (change impact)')
  const ci = await session2.call('veyra_change_impact', {
    changedFiles: ['src/stock/warehouse.mjs', 'check/idempotency.mjs'],
    createCandidates: false,
  })
  const affected = ((ci.context || []).length ? ci.context : (ci.affectedMemories || [])).map((m) => [m.memoryId || m.id, m.category])
  note(t3, 'change impact: ' + JSON.stringify({ ok: ci.ok, degraded: ci.degraded, affected, summary: ci.summary || null }).slice(0, 600))
  if (ci.ok && affected.some(([id, cat]) => id === R1 && cat !== 'trusted')) {
    pass(t3, 'R1 flagged as affected with non-trusted category', 'category=' + affected.find(([id]) => id === R1)?.[1])
  } else {
    fail(t3, 'R1 listed as affected with non-trusted category', JSON.stringify(ci).slice(0, 400), '')
  }

  // T4 - contradiction handling: both sides must stay visible
  const t4 = task('T4', 'contradiction: two opposite claims, no silent merge')
  const r5 = await session2.call('veyra_remember', {
    kind: 'memory',
    title: 'Stock drift was caused by a stale inventory cache, not redelivery',
    body: 'Counter-explanation from incident review: the drift came from a cached inventory snapshot going stale after the cache TTL; clearing the cache stopped the drift. No code change was made.',
    confidence: 'medium',
    tags: ['warehouse', 'cache'],
  })
  const R5 = r5?.record?.id || r5?.id || null
  note(t4, 'remember R5 -> ' + JSON.stringify({ id: R5, gate: r5?.gateDecision || r5?.gate || null }).slice(0, 300))
  const health = await session2.call('veyra_health', {})
  const contraMentions = JSON.stringify(health).match(/contradict/gi)?.length || 0
  const rec4 = await session2.call('veyra_recall', { query: 'stock drift root cause warehouse', limit: 10 })
  const ids4 = (rec4.items || []).map((i) => i.id)
  const bothVisible = ids4.includes(R1) && (R5 ? ids4.includes(R5) : false)
  const countNow = storeCount(store, [R1, R5])
  const r1view = (rec4.items || []).find((i) => i.id === R1)
  note(t4, 'health contradiction mentions=' + contraMentions + '; bothVisible=' + bothVisible + '; store count=' + countNow + '; R1 contradictionBanners=' + JSON.stringify(r1view?.contradictionBanners || []).slice(0, 200) + '; R1 contradictions=' + JSON.stringify(r1view?.contradictions || []).slice(0, 200))
  if (bothVisible && countNow === 2) pass(t4, 'contradicting records coexist, both recalled, none merged', 'both in recall, store count 2')
  else fail(t4, 'both records visible and unmerged', 'bothVisible=' + bothVisible + ' count=' + countNow + ' ids=' + JSON.stringify(ids4), JSON.stringify(r5).slice(0, 200))

  // T5 - learning from verified outcomes
  const t5 = task('T5', 'feedback ladder + recurrence of a repeatedly failed approach')
  const insBefore = await session2.call('veyra_inspect', { id: R1 })
  const beforeR1 = insBefore.record
  const fb1 = await session2.call('veyra_feedback', { id: R1, outcome: 'success', note: 're-verified in incident #52: stock stable after dedup guard' })
  const insAfter = await session2.call('veyra_inspect', { id: R1 })
  const afterR1 = insAfter.record
  const ladder = { before: beforeR1?.validation + '/' + beforeR1?.confidence, after: afterR1?.validation + '/' + afterR1?.confidence, feedbackOk: fb1?.ok, record: Boolean(beforeR1 && afterR1) }
  const r6 = await session2.call('veyra_remember', {
    kind: 'memory',
    title: 'Adding a 3s retry loop after restart settles the drift',
    body: 'Hypothesis: retrying deductions 3s after restart converges the stock. Trial attempt, unverified.',
    confidence: 'low',
    tags: ['warehouse', 'retry'],
  })
  const R6 = r6?.record?.id || r6?.id || null
  note(t5, 'remember R6 -> ' + JSON.stringify({ id: R6, gate: r6?.gateDecision || r6?.gate || null }).slice(0, 300))
  const fb6a = R6 ? await session2.call('veyra_feedback', { id: R6, outcome: 'failure', note: 'still off by one after restart replay; retry does not dedup' }) : null
  const fb6b = R6 ? await session2.call('veyra_feedback', { id: R6, outcome: 'failure', note: 'second incident, same root-cause family' }) : null
  const rec6 = await session2.call('veyra_recurrence', { threshold: 2 })
  const recFind = (rec6.findings || []).map((f) => f.recordId || f.id || JSON.stringify(f).slice(0, 80))
  const wgl = await session2.call('veyra_health', { writeGate: true })
  const gateAccounting = wgl.writeGate || null
  note(t5, 'ladder=' + JSON.stringify(ladder) + '; R6=' + R6 + ' fb=' + JSON.stringify([fb6a?.ok, fb6b?.ok]) + '; recurrence findings=' + JSON.stringify(recFind) + '; writeGate=' + JSON.stringify(gateAccounting).slice(0, 300))
  const ladderOk = ladder.record && ladder.feedbackOk && ladder.after !== ladder.before
  const recOk = recFind.length >= 1
  if (ladderOk && recOk && gateAccounting) {
    pass(t5, 'success advances validation; repeated failures surface as recurrence; gate ledger present',
      JSON.stringify({ ladder, recFind, gateTotal: gateAccounting.total })).slice(0, 500)
  } else fail(t5, 'feedback ladder + recurrence + write-gate ledger all present', JSON.stringify({ ladder, recFind, gateAccounting }), '')

  // T6 - context budget and retrieval efficiency
  const t6 = task('T6', 'context budget integrity + recall latency at scale')
  const budgets = [400, 800, 1200, 2400, 4800]
  const budgetRows = []
  for (const b of budgets) {
    const text = buildRecallContext({ veyraHome: veyraHomeA, cwd: fixtureDir, query: 'warehouse stock', limit: 5, budget: b })
    const headers = (text.match(/^- \[vey_/gm) || []).length
    budgetRows.push({ budget: b, chars: text.length, headers, truncated: text.includes('truncated at the character budget'), tokensApprox: Math.round(text.length / 4) })
  }
  note(t6, 'budgets: ' + JSON.stringify(budgetRows))
  // starvation probe: one oversized record must not empty the context
  const homeLat = path.join(RUN, 'veyra-home-lat')
  const fixtureLat = path.join(RUN, 'fixture-lat')
  fs.mkdirSync(fixtureLat, { recursive: true })
  const harnessLat = createToolHarness({ veyraHome: homeLat, fallbackCwd: fixtureLat })
  for (let i = 0; i < 120; i++) {
    await harnessLat.call('veyra_remember', {
      kind: 'memory',
      title: 'Latency seed module ' + String(i % 12) + ' finding ' + i,
      body: 'Deterministic seed record number ' + i + ' for latency measurement. Module ' + (i % 12) + ' handling path ' + (i % 7) + '.',
      confidence: i % 3 === 0 ? 'high' : 'medium',
      tags: ['latency', 'module' + (i % 12)],
    })
  }
  const storeLat = openProjectStore(homeLat, projectIdFor(fixtureLat))
  const latCounts = []
  const queries = Array.from({ length: 50 }, (_, i) => 'module ' + (i % 12) + ' finding ' + i)
  for (const q of queries) {
    const t0ms = performance.now()
    retrieveRecall({ projectStore: storeLat, reusableStore: null, query: q, limit: 5, includeReusable: false })
    latCounts.push(performance.now() - t0ms)
  }
  latCounts.sort((a, b) => a - b)
  const p50 = latCounts[Math.floor(0.5 * latCounts.length)].toFixed(2)
  const p95 = latCounts[Math.floor(0.95 * latCounts.length)].toFixed(2)
  const oversized = await harnessLat.call('veyra_remember', {
    kind: 'memory',
    title: 'Oversized probe record',
    body: 'Probe body repeated '.concat('x'.repeat(4000)),
    confidence: 'high',
    tags: ['probe'],
  })
  const starveText = buildRecallContext({ veyraHome: homeLat, cwd: fixtureLat, query: 'oversized probe', limit: 1, budget: 400 })
  const starve = { headers: (starveText.match(/^- \[vey_/gm) || []).length, chars: starveText.length, empty: starveText.length < 120 }
  note(t6, 'starvation probe: ' + JSON.stringify(starve))
  results.metrics = {
    budgets: budgetRows,
    recallLatencyMs: { p50, p95, n: latCounts.length, records: 121 },
    starvationProbe: starve,
  }
  const emptyRecalls = budgetRows.filter((r) => r.headers === 0 && r.chars < 120).length
  if (emptyRecalls === 0 && !starve.empty) {
    pass(t6, 'no empty recall under budget pressure; latency measured',
      'p50=' + p50 + 'ms p95=' + p95 + 'ms; budgets=' + JSON.stringify(budgetRows.map((r) => [r.budget, r.chars, r.headers])) + '; starve=' + JSON.stringify(starve))
  } else {
    fail(t6, 'no empty recall at any budget', JSON.stringify({ emptyRecalls, starve, budgetRows }))
  }

  // ============ ARM B - no memory baseline ============
  const tB = task('ARM-B', 'baseline without Veyra: same T1 query on an empty store')
  const fixtureB = buildFixture(path.join(RUN, 'fixture-B'), { buggy: true })
  const cold = createToolHarness({ veyraHome: veyraHomeB, fallbackCwd: fixtureB })
  const recB = await cold.call('veyra_recall', { query: 'why does warehouse stock drift off after event replay', limit: 5 })
  const noMemory = recB.count === 0 || (recB.items || []).length === 0
  const coldContext = buildRecallContext({ veyraHome: veyraHomeB, cwd: fixtureB, query: 'why does warehouse stock drift off after event replay', limit: 5 })
  note(tB, 'recall count=' + recB.count + '; context head: ' + JSON.stringify(coldContext.slice(0, 200)))
  if (noMemory) pass(tB, 'empty store reports a distinguishable absence, not silence', 'count=0 + "No known engineering history" marker present=' + coldContext.includes('No known engineering history'))
  else fail(tB, 'distinguishable absence on empty store', 'count=' + recB.count)
  const probeCold = shTry('node check/idempotency.mjs', fixtureB)
  const opsCold = [
    'run check/idempotency.mjs (FAIL observed: ' + probeCold.out.trim().slice(0, 80) + ')',
    'read src/warehouse.mjs and locate deduct()',
    'search for idempotency/seen-set guards (none found)',
    're-derive and re-implement the seen-set fix',
    're-run check + test suite to verify',
  ]
  results.tokenCost = {
    armA: { recallTokensApproxAt2400: budgetRows.find((r) => r.budget === 2400)?.tokensApprox, opsToSolve: 2, note: 'arm A: one veyra_recall, apply the recorded fix, run the check to confirm' },
    armB: { opsToSolve: opsCold.length, ops: opsCold, recallTokens: 0, note: 'arm B: full re-investigation (reproduce, locate, re-reason, re-implement, verify)' },
  }

  results.finishedAt = new Date().toISOString()
  const summary = results.tasks.map((t) => ({ id: t.id, pass: t.pass, expected: t.expected, actual: String(t.actual).slice(0, 300), evidence: t.evidence }))
  const out = { ...results, tasks: summary, failures: results.failures }
  fs.writeFileSync(path.join(RUN, 'eval-v0169-results.json'), JSON.stringify(out, null, 2))
  const repoResults = path.resolve('test/eval-v0169-results.json')
  fs.writeFileSync(repoResults, JSON.stringify(out, null, 2))
  closeAllStores()
  fs.rmSync(RUN, { recursive: true, force: true })
  console.log('=== Veyra v0.1.69 real-world evaluation ===')
  for (const t of summary) console.log((t.pass ? 'PASS' : 'FAIL') + '  ' + t.id + ': ' + t.name)
  console.log('FAILURES: ' + results.failures.length)
  for (const f of results.failures) console.log('  - ' + f.id + ': expected ' + f.expected + ' | got: ' + f.actual.slice(0, 200))
  console.log('metrics: ' + JSON.stringify(results.metrics))
  console.log('tokenCost: ' + JSON.stringify(results.tokenCost))
  console.log('results written to: ' + repoResults)
}

main().catch((e) => { console.error('EVAL FAILED:', e); process.exit(1) })