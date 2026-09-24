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

function loadValidateJsonSchemaValue() {
  for (const spec of DSH_TOOLS_CANDIDATES) {
    try {
      const mod = require(spec)
      if (typeof mod.validateJsonSchemaValue === 'function') return mod.validateJsonSchemaValue
    } catch {
      // try next
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
  const skills = []
  const providers = []
  const listeners = {}
  return {
    tools: { register: (def) => tools.push(def) },
    commands: { register: (def) => commands.push(def) },
    skills: {
      register: (def) => skills.push(def),
      registerProvider: (factory) => {
        const provider = factory({ signal: new AbortController().signal, invalidate: () => {} })
        providers.push(provider)
        return () => {}
      },
    },
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
    _skills: skills,
    _providers: providers,
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
  assert.ok(ctx._providers.some((p) => p.name === 'veyra'))
  const catalog = await ctx._providers[0].list()
  assert.ok(catalog.some((c) => c.name === 'veyra'))
  const loaded = await ctx._providers[0].get(catalog[0])
  assert.ok(loaded.content.includes('Candidate ≠ Truth'))
  assert.ok(typeof ctx._listeners['session/event']?.[0] === 'function')
  assert.ok(typeof ctx._listeners['agent/inbox/claimed']?.[0] === 'function')
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

test('tool failure payloads strictly satisfy output schema validation (no null objects)', async () => {
  const validate = loadValidateJsonSchemaValue()
  if (!validate) return
  const dir = mkdtempSync(join(tmpdir(), 'veyra-schema-fail-'))
  const runtime = { veyraHome: dir, fallbackCwd: '/tmp/proj', recallLimit: 5, includeReusable: true }
  const defs = Object.fromEntries(buildToolDefinitions(runtime).map((d) => [d.name, d]))
  const harness = createToolHarness(runtime)

  // 1. inspect non-existent
  const inspectRes = await harness.call('veyra_inspect', { id: 'vey_missing' }, { agent: { session: { header: { cwd: '/tmp/proj' } } } })
  assert.equal(inspectRes.ok, false)
  const inspectViolations = validate(defs.veyra_inspect.output.schema, inspectRes)
  assert.deepEqual(inspectViolations, [])

  // 2. forget non-existent
  const forgetRes = await harness.call('veyra_forget', { id: 'vey_missing' }, { agent: { session: { header: { cwd: '/tmp/proj' } } } })
  assert.equal(forgetRes.ok, false)
  const forgetViolations = validate(defs.veyra_forget.output.schema, forgetRes)
  assert.deepEqual(forgetViolations, [])

  // 3. remember then promote without explicit
  const rememberRes = await harness.call('veyra_remember', { title: 'Test', body: 'Test body' }, { agent: { session: { header: { cwd: '/tmp/proj' } } } })
  const promoteRes = await harness.call('veyra_promote', { id: rememberRes.record.id, to: 'canonical', explicit: false }, { agent: { session: { header: { cwd: '/tmp/proj' } } } })
  assert.equal(promoteRes.ok, false)
  const promoteViolations = validate(defs.veyra_promote.output.schema, promoteRes)
  assert.deepEqual(promoteViolations, [])

  closeAllStores()
  rmSync(dir, { recursive: true, force: true })
})

function assertLossless(value) {
  assert.deepEqual(JSON.parse(JSON.stringify(value)), value)
}

test('remember/inspect/promote/forget payloads are lossless JSON and forget is scoped', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'veyra-json-safe-'))
  const runtime = { veyraHome: dir, fallbackCwd: '/tmp/proj', recallLimit: 5, includeReusable: true }
  const harness = createToolHarness(runtime)
  const exec = { agent: { session: { header: { cwd: '/tmp/proj' } } } }
  const remembered = await harness.call('veyra_remember', {
    title: 'JSON-safe remember',
    body: 'Stored only to prove tool output can be JSON.stringified without holes.',
    kind: 'knowledge',
  }, exec)
  assert.equal(remembered.ok, true)
  assertLossless(remembered)

  const recalled = await harness.call('veyra_recall', { query: 'JSON-safe remember' }, exec)
  assertLossless(recalled)

  const inspected = await harness.call('veyra_inspect', { id: remembered.record.id }, exec)
  assertLossless(inspected)

  const reusable = await harness.call('veyra_remember', {
    title: 'JSON-safe reusable forget target',
    body: 'Disposable reusable record used only to prove scoped forget.',
    scope: 'reusable',
  }, exec)
  assert.equal(reusable.ok, true)
  assertLossless(reusable)

  const promoted = await harness.call('veyra_promote', {
    id: remembered.record.id,
    to: 'canonical',
    explicit: true,
  }, exec)
  assert.equal(promoted.ok, true)
  assertLossless(promoted)

  const forgotProject = await harness.call('veyra_forget', { id: remembered.record.id }, exec)
  assert.equal(forgotProject.ok, true)
  assert.equal(forgotProject.record.forgotten, true)
  assertLossless(forgotProject)

  const forgotReusable = await harness.call('veyra_forget', { id: reusable.record.id }, exec)
  assert.equal(forgotReusable.ok, true)
  assert.equal(forgotReusable.record.forgotten, true)
  assert.equal(forgotReusable.record.scope, 'reusable')
  assertLossless(forgotReusable)

  const after = await harness.call('veyra_recall', { query: 'JSON-safe remember forget target' }, exec)
  assert.equal(after.items.some((item) => item.id === remembered.record.id || item.id === reusable.record.id), false)

  closeAllStores()
  rmSync(dir, { recursive: true, force: true })
})
