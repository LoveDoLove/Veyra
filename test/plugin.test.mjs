import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply, name, DEFAULT_CONFIG } from '../src/plugin.mjs'
import * as pluginExports from '../src/plugin.mjs'
import { createToolHarness } from '../src/tools.mjs'
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
