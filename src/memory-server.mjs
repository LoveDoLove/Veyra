/**
 * Veyra — long-lived in-process Memory Server.
 *
 * One instance is created per Cordis plugin lifecycle and lives as long as the
 * DSH Web host process. It owns:
 *
 *   - the WorkspaceResolver (session/path → authoritative workspace binding);
 *   - the MemoryRouter (operation → allowed storage targets);
 *   - one private Memory Room per DSH workspace;
 *   - the single shared Central Memories store;
 *   - governed promotion into Central Memories.
 *
 * It does not run a daemon, timer, or background job. All work happens on the
 * call path that needs it, so observation/recall failures degrade to an empty
 * result and never break the agent loop. Store handles are the cached ones from
 * `store.mjs`; `closeAllStores()` remains the single disposal point.
 *
 * There is no second storage model. A binding either names a workspace room or
 * the server refuses: `storesFor()` returns `ok: false` and every caller on the
 * path treats that as "no memory available". The old `projects/<projectId>`
 * and `reusable/` directories are never opened here, so data written by earlier
 * versions stays on disk exactly as it was — unread, unmigrated, undeleted.
 */

import { openCentralStore, openRoomStore } from './store.mjs'
import { createWorkspaceResolver } from './workspace-resolver.mjs'
import { createMemoryRouter, MEMORY_OPERATIONS } from './memory-router.mjs'
import { promoteRecord } from './promotion.mjs'
import { writeRoomBinding } from './rooms.mjs'
import { AUTHORITIES } from './types.mjs'

export const MEMORY_SERVER_PHASES = Object.freeze({
  CREATED: 'created',
  READY: 'ready',
  DEGRADED: 'degraded',
  DISPOSED: 'disposed',
})

/**
 * Does the host DECLARE a workspace service at all?
 *
 * Cordis records every `provide()` in `ctx.reflect.props`, and that table is
 * shared down the context prototype chain. A declaration that the host cannot
 * currently hand over is therefore a fault; no declaration at all is a host
 * that genuinely lacks workspace support. An undeclared property access throws
 * `cannot get property "workspaceRegistry" without inject`, so a throw alone
 * must never be read as evidence of capability.
 */
function declaresWorkspaceService(ctx) {
  try {
    const props = ctx?.reflect?.props
    if (props && Object.prototype.hasOwnProperty.call(props, 'workspaceRegistry')) {
      return props.workspaceRegistry?.type === 'service'
    }
  } catch {
    // A broken reflect table is not evidence either way.
  }
  // Plain-object hosts (tests, embedders) expose the service directly.
  try {
    return Boolean(ctx?.workspaceRegistry)
  } catch {
    return false
  }
}

function registryFrom(ctx) {
  if (!ctx) return null
  const declared = declaresWorkspaceService(ctx)
  let candidate = null
  let failure = null

  try {
    candidate = ctx.workspaceRegistry ?? null
  } catch (error) {
    failure = error
  }
  if (!candidate) {
    try {
      candidate = (typeof ctx.get === 'function' ? ctx.get('workspaceRegistry') : null) ?? null
    } catch (error) {
      failure = failure ?? error
    }
  }

  if (candidate) return candidate
  // Declared but unobtainable: fail closed. Pretending the host has no
  // workspace capability would invite a second storage layout, and a transient
  // fault would then look like a permanent absence forever after.
  if (declared) {
    throw failure ?? new Error('workspace registry declared but unavailable')
  }
  return null
}

export function createMemoryServer({ ctx, runtime, config = {} } = {}) {
  const home = runtime?.veyraHome
  if (!home) throw new Error('Veyra Memory Server requires runtime.veyraHome')

  const log = runtime?.log
  const resolver = createWorkspaceResolver({ getRegistry: () => registryFrom(ctx) })
  const router = createMemoryRouter()

  const state = {
    phase: MEMORY_SERVER_PHASES.CREATED,
    lastError: null,
    writtenBindings: new Set(),
  }

  function markReady() {
    if (state.phase === MEMORY_SERVER_PHASES.CREATED) state.phase = MEMORY_SERVER_PHASES.READY
  }

  function degrade(err, message) {
    state.phase = MEMORY_SERVER_PHASES.DEGRADED
    state.lastError = err instanceof Error ? err.message : String(err)
    try { log?.warn?.(`[veyra] ${message}: ${state.lastError}`) } catch {}
  }

  /**
   * Resolution is total: either a registry-backed workspace binding, or a
   * refusal carrying the reason. There is no third case to fall back into.
   */
  function resolve(agent) {
    const resolved = resolver.resolve(agent)
    if (resolved.ok) markReady()
    return resolved
  }

  function resolvePath(cwd) {
    const resolved = resolver.resolvePath(cwd)
    if (resolved.ok) markReady()
    return resolved
  }

  function storesForBinding(binding, operation) {
    const decision = router.decide(operation, binding)
    if (!decision.ok) return { ok: false, reason: decision.reason, binding }

    const projectStore = openRoomStore(home, binding.roomId)
    const reusableStore = openCentralStore(home)
    // Persist the binding that this room was created from. This is an audit
    // record for operators; it is never the authority for room identity.
    // Written once per room per server lifetime.
    if (!state.writtenBindings.has(binding.roomId)) {
      try {
        writeRoomBinding(home, binding)
        state.writtenBindings.add(binding.roomId)
      } catch (err) {
        degrade(err, `room binding not written for ${binding.roomId}`)
      }
    }
    return {
      ok: true,
      binding,
      decision,
      projectStore,
      reusableStore,
      roomId: binding.roomId,
      projectId: binding.roomId,
      cwd: binding.workspacePath,
    }
  }

  function storesFor(agent, operation = MEMORY_OPERATIONS.RECALL_MANUAL) {
    const resolved = resolve(agent)
    if (!resolved.ok) return resolved
    return storesForBinding(resolved.binding, operation)
  }

  function storesForPath(cwd, operation = MEMORY_OPERATIONS.RECALL_MANUAL) {
    const resolved = resolvePath(cwd)
    if (!resolved.ok) return resolved
    return storesForBinding(resolved.binding, operation)
  }

  /** Automatic recall: workspace room + Central Memories, read-only. */
  function recallStores(agent, { includeReusable = true } = {}) {
    const resolved = resolve(agent)
    if (!resolved.ok) return resolved
    const stores = storesForBinding(resolved.binding, MEMORY_OPERATIONS.RECALL_AUTO)
    if (!stores.ok) return stores
    if (!includeReusable) return { ...stores, reusableStore: null }
    return stores
  }

  function recallStoresForPath(cwd, { includeReusable = true } = {}) {
    const resolved = resolvePath(cwd)
    if (!resolved.ok) return resolved
    const stores = storesForBinding(resolved.binding, MEMORY_OPERATIONS.RECALL_AUTO)
    if (!stores.ok) return stores
    if (!includeReusable) return { ...stores, reusableStore: null }
    return stores
  }

  /**
   * Governed promotion of one workspace record into Central Memories.
   *
   * This is the ONLY write path into Central Memories. Recall reads Central,
   * and `MEMORY_OPERATIONS.LEARN_AUTO` / `UPDATE` / `FORGET` are denied a
   * central target by the router, so a record can arrive there only by being
   * promoted deliberately and with evidence.
   */
  function promote({ agent, id, to = AUTHORITIES.DERIVED, explicit = false, reason = '' } = {}) {
    const resolved = resolve(agent)
    if (!resolved.ok) return resolved
    const binding = resolved.binding
    const decision = router.decide(MEMORY_OPERATIONS.PROMOTE, binding)
    if (!decision.ok) return decision
    const stores = storesForBinding(binding, MEMORY_OPERATIONS.PROMOTE)
    if (!stores.ok) return stores
    return promoteRecord({
      workspaceStore: stores.projectStore,
      centralStore: stores.reusableStore,
      binding,
      id,
      to,
      explicit,
      reason,
    })
  }

  function health() {
    return {
      phase: state.phase,
      mode: resolver.mode(),
      // `mode()` answers "which storage model", and there is only one. Whether
      // the registry behind it is usable is the separate, three-state question
      // an operator actually needs answered.
      registryState: resolver.state(),
      home,
      registryAvailable: Boolean(resolver.list()),
      bindingsWritten: state.writtenBindings.size,
      lastError: state.lastError,
    }
  }

  function dispose() {
    state.phase = MEMORY_SERVER_PHASES.DISPOSED
  }

  return {
    resolve,
    resolvePath,
    storesFor,
    storesForPath,
    recallStores,
    recallStoresForPath,
    promote,
    health,
    dispose,
    resolver,
    router,
    get phase() { return state.phase },
  }
}
