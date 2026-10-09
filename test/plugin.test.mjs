import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply, name, DEFAULT_CONFIG, Config } from '../src/plugin.mjs'
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
import { GUIDANCE_TEXT, buildRecallContext, createContextProvider } from '../src/context.mjs'
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
  assert.equal(defs.length, 16)
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
    'veyra_feedback',
    'veyra_recurrence',
    'veyra_health',
    'cbm_projects',
    'cbm_search',
    'cbm_snippet',
    'cbm_trace',
    'cbm_arch',
    'cbm_search_code',
    'veyra_code_status',
    'veyra_change_impact',
  ])
  assert.deepEqual(accepted, names)
  assert.equal(warnings.length, 0)
})

test('registerTools provides action-oriented descriptions and explicit parameter schemas', async () => {
  const registered = new Map()
  const ctx = {
    tools: {
      register(def) {
        registered.set(def.name, def)
      },
    },
  }
  await registerTools(ctx, {
    veyraHome: '/tmp',
    fallbackCwd: '/tmp',
    log: { warn: () => {} },
  })

  const recall = registered.get('veyra_recall')
  assert.ok(recall.description.includes('Use when investigating'))
  assert.ok(!recall.description.includes('Automatic recall already runs'))

  const remember = registered.get('veyra_remember')
  assert.ok(remember.description.includes('Use after discovering'))

  const feedback = registered.get('veyra_feedback')
  assert.ok(feedback.description.includes('Use after verifying a recalled fix'))

  const rememberEvidence = remember.parameters.evidence
  assert.equal(rememberEvidence.type, 'array')
  assert.equal(rememberEvidence.items.type, 'object')
  assert.ok(rememberEvidence.items.properties.path)

  const rememberContext = remember.parameters.context
  assert.equal(rememberContext.type, 'object')
  assert.ok(rememberContext.properties.toolchain)
})

test('apply recallLimit 0 disables automatic context and leaves tools working', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'veyra-limit0-'))
  const cwd = process.cwd()
  const ctx = mockCtx()
  apply(ctx, { home: dir, recallLimit: 0 })
  await new Promise((r) => setTimeout(r, 50))
  const runtime = { veyraHome: dir, fallbackCwd: cwd, recallLimit: 0, includeReusable: true }
  const harness = createToolHarness(runtime)
  const remembered = await harness.call('veyra_remember', {
    title: 'SQLite WAL must stay on for Veyra stores',
    body: 'Keep WAL so concurrent readers do not block the writer. This must remain recallable via veyra_recall.',
  }, { agent: { session: { header: { cwd }, id: 'limit0-a' } } })
  assert.equal(remembered.ok, true)

  const recalled = await harness.call('veyra_recall', { query: 'WAL sqlite writer' }, {
    agent: { session: { header: { cwd }, id: 'limit0-b' } },
  })
  assert.ok(recalled.count >= 1)
  assert.ok(recalled.items.some((item) => item.id === remembered.record.id))

  const provider = ctx._contexts.find((c) => c.name === 'veyra:recall')
  assert.ok(provider)
  const injected = provider.text({
    agent: {
      session: {
        header: { cwd },
        deriveMessages: () => [{ role: 'user', content: 'How do we keep the sqlite writer from blocking?' }],
      },
    },
  })
  assert.equal(injected, '')

  const viaProvider = createContextProvider(runtime)({
    agent: {
      session: {
        header: { cwd },
        deriveMessages: () => [{ role: 'user', content: 'How do we keep the sqlite writer from blocking?' }],
      },
    },
  })
  assert.equal(viaProvider, '')

  closeAllStores()
  rmSync(dir, { recursive: true, force: true })
})

test('plugin exports a Settings Config for recallLimit and includeReusable', () => {
  assert.equal(name, 'veyra')
  assert.equal(typeof Config?.['~standard']?.validate, 'function')
  assert.equal(typeof Config.toJSON, 'function')
  assert.equal(pluginExports.Config, Config)
  assert.equal(DEFAULT_CONFIG.observe, true)
  assert.equal(DEFAULT_CONFIG.learn, true)
  assert.equal(DEFAULT_CONFIG.recallLimit, 5)
  const form = Config.toJSON()
  assert.equal(form.refs[5].meta.volatile, true)
  assert.equal(form.refs[9].meta.volatile, true)
  assert.deepEqual(Object.keys(form.refs[10].dict).sort(), ['includeReusable', 'recallLimit'])
  assert.equal(Config.dict.observe, undefined)
  assert.equal(Config.dict.learn, undefined)
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

test('Veyra Agent Policy is registered as exactly one static system-prompt section', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'veyra-policy-'))
  const ctx = mockCtx()
  const dispose = apply(ctx, { home: dir, observe: true })
  const guidance = ctx._sections.filter((s) => s.name === 'veyra:guidance')
  assert.equal(guidance.length, 1, 'exactly one veyra:guidance section — no duplicate injection')
  assert.equal(guidance[0].order, 3050)
  assert.equal(typeof guidance[0].text, 'string', 'policy is static text, assembled by DSH per model step')
  assert.equal(guidance[0].text, GUIDANCE_TEXT)
  const recalls = ctx._contexts.filter((c) => c.name === 'veyra:recall')
  assert.equal(recalls.length, 1, 'exactly one veyra:recall context')
  dispose?.()
  closeAllStores()
  rmSync(dir, { recursive: true, force: true })
})

test('Veyra Agent Policy covers availability, triggers, and preserved invariants', () => {
  // 1. Availability: the agent always knows Veyra exists and what it offers.
  assert.ok(GUIDANCE_TEXT.includes('Veyra engineering intelligence is available'))
  assert.ok(GUIDANCE_TEXT.includes('veyra_remember, veyra_recall'))
  // 2. Retrieval triggers.
  assert.ok(GUIDANCE_TEXT.includes('Consider retrieval when'))
  assert.ok(GUIDANCE_TEXT.includes('prior project or architecture decisions'))
  assert.ok(GUIDANCE_TEXT.includes('project constraints and durable implementation conventions'))
  assert.ok(GUIDANCE_TEXT.includes('troubleshooting outcomes'))
  assert.ok(GUIDANCE_TEXT.includes('conflicting historical knowledge'))
  // 3. When NOT to use Veyra: no per-turn obligation, trivial tasks skipped.
  assert.ok(GUIDANCE_TEXT.includes('Consider retrieval when'))
  assert.ok(GUIDANCE_TEXT.includes('typos, formatting-only edits'))
  assert.ok(!GUIDANCE_TEXT.includes('skip the tool call'))
  // 4. Recording triggers + transient noise rule.
  assert.ok(GUIDANCE_TEXT.includes('Consider recording'))
  assert.ok(GUIDANCE_TEXT.includes('durable architecture decisions'))
  assert.ok(GUIDANCE_TEXT.includes('Transient conversation noise must never become memory'))
  // 5. Validation triggers for conflicting / obsolete knowledge.
  assert.ok(GUIDANCE_TEXT.includes('Consider validation'))
  assert.ok(GUIDANCE_TEXT.includes('conflicts with recalled knowledge'))
  assert.ok(GUIDANCE_TEXT.includes('remembered knowledge looks obsolete'))
  // 6. Interpretation: results are evidence/context, verified against the repo.
  assert.ok(GUIDANCE_TEXT.includes('evidence and context, not repository truth'))
  assert.ok(GUIDANCE_TEXT.includes('current code, tests, and git history'))
  // 7. Similarity never raises standing.
  assert.ok(GUIDANCE_TEXT.includes('Similarity ≠ Authority'))
  assert.ok(GUIDANCE_TEXT.replace(/\s+/g, ' ').includes("never raise a record's standing"))
  // 8. No silent merge/overwrite/retire; contradictions stay visible.
  assert.ok(GUIDANCE_TEXT.includes('Do not silently merge, overwrite, or retire memory'))
  assert.ok(GUIDANCE_TEXT.includes('Contradictions stay visible'))
  // 9. Preserved invariants from the original guidance.
  assert.ok(GUIDANCE_TEXT.includes('Observe ≠ Store'))
  assert.ok(GUIDANCE_TEXT.includes('Candidate ≠ Truth'))
  assert.ok(GUIDANCE_TEXT.includes('Memory ≠ Knowledge'))
  assert.ok(GUIDANCE_TEXT.includes('Knowledge without evidence is not authoritative'))
  assert.ok(GUIDANCE_TEXT.includes('veyra_promote (canonical)'))
  assert.ok(GUIDANCE_TEXT.includes('Project isolation is preserved'))
  assert.ok(GUIDANCE_TEXT.includes('does not replace verification'))
  // Static policy text must not contain prompt-variable references.
  assert.ok(!GUIDANCE_TEXT.includes('{{'))
  // 10. Session continuity boundary and trust standing.
  assert.ok(GUIDANCE_TEXT.includes('Session continuity boundary'))
  assert.ok(GUIDANCE_TEXT.includes('DO NOT use Veyra for current turn/session progress'))
  assert.ok(GUIDANCE_TEXT.includes('STALE or INSUFFICIENT_EVIDENCE'))
  assert.ok(GUIDANCE_TEXT.includes('Outcome: test-failed'))
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

  assert.equal(buildRecallContext({
    veyraHome: dir,
    cwd,
    query: 'where does veyra persist memory',
    limit: 0,
  }), '')

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

test('records without source.context omit context from tool output (no null schema violation)', async () => {
  const validate = loadValidateJsonSchemaValue()
  if (!validate) return
  const dir = mkdtempSync(join(tmpdir(), 'veyra-no-context-'))
  const runtime = { veyraHome: dir, fallbackCwd: '/tmp/proj', recallLimit: 5, includeReusable: true }
  const defs = Object.fromEntries(buildToolDefinitions(runtime).map((d) => [d.name, d]))
  const harness = createToolHarness(runtime)
  const exec = { agent: { session: { header: { cwd: '/tmp/proj' } } } }

  // 1. veyra_remember with kind: 'negative' — skips context injection
  const neg = await harness.call('veyra_remember', {
    title: 'Negative kind has no context',
    body: 'This record was written with kind=negative and must not produce context:null.',
    kind: 'negative',
  }, exec)
  assert.equal(neg.ok, true)
  assert.equal(neg.record.context, undefined, 'context must be omitted, not null')
  assert.ok(!('context' in neg.record), 'context key must be absent from output')
  const negViolations = validate(defs.veyra_remember.output.schema, neg)
  assert.deepEqual(negViolations, [])

  // 2. veyra_inspect on the negative record
  const inspected = await harness.call('veyra_inspect', { id: neg.record.id }, exec)
  assert.equal(inspected.ok, true)
  assert.equal(inspected.record.context, undefined)
  assert.ok(!('context' in inspected.record))
  const inspectViolations = validate(defs.veyra_inspect.output.schema, inspected)
  assert.deepEqual(inspectViolations, [])

  // 3. veyra_recall returning the negative record
  const recalled = await harness.call('veyra_recall', { query: 'Negative kind has no context' }, exec)
  assert.equal(recalled.ok, true)
  const negItem = recalled.items.find((i) => i.id === neg.record.id)
  assert.ok(negItem, 'negative record must appear in recall results')
  assert.equal(negItem.context, undefined)
  assert.ok(!('context' in negItem))
  const recallViolations = validate(defs.veyra_recall.output.schema, recalled)
  assert.deepEqual(recallViolations, [])

  // 4. veyra_forget on the negative record
  const forgot = await harness.call('veyra_forget', { id: neg.record.id }, exec)
  assert.equal(forgot.ok, true)
  assert.equal(forgot.record.context, undefined)
  assert.ok(!('context' in forgot.record))
  const forgetViolations = validate(defs.veyra_forget.output.schema, forgot)
  assert.deepEqual(forgetViolations, [])

  // 5. veyra_promote on a fresh negative record
  const neg2 = await harness.call('veyra_remember', {
    title: 'Negative kind promote target',
    body: 'Another negative record for promote schema check.',
    kind: 'negative',
  }, exec)
  assert.equal(neg2.ok, true)
  const promoted = await harness.call('veyra_promote', { id: neg2.record.id, to: 'derived', explicit: true }, exec)
  assert.equal(promoted.ok, true)
  assert.equal(promoted.record.context, undefined)
  assert.ok(!('context' in promoted.record))
  const promoteViolations = validate(defs.veyra_promote.output.schema, promoted)
  assert.deepEqual(promoteViolations, [])

  // 6. veyra_feedback on a fresh negative record
  const neg3 = await harness.call('veyra_remember', {
    title: 'Negative kind feedback target',
    body: 'Another negative record for feedback schema check.',
    kind: 'negative',
  }, exec)
  assert.equal(neg3.ok, true)
  const feedback = await harness.call('veyra_feedback', { id: neg3.record.id, outcome: 'success' }, exec)
  assert.equal(feedback.ok, true)
  assert.equal(feedback.record.context, undefined)
  assert.ok(!('context' in feedback.record))
  const feedbackViolations = validate(defs.veyra_feedback.output.schema, feedback)
  assert.deepEqual(feedbackViolations, [])

  // 7. Normal object context still works (auto-stamped os/runtime + user keys)
  const normal = await harness.call('veyra_remember', {
    title: 'Normal record with context',
    body: 'This record has a normal object context.',
    kind: 'knowledge',
    context: { toolchain: 'node', version: '22' },
  }, exec)
  assert.equal(normal.ok, true)
  assert.equal(normal.record.context.toolchain, 'node')
  assert.equal(normal.record.context.version, '22')
  assert.equal(typeof normal.record.context.os, 'string')
  assert.equal(typeof normal.record.context.runtime, 'string')
  const normalViolations = validate(defs.veyra_remember.output.schema, normal)
  assert.deepEqual(normalViolations, [])

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

  // §23: canonical authority is implicitly protected — a plain forget on it
  // is refused until an explicit override supplies a reason.
  const refused = await harness.call('veyra_forget', { id: remembered.record.id }, exec)
  assert.equal(refused.ok, false)
  assert.match(refused.error, /protected/)
  assertLossless(refused)

  const forgotProject = await harness.call('veyra_forget', {
    id: remembered.record.id,
    override: true,
    reason: 'canonical fixture retired under §23 override',
  }, exec)
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

test('DSH rawInput observatory remainder reaches existing overview and search branches', () => {
  const dir = mkdtempSync(join(tmpdir(), 'veyra-rawinput-'))
  const cwd = join(dir, 'workspace')
  const runtime = { veyraHome: dir, fallbackCwd: cwd, recallLimit: 5, includeReusable: true }
  const invocation = { agent: { session: { header: { cwd } } } }

  const overview = handleVeyraCommand(runtime, { ...invocation, rawInput: 'observatory overview' })
  assert.equal(overview.kind, 'success')
  assert.ok(overview.text.includes('VEYRA KNOWLEDGE OBSERVATORY — OVERVIEW'))
  assert.equal(overview.text.includes('Veyra — Engineering Intelligence for Coding Agents'), false)

  const search = handleVeyraCommand(runtime, { ...invocation, rawInput: 'observatory search sqlite mutex' })
  assert.equal(search.kind, 'success')
  assert.ok(search.text.includes('VEYRA OBSERVATORY — HYBRID SEARCH'))
  assert.equal(search.text.includes('Veyra — Engineering Intelligence for Coding Agents'), false)

  const localMissing = handleVeyraCommand(runtime, { ...invocation, rawInput: 'observatory local' })
  assert.equal(localMissing.kind, 'error')
  assert.ok(localMissing.text.includes('observatory local <id>'))

  closeAllStores()
  rmSync(dir, { recursive: true, force: true })
})

test('/veyra help banner reports the installed package version', () => {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
  const dir = mkdtempSync(join(tmpdir(), 'veyra-version-'))
  const cwd = join(dir, 'workspace')
  const runtime = { veyraHome: dir, fallbackCwd: cwd, recallLimit: 5, includeReusable: true }

  const help = handleVeyraCommand(runtime, {
    rawInput: 'help',
    agent: { session: { header: { cwd } } },
  })
  assert.equal(help.kind, 'success')
  assert.ok(help.text.includes(`Veyra — Engineering Intelligence for Coding Agents (v${pkg.version})`))

  closeAllStores()
  rmSync(dir, { recursive: true, force: true })
})
