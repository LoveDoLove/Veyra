/**
 * Veyra — /veyra slash command.
 *
 * Manual control for inspection and administration. Normal memory
 * behavior does not require this command.
 */

import { AUTHORITIES, KINDS } from './types.mjs'
import { projectIdFor, resolveVeyraHome, resolveWorkspace } from './ids.mjs'
import { openProjectStore, openReusableStore } from './store.mjs'
import { recall } from './retrieve.mjs'
import { promote } from './learn.mjs'

function helpText() {
  return [
    'Veyra — Engineering Brain for DSH',
    '',
    '/veyra              status for this workspace',
    '/veyra recall [q]   search project (+ reusable) memory',
    '/veyra recent       last 8 memories (including candidates)',
    '/veyra inspect <id> show one record',
    '/veyra forget <id>  soft-forget a record',
    '/veyra promote <id> [derived|canonical]',
    '',
    'Canonical promotion is an explicit user action. Automatic capture',
    'never creates authoritative truth. Memory lives in $DSH_HOME/veyra/.',
  ].join('\n')
}

function formatRecord(record) {
  if (!record) return 'not found'
  const ev = record.evidence?.length ? ` evidence=${record.evidence.length}` : ''
  return [
    `${record.id}  ${record.kind}/${record.authority}/${record.validation}/${record.confidence}  ${record.scope}${record.forgotten ? '  FORGOTTEN' : ''}${ev}`,
    record.title,
    record.body,
  ].join('\n')
}

export function handleVeyraCommand(runtime, invocation) {
  const raw = String(invocation?.text || invocation?.input || invocation?.args || '').trim()
  const cwd = resolveWorkspace(invocation?.agent) || runtime.fallbackCwd
  const projectId = projectIdFor(cwd)
  const projectStore = openProjectStore(runtime.veyraHome, projectId)
  const reusableStore = openReusableStore(runtime.veyraHome)
  const [verb, ...rest] = raw.split(/\s+/)
  const arg = rest.join(' ').trim()

  if (!verb || verb === 'help' || verb === 'status') {
    return {
      kind: 'success',
      text: [
        `Veyra project ${projectId}`,
        `workspace: ${cwd}`,
        `home: ${runtime.veyraHome}`,
        `project memories: ${projectStore.count()}`,
        `reusable memories: ${reusableStore.count()}`,
        '',
        helpText(),
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
    return { kind: record ? 'success' : 'error', text: formatRecord(record) }
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
    description: 'Inspect and administer Veyra engineering memory',
    input: { hint: '[status|recall|recent|inspect|forget|promote]', attachments: false },
    handler: (invocation) => handleVeyraCommand(runtime, invocation),
  })
  return true
}

// Keep KINDS imported for potential future /veyra observe listing.
void KINDS
void resolveVeyraHome
