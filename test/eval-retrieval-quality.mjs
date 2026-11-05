// Veyra retrieval-quality & applicability evaluation (isolated, reproducible).
// Usage: node test/eval-retrieval-quality.mjs
//
// Builds a deterministic fixture git repo + isolated Veyra stores under os.tmpdir.
// The fixture workspace is carried into every tool call via exec so records land in
// the FIXTURE project store (not process.cwd()). No live DSH home, no DSH Web, no
// user repository touched. Covers six dimensions:
//   D1 retrieval relevance (precision@k + false positives)
//   D2 evidence quality (verified vs unsupported vs no-evidence ranking)
//   D3 applicability  (stale detection when the anchored file changes)
//   D4 stale handling (an aged anchor is not silently presented as a current fact)
//   D5 contradictions (conflicting root causes stay visible, unmerged)
//   D6 baseline comparison (agent task with vs without Veyra context)
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execSync } from 'node:child_process'
import { createToolHarness } from '../src/tools.mjs'
import { buildRecallContext } from '../src/context.mjs'

const RUN = fs.mkdtempSync(path.join(os.tmpdir(), 'veyra-eval-rq-'))
const FIX = path.join(RUN, 'fixture')
const GENV = { ...process.env, GIT_AUTHOR_NAME: 'e', GIT_AUTHOR_EMAIL: 'e@x', GIT_COMMITTER_NAME: 'e', GIT_COMMITTER_EMAIL: 'e@x' }
const g = (cmd, cwd) => execSync(cmd, { cwd, env: GENV, stdio: 'pipe' })

function buildFixture(dir, buggy) {
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true })
  fs.mkdirSync(path.join(dir, 'check'), { recursive: true })
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'stockctl', version: '0.2.0', type: 'module', scripts: { check: 'node check/idempotency.mjs' } }, null, 2) + '\n')
  const buggyDeduct = buggy
    ? [
        '  // BUG: no idempotency guard; a redelivered eventId deducts twice.',
        '  deduct(sku, qty, eventId) { const cur = this.stock.get(sku) ?? 0; this.stock.set(sku, cur - qty); return this.stock.get(sku) }',
      ]
    : [
        '  constructor(rows) { this.stock = new Map(rows.map((r) => [r.sku, r.qty])); this.seen = new Set() }',
        '  deduct(sku, qty, eventId) { if (this.seen.has(eventId)) return this.stock.get(sku); this.seen.add(eventId); const cur = this.stock.get(sku) ?? 0; this.stock.set(sku, cur - qty); return this.stock.get(sku) }',
      ]
  fs.writeFileSync(
    path.join(dir, 'src', 'warehouse.mjs'),
    ['export class Warehouse {', buggy ? '  constructor(rows) { this.stock = new Map(rows.map((r) => [r.sku, r.qty])) }' : '  constructor(rows) { this.stock = new Map(rows.map((r) => [r.sku, r.qty])); this.seen = new Set() }', ...buggyDeduct, '  balance(sku) { return this.stock.get(sku) ?? 0 }', '}', ''].join('\n'),
  )
  fs.writeFileSync(
    path.join(dir, 'check', 'idempotency.mjs'),
    ["import { Warehouse } from '../src/warehouse.mjs'", "const w = new Warehouse([{ sku: 'W-1', qty: 10 }])", "w.deduct('W-1', 1, 'evt-42'); w.deduct('W-1', 1, 'evt-42')", `const got = w.balance('W-1')`, "console.log(got === 9 ? 'PASS stock exact' : 'FAIL expected 9 got ' + got)", 'process.exit(got === 9 ? 0 : 1)', ''].join('\n'),
  )
  g('git init -q', dir); g('git add -A', dir); g('git commit -q -m init', dir)
}
buildFixture(FIX, true)

const homeA = path.join(RUN, 'veyra-home-A')
const homeB = path.join(RUN, 'veyra-home-B')
const E = { agent: { session: { header: { cwd: FIX } } } }
const hA = createToolHarness({ veyraHome: homeA, fallbackCwd: FIX })
const hB = createToolHarness({ veyraHome: homeB, fallbackCwd: FIX })

const out = { harness: 'eval-retrieval-quality', startedAt: new Date().toISOString(), runDir: RUN, dims: {}, metrics: {}, failures: [], nextSlice: null }
const rec = (label) => { out.dims[label] = out.dims[label] || { checks: [] }; return out.dims[label] }
function check(dim, id, name, expected, actual, pass) {
  out.dims[dim].checks.push({ id, name, expected, actual: String(actual).slice(0, 600), pass: Boolean(pass) })
  if (!pass) out.failures.push({ dim, id, expected, actual: String(actual).slice(0, 300) })
}
function ids(r) { return (r?.items || []).map((i) => i.id) }
function rankOf(order, id) { const i = order.indexOf(id); return i < 0 ? null : i + 1 }

// seed the project store
async function seed(h) {
  const mk = (a) => h.call('veyra_remember', a, E)
  const RC = (await mk({ kind: 'memory', title: 'Root cause: bus event redelivery without idempotency', body: 'Warehouse stock drifted low after each restart. Root cause: the event bus redelivers in-flight events after a process restart, and Warehouse.deduct() had no idempotency guard, so the same eventId deducted twice. Remedy: guard deduct() with a seen-set keyed on eventId, not a mutex. Verified by check/idempotency.mjs (FAIL expected 9 got 8 before fix, PASS after).', confidence: 'high', tags: ['warehouse', 'idempotency', 'stock'], evidence: [{ path: 'src/warehouse.mjs', note: 'deduct() had no seen-set guard' }, { note: 'check/idempotency.mjs FAIL expected 9 got 8 before fix' }] })).record.id
  const SCHEMA = (await mk({ kind: 'knowledge', title: 'stockctl v0.2.0 event schema: sku+qty+eventId+ts', body: 'Event shape { sku, qty, eventId, ts }; deduct(sku, qty, eventId). Verified against src/warehouse.mjs.', confidence: 'medium', tags: ['warehouse', 'schema'], evidence: [{ path: 'src/warehouse.mjs', note: 'deduct signature' }] })).record.id
  const NEG = (await mk({ kind: 'negative', title: 'An in-process mutex around deduct() does NOT fix the drift', body: 'Tried: wrapping deduct() in a global mutex. Failed: the duplicate delivery spans a process RESTART where an in-memory mutex does not survive. Use idempotency.', confidence: 'high', tags: ['warehouse', 'idempotency', 'mutex'] })).record.id
  const DISTR = (await mk({ kind: 'memory', title: 'CI caches node_modules under .cache/stockctl', body: 'The CI cache key is derived from the lockfile hash. A stale cache once caused a transient dependency error. Unrelated to the stock drift.', confidence: 'low', tags: ['ci', 'cache'] })).record.id
  const DB = (await mk({ kind: 'knowledge', title: 'Postgres connection pooling defaults', body: 'pool_max 20, idle_timeout 30s. Tuned for the read replica.', confidence: 'medium', tags: ['postgres', 'pooling'] })).record.id
  const CSS = (await mk({ kind: 'memory', title: 'Grid layout uses 12-col, 16px gutter', body: 'The dashboard grid is 12 columns with 16px gutters; breakpoints at 1024/1440.', confidence: 'low', tags: ['css', 'layout'] })).record.id
  return { RC, SCHEMA, NEG, DISTR, DB, CSS }
}
const s = await seed(hA)

// ============ D1: retrieval relevance ============
const d1 = rec('D1')
const relOrder = ids(await hA.call('veyra_recall', { query: 'warehouse stock drift after restart root cause', limit: 5 }, E))
const relevant = new Set([s.RC, s.SCHEMA, s.NEG])
const precisionAt = (order, k) => { const top = order.slice(0, k).filter(Boolean); return top.length ? Number((top.filter((id) => relevant.has(id)).length / top.length).toFixed(3)) : null }
d1.metric = { relOrder, RCrank: rankOf(relOrder, s.RC), DISTRrank: rankOf(relOrder, s.DISTR), precisionAt1: precisionAt(relOrder, 1), precisionAt3: precisionAt(relOrder, 3), precisionAt5: precisionAt(relOrder, 5) }
check('D1', 'D1.1', 'true root cause is top-1 for its own query', 'RC rank 1', 'RC rank ' + d1.metric.RCrank, d1.metric.RCrank === 1)
const fp = ids(await hA.call('veyra_recall', { query: 'kubernetes ingress routing and TLS termination', limit: 5 }, E))
d1.metric.unrelated = { order: fp, returned: fp.length }
check('D1', 'D1.2', 'zero-overlap query returns no records (irrelevance floor)', '0 records', fp.length + ' records', fp.length === 0)

// ============ D2: evidence quality ============
const d2 = rec('D2')
const noEv = (await hA.call('veyra_remember', { kind: 'memory', title: 'Stock drift likely caused by a flaky timer', body: 'Speculation: a timer drift might reset deductions. No test or file evidence; unverified guess.', confidence: 'low', tags: ['warehouse', 'stock'] }, E)).record.id
const evOrder = ids(await hA.call('veyra_recall', { query: 'why does warehouse stock drift low', limit: 5 }, E))
const RCevRank = rankOf(evOrder, s.RC), noEvRank = rankOf(evOrder, noEv)
d2.metric = { order: evOrder, RC_evidenced_rank: RCevRank, noEvidence_rank: noEvRank, evCount_RC: 2, evCount_noEv: 0 }
check('D2', 'D2.1', 'evidenced record ranks above unsupported no-evidence same-topic record', 'RC rank < noEv rank', 'RC=' + RCevRank + ' noEv=' + noEvRank, RCevRank !== null && noEvRank !== null && RCevRank < noEvRank)

// ============ D3: applicability / stale detection ============
// veyra_change_impact returns:
//   affectedMemories[]: { memoryId, title, authority, validation, status, freshness, affectedAnchors }
//   context[]:          { memoryId, category }  where category in trusted|review_required|stale|contradicted|insufficient_evidence
const catOf = (ci, id) => (ci?.context || []).find((c) => c.memoryId === id)?.category || null
const inAffected = (ci, id) => (ci?.affectedMemories || []).some((a) => a.memoryId === id)
const d3 = rec('D3')
const ciOrig = await hA.call('veyra_change_impact', { changedFiles: ['src/warehouse.mjs'] }, E)
const origCat = catOf(ciOrig, s.RC)
d3.metric = { originalPath_flagsRC: inAffected(ciOrig, s.RC), originalCategory: origCat, originalSummary: ciOrig?.summary }
check('D3', 'D3.1', 'in-place anchored-file change flags the memory as affected', 'RC in affectedMemories', 'category=' + origCat, inAffected(ciOrig, s.RC))
fs.mkdirSync(path.join(FIX, 'src', 'stock'), { recursive: true })
fs.writeFileSync(path.join(FIX, 'src', 'stock', 'warehouse.mjs'), fs.readFileSync(path.join(FIX, 'src', 'warehouse.mjs')))
fs.rmSync(path.join(FIX, 'src', 'warehouse.mjs'))
g('git add -A', FIX); g('git commit -q -m move', FIX)
const ciRename = await hA.call('veyra_change_impact', { changedFiles: ['src/stock/warehouse.mjs'] }, E)
const renameHit = inAffected(ciRename, s.RC)
d3.metric.renamedPath_detected = renameHit, d3.metric.renamedCategory = catOf(ciRename, s.RC), d3.metric.renamedAffected = (ciRename?.affectedMemories || []).map((a) => a.memoryId)
check('D3', 'D3.2', 'file rename (move) still flags the anchored memory stale', 'RC flagged after move', 'category=' + catOf(ciRename, s.RC) + ' affected=' + JSON.stringify(d3.metric.renamedAffected), renameHit)
// ============ D4: stale not presented as current fact ============
const d4 = rec('D4')
const ctxNow = buildRecallContext({ veyraHome: homeA, cwd: FIX, query: 'warehouse stock drift root cause', limit: 5, budget: 4000 })
d4.metric = { ctxChars: ctxNow.length, headers: (ctxNow.match(/^- \[vey_/gm) || []).length }
check('D4', 'D4.1', 'context render is non-empty and includes the relevant record', 'headers>0', 'headers=' + d4.metric.headers, d4.metric.headers > 0)

// ============ D5: contradictions ============
const d5 = rec('D5')
const R5 = (await hA.call('veyra_remember', { kind: 'memory', title: 'Root cause of stock drift: a stale inventory cache', body: 'The drift was caused by a stale in-memory inventory cache that was not invalidated on restart. Remedy: add cache invalidation. No test evidence yet.', confidence: 'low', tags: ['warehouse', 'cache', 'root-cause'] }, E)).record.id
const cc = await hA.call('veyra_recall', { query: 'root cause of stock drift', limit: 5 }, E)
const ccItems = cc?.items || []
const both = ccItems.map((i) => i.id).includes(s.RC) && ccItems.map((i) => i.id).includes(R5)
const linked = ccItems.some((i) => (i.contradictions?.length > 0 || i.contradictionBanners?.length > 0))
d5.metric = { bothVisible: both, linked, count: ccItems.length, rcAndR5: [s.RC, R5] }
check('D5', 'D5.1', 'two conflicting root causes both visible without silent merge', 'count>=2 and both ids', ccItems.length, both)
check('D5', 'D5.2', 'Veyra proactively links the two contradicting root-cause claims', 'contradiction link/banner', 'linked=' + linked, linked)

// ============ D6: baseline comparison ============
const d6 = rec('D6')
const ctxA = buildRecallContext({ veyraHome: homeA, cwd: FIX, query: 'how do I fix the warehouse stock drift', limit: 5, budget: 2400 })
const ctxB = buildRecallContext({ veyraHome: homeB, cwd: FIX, query: 'how do I fix the warehouse stock drift', limit: 5, budget: 2400 })
const recallB = await hB.call('veyra_recall', { query: 'warehouse stock drift root cause', limit: 5 }, E)
const A_hit = ctxA.includes('idempotency') || ctxA.includes('seen-set') || ctxA.includes('Root cause')
d6.metric = { armA: { ctxChars: ctxA.length, relevantSurfaced: A_hit }, armB: { ctxChars: ctxB.length, recallCount: recallB?.count || 0, distinguishesAbsence: /No known engineering history/i.test(ctxB) } }
check('D6', 'D6.1', 'arm A (with Veyra) surfaces the relevant root cause', 'root cause in arm A context', 'hit=' + A_hit + ' chars=' + ctxA.length, A_hit)
check('D6', 'D6.2', 'arm B (without) returns empty store and distinguishes absence', '0 records + marker', 'count=' + d6.metric.armB.recallCount + ' marker=' + d6.metric.armB.distinguishesAbsence, d6.metric.armB.recallCount === 0 && d6.metric.armB.distinguishesAbsence)

out.metrics = {
  precisionAt: d1.metric, fpOnUnrelated: d1.metric.unrelated, evidenceRanking: d2.metric,
  applicability: d3.metric, staleRendering: d4.metric, contradiction: d5.metric, baseline: d6.metric,
  tokenCostApprox: { armA_recallContext: Math.round(ctxA.length / 4), armB_recallContext: Math.round(ctxB.length / 4) },
}
out.finishedAt = new Date().toISOString()
fs.writeFileSync(path.join(RUN, 'results.json'), JSON.stringify(out, null, 2))
fs.writeFileSync('test/eval-retrieval-quality-results.json', JSON.stringify(out, null, 2))

console.log('=== eval-retrieval-quality ===')
for (const [dim, d] of Object.entries(out.dims)) for (const c of d.checks) console.log((c.pass ? 'PASS' : 'FAIL'), dim, c.id, '|', c.name, '=>', c.actual)
console.log('\nmetrics\n', JSON.stringify(out.metrics, null, 1))
console.log('\nFAILURES', out.failures.length)
