/**
 * Phase 8 — Forgetting and Protection (GOAL.md §22, §23).
 *
 * §22: forgetting is not unconditional deletion. Every retirement action
 * (invalidate / supersede / forget / tombstone) preserves historical
 * reasoning — what was invalidated, when, why, what contradicted it, what
 * replaced it — in a bounded `source.lifecycle` trail, while obsolete
 * knowledge leaves active retrieval.
 *
 * §23: protection is selective. A protected record cannot be forgotten or
 * tombstoned without an explicit override (with the reason recorded), but
 * protection must NOT block a truth claim: a protected record can still be
 * invalidated or superseded. Canonical authority is implicitly protected;
 * an explicit unprotect mark cannot lift that tier.
 *
 * Ported guard semantics: dsh-memory `md_cg/protect.py` (guard_forget /
 * guard_overwrite / ProtectionError) — here the guard is in-record
 * (`source.lifecycle` audit entries) instead of a separate audit file.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { openEphemeralStore, openProjectStore, closeAllStores } from '../src/store.mjs'
import { projectIdFor } from '../src/ids.mjs'
import {
  forget, invalidate, protect, protectionOf, supersede, tombstone, unprotect,
} from '../src/lifecycle.mjs'
import {
  AUTHORITIES, CONFIDENCES, KINDS, RELATIONS, SCOPES, STATUSES, VALIDATIONS,
  isLifecycleEligible, isRecallEligible,
} from '../src/types.mjs'
import { provenanceChain } from '../src/context.mjs'
import { memoryHealth } from '../src/health.mjs'
import { handleVeyraCommand } from '../src/commands.mjs'
import { buildToolDefinitions } from '../src/tools.mjs'

let putSeq = 0
function putRec(store, over = {}, opts = {}) {
  // Unique title+body per call: the store's verbatim-duplicate guard merges
  // identical neighbors, which would collapse fixture records into one.
  putSeq += 1
  return store.put({
    title: `Decision: retire the legacy token refresh path #${putSeq}`,
    body: `Refresh tokens must rotate on every use; the legacy silent-renew path is being retired. Variant ${putSeq}.`,
    kind: KINDS.MEMORY,
    authority: AUTHORITIES.DERIVED,
    validation: VALIDATIONS.UNVERIFIED,
    confidence: CONFIDENCES.LOW,
    scope: SCOPES.PROJECT,
    projectId: 'test',
    tags: [],
    relations: [],
    evidence: [],
    source: {},
    ...over,
  }, opts).record
}

// ============================================================ §22 forget with history

test('§22: forget records why/when, leaves recall, stays inspectable', () => {
  const store = openEphemeralStore()
  const rec = putRec(store)
  assert.equal(isRecallEligible(rec), true)

  const res = forget(store, rec.id, { why: 'obsolete after v2 API' })
  assert.equal(res.ok, true)

  const after = store.get(rec.id)
  assert.ok(after, 'forgotten record remains inspectable via store.get')
  assert.equal(after.forgotten, true)
  assert.equal(isLifecycleEligible(after), false, 'forgotten record leaves the lifecycle gate')
  assert.equal(isRecallEligible(after), false, 'forgotten record leaves active recall')

  const trail = after.source.lifecycle
  assert.equal(trail.length, 1)
  assert.equal(trail[0].action, 'forget')
  assert.equal(trail[0].why, 'obsolete after v2 API')
  assert.match(trail[0].at, /^\d{4}-\d{2}-\d{2}T/, 'when is recorded as an ISO timestamp')

  // Default listing excludes it; the record is recoverable only by id.
  assert.ok(!store.list({ limit: 50 }).some((r) => r.id === rec.id))

  // Missing record is an error, not a silent no-op.
  assert.deepEqual(forget(store, 'vey_missing', { why: 'x' }), { ok: false, error: 'not found' })
})

// ============================================================ §23 protection tiers

test('§23: explicit protection blocks forget without override; override reason is audited', () => {
  const store = openEphemeralStore()
  const rec = putRec(store)
  const p = protect(store, rec.id, { reason: 'load-bearing constraint' })
  assert.equal(p.ok, true)
  assert.deepEqual(protectionOf(store.get(rec.id)), { protected: true, why: 'load-bearing constraint' })

  const denied = forget(store, rec.id, { why: 'cleanup' })
  assert.equal(denied.ok, false)
  assert.match(denied.error, /protected/)
  assert.match(denied.error, /load-bearing constraint/, 'the guard names why protection applies')
  assert.match(denied.error, /override/, 'the guard says how to proceed')
  assert.equal(store.get(rec.id).forgotten, false, 'denied forget changes nothing')

  const allowed = forget(store, rec.id, { override: true, why: 'superseded by config flag' })
  assert.equal(allowed.ok, true)
  const after = store.get(rec.id)
  assert.equal(after.forgotten, true)
  const last = after.source.lifecycle.at(-1)
  assert.equal(last.action, 'forget')
  assert.equal(last.why, 'superseded by config flag')
  assert.equal(protectionOf(after).protected, true, 'protection mark survives the override')
})

test('§23: canonical authority is implicitly protected; unprotect cannot lift that tier', () => {
  const store = openEphemeralStore()
  const rec = putRec(store, { authority: AUTHORITIES.CANONICAL }, { explicitCanonical: true })
  assert.deepEqual(protectionOf(rec), { protected: true, why: 'canonical authority' })

  const denied = forget(store, rec.id, { why: 'x' })
  assert.equal(denied.ok, false)
  assert.match(denied.error, /canonical authority/)

  // A recorded unprotect attempt must not demote the truth tier (§32: no
  // silent authority changes) — it reports the record is still protected.
  const u = unprotect(store, rec.id)
  assert.equal(u.ok, true)
  assert.equal(u.stillProtected, true, 'unprotect reports the canonical tier still guards')
  assert.equal(protectionOf(store.get(rec.id)).protected, true)
  assert.equal(forget(store, rec.id, { why: 'x' }).ok, false)

  // Explicit override remains the only way out.
  assert.equal(forget(store, rec.id, { override: true, why: 'project archived' }).ok, true)
})

test('§23: protect/unprotect round-trip writes audit entries both ways', () => {
  const store = openEphemeralStore()
  const rec = putRec(store)

  const p = protect(store, rec.id, { reason: 'invariant used by onboarding' })
  assert.equal(p.ok, true)
  let after = store.get(rec.id)
  assert.deepEqual(protectionOf(after), { protected: true, why: 'invariant used by onboarding' })
  assert.match(after.source.protection.at, /^\d{4}-\d{2}-\d{2}T/, 'mark records when it was set')
  let last = after.source.lifecycle.at(-1)
  assert.equal(last.action, 'protect')
  assert.equal(last.why, 'invariant used by onboarding')

  const u = unprotect(store, rec.id, { reason: 'onboarding rewritten' })
  assert.equal(u.ok, true)
  assert.equal(u.stillProtected, false)
  after = store.get(rec.id)
  assert.equal(protectionOf(after).protected, false)
  assert.equal(after.source.protection.protected, false, 'unprotect keeps the mark, flips the flag')
  last = after.source.lifecycle.at(-1)
  assert.equal(last.action, 'unprotect')
  assert.equal(last.why, 'onboarding rewritten')
  assert.equal(unprotect(store, 'vey_missing').ok, false)
  assert.equal(protect(store, 'vey_missing', {}).ok, false)
})

// ============================================================ §22/§23 invalidate & supersede

test('§22/§23: invalidate preserves why/contradictedBy/replacedBy and works on protected records', () => {
  const store = openEphemeralStore()
  const a = putRec(store)
  const b = putRec(store)
  protect(store, a.id, { reason: 'still relevant' })

  const inv = invalidate(store, a.id, {
    why: 'method removed in v3',
    contradictedBy: b.id,
    replacedBy: b.id,
  })
  assert.equal(inv.ok, true)

  const after = store.get(a.id)
  assert.equal(after.validation, VALIDATIONS.INVALID)
  assert.equal(isLifecycleEligible(after), false, 'invalid leaves active retrieval')
  assert.equal(protectionOf(after).protected, true, 'protection does not block invalidation (§23)')
  const last = after.source.lifecycle.at(-1)
  assert.equal(last.action, 'invalidate')
  assert.equal(last.why, 'method removed in v3')
  assert.equal(last.contradictedBy, b.id, 'what contradicted it')
  assert.equal(last.replacedBy, b.id, 'what replaced it')

  // Idempotent: second invalidate reports already, adds no entry.
  const lenBefore = store.get(a.id).source.lifecycle.length
  const again = invalidate(store, a.id, { why: 'second' })
  assert.equal(again.ok, true)
  assert.equal(again.already, true)
  assert.equal(store.get(a.id).source.lifecycle.length, lenBefore)
  assert.equal(invalidate(store, 'vey_missing').ok, false)
})

test('§22: supersede links the replacement, protects direction, and is idempotent', () => {
  const store = openEphemeralStore()
  const a = putRec(store)
  const b = putRec(store)
  protect(store, a.id, { reason: 'protected yet retireable' })

  const sup = supersede(store, a.id, b.id, { why: 'redesigned pipeline' })
  assert.equal(sup.ok, true)

  const after = store.get(a.id)
  assert.equal(after.status, STATUSES.SUPERSEDED)
  assert.equal(isLifecycleEligible(after), false, 'superseded leaves active retrieval')
  const edges = after.relations.filter((r) => r.type === RELATIONS.SUPERSEDES)
  assert.equal(edges.length, 1, 'exactly one supersedes edge on the retired record')
  assert.equal(edges[0].targetId, b.id)
  assert.equal(store.get(b.id).relations.filter((r) => r.type === RELATIONS.SUPERSEDES).length, 0,
    'replacement carries no supersedes edge (M1 direction contract)')
  const last = after.source.lifecycle.at(-1)
  assert.equal(last.action, 'supersede')
  assert.equal(last.replacedBy, b.id)
  assert.equal(last.why, 'redesigned pipeline')
  assert.equal(protectionOf(after).protected, true, 'protection does not block supersession (§23)')

  // Idempotent: no duplicate edge, no duplicate history entry.
  const lenBefore = store.get(a.id).source.lifecycle.length
  const again = supersede(store, a.id, b.id, { why: 'redesigned pipeline' })
  assert.equal(again.ok, true)
  assert.equal(again.already, true)
  assert.equal(store.get(a.id).source.lifecycle.length, lenBefore)
  assert.equal(store.get(a.id).relations.filter((r) => r.type === RELATIONS.SUPERSEDES).length, 1)

  // Guards: self-replacement and unknown replacement are refused.
  assert.equal(supersede(store, a.id, a.id).ok, false)
  assert.equal(supersede(store, a.id, 'vey_missing').ok, false)
  assert.equal(supersede(store, 'vey_missing', b.id).ok, false)
})

// ============================================================ §22 tombstone

test('§22: tombstone retires to historical with a reason, stays inspectable, obeys the guard', () => {
  const store = openEphemeralStore()
  const rec = putRec(store)
  protect(store, rec.id, { reason: 'legacy migration note' })

  const denied = tombstone(store, rec.id, { why: 'old practice' })
  assert.equal(denied.ok, false)
  assert.match(denied.error, /protected/)

  const ok = tombstone(store, rec.id, { override: true, why: 'old practice' })
  assert.equal(ok.ok, true)
  const after = store.get(rec.id)
  assert.equal(after.status, STATUSES.HISTORICAL)
  assert.equal(after.forgotten, false, 'tombstone is not deletion — the record stays inspectable')
  assert.equal(isLifecycleEligible(after), false, 'historical leaves active retrieval')
  const last = after.source.lifecycle.at(-1)
  assert.equal(last.action, 'tombstone')
  assert.equal(last.why, 'old practice')

  // Guard-first on repeats: the record is still explicitly protected, so an
  // unprivileged re-tombstone fails closed even though it would be a no-op.
  const againDenied = tombstone(store, rec.id, { why: 'again' })
  assert.equal(againDenied.ok, false)
  assert.match(againDenied.error, /protected/)

  // With override the repeat is an idempotent no-op: already, no new entry.
  const again = tombstone(store, rec.id, { override: true, why: 'again' })
  assert.equal(again.ok, true)
  assert.equal(again.already, true)
  assert.equal(store.get(rec.id).source.lifecycle.length, 2, 'already adds no third entry')

  // Unprotected tombstone needs no override.
  const plain = putRec(store)
  assert.equal(tombstone(store, plain.id, { why: 'archive' }).ok, true)
  assert.equal(store.get(plain.id).status, STATUSES.HISTORICAL)
})

// ============================================================ trail bound

test('§22: the lifecycle trail is bounded to 10 entries, oldest roll off', () => {
  const store = openEphemeralStore()
  const rec = putRec(store)
  for (let i = 0; i < 12; i += 1) protect(store, rec.id, { reason: `round ${i}` })
  const trail = store.get(rec.id).source.lifecycle
  assert.equal(trail.length, 10, 'trail is capped')
  assert.match(trail[0].why, /^round 2$/, 'oldest entries rolled off')
  assert.match(trail.at(-1).why, /^round 11$/)
})

// ============================================================ §22 surfaced in provenance chain

test('§22: provenanceChain surfaces lifecycle reasoning without duplicating relation detail', () => {
  const store = openEphemeralStore()

  // invalidate → validation-demotion row + why/contradictedBy/replacedBy.
  const a = putRec(store)
  const b = putRec(store)
  invalidate(store, a.id, { why: 'method removed', contradictedBy: b.id, replacedBy: b.id })
  let row = provenanceChain(store.get(a.id)).at(-1)
  assert.equal(row.stage, 'Update/Supersession')
  assert.match(row.detail, /validation demoted to invalid/)
  assert.match(row.detail, /invalidate @ \d{4}-/, 'when is surfaced')
  assert.match(row.detail, /method removed/, 'why is surfaced')
  assert.match(row.detail, /contradicted by vey_/, 'what contradicted it is surfaced')
  assert.match(row.detail, /replaced by vey_/, 'what replaced it is surfaced')

  // supersede → the relation row already says "replaced by X"; the lifecycle
  // enrichment must not append it a second time.
  const c = putRec(store)
  const d = putRec(store)
  supersede(store, c.id, d.id, { why: 'pipeline v2' })
  row = provenanceChain(store.get(c.id)).at(-1)
  assert.match(row.detail, /retired — replaced by vey_/)
  assert.equal(row.detail.match(/replaced by/g).length, 1, 'no duplicate replaced-by detail')
  assert.match(row.detail, /supersede @ \d{4}-/)
  assert.match(row.detail, /pipeline v2/)

  // forget → soft-deleted row + forget entry.
  const e = putRec(store)
  forget(store, e.id, { why: 'stale duplicate' })
  row = provenanceChain(store.get(e.id)).at(-1)
  assert.match(row.detail, /forgotten \(soft-deleted, off recall\)/)
  assert.match(row.detail, /forget @ \d{4}-/)
  assert.match(row.detail, /stale duplicate/)

  // tombstone → historical row + tombstone entry.
  const f = putRec(store)
  tombstone(store, f.id, { why: 'retired practice' })
  row = provenanceChain(store.get(f.id)).at(-1)
  assert.match(row.detail, /status historical/)
  assert.match(row.detail, /tombstone @ \d{4}-/)
  assert.match(row.detail, /retired practice/)

  // Records without a lifecycle trail render exactly as before (no change
  // to the stage-9 branches).
  const plain = putRec(store)
  const plainRow = provenanceChain(plain).at(-1)
  assert.equal(plainRow.detail, 'no update, retirement, or invalidation yet')
})

// ============================================================ /veyra commands

test('/veyra: forget/invalidate/supersede/tombstone/protect/unprotect verbs end-to-end', () => {
  const dir = mkdtempSync(join(tmpdir(), 'veyra-m10-cmd-'))
  const cwd = mkdtempSync(join(tmpdir(), 'veyra-m10-ws-'))
  try {
    const runtime = { veyraHome: dir, fallbackCwd: cwd, recallLimit: 5, includeReusable: true }
    const store = openProjectStore(dir, projectIdFor(cwd))
    const run = (text) => handleVeyraCommand(runtime, {
      text, agent: { session: { header: { cwd } } },
    })

    const help = run('help')
    assert.equal(help.kind, 'success')
    for (const verb of ['invalidate', 'supersede', 'tombstone', 'protect', 'unprotect', 'forget']) {
      assert.match(help.text, new RegExp(`/veyra ${verb}`), `help lists /veyra ${verb}`)
    }

    const rec = putRec(store, { projectId: projectIdFor(cwd) })
    assert.match(run(`protect ${rec.id} load-bearing`).text, /Protected/)
    const denied = run(`forget ${rec.id}`)
    assert.equal(denied.kind, 'error')
    assert.match(denied.text, /protected/)
    const done = run(`forget ${rec.id} override superseded by config`)
    assert.equal(done.kind, 'success')
    assert.match(done.text, new RegExp(`Forgot ${rec.id}`))
    const after = store.get(rec.id)
    assert.equal(after.forgotten, true)
    assert.equal(after.source.lifecycle.at(-1).why, 'superseded by config')

    const inv = putRec(store, { projectId: projectIdFor(cwd) })
    const invRes = run(`invalidate ${inv.id} because tests lie`)
    assert.equal(invRes.kind, 'success')
    const invAfter = store.get(inv.id)
    assert.equal(invAfter.validation, VALIDATIONS.INVALID)
    assert.equal(invAfter.source.lifecycle.at(-1).why, 'because tests lie')

    const from = putRec(store, { projectId: projectIdFor(cwd) })
    const to = putRec(store, { projectId: projectIdFor(cwd) })
    const badSup = run('supersede')
    assert.equal(badSup.kind, 'error')
    assert.match(badSup.text, /usage: \/veyra supersede/)
    const supRes = run(`supersede ${from.id} ${to.id} old design`)
    assert.equal(supRes.kind, 'success')
    assert.match(supRes.text, new RegExp(`Superseded ${from.id} by ${to.id}`))
    assert.equal(store.get(from.id).status, STATUSES.SUPERSEDED)

    const ts = putRec(store, { projectId: projectIdFor(cwd) })
    assert.match(run(`tombstone ${ts.id} old practice`).text, /Tombstoned/)
    assert.equal(store.get(ts.id).status, STATUSES.HISTORICAL)

    assert.match(run(`unprotect ${ts.id}`).text, /Unprotected|Unmarked/)

    // Unknown ids fail loudly on every verb.
    assert.equal(run('invalidate vey_missing').kind, 'error')
    assert.equal(run('forget vey_missing').kind, 'error')
    assert.equal(run('tombstone vey_missing').kind, 'error')
  } finally {
    closeAllStores()
    rmSync(dir, { recursive: true, force: true })
    rmSync(cwd, { recursive: true, force: true })
  }
})

// ============================================================ veyra_forget tool

test('tools: veyra_forget carries reason/override through and renders the guard', () => {
  const home = mkdtempSync(join(tmpdir(), 'veyra-m10-tool-'))
  try {
    const defs = buildToolDefinitions({ veyraHome: home, fallbackCwd: home })
    const def = defs.find((d) => d.name === 'veyra_forget')
    assert.ok(def, 'veyra_forget tool defined')

    const exec = { agent: { session: { id: 's1', header: { cwd: home } }, provider: 'deepseek', model: 'ds-test' } }
    const store = openProjectStore(home, projectIdFor(home))
    const rec = putRec(store, { projectId: projectIdFor(home) })

    // Schema surface: reason + override are declared parameters (flat DSL).
    const props = def.parameters?.properties ?? def.parameters ?? {}
    assert.ok(props.reason, 'reason parameter declared')
    assert.ok(props.override, 'override parameter declared')

    // reason is recorded in the lifecycle trail.
    const res = def.execute({ id: rec.id, reason: 'stale duplicate of config doc' }, exec)
    assert.equal(res.ok, true)
    assert.equal(res.record.id, rec.id)
    const after = store.get(rec.id)
    assert.equal(after.forgotten, true)
    assert.equal(after.source.lifecycle.at(-1).why, 'stale duplicate of config doc')

    // Protected record: refused with the guard text, rendered by output.render.
    const guard = putRec(store, { projectId: projectIdFor(home) })
    protect(store, guard.id, { reason: 'onboarding invariant' })
    const denied = def.execute({ id: guard.id, reason: 'cleanup' }, exec)
    assert.equal(denied.ok, false)
    assert.match(denied.error, /protected/)
    assert.equal(store.get(guard.id).forgotten, false)

    const rendered = def.output.render({ id: guard.id }, denied).map((b) => b.text).join('\n')
    assert.match(rendered, /protected/)
    assert.match(rendered, /onboarding invariant/)

    // override:true completes the guarded forget through the tool.
    const forced = def.execute({ id: guard.id, reason: 'project archived', override: true }, exec)
    assert.equal(forced.ok, true)
    assert.equal(store.get(guard.id).forgotten, true)

    // Missing record → explicit error, render surfaces it verbatim.
    const missing = def.execute({ id: 'vey_missing' }, exec)
    assert.equal(missing.ok, false)
    assert.equal(missing.error, 'not found')
    const missingText = def.output.render({ id: 'vey_missing' }, missing).map((b) => b.text).join('\n')
    assert.match(missingText, /not found/i)
  } finally {
    closeAllStores()
    rmSync(home, { recursive: true, force: true })
  }
})

// ============================================================ health category

test('§21+§23: health counts explicit protection marks alongside canonical authority', () => {
  const store = openEphemeralStore()
  const marked = putRec(store)
  protect(store, marked.id, { reason: 'operational invariant' })
  putRec(store, { authority: AUTHORITIES.CANONICAL, validation: VALIDATIONS.VERIFIED }, { explicitCanonical: true })
  putRec(store)

  const report = memoryHealth(store.list({ limit: 50 }), { workspace: '/tmp' })
  assert.equal(report.scanned, 3)
  assert.equal(report.categories.protected, 2, 'explicit mark + canonical authority both count')
})
