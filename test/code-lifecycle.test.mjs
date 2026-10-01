import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply } from '../src/plugin.mjs'
import { closeAllStores } from '../src/store.mjs'

function mockCordisContext() {
  const tools = []
  const commands = []
  const sections = []
  const contexts = []
  const handlers = new Map()
  const effects = []

  const ctx = {
    tools: {
      register: (tool) => tools.push(tool),
    },
    commands: {
      register: (cmd) => commands.push(cmd),
    },
    systemPrompt: {
      section: (s) => sections.push(s),
      context: (c) => contexts.push(c),
    },
    on: (event, handler) => {
      if (!handlers.has(event)) handlers.set(event, [])
      handlers.get(event).push(handler)
      return () => {
        const arr = handlers.get(event) || []
        const idx = arr.indexOf(handler)
        if (idx >= 0) arr.splice(idx, 1)
      }
    },
    effect: (fn) => {
      const cleanup = fn()
      if (typeof cleanup === 'function') effects.push(cleanup)
      return cleanup
    },
    logger: {
      info: () => {},
      warn: () => {},
      debug: () => {},
      error: () => {},
    },
  }

  return { ctx, tools, commands, sections, contexts, handlers, effects }
}

test('plugin lifecycle initializes code engine, registers tools, and disposes cleanly', async () => {
  const tmpHome = mkdtempSync(join(tmpdir(), 'veyra-life-home-'))
  const tmpRepo = mkdtempSync(join(tmpdir(), 'veyra-life-repo-'))

  try {
    writeFileSync(join(tmpRepo, 'index.js'), 'console.log("hello");\n')
    const { ctx, tools, commands, sections, effects } = mockCordisContext()

    const teardown = apply(ctx, {
      home: tmpHome,
      codebaseMemoryBin: '/nonexistent/codebase-memory-mcp',
      codebaseWatch: true,
    })

    await new Promise((r) => setTimeout(r, 20))

    const toolNames = tools.map((t) => t.name)
    assert.ok(toolNames.includes('cbm_projects'), 'registered cbm_projects')
    assert.ok(toolNames.includes('cbm_search'), 'registered cbm_search')
    assert.ok(toolNames.includes('cbm_snippet'), 'registered cbm_snippet')
    assert.ok(toolNames.includes('cbm_trace'), 'registered cbm_trace')
    assert.ok(toolNames.includes('cbm_arch'), 'registered cbm_arch')
    assert.ok(toolNames.includes('cbm_search_code'), 'registered cbm_search_code')
    assert.ok(toolNames.includes('veyra_code_status'), 'registered veyra_code_status')

    assert.ok(sections.some((s) => s.name === 'veyra:guidance' && s.text.includes('Codebase Memory')))
    assert.ok(commands.some((c) => c.name === 'veyra'))

    // Clean teardown
    if (typeof teardown === 'function') teardown()
    for (const eff of effects) {
      if (typeof eff === 'function') eff()
    }
  } finally {
    closeAllStores()
    rmSync(tmpHome, { recursive: true, force: true })
    rmSync(tmpRepo, { recursive: true, force: true })
  }
})
