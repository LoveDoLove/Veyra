/**
 * Advanced configuration/runtime seam: Veyra's dedicated DSH Settings UI is
 * removed, but runtime.Config, advanced YAML/programmatic config, defaults, and
 * recallLimit behavior must remain intact.
 *   entry.fiber.runtime.Config  → schema()/describe() surface for Host tooling
 *   fiber.config / fiber.update → validated config flowing into apply()
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

test('advanced config seam: runtime.Config exports and live recallLimit/includeReusable updates', async (t) => {
  const cordis = await loadCordis()
  if (!cordis) {
    t.skip('@deepseek-ai/cordis not resolvable')
    return
  }
  const dir = mkdtempSync(join(tmpdir(), 'veyra-settings-'))
  const promptHooks = []
  const ctx = new cordis.Context()
  ctx.provide('tools', { register() {} })
  ctx.provide('systemPrompt', {
    section(desc) { promptHooks.push(desc?.name); return () => {} },
    context(desc) { promptHooks.push(desc?.name); return () => {} },
  })

  const fiber = ctx.plugin(veyra, { home: dir, codebaseWatch: false, eagerStartCodebaseMemory: false })
  await fiber.await()

  assert.equal(fiber.runtime.Config, veyra.Config)
  assert.equal(typeof veyra.Config['~standard']?.validate, 'function')
  const rawDesc = typeof fiber.runtime.Config.describe === 'function' ? fiber.runtime.Config.describe() : null
  const toJson = typeof veyra.Config.toJSON === 'function' ? veyra.Config.toJSON() : null
  const root = toJson?.refs?.[toJson?.uid]
  const resolveRef = (n) => (typeof n === 'number' ? toJson?.refs?.[n] : n)
  const desc = rawDesc?.type === 'object' && rawDesc?.properties ? rawDesc
    : toJson?.type === 'object' && toJson?.properties ? toJson
    : { type: 'object', properties: Object.fromEntries(Object.entries(root?.dict || {}).map(([k, v]) => [k, resolveRef(v)])) }
  assert.equal(desc?.type, 'object')
  assert.ok(desc?.properties?.recallLimit)
  const recallMeta = desc.properties.recallLimit.meta || desc.properties.recallLimit
  const reusableMeta = desc.properties.includeReusable.meta || desc.properties.includeReusable
  assert.equal(recallMeta?.default, 5)
  assert.ok(desc?.properties?.includeReusable)
  assert.equal(reusableMeta?.default, true)

  assert.equal(fiber.config?.recallLimit ?? 5, 5)
  assert.equal(fiber.config?.includeReusable ?? true, true)
  assert.equal(Config['~standard'].validate({}).value.recallLimit, 5)
  assert.equal(Config['~standard'].validate({ recallLimit: 0 }).value.recallLimit, 0)
  assert.ok(promptHooks.includes('veyra:guidance'))
  assert.ok(promptHooks.includes('veyra:recall'))

  // Advanced config save path: fiber.update applies validated config and remounts.
  fiber.update({ home: dir, recallLimit: 3, includeReusable: false, codebaseWatch: false, eagerStartCodebaseMemory: false })
  await fiber.await()
  assert.equal(fiber.config.recallLimit, 3)
  assert.equal(fiber.config.includeReusable, false)

  fiber.update({ home: dir, recallLimit: 0, codebaseWatch: false, eagerStartCodebaseMemory: false })
  await fiber.await()
  assert.equal(fiber.config.recallLimit, 0)

  // Invalid edits are rejected by schema through cordis resolveConfig.
  await assert.rejects(async () => {
    fiber.update({ home: dir, recallLimit: -1 })
    await fiber.await()
  }, />= 0/)

  closeAllStores()
  rmSync(dir, { recursive: true, force: true })
})
