import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

// The absent-bridge behaviour itself is unit-tested in
// test/cbm-bridge.test.mjs via resolveRepoPath's injectable namespace. What
// these tests pin is that the three call sites actually route through it,
// because a direct `@lovedolove/dsh-codebase-memory-mcp` import would silently
// restore the hard dependency the whole change exists to remove.
//
// This asserts the import edges, not the absence of an identifier: the old
// `!src.includes('resolveSafeRepoPath')` check looked like a guard but only
// forbade one spelling, so `const { resolveSafeRepoPath } = await import(...)`
// or an alias would have passed it while reintroducing the dependency.
test('the capture and trust path resolve anchors through the bridge', () => {
  for (const file of ['../src/understand.mjs', '../src/trust.mjs', '../src/code/linking.mjs']) {
    const src = readFileSync(new URL(file, import.meta.url), 'utf8')
    for (const line of src.split('\n')) {
      assert.ok(!/from\s+['"]@lovedolove\/dsh-codebase-memory-mcp/.test(line),
        `${file} must not import the codebase memory package directly: ${line.trim()}`)
    }
    // `../cbm-bridge.mjs` for src/code/linking.mjs, `./cbm-bridge.mjs` elsewhere.
    assert.ok(/from\s+['"]\.\.?\/cbm-bridge\.mjs['"]/.test(src),
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
  const { fileURLToPath } = await import('node:url')
  // `fileURLToPath`, not `URL.pathname`: on Windows the pathname keeps a
  // leading slash and percent-encodes spaces, so `full.slice(root.length)`
  // would compare mangled prefixes and quietly report no offenders at all.
  const root = fileURLToPath(new URL('../src/', import.meta.url))
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

test('guidance reports Code Intelligence as unavailable when the engine is degraded', async (t) => {
  const { apply } = await import('../src/plugin.mjs')
  const { CODE_INTELLIGENCE_UNAVAILABLE_GUIDANCE, GUIDANCE_TEXT } = await import('../src/context.mjs')
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
  // With Code Intelligence unusable, the section is the base policy plus one
  // explicit line saying so (design spec §6). Silence used to be the choice
  // here, but a silent section reads as "nothing to say about code": the model
  // then has no instruction to fall back to its own file tools.
  assert.equal(
    guidance[0].text,
    `${GUIDANCE_TEXT}\n\n${CODE_INTELLIGENCE_UNAVAILABLE_GUIDANCE}`,
  )
  // The unavailable line must not advertise the tool surface that is missing.
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

// Anti-fabrication. When Code Intelligence cannot resolve a path, the anchor is
// NOT "outside the repository" — nobody knows. Reporting INVALID with the
// out-of-repo reason invented a repository fact the bridge never established,
// and that fabrication propagated into trust (stale), the recall banner (CODE
// EVIDENCE INVALID), and retrieval (a 0.35 penalty plus a "memory references
// code that no longer exists" contradiction). The bridge is bound at module
// evaluation, so the only way to exercise a genuinely unavailable namespace is
// to import a copy of src/ that sits outside any node_modules tree: every bare
// specifier under src/ is either node:* or the dynamic @deepseek-ai/dsh-tools
// import in tools.mjs, which this path never reaches.
test('an unavailable bridge reports unverifiable evidence, never a fabricated reason', async (t) => {
  const { cpSync, mkdtempSync, rmSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const { fileURLToPath } = await import('node:url')
  const root = mkdtempSync(join(tmpdir(), 'veyra-absent-bridge-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const srcCopy = join(root, 'src')
  cpSync(fileURLToPath(new URL('../src/', import.meta.url)), srcCopy, { recursive: true })

  const bridge = await import(join(srcCopy, 'cbm-bridge.mjs'))
  assert.equal(bridge.cbm.available, false, 'the copy must degrade for real')

  const { checkAnchorFreshness, checkRecordFreshness } = await import(join(srcCopy, 'code/linking.mjs'))
  const anchor = { path: 'src/anything.mjs', symbol: 'anything' }
  const fresh = checkAnchorFreshness(anchor, root)
  assert.equal(fresh.status, 'invalid')
  assert.equal(fresh.unverifiable, true, 'an unresolved path must be flagged unverifiable')
  assert.match(fresh.reason, /code intelligence is unavailable/i)
  assert.doesNotMatch(fresh.reason, /outside repository or invalid/i,
    'the out-of-repo reason is a fabricated repository fact when the bridge cannot resolve')

  const record = { title: 'anchored memory', evidence: [{ path: anchor.path, symbol: anchor.symbol }] }
  const freshness = checkRecordFreshness(record, root)
  assert.equal(freshness.unverifiable, true, 'the record-level verdict must carry the flag')
  assert.equal(freshness.anchors.length, 1)

  const { classifyRecordTrust, TRUST_CATEGORIES } = await import(join(srcCopy, 'trust.mjs'))
  const trust = classifyRecordTrust(record, { workspace: root, freshness })
  assert.equal(trust.category, TRUST_CATEGORIES.INSUFFICIENT_EVIDENCE,
    'unverifiable is not stale — there is no evidence the code changed')
  assert.ok(!trust.reasons.some((r) => /code evidence (invalid|stale)/.test(r)),
    'no fabricated invalid/stale claim may reach the reasons')
  assert.ok(trust.evidence.some((e) => e.includes('unverifiable')))
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

// §13's whole point is the operator actually seeing the warning, so pin the
// call site and not just the classifier: one warn per apply() for a broken
// install, silence for a plain absence. `loadCbmBridge` is the injectable seam
// (`cbmLoadFailure` is a live binding), and the real load at the end restores
// the module to the state every later test in this process expects.
test('apply warns once for a broken install and stays quiet for an absent package', async (t) => {
  const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const { apply } = await import('../src/plugin.mjs')
  const { loadCbmBridge } = await import('../src/cbm-bridge.mjs')
  const { testHome } = await import('./helpers/room.mjs')

  const runApply = (home) => {
    const warns = []
    const ctx = {
      tools: { register: () => {} },
      commands: { register: () => {} },
      skills: { register: () => {}, registerProvider: () => () => {} },
      systemPrompt: { section: () => {}, context: () => {} },
      on: () => () => {},
      effect: (factory) => factory(),
      logger: { info: () => {}, warn: (msg) => warns.push(String(msg)), debug: () => {}, error: () => {} },
    }
    const dispose = apply(ctx, { home, observe: false, codebaseMemoryBin: '/nonexistent/cbm-binary-for-test' })
    return { warns: warns.filter((w) => w.includes('Codebase Memory failed to load')), dispose }
  }

  const broken = mkdtempSync(join(tmpdir(), 'veyra-warn-broken-'))
  const absent = mkdtempSync(join(tmpdir(), 'veyra-warn-absent-'))
  try {
    // An installed package whose `main` is missing: the broken install §13 is
    // about. Node reports it as MODULE_NOT_FOUND, same as a missing package.
    const pkg = join(broken, 'node_modules', '@lovedolove', 'dsh-codebase-memory-mcp')
    mkdirSync(pkg, { recursive: true })
    writeFileSync(join(pkg, 'package.json'), JSON.stringify({
      name: '@lovedolove/dsh-codebase-memory-mcp', version: '9.9.9', main: 'index.cjs',
    }))
    writeFileSync(join(broken, 'entry.mjs'), '')
    writeFileSync(join(absent, 'entry.mjs'), '')

    loadCbmBridge({ requireFrom: join(broken, 'entry.mjs') })
    const brokenRun = runApply(testHome(t))
    brokenRun.dispose?.()
    assert.equal(brokenRun.warns.length, 1, 'a broken install must warn exactly once per apply')
    assert.match(brokenRun.warns[0], /failed to load/)

    loadCbmBridge({ requireFrom: join(absent, 'entry.mjs') })
    const absentRun = runApply(testHome(t))
    absentRun.dispose?.()
    assert.deepEqual(absentRun.warns, [], 'an absent optional peer is a supported configuration, not news')
  } finally {
    loadCbmBridge() // restore the real namespace for the rest of this process
    rmSync(broken, { recursive: true, force: true })
    rmSync(absent, { recursive: true, force: true })
  }
})
