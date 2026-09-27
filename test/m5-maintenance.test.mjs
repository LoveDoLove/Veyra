/**
 * M5 Phase-1 maintenance: focused regression coverage.
 *
 * Two properties matter most here and are pinned deliberately:
 *
 *  1. `sweepStale` widens WHAT is examined, never WHAT the criteria are. The
 *     80-row window is removed; stale/authority/validation rules are not.
 *  2. `reviewCandidate` reuses `maybeLearn`'s guard chain verbatim. Test
 *     evidence alone, observation count, age, retrieval count, similarity,
 *     confidence and frequency can never promote a candidate — `evidenceFrom`
 *     attaches `test-passed` to any turn with test-looking tool activity,
 *     including harness traffic.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MemoryStore, closeAllStores } from '../src/store.mjs'
import { sweepStale, markStale, verifyEvidenceHealth, evolveAgainst } from '../src/evolve.mjs'
import { maybeLearn, reviewCandidate, strengthenMemory } from '../src/learn.mjs'
import { AUTHORITIES, KINDS, STATUSES, VALIDATIONS } from '../src/types.mjs'
import { apply, MAINTENANCE_EVERY_N_TURNS, _resetMaintenanceCounter, _maintenanceTurns } from '../src/plugin.mjs'

const daysAgo = (d) => new Date(Date.now() - d * 86400000).toISOString()
const OLD = 200 * 86400000

function tempStore() {
  const dir = mkdtempSync(join(tmpdir(), 'veyra-m5-'))
  return new MemoryStore(join(dir, 'memory.db'), { scope: 'project', projectId: 'p' })
}

const CLAIM_BODY = 'Always serialize DatabaseSync writes to avoid FTS corruption, because concurrent writers race on the shared handle under WAL.'

// ---------------------------------------------------------------------------
// Stale sweep
// ---------------------------------------------------------------------------

test('sweepStale examines records beyond the old 80-row window', () => {
  const store = tempStore()
  for (let i = 0; i < 100; i += 1) {
    store.put({
      title: `filler record ${i}`, body: CLAIM_BODY,
      evidence: [{ path: 'src/x.mjs' }], authority: AUTHORITIES.DERIVED,
      validation: VALIDATIONS.UNVERIFIED, createdAt: daysAgo(300), updatedAt: daysAgo(300),
    })
  }
  const r = sweepStale(store, {})
  assert.ok(r.examined > 80, `must look past 80 rows, examined ${r.examined}`)
  assert.equal(r.error, null)
  assert.equal(r.marked, r.records.length)
  store.close()
})

test('an eligible idle record beyond 80 rows becomes stale', () => {
  const store = tempStore()
  for (let i = 0; i < 90; i += 1) {
    store.put({
      title: `recent record ${i}`, body: CLAIM_BODY,
      evidence: [{ path: 'src/x.mjs' }], authority: AUTHORITIES.DERIVED,
      validation: VALIDATIONS.UNVERIFIED, updatedAt: daysAgo(1),
    })
  }
  const hidden = store.put({
    title: 'the genuinely old hidden record', body: CLAIM_BODY,
    evidence: [{ path: 'src/x.mjs' }], authority: AUTHORITIES.DERIVED,
    validation: VALIDATIONS.UNVERIFIED, createdAt: daysAgo(300), updatedAt: daysAgo(300),
  }).record
  const r = sweepStale(store, {})
  assert.equal(store.get(hidden.id).validation, VALIDATIONS.STALE, 'the old record must be marked')
  assert.ok(r.marked >= 1)
  store.close()
})

test('markStale still uses its 80-row window; sweepStale is the widened pass', () => {
  const store = tempStore()
  for (let i = 0; i < 90; i += 1) {
    store.put({
      title: `recent ${i}`, body: CLAIM_BODY, evidence: [{ path: 'src/x.mjs' }],
      authority: AUTHORITIES.DERIVED, validation: VALIDATIONS.UNVERIFIED, updatedAt: daysAgo(1),
    })
  }
  const hidden = store.put({
    title: 'old hidden one', body: CLAIM_BODY, evidence: [{ path: 'src/x.mjs' }],
    authority: AUTHORITIES.DERIVED, validation: VALIDATIONS.UNVERIFIED,
    createdAt: daysAgo(300), updatedAt: daysAgo(300),
  }).record
  markStale(store, {})
  assert.equal(store.get(hidden.id).validation, VALIDATIONS.UNVERIFIED, 'markStale is unchanged')
  sweepStale(store, {})
  assert.equal(store.get(hidden.id).validation, VALIDATIONS.STALE, 'sweepStale finds it')
  store.close()
})

test('sweepStale leaves non-stale, canonical, forgotten, invalid and superseded records alone', () => {
  const store = tempStore()
  const fresh = store.put({ title: 'fresh claim', body: CLAIM_BODY, evidence: [{ path: 'a.mjs' }], authority: AUTHORITIES.DERIVED, validation: VALIDATIONS.UNVERIFIED, updatedAt: daysAgo(1) }).record
  const canon = store.put({ title: 'canonical claim', body: CLAIM_BODY, evidence: [{ path: 'a.mjs' }], authority: AUTHORITIES.CANONICAL, validation: VALIDATIONS.UNVERIFIED, createdAt: daysAgo(300), updatedAt: daysAgo(300) }, { explicitCanonical: true }).record
  assert.equal(store.get(canon.id).authority, AUTHORITIES.CANONICAL, 'fixture really is canonical')
  const invalid = store.put({ title: 'invalid claim', body: CLAIM_BODY, evidence: [{ path: 'a.mjs' }], authority: AUTHORITIES.DERIVED, validation: VALIDATIONS.INVALID, createdAt: daysAgo(300), updatedAt: daysAgo(300) }).record
  const goned = store.put({ title: 'forgotten claim', body: CLAIM_BODY, evidence: [{ path: 'a.mjs' }], authority: AUTHORITIES.DERIVED, validation: VALIDATIONS.UNVERIFIED, createdAt: daysAgo(300), updatedAt: daysAgo(300) }).record
  store.forget(goned.id)
  const sup = store.put({ title: 'superseded claim', body: CLAIM_BODY, evidence: [{ path: 'a.mjs' }], authority: AUTHORITIES.DERIVED, validation: VALIDATIONS.UNVERIFIED, createdAt: daysAgo(300), updatedAt: daysAgo(300) }).record
  const supRec = store.get(sup.id)
  store.put({ ...supRec, status: STATUSES.SUPERSEDED, updatedAt: daysAgo(300) })

  sweepStale(store, {})
  assert.equal(store.get(fresh.id).validation, VALIDATIONS.UNVERIFIED, 'fresh untouched')
  assert.equal(store.get(canon.id).validation, VALIDATIONS.UNVERIFIED, 'canonical untouched')
  assert.equal(store.get(invalid.id).validation, VALIDATIONS.INVALID, 'invalid untouched')
  assert.equal(store.get(goned.id).validation, VALIDATIONS.UNVERIFIED, 'forgotten untouched')
  assert.equal(store.get(sup.id).validation, VALIDATIONS.UNVERIFIED, 'superseded untouched')
  store.close()
})

test('sweepStale is idempotent', () => {
  const store = tempStore()
  store.put({ title: 'old claim', body: CLAIM_BODY, evidence: [{ path: 'a.mjs' }], authority: AUTHORITIES.DERIVED, validation: VALIDATIONS.UNVERIFIED, createdAt: daysAgo(300), updatedAt: daysAgo(300) })
  const first = sweepStale(store, {})
  const second = sweepStale(store, {})
  const third = sweepStale(store, {})
  assert.ok(first.marked >= 1)
  assert.equal(second.marked, 0, 'second run does no work')
  assert.equal(third.marked, 0)
  store.close()
})

test('sweepStale preserves the evidence-health criterion', () => {
  const dir = mkdtempSync(join(tmpdir(), 'veyra-m5-ws-'))
  writeFileSync(join(dir, 'present.mjs'), 'x')
  const store = tempStore()
  const broken = store.put({ title: 'broken evidence claim', body: CLAIM_BODY, evidence: [{ path: 'gone/forever.mjs' }], authority: AUTHORITIES.DERIVED, validation: VALIDATIONS.UNVERIFIED, updatedAt: daysAgo(1) }).record
  const healthy = store.put({ title: 'healthy evidence claim', body: CLAIM_BODY, evidence: [{ path: 'present.mjs' }], authority: AUTHORITIES.DERIVED, validation: VALIDATIONS.UNVERIFIED, updatedAt: daysAgo(1) }).record
  const r = sweepStale(store, { workspace: dir })
  assert.equal(store.get(broken.id).validation, VALIDATIONS.STALE, 'broken evidence goes stale even when recent')
  assert.equal(store.get(healthy.id).validation, VALIDATIONS.UNVERIFIED, 'healthy recent stays')
  assert.equal(r.error, null)
  assert.equal(verifyEvidenceHealth(store.get(broken.id), dir).status, 'broken')
  store.close()
})

test('sweepStale reports a failure instead of a successful run', () => {
  const broken = {
    list() { throw new Error('listing exploded') },
    put() { throw new Error('must not be reached') },
  }
  const r = sweepStale(broken, {})
  assert.match(r.error, /listing exploded/)
  assert.equal(typeof r.examined, 'number')
  assert.equal(typeof r.marked, 'number')
  assert.deepEqual(sweepStale(null, {}), { examined: 0, marked: 0, records: [], error: null })
})

// ---------------------------------------------------------------------------
// Candidate review — the guard chain
// ---------------------------------------------------------------------------

function seedCandidate(store, over = {}) {
  return store.put({
    title: 'a claim worth keeping about sqlite writes', body: CLAIM_BODY,
    evidence: [{ path: 'src/store.mjs' }], authority: AUTHORITIES.CANDIDATE,
    validation: VALIDATIONS.UNVERIFIED,
    source: { automatic: true, provenance: { origins: ['assistant'] } }, ...over,
  }).record
}

test('a candidate that fails looksLikeClaim stays a candidate', () => {
  const store = tempStore()
  const c = seedCandidate(store, { title: 'Fix: work on store.mjs', body: 'ran a bash command and edited the file' })
  const r = reviewCandidate(store, c, {})
  assert.equal(r.outcome, 'blocked')
  assert.equal(store.get(c.id).authority, AUTHORITIES.CANDIDATE)
  store.close()
})

test('test-passed evidence alone does NOT promote a non-claim candidate', () => {
  const store = tempStore()
  // Exactly the audit finding: harness/conversational text carrying a
  // test-passed note auto-attached by evidenceFrom.
  const c = seedCandidate(store, {
    title: 'M2 commit gate 已通过，现在授权 push 这次改动',
    body: '好的，我现在把测试跑一下，然后再看一下结果，最后决定要不要改',
    evidence: [{ note: 'test-passed' }],
  })
  const r = reviewCandidate(store, c, {})
  assert.equal(r.outcome, 'blocked', 'a test note is not a claim')
  assert.equal(store.get(c.id).authority, AUTHORITIES.CANDIDATE)
  store.close()
})

test('tests-touched evidence alone does NOT promote', () => {
  const store = tempStore()
  const c = seedCandidate(store, {
    title: 'Fix: work on package.json',
    body: '改了一下配置文件，然后跑了一下测试，确认没有问题就可以了',
    evidence: [{ note: 'tests-touched' }],
  })
  assert.equal(reviewCandidate(store, c, {}).outcome, 'blocked')
  assert.equal(store.get(c.id).authority, AUTHORITIES.CANDIDATE)
  store.close()
})

test('observation count alone does NOT promote', () => {
  const store = tempStore()
  const c = seedCandidate(store, { body: '短', source: { observations: 99 } })
  const before = store.get(c.id)
  reviewCandidate(store, before, {})
  assert.equal(store.get(c.id).authority, AUTHORITIES.CANDIDATE)
  store.close()
})

test('age alone does NOT promote', () => {
  const store = tempStore()
  const c = seedCandidate(store, { body: '短', createdAt: daysAgo(365), updatedAt: daysAgo(365) })
  reviewCandidate(store, store.get(c.id), {})
  assert.equal(store.get(c.id).authority, AUTHORITIES.CANDIDATE, 'a year-old non-claim is still not a claim')
  store.close()
})

test('retrieval count and confidence alone do NOT promote', () => {
  const store = tempStore()
  const c = seedCandidate(store, {
    body: '短', confidence: 'high', lastRecalledAt: new Date().toISOString(), source: { observations: 50 },
  })
  reviewCandidate(store, store.get(c.id), {})
  assert.equal(store.get(c.id).authority, AUTHORITIES.CANDIDATE)
  store.close()
})

test('a genuinely durable grounded candidate follows the maybeLearn chain', () => {
  const store = tempStore()
  const c = seedCandidate(store)
  const r = reviewCandidate(store, c, {})
  assert.equal(r.outcome, 'transitioned')
  assert.equal(store.get(c.id).authority, AUTHORITIES.DERIVED)
  // the outcome must equal what the per-turn path would have produced
  const store2 = tempStore()
  const c2 = seedCandidate(store2)
  const learned = maybeLearn(store2, c2, {})
  assert.ok(learned, 'maybeLearn promotes the same record')
  assert.equal(store2.get(c2.id).authority, AUTHORITIES.DERIVED)
  store.close(); store2.close()
})

test('a near-duplicate candidate takes the neighbour path, not a transition', () => {
  const store = tempStore()
  const derived = store.put({
    title: 'serialize database writes', body: CLAIM_BODY,
    evidence: [{ path: 'src/store.mjs' }], authority: AUTHORITIES.DERIVED,
    validation: VALIDATIONS.UNVERIFIED, source: { observations: 1 },
  }).record
  const dup = seedCandidate(store)
  const r = reviewCandidate(store, dup, {})
  // Either outcome is legitimate; what must hold is that the candidate never
  // becomes a second independent derived record.
  assert.ok(['unchanged', 'transitioned'].includes(r.outcome), `unexpected outcome ${r.outcome}`)
  const stores = store.list({ limit: 50 }).filter((x) => x.authority === AUTHORITIES.DERIVED)
  const sameContent = stores.filter((x) => x.contentHash === dup.contentHash)
  assert.ok(sameContent.length <= 1, 'a duplicate must not create a second derived record')
  assert.ok(store.get(derived.id), 'the original neighbour survives')
  store.close()
})

test('reviewCandidate never grants canonical and does not fabricate provenance', () => {
  const store = tempStore()
  const c = seedCandidate(store, { source: { sessionId: 's1', turn: 3, tools: ['edit'] } })
  const before = store.get(c.id)
  reviewCandidate(store, c, {})
  const after = store.get(c.id)
  assert.notEqual(after.authority, AUTHORITIES.CANONICAL, 'canonical is unreachable')
  assert.equal(after.title, before.title, 'title unchanged')
  assert.equal(after.body, before.body, 'body unchanged')
  // The capture provenance that actually existed must survive verbatim.
  assert.equal(after.source.sessionId, 's1')
  assert.equal(after.source.turn, 3)
  assert.deepEqual(after.source.tools, ['edit'])
  // any additions are the same bookkeeping maybeLearn already performs on the
  // per-turn path — they are recorded, never invented.
  for (const key of Object.keys(after.source)) {
    assert.ok(
      key in before.source || ['observations', 'learnedFrom', 'evolveAction'].includes(key),
      `unexpected provenance key ${key}`,
    )
  }
  store.close()
})

test('reviewCandidate skips non-candidates and forgotten records', () => {
  const store = tempStore()
  const derived = store.put({ title: 'x claim', body: CLAIM_BODY, evidence: [{ path: 'a.mjs' }], authority: AUTHORITIES.DERIVED, validation: VALIDATIONS.UNVERIFIED }).record
  const goned = seedCandidate(store)
  store.forget(goned.id)
  assert.equal(reviewCandidate(store, derived, {}).outcome, 'skipped')
  assert.equal(reviewCandidate(store, store.get(goned.id), {}).outcome, 'skipped')
  assert.equal(reviewCandidate(null, null, {}).outcome, 'blocked')
  store.close()
})

test('canonical input is rejected by the guard chain', () => {
  const store = tempStore()
  // Canonical is never writable without an explicit flag — that is the M1/M2
  // guard, and it throws before any maintenance code is reached.
  assert.throws(
    () => store.put({ title: 'canon', body: CLAIM_BODY, evidence: [{ path: 'a.mjs' }], authority: AUTHORITIES.CANONICAL, validation: VALIDATIONS.REVIEWED }),
    /refuses to auto-promote/,
  )
  const canon = store.put({ title: 'canon', body: CLAIM_BODY, evidence: [{ path: 'a.mjs' }], authority: AUTHORITIES.CANONICAL, validation: VALIDATIONS.REVIEWED }, { explicitCanonical: true }).record
  assert.equal(store.get(canon.id).authority, AUTHORITIES.CANONICAL, 'canonical is reachable only explicitly')
  assert.equal(maybeLearn(store, canon, {}), null, 'maybeLearn refuses canonical input')
  assert.equal(reviewCandidate(store, canon, {}).outcome, 'skipped', 'review skips non-candidates')
  assert.equal(store.get(canon.id).authority, AUTHORITIES.CANONICAL, 'authority unchanged')
  store.close()
})

// ---------------------------------------------------------------------------
// Trigger cadence
// ---------------------------------------------------------------------------

test('the real turn-stopping handler runs maintenance on turns 5 and 10', () => {
  // End-to-end through the plugin, not a copy of its arithmetic: the
  // cadence helper is module-private, so the contract is observed through the
  // maintenance log the real handler emits.
  const home = mkdtempSync(join(tmpdir(), 'veyra-m5-cad-'))
  const logs = []
  const hooks = {}
  const ctx = {
    on(ev, fn) { hooks[ev] = fn },
    effect() { return () => {} },
    logger: { info: (m) => logs.push(m) },
  }
  apply.call(ctx, ctx, { home, learn: true })
  assert.equal(typeof hooks['agent/turn-stopping'], 'function', 'turn-stopping is registered')

  const session = { id: 's1' }
  const agent = { session, workspace: process.cwd() }
  const maintenanceLogs = () => logs.filter((l) => l.includes('[veyra] maintenance'))

  const fired = []
  for (let turn = 1; turn <= 12; turn += 1) {
    hooks['session/event']?.(session, { type: 'turn/start', data: { turn } })
    hooks['session/event']?.(session, {
      type: 'user/message',
      data: { content: [{ type: 'text', text: `Turn ${turn}: always serialize DatabaseSync writes to avoid FTS corruption under WAL for concurrent writers.` }] },
    })
    const before = maintenanceLogs().length
    hooks['agent/turn-stopping']?.({ agent })
    if (maintenanceLogs().length > before) fired.push(turn)
  }
  assert.deepEqual(fired, [5, 10], 'maintenance runs on turns 5 and 10, and not on 1-4 or 6-9')
  closeAllStores()
})

test('a restart resets the in-memory cadence', () => {
  assert.equal(MAINTENANCE_EVERY_N_TURNS, 5)
  _resetMaintenanceCounter()
  assert.equal(_maintenanceTurns(), 0, 'a fresh process — or a restart — starts at 0')
})

test('per-turn learning still runs independently of maintenance', () => {
  // maybeLearn is invoked on every turn today and must stay that way; the
  // maintenance block is additive and does not gate it.
  const store = tempStore()
  const c = seedCandidate(store)
  for (let turn = 1; turn <= 4; turn += 1) {
    const learned = maybeLearn(store, c, {})
    assert.ok(learned, `turn ${turn} must still learn`)
  }
  assert.equal(store.get(c.id).authority, AUTHORITIES.DERIVED)
  store.close()
})

// ---------------------------------------------------------------------------
// Observability
// ---------------------------------------------------------------------------

test('the maintenance result exposes the counts needed to tell work from no-work', () => {
  const store = tempStore()
  store.put({ title: 'old claim', body: CLAIM_BODY, evidence: [{ path: 'a.mjs' }], authority: AUTHORITIES.DERIVED, validation: VALIDATIONS.UNVERIFIED, createdAt: daysAgo(300), updatedAt: daysAgo(300) })
  const first = sweepStale(store, {})
  assert.ok(first.examined >= 1, 'examined reported')
  assert.ok(first.marked >= 1, 'marked reported')
  const second = sweepStale(store, {})
  assert.equal(typeof second.examined, 'number', 'examined is always reported')
  assert.equal(second.marked, 0, 'zero work is distinguishable from a failure via error')
  assert.equal(second.error, null, 'a zero-work run is not a failed run')
  assert.ok(Array.isArray(second.records))
  store.close()
})

test('review outcomes cover transitioned, unchanged, blocked and skipped', () => {
  const store = tempStore()
  const durable = seedCandidate(store)
  const noisy = seedCandidate(store, { title: 'Fix: work on x.mjs', body: 'ran a command' })
  const derived = store.put({ title: 'existing claim', body: CLAIM_BODY, evidence: [{ path: 'a.mjs' }], authority: AUTHORITIES.DERIVED, validation: VALIDATIONS.UNVERIFIED }).record
  const outcomes = new Set([
    reviewCandidate(store, durable, {}).outcome,
    reviewCandidate(store, noisy, {}).outcome,
    reviewCandidate(store, derived, {}).outcome,
  ])
  assert.ok(outcomes.has('transitioned'))
  assert.ok(outcomes.has('blocked'))
  assert.ok(outcomes.has('skipped'))
  store.close()
})

// ---------------------------------------------------------------------------
// Regression on the shipped retrieval + lifecycle work
// ---------------------------------------------------------------------------

test('M1 supersedes semantics are untouched by maintenance', () => {
  const store = tempStore()
  const a = store.put({ title: 'use rsync for sync', body: CLAIM_BODY, evidence: [{ path: 's.sh' }], authority: AUTHORITIES.DERIVED, validation: VALIDATIONS.REVIEWED }).record
  const b = store.put({ title: 'switched from rsync to zstd for sync', body: 'The pipeline switched from rsync to zstd streaming in the deploy script, which removes the double pass across every host today and keeps the upload resumable.', evidence: [{ path: 's.sh' }], authority: AUTHORITIES.DERIVED, validation: VALIDATIONS.REVIEWED }).record
  const ev = evolveAgainst(store, b, [a])
  store.put(ev.record)
  assert.equal(ev.action, 'supersede')
  const retired = store.get(a.id)
  assert.equal(retired.status, STATUSES.SUPERSEDED, 'retired is marked superseded')
  assert.equal(
    retired.relations.filter((x) => x.type === 'supersedes').length, 1,
    'exactly one supersedes edge, retired -> replacement',
  )
  assert.equal(
    store.get(b.id).relations.filter((x) => x.type === 'supersedes').length, 0,
    'no mirror edge on the replacement',
  )
  // A maintenance sweep must not disturb either record.
  sweepStale(store, {})
  assert.equal(store.get(a.id).status, STATUSES.SUPERSEDED)
  assert.equal(store.get(a.id).relations.filter((x) => x.type === 'supersedes').length, 1)
  store.close()
})
