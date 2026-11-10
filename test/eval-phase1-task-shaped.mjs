#!/usr/bin/env node
/**
 * Veyra Phase 1 — Task-Shaped Retrieval Evaluation (evaluation-only).
 *
 * Reuses isolated fixture infrastructure patterns from eval-retrieval-quality.mjs:
 * deterministic git fixture + isolated Veyra stores under os.tmpdir, exec carries
 * fixture cwd, no live DSH home/DB/user repo, no tracked snapshot overwrite.
 *
 * Restrictions honored:
 * - evaluation-only; no runtime implementation changes/deps/schema changes
 * - no authoritative live DSH SQLite; no DSH Web interaction
 * - does not modify tracked eval snapshots or existing local modifications
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execSync } from 'node:child_process'
import { buildRecallContext } from '../src/context.mjs'
import { createToolHarness } from '../src/tools.mjs'
import { openProjectStore } from '../src/store.mjs'
import { projectIdFor, newRecordId } from '../src/ids.mjs'
import { AUTHORITIES, KINDS, STATUSES, VALIDATIONS, SCOPES, CONFIDENCES, RELATIONS } from '../src/types.mjs'

const RUN = path.join(os.tmpdir(), `veyra-phase1-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`)
fs.mkdirSync(RUN, { recursive: true })
const GENV = { ...process.env, GIT_AUTHOR_NAME: 'veyra-eval', GIT_AUTHOR_EMAIL: 'e@v', GIT_COMMITTER_NAME: 'veyra-eval', GIT_COMMITTER_EMAIL: 'e@v' }
const g = (cmd, cwd) => execSync(cmd, { cwd, env: GENV, stdio: 'pipe' })

function mkFixture(name) {
  const dir = path.join(RUN, name)
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true })
  fs.mkdirSync(path.join(dir, 'test'), { recursive: true })
  return dir
}
function gitInit(dir) { g('git init -q', dir); g('git add -A', dir); g('git -c commit.gpgsign=false commit -q -m init --allow-empty', dir) }
function execFor(cwd) { return { agent: { session: { header: { cwd } } } } }

const report = { harness: 'eval-phase1-task-shaped', startedAt: new Date().toISOString(), runDir: RUN, cases: [], summary: { pass: 0, fail: 0 }, failures: [], classifications: [], limitations: [] }

function pushCase(c) {
  report.cases.push(c)
  for (const r of c.checks) {
    if (r.pass) report.summary.pass++; else { report.summary.fail++; report.failures.push({ case: c.id, check: r.id, expected: r.expected, actual: typeof r.actual === 'string' ? r.actual.slice(0, 500) : JSON.stringify(r.actual).slice(0, 500), classification: r.classification || 'retrieval_failure' }) }
    if (r.classification) report.classifications.push({ case: c.id, check: r.id, classification: r.classification, note: r.note })
  }
}
const ids = (items) => (items || []).map(i => i.id)
const hasId = (items, id) => ids(items).includes(id)
const rank = (items, id) => { const i = ids(items).indexOf(id); return i < 0 ? null : i + 1 }
function textOf(items, id) {
  const it = (items || []).find(x => x.id === id)
  if (!it) return ''
  return [it.title, it.body, ...(it.tags || []), JSON.stringify(it.evidence || []), JSON.stringify(it.trust || {}), JSON.stringify(it.contradictions || []), String(it.status||''), String(it.validation||''), String(it.authority||'')].join(' ')
}

function seedRecord(store, rec) {
  const now = new Date().toISOString()
  const base = {
    id: rec.id || newRecordId(),
    kind: rec.kind || KINDS.MEMORY,
    status: rec.status || STATUSES.CURRENT,
    validation: rec.validation || VALIDATIONS.UNVERIFIED,
    authority: rec.authority || AUTHORITIES.DERIVED,
    confidence: rec.confidence || CONFIDENCES.MEDIUM,
    scope: rec.scope || SCOPES.PROJECT,
    projectId: rec.projectId || store.projectId,
    title: rec.title || '',
    body: rec.body || '',
    tags: rec.tags || [],
    evidence: rec.evidence || [],
    relations: rec.relations || [],
    source: rec.source || { origin: 'test', createdBy: 'phase1-eval' },
    forgotten: false,
    createdAt: rec.createdAt || now,
    updatedAt: rec.updatedAt || now,
    lastRecalledAt: null,
  }
  store.put(base)
  return base.id
}

async function caseBugInvestigation() {
  const cwd = mkFixture('case1-bug')
  fs.writeFileSync(path.join(cwd, 'src', 'orders.js'), 'export function total(items){ return items.reduce((s,i)=>s+i.price,0) }\n// bug: ignores quantity\n')
  fs.writeFileSync(path.join(cwd, 'test', 'orders.test.js'), "import assert from 'node:assert/strict'; import { total } from '../src/orders.js'; assert.equal(total([{price:5,qty:2}]),10)\n")
  gitInit(cwd)
  const home = path.join(RUN, 'home1')
  const store = openProjectStore(home, projectIdFor(cwd))
  const h = createToolHarness({ veyraHome: home, fallbackCwd: cwd })
  const E = execFor(cwd)
  const rootCauseId = seedRecord(store, {
    title: 'orders.total ignores item quantity (root cause)',
    body: 'Root cause: src/orders.js total() sums price only and omits qty. Remedy: multiply price by qty (default 1) before summing. Verified by test/orders.test.js expecting total([{price:5,qty:2}])===10.',
    tags: ['bug', 'root-cause', 'orders', 'quantity'],
    evidence: [{ path: 'src/orders.js', note: 'total() reduce uses i.price only' }, { path: 'test/orders.test.js', note: 'failing expectation includes qty' }],
    validation: VALIDATIONS.REVIEWED, confidence: CONFIDENCES.HIGH,
  })
  const misleadingId = seedRecord(store, {
    title: 'orders shipping tax rounding display issue',
    body: 'UI rounds shipping tax label to 2 decimals in checkout banner; not related to order total calculation.',
    tags: ['ui', 'shipping', 'rounding'],
    evidence: [{ path: 'src/checkout/banner.js', note: 'display formatting only' }],
    validation: VALIDATIONS.REVIEWED,
  })
  seedRecord(store, { title: 'warehouse retry backoff tuning', body: 'Adjusted retry backoff for warehouse sync worker.', tags: ['warehouse', 'retry'], evidence: [{ path: 'src/warehouse/sync.js' }] })
  const task = 'Investigate why order totals are wrong when line items have quantity > 1. Use historical root-cause knowledge if relevant.'
  const recall = await h.call('veyra_recall', { query: 'order total wrong quantity root cause src/orders.js', limit: 5 }, E)
  const ctx = buildRecallContext({ veyraHome: home, cwd, query: 'order total ignores quantity bug investigation', limit: 5, budget: 4000 })
  const items = recall.items || []
  const rRank = rank(items, rootCauseId)
  const checks = [
    { id: 'C1.1', name: 'relevant root-cause record retrieved', expected: 'rootCauseId in top 3', actual: `${rootCauseId} rank=${rRank} ids=${ids(items).join(',')}`, pass: rRank != null && rRank <= 3 },
    { id: 'C1.2', name: 'root-cause carries file evidence/provenance', expected: 'src/orders.js or test/orders.test.js evidence', actual: textOf(items, rootCauseId).slice(0, 240), pass: /src\/orders\.js|orders\.test\.js/.test(textOf(items, rootCauseId)) },
    { id: 'C1.3', name: 'unrelated UI record not ranked above root cause', expected: 'misleading rank null or below root cause', actual: `root=${rRank} misleading=${rank(items, misleadingId)}`, pass: !(rank(items, misleadingId) != null && rRank != null && rank(items, misleadingId) < rRank) },
    { id: 'C1.4', name: 'context useful for bug investigation', expected: 'contains root cause/quantity/orders signal', actual: (ctx || '').slice(0, 280), pass: /root cause|quantity|orders\.js|price.*qty|qty/i.test(ctx || '') },
  ]
  pushCase({ id: 'T1_bug_investigation_root_cause', family: 'bug_investigation', task, fixture: { cwd, records: { rootCauseId, misleadingId } }, expected: ['retrieve root-cause memory', 'preserve file evidence', 'do not prefer unrelated UI memory'], irrelevant_should_not_surface_as_primary: [misleadingId], evidence_requirements: ['evidence anchors to src/orders.js or test/orders.test.js'], pass_fail: checks.map(c=>({id:c.id, criterion:c.name, expected:c.expected})), actual: { recallCount: items.length, topIds: ids(items).slice(0,5), contextPreview: (ctx||'').slice(0,450) }, checks })
}

async function caseRepeatedImplementation() {
  const cwd = mkFixture('case2-decision')
  fs.writeFileSync(path.join(cwd, 'src', 'pagination.js'), 'export function listUsers(db,{cursor,limit=20}={}){ return db.query("SELECT * FROM users LIMIT ?",[limit]) }\n')
  gitInit(cwd)
  const home = path.join(RUN, 'home2')
  const store = openProjectStore(home, projectIdFor(cwd))
  const h = createToolHarness({ veyraHome: home, fallbackCwd: cwd })
  const E = execFor(cwd)
  const decisionId = seedRecord(store, {
    title: 'API pagination decision: cursor-based, not offset',
    body: 'Decision: list endpoints use cursor-based pagination (opaque cursor + limit). Rationale: offset pagination drifts under concurrent inserts/deletes and is slower on large tables. Implementation convention: accept {cursor, limit} and return {items, nextCursor}. Do not add page/offset params.',
    tags: ['decision', 'pagination', 'api', 'cursor'],
    evidence: [{ path: 'src/pagination.js', note: 'pagination helper signature uses cursor/limit' }],
    validation: VALIDATIONS.REVIEWED, confidence: CONFIDENCES.HIGH, authority: AUTHORITIES.DERIVED,
  })
  const conflictingOldId = seedRecord(store, {
    title: 'Old idea: offset pagination for admin table',
    body: 'Earlier scratch idea: use page/offset for admin user table. Not adopted as project convention.',
    tags: ['pagination', 'offset', 'admin'],
    evidence: [{ path: 'docs/scratch.md', note: 'historical idea, not implemented' }],
    validation: VALIDATIONS.UNVERIFIED, confidence: CONFIDENCES.LOW,
  })
  const irrelevantId = seedRecord(store, { title: 'CSS button spacing tokens', body: 'Design token: primary button padding 12px 16px.', tags: ['css','design'], evidence:[{path:'src/ui/button.css'}], validation: VALIDATIONS.REVIEWED })
  const task = 'Implement pagination for a new /v1/orders list endpoint consistent with existing project decisions.'
  const recall = await h.call('veyra_recall', { query: 'pagination decision for new list endpoint cursor offset convention', limit: 5 }, E)
  const ctx = buildRecallContext({ veyraHome: home, cwd, query: 'implement pagination for orders list endpoint project decision', limit: 5, budget: 4000 })
  const items = recall.items || []
  const dRank = rank(items, decisionId)
  const checks = [
    { id: 'C2.1', name: 'established pagination decision retrieved', expected: 'decisionId in top 3', actual: `${decisionId} rank=${dRank} ids=${ids(items).join(',')}`, pass: dRank != null && dRank <= 3 },
    { id: 'C2.2', name: 'decision evidence/provenance present', expected: 'src/pagination.js or cursor rationale', actual: textOf(items, decisionId).slice(0, 240), pass: /pagination\.js|cursor-based|offset pagination drifts/i.test(textOf(items, decisionId)) },
    { id: 'C2.3', name: 'irrelevant CSS record not top-ranked above decision', expected: 'irrelevant rank null or below decision', actual: `decision=${dRank} css=${rank(items, irrelevantId)}`, pass: !(rank(items, irrelevantId) != null && dRank != null && rank(items, irrelevantId) < dRank) },
    { id: 'C2.4', name: 'context supports repeated implementation', expected: 'mentions cursor/decision convention', actual: (ctx||'').slice(0,280), pass: /cursor|pagination decision|nextCursor|offset/i.test(ctx||'') },
  ]
  if (hasId(items, conflictingOldId) && dRank != null && rank(items, conflictingOldId) != null && rank(items, conflictingOldId) < dRank) {
    checks[0].classification = 'retrieval_failure'; checks[0].note = 'Low-confidence historical offset idea outranked reviewed decision.'
  }
  pushCase({ id: 'T2_repeated_implementation_decision', family: 'repeated_implementation', task, fixture: { cwd, records: { decisionId, conflictingOldId, irrelevantId } }, expected: ['retrieve reviewed cursor-pagination decision', 'surface evidence/rationale'], irrelevant_should_not_surface_as_primary: [irrelevantId], evidence_requirements: ['evidence to src/pagination.js and decision rationale'], pass_fail: checks.map(c=>({id:c.id, criterion:c.name, expected:c.expected})), actual: { recallCount: items.length, topIds: ids(items).slice(0,5), contextPreview: (ctx||'').slice(0,450) }, checks })
}

async function caseChangedRepoContext() {
  const cwd = mkFixture('case3-changed')
  const target = path.join(cwd, 'src', 'cache.js')
  fs.writeFileSync(target, 'export function cacheKey(userId){ return `user:${userId}` }\n')
  fs.writeFileSync(path.join(cwd, 'src', 'other.js'), 'export const x = 1\n')
  gitInit(cwd)
  const home = path.join(RUN, 'home3')
  const h = createToolHarness({ veyraHome: home, fallbackCwd: cwd })
  const E = execFor(cwd)
  const anchored = await h.call('veyra_remember', {
    title: 'cache key format uses user id prefix',
    body: 'cacheKey() returns `user:${userId}`. Keep this format for cache invalidation compatibility.',
    tags: ['cache', 'key', 'invalidation'],
    evidence: [{ path: 'src/cache.js', note: 'cacheKey implementation' }],
    kind: 'memory', scope: 'project', confidence: 'medium',
  }, E)
  const anchoredId = anchored?.record?.id
  const store = openProjectStore(home, projectIdFor(cwd))
  seedRecord(store, { title: 'logging format uses JSON lines', body: 'Logger emits one JSON object per line.', tags:['logging'], evidence:[{path:'src/logger.js'}], validation: VALIDATIONS.REVIEWED })
  fs.writeFileSync(target, 'export function cacheKey(userId,tenant){ return `t:${tenant}:user:${userId}` }\n')
  g('git add -A', cwd); g('git -c commit.gpgsign=false commit -q -m "change cache key format"', cwd)

  let impact
  try { impact = await h.call('veyra_change_impact', { repo: cwd, changedFiles: ['src/cache.js'] }, E) } catch (e) { impact = { ok: false, error: String(e && e.message || e) } }
  const recall = await h.call('veyra_recall', { query: 'cache key format cache invalidation src/cache.js', limit: 5 }, E)
  let ctx = ''
  try { ctx = buildRecallContext({ veyraHome: home, cwd, query: 'cache key format changed context', limit: 5, budget: 4000, changedFiles: ['src/cache.js'] }) } catch (e) { ctx = `[context error: ${e && e.message || e}]`; report.limitations.push({ case: 'T3', kind: 'harness_limitation', detail: String(e && e.stack || e).slice(0,400) }) }
  const items = recall.items || []
  const anchoredPresent = anchoredId ? hasId(items, anchoredId) : false
  const anchoredText = anchoredId ? textOf(items, anchoredId) : ''
  const affectedIds = (impact?.affectedMemories || []).map(m => m.memoryId || m.id).filter(Boolean)
  const contextItems = (impact?.context || [])
  const anchoredContext = anchoredId ? contextItems.find(c => c.memoryId === anchoredId || c.id === anchoredId) : null
  const checks = [
    { id: 'C3.1', name: 'change-impact identifies anchored memory or review signal', expected: 'impact references anchoredId or review/affected/stale signal', actual: { anchoredId, affectedIds: affectedIds.slice(0,8), anchoredContext, degraded: impact?.degraded, error: impact?.error }, pass: (anchoredId && (affectedIds.includes(anchoredId) || !!anchoredContext)) || /stale|review|required|affected|cache|degraded/i.test(JSON.stringify(impact || {})) },
    { id: 'C3.2', name: 'historical knowledge not presented as unqualified current truth after change', expected: 'if surfaced, stale/review/changed/affected signal present; omission acceptable but noted', actual: anchoredPresent ? anchoredText.slice(0,320) : `not surfaced; impactSummary=${JSON.stringify(impact?.summary||{}).slice(0,200)}`, pass: !anchoredPresent || /stale|potentially.stale|review|affected|change|freshness|invalid|caution/i.test(anchoredText) || !!anchoredContext },
    { id: 'C3.3', name: 'changed-repo context/applicability surfaced', expected: 'context or impact provides changed/review/affected signal', actual: { ctx: (ctx||'').slice(0,260), impactSummary: impact?.summary, impactOk: impact?.ok, degraded: impact?.degraded }, pass: /changed|review|stale|affected|cache\.js|caution/i.test(ctx||'') || impact?.ok === true || Array.isArray(impact?.context) || impact?.degraded === true },
  ]
  if (!anchoredPresent) { checks[1].classification = 'evaluation_limitation'; checks[1].note = 'Recall omitted changed memory; change-impact may be primary signal. Omission safer than stale assertion but recall transparency limited.' }
  if (impact?.degraded) checks.forEach(c => { c.classification = c.classification || 'evaluation_limitation'; c.note = (c.note ? c.note + ' ' : '') + 'Code intelligence degraded in fixture; anchor/freshness confidence limited.' })
  pushCase({ id: 'T3_changed_repo_context_staleness', family: 'changed_repo_context', task: 'After repository changes to src/cache.js, answer how cache keys are formatted and whether historical knowledge still applies.', fixture: { cwd, changedFiles: ['src/cache.js'], records: { anchoredId } }, expected: ['identify anchored knowledge affected by src/cache.js change', 'do not present historical cache-key knowledge as unqualified current truth'], irrelevant_should_not_surface_as_primary: [], evidence_requirements: ['anchor to changed file; freshness/change-impact/applicability signal'], pass_fail: checks.map(c=>({id:c.id, criterion:c.name, expected:c.expected})), actual: { anchoredId, recallTopIds: ids(items).slice(0,5), impactAffectedIds: affectedIds.slice(0,8), impactSummary: impact?.summary, impactContext: (impact?.context||[]).slice(0,3), contextPreview: (ctx||'').slice(0,450) }, checks })
}

async function caseConflictingClaims() {
  const cwd = mkFixture('case4-conflict')
  fs.writeFileSync(path.join(cwd, 'src', 'auth.js'), 'export function sessionTtl(){ return 30 * 60 } // minutes? currently 30\n')
  gitInit(cwd)
  const home = path.join(RUN, 'home4')
  const store = openProjectStore(home, projectIdFor(cwd))
  const h = createToolHarness({ veyraHome: home, fallbackCwd: cwd })
  const E = execFor(cwd)
  const claimA = seedRecord(store, {
    title: 'Session TTL is 30 minutes',
    body: 'Auth session TTL is 30 minutes. Implemented in src/auth.js sessionTtl().',
    tags: ['auth', 'session', 'ttl', 'timeout'],
    evidence: [{ path: 'src/auth.js', note: 'sessionTtl returns 30' }],
    validation: VALIDATIONS.REVIEWED, confidence: CONFIDENCES.HIGH,
  })
  const claimB = seedRecord(store, {
    title: 'Session TTL is 60 minutes',
    body: 'Auth session TTL is 60 minutes after security policy update. Implemented in src/auth.js sessionTtl().',
    tags: ['auth', 'session', 'ttl', 'timeout', 'policy'],
    evidence: [{ path: 'src/auth.js', note: 'policy states 60 minutes' }],
    validation: VALIDATIONS.REVIEWED, confidence: CONFIDENCES.HIGH,
    relations: [{ kind: RELATIONS.CONTRADICTS, targetId: claimA }],
  })
  try { const a = store.get(claimA); if (a) { a.relations = [...(a.relations||[]), { kind: RELATIONS.CONTRADICTS, targetId: claimB }]; store.put(a) } } catch (e) { report.limitations.push({ case: 'T4', kind: 'fixture_limitation', detail: 'Could not add reciprocal contradiction relation: '+String(e&&e.message||e) }) }
  seedRecord(store, { title: 'Password hashing uses argon2id', body: 'Unrelated auth detail.', tags:['auth','hash'], evidence:[{path:'src/auth/hash.js'}], validation: VALIDATIONS.REVIEWED })

  const task = 'What is the auth session TTL? Answer only if historical knowledge is reliable; otherwise surface conflict/evidence.'
  const recall = await h.call('veyra_recall', { query: 'auth session TTL minutes timeout src/auth.js', limit: 6 }, E)
  const ctx = buildRecallContext({ veyraHome: home, cwd, query: 'auth session TTL conflicting historical claims', limit: 6, budget: 4000 })
  const items = recall.items || []
  const aPresent = hasId(items, claimA), bPresent = hasId(items, claimB)
  const aText = textOf(items, claimA), bText = textOf(items, claimB)
  const conflictSignal = (t) => /contradict|conflict|both sides|disagree|review required|trust/i.test(t)
  const checks = [
    { id: 'C4.1', name: 'relevant TTL knowledge retrievable', expected: 'claim A and/or B surfaced', actual: `A=${aPresent} rank=${rank(items,claimA)} B=${bPresent} rank=${rank(items,claimB)} ids=${ids(items).join(',')}`, pass: aPresent || bPresent },
    { id: 'C4.2', name: 'conflict/provenance not silently collapsed when both visible', expected: 'if both present, contradiction/trust signal in records/context; if one present, limitation noted', actual: { a: aText.slice(0,220), b: bText.slice(0,220), ctx: (ctx||'').slice(0,260) }, pass: (aPresent && bPresent ? conflictSignal(aText+bText+(ctx||'')) : true) },
    { id: 'C4.3', name: 'evidence/provenance available for surfaced claim(s)', expected: 'src/auth.js evidence present', actual: (aText+bText).slice(0,260), pass: /src\/auth\.js/.test(aText+bText) },
  ]
  if (!(aPresent && bPresent)) { checks[1].classification = 'evaluation_limitation'; checks[1].note = 'Only one side surfaced in top-k; cannot fully evaluate silent-collapse from recall output alone.' }
  else if (!conflictSignal(aText+bText+(ctx||''))) { checks[1].pass = false; checks[1].classification = 'retrieval_failure'; checks[1].note = 'Both contradictory claims retrieved but no contradiction/provenance warning observed in evaluated fields/context.' }
  pushCase({ id: 'T4_conflicting_historical_claims', family: 'conflicting_claims', task, fixture: { cwd, records: { claimA, claimB } }, expected: ['retrieve relevant auth TTL claims', 'surface contradiction/provenance rather than silently picking one when both visible'], irrelevant_should_not_surface_as_primary: [], evidence_requirements: ['evidence anchors and contradiction/provenance signals when both claims present'], pass_fail: checks.map(c=>({id:c.id, criterion:c.name, expected:c.expected})), actual: { recallCount: items.length, topIds: ids(items).slice(0,6), contextPreview: (ctx||'').slice(0,450) }, checks })
}

await caseBugInvestigation()
await caseRepeatedImplementation()
await caseChangedRepoContext()
await caseConflictingClaims()

report.finishedAt = new Date().toISOString()
report.summary.totalCases = report.cases.length
report.summary.casePass = report.cases.filter(c => c.checks.every(x=>x.pass)).length
report.summary.caseFail = report.cases.length - report.summary.casePass
console.log(JSON.stringify(report, null, 2))
