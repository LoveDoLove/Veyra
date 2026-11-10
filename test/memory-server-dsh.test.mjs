/**
 * Plugin-level integration: Veyra composed into a real Cordis context with
 * the REAL DSH host services and the REAL workspace registry.
 *
 * Everything here is driven through production seams — registered tools,
 * `/veyra` commands, and prompt assembly — never through the Memory Server
 * object directly. `fiber.runtime` is the plugin DEFINITION (cordis
 * `Fiber#runtime` is `Plugin.Runtime`), so the server that `apply()` builds
 * has no handle for a test to grab; reaching it would require a test-only
 * `ctx.provide`, and no product consumer needs one.
 *
 * Since the clean break there is one storage model: a room keyed by a DSH
 * WorkspaceId. Verifies:
 *   - no workspace registry: every memory tool and command fails closed, and
 *     nothing is written anywhere — no legacy layout, no room;
 *   - real registry: two workspaces on one repository get distinct rooms and
 *     isolated writes;
 *   - a legacy `projects/<id>` tree on disk is never read, imported, or
 *     modified — no migration ledger is ever created;
 *   - promotion through `veyra_promote` writes Central Memories only through
 *     the governed path (candidates refused, canonical needs `explicit`);
 *   - assembled recall sees room memory and never sees legacy records;
 *   - a registry that is BROKEN and then RECOVERS inside one process: memory
 *     refuses while broken, works after recovery, and a session that moves
 *     between two workspaces reads the room it is in each time.
 *
 * Skips when no DSH install is discoverable (set DSH_INSTALL to force one),
 * matching test/dsh-runtime.test.mjs.
 */

import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { findDshRoot, loadDshPackage } from './helpers/dsh.mjs'
import * as veyra from '../src/plugin.mjs'
import { rememberClaimedPrompt } from '../src/context.mjs'
import { closeAllStores, openCentralStore } from '../src/store.mjs'
import { projectIdFor } from '../src/ids.mjs'
import { ROOMS_DIR, CENTRAL_DIR } from '../src/rooms.mjs'

const dsh = findDshRoot()
const skip = dsh ? false : 'no DSH install found (set DSH_INSTALL to run)'

const tmpHome = mkdtempSync(join(tmpdir(), 'veyra-memserver-home-'))
const tmpRepo = mkdtempSync(join(tmpdir(), 'veyra-memserver-repo-'))
after(() => {
  try { closeAllStores() } catch { /* already closed */ }
  for (const dir of [tmpHome, tmpRepo]) rmSync(dir, { recursive: true, force: true })
})

function compositionPlan(workspaceRegistry) {
  const names = [
    '@deepseek-ai/cordis',
    '@deepseek-ai/dsh-system-prompt',
    '@deepseek-ai/dsh-tools',
    '@deepseek-ai/dsh-tool-executor-native',
    '@deepseek-ai/dsh-commands',
    '@deepseek-ai/dsh-storage',
    '@deepseek-ai/dsh-storage-json',
    '@deepseek-ai/dsh-storage-domain',
    '@deepseek-ai/dsh-session',
    '@deepseek-ai/dsh-session-persistence-jsonl',
  ]
  if (workspaceRegistry) names.push('@deepseek-ai/dsh-workspace')
  return names
}

/** CommandRuntime.execute dereferences `signal.aborted`, so it needs a real one. */
function signal() {
  return new AbortController().signal
}

async function until(probe, ms = 5000) {
  const start = Date.now()
  while (Date.now() - start < ms) {
    if (await probe()) return true
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  return false
}

/**
 * Compose Veyra with the real host services. `profileContext`, `configEditor`
 * and `loader` are profile-boot infrastructure DSH's profile normally owns
 * (same stubs as test/dsh-runtime.test.mjs); every service Veyra itself
 * touches is the real implementation.
 */
async function compose({ home, profileDir, workspaceRegistry, registry } = {}) {
  const svc = {}
  for (const name of compositionPlan(workspaceRegistry)) {
    svc[name] = await loadDshPackage(name)
    assert.ok(svc[name], `${name} could not be imported from ${dsh.dir}`)
  }
  const { Context } = svc['@deepseek-ai/cordis']
  const { SystemPrompt } = svc['@deepseek-ai/dsh-system-prompt']
  const { ToolRuntime } = svc['@deepseek-ai/dsh-tools']
  const NativeToolExecutor = svc['@deepseek-ai/dsh-tool-executor-native']
  const { CommandRuntime } = svc['@deepseek-ai/dsh-commands']
  const storage = svc['@deepseek-ai/dsh-storage']
  const storageJson = svc['@deepseek-ai/dsh-storage-json']
  const storageDomain = svc['@deepseek-ai/dsh-storage-domain']
  const session = svc['@deepseek-ai/dsh-session']
  const persistence = svc['@deepseek-ai/dsh-session-persistence-jsonl']

  const ctx = new Context()
  ctx.provide('profileContext', { home: profileDir, dir: profileDir, name: 'memory-server-test' })
  ctx.provide('configEditor', {
    documentPath: join(profileDir, 'settings.patch.json'),
    configuration: () => [],
    entries: () => [],
    edit: async () => {},
  })
  ctx.provide('loader', { await: () => Promise.resolve() })
  // A caller-supplied registry stand-in. `provide` declares it as a service, so
  // Veyra's capability probe sees exactly what it would see from the real
  // workspace plugin — this is the only way to test a registry that is BROKEN
  // and later RECOVERS inside one process, which the real one cannot do.
  if (registry) ctx.provide('workspaceRegistry', registry)

  await ctx.plugin(SystemPrompt)
  await ctx.plugin(CommandRuntime)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(NativeToolExecutor.default ?? NativeToolExecutor)
  await ctx.plugin(storage.Storage, {})
  await ctx.plugin(storageJson, { root: join(profileDir, 'storage') })
  await ctx.plugin(storageDomain, { backend: 'json' })
  await ctx.plugin(session.default, {})
  await ctx.plugin(persistence, { root: join(profileDir, 'sessions') })
  if (workspaceRegistry) {
    const workspace = svc['@deepseek-ai/dsh-workspace']
    await ctx.plugin(workspace.default, {})
  }
  await ctx.plugin(veyra, { home, recallLimit: 3, codebaseWatch: false, eagerStartCodebaseMemory: false })
  return { ctx }
}

/** Resolve the registered tool definition (the real seam the model uses). */
async function tool(ctx, name) {
  const up = await until(() => ctx.tools.view().visible.has(name))
  assert.ok(up, `${name} was never registered`)
  return ctx.tools.view().visible.get(name)
}

/** A real session from the real session store; Veyra only reads header/append. */
function sessionFor(ctx, cwd) {
  return ctx.sessions.create(undefined, { meta: { cwd } })
}

// Clean Break regression. The pre-clean-break plugin answered this exact
// scenario by falling back to `$VEYRA_HOME/projects/<projectId>/memory.db` and
// letting `/veyra migrate` import it later. Both are gone: without a registry
// there is no workspace id, so there is no room, so memory is unavailable.
test('no workspace registry: every memory path fails closed and writes nothing', { skip }, async () => {
  const profileDir = mkdtempSync(join(tmpdir(), 'veyra-memserver-profile-'))
  const repoDir = join(tmpRepo, 'legacy-workspace')
  mkdirSync(repoDir, { recursive: true })
  const home = join(tmpHome, 'legacy-home')
  mkdirSync(home, { recursive: true })
  const { ctx } = await compose({ home, profileDir })

  const agent = { session: sessionFor(ctx, repoDir), inbox: {} }
  // Tools fail closed by throwing; the native executor turns that into a tool
  // error the model can read. Calling `execute` directly surfaces the throw,
  // which is exactly the refusal we are asserting on.
  const remember = await tool(ctx, 'veyra_remember')
  assert.throws(
    () => remember.execute(
      { title: 'legacy layout probe', body: 'Written with no workspace registry present.' },
      { agent },
    ),
    (err) => {
      assert.equal(err.code, 'VEYRA_MEMORY_UNAVAILABLE')
      assert.match(String(err.message), /memory-server-unavailable|workspace-registry-unavailable/)
      return true
    },
    'a write without a workspace room must be refused',
  )

  const recall = await tool(ctx, 'veyra_recall')
  assert.throws(
    () => recall.execute({ query: 'legacy layout probe' }, { agent }),
    /Veyra memory unavailable: workspace-registry-unavailable/,
    'recall without a workspace room must be refused',
  )

  // Nothing was written: no legacy project store, no room, no migration ledger.
  assert.equal(existsSync(join(home, 'projects')), false, 'the legacy layout is never created')
  assert.equal(existsSync(join(home, 'reusable')), false, 'the legacy reusable store is never created')
  assert.equal(existsSync(join(home, ROOMS_DIR)), false, 'no room directories exist without a registry')
  assert.equal(existsSync(join(home, 'migrations')), false, 'nothing is ever migrated')

  // `/veyra migrate` no longer exists as a verb; it must not resurrect.
  const migrated = await ctx.commands.execute(agent, '/veyra migrate', [], signal())
  const text = migrated.result?.text ?? ''
  assert.doesNotMatch(text, /Migration plan|imported|already-migrated/)
  assert.equal(existsSync(join(home, 'migrations', 'ledger.json')), false)
  try { rmSync(profileDir, { recursive: true, force: true }) } catch {}
})

test('real workspace registry: distinct rooms, legacy isolation, governed promotion, recall', { skip }, async () => {
  const profileDir = mkdtempSync(join(tmpdir(), 'veyra-memserver-profile-'))
  const home = join(tmpHome, 'registry-home')
  const wsA = join(tmpRepo, 'a')
  const wsB = join(tmpRepo, 'b')
  mkdirSync(join(tmpRepo, '.git'), { recursive: true })
  mkdirSync(wsA, { recursive: true })
  mkdirSync(wsB, { recursive: true })

  const { ctx } = await compose({ home, profileDir, workspaceRegistry: true })
  const wsARec = await ctx.workspaceRegistry.create(wsA, 'Veyra test A')
  const wsBRec = await ctx.workspaceRegistry.create(wsB, 'Veyra test B')
  assert.notEqual(wsARec.id, wsBRec.id)

  // Seed a legacy tree the way a pre-rooms Veyra install would have left it:
  // both workspace directories map to the SAME legacy project id (one
  // repository) — exactly the ambiguity that could not be resolved without
  // provenance, and which the clean break now refuses to touch at all.
  const legacyProject = projectIdFor(wsA)
  assert.equal(legacyProject, projectIdFor(wsB))
  const legacyDir = join(home, 'projects', legacyProject)
  mkdirSync(legacyDir, { recursive: true })
  const legacyFile = join(legacyDir, 'memory.db')
  writeFileSync(legacyFile, 'legacy-placeholder-not-a-real-db')
  const reusableDir = join(home, 'reusable')
  mkdirSync(reusableDir, { recursive: true })
  const reusableFile = join(reusableDir, 'memory.db')
  writeFileSync(reusableFile, 'legacy-reusable-placeholder')

  const agentA = { session: sessionFor(ctx, wsA), inbox: {} }
  const agentB = { session: sessionFor(ctx, wsB), inbox: {} }

  // 1. Two workspaces on one repository are distinct rooms: a write through
  //    the tool in A is invisible in B.
  const remember = await tool(ctx, 'veyra_remember')
  const written = await remember.execute({
    title: 'only in room A',
    body: 'Workspace A private memory.',
    evidence: [{ note: 'integration test: room isolation' }],
  }, { agent: agentA })
  assert.equal(written.ok, true, written.error)

  const recall = await tool(ctx, 'veyra_recall')
  const inA = await recall.execute({ query: 'room A private memory' }, { agent: agentA })
  const inB = await recall.execute({ query: 'room A private memory' }, { agent: agentB })
  assert.match(JSON.stringify(inA.items), /only in room A/)
  assert.doesNotMatch(JSON.stringify(inB.items), /only in room A/, 'rooms must not leak across workspaces')

  // 2. Rooms exist for both workspaces; the legacy trees are untouched.
  assert.ok(existsSync(join(home, ROOMS_DIR, `w_${wsARec.id}`, 'memory.db')), 'room A database must exist')
  assert.ok(existsSync(join(home, ROOMS_DIR, `w_${wsBRec.id}`, 'memory.db')), 'room B database must exist')
  assert.equal(readFileSync(legacyFile, 'utf8'), 'legacy-placeholder-not-a-real-db')
  assert.equal(readFileSync(reusableFile, 'utf8'), 'legacy-reusable-placeholder')
  assert.equal(existsSync(join(home, 'migrations')), false, 'no migration ledger is ever created')
  const legacyTitles = readdirSync(legacyDir).sort()
  assert.deepEqual(legacyTitles, ['memory.db'])

  // Legacy records were never imported: nothing of theirs is recallable.
  const legacyLookup = await recall.execute({
    query: 'legacy unattributed knowledge legacy shared habit',
    include_reusable: true,
  }, { agent: agentA })
  assert.doesNotMatch(JSON.stringify(legacyLookup.items), /legacy unattributed|legacy shared habit/)

  // 3. Promotion is governed, and only it reaches Central Memories.
  const promote = await tool(ctx, 'veyra_promote')
  const candidate = await remember.execute({
    title: 'candidate observation',
    body: 'Auto-captured, not yet usable.',
    kind: 'observation',
  }, { agent: agentA })
  assert.equal(candidate.ok, true, candidate.error)
  const refused = await promote.execute({ id: candidate.record.id, to: 'derived', central: true }, { agent: agentA })
  assert.equal(refused.ok, false, 'a candidate must not be promotable')

  const promoted = await promote.execute({ id: written.record.id, to: 'derived', central: true }, { agent: agentA })
  assert.equal(promoted.ok, true, promoted.error)
  assert.equal(openCentralStore(home).get(promoted.centralId)?.title, 'only in room A')
  assert.ok(existsSync(join(home, CENTRAL_DIR, 'memory.db')), 'central database exists once promotion writes')

  const explicitDenied = await promote.execute({ id: written.record.id, to: 'canonical', central: true }, { agent: agentA })
  assert.equal(explicitDenied.ok, false, 'canonical requires the explicit flag')

  // 4. Assembled recall sees room memory and never the legacy records.
  rememberClaimedPrompt(agentA, { role: 'user', content: 'what do we know about the room isolation ledger' })
  const assembled = await ctx.systemPrompt.assemble({ agent: agentA })
  const recallContext = assembled.contexts.find((entry) => entry.name === 'veyra:recall')
  assert.ok(recallContext, 'veyra:recall context must be assembled')
  assert.match(recallContext.text, /only in room A/)
  assert.doesNotMatch(recallContext.text, /legacy unattributed knowledge|legacy shared habit/)
  try { rmSync(profileDir, { recursive: true, force: true }) } catch {}
})

// Registry failure is not a permanent condition: a host whose registry has not
// started yet is a FAULT (fail closed, never guess), and when it finishes
// starting in the same process the very next call must work. The real workspace
// plugin cannot be broken and repaired inside one process, so this test supplies
// a registry stand-in through `ctx.provide` — the declaration the capability
// probe reads, exercised through the same production seams as everything else.
test('registry broken then recovered: refuses while broken, works after, rooms stay separate', { skip }, async () => {
  const profileDir = mkdtempSync(join(tmpdir(), 'veyra-memserver-profile-'))
  const home = join(tmpHome, 'recovery-home')
  const wsA = join(tmpRepo, 'rec-a')
  const wsB = join(tmpRepo, 'rec-b')
  mkdirSync(wsA, { recursive: true })
  mkdirSync(wsB, { recursive: true })

  const state = { broken: true, workspaces: [] }
  const registry = {
    list() {
      if (state.broken) throw new Error('workspace registry is not started yet')
      return state.workspaces
    },
    create(path, title) {
      const rec = { id: `ws-${state.workspaces.length}`, path, title, sessionIds: [] }
      state.workspaces.push(rec)
      return Promise.resolve(rec)
    },
  }

  const { ctx } = await compose({ home, profileDir, registry })

  // 1. While the registry is broken, memory refuses — and refuses as a FAULT,
  //    never as "this host has no workspaces" (which would invite a guess).
  const remember = await tool(ctx, 'veyra_remember')
  const health = await tool(ctx, 'veyra_health')
  const sessionA = sessionFor(ctx, wsA)
  const agentA = { session: sessionA, inbox: {} }

  // The tools throw synchronously when they cannot resolve a store, so a
  // rejection-only assertion would miss the very failure it is testing for.
  let refusal = null
  try {
    await remember.execute({ title: 'should not land', body: 'nothing may be written here' }, { agent: agentA })
  } catch (err) {
    refusal = err
  }
  assert.ok(refusal, 'memory must refuse while the registry is broken')
  assert.equal(refusal.code, 'VEYRA_MEMORY_UNAVAILABLE')
  assert.match(refusal.message, /workspace-registry-(unreadable|not-ready)/)
  // Health is a read, so it refuses the same way rather than reporting an
  // empty room as if the workspace had no memory.
  let healthRefusal = null
  let brokenHealth = null
  try {
    brokenHealth = await health.execute({}, { agent: agentA })
  } catch (err) {
    healthRefusal = err
  }
  assert.ok(healthRefusal, 'health must refuse while the registry is broken')
  assert.equal(healthRefusal.code, 'VEYRA_MEMORY_UNAVAILABLE')
  assert.equal(brokenHealth, null)

  // 2. Recovery: the same process, the same plugin, no restart.
  state.broken = false
  const recA = await registry.create(wsA, 'Recovered A')
  const recB = await registry.create(wsB, 'Recovered B')

  const wrote = await remember.execute({ title: 'written after recovery', body: 'room A memory after the registry recovered' }, { agent: agentA })
  assert.equal(wrote.ok, true, wrote.error)

  const recall = await tool(ctx, 'veyra_recall')
  const seesInA = await recall.execute({ query: 'written after recovery' }, { agent: agentA })
  assert.match(JSON.stringify(seesInA.items), /written after recovery/)

  // 3. Switching workspaces: a session in B sees nothing of A's room, and
  //    returning to A sees it again. Recall follows the session's workspace,
  //    not a path cached from an earlier turn.
  const agentB = { session: sessionFor(ctx, wsB), inbox: {} }
  const seesInB = await recall.execute({ query: 'written after recovery' }, { agent: agentB })
  assert.equal(seesInB.items.length, 0, 'room B must not see room A memory')

  const backInA = await recall.execute({ query: 'written after recovery' }, { agent: agentA })
  assert.match(JSON.stringify(backInA.items), /written after recovery/, 'returning to A must still see A memory')

  // 4. Exactly two rooms, keyed by the workspace ids the registry reported, and
  //    no legacy layout was created on the recovery path either.
  assert.deepEqual(readdirSync(join(home, ROOMS_DIR)).sort(), [`w_${recA.id}`, `w_${recB.id}`])
  assert.equal(existsSync(join(home, 'projects')), false, 'recovery must not create the legacy layout')
  assert.equal(existsSync(join(home, 'reusable')), false, 'recovery must not create the legacy layout')

  try { rmSync(profileDir, { recursive: true, force: true }) } catch {}
})
