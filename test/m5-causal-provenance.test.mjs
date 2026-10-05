/**
 * Phase 5 — Causal Memory & Provenance (GOAL.md §14 / §15 / §16).
 *
 *   §14 Causal Memory          — causal retrieval prioritises VERIFIED
 *                                cause/effect chains; the chain stays a
 *                                strengthening multiplier on the existing
 *                                causal channel (verified+complete = ×1.0,
 *                                legacy byte-identical), never a rewrite of
 *                                the fusion contract.
 *   §15 Provenance             — attribution dimensions (workspace /
 *                                repository / remote / agent) stamped on
 *                                every lifecycle write, beside (never
 *                                inside) the capture-stream `origins` bag;
 *                                provenance ≠ authority and dims are NOT a
 *                                substitute for capture origins.
 *   §16 Memory Provenance Chain— read-only Observation → Evidence →
 *                                Candidate → Validation → Promotion →
 *                                Retrieval → Application → Verification →
 *                                Update/Supersession view exposed on
 *                                veyra_inspect, answering "where did this
 *                                come from, why was it trusted, what
 *                                happened when it was used" without
 *                                inventing telemetry.
 *
 * Reference `dsh-memory` has NO causal/provenance machinery to copy — these
 * are Veyra-native adaptations (Phase 5 report notes this honestly).
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { KINDS, provenanceOrigins, STATUSES } from '../src/types.mjs'
import { closeAllStores } from '../src/store.mjs'
import { findGitRoot, provenanceDimensions } from '../src/ids.mjs'
import { distillBuffer } from '../src/understand.mjs'
import { causalRelevance, rankRecords } from '../src/retrieve.mjs'
import { provenanceChain } from '../src/context.mjs'
import { provenanceAllowsLearning } from '../src/learn.mjs'
import { buildToolDefinitions } from '../src/tools.mjs'

// ---------------------------------------------------------------- fixtures

const makeBuffer = ({ user = [], assistant = [], tools = [], files = [], turn = 1 } = {}) => ({
  turn, user, assistant, tools, files: new Set(files),
})
const USER_TEXT = 'The sqlite writer race is fixed by wrapping DatabaseSync writes in a mutex around the critical section.'
const daysAgo = (d) => new Date(Date.now() - d * 86400000).toISOString()

const BASE = {
  scope: 'project',
  source: { origin: 'session', observer: 'test' },
  authority: 'derived',
  validation: 'derived',
  confidence: 0.5,
  tags: [],
  relations: [],
  evidence: [],
  kind: KINDS.MEMORY,
  createdAt: 1700000000000,
  updatedAt: 1700000000000,
}
const rec = (id, title, extra = {}) => ({ ...BASE, id, title, body: title, ...extra })

// ============================================================ §15 provenance

test('§15: provenanceDimensions stamps workspace/repository/remote/agent, unknown stays unknown', () => {
  const dims = provenanceDimensions(process.cwd(), { provider: 'deepseek', model: 'ds-test' })
  assert.equal(dims.workspace, resolve(process.cwd()), 'workspace resolves the cwd')
  const root = findGitRoot(process.cwd())
  assert.equal(dims.repository, root, 'repository follows git root discovery')
  assert.equal(dims.remote, root ? (typeof dims.remote === 'string' ? dims.remote : null) : null)
  assert.deepEqual(dims.agent, { provider: 'deepseek', model: 'ds-test' })

  // Partial agent → the other half is null, never a guessed string.
  const home = mkdtempSync(join(tmpdir(), 'veyra-m5-'))
  try {
    assert.deepEqual(provenanceDimensions(home, { provider: 'p' }).agent, { provider: 'p', model: null })
    // Non-git workspace → repository/remote null (no inference, no backfill).
    const plain = provenanceDimensions(home, undefined)
    assert.deepEqual(plain, { workspace: home, repository: null, remote: null, agent: null })
    // No cwd at all → everything null, still a valid bag.
    assert.deepEqual(provenanceDimensions(null, null), { workspace: null, repository: null, remote: null, agent: null })
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('§15: distillBuffer stamps provenance only when a cwd is supplied — legacy shape byte-identical', () => {
  const buffer = makeBuffer({ user: [USER_TEXT], tools: [{ name: 'edit', args: { file_path: 'src/store.mjs' } }] })
  const legacy = distillBuffer(buffer, { projectId: 'p_m5', sessionId: 's_m5' })
  assert.ok(legacy, 'record distilled')
  assert.deepEqual(Object.keys(legacy.source.provenance), ['origins'], 'no cwd → provenance holds exactly the capture origins')
  assert.ok(Array.isArray(legacy.source.provenance.origins))

  const cwd = mkdtempSync(join(tmpdir(), 'veyra-m5-'))
  try {
    const stamped = distillBuffer(makeBuffer({ user: [USER_TEXT] }), {
      projectId: 'p_m5', sessionId: 's_m5', cwd,
      agent: { provider: 'deepseek', model: 'ds-test' },
    })
    assert.ok(stamped, 'record distilled with cwd')
    assert.equal(stamped.source.provenance.workspace, cwd)
    assert.equal(stamped.source.provenance.repository, null, 'tmp cwd is not a git repo')
    assert.deepEqual(stamped.source.provenance.agent, { provider: 'deepseek', model: 'ds-test' })
    assert.ok(Array.isArray(stamped.source.provenance.origins), 'capture origins ride along untouched')
  } finally {
    rmSync(cwd, { recursive: true, force: true })
  }
})

test('§15: provenance ≠ authority and ≠ capture origins — dims never open the M9 gate', () => {
  // §15/§16 spine: the presence of attribution dimensions must NOT count
  // as capture provenance for the automatic learning gate.
  assert.equal(provenanceAllowsLearning({
    source: { automatic: true, provenance: { workspace: '/w', repository: '/r', remote: null, agent: { provider: 'p', model: 'm' } } },
  }), false, 'dims-only provenance fails closed — origins are the only gate currency')
  // Deliberate writes stay open regardless of dims (gate never changed).
  assert.equal(provenanceAllowsLearning({
    source: { automatic: false, tool: 'veyra_remember', provenance: { workspace: '/w', repository: null, remote: null, agent: null } },
  }), true)
})

test('§15: veyra_remember stamps attribution dimensions, never capture origins', async () => {
  const home = mkdtempSync(join(tmpdir(), 'veyra-m5-'))
  try {
    const defs = buildToolDefinitions({ veyraHome: home, fallbackCwd: home })
    const rememberDef = defs.find((d) => d.name === 'veyra_remember')
    const res = await rememberDef.execute(
      { title: 'Deliberate §15 note', body: 'A deliberately remembered note proving deliberate writes carry attribution dimensions without fabricating capture-stream origins.', scope: 'project' },
      { agent: { session: { id: 's_m5', header: { cwd: home } }, provider: 'deepseek', model: 'ds-test' } },
    )
    assert.ok(res?.record, 'deliberate write succeeded')
    assert.deepEqual(
      res.record.source.provenance,
      { workspace: home, repository: null, remote: null, agent: { provider: 'deepseek', model: 'ds-test' } },
      '§15 attribution stamped; tmp home is not a git repo so repository/remote stay null',
    )
    assert.equal(res.record.source.provenance.origins, undefined, 'origins never fabricated on deliberate writes')
    assert.equal(provenanceOrigins(res.record.source), null, 'M9 gate still reads unknown origins')
  } finally {
    closeAllStores()
    rmSync(home, { recursive: true, force: true })
  }
})

// ============================================================ §14 causal quality

// Shared symptom so both chains overlap the query IDENTICALLY — only the
// documented completeness / verification differs, which is exactly what
// the quality multiplier must decide.
const SYMPTOM = 'release builds flake when two writers race the queue'
const QUERY = 'why do release builds flake'

test('§14: a verified chain outranks a suspected one at equal query overlap', () => {
  const suspected = rec('c_suspected', 'Release flake', {
    source: { causal: { symptom: SYMPTOM, rootCause: 'two writers race the release queue' } },
  })
  const verified = rec('c_verified', 'Release flake', {
    source: { causal: {
      symptom: SYMPTOM,
      rootCause: 'two writers race the release queue',
      verifiedOutcome: 'mutex serializes the queue; flake gone in 500 runs (test-passed)',
    } },
  })
  const s = causalRelevance(QUERY, suspected)
  const v = causalRelevance(QUERY, verified)
  assert.ok(v > s, `verified (${v}) must outrank suspected (${s})`)
  assert.ok(s > 0, 'an unverified chain still participates — degraded, never zeroed')
  assert.ok(v <= 1)
})

test('§14: a fuller chain outranks a fragmentary one; unrelated queries stay 0', () => {
  const fragment = rec('c_fragment', 'Release flake', {
    source: { causal: { symptom: SYMPTOM } },
  })
  const full = rec('c_full', 'Release flake', {
    source: { causal: {
      symptom: SYMPTOM,
      rootCause: 'sqlite write contention under WAL',        // no query tokens
      remedy: 'serialize the writer with a mutex',           // no query tokens
    } },
  })
  const f = causalRelevance(QUERY, fragment)
  const c = causalRelevance(QUERY, full)
  assert.ok(c > f, `complete chain (${c}) must outrank fragment (${f})`)
  assert.ok(f > 0, 'fragments keep a nonzero floor (m3 pins causal > 0)')
  // Unrelated query: overlap ratio is 0 — quality can never resurrect a miss.
  assert.equal(causalRelevance('quantum blockchain gardening', full), 0)
  // No causal facets at all → 0 regardless of quality terms.
  assert.equal(causalRelevance(QUERY, rec('c_none', 'Release flake')), 0)
})

test('§14: rankRecords — a verified chain flips the tied pool, composite untouched', () => {
  // Identical records except the causal facets, and the verified one is
  // the OLDER — legacy recency would put the plain twin first; fusion
  // must flip exactly that tie (m3's shape, now with a verified chain).
  const older = 1700000000000
  const newer = 1700000999000
  const verifiedTwin = rec('twin_verified', 'Release flake investigation', {
    relevance: 0.8,
    createdAt: older,
    updatedAt: older,
    source: { origin: 'session', observer: 'test', causal: {
      symptom: SYMPTOM,
      rootCause: 'two writers race the release queue',
      verifiedOutcome: 'mutex serializes the queue; test-passed',
    } },
  })
  const plainTwin = rec('twin_plain', 'Release flake investigation', {
    relevance: 0.8,
    createdAt: newer,
    updatedAt: newer,
  })
  const r = rankRecords([plainTwin, verifiedTwin], { query: 'release flake writer race' })
  assert.equal(r.length, 2)
  assert.equal(r[0].id, 'twin_verified', 'verified causal chain wins the flip despite losing recency')

  // The quality multiplier participates ONLY through the causal/RRF path:
  // the pinned plain weighted-sum composite is identical for both twins.
  assert.equal(r[0].scores.composite, r[1].scores.composite, 'composite untouched — causal stays out of the weighted sum')
  assert.ok(r.find((x) => x.id === 'twin_verified').scores.causal > 0)
  assert.equal(r.find((x) => x.id === 'twin_plain').scores.causal, 0)
})

// ============================================================ §16 provenance chain

test('§16: provenanceChain returns the nine §16 stages in order with honest states', () => {
  const full = {
    id: 'vey_full',
    status: STATUSES.CURRENT,
    validation: 'verified',
    authority: 'derived',
    confidence: 'high',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-02T00:00:00.000Z',
    lastRecalledAt: '2026-01-03T00:00:00.000Z',
    evidence: [{ path: 'src/store.mjs', note: 'test-passed' }],
    relations: [],
    source: {
      automatic: true,
      sessionId: 'sess1',
      turn: 3,
      provenance: {
        origins: ['user'],
        workspace: '/w',
        repository: '/r',
        remote: 'git@example.com:x/y.git',
        agent: { provider: 'deepseek', model: 'ds-test' },
      },
    },
  }
  const chain = provenanceChain(full)
  assert.deepEqual(chain.map((x) => x.stage), [
    'Observation', 'Evidence', 'Candidate', 'Validation', 'Promotion',
    'Retrieval', 'Application', 'Verification', 'Update/Supersession',
  ])
  const by = Object.fromEntries(chain.map((x) => [x.stage, x]))
  assert.equal(by.Observation.state, 'recorded')
  for (const bit of ['sess1', 'origins [user]', '/w', 'deepseek/ds-test']) assert.ok(by.Observation.detail.includes(bit), `observation detail has ${bit}`)
  assert.equal(by.Evidence.state, 'recorded')
  assert.equal(by.Validation.state, 'recorded')
  assert.equal(by.Promotion.state, 'recorded')
  assert.ok(by.Promotion.detail.includes('derived'), 'promotion says what was actually granted')
  assert.equal(by.Retrieval.state, 'recorded')
  assert.equal(by.Retrieval.at, full.lastRecalledAt)
  // Application is deliberately untracked: memory is evidence, not instructions.
  assert.equal(by.Application.state, 'not-tracked')
  assert.equal(by.Verification.state, 'recorded')
  assert.equal(by['Update/Supersession'].state, 'none')
})

test('§16: legacy record says unknown, pending stays pending — nothing is invented', () => {
  const legacy = {
    id: 'vey_legacy',
    status: STATUSES.CURRENT,
    validation: 'candidate',
    authority: 'candidate',
    createdAt: daysAgo(30),
    updatedAt: daysAgo(30),
    evidence: [],
    relations: [],
    source: { origin: 'session', observer: 'test' },
  }
  const chain = provenanceChain(legacy)
  const by = Object.fromEntries(chain.map((x) => [x.stage, x]))
  assert.equal(by.Observation.state, 'unknown', 'no capture context → unknown, not a guess')
  assert.equal(by.Evidence.state, 'none')
  assert.equal(by.Validation.state, 'pending')
  assert.equal(by.Promotion.state, 'pending')
  assert.equal(by.Retrieval.state, 'not-yet')
  assert.equal(by.Verification.state, 'pending')
  assert.equal(by['Update/Supersession'].state, 'none')

  // Supersession: supersedes edge is directed retired → replacement (M1),
  // so an edge on THIS record means it was retired.
  const retired = provenanceChain({
    ...legacy,
    status: STATUSES.SUPERSEDED,
    relations: [{ type: 'supersedes', targetId: 'vey_replacement' }],
  })
  const upd = retired.find((x) => x.stage === 'Update/Supersession')
  assert.equal(upd.state, 'recorded')
  assert.ok(upd.detail.includes('vey_replacement'), upd.detail)

  // Forgotten and demoted records are updates too: evolve retires status
  // (deprecated/historical) and demotes the validation ladder (stale/invalid).
  assert.ok(provenanceChain({ ...legacy, forgotten: true })
    .find((x) => x.stage === 'Update/Supersession').detail.includes('forgotten'))
  assert.ok(provenanceChain({ ...legacy, status: STATUSES.DEPRECATED })
    .find((x) => x.stage === 'Update/Supersession').detail.includes('deprecated'))
  assert.ok(provenanceChain({ ...legacy, validation: 'stale' })
    .find((x) => x.stage === 'Update/Supersession').detail.includes('stale'))

  // Garbage in → nine rows out, never a throw.
  assert.equal(provenanceChain(null).length, 9)
  assert.equal(provenanceChain({}).length, 9)
})

test('§16: veyra_inspect exposes and renders the provenance chain', async () => {
  const home = mkdtempSync(join(tmpdir(), 'veyra-m5-'))
  try {
    const defs = buildToolDefinitions({ veyraHome: home, fallbackCwd: home })
    const rememberDef = defs.find((d) => d.name === 'veyra_remember')
    const exec = { agent: { session: { id: 's_chain', header: { cwd: home } }, provider: 'deepseek', model: 'ds-test' } }
    const written = await rememberDef.execute(
      { title: 'Chain probe', body: 'A deliberately remembered note whose provenance chain must be exposed verbatim by veyra_inspect.', scope: 'project' },
      exec,
    )
    assert.ok(written?.record, 'write succeeded')

    const inspectDef = defs.find((d) => d.name === 'veyra_inspect')
    const view = await inspectDef.execute({ id: written.record.id }, exec)
    assert.equal(view.ok, true, 'record inspectable')
    assert.ok(Array.isArray(view.chain), 'chain exposed on the payload')
    assert.deepEqual(view.chain.map((x) => x.stage), [
      'Observation', 'Evidence', 'Candidate', 'Validation', 'Promotion',
      'Retrieval', 'Application', 'Verification', 'Update/Supersession',
    ])
    assert.equal(view.chain[0].state, 'recorded')
    assert.ok(view.chain[0].detail.includes(home), '§15 workspace rides into the chain')

    // render returns an array of text blocks (DSH tool-output shape).
    const blocks = inspectDef.output.render({ id: written.record.id }, view)
    const card = (Array.isArray(blocks) ? blocks : [blocks]).map((b) => b?.text ?? String(b)).join('\n')
    assert.ok(card.includes('Provenance chain (§16)'), 'chain visible in the inspect card')
    assert.ok(card.includes('Application: not-tracked'), 'the evidence-not-instructions boundary is stated')
  } finally {
    closeAllStores()
    rmSync(home, { recursive: true, force: true })
  }
})
