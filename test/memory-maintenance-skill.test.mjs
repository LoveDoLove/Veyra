/**
 * Memory-maintenance skill registration and workflow guidance.
 *
 * Verifies the bundled memory-maintenance skill:
 * - Is registered and loadable
 * - References existing Veyra lifecycle commands (not inventing a second system)
 * - Follows the skill frontmatter convention
 * - Contains workflow steps that use existing tools
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { parseSkillMarkdown, skillFileFor } from '../src/skills.mjs'
import { memoryHealth } from '../src/health.mjs'
import { VALIDATIONS, AUTHORITIES, KINDS, STATUSES } from '../src/types.mjs'
import { openEphemeralStore } from '../src/store.mjs'

test('memory-maintenance skill frontmatter follows convention', () => {
  const raw = readFileSync(skillFileFor('memory-maintenance'), 'utf8')
  const parsed = parseSkillMarkdown(raw, 'memory-maintenance')
  
  assert.equal(parsed.name, 'memory-maintenance')
  assert.match(parsed.name, /^[a-z0-9]+(?:-[a-z0-9]+)*$/)
  assert.ok(parsed.description.length > 20)
  assert.ok(parsed.whenToUse)
  
  // Verify it is about maintenance, not creation
  assert.match(parsed.description, /maintenance|clean|reconcile|audit/i)
  assert.match(parsed.whenToUse, /maintenance|health|contradic|stale/i)
})

test('memory-maintenance references existing lifecycle commands', () => {
  const raw = readFileSync(skillFileFor('memory-maintenance'), 'utf8')
  const parsed = parseSkillMarkdown(raw)
  
  // Must reference existing /veyra commands
  assert.ok(parsed.content.includes('/veyra invalidate'))
  assert.ok(parsed.content.includes('/veyra supersede'))
  assert.ok(parsed.content.includes('/veyra tombstone'))
  assert.ok(parsed.content.includes('/veyra forget'))
  assert.ok(parsed.content.includes('/veyra health'))
  
  // Must reference veyra_health tool
  assert.ok(parsed.content.includes('veyra_health'))
  
  // Must reference veyra_inspect for reading records
  assert.ok(parsed.content.includes('veyra_inspect'))
  
  // Must NOT invent a second cleanup system
  assert.ok(!parsed.content.match(/DELETE FROM|PRAGMA|sql|sqlite/i), 'must not touch SQLite directly')
  assert.ok(!parsed.content.match(/new.*cleanup|auto.*delete.*all/i), 'must not invent bulk delete')
})

test('memory-maintenance workflow preserves repository truth principle', () => {
  const raw = readFileSync(skillFileFor('memory-maintenance'), 'utf8')
  const parsed = parseSkillMarkdown(raw)
  
  // Must verify against repository
  assert.ok(parsed.content.includes('repository truth') || parsed.content.includes('Repository truth'))
  assert.ok(parsed.content.match(/verify.*against.*repositor/i))
  
  // Must preserve key Veyra invariants
  assert.ok(parsed.content.match(/contradict.*visible|visible.*contradict/i), 'contradictions stay visible')
  assert.ok(parsed.content.match(/canonical.*explicit/i), 'canonical needs explicit approval')
  assert.ok(!parsed.content.match(/auto.*promot.*canonical/i), 'no auto-promotion to canonical')
})

test('memory-maintenance includes KEEP/SUPERSEDE/INVALIDATE/FORGET/DEFER actions', () => {
  const raw = readFileSync(skillFileFor('memory-maintenance'), 'utf8')
  const parsed = parseSkillMarkdown(raw)
  
  // The six core actions from the requirement
  assert.ok(parsed.content.includes('KEEP'))
  assert.ok(parsed.content.includes('SUPERSEDE'))
  assert.ok(parsed.content.includes('INVALIDATE'))
  assert.ok(parsed.content.includes('FORGET'))
  assert.ok(parsed.content.includes('REVALIDATE') || parsed.content.includes('DEFER'))
  assert.ok(parsed.content.includes('TOMBSTONE'))
  
  // Action table or workflow present
  assert.ok(parsed.content.match(/\|.*Action.*\|.*When.*\|/i) || parsed.content.match(/### \d\. .*action/i))
})

test('memory-maintenance workflow includes health → inspect → verify → apply → report', () => {
  const raw = readFileSync(skillFileFor('memory-maintenance'), 'utf8')
  const parsed = parseSkillMarkdown(raw)
  
  // The required workflow steps
  const hasHealthStep = parsed.content.match(/health.*findings|run.*health/i)
  const hasInspectStep = parsed.content.match(/inspect.*record|veyra_inspect/i)
  const hasVerifyStep = parsed.content.match(/verify.*repository|repository.*check/i)
  const hasApplyStep = parsed.content.match(/apply.*action|lifecycle.*action/i)
  const hasReportStep = parsed.content.match(/report|after.*health|health.*after/i)
  
  assert.ok(hasHealthStep, 'must include health findings step')
  assert.ok(hasInspectStep, 'must include inspect step')
  assert.ok(hasVerifyStep, 'must include repository verification step')
  assert.ok(hasApplyStep, 'must include lifecycle action step')
  assert.ok(hasReportStep, 'must include reporting step')
})

test('memory-maintenance includes concrete examples', () => {
  const raw = readFileSync(skillFileFor('memory-maintenance'), 'utf8')
  const parsed = parseSkillMarkdown(raw)
  
  // Must have scenario examples showing how to apply the workflow
  const scenarioCount = (parsed.content.match(/####? Scenario|####? Example/gi) || []).length
  assert.ok(scenarioCount >= 3, `expected at least 3 scenarios, got ${scenarioCount}`)
  
  // At least one example must show repository verification
  assert.ok(parsed.content.match(/repository check:|Repository check:/))
})

test('regression: memory-maintenance enforces per-run safety limit of at most 10 records and halts', () => {
  const raw = readFileSync(skillFileFor('memory-maintenance'), 'utf8')
  const parsed = parseSkillMarkdown(raw)

  // 1. Must define per-run safety limit capped at 10 records
  assert.ok(parsed.content.match(/safety limit.*10|at most.*10 records/i), 'must define 10-record safety limit')
  // 2. Must require stopping immediately when reaching limit
  assert.ok(parsed.content.match(/stop immediately/i), 'must require stopping immediately upon reaching limit')
  // 3. Must forbid full-sweep auto-iteration across all findings
  assert.ok(parsed.content.match(/no full-sweep|never iterate through all/i), 'must forbid iterating through all findings in one run')
  // 4. Must report remaining unhandled findings
  assert.ok(parsed.content.match(/remaining findings|deferred/i), 'must report remaining findings as deferred')
})

test('regression: inspect failure requires DEFER and forbids destructive action', () => {
  const raw = readFileSync(skillFileFor('memory-maintenance'), 'utf8')
  const parsed = parseSkillMarkdown(raw)

  // 1. Inspect failure must yield DEFER
  assert.ok(parsed.content.match(/inspect.*fail.*DEFER/i), 'inspect failure must mandate DEFER')
  // 2. No destructive action without inspection
  assert.ok(parsed.content.match(/no destructive action without|never.*destructive.*uninspected/i), 'must forbid destructive action without inspect')
})

test('regression: no direct database / raw SQLite fallback when tools fail', () => {
  const raw = readFileSync(skillFileFor('memory-maintenance'), 'utf8')
  const parsed = parseSkillMarkdown(raw)

  // 1. Must explicitly forbid bypassing tools with direct database access
  assert.ok(parsed.content.match(/no direct database|never bypass.*direct database/i), 'must forbid direct database bypass')
  // 2. Must not touch raw SQLite / SQL directly
  assert.ok(!parsed.content.match(/DELETE FROM|PRAGMA|sql|sqlite/i), 'must not reference direct SQLite commands')
})

test('regression: stale calculation in memoryHealth does not count forgotten records', () => {
  const activeStale = {
    id: 'vey_active_stale',
    title: 'Active stale item',
    body: 'body',
    validation: VALIDATIONS.STALE,
    forgotten: false,
  }
  const forgottenStale = {
    id: 'vey_forgotten_stale',
    title: 'Forgotten stale item',
    body: 'body',
    validation: VALIDATIONS.STALE,
    forgotten: true,
  }

  const report = memoryHealth([activeStale, forgottenStale])
  assert.equal(report.scanned, 1, 'only non-forgotten records are scanned')
  assert.equal(report.categories.stale, 1, 'only active stale records count in stale category')
  assert.equal(report.findings.staleKnowledge.length, 1, 'only active stale records appear in findings')
  assert.equal(report.findings.staleKnowledge[0].id, 'vey_active_stale')
})

test('regression: 200-row health window shift reveals older pre-existing stale records after forgetting newer records', () => {
  const store = openEphemeralStore()

  try {
    // 1. Insert 20 older records marked STALE
    for (let i = 0; i < 20; i++) {
      store.put({
        id: `vey_old_stale_${String(i).padStart(3, '0')}`,
        title: `Old stale record ${i}`,
        body: 'historical body',
        kind: KINDS.MEMORY,
        status: STATUSES.CURRENT,
        authority: AUTHORITIES.DERIVED,
        validation: VALIDATIONS.STALE,
        updatedAt: new Date(1000000000000 + i * 1000).toISOString(),
      })
    }

    // 2. Insert 195 newer records with UNVERIFIED (making total 215 active records > 200)
    for (let i = 0; i < 195; i++) {
      store.put({
        id: `vey_new_active_${String(i).padStart(3, '0')}`,
        title: `New active record ${i}`,
        body: 'recent body',
        kind: KINDS.MEMORY,
        status: STATUSES.CURRENT,
        authority: AUTHORITIES.DERIVED,
        validation: VALIDATIONS.UNVERIFIED,
        updatedAt: new Date(2000000000000 + i * 1000).toISOString(),
      })
    }

    assert.equal(store.count(), 215, 'store has 215 active records total')

    // 3. Before maintenance: health checks top 200 newest records (LIMIT 200)
    const beforeRecords = store.list({ limit: 200 })
    assert.equal(beforeRecords.length, 200, 'list limit caps at 200')
    const beforeHealth = memoryHealth(beforeRecords)
    // The top 200 newest contain 195 newer records + only 5 older stale records
    assert.equal(beforeHealth.scanned, 200)
    assert.equal(beforeHealth.findings.staleKnowledge.length, 5, 'only 5 stale records visible in top-200 window')

    // 4. Maintenance forgets 25 newer records
    for (let i = 0; i < 25; i++) {
      store.forget(`vey_new_active_${String(i).padStart(3, '0')}`)
    }

    assert.equal(store.count(), 190, 'active store count drops from 215 to 190')

    // 5. After maintenance: health checks top 200 newest non-forgotten records
    const afterRecords = store.list({ limit: 200 })
    assert.equal(afterRecords.length, 190, 'all remaining 190 active records fit in 200 limit')
    const afterHealth = memoryHealth(afterRecords)

    // Now all 20 older stale records fit in the top-200 window!
    assert.equal(afterHealth.scanned, 190)
    assert.equal(afterHealth.findings.staleKnowledge.length, 20, 'all 20 pre-existing stale records now visible')
  } finally {
    store.close()
  }
})

test('regression: maintenance requires explicit user intent; findings never authorize a run', () => {
  const raw = readFileSync(skillFileFor('memory-maintenance'), 'utf8')
  const parsed = parseSkillMarkdown(raw, 'memory-maintenance')

  // 1. whenToUse must not auto-trigger on accumulated health findings.
  assert.ok(
    !parsed.whenToUse.match(/when health findings accumulate/i),
    'whenToUse must not trigger maintenance on health findings alone',
  )
  assert.ok(parsed.whenToUse, 'whenToUse must exist')

  // 2. Explicit intent gate in the workflow.
  assert.ok(
    parsed.content.match(/Begin a maintenance run only for an explicit user\s+maintenance request/),
    'workflow must gate the run on an explicit user maintenance request',
  )

  // 3. Health findings — including memory-review findings — are not authorization.
  assert.ok(
    parsed.content.match(/are never\s+themselves authorization/),
    'findings must be stated as never authorization',
  )
  assert.ok(
    parsed.content.includes('findings surfaced by `memory-review`'),
    'memory-review findings must be explicitly excluded as an auto-trigger',
  )

  // 4. Existing safety model stays intact.
  assert.ok(parsed.content.match(/safety limit.*10|at most.*10 records/i), '10-record safety limit kept')
  assert.ok(parsed.content.match(/stop immediately/i), 'stop-at-limit kept')
  assert.ok(parsed.content.match(/inspect.*fail.*DEFER/i), 'inspect-failure DEFER gate kept')
})
