import test from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { writeFileSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'

import { DIFF, MIN_CONFLICT_SIM, diffMemory } from '../src/diff.mjs'
import {
  stripLineSuffix,
  isTemporaryPath,
  verifyEvidenceHealth,
  detectContradictions,
  markStale,
} from '../src/evolve.mjs'
import { memoryHealth } from '../src/health.mjs'
import { AUTHORITIES, RELATIONS, STATUSES, VALIDATIONS, CONFIDENCES } from '../src/types.mjs'

test('Scenario 1: Semantic threshold gating in src/diff.mjs', () => {
  assert.equal(MIN_CONFLICT_SIM, 0.35, 'MIN_CONFLICT_SIM is exported and equals 0.35')

  // Unrelated records with polarity mismatch (one has negation, one does not)
  // Record A: "Use PostgreSQL for database storage"
  // Record B: "Never run background migration without lock"
  // Both share almost no tokens, but Record B has "never" (negation) while Record A has none.
  const recA = { id: 'a', title: 'Postgres DB', body: 'Use PostgreSQL for database storage' }
  const recB = { id: 'b', title: 'Migrations', body: 'Never run background migration without lock' }

  const diffUnrelated = diffMemory(recB, [recA])
  assert.equal(diffUnrelated.suggestion, DIFF.ADD, 'unrelated records with negation mismatch must be DIFF.ADD, not DIFF.CONFLICT')

  // Related records with polarity mismatch (token overlap >= 0.35)
  // Record C: "Enable WAL mode for SQLite database performance"
  // Record D: "Do not enable WAL mode for SQLite database performance"
  const recC = { id: 'c', title: 'SQLite WAL', body: 'Enable WAL mode for SQLite database performance' }
  const recD = { id: 'd', title: 'SQLite WAL', body: 'Do not enable WAL mode for SQLite database performance' }

  const diffRelated = diffMemory(recD, [recC])
  assert.equal(diffRelated.suggestion, DIFF.CONFLICT, 'related records with polarity mismatch must be DIFF.CONFLICT')
})

test('Scenario 2: Evidence path line-suffix stripping in src/evolve.mjs', () => {
  // stripLineSuffix helper
  assert.equal(stripLineSuffix('src/diff.mjs:42'), 'src/diff.mjs')
  assert.equal(stripLineSuffix('src/diff.mjs:10-25'), 'src/diff.mjs')
  assert.equal(stripLineSuffix('src/diff.mjs#L15'), 'src/diff.mjs')
  assert.equal(stripLineSuffix('src/diff.mjs#L15-L30'), 'src/diff.mjs')
  assert.equal(stripLineSuffix('src/diff.mjs:L20'), 'src/diff.mjs')
  assert.equal(stripLineSuffix('src/diff.mjs'), 'src/diff.mjs')

  // verifyEvidenceHealth with real file
  const tmpDir = mkdtempSync(join(tmpdir(), 'veyra-suffix-test-'))
  try {
    mkdirSync(join(tmpDir, 'src'), { recursive: true })
    writeFileSync(join(tmpDir, 'src/test.js'), 'console.log("hello")')

    const rec = {
      id: 'rec1',
      evidence: [
        { path: 'src/test.js:42' },
        { path: 'src/test.js#L10-L20' },
        { path: 'src/test.js:15' },
      ],
      source: { files: ['src/test.js'] },
    }

    const health = verifyEvidenceHealth(rec, tmpDir)
    assert.equal(health.status, 'healthy', 'existing file with line suffixes must be healthy, not broken')
    assert.equal(health.missingPaths.length, 0)
    assert.equal(health.existingPaths.length, 3)
  } finally {
    rmSync(tmpDir, { recursive: true, force: true })
  }
})

test('Scenario 3: Ephemeral /tmp/ path isolation in src/evolve.mjs', () => {
  const tmpDir = mkdtempSync(join(tmpdir(), 'veyra-temp-test-'))
  try {
    mkdirSync(join(tmpDir, 'src'), { recursive: true })
    writeFileSync(join(tmpDir, 'src/repo.js'), 'export const a = 1')

    assert.equal(isTemporaryPath('/tmp/matrix-123.mjs', tmpDir), true)
    assert.equal(isTemporaryPath('/var/tmp/benchmark.json', tmpDir), true)
    assert.equal(isTemporaryPath('src/repo.js', tmpDir), false)

    // Record with only missing /tmp/ evidence
    const recOnlyTemp = {
      id: 'temp1',
      evidence: [{ path: '/tmp/matrix-missing-456.mjs' }],
    }
    const healthTemp = verifyEvidenceHealth(recOnlyTemp, tmpDir)
    assert.equal(healthTemp.status, 'temporary', 'record with only missing temp paths is temporary')
    assert.equal(healthTemp.missingPaths.length, 0, 'no repo missing paths')
    assert.equal(healthTemp.missingTempPaths.length, 1)

    // markStale should NOT mark recOnlyTemp as stale due to missing temp files
    const store = {
      records: [
        {
          ...recOnlyTemp,
          authority: AUTHORITIES.DERIVED,
          validation: VALIDATIONS.UNVERIFIED,
          status: STATUSES.CURRENT,
          accessedAt: Date.now() - 1000,
          updatedAt: Date.now() - 1000,
        },
      ],
      list() { return this.records },
      put(updated) { this.records = this.records.map((r) => (r.id === updated.id ? updated : r)) },
    }
    const markRes = markStale(store, { workspace: tmpDir })
    assert.equal(markRes.length, 0, 'temporary path absence must not cause record to be marked stale')

    // Record with both existing repo path and missing temp path
    const recMixed = {
      id: 'mixed1',
      evidence: [
        { path: 'src/repo.js' },
        { path: '/tmp/nonexistent-bench.json' },
      ],
    }
    const healthMixed = verifyEvidenceHealth(recMixed, tmpDir)
    assert.equal(healthMixed.status, 'healthy', 'existing repo path makes status healthy despite missing temp path')
  } finally {
    rmSync(tmpDir, { recursive: true, force: true })
  }
})

test('Scenario 4: Active contradiction filtering for superseded records in src/evolve.mjs', () => {
  const recActive = {
    id: 'active1',
    title: 'Active rule',
    status: STATUSES.CURRENT,
    relations: [{ type: RELATIONS.CONTRADICTS, targetId: 'superseded1' }],
  }
  const recSuperseded = {
    id: 'superseded1',
    title: 'Superseded rule',
    status: STATUSES.SUPERSEDED,
    relations: [{ type: RELATIONS.CONTRADICTS, targetId: 'active1' }],
  }

  const result = detectContradictions([recActive, recSuperseded])
  assert.equal(result.hasContradictions, false, 'superseded record must not trigger active contradictions')
  assert.equal(result.pairs.length, 0)
  assert.equal(result.contradictingIds.size, 0)
})

test('Scenario 5: Evolution relation filtering in src/evolve.mjs', () => {
  // Case A: rec2 supersedes rec1
  const rec1 = {
    id: 'r1',
    title: 'Old architecture',
    status: STATUSES.CURRENT,
    relations: [{ type: RELATIONS.CONTRADICTS, targetId: 'r2' }],
  }
  const rec2 = {
    id: 'r2',
    title: 'New architecture',
    status: STATUSES.CURRENT,
    relations: [
      { type: RELATIONS.CONTRADICTS, targetId: 'r1' },
      { type: RELATIONS.SUPERSEDES, targetId: 'r1' },
    ],
  }

  const resultSupersedes = detectContradictions([rec1, rec2])
  assert.equal(resultSupersedes.hasContradictions, false, 'records linked by SUPERSEDES must not be active contradictions')
  assert.equal(resultSupersedes.pairs.length, 0)

  // Case B: inverse relation (rec1 supersededBy or target has supersedes)
  const rec3 = {
    id: 'r3',
    title: 'Superseded record',
    status: STATUSES.CURRENT,
    relations: [
      { type: RELATIONS.CONTRADICTS, targetId: 'r4' },
      { type: RELATIONS.SUPERSEDES, targetId: 'r4' },
    ],
  }
  const rec4 = {
    id: 'r4',
    title: 'Original record',
    status: STATUSES.CURRENT,
    relations: [
      { type: RELATIONS.CONTRADICTS, targetId: 'r3' },
    ],
  }

  const resultInverse = detectContradictions([rec3, rec4])
  assert.equal(resultInverse.hasContradictions, false, 'records linked by SUPERSEDES must not be active contradictions')
  assert.equal(resultInverse.pairs.length, 0)
})

test('Scenario 6: Contradiction and revalidation filtering in src/health.mjs', () => {
  const tmpDir = mkdtempSync(join(tmpdir(), 'veyra-health-test-'))
  try {
    const records = [
      {
        id: 'super1',
        title: 'Old superseded record with broken evidence',
        status: STATUSES.SUPERSEDED,
        authority: AUTHORITIES.DERIVED,
        validation: VALIDATIONS.VERIFIED,
        confidence: CONFIDENCES.MEDIUM,
        evidence: [{ path: 'src/deleted-file.js' }],
        relations: [{ type: RELATIONS.CONTRADICTS, targetId: 'super2' }],
      },
      {
        id: 'super2',
        title: 'Old peer record',
        status: STATUSES.SUPERSEDED,
        authority: AUTHORITIES.DERIVED,
        validation: VALIDATIONS.VERIFIED,
        confidence: CONFIDENCES.MEDIUM,
        relations: [{ type: RELATIONS.CONTRADICTS, targetId: 'super1' }],
      },
    ]

    const store = {
      list() { return records },
    }

    const health = memoryHealth(store, { workspace: tmpDir })

    // Categories: superseded records must not be counted in contradicted category
    assert.equal(health.categories.contradicted, 0, 'superseded records must not count toward contradicted category')

    // Findings: superseded records must not be in revalidationCandidates even with broken evidence
    const reval = health.findings.revalidationCandidates
    assert.equal(reval.some((f) => f.id === 'super1'), false, 'superseded records must not be revalidation candidates')
  } finally {
    rmSync(tmpDir, { recursive: true, force: true })
  }
})
