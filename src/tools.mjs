/**
 * Veyra — DSH tools.
 *
 * Five model-facing tools:
 *   veyra_remember  — keep durable engineering knowledge or RAG knowledge
 *   veyra_recall    — unified hybrid search beyond automatic context
 *   veyra_inspect   — read one record with deep provenance, causal facets, relations
 *   veyra_forget    — soft-forget a record
 *   veyra_promote   — change standing; canonical requires explicit=true
 *
 * Registered through `@deepseek-ai/dsh-tools` `defineTool` when the peer
 * is available. Falls back to a duck-typed definition so unit tests and
 * non-DSH hosts can still exercise the execute path.
 *
 * Output schemas must already be in the dsh-tools *raw* JSON Schema
 * subset. `required` is only legal on `type: "object"` (as a string
 * array). Per-property `required: true` is the author-facing parameter
 * DSL — if `defineTool` cannot be imported (typical for a profile-
 * installed plugin, whose resolver cannot see DSH's node_modules), the
 * raw schema is registered as-is and DSH rejects `required` on
 * booleans/strings with:
 *   unsupported JSON schema: schema.properties.ok.required is not
 *   supported on type "boolean"
 */

import { AUTHORITIES, CONFIDENCES, KINDS, SCOPES, VALIDATIONS, VALID_AUTHORITIES, VALID_CONFIDENCES, VALID_KINDS, VALID_SCOPES } from './types.mjs'
import { projectIdFor, resolveWorkspace } from './ids.mjs'
import { openProjectStore, openReusableStore } from './store.mjs'
import { inspect, recall, summarizeForPrompt } from './retrieve.mjs'
import { promote, remember } from './learn.mjs'
import { CodeIntelligenceEngine } from './code/engine.mjs'
import { FRESHNESS_STATUS } from './code/types.mjs'
import { checkRecordFreshness } from './code/linking.mjs'

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
    output: {
      ...options.output,
      schema: toRawOutputSchema(options.output.schema),
    },
    execute: options.execute,
    presentCall: options.presentCall,
  }
}

/**
 * Project the author-facing value-schema DSL onto the raw subset that
 * `ctx.tools.register` validates. Per-property `required: true` becomes
 * the parent object's `required: string[]`; leftover `required` on
 * scalars (the live-install failure mode) is stripped.
 */
export function toRawOutputSchema(schema) {
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) return schema
  if (Array.isArray(schema.oneOf)) {
    return { ...schema, oneOf: schema.oneOf.map(toRawOutputSchema) }
  }
  if (schema.type === 'array') {
    return schema.items ? { ...schema, items: toRawOutputSchema(schema.items) } : { ...schema }
  }
  if (schema.type !== 'object') {
    if (!Object.hasOwn(schema, 'required')) return schema
    const { required: _drop, ...rest } = schema
    return rest
  }
  const properties = schema.properties && typeof schema.properties === 'object'
    ? schema.properties
    : null
  const lifted = []
  const nextProps = {}
  if (properties) {
    for (const [key, node] of Object.entries(properties)) {
      if (node && typeof node === 'object' && !Array.isArray(node) && node.required === true) {
        lifted.push(key)
        const { required: _drop, ...rest } = node
        nextProps[key] = toRawOutputSchema(rest)
      } else {
        nextProps[key] = toRawOutputSchema(node)
      }
    }
  }
  const required = Array.isArray(schema.required)
    ? [...new Set([...schema.required, ...lifted])]
    : lifted
  const next = { ...schema }
  if (properties) next.properties = nextProps
  if (required.length) next.required = required
  else delete next.required
  return next
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

function jsonSafe(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value))
}

function recordView(record) {
  if (!record) return null
  return jsonSafe({
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
    tags: record.tags || [],
    evidence: record.evidence || [],
    relations: record.relations || [],
    source: record.source || {},
    scores: record.scores || {},
    contradictions: record.contradictions || [],
    contradictionBanners: record.contradictionBanners || [],
    via: record.via || undefined,
    forgotten: Boolean(record.forgotten),
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  })
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
    tags: { type: 'array', items: { type: 'string' } },
    evidence: { type: 'array', items: { type: 'object', additionalProperties: true } },
    relations: { type: 'array', items: { type: 'object', additionalProperties: true } },
    source: { type: 'object', additionalProperties: true },
    scores: { type: 'object', additionalProperties: true },
  },
}

export function buildToolDefinitions(runtime) {
  return [
    {
      name: 'veyra_remember',
      description:
        'Store durable engineering knowledge in Veyra. Use for decisions, root causes, constraints, '
        + 'fix patterns, RAG documentation (kind: \'knowledge\'), and reusable lessons. Stored items become '
        + 'derived memory (never canonical). Secrets are redacted. Project scope is the default; use '
        + 'reusable only for experience that is truly project-agnostic.',
      parameters: {
        title: { type: 'string', required: true, description: 'Short title for the memory.' },
        body: { type: 'string', required: true, description: 'The knowledge itself, with enough context to reuse later.' },
        kind: { type: 'string', enum: [...VALID_KINDS], description: 'observation | memory | knowledge | evidence. Default memory (or knowledge for RAG).' },
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
            ok: { type: 'boolean' },
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
        'Unified Hybrid Search across Veyra memory and RAG knowledge. Combines lexical, semantic, '
        + 'intent, and relationship signals with transparent ranking. Automatic recall already runs '
        + 'each turn; use this for targeted queries beyond automatic context.',
      parameters: {
        query: { type: 'string', required: true, description: 'What to look for.' },
        limit: { type: 'number', description: 'Max results (default 5, max 20).' },
        include_reusable: { type: 'boolean', description: 'Include cross-project reusable experience. Default true.' },
        kind: { type: 'string', enum: [...VALID_KINDS], description: 'Optional kind filter: memory | knowledge | evidence | observation. Omit for unified search.' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: true,
          properties: {
            ok: { type: 'boolean' },
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
          kind: args.kind || null,
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
        'Read one Veyra record by id, including candidates, evidence, causal facets, and relationships. '
        + 'Inspection is not recall and does not grant authority.',
      parameters: {
        id: { type: 'string', required: true, description: 'Record id (vey_…).' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: true,
          properties: {
            ok: { type: 'boolean' },
            record: RECORD_SCHEMA,
          },
        },
        render: (_args, value) => {
          if (!value.record) return textBlocks('Not found.')
          const r = value.record
          const lines = [`${r.id} [${r.authority}/${r.validation}/${r.kind}] ${r.title}`]
          if (r.source?.causal) {
            const c = r.source.causal
            if (c.symptom) lines.push(`Symptom: ${c.symptom}`)
            if (c.rootCause) lines.push(`Root cause: ${c.rootCause}`)
            if (c.remedy) lines.push(`Remedy: ${c.remedy}`)
            if (c.verifiedOutcome) lines.push(`Outcome: ${c.verifiedOutcome}`)
          }
          lines.push(r.body)
          return textBlocks(lines.join('\n'))
        },
      },
      execute(args, exec) {
        const { projectStore, reusableStore } = storesFor(runtime, exec, SCOPES.PROJECT)
        const record = inspect({ projectStore, reusableStore, id: args.id })
        const payload = { ok: Boolean(record) }
        if (record) payload.record = recordView(record)
        return payload
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
            ok: { type: 'boolean' },
            record: RECORD_SCHEMA,
          },
        },
        render: (_args, value) => textBlocks(value.ok ? `Forgot ${value.record?.id}.` : 'Not found.'),
      },
      execute(args, exec) {
        const { projectStore, reusableStore } = storesFor(runtime, exec, SCOPES.PROJECT)
        const existing = inspect({ projectStore, reusableStore, id: args.id })
        if (!existing) return { ok: false }
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
            ok: { type: 'boolean' },
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
        const payload = { ok: result.ok }
        if (result.error) payload.error = result.error
        if (result.record) payload.record = recordView(result.record)
        return payload
      },
      presentCall: (args) => ({ card: 'generic', title: 'Promote', kind: 'other', rawInput: `${args.id} → ${args.to || 'derived'}` }),
    },
    {
      name: 'cbm_projects',
      description: 'List all projects currently indexed in codebase-memory-mcp.',
      parameters: {
        reason: { type: 'string', required: true, description: 'Brief explanation of why you are calling this tool' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: true,
          properties: {
            ok: { type: 'boolean' },
            degraded: { type: 'boolean' },
            message: { type: 'string' },
            projects: { type: 'array' },
          },
        },
        render: (_args, value) => {
          if (value?.degraded) return textBlocks(`Code Intelligence Degraded: ${value?.message || 'Service unavailable'}`)
          if (!value?.projects || value.projects.length === 0) return textBlocks('No projects indexed.')
          return textBlocks(JSON.stringify(value.projects, null, 2))
        },
      },
      async execute(args, exec) {
        const cwd = resolveWorkspace(exec?.agent) || runtime.fallbackCwd
        const engine = runtime.codeEngine || new CodeIntelligenceEngine()
        return await engine.listProjects()
      },
      presentCall: (args) => ({ card: 'generic', title: 'Code Projects', kind: 'read', rawInput: args.reason }),
    },
    {
      name: 'cbm_search',
      description: 'Search the code knowledge graph for symbols, functions, classes, or files. Filter by name_pattern, label (Function, Class, Interface, File), or degree.',
      parameters: {
        name_pattern: { type: 'string', description: 'Regex/substring to filter node names (e.g. ".*auth.*").' },
        label: { type: 'string', description: 'Node label filter: Function | Class | Interface | File' },
        file_path_pattern: { type: 'string', description: 'Regex to filter by file path.' },
        limit: { type: 'number', description: 'Maximum results to return (default 50).' },
        project: { type: 'string', description: 'Project name (e.g. C-repos-myproject). Defaults to current repo.' },
        repo: { type: 'string', description: 'Repository root path as fallback if project name not known.' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: true,
          properties: {
            ok: { type: 'boolean' },
            degraded: { type: 'boolean' },
            message: { type: 'string' },
            raw: { type: 'string' },
          },
        },
        render: (_args, value) => {
          if (value?.degraded) return textBlocks(`Code Intelligence Degraded: ${value?.message || 'Service unavailable'}`)
          return textBlocks(value?.raw || (value?.ok ? 'No matching symbols found.' : value?.message || 'Search failed.'))
        },
      },
      async execute(args, exec) {
        const cwd = resolveWorkspace(exec?.agent) || runtime.fallbackCwd
        const targetRepo = args.repo || cwd
        const engine = runtime.codeEngine || new CodeIntelligenceEngine()
        return await engine.searchSymbols(targetRepo, args)
      },
      presentCall: (args) => ({ card: 'generic', title: 'Search Symbols', kind: 'read', rawInput: args.name_pattern || args.label || '' }),
    },
    {
      name: 'cbm_snippet',
      description: 'Fetch the exact source code snippet for a qualified symbol or function from codebase-memory.',
      parameters: {
        qualified_name: { type: 'string', required: true, description: 'Full qualified name of the symbol (e.g. "app.auth.login").' },
        file_path: { type: 'string', description: 'File path containing the symbol.' },
        start_line: { type: 'number', description: 'Start line (1-based, optional).' },
        end_line: { type: 'number', description: 'End line (optional).' },
        project: { type: 'string', description: 'Project name.' },
        repo: { type: 'string', description: 'Repository root path.' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: true,
          properties: {
            ok: { type: 'boolean' },
            degraded: { type: 'boolean' },
            message: { type: 'string' },
            snippet: { type: 'string' },
          },
        },
        render: (_args, value) => {
          if (value?.degraded) return textBlocks(`Code Intelligence Degraded: ${value?.message || 'Service unavailable'}`)
          return textBlocks(value?.snippet || (value?.ok ? 'No snippet returned.' : value?.message || 'Snippet retrieval failed.'))
        },
      },
      async execute(args, exec) {
        const cwd = resolveWorkspace(exec?.agent) || runtime.fallbackCwd
        const targetRepo = args.repo || cwd
        const engine = runtime.codeEngine || new CodeIntelligenceEngine()
        return await engine.getCodeSnippet(targetRepo, args)
      },
      presentCall: (args) => ({ card: 'generic', title: 'Code Snippet', kind: 'read', rawInput: args.qualified_name }),
    },
    {
      name: 'cbm_trace',
      description: 'Trace inbound/outbound call paths through the knowledge graph from a specific symbol.',
      parameters: {
        symbol: { type: 'string', required: true, description: 'Target symbol or function name to trace from.' },
        direction: { type: 'string', description: 'Trace direction (default "both"): inbound | outbound | both' },
        max_depth: { type: 'number', description: 'Maximum hop depth (default 3).' },
        project: { type: 'string', description: 'Project name.' },
        repo: { type: 'string', description: 'Repository root path.' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: true,
          properties: {
            ok: { type: 'boolean' },
            degraded: { type: 'boolean' },
            message: { type: 'string' },
            raw: { type: 'string' },
          },
        },
        render: (_args, value) => {
          if (value?.degraded) return textBlocks(`Code Intelligence Degraded: ${value?.message || 'Service unavailable'}`)
          return textBlocks(value?.raw || (value?.ok ? 'No call paths found.' : value?.message || 'Trace failed.'))
        },
      },
      async execute(args, exec) {
        const cwd = resolveWorkspace(exec?.agent) || runtime.fallbackCwd
        const targetRepo = args.repo || cwd
        const engine = runtime.codeEngine || new CodeIntelligenceEngine()
        return await engine.traceCallPath(targetRepo, args)
      },
      presentCall: (args) => ({ card: 'generic', title: 'Trace Calls', kind: 'read', rawInput: args.symbol }),
    },
    {
      name: 'cbm_arch',
      description: 'Get an architectural summary of a directory: key components, entry points, and dependencies.',
      parameters: {
        directory: { type: 'string', description: 'Subdirectory to analyze (relative to repo root).' },
        depth: { type: 'number', description: 'Analysis depth (default 2).' },
        project: { type: 'string', description: 'Project name.' },
        repo: { type: 'string', description: 'Repository root path.' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: true,
          properties: {
            ok: { type: 'boolean' },
            degraded: { type: 'boolean' },
            message: { type: 'string' },
            raw: { type: 'string' },
          },
        },
        render: (_args, value) => {
          if (value?.degraded) return textBlocks(`Code Intelligence Degraded: ${value?.message || 'Service unavailable'}`)
          return textBlocks(value?.raw || (value?.ok ? 'No architectural summary available.' : value?.message || 'Arch query failed.'))
        },
      },
      async execute(args, exec) {
        const cwd = resolveWorkspace(exec?.agent) || runtime.fallbackCwd
        const targetRepo = args.repo || cwd
        const engine = runtime.codeEngine || new CodeIntelligenceEngine()
        return await engine.getArchitecture(targetRepo, args)
      },
      presentCall: (args) => ({ card: 'generic', title: 'Architecture Summary', kind: 'read', rawInput: args.directory || '' }),
    },
    {
      name: 'cbm_search_code',
      description: 'Fast textual regex search over indexed repository files in codebase-memory.',
      parameters: {
        query: { type: 'string', required: true, description: 'Search term or regex pattern.' },
        file_pattern: { type: 'string', description: 'Glob/regex to restrict file paths.' },
        limit: { type: 'number', description: 'Maximum results (default 50).' },
        project: { type: 'string', description: 'Project name.' },
        repo: { type: 'string', description: 'Repository root path.' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: true,
          properties: {
            ok: { type: 'boolean' },
            degraded: { type: 'boolean' },
            message: { type: 'string' },
            results: { type: 'string' },
          },
        },
        render: (_args, value) => {
          if (value?.degraded) return textBlocks(`Code Intelligence Degraded: ${value?.message || 'Service unavailable'}`)
          return textBlocks(value?.results || (value?.ok ? 'No matches found.' : value?.message || 'Search failed.'))
        },
      },
      async execute(args, exec) {
        const cwd = resolveWorkspace(exec?.agent) || runtime.fallbackCwd
        const targetRepo = args.repo || cwd
        const engine = runtime.codeEngine || new CodeIntelligenceEngine()
        return await engine.searchCodeText(targetRepo, args)
      },
      presentCall: (args) => ({ card: 'generic', title: 'Search Code Text', kind: 'read', rawInput: args.query }),
    },
    {
      name: 'veyra_code_status',
      description: 'Inspect Veyra repository code index status, freshness, and affected memories.',
      parameters: {
        repo: { type: 'string', description: 'Repository root path (defaults to current workspace).' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: true,
          properties: {
            ok: { type: 'boolean' },
            status: { type: 'string' },
            degraded: { type: 'boolean' },
            message: { type: 'string' },
            freshMemories: { type: 'number' },
            staleMemories: { type: 'number' },
            invalidMemories: { type: 'number' },
          },
        },
        render: (_args, value) => {
          const lines = [
            `Index Status: ${value?.status || 'unknown'} (degraded: ${Boolean(value?.degraded)})`,
          ]
          if (value?.message) lines.push(`Message: ${value.message}`)
          if (typeof value?.freshMemories === 'number') {
            lines.push(`Memories: ${value.freshMemories} fresh, ${value.staleMemories} stale, ${value.invalidMemories} invalid`)
          }
          return textBlocks(lines.join('\n'))
        },
      },
      async execute(args, exec) {
        const cwd = resolveWorkspace(exec?.agent) || runtime.fallbackCwd
        const targetRepo = args.repo || cwd
        const engine = runtime.codeEngine || new CodeIntelligenceEngine()
        const status = await engine.getStatus(targetRepo)

        const projectId = projectIdFor(targetRepo)
        const projectStore = openProjectStore(runtime.veyraHome, projectId)
        const memories = projectStore ? projectStore.list({ limit: 500 }) : []
        let freshCount = 0
        let staleCount = 0
        let invalidCount = 0

        for (const mem of memories) {
          const f = checkRecordFreshness(mem, targetRepo)
          if (f.status === FRESHNESS_STATUS.FRESH) freshCount++
          else if (f.status === FRESHNESS_STATUS.POTENTIALLY_STALE) staleCount++
          else if (f.status === FRESHNESS_STATUS.INVALID) invalidCount++
        }

        return {
          ok: true,
          status: status?.status || 'unindexed',
          degraded: Boolean(status?.degraded),
          message: status?.message || null,
          freshMemories: freshCount,
          staleMemories: staleCount,
          invalidMemories: invalidCount,
        }
      },
      presentCall: (args) => ({ card: 'generic', title: 'Code Status', kind: 'read', rawInput: args.repo || '' }),
    },
  ]
}

export async function registerTools(ctx, runtime, scope) {
  if (!ctx?.tools || typeof ctx.tools.register !== 'function') return []
  let defineTool
  try {
    defineTool = await loadDefineTool()
  } catch {
    defineTool = null
  }
  if (typeof defineTool !== 'function') defineTool = fallbackDefineTool
  const effect = scope && typeof scope.effect === 'function' ? scope.effect.bind(scope) : null
  const registered = []
  const failures = []
  for (const def of buildToolDefinitions(runtime)) {
    try {
      const register = () => ctx.tools.register(defineTool(def))
      if (effect) effect(register)
      else register()
      registered.push(def.name)
    } catch (err) {
      failures.push(`${def.name}: ${err instanceof Error ? err.message : String(err)}`)
    }
  }
  if (failures.length && runtime?.log?.warn) {
    runtime.log.warn(`[veyra] tool register failed: ${failures.join('; ')}`)
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
