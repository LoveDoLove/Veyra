/**
 * Veyra — /veyra slash command.
 *
 * Manual control for inspection, administration, and the read-only
 * Knowledge Observatory.
 */

import { AUTHORITIES, KINDS, VALIDATIONS } from './types.mjs'
import { projectIdFor, resolveVeyraHome, resolveWorkspace } from './ids.mjs'
import { openProjectStore, openReusableStore } from './store.mjs'
import { recall } from './retrieve.mjs'
import { promote } from './learn.mjs'
import {
  observatoryCausality,
  observatoryContradictions,
  observatoryLocalGraph,
  observatoryOverview,
  observatoryRecord,
  observatoryRelationships,
  observatorySearch,
} from './observatory.mjs'

function helpText() {
  return [
    'Veyra — Engineering Brain for DSH (v0.1.8)',
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
    '       observatory contradictions          conflicts and opposing claims',
    '/veyra recall [q]                          hybrid search project (+ reusable) memory',
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
      const res = observatoryLocalGraph({ projectStore, reusableStore, id: subArg })
      return { kind: res.ok ? 'success' : 'error', text: res.formatted }
    }

    if (sub === 'graph') {
      if (subArg) {
        const res = observatoryLocalGraph({ projectStore, reusableStore, id: subArg })
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

    return {
      kind: 'error',
      text: [
        `Unknown observatory subcommand: ${sub}`,
        'Available: overview | search <q> | record <id> | causality | local <id> | graph [id] | relationships | contradictions',
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

export function registerCommand(ctx, runtime) {
  if (!ctx?.commands || typeof ctx.commands.register !== 'function') return false
  ctx.commands.register({
    name: 'veyra',
    description: 'Inspect and administer Veyra engineering memory & observatory',
    input: { hint: '[status|observatory|recall|recent|inspect|forget|promote]', attachments: false },
    handler: (invocation) => handleVeyraCommand(runtime, invocation),
  })
  return true
}

void KINDS
void resolveVeyraHome
