import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

// The absent-bridge behaviour itself is unit-tested in
// test/cbm-bridge.test.mjs via resolveRepoPath's injectable namespace. What
// these tests pin is that the three call sites actually route through it,
// because a direct `resolveSafeRepoPath` import would silently restore the
// hard dependency the whole change exists to remove.
test('the capture and trust path resolve anchors through the bridge', () => {
  for (const file of ['../src/understand.mjs', '../src/trust.mjs', '../src/code/linking.mjs']) {
    const src = readFileSync(new URL(file, import.meta.url), 'utf8')
    assert.ok(!src.includes('resolveSafeRepoPath'),
      `${file} must not call resolveSafeRepoPath directly`)
    assert.ok(src.includes('resolveRepoPath') || src.includes('repoRelativeAnchor'),
      `${file} must resolve paths through the bridge`)
  }
})

test('createCodeAnchor still refuses an out-of-repo path', async () => {
  const { createCodeAnchor } = await import('../src/code/linking.mjs')
  assert.throws(
    () => createCodeAnchor({ repoRoot: '/tmp/repo-a', path: '/tmp/outside/b.mjs' }),
    /escapes repository boundary/,
  )
})

test('exactly one file under src/ names the codebase memory package', async () => {
  const { readdirSync, readFileSync } = await import('node:fs')
  const { join } = await import('node:path')
  const root = new URL('../src/', import.meta.url).pathname
  const offenders = []
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) { walk(full); continue }
      if (!entry.name.endsWith('.mjs')) continue
      if (readFileSync(full, 'utf8').includes('@lovedolove/dsh-codebase-memory-mcp')) {
        offenders.push(full.slice(root.length))
      }
    }
  }
  walk(root)
  assert.deepEqual(offenders, ['cbm-bridge.mjs'])
})

test('plugin apply completes and registers tools with a degraded engine', async (t) => {
  // test/helpers/ holds only dsh.mjs, eval-output.mjs, room.mjs — there is no
  // shared plugin mock. plugin.test.mjs, loop.test.mjs and the three
  // turn-stopping tests each redefine mockCtx() locally; this file follows the
  // same convention with only the members apply() touches.
  const { apply } = await import('../src/plugin.mjs')
  const { cbm, createDegradedEngine } = await import('../src/cbm-bridge.mjs')
  const { testHome } = await import('./helpers/room.mjs')
  const tools = []
  const sections = []
  const contexts = []
  const ctx = {
    tools: { register: (def) => tools.push(def) },
    commands: { register: () => {} },
    skills: { register: () => {}, registerProvider: () => () => {} },
    systemPrompt: { section: (s) => sections.push(s), context: (c) => contexts.push(c) },
    on: () => () => {},
    effect: (factory) => factory(),
    logger: { info: () => {}, warn: () => {}, debug: () => {}, error: () => {} },
  }
  // A missing binary is what makes the engine degraded for certain
  // (`isDegraded === true`, `client.isAvailable === false`); leaving
  // `codebaseMemoryBin` unset does NOT, because the real engine falls back to
  // discovering an installed binary on PATH. Assert that premise rather than
  // assuming it, so this test keeps its meaning once the bridge stops loading
  // and createDegradedEngine() supplies the engine instead.
  const noopLog = { info: () => {}, warn: () => {}, debug: () => {}, error: () => {} }
  const premise = typeof cbm.CodeIntelligenceEngine === 'function'
    ? new cbm.CodeIntelligenceEngine({ exePath: '/nonexistent/cbm-binary-for-test', log: noopLog })
    : createDegradedEngine()
  assert.equal(premise.isDegraded, true, 'a missing binary must leave the engine degraded')
  premise.dispose?.()

  const dispose = apply(ctx, {
    home: testHome(t),
    observe: true,
    codebaseMemoryBin: '/nonexistent/cbm-binary-for-test',
  })
  // Tools register asynchronously: registerTools() awaits a dynamic
  // `import('@deepseek-ai/dsh-tools')` before the first ctx.tools.register call.
  await new Promise((r) => setTimeout(r, 50))

  assert.ok(tools.some((d) => d.name === 'veyra_recall'), 'veyra_recall must register')
  assert.ok(tools.some((d) => d.name === 'veyra_code_status'), 'veyra_code_status must register')
  for (const def of tools) {
    assert.equal(typeof def.execute, 'function', `${def.name} must carry an execute`)
  }

  // The six cbm_* tools belong to the Codebase Memory plugin, which registers
  // them itself. Veyra must register none of them: a cbm_* name here would be
  // a duplicate registration on any host that also installs that plugin.
  assert.deepEqual(tools.filter((d) => d.name.startsWith('cbm_')).map((d) => d.name), [],
    'Veyra must not register any cbm_* tool')

  dispose?.()
})
