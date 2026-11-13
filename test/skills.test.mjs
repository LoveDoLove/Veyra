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
  assert.ok(BUNDLED_NAMES.includes('veyra-memory-bootstrap'))
  assert.ok(BUNDLED_NAMES.includes('veyra-memory-curation'))
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

test('veyra-memory-bootstrap SKILL.md carries the required workflow guidance', () => {
  const raw = readFileSync(skillFileFor('veyra-memory-bootstrap'), 'utf8')
  const parsed = parseSkillMarkdown(raw)
  assert.equal(parsed.name, 'veyra-memory-bootstrap')
  assert.equal(stripSkillFrontmatter(raw), parsed.content)
  assert.ok(parsed.content.startsWith('# Veyra Memory Bootstrap'))

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

test('veyra-memory-curation SKILL.md carries the required curation guidance', () => {
  const raw = readFileSync(skillFileFor('veyra-memory-curation'), 'utf8')
  const parsed = parseSkillMarkdown(raw, 'veyra-memory-curation')
  assert.equal(parsed.name, 'veyra-memory-curation')
  assert.equal(stripSkillFrontmatter(raw), parsed.content)
  assert.ok(parsed.content.startsWith('# Veyra Memory Curation'))

  // Both modes, plus the sections that keep them honest.
  for (const heading of [
    '## Mode selection',
    '## Hard rules',
    '## Capture mode',
    '## Maintain mode',
    '## Veyra integration',
    '## Evidence rules',
    '## Completion criteria',
    '## Stop conditions',
    '## Failure and recovery',
  ]) {
    assert.ok(parsed.content.includes(heading), `missing section: ${heading}`)
  }

  // Invariants: reviews against existing Veyra tools only, keeps
  // Candidate/Truth and Similarity/Authority distinct, never stores the whole
  // conversation, and never grants canonical.
  for (const tool of ['veyra_recall', 'veyra_inspect', 'veyra_remember']) {
    assert.ok(parsed.content.includes(tool), `missing tool reference: ${tool}`)
  }
  assert.ok(parsed.content.includes('Candidate ≠ Truth'))
  assert.ok(parsed.content.includes('Similarity ≠ Authority'))
  assert.match(parsed.content, /Never store the conversation/)
  assert.match(parsed.content, /Never promote to canonical/)
  assert.match(parsed.content, /No new mechanisms/)
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

  const onboarding = candidates.find((c) => c.name === 'veyra-memory-bootstrap')
  assert.ok(onboarding)
  assert.equal(onboarding.source, 'bundled')
  assert.equal(onboarding.rank, BUNDLED_SKILL_RANK)
  const loadedOnboarding = await provider.get(onboarding)
  assert.equal(loadedOnboarding.name, 'veyra-memory-bootstrap')
  assert.equal(loadedOnboarding.content.startsWith('---'), false)
  assert.ok(loadedOnboarding.content.startsWith('# Veyra Memory Bootstrap'))
  assert.ok(loadedOnboarding.path.endsWith('skills/veyra-memory-bootstrap/SKILL.md'))
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

  const onboarding = registered.find((def) => def.name === 'veyra-memory-bootstrap')
  assert.ok(onboarding)
  assert.ok(onboarding.content.includes('# Veyra Memory Bootstrap'))
  assert.equal(onboarding.invocation.modelInvocable, true)

  assert.deepEqual(await registerSkills({}), [])
})

test('regression: frontmatter routing metadata matches BUNDLED_SKILL_DEFINITIONS', () => {
  // Single source of truth: the provider path uses the definitions, the
  // register() fallback uses frontmatter. Both must present identical
  // model-facing routing metadata for every bundled skill.
  for (const def of BUNDLED_SKILL_DEFINITIONS) {
    const parsed = parseSkillMarkdown(readFileSync(skillFileFor(def.name), 'utf8'), def.name)
    assert.equal(
      parsed.description,
      def.description,
      `description drift between SKILL.md frontmatter and BUNDLED_SKILL_DEFINITIONS for '${def.name}'`,
    )
    assert.equal(
      parsed.whenToUse,
      def.whenToUse,
      `whenToUse drift between SKILL.md frontmatter and BUNDLED_SKILL_DEFINITIONS for '${def.name}'`,
    )
  }
})

test('regression: curation keeps capture non-destructive and gates maintenance', () => {
  const raw = readFileSync(skillFileFor('veyra-memory-curation'), 'utf8')
  const parsed = parseSkillMarkdown(raw, 'veyra-memory-curation')

  // 1. Capture mode never performs maintenance: the section between the two
  //    mode headings carries no lifecycle command. It may read a health report
  //    as optional context, but must not act on one.
  const capture = parsed.content
    .split('## Capture mode')[1]
    .split('## Maintain mode')[0]
  assert.ok(capture.length > 0, 'capture mode section must exist')
  assert.ok(
    !capture.match(/\/veyra (forget|invalidate|supersede|tombstone|protect)/),
    'capture mode must not invoke destructive /veyra lifecycle commands',
  )
  assert.ok(
    !capture.match(/veyra_forget\s*\(/),
    'capture mode must not call veyra_forget',
  )

  // 2. Health findings are input, not instructions — and are never authorization.
  assert.ok(
    parsed.content.includes('not instructions'),
    'health findings must be framed as input, not instructions',
  )
  assert.match(parsed.content, /never fix them automatically/)
  assert.match(parsed.content, /never authorization/)
  assert.match(parsed.content, /Only an explicit user request in the current conversation/)

  // 3. The blast-radius guardrails survive the merge.
  assert.match(parsed.content, /At most 10 records/)
  assert.match(parsed.content, /No full-sweep auto-iteration/)
  assert.match(parsed.content, /Inspect before acting/)
  assert.match(parsed.content, /Contradictions stay visible/)
  assert.match(parsed.content, /never yours to grant/)

  // 4. Only existing Veyra capabilities are used, and the skill routes the
  //    first-baseline case away to the bootstrap skill.
  for (const tool of ['veyra_recall', 'veyra_inspect', 'veyra_remember', 'veyra_health']) {
    assert.ok(parsed.content.includes(tool), `curation must use ${tool}`)
  }
  assert.match(parsed.content, /veyra-memory-bootstrap/)
  assert.ok(
    !parsed.content.match(/veyra_promote\([^)]*canonical/),
    'curation must not promote to canonical',
  )
})

test('regression: veyra skill explicitly excludes session continuity and bounds STALE/test-failed', () => {
  const veyra = BUNDLED_SKILL_DEFINITIONS.find((d) => d.name === 'veyra')
  assert.ok(veyra)
  assert.ok(veyra.description.includes('Do NOT load for immediate session continuity'))
  assert.ok(veyra.whenToUse.includes('Never for in-session turn progress or session continuity'))

  const raw = readFileSync(skillFileFor('veyra'), 'utf8')
  const parsed = parseSkillMarkdown(raw, 'veyra')
  assert.ok(parsed.content.includes('Durable memory ≠ Session continuity'))
  assert.ok(parsed.content.includes('STALE and INSUFFICIENT_EVIDENCE are not current truth'))
  assert.ok(parsed.content.includes('Outcome: test-failed is a failed attempt, not completed work'))
  assert.ok(parsed.content.match(/NEVER call `veyra_recall`\s+for session continuity/))
})
