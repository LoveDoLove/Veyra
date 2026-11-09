/**
 * CTO Task 17 — Memory Reusability Quality.
 *
 * Reproducible defect: remember() auto-stamped `os` for every scope, and
 * contextCompatibility() treats shared-key OS mismatch as incompatible.
 * A cross-platform reusable engineering memory captured on one OS became
 * applicability-incompatible on another OS, so §12's eligibility guard
 * could rank-limit/suppress it below an eligible alternative despite the
 * knowledge being project-agnostic and task-relevant (Similarity ≠
 * Applicability must not become false inapplicability for reusable
 * cross-platform knowledge when applicability evidence is absent).
 *
 * Scenarios:
 * A. Same project, matching engineering context: relevant reusable memory retrievable.
 * B. Same project, unrelated task: task-specific experience not universally applicable.
 * C. Different project: project isolation intact.
 * D. Contradictory or stale memory: trust/lifecycle rules effective.
 * E. Insufficient applicability evidence: do not infer universal applicability
 *    from similarity, and do not infer OS inapplicability for reusable
 *    knowledge absent explicit OS constraint.
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { remember } from '../src/learn.mjs'
import { hybridRetrieve, rankRecords, contextCompatibility } from '../src/retrieve.mjs'
import { openProjectStore, openReusableStore, closeAllStores } from '../src/store.mjs'
import { SCOPES, KINDS, AUTHORITIES, STATUSES, VALIDATIONS, CONFIDENCES } from '../src/types.mjs'

function tmpHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'veyra-t17-reuse-'))
}

test('A: same project, matching context — cross-platform reusable knowledge stays applicable', () => {
  const home = tmpHome()
  try {
    const reusable = openReusableStore(home)
    const proj = openProjectStore(home, 'pA')
    remember(reusable, {
      title: 'git rebase preserves commit authorship by default',
      body: 'git rebase keeps author metadata; cross-platform git behavior',
      kind: KINDS.KNOWLEDGE,
      scope: SCOPES.REUSABLE,
      projectId: 'reusable',
      tags: ['git', 'rebase'],
      evidence: [{ note: 'git docs' }],
    })
    // Simulate retrieval on a different OS than capture by passing current context explicitly.
    // The reusable record must not carry an auto-stamped OS contradiction unless explicitly constrained.
    const rec = reusable.list({ limit: 5 })[0]
    assert.ok(rec, 'reusable record stored')
    assert.equal(rec.source?.context?.os, undefined, 'reusable scope must not auto-stamp OS applicability constraint')
    assert.ok(rec.source?.context?.runtime, 'runtime still auto-stamped')
    assert.equal(contextCompatibility(rec, { os: 'win32', runtime: process.version }), 1)
    assert.equal(contextCompatibility(rec, { os: 'darwin', runtime: process.version }), 1)

    const hits = hybridRetrieve({
      projectStore: proj,
      reusableStore: reusable,
      query: 'git rebase commit authorship',
      includeReusable: true,
      limit: 5,
    })
    assert.ok(hits.some((h) => h.id === rec.id), 'cross-platform reusable knowledge retrievable in matching context')
    assert.equal(hits.find((h) => h.id === rec.id)?.scores?.applicability, 1)
  } finally { closeAllStores(); fs.rmSync(home, { recursive: true, force: true }) }
})

test('A/E: explicitly OS-constrained reusable knowledge remains applicability-aware', () => {
  const home = tmpHome()
  try {
    const reusable = openReusableStore(home)
    remember(reusable, {
      title: 'Windows path separator handling in batch scripts',
      body: 'Use backslash escaping in Windows cmd batch scripts',
      kind: KINDS.KNOWLEDGE,
      scope: SCOPES.REUSABLE,
      projectId: 'reusable',
      tags: ['windows', 'batch'],
      context: { os: 'win32' },
      evidence: [{ note: 'explicitly OS-specific reusable note' }],
    })
    const rec = reusable.list({ limit: 5 })[0]
    assert.equal(rec.source?.context?.os, 'win32')
    assert.equal(contextCompatibility(rec, { os: 'win32', runtime: process.version }), 1)
    assert.equal(contextCompatibility(rec, { os: 'linux', runtime: process.version }), 0, 'explicit OS constraint still enforced')
  } finally { closeAllStores(); fs.rmSync(home, { recursive: true, force: true }) }
})

test('B: same project, unrelated task-specific experience is not surfaced as applicable to unrelated query', () => {
  const home = tmpHome()
  try {
    const proj = openProjectStore(home, 'pA')
    remember(proj, {
      title: 'Fix invoice PDF footer alignment in billing module',
      body: 'Adjusted billing/invoiceFooter.css margin-bottom for April invoice export',
      kind: KINDS.MEMORY,
      scope: SCOPES.PROJECT,
      projectId: 'pA',
      tags: ['billing', 'invoice', 'pdf'],
      evidence: [{ path: 'billing/invoiceFooter.css', note: 'task-specific fix' }],
    })
    remember(proj, {
      title: 'SQLite WAL checkpoint tuning for worker queue',
      body: 'Set WAL autocheckpoint for queue durability under concurrent workers',
      kind: KINDS.KNOWLEDGE,
      scope: SCOPES.PROJECT,
      projectId: 'pA',
      tags: ['sqlite', 'wal', 'queue'],
      evidence: [{ path: 'src/queue/db.mjs', note: 'durable knowledge' }],
    })
    const hits = hybridRetrieve({
      projectStore: proj,
      reusableStore: null,
      query: 'sqlite wal checkpoint concurrent worker queue',
      includeReusable: false,
      limit: 5,
    })
    assert.ok(hits.length >= 1)
    assert.ok(hits[0].title.includes('SQLite WAL'), 'matching knowledge ranks first')
    const invoice = hits.find((h) => h.title.includes('invoice PDF footer'))
    const wal = hits.find((h) => h.title.includes('SQLite WAL'))
    assert.ok(wal, 'relevant knowledge retrievable')
    // Task-specific unrelated experience must not outrank clearly relevant knowledge or be treated as universally applicable.
    if (invoice) assert.ok(hits.indexOf(wal) < hits.indexOf(invoice), 'unrelated task-specific experience must not outrank matching knowledge')
  } finally { closeAllStores(); fs.rmSync(home, { recursive: true, force: true }) }
})

test('C: different project isolation remains intact for project and reusable stores', () => {
  const home = tmpHome()
  try {
    const projA = openProjectStore(home, 'pA')
    const projB = openProjectStore(home, 'pB')
    const reusable = openReusableStore(home)
    remember(projA, {
      title: 'Project A auth token rotation uses Redis key prefix authA',
      body: 'Only project A uses authA prefix',
      kind: KINDS.MEMORY,
      scope: SCOPES.PROJECT,
      projectId: 'pA',
      tags: ['auth', 'redis'],
      evidence: [{ path: 'src/authA.mjs' }],
    })
    const hitsB = hybridRetrieve({
      projectStore: projB,
      reusableStore: reusable,
      query: 'auth token rotation redis key prefix authA',
      includeReusable: true,
      limit: 5,
    })
    assert.ok(!hitsB.some((h) => /authA/.test(h.title + h.body)), 'project A memory must not leak to project B')
  } finally { closeAllStores(); fs.rmSync(home, { recursive: true, force: true }) }
})

test('D: stale/contradiction trust and lifecycle rules remain effective (sort-only guard)', () => {
  const now = Date.now()
  const expired = {
    id: 'r_expired', kind: KINDS.KNOWLEDGE, status: STATUSES.CURRENT, validation: VALIDATIONS.UNVERIFIED,
    authority: AUTHORITIES.DERIVED, confidence: CONFIDENCES.HIGH, scope: SCOPES.REUSABLE, projectId: 'reusable',
    title: 'Deprecated API shape for queue config', body: 'queue config uses old key format',
    tags: ['queue'], evidence: [{ note: 'old' }],
    source: { temporal: { validUntil: new Date(now - 86400000).toISOString() }, context: {} },
  }
  const current = {
    id: 'r_current', kind: KINDS.KNOWLEDGE, status: STATUSES.CURRENT, validation: VALIDATIONS.REVIEWED,
    authority: AUTHORITIES.DERIVED, confidence: CONFIDENCES.HIGH, scope: SCOPES.REUSABLE, projectId: 'reusable',
    title: 'Current queue config key format', body: 'queue config uses current key format',
    tags: ['queue'], evidence: [{ note: 'current' }],
    source: { context: {} },
  }
  const ranked = rankRecords([expired, current], { query: 'queue config key format' })
  assert.equal(ranked[0].id, 'r_current')
  assert.equal(ranked.find((r) => r.id === 'r_expired')?.scores?.temporal_validity, 0)
  assert.equal(ranked.find((r) => r.id === 'r_expired')?.scores?.rank_limited, true)
})

test('E: insufficient applicability evidence must not infer universal applicability from similarity alone', () => {
  const inapplicable = {
    id: 'r_win', kind: KINDS.KNOWLEDGE, status: STATUSES.CURRENT, validation: VALIDATIONS.UNVERIFIED,
    authority: AUTHORITIES.DERIVED, confidence: CONFIDENCES.HIGH, scope: SCOPES.REUSABLE, projectId: 'reusable',
    title: 'Windows service restart command', body: 'Use Restart-Service for Windows service management',
    tags: ['windows', 'service'], evidence: [{ note: 'windows only' }],
    source: { context: { os: 'win32' } },
  }
  const eligible = {
    id: 'p_linux', kind: KINDS.MEMORY, status: STATUSES.CURRENT, validation: VALIDATIONS.UNVERIFIED,
    authority: AUTHORITIES.DERIVED, confidence: CONFIDENCES.MEDIUM, scope: SCOPES.PROJECT, projectId: 'pA',
    title: 'Linux service restart command', body: 'Use systemctl restart for Linux service management',
    tags: ['linux', 'service'], evidence: [{ note: 'linux' }],
    source: { context: { os: 'linux' } },
  }
  const ranked = rankRecords([inapplicable, eligible], { query: 'service restart command', preferProject: true })
  assert.equal(ranked[0].id, 'p_linux', 'applicable record ranks first')
  assert.equal(ranked.find((r) => r.id === 'r_win')?.scores?.applicability, 0)
  assert.equal(ranked.find((r) => r.id === 'r_win')?.scores?.rank_limited, true, 'incompatible explicit context is rank-limited, not deleted')
  assert.ok(ranked.some((r) => r.id === 'r_win'), 'incompatible record remains recallable history (not removed)')
})
