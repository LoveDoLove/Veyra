/**
 * M9 — Provenance-aware automated learning gate.
 *
 * Policy (fixed by the M9 audit):
 *   - Deliberate records (`source.automatic === false`, i.e. explicit
 *     `veyra_remember`) are never gated and need no provenance.
 *   - Automatic records may enter the learning pipeline only on provenance
 *     ["assistant"] or ["assistant", "tool"]. Anything containing "user",
 *     ["tool"] alone, missing/malformed provenance, empty origins and
 *     unknown origin values is UNKNOWN provenance and fails closed.
 *   - The gate answers only "May this automatically enter the learning
 *     pipeline?" — never "Is this fact true?". A blocked record is only not
 *     learned: it stays captured, undeleted, uninvalidated, with provenance
 *     and lifecycle untouched.
 *
 * Covered here: deliberate eligibility; allowed origins; the five blocked
 * combinations; missing/malformed/empty/unknown provenance; existing guards
 * unchanged for allowed records (canonical, durability, content-hash,
 * duplicate strengthening, maintenance re-review, evolution, supersession,
 * staleness sweep); candidate preservation; cross-project isolation.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  AUTHORITIES,
  KINDS,
  STATUSES,
  VALIDATIONS,
} from '../src/types.mjs'
import { openEphemeralStore } from '../src/store.mjs'
import { maybeLearn, provenanceAllowsLearning, remember, reviewCandidate } from '../src/learn.mjs'
import { sweepStale } from '../src/evolve.mjs'

const TITLE = 'Serialize DatabaseSync writes'
const BODY = 'The root cause is concurrent DatabaseSync writes corrupting FTS triggers. The remedy is to serialize every write through a mutex around the shared handle.'

const daysAgo = (d) => new Date(Date.now() - d * 86400000).toISOString()

const mkCandidate = (source, overrides = {}) => ({
  title: overrides.title ?? TITLE,
  body: overrides.body ?? BODY,
  scope: 'project',
  projectId: 'p_m9',
  kind: KINDS.OBSERVATION,
  authority: AUTHORITIES.CANDIDATE,
  tags: ['m9'],
  evidence: [{ path: 'src/store.mjs' }],
  source,
  ...overrides,
})

const capture = (store, source, overrides = {}) => store.put(mkCandidate(source, overrides)).record

// ------------------------------------------------------- policy matrix (unit)

test('M9: provenanceAllowsLearning matrix', () => {
  // Deliberate channel — no provenance requirement, ever.
  assert.equal(provenanceAllowsLearning({ source: { automatic: false, tool: 'veyra_remember' } }), true)
  assert.equal(provenanceAllowsLearning({ source: { automatic: false, provenance: { origins: ['user'] } } }), true)

  // Allowed automatic provenance.
  assert.equal(provenanceAllowsLearning({ source: { automatic: true, provenance: { origins: ['assistant'] } } }), true)
  assert.equal(provenanceAllowsLearning({ source: { automatic: true, provenance: { origins: ['assistant', 'tool'] } } }), true)

  // Blocked combinations.
  const blocked = [
    ['user', ['user']],
    ['user+assistant', ['user', 'assistant']],
    ['user+tool', ['user', 'tool']],
    ['user+assistant+tool', ['user', 'assistant', 'tool']],
    ['tool only', ['tool']],
  ]
  for (const [label, origins] of blocked) {
    assert.equal(
      provenanceAllowsLearning({ source: { automatic: true, provenance: { origins } } }),
      false,
      `blocked: ${label}`,
    )
  }

  // Unknown / legacy provenance fails closed.
  assert.equal(provenanceAllowsLearning({ source: { automatic: true } }), false, 'provenance absent')
  assert.equal(provenanceAllowsLearning({ source: { automatic: true, provenance: null } }), false, 'provenance null')
  assert.equal(provenanceAllowsLearning({ source: { automatic: true, provenance: { origins: [] } } }), false, 'origins === []')
  assert.equal(provenanceAllowsLearning({ source: { automatic: true, provenance: { origins: 'assistant' } } }), false, 'origins not an array')
  assert.equal(provenanceAllowsLearning({ source: { automatic: true, provenance: 'assistant' } }), false, 'provenance not an object')
  assert.equal(provenanceAllowsLearning({ source: { automatic: true, provenance: { origins: ['assistant', 'alien'] } } }), false, 'unknown origin value')
  assert.equal(provenanceAllowsLearning({ source: { automatic: true, provenance: { origins: ['ASSISTANT'] } } }), false, 'case-sensitive origin')
  assert.equal(provenanceAllowsLearning({ source: { automatic: true, provenance: { origins: [null] } } }), false, 'non-string origin')
  assert.equal(provenanceAllowsLearning({}), false, 'no source at all')
  assert.equal(provenanceAllowsLearning(null), false, 'no record')
})

// -------------------------------------------------- deliberate stays eligible

test('M9: deliberate records learn without any provenance', () => {
  const store = openEphemeralStore()
  try {
    // Exactly what the veyra_remember tool stamps: automatic:false, no provenance.
    const written = remember(store, {
      title: TITLE,
      body: BODY,
      evidence: [{ path: 'src/store.mjs' }],
      source: { tool: 'veyra_remember', automatic: false },
    })
    assert.ok(written.record)
    assert.equal(written.record.source.automatic, false)
    assert.equal(written.record.source.provenance, undefined, 'deliberate record carries no provenance')

    // The deliberate record is not blocked by the gate on any automatic path.
    const learned = maybeLearn(store, { ...written.record, authority: AUTHORITIES.CANDIDATE })
    assert.ok(learned, 'deliberate record passes the gate without provenance')
    assert.equal(learned.authority, AUTHORITIES.DERIVED)
    assert.equal(learned.source.automatic, false, 'deliberate stamp untouched')
    assert.equal(learned.source.provenance, undefined, 'no provenance invented')
  } finally {
    store.close()
  }
})

// ------------------------------------------------------- allowed provenance

test('M9: assistant and assistant+tool provenance learn', () => {
  const store = openEphemeralStore()
  try {
    const variants = [
      { origins: ['assistant'], title: TITLE, body: BODY },
      {
        origins: ['assistant', 'tool'],
        title: 'Serialize request logs per tenant',
        body: 'The root cause is interleaved request logs across tenants. The remedy is to prefix every log line with a tenant id at the ingestion boundary.',
      },
    ]
    for (const { origins, title, body } of variants) {
      const source = { automatic: true, provenance: { origins } }
      const written = store.put(mkCandidate(source, { title, body }))
      const learned = maybeLearn(store, { ...written.record })
      assert.ok(learned, `origins [${origins}] must learn`)
      assert.equal(learned.authority, AUTHORITIES.DERIVED)
      assert.deepEqual(learned.source.provenance, { origins }, 'derived write preserves provenance verbatim')
      const reread = store.get(learned.id)
      assert.deepEqual(reread.source.provenance, { origins }, 'reread preserves provenance')
      assert.equal(reread.source.automatic, true, 'automatic stamp preserved')
    }
  } finally {
    store.close()
  }
})

// ---------------------------------------------------- user-involving blocked

test('M9: user-involving and tool-only provenance are blocked', () => {
  const store = openEphemeralStore()
  try {
    const combos = [
      ['user'],
      ['user', 'assistant'],
      ['user', 'tool'],
      ['user', 'assistant', 'tool'],
      ['tool'],
    ]
    for (const origins of combos) {
      const source = { automatic: true, provenance: { origins } }
      const before = capture(store, source, { title: `Blocked claim for ${origins.join('+')}` })
      const countBefore = store.list({ limit: 200 }).length
      const learned = maybeLearn(store, { ...before })
      assert.equal(learned, null, `origins [${origins}] must not learn`)

      const after = store.get(before.id)
      assert.equal(after.authority, AUTHORITIES.CANDIDATE, 'stays a candidate')
      assert.deepEqual(after.source, before.source, 'provenance unchanged')
      assert.equal(after.forgotten || false, false, 'not deleted or forgotten')
      assert.equal(store.list({ limit: 200 }).length, countBefore, 'no new record created')
    }
  } finally {
    store.close()
  }
})

// -------------------------------------------- unknown provenance fails closed

test('M9: missing, malformed, empty and unknown provenance fail closed', () => {
  const store = openEphemeralStore()
  try {
    const cases = [
      ['provenance absent', { automatic: true }],
      ['provenance null', { automatic: true, provenance: null }],
      ['origins empty', { automatic: true, provenance: { origins: [] } }],
      ['origins not array', { automatic: true, provenance: { origins: 'assistant' } }],
      ['provenance not object', { automatic: true, provenance: 'assistant' }],
      ['unknown origin value', { automatic: true, provenance: { origins: ['assistant', 'alien'] } }],
      ['non-string origin', { automatic: true, provenance: { origins: [42] } }],
      ['flag absent, provenance absent', {}],
    ]
    for (const [label, source] of cases) {
      const before = capture(store, source, { title: `Legacy claim: ${label}` })
      const learned = maybeLearn(store, { ...before })
      assert.equal(learned, null, `${label} must fail closed`)
      assert.deepEqual(store.get(before.id).source, before.source, `${label}: record untouched`)
    }
  } finally {
    store.close()
  }
})

// ------------------------------------ existing guards unchanged for ALLOWED

test('M9: canonical authority still blocks an allowed record', () => {
  const store = openEphemeralStore()
  try {
    const candidate = mkCandidate({ automatic: true, provenance: { origins: ['assistant'] } }, {
      authority: AUTHORITIES.CANONICAL,
    })
    assert.equal(maybeLearn(store, candidate), null)
  } finally {
    store.close()
  }
})

test('M9: durability still blocks an allowed record', () => {
  const store = openEphemeralStore()
  try {
    const learned = maybeLearn(store, mkCandidate({ automatic: true, provenance: { origins: ['assistant'] } }, {
      title: 'Looked at files',
      body: 'Opened a few files and listed the directory. Nothing conclusive yet.',
    }))
    assert.equal(learned, null)
  } finally {
    store.close()
  }
})

test('M9: exact content-hash duplicate still blocks an allowed record', () => {
  const store = openEphemeralStore()
  try {
    const existing = store.put(mkCandidate({ automatic: true, provenance: { origins: ['assistant'] } }, {
      authority: AUTHORITIES.DERIVED,
    })).record
    assert.equal(existing.authority, AUTHORITIES.DERIVED)
    const learned = maybeLearn(store, mkCandidate({ automatic: true, provenance: { origins: ['assistant'] } }))
    assert.equal(learned, null, 'identical content hash must not re-learn')
    assert.equal(store.get(existing.id).authority, AUTHORITIES.DERIVED, 'existing record untouched')
  } finally {
    store.close()
  }
})

test('M9: near-duplicate strengthening still runs for allowed records', () => {
  const store = openEphemeralStore()
  const source = { automatic: true, provenance: { origins: ['assistant'] } }
  try {
    const neighborBody = 'Always serialize DatabaseSync writes to avoid FTS corruption, because concurrent writers race on the shared handle under WAL.'
    const neighbor = store.put(mkCandidate(source, {
      authority: AUTHORITIES.DERIVED,
      body: neighborBody,
    })).record
    assert.equal(neighbor.authority, AUTHORITIES.DERIVED)

    const candidate = store.put(mkCandidate(source, {
      title: 'Serialize DatabaseSync writes',
      body: `${neighborBody} now`,
    })).record
    const learned = maybeLearn(store, { ...candidate })
    assert.equal(learned, null, 'near-duplicate is not new learning')

    const strengthened = store.get(neighbor.id)
    assert.ok((strengthened.source.observations || 1) >= 2, 'neighbor observation count incremented')
    assert.deepEqual(strengthened.source.provenance, { origins: ['assistant'] }, 'neighbor provenance preserved')
    assert.equal(strengthened.authority, AUTHORITIES.DERIVED, 'neighbor stays derived')
    assert.equal(store.get(candidate.id).authority, AUTHORITIES.CANDIDATE, 'candidate stays inspectable')
  } finally {
    store.close()
  }
})

test('M9: maintenance re-review transitions allowed and leaves blocked unchanged', () => {
  const store = openEphemeralStore()
  try {
    const allowed = capture(store, { automatic: true, provenance: { origins: ['assistant'] } })
    const transitioned = reviewCandidate(store, allowed)
    assert.equal(transitioned.outcome, 'transitioned')
    assert.equal(transitioned.authority, AUTHORITIES.DERIVED)

    const blocked = capture(store, { automatic: true, provenance: { origins: ['user'] } }, { title: 'Blocked maintenance claim' })
    const unchanged = reviewCandidate(store, blocked)
    assert.equal(unchanged.outcome, 'unchanged')
    assert.equal(store.get(blocked.id).authority, AUTHORITIES.CANDIDATE, 'blocked record stays a candidate')
    assert.deepEqual(store.get(blocked.id).source, blocked.source, 'blocked provenance untouched by maintenance')
  } finally {
    store.close()
  }
})

test('M9: evolution relations still seed for allowed records', () => {
  const store = openEphemeralStore()
  try {
    const other = store.put(mkCandidate({ automatic: true, provenance: { origins: ['assistant'] } }, {
      title: 'Rotate deployment tokens quarterly',
      body: 'The deployment tokens must be rotated every quarter so leaked credentials expire before they are abused.',
      authority: AUTHORITIES.DERIVED,
    })).record
    const candidate = store.put(mkCandidate({ automatic: true, provenance: { origins: ['assistant', 'tool'] } }, {
      title: 'Rotate staging tokens quarterly',
      body: 'The staging tokens must be rotated every quarter so leaked credentials expire before anyone reuses them.',
    })).record
    const learned = maybeLearn(store, { ...candidate }, { related: [{ id: other.id }] })
    assert.ok(learned, 'allowed record learns with related seed')
    assert.ok(
      (learned.relations || []).some((r) => r.type === 'derives' || r.targetId === other.id),
      'DERIVES relation seeded',
    )
  } finally {
    store.close()
  }
})

test('M9: supersession lifecycle still runs for allowed records', () => {
  const store = openEphemeralStore()
  const source = { automatic: true, provenance: { origins: ['assistant'] } }
  try {
    const oldRec = store.put(mkCandidate(source, {
      title: 'Deploy uses rsync for artifact sync',
      body: 'The deploy pipeline always syncs build artifacts to the release host with rsync over ssh.',
      evidence: [{ path: 'scripts/deploy.sh' }],
      authority: AUTHORITIES.DERIVED,
    })).record
    const candidate = store.put(mkCandidate(source, {
      title: 'Deploy switched from rsync to zstd for artifact sync',
      body: 'The deploy pipeline now compresses build artifacts with zstd instead of rsync, and releases must always ship compressed artifacts only.',
      evidence: [{ path: 'scripts/deploy.sh' }],
    })).record

    const learned = maybeLearn(store, { ...candidate })
    assert.ok(learned, 'allowed replacement learns')
    assert.equal(store.get(oldRec.id).status, STATUSES.SUPERSEDED, 'old record superseded as before')
    assert.deepEqual(store.get(oldRec.id).source.provenance, { origins: ['assistant'] }, 'retired record keeps its provenance')
    assert.deepEqual(store.get(learned.id).source.provenance, { origins: ['assistant'] }, 'replacement keeps its provenance')
  } finally {
    store.close()
  }
})

test('M9: staleness sweep unaffected while blocked records sit untouched', () => {
  const store = openEphemeralStore()
  try {
    const stale = store.put(mkCandidate({ automatic: true, provenance: { origins: ['assistant'] } }, {
      title: 'Old claim that will go stale',
      body: 'Always serialize DatabaseSync writes to avoid FTS corruption, because concurrent writers race on the shared handle under WAL.',
      authority: AUTHORITIES.DERIVED,
      validation: VALIDATIONS.UNVERIFIED,
      createdAt: daysAgo(300),
      updatedAt: daysAgo(300),
    })).record
    const blocked = capture(store, { automatic: true, provenance: { origins: ['user'] } }, { title: 'Blocked stale-era claim' })
    sweepStale(store, {})
    assert.equal(store.get(stale.id).validation, VALIDATIONS.STALE, 'staleness sweep still fires')
    const after = store.get(blocked.id)
    assert.equal(after.authority, AUTHORITIES.CANDIDATE, 'sweep does not promote or drop the blocked record')
    assert.deepEqual(after.source, blocked.source, 'blocked record untouched by sweep')
  } finally {
    store.close()
  }
})

// -------------------------------------------------- candidate preservation

test('M9: blocked candidates are captured, unchanged and never invalidated', () => {
  const store = openEphemeralStore()
  try {
    const candidate = capture(store, { automatic: true, provenance: { origins: ['user'] } }, {
      title: 'Blocked capture must survive',
      body: 'The user asked to always rebuild the image before shipping, and the capture must survive learning being refused.',
    })
    const snapshot = JSON.stringify(store.get(candidate.id))

    assert.equal(maybeLearn(store, { ...candidate }), null)
    const review = reviewCandidate(store, candidate)
    assert.equal(review.outcome, 'unchanged')

    const after = store.get(candidate.id)
    assert.equal(JSON.stringify(after), snapshot, 'record byte-identical after blocked learning')
    assert.equal(after.authority, AUTHORITIES.CANDIDATE)
    assert.equal(after.validation, candidate.validation, 'no validation change')
    assert.deepEqual(after.relations || [], candidate.relations || [], 'no relationships added')
    assert.deepEqual(after.source.provenance, { origins: ['user'] }, 'provenance not rewritten')
    assert.equal(after.forgotten || false, false, 'not forgotten')
    assert.equal(after.status, candidate.status, 'no new lifecycle state')
    assert.equal(store.list({ limit: 200 }).length, 1, 'no derived twin was written')
  } finally {
    store.close()
  }
})

// ------------------------------------------------------- project isolation

test('M9: gate is per-record, not cross-project', () => {
  const storeA = openEphemeralStore(':memory:', { scope: 'project', projectId: 'p_m9_a' })
  const storeB = openEphemeralStore(':memory:', { scope: 'project', projectId: 'p_m9_b' })
  try {
    // Blocked record in project A must not affect project B…
    const blockedA = capture(storeA, { automatic: true, provenance: { origins: ['user'] } })
    assert.equal(maybeLearn(storeA, { ...blockedA }), null)

    const allowedB = capture(storeB, { automatic: true, provenance: { origins: ['assistant'] } })
    const learnedB = maybeLearn(storeB, { ...allowedB })
    assert.ok(learnedB, 'project B learns independently of project A block')
    assert.equal(learnedB.authority, AUTHORITIES.DERIVED)

    // …and a blocked record must not poison allowed records in its own project.
    const allowedA = capture(storeA, { automatic: true, provenance: { origins: ['assistant', 'tool'] } }, {
      title: 'Allowed claim alongside a blocked one',
      body: 'The gate must be per-record: an allowed claim in the same project must still learn while a blocked claim stays a candidate.',
    })
    const learnedA = maybeLearn(storeA, { ...allowedA })
    assert.ok(learnedA, 'allowed record in project A still learns')
    assert.equal(storeA.get(blockedA.id).authority, AUTHORITIES.CANDIDATE, 'blocked record stays blocked')
    assert.equal(storeB.get(allowedB.id).authority, AUTHORITIES.DERIVED, 'project B record untouched by A')
  } finally {
    storeA.close()
    storeB.close()
  }
})
