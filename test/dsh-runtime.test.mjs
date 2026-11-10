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
import { fakeRegistry, roomIdFor, roomStore } from './helpers/room.mjs'

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
    '@deepseek-ai/dsh-tool-executor-native',
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
  const NativeToolExecutor = svc['@deepseek-ai/dsh-tool-executor-native']
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
  // DSH 0.2.2-rc.1: systemPrompt assembly requires a selected tool executor
  // when ToolRuntime is present. Provide the native executor in fixtures.
  if (NativeToolExecutor?.apply || NativeToolExecutor?.default?.apply) ctx.plugin(NativeToolExecutor.default ?? NativeToolExecutor)
  else throw new Error('dsh-tool-executor-native plugin export missing apply()')
  ctx.plugin(SettingsForms)
  // The Memory Server resolves a workspace room through the host's registry, so
  // the declared service must be here before the plugin composes. test ws is
  // the workspace this test's turn-stopping event carries.
  const registry = fakeRegistry([ws])
  ctx.provide('workspaceRegistry', registry)
  const fiber = ctx.plugin(veyra, { home: tmpHome, recallLimit: 3 })

  const expected = buildToolDefinitions({ veyraHome: tmpHome, fallbackCwd: '/tmp' }).map((d) => d.name).sort()
  assert.equal(expected.length, 17)

  // Registration is async (tool loading falls back through a dynamic import),
  // so poll for the full seam to come up before asserting. The dedicated
  // Settings UI registration has been removed; Veyra still registers tools,
  // command, prompts, and skill.
  const up = await until(() => {
    const visible = ctx.tools?.view()?.visible
    if (!visible || !expected.every((name) => visible.has(name))) return false
    if (!ctx.commands.list(undefined).some((d) => d.name === 'veyra')) return false
    return ctx.systemPrompt.assemble({
      agent: { session: { header: { cwd: '/tmp' }, deriveMessages: () => [] }, inbox: {} },
    }).then((a) => a.sections.some((s) => s.name === 'veyra:guidance') && a.contexts.some((c) => c.name === 'veyra:recall')).catch(() => false)
  })
  assert.ok(up, 'Veyra registrations did not come up against the real services')

  // 1. Tool seam: exactly the declared tool set is visible in the real registry.
  const visible = [...ctx.tools.view().visible.keys()].sort()
  assert.deepEqual(visible, expected, 'real ToolRuntime view must equal the declared tool set')

  // 2. Prompt seam: real SystemPrompt assembles both Veyra contributions —
  // and the agent policy rides in as exactly one static section, re-assembled
  // by DSH before every model step without duplicating.
  // Task 30: automatic proactive recall fails closed without a task-shaped signal.
  const assembleCtx = { agent: { session: { header: { cwd: '/tmp' }, deriveMessages: () => [{ role: 'user', content: 'veyra runtime composition recall seam check', source: { kind: 'user' } }] } } }
  const assembly = await ctx.systemPrompt.assemble(assembleCtx)
  const guidanceSections = assembly.sections.filter((s) => s.name === 'veyra:guidance')
  assert.equal(guidanceSections.length, 1, 'exactly one veyra:guidance section expected per assembly')
  assert.ok(guidanceSections[0].text.includes('Veyra Agent Policy'), 'assembled veyra:guidance lost the agent policy text')
  assert.ok(guidanceSections[0].text.includes('Proactive Recall'), 'policy proactive recall contract missing from assembly')
  assert.ok(guidanceSections[0].text.includes('Normal Work'), 'policy normal work contract missing from assembly')
  assert.ok(guidanceSections[0].text.includes('Opportunistic Learning'), 'policy opportunistic learning contract missing from assembly')
  assert.ok(guidanceSections[0].text.includes('Future Reuse'), 'policy future reuse contract missing from assembly')
  assert.ok(guidanceSections[0].text.includes('Never block work because memory is unavailable or empty'), 'policy must not block on empty recall')
  assert.ok(assembly.contexts.filter((c) => c.name === 'veyra:recall').length === 1, 'veyra:recall context missing')
  const second = await ctx.systemPrompt.assemble(assembleCtx)
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

  // 5. Advanced config/runtime seam: Veyra's dedicated Settings UI is removed.
  assert.equal(fiber.runtime.Config, veyra.Config)
  const rawDesc = typeof fiber.runtime.Config.describe === 'function' ? fiber.runtime.Config.describe() : null
  const toJson = typeof veyra.Config.toJSON === 'function' ? veyra.Config.toJSON() : null
  const root = toJson?.refs?.[toJson?.uid]
  const resolveRef = (n) => (typeof n === 'number' ? toJson?.refs?.[n] : n)
  const desc = rawDesc?.type === 'object' && rawDesc?.properties ? rawDesc
    : toJson?.type === 'object' && toJson?.properties ? toJson
    : { type: 'object', properties: Object.fromEntries(Object.entries(root?.dict || {}).map(([k, v]) => [k, resolveRef(v)])) }
  const recallMeta = desc.properties?.recallLimit?.meta || desc.properties?.recallLimit || {}
  const reusableMeta = desc.properties?.includeReusable?.meta || desc.properties?.includeReusable || {}
  assert.equal(recallMeta.default, 5)
  assert.equal(reusableMeta.default, true)
  fiber.update({ home: tmpHome, recallLimit: 3 })
  await fiber.await()
  assert.equal(fiber.config.recallLimit, 3)
  fiber.update({ home: tmpHome, recallLimit: 0 })
  await fiber.await()
  assert.equal(fiber.config.recallLimit, 0)

  // 6. WebUI seam: no webServer service in this context, so registration must
  // defer rather than crash (the live DSH Web service is never involved).
  assert.equal(ctx.get('webServer'), undefined)

  // 7. Skill resolution: the real SkillRegistry resolves Veyra's bundled
  // skills through the provider contract (list + get with locator/resourceBase).
  const veyraSkill = await ctx.skills.get('veyra')
  assert.ok(veyraSkill, 'skills.get("veyra") must resolve through the real SkillRegistry')
  assert.equal(veyraSkill.name, 'veyra')
  assert.ok(veyraSkill.content.includes('Candidate'), 'skill content must be loaded from SKILL.md')
  assert.ok(veyraSkill.content.includes('Proactive Recall at start'), 'skill must align proactive recall trigger')
  const veyraSkillNorm = veyraSkill.content.replace(/\s+/g, ' ')
  assert.ok(veyraSkillNorm.includes('supplementary context') && veyraSkillNorm.includes('not a replacement for initial targeted recall'), 'skill must not let snapshot replace targeted recall')
  assert.ok(veyraSkillNorm.includes('never block on empty recall'), 'skill must not block on empty recall')
  assert.ok(veyraSkill.content.includes('Opportunistic Learning'), 'skill must align opportunistic remember trigger')
  assert.ok(veyraSkillNorm.toLowerCase().includes('never store temporary state, unsupported assumptions, secrets'), 'skill must preserve remember safety constraints')
  assert.ok(veyraSkill.path.endsWith('skills/veyra/SKILL.md'))

  const onboardingSkill = await ctx.skills.get('legacy-onboarding')
  assert.ok(onboardingSkill, 'skills.get("legacy-onboarding") must resolve')
  assert.ok(onboardingSkill.content.includes('Legacy Project Onboarding'))

  // 8. Real event dispatch: a turn observed on a registered workspace must
  // persist into that workspace's room, and only into the isolated home —
  // never into the operator's live store. The observation buffer is keyed by
  // the live session object, so the same session must feed both events.
  const session = { id: 'runtime-test-session', header: { cwd: ws } }
  ctx.emit('session/event', session, { type: 'turn/start', data: { turn: 1 } })
  ctx.emit('session/event', session, {
    type: 'user/message',
    data: { text: 'Remember that the isolated runtime store must stay under the temp home.' },
  })
  ctx.emit('agent/turn-stopping', { agent: { session } })
  // Expected layout is the workspace room (`rooms/<roomId>`), not the retired
  // path-keyed `projects/<projectId>` layout.
  const roomId = roomIdFor(ws)
  assert.ok(
    await until(() => existsSync(join(tmpHome, 'rooms', roomId, 'memory.db'))),
    'isolated workspace room was not created under the temp home',
  )
  assert.ok(roomStore(tmpHome, ws).list({ limit: 10 }).length >= 1, 'the observed turn must persist into the workspace room')
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
  const assemblyAfter = await ctx.systemPrompt.assemble(assembleCtx)
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
  assert.equal(defs.length, 17)
  for (const def of defs) {
    const compiled = defineTool(def)
    ctx.tools.register(compiled)
    assert.ok(ctx.tools.view().visible.has(def.name), `${def.name} not visible after real register()`)
  }
  const visible = [...ctx.tools.view().visible.keys()].sort()
  assert.deepEqual(visible, [...defs.map((d) => d.name)].sort())
})
