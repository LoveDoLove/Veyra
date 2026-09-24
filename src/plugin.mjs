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
 *   - ctx.skills            — bundled `veyra` skill (skills/veyra/SKILL.md)
 *
 * Memory lives under $DSH_HOME/veyra/, never inside the user's repository.
 */

import { DEFAULT_RECALL_LIMIT } from './types.mjs'
import { closeAllStores } from './store.mjs'
import { projectIdFor, resolveVeyraHome, resolveWorkspace } from './ids.mjs'
import { openProjectStore, openReusableStore } from './store.mjs'
import { GUIDANCE_TEXT, createContextProvider, rememberClaimedPrompt } from './context.mjs'
import { candidateFromBuffer, newBuffer, observeEvent } from './observe.mjs'
import { maybeLearn, strengthenMemory } from './learn.mjs'
import { markStale } from './evolve.mjs'
import { registerTools } from './tools.mjs'
import { registerCommand } from './commands.mjs'
import { registerSkills } from './skills.mjs'

export const name = 'veyra'
export const inject = ['tools']

/**
 * Accepted `config:` keys (all optional, defaults shown):
 *   home: string            storage root, default $DSH_HOME/veyra
 *   recallLimit: number     memories injected per turn, default 5
 *   includeReusable: bool   include cross-project experience, default true
 *   observe: bool           capture session activity, default true
 *   learn: bool             promote durable observations, default true
 *
 * No `Config` export on purpose: Cordis treats an exported `Config` as a
 * Standard Schema, and Veyra has no runtime dependency on schemastery.
 */
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
  return {
    veyraHome: resolveVeyraHome(config),
    recallLimit: Number(config.recallLimit) > 0 ? Number(config.recallLimit) : DEFAULT_RECALL_LIMIT,
    includeReusable: config.includeReusable !== false,
    observe: config.observe !== false,
    learn: config.learn !== false,
    fallbackCwd: process.cwd(),
    log: loggerOf(ctx),
  }
}

/**
 * @param {object} ctx  Cordis context
 * @param {object} [config]
 */
export function apply(ctx, config = {}) {
  const runtime = createRuntime(ctx, { ...DEFAULT_CONFIG, ...config })
  const buffers = new WeakMap()

  const registerPrompt = (scope) => {
    if (!scope?.systemPrompt) return
    try {
      scope.systemPrompt.section({
        name: 'veyra:guidance',
        order: 3050,
        text: GUIDANCE_TEXT,
      })
    } catch (err) {
      runtime.log.warn(`[veyra] section register failed: ${err instanceof Error ? err.message : String(err)}`)
    }
    try {
      scope.systemPrompt.context({
        name: 'veyra:recall',
        order: 200,
        text: createContextProvider(runtime),
      })
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
    void registerTools(ctx, runtime).then((names) => {
      if (names.length) runtime.log.info(`[veyra] registered tools: ${names.join(', ')}`)
    }).catch((err) => {
      runtime.log.warn(`[veyra] tool register failed: ${err instanceof Error ? err.message : String(err)}`)
    })
  }

  const registerSkillSurface = (scope) => {
    void registerSkills(scope, runtime.log).then((names) => {
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
        if (registerCommand(scope, runtime)) {
          runtime.log.info('[veyra] registered /veyra')
        }
      })
    } catch {
      if (registerCommand(ctx, runtime)) runtime.log.info('[veyra] registered /veyra')
    }
  } else if (registerCommand(ctx, runtime)) {
    runtime.log.info('[veyra] registered /veyra')
  }

  if (typeof ctx.on === 'function') {
    ctx.on('agent/inbox/claimed', ({ agent, message } = {}) => {
      try {
        rememberClaimedPrompt(agent, message)
      } catch {
        // recall query is best-effort
      }
    })
  }

  if (typeof ctx.on === 'function' && runtime.observe) {
    ctx.on('session/event', (session, event) => {
      try {
        let buffer = buffers.get(session)
        if (!buffer) {
          buffer = newBuffer()
          buffers.set(session, buffer)
        }
        observeEvent(buffer, session, event)
      } catch {
        // observation is best-effort and must never break the agent loop
      }
    })

    ctx.on('agent/turn-stopping', ({ agent } = {}) => {
      try {
        const session = agent?.session
        if (!session) return
        const buffer = buffers.get(session)
        if (!buffer) return
        const cwd = resolveWorkspace(agent) || runtime.fallbackCwd
        const projectId = projectIdFor(cwd)
        const projectStore = openProjectStore(runtime.veyraHome, projectId)
        const candidate = candidateFromBuffer(buffer, {
          projectId,
          sessionId: session.id,
        })
        if (!candidate) return
        const written = projectStore.put(candidate)
        if (runtime.learn && written.created) {
          maybeLearn(projectStore, { ...written.record }, { workspace: cwd })
        } else if (runtime.learn && written.duplicate && written.record?.authority === AUTHORITIES.DERIVED) {
          const strengthened = strengthenMemory(written.record, candidate, { workspace: cwd })
          projectStore.put(strengthened)
        }
        if (runtime.learn) {
          markStale(projectStore, { workspace: cwd })
        }
      } catch {
        // learning is best-effort
      }
    })
  }

  ctx.effect?.(() => () => {
    closeAllStores()
  })

  runtime.log.info(`[veyra] plugin loaded (home=${runtime.veyraHome})`)
  return () => {
    closeAllStores()
  }
}

export {
  resolveVeyraHome,
  projectIdFor,
  openProjectStore,
  openReusableStore,
}
