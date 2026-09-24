/**
 * Veyra — DSH tools.
 *
 * Five model-facing tools:
 *   veyra_remember  — keep durable engineering knowledge
 *   veyra_recall    — targeted search beyond automatic context
 *   veyra_inspect   — read one record, including candidates
 *   veyra_forget    — soft-forget a record
 *   veyra_promote   — change standing; canonical requires explicit=true
 *
 * Registered through `@deepseek-ai/dsh-tools` `defineTool` when the peer
 * is available. Falls back to a duck-typed definition so unit tests and
 * non-DSH hosts can still exercise the execute path.
 */

import { AUTHORITIES, CONFIDENCES, KINDS, SCOPES, VALIDATIONS, VALID_AUTHORITIES, VALID_CONFIDENCES, VALID_KINDS, VALID_SCOPES } from './types.mjs'
import { projectIdFor, resolveWorkspace } from './ids.mjs'
import { openProjectStore, openReusableStore } from './store.mjs'
import { inspect, recall, summarizeForPrompt } from './retrieve.mjs'
import { promote, remember } from './learn.mjs'

function loadDefineTool() {
  try {
    // Optional peer. Resolution happens from the running DSH install.
    return import('@deepseek-ai/dsh-tools').then((mod) => mod.defineTool)
  } catch {
    return Promise.resolve(null)
  }
}

function fallbackDefineTool(options) {
  return {
    name: options.name,
    description: options.description,
    parameters: options.parameters,
    output: options.output,
    execute: options.execute,
    presentCall: options.presentCall,
  }
}

function textBlocks(text) {
  return [{ type: 'text', text }]
}

function storesFor(runtime, exec, scope) {
  const cwd = resolveWorkspace(exec?.agent) || runtime.fallbackCwd
  const projectId = projectIdFor(cwd)
  const projectStore = openProjectStore(runtime.veyraHome, projectId)
  const reusableStore = openReusableStore(runtime.veyraHome)
  const store = scope === SCOPES.REUSABLE ? reusableStore : projectStore
  return { cwd, projectId, projectStore, reusableStore, store }
}

function recordView(record) {
  if (!record) return null
  return {
    id: record.id,
    kind: record.kind,
    status: record.status,
    validation: record.validation,
    authority: record.authority,
    confidence: record.confidence,
    scope: record.scope,
    projectId: record.projectId,
    title: record.title,
    body: record.body,
    tags: record.tags,
    evidence: record.evidence,
    relations: record.relations,
    forgotten: record.forgotten,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  }
}

const RECORD_SCHEMA = {
  type: 'object',
  additionalProperties: true,
  properties: {
    id: { type: 'string' },
    kind: { type: 'string' },
    status: { type: 'string' },
    validation: { type: 'string' },
    authority: { type: 'string' },
    confidence: { type: 'string' },
    scope: { type: 'string' },
    title: { type: 'string' },
    body: { type: 'string' },
  },
}

export function buildToolDefinitions(runtime) {
  return [
    {
      name: 'veyra_remember',
      description:
        'Store durable engineering knowledge in Veyra. Use for decisions, root causes, constraints, '
        + 'fix patterns, and reusable lessons. Stored items become derived memory (never canonical). '
        + 'Secrets are redacted. Project scope is the default; use reusable only for experience that '
        + 'is truly project-agnostic.',
      parameters: {
        title: { type: 'string', required: true, description: 'Short title for the memory.' },
        body: { type: 'string', required: true, description: 'The knowledge itself, with enough context to reuse later.' },
        kind: { type: 'string', enum: [...VALID_KINDS], description: 'observation | memory | knowledge | evidence. Default memory.' },
        scope: { type: 'string', enum: [...VALID_SCOPES], description: 'project (default) or reusable.' },
        tags: { type: 'array', items: { type: 'string' }, description: 'Optional short tags.' },
        evidence: {
          type: 'array',
          items: { type: 'object', additionalProperties: true },
          description: 'Optional evidence anchors (path, note, uri).',
        },
        confidence: { type: 'string', enum: [...VALID_CONFIDENCES], description: 'low | medium | high. Default medium.' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: true,
          properties: {
            ok: { type: 'boolean', required: true },
            created: { type: 'boolean' },
            duplicate: { type: 'boolean' },
            redacted: { type: 'boolean' },
            record: RECORD_SCHEMA,
            disclaimer: { type: 'string' },
          },
        },
        render: (_args, value) => textBlocks(
          value.ok
            ? `Remembered ${value.record?.id} as ${value.record?.authority} ${value.record?.kind}${value.duplicate ? ' (duplicate)' : ''}${value.redacted ? ' (secrets redacted)' : ''}.`
            : `Remember failed: ${value.error || 'unknown'}`,
        ),
      },
      execute(args, exec) {
        const scope = args.scope === SCOPES.REUSABLE ? SCOPES.REUSABLE : SCOPES.PROJECT
        const { store, projectId } = storesFor(runtime, exec, scope)
        const written = remember(store, {
          title: args.title,
          body: args.body,
          kind: args.kind,
          scope,
          projectId: scope === SCOPES.REUSABLE ? 'reusable' : projectId,
          tags: args.tags,
          evidence: args.evidence,
          confidence: args.confidence,
          source: {
            sessionId: exec?.agent?.session?.id || null,
            tool: 'veyra_remember',
            automatic: false,
          },
        })
        return {
          ok: true,
          created: written.created,
          duplicate: written.duplicate,
          redacted: written.redacted,
          record: recordView(written.record),
          disclaimer: 'Stored as derived memory, not repository truth. Canonical authority requires an explicit veyra_promote.',
        }
      },
      presentCall: (args) => ({ card: 'generic', title: 'Remember', kind: 'other', rawInput: args.title }),
    },
    {
      name: 'veyra_recall',
      description:
        'Search Veyra memory for relevant engineering experience. Automatic recall already runs '
        + 'each turn; use this for a targeted query. Results are not authoritative.',
      parameters: {
        query: { type: 'string', required: true, description: 'What to look for.' },
        limit: { type: 'number', description: 'Max results (default 5, max 20).' },
        include_reusable: { type: 'boolean', description: 'Include cross-project reusable experience. Default true.' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: true,
          properties: {
            ok: { type: 'boolean', required: true },
            count: { type: 'number' },
            items: { type: 'array', items: RECORD_SCHEMA },
            disclaimer: { type: 'string' },
          },
        },
        render: (_args, value) => textBlocks(
          value.count
            ? summarizeForPrompt(value.items, { heading: `Veyra recall (${value.count})` })
            : 'No matching Veyra memory.',
        ),
      },
      execute(args, exec) {
        const { projectStore, reusableStore } = storesFor(runtime, exec, SCOPES.PROJECT)
        const limit = Math.max(1, Math.min(Number(args.limit) || 5, 20))
        const includeReusable = args.include_reusable !== false
        const items = recall({
          projectStore,
          reusableStore,
          query: args.query,
          limit,
          includeReusable,
        })
        projectStore.touch(items.filter((r) => r.scope !== SCOPES.REUSABLE).map((r) => r.id))
        return {
          ok: true,
          count: items.length,
          items: items.map(recordView),
          disclaimer: 'Recalled memory is not repository truth. Verify before acting.',
        }
      },
      presentCall: (args) => ({ card: 'generic', title: 'Recall', kind: 'read', rawInput: args.query }),
    },
    {
      name: 'veyra_inspect',
      description:
        'Read one Veyra record by id, including candidates and forgotten items. '
        + 'Inspection is not recall and does not grant authority.',
      parameters: {
        id: { type: 'string', required: true, description: 'Record id (vey_…).' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: true,
          properties: {
            ok: { type: 'boolean', required: true },
            record: RECORD_SCHEMA,
          },
        },
        render: (_args, value) => textBlocks(
          value.record
            ? `${value.record.id} [${value.record.authority}/${value.record.validation}] ${value.record.title}\n${value.record.body}`
            : 'Not found.',
        ),
      },
      execute(args, exec) {
        const { projectStore, reusableStore } = storesFor(runtime, exec, SCOPES.PROJECT)
        const record = inspect({ projectStore, reusableStore, id: args.id })
        return { ok: Boolean(record), record: recordView(record) }
      },
      presentCall: (args) => ({ card: 'generic', title: 'Inspect', kind: 'read', rawInput: args.id }),
    },
    {
      name: 'veyra_forget',
      description: 'Soft-forget a Veyra record. It remains inspectable but leaves recall.',
      parameters: {
        id: { type: 'string', required: true, description: 'Record id to forget.' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: true,
          properties: {
            ok: { type: 'boolean', required: true },
            record: RECORD_SCHEMA,
          },
        },
        render: (_args, value) => textBlocks(value.ok ? `Forgot ${value.record?.id}.` : 'Not found.'),
      },
      execute(args, exec) {
        const { projectStore, reusableStore } = storesFor(runtime, exec, SCOPES.PROJECT)
        const existing = inspect({ projectStore, reusableStore, id: args.id })
        if (!existing) return { ok: false, record: null }
        const store = existing.scope === SCOPES.REUSABLE ? reusableStore : projectStore
        return { ok: true, record: recordView(store.forget(args.id)) }
      },
      presentCall: (args) => ({ card: 'generic', title: 'Forget', kind: 'other', rawInput: args.id }),
    },
    {
      name: 'veyra_promote',
      description:
        'Change a record\'s standing. Promoting a candidate to derived marks it as useful learned '
        + 'memory. Promoting to canonical requires explicit=true and should only happen when the '
        + 'user asked to treat the item as project truth. Veyra never auto-promotes to canonical.',
      parameters: {
        id: { type: 'string', required: true, description: 'Record id to promote.' },
        to: { type: 'string', enum: [...VALID_AUTHORITIES], description: 'derived (default) or canonical.' },
        explicit: {
          type: 'boolean',
          description: 'Required true when promoting to canonical. Confirms a user-requested promotion.',
        },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: true,
          properties: {
            ok: { type: 'boolean', required: true },
            error: { type: 'string' },
            record: RECORD_SCHEMA,
          },
        },
        render: (_args, value) => textBlocks(
          value.ok
            ? `Promoted ${value.record?.id} to ${value.record?.authority}.`
            : `Promote failed: ${value.error || 'unknown'}`,
        ),
      },
      execute(args, exec) {
        const to = args.to === AUTHORITIES.CANONICAL ? AUTHORITIES.CANONICAL : AUTHORITIES.DERIVED
        const explicit = args.explicit === true
        const { projectStore, reusableStore } = storesFor(runtime, exec, SCOPES.PROJECT)
        const existing = inspect({ projectStore, reusableStore, id: args.id })
        if (!existing) return { ok: false, error: 'not found' }
        const store = existing.scope === SCOPES.REUSABLE ? reusableStore : projectStore
        const result = promote(store, args.id, { to, explicit })
        return { ok: result.ok, error: result.error, record: recordView(result.record) }
      },
      presentCall: (args) => ({ card: 'generic', title: 'Promote', kind: 'other', rawInput: `${args.id} → ${args.to || 'derived'}` }),
    },
  ]
}

export async function registerTools(ctx, runtime) {
  if (!ctx?.tools || typeof ctx.tools.register !== 'function') return []
  let defineTool
  try {
    defineTool = await loadDefineTool()
  } catch {
    defineTool = null
  }
  if (typeof defineTool !== 'function') defineTool = fallbackDefineTool
  const registered = []
  for (const def of buildToolDefinitions(runtime)) {
    ctx.tools.register(defineTool(def))
    registered.push(def.name)
  }
  return registered
}

/** Direct execute helper for tests (no Cordis). */
export function createToolHarness(runtime) {
  const defs = Object.fromEntries(buildToolDefinitions(runtime).map((d) => [d.name, d]))
  return {
    async call(name, args = {}, exec = {}) {
      const def = defs[name]
      if (!def) throw new Error(`unknown tool ${name}`)
      return def.execute(args, exec)
    },
  }
}
