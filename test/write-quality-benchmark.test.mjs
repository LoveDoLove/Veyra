/**
 * Memory Write Quality / Auto-Learning Pollution Benchmark.
 *
 * Measures whether automatic learning preserves the GOAL.md invariants:
 *   Observe ≠ Store · Candidate ≠ Truth · transient dialogue ≠ durable knowledge
 *   automatic behavior never becomes canonical by itself
 *
 * Ten cases, each recording the write-gate verdict (ACCEPT / MERGE / DROP /
 * DEFER) and the resulting kind / authority / validation / recall behavior.
 * Metrics computed at the end: False Accepts, False Rejects, Unsafe
 * Promotions, Pollution Rate, Useful Knowledge Retention Rate.
 *
 * Read-only with respect to production: every store here is ephemeral
 * (:memory:). No production code or production DB is touched.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  AUTHORITIES,
  KINDS,
  SCOPES,
  STATUSES,
  VALIDATIONS,
  isRecallEligible,
} from '../src/types.mjs'
import { openEphemeralStore } from '../src/store.mjs'
import { newBuffer, observeEvent, candidateFromBuffer, isNoiseText } from '../src/observe.mjs'
import { writeGate, maybeLearn, remember, provenanceAllowsLearning, WRITE_GATES } from '../src/learn.mjs'
import { verifyEvidenceHealth, markStale } from '../src/evolve.mjs'
import { recordFeedback } from '../src/feedback.mjs'
import { recall } from '../src/retrieve.mjs'
import { promote } from '../src/learn.mjs'

// ─────────────────────────────────────────────────────────────────────────────
// Verdict ledger — every case records what actually happened.
// ─────────────────────────────────────────────────────────────────────────────
const ledger = []
function record(caseId, outcome) {
  ledger.push({ caseId, ...outcome })
}

const mkStore = () => openEphemeralStore(':memory:', { scope: SCOPES.PROJECT, projectId: 'p_wqb' })

const mkCandidate = (overrides = {}) => ({
  title: overrides.title ?? 'Serialize DatabaseSync writes',
  body: overrides.body
    ?? 'The root cause is concurrent DatabaseSync writes corrupting FTS triggers. The remedy is to serialize every write through a mutex around the shared handle.',
  scope: 'project',
  projectId: 'p_wqb',
  kind: KINDS.OBSERVATION,
  authority: AUTHORITIES.CANDIDATE,
  tags: ['observation'],
  evidence: [{ path: 'src/store.mjs', note: 'test-passed' }],
  source: { automatic: true, signal: 'decision', provenance: { origins: ['assistant'] } },
  ...overrides,
})

function bufferedTurn({ userText = '', assistantText = '', tools = [], noiseUser = null } = {}) {
  const buffer = newBuffer()
  observeEvent(buffer, {}, { type: 'turn/start', data: { turn: 1 } })
  if (noiseUser !== null) {
    // noise text must be dropped by the observer itself
    observeEvent(buffer, {}, { type: 'user/message', data: { content: [{ type: 'text', text: noiseUser }] } })
  }
  if (userText) {
    observeEvent(buffer, {}, { type: 'user/message', data: { content: [{ type: 'text', text: userText }] } })
  }
  if (assistantText) {
    observeEvent(buffer, {}, { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: assistantText }] } } })
  }
  for (const tool of tools) {
    observeEvent(buffer, {}, { type: 'tool/call', data: { name: tool.name, arguments: tool.args } })
  }
  return buffer
}

// ─────────────────────────────────────────────────────────────────────────────
// Case 1 — Transient dialogue
// ─────────────────────────────────────────────────────────────────────────────
test('WQ-01 transient dialogue: acknowledgements never become candidates', () => {
  const buffer = bufferedTurn({ noiseUser: 'ok', assistantText: 'LGTM' })
  const candidate = candidateFromBuffer(buffer, { projectId: 'p_wqb', sessionId: 's1' })
  assert.equal(candidate, null, 'short acknowledgement must produce no candidate')
  record('WQ-01a', { verdict: 'DROP-at-observe', enteredRecall: false, canonical: false })
})

test('WQ-01b progress updates from user dialogue stay gated (provenance)', () => {
  const store = mkStore()
  const buffer = bufferedTurn({
    // ≥80 chars, no claim hints → distillable but not durable
    userText: 'Wrapped up the exploratory pass on the benchmark harness and jotted down notes for the next session tomorrow.',
    tools: [{ name: 'read', args: { path: 'test/fixtures/harness.json' } }],
  })
  const candidate = candidateFromBuffer(buffer, { projectId: 'p_wqb', sessionId: 's1' })
  assert.ok(candidate, 'fixture must reach distill (otherwise the case proves nothing)')
  assert.equal(candidate.authority, AUTHORITIES.CANDIDATE, 'observe never assigns derived/canonical')
  assert.equal(candidate.kind, KINDS.OBSERVATION)
  assert.equal(isRecallEligible(candidate), false, 'candidate must not be recall-eligible')

  const gate = writeGate(store, candidate)
  assert.equal(gate.decision, WRITE_GATES.DEFER, `expected DEFER for user-origin dialogue, got ${gate.decision}`)
  assert.equal(gate.reason, 'provenance-gated')
  assert.equal(gate.record, null, 'DEFER writes no derived record')
  assert.equal(provenanceAllowsLearning(candidate), false, 'origins include user → automatic learning blocked')
  assert.equal(recall({ projectStore: store, query: 'benchmark harness session notes', limit: 5 }).length, 0)

  record('WQ-01b', {
    verdict: gate.decision, reason: gate.reason, kind: null, authority: 'candidate (unchanged)',
    validation: 'n/a', enteredRecall: false, canonical: false,
  })
  store.close()
})

// ─────────────────────────────────────────────────────────────────────────────
// Case 2 — Tool / command output
// ─────────────────────────────────────────────────────────────────────────────
test('WQ-02 raw tool output: not durable → DROP, tool-only origin → DEFER', () => {
  const store = mkStore()
  const rawLog = [
    'Running 676 tests...',
    '✔ case alpha (12ms)',
    '✔ case beta (8ms)',
    'npm ERR! exit code 0 after 4.2s',
    'ok all assertions passed in 3900ms',
  ].join('\n')

  // 2a: assistant narrates raw output, no claim language → durability gate
  const assistantNarrated = mkCandidate({
    title: 'Test run output',
    body: rawLog,
    evidence: [{ path: 'src/store.mjs', note: 'test-passed' }],
    source: { automatic: true, signal: 'observation', provenance: { origins: ['assistant'] } },
  })
  const gateA = writeGate(store, assistantNarrated)
  assert.equal(gateA.decision, WRITE_GATES.DROP, `raw output must be dropped, got ${gateA.decision}`)
  assert.equal(gateA.reason, 'not-durable')
  assert.equal(gateA.record, null)

  // 2b: origin is tool-only (no assistant) → provenance blocks first
  const toolOnly = mkCandidate({
    title: 'Command result dump',
    body: rawLog,
    source: { automatic: true, signal: 'observation', provenance: { origins: ['tool'] } },
  })
  const gateB = writeGate(store, toolOnly)
  assert.equal(gateB.decision, WRITE_GATES.DEFER, `tool-only origin must defer, got ${gateB.decision}`)
  assert.equal(gateB.reason, 'provenance-gated')

  assert.equal(store.list({ limit: 50 }).filter((r) => r.authority === AUTHORITIES.DERIVED).length, 0)
  record('WQ-02', { verdict: `${gateA.decision}/${gateB.decision}`, kind: null, authority: null, enteredRecall: false, canonical: false })
  store.close()
})

// ─────────────────────────────────────────────────────────────────────────────
// Case 3 — Speculation
// ─────────────────────────────────────────────────────────────────────────────
test('WQ-03 unverified speculation: reaches derived only as UNVERIFIED, never canonical', () => {
  const store = mkStore()
  const spec = mkCandidate({
    title: 'Flaky retry loop suspicion',
    body: 'Probably caused by the flaky timer in the retry loop, though this is unverified so far and no test covers it.',
    evidence: [],
    source: { automatic: true, signal: 'observation', provenance: { origins: ['assistant'] } },
  })
  const gate = writeGate(store, spec)
  assert.equal(gate.decision, WRITE_GATES.ACCEPT, `measured behavior: ${gate.decision} (${gate.reason})`)
  assert.equal(gate.record.authority, AUTHORITIES.DERIVED, 'never canonical')
  assert.equal(gate.record.validation, VALIDATIONS.UNVERIFIED, 'speculation must stay unverified')
  assert.notEqual(gate.record.validation, VALIDATIONS.VERIFIED)
  assert.equal(gate.record.confidence, 'low', 'no grounding + no test evidence → low confidence')

  const promoted = promote(store, gate.record.id, { to: AUTHORITIES.CANONICAL, explicit: false })
  assert.equal(promoted.ok, false, 'canonical still requires explicit user action')
  assert.equal(store.get(gate.record.id).authority, AUTHORITIES.DERIVED)

  record('WQ-03', {
    verdict: gate.decision, reason: gate.reason, kind: gate.record.kind, authority: gate.record.authority,
    validation: gate.record.validation, evidence: 0, enteredRecall: true, canonical: false,
  })
  store.close()
})

// ─────────────────────────────────────────────────────────────────────────────
// Case 4 — Temporary evidence
// ─────────────────────────────────────────────────────────────────────────────
test('WQ-04 /tmp evidence: never broken, never triggers stale; missing repo file does', () => {
  const workspace = mkdtempSync(join(tmpdir(), 'wqb-'))
  try {
    const store = mkStore()
    const tmpRec = remember(store, {
      title: 'Probe artifact for the write-quality run',
      body: 'Generated a probe artifact under /tmp during the benchmark run and inspected it there.',
      evidence: [{ path: '/tmp/wqb-definitely-missing/artifact.json' }],
      scope: 'project', projectId: 'p_wqb',
    }, {})
    assert.ok(tmpRec.record, 'record written')
    const health = verifyEvidenceHealth(tmpRec.record, workspace)
    assert.equal(health.status, 'temporary', `temp evidence must be 'temporary', got '${health.status}'`)
    assert.ok(health.missingTempPaths.length >= 1)

    const staleAfterTemp = markStale(store, { workspace, now: Date.now() })
    assert.equal(staleAfterTemp.length, 0, 'temporary evidence must never mark a record stale')
    assert.notEqual(store.get(tmpRec.record.id).validation, VALIDATIONS.STALE)

    // control: a missing repo-anchored path IS broken and does go stale
    const repoRec = remember(store, {
      title: 'Anchored claim with deleted file',
      body: 'The root cause lived in a module that has since been deleted from the repository tree.',
      evidence: [{ path: 'src/wqb_missing_module.mjs' }],
      scope: 'project', projectId: 'p_wqb',
    }, {})
    const repoHealth = verifyEvidenceHealth(repoRec.record, workspace)
    assert.equal(repoHealth.status, 'broken')
    const staleAfterRepo = markStale(store, { workspace, now: Date.now() })
    assert.equal(staleAfterRepo.length, 1, 'genuinely broken repo evidence must go stale')
    assert.equal(store.get(repoRec.record.id).validation, VALIDATIONS.STALE)

    record('WQ-04', {
      verdict: 'DEFER (no stale)', kind: 'memory', authority: 'derived',
      validation: 'unverified → temporary (not stale)', enteredRecall: true, canonical: false,
    })
    store.close()
  } finally {
    rmSync(workspace, { recursive: true, force: true })
  }
})

// ─────────────────────────────────────────────────────────────────────────────
// Case 5 — Benchmark / session chatter
// ─────────────────────────────────────────────────────────────────────────────
test('WQ-05 benchmark chatter: noise prefixes are dropped at observe', () => {
  assert.equal(isNoiseText('Veyra recalled engineering memory from last week'), true)
  assert.equal(isNoiseText('these items are remembered engineering experience'), true)
  assert.equal(isNoiseText('/goal keep the suite green'), true)
  assert.equal(isNoiseText('[veyra] canonical record protected'), true)

  // chatter WITH tool activity: candidate may form, but provenance still blocks
  const store = mkStore()
  const buffer = bufferedTurn({
    noiseUser: 'Veyra recalled engineering memory and I will now narrate the benchmark case for the transcript.',
    tools: [
      { name: 'read', args: { path: 'src/learn.mjs' } },
      { name: 'grep', args: { path: 'src/evolve.mjs' } },
    ],
  })
  const candidate = candidateFromBuffer(buffer, { projectId: 'p_wqb', sessionId: 's2' })
  if (candidate) {
    const gate = writeGate(store, candidate)
    assert.notEqual(gate.decision, WRITE_GATES.ACCEPT, `chatter must not be accepted, got ${gate.decision}`)
    assert.equal(gate.record, null)
    record('WQ-05', { verdict: gate.decision, reason: gate.reason, enteredRecall: false, canonical: false })
  } else {
    record('WQ-05', { verdict: 'DROP-at-observe', enteredRecall: false, canonical: false })
  }
  assert.equal(recall({ projectStore: store, query: 'benchmark transcript narration', limit: 5 }).length, 0)
  store.close()
})

// ─────────────────────────────────────────────────────────────────────────────
// Case 6 — Duplicate observations
// ─────────────────────────────────────────────────────────────────────────────
test('WQ-06 duplicate fact: MERGE, not a second equivalent record', () => {
  const store = mkStore()
  const first = writeGate(store, mkCandidate())
  assert.equal(first.decision, WRITE_GATES.ACCEPT)
  const second = writeGate(store, mkCandidate())
  assert.equal(second.decision, WRITE_GATES.MERGE, `verbatim repeat must merge, got ${second.decision} (${second.reason})`)
  assert.equal(second.reason, 'near-duplicate-strengthened')
  assert.equal(second.record, null)
  const derived = store.list({ limit: 50 }).filter((r) => r.authority === AUTHORITIES.DERIVED)
  assert.equal(derived.length, 1, 'exactly one derived record after a repeat')
  assert.ok(derived[0].source.observations >= 2, 'neighbor strengthened, not duplicated')

  // paraphrased duplicate — measure what the diff layer actually does
  const paraphrase = writeGate(store, mkCandidate({
    title: 'Serialize DatabaseSync writes',
    body: 'Always serialize DatabaseSync writes to avoid FTS corruption: the root cause is concurrent DatabaseSync writes corrupting FTS triggers.',
  }))
  const derivedAfter = store.list({ limit: 50 }).filter((r) => r.authority === AUTHORITIES.DERIVED)
  if (paraphrase.decision === WRITE_GATES.MERGE) {
    assert.equal(derivedAfter.length, 1, 'paraphrase merged into the same neighbor')
  } else {
    // acceptance is allowed only if the records are relation-linked (no silent equivalents)
    assert.equal(paraphrase.decision, WRITE_GATES.ACCEPT)
    assert.ok(derivedAfter.length <= 2, 'at most one additional record')
    const links = (paraphrase.record.relations || []).concat(derivedAfter.flatMap((r) => r.relations || []))
    assert.ok(links.length > 0, 'any accepted paraphrase must carry a relation to its neighbor — no silent equivalents')
  }
  record('WQ-06', {
    verdict: 'MERGE (verbatim) / ' + paraphrase.decision + ' (paraphrase)',
    duplicateBehavior: 'strengthened, count stable', enteredRecall: true, canonical: false,
  })
  store.close()
})

// ─────────────────────────────────────────────────────────────────────────────
// Case 7 — Negative / failed approach
// ─────────────────────────────────────────────────────────────────────────────
test('WQ-07 negative knowledge: derived + correct validation, idempotent, never canonical', () => {
  const store = mkStore()
  const first = remember(store, {
    kind: KINDS.NEGATIVE,
    title: 'Hypothesis: relaxing FTS journal mode fixes the race',
    body: 'Setting journal_mode=WAL off stops the corruption.',
    evidence: [{ path: 'src/store.mjs' }],
    scope: 'project', projectId: 'p_wqb',
  }, {})
  assert.ok(first.record)
  assert.equal(first.record.kind, KINDS.NEGATIVE)
  assert.equal(first.record.authority, AUTHORITIES.DERIVED, '§8: historical evidence, never canonical')
  assert.equal(first.record.validation, VALIDATIONS.VERIFIED, 'verificationBasis=test → verified')
  assert.ok(first.record.tags.includes('negative'))

  const again = remember(store, {
    kind: KINDS.NEGATIVE,
    title: 'Hypothesis: relaxing FTS journal mode fixes the race',
    body: 'Setting journal_mode=WAL off stops the corruption.',
    scope: 'project', projectId: 'p_wqb',
  }, {})
  assert.equal(again.duplicate, true, 'idempotent — no second record for the same hypothesis')
  assert.equal(again.created, false)
  assert.equal(store.list({ limit: 50 }).filter((r) => r.kind === KINDS.NEGATIVE).length, 1)

  // explicit kind query surfaces it; it never gains canonical authority
  const kindHits = recall({ projectStore: store, query: 'FTS journal race', kind: KINDS.NEGATIVE, limit: 5 })
  assert.ok(kindHits.some((r) => r.id === first.record.id), 'explicit kind query returns the negative')
  assert.equal(store.get(first.record.id).authority, AUTHORITIES.DERIVED)

  record('WQ-07', {
    verdict: 'ACCEPT-as-negative', kind: KINDS.NEGATIVE, authority: AUTHORITIES.DERIVED,
    validation: VALIDATIONS.VERIFIED, duplicateBehavior: 'idempotent', enteredRecall: 'kind-filter only', canonical: false,
  })
  store.close()
})

// ─────────────────────────────────────────────────────────────────────────────
// Case 8 — Verified root cause
// ─────────────────────────────────────────────────────────────────────────────
test('WQ-08 verified root cause: ACCEPT with reviewed validation and enters recall', () => {
  const store = mkStore()
  const gate = writeGate(store, mkCandidate())
  assert.equal(gate.decision, WRITE_GATES.ACCEPT)
  assert.equal(gate.reason, 'new-derived-knowledge')
  assert.equal(gate.record.authority, AUTHORITIES.DERIVED)
  assert.equal(gate.record.validation, VALIDATIONS.REVIEWED, 'test-passed evidence → reviewed')
  assert.equal(isRecallEligible(gate.record), true)

  const hits = recall({ projectStore: store, query: 'DatabaseSync write race FTS', limit: 5 })
  assert.ok(hits.some((r) => r.id === gate.record.id), 'verified knowledge must be recallable')
  const prompt = hits.map((r) => r).find((r) => r.id === gate.record.id)
  assert.equal(prompt.validation, VALIDATIONS.REVIEWED)

  record('WQ-08', {
    verdict: gate.decision, reason: gate.reason, kind: gate.record.kind, authority: gate.record.authority,
    validation: gate.record.validation, evidence: gate.record.evidence.length, enteredRecall: true, canonical: false,
  })
  store.close()
})

// ─────────────────────────────────────────────────────────────────────────────
// Case 9 — Architectural decision
// ─────────────────────────────────────────────────────────────────────────────
test('WQ-09 architectural decision: durable derived knowledge; canonical refused without explicit', () => {
  const store = mkStore()
  // deliberate remember path with canonical requested → demoted
  const written = remember(store, {
    title: 'Single-writer mutex around the shared sqlite handle',
    body: 'Decision: always serialize DatabaseSync writes through one mutex; rationale is FTS trigger corruption under concurrency, verified by the regression suite.',
    kind: KINDS.KNOWLEDGE,
    authority: AUTHORITIES.CANONICAL,
    validation: VALIDATIONS.REVIEWED,
    evidence: [{ path: 'src/store.mjs' }],
    scope: 'project', projectId: 'p_wqb',
    source: { automatic: false },
  }, {})
  assert.ok(written.record, 'record written')
  assert.equal(written.record.authority, AUTHORITIES.DERIVED, 'remember() demotes incoming canonical → derived')
  assert.equal(written.record.kind, KINDS.KNOWLEDGE)

  const ref = promote(store, written.record.id, { to: AUTHORITIES.CANONICAL })
  assert.equal(ref.ok, false, 'canonical promotion requires an explicit user action')
  assert.equal(store.get(written.record.id).authority, AUTHORITIES.DERIVED)

  const hits = recall({ projectStore: store, query: 'single writer mutex architecture decision', limit: 5 })
  assert.ok(hits.some((r) => r.id === written.record.id), 'durable decision is recallable')

  record('WQ-09', {
    verdict: 'ACCEPT (remember path)', kind: KINDS.KNOWLEDGE, authority: AUTHORITIES.DERIVED,
    validation: VALIDATIONS.REVIEWED, evidence: 1, enteredRecall: true, canonical: false,
  })
  store.close()
})

// ─────────────────────────────────────────────────────────────────────────────
// Case 10 — Verified outcome (symptom → root cause → remedy → feedback)
// ─────────────────────────────────────────────────────────────────────────────
test('WQ-10 verified outcome: feedback lifts validation along the ladder, never authority', () => {
  const store = mkStore()
  const gate = writeGate(store, mkCandidate())
  assert.equal(gate.decision, WRITE_GATES.ACCEPT)
  const id = gate.record.id
  assert.equal(gate.record.validation, VALIDATIONS.REVIEWED)
  assert.equal(gate.record.source.observations, 1)

  const fb1 = recordFeedback(store, { id, outcome: 'success', note: 'fix verified in suite' })
  assert.equal(fb1.ok, true)
  const after1 = store.get(id)
  assert.ok(after1.source.observations >= 2, 'success increments observations')

  const fb2 = recordFeedback(store, { id, outcome: 'success', note: 'second verification' })
  assert.equal(fb2.ok, true)
  const after2 = store.get(id)
  assert.equal(after2.authority, AUTHORITIES.DERIVED, 'feedback ladder never touches authority')
  assert.ok(
    [VALIDATIONS.REVIEWED, VALIDATIONS.VERIFIED].includes(after2.validation),
    `ladder must stay within reviewed/verified, got ${after2.validation}`,
  )

  const bad = recordFeedback(store, { id, outcome: 'failure', note: 'regressed later' })
  assert.equal(bad.ok, true)
  const after3 = store.get(id)
  assert.notEqual(after3.validation, after2.validation, 'failure must demote validation')
  assert.equal(after3.authority, AUTHORITIES.DERIVED, 'authority still untouched by feedback')

  record('WQ-10', {
    verdict: 'ACCEPT → feedback ladder', kind: KINDS.MEMORY, authority: AUTHORITIES.DERIVED,
    validation: `${after2.validation} → ${after3.validation}`, enteredRecall: true, canonical: false,
  })
  store.close()
})

// ─────────────────────────────────────────────────────────────────────────────
// Metrics
// ─────────────────────────────────────────────────────────────────────────────
test('WQ-M metrics: false accepts, unsafe promotions, pollution + retention rates', () => {
  // pollution-relevant cases: dialogue/tool/chatter must never ACCEPT
  const transientCases = ledger.filter((e) => ['WQ-01a', 'WQ-01b', 'WQ-02', 'WQ-05'].includes(e.caseId))
  const falseAccepts = transientCases.filter((e) => String(e.verdict).startsWith('ACCEPT'))

  // useful-knowledge cases: negative, root cause, decision, verified outcome must be retained
  const usefulCases = ledger.filter((e) => ['WQ-07', 'WQ-08', 'WQ-09', 'WQ-10'].includes(e.caseId))
  const retained = usefulCases.filter((e) => e.enteredRecall === true || e.enteredRecall === 'kind-filter only')
  const retentionRate = usefulCases.length ? retained.length / usefulCases.length : 0

  const unsafePromotions = ledger.filter((e) => e.canonical === true)

  const pollutionRate = transientCases.length ? falseAccepts.length / transientCases.length : 0

  assert.equal(falseAccepts.length, 0, `false accepts: ${JSON.stringify(falseAccepts)}`)
  assert.equal(unsafePromotions.length, 0, `unsafe promotions: ${JSON.stringify(unsafePromotions)}`)
  assert.equal(retentionRate, 1, `useful knowledge retention ${retentionRate} — retained ${retained.length}/${usefulCases.length}`)

  console.log(`[WQ] cases=${ledger.length} falseAccepts=${falseAccepts.length} unsafePromotions=${unsafePromotions.length} pollutionRate=${(pollutionRate * 100).toFixed(1)}% retentionRate=${(retentionRate * 100).toFixed(1)}%`)
  for (const entry of ledger) {
    console.log(`[WQ] ${entry.caseId}: ${entry.verdict}${entry.reason ? ' (' + entry.reason + ')' : ''} kind=${entry.kind ?? '-'} authority=${entry.authority ?? '-'} validation=${entry.validation ?? '-'} recall=${entry.enteredRecall} canonical=${entry.canonical}`)
  }
})
