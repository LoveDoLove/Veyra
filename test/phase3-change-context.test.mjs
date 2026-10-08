/**
 * Phase 3 — Automatic Change-Aware Context (GOAL.md Phase 3).
 *
 * Existing Repository Change Signal → Existing Change Intelligence →
 * Existing Trust Classification → Existing Ambient Agent Context.
 *
 * Verifies the invariants required by Phase 3:
 *   - an existing RepositoryWatcher change event reaches ambient context
 *     WITHOUT the agent calling veyra_change_impact
 *   - changed files propagate into the rendered context (change summary)
 *   - ambient context classifies via classifyRecordTrust (existing semantics)
 *   - no change signal → context behavior is byte-identical to before
 *   - repeated changes never accumulate; latest change supersedes
 *   - signal fails closed across workspaces (isolation)
 *   - degraded Code Intelligence stays safe (path matching only, no
 *     fabricated symbol / call-graph impact)
 *   - recording signals and rendering context never mutates canonical memory
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { openProjectStore, closeAllStores } from '../src/store.mjs'
import { projectIdFor, newRecordId } from '../src/ids.mjs'
import { AUTHORITIES, KINDS, RELATIONS, STATUSES, VALIDATIONS } from '../src/types.mjs'
import { TRUST_CATEGORIES } from '../src/trust.mjs'
import {
  buildRecallContext,
  createContextProvider,
  recordRepositoryChange,
} from '../src/context.mjs'
import { apply } from '../src/plugin.mjs'

const noopLog = { debug: () => {}, warn: () => {}, info: () => {} }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function makeRepo(t, files = { 'src/a.js': 'export const a = 1\n' }) {
  const tmp = mkdtempSync(join(tmpdir(), 'veyra-phase3-repo-'))
  t.after(() => rmSync(tmp, { recursive: true, force: true }))
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(tmp, rel)
    mkdirSync(dirname(abs), { recursive: true })
    writeFileSync(abs, content)
  }
  return tmp
}

function makeHome(t) {
  const home = mkdtempSync(join(tmpdir(), 'veyra-phase3-home-'))
  t.after(() => rmSync(home, { recursive: true, force: true }))
  return home
}

function record(overrides = {}) {
  return {
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
    source: { signal: 'test' },
    ...overrides,
  }
}

function putRecord(home, repo, overrides = {}) {
  const store = openProjectStore(home, projectIdFor(repo))
  const written = store.put(record(overrides))
  assert.equal(written.created, true)
  return written.record
}

/**
 * A runtime shaped exactly like createContextProvider expects, with an
 * explicit changeSignals map (plugin runtime shape) and a no-op watcher
 * registration for unit-speed tests. The real wiring is covered by the
 * plugin-lifecycle test below.
 */
function fakeRuntime(home, cwd, opts = {}) {
  return {
    veyraHome: home,
    fallbackCwd: cwd,
    recallLimit: 5,
    includeReusable: true,
    codeEngine: opts.codeEngine || { isDegraded: false },
    changeSignals: opts.changeSignals || new Map(),
    ensureWatcher: () => {},
    log: noopLog,
  }
}

function callProvider(runtime, cwd, queryText = null) {
  const provider = createContextProvider(runtime)
  const agent = {
    session: {
      header: { cwd },
      ...(queryText
        ? { deriveMessages: () => [{ role: 'user', content: queryText }] }
        : {}),
    },
  }
  return provider({ agent })
}

/** The rendered block belonging to one recalled record (its title is the key). */
function blockFor(text, title) {
  const lines = text.split('\n')
  const start = lines.findIndex((l) => l.startsWith('- [') && l.includes(title))
  assert.notEqual(start, -1, `record line for "${title}" not found in:\n${text}`)
  let end = lines.length
  for (let i = start + 1; i < lines.length; i++) {
    if (lines[i].startsWith('- [')) { end = i; break }
  }
  return lines.slice(start, end).join('\n')
}

/** Canonical-safety snapshot: every row, minus the recall bookkeeping stamp. */
function storeSnapshot(home, repo) {
  const store = openProjectStore(home, projectIdFor(repo))
  return JSON.stringify(
    store.list({ limit: 500 }).map(({ lastRecalledAt, last_recalled_at, ...rest }) => rest),
  )
}

// ── 1. Existing RepositoryWatcher change event → ambient context ────────────

test('plugin lifecycle: RepositoryWatcher change event reaches ambient context', async (t) => {
  const home = makeHome(t)
  const repo = makeRepo(t, { 'src/a.js': 'export const a = 1\n' })
  putRecord(home, repo, {
    title: 'Auth flow validates session tokens in src/a.js',
    body: 'Session tokens are validated during the auth flow.',
    evidence: [{ path: 'src/a.js' }],
  })

  // Minimal Cordis-shaped ctx (same harness shape as test/plugin.test.mjs).
  const tools = []
  const commands = []
  const sections = []
  const contexts = []
  const skills = []
  const providers = []
  const listeners = {}
  const ctx = {
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
  const dispose = apply(ctx, { home, observe: false, learn: false })
  t.after(() => {
    dispose?.()
    closeAllStores()
  })
  await sleep(50)

  const provider = ctx._contexts.find((c) => c.name === 'veyra:recall')
  assert.ok(provider, 'veyra:recall context registered')
  const call = () => provider.text({
    agent: {
      session: {
        header: { cwd: repo },
        deriveMessages: () => [{ role: 'user', content: 'How are session tokens validated?' }],
      },
    },
  })

  // No change signal yet → original context behavior.
  const before = call()
  assert.ok(!before.includes('Repository changes detected:'), 'no signal → no change block')
  assert.ok(before.includes('Auth flow validates session tokens'), 'record recalled as before')

  // Existing watcher signal (debounce 500ms default): modify the anchored file.
  writeFileSync(join(repo, 'src/a.js'), 'export const a = 2\n')
  let after = ''
  for (let i = 0; i < 40 && !after.includes('Repository changes detected:'); i++) {
    await sleep(150)
    after = call()
  }

  assert.ok(after.includes('Repository changes detected:'), 'change signal reaches ambient context')
  assert.ok(after.includes('- src/a.js'), 'changed file listed')
  assert.ok(after.includes('Knowledge impact:'), 'impact tally rendered')
  const block = blockFor(after, 'Auth flow validates session tokens')
  assert.ok(
    block.includes(`⚠️ trust: ${TRUST_CATEGORIES.REVIEW_REQUIRED.toUpperCase()}`),
    `affected record classifies as review_required, block:\n${block}`,
  )
})

// ── 2. recordRepositoryChange unit behavior ─────────────────────────────────

test('recordRepositoryChange dedupes, replaces, and refuses empty signals', () => {
  const signals = new Map()
  const repo = '/repo/one'
  const other = '/repo/two'

  const first = recordRepositoryChange(signals, {
    repoRoot: repo,
    added: ['src/new.js'],
    modified: ['src/a.js', 'src/a.js', 'src/new.js'],
    deleted: ['src/old.js'],
    timestamp: 1,
  })
  assert.deepEqual(first.changedFiles, ['src/new.js', 'src/a.js', 'src/old.js'])
  assert.equal(signals.size, 1)

  // Same content again → no duplicate state (order-stable input).
  recordRepositoryChange(signals, {
    repoRoot: repo,
    added: ['src/new.js'],
    modified: ['src/a.js', 'src/new.js'],
    deleted: ['src/old.js'],
  })
  assert.equal(signals.size, 1)
  assert.deepEqual(signals.get(repo).changedFiles, ['src/new.js', 'src/a.js', 'src/old.js'])

  // Newest changeset fully supersedes the obsolete one.
  recordRepositoryChange(signals, { repoRoot: repo, modified: ['src/b.js'] })
  assert.deepEqual(signals.get(repo).changedFiles, ['src/b.js'])

  // Empty / malformed changesets never fabricate a signal.
  assert.equal(recordRepositoryChange(signals, { repoRoot: repo, modified: [] }), null)
  assert.equal(recordRepositoryChange(signals, { modified: ['src/c.js'] }), null)
  assert.equal(recordRepositoryChange(signals, null), null)
  assert.equal(recordRepositoryChange(null, { repoRoot: repo, modified: ['x'] }), null)
  assert.equal(signals.get(repo).changedFiles[0], 'src/b.js', 'refused writes left the signal intact')

  // Separate repos stay separate (isolation).
  recordRepositoryChange(signals, { repoRoot: other, modified: ['y.js'] })
  assert.equal(signals.size, 2)
  assert.deepEqual(signals.get(other).changedFiles, ['y.js'])
  assert.deepEqual(signals.get(repo).changedFiles, ['src/b.js'])
})

// ── 3. Ambient context uses the existing trust classification ───────────────

test('ambient context classifies affected and unaffected knowledge via classifyRecordTrust', (t) => {
  const home = makeHome(t)
  const repo = makeRepo(t, { 'src/a.js': 'export const a = 1\n', 'src/b.js': 'export const b = 2\n' })
  putRecord(home, repo, {
    title: 'Module A wiring rules',
    body: 'a wiring',
    evidence: [{ path: 'src/a.js' }],
  })
  putRecord(home, repo, {
    title: 'Module B wiring rules',
    body: 'b wiring',
    evidence: [{ path: 'src/b.js' }],
  })

  const changeSignals = new Map()
  recordRepositoryChange(changeSignals, { repoRoot: repo, modified: ['src/a.js'] })
  const out = callProvider(fakeRuntime(home, repo, { changeSignals }), repo)

  assert.ok(out.includes('Repository changes detected:'))
  assert.ok(out.includes('- src/a.js'))
  assert.ok(!out.includes('- src/b.js'), 'unchanged file not listed')
  assert.ok(out.includes('- 1 review required'), 'impact: affected record')
  assert.ok(out.includes('- 1 trusted'), 'impact: unaffected record stays trusted')

  const affected = blockFor(out, 'Module A wiring rules')
  assert.ok(affected.includes(`⚠️ trust: ${TRUST_CATEGORIES.REVIEW_REQUIRED.toUpperCase()}`), affected)
  const untouched = blockFor(out, 'Module B wiring rules')
  assert.ok(untouched.includes('trust: TRUSTED'), untouched)
  assert.ok(!untouched.includes('⚠️ trust:'), untouched)
})

// ── 4. No change signal → original context behavior ─────────────────────────

test('no change signal keeps context behavior unchanged', (t) => {
  const home = makeHome(t)
  const repo = makeRepo(t, { 'src/a.js': 'export const a = 1\n' })
  putRecord(home, repo, {
    title: 'Stable knowledge without change signal',
    body: 'body',
    evidence: [{ path: 'src/a.js' }],
  })

  const viaProvider = callProvider(fakeRuntime(home, repo), repo)
  const viaDirect = buildRecallContext({
    veyraHome: home,
    cwd: repo,
    query: '',
    limit: 5,
    includeReusable: true,
    degraded: false,
  })
  assert.equal(viaProvider, viaDirect, 'provider output identical to pre-Phase-3 context')
  assert.ok(!viaProvider.includes('Repository changes detected:'))
})

// ── 5. Repeated changes: idempotent, latest supersedes ──────────────────────

test('repeated changes produce no duplicate state and latest change supersedes', (t) => {
  const home = makeHome(t)
  const repo = makeRepo(t, { 'src/a.js': 'export const a = 1\n', 'src/b.js': 'export const b = 2\n' })
  putRecord(home, repo, { title: 'Knowledge for change supersession', body: 'body', evidence: [] })

  const changeSignals = new Map()
  recordRepositoryChange(changeSignals, { repoRoot: repo, modified: ['src/a.js'] })
  recordRepositoryChange(changeSignals, { repoRoot: repo, modified: ['src/a.js'] })
  recordRepositoryChange(changeSignals, { repoRoot: repo, modified: ['src/b.js'] })
  assert.equal(changeSignals.size, 1, 'one signal per repository, never accumulated')

  const runtime = fakeRuntime(home, repo, { changeSignals })
  const first = callProvider(runtime, repo)
  const second = callProvider(runtime, repo)
  assert.equal(first, second, 'repeated rendering is deterministic (idempotent)')
  assert.ok(first.includes('- src/b.js'), 'latest change rendered')
  assert.ok(!first.includes('- src/a.js'), 'obsolete change superseded, not accumulated')
})

// ── 6. Workspace isolation (fail closed) ────────────────────────────────────

test('change signal fails closed across workspaces', (t) => {
  const home = makeHome(t)
  const repo = makeRepo(t, { 'src/a.js': 'export const a = 1\n' })
  putRecord(home, repo, { title: 'Knowledge in this workspace', body: 'body', evidence: [] })

  const changeSignals = new Map()
  recordRepositoryChange(changeSignals, { repoRoot: '/some/other/repo', modified: ['other.js'] })
  recordRepositoryChange(changeSignals, { repoRoot: join(repo, 'sub'), modified: ['sub.js'] })

  const out = callProvider(fakeRuntime(home, repo, { changeSignals }), repo)
  assert.ok(!out.includes('Repository changes detected:'), 'foreign signal never leaks into this workspace')
  assert.ok(out.includes('Knowledge in this workspace'), 'recall itself unaffected')

  // Unknown workspace: no signal → no change block (fail closed).
  const unknown = callProvider(fakeRuntime(home, repo, { changeSignals }), '/nowhere/else')
  assert.ok(!unknown.includes('Repository changes detected:'))
})

// ── 7. Degraded Code Intelligence stays safe ────────────────────────────────

test('degraded Code Intelligence: path matching only, nothing fabricated', (t) => {
  const home = makeHome(t)
  const repo = makeRepo(t, { 'src/a.js': 'export const a = 1\n' })
  // Path-only anchor: safe to match against changed files while degraded.
  putRecord(home, repo, {
    title: 'Path anchored knowledge',
    body: 'body',
    evidence: [{ path: 'src/a.js' }],
  })
  // Symbol anchor: symbol only (no path) — degraded mode must classify it
  // as insufficient evidence instead of fabricating symbol-level impact.
  putRecord(home, repo, {
    title: 'Symbol anchored knowledge',
    body: 'body',
    evidence: [{ symbol: 'legacyHelper' }],
  })

  const changeSignals = new Map()
  recordRepositoryChange(changeSignals, { repoRoot: repo, modified: ['src/a.js'] })
  const out = callProvider(fakeRuntime(home, repo, { changeSignals, codeEngine: { isDegraded: true } }), repo)

  assert.ok(out.includes('Repository changes detected:'), 'changed files still propagate while degraded')
  const pathBlock = blockFor(out, 'Path anchored knowledge')
  assert.ok(pathBlock.includes(`⚠️ trust: ${TRUST_CATEGORIES.REVIEW_REQUIRED.toUpperCase()}`), pathBlock)
  const symbolBlock = blockFor(out, 'Symbol anchored knowledge')
  assert.ok(
    symbolBlock.includes(`⚠️ trust: ${TRUST_CATEGORIES.INSUFFICIENT_EVIDENCE.toUpperCase()}`),
    `symbol-only knowledge stays insufficient_evidence while degraded:\n${symbolBlock}`,
  )
  assert.ok(
    symbolBlock.includes('while Code Intelligence is degraded'),
    `degraded trust reason must state its limits:\n${symbolBlock}`,
  )
  assert.ok(!symbolBlock.includes('call graph resolved'), 'no fabricated symbol/call-graph impact')
})

// ── 8. Canonical safety ─────────────────────────────────────────────────────

test('change signal processing never mutates canonical memory', (t) => {
  const home = makeHome(t)
  const repo = makeRepo(t, { 'src/a.js': 'export const a = 1\n' })
  putRecord(home, repo, { title: 'Canonical candidate knowledge', body: 'body', evidence: [{ path: 'src/a.js' }] })
  const other = putRecord(home, repo, { title: 'Other side knowledge', body: 'other', evidence: [] })
  putRecord(home, repo, {
    title: 'Contradicted knowledge',
    body: 'body',
    evidence: [],
    relations: [{ type: RELATIONS.CONTRADICTS, targetId: other.id }],
  })

  const before = storeSnapshot(home, repo)
  const changeSignals = new Map()
  recordRepositoryChange(changeSignals, { repoRoot: repo, modified: ['src/a.js'] })
  const runtime = fakeRuntime(home, repo, { changeSignals })
  callProvider(runtime, repo)
  callProvider(runtime, repo)
  const after = storeSnapshot(home, repo)

  assert.equal(after, before, 'no row added, removed, or rewritten by signal + render')
  assert.ok(!after.includes('"authority": "canonical"') || after === before, 'authority unchanged')
  const out = callProvider(runtime, repo)
  assert.ok(out.includes(`⚠️ trust: ${TRUST_CATEGORIES.CONTRADICTED.toUpperCase()}`), 'contradiction stays visible')
  assert.ok(
    out.includes('[CONTRADICTION:') && out.includes('Other side knowledge') && out.includes('Contradicted knowledge'),
    'both contradiction sides named in the banner',
  )
})

// ── 9. Change block survives an empty recall ────────────────────────────────

test('changed files reach the context even when no memory is recalled', (t) => {
  const home = makeHome(t)
  const repo = makeRepo(t, { 'src/new.js': 'export const n = 1\n' })
  const changeSignals = new Map()
  recordRepositoryChange(changeSignals, { repoRoot: repo, added: ['src/new.js'] })

  const out = callProvider(fakeRuntime(home, repo, { changeSignals }), repo)
  assert.ok(out.includes('No known engineering history'), 'empty recall state preserved')
  assert.ok(out.includes('Repository changes detected:'), 'change signal still reaches the agent')
  assert.ok(out.includes('- src/new.js'))
  assert.ok(!out.includes('Knowledge impact:'), 'no impact tally without classified records')
})
