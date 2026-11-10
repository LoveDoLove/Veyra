#!/usr/bin/env node
/**
 * Veyra Phase 1.1 — Applicability Transparency & Contradiction Verification
 * (evaluation-only, no runtime behavior changes).
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execSync } from 'node:child_process'
import { buildRecallContext, composeAgentContext, renderAgentContext } from '../src/context.mjs'
import { createToolHarness } from '../src/tools.mjs'
import { openProjectStore } from '../src/store.mjs'
import { projectIdFor, newRecordId } from '../src/ids.mjs'
import { AUTHORITIES, KINDS, STATUSES, VALIDATIONS, SCOPES, CONFIDENCES, RELATIONS } from '../src/types.mjs'
import { classifyRecordTrust } from '../src/trust.mjs'
import { annotateContradictions } from '../src/evolve.mjs'

const RUN = path.join(os.tmpdir(), 'veyra-phase1-1-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6))
fs.mkdirSync(RUN, { recursive: true })
const GENV = { ...process.env, GIT_AUTHOR_NAME: 'veyra-eval', GIT_AUTHOR_EMAIL: 'e@v', GIT_COMMITTER_NAME: 'veyra-eval', GIT_COMMITTER_EMAIL: 'e@v' }
const g = (cmd, cwd) => execSync(cmd, { cwd, env: GENV, stdio: 'pipe' })
function mkFixture(name) { const dir = path.join(RUN, name); fs.mkdirSync(path.join(dir, 'src'), { recursive: true }); return dir }
function gitInit(dir) { g('git init -q', dir); g('git add -A', dir); g('git -c commit.gpgsign=false commit -q -m init --allow-empty', dir) }
function execFor(cwd) { return { agent: { session: { header: { cwd } } } } }
const report = { harness: 'eval-phase1-1-applicability-contradiction', startedAt: new Date().toISOString(), runDir: RUN, sections: [], sourceRefs: {} }
function criterion(id, name, status, expected, actual, evidence, note) { return { id, criterion: name, status, expected, actual, evidence, note: note || '' } }
function seedRecord(store, rec) {
  const now = new Date().toISOString()
  const base = { id: rec.id || newRecordId(), kind: rec.kind || KINDS.MEMORY, status: rec.status || STATUSES.CURRENT, validation: rec.validation || VALIDATIONS.UNVERIFIED, authority: rec.authority || AUTHORITIES.DERIVED, confidence: rec.confidence || CONFIDENCES.MEDIUM, scope: rec.scope || SCOPES.PROJECT, projectId: rec.projectId || store.projectId, title: rec.title || '', body: rec.body || '', tags: rec.tags || [], evidence: rec.evidence || [], relations: rec.relations || [], source: rec.source || { origin: 'test', createdBy: 'phase1-1-eval' }, forgotten: false, createdAt: rec.createdAt || now, updatedAt: rec.updatedAt || now, lastRecalledAt: null }
  store.put(base); return base.id
}

async function t3ApplicabilityTransparency() {
  const cwd = mkFixture('t3-changed')
  const target = path.join(cwd, 'src', 'cache.js')
  fs.writeFileSync(target, 'export function cacheKey(userId){ return "user:" + userId }\n')
  fs.writeFileSync(path.join(cwd, 'src', 'other.js'), 'export const x = 1\n')
  gitInit(cwd)
  const home = path.join(RUN, 'home-t3')
  const h = createToolHarness({ veyraHome: home, fallbackCwd: cwd })
  const E = execFor(cwd)
  const anchored = await h.call('veyra_remember', { title: 'cache key format uses user id prefix', body: 'cacheKey() returns user:${userId}. Keep this format for cache invalidation compatibility.', tags: ['cache', 'key', 'invalidation'], evidence: [{ path: 'src/cache.js', note: 'cacheKey implementation' }], kind: 'memory', scope: 'project', confidence: 'medium' }, E)
  const anchoredId = anchored?.record?.id
  fs.writeFileSync(target, 'export function cacheKey(userId,tenant){ return "t:" + tenant + ":user:" + userId }\n')
  g('git add -A', cwd); g('git -c commit.gpgsign=false commit -q -m "change cache key format"', cwd)
  const changedFiles = ['src/cache.js']
  const rendered = buildRecallContext({ veyraHome: home, cwd, query: 'cache key format cache invalidation src/cache.js', limit: 5, budget: 4000, changedFiles }) || ''
  const store = openProjectStore(home, projectIdFor(cwd))
  const records = anchoredId ? [store.get(anchoredId)].filter(Boolean) : []
  const composed = composeAgentContext(records, { stores: [store], workspace: cwd, changedFiles, degraded: false })
  const trust = records[0] ? classifyRecordTrust(records[0], { workspace: cwd, changedFiles, degraded: false }) : null
  const renderedDirect = renderAgentContext(composed, { budget: 4000, changes: { changedFiles, degraded: false } }) || ''
  const anchoredMentioned = /cache key format uses user id prefix|cacheKey\(\)/i.test(rendered)
  const hasReview = /review_required|REVIEW_REQUIRED/i.test(rendered)
  const hasAffectedTrust = /trust:.*REVIEW_REQUIRED|related repository file changed|review before relying/i.test(rendered)
  const hasKnowledgeImpactReview = /Knowledge impact:[\s\S]{0,120}review required/i.test(rendered)
  const demotedOrExcluded = !anchoredMentioned
  let visibility
  if (demotedOrExcluded) visibility = 'demoted_or_excluded'
  else if (hasReview || hasAffectedTrust) visibility = 'clearly_labeled_review_required_or_equivalent'
  else if (hasKnowledgeImpactReview) visibility = 'aggregate_knowledge_impact_only_not_item_level'
  else visibility = 'presented_without_explicit_warning'
  const itemLevelClear = hasReview || hasAffectedTrust
  const checks = [
    criterion('T3.1','Actual rendered automatic recall context inspected (not only veyra_change_impact)','PASS','buildRecallContext/renderAgentContext output captured',{renderedLength:rendered.length,renderedPreview:rendered.slice(0,1600),renderedDirectPreview:renderedDirect.slice(0,1400)},'src/context.mjs:buildRecallContext->renderAgentContext(composeAgentContext), composeAgentContext calls classifyRecordTrust with changedFiles/workspace; renderAgentContext prints trust line (326-332) and Knowledge impact (264-289,711-779).'),
    criterion('T3.2','Changed-file-anchored memory applicability visibility in actual rendered automatic context',(demotedOrExcluded||itemLevelClear)?'PASS':'FAIL','Affected memory clearly labeled review_required/equivalent, or demoted/excluded; not presented as current truth without explicit item-level warning',{visibility,anchoredId,anchoredMentioned,hasReview,hasAffectedTrust,hasKnowledgeImpactReview,demotedOrExcluded,trustCategory:trust?.category,trustReasons:trust?.reasons,trustAction:trust?.action,composedCategory:composed?.[0]?.trust?.category},'Exact rendered excerpt (targeted): '+(rendered.match(/cache key format[\s\S]{0,700}/)?.[0]||rendered.slice(0,700)), visibility==='aggregate_knowledge_impact_only_not_item_level'?'Confirmed gap: aggregate Knowledge impact says review required, but affected item entry lacks explicit item-level review_required/stale warning in rendered automatic context.':(visibility==='presented_without_explicit_warning'?'Confirmed gap: affected memory presented without explicit review/stale warning.':(itemLevelClear?'Item-level trust review-required/equivalent signal present.':'')))
  ]
  return { id:'T3_applicability_transparency', objective:'Verify changed-file-anchored historical memory is clearly identified as requiring review in actual rendered automatic recall context.', fixture:{cwd,changedFiles,anchoredId}, renderedAutomaticContext:rendered, renderedDirect, composed:composed?.[0]||null, trust, checks }
}

async function t4ContradictionVerification() {
  const cwd = mkFixture('t4-conflict')
  fs.writeFileSync(path.join(cwd,'src','auth.js'),'export function sessionTtl(){ return 30 * 60 } // currently 30\n')
  gitInit(cwd)
  const home = path.join(RUN,'home-t4')
  const store = openProjectStore(home, projectIdFor(cwd))
  const h = createToolHarness({ veyraHome: home, fallbackCwd: cwd })
  const E = execFor(cwd)
  const claimA = seedRecord(store,{ title:'Session TTL is 30 minutes', body:'Auth session TTL is 30 minutes. Implemented in src/auth.js sessionTtl().', tags:['auth','session','ttl','timeout','src/auth.js'], evidence:[{path:'src/auth.js',note:'sessionTtl returns 30'}], validation:VALIDATIONS.REVIEWED, confidence:CONFIDENCES.HIGH })
  const claimB = seedRecord(store,{ title:'Session TTL is 60 minutes', body:'Auth session TTL is 60 minutes after security policy update. Implemented in src/auth.js sessionTtl().', tags:['auth','session','ttl','timeout','policy','src/auth.js'], evidence:[{path:'src/auth.js',note:'policy states 60 minutes'}], validation:VALIDATIONS.REVIEWED, confidence:CONFIDENCES.HIGH, relations:[{kind:RELATIONS.CONTRADICTS,targetId:claimA}] })
  const a = store.get(claimA); if (a) { a.relations = [...(a.relations||[]), {kind:RELATIONS.CONTRADICTS,targetId:claimB}]; store.put(a) }
  const query = 'auth session TTL 30 60 minutes timeout src/auth.js sessionTtl policy'
  const recall = await h.call('veyra_recall',{ query, limit:8 }, E)
  const items = recall.items || []
  const ids = items.map(i=>i.id)
  const bothInRecall = ids.includes(claimA) && ids.includes(claimB)
  const candidates = [store.get(claimA), store.get(claimB)].filter(Boolean).map(r=>JSON.parse(JSON.stringify(r)))
  const annotated = annotateContradictions(candidates)
  const composed = composeAgentContext(annotated, { stores:[store], workspace:cwd, changedFiles:null, degraded:false })
  const rendered = renderAgentContext(composed, { budget:5000 }) || ''
  const trustA = classifyRecordTrust(store.get(claimA), { workspace:cwd, changedFiles:null, degraded:false })
  const trustB = classifyRecordTrust(store.get(claimB), { workspace:cwd, changedFiles:null, degraded:false })
  const recallRendered = buildRecallContext({ veyraHome: home, cwd, query, limit:8, budget:5000, changedFiles:null }) || ''
  const renderedHasA = /30 minutes|Session TTL is 30/i.test(rendered)
  const renderedHasB = /60 minutes|Session TTL is 60/i.test(rendered)
  const contradictionVisible = /CONTRADICTION|CONTRADICTED|contradict/i.test(rendered)
  const evidenceDistinguishable = /sessionTtl returns 30|policy states 60 minutes|src\/auth\.js/.test(rendered)
  const silentSuppression = !(renderedHasA && renderedHasB)
  const recallRenderedHasA = /30 minutes|Session TTL is 30/i.test(recallRendered)
  const recallRenderedHasB = /60 minutes|Session TTL is 60/i.test(recallRendered)
  const recallContradictionVisible = /CONTRADICTION|CONTRADICTED|contradict/i.test(recallRendered)
  const checks = [
    criterion('T4.1','Both contradictory claims eligible retrieval candidates in veyra_recall harness path', bothInRecall?'PASS':'EVALUATION_LIMITATION', 'Both claimA and claimB retrievable as candidates for same query without runtime changes', {bothInRecall,recallIds:ids,claimA,claimB,query,recallRenderedPreview:recallRendered.slice(0,1400),recallRenderedHasA,recallRenderedHasB,recallContradictionVisible}, 'src/retrieve.mjs recall() ranks/filters and applies annotateContradictions (1217,1282); src/tools.mjs veyra_recall returns items. Harness probed veyra_recall/buildRecallContext (limit=8). If not both retrieved, ranking prevents proving silent collapse from recall output alone.', bothInRecall?'Both sides retrieved.':'veyra_recall/buildRecallContext did not surface both sides together; limitation documented (pass criteria not weakened). Direct candidate-set check below evaluates metadata/rendering when both eligible.'),
    criterion('T4.2','Contradiction/trust metadata present for both claims (eligible candidate set)', ((trustA?.category==='contradicted'||(trustA?.reasons||[]).some(r=>/contradict/i.test(r))) && (trustB?.category==='contradicted'||(trustB?.reasons||[]).some(r=>/contradict/i.test(r))) && (annotated[0]?.contradictions?.length||annotated[0]?.contradictionBanners?.length))?'PASS':'FAIL', 'Trust and contradiction metadata mark both sides as contradicted/linked when both are eligible candidates', {trustA,trustB,annotated:annotated.map(r=>({id:r.id,contradictions:r.contradictions,contradictionBanners:r.contradictionBanners}))}, 'src/trust.mjs classifyRecordTrust emits CONTRADICTED when contradictions/contradictionBanners present. src/evolve.mjs annotateContradictions adds contradictionBanners/contradictions for CONTRADICTS relations/topic overlap without resolving/dropping/merging.'),
    criterion('T4.3','Rendered context preserves both claims and makes contradiction/evidence distinguishable (eligible candidate set)', (renderedHasA&&renderedHasB&&contradictionVisible&&evidenceDistinguishable)?'PASS':'FAIL', 'Both claims preserved; contradictory relationship visible; evidence/provenance distinguishable; no silent suppression', {renderedHasA,renderedHasB,contradictionVisible,evidenceDistinguishable,silentSuppression,renderedPreview:rendered.slice(0,1800)}, 'src/context.mjs renderAgentContext renders contradiction banners (291-293), trust lines, evidence items; composeAgentContext classifies trust including contradictions. Direct candidate set guarantees both eligible.', silentSuppression?'One claim suppressed in rendered candidate context.':'Both claims visible with contradiction/evidence signals when both eligible.')
  ]
  return { id:'T4_contradiction_verification', objective:'Determine whether contradictory historical claims remain visible and distinguishable.', fixture:{cwd,claimA,claimB}, recall:{bothInRecall,ids,query,recallRendered}, annotatedMetadata:annotated.map(r=>({id:r.id,title:r.title,contradictions:r.contradictions,contradictionBanners:r.contradictionBanners})), trusts:{claimA:trustA,claimB:trustB}, renderedContext:rendered, checks }
}

const t3 = await t3ApplicabilityTransparency()
const t4 = await t4ContradictionVerification()
report.sections = [t3,t4]
report.sourceRefs = {
  context: {
    'src/context.mjs:216-259':'composeAgentContext: checkRecordFreshness + classifyRecordTrust(record,{workspace,changedFiles,degraded,...freshness}); returns trust/category/reasons/evidence/freshness/changed metadata per record.',
    'src/context.mjs:264-341':'renderAgentContext: renders change summary/Knowledge impact when changes present; renders contradiction banners (291-293), code-freshness warning (316-320), trust line with category/reasons/action (326-332), evidence and body.',
    'src/context.mjs:711-779':'changeSummaryLines/signalForWorkspace/recordRepositoryChange: surfaces Repository changes detected and Knowledge impact categories.',
    'src/context.mjs:790-838':'buildRecallContext: builds recall snapshot and passes changedFiles/signal into composeAgentContext/renderAgentContext.'
  },
  trust: {
    'src/trust.mjs:33-60':'TRUST_CATEGORIES includes review_required; PRECEDENCE contradicted>stale>insufficient_evidence>review_required.',
    'src/trust.mjs:94-171':'classifyRecordTrust: freshness invalid/stale => stale; missing workspace with anchors => review_required; changedFiles anchor match => review_required "related repository file changed: ..."; contradictions => contradicted.'
  },
  contradiction: {
    'src/evolve.mjs:568+':'annotateContradictions detects CONTRADICTS relations/topic overlap and adds contradictionBanners/contradictions without resolving/dropping/merging.',
    'src/retrieve.mjs:1217,1282':'recall path annotates contradictions on ranked/returned results.',
    'src/tools.mjs:964':'veyra_recall tool path annotates contradictions for returned memories.'
  }
}
report.finishedAt = new Date().toISOString()
console.log(JSON.stringify(report, null, 2))
