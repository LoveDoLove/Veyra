/**
 * Veyra — /veyra slash command.
 *
 * Manual control for inspection, administration, and the read-only
 * Knowledge Observatory.
 */

import { readFileSync } from 'node:fs'
import { AUTHORITIES, KINDS, VALIDATIONS } from './types.mjs'
import { projectIdFor, resolveVeyraHome, resolveWorkspace } from './ids.mjs'
import { openProjectStore, openReusableStore } from './store.mjs'
import { recall } from './retrieve.mjs'
import { promote } from './learn.mjs'
import {
  observatoryCausality,
  observatoryConsolidation,
  observatoryContradictions,
  observatoryLocalGraph,
  observatoryOverview,
  observatoryRecord,
  observatoryRelationships,
  observatorySearch,
} from './observatory.mjs'
import { CodeIntelligenceEngine } from './code/engine.mjs'
import { FRESHNESS_STATUS } from './code/types.mjs'
import { checkRecordFreshness, findAffectedMemories } from './code/linking.mjs'

/** Installed version, read from package.json; 'dev' outside the package. */
export function packageVersion() {
  try {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
    return typeof pkg.version === 'string' && pkg.version ? pkg.version : 'dev'
  } catch {
    return 'dev'
  }
}

function helpText() {
  return [
    `Veyra — Engineering Intelligence for Coding Agents (v${packageVersion()})`,
    '',
    '/veyra                                     status for this workspace',
    '/veyra observatory [subcommand]            human knowledge observatory',
    '       observatory overview                aggregate knowledge & health counts',
    '       observatory search <query>          inspect hybrid search signals',
    '       observatory record <id>             deep evidence & provenance inspection',
    '       observatory causality               causal knowledge map (symptom→fix)',
    '       observatory relationships [id]      directed edges (optional filter)',
    '       observatory local <id>              1-hop neighborhood around a record',
    '       observatory graph [id]              local graph if id given, else all edges',
    '       Network Graph WebUI                 /veyra (workspace overview) · /veyra?id=<record> (local graph)',
    '       observatory contradictions          conflicts and opposing claims',
    '       observatory consolidation            detect -> propose consolidation candidates (read-only)',
    '/veyra recall [q]                          hybrid search project (+ reusable) memory',
    '/veyra code [subcommand]                   code intelligence & graph',
    '       code status                         index status & memory freshness',
    '       code index                          trigger repository reindexing',
    '       code trace <symbol>                 trace call graph for symbol',
    '       code impact                         check memory impact against changed code',
    '/veyra recent                              last 8 memories (including candidates)',
    '/veyra inspect <id>                        deep evidence, provenance & causal inspect',
    '/veyra forget <id>                         soft-forget a record',
    '/veyra promote <id> [derived|canonical]    promote standing (canonical requires user explicit)',
    '',
    'Canonical promotion is an explicit user action. Automatic capture',
    'never creates authoritative truth. Memory lives in $DSH_HOME/veyra/.',
  ].join('\n')
}

export function handleVeyraCommand(runtime, invocation) {
  const raw = String(invocation?.rawInput || invocation?.text || invocation?.input || invocation?.args || '').trim()
  const cwd = resolveWorkspace(invocation?.agent) || runtime.fallbackCwd
  const projectId = projectIdFor(cwd)
  const projectStore = openProjectStore(runtime.veyraHome, projectId)
  const reusableStore = openReusableStore(runtime.veyraHome)
  const [verb, ...rest] = raw.split(/\s+/)
  const arg = rest.join(' ').trim()

  if (!verb || verb === 'help' || verb === 'status') {
    const projectRecords = projectStore.list({ limit: 200 })
    const candidateCount = projectRecords.filter((r) => r.authority === AUTHORITIES.CANDIDATE).length
    const derivedCount = projectRecords.filter((r) => r.authority === AUTHORITIES.DERIVED).length
    const canonicalCount = projectRecords.filter((r) => r.authority === AUTHORITIES.CANONICAL).length
    const verifiedCount = projectRecords.filter((r) => r.validation === VALIDATIONS.VERIFIED).length
    const reviewedCount = projectRecords.filter((r) => r.validation === VALIDATIONS.REVIEWED).length
    const promoCount = projectRecords.filter((r) => r.tags?.includes('promotion-candidate')).length
    return {
      kind: 'success',
      text: [
        `Veyra project ${projectId}`,
        `workspace: ${cwd}`,
        `home: ${runtime.veyraHome}`,
        `project memories: ${projectStore.count()} (derived: ${derivedCount}, canonical: ${canonicalCount}, candidate: ${candidateCount})`,
        `health: ${verifiedCount} verified, ${reviewedCount} reviewed${promoCount > 0 ? `, ${promoCount} promotion candidates` : ''}`,
        `reusable memories: ${reusableStore.count()}`,
        '',
        helpText(),
      ].join('\n'),
    }
  }

  if (verb === 'observatory' || verb === 'obs') {
    const [sub, ...subRest] = arg.split(/\s+/)
    const subArg = subRest.join(' ').trim()

    if (!sub || sub === 'overview' || sub === 'status') {
      const res = observatoryOverview({ projectStore, reusableStore, cwd, projectId, veyraHome: runtime.veyraHome })
      return { kind: 'success', text: res.formatted }
    }

    if (sub === 'search' || sub === 'find') {
      if (!subArg) return { kind: 'error', text: 'Usage: /veyra observatory search <query>' }
      const res = observatorySearch({ projectStore, reusableStore, query: subArg, limit: 10 })
      return { kind: 'success', text: res.formatted }
    }

    if (sub === 'record' || sub === 'inspect') {
      if (!subArg) return { kind: 'error', text: 'Usage: /veyra observatory record <id>' }
      const res = observatoryRecord({ projectStore, reusableStore, id: subArg })
      return { kind: res.ok ? 'success' : 'error', text: res.formatted }
    }

    if (sub === 'causality' || sub === 'causal') {
      const res = observatoryCausality({ projectStore, reusableStore, limit: 25 })
      return { kind: 'success', text: res.formatted }
    }

    if (sub === 'local') {
      if (!subArg) return { kind: 'error', text: 'Usage: /veyra observatory local <id>' }
      const res = observatoryLocalGraph({ projectStore, reusableStore, id: subArg, cwd })
      return { kind: res.ok ? 'success' : 'error', text: res.formatted }
    }

    if (sub === 'graph') {
      if (subArg) {
        const res = observatoryLocalGraph({ projectStore, reusableStore, id: subArg, cwd })
        return { kind: res.ok ? 'success' : 'error', text: res.formatted }
      }
      const res = observatoryRelationships({ projectStore, reusableStore, id: null })
      return { kind: 'success', text: res.formatted }
    }

    if (sub === 'relationships' || sub === 'rel') {
      const res = observatoryRelationships({ projectStore, reusableStore, id: subArg || null })
      return { kind: 'success', text: res.formatted }
    }

    if (sub === 'contradictions' || sub === 'conflicts' || sub === 'contra') {
      const res = observatoryContradictions({ projectStore, reusableStore })
      return { kind: 'success', text: res.formatted }
    }

    if (sub === 'consolidation' || sub === 'consolidate' || sub === 'proposals') {
      const res = observatoryConsolidation({ projectStore, reusableStore, cwd })
      return { kind: 'success', text: res.formatted }
    }

    return {
      kind: 'error',
      text: [
        `Unknown observatory subcommand: ${sub}`,
        'Available: overview | search <q> | record <id> | causality | local <id> | graph [id] | relationships | contradictions | consolidation',
      ].join('\n'),
    }
  }

  if (verb === 'recall') {
    const items = recall({
      projectStore,
      reusableStore,
      query: arg,
      limit: 8,
      includeReusable: true,
    })
    if (items.length === 0) return { kind: 'success', text: 'No matching memory.' }
    return {
      kind: 'success',
      text: items.map((r) => `- ${r.id} [${r.scope}/${r.authority}] ${r.title}`).join('\n'),
    }
  }

  if (verb === 'recent') {
    const rows = [
      ...projectStore.list({ limit: 8 }),
      ...reusableStore.list({ limit: 4 }),
    ]
    if (rows.length === 0) return { kind: 'success', text: 'No memories yet.' }
    return {
      kind: 'success',
      text: rows.map((r) => `- ${r.id} [${r.kind}/${r.authority}/${r.validation}] ${r.title}`).join('\n'),
    }
  }

  if (verb === 'inspect') {
    const record = projectStore.get(arg) || reusableStore.get(arg)
    if (!record) return { kind: 'error', text: 'not found' }
    const res = observatoryRecord({ projectStore, reusableStore, id: arg })
    return { kind: 'success', text: res.formatted }
  }

  if (verb === 'forget') {
    const existing = projectStore.get(arg) || reusableStore.get(arg)
    if (!existing) return { kind: 'error', text: 'not found' }
    const store = existing.scope === 'reusable' ? reusableStore : projectStore
    store.forget(arg)
    return { kind: 'success', text: `Forgot ${arg}` }
  }

  if (verb === 'code') {
    return handleCodeCommand(runtime, projectStore, cwd, arg)
  }

  if (verb === 'promote') {
    const [id, toRaw] = arg.split(/\s+/)
    const existing = projectStore.get(id) || reusableStore.get(id)
    if (!existing) return { kind: 'error', text: 'not found' }
    const to = toRaw === AUTHORITIES.CANONICAL ? AUTHORITIES.CANONICAL : AUTHORITIES.DERIVED
    const store = existing.scope === 'reusable' ? reusableStore : projectStore
    const result = promote(store, id, { to, explicit: to === AUTHORITIES.CANONICAL })
    if (!result.ok) return { kind: 'error', text: result.error }
    return { kind: 'success', text: `Promoted ${id} to ${result.record.authority}` }
  }

  return { kind: 'error', text: helpText() }
}

async function handleCodeCommand(runtime, projectStore, cwd, arg) {
  const [sub, ...subRest] = arg.split(/\s+/)
  const subArg = subRest.join(' ').trim()
  const engine = runtime.codeEngine || new CodeIntelligenceEngine()

  if (!sub || sub === 'status') {
    const status = await engine.getStatus(cwd)
    const projectRecords = projectStore.list({ limit: 500 })
    let freshCount = 0
    let staleCount = 0
    let invalidCount = 0
    for (const mem of projectRecords) {
      const f = checkRecordFreshness(mem, cwd)
      if (f.status === FRESHNESS_STATUS.FRESH) freshCount++
      else if (f.status === FRESHNESS_STATUS.POTENTIALLY_STALE) staleCount++
      else if (f.status === FRESHNESS_STATUS.INVALID) invalidCount++
    }
    const lines = [
      `Code Intelligence Status for ${cwd}:`,
      `  Status: ${status?.status || 'unindexed'}`,
      `  Degraded: ${status?.degraded ? `YES (${status?.message || 'service unavailable'})` : 'NO'}`,
      `  Memories: ${freshCount} fresh, ${staleCount} potentially stale, ${invalidCount} invalid`,
    ]
    if (engine.client?.serverInfo?.version) {
      lines.splice(2, 0, `  Binary: ${engine.client.serverInfo.name || 'codebase-memory-mcp'} v${engine.client.serverInfo.version}`)
    }
    if (status?.degraded) {
      lines.push(
        '  Guidance: Install codebase-memory-mcp into ~/.local/bin via:',
        '    curl -fsSL https://raw.githubusercontent.com/DeusData/codebase-memory-mcp/main/install.sh | bash',
        '    or set CBM_EXE=/path/to/codebase-memory-mcp'
      )
    }
    return {
      kind: 'success',
      text: lines.join('\n'),
    }
  }

  if (sub === 'index') {
    const res = await engine.indexRepository(cwd, { mode: 'full' })
    return {
      kind: res.ok ? 'success' : 'error',
      text: res.ok ? `Successfully indexed repository at ${cwd}` : `Indexing failed: ${res.message}`,
    }
  }

  if (sub === 'trace') {
    if (!subArg) return { kind: 'error', text: 'Usage: /veyra code trace <symbol>' }
    const res = await engine.traceCallPath(cwd, { symbol: subArg })
    return {
      kind: res.ok ? 'success' : 'error',
      text: res.raw || res.message || 'No trace result',
    }
  }

  if (sub === 'impact') {
    const files = subArg ? subArg.split(/[,\s]+/).filter(Boolean) : null
    const projectRecords = projectStore.list({ limit: 500 })
    if (files && files.length > 0) {
      const affected = findAffectedMemories(cwd, files, projectRecords)
      if (affected.length === 0) {
        return { kind: 'success', text: `No memories affected by changes to: ${files.join(', ')}` }
      }
      const lines = affected.map((a) => `- [${a.record.id}] ${a.record.title} (${a.freshness})`)
      return { kind: 'success', text: `Memories affected by ${files.join(', ')}:\n${lines.join('\n')}` }
    }
    const affected = []
    for (const mem of projectRecords) {
      const f = checkRecordFreshness(mem, cwd)
      if (f.status !== FRESHNESS_STATUS.FRESH) {
        affected.push(`- [${mem.id}] ${mem.title} (${f.status})`)
      }
    }
    return {
      kind: 'success',
      text: affected.length > 0
        ? `Memories with non-fresh code anchors:\n${affected.join('\n')}`
        : 'All memory code anchors are fresh and verified against repository.',
    }
  }

  return { kind: 'error', text: 'Usage: /veyra code [status|index|trace|impact]' }
}

export function registerCommand(ctx, runtime, scope) {
  if (!ctx?.commands || typeof ctx.commands.register !== 'function') return false
  const effect = scope && typeof scope.effect === 'function' ? scope.effect.bind(scope) : null
  const register = () => ctx.commands.register({
    name: 'veyra',
    description: 'Inspect and administer Veyra engineering memory & observatory',
    input: { hint: '[status|observatory|recall|recent|inspect|forget|promote]', attachments: false },
    handler: (invocation) => handleVeyraCommand(runtime, invocation),
  })
  if (effect) effect(register)
  else register()
  return true
}

void KINDS
void resolveVeyraHome
