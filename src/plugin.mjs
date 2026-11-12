/**
 * Veyra — Engineering Brain for DSH.
 *
 * Native Cordis plugin. Integrates with the real DSH lifecycle:
 *   - systemPrompt.section  — static memory-is-not-truth guidance
 *   - systemPrompt.context  — per-turn automatic recall
 *   - session/event         — observe engineering activity
 *   - agent/turn-stopping   — persist candidates / maybe-learn
 *   - ctx.tools             — remember / recall / inspect / forget / promote
 *   - ctx.commands          — /veyra
 *   - ctx.webServer         — Network Graph WebUI at /veyra (when the host has HTTP)
 *   - ctx.skills            — bundled skills (skills/veyra, skills/legacy-onboarding)
 *
 * Memory lives under $DSH_HOME/veyra/, never inside the user's repository.
 */

import { AUTHORITIES, CODE_FRESHNESS, DEFAULT_RECALL_LIMIT } from './types.mjs'
import { Config, normalizeRecallLimit } from './config.mjs'
import { closeAllStores } from './store.mjs'
import { projectIdFor, resolveVeyraHome, resolveWorkspace } from './ids.mjs'
import { openProjectStore, openReusableStore } from './store.mjs'
import { createMemoryServer } from './memory-server.mjs'
import { MEMORY_OPERATIONS } from './memory-router.mjs'
import { CODE_INTELLIGENCE_GUIDANCE, CODE_INTELLIGENCE_UNAVAILABLE_GUIDANCE, DEFAULT_RECALL_CHARS, GUIDANCE_TEXT, createContextProvider, rememberClaimedPrompt, rememberCompactedCheckpoint, recordRepositoryChange } from './context.mjs'
import { candidateFromBuffer, newBuffer, observeEvent } from './observe.mjs'
import { maybeLearn, provenanceAllowsLearning, reviewCandidate, strengthenMemory } from './learn.mjs'
import { markStale, sweepStale } from './evolve.mjs'
import { detectConsolidationCandidates } from './consolidate.mjs'
import { registerTools } from './tools.mjs'
import { registerCommand } from './commands.mjs'
import { registerSkills } from './skills.mjs'
import { registerWebUi } from './webui.mjs'
import { CBM_PACKAGE_NAME, cbm, createDegradedEngine, cbmLoadFailure, isAbsentFailure, isCodeIntelligenceAvailable } from './cbm-bridge.mjs'
import { findAffectedMemories, buildStaleReviewCandidate } from './code/linking.mjs'
import { AUTO_OUTCOME, DELIVERY, readGenerationEvidence, recordAutoOutcomeSignal } from './apply-generation-evidence.mjs'
import { testOutcomeFrom } from './understand.mjs'

// `src/plugin.mjs` is this package's `main`/`exports` target, so these five CBM
// helpers are part of Veyra's own public module surface. They are bound from the
// bridge (and stay `undefined` when it cannot load) rather than from a direct
// package import, which is why the re-export block below is unchanged.
const findExe = cbm.findExe
const getOrCreateClient = cbm.getOrCreateClient
const createClient = cbm.createClient
const cbmApply = cbm.cbmApply
const autoStartCodebaseMemory = cbm.autoStartCodebaseMemory

export const name = 'veyra'
export const inject = ['tools']

/**
 * M5 maintenance cadence. In-memory only: no scheduler, no worker, no
 * persisted marker, no schema. The counter is module-scoped, so it is shared by
 * every session in the process and resets when the process restarts.
 */
export const MAINTENANCE_EVERY_N_TURNS = 5
const MAINTENANCE_LIST_LIMIT = 200
let maintenanceTurns = 0

/** Reset the maintenance cadence. Exported for tests only. */
export function _resetMaintenanceCounter() {
  maintenanceTurns = 0
}

/** Current maintenance turn position. Exported for tests only. */
export function _maintenanceTurns() {
  return maintenanceTurns
}

/**
 * The one and only implementation of the maintenance cadence. The real
 * `turn-stopping` handler calls this, and the cadence tests drive the same
 * function, so there is no second copy of the arithmetic to drift.
 *
 * Returns true when a maintenance pass is due, having already reset the
 * counter for the next window.
 */
function dueForMaintenance() {
  maintenanceTurns += 1
  if (maintenanceTurns < MAINTENANCE_EVERY_N_TURNS) return false
  maintenanceTurns = 0
  return true
}

/**
 * Accepted `config:` keys (all optional, defaults shown):
 *   home: string            storage root, default $DSH_HOME/veyra
 *   recallLimit: number     memories injected per turn, default 5; 0 disables automatic recall
 *   includeReusable: bool   include cross-project experience, default true
 *   observe: bool           capture session activity, default true
 *   learn: bool             promote durable observations, default true
 *
 * `Config` is the DSH Settings surface (recallLimit + includeReusable only).
 * observe/learn stay yaml-only so their lifecycle is not a Settings toggle.
 */
export { Config, normalizeRecallLimit } from './config.mjs'

export const DEFAULT_CONFIG = Object.freeze({
  recallLimit: DEFAULT_RECALL_LIMIT,
  includeReusable: true,
  observe: true,
  learn: true,
})

function loggerOf(ctx) {
  // Cordis's default logger only buffers; operators never see plugin
  // startup unless we also write to stderr.
  const echo = {
    info: (...args) => console.error(...args),
    warn: (...args) => console.warn(...args),
    debug: (...args) => { /* quiet */ void args },
  }
  const log = ctx?.logger
  if (!log || typeof log.info !== 'function') return echo
  return {
    info: (...args) => {
      try { log.info(...args) } catch { /* ignore */ }
      echo.info(...args)
    },
    warn: (...args) => {
      try { log.warn(...args) } catch { /* ignore */ }
      echo.warn(...args)
    },
    debug: (...args) => {
      try { log.debug?.(...args) } catch { /* ignore */ }
    },
  }
}

function createRuntime(ctx, config = {}) {
  const log = loggerOf(ctx)
  // A missing/loading bridge must not break `apply()`: fall back to the null
  // engine, which answers `{ ok: false, degraded: true }` to every call.
  const codeEngine = typeof cbm.CodeIntelligenceEngine === 'function'
    ? new cbm.CodeIntelligenceEngine({
      exePath: config.codebaseMemoryBin,
      defaultPort: config.codebaseMemoryPort,
      log,
    })
    : createDegradedEngine()
  return {
    veyraHome: resolveVeyraHome(config),
    recallLimit: normalizeRecallLimit(config.recallLimit),
    includeReusable: config.includeReusable !== false,
    observe: config.observe !== false,
    learn: config.learn !== false,
    // GOAL.md §11 — the recall intake is bounded in BOTH dimensions: record
    // count (recallLimit) and total injected characters (DEFAULT_RECALL_CHARS).
    // The character cap is not a Settings toggle: it is a fixed safety bound
    // on the agent-facing intake, so a misconfigured recallLimit can never
    // expand the injected context without bound.
    recallChars: DEFAULT_RECALL_CHARS,
    fallbackCwd: process.cwd(),
    codeEngine,
    codebaseWatch: config.codebaseWatch !== false,
    // Phase 3 — in-memory change signal per repo root (latest event replaces
    // the previous one). Not persisted; a restart simply starts signal-free.
    changeSignals: new Map(),
    log,
  }
}

/**
 * @param {object} ctx  Cordis context
 * @param {object} [config]
 */
export function apply(ctx, config = {}) {
  // Attach Config to the apply function so Cordis registry wires it into
  // runtime.Config. Advanced YAML/config APIs still accept recallLimit and
  // includeReusable through this schema; the dedicated Settings UI is removed.
  apply.Config = Config

  const runtime = createRuntime(ctx, { ...DEFAULT_CONFIG, ...config })

  // Spec §13: a corrupt install must not look like no install. The bridge
  // degrades silently by design (module evaluation stays side-effect free), so
  // the one warning lives here, where a logger exists. Only a failure that is
  // not a plain absence is news, and the two are not distinguishable by the
  // error code — `require` reports a missing package, a package whose `main` is
  // missing, and a package whose dependency is missing all as MODULE_NOT_FOUND.
  // `isAbsentFailure` compares the named specifier instead, so the broken
  // install §13 exists to surface is not suppressed along with the absent one.
  // `runtime.log.warn` is the logger wrapper that already swallows sink
  // failures, so this can never break plugin load; there is one call per
  // apply(), no interval/retry.
  //
  // The package name comes from the bridge: this file must never spell the
  // specifier itself (a test asserts exactly one src/ file names it).
  if (cbmLoadFailure && !isAbsentFailure(cbmLoadFailure)) {
    try {
      runtime.log.warn(
        `[veyra] Codebase Memory failed to load (${cbmLoadFailure.code || 'unknown'}): ${cbmLoadFailure.message}. Code Intelligence is degraded; install or reinstall ${CBM_PACKAGE_NAME} to restore it.`,
      )
    } catch {
      // A broken logger must never break plugin load.
    }
  }

  // The Memory Server is created once per plugin lifecycle and owns workspace
  // resolution, room routing, migration, and promotion for every consumer
  // (tools, commands, WebUI, automatic recall, automatic learning).
  runtime.memoryServer = createMemoryServer({ ctx, runtime, config: { ...DEFAULT_CONFIG, ...config } })

  // Eagerly start codebase-memory-mcp daemon on plugin load unless running inside unit tests
  const isTest =
    process.env.NODE_ENV === 'test' ||
    process.execArgv.includes('--test') ||
    process.argv.includes('--test') ||
    process.argv.some((arg) => typeof arg === 'string' && (arg.endsWith('.test.mjs') || arg.endsWith('.test.js')))

  const shouldEagerStart = config.eagerStartCodebaseMemory !== undefined
    ? Boolean(config.eagerStartCodebaseMemory)
    : !isTest

  if (shouldEagerStart && runtime.codeEngine?.client?.isAvailable) {
    autoStartCodebaseMemory?.(runtime.codeEngine.client, runtime.log)
  }

  const buffers = new WeakMap()
  const watchers = new Map()

  const ensureWatcher = (cwd) => {
    if (!runtime.codebaseWatch || !cwd || watchers.has(cwd)) return
    if (typeof cbm.RepositoryWatcher !== 'function') return
    try {
      const watcher = new cbm.RepositoryWatcher(cwd, {
        onBatchChanges: async (events) => {
          try {
            const changedFiles = events.map((e) => e.relativePath)
            runtime.log?.debug?.(`[veyra] code changes in ${cwd}: ${changedFiles.join(', ')}`)
            await runtime.codeEngine.indexRepository(cwd, { mode: 'incremental' }).catch(() => {})
            // A watcher batch updates memories for the workspace that owns
            // this directory. No server, or a refused resolution, means there
            // is no room to update — return rather than invent a path-keyed
            // store for data the clean-break architecture will never read.
            const server = runtime.memoryServer
            if (!server) return
            const stores = server.storesForPath(cwd, MEMORY_OPERATIONS.UPDATE)
            if (!stores.ok) return
            const projectStore = stores.projectStore
            const memories = projectStore.list({ limit: 500 })
            const affected = findAffectedMemories(cwd, changedFiles, memories)
            for (const item of affected) {
              if (item.freshness === CODE_FRESHNESS.POTENTIALLY_STALE || item.freshness === CODE_FRESHNESS.INVALID) {
                const candidate = buildStaleReviewCandidate(
                  item.record,
                  item.affectedAnchors[0]?.path || 'modified code',
                  item.freshness,
                )
                projectStore.put(candidate)
              }
            }
          } catch (err) {
            runtime.log?.debug?.(`[veyra] watcher batch error: ${err.message}`)
          }
        },
      })
      // Phase 3 — the existing watcher's change signal feeds the ambient
      // context: latest changeset becomes the workspace's change signal
      // (replaced, never accumulated), so recall is change-aware without the
      // agent calling veyra_change_impact. Context only — never a store write.
      watcher.on('change', (changeset) => {
        try {
          recordRepositoryChange(runtime.changeSignals, changeset)
        } catch (err) {
          runtime.log?.debug?.(`[veyra] change signal record failed: ${err.message}`)
        }
      })
      watcher.start()
      watchers.set(cwd, watcher)
    } catch {
      // safe fallback
    }
  }
  runtime.ensureWatcher = ensureWatcher

  const registerPrompt = (scope) => {
    if (!scope?.systemPrompt) return
    const effect = typeof scope.effect === 'function' ? scope.effect.bind(scope) : null
    const runPromptEffect = (register) => {
      if (!effect) { register(); return }
      // DSH 0.2.2-rc.1: systemPrompt.section/context may return a Cordis
      // disposer/effect Function. Normalize so Cordis never sees a
      // non-disposer value from test doubles/mocks.
      effect(() => {
        const disposer = register()
        return typeof disposer === 'function' ? disposer : undefined
      })
    }
    // Advertise Code Intelligence only when it can actually answer. Computed
    // here, not at module scope or in apply(): registerPrompt runs per apply,
    // after createRuntime(), so runtime.codeEngine already exists. The `?.`
    // matters because a host may register the prompt with a runtime that has
    // no engine at all.
    //
    // `cbm.available` alone is not the test: it records that the optional peer
    // package resolved, not that the six cbm_* tools exist. They are registered
    // by the Codebase Memory plugin's own apply(), which DSH gives Veyra no way
    // to probe — so the block is phrased conditionally and an unusable bridge
    // emits the §6 fallback line instead of silence.
    const codeIntelligenceUsable =
      isCodeIntelligenceAvailable() && runtime.codeEngine?.isDegraded !== true
    const guidanceText = codeIntelligenceUsable
      ? `${GUIDANCE_TEXT}\n\n${CODE_INTELLIGENCE_GUIDANCE}`
      : `${GUIDANCE_TEXT}\n\n${CODE_INTELLIGENCE_UNAVAILABLE_GUIDANCE}`
    try {
      runPromptEffect(() => scope.systemPrompt.section({
        name: 'veyra:guidance',
        order: 3050,
        text: guidanceText,
      }))
    } catch (err) {
      runtime.log.warn(`[veyra] section register failed: ${err instanceof Error ? err.message : String(err)}`)
    }
    try {
      runPromptEffect(() => scope.systemPrompt.context({
        name: 'veyra:recall',
        order: 200,
        text: createContextProvider(runtime),
      }))
    } catch (err) {
      runtime.log.warn(`[veyra] context register failed: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  if (typeof ctx.inject === 'function') {
    try {
      ctx.inject(['systemPrompt'], registerPrompt)
    } catch {
      registerPrompt(ctx)
    }
  } else {
    registerPrompt(ctx)
  }

  if (ctx.tools && typeof ctx.tools.register === 'function') {
    void registerTools(ctx, runtime, ctx).then((names) => {
      if (names.length) runtime.log.info(`[veyra] registered tools: ${names.join(', ')}`)
    }).catch((err) => {
      runtime.log.warn(`[veyra] tool register failed: ${err instanceof Error ? err.message : String(err)}`)
    })
  }

  const registerSkillSurface = (scope) => {
    void registerSkills(scope, runtime.log, scope).then((names) => {
      if (names.length) runtime.log.info(`[veyra] registered skill: ${names.join(', ')}`)
    }).catch((err) => {
      runtime.log.warn(`[veyra] skill register failed: ${err instanceof Error ? err.message : String(err)}`)
    })
  }

  if (typeof ctx.inject === 'function') {
    try {
      ctx.inject(['skills'], registerSkillSurface)
    } catch {
      registerSkillSurface(ctx)
    }
  } else {
    registerSkillSurface(ctx)
  }

  if (typeof ctx.inject === 'function') {
    try {
      ctx.inject(['commands'], (scope) => {
        if (registerCommand(scope, runtime, scope)) {
          runtime.log.info('[veyra] registered /veyra')
        }
      })
    } catch {
      if (registerCommand(ctx, runtime, ctx)) runtime.log.info('[veyra] registered /veyra')
    }
  } else if (registerCommand(ctx, runtime, ctx)) {
    runtime.log.info('[veyra] registered /veyra')
  }

  if (registerWebUi(ctx, runtime)) {
    runtime.log.info('[veyra] Network Graph WebUI at /veyra')
  }

  if (typeof ctx.on === 'function') {
    const offClaimed = ctx.on('agent/inbox/claimed', ({ agent, message } = {}) => {
      try {
        rememberClaimedPrompt(agent, message)
      } catch {
        // recall query is best-effort
      }
    })
    if (typeof offClaimed === 'function') ctx.effect(() => offClaimed)
  }

  if (typeof ctx.on === 'function') {
    const offEvent = ctx.on('session/event', (session, event) => {
      try {
        if (event?.type === 'compaction/end' && event?.data?.error === undefined) {
          rememberCompactedCheckpoint(session, event)
        }
        if (runtime.observe) {
          let buffer = buffers.get(session)
          if (!buffer) {
            buffer = newBuffer()
            buffers.set(session, buffer)
          }
          observeEvent(buffer, session, event)
        }
      } catch {
        // observation and compaction recovery are best-effort and must never break the agent loop
      }
    })
    if (typeof offEvent === 'function') ctx.effect(() => offEvent)

    if (runtime.observe) {
      const offStopping = ctx.on('agent/turn-stopping', ({ agent } = {}) => {
      try {
        const session = agent?.session
        if (!session) return
        const buffer = buffers.get(session)
        if (!buffer) return
        let cwd = resolveWorkspace(agent) || runtime.fallbackCwd
        const server = runtime.memoryServer
        // Fail closed: without a server, or when the workspace cannot be
        // resolved, there is no room to learn into. Writing to a path-keyed
        // store instead would place this turn's memory somewhere the clean-break
        // architecture never reads again.
        if (!server) return
        const stores = server.storesFor(agent, MEMORY_OPERATIONS.LEARN_AUTO)
        if (!stores.ok) return
        cwd = stores.cwd || cwd
        const projectId = stores.projectId
        const projectStore = stores.projectStore
        ensureWatcher(cwd)
        const candidate = candidateFromBuffer(buffer, {
          projectId,
          sessionId: session.id,
          // §15 — provenance dimensions ride with the captured turn.
          cwd,
          agent,
        })
        // Turn-end outcome signal (non-causal). Test evidence from this turn makes
        // a delivered record *correlated* with a pass, never verified: `test-passed`
        // is a local observation of runner output, not a model receipt. Nothing here
        // may touch confidence, validation, or authority.
        //
        // This runs before the `if (!candidate) return` guard on purpose. A short
        // "did it pass?" turn produces no durable observation, so a block placed
        // after that guard would skip exactly the turns whose test evidence matters.
        // `runtime.observe: false` disables this path with the rest of the handler.
        try {
          const outcome = testOutcomeFrom(buffer.tools, [...buffer.files])
          const signal = outcome === 'test-passed' ? AUTO_OUTCOME.PLAUSIBLE
            : outcome === 'test-failed' ? AUTO_OUTCOME.CONTRADICTED
              : null
          if (signal) {
            // readLog returns null when nothing was ever recorded, so a fresh room
            // has no generation log at all.
            const delivered = readGenerationEvidence(projectStore)?.entries
              ?.filter((e) => e.delivery?.status === DELIVERY.DELIVERED)
              .at(-1)
            if (delivered) {
              for (const recordId of delivered.recordRefs.slice(0, 5)) {
                recordAutoOutcomeSignal(projectStore, {
                  recordId,
                  generationEventId: delivered.eventId,
                  signal,
                })
              }
            }
          }
        } catch {
          // turn-end signal is best-effort and must never break the agent loop
        }

        if (!candidate) return
        const written = projectStore.put(candidate)
        if (runtime.learn && written.created) {
          maybeLearn(projectStore, { ...written.record }, { workspace: cwd })
        } else if (runtime.learn && written.duplicate && written.record?.authority === AUTHORITIES.DERIVED && provenanceAllowsLearning(candidate)) {
          const strengthened = strengthenMemory(written.record, candidate, { workspace: cwd })
          projectStore.put(strengthened)
        }
        if (runtime.learn) {
          markStale(projectStore, { workspace: cwd })
        }

        // Periodic maintenance (M5). In-memory counter only: no scheduler, no
        // worker, no persisted marker, no schema. It runs off the existing turn
        // lifecycle and never from recall(). Losing the counter on restart is
        // acceptable — the next fifth turn simply re-establishes the cadence.
        if (runtime.learn && dueForMaintenance()) {
          const swept = sweepStale(projectStore, { workspace: cwd })
          const candidates = projectStore
            .list({ limit: MAINTENANCE_LIST_LIMIT, kind: 'observation' })
            .concat(projectStore.list({ limit: MAINTENANCE_LIST_LIMIT }))
            .filter((r) => r && !r.forgotten && r.authority === AUTHORITIES.CANDIDATE)

          let transitioned = 0, unchanged = 0, blocked = 0, skipped = 0, failed = 0
          for (const candidate of candidates) {
            try {
              const r = reviewCandidate(projectStore, candidate, { workspace: cwd })
              if (r.outcome === 'transitioned') transitioned += 1
              else if (r.outcome === 'unchanged') unchanged += 1
              else if (r.outcome === 'blocked') blocked += 1
              else skipped += 1
            } catch {
              failed += 1
            }
          }

          // M12 C3: read-only consolidation detection over the same bounded
          // list (store.list clamps to MAINTENANCE_LIST_LIMIT — not an
          // unbounded DB scan). Pure proposals only: never merges, deletes, or
          // mutates a record. Surfaced through this log line and Observatory;
          // runs on the existing cadence so no scheduler/worker/daemon is
          // introduced. Duplicate pass is O(n²) in n <= list limit (~156ms at
          // n=200 worst case), documented in src/consolidate.mjs.
          let proposals = null
          try {
            const allRecords = projectStore.list({ limit: MAINTENANCE_LIST_LIMIT })
            proposals = detectConsolidationCandidates(allRecords, { workspace: cwd })
          } catch {
            // detection is best-effort
          }

          runtime.log?.info?.(
            `[veyra] maintenance examined=${swept.examined} markedStale=${swept.marked} `
            + `candidatesReviewed=${candidates.length} transitioned=${transitioned} `
            + `unchanged=${unchanged} blocked=${blocked} skipped=${skipped} failed=${failed}`
            + (swept.error ? ` staleError=${swept.error}` : '')
            + (proposals
              ? ` proposals=${proposals.counts.total}(dup=${proposals.counts.duplicate}`
                + ` con=${proposals.counts.contradiction} out=${proposals.counts.outdated}`
                + ` rep=${proposals.counts.replacement} ret=${proposals.counts.retirement})`
              : ''),
          )
        }
      } catch {
        // learning is best-effort
      }
    })
      if (typeof offStopping === 'function') ctx.effect(() => offStopping)
    }
  }

  const cleanup = () => {
    for (const w of watchers.values()) {
      try { w.stop?.() } catch {}
      try { w.close?.() } catch {}
    }
    watchers.clear()
    try { runtime.codeEngine?.dispose() } catch {}
    try { runtime.memoryServer?.dispose() } catch {}
    closeAllStores()
  }

  ctx.effect?.(() => cleanup)

  runtime.log.info(`[veyra] plugin loaded (home=${runtime.veyraHome})`)
  return () => {
    cleanup()
  }
}

export {
  resolveVeyraHome,
  projectIdFor,
  openProjectStore,
  openReusableStore,
  findExe,
  getOrCreateClient,
  createClient,
  cbmApply,
  autoStartCodebaseMemory,
}
