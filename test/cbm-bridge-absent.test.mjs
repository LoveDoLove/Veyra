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

test('guidance omits the Code Intelligence block when the engine is degraded', async (t) => {
  const { apply } = await import('../src/plugin.mjs')
  const { GUIDANCE_TEXT } = await import('../src/context.mjs')
  const { testHome } = await import('./helpers/room.mjs')
  const sections = []
  const ctx = {
    tools: { register: () => {} },
    commands: { register: () => {} },
    skills: { register: () => {}, registerProvider: () => () => {} },
    systemPrompt: { section: (s) => sections.push(s), context: () => {} },
    on: () => () => {},
    effect: (factory) => factory(),
    logger: { info: () => {}, warn: () => {}, debug: () => {}, error: () => {} },
  }
  // A missing binary makes the engine degraded for certain, exactly as in the
  // apply() test above: an unset codebaseMemoryBin would discover the installed
  // binary on PATH and leave the guidance legitimately enabled.
  const dispose = apply(ctx, {
    home: testHome(t),
    observe: true,
    codebaseMemoryBin: '/nonexistent/cbm-binary-for-test',
  })

  const guidance = sections.filter((s) => s.name === 'veyra:guidance')
  assert.equal(guidance.length, 1)
  // With Code Intelligence unusable, the section is exactly the degraded text:
  // no extra newline, no partial block, nothing the model could misread as a
  // usable cbm_* tool surface.
  assert.equal(guidance[0].text, GUIDANCE_TEXT)
  assert.ok(!guidance[0].text.includes('Codebase Memory Policy'))
  assert.ok(!guidance[0].text.includes('cbm_trace'))

  dispose?.()
})

// The mirror of the test above, and the reason the feature exists: when Code
// Intelligence CAN answer, the model must be told the tool surface exists.
// Without this, every remaining assertion is negative (block absent) and the
// true-branch of `cbm.available && isDegraded !== true` could regress to
// always-absent with the whole suite still green.
test('guidance appends the Code Intelligence block when the engine is available', async (t) => {
  const { mkdtempSync, writeFileSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const { apply } = await import('../src/plugin.mjs')
  const { CODE_INTELLIGENCE_GUIDANCE, GUIDANCE_TEXT } = await import('../src/context.mjs')
  const { testHome } = await import('./helpers/room.mjs')
  const sections = []
  const ctx = {
    tools: { register: () => {} },
    commands: { register: () => {} },
    skills: { register: () => {}, registerProvider: () => () => {} },
    systemPrompt: { section: (s) => sections.push(s), context: () => {} },
    on: () => () => {},
    effect: (factory) => factory(),
    logger: { info: () => {}, warn: () => {}, debug: () => {}, error: () => {} },
  }
  // Availability is decided by `Boolean(exePath && existsSync(exePath))`, so any
  // EXISTING file counts as available and no real binary is needed. The file is
  // never executed: apply() does not await the daemon and a failed spawn is only
  // logged. `observe: false` keeps it that way — with observation on, the plugin
  // tries to start the fake binary and logs a spawn EACCES the test does not
  // need, while the guidance question is already settled at apply() time.
  const bin = join(mkdtempSync(join(tmpdir(), 'veyra-fake-cbm-')), 'fake-mcp')
  writeFileSync(bin, '')
  const dispose = apply(ctx, { home: testHome(t), observe: false, codebaseMemoryBin: bin })

  const guidance = sections.filter((s) => s.name === 'veyra:guidance')
  assert.equal(guidance.length, 1)
  assert.ok(guidance[0].text.includes('Codebase Memory Policy'), 'the block must be advertised when CI can answer')
  assert.ok(guidance[0].text.includes('cbm_trace'), 'the block must name a real tool')
  // Composition, not exact equality: `startsWith` + `includes` proves the block
  // is appended to the intact base policy without freezing both strings
  // verbatim, so a future wording edit does not turn this into a maintenance
  // tax.
  assert.ok(guidance[0].text.startsWith(GUIDANCE_TEXT), 'the base agent policy must come first and stay intact')
  assert.ok(guidance[0].text.endsWith(CODE_INTELLIGENCE_GUIDANCE), 'the block is appended last')

  dispose?.()
})

// The skill lives on both sides of this decoupling: Veyra bundled its own copy
// while CBM's plugin ships the same skill name, so two providers claimed it. The
// deletion is what removes the collision, and nothing else in the suite pins the
// absence — a future re-add would silently reintroduce the duplicate.
test('Veyra no longer bundles a codebase-memory skill', async () => {
  const { BUNDLED_SKILL_DEFINITIONS } = await import('../src/skills.mjs')
  assert.equal(BUNDLED_SKILL_DEFINITIONS.some((s) => s.name === 'codebase-memory'), false)
  assert.equal(BUNDLED_SKILL_DEFINITIONS.length, 4)
})
