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
