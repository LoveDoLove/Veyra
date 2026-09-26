/**
 * Settings surface integration: boots Veyra on real cordis and proves the
 * exact seams DSH SettingsForms reads:
 *   entry.fiber.runtime.Config  → schema()/describe() surface
 *   settings.configure({auto})  → section presentation
 *   fiber.config                → validated value flowing into apply()
 * Skips cleanly when @deepseek-ai/cordis is not resolvable.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as veyra from '../src/plugin.mjs'
import { Config } from '../src/config.mjs'
import { closeAllStores } from '../src/store.mjs'

const CORDIS_CANDIDATES = [
  '@deepseek-ai/cordis',
  '/home/lovedolove/.local/share/mise/installs/node/24.21.0/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/cordis/lib/index.js',
  '/home/lovedolove/.local/share/mise/installs/node/lts/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/cordis/lib/index.js',
]

async function loadCordis() {
  for (const spec of CORDIS_CANDIDATES) {
    try {
      return await import(spec)
    } catch {
      // try the next candidate
    }
  }
  return null
}

test('DSH Settings seam: runtime.Config, auto presentation, live recallLimit update', async (t) => {
  const cordis = await loadCordis()
  if (!cordis) {
    t.skip('@deepseek-ai/cordis not resolvable')
    return
  }
  const dir = mkdtempSync(join(tmpdir(), 'veyra-settings-'))
  const configureCalls = []
  const promptHooks = []
  const ctx = new cordis.Context()
  ctx.provide('tools', { register() {} })
  ctx.provide('settings', {
    configure(presentation, owner) {
      configureCalls.push({ presentation, owner })
      return () => {}
    },
  })
  ctx.provide('systemPrompt', {
    section: (s) => promptHooks.push(s),
    context: (c) => promptHooks.push(c),
  })

  const fiber = ctx.plugin(veyra, { home: dir, recallLimit: 0 })
  await fiber

  // SettingsForms.schema(): entry.fiber?.runtime?.Config
  assert.equal(fiber.runtime.Config, Config)
  // auto=true surfaces the section; owner is Veyra's own fiber
  assert.equal(configureCalls.length, 1)
  assert.deepEqual(configureCalls[0].presentation, { auto: true })
  assert.equal(configureCalls[0].owner.runtime, fiber.runtime)
  // Config['~standard'] validated the value; explicit 0 survives into apply()
  assert.equal(fiber.config.recallLimit, 0)
  assert.equal(fiber.config.includeReusable, true)
  // recallLimit 0 → recall context provider is registered on the live plugin
  assert.ok(
    promptHooks.some((h) => h.name === 'veyra:recall' && typeof h.text === 'function'),
    'veyra:recall context provider registered',
  )

  // Live settings save path: SettingsForms.write → configEditor → fiber.update
  fiber.update({ home: dir, recallLimit: 3 })
  await fiber.await()
  assert.equal(fiber.config.recallLimit, 3)

  // Invalid edits are rejected by our schema through cordis resolveConfig
  await assert.rejects(async () => {
    fiber.update({ home: dir, recallLimit: -1 })
    await fiber.await()
  }, />= 0/)

  closeAllStores()
  rmSync(dir, { recursive: true, force: true })
})
