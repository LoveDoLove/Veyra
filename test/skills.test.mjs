import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import {
  BUNDLED_SKILL_DEFINITIONS,
  BUNDLED_SKILL_RANK,
  BUNDLED_SKILLS_DIR,
  SKILL_PROVIDER_NAME,
  createBundledSkillProvider,
  parseSkillMarkdown,
  registerSkills,
  skillFileFor,
  stripSkillFrontmatter,
} from '../src/skills.mjs'

const BUNDLED_NAMES = BUNDLED_SKILL_DEFINITIONS.map((def) => def.name)

test('bundled definitions match the on-disk skills directory convention', () => {
  assert.ok(BUNDLED_NAMES.includes('veyra'))
  assert.ok(BUNDLED_NAMES.includes('legacy-onboarding'))
  for (const name of BUNDLED_NAMES) {
    assert.match(name, /^[a-z0-9]+(?:-[a-z0-9]+)*$/)
    const parsed = parseSkillMarkdown(readFileSync(skillFileFor(name), 'utf8'), name)
    assert.equal(parsed.name, name)
    assert.ok(parsed.description.length > 20)
    assert.ok(parsed.whenToUse)
  }
})

test('bundled SKILL.md has kebab-case name and routing fields', () => {
  const raw = readFileSync(skillFileFor('veyra'), 'utf8')
  const parsed = parseSkillMarkdown(raw)
  assert.equal(parsed.name, 'veyra')
  assert.match(parsed.name, /^[a-z0-9]+(?:-[a-z0-9]+)*$/)
  assert.ok(parsed.description.length > 20)
  assert.ok(parsed.whenToUse)
  assert.ok(parsed.content.includes('veyra_remember'))
  assert.ok(parsed.content.includes('veyra_promote'))
  assert.ok(parsed.content.includes('canonical'))
  assert.ok(parsed.content.includes('Repository truth remains authoritative'))
  assert.equal(stripSkillFrontmatter(raw), parsed.content)
})

test('legacy-onboarding SKILL.md carries the required workflow guidance', () => {
  const raw = readFileSync(skillFileFor('legacy-onboarding'), 'utf8')
  const parsed = parseSkillMarkdown(raw)
  assert.equal(parsed.name, 'legacy-onboarding')
  assert.equal(stripSkillFrontmatter(raw), parsed.content)
  assert.ok(parsed.content.startsWith('# Legacy Project Onboarding'))

  // Required sections: trigger, depth control, workflow, evidence, completion,
  // stop conditions, failure recovery.
  for (const heading of [
    '## Trigger and applicability',
    '## Depth control',
    '## Workflow',
    '## Veyra integration',
    '## Evidence rules',
    '## Completion criteria',
    '## Stop conditions',
    '## Failure and recovery',
  ]) {
    assert.ok(parsed.content.includes(heading), `missing section: ${heading}`)
  }
  for (const depth of ['**Shallow**', '**Standard**', '**Deep**']) {
    assert.ok(parsed.content.includes(depth), `missing depth: ${depth}`)
  }

  // Invariants: never auto-grant canonical, historical ≠ current, and no
  // invented lifecycle state (Veyra Core owns the lifecycle).
  assert.ok(parsed.content.includes('Canonical is never yours to grant'))
  assert.ok(parsed.content.includes('Historical evidence ≠ current truth'))
  assert.match(parsed.content, /Veyra has no quarantine state/)
})

test('bundled provider lists and loads every bundled skill', async () => {
  const provider = createBundledSkillProvider()
  assert.equal(provider.name, SKILL_PROVIDER_NAME)
  const candidates = await provider.list()
  assert.equal(candidates.length, BUNDLED_SKILL_DEFINITIONS.length)
  const veyra = candidates.find((c) => c.name === 'veyra')
  assert.ok(veyra)
  assert.equal(veyra.source, 'bundled')
  assert.equal(veyra.rank, BUNDLED_SKILL_RANK)
  assert.equal(veyra.invocation.modelInvocable, true)
  assert.equal(veyra.invocation.userInvocable, true)
  assert.equal(veyra.resourceBase.kind, 'directory')
  assert.ok(veyra.resourceBase.path.startsWith(BUNDLED_SKILLS_DIR))

  const loaded = await provider.get(veyra)
  assert.equal(loaded.name, 'veyra')
  assert.ok(loaded.content.includes('Candidate ≠ Truth'))
  assert.equal(loaded.content.startsWith('---'), false)
  assert.ok(loaded.content.startsWith('# Veyra'))
  assert.ok(loaded.path.endsWith('skills/veyra/SKILL.md'))

  const onboarding = candidates.find((c) => c.name === 'legacy-onboarding')
  assert.ok(onboarding)
  assert.equal(onboarding.source, 'bundled')
  assert.equal(onboarding.rank, BUNDLED_SKILL_RANK)
  const loadedOnboarding = await provider.get(onboarding)
  assert.equal(loadedOnboarding.name, 'legacy-onboarding')
  assert.equal(loadedOnboarding.content.startsWith('---'), false)
  assert.ok(loadedOnboarding.content.startsWith('# Legacy Project Onboarding'))
  assert.ok(loadedOnboarding.path.endsWith('skills/legacy-onboarding/SKILL.md'))
})

test('registerSkills prefers registerProvider and falls back to register', async () => {
  const providers = []
  const viaProvider = {
    skills: {
      registerProvider(factory) {
        providers.push(factory({ signal: new AbortController().signal, invalidate: () => {} }))
      },
    },
  }
  const names = await registerSkills(viaProvider)
  assert.deepEqual(names, [...BUNDLED_NAMES])
  assert.equal(providers[0].name, 'veyra')

  const registered = []
  const viaRegister = {
    skills: {
      register(def) {
        registered.push(def)
      },
    },
  }
  const fallback = await registerSkills(viaRegister)
  assert.deepEqual(fallback, [...BUNDLED_NAMES])
  assert.equal(registered[0].name, 'veyra')
  assert.ok(registered[0].content.includes('veyra_recall'))
  assert.equal(registered[0].invocation.modelInvocable, true)

  const onboarding = registered.find((def) => def.name === 'legacy-onboarding')
  assert.ok(onboarding)
  assert.ok(onboarding.content.includes('# Legacy Project Onboarding'))
  assert.equal(onboarding.invocation.modelInvocable, true)

  assert.deepEqual(await registerSkills({}), [])
})
