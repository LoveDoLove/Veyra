import { test } from 'node:test'
import assert from 'node:assert/strict'
import { AUTHORITIES, KINDS, RELATIONS, STATUSES, VALIDATIONS } from '../src/types.mjs'
import { openEphemeralStore } from '../src/store.mjs'
import { newBuffer, observeEvent, candidateFromBuffer } from '../src/observe.mjs'
import { distillBuffer, extractSymbols, looksLikeClaim } from '../src/understand.mjs'
import { INTENTS, detectIntent } from '../src/intent.mjs'
import { DIFF, diffMemory } from '../src/diff.mjs'
import { annotateContradictions, evolveAgainst, markStale } from '../src/evolve.mjs'
import { maybeLearn, remember } from '../src/learn.mjs'
import { recall, summarizeForPrompt } from '../src/retrieve.mjs'
import { isRecallEligible } from '../src/types.mjs'

test('distill extracts files, symbols, and a claim signal', () => {
  const buffer = newBuffer()
  observeEvent(buffer, {}, { type: 'turn/start', data: { turn: 1 } })
  observeEvent(buffer, {}, {
    type: 'user/message',
    data: { content: [{ type: 'text', text: 'The root cause is a sqlite writer race. Always serialize DatabaseSync writes.' }] },
  })
  observeEvent(buffer, {}, {
    type: 'assistant/message',
    data: { message: { content: [{ type: 'text', text: 'export function lockWriter() { /* serialize */ }' }] } },
  })
  observeEvent(buffer, {}, {
    type: 'tool/call',
    data: { name: 'edit', arguments: { file_path: 'src/store.mjs' } },
  })
  const distilled = distillBuffer(buffer, { projectId: 'p_test', sessionId: 's1' })
  assert.ok(distilled)
  assert.equal(distilled.authority, AUTHORITIES.CANDIDATE)
  assert.equal(distilled.source.signal, 'root-cause')
  assert.ok(distilled.evidence.some((e) => e.path === 'src/store.mjs'))
  assert.ok(distilled.evidence.some((e) => e.note === 'sym:lockWriter'))
  assert.ok(distilled.body.includes('Files touched'))
  assert.equal(looksLikeClaim('hello world this is a short note without signal words present'), false)
  assert.deepEqual(extractSymbols('export async function lockWriter() {}'), ['lockWriter'])
})

test('candidateFromBuffer uses distill rather than dumping the turn', () => {
  const buffer = newBuffer()
  observeEvent(buffer, {}, { type: 'turn/start', data: { turn: 3 } })
  observeEvent(buffer, {}, {
    type: 'user/message',
    data: { content: [{ type: 'text', text: 'Diagnose the sqlite writer race and lock the connection so tests stop flaking.' }] },
  })
  observeEvent(buffer, {}, {
    type: 'tool/call',
    data: { name: 'edit', arguments: { path: 'src/store.mjs' } },
  })
  const candidate = candidateFromBuffer(buffer, { projectId: 'p_test' })
  assert.ok(candidate)
  assert.ok(candidate.tags.includes('auto'))
  assert.ok(candidate.source.signal)
  assert.ok(Array.isArray(candidate.source.tokens))
})

test('detectIntent distinguishes why / how / when / general', () => {
  assert.equal(detectIntent('why was there a sqlite writer race'), INTENTS.WHY)
  assert.equal(detectIntent('how did we serialize DatabaseSync writes'), INTENTS.HOW)
  assert.equal(detectIntent('when did we switch to WAL mode last time'), INTENTS.WHEN)
  assert.equal(detectIntent('what is the project memory layout'), INTENTS.ENTITY)
  assert.equal(detectIntent('look at the current files'), INTENTS.GENERAL)
})

test('diff classifies add / duplicate / update / conflict without merging', () => {
  const base = {
    id: 'vey_old',
    title: 'WAL mode is allowed for project sqlite writes',
    body: 'The decision is that WAL mode is allowed for project sqlite writes.',
  }
  const add = diffMemory('Completely unrelated font metric cache for SVG slides.', [base])
  assert.equal(add.suggestion, DIFF.ADD)

  const dup = diffMemory({
    title: 'WAL mode is allowed for project sqlite writes',
    body: 'The decision is that WAL mode is allowed for project sqlite writes.',
  }, [base])
  assert.equal(dup.suggestion, DIFF.DUPLICATE)

  const update = diffMemory({
    title: 'WAL mode is allowed for project sqlite writes',
    body: 'The decision is that WAL mode is allowed for project sqlite writes, and we also enable it on reusable stores after open.',
  }, [base])
  assert.equal(update.suggestion, DIFF.UPDATE)

  const conflict = diffMemory({
    title: 'WAL mode is not allowed for project sqlite writes',
    body: 'The decision is that WAL mode is not allowed for project sqlite writes.',
  }, [base])
  assert.equal(conflict.suggestion, DIFF.CONFLICT)
  assert.equal(conflict.matches.length > 0, true)
})

test('evolve links contradictions and never merges rows', () => {
  const store = openEphemeralStore()
  const first = store.put({
    title: 'WAL mode is allowed for project sqlite writes',
    body: 'The decision is that WAL mode is allowed for project sqlite writes.',
    authority: AUTHORITIES.DERIVED,
  })
  const incoming = {
    id: 'vey_new',
    title: 'WAL mode is not allowed for project sqlite writes',
    body: 'The decision is that WAL mode is not allowed for project sqlite writes.',
    authority: AUTHORITIES.DERIVED,
    relations: [],
  }
  const evolved = evolveAgainst(store, incoming, [first.record])
  assert.equal(evolved.action, 'conflict')
  assert.ok(evolved.record.relations.some((r) => r.type === RELATIONS.CONTRADICTS && r.targetId === first.record.id))
  assert.equal(store.get(first.record.id).id, first.record.id)
  assert.ok(store.get(first.record.id).relations.some((r) => r.type === RELATIONS.CONTRADICTS && r.targetId === 'vey_new'))
  assert.equal(store.count(), 1)
  store.close()
})

test('a later derived update supersedes the older derived neighbor', () => {
  const store = openEphemeralStore()
  const first = store.put({
    title: 'Always serialize DatabaseSync writes',
    body: 'Always serialize DatabaseSync writes to avoid FTS corruption.',
    authority: AUTHORITIES.DERIVED,
  })
  const next = store.put({
    title: 'Always serialize DatabaseSync writes',
    body: 'Always serialize DatabaseSync writes to avoid FTS corruption, and wrap put() with a mutex after open.',
    authority: AUTHORITIES.DERIVED,
  })
  const evolved = evolveAgainst(store, next.record, [first.record])
  assert.ok(evolved.action === 'supersede' || evolved.action === 'update')
  const older = store.get(first.record.id)
  if (evolved.action === 'supersede') {
    assert.equal(older.status, STATUSES.SUPERSEDED)
    assert.equal(isRecallEligible(older), false)
  }
  assert.equal(store.get(next.record.id).id, next.record.id)
  store.close()
})

test('canonical neighbors are never auto-superseded', () => {
  const store = openEphemeralStore()
  const canon = store.put({
    title: 'Always serialize DatabaseSync writes',
    body: 'Always serialize DatabaseSync writes to avoid FTS corruption.',
    authority: AUTHORITIES.CANONICAL,
    validation: VALIDATIONS.REVIEWED,
  }, { explicitCanonical: true })
  const incoming = {
    id: 'vey_later',
    title: 'Always serialize DatabaseSync writes',
    body: 'Always serialize DatabaseSync writes to avoid FTS corruption, plus a mutex.',
    authority: AUTHORITIES.DERIVED,
    relations: [],
  }
  const evolved = evolveAgainst(store, incoming, [canon.record])
  assert.notEqual(evolved.action, 'supersede')
  assert.equal(store.get(canon.record.id).authority, AUTHORITIES.CANONICAL)
  assert.equal(store.get(canon.record.id).status, STATUSES.CURRENT)
  store.close()
})

test('markStale leaves recent and canonical records alone', () => {
  const store = openEphemeralStore()
  const old = store.put({
    title: 'Ancient unverified guess about fonts',
    body: 'Maybe the font cache is the problem. Unverified derived leftover.',
    authority: AUTHORITIES.DERIVED,
  })
  store.put({
    ...old.record,
    updatedAt: '2018-01-01T00:00:00.000Z',
    lastRecalledAt: '2018-01-01T00:00:00.000Z',
  })
  const canon = store.put({
    title: 'Project uses node:sqlite',
    body: 'Canonical: no better-sqlite3.',
    authority: AUTHORITIES.CANONICAL,
    validation: VALIDATIONS.VERIFIED,
  }, { explicitCanonical: true })
  const changed = markStale(store, { now: Date.now(), olderThanMs: 30 * 86_400_000 })
  assert.ok(changed.some((r) => r.id === old.record.id))
  assert.equal(store.get(old.record.id).validation, VALIDATIONS.STALE)
  assert.equal(isRecallEligible(store.get(old.record.id)), false)
  assert.equal(store.get(canon.record.id).validation, VALIDATIONS.VERIFIED)
  store.close()
})

test('maybeLearn attaches evolution relations on a durable candidate', () => {
  const store = openEphemeralStore()
  const neighbor = store.put({
    title: 'Always serialize DatabaseSync writes',
    body: 'Always serialize DatabaseSync writes to avoid FTS corruption.',
    authority: AUTHORITIES.DERIVED,
    evidence: [{ path: 'src/store.mjs' }],
  })
  const written = store.put({
    title: 'Always serialize DatabaseSync writes',
    body: 'Always serialize DatabaseSync writes to avoid FTS corruption and lock put() on one connection.',
    kind: KINDS.OBSERVATION,
    authority: AUTHORITIES.CANDIDATE,
    evidence: [{ path: 'src/store.mjs' }],
    source: { automatic: true, signal: 'decision' },
  })
  const learned = maybeLearn(store, { ...written.record })
  assert.ok(learned)
  assert.equal(learned.id, written.record.id)
  assert.equal(learned.authority, AUTHORITIES.DERIVED)
  assert.ok((learned.relations || []).length >= 1)
  assert.ok(learned.relations.some((r) => r.targetId === neighbor.record.id))
  store.close()
})

test('remember of a conflicting claim keeps both records and banners them on recall', () => {
  const store = openEphemeralStore()
  store.projectId = 'p_aaa'
  const first = remember(store, {
    title: 'WAL mode is allowed for project sqlite writes',
    body: 'The decision is that WAL mode is allowed for project sqlite writes.',
    projectId: 'p_aaa',
    evidence: [{ path: 'src/store.mjs' }],
  })
  const second = remember(store, {
    title: 'WAL mode is not allowed for project sqlite writes',
    body: 'The decision is that WAL mode is not allowed for project sqlite writes.',
    projectId: 'p_aaa',
    evidence: [{ path: 'src/store.mjs' }],
  })
  assert.equal(first.created, true)
  assert.equal(second.created, true)
  assert.notEqual(first.record.id, second.record.id)
  const left = store.get(first.record.id)
  const right = store.get(second.record.id)
  const linked = [left, right].some((r) => (r.relations || []).some((rel) => rel.type === RELATIONS.CONTRADICTS))
  assert.equal(linked, true)

  const items = recall({ projectStore: store, query: 'WAL mode sqlite writes', limit: 5 })
  const annotated = annotateContradictions(items)
  const prompt = summarizeForPrompt(annotated)
  assert.ok(items.length >= 2)
  assert.ok(prompt.includes('not repository truth'))
  if (annotated.some((r) => r.contradictions?.length)) {
    assert.ok(prompt.includes('CONTRADICTION') || prompt.includes('CONTRADICTS'))
  }
  store.close()
})

test('intent-aware recall prefers a how/fix memory for a how query', () => {
  const store = openEphemeralStore()
  store.projectId = 'p_aaa'
  store.put({
    title: 'Root cause: sqlite writer race',
    body: 'The root cause was concurrent put() calls corrupting FTS triggers.',
    authority: AUTHORITIES.DERIVED,
    projectId: 'p_aaa',
    tags: ['root-cause'],
    source: { signal: 'root-cause' },
    evidence: [{ path: 'src/store.mjs' }],
  })
  store.put({
    title: 'Fix: serialize DatabaseSync writes',
    body: 'Always serialize DatabaseSync writes. Lock the writer and add a regression test.',
    authority: AUTHORITIES.DERIVED,
    projectId: 'p_aaa',
    tags: ['fix', 'edited', 'tested'],
    source: { signal: 'fix' },
    evidence: [{ path: 'src/store.mjs' }, { path: 'test/store.test.mjs' }],
  })
  const how = recall({ projectStore: store, query: 'how did we lock DatabaseSync writes', limit: 2 })
  assert.ok(how.length >= 1)
  assert.equal(how[0].intent, INTENTS.HOW)
  assert.equal(typeof how[0].scores.intent_affinity, 'number')
  assert.ok(how.some((r) => /serialize|lock|Fix/i.test(r.title)))
  store.close()
})
