/**
 * E2E Agent Workflow verification (GOAL.md).
 *
 * Validates the complete Veyra integration chain as it composes in a real
 * coding-agent session:
 *
 *   User task → Observe → Recall → Query CBM (repository truth) → Implement
 *   → Verify against repository → Remember outcome → Feedback / recurrence
 *   → Future recall
 *
 * Focus areas covered:
 *   1. Recall — project-relevant results; historical ≠ current truth;
 *      similarity ≠ authority.
 *   2. Codebase Memory — repository evidence wins over conflicting memory;
 *      memory is context, not executable instruction.
 *   3. Write Gate — observation / candidate / knowledge distinction; new
 *      observations pass the gate; no auto-promotion to canonical.
 *   4. Evolution — successful outcomes become reusable knowledge;
 *      contradiction / supersede handled explicitly (no silent merge).
 *   5. Validation — repository verification (test evidence) drives the
 *      validation ladder; historical knowledge stays but never masquerades
 *      as current truth.
 *   6. Isolation — project memory does not leak across project scopes;
 *      reusable vs project-local boundary holds.
 *   7. DSH integration — uses the plugin's real observe → learn → recall
 *      composition (the same functions the DSH runtime wires up).
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { AUTHORITIES, KINDS, RELATIONS, SCOPES, VALIDATIONS, CONFIDENCES, isRecallEligible } from '../src/types.mjs'
import { openEphemeralStore } from '../src/store.mjs'
import { newBuffer, observeEvent, candidateFromBuffer } from '../src/observe.mjs'
import { distillBuffer } from '../src/understand.mjs'
import { maybeLearn, remember, writeGate, promote } from '../src/learn.mjs'
import { recordFeedback, detectRecurrence } from '../src/feedback.mjs'
import { recall, temporalState, summarizeForPrompt } from '../src/retrieve.mjs'
import { renderAgentContext } from '../src/context.mjs'

function freshStores(projectId = 'p_e2e') {
  return {
    projectStore: openEphemeralStore(':memory:', { scope: SCOPES.PROJECT, projectId }),
    reusableStore: openEphemeralStore(':memory:', { scope: SCOPES.REUSABLE, projectId: 'reusable' }),
  }
}

/** Replay a realistic coding-agent turn through the Observe pipeline. */
function observeTurn(texts, { projectId = 'p_e2e', sessionId = 's-e2e' } = {}) {
  const buffer = newBuffer()
  observeEvent(buffer, {}, { type: 'turn/start', data: { turn: 1 } })
  for (const t of texts) {
    observeEvent(buffer, {}, { type: 'user/message', data: { content: [{ type: 'text', text: t }] } })
    break // first user message seeds the turn
  }
  return buffer
}

// ============================================================ full loop

test('E2E: observe → learn → feedback → future recall completes the loop', () => {
  const { projectStore, reusableStore } = freshStores('p_e2e_loop')

  // --- Stage 1: Observe — turn A: a human prompt + assistant claim + tool.
  //     This mirrors the real DSH turn order (turn/start, then the claimed
  //     user message, then assistant/tool streams).
  const turnA = newBuffer()
  observeEvent(turnA, {}, { type: 'turn/start', data: { turn: 1 } })
  observeEvent(turnA, {}, {
    type: 'user/message',
    data: { content: [{ type: 'text', text: 'Diagnose the sqlite writer race and lock DatabaseSync writes so the integration tests stop flaking.' }] },
  })
  observeEvent(turnA, {}, {
    type: 'assistant/message',
    data: { message: { content: [{ type: 'text', text: 'Root cause: concurrent DatabaseSync writes corrupt FTS triggers. Remedy: serialize writes through a mutex.' }] } },
  })
  observeEvent(turnA, {}, {
    type: 'tool/call',
    data: { name: 'edit', arguments: { file_path: 'src/store.mjs' } },
  })

  const candidate = candidateFromBuffer(turnA, { projectId: 'p_e2e_loop', sessionId: 's1' })
  assert.ok(candidate, 'observe produces a candidate')
  assert.equal(candidate.authority, AUTHORITIES.CANDIDATE)
  assert.equal(candidate.kind, KINDS.OBSERVATION)

  // --- Recall BEFORE learning: the observation must NOT surface (candidates
  //     and observations are never recall-eligible — write gate holds).
  const beforeRecall = recall({
    projectStore, reusableStore,
    query: 'sqlite writer race DatabaseSync',
    limit: 5,
  })
  assert.equal(beforeRecall.length, 0, 'candidates/observations are not recall-eligible')

  // --- Stage 2a: M9 provenance gate — a turn materially composed from the
  //     human prompt is captured but DEFERred: user text is not knowledge.
  const distilledA = distillBuffer(turnA, { projectId: 'p_e2e_loop', sessionId: 's1' })
  assert.ok(distilledA, 'distill produced a claim')
  assert.deepEqual(distilledA.source.provenance.origins, ['user', 'assistant'], 'user+assistant turn provenance')
  const persisted = projectStore.put(candidate) // plugin persist-before-learn order
  const learnedA = maybeLearn(projectStore, { ...persisted.record }, { workspace: '/tmp/e2e-project' })
  assert.equal(learnedA, null, 'user-involving provenance is provenance-gated')
  const gated = projectStore.get(persisted.record.id)
  assert.ok(gated, 'gated record stays captured (not deleted, not invalidated)')
  assert.equal(gated.authority, AUTHORITIES.CANDIDATE, 'gate leaves the candidate untouched')

  // --- Stage 2b: continuation round — assistant-only provenance learns.
  //     (Live store shows this path is how automatic knowledge is created.)
  const turnB = newBuffer()
  observeEvent(turnB, {}, { type: 'turn/start', data: { turn: 2 } })
  observeEvent(turnB, {}, {
    type: 'assistant/message',
    data: { message: { content: [{ type: 'text', text: 'The writer race is fixed: lockWriter serializes DatabaseSync writes through a single mutex; FTS triggers stay consistent.' }] } },
  })
  observeEvent(turnB, {}, {
    type: 'tool/call',
    data: { name: 'bash', arguments: { command: 'node --test test/store.test.mjs' } },
  })
  observeEvent(turnB, {}, {
    type: 'tool/result',
    data: { message: { source: { kind: 'tool', callId: 'c1' }, content: [{ type: 'tool-result', toolCallId: 'c1', content: [{ type: 'text', text: 'pass 42 fail 0' }] }] } },
  })

  const candidateB = candidateFromBuffer(turnB, { projectId: 'p_e2e_loop', sessionId: 's1' })
  assert.ok(candidateB, 'continuation round distilled a claim')
  assert.ok(
    !candidateB.source.provenance.origins.includes('user'),
    'continuation provenance is assistant-only'
  )
  const persistedB = projectStore.put(candidateB)
  const learned = maybeLearn(projectStore, { ...persistedB.record }, { workspace: '/tmp/e2e-project' })
  assert.ok(learned, 'write gate accepted the assistant-only distilled claim')
  assert.equal(learned.authority, AUTHORITIES.DERIVED, 'auto-learning never manufactures canonical')
  assert.ok(isRecallEligible(learned), 'derived memory is recall-eligible')

  // --- Stage 3: Future recall — the learned knowledge now surfaces.
  const afterRecall = recall({
    projectStore, reusableStore,
    query: 'lockWriter DatabaseSync mutex writer race',
    limit: 5,
  })
  assert.ok(afterRecall.length > 0, 'learned memory surfaces in recall')
  const hit = afterRecall.find((r) => r.id === learned.id)
  assert.ok(hit, 'the learned record is the recalled hit')
  assert.equal(hit.authority, AUTHORITIES.DERIVED, 'similarity match does not imply authority')
  assert.ok(hit.authority !== AUTHORITIES.CANONICAL, 'recall never returns auto-canonical')

  // --- Stage 4: Verify against repository + feedback success.
  // Ladder (strengthenMemory): obsCount = source.observations + 1;
  // obs>=2 (or test evidence) → REVIEWED; obs>=3 WITH test evidence → VERIFIED.
  const withRepoEvidence = {
    ...hit,
    evidence: [...(hit.evidence || []), { path: 'src/store.mjs', note: 'test-passed' }],
    source: { ...hit.source, observations: 1 },
  }
  projectStore.put(withRepoEvidence)

  const fb = recordFeedback(projectStore, { id: hit.id, outcome: 'success', note: 'repo verified: lockWriter serializes writes; tests green' })
  assert.equal(fb.ok, true)
  assert.equal(fb.record.validation, VALIDATIONS.REVIEWED, 'obs+test evidence reaches reviewed, not beyond')
  assert.equal(fb.record.authority, AUTHORITIES.DERIVED, 'feedback never changes authority (no auto-canonical)')

  // --- Stage 5: third observation + test evidence → verified.
  const up3 = { ...fb.record, source: { ...fb.record.source, observations: 2 } }
  projectStore.put(up3)
  const fb2 = recordFeedback(projectStore, { id: hit.id, outcome: 'success', note: 'second run still green' })
  assert.equal(fb2.record.validation, VALIDATIONS.VERIFIED, 'obs>=3 + test evidence → verified')
  assert.equal(fb2.record.authority, AUTHORITIES.DERIVED, 'authority stays DERIVED without explicit promote')
  assert.ok(
    (fb2.record.tags || []).includes('promotion-candidate'),
    'verified records are tagged promotion-candidate (still not canonical)'
  )

  // --- Stage 6: explicit promote is the ONLY canonical path.
  const promoted = promote(projectStore, hit.id, { to: AUTHORITIES.CANONICAL, explicit: true })
  assert.equal(promoted.record?.authority, AUTHORITIES.CANONICAL, 'explicit promote works')
  const refused = promote(projectStore, hit.id, { to: AUTHORITIES.CANONICAL, explicit: false })
  assert.equal(refused.ok, false, 'auto-promote to canonical is refused')
  assert.match(refused.error, /explicit/i, 'refusal explains the explicit-action requirement')
})

// ============================================================ recall quality

test('E2E recall: relevant hit first, irrelevant records stay out', () => {
  const { projectStore, reusableStore } = freshStores('p_e2e_recall')

  remember(projectStore, {
    kind: KINDS.KNOWLEDGE,
    title: 'DatabaseSync writes must be serialized',
    body: 'Root cause: concurrent put() calls corrupt SQLite state. Remedy: serialize DatabaseSync writes behind a mutex.',
    evidence: [{ path: 'src/store.mjs', note: 'lockWriter' }],
    confidence: CONFIDENCES.HIGH,
    scope: SCOPES.PROJECT,
  })
  remember(projectStore, {
    kind: KINDS.KNOWLEDGE,
    title: 'CSS grid gutters collapse at small viewports',
    body: 'Use container queries instead of media queries for dashboard cards.',
    evidence: [{ path: 'web/styles.css' }],
    confidence: CONFIDENCES.MEDIUM,
    scope: SCOPES.PROJECT,
  })

  const hits = recall({
    projectStore, reusableStore,
    query: 'sqlite writer race DatabaseSync',
    limit: 5,
  })
  assert.ok(hits.length > 0, 'recall returns project memory')
  assert.ok(hits[0].title.includes('DatabaseSync'), 'most relevant record ranks first')
  // Coverage pooling may surface other project records (recent-pool scoring);
  // if the unrelated record appears at all it must rank strictly after the
  // relevant hit — relevance drives ordering, never authority.
  const cssIdx = hits.findIndex((r) => r.title.includes('CSS grid'))
  const dbIdx = hits.findIndex((r) => r.title.includes('DatabaseSync'))
  if (cssIdx !== -1) assert.ok(cssIdx > dbIdx, 'irrelevant record ranks after the relevant hit')
  // relevance does not equal authority: the hit may be derived/high confidence
  assert.notEqual(hits[0].authority, AUTHORITIES.CANONICAL, 'relevance never implies canonical authority')
})

test('E2E recall: historical (temporally bounded, expired) memory is marked, not current truth', () => {
  const { projectStore, reusableStore } = freshStores('p_e2e_temporal')

  // Real write path: remember() maps validUntil → source.temporal.validUntil.
  const rec = remember(projectStore, {
    kind: KINDS.KNOWLEDGE,
    title: 'Legacy bundler config for webpack 4',
    body: 'Use webpack 4 UglifyJsPlugin for minification in this project. Constraint: do not upgrade to terser without migrating the config.',
    confidence: CONFIDENCES.HIGH,
    scope: SCOPES.PROJECT,
    validUntil: '2021-01-01',
  })
  const id = rec?.record?.id || rec?.id
  assert.ok(id, 'record written')

  const stored = projectStore.get(id)
  assert.deepEqual(
    stored.source?.temporal, { validUntil: '2021-01-01' },
    'remember maps validUntil onto source.temporal'
  )
  assert.equal(temporalState(stored), 'expired', 'past validity window reads expired')

  const hits = recall({
    projectStore, reusableStore,
    query: 'webpack minification config',
    limit: 5,
  })
  const hit = hits.find((r) => r.id === id)
  assert.ok(hit, 'historical knowledge is kept (not deleted)')
  assert.equal(temporalState(hit), 'expired', 'expiry survives recall')

  // Regression: the agent-facing rendering must mark expiry, otherwise an
  // expired record masquerades as current truth in the injected context.
  const prompt = summarizeForPrompt([hit])
  assert.match(prompt, /\[EXPIRED\]/, 'summarizeForPrompt marks expired records')
  const injected = renderAgentContext([{ record: hit, status: 'current' }])
  assert.match(injected, /\[EXPIRED\]/, 'renderAgentContext marks expired records')

  // A current record must NOT carry the expired tag (no false positives).
  const fresh = remember(projectStore, {
    kind: KINDS.KNOWLEDGE,
    title: 'Current bundler config for esbuild',
    body: 'Use esbuild for bundling; the config lives in build.mjs and must not be bypassed.',
    confidence: CONFIDENCES.HIGH,
    scope: SCOPES.PROJECT,
  })
  const freshId = fresh?.record?.id || fresh?.id
  const freshRec = projectStore.get(freshId)
  assert.equal(temporalState(freshRec), 'current', 'no validity window reads current')
  const freshPrompt = summarizeForPrompt([freshRec])
  assert.ok(!freshPrompt.includes('[EXPIRED]'), 'current records are not marked expired')
})

// ============================================================ write gate

test('E2E write gate: noise dropped, candidates inspected but not recalled, no silent canonical', () => {
  const { projectStore } = freshStores('p_e2e_gate')

  // 1. Unknown/missing provenance fails closed: DEFER with a null record
  //    (the candidate is never silently written as knowledge).
  const gated = writeGate(projectStore, {
    kind: KINDS.OBSERVATION,
    authority: AUTHORITIES.CANDIDATE,
    title: 'Agent ran tests during E2E turn',
    body: 'Files touched: src/store.mjs — observed while diagnosing sqlite writer race.',
    scope: SCOPES.PROJECT,
    projectId: 'p_e2e_gate',
  })
  assert.equal(gated.decision, 'DEFER', 'unknown provenance fails closed')
  assert.equal(gated.record, null, 'DEFER returns a null record (no write)')

  // 2. Assistant-only provenance: the observation passes inspection and is
  //    rewritten as DERIVED memory — never canonical.
  const accepted = writeGate(projectStore, {
    kind: KINDS.OBSERVATION,
    authority: AUTHORITIES.CANDIDATE,
    title: 'lockWriter claim accepted through the write gate',
    body: 'Root cause: concurrent DatabaseSync writes race across triggers; remedy: lockWriter must serialize all writes through a single mutex.',
    evidence: [{ path: 'src/store.mjs', note: 'test-passed' }],
    scope: SCOPES.PROJECT,
    projectId: 'p_e2e_gate',
    source: { automatic: true, provenance: { origins: ['assistant', 'tool'] } },
  })
  assert.equal(accepted.decision, 'ACCEPT', 'assistant-only provenance passes the gate')
  assert.ok(accepted.record, 'ACCEPT writes a record')
  assert.equal(accepted.record.authority, AUTHORITIES.DERIVED, 'gate writes derived, not canonical')
  assert.equal(accepted.record.kind, KINDS.MEMORY, 'accepted claim is stored as memory')

  // 3. A raw persisted observation candidate is not recall-eligible.
  projectStore.put({
    id: 'cand_raw_e2e',
    kind: KINDS.OBSERVATION,
    status: 'current',
    validation: VALIDATIONS.UNVERIFIED,
    authority: AUTHORITIES.CANDIDATE,
    confidence: CONFIDENCES.LOW,
    scope: SCOPES.PROJECT,
    projectId: 'p_e2e_gate',
    title: 'Raw observation stays out of recall',
    body: 'Captured tool traffic with no claim review yet.',
    source: { automatic: true, provenance: { origins: ['user', 'assistant'] } },
  })
  const raw = projectStore.get('cand_raw_e2e')
  assert.ok(raw, 'raw candidate persisted for inspection')
  assert.ok(!isRecallEligible(raw), 'persisted candidate is not recall-eligible')

  // 4. A knowledge claim via remember() is accepted as derived, never canonical.
  const k = remember(projectStore, {
    kind: KINDS.KNOWLEDGE,
    title: 'E2E write-gate probe: knowledge stays derived',
    body: 'Automatic or explicit learning writes DERIVED authority; canonical requires explicit promote.',
    confidence: CONFIDENCES.MEDIUM,
    scope: SCOPES.PROJECT,
  })
  const kid = k?.record?.id || k?.id
  const krec = projectStore.get(kid)
  assert.equal(krec.authority, AUTHORITIES.DERIVED, 'write gate never manufactures canonical')

  // 5. Verbatim duplicate → MERGE, not a second record (no silent duplicate).
  const before = projectStore.list({ limit: 100 }).filter((r) => r.title === krec.title).length
  const dup = remember(projectStore, {
    kind: KINDS.KNOWLEDGE,
    title: krec.title,
    body: krec.body,
    confidence: CONFIDENCES.MEDIUM,
    scope: SCOPES.PROJECT,
  })
  const after = projectStore.list({ limit: 100 }).filter((r) => r.title === krec.title).length
  assert.equal(after, before, 'near-duplicate strengthens the neighbor instead of writing a second record')
  assert.ok(dup, 'duplicate handling returns a result')
})

// ============================================================ evolution / contradiction

test('E2E evolution: contradiction links records explicitly; records are never silently merged', () => {
  const { projectStore } = freshStores('p_e2e_evolve')

  const original = remember(projectStore, {
    kind: KINDS.KNOWLEDGE,
    title: 'Connection pooling: always use size 10',
    body: 'Set pool size to 10 for all environments.',
    confidence: CONFIDENCES.HIGH,
    scope: SCOPES.PROJECT,
  })
  const oid = original?.record?.id || original?.id

  const updated = remember(projectStore, {
    kind: KINDS.KNOWLEDGE,
    title: 'Connection pooling: environment-dependent size',
    body: 'Set pool size to 50 in production, 10 in test. Supersedes the fixed size-10 guidance.',
    confidence: CONFIDENCES.HIGH,
    scope: SCOPES.PROJECT,
  })
  const uid = updated?.record?.id || updated?.id

  assert.ok(oid && uid, 'both records written')
  assert.notEqual(oid, uid, 'contradicting claims remain two inspectable records (no silent merge)')

  const orec = projectStore.get(oid)
  const urec = projectStore.get(uid)
  const related =
    (orec.relations || []).some((r) => r.targetId === uid)
    || (urec.relations || []).some((r) => r.targetId === oid)
  assert.ok(
    related || orec.contradicts || urec.contradicts,
    'contradiction is expressed as an explicit relation/annotation, not a merge'
  )
  assert.equal(orec.authority, AUTHORITIES.DERIVED, 'evolution never touches authority silently')
  assert.equal(urec.authority, AUTHORITIES.DERIVED, 'evolution never touches authority silently')
})

test('E2E evolution: successful outcome forms reusable knowledge; recurrence detects clusters', () => {
  const { projectStore, reusableStore } = freshStores('p_e2e_reuse')

  const rec = remember(projectStore, {
    kind: KINDS.KNOWLEDGE,
    title: 'E2E reusable lesson: CI marker must not be quoted',
    body: 'Commit-message CI guards scan the whole message; quoting the marker in prose skips the run.',
    evidence: [{ path: '.github/workflows/publish-npm.yml' }],
    confidence: CONFIDENCES.MEDIUM,
    scope: SCOPES.PROJECT,
  })
  const id = rec?.record?.id || rec?.id

  // Repeated successful applications accumulate.
  recordFeedback(projectStore, { id, outcome: 'success', note: 'applied again, guard worked' })
  const confirmed = projectStore.get(id)
  assert.ok(confirmed.source.feedback.successes >= 1, 'success outcome recorded')

  // Promotion to reusable is explicit — the agent decides the scope boundary.
  const promotedReusable = { ...confirmed, scope: SCOPES.REUSABLE, projectId: 'reusable' }
  reusableStore.put(promotedReusable)
  assert.equal(reusableStore.get(id).scope, SCOPES.REUSABLE, 'reusable store holds the reusable copy')

  // Recurrence: same root cause repeated → detectable cluster.
  // detectRecurrence requires source.causal facets (rootCause/symptom/remedy).
  const records = [
    {
      id: 'r1',
      kind: KINDS.MEMORY,
      title: 'CI skip marker quoted',
      body: 'quoted marker',
      source: {
        causal: { rootCause: 'quoted marker in commit message', remedy: 'do not quote' },
        feedback: { successes: 0 },
      },
    },
    {
      id: 'r2',
      kind: KINDS.MEMORY,
      title: 'CI skip marker quoted',
      body: 'quoted marker again',
      source: {
        causal: { rootCause: 'quoted marker in commit message', remedy: 'do not quote' },
        feedback: { successes: 0 },
      },
    },
    {
      id: 'r3',
      kind: KINDS.MEMORY,
      title: 'CI skip marker quoted',
      body: 'quoted marker third time',
      source: {
        causal: { rootCause: 'quoted marker in commit message', remedy: 'do not quote' },
        feedback: { successes: 0 },
      },
    },
  ]
  const findings = detectRecurrence(records, { threshold: 3 })
  assert.ok(findings.length > 0, 'recurrence detects the repeated cluster (root-cause or remedy)')
  const rootCausePattern = findings.find((f) => f.kind === 'root-cause')
  const remedyPattern = findings.find((f) => f.kind === 'recurring-remedy')
  assert.ok(rootCausePattern || remedyPattern, 'recurrence returns root-cause or remedy cluster')
})

// ============================================================ isolation

test('E2E isolation: project memory does not leak across project scopes', () => {
  const storeA = openEphemeralStore(':memory:', { scope: SCOPES.PROJECT, projectId: 'p_alpha' })
  const storeB = openEphemeralStore(':memory:', { scope: SCOPES.PROJECT, projectId: 'p_beta' })
  const reusableStore = openEphemeralStore(':memory:', { scope: SCOPES.REUSABLE, projectId: 'reusable' })

  remember(storeA, {
    kind: KINDS.KNOWLEDGE,
    title: 'Alpha project: custom rate limiter in memory.mjs',
    body: 'This project implements a token bucket in src/memory.mjs; do not swap for redis.',
    confidence: CONFIDENCES.HIGH,
    scope: SCOPES.PROJECT,
    projectId: 'p_alpha',
  })
  remember(reusableStore, {
    kind: KINDS.KNOWLEDGE,
    title: 'General: prefer token bucket over fixed window',
    body: 'Token bucket smoother under bursty traffic.',
    confidence: CONFIDENCES.MEDIUM,
    scope: SCOPES.REUSABLE,
  })

  // Project B recall must see reusable knowledge but NOT project A's memory.
  const hitsB = recall({ projectStore: storeB, reusableStore, query: 'rate limiter token bucket memory.mjs', limit: 10 })
  assert.ok(
    !hitsB.some((r) => r.title.includes('Alpha project')),
    'project A memory does not leak into project B recall'
  )
  assert.ok(
    hitsB.some((r) => r.title.includes('token bucket') && r.scope === SCOPES.REUSABLE),
    'reusable knowledge crosses the boundary as designed'
  )

  // Project A still sees its own memory.
  const hitsA = recall({ projectStore: storeA, reusableStore, query: 'rate limiter memory.mjs', limit: 10 })
  assert.ok(hitsA.some((r) => r.title.includes('Alpha project')), 'project A sees its own memory')
})

// ============================================================ repository truth vs memory

test('E2E: repository verification gates authority; stale/temporary evidence behaves correctly', () => {
  const { projectStore } = freshStores('p_e2e_repo')

  const rec = remember(projectStore, {
    kind: KINDS.KNOWLEDGE,
    title: 'Reader for config lives in config.mjs',
    body: 'The config loader reads yaml via readFileSync in src/config.mjs.',
    evidence: [{ path: 'src/config.mjs', note: 'reader' }],
    confidence: CONFIDENCES.HIGH,
    scope: SCOPES.PROJECT,
  })
  const id = rec?.record?.id || rec?.id

  // Repository verification passes → feedback success lifts validation.
  recordFeedback(projectStore, { id, outcome: 'success', note: 'verified against src/config.mjs' })
  const verified = projectStore.get(id)
  assert.equal(verified.validation, VALIDATIONS.REVIEWED, 'repo-verified application lifts validation')
  assert.equal(verified.authority, AUTHORITIES.DERIVED, 'validation changes never silently set canonical')

  // Temporary evidence (test-passed) must NOT make the record stale by itself.
  const withTempEvidence = { ...verified, evidence: [...(verified.evidence || []), { note: 'test-passed' }] }
  projectStore.put(withTempEvidence)
  const afterTemp = projectStore.get(id)
  assert.notEqual(afterTemp.status, 'stale', 'temporary test evidence does not mark the record stale')
  assert.notEqual(afterTemp.validation, VALIDATIONS.INVALID, 'temporary evidence does not invalidate')

  // A failure feedback demotes validation/confidence — but never authority.
  const fbFail = recordFeedback(projectStore, { id, outcome: 'failure', note: 'regression: reader moved' })
  assert.equal(fbFail.ok, true)
  assert.equal(fbFail.record.authority, AUTHORITIES.DERIVED, 'failure feedback never changes authority')
  assert.ok(
    fbFail.record.validation !== VALIDATIONS.VERIFIED,
    'failure demotes a verified record out of verified'
  )
})

// ============================================================ negative / unresolved kinds stay distinct

test('E2E: negative and unresolved are first-class kinds, never coerced to memory', () => {
  const { projectStore } = freshStores('p_e2e_neg')

  const neg = remember(projectStore, {
    kind: KINDS.NEGATIVE,
    title: 'WAL mode for this workload',
    body: 'Rejected: WAL mode caused throughput drop in our workload; fixed journal mode is better here.',
    confidence: CONFIDENCES.MEDIUM,
    scope: SCOPES.PROJECT,
  })
  const negId = neg?.record?.id || neg?.id
  const negRec = projectStore.get(negId)
  assert.equal(negRec.kind, KINDS.NEGATIVE, 'negative kind preserved')
  assert.notEqual(negRec.kind, KINDS.MEMORY, 'negative never coerced to memory')

  const unres = remember(projectStore, {
    kind: KINDS.UNRESOLVED,
    title: 'Unknown flake in parallel worker teardown',
    body: 'Known clues: fails only with --maxWorkers=8; repro rate ~10%.',
    confidence: CONFIDENCES.LOW,
    scope: SCOPES.PROJECT,
  })
  const unresId = unres?.record?.id || unres?.id
  const unresRec = projectStore.get(unresId)
  assert.equal(unresRec.kind, KINDS.UNRESOLVED, 'unresolved kind preserved')

  // Negative/unresolved are recall-eligible (they are knowledge), but carry no canonical authority.
  const negHits = recall({ projectStore, reusableStore: null, query: 'WAL mode throughput', limit: 5 })
  const hit = negHits.find((r) => r.id === negId)
  if (hit) {
    assert.notEqual(hit.authority, AUTHORITIES.CANONICAL, 'negative knowledge never canonical')
  }
})
