/**
 * Issue #3 — replacement-language false contradiction edges.
 *
 * Phase A regression coverage: replacement wording is directional evidence,
 * never proof of a shared subject. A conflict now requires BOTH the lexical
 * floor and a stored-provenance subject anchor.
 *
 * Covers remediation coverage items 1–7:
 *   1. unrelated "rather than" is not a conflict
 *   2. other replacement phrases (instead of / deprecated / switched from)
 *   3. genuine polarity conflict with overlap is still detected
 *   4. genuine same-subject replacement keeps directional supersession
 *   5. a shared file path alone is not a shared subject
 *   6. evolveAgainst persists no contradicts edge for an unrelated phrase
 *   7. trust projection reports no contradicted state for that pair
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import { DIFF, diffMemory } from '../src/diff.mjs'
import { evolveAgainst, annotateContradictions } from '../src/evolve.mjs'
import { openEphemeralStore } from '../src/store.mjs'
import { classifyRecordTrust, TRUST_CATEGORIES } from '../src/trust.mjs'
import { AUTHORITIES, RELATIONS } from '../src/types.mjs'

const claim = (title, body, path, extra = {}) => ({
  title,
  body,
  evidence: [{ path }],
  authority: AUTHORITIES.DERIVED,
  ...extra,
})

const conflicts = (diff) => diff.matches.filter((m) => m.suggestion === DIFF.CONFLICT)

test('coverage 1: unrelated "rather than" claim is not a conflict', () => {
  const database = claim(
    'Local database driver',
    'Use the SQLite driver rather than a networked database for local persistence in the desktop build.',
    'src/db.mjs',
  )
  const typescript = claim(
    'TypeScript config for consumers',
    'Set declaration to true in the TypeScript config so downstream consumers receive type information from the package.',
    'tsconfig.json',
  )

  const diff = diffMemory(typescript, [database])
  assert.equal(diff.suggestion, DIFF.ADD)
  assert.equal(conflicts(diff).length, 0)
})

test('coverage 2: instead of / deprecated / switched from stay non-conflicts when unrelated', () => {
  const existing = claim(
    'Cache warmup strategy',
    'Warm the edge cache before the first request instead of paying a cold-start penalty on every deploy.',
    'src/cache.mjs',
  )
  const variants = [
    claim(
      'Release note wording',
      'The old release note is deprecated and replaced by the changelog entry in the docs directory.',
      'docs/releases.md',
    ),
    claim(
      'Package manager',
      'The workspace switched from npm to pnpm for deterministic dependency installs.',
      'package.json',
    ),
  ]

  for (const incoming of variants) {
    const diff = diffMemory(incoming, [existing])
    assert.equal(conflicts(diff).length, 0, `${incoming.title} must not conflict`)
    assert.equal(diff.suggestion, DIFF.ADD)
  }
})

test('coverage 3: genuine polarity conflict with lexical overlap is still detected', () => {
  const positive = claim(
    'Primary database choice',
    'Use PostgreSQL for primary database storage in production deployments.',
    'db/config.js',
  )
  const negative = claim(
    'Primary database choice',
    'Never use PostgreSQL for primary database storage in production deployments.',
    'db/config.js',
  )

  const diff = diffMemory(negative, [positive])
  assert.equal(diff.suggestion, DIFF.CONFLICT)
  assert.equal(conflicts(diff).length, 1)
})

test('coverage 5: a shared file path alone is not a shared subject', () => {
  // Deliberately zero claim-token overlap: the only anchor is the file path.
  const deploy = claim(
    'Deploy artifact sync',
    'The release uploader copies build artifacts with rsync for resumable transfers.',
    'scripts/deploy.sh',
  )
  const shell = claim(
    'CLI flag parsing',
    'Argument flags are validated rather than read from the environment.',
    'scripts/deploy.sh',
  )

  const diff = diffMemory(shell, [deploy])
  assert.equal(sharesEvidencePath(deploy, shell), true, 'fixture shares a file path')
  assert.equal(conflicts(diff).length, 0, 'path overlap alone must not manufacture a conflict')
  // ADD also means evolveAgainst cannot supersede on the path anchor alone.
  assert.equal(diff.suggestion, DIFF.ADD)
})

// Local mirror of the path-anchor check, kept explicit so the fixture above
// cannot silently stop sharing a path without failing this test.
function sharesEvidencePath (a, b) {
  const paths = (r) => new Set((r.evidence || []).map((e) => e.path))
  const left = paths(a)
  for (const p of paths(b)) if (left.has(p)) return true
  return false
}

test('coverage 5b: similarity without a subject anchor is not a conflict', () => {
  const existing = claim(
    'Artifact sync transport',
    'The release pipeline copies build artifacts to edge hosts with rsync for deterministic resumable uploads.',
    'scripts/deploy.sh',
  )
  const incoming = claim(
    'Artifact sync transport',
    'The release pipeline streams build artifacts to edge hosts with zstd instead of rsync for deterministic resumable uploads.',
    'scripts/release.sh',
  )

  const diff = diffMemory(incoming, [existing])
  const top = diff.matches.find((m) => m.record === existing)
  assert.ok(top && top.similarity >= 0.35, 'fixture is above the conflict similarity floor')
  assert.equal(top.suggestion, DIFF.UPDATE, 'high similarity alone is not a conflict')
  assert.equal(conflicts(diff).length, 0)
})

test('coverage 4: genuine same-subject replacement keeps directional supersession', () => {
  const store = openEphemeralStore()
  try {
    const old = store.put(claim(
      'Deploy uses rsync for artifact sync',
      'The release pipeline copies build artifacts to the edge hosts with rsync from the deploy script, which keeps the upload deterministic and resumable across every host in the fleet today.',
      'scripts/deploy.sh',
    )).record
    const replacement = store.put(claim(
      'Deploy switched from rsync to zstd for artifact sync',
      'The release pipeline switched from rsync to zstd streaming for artifact sync in the deploy script, which removes the double temp-file pass and keeps the upload resumable across every host in the fleet today.',
      'scripts/deploy.sh',
    )).record

    const evolved = evolveAgainst(store, replacement, [old])
    assert.equal(evolved.action, 'supersede')
    store.put(evolved.record)

    const retired = store.get(old.id)
    const winner = store.get(replacement.id)
    const sup = (retired.relations || []).filter((r) => r.type === RELATIONS.SUPERSEDES)
    assert.equal(sup.length, 1, 'exactly one directed supersedes edge')
    assert.equal(sup[0].targetId, winner.id)
    assert.equal(
      (winner.relations || []).filter((r) => r.type === RELATIONS.SUPERSEDES).length,
      0,
      'replacement carries no supersedes edge',
    )
  } finally {
    store.close()
  }
})

test('coverage 6/7: unrelated replacement wording persists no contradiction or contradicted trust', () => {
  const store = openEphemeralStore()
  try {
    const existing = store.put(claim(
      'Local database driver',
      'Use the SQLite driver rather than a networked database for local persistence in the desktop build.',
      'src/db.mjs',
    )).record
    const incoming = {
      ...claim(
        'TypeScript config for consumers',
        'Set declaration to true in the TypeScript config so downstream consumers receive type information from the package.',
        'tsconfig.json',
      ),
      id: 'issue3-unrelated-incoming',
    }

    const evolved = evolveAgainst(store, incoming, [existing])
    assert.notEqual(evolved.action, 'conflict')
    assert.notEqual(evolved.action, 'supersede')
    store.put(evolved.record)

    const persistedExisting = store.get(existing.id)
    const persistedIncoming = store.get(incoming.id)
    const edges = (record) => (record.relations || []).filter((r) => r.type === RELATIONS.CONTRADICTS)
    assert.equal(edges(persistedExisting).length, 0, 'existing record gains no contradicts edge')
    assert.equal(edges(persistedIncoming).length, 0, 'incoming record gains no contradicts edge')

    const annotated = annotateContradictions([persistedExisting, persistedIncoming])
    for (const record of annotated) {
      assert.deepEqual(record.contradictions || [], [], 'no contradiction annotation')
      const trust = classifyRecordTrust(record)
      assert.notEqual(trust.category, TRUST_CATEGORIES.CONTRADICTED)
    }
  } finally {
    store.close()
  }
})
