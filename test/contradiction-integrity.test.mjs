/**
 * CTO Task 21 — Contradiction & Memory Conflict Integrity (focused regression).
 *
 * Verifies existing contract behavior in isolated temp stores:
 * - contradictions remain visible (including when a partner is ineligible for recall)
 * - similarity is not contradiction
 * - newer is not automatically correct; VERIFIED does not auto-override
 * - no silent merge/resolution; provenance/evidence/validation/authority preserved
 * - project isolation preserved
 * - repeated detection/annotation idempotent, no duplicate lifecycle mutation
 * - promotion preserves CONTRADICTS relations
 *
 * Test-only; no network; no production stores.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openProjectStore, closeAllStores } from '../src/store.mjs'
import { projectIdFor } from '../src/ids.mjs'
import { hybridRetrieve, summarizeForPrompt } from '../src/retrieve.mjs'
import { evolveAgainst, detectContradictions, annotateContradictions } from '../src/evolve.mjs'
import { promote } from '../src/learn.mjs'
import { diffMemory } from '../src/diff.mjs'
import { AUTHORITIES, KINDS, RELATIONS, SCOPES, STATUSES, VALIDATIONS } from '../src/types.mjs'

function mk(project = '/tmp/veyra-t21-integrity') {
  const home = mkdtempSync(join(tmpdir(), 'veyra-t21-ci-'))
  const projectId = projectIdFor(project)
  const store = openProjectStore(home, projectId)
  return { home, projectId, store }
}

function put(store, projectId, r) {
  return store.put({
    kind: KINDS.FACT,
    scope: SCOPES.PROJECT,
    authority: AUTHORITIES.DERIVED,
    status: STATUSES.CURRENT,
    validation: VALIDATIONS.REVIEWED,
    confidence: 'medium',
    projectId,
    evidence: [{ note: 'evidence' }],
    updatedAt: Date.now(),
    relations: [],
    ...r,
  }).record
}

test('genuine contradictory claims create visible bidirectional contradiction', () => {
  const { projectId, store } = mk('/tmp/t21-genuine')
  try {
    const a = put(store, projectId, { id: 'g_a', title: 'Alpha uses Redis', body: 'The cache uses Redis.' })
    const bCand = { id: 'g_b', title: 'Alpha does not use Redis', body: 'The cache does not use Redis.', kind: KINDS.FACT, scope: SCOPES.PROJECT, authority: AUTHORITIES.DERIVED, status: STATUSES.CURRENT, validation: VALIDATIONS.REVIEWED, confidence: 'medium', projectId, evidence: [{ note: 'evidence' }], updatedAt: Date.now() }
    const ev = evolveAgainst(store, bCand, { neighbors: [a] })
    assert.equal(ev.action === 'conflict' || ev.action === 'supersede', true)
    store.put(ev.record)
    const ra = store.get('g_a'), rb = store.get('g_b')
    assert.ok((ra.relations || []).some((r) => r.type === RELATIONS.CONTRADICTS && r.targetId === 'g_b'))
    assert.ok((rb.relations || []).some((r) => r.type === RELATIONS.CONTRADICTS && r.targetId === 'g_a'))
    const det = detectContradictions([ra, rb])
    assert.equal(det.hasContradictions, true)
    assert.equal(det.pairs.length, 1)
    const items = hybridRetrieve({ projectStore: store, query: 'Alpha Redis cache', limit: 5 })
    assert.ok(items.some((r) => r.id === 'g_a') && items.some((r) => r.id === 'g_b'))
    assert.ok(items.every((r) => !['g_a', 'g_b'].includes(r.id) || (r.contradictionBanners || []).length >= 1))
  } finally { closeAllStores() }
})

test('compatible similar-keyword claims are not false contradictions', () => {
  const { projectId, store } = mk('/tmp/t21-compatible')
  try {
    const a = put(store, projectId, { id: 'c_a', title: 'Redis for sessions', body: 'Sessions use Redis.' })
    const bCand = { id: 'c_b', title: 'Redis for rate limits', body: 'Rate limits use Redis.', kind: KINDS.FACT, scope: SCOPES.PROJECT, authority: AUTHORITIES.DERIVED, status: STATUSES.CURRENT, validation: VALIDATIONS.REVIEWED, confidence: 'medium', projectId, evidence: [{ note: 'evidence' }], updatedAt: Date.now() }
    assert.notEqual(diffMemory(bCand, a).label, 'conflict')
    const ev = evolveAgainst(store, bCand, { neighbors: [a] })
    assert.notEqual(ev.action, 'conflict')
    store.put(ev.record)
    assert.equal(detectContradictions([store.get('c_a'), store.get('c_b')]).hasContradictions, false)
  } finally { closeAllStores() }
})

test('newer conflicting claim does not silently override older; both stay visible', () => {
  const { projectId, store } = mk('/tmp/t21-newer')
  try {
    put(store, projectId, { id: 'n_old', title: 'Auth uses JWT', body: 'Authentication uses JWT tokens.' })
    const newer = { id: 'n_new', title: 'Auth does not use JWT', body: 'Authentication does not use JWT tokens.', kind: KINDS.FACT, scope: SCOPES.PROJECT, authority: AUTHORITIES.DERIVED, status: STATUSES.CURRENT, validation: VALIDATIONS.REVIEWED, confidence: 'medium', projectId, evidence: [{ note: 'evidence' }], updatedAt: Date.now() + 1000 }
    store.put(evolveAgainst(store, newer, { neighbors: [store.get('n_old')] }).record)
    const oldR = store.get('n_old'), newR = store.get('n_new')
    assert.equal(oldR.status, STATUSES.CURRENT)
    assert.equal(newR.status, STATUSES.CURRENT)
    assert.ok((oldR.relations || []).some((r) => r.type === RELATIONS.CONTRADICTS))
    assert.ok((newR.relations || []).some((r) => r.type === RELATIONS.CONTRADICTS))
    assert.equal(detectContradictions([oldR, newR]).hasContradictions, true)
  } finally { closeAllStores() }
})

test('verified does not auto-override conflicting unverified evidence', () => {
  const { projectId, store } = mk('/tmp/t21-verified')
  try {
    put(store, projectId, { id: 'v_v', title: 'API is REST', body: 'API is REST.', validation: VALIDATIONS.VERIFIED, confidence: 'high', authority: AUTHORITIES.DERIVED })
    const u = { id: 'v_u', title: 'API is not REST', body: 'API is not REST.', kind: KINDS.FACT, scope: SCOPES.PROJECT, authority: AUTHORITIES.DERIVED, status: STATUSES.CURRENT, validation: VALIDATIONS.UNVERIFIED, confidence: 'low', projectId, evidence: [{ note: 'evidence' }], updatedAt: Date.now() }
    store.put(evolveAgainst(store, u, { neighbors: [store.get('v_v')] }).record)
    const vv = store.get('v_v'), vu = store.get('v_u')
    assert.equal(vv.validation, VALIDATIONS.VERIFIED)
    assert.equal(vv.status, STATUSES.CURRENT)
    assert.equal(vu.validation, VALIDATIONS.UNVERIFIED)
    assert.ok((vv.relations || []).some((r) => r.type === RELATIONS.CONTRADICTS && r.targetId === 'v_u'))
    assert.equal(detectContradictions([vv, vu]).hasContradictions, true)
  } finally { closeAllStores() }
})

test('contradiction remains visible in recall when partner is stale, invalid, or forgotten', () => {
  const { projectId, store } = mk('/tmp/t21-ineligible')
  try {
    for (const [k, badVal, extra] of [['s', VALIDATIONS.STALE, {}], ['i', VALIDATIONS.INVALID, {}]]) {
      put(store, projectId, { id: `${k}_a`, title: `${k} uses DB`, body: `${k} uses DB.` })
      put(store, projectId, { id: `${k}_b`, title: `${k} does not use DB`, body: `${k} does not use DB.`, validation: badVal, ...extra })
      store.put({ ...store.get(`${k}_a`), relations: [{ type: RELATIONS.CONTRADICTS, targetId: `${k}_b` }] })
      store.put({ ...store.get(`${k}_b`), relations: [{ type: RELATIONS.CONTRADICTS, targetId: `${k}_a` }] })
      const items = hybridRetrieve({ projectStore: store, query: `${k} uses DB`, limit: 5 })
      assert.ok(items.some((r) => r.id === `${k}_a`), `eligible side should be recalled for ${k}`)
      assert.ok(!items.some((r) => r.id === `${k}_b`), `ineligible ${k} partner must not be recalled as normal memory`)
      const a = items.find((r) => r.id === `${k}_a`)
      assert.ok((a.contradictionBanners || []).some((b) => b.includes('CONTRADICTION') && b.includes(badVal)), `contradiction banner should name ${badVal}`)
      assert.ok((a.contradictions || []).includes(`${k}_b`), `contradiction id preserved for ${k}`)
    }
    put(store, projectId, { id: 'f_a', title: 'f uses MQ', body: 'f uses MQ.' })
    put(store, projectId, { id: 'f_b', title: 'f does not use MQ', body: 'f does not use MQ.' })
    store.put({ ...store.get('f_a'), relations: [{ type: RELATIONS.CONTRADICTS, targetId: 'f_b' }] })
    store.put({ ...store.get('f_b'), relations: [{ type: RELATIONS.CONTRADICTS, targetId: 'f_a' }] })
    store.forget('f_b')
    const fi = hybridRetrieve({ projectStore: store, query: 'f uses MQ', limit: 5 })
    const fa = fi.find((r) => r.id === 'f_a')
    assert.ok(fa && !fi.some((r) => r.id === 'f_b'))
    assert.ok((fa.contradictionBanners || []).some((b) => b.includes('CONTRADICTION') && b.includes('forgotten')))
  } finally { closeAllStores() }
})

test('existing CONTRADICTS relations survive promotion and are not silently resolved', () => {
  const { projectId, store } = mk('/tmp/t21-promote')
  try {
    put(store, projectId, { id: 'p_a', title: 'Mode uses gRPC', body: 'Mode uses gRPC.', authority: AUTHORITIES.CANDIDATE, validation: VALIDATIONS.UNVERIFIED })
    put(store, projectId, { id: 'p_b', title: 'Mode does not use gRPC', body: 'Mode does not use gRPC.', authority: AUTHORITIES.CANDIDATE, validation: VALIDATIONS.UNVERIFIED })
    store.put({ ...store.get('p_a'), relations: [{ type: RELATIONS.CONTRADICTS, targetId: 'p_b' }] })
    store.put({ ...store.get('p_b'), relations: [{ type: RELATIONS.CONTRADICTS, targetId: 'p_a' }] })
    assert.equal(promote(store, 'p_a', { to: AUTHORITIES.DERIVED }).ok, true)
    const canon = promote(store, 'p_a', { to: AUTHORITIES.CANONICAL, explicit: true })
    assert.equal(canon.ok, true)
    assert.equal(store.get('p_a').authority, AUTHORITIES.CANONICAL)
    assert.ok((store.get('p_a').relations || []).some((r) => r.type === RELATIONS.CONTRADICTS && r.targetId === 'p_b'))
    assert.equal(detectContradictions([store.get('p_a'), store.get('p_b')]).hasContradictions, true)
  } finally { closeAllStores() }
})

test('repeated detection and annotation are idempotent and do not mutate records/lifecycle', () => {
  const { projectId, store } = mk('/tmp/t21-repeat')
  try {
    put(store, projectId, { id: 'r_a', title: 'R uses TCP', body: 'R uses TCP.', relations: [{ type: RELATIONS.CONTRADICTS, targetId: 'r_b' }] })
    put(store, projectId, { id: 'r_b', title: 'R does not use TCP', body: 'R does not use TCP.', relations: [{ type: RELATIONS.CONTRADICTS, targetId: 'r_a' }] })
    const snap = JSON.stringify(store.list().map((r) => ({ id: r.id, relations: r.relations, status: r.status, validation: r.validation, authority: r.authority, source: r.source })))
    const d1 = detectContradictions([store.get('r_a'), store.get('r_b')])
    const d2 = detectContradictions([store.get('r_a'), store.get('r_b')])
    assert.equal(d1.pairs.length, 1); assert.equal(d2.pairs.length, 1)
    const a1 = annotateContradictions([store.get('r_a'), store.get('r_b')])
    const a2 = annotateContradictions(a1)
    assert.equal(a2.filter((r) => (r.contradictionBanners || []).length).length, 2)
    assert.equal(JSON.stringify(store.list().map((r) => ({ id: r.id, relations: r.relations, status: r.status, validation: r.validation, authority: r.authority, source: r.source }))), snap)
  } finally { closeAllStores() }
})

test('project isolation prevents cross-project contradiction leakage', () => {
  const home = mkdtempSync(join(tmpdir(), 'veyra-t21-iso-'))
  try {
    const p1 = projectIdFor('/tmp/t21-iso-1'), p2 = projectIdFor('/tmp/t21-iso-2')
    const s1 = openProjectStore(home, p1), s2 = openProjectStore(home, p2)
    put(s1, p1, { id: 'i1', title: 'Iso uses Redis', body: 'Iso uses Redis.' })
    put(s2, p2, { id: 'i2', title: 'Iso does not use Redis', body: 'Iso does not use Redis.' })
    assert.equal(hybridRetrieve({ projectStore: s1, query: 'Iso Redis', limit: 5 }).some((r) => r.id === 'i2'), false)
    assert.equal(hybridRetrieve({ projectStore: s2, query: 'Iso Redis', limit: 5 }).some((r) => r.id === 'i1'), false)
    assert.equal(detectContradictions([...s1.list(), ...s2.list()]).hasContradictions, false)
  } finally { closeAllStores() }
})
