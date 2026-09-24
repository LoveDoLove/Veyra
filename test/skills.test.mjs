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

test('bundled provider lists and loads the veyra skill', async () => {
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
  assert.deepEqual(names, ['veyra'])
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
  assert.deepEqual(fallback, ['veyra'])
  assert.equal(registered[0].name, 'veyra')
  assert.ok(registered[0].content.includes('veyra_recall'))
  assert.equal(registered[0].invocation.modelInvocable, true)

  assert.deepEqual(await registerSkills({}), [])
})
