/**
 * Phase 6 — Feedback and Recurrence (GOAL.md §19 / §20).
 *
 * §19: actual engineering outcomes improve memory quality — success strengthens
 * via the observation ladder, failure records history and decreases reliability
 * (validation + confidence demote one step), canonical stays protected.
 * §20: recurring symptom / root cause / failed approach / remedy / regression
 * are detected; a cluster with ONE verified remedy becomes a gated candidate
 * for stronger engineering knowledge (write gate; never automatic canonical).
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  detectRecurrence,
  eligibleForCandidate,
  feedbackStats,
  recordFeedback,
  recurrenceCandidate,
} from '../src/feedback.mjs'
import { openEphemeralStore, openProjectStore, closeAllStores } from '../src/store.mjs'
import { projectIdFor } from '../src/ids.mjs'
import { buildToolDefinitions } from '../src/tools.mjs'
import { AUTHORITIES, CONFIDENCES, KINDS, RELATIONS, SCOPES, VALIDATIONS } from '../src/types.mjs'

function putRec(store, over = {}, opts = {}) {
  return store.put({
    title: 'Decision: wrap DatabaseSync writes in a mutex',
    body: 'The sqlite writer race must be fixed by serializing every write around a critical-section mutex.',
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

// Plain records for pure detection tests (detectRecurrence reads arrays).
const mk = (id, causal, extra = {}) => ({
  id,
  kind: KINDS.MEMORY,
  status: 'current',
  title: `Incident ${id}`,
  body: `incident body ${id}`,
  tags: [],
  forgotten: false,
  source: causal ? { causal } : {},
  ...extra,
})

// ============================================================ §19 feedback

test('§19: success strengthens the observation ladder and keeps authority', () => {
  const store = openEphemeralStore()
  const rec = putRec(store, { source: { observations: 1 } })

  const res = recordFeedback(store, { id: rec.id, outcome: 'success', note: 'tests green' })
  assert.equal(res.ok, true)
  assert.equal(res.record.source.observations, 2, 'successful application confirms the record')
  assert.equal(res.record.validation, VALIDATIONS.REVIEWED, 'obs>=2 lifts unverified → reviewed')
  assert.equal(res.record.confidence, CONFIDENCES.MEDIUM, 'reviewed lifts low → medium')
  assert.equal(res.record.authority, AUTHORITIES.DERIVED, 'feedback never changes authority')
  assert.ok(res.record.source.lastConfirmedAt, 'lastConfirmedAt stamped')
  assert.equal(res.record.source.lastConfirmedBy, 'veyra_feedback:success')
  assert.deepEqual(res.feedback, {
    successes: 1,
    failures: 0,
    attempts: 1,
    reliability: 1,
    lastOutcome: 'success',
    lastOutcomeAt: res.feedback.lastOutcomeAt,
  })
  assert.equal(res.record.source.feedback.history.length, 1)
  assert.equal(res.record.source.feedback.history[0].note, 'tests green')
  assert.equal(res.previous.validation, VALIDATIONS.UNVERIFIED)
})

test('§19: verified outcome + test evidence → verified/high + promotion-candidate tag', () => {
  const store = openEphemeralStore()
  const rec = putRec(store, {
    validation: VALIDATIONS.REVIEWED,
    confidence: CONFIDENCES.MEDIUM,
    source: { observations: 2 },
    evidence: [{ note: 'test-passed' }],
  })

  const res = recordFeedback(store, { id: rec.id, outcome: 'success' })
  assert.equal(res.record.source.observations, 3)
  assert.equal(res.record.validation, VALIDATIONS.VERIFIED, 'obs>=3 + test evidence → verified')
  assert.equal(res.record.confidence, CONFIDENCES.HIGH)
  assert.ok(res.record.tags.includes('promotion-candidate'), 'verified knowledge tagged for promotion')
  assert.equal(res.record.authority, AUTHORITIES.DERIVED, 'still never canonical')
})

test('§19: canonical records get history only — validation, confidence and observations untouched', () => {
  const store = openEphemeralStore()
  const rec = putRec(store, {
    authority: AUTHORITIES.CANONICAL,
    validation: VALIDATIONS.VERIFIED,
    confidence: CONFIDENCES.HIGH,
  }, { explicitCanonical: true })
  assert.equal(rec.authority, AUTHORITIES.CANONICAL)

  const ok = recordFeedback(store, { id: rec.id, outcome: 'success' })
  assert.equal(ok.ok, true)
  assert.equal(ok.record.authority, AUTHORITIES.CANONICAL, 'canonical survives the write')
  assert.equal(ok.record.validation, VALIDATIONS.VERIFIED)
  assert.equal(ok.record.source.observations, undefined, 'strengthenMemory early-returns for canonical')
  assert.equal(ok.feedback.successes, 1)

  const bad = recordFeedback(store, { id: rec.id, outcome: 'failure', note: 'regressed' })
  assert.equal(bad.ok, true)
  assert.equal(bad.record.authority, AUTHORITIES.CANONICAL)
  assert.equal(bad.record.validation, VALIDATIONS.VERIFIED, 'agent failure never demotes canonical validation')
  assert.equal(bad.record.confidence, CONFIDENCES.HIGH)
  assert.equal(bad.feedback.failures, 1, 'failure history still recorded')
  assert.equal(bad.record.source.feedback.history.length, 2)
})

test('§19: failure demotes validation+confidence, keeps causal/evidence/status visible', () => {
  const store = openEphemeralStore()
  const causal = {
    symptom: 'database is locked under load',
    rootCause: 'SQLite writer race inside DatabaseSync',
    remedy: 'Wrap writes in a mutex',
    verifiedOutcome: 'tests passed after mutex',
  }
  const evidence = [{ note: 'test-passed' }]
  const rec = putRec(store, {
    validation: VALIDATIONS.VERIFIED,
    confidence: CONFIDENCES.HIGH,
    source: { observations: 5, causal },
    evidence,
  })

  const first = recordFeedback(store, { id: rec.id, outcome: 'failure', note: 'tests failed: writer timeout' })
  assert.equal(first.record.validation, VALIDATIONS.REVIEWED, 'verified → reviewed')
  assert.equal(first.record.confidence, CONFIDENCES.MEDIUM, 'high → medium')
  assert.deepEqual(first.record.source.causal, causal, 'causal untouched — verifiedOutcome is history, never rewritten')
  assert.deepEqual(first.record.evidence, evidence, 'evidence untouched')
  assert.equal(first.record.source.observations, 5, 'failure adds no observation')
  assert.equal(first.feedback.reliability, 0, 'reliability decreased')
  assert.equal(first.feedback.failures, 1)

  const second = recordFeedback(store, { id: rec.id, outcome: 'failure' })
  assert.equal(second.record.validation, VALIDATIONS.UNVERIFIED, 'reviewed → unverified')
  assert.equal(second.record.confidence, CONFIDENCES.LOW, 'medium → low')

  const third = recordFeedback(store, { id: rec.id, outcome: 'failure' })
  assert.equal(third.record.validation, VALIDATIONS.UNVERIFIED, 'floor: unverified stays')
  assert.equal(third.record.confidence, CONFIDENCES.LOW, 'floor: low stays')
})

test('§19: failure history is bounded to 10 entries while counters keep every attempt', () => {
  const store = openEphemeralStore()
  const rec = putRec(store)
  let last = null
  for (let i = 0; i < 12; i++) last = recordFeedback(store, { id: rec.id, outcome: 'failure' })

  const history = last.record.source.feedback.history
  assert.equal(history.length, 10, 'history window bounded')
  assert.equal(last.feedback.failures, 12, 'counters never bounded')
  assert.ok(history.every((h) => h.outcome === 'failure'))
  assert.equal(history.at(-1).outcome, 'failure')
})

test('§19: rejected feedback — bad outcome, missing record, forgotten record', () => {
  const store = openEphemeralStore()
  const rec = putRec(store)

  const badOutcome = recordFeedback(store, { id: rec.id, outcome: 'meh' })
  assert.equal(badOutcome.ok, false)
  assert.match(badOutcome.error, /success or failure/)

  const missing = recordFeedback(store, { id: 'vey_nope', outcome: 'success' })
  assert.equal(missing.ok, false)
  assert.equal(missing.error, 'record not found')

  const noId = recordFeedback(store, { outcome: 'success' })
  assert.equal(noId.ok, false)

  store.forget(rec.id)
  const forgotten = recordFeedback(store, { id: rec.id, outcome: 'success' })
  assert.equal(forgotten.ok, false)
  assert.equal(forgotten.error, 'record is forgotten')
  assert.equal(store.get(rec.id).source?.feedback, undefined, 'forgotten record untouched')
})

test('§19: feedbackStats — empty record reports null reliability, partial counts ratio', () => {
  const empty = feedbackStats({ source: {} })
  assert.deepEqual(empty, {
    successes: 0,
    failures: 0,
    attempts: 0,
    reliability: null,
    lastOutcome: null,
    lastOutcomeAt: null,
  })
  const partial = feedbackStats({ source: { feedback: { successes: 2, failures: 1, lastOutcome: 'failure' } } })
  assert.equal(partial.attempts, 3)
  assert.equal(partial.reliability, 0.667)
  assert.equal(partial.lastOutcome, 'failure')
})

// ============================================================ §20 recurrence

test('§20: root-cause cluster at threshold, remedy consistency, below-threshold silence', () => {
  const cause = { rootCause: 'dependency issue in writer pool', remedy: 'pin sqlite3 and serialize writes' }
  const records = [
    mk('a', cause),
    mk('b', { ...cause, symptom: 'busy timeout' }),
    mk('c', cause),
    mk('d', { rootCause: 'unrelated config drift', remedy: 'reload config' }),
    mk('e', { rootCause: 'unrelated config drift', remedy: 'reload config' }),
  ]
  const findings = detectRecurrence(records, { threshold: 3 })
  const root = findings.find((f) => f.kind === 'root-cause')
  assert.ok(root, 'root-cause finding exists')
  assert.equal(root.count, 3)
  assert.deepEqual(root.recordIds.sort(), ['a', 'b', 'c'])
  assert.equal(root.remedyConsistent, true, 'one distinct remedy across the cluster')
  assert.equal(root.verifiedRemedy, false, 'no member has a verified outcome yet')
  assert.equal(findings.some((f) => f.key.includes('config drift')), false, '2 incidents < threshold 3')

  // Threshold boundary: at 2 the smaller cluster appears.
  const atTwo = detectRecurrence(records, { threshold: 2 })
  assert.ok(atTwo.find((f) => f.kind === 'root-cause' && f.key.includes('config drift')))
  assert.equal(detectRecurrence(records, { threshold: 1 }).length > 0, true, 'threshold clamped to >= 2')
})

test('§20: inconsistent remedies disqualify candidacy; verified consistent remedy qualifies', () => {
  const base = { rootCause: 'shared dependency issue' }
  const inconsistent = detectRecurrence([
    mk('a', { ...base, remedy: 'pin version' }),
    mk('b', { ...base, remedy: 'pin version' }),
    mk('c', { ...base, remedy: 'vendor the dep' }),
  ], { threshold: 3 })
  const inc = inconsistent.find((f) => f.kind === 'root-cause')
  assert.equal(inc.remedyConsistent, false)
  assert.equal(eligibleForCandidate(inc), false, 'two remedies → never a candidate')

  const consistent = detectRecurrence([
    mk('a', { ...base, remedy: 'pin version' }),
    mk('b', { ...base, remedy: 'pin version' }),
    mk('c', { ...base, remedy: 'pin version', verifiedOutcome: 'tests pass after pinning' }),
  ], { threshold: 3 })
  const con = consistent.find((f) => f.kind === 'root-cause')
  assert.equal(con.remedyConsistent, true)
  assert.equal(con.verifiedRemedy, true)
  assert.equal(eligibleForCandidate(con), true)

  // Symptom clusters stay report-only: no root cause, no candidacy.
  const symptomatic = detectRecurrence([
    mk('x', { symptom: 'deadlock on startup' }),
    mk('y', { symptom: 'deadlock on startup' }),
    mk('z', { symptom: 'deadlock on startup' }),
  ], { threshold: 3 })
  const sym = symptomatic.find((f) => f.kind === 'symptom')
  assert.ok(sym, 'recurring symptom detected without a root cause')
  assert.equal(sym.count, 3)
  assert.equal(eligibleForCandidate(sym), false, 'symptom-only clusters are never auto-written')
})

test('§20: failed approach, recurring regression, recurring remedy, recurring failure', () => {
  // Known-failed approaches (negative kind) sharing a hypothesis title.
  const negatives = detectRecurrence([
    mk('n1', null, { kind: KINDS.NEGATIVE, title: 'increase busy_timeout to 30s' }),
    mk('n2', null, { kind: KINDS.NEGATIVE, title: 'increase busy_timeout to 30s' }),
    mk('n3', null, { kind: KINDS.NEGATIVE, title: 'increase busy_timeout to 30s' }),
  ], { threshold: 3 })
  const failed = negatives.find((f) => f.kind === 'failed-approach')
  assert.equal(failed?.count, 3)
  assert.equal(eligibleForCandidate(failed), false, 'failed approaches are findings, not candidates')

  // Recurring regression: regression-tagged records sharing a root cause.
  const regressions = detectRecurrence([
    mk('r1', { rootCause: 'flaky writer race', remedy: 'mutex' }, { tags: ['regression'] }),
    mk('r2', { rootCause: 'flaky writer race', remedy: 'mutex' }, { tags: ['regression'] }),
    mk('r3', { rootCause: 'flaky writer race', remedy: 'mutex', verifiedOutcome: 'green after mutex' }, { tags: ['regression'] }),
  ], { threshold: 3 })
  const reg = regressions.find((f) => f.kind === 'recurring-regression')
  assert.equal(reg?.count, 3)
  assert.equal(reg.remedyConsistent, true)
  assert.equal(eligibleForCandidate(reg), true, 'verified consistent regression remedy → candidate')

  // Recurring remedy across DIFFERENT root causes.
  const remedies = detectRecurrence([
    mk('m1', { rootCause: 'cause one', remedy: 'wrap in mutex' }),
    mk('m2', { rootCause: 'cause two', remedy: 'wrap in mutex' }),
    mk('m3', { rootCause: 'cause three', remedy: 'wrap in mutex' }),
  ], { threshold: 3 })
  const rem = remedies.find((f) => f.kind === 'recurring-remedy')
  assert.equal(rem?.count, 3)
  assert.equal(eligibleForCandidate(rem), false, 'remedy recurrence alone is not enough')

  // One record repeatedly failing in application.
  const persistent = detectRecurrence([
    mk('p1', { rootCause: 'solo cause', remedy: 'solo remedy' }, {
      source: { feedback: { successes: 0, failures: 3, lastOutcome: 'failure' } },
    }),
  ], { threshold: 3 })
  const hist = persistent.find((f) => f.kind === 'recurring-failure')
  assert.ok(hist, 'a record with >= threshold failures is a recurring failure')
  assert.equal(hist.failureCount, 3)
  assert.deepEqual(hist.recordIds, ['p1'])

  const below = detectRecurrence([
    mk('q1', null, { source: { feedback: { failures: 2 } } }),
  ], { threshold: 3 })
  assert.equal(below.some((f) => f.kind === 'recurring-failure'), false, '2 failures < threshold 3')
})

test('§20: recurrenceCandidate writes a deliberate derived candidate with DERIVES edges, never canonical', () => {
  const store = openEphemeralStore()
  const members = [
    putRec(store, { title: 'incident one', body: 'busy timeout on the writer under load, fixed by pinning sqlite3', source: { causal: { rootCause: 'dependency issue in writer pool', remedy: 'pin sqlite3 and serialize writes' } } }),
    putRec(store, { title: 'incident two', body: 'second busy timeout surfaced after upgrade, same fix pinned', source: { causal: { rootCause: 'dependency issue in writer pool', remedy: 'pin sqlite3 and serialize writes', verifiedOutcome: 'tests green after pin' } } }),
    putRec(store, { title: 'incident three', body: 'third occurrence on ci runner, pinned dep resolves it', source: { causal: { rootCause: 'dependency issue in writer pool', remedy: 'pin sqlite3 and serialize writes' } } }),
  ]
  const finding = detectRecurrence(members, { threshold: 3 }).find((f) => f.kind === 'root-cause')
  assert.ok(eligibleForCandidate(finding), 'fixture must be eligible')

  const res = recurrenceCandidate(store, finding, members, {})
  assert.equal(res.decision, 'ACCEPT', `expected ACCEPT, got ${res.decision}: ${res.reason}`)
  const written = res.record
  assert.equal(written.authority, AUTHORITIES.DERIVED, 'candidate-for-stronger-knowledge stays derived')
  assert.ok(written.title.startsWith('Recurring root cause (3 records)'))
  assert.equal(written.source.automatic, false, 'deliberate: tool-explicit action, not automatic learning')
  assert.equal(written.source.recurrence.count, 3)
  assert.deepEqual([...written.source.recurrence.members].sort(), members.map((m) => m.id).sort())
  assert.equal(written.source.recurrence.remedyConsistent, true)
  const derives = (written.relations || []).filter((r) => r.type === RELATIONS.DERIVES)
  assert.deepEqual(derives.map((r) => r.targetId).sort(), members.map((m) => m.id).sort(), 'DERIVES edges to every incident')
  assert.ok(written.tags.includes('learned'))

  // Idempotent: writing the identical candidate again must not duplicate it.
  const again = recurrenceCandidate(store, finding, members, {})
  assert.ok(['MERGE', 'ACCEPT'].includes(again.decision), `second write: ${again.decision}`)
  const dupes = store.list({ limit: 50 }).filter((r) => r.title.startsWith('Recurring root cause'))
  assert.equal(dupes.length, 1, 'no duplicate recurrence record')
})

test('§20: ineligible inputs defer without writing', () => {
  const store = openEphemeralStore()
  putRec(store)
  const before = store.count()

  const noFinding = recurrenceCandidate(store, null, [], {})
  assert.equal(noFinding.decision, 'DEFER')
  assert.equal(noFinding.reason, 'not-eligible')

  const failedApproach = recurrenceCandidate(store, {
    kind: 'failed-approach',
    key: 'increase busy_timeout',
    count: 5,
    recordIds: ['x', 'y', 'z'],
    remedies: ['a'],
  }, [], {})
  assert.equal(failedApproach.decision, 'DEFER')
  assert.equal(store.count(), before, 'report-only finding never writes')
})

test('§20: pure detection never touches the store (no hidden writes)', () => {
  const store = openEphemeralStore()
  const rec = putRec(store, { source: { causal: { rootCause: 'solo', remedy: 'x' }, feedback: { failures: 5 } } })
  const before = store.get(rec.id)
  detectRecurrence(store.list({ limit: 50 }), { threshold: 3 })
  assert.deepEqual(store.get(rec.id), before, 'scan is read-only')
})

// ============================================================ tools

test('tools: veyra_feedback executes §19 end-to-end and renders reliability change', () => {
  const home = mkdtempSync(join(tmpdir(), 'veyra-m6-'))
  try {
    const defs = buildToolDefinitions({ veyraHome: home, fallbackCwd: home })
    const def = defs.find((d) => d.name === 'veyra_feedback')
    assert.ok(def, 'veyra_feedback tool defined')
    const exec = { agent: { session: { id: 's1', header: { cwd: home } }, provider: 'deepseek', model: 'ds-test' } }
    const store = openProjectStore(home, projectIdFor(home))
    const rec = putRec(store, {
      validation: VALIDATIONS.VERIFIED,
      confidence: CONFIDENCES.HIGH,
      source: { observations: 4 },
    })

    const failure = def.execute({ id: rec.id, outcome: 'failure', note: 'tests failed: writer timeout' }, exec)
    assert.equal(failure.ok, true)
    assert.equal(failure.record.validation, VALIDATIONS.REVIEWED)
    assert.equal(failure.record.confidence, CONFIDENCES.MEDIUM)
    assert.equal(failure.feedback.failures, 1)
    assert.equal(failure.feedback.reliability, 0)
    const rendered = def.output.render({ id: rec.id, outcome: 'failure' }, failure).map((b) => b.text).join('\n')
    assert.match(rendered, /Feedback recorded for/)
    assert.match(rendered, /Reliability decreased: validation verified → reviewed/)
    assert.equal(def.presentCall({ id: rec.id, outcome: 'failure' }).title, 'Feedback')

    const success = def.execute({ id: rec.id, outcome: 'success' }, exec)
    assert.equal(success.ok, true)
    assert.equal(success.feedback.successes, 1)
    assert.equal(success.feedback.reliability, 0.5)

    const unknown = def.execute({ id: 'vey_missing', outcome: 'success' }, exec)
    assert.equal(unknown.ok, false)
    const badOutcome = def.execute({ id: rec.id, outcome: 'meh' }, exec)
    assert.equal(badOutcome.ok, false)
    assert.match(def.output.render({}, unknown).map((b) => b.text).join('\n'), /Feedback rejected/)
  } finally {
    closeAllStores()
  }
})

test('tools: veyra_recurrence scans read-only by default, candidates only on autoCandidate', () => {
  const home = mkdtempSync(join(tmpdir(), 'veyra-m6b-'))
  try {
    const defs = buildToolDefinitions({ veyraHome: home, fallbackCwd: home })
    const def = defs.find((d) => d.name === 'veyra_recurrence')
    assert.ok(def, 'veyra_recurrence tool defined')
    const exec = { agent: { session: { id: 's1', header: { cwd: home } }, provider: 'deepseek', model: 'ds-test' } }
    const store = openProjectStore(home, projectIdFor(home))
    const causal = { rootCause: 'dependency issue in writer pool', remedy: 'pin sqlite3 and serialize writes' }
    putRec(store, { title: 'dep incident 1', body: 'busy timeout incident one pinned dep resolves', source: { causal } })
    putRec(store, { title: 'dep incident 2', body: 'busy timeout incident two pinned dep resolves', source: { causal } })
    putRec(store, { title: 'dep incident 3', body: 'busy timeout incident three pinned dep resolves', source: { causal: { ...causal, verifiedOutcome: 'tests green after pin' } } })
    const seeded = store.count()

    // Read-only default: findings, no writes.
    const scan = def.execute({ threshold: 3 }, exec)
    assert.equal(scan.ok, true)
    assert.equal(scan.threshold, 3)
    assert.equal(scan.autoCandidate, false)
    const root = scan.findings.find((f) => f.kind === 'root-cause')
    assert.ok(root && root.count === 3 && root.remedyConsistent && root.verifiedRemedy)
    assert.deepEqual(scan.candidates, [])
    assert.equal(store.count(), seeded, 'default scan writes nothing')

    const scanned = def.output.render({ threshold: 3 }, scan).map((b) => b.text).join('\n')
    assert.match(scanned, /root-cause \[3\]/)
    assert.match(scanned, /one remedy/)

    // Explicit candidate gate writes once, deliberately.
    const gated = def.execute({ threshold: 3, autoCandidate: true }, exec)
    assert.equal(gated.candidates.length, 1)
    assert.equal(gated.candidates[0].decision, 'ACCEPT')
    assert.equal(store.count(), seeded + 1)
    const written = store.get(gated.candidates[0].id)
    assert.equal(written.authority, AUTHORITIES.DERIVED)
    assert.equal(written.source.automatic, false)

    const repeat = def.execute({ threshold: 3, autoCandidate: true }, exec)
    assert.ok(['MERGE', 'ACCEPT'].includes(repeat.candidates[0].decision))
    assert.equal(store.count(), seeded + 1, 'repeat scan never duplicates the candidate')

    // Empty store → friendly empty render.
    const emptyHome = mkdtempSync(join(tmpdir(), 'veyra-m6c-'))
    const emptyDef = buildToolDefinitions({ veyraHome: emptyHome, fallbackCwd: emptyHome }).find((d) => d.name === 'veyra_recurrence')
    const emptyExec = { agent: { session: { id: 's2', header: { cwd: emptyHome } }, provider: 'deepseek', model: 'ds-test' } }
    const emptyValue = emptyDef.execute({ threshold: 3 }, emptyExec)
    assert.deepEqual(emptyValue.findings, [])
    const emptyText = emptyDef.output.render({ threshold: 3 }, emptyValue).map((b) => b.text).join('\n')
    assert.match(emptyText, /No recurring engineering problem detected/)
  } finally {
    closeAllStores()
  }
})
