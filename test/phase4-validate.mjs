/**
 * Phase 4 — Real Coding-Agent Validation (standalone, repeatable).
 *
 * Run:  node test/phase4-validate.mjs        (exit 0 = PHASE 4 PASS)
 * Not matched by `npm test` (test/*.test.mjs), per the helpers/dsh.mjs
 * convention for non-test modules.
 *
 * Validates the real pipeline end to end against the CURRENT Veyra
 * repository and the REAL DSH host services (cordis Context + SystemPrompt +
 * ToolRuntime — the same composition test/dsh-runtime.test.mjs uses):
 *
 *   Repository Change → RepositoryWatcher → Change Signal →
 *   Trust Classification → Ambient Agent Context (agent-visible snapshot)
 *
 * Scenarios (GOAL.md Phase 4):
 *   A — Relevant change      (src/context.mjs edited → affected knowledge flagged)
 *   B — Unrelated change     (src/diff.mjs edited → no false downgrade)
 *   C — Assumption-breaking  (the exact implementation value a knowledge record
 *                             asserts is changed → agent sees STALE + revalidate)
 *   D — Degraded Code Intelligence (cbm binary unavailable → reduced evidence,
 *                             never fabricated symbol/call-graph evidence)
 *   E — Canonical safety     (store snapshots before/after every scenario)
 *
 * The harness edits REAL repository files and always restores them byte-exact
 * (try/finally + startup backups + final verification).
 */

import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { findDshRoot, loadDshPackage, resolveDshPackage } from './helpers/dsh.mjs'
import * as veyra from '../src/plugin.mjs'
import { buildToolDefinitions, createToolHarness } from '../src/tools.mjs'
import { closeAllStores, openProjectStore } from '../src/store.mjs'
import { newRecordId, projectIdFor, sha256Hex } from '../src/ids.mjs'
import { AUTHORITIES, KINDS, STATUSES, VALIDATIONS } from '../src/types.mjs'
import { getOrCreateCodeClient, resetSharedCodeClient } from '../src/code/client.mjs'

// ─── constants ──────────────────────────────────────────────────────────────

const REPO = process.cwd()
const FOREIGN_REPO = '/some/foreign/phase4-repo'
const EDIT_FILES = ['src/context.mjs', 'src/trust.mjs', 'src/text.mjs', 'src/diff.mjs']
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const checks = []
function check(scenario, name, ok, detail = '') {
  checks.push({ scenario, name, ok, detail })
  console.log(`  ${ok ? '✔' : '✖'} ${scenario}: ${name}${ok || !detail ? '' : `\n      ${detail}`}`)
  return ok
}

// ─── repo edit helpers (always byte-exact restore) ──────────────────────────

const backups = new Map(EDIT_FILES.map((f) => [f, readFileSync(join(REPO, f), 'utf8')]))
const touched = new Set()

function editAppend(file, comment) {
  const current = readFileSync(join(REPO, file), 'utf8')
  writeFileSync(join(REPO, file), current + comment)
  touched.add(file)
}
function editReplace(file, needle, replacement) {
  const current = readFileSync(join(REPO, file), 'utf8')
  assert.ok(current.includes(needle), `edit anchor missing in ${file}`)
  writeFileSync(join(REPO, file), current.replace(needle, replacement))
  touched.add(file)
}
function restore(file) {
  writeFileSync(join(REPO, file), backups.get(file))
  touched.delete(file)
}
function restoreAll() {
  for (const file of [...touched]) restore(file)
}

// ─── store seeding + snapshots ──────────────────────────────────────────────

function seedRecord(home, repo, overrides) {
  const store = openProjectStore(home, projectIdFor(repo))
  const rec = {
    id: newRecordId(),
    kind: KINDS.KNOWLEDGE,
    status: STATUSES.CURRENT,
    validation: VALIDATIONS.VERIFIED,
    authority: AUTHORITIES.DERIVED,
    confidence: 'high',
    scope: 'project',
    title: 'Knowledge',
    body: 'body',
    evidence: [],
    source: { signal: 'phase4-validation' },
    ...overrides,
  }
  const written = store.put(rec)
  assert.equal(written.created, true, `seed failed: ${written.reason || ''}`)
  return written.record
}

function snapshot(home, repo) {
  const store = openProjectStore(home, projectIdFor(repo))
  return JSON.stringify(
    store.list({ limit: 500 }).map(({ lastRecalledAt, last_recalled_at, ...rest }) => rest),
  )
}

// ─── real DSH composition (same mechanism as test/dsh-runtime.test.mjs) ─────

async function until(probe, ms = 8000) {
  const start = Date.now()
  while (Date.now() - start < ms) {
    if (await probe()) return true
    await sleep(50)
  }
  return false
}

async function loadServices() {
  const names = [
    '@deepseek-ai/cordis',
    '@deepseek-ai/dsh-system-prompt',
    '@deepseek-ai/dsh-tools',
    '@deepseek-ai/dsh-commands',
    '@deepseek-ai/dsh-settings',
    '@deepseek-ai/dsh-skill',
  ]
  const loaded = {}
  for (const name of names) {
    assert.ok(resolveDshPackage(name), `DSH install does not provide ${name}`)
    loaded[name] = await loadDshPackage(name)
    assert.ok(loaded[name], `${name} could not be imported`)
  }
  return loaded
}

async function compose(svc, config, tmpProfile) {
  const { Context } = svc['@deepseek-ai/cordis']
  const { SystemPrompt } = svc['@deepseek-ai/dsh-system-prompt']
  const { ToolRuntime } = svc['@deepseek-ai/dsh-tools']
  const { CommandRuntime } = svc['@deepseek-ai/dsh-commands']
  const { SettingsForms } = svc['@deepseek-ai/dsh-settings']
  const { SkillRegistry } = svc['@deepseek-ai/dsh-skill']

  const ctx = new Context()
  ctx.provide('profileContext', { home: tmpProfile, dir: tmpProfile, name: 'phase4' })
  ctx.provide('configEditor', {
    documentPath: join(tmpProfile, 'settings.patch.json'),
    configuration: () => [],
    entries: () => [],
    edit: async () => {},
  })
  ctx.provide('loader', { await: () => Promise.resolve() })

  ctx.plugin(SystemPrompt)
  ctx.plugin(SkillRegistry)
  ctx.plugin(CommandRuntime)
  ctx.plugin(ToolRuntime)
  ctx.plugin(SettingsForms)
  const fiber = ctx.plugin(veyra, config)

  const expected = buildToolDefinitions({ veyraHome: config.home, fallbackCwd: REPO }).map((d) => d.name)
  const up = await until(() => {
    const visible = ctx.tools?.view()?.visible
    return Boolean(visible) && expected.every((n) => visible.has(n))
  })
  assert.ok(up, 'Veyra registrations did not come up on real host services')
  return { ctx, fiber }
}

/** One real model-step assembly: returns the agent-visible veyra:recall text. */
const captures = { leakFree: 0, total: 0 }
async function agentContext(ctx, label) {
  const assembly = await ctx.systemPrompt.assemble({
    agent: { session: { header: { cwd: REPO } } },
  })
  const entry = assembly.contexts.find((c) => c.name === 'veyra:recall')
  const text = entry?.text ?? ''
  const snapshotText = renderSnapshot(svc, assembly)
  captures.total += 1
  if (text && !text.includes('Phase4 FOREIGN')) captures.leakFree += 1
  return { text, snapshot: snapshotText, label }
}

let svc = null
function renderSnapshot(s, assembly) {
  try {
    return s['@deepseek-ai/dsh-system-prompt'].renderContextSnapshot(assembly)
  } catch {
    return assembly.contexts.map((c) => c.text).join('\n\n')
  }
}

async function waitContext(ctx, probe, what, ms = 12000) {
  const start = Date.now()
  let last = null
  while (Date.now() - start < ms) {
    last = await agentContext(ctx, what)
    if (probe(last.text)) return last
    await sleep(250)
  }
  return last
}

/** The rendered block belonging to one recalled record (keyed by record id). */
function blockFor(text, id) {
  const lines = text.split('\n')
  const start = lines.findIndex((l) => l.startsWith(`- [${id}]`))
  assert.notEqual(start, -1, `record ${id} not found in context:\n${text.slice(0, 2000)}`)
  let end = lines.length
  for (let i = start + 1; i < lines.length; i++) {
    if (lines[i].startsWith('- [')) { end = i; break }
  }
  return lines.slice(start, end).join('\n')
}

/** Exact-line match: seeded record bodies QUOTE this string, so a plain
 *  includes() would false-positive. The change block always renders it as
 *  its own line. */
const hasChangeBlock = (t) => /^Repository changes detected:$/m.test(t)

function excerpt(text) {
  return text
    .split('\n')
    .filter((l) =>
      l.startsWith('Repository changes detected:') ||
      l.startsWith('Knowledge impact:') ||
      l.startsWith('- src/') ||
      /^- \d+ /.test(l) ||
      l.startsWith('- [vey_') ||
      l.includes('trust:'),
    )
    .join('\n')
}

// ─── main ───────────────────────────────────────────────────────────────────

async function main() {
  const dshRoot = findDshRoot()
  assert.ok(dshRoot, 'no DSH install discoverable — Phase 4 needs the real coding-agent integration')
  console.log(`Phase 4 validation — repo: ${REPO}`)
  console.log(`DSH install: ${dshRoot.dir} (v${dshRoot.version})\n`)

  svc = await loadServices()

  const homeMain = mkdtempSync(join(tmpdir(), 'veyra-phase4-main-'))
  const homeDeg = mkdtempSync(join(tmpdir(), 'veyra-phase4-degraded-'))
  const profile = mkdtempSync(join(tmpdir(), 'veyra-phase4-profile-'))
  const tmp = mkdtempSync(join(tmpdir(), 'veyra-phase4-bin-'))
  const cleanup = () => {
    for (const dir of [homeMain, homeDeg, profile, tmp]) rmSync(dir, { recursive: true, force: true })
  }

  // ── seed known Veyra knowledge (real repo paths, real content hashes) ──
  const K1 = seedRecord(homeMain, REPO, {
    title: 'Phase4: renderAgentContext ordering',
    body: 'renderAgentContext emits the trust line right after the freshness lines inside each record block.',
    evidence: [{ path: 'src/context.mjs', content_hash: sha256Hex(backups.get('src/context.mjs')) }],
  })
  const K2 = seedRecord(homeMain, REPO, {
    title: 'Phase4: change summary block format',
    body: 'The ambient change summary starts with "Repository changes detected:".',
    evidence: [{ path: 'src/context.mjs' }],
  })
  const K3 = seedRecord(homeMain, REPO, {
    title: 'Phase4: text utility helper assumption',
    body: 'Text helpers in src/text.mjs operate on plain strings.',
    evidence: [{ path: 'src/text.mjs', content_hash: sha256Hex(backups.get('src/text.mjs')) }],
  })
  const K4 = seedRecord(homeMain, REPO, {
    title: 'Phase4: trusted action wording assumption',
    body: "TRUST_ACTIONS.trusted action text is 'use as context; still verify against the repository' — recorded from src/trust.mjs.",
    evidence: [{ path: 'src/trust.mjs', content_hash: sha256Hex(backups.get('src/trust.mjs')) }],
  })
  const FOREIGN = seedRecord(homeMain, FOREIGN_REPO, {
    title: 'Phase4 FOREIGN project record — must never leak',
    body: 'foreign project knowledge',
  })
  const snapMain0 = snapshot(homeMain, REPO)
  const snapForeign0 = snapshot(homeMain, FOREIGN_REPO)


  // ── main composition (real host services, this repo) ──
  const mainRuntimeCfg = {
    home: homeMain,
    recallLimit: 10,
    includeReusable: false,
    eagerStartCodebaseMemory: false,
  }
  const { ctx, fiber } = await compose(svc, mainRuntimeCfg, join(profile, 'main'))
  const harness = createToolHarness({ veyraHome: homeMain, fallbackCwd: REPO })

  try {
    // ═══ Scenario A — Relevant change ═══
    console.log('\n── Scenario A — Relevant change (src/context.mjs) ──')
    const baseline = await agentContext(ctx, 'A-baseline')
    check('A', 'baseline: no change block before any change', !hasChangeBlock(baseline.text))
    check('A', 'baseline: all four records recalled', [K1, K2, K3, K4].every((k) => baseline.text.includes(`- [${k.id}]`)))
    check('A', 'baseline: no warnings (all trusted)', !baseline.text.includes('⚠️ trust:'))
    console.log('  baseline excerpt:\n' + excerpt(baseline.text).split('\n').map((l) => `      ${l}`).join('\n'))

    editAppend('src/context.mjs', '\n// Phase 4 validation — scenario A controlled change (restored byte-exact)\n')
    console.log('  CHANGE APPLIED: src/context.mjs (+1 comment line)')
    const after = await waitContext(ctx, (t) => hasChangeBlock(t) && t.includes('- src/context.mjs'), 'A-after-change')
    check('A', 'change signal reaches ambient context', hasChangeBlock(after.text) && after.text.includes('- src/context.mjs'))
    const k1b = blockFor(after.text, K1.id)
    check('A', 'affected knowledge (hash anchor) → STALE', k1b.includes('⚠️ trust: STALE'), k1b)
    check('A', 'stale reason understandable (content hash changed)', k1b.includes('Content hash changed'), k1b)
    const k2b = blockFor(after.text, K2.id)
    check('A', 'affected knowledge (path anchor) → REVIEW_REQUIRED', k2b.includes('⚠️ trust: REVIEW_REQUIRED') && k2b.includes('related repository file changed: src/context.mjs'), k2b)
    check('A', 'impact tally correct (1 stale, 1 review required, 2 trusted)',
      after.text.includes('- 1 stale') && after.text.includes('- 1 review required') && after.text.includes('- 2 trusted'))
    console.log('  agent-visible context after change:\n' + excerpt(after.text).split('\n').map((l) => `      ${l}`).join('\n'))

    const impact = await harness.call('veyra_change_impact', { changedFiles: ['src/context.mjs'], repo: REPO }, { agent: { session: { header: { cwd: REPO } } } })
    const affectedIds = (impact.affectedMemories || []).map((m) => m.memoryId)
    check('A', 'veyra_change_impact identifies affected knowledge', impact.ok && affectedIds.includes(K1.id) && affectedIds.includes(K2.id), JSON.stringify(affectedIds))
    check('A', 'unrelated knowledge NOT reported affected', !affectedIds.includes(K3.id) && !affectedIds.includes(K4.id))
    const ctxK1 = (impact.context || []).find((c) => c.memoryId === K1.id)
    check('A', 'change impact classification: stale', ctxK1?.category === 'stale', JSON.stringify(ctxK1))
    check('A', 'change impact reports degraded=false', impact.degraded === false)

    restore('src/context.mjs')
    console.log('  RESTORED: src/context.mjs')
    // Let the watcher flush the restore as its own batch (debounceMs=500),
    // otherwise the next scenario's edit batches with this restore event and
    // the signal legitimately lists both files.
    await sleep(1500)
    const snapA = snapshot(homeMain, REPO)
    check('E/A', 'canonical store unchanged across scenario A', snapA === snapMain0,
      `sha ${sha256Hex(snapA).slice(0, 12)} vs ${sha256Hex(snapMain0).slice(0, 12)}`)

    // ═══ Scenario B — Unrelated change ═══
    console.log('\n── Scenario B — Unrelated change (src/diff.mjs) ──')
    editAppend('src/diff.mjs', '\n// Phase 4 validation — scenario B controlled change (restored byte-exact)\n')
    console.log('  CHANGE APPLIED: src/diff.mjs (+1 comment line)')
    const b = await waitContext(ctx, (t) => hasChangeBlock(t) && t.includes('- src/diff.mjs'), 'B-after-change')
    check('B', 'unrelated change signal reaches ambient context', hasChangeBlock(b.text) && b.text.includes('- src/diff.mjs'))
    check('B', 'previous change signal superseded (no stale context accumulation)', !b.text.includes('- src/context.mjs'))
    check('B', 'unrelated knowledge (K3) stays trusted', blockFor(b.text, K3.id).includes('trust: TRUSTED') && !blockFor(b.text, K3.id).includes('⚠️'))
    check('B', 'restored knowledge (K1) trusted again (read-time projection)', blockFor(b.text, K1.id).includes('trust: TRUSTED') && !blockFor(b.text, K1.id).includes('⚠️'))
    check('B', 'no false warnings anywhere', !b.text.includes('⚠️ trust:'))
    check('B', 'no false impact (tally is trusted-only)', b.text.includes('- 4 trusted') && !b.text.includes('stale') && !b.text.includes('review required'))
    console.log('  agent-visible context after unrelated change:\n' + excerpt(b.text).split('\n').map((l) => `      ${l}`).join('\n'))
    restore('src/diff.mjs')
    console.log('  RESTORED: src/diff.mjs')
    await sleep(1500) // same flush-settle as scenario A

    // ═══ Scenario C — Assumption-breaking change ═══
    console.log('\n── Scenario C — Assumption-breaking change (src/trust.mjs) ──')
    editReplace(
      'src/trust.mjs',
      "trusted: 'use as context; still verify against the repository',",
      "trusted: 'phase4: verify this action against the repository before use',",
    )
    console.log("  CHANGE APPLIED: src/trust.mjs — TRUST_ACTIONS.trusted rewritten ('use as context; still verify against the repository' → 'phase4: verify …')")
    check('C', 'assumption actually broken in repository', (() => {
      const now = readFileSync(join(REPO, 'src/trust.mjs'), 'utf8')
      return now.includes('phase4: verify this action against the repository before use') && !now.includes('use as context; still verify against the repository')
    })())
    const c = await waitContext(ctx, (t) => hasChangeBlock(t) && t.includes('- src/trust.mjs'), 'C-after-change')
    const k4b = blockFor(c.text, K4.id)
    check('C', 'assumption knowledge → STALE', k4b.includes('⚠️ trust: STALE'), k4b)
    check('C', 'agent sees WHAT the knowledge claims (old assumption text)', k4b.includes("use as context; still verify against the repository"))
    check('C', 'agent sees WHY it is affected (content hash changed)', k4b.includes('Content hash changed'), k4b)
    check('C', 'agent sees the appropriate ACTION (revalidate)', k4b.includes('revalidate against the repository'), k4b)
    check('C', 'unrelated knowledge in same scenario (K3) unaffected', blockFor(c.text, K3.id).includes('trust: TRUSTED') && !blockFor(c.text, K3.id).includes('⚠️'))
    check('C', 'impact tally correct (1 stale, 3 trusted)', c.text.includes('- 1 stale') && c.text.includes('- 3 trusted'))
    console.log('  agent-visible context after assumption-breaking change:\n' + excerpt(c.text).split('\n').map((l) => `      ${l}`).join('\n'))
    console.log('  knowledge block for the invalidated assumption:\n' + k4b.split('\n').map((l) => `      ${l}`).join('\n'))
    restore('src/trust.mjs')
    console.log('  RESTORED: src/trust.mjs')

    const snapEnd = snapshot(homeMain, REPO)
    check('E', 'canonical store unchanged across A+B+C', snapEnd === snapMain0,
      `sha ${sha256Hex(snapEnd).slice(0, 12)} vs ${sha256Hex(snapMain0).slice(0, 12)}`)
    check('E', 'no candidate rows auto-created', JSON.parse(snapEnd).length === 4, `${JSON.parse(snapEnd).length} rows`)
    check('E', 'no canonical authority rows created', !snapEnd.includes('"authority":"canonical"'))
    check('ISO', 'foreign project store untouched', snapshot(homeMain, FOREIGN_REPO) === snapForeign0)

    fiber.dispose()
  } finally {
    restoreAll()
  }

  // ── degraded phase ──
  // openProjectStore keys its cache by projectId ONLY (veyraHome ignored,
  // src/store.mjs:594-607) — clear the cache so homeDeg seeds land in the
  // homeDeg database. Then rebuild the shared cbm client with the bad binary
  // path so every later resolution (ambient + tool) sees the degraded client.
  closeAllStores()
  const D1 = seedRecord(homeDeg, REPO, {
    title: 'Phase4: renderAgentContext ordering (degraded)',
    body: 'renderAgentContext emits the trust line right after the freshness lines.',
    evidence: [{ path: 'src/context.mjs', content_hash: sha256Hex(backups.get('src/context.mjs')) }],
  })
  const D2 = seedRecord(homeDeg, REPO, {
    title: 'Phase4: change summary block (degraded)',
    body: 'The ambient change summary starts with "Repository changes detected:".',
    evidence: [{ path: 'src/context.mjs' }],
  })
  const D5 = seedRecord(homeDeg, REPO, {
    title: 'Phase4 symbol-only anchor: phase4SymbolOnlyAnchor',
    body: 'phase4SymbolOnlyAnchor knowledge with a symbol anchor and no file path.',
    evidence: [{ symbol: 'phase4SymbolOnlyAnchor' }],
  })
  const snapDeg0 = snapshot(homeDeg, REPO)
  resetSharedCodeClient()
  const badExe = join(tmp, 'no-such-codebase-memory-binary')
  getOrCreateCodeClient({ exePath: badExe })
  const { ctx: dctx, fiber: dFiber } = await compose(svc, {
    home: homeDeg,
    recallLimit: 10,
    includeReusable: false,
    eagerStartCodebaseMemory: false,
    codebaseMemoryBin: badExe,
  }, join(profile, 'degraded'))

  try {
    // ═══ Scenario D — Degraded Code Intelligence ═══
    console.log('\n── Scenario D — Degraded Code Intelligence (cbm binary unavailable) ──')
    const dtool = createToolHarness({ veyraHome: homeDeg, fallbackCwd: REPO })
    const probe = await dtool.call('veyra_change_impact', { changedFiles: ['src/context.mjs'], repo: REPO }, { agent: { session: { header: { cwd: REPO } } } })
    check('D', 'Code Intelligence reports degraded', probe.degraded === true && typeof probe.degradedReason === 'string', JSON.stringify({ degraded: probe.degraded, reason: probe.degradedReason }))

    const dbase = await agentContext(dctx, 'D-baseline')
    check('D', 'baseline: symbol-only knowledge visible as insufficient_evidence',
      blockFor(dbase.text, D5.id).includes('⚠️ trust: INSUFFICIENT_EVIDENCE') &&
      blockFor(dbase.text, D5.id).includes('while Code Intelligence is degraded'))
    check('D', 'baseline: path-anchored knowledge trusted (no unsafe escalation concern)',
      blockFor(dbase.text, D1.id).includes('trust: TRUSTED') && !blockFor(dbase.text, D1.id).includes('⚠️'))
    check('D', 'baseline: no change block', !hasChangeBlock(dbase.text))

    editAppend('src/context.mjs', '\n// Phase 4 validation — scenario D controlled change (restored byte-exact)\n')
    console.log('  CHANGE APPLIED: src/context.mjs (+1 comment line)')
    const d = await waitContext(dctx, (t) => hasChangeBlock(t) && t.includes('- src/context.mjs'), 'D-after-change')
    check('D', 'changed files still reach ambient context while degraded', hasChangeBlock(d.text) && d.text.includes('- src/context.mjs'))
    const d1b = blockFor(d.text, D1.id)
    check('D', 'path evidence still works: hash anchor → STALE', d1b.includes('⚠️ trust: STALE') && d1b.includes('Content hash changed'), d1b)
    const d2b = blockFor(d.text, D2.id)
    check('D', 'path evidence still works: path anchor → REVIEW_REQUIRED', d2b.includes('⚠️ trust: REVIEW_REQUIRED') && d2b.includes('related repository file changed: src/context.mjs'), d2b)
    const d5b = blockFor(d.text, D5.id)
    check('D', 'symbol-only knowledge stays insufficient_evidence (visible uncertainty)', d5b.includes('⚠️ trust: INSUFFICIENT_EVIDENCE') && d5b.includes('while Code Intelligence is degraded'), d5b)
    check('D', 'impact tally (1 stale, 1 review, 1 insufficient)',
      d.text.includes('- 1 stale') && d.text.includes('- 1 review required') && d.text.includes('- 1 insufficient evidence'))
    check('D', 'no fabricated symbol/call-graph impact in context', !/symbols resolved|call[- ]graph (resolved|built|impact)|symbol impact:/.test(d.text))
    console.log('  agent-visible context (degraded) after change:\n' + excerpt(d.text).split('\n').map((l) => `      ${l}`).join('\n'))

    const dimpact = await dtool.call('veyra_change_impact', { changedFiles: ['src/context.mjs'], repo: REPO, query: 'phase4SymbolOnlyAnchor' }, { agent: { session: { header: { cwd: REPO } } } })
    const dAffected = (dimpact.affectedMemories || []).map((m) => m.memoryId)
    check('D', 'affected detection still path-based only', dAffected.includes(D1.id) && dAffected.includes(D2.id) && !dAffected.includes(D5.id), JSON.stringify(dAffected))
    const dK5 = (dimpact.context || []).find((c) => c.memoryId === D5.id)
    check('D', 'symbol-only record classified insufficient_evidence with honest evidence', dK5?.category === 'insufficient_evidence' &&
      (dK5.evidence || []).some((e) => /no symbol or call-graph evidence used/.test(e)), JSON.stringify(dK5))
    check('D', 'no fabricated symbol/call-graph fields in change impact result', !('symbols' in dimpact) && !('callGraph' in dimpact))

    dFiber.dispose()

    restore('src/context.mjs')
    console.log('  RESTORED: src/context.mjs')
    const snapDegEnd = snapshot(homeDeg, REPO)
    check('E/D', 'degraded canonical store unchanged', snapDegEnd === snapDeg0,
      `sha ${sha256Hex(snapDegEnd).slice(0, 12)} vs ${sha256Hex(snapDeg0).slice(0, 12)}`)
  } finally {
    restoreAll()
  }

  // ── final repo-restoration proof ──
  const restoredAll = EDIT_FILES.every((f) => readFileSync(join(REPO, f), 'utf8') === backups.get(f))
  check('E', 'repository files restored byte-exact after all scenarios', restoredAll)

  // ── isolation across every single capture ──
  check('ISO', `foreign record never leaked across ${captures.total} context captures`, captures.leakFree === captures.total,
    `${captures.leakFree}/${captures.total}`)

  // ── summary ──
  const failed = checks.filter((c) => !c.ok)
  const scenarios = [...new Set(checks.map((c) => c.scenario))]
  console.log('\n════════════════════════════════════════════════')
  console.log(`checks: ${checks.length - failed.length}/${checks.length} passed — scenarios: ${scenarios.join(', ')}`)
  console.log(`canonical store sha: main ${sha256Hex(snapMain0).slice(0, 16)} (before) == ${sha256Hex(snapshot(homeMain, REPO)).slice(0, 16)} (after)`)
  console.log(failed.length === 0 ? 'PHASE 4: PASS' : `PHASE 4: FAIL (${failed.length} failed checks)`)
  console.log('════════════════════════════════════════════════')
  if (failed.length > 0) {
    for (const f of failed) console.log(`  ✖ [${f.scenario}] ${f.name}`)
    process.exitCode = 1
  }
}

main()
  .catch((err) => {
    console.error('\nPHASE 4 VALIDATION ERROR:', err)
    process.exitCode = 1
  })
  .finally(() => {
    try { restoreAll() } catch { /* best effort */ }
    try { closeAllStores() } catch { /* already closed */ }
  })
