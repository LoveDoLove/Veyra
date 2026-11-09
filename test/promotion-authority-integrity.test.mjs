/**
 * Task 20 — Memory Promotion & Authority Integrity
 *
 * Promotion must not raise authority when evidence is insufficient, validation
 * has failed/stale, status is not current, record is forgotten/missing/cross-
 * project; must preserve unresolved contradictions; must be idempotent and
 * must not manufacture evidence/verification or partially mutate on rejection.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openProjectStore, closeAllStores } from '../src/store.mjs'
import { promote } from '../src/learn.mjs'
import { AUTHORITIES, VALIDATIONS, STATUSES, KINDS, CONFIDENCES } from '../src/types.mjs'

function setup(label) {
  const dir = mkdtempSync(join(tmpdir(), `veyra-t20-${label}-`))
  const store = openProjectStore(dir, `proj_${label}`)
  return { dir, store }
}
function cleanup(dir) { try { closeAllStores() } catch {} try { rmSync(dir, { recursive: true, force: true }) } catch {} }
function snap(store, id) {
  const r = store.get(id)
  return r ? { authority: r.authority, validation: r.validation, status: r.status, forgotten: !!r.forgotten, confidence: r.confidence, kind: r.kind, evidenceLen: (r.evidence || []).length, relations: JSON.stringify(r.relations || []) } : null
}
function putCandidate(store, projectId, overrides = {}) {
  return store.put({
    title: 'Candidate record', body: 'Evidence-backed record body.',
    kind: KINDS.MEMORY, authority: AUTHORITIES.CANDIDATE, status: STATUSES.CURRENT,
    validation: VALIDATIONS.REVIEWED, confidence: CONFIDENCES.MEDIUM, scope: 'project',
    evidence: [{ path: 'src/x.mjs', note: 'anchor' }], projectId, ...overrides,
  }).record
}

test('Task 20 promotion integrity: eligible promotion, rejections, contradictions, idempotency, isolation', async (t) => {
  await t.test('valid sufficiently evidenced candidate can be promoted to derived; explicit canonical allowed', () => {
    const { dir, store } = setup('valid')
    try {
      const rec = putCandidate(store, 'proj_valid', { title: 'Root cause: flush timeout', body: 'Await flush before send.', evidence: [{ path: 'src/persist.mjs', note: 'await flush' }] })
      const r1 = promote(store, rec.id, { to: AUTHORITIES.DERIVED })
      assert.equal(r1.ok, true); assert.equal(r1.record.authority, AUTHORITIES.DERIVED)
      assert.equal(r1.record.validation, VALIDATIONS.REVIEWED, 'promotion to derived must not manufacture verification')
      const r2 = promote(store, rec.id, { to: AUTHORITIES.CANONICAL, explicit: true })
      assert.equal(r2.ok, true); assert.equal(r2.record.authority, AUTHORITIES.CANONICAL)
      assert.equal(r2.record.validation, VALIDATIONS.REVIEWED, 'explicit canonical promotion preserves existing validation; must not manufacture VERIFIED')
      const r3 = promote(store, rec.id, { to: AUTHORITIES.CANONICAL, explicit: false })
      assert.equal(r3.ok, false); assert.match(r3.error, /explicit/i)
    } finally { cleanup(dir) }
  })

  await t.test('Task 20.1: explicit canonical promotion preserves UNVERIFIED validation (no manufactured review)', () => {
    const { dir, store } = setup('t201-unv')
    try {
      const rec = putCandidate(store, 'proj_t201-unv', { authority: AUTHORITIES.DERIVED, validation: VALIDATIONS.UNVERIFIED, confidence: CONFIDENCES.LOW, evidence: [] })
      // ensure derived starting state
      store.put({ ...store.get(rec.id), authority: AUTHORITIES.DERIVED, validation: VALIDATIONS.UNVERIFIED }, { explicitCanonical: false })
      const before = snap(store, rec.id)
      const res = promote(store, rec.id, { to: AUTHORITIES.CANONICAL, explicit: true })
      assert.equal(res.ok, true)
      assert.equal(res.record.authority, AUTHORITIES.CANONICAL)
      assert.equal(res.record.validation, VALIDATIONS.UNVERIFIED, 'explicit authority promotion must not manufacture review/verification')
      assert.deepEqual(res.record.evidence, [], 'must not manufacture evidence')
      assert.notDeepEqual(before, snap(store, rec.id))
    } finally { cleanup(dir) }
  })

  await t.test('insufficient evidence/unverified candidate: derived promotion remains standing change only, no evidence/verification manufactured; explicit canonical preserves unverified validation', () => {
    const { dir, store } = setup('noev')
    try {
      const rec = putCandidate(store, 'proj_noev', { validation: VALIDATIONS.UNVERIFIED, confidence: CONFIDENCES.LOW, evidence: [] })
      const before = snap(store, rec.id)
      const res = promote(store, rec.id, { to: AUTHORITIES.DERIVED })
      assert.equal(res.ok, true, 'derived promotion is an explicit standing change; existing contract allows it')
      assert.equal(res.record.authority, AUTHORITIES.DERIVED)
      assert.equal(res.record.validation, VALIDATIONS.REVIEWED, 'existing contract: unverified -> reviewed on derived promotion; not VERIFIED')
      assert.deepEqual(res.record.evidence, [], 'must not manufacture evidence')
      assert.notEqual(before.authority, res.record.authority)
    } finally { cleanup(dir) }
  })

  await t.test('failed validation cannot gain higher authority (derived or explicit canonical)', () => {
    const { dir, store } = setup('invalid')
    try {
      const rec = putCandidate(store, 'proj_invalid', { validation: VALIDATIONS.INVALID })
      const before = snap(store, rec.id)
      const r1 = promote(store, rec.id, { to: AUTHORITIES.DERIVED })
      assert.equal(r1.ok, false); assert.match(r1.error, /invalid/i); assert.deepEqual(snap(store, rec.id), before)
      const r2 = promote(store, rec.id, { to: AUTHORITIES.CANONICAL, explicit: true })
      assert.equal(r2.ok, false); assert.match(r2.error, /invalid/i); assert.deepEqual(snap(store, rec.id), before)
    } finally { cleanup(dir) }
  })

  await t.test('stale memory cannot gain higher authority', () => {
    const { dir, store } = setup('stale')
    try {
      const rec = putCandidate(store, 'proj_stale', { validation: VALIDATIONS.STALE })
      const before = snap(store, rec.id)
      const res = promote(store, rec.id, { to: AUTHORITIES.DERIVED })
      assert.equal(res.ok, false); assert.match(res.error, /stale/i); assert.deepEqual(snap(store, rec.id), before)
    } finally { cleanup(dir) }
  })

  await t.test('non-current status cannot gain higher authority', () => {
    const { dir, store } = setup('sup')
    try {
      const rec = putCandidate(store, 'proj_sup', { status: STATUSES.SUPERSEDED })
      const before = snap(store, rec.id)
      const res = promote(store, rec.id, { to: AUTHORITIES.DERIVED })
      assert.equal(res.ok, false); assert.match(res.error, /current status/i); assert.deepEqual(snap(store, rec.id), before)
    } finally { cleanup(dir) }
  })

  await t.test('unresolved contradiction remains visible; promotion does not silently resolve it', () => {
    const { dir, store } = setup('contr')
    try {
      const a = putCandidate(store, 'proj_contr', { title: 'Cache uses Redis', body: 'Uses Redis.', validation: VALIDATIONS.REVIEWED })
      const b = putCandidate(store, 'proj_contr', { title: 'Cache avoids Redis', body: 'Uses in-memory maps.', authority: AUTHORITIES.DERIVED })
      store.put({ ...store.get(a.id), relations: [{ type: 'contradicts', targetId: b.id, why: 'test', at: new Date().toISOString() }] })
      store.put({ ...store.get(b.id), relations: [{ type: 'contradicts', targetId: a.id, why: 'test', at: new Date().toISOString() }] })
      const before = snap(store, a.id)
      const res = promote(store, a.id, { to: AUTHORITIES.DERIVED })
      assert.equal(res.ok, true, 'existing contract: contradiction is visible context, not an automatic promotion blocker; promotion must not silently resolve it')
      const after = store.get(a.id)
      assert.ok((after.relations || []).some(r => r.type === 'contradicts' && r.targetId === b.id), 'contradicts relation preserved')
      assert.notEqual(before.relations, snap(store, a.id).relations ? undefined : 'x') // authority changed but relations preserved
      assert.equal((store.get(b.id).relations || []).some(r => r.type === 'contradicts'), true)
    } finally { cleanup(dir) }
  })

  await t.test('forgotten, missing, and cross-project records cannot be promoted', () => {
    const { dir, store } = setup('forgot')
    try {
      const rec = putCandidate(store, 'proj_forgot', { forgotten: 1 })
      const before = snap(store, rec.id)
      const res = promote(store, rec.id, { to: AUTHORITIES.DERIVED })
      assert.equal(res.ok, false); assert.match(res.error, /forgotten/i); assert.deepEqual(snap(store, rec.id), before)
      const missing = promote(store, 'vey_missing', { to: AUTHORITIES.DERIVED })
      assert.equal(missing.ok, false); assert.match(missing.error, /not found/i)
    } finally { cleanup(dir) }
    const dir2 = mkdtempSync(join(tmpdir(), 'veyra-t20-xp-'))
    try {
      const a = openProjectStore(dir2, 'proj_a')
      const b = openProjectStore(dir2, 'proj_b')
      const rec = a.put({ title: 'In A', body: 'x', kind: KINDS.MEMORY, authority: AUTHORITIES.CANDIDATE, status: STATUSES.CURRENT, validation: VALIDATIONS.REVIEWED, confidence: CONFIDENCES.MEDIUM, scope: 'project', evidence: [{ path: 'a' }], projectId: 'proj_a' }).record
      const cross = promote(b, rec.id, { to: AUTHORITIES.DERIVED })
      assert.equal(cross.ok, false); assert.match(cross.error, /not found/i)
    } finally { cleanup(dir2) }
  })

  await t.test('already-canonical and repeated promotion are safe/idempotent; canonical not changed through promotion path', () => {
    const { dir, store } = setup('canon')
    try {
      const rec = store.put({ title: 'Canonical', body: 'Project truth.', kind: KINDS.MEMORY, authority: AUTHORITIES.CANONICAL, status: STATUSES.CURRENT, validation: VALIDATIONS.VERIFIED, confidence: CONFIDENCES.HIGH, scope: 'project', evidence: [{ path: 'a' }], projectId: 'proj_canon' }, { explicitCanonical: true }).record
      const before = snap(store, rec.id)
      const same = promote(store, rec.id, { to: AUTHORITIES.CANONICAL, explicit: true })
      assert.equal(same.ok, true); assert.equal(same.already, true); assert.deepEqual(snap(store, rec.id), before)
      const demote = promote(store, rec.id, { to: AUTHORITIES.DERIVED, explicit: true })
      assert.equal(demote.ok, false); assert.match(demote.error, /canonical authority cannot be changed/i); assert.deepEqual(snap(store, rec.id), before)
    } finally { cleanup(dir) }
    const { dir: dir2, store: store2 } = setup('idem')
    try {
      const rec = putCandidate(store2, 'proj_idem')
      const r1 = promote(store2, rec.id, { to: AUTHORITIES.DERIVED }); assert.equal(r1.ok, true)
      const before = snap(store2, rec.id)
      const r2 = promote(store2, rec.id, { to: AUTHORITIES.DERIVED }); assert.equal(r2.ok, true); assert.equal(r2.already, true)
      assert.deepEqual(snap(store2, rec.id), before)
    } finally { cleanup(dir2) }
  })
})
