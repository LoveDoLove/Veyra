/**
 * Real-runtime composition test.
 *
 * Composes Veyra inside a fresh Cordis context together with the REAL host
 * service classes of the installed DeepSeek Harness (0.2.0-rc.2):
 * SystemPrompt, ToolRuntime, CommandRuntime, SkillRegistry and SettingsForms.
 * This verifies every registration seam Veyra uses against actual DSH
 * implementations rather than doubles, with storage isolated to a temp home
 * and no network ports (the live DSH Web service is never touched).
 *
 * profileContext / configEditor / loader are profile-local boot infrastructure
 * that DSH's profile boot normally owns. They are stubbed in-process on
 * purpose: they are not Veyra's seams, and stubbing avoids composing the real
 * config editor (which pulls in the file-watching loader). Every service
 * Veyra does touch is the real one.
 *
 * Skips when no DSH install is discoverable (set DSH_INSTALL to force one).
 * If a DSH is found but a required service package is missing, this fails
 * loudly — that is a genuine compatibility break, not an environment gap.
 */

import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { findDshRoot, loadDshPackage, resolveDshPackage } from './helpers/dsh.mjs'
import * as veyra from '../src/plugin.mjs'
import { buildToolDefinitions } from '../src/tools.mjs'
import { closeAllStores } from '../src/store.mjs'

const dsh = findDshRoot()
const skip = dsh ? false : 'no DSH install found (set DSH_INSTALL to run)'

const tmpHome = mkdtempSync(join(tmpdir(), 'veyra-runtime-home-'))
const tmpProfile = mkdtempSync(join(tmpdir(), 'veyra-runtime-profile-'))
const ws = mkdtempSync(join(tmpdir(), 'veyra-runtime-ws-'))

after(() => {
  try { closeAllStores() } catch { /* already closed */ }
  for (const dir of [tmpHome, tmpProfile, ws]) rmSync(dir, { recursive: true, force: true })
})

async function until (probe, ms = 5000) {
  const start = Date.now()
  while (Date.now() - start < ms) {
    if (await probe()) return true
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  return false
}

function snapshot (dir) {
  const out = new Map()
  if (!existsSync(dir)) return out
  const walk = (d) => {
    for (const name of readdirSync(d)) {
      const p = join(d, name)
      const st = statSync(p)
      if (st.isDirectory()) walk(p)
      else out.set(relative(dir, p), `${st.size}:${st.mtimeMs}`)
    }
  }
  walk(dir)
  return out
}

async function loadServices () {
  const names = [
    '@deepseek-ai/cordis',
    '@deepseek-ai/dsh-system-prompt',
    '@deepseek-ai/dsh-tools',
    '@deepseek-ai/dsh-commands',
    '@deepseek-ai/dsh-settings',
    '@deepseek-ai/dsh-skill',
  ]
  const loaded = {}
  for (const name of names) {
    assert.ok(resolveDshPackage(name), `DSH install at ${dsh.dir} does not provide ${name}`)
    loaded[name] = await loadDshPackage(name)
    assert.ok(loaded[name], `${name} could not be imported`)
  }
  return loaded
}

test('Veyra composes against the real DSH host services', { skip }, async () => {
  const svc = await loadServices()
  const { Context } = svc['@deepseek-ai/cordis']
  const { SystemPrompt } = svc['@deepseek-ai/dsh-system-prompt']
  const { ToolRuntime } = svc['@deepseek-ai/dsh-tools']
  const { CommandRuntime } = svc['@deepseek-ai/dsh-commands']
  const { SettingsForms } = svc['@deepseek-ai/dsh-settings']
  const { SkillRegistry } = svc['@deepseek-ai/dsh-skill']

  const liveDir = join(homedir(), '.dsh/veyra')
  const liveBefore = snapshot(liveDir)

  const ctx = new Context()
  ctx.provide('profileContext', { home: tmpProfile, dir: tmpProfile, name: 'runtime-test' })
  ctx.provide('configEditor', {
    documentPath: join(tmpProfile, 'settings.patch.json'),
    configuration: () => [],
    entries: () => [],
    edit: async () => {},
  })
  ctx.provide('loader', { await: () => Promise.resolve() })

  ctx.plugin(SystemPrompt)
  ctx.plugin(SkillRegistry)
  ctx.plugin(CommandRuntime)
  ctx.plugin(ToolRuntime)
  ctx.plugin(SettingsForms)
  const fiber = ctx.plugin(veyra, { home: tmpHome, recallLimit: 3 })

  const expected = buildToolDefinitions({ veyraHome: tmpHome, fallbackCwd: '/tmp' }).map((d) => d.name).sort()
  assert.equal(expected.length, 5)

  // Registration is async (tool loading falls back through a dynamic import),
  // so poll for the full seam to come up before asserting.
  const up = await until(() => {
    const visible = ctx.tools?.view()?.visible
    if (!visible || !expected.every((name) => visible.has(name))) return false
    if (!ctx.commands.list(undefined).some((d) => d.name === 'veyra')) return false
    return ctx.settings.presentations.size === 1
  })
  assert.ok(up, 'Veyra registrations did not come up against the real services')

  // 1. Tool seam: exactly Veyra's five tools are visible in the real registry.
  const visible = [...ctx.tools.view().visible.keys()].sort()
  assert.deepEqual(visible, expected, 'real ToolRuntime view must equal the declared tool set')

  // 2. Prompt seam: real SystemPrompt assembles both Veyra contributions —
  // and the agent policy rides in as exactly one static section, re-assembled
  // by DSH before every model step without duplicating.
  const assembly = await ctx.systemPrompt.assemble({})
  const guidanceSections = assembly.sections.filter((s) => s.name === 'veyra:guidance')
  assert.equal(guidanceSections.length, 1, 'exactly one veyra:guidance section expected per assembly')
  assert.ok(guidanceSections[0].text.includes('Veyra Agent Policy'), 'assembled veyra:guidance lost the agent policy text')
  assert.ok(guidanceSections[0].text.includes('Consider retrieval'), 'policy retrieval triggers missing from assembly')
  assert.ok(guidanceSections[0].text.includes('Consider validation'), 'policy validation triggers missing from assembly')
  assert.ok(assembly.contexts.filter((c) => c.name === 'veyra:recall').length === 1, 'veyra:recall context missing')
  const second = await ctx.systemPrompt.assemble({})
  assert.equal(second.sections.filter((s) => s.name === 'veyra:guidance').length, 1, 're-assembly must not duplicate the policy section')
  assert.equal(second.sections.find((s) => s.name === 'veyra:guidance').text, guidanceSections[0].text, 'static policy text must be stable across model steps')

  // 3. Command seam: real CommandRuntime descriptor for /veyra.
  const command = ctx.commands.list(undefined).find((d) => d.name === 'veyra')
  assert.ok(command, 'veyra command missing from real CommandRuntime')
  assert.ok(command.description, 'veyra command descriptor lost its description')

  // 4. Skills seam: both bundled skills are offered through real SkillRegistry.
  const skillOut = await ctx.skills.list()
  const skillNames = (Array.isArray(skillOut) ? skillOut : skillOut.candidates).map((s) => s.name)
  assert.ok(skillNames.includes('veyra'), `veyra skill missing: ${skillNames.join(',')}`)
  assert.ok(skillNames.includes('legacy-onboarding'), `legacy-onboarding skill missing: ${skillNames.join(',')}`)

  // 5. Settings seam: real SettingsForms carries Veyra's presentation policy.
  const policies = [...ctx.settings.presentations.values()]
  assert.equal(policies.length, 1, 'exactly one Veyra settings presentation expected')
  assert.equal(policies[0].auto, true)

  // 6. WebUI seam: no webServer service in this context, so registration must
  // defer rather than crash (the live DSH Web service is never involved).
  assert.equal(ctx.get('webServer'), undefined)

  // 7. Skill resolution: the real SkillRegistry resolves Veyra's bundled
  // skills through the provider contract (list + get with locator/resourceBase).
  const veyraSkill = await ctx.skills.get('veyra')
  assert.ok(veyraSkill, 'skills.get("veyra") must resolve through the real SkillRegistry')
  assert.equal(veyraSkill.name, 'veyra')
  assert.ok(veyraSkill.content.includes('Candidate'), 'skill content must be loaded from SKILL.md')
  assert.ok(veyraSkill.path.endsWith('skills/veyra/SKILL.md'))

  const onboardingSkill = await ctx.skills.get('legacy-onboarding')
  assert.ok(onboardingSkill, 'skills.get("legacy-onboarding") must resolve')
  assert.ok(onboardingSkill.content.includes('Legacy Project Onboarding'))

  // 8. Real event dispatch: agent/turn-stopping must persist only into the
  // isolated home, never into the operator's live store.
  ctx.emit('agent/turn-stopping', { agent: { session: { id: 'runtime-test-session' }, cwd: ws } })
  assert.ok(await until(() => existsSync(join(tmpHome, 'projects'))), 'isolated project store was not created under the temp home')
  assert.deepEqual(snapshot(liveDir), liveBefore, 'live ~/.dsh/veyra must stay untouched')

  // 9. Disposal: disposing the plugin context must unregister everything.
  // This is the core lifecycle contract — registrations must not leak.
  fiber.dispose()
  await new Promise((resolve) => setImmediate(resolve))

  const visibleAfter = ctx.tools?.view()?.visible
  if (visibleAfter) {
    for (const name of expected) {
      assert.ok(!visibleAfter.has(name), `tool ${name} must be unregistered after ctx.dispose()`)
    }
  }
  assert.ok(
    !ctx.commands.list(undefined).some((d) => d.name === 'veyra'),
    '/veyra command must be unregistered after ctx.dispose()',
  )
  const assemblyAfter = await ctx.systemPrompt.assemble({})
  assert.equal(
    assemblyAfter.sections.filter((s) => s.name === 'veyra:guidance').length,
    0,
    'veyra:guidance section must be unregistered after ctx.dispose()',
  )
  assert.equal(
    assemblyAfter.sections.filter((s) => s.name === 'veyra:recall').length,
    0,
    'veyra:recall context must be unregistered after ctx.dispose()',
  )
})

test('real defineTool output is accepted by the real ToolRuntime', { skip }, async () => {
  const svc = await loadServices()
  const { Context } = svc['@deepseek-ai/cordis']
  const { SystemPrompt } = svc['@deepseek-ai/dsh-system-prompt']
  const { ToolRuntime, defineTool } = svc['@deepseek-ai/dsh-tools']

  const ctx = new Context()
  ctx.plugin(SystemPrompt)
  ctx.plugin(ToolRuntime)
  assert.ok(await until(() => typeof ctx.tools?.view === 'function'), 'ToolRuntime did not come up')

  const defs = buildToolDefinitions({ veyraHome: tmpHome, fallbackCwd: '/tmp' })
  assert.equal(defs.length, 5)
  for (const def of defs) {
    const compiled = defineTool(def)
    ctx.tools.register(compiled)
    assert.ok(ctx.tools.view().visible.has(def.name), `${def.name} not visible after real register()`)
  }
  const visible = [...ctx.tools.view().visible.keys()].sort()
  assert.deepEqual(visible, [...defs.map((d) => d.name)].sort())
})
