import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply, name, DEFAULT_CONFIG } from '../src/plugin.mjs'
import * as pluginExports from '../src/plugin.mjs'
import { createRequire } from 'node:module'
import { buildToolDefinitions, createToolHarness, registerTools, toRawOutputSchema } from '../src/tools.mjs'

const require = createRequire(import.meta.url)
const DSH_TOOLS_CANDIDATES = [
  '@deepseek-ai/dsh-tools',
  '/home/lovedolove/.local/share/mise/installs/node/lts/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-tools',
]

function loadAssertSupportedJsonSchema() {
  for (const spec of DSH_TOOLS_CANDIDATES) {
    try {
      const mod = require(spec)
      if (typeof mod.assertSupportedJsonSchema === 'function') return mod.assertSupportedJsonSchema
    } catch {
      // try the next candidate
    }
  }
  return null
}
import { handleVeyraCommand } from '../src/commands.mjs'
import { GUIDANCE_TEXT, buildRecallContext } from '../src/context.mjs'
import { AUTHORITIES } from '../src/types.mjs'
import { projectIdFor } from '../src/ids.mjs'
import { closeAllStores } from '../src/store.mjs'

function mockCtx() {
  const tools = []
  const commands = []
  const sections = []
  const contexts = []
  const listeners = {}
  return {
    tools: { register: (def) => tools.push(def) },
    commands: { register: (def) => commands.push(def) },
    systemPrompt: {
      section: (s) => sections.push(s),
      context: (c) => contexts.push(c),
    },
    on: (event, fn) => {
      listeners[event] = listeners[event] || []
      listeners[event].push(fn)
    },
    effect: (factory) => factory(),
    _tools: tools,
    _commands: commands,
    _sections: sections,
    _contexts: contexts,
    _listeners: listeners,
  }
}

/**
 * Mirror of dsh-tools `assertSupportedJsonSchema` for the rule that
 * killed live registration: `required` is only legal on type "object"
 * (as a string array). Per-property `required: true` on a boolean is
 * rejected with:
 *   schema.properties.ok.required is not supported on type "boolean"
 */
function assertSupportedLikeDsh(schema, path = 'schema') {
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) {
    throw new Error(`${path} must be a schema object`)
  }
  const type = schema.type
  if (type && type !== 'object' && Object.hasOwn(schema, 'required')) {
    throw new Error(`${path}.required is not supported on type "${type}"`)
  }
  if (type === 'object') {
    if (Object.hasOwn(schema, 'required') && (
      !Array.isArray(schema.required) || schema.required.some((k) => typeof k !== 'string')
    )) {
      throw new Error(`${path}.required must be an array of strings`)
    }
    if (schema.properties && typeof schema.properties === 'object') {
      for (const [key, node] of Object.entries(schema.properties)) {
        assertSupportedLikeDsh(node, `${path}.properties.${key}`)
      }
    }
  }
  if (type === 'array' && schema.items) {
    assertSupportedLikeDsh(schema.items, `${path}.items`)
  }
  if (Array.isArray(schema.oneOf)) {
    schema.oneOf.forEach((branch, i) => assertSupportedLikeDsh(branch, `${path}.oneOf[${i}]`))
  }
}

test('output schemas are DSH-registerable without defineTool compilation', () => {
  const defs = buildToolDefinitions({ veyraHome: '/tmp', fallbackCwd: '/tmp', recallLimit: 5 })
  assert.equal(defs.length, 5)
  const official = loadAssertSupportedJsonSchema()
  for (const def of defs) {
    assertSupportedLikeDsh(def.output.schema)
    assertSupportedLikeDsh(toRawOutputSchema(def.output.schema))
    if (official) {
      official(def.output.schema)
      official(toRawOutputSchema(def.output.schema))
    }
  }
  if (!official) {
    console.error('[veyra test] official assertSupportedJsonSchema not found; used local mirror only')
  }
})

test('toRawOutputSchema lifts per-property required:true off scalars', () => {
  const raw = toRawOutputSchema({
    type: 'object',
    additionalProperties: true,
    properties: {
      ok: { type: 'boolean', required: true },
      name: { type: 'string', required: true },
      extra: { type: 'number' },
    },
  })
  assert.deepEqual(raw.required, ['ok', 'name'])
  assert.equal(Object.hasOwn(raw.properties.ok, 'required'), false)
  assert.equal(raw.properties.ok.type, 'boolean')
  assertSupportedLikeDsh(raw)
})

test('registerTools keeps going when one tool fails DSH schema checks', async () => {
  const warnings = []
  const accepted = []
  const ctx = {
    tools: {
      register(def) {
        assertSupportedLikeDsh(def.output.schema)
        accepted.push(def.name)
      },
    },
  }
  const names = await registerTools(ctx, {
    veyraHome: '/tmp',
    fallbackCwd: '/tmp',
    log: { warn: (msg) => warnings.push(msg) },
  })
  assert.deepEqual(names, [
    'veyra_remember',
    'veyra_recall',
    'veyra_inspect',
    'veyra_forget',
    'veyra_promote',
  ])
  assert.deepEqual(accepted, names)
  assert.equal(warnings.length, 0)
})

test('plugin does not export Config (Cordis would treat it as a Standard Schema)', () => {
  assert.equal(name, 'veyra')
  assert.equal('Config' in pluginExports, false)
  assert.equal(pluginExports.Config, undefined)
  assert.equal(DEFAULT_CONFIG.observe, true)
  assert.equal(DEFAULT_CONFIG.learn, true)
})

test('plugin exports name=veyra and wires DSH surfaces', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'veyra-plugin-'))
  const ctx = mockCtx()
  const dispose = apply(ctx, { home: dir, observe: true })
  assert.equal(name, 'veyra')
  // tools register asynchronously because defineTool is dynamically imported
  await new Promise((r) => setTimeout(r, 50))
  assert.ok(ctx._sections.some((s) => s.name === 'veyra:guidance'))
  assert.ok(ctx._contexts.some((c) => c.name === 'veyra:recall'))
  assert.ok(ctx._commands.some((c) => c.name === 'veyra'))
  assert.ok(typeof ctx._listeners['session/event']?.[0] === 'function')
  assert.ok(typeof ctx._listeners['agent/turn-stopping']?.[0] === 'function')
  assert.ok(GUIDANCE_TEXT.includes('Memory ≠ Knowledge'))
  dispose?.()
  closeAllStores()
  rmSync(dir, { recursive: true, force: true })
})

test('tools remember → persist → recall across a fresh harness (session A/B)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'veyra-loop-'))
  const cwd = process.cwd()
  const runtime = { veyraHome: dir, fallbackCwd: cwd, recallLimit: 5, includeReusable: true }
  const a = createToolHarness(runtime)
  const remembered = await a.call('veyra_remember', {
    title: 'Veyra stores memory outside the repo',
    body: 'The decision is to keep $DSH_HOME/veyra/ as the only persistence root so user git status stays clean.',
    tags: ['architecture'],
    evidence: [{ path: 'src/ids.mjs' }],
  }, { agent: { session: { header: { cwd }, id: 'session-a' } } })
  assert.equal(remembered.ok, true)
  assert.equal(remembered.record.authority, AUTHORITIES.DERIVED)
  closeAllStores()

  const b = createToolHarness(runtime)
  const recalled = await b.call('veyra_recall', { query: 'persistence home veyra repo' }, {
    agent: { session: { header: { cwd }, id: 'session-b' } },
  })
  assert.ok(recalled.count >= 1)
  assert.ok(recalled.items.some((item) => item.id === remembered.record.id))
  assert.ok(recalled.disclaimer.includes('not repository truth'))

  const ambient = buildRecallContext({
    veyraHome: dir,
    cwd,
    query: 'where does veyra persist memory',
  })
  assert.ok(ambient.includes(remembered.record.id))
  assert.ok(ambient.includes('not repository truth'))

  const blocked = await b.call('veyra_promote', { id: remembered.record.id, to: 'canonical', explicit: false }, {
    agent: { session: { header: { cwd } } },
  })
  assert.equal(blocked.ok, false)

  const promoted = await b.call('veyra_promote', { id: remembered.record.id, to: 'canonical', explicit: true }, {
    agent: { session: { header: { cwd } } },
  })
  assert.equal(promoted.ok, true)
  assert.equal(promoted.record.authority, AUTHORITIES.CANONICAL)

  const status = handleVeyraCommand(runtime, {
    text: 'status',
    agent: { session: { header: { cwd } } },
  })
  assert.ok(status.text.includes(projectIdFor(cwd)))
  assert.ok(status.text.includes('project memories:'))

  closeAllStores()
  rmSync(dir, { recursive: true, force: true })
})

test('project isolation: memories from another project id do not leak', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'veyra-iso-'))
  const runtime = { veyraHome: dir, fallbackCwd: '/tmp/project-one', recallLimit: 5, includeReusable: true }
  const harness = createToolHarness(runtime)
  await harness.call('veyra_remember', {
    title: 'Only project one knows this secret architecture',
    body: 'Project one serializes writes with a mutex. This must not leak.',
  }, { agent: { session: { header: { cwd: '/tmp/project-one' } } } })

  const other = await harness.call('veyra_recall', { query: 'mutex serializes writes', include_reusable: false }, {
    agent: { session: { header: { cwd: '/tmp/project-two' } } },
  })
  assert.equal(other.count, 0)
  closeAllStores()
  rmSync(dir, { recursive: true, force: true })
})
