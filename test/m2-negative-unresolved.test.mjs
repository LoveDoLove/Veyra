/**
 * M2 — Negative & unresolved memory (GOAL.md Phase 2 / §8 / §9).
 *
 * Negative memory (known failed approaches) and unresolved investigations
 * are first-class kinds, ported from dsh-memory `mdcg.py add_rejected /
 * add_unresolved` + `tasks.py slugify`:
 *
 *   - idempotent identity: re-recording the same hypothesis must not fork
 *     a second record (falsification is final),
 *   - unresolved identity is a semantic slug (whitespace-folded), and a
 *     re-render updates the body in place — never id/createdAt,
 *   - never CANONICAL: writers hardcode DERIVED + confidence LOW,
 *   - excluded from forward-scored unified retrieval, surfaced instead as a
 *     bounded zero-score coverage tail (NEG_COVERAGE_MAX, appended last,
 *     counted against the budget),
 *   - lifecycle + scope gates apply to the tail exactly like the forward
 *     pool (forgotten/candidate excluded, reusable needs includeReusable),
 *   - renderers distinguish the four retrieval outcomes: known solution /
 *     known failed solution / known unresolved investigation /
 *     no known history.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { KINDS } from '../src/types.mjs'
import { openEphemeralStore, closeAllStores } from '../src/store.mjs'
import { remember } from '../src/learn.mjs'
import { addRejected, addUnresolved, slugify, ticketSlug } from '../src/negative.mjs'
import {
  NEG_COVERAGE_MAX,
  NEG_COVERAGE_SCORE,
  hybridRetrieve,
  summarizeForPrompt,
} from '../src/retrieve.mjs'
import { buildRecallContext, renderAgentContext } from '../src/context.mjs'

const HYPO = 'Use bcrypt cost 4 for every password hash'
const REASON = 'Rejected because cost 4 hashed too fast in the hash benchmark and failed the timing requirement.'
const QUESTION = 'Why does the FTS index drift after checkpoint?'
const CLUE = 'index rebuilt twice in the nightly sync'

const open = (projectId) => openEphemeralStore(':memory:', { scope: 'project', projectId })

test('addRejected is idempotent and can never carry canonical authority', () => {
  const store = open('p_rej')
  const first = addRejected(store, HYPO, REASON)
  assert.equal(first.created, true)
  assert.match(first.record.id, /^rej_[0-9a-f]{10}$/)
  assert.equal(first.record.kind, KINDS.NEGATIVE)
  assert.equal(first.record.authority, 'derived')
  assert.equal(first.record.confidence, 'low')
  assert.equal(first.record.validation, 'verified') // verificationBasis 'test'
  assert.ok(first.record.tags.includes('negative'))
  assert.match(first.record.body, /Hypothesis:/)
  assert.match(first.record.body, /Rejected because:/)
  assert.match(first.record.body, /Verification basis: test/)

  // Re-falsifying the same hypothesis must not fork a second record.
  const second = addRejected(store, HYPO, 'A different later reason for the same hypothesis.')
  assert.equal(second.created, false)
  assert.equal(second.duplicate, true)
  assert.equal(second.record.id, first.record.id)
  assert.equal(second.record.body, first.record.body) // original evidence is preserved
  assert.equal(store.list({ kind: KINDS.NEGATIVE }).length, 1)
})

test('addUnresolved re-renders its body in place, preserving id and createdAt', () => {
  const store = open('p_unr')
  const first = addUnresolved(store, QUESTION, { knownClues: CLUE, context: 'store.mjs checkpoint', goal: 'find the writer' })
  assert.equal(first.created, true)
  assert.match(first.record.id, /^unr_/)
  assert.equal(first.record.kind, KINDS.UNRESOLVED)
  assert.equal(first.record.authority, 'derived')
  assert.equal(first.record.confidence, 'low')
  assert.equal(first.record.validation, 'unverified')
  assert.ok(first.record.tags.includes('unresolved'))
  assert.match(first.record.body, /Known clues: index rebuilt twice/)
  assert.match(first.record.body, /Context: store.mjs checkpoint/)
  assert.match(first.record.body, /Goal: find the writer/)

  const createdAt = first.record.createdAt

  // New evidence for the SAME investigation re-renders the body only.
  const second = addUnresolved(store, QUESTION, { knownClues: `${CLUE}; new clue: checkpoint ordering` })
  assert.equal(second.created, false)
  assert.equal(second.record.id, first.record.id)
  assert.equal(second.record.createdAt, createdAt)
  assert.match(second.record.body, /new clue: checkpoint ordering/)
  assert.equal(store.list({ kind: KINDS.UNRESOLVED }).length, 1)

  // Identical restatement is a zero-write refresh.
  const secondUpdatedAt = second.record.updatedAt
  const third = addUnresolved(store, QUESTION, { knownClues: `${CLUE}; new clue: checkpoint ordering` })
  assert.equal(third.created, false)
  assert.equal(third.duplicate, true)
  assert.equal(third.record.updatedAt, secondUpdatedAt)
})

test('unresolved identity is a semantic slug: whitespace rewording keeps the same ticket', () => {
  const store = open('p_slug')
  const a = addUnresolved(store, 'Cache stampede in the nightly sync?')
  const b = addUnresolved(store, 'Cache  stampede in\nthe nightly sync?')
  assert.equal(b.record.id, a.record.id) // whitespace-folded identity, not a content hash
  assert.notEqual(a.record.body, b.record.body) // but the body reflects the rewording

  // slugify port: separators folded, CJK kept, 64-char cap.
  assert.equal(slugify('a b/c'), 'a-b-c')
  assert.equal(slugify('验证 缓存'), '验证-缓存')
  assert.equal(slugify('x'.repeat(100)).length, 64)
  assert.equal(ticketSlug('Cache  stampede\nnightly', null), ticketSlug('Cache stampede nightly', null))
})

test('remember() routes kind negative/unresolved without memory coercion', () => {
  const store = open('p_route')
  const neg = remember(store, {
    kind: KINDS.NEGATIVE,
    title: HYPO,
    body: REASON,
    tags: ['bcrypt'],
  })
  assert.equal(neg.created, true)
  assert.equal(neg.record.kind, KINDS.NEGATIVE)
  assert.equal(neg.record.authority, 'derived') // §8/§9: never canonical on these paths
  assert.equal(neg.record.confidence, 'low')
  assert.ok(neg.record.tags.includes('negative'))
  assert.ok(neg.record.tags.includes('bcrypt'))

  // Idempotency survives the tool path too.
  const again = remember(store, { kind: KINDS.NEGATIVE, title: HYPO, body: REASON })
  assert.equal(again.created, false)
  assert.equal(again.record.id, neg.record.id)

  const unr = remember(store, { kind: KINDS.UNRESOLVED, title: QUESTION, body: CLUE })
  assert.equal(unr.record.kind, KINDS.UNRESOLVED)
  assert.match(unr.record.id, /^unr_/)
  assert.equal(unr.record.authority, 'derived')

  // Positive memory written alongside stays untouched (no kind bleed).
  const pos = remember(store, { title: 'Serialize DatabaseSync writes', body: 'Serialize every write through a mutex around the shared handle to keep FTS triggers consistent.' })
  assert.equal(pos.record.kind, KINDS.MEMORY)
  assert.equal(pos.record.authority, 'derived')
})

test('unified recall keeps negative/unresolved out of the scored pool but appends a zero-score coverage tail', () => {
  const store = open('p_recall')
  // Positive memory first: forward writes must not evolve against negatives.
  remember(store, { title: 'SQLite WAL stays on', body: 'Keep WAL enabled so concurrent readers never block the writer connection.' })
  remember(store, { title: 'Serialize DatabaseSync writes', body: 'A mutex around the shared handle serializes writes and keeps FTS triggers consistent.' })
  addRejected(store, 'Retry the cache stampede with a bigger TTL', 'Rejected because a bigger TTL made the stampede worse under load.')
  addRejected(store, 'Drop the index instead of rebuilding it', 'Rejected because dropping the index lost the nightly sync checkpoint mapping.')
  addUnresolved(store, 'Why does cache stampede still happen?', { knownClues: 'TTL reset fires before the lock is taken' })

  const results = hybridRetrieve({ projectStore: store, query: 'cache stampede nightly', limit: 6 })
  assert.ok(results.length <= 6)

  const tail = results.filter((r) => r.negativeCoverage === true)
  assert.equal(tail.length, 3) // 2 negative + 1 unresolved, under NEG_COVERAGE_MAX
  for (const rec of tail) {
    assert.ok(rec.kind === KINDS.NEGATIVE || rec.kind === KINDS.UNRESOLVED)
    assert.equal(rec.negLayer, rec.kind)
    assert.equal(rec.scores.composite, NEG_COVERAGE_SCORE)
    assert.equal(NEG_COVERAGE_SCORE, 0)
  }
  // Tail is a contiguous suffix: zero-score entries never interleave.
  const firstFlagged = results.findIndex((r) => r.negativeCoverage === true)
  assert.ok(firstFlagged > 0)
  for (let i = firstFlagged; i < results.length; i += 1) assert.equal(results[i].negativeCoverage, true)
  // Forward-scored entries carry no coverage flag and never duplicate a tail id.
  const forwardIds = results.slice(0, firstFlagged).map((r) => r.id)
  assert.equal(forwardIds.some((id) => tail.some((t) => t.id === id)), false)
  assert.ok(results.slice(0, firstFlagged).every((r) => r.negativeCoverage === undefined))
})

test('coverage tail is capped at NEG_COVERAGE_MAX and consumes budget slots', () => {
  const store = open('p_budget')
  remember(store, { title: 'SQLite WAL stays on', body: 'Keep WAL enabled so concurrent readers never block the writer connection.' })
  remember(store, { title: 'Serialize DatabaseSync writes', body: 'A mutex around the shared handle serializes writes and keeps FTS triggers consistent.' })
  for (let i = 0; i < 5; i += 1) {
    addRejected(store, `Cache stampede fix attempt ${i}`, `Rejected because attempt ${i} still lost the stampede window.`)
  }

  const wide = hybridRetrieve({ projectStore: store, query: 'cache stampede', limit: 10 })
  assert.equal(wide.filter((r) => r.negativeCoverage === true).length, NEG_COVERAGE_MAX)

  // Budget: tail counts against k (reference _primary_slots = max(0, k - n_tail)).
  const narrow = hybridRetrieve({ projectStore: store, query: 'cache stampede', limit: 2 })
  assert.ok(narrow.length <= 2)
  assert.equal(narrow.at(-1).negativeCoverage, true)

  // No query → no tail (a coverage tail without a question is noise).
  assert.deepEqual(hybridRetrieve({ projectStore: store, query: '', limit: 5 }).filter((r) => r.negativeCoverage === true), [])
})

test('explicit kind queries forward-score negative records without the coverage flag', () => {
  const store = open('p_kind')
  addRejected(store, 'Retry the cache stampede with a bigger TTL', 'Rejected because a bigger TTL made the stampede worse under load.')
  addUnresolved(store, 'Why does cache stampede still happen?', { knownClues: 'TTL reset fires before the lock is taken' })

  const negatives = hybridRetrieve({ projectStore: store, query: 'cache stampede', kind: KINDS.NEGATIVE, limit: 5 })
  assert.ok(negatives.length >= 1)
  for (const rec of negatives) {
    assert.equal(rec.kind, KINDS.NEGATIVE)
    assert.equal(rec.negativeCoverage, undefined) // deliberate query, not coverage tail
  }

  const unresolved = hybridRetrieve({ projectStore: store, query: 'cache stampede', kind: KINDS.UNRESOLVED, limit: 5 })
  assert.ok(unresolved.length >= 1)
  assert.ok(unresolved.every((r) => r.kind === KINDS.UNRESOLVED && r.negativeCoverage === undefined))
})

test('coverage tail respects lifecycle gates: forgotten and candidate negatives are excluded', () => {
  const store = open('p_gate')
  remember(store, { title: 'SQLite WAL stays on', body: 'Keep WAL enabled so concurrent readers never block the writer connection.' })
  const keep = addRejected(store, 'Retry the cache stampede with a bigger TTL', 'Rejected because a bigger TTL made the stampede worse under load.')
  const drop = addRejected(store, 'Drop the index instead of rebuilding it', 'Rejected because dropping the index lost the nightly sync checkpoint mapping.')
  // Candidate authority is never lifecycle-eligible for recall.
  store.put({
    id: 'rej_cand000000',
    kind: KINDS.NEGATIVE,
    title: 'cache stampede candidate claim',
    body: 'cache stampede reasoning recorded without review',
    authority: 'candidate',
  })
  store.forget(drop.record.id)

  const results = hybridRetrieve({ projectStore: store, query: 'cache stampede', limit: 6 })
  const ids = results.map((r) => r.id)
  assert.ok(ids.includes(keep.record.id))
  assert.equal(ids.includes(drop.record.id), false) // forgotten
  assert.equal(ids.includes('rej_cand000000'), false) // candidate ≠ knowledge
})

test('coverage tail respects scope isolation: reusable negatives surface only with includeReusable', () => {
  const projectStore = open('p_scope')
  const reusableStore = openEphemeralStore(':memory:', { scope: 'reusable', projectId: 'reusable' })
  remember(projectStore, { title: 'SQLite WAL stays on', body: 'Keep WAL enabled so concurrent readers never block the writer connection.' })
  const shared = addRejected(reusableStore, 'Retry the cache stampede with a bigger TTL', 'Rejected because a bigger TTL made the stampede worse under load.')

  const isolated = hybridRetrieve({ projectStore, query: 'cache stampede', limit: 5, includeReusable: false })
  assert.equal(isolated.some((r) => r.id === shared.record.id), false)

  const inclusive = hybridRetrieve({ projectStore, reusableStore, query: 'cache stampede', limit: 5, includeReusable: true })
  const surfaced = inclusive.find((r) => r.id === shared.record.id)
  assert.ok(surfaced)
  assert.equal(surfaced.negativeCoverage, true)
  assert.equal(surfaced.scope, 'reusable')
})

test('renderers distinguish known solution / known failed solution / known unresolved', () => {
  const mk = (kind, id, title) => ({
    id,
    kind,
    title,
    body: 'body',
    scope: 'project',
    authority: 'derived',
    status: 'current',
    validation: 'unverified',
    confidence: 'low',
    tags: [],
    evidence: [],
    contradictions: [],
    source: {},
  })
  const known = mk(KINDS.MEMORY, 'mem_known000000', 'Serialize DatabaseSync writes')
  const failed = mk(KINDS.NEGATIVE, 'rej_known000000', HYPO)
  const openTicket = mk(KINDS.UNRESOLVED, 'unr_known000000', QUESTION)

  for (const rendered of [summarizeForPrompt([known, failed, openTicket]), renderAgentContext([{ record: known, evidence: [] }, { record: failed, evidence: [] }, { record: openTicket, evidence: [] }])]) {
    assert.match(rendered, /\[NEGATIVE · known failed solution\]/)
    assert.match(rendered, /\[UNRESOLVED · known open investigation\]/)
    const positiveLine = rendered.split('\n').find((line) => line.includes('[mem_known000000]'))
    assert.ok(positiveLine)
    assert.equal(positiveLine.includes('[NEGATIVE'), false)
    assert.equal(positiveLine.includes('[UNRESOLVED'), false)
  }

  // State 4: no known history is a rendered state, not silence.
  assert.equal(summarizeForPrompt([]), '')
})

test('buildRecallContext reports no known history on an empty home (limit 0 stays silent)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'veyra-m2-empty-'))
  const out = buildRecallContext({ veyraHome: dir, cwd: dir, query: 'cache stampede anything' })
  assert.match(out, /No known engineering history/)
  assert.match(out, /Absence of memory is not evidence/)
  closeAllStores()
  rmSync(dir, { recursive: true, force: true })
})
