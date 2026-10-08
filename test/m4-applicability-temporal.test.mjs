/**
 * M4 — Applicability and temporal semantics (GOAL.md Phase 4 / §12 / §13 / §11).
 *
 * Phase 4 makes Veyra able to answer three questions about any memory —
 * "Is this relevant? Is it applicable HERE? Is it still valid?" — without
 * turning retrieval into a filter:
 *
 *   - §13 temporal validity: `source.temporal` (validFrom/validUntil,
 *     camelCase canonical, snake_case read aliases, dsh-memory
 *     nodefile.py:133-138 discipline) resolves to one of `current` /
 *     `not_yet_effective` / `expired`; unparseable endpoints fail open
 *     (mdcos.py: 不过滤, 不猜测); a future valid_from is NOT an expiry.
 *   - §12 applicability context: remember() auto-stamps os/runtime,
 *     agent-supplied keys ride alongside; compatibility compares only
 *     keys both sides state (unknown ≠ incompatible), runtime at
 *     major-version granularity.
 *   - Both dimensions are SORT-ONLY: they enter the RRF channel set and
 *     a polarity-style eligibility cap on `fusion`; `composite` — the
 *     pinned plain weighted sum — never sees them.
 *   - Guards are query-only (empty-query = browse, availability wins)
 *     and inactive when nothing eligible exists (sole expired result
 *     stays retrievable: historical remains available, just never
 *     presented as current truth).
 *   - §11 view: every record view carries `temporal` and `context`.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { KINDS } from '../src/types.mjs'
import { openEphemeralStore, closeAllStores } from '../src/store.mjs'
import { remember } from '../src/learn.mjs'
import { buildToolDefinitions } from '../src/tools.mjs'
import { CodeIntelligenceEngine } from '../src/code/engine.mjs'
import { rankRecords, temporalBounds, temporalState, contextCompatibility } from '../src/retrieve.mjs'

const PAST = '2020-01-01T00:00:00.000Z'
const FUTURE = '2999-01-01T00:00:00.000Z'

const BASE = { kind: 'memory', scope: 'project', projectId: 'p1', status: 'derived', validation: 'candidate', authority: 'derived', confidence: 'medium', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z', tags: [], evidence: [], relations: [] }
const rec = (id, title, body, extra = {}, override = {}) => ({ ...BASE, id, title, body, ...extra, ...override })

// ── §13 temporal bounds & state ─────────────────────────────────────────

test('temporalBounds reads canonical bag, top-level and snake_case shapes', () => {
  assert.deepEqual(temporalBounds({ source: { temporal: { validFrom: PAST, validUntil: FUTURE } } }), { validFrom: PAST, validUntil: FUTURE })
  assert.deepEqual(temporalBounds({ validFrom: PAST, validUntil: FUTURE }), { validFrom: PAST, validUntil: FUTURE })
  assert.deepEqual(temporalBounds({ valid_from: PAST, valid_until: FUTURE }), { validFrom: PAST, validUntil: FUTURE })
  assert.deepEqual(temporalBounds({ source: { temporal: { valid_until: FUTURE } } }), { validFrom: null, validUntil: FUTURE })
  // Unparseable endpoints drop out (fail-open at the state level).
  assert.deepEqual(temporalBounds({ source: { temporal: { validUntil: 'not-a-date' } } }), { validFrom: null, validUntil: null })
  assert.deepEqual(temporalBounds({}), { validFrom: null, validUntil: null })
  assert.deepEqual(temporalBounds(null), { validFrom: null, validUntil: null })
})

test('temporalState: current / not_yet_effective / expired, fail-open', () => {
  assert.equal(temporalState({ source: { temporal: { validUntil: PAST } } }), 'expired')
  assert.equal(temporalState({ source: { temporal: { validFrom: FUTURE } } }), 'not_yet_effective')
  assert.equal(temporalState({ source: { temporal: { validFrom: PAST, validUntil: FUTURE } } }), 'current')
  assert.equal(temporalState({}), 'current')
  assert.equal(temporalState(null), 'current')
  // Garbage never expires a record (unparsing → current).
  assert.equal(temporalState({ source: { temporal: { validUntil: 'soonish' } } }), 'current')
  // Snake alias on the top level.
  assert.equal(temporalState({ valid_until: PAST }), 'expired')
  // A passed valid_until wins over a valid-from in the past (window closed).
  assert.equal(temporalState({ source: { temporal: { validFrom: PAST, validUntil: PAST } } }), 'expired')
})

// ── §12 auto-capture on the write path ──────────────────────────────────

test('remember auto-stamps os/runtime context; agent-supplied keys win', () => {
  const store = openEphemeralStore()
  const written = remember(store, { title: 'ctx auto', body: 'Captured on write.', kind: KINDS.MEMORY }).record
  assert.ok(written?.id)
  const got = store.get(written.id)
  assert.equal(got.source.context.os, process.platform)
  assert.equal(got.source.context.runtime, process.version)

  const supplied = remember(store, { title: 'ctx supplied', body: 'Agent states its own context.', kind: KINDS.MEMORY, context: { os: 'darwin', toolchain: 'pnpm@9' } }).record
  const got2 = store.get(supplied.id)
  assert.equal(got2.source.context.os, 'darwin') // agent wins on conflict
  assert.equal(got2.source.context.runtime, process.version) // runtime still recorded
  assert.equal(got2.source.context.toolchain, 'pnpm@9')
  closeAllStores()
})

test('remember maps validFrom/validUntil onto source.temporal', () => {
  const store = openEphemeralStore()
  const w = remember(store, { title: 'win validity', body: 'Windowed knowledge.', kind: KINDS.KNOWLEDGE, validFrom: PAST, validUntil: FUTURE }).record
  const got = store.get(w.id)
  assert.deepEqual(got.source.temporal, { validFrom: PAST, validUntil: FUTURE })
  assert.equal(temporalState(got), 'current')
  closeAllStores()
})

test('negative/unresolved kinds skip auto-context (ponytail: coverage tail, not applicability)', () => {
  const store = openEphemeralStore()
  const n = remember(store, { title: 'neg ctx', body: 'fails every time', kind: KINDS.NEGATIVE }).record
  assert.ok(n?.id)
  assert.equal(store.get(n.id).source?.context, undefined)
  closeAllStores()
})

// ── §12 context compatibility ───────────────────────────────────────────

test('contextCompatibility: unknown is neutral, only shared keys contradict', () => {
  assert.equal(contextCompatibility({}), 1) // no capture → not a mismatch
  assert.equal(contextCompatibility({ source: { context: { os: process.platform, runtime: process.version } } }), 1)
  assert.equal(contextCompatibility({ source: { context: { os: 'some-other-os' } } }), 0)
  // Major-version granularity: patch drift is the same toolchain line.
  const major = process.version.match(/\d+/)[0]
  assert.equal(contextCompatibility({ source: { context: { runtime: `v${major}.0.0` } } }), 1)
  assert.equal(contextCompatibility({ source: { context: { runtime: 'v0.0.1' } } }), 0)
  // Keys only the record carries can never contradict current facts.
  assert.equal(contextCompatibility({ source: { context: { toolchain: 'pnpm@9', taskType: 'refactor' } } }), 1)
  // Supplied current-context override works the same way.
  assert.equal(contextCompatibility({ source: { context: { os: 'darwin' } } }, { os: 'darwin' }), 1)
  assert.equal(contextCompatibility({ source: { context: { os: 'darwin' } } }, { os: 'linux' }), 0)
})

// ── §12 invariant: Similarity ≠ Applicability (ranking) ────────────────

test('§12: an incompatible-but-more-similar record cannot outrank the applicable one', () => {
  const query = 'database migration rollback strategy'
  const applicable = rec('a', 'migration rollback', 'Rollback steps for the database migration, verified in staging.', {}, { source: { context: { os: process.platform, runtime: process.version } } })
  const incompatible = rec('b', 'migration rollback', 'database migration rollback strategy must be rehearsed in staging first before production cutover', { evidence: [{ path: 'a.md' }, { path: 'b.md' }] }, { source: { context: { os: 'some-other-os' } } })
  const r = rankRecords([applicable, incompatible], { query })
  const byId = Object.fromEntries(r.map((x) => [x.id, x]))
  // The incompatible record really is the more similar one — and still loses.
  assert.ok(byId.b.scores.composite > byId.a.scores.composite, 'incompatible twin must be textually stronger')
  assert.equal(byId.a.scores.applicability, 1)
  assert.equal(byId.b.scores.applicability, 0)
  assert.equal(r[0].id, 'a')
  assert.equal(byId.b.scores.rank_limited, true)
  assert.equal(byId.a.scores.rank_limited, undefined)
  assert.ok(byId.b.scores.fusion < byId.a.scores.fusion)
  // Composite purity: the guard touched fusion only.
  assert.equal(byId.b.scores.composite, byId.b.scores.composite)
})

test('§12 channel is live: context-only twins produce nonzero rrf', () => {
  const query = 'database migration rollback strategy'
  const shared = { title: 'migration rollback', body: 'Rollback steps for the database migration.' }
  const twins = [
    rec('ctx-ok', shared.title, shared.body, {}, { source: { context: { os: process.platform } } }),
    rec('ctx-bad', shared.title, shared.body, {}, { source: { context: { os: 'some-other-os' } } }),
  ]
  const r = rankRecords(twins, { query })
  // Everything else is flat — applicability is the only discriminating
  // channel, so rrf can only be > 0 if Phase 4 wired it into the set.
  assert.ok(r.every((x) => x.scores.rrf > 0), `expected live applicability channel, got ${JSON.stringify(r.map((x) => x.scores.rrf))}`)
})

// ── §13 invariant: historical ≠ current truth (ranking) ─────────────────

test('§13: expired twin is demoted below the current one, composite untouched', () => {
  const query = 'rollback strategy documented and verified'
  const body = 'Rollback strategy documented and verified on the old API.'
  const twins = [
    rec('expired', 'rollback strategy', body, {}, { source: { temporal: { validUntil: PAST } } }),
    rec('current', 'rollback strategy', body, {}, { source: {} }),
  ]
  const r = rankRecords(twins, { query })
  const byId = Object.fromEntries(r.map((x) => [x.id, x]))
  assert.deepEqual(r.map((x) => x.id), ['current', 'expired'])
  assert.equal(byId.expired.scores.rank_limited, true)
  assert.equal(byId.current.scores.rank_limited, undefined)
  assert.ok(byId.expired.scores.fusion < byId.current.scores.fusion)
  // Sort-only: same input facts → identical plain weighted sum.
  assert.equal(byId.expired.scores.composite, byId.current.scores.composite)
  // temporal_validity channel is live (flat-everything-else pool).
  assert.ok(byId.expired.scores.rrf > 0, 'rrf must be > 0 when temporal validity is the only signal')
})

test('§13: a sole expired record stays fully retrievable (no eligible alternative → no cap)', () => {
  const pool = [rec('only-expired', 'rollback strategy', 'Old rollback strategy.', {}, { source: { temporal: { validUntil: PAST } } })]
  const r = rankRecords(pool, { query: 'rollback strategy' })
  assert.equal(r.length, 1)
  assert.equal(r[0].scores.rank_limited, undefined)
  assert.equal(r[0].scores.fusion, r[0].scores.composite) // single flat pool → rrf null → fusion ≡ composite
})

test('§13: not_yet_effective is never demoted (scheduled knowledge stays recallable)', () => {
  const query = 'rollback strategy documented and verified'
  const body = 'Rollback strategy documented and verified on the old API.'
  const twins = [
    rec('scheduled', 'rollback strategy', body, {}, { source: { temporal: { validFrom: FUTURE } } }),
    rec('plain', 'rollback strategy', body, {}, { source: {} }),
  ]
  const r = rankRecords(twins, { query })
  assert.equal(r.length, 2)
  assert.ok(r.every((x) => x.scores.rank_limited === undefined), 'future-valid knowledge must not be eligibility-capped')
  assert.equal(temporalState({ source: { temporal: { validFrom: FUTURE } } }), 'not_yet_effective')
})

// ── Composite purity & no-query legacy ──────────────────────────────────

test('Phase 4 fields never enter the pinned plain weighted sum', () => {
  const query = 'database migration rollback strategy'
  const plain = rec('plain', 'migration rollback', 'Rollback steps.')
  const decorated = rec('dec', 'migration rollback', 'Rollback steps.', {}, { source: { context: { os: 'some-other-os' }, temporal: { validUntil: PAST } } })
  const [p, d] = rankRecords([plain, decorated], { query })
  assert.equal(p.scores.composite, d.scores.composite, 'composite must ignore context/temporal')
  assert.equal(d.scores.applicability, 0)
  assert.equal(d.scores.temporal_validity, 0)
})

test('no-query browse: eligibility guard inactive, legacy order untouched', () => {
  // Expired record first in input, richer metadata → highest composite.
  const expiredStrong = rec('expired-strong', 'rollback strategy', 'Rollback strategy.', { evidence: [{ path: 'a.md' }, { path: 'b.md' }] }, { source: { temporal: { validUntil: PAST }, context: { os: 'some-other-os' } } })
  const currentWeak = rec('current-weak', 'rollback strategy', 'Rollback strategy.')
  const r = rankRecords([expiredStrong, currentWeak], {})
  assert.equal(r[0].id, 'expired-strong') // legacy chain order, guard off
  assert.ok(r.every((x) => x.scores.rank_limited === undefined))
  assert.ok(r.every((x) => x.scores.rrf === 0 && x.scores.fusion === x.scores.composite))
})

// ── §11 exposure ────────────────────────────────────────────────────────

test('§11: record views expose temporal + context; remember schema documents them', async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'veyra-m4-'))
  t.after(() => { closeAllStores(); rmSync(home, { recursive: true, force: true }) })
  const runtime = { veyraHome: home, fallbackCwd: process.cwd(), codeEngine: new CodeIntelligenceEngine({ exePath: '/nonexistent/bin' }) }
  const defs = buildToolDefinitions(runtime)
  const tools = new Map(defs.map((x) => [x.name, x]))
  assert.equal(tools.size, 16, 'tool surface stays frozen')

  // Schema documents the §12/§13 surface on both the input and the view.
  const rememberDef = tools.get('veyra_remember')
  assert.ok(rememberDef.parameters.validFrom, 'validFrom param documented')
  assert.ok(rememberDef.parameters.validUntil, 'validUntil param documented')
  assert.ok(rememberDef.parameters.context, 'context param documented')
  const outJson = JSON.stringify(rememberDef.output)
  assert.ok(outJson.includes('"temporal"'), 'view schema documents temporal')
  assert.ok(outJson.includes('"context"'), 'view schema documents context')

  const exec = { agent: { session: { id: 'm4-session', workspace: process.cwd() } } }
  const written = await rememberDef.execute({ title: 'view temporal context', body: 'Expose §11 fields.', kind: 'knowledge', validUntil: PAST }, exec)
  assert.equal(written.record.temporal, 'expired')
  assert.deepEqual(written.record.context, { os: process.platform, runtime: process.version })

  const recalled = await tools.get('veyra_recall').execute({ query: 'view temporal context' }, exec)
  assert.equal(recalled.ok, true)
  assert.ok(recalled.count >= 1)
  const hit = recalled.items.find((x) => x.id === written.record.id)
  assert.ok(hit, 'remembered record is recallable')
  assert.equal(hit.temporal, 'expired')
  assert.deepEqual(hit.context, { os: process.platform, runtime: process.version })
})
