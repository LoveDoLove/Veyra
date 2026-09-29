import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  detectConsolidationCandidates, PROPOSAL_LIMIT, PROPOSAL_TYPES,
} from '../src/consolidate.mjs'
import { observatoryConsolidation } from '../src/observatory.mjs'
import { isRecallEligible, STATUSES, VALIDATIONS, AUTHORITIES, KINDS, RELATIONS } from '../src/types.mjs'
import { openEphemeralStore, openProjectStore, closeAllStores } from '../src/store.mjs'
import { sharesSubject } from '../src/diff.mjs'
import { supersedeEligible, markStale } from '../src/evolve.mjs'
import { handleVeyraCommand } from '../src/commands.mjs'
import { projectIdFor } from '../src/ids.mjs'
import { apply, MAINTENANCE_EVERY_N_TURNS, _resetMaintenanceCounter, _maintenanceTurns } from '../src/plugin.mjs'

// ============================================================================
// M12 C3 — Consolidation Detection (detect -> propose, never mutate)
//
// Invariants under test:
//   - detection is pure: it proposes, it never merges/deletes/rewrites a record
//   - MANDATORY snapshot: authority, validation, status, forgotten, body,
//     provenance (source/evidence) are byte-identical before/after detection
//   - distinct-but-similar records are preserved (no false duplicate)
//   - proposals are non-authoritative review suggestions, never auto-applied
//   - recall eligibility (types.mjs isRecallEligible) is untouched
// ============================================================================

const base = (over = {}) => ({
  id: 'rec', kind: KINDS.MEMORY, status: STATUSES.CURRENT,
  validation: VALIDATIONS.REVIEWED, authority: AUTHORITIES.DERIVED,
  title: 'T', body: 'B', relations: [], evidence: [], source: {}, ...over,
})

const snapshot = (records) => records.map((r) => ({
  id: r.id, authority: r.authority, validation: r.validation, status: r.status,
  forgotten: r.forgotten, body: r.body, title: r.title,
  source: JSON.stringify(r.source), evidence: JSON.stringify(r.evidence),
  relations: JSON.stringify(r.relations),
}))

const byType = (det, type) => det.candidates.filter((c) => c.type === type)

// -- Fixtures ---------------------------------------------------------------

const duplicatePair = () => [
  base({ id: 'dupA', title: 'Serialize DatabaseSync writes with a mutex', body: 'Serialize DatabaseSync writes with a mutex to prevent concurrent put on the same row', evidence: [{ path: 'src/store.mjs' }], source: { files: ['src/store.mjs'] } }),
  base({ id: 'dupB', title: 'Serialize DatabaseSync writes with a mutex', body: 'Serialize DatabaseSync writes with a mutex to prevent concurrent put on the same row', evidence: [{ path: 'src/store.mjs' }], source: { files: ['src/store.mjs'] } }),
]

const contradictionPair = () => [
  base({ id: 'conA', title: 'WAL checkpoint is safe under load', body: 'Checkpointing the WAL never blocks writers.', relations: [{ type: RELATIONS.CONTRADICTS, targetId: 'conB' }] }),
  base({ id: 'conB', title: 'Frequent WAL checkpointing stalls writers', body: 'Checkpointing the WAL blocks writers during merge.', relations: [{ type: RELATIONS.CONTRADICTS, targetId: 'conA' }] }),
]

const contradictionCluster = () => [
  base({ id: 'kA', title: 'Replication is synchronous by default', relations: [{ type: RELATIONS.CONTRADICTS, targetId: 'kB' }, { type: RELATIONS.CONTRADICTS, targetId: 'kC' }] }),
  base({ id: 'kB', title: 'Replication is asynchronous by default', relations: [{ type: RELATIONS.CONTRADICTS, targetId: 'kA' }, { type: RELATIONS.CONTRADICTS, targetId: 'kC' }] }),
  base({ id: 'kC', title: 'Replication mode varies by cluster', relations: [{ type: RELATIONS.CONTRADICTS, targetId: 'kA' }, { type: RELATIONS.CONTRADICTS, targetId: 'kB' }] }),
]

const distinctSimilar = () => [
  base({ id: 'disX', title: 'Set busy_timeout to handle SQLITE_BUSY retries', body: 'Configure busy_timeout so writers retry when the lock is held.' }),
  base({ id: 'disY', title: 'Checkpoint the WAL to keep readers fast', body: 'Periodic WAL checkpointing keeps reader latency low.' }),
]

const staleRecord = () => base({ id: 'stale1', validation: VALIDATIONS.STALE, title: 'Legacy flag handling', body: 'Old behaviour that lifecycle freshness has flagged.' })

// -- Duplicate detection (pure detector, exact-identical claims) ------------

test('C3: exact duplicate pair -> one duplicate proposal (review-merge)', () => {
  const det = detectConsolidationCandidates(duplicatePair())
  const dups = byType(det, PROPOSAL_TYPES.DUPLICATE)
  assert.equal(dups.length, 1, 'one duplicate proposal')
  assert.equal(det.counts.duplicate, 1)
  assert.equal(dups[0].proposedAction, 'review-merge')
  assert.deepEqual(dups[0].records.map((r) => r.id).sort(), ['dupA', 'dupB'])
  assert.equal(det.truncated, false)
})

// -- Contradiction pair + cluster ------------------------------------------

test('C3: contradiction pair -> one contradiction proposal (review-contradiction)', () => {
  const det = detectConsolidationCandidates(contradictionPair())
  const cons = byType(det, PROPOSAL_TYPES.CONTRADICTION)
  assert.equal(cons.length, 1, 'one contradiction proposal')
  assert.equal(cons[0].proposedAction, 'review-contradiction')
  assert.deepEqual(cons[0].cluster.slice().sort(), ['conA', 'conB'])
  assert.ok(cons[0].evidence.some((e) => e.relation === 'contradicts'), 'evidence cites contradicts relation')
})

test('C3: contradiction triangle collapses into ONE cluster of three', () => {
  const det = detectConsolidationCandidates(contradictionCluster())
  const cons = byType(det, PROPOSAL_TYPES.CONTRADICTION)
  assert.equal(cons.length, 1, 'single merged cluster')
  assert.equal(cons[0].cluster.length, 3)
  assert.equal(det.counts.contradiction, 1)
})

// -- Distinct-but-similar is preserved (no false duplicate) -----------------

test('C3: distinct-but-similar records produce no duplicate proposal', () => {
  const det = detectConsolidationCandidates(distinctSimilar())
  assert.equal(byType(det, PROPOSAL_TYPES.DUPLICATE).length, 0, 'no false duplicate')
  assert.equal(det.counts.total, 0, 'nothing to propose for distinct records')
})

// -- Retirement via existing lifecycle freshness ----------------------------

test('C3: current+stale record -> retirement proposal (uses existing flags only)', () => {
  const det = detectConsolidationCandidates([staleRecord(), ...distinctSimilar()])
  const ret = byType(det, PROPOSAL_TYPES.RETIREMENT)
  assert.equal(ret.length, 1)
  assert.equal(ret[0].proposedAction, 'review-retirement')
  assert.equal(ret[0].records[0].id, 'stale1')
})

// -- Replacement candidate (A may be superseded by B) -----------------------

test('C3: directional replacement -> review-supersession, records ordered [older, newer]', () => {
  const older = base({ id: 'oldWay', title: 'Use busy_timeout pragma for SQLITE_BUSY', body: 'Set busy_timeout so writers retry on lock contention.', evidence: [{ path: 'src/store.mjs' }], source: { files: ['src/store.mjs'] } })
  const newer = base({ id: 'newWay', title: 'Serialize DatabaseSync writes with a mutex', body: 'We replaced the busy_timeout approach with a write mutex instead of retries.', evidence: [{ path: 'src/store.mjs' }], source: { files: ['src/store.mjs'] } })
  const det = detectConsolidationCandidates([older, newer])
  const rep = byType(det, PROPOSAL_TYPES.REPLACEMENT)
  assert.equal(rep.length, 1, 'one replacement candidate')
  assert.equal(rep[0].proposedAction, 'review-supersession')
  assert.deepEqual(rep[0].records.map((r) => r.id), ['oldWay', 'newWay'], 'ordered [older, newer]')
})

// -- Outdated via verifyEvidenceHealth (workspace-scoped) -------------------

test('C3: record whose evidence files are all gone -> outdated proposal', () => {
  const ws = mkdtempSync(join(tmpdir(), 'm12-ws-'))
  const gone = base({ id: 'gone1', title: 'Old deleted-module notes', body: 'Refers to a file that no longer exists.', evidence: [{ path: 'src/definitely_gone_xyz.mjs' }], source: { files: ['src/definitely_gone_xyz.mjs'] } })
  const det = detectConsolidationCandidates([gone], { workspace: ws })
  const out = byType(det, PROPOSAL_TYPES.OUTDATED)
  assert.equal(out.length, 1, 'outdated proposal fired')
  assert.equal(out[0].proposedAction, 'review-freshness')
  assert.equal(out[0].evidence[0].state, 'missing')
})

test('C3: no outdated proposal when workspace is not provided', () => {
  const gone = base({ id: 'gone2', title: 'Old notes', body: 'Refers to missing file.', evidence: [{ path: 'src/nope.mjs' }] })
  const det = detectConsolidationCandidates([gone])
  assert.equal(byType(det, PROPOSAL_TYPES.OUTDATED).length, 0)
})

// -- Evidence-health path resolution (absolute evidence paths) ---------------
//
// Production evidence is frequently recorded as an absolute path (168 of 185
// distinct paths in p_2d59). `join(workspace, absolutePath)` fabricates
// '<workspace>/<absolutePath>', which never exists, so a file that IS present
// was reported missing. That produced 33/45 bogus `outdated` proposals and
// wrongly demoted 33 records to `stale` (all 0.2-3.9 days old, far inside the
// 120-day idle window). The rule — "all referenced files gone -> broken" — is
// unchanged; only the lookup path is corrected.

test('C3: absolute evidence path to an EXISTING file produces no outdated proposal', () => {
  const ws = mkdtempSync(join(tmpdir(), 'm12-ws-abs-'))
  writeFileSync(join(ws, 'live.mjs'), 'export const live = true\n')
  const abs = join(ws, 'live.mjs')
  const rec = base({ id: 'absLive', title: 'Absolute path note', body: 'Evidence cited with an absolute path.', evidence: [{ path: abs }], source: { files: [abs] } })
  const det = detectConsolidationCandidates([rec], { workspace: ws })
  assert.equal(byType(det, PROPOSAL_TYPES.OUTDATED).length, 0, 'an existing file must count as present, however the path is written')
  rmSync(ws, { recursive: true, force: true })
})

test('C3: absolute evidence path to a genuinely deleted file still produces an outdated proposal', () => {
  const ws = mkdtempSync(join(tmpdir(), 'm12-ws-absgone-'))
  const goneAbs = join(ws, 'deleted_abs_xyz.mjs')
  const rec = base({ id: 'absGone', title: 'Deleted absolute note', body: 'Evidence pointed at an absolute path that is gone.', evidence: [{ path: goneAbs }], source: { files: [goneAbs] } })
  const det = detectConsolidationCandidates([rec], { workspace: ws })
  const out = byType(det, PROPOSAL_TYPES.OUTDATED)
  assert.equal(out.length, 1, 'a truly deleted file still counts as gone')
  assert.equal(out[0].evidence[0].path, goneAbs, 'the path is reported exactly as recorded')
  rmSync(ws, { recursive: true, force: true })
})

test('M5 regression: markStale demotes on genuinely gone absolute evidence only', () => {
  const ws = mkdtempSync(join(tmpdir(), 'm12-ws-stale-abs-'))
  writeFileSync(join(ws, 'keep.mjs'), 'export const keep = true\n')
  const store = openEphemeralStore()
  const alive = store.put({ title: 'absolute evidence alive', body: 'The referenced absolute-path file still exists.', authority: AUTHORITIES.DERIVED, validation: VALIDATIONS.UNVERIFIED, evidence: [{ path: join(ws, 'keep.mjs') }] }).record
  const dead = store.put({ title: 'absolute evidence gone', body: 'The referenced absolute-path file was deleted.', authority: AUTHORITIES.DERIVED, validation: VALIDATIONS.UNVERIFIED, evidence: [{ path: join(ws, 'never_made.mjs') }] }).record
  markStale(store, { workspace: ws })
  assert.equal(store.get(alive.id).validation, VALIDATIONS.UNVERIFIED, 'live absolute evidence must not be demoted out of recall')
  assert.equal(store.get(dead.id).validation, VALIDATIONS.STALE, 'genuinely gone absolute evidence is still demoted')
  store.close()
  rmSync(ws, { recursive: true, force: true })
})

// -- MANDATORY snapshot safety: detection never mutates records ------------

test('C3 MANDATORY: detection does not change authority/validation/status/forgotten/body/provenance', () => {
  const records = [
    ...duplicatePair(), ...contradictionCluster(), ...distinctSimilar(),
    staleRecord(),
    base({ id: 'repOld', title: 'Use busy_timeout pragma for SQLITE_BUSY', body: 'Set busy_timeout so writers retry.', evidence: [{ path: 'src/store.mjs' }], source: { files: ['src/store.mjs'] } }),
    base({ id: 'repNew', title: 'Serialize DatabaseSync writes with a mutex', body: 'We replaced busy_timeout with a mutex instead of retries.', evidence: [{ path: 'src/store.mjs' }], source: { files: ['src/store.mjs'] } }),
  ]
  const before = snapshot(records)
  const det = detectConsolidationCandidates(records)
  assert.ok(det.counts.total > 0, 'detection found something to propose')
  assert.deepEqual(snapshot(records), before, 'records byte-identical after detection')
})

// -- Proposals are non-authoritative and review-only ------------------------

test('C3: every proposal action is review-only (never auto-applied)', () => {
  const records = [
    ...duplicatePair(), ...contradictionPair(), staleRecord(),
    base({ id: 'repOld', title: 'Use busy_timeout pragma for SQLITE_BUSY', body: 'Set busy_timeout so writers retry.', evidence: [{ path: 'src/store.mjs' }], source: { files: ['src/store.mjs'] } }),
    base({ id: 'repNew', title: 'Serialize DatabaseSync writes with a mutex', body: 'We replaced busy_timeout with a mutex instead of retries.', evidence: [{ path: 'src/store.mjs' }], source: { files: ['src/store.mjs'] } }),
  ]
  const det = detectConsolidationCandidates(records)
  assert.ok(det.candidates.length > 0)
  for (const c of det.candidates) {
    assert.ok(c.proposedAction.startsWith('review-'), `review-only action: ${c.proposedAction}`)
    assert.ok(c.why && typeof c.why === 'string', 'every proposal explains why')
    assert.ok(Array.isArray(c.records) && c.records.length > 0, 'affected records listed')
  }
  // proposals never add authority/status to records (snapshot covers this too)
})

// -- M12 scope: proposals never pollute recall (eligibility untouched) ------

test('C3 MANDATORY: recall eligibility semantics are unchanged by detection', () => {
  // baseline eligibility contract (types.mjs isRecallEligible)
  assert.equal(isRecallEligible(base({})), true, 'current+reviewed+derived is eligible')
  assert.equal(isRecallEligible(base({ authority: AUTHORITIES.CANDIDATE })), false, 'candidate never eligible')
  assert.equal(isRecallEligible(base({ validation: VALIDATIONS.INVALID })), false, 'invalid never eligible')
  assert.equal(isRecallEligible(base({ validation: VALIDATIONS.STALE })), false, 'stale never eligible')
  assert.equal(isRecallEligible(base({ forgotten: true })), false, 'forgotten never eligible')
  assert.equal(isRecallEligible(base({ kind: KINDS.OBSERVATION })), false, 'observation never eligible')

  // running detection over these very records flips nothing
  const records = [base({}), base({ id: 'c', authority: AUTHORITIES.CANDIDATE }), base({ id: 's', validation: VALIDATIONS.STALE }), staleRecord()]
  const eligBefore = records.map((r) => isRecallEligible(r))
  detectConsolidationCandidates(records)
  assert.deepEqual(records.map((r) => isRecallEligible(r)), eligBefore, 'eligibility unchanged by detection')
})

// -- Bounds: per-type cap and input limit -----------------------------------

test('C3: surfaced candidates are capped per type while counts stay exact', () => {
  const many = []
  for (let i = 0; i < PROPOSAL_LIMIT + 5; i++) {
    many.push(base({ id: `s${i}`, validation: VALIDATIONS.STALE, title: `Stale record ${i}`, body: `stale body ${i}` }))
  }
  const det = detectConsolidationCandidates(many)
  assert.equal(det.counts.retirement, PROPOSAL_LIMIT + 5, 'counts exact')
  assert.equal(byType(det, PROPOSAL_TYPES.RETIREMENT).length, PROPOSAL_LIMIT, 'surfaced capped')
  assert.equal(det.truncated, true)
})

test('C3: input list is bounded (limit honored, no unbounded scan)', () => {
  const many = Array.from({ length: 30 }, (_, i) => base({ id: `b${i}`, title: `Record ${i}` }))
  const det = detectConsolidationCandidates(many, { limit: 10 })
  // detection never sees more than `limit` records; output is bounded
  assert.ok(det.candidates.length <= 10 * PROPOSAL_LIMIT)
})

// -- Store-level near-duplicate detection (end-to-end) ----------------------

test('C3: near-duplicate records through a real store -> duplicate proposal', () => {
  const store = openEphemeralStore()
  const put = (over) => store.put({ kind: KINDS.MEMORY, status: STATUSES.CURRENT, validation: VALIDATIONS.REVIEWED, authority: AUTHORITIES.DERIVED, relations: [], evidence: [], source: {}, ...over })
  put({ id: 'n1', title: 'Serialize DatabaseSync writes with a mutex', body: 'Serialize DatabaseSync writes with a mutex to prevent concurrent put on the same row', evidence: [{ path: 'src/store.mjs' }] })
  put({ id: 'n2', title: 'Serialize DatabaseSync writes with a mutex', body: 'Serialize DatabaseSync writes with a mutex to prevent concurrent put on the same row.', evidence: [{ path: 'src/store.mjs' }] })
  const recs = store.list({ limit: 200 })
  const det = detectConsolidationCandidates(recs)
  assert.equal(byType(det, PROPOSAL_TYPES.DUPLICATE).length, 1, 'near-dup detected end-to-end')
})

// -- Observatory consolidation view is read-only ----------------------------

test('C3: observatory consolidation view renders proposals and mutates nothing', () => {
  const store = openEphemeralStore()
  const put = (over) => store.put({ kind: KINDS.MEMORY, status: STATUSES.CURRENT, validation: VALIDATIONS.UNVERIFIED, authority: AUTHORITIES.DERIVED, relations: [], evidence: [], source: {}, ...over })
  put({ id: 'o1', title: 'WAL checkpoint is safe under load', body: 'Checkpointing the WAL never blocks writers at all.', relations: [{ type: RELATIONS.CONTRADICTS, targetId: 'o2' }] })
  put({ id: 'o2', title: 'Frequent WAL checkpointing stalls writers badly', body: 'Checkpointing the WAL blocks writers during merge phase.', relations: [{ type: RELATIONS.CONTRADICTS, targetId: 'o1' }] })
  put({ id: 'o3', title: 'Legacy flag handling', body: 'Old behaviour lifecycle freshness has flagged for review.', validation: VALIDATIONS.STALE })

  const before = snapshot(store.list({ limit: 200 }))
  const res = observatoryConsolidation({ projectStore: store, reusableStore: null, cwd: '' })
  assert.equal(res.ok, true)
  assert.ok(res.formatted.includes('CONSOLIDATION'), 'read-only header present')
  assert.ok(res.formatted.includes('read-only'), 'read-only framing present')
  assert.ok(res.formatted.includes('[CONTRADICTION]') || res.formatted.includes('[RETIREMENT]'), 'proposals rendered')
  assert.ok(res.formatted.includes('review only'), 'action framed as review-only')
  assert.deepEqual(snapshot(store.list({ limit: 200 })), before, 'store records unchanged by observatory view')
})


// ============================================================================
// M12 C3 — Candidate-scoping regression suite (Phase 2 production precision)
//
// The replacement pass used to test every bounded record against every other
// bounded record, gated only by a shared repository path. Production never
// does that: it selects ONE neighbour per incoming record and applies
// `supersedeEligible()` to that neighbour alone. These tests pin the three
// stages that replaced the cross-product:
//
//   1. relevance    — shared provenance alone cannot nominate a neighbour
//   2. evolution    — one neighbour per record, via the production
//                     `evolveAgainst(null, record, peers)` selection path
//   3. supersession — `supersedeEligible()`, byte-identical, decides
//
// Nothing here tunes toward a proposal count: every assertion is about which
// pairs may be proposed, never about how many.
// ============================================================================

// -- Shared fixtures --------------------------------------------------------

// A genuinely related replacement: same subject, same files, replacement
// language on the newer claim, older claim lacks it.
const relatedReplacement = () => [
  base({ id: 'relOld', title: 'Use busy_timeout pragma for SQLITE_BUSY', body: 'Set busy_timeout so writers retry on lock contention.', evidence: [{ path: 'src/store.mjs' }], source: { files: ['src/store.mjs'] } }),
  base({ id: 'relNew', title: 'Serialize DatabaseSync writes with a mutex', body: 'We replaced the busy_timeout approach with a write mutex instead of retries.', evidence: [{ path: 'src/store.mjs' }], source: { files: ['src/store.mjs'] } }),
]

// Unrelated audit records that share the repository path but claim nothing
// about one another. Every one of them touches `src/store.mjs`, which is
// exactly what made them nominate each other before scoping.
const pathSharingAudits = () => [
  base({ id: 'aud1', title: 'Diagnosed flaky assertion in observatory rendering', body: 'The observatory panel rendered stale rows because the snapshot was taken before flush.', evidence: [{ path: 'src/store.mjs' }], source: { files: ['src/store.mjs'] } }),
  base({ id: 'aud2', title: 'Checked retrieval weight table against frozen defaults', body: 'Recall ordering matched the frozen weights and no ranking rule changed this turn.', evidence: [{ path: 'src/store.mjs' }], source: { files: ['src/store.mjs'] } }),
  base({ id: 'aud3', title: 'Confirmed maintenance cadence still fires every fifth turn', body: 'Due-for-maintenance logic returned true on the expected turn and no extra pass ran.', evidence: [{ path: 'src/store.mjs' }], source: { files: ['src/store.mjs'] } }),
  base({ id: 'aud4', title: 'Verified secret scrubbing on a crafted credential', body: 'The redactor removed the token before any record body was persisted to disk.', evidence: [{ path: 'src/store.mjs' }], source: { files: ['src/store.mjs'] } }),
  base({ id: 'aud5', title: 'Reviewed near-duplicate suppression in recall', body: 'Two sibling candidates were emitted and the suppression step dropped the redundant one.', evidence: [{ path: 'src/store.mjs' }], source: { files: ['src/store.mjs'] } }),
]

// Production p_2d59 false-positive shape: one replacement-language claim
// surrounded by unrelated audit records that all share the same repository
// path. The pre-scoping pass emitted one proposal per path-sharing pair.
const p2d59FalsePositive = () => [
  ...pathSharingAudits(),
  base({ id: 'p2dRep', title: 'Retire the busy_timeout retry strategy',
    body: 'We replaced the busy_timeout approach with a write mutex instead of retries. SQLITE_BUSY is no longer retried.',
    evidence: [{ path: 'src/store.mjs' }], source: { files: ['src/store.mjs'] } }),
]

// -- (1) genuinely related replacement candidates still propose -------------

test('C3 scoping: genuinely related replacement candidates still produce a proposal', () => {
  const records = [...relatedReplacement(), ...pathSharingAudits()]
  const det = detectConsolidationCandidates(records)
  const rep = byType(det, PROPOSAL_TYPES.REPLACEMENT)
  assert.equal(rep.length, 1, 'exactly one related replacement proposal survives scoping')
  assert.equal(rep[0].proposedAction, 'review-supersession')
  assert.deepEqual(rep[0].records.map((r) => r.id), ['relOld', 'relNew'], 'ordered [older, newer]')
  assert.equal(rep[0].evidence[0].note, 'replacement language on incoming record', 'evidence shape preserved')
})

// -- (2) shared file/path alone never nominates a proposal -------------------

test('C3 scoping: shared file/path alone does not create replacement proposals', () => {
  const incoming = p2d59FalsePositive().find((r) => r.id === 'p2dRep')
  const peer = pathSharingAudits()[0]
  // The fixture must genuinely exercise the false-positive pattern: the path
  // says the same subject, and the gate alone would say yes.
  assert.equal(sharesSubject(incoming, peer), true, 'fixture shares a repository path')
  assert.equal(supersedeEligible(incoming, peer), true, 'gate alone would allow this pair')
  // ...but relevance scoping refuses it: the two claims share no token at all.
  const det = detectConsolidationCandidates([incoming, peer])
  assert.equal(det.counts.replacement, 0, 'provenance overlap without claim overlap is not a candidate')
  assert.equal(byType(det, PROPOSAL_TYPES.REPLACEMENT).length, 0)
})

// -- (3) unrelated audit records never become replacement proposals -----------

test('C3 scoping: p_2d59 fixture — unrelated audit records do not propose on shared paths', () => {
  const records = p2d59FalsePositive()
  const rep = byType(detectConsolidationCandidates(records), PROPOSAL_TYPES.REPLACEMENT)
  assert.equal(rep.length, 0, 'no replacement proposal from shared repository paths alone')
  assert.equal(detectConsolidationCandidates(records).counts.replacement, 0, 'count stays at zero, not merely capped')
})

// -- (4) contradiction proposals remain detectable ---------------------------

test('C3 scoping: contradiction proposals remain detectable alongside a replacement claim', () => {
  const det = detectConsolidationCandidates([...contradictionPair(), ...relatedReplacement(), ...pathSharingAudits()])
  const con = byType(det, PROPOSAL_TYPES.CONTRADICTION)
  assert.equal(con.length, 1, 'contradiction pass unaffected by replacement scoping')
  assert.equal(con[0].proposedAction, 'review-contradiction')
  assert.equal(byType(det, PROPOSAL_TYPES.REPLACEMENT).length, 1, 'replacement pass unaffected by contradiction pass')
})

// -- (5) duplicate proposals remain detectable -------------------------------

test('C3 scoping: duplicate proposals remain detectable alongside a replacement claim', () => {
  const det = detectConsolidationCandidates([...duplicatePair(), ...relatedReplacement(), ...pathSharingAudits()])
  assert.equal(byType(det, PROPOSAL_TYPES.DUPLICATE).length, 1, 'duplicate pass unaffected by replacement scoping')
  assert.equal(byType(det, PROPOSAL_TYPES.REPLACEMENT).length, 1, 'duplicate neighbour never reaches the supersession gate')
})

// -- (6) outdated detection remains bounded ----------------------------------

test('C3 scoping: outdated detection remains bounded while replacement is scoped', () => {
  const ws = mkdtempSync(join(tmpdir(), 'm12-ws-bound-'))
  // the shared fixture path must exist here, otherwise it would itself be
  // reported missing and the exact-count assertion below would be meaningless
  mkdirSync(join(ws, 'src'), { recursive: true })
  writeFileSync(join(ws, 'src', 'store.mjs'), '// present\n')
  const many = Array.from({ length: PROPOSAL_LIMIT + 5 }, (_, i) =>
    base({ id: `gone${i}`, title: `Old deleted notes ${i}`, body: `Refers to a removed module ${i}.`, evidence: [{ path: `src/gone_${i}.mjs` }], source: { files: [`src/gone_${i}.mjs`] } }))
  const records = [...many, ...relatedReplacement(), ...pathSharingAudits()]
  const det = detectConsolidationCandidates(records, { workspace: ws })
  assert.equal(det.counts.outdated, PROPOSAL_LIMIT + 5, 'outdated counts stay exact')
  assert.equal(byType(det, PROPOSAL_TYPES.OUTDATED).length, PROPOSAL_LIMIT, 'outdated surfaced stays capped')
  assert.equal(byType(det, PROPOSAL_TYPES.REPLACEMENT).length, 1, 'replacement scoping does not disturb outdated')
  const noWs = detectConsolidationCandidates(records)
  assert.equal(byType(noWs, PROPOSAL_TYPES.OUTDATED).length, 0, 'still requires an explicit workspace')
})

// -- (7) retirement detection remains bounded --------------------------------

test('C3 scoping: retirement detection remains bounded while replacement is scoped', () => {
  const many = Array.from({ length: PROPOSAL_LIMIT + 5 }, (_, i) =>
    base({ id: `ret${i}`, validation: VALIDATIONS.STALE, title: `Legacy handling ${i}`, body: `Lifecycle freshness flagged record ${i}.` }))
  const records = [...many, ...relatedReplacement(), ...pathSharingAudits()]
  const det = detectConsolidationCandidates(records)
  assert.equal(det.counts.retirement, PROPOSAL_LIMIT + 5, 'retirement counts stay exact')
  assert.equal(byType(det, PROPOSAL_TYPES.RETIREMENT).length, PROPOSAL_LIMIT, 'retirement surfaced stays capped')
  assert.equal(byType(det, PROPOSAL_TYPES.REPLACEMENT).length, 1, 'replacement scoping does not disturb retirement')
})

// -- (8) detection is completely read-only -----------------------------------

test('C3 scoping MANDATORY: replacement detection is read-only end to end', () => {
  const records = [
    ...relatedReplacement(), ...pathSharingAudits(), ...duplicatePair(), ...contradictionPair(), staleRecord(),
  ]
  const before = JSON.stringify(snapshot(records))
  const det = detectConsolidationCandidates(records, { workspace: mkdtempSync(join(tmpdir(), 'm12-ws-ro-')) })
  // prove the replacement branch actually ran (it is the only branch that
  // reuses evolveAgainst, whose non-null store path writes)
  assert.ok(det.counts.replacement > 0, 'replacement branch executed')
  assert.equal(JSON.stringify(snapshot(records)), before, 'byte-identical before/after detection')
  for (const c of det.candidates) assert.ok(c.proposedAction.startsWith('review-'), 'review-only')
})

// -- (9) supersedeEligible() lifecycle/authority behaviour unchanged ----------

test('C3 scoping: supersedeEligible() lifecycle and authority behaviour is unchanged', () => {
  const incoming = base({ id: 'inc', title: 'Serialize DatabaseSync writes with a mutex', body: 'We replaced busy_timeout with a mutex instead of retries.', evidence: [{ path: 'src/store.mjs' }], source: { files: ['src/store.mjs'] } })
  const neighbor = base({ id: 'nei', title: 'Use busy_timeout pragma for SQLITE_BUSY', body: 'Set busy_timeout so writers retry on lock contention.', evidence: [{ path: 'src/store.mjs' }], source: { files: ['src/store.mjs'] } })

  assert.equal(supersedeEligible(incoming, neighbor), true, 'valid directional replacement still allowed')
  assert.equal(supersedeEligible(null, neighbor), false, 'missing incoming')
  assert.equal(supersedeEligible(incoming, null), false, 'missing neighbour')
  assert.equal(supersedeEligible(incoming, { ...neighbor, id: incoming.id }), false, 'same id rejected')

  assert.equal(supersedeEligible(incoming, { ...neighbor, authority: AUTHORITIES.CANONICAL }), false, 'canonical neighbour is never replaced')
  for (const st of [STATUSES.SUPERSEDED, STATUSES.HISTORICAL, STATUSES.DEPRECATED]) {
    assert.equal(supersedeEligible(incoming, { ...neighbor, status: st }), false, `non-current neighbour (${st}) is never replaced`)
  }
  assert.equal(supersedeEligible({ ...incoming, authority: AUTHORITIES.CANDIDATE }, neighbor), false, 'candidate incoming never supersedes')

  assert.equal(supersedeEligible(incoming, { ...neighbor, title: incoming.title, body: incoming.body }), false, 'neighbour that itself claims replacement is never the victim')
  assert.equal(supersedeEligible(incoming, base({ id: 'nei2', title: 'Unrelated queue audit', body: 'Nothing about locking in this record at all.', evidence: [], source: {} })), false, 'no shared subject')
})

// -- (10) surface: the C3 fix reaches the user-facing command ---------------
// Detection had been proven in isolation, but the surface an operator actually
// runs (`veyra observatory consolidation`) had only ever rendered a
// contradiction/retirement fixture. The replacement pass must survive the
// surface path and still never write.

test('C3 scoping SURFACE: observatory renders [REPLACEMENT] through the real command, store untouched', () => {
  const store = openEphemeralStore()
  // NOTE: a byte-identical pair cannot be stored at all — `store.put` refuses
  // an insert whose contentHash already exists (baseline behaviour). Real
  // duplicate proposals therefore come from near-identical claims, so this
  // pair differs by trailing punctuation only: same contentHash? no; same
  // token set? yes -> DIFF.DUPLICATE.
  const twin = (id, body) => base({ id, title: 'Dashboard badge refresh runs nightly', body })
  for (const r of [
    ...relatedReplacement(), ...pathSharingAudits(),
    twin('dupA', 'Refresh the dashboard badge links nightly so the status never goes stale'),
    twin('dupB', 'Refresh the dashboard badge links nightly so the status never goes stale.'),
  ]) store.put({ ...r })
  const before = snapshot(store.list({ limit: 200 }))

  const res = observatoryConsolidation({ projectStore: store, reusableStore: null, cwd: '' })
  assert.equal(res.ok, true)
  assert.ok(res.formatted.includes('[REPLACEMENT]'), 'replacement proposal rendered by the user-facing surface')
  assert.ok(res.formatted.includes('review-supersession'), 'surfaced as review-only supersession')
  assert.ok(res.formatted.includes('replacement language on incoming record'), 'grounding evidence rendered')
  assert.ok(res.formatted.includes('[DUPLICATE]'), 'duplicate pass still surfaced alongside it')
  // the twins carry no replacement language and share no subject with the
  // replacement pair, so they must not mask it (evolveAgainst takes ONE
  // strongest neighbour; an ineligible neighbour yields no proposal)
  assert.ok(res.formatted.includes('review only'), 'every action framed as review-only')
  assert.ok(res.formatted.includes('no changes made'), 'read-only header present')

  const proj = res.data.find((d) => d.scope === 'project')
  assert.equal(store.list({ limit: 200 }).length, 9, 'both duplicate twins actually landed in the store')
  assert.equal(proj.counts.replacement, 1, 'scoped count survives the surface path')
  assert.equal(proj.counts.duplicate, 1, 'duplicate count survives too')
  assert.deepEqual(snapshot(store.list({ limit: 200 })), before, 'store byte-identical after rendering')
})

// -- (11) isolation: project and reusable stores never pair -----------------
// observatoryConsolidation documents that each store is detected separately so
// project/reusable isolation is preserved. Splitting a would-be replacement
// pair across the two stores proves detection cannot reach across the boundary.

test('C3 scoping ISOLATION: a replacement pair split across project/reusable stores proposes nothing', () => {
  const [oldRec, newRec] = relatedReplacement()
  const project = openEphemeralStore()
  const reusable = openEphemeralStore()
  project.put({ ...newRec })    // the newer claim
  reusable.put({ ...oldRec })   // the record it would replace

  const res = observatoryConsolidation({ projectStore: project, reusableStore: reusable, cwd: '' })
  const p = res.data.find((d) => d.scope === 'project')
  const u = res.data.find((d) => d.scope === 'reusable')
  assert.equal(res.data.length, 2, 'both scopes reported independently')
  assert.equal(p.counts.replacement, 0, 'project store has no peer inside its own store')
  assert.equal(u.counts.replacement, 0, 'reusable store has no peer inside its own store')
  assert.equal(res.data.reduce((n, d) => n + d.counts.replacement, 0), 0, 'no cross-store pairing at all')
  assert.ok(!res.formatted.includes('[REPLACEMENT]'), 'nothing to review renders')

  // control: the identical pair inside ONE store still proposes — the zero
  // above is isolation, not a detector that has stopped working
  const both = openEphemeralStore()
  both.put({ ...oldRec })
  both.put({ ...newRec })
  const ctrl = observatoryConsolidation({ projectStore: both, reusableStore: null, cwd: '' })
  assert.ok(ctrl.formatted.includes('[REPLACEMENT]'), 'control: paired records in one store still propose')
})

// -- (12) dispatch: the outermost link of detect -> propose -> surface -------
// The detector and the surface were each covered separately; the command an
// operator actually types (`/veyra observatory consolidation`) was not, so a
// routing regression could have hidden a fully-green detector.

test('C3 DISPATCH: observatory consolidation + aliases reach the read-only surface', () => {
  const dir = mkdtempSync(join(tmpdir(), 'veyra-m12-dispatch-'))
  const cwd = join(dir, 'workspace')
  mkdirSync(cwd, { recursive: true })
  const projectStore = openProjectStore(dir, projectIdFor(cwd))
  for (const r of relatedReplacement()) projectStore.put({ ...r })

  const runtime = { veyraHome: dir, fallbackCwd: cwd, recallLimit: 5, includeReusable: true }
  const invocation = { agent: { session: { header: { cwd } } } }

  for (const sub of ['consolidation', 'consolidate', 'proposals']) {
    const res = handleVeyraCommand(runtime, { ...invocation, rawInput: `observatory ${sub}` })
    assert.equal(res.kind, 'success', `alias "${sub}" dispatches`)
    assert.ok(res.text.includes('CONSOLIDATION PROPOSALS'), `"${sub}" renders the consolidation surface`)
    assert.ok(res.text.includes('[REPLACEMENT]'), 'replacement proposal reaches the command surface')
    assert.ok(res.text.includes('review-supersession'), 'action framed as review-only')
    assert.ok(res.text.includes('no changes made'), 'read-only header carried through dispatch')
  }

  const help = handleVeyraCommand(runtime, { ...invocation, rawInput: 'help' })
  assert.equal(help.kind, 'success')
  assert.ok(help.text.includes('detect -> propose consolidation candidates (read-only)'), 'help advertises the surface')

  const bad = handleVeyraCommand(runtime, { ...invocation, rawInput: 'observatory nonsense' })
  assert.equal(bad.kind, 'error')
  assert.ok(bad.text.includes('consolidation'), 'unknown-sub help lists consolidation')

  assert.equal(projectStore.list({ limit: 200 }).length, 2, 'dispatch left both records in place (no merge/delete)')

  closeAllStores()
  rmSync(dir, { recursive: true, force: true })
})

// -- (13) cadence: the plugin maintenance path --------------------------------
// Phases 5/6 claim C3 runs on the existing turn lifecycle with no scheduler,
// worker or daemon, and that its only side effect is a log line. That path
// (`agent/turn-stopping` -> dueForMaintenance -> detect) was never executed;
// driving it proves the cadence, the read-only guarantee, and the absence of
// any new timing mechanism at runtime rather than by code reading.

test('C3 CADENCE: maintenance reports proposals read-only on the existing 5-turn cadence', () => {
  _resetMaintenanceCounter()
  const dir = mkdtempSync(join(tmpdir(), 'veyra-m12-cadence-'))
  // Workspace is the real repo root (storage still lives under the temp `dir`,
  // so no production DB is opened). With the workspace real, the pre-existing
  // M5 evidence-health check finds `src/store.mjs` present, so `markStale` has
  // nothing to demote and the snapshot below isolates what C3 itself does.
  const cwd = process.cwd()
  const projectId = projectIdFor(cwd)

  const logs = []
  const listeners = {}
  const ctx = {
    logger: { info: (m) => logs.push(String(m)), warn: (m) => logs.push(String(m)), debug: () => {} },
    tools: { register: () => {} },
    commands: { register: () => {} },
    skills: { register: () => {}, registerProvider: () => () => {} },
    systemPrompt: { section: () => {}, context: () => {} },
    on: (event, fn) => { (listeners[event] = listeners[event] || []).push(fn) },
    effect: (fn) => fn(),
  }
  const dispose = apply(ctx, { home: dir, observe: true })

  const projectStore = openProjectStore(dir, projectId)
  for (const r of relatedReplacement()) projectStore.put({ ...r })
  const seededBefore = snapshot([projectStore.get('relOld'), projectStore.get('relNew')])

  const session = { id: 'cadence-session', header: { cwd } }
  const agent = { session }
  const fire = (type, data) => (listeners['session/event'] || []).forEach((fn) => fn(session, { type, data }))
  const stop = () => (listeners['agent/turn-stopping'] || []).forEach((fn) => fn({ agent }))

  // >= 80 chars: clears distillBuffer's claim/tool gate so every turn yields a
  // candidate, which is the only way the turn handler reaches maintenance.
  const claim = 'Always flush the panel snapshot after rendering so the displayed record counts never lag behind the bounded list being reviewed.'
  for (let i = 1; i <= MAINTENANCE_EVERY_N_TURNS; i += 1) {
    fire('turn/start', { turn: i })
    fire('user/message', { text: claim })
    stop()
  }

  const cadence = logs.filter((l) => l.includes('proposals='))
  assert.equal(cadence.length, 1, 'C3 ran exactly once in five turns — existing cadence, no scheduler')
  assert.match(cadence[0], /proposals=\d+\(dup=\d+ con=\d+ out=\d+ rep=1 ret=\d+\)/, 'C3 counts appended to the maintenance line')
  assert.ok(cadence[0].includes('maintenance examined='), 'appended to the existing M5 line rather than a new signal')
  assert.equal(_maintenanceTurns(), 0, 'in-memory counter reset for the next window — no persisted marker/daemon')

  assert.deepEqual(snapshot([projectStore.get('relOld'), projectStore.get('relNew')]), seededBefore,
    'maintenance + detection left the seeded records untouched (propose-only)')
  // Note: M5's `markStale` may legitimately demote a record to `stale` when its
  // evidence path is absent from the workspace. That is pre-existing frozen
  // lifecycle behaviour, not C3 — hence the real workspace above, so any diff
  // here could only come from the consolidation pass.

  dispose?.()
  closeAllStores()
  rmSync(dir, { recursive: true, force: true })
})
