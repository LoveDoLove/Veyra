/**
 * Phase 5 regression: configured recallLimit → actual runtime limit.
 *
 * Phase 4 reported that a boot config of `recallLimit: 10` still yielded 5
 * recalled records and read it as "recallLimit does not reach the runtime".
 * Root cause of that observation (Phase 5): the config DID reach the runtime
 * — the count of 5 came from near-duplicate suppression (retrieve.mjs
 * suppressNearDuplicates, containment >= 0.5) collapsing two seed pairs that
 * only shared one store because of the home-agnostic store cache key. This
 * file therefore locks two things:
 *
 *   1. the recallLimit contract itself — against a real Cordis composition
 *      (same mechanics as dsh-runtime.test.mjs): 0 disables automatic
 *      recall, 3 caps at 3, 10 shows all 7 distinct records, absent key
 *      keeps the default 5, and a settings remount via fiber.update()
 *      re-applies the new limit;
 *   2. the Phase 4 observation itself — 7 stored records where two pairs are
 *      near-duplicates recall as 5 at limit 10, by design. Dedup, not a
 *      lost limit.
 *
 * Skips the composed test when no DSH install is discoverable (set
 * DSH_INSTALL to force one); the direct recall test always runs.
 */

import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { findDshRoot, loadDshPackage } from './helpers/dsh.mjs'
import * as veyra from '../src/plugin.mjs'
import { buildToolDefinitions } from '../src/tools.mjs'
import { openProjectStore, closeAllStores } from '../src/store.mjs'
import { recall } from '../src/retrieve.mjs'
import { newRecordId, projectIdFor } from '../src/ids.mjs'

const dsh = findDshRoot()
const skip = dsh ? false : 'no DSH install found (set DSH_INSTALL to run)'
const REPO = process.cwd()

function seedRecallEligibleRecords(home, count) {
  const store = openProjectStore(home, projectIdFor(REPO))
  // Seven DISTINCT facts: near-duplicate suppression (containment >= 0.5,
  // retrieve.mjs) would otherwise collapse near-identical claims and mask
  // the limit being tested. See the Phase 4 root-cause test below.
  const facts = [
    ['sqlite write serialization', 'DatabaseSync connections are unsafe for concurrent writers.'],
    ['fts match quoting', 'Unquoted user text can break MATCH queries.'],
    ['wal journal pragma', 'Project databases open with journal_mode WAL enabled.'],
    ['candidate recall gate', 'Candidates stay out of ambient recall by default.'],
    ['secret redaction write', 'API keys get masked before records hit the disk.'],
    ['watcher debounce window', 'Adjacent filesystem events batch inside one timer.'],
    ['store cache home key', 'The store cache key includes the resolved database path.'],
  ]
  const ids = []
  for (let i = 0; i < count; i++) {
    const written = store.put({
      id: newRecordId(),
      kind: 'knowledge',
      status: 'current',
      validation: 'verified',
      authority: 'derived',
      confidence: 'high',
      scope: 'project',
      title: facts[i][0],
      body: facts[i][1],
      evidence: [],
      source: { signal: 'probe' },
    })
    ids.push(written.record.id)
  }
  return ids
}

async function composeVeyra(home, profileDir, config) {
  const { Context } = await loadDshPackage('@deepseek-ai/cordis')
  const { SystemPrompt } = await loadDshPackage('@deepseek-ai/dsh-system-prompt')
  const { ToolRuntime } = await loadDshPackage('@deepseek-ai/dsh-tools')
  const { CommandRuntime } = await loadDshPackage('@deepseek-ai/dsh-commands')
  const { SettingsForms } = await loadDshPackage('@deepseek-ai/dsh-settings')
  const { SkillRegistry } = await loadDshPackage('@deepseek-ai/dsh-skill')

  const ctx = new Context()
  ctx.provide('profileContext', { home: profileDir, dir: profileDir, name: 'recall-limit' })
  ctx.provide('configEditor', {
    documentPath: join(profileDir, 'settings.json'),
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
  const fiber = ctx.plugin(veyra, {
    home,
    codebaseWatch: false,
    eagerStartCodebaseMemory: false,
    includeReusable: false,
    ...config,
  })

  const names = buildToolDefinitions({ veyraHome: home, fallbackCwd: REPO }).map((d) => d.name)
  for (let i = 0; i < 120; i++) {
    const view = ctx.tools?.view?.()
    if (view && names.every((n) => view.visible.has(n))) break
    await new Promise((r) => setTimeout(r, 100))
    if (i === 119) throw new Error('Veyra tools never became visible in the composed context')
  }
  return { ctx, fiber }
}

async function recalledCount(ctx) {
  const assembly = await ctx.systemPrompt.assemble({
    agent: { session: { header: { cwd: REPO } } },
  })
  const entry = assembly.contexts.find((c) => c.name === 'veyra:recall')
  const text = entry?.text ?? ''
  return (text.match(/^- \[vey_/gm) || []).length
}

test('configured recallLimit reaches the runtime (boot 0/3/10 + settings remount)', { skip }, async () => {
  const home = mkdtempSync(join(tmpdir(), 'veyra-recall-limit-'))
  const profiles = mkdtempSync(join(tmpdir(), 'veyra-recall-limit-prof-'))
  const fibers = []
  try {
    seedRecallEligibleRecords(home, 7)

    // Boot config 10 → all 7 records in ambient context (Phase 4 claimed 5).
    const c10 = await composeVeyra(home, join(profiles, 'p10'), { recallLimit: 10 })
    fibers.push(c10.fiber)
    assert.equal(await recalledCount(c10.ctx), 7, 'boot recallLimit: 10 must show all 7 eligible records')

    // Settings remount path: fiber.update({recallLimit: 3}) → live context follows.
    c10.fiber.update({ home, codebaseWatch: false, eagerStartCodebaseMemory: false, includeReusable: false, recallLimit: 3 })
    let updated = -1
    for (let i = 0; i < 50 && updated !== 3; i++) {
      try { updated = await recalledCount(c10.ctx) } catch { updated = -1 }
      if (updated !== 3) await new Promise((r) => setTimeout(r, 100))
    }
    assert.equal(updated, 3, 'fiber.update to recallLimit: 3 must cap ambient context at 3 records')

    // Boot config 3 → exactly 3.
    const c3 = await composeVeyra(home, join(profiles, 'p3'), { recallLimit: 3 })
    fibers.push(c3.fiber)
    assert.equal(await recalledCount(c3.ctx), 3, 'boot recallLimit: 3 must cap ambient context at 3 records')

    // Boot config 0 → automatic recall disabled (default behavior unchanged).
    const c0 = await composeVeyra(home, join(profiles, 'p0'), { recallLimit: 0 })
    fibers.push(c0.fiber)
    assert.equal(await recalledCount(c0.ctx), 0, 'boot recallLimit: 0 must suppress the ambient recall context')

    // No recallLimit key at all → default 5 behavior preserved.
    const cDefault = await composeVeyra(home, join(profiles, 'pDefault'), {})
    fibers.push(cDefault.fiber)
    assert.equal(await recalledCount(cDefault.ctx), 5, 'absent recallLimit must keep the default of 5')
  } finally {
    for (const fiber of fibers) {
      try { await fiber.dispose() } catch { /* teardown best-effort */ }
    }
    closeAllStores()
    rmSync(home, { recursive: true, force: true })
    rmSync(profiles, { recursive: true, force: true })
  }
})

test('Phase 4 observation: limit 10 over 7 records with 2 near-dup pairs recalls 5 (dedup, not a lost limit)', () => {
  const home = mkdtempSync(join(tmpdir(), 'veyra-recall-dedup-'))
  try {
    const store = openProjectStore(home, projectIdFor(REPO))
    // The exact Phase 4 seed set as it landed in ONE store once the
    // home-agnostic cache key put the main and degraded homes together.
    const seeds = [
      { id: 'k1', title: 'Phase4: renderAgentContext ordering', body: 'renderAgentContext emits the trust line right after the freshness lines inside each record block.' },
      { id: 'k2', title: 'Phase4: change summary block format', body: 'The ambient change summary starts with "Repository changes detected:".' },
      { id: 'k3', title: 'Phase4: text utility helper assumption', body: 'Text helpers in src/text.mjs operate on plain strings.' },
      { id: 'k4', title: 'Phase4: trusted action wording assumption', body: "TRUST_ACTIONS.trusted action text is 'use as context; still verify against the repository' — recorded from src/trust.mjs." },
      { id: 'd1', title: 'Phase4: renderAgentContext ordering (degraded)', body: 'renderAgentContext emits the trust line right after the freshness lines.' },
      { id: 'd2', title: 'Phase4: change summary block (degraded)', body: 'The ambient change summary starts with "Repository changes detected:".' },
      { id: 'd5', title: 'Phase4 symbol-only anchor: phase4SymbolOnlyAnchor', body: 'phase4SymbolOnlyAnchor knowledge with a symbol anchor and no file path.' },
    ]
    const byKey = {}
    for (const s of seeds) {
      const written = store.put({
        id: newRecordId(),
        kind: 'knowledge',
        status: 'current',
        validation: 'verified',
        authority: 'derived',
        confidence: 'high',
        scope: 'project',
        title: s.title,
        body: s.body,
        evidence: [],
        source: { signal: 'probe' },
      })
      byKey[s.id] = written.record.id
    }
    assert.equal(store.list({ limit: 100 }).length, 7)

    const hits = recall({ projectStore: store, reusableStore: null, query: '', goal: null, limit: 10, includeReusable: false })
    const hitIds = new Set(hits.map((r) => r.id))
    assert.equal(hits.length, 5, 'two near-duplicate pairs collapse by design: 7 - 2 = 5')
    assert.ok(hitIds.has(byKey.k3) && hitIds.has(byKey.k4) && hitIds.has(byKey.d5), 'distinct records always survive')
    assert.ok(hitIds.has(byKey.k1) !== hitIds.has(byKey.d1), 'exactly one of the k1/d1 near-dup pair survives')
    assert.ok(hitIds.has(byKey.k2) !== hitIds.has(byKey.d2), 'exactly one of the k2/d2 near-dup pair survives')
  } finally {
    closeAllStores()
    rmSync(home, { recursive: true, force: true })
  }
})

after(() => {
  try { closeAllStores() } catch { /* teardown best-effort */ }
})
