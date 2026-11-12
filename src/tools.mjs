/**
 * Veyra — DSH tools.
 *
 * Eleven model-facing tools:
 *   veyra_remember  — keep durable engineering knowledge or RAG knowledge
 *   veyra_recall    — unified hybrid search beyond automatic context
 *   veyra_inspect   — read one record with deep provenance, causal facets, relations
 *   veyra_forget    — soft-forget a record
 *   veyra_promote   — change standing; canonical requires explicit=true
 *   veyra_feedback  — §19: report a real application outcome; success strengthens,
 *                     failure records history and decreases reliability
 *   veyra_recurrence — §20: detect recurring root cause/symptom/failed approach,
 *                     optionally gate a remedy-consistent cluster into a candidate
 *   veyra_health    — §21: read-only memory-health categories & maintenance
 *                     findings; never mutates authority or records
 *   veyra_code_status     — freshness of Code Intelligence for a repository;
 *                           reports degraded when the bridge is absent
 *   veyra_change_impact   — which memories a code change may affect
 *   veyra_stale_ledger    — review ledger of memories whose anchors no longer resolve
 *
 * The six `cbm_*` tools are not defined here: they belong to the Codebase
 * Memory plugin, which registers them from its own `apply()`.
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

import { AUTHORITIES, CODE_FRESHNESS, CONFIDENCES, KINDS, SCOPES, VALIDATIONS, VALID_AUTHORITIES, VALID_CONFIDENCES, VALID_KINDS, VALID_SCOPES } from './types.mjs'
import { provenanceDimensions, resolveWorkspace } from './ids.mjs'

import { MEMORY_OPERATIONS } from './memory-router.mjs'
import { RELEVANCE_SEM_FLOOR, inspect, recall, summarizeForPrompt, temporalState } from './retrieve.mjs'
import { tokenOverlap } from './text.mjs'
import { provenanceChain } from './context.mjs'
import { promote, readWriteGateLedger, readWriteGateTrace, remember } from './learn.mjs'
import { forget as lifecycleForget } from './lifecycle.mjs'
import { detectRecurrence, eligibleForCandidate, recordFeedback, recurrenceCandidate } from './feedback.mjs'
import { memoryHealth, renderHealth } from './health.mjs'
import { readGenerationEvidence, summarizeGenerationEvidence, recordExplicitOutcomeLink } from './apply-generation-evidence.mjs'
import { checkRecordFreshness, checkAnchorFreshness, extractAnchorsFromRecord, findAffectedMemories, buildStaleReviewCandidate } from './code/linking.mjs'
import { createDegradedEngine, isCodeIntelligenceAvailable, resolveRepoPath } from './cbm-bridge.mjs'
import { classifyRecordTrust, TRUST_CATEGORIES } from './trust.mjs'
import { annotateContradictions } from './evolve.mjs'

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

/**
 * Resolve the stores a tool call may touch, or throw.
 *
 * Fail closed in both directions. Without a Memory Server there is no
 * workspace binding, and the only store a path could name is the legacy one
 * this architecture no longer reads or writes. With a server, a refusal
 * (`workspace-unresolved`, `workspace-registry-unavailable`, …) is equally
 * fatal to the call: a tool that cannot name its room must not guess.
 */
function requireStores(server, resolved) {
  if (!server) {
    const err = new Error('Veyra memory unavailable: memory-server-unavailable')
    err.code = 'VEYRA_MEMORY_UNAVAILABLE'
    throw err
  }
  if (!resolved.ok) {
    const err = new Error(`Veyra memory unavailable: ${resolved.reason}`)
    err.code = 'VEYRA_MEMORY_UNAVAILABLE'
    throw err
  }
  return resolved
}

function storesFor(runtime, exec, scope, operation = MEMORY_OPERATIONS.WRITE_MANUAL) {
  const server = runtime.memoryServer
  if (!server) requireStores(null, null)
  // The router decides which stores the operation may touch. Manual tools
  // default to write access; read-only tools pass their own operation so the
  // decision stays honest.
  const stores = requireStores(server, server.storesFor(exec?.agent, operation))
  const store = scope === SCOPES.REUSABLE ? stores.reusableStore : stores.projectStore
  return {
    cwd: stores.cwd,
    projectId: stores.projectId,
    projectStore: stores.projectStore,
    reusableStore: stores.reusableStore,
    store,
    binding: stores.binding,
  }
}

/**
 * Stores for an explicit repository path rather than the caller's own agent.
 *
 * `veyra_code_status` and `veyra_stale_ledger` take an `args.repo`, so they
 * must resolve THAT path to its own workspace room instead of borrowing the
 * caller's. Resolving by path keeps the promise the room model makes: the
 * store belongs to the workspace that owns the directory, and a directory no
 * workspace owns yields nothing rather than someone else's memory.
 */
function storesForRepository(runtime, repoPath, operation = MEMORY_OPERATIONS.INSPECT) {
  const server = runtime.memoryServer
  // Guard before dereferencing: `requireStores(server, server.storesForPath(…))`
  // evaluates its arguments first, so a missing server would raise a raw
  // TypeError instead of the clean `VEYRA_MEMORY_UNAVAILABLE` refusal every
  // other tool path produces.
  if (!server) requireStores(null, null)
  const stores = requireStores(server, server.storesForPath(repoPath, operation))
  return {
    cwd: stores.cwd,
    projectId: stores.projectId,
    projectStore: stores.projectStore,
    reusableStore: stores.reusableStore,
    store: stores.projectStore,
    binding: stores.binding,
  }
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
    // Phase 4 §11/§13 — "still valid?" and "applicable here?" answered
    // straight from the view: validity state on the temporal axis plus
    // the context captured when the memory was written.
    temporal: temporalState(record),
    // Omit entirely (|| undefined → stripped by jsonSafe) when absent:
    // the tool output schema types context as 'object', and JSON null
    // fails that assertion (RCA: veyra_inspect context:null).
    context: record.source?.context || undefined,
    contradictions: record.contradictions || [],
    contradictionBanners: record.contradictionBanners || [],
    via: record.via || undefined,
    negativeCoverage: record.negativeCoverage || undefined,
    negLayer: record.negLayer || undefined,
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
    temporal: {
      type: 'string',
      enum: ['current', 'not_yet_effective', 'expired'],
      description: '§13 validity state derived from source.temporal (validFrom/validUntil).',
    },
    context: {
      type: 'object',
      additionalProperties: true,
      description: '§12 applicability context captured at write time (os, runtime, agent-supplied keys).',
    },
  },
}

export function buildToolDefinitions(runtime) {
  return [
    {
      name: 'veyra_remember',
      description:
        'Store durable engineering knowledge in Veyra. After producing a verified, durable, reusable '
        + 'engineering outcome (non-obvious root cause, verified fix pattern, durable architecture decision, '
        + 'or project constraint), proactively consider recording it. Record only evidence-backed, project-'
        + 'specific knowledge; never store temporary state, unsupported assumptions, secrets, or transient '
        + 'conversation noise. Stored items become derived memory (never canonical) — canonical authority '
        + 'requires explicit veyra_promote. Secrets are redacted. Project scope is the default; use '
        + 'reusable only for experience that is truly project-agnostic.',
      parameters: {
        title: { type: 'string', required: true, description: 'Short title for the memory.' },
        body: { type: 'string', required: true, description: 'The knowledge itself, with enough context to reuse later.' },
        kind: { type: 'string', enum: [...VALID_KINDS], description: 'observation | memory | knowledge | evidence | negative (known failed approach) | unresolved (known open investigation). Default memory (or knowledge for RAG). negative: title = hypothesis, body = rejection reason. unresolved: title = question, body = known clues.' },
        scope: { type: 'string', enum: [...VALID_SCOPES], description: 'project (default) or reusable.' },
        tags: { type: 'array', items: { type: 'string' }, description: 'Optional short tags.' },
        evidence: {
          type: 'array',
          description: 'Optional evidence anchors (path, note, uri).',
          items: {
            type: 'object',
            description: 'Evidence anchor item.',
            additionalProperties: true,
            properties: {
              path: { type: 'string', description: 'Repository file path anchor.' },
              note: { type: 'string', description: 'Evidence note, symptom, or observation details.' },
              uri: { type: 'string', description: 'External URI or document reference.' },
            },
          },
        },
        confidence: { type: 'string', enum: [...VALID_CONFIDENCES], description: 'low | medium | high. Default medium.' },
        validFrom: { type: 'string', description: 'Optional §13 ISO date: when this knowledge takes effect (before that it reads as not_yet_effective, never hidden).' },
        validUntil: { type: 'string', description: 'Optional §13 ISO date: when this knowledge expires (after that it reads as expired — demoted, never deleted).' },
        context: {
          type: 'object',
          description: 'Optional §12 applicability context (toolchain, version, taskType, …). os/runtime are auto-captured; supplied keys win.',
          additionalProperties: true,
          properties: {
            toolchain: { type: 'string', description: 'Toolchain or compiler version.' },
            version: { type: 'string', description: 'Package or software version.' },
            taskType: { type: 'string', description: 'Task category or type.' },
          },
        },
        id: { type: 'string', description: 'Existing record id — updates that record instead of creating one.' },
        repair: { type: 'boolean', description: '§25 explicit repair: rewrite a structurally corrupted record (broken JSON columns or invalid enums). Refused unless the record is actually corrupted; corrupt bytes are preserved otherwise.' },
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
        const { store, projectId, cwd } = storesFor(runtime, exec, scope)
        try {
          const written = remember(store, {
          title: args.title,
          body: args.body,
          kind: args.kind,
          scope,
          projectId: scope === SCOPES.REUSABLE ? 'reusable' : projectId,
          tags: args.tags,
          evidence: args.evidence,
          confidence: args.confidence,
          validFrom: args.validFrom,
          validUntil: args.validUntil,
          context: args.context,
          ...(args.id ? { id: args.id } : {}),
          source: {
            sessionId: exec?.agent?.session?.id || null,
            tool: 'veyra_remember',
            automatic: false,
            // §15 — attribution dimensions (workspace/repository/agent).
            // `origins` stays absent on deliberate writes: capture-stream
            // provenance is never fabricated, so the M9 learning gate
            // reads exactly as before (provenance ≠ authority).
            provenance: provenanceDimensions(cwd, exec?.agent),
          },
        }, { repair: args.repair === true })
        return {
          ok: true,
          created: written.created,
          duplicate: written.duplicate,
          redacted: written.redacted,
          record: recordView(written.record),
          disclaimer: 'Stored as derived memory, not repository truth. Canonical authority requires an explicit veyra_promote.',
        }
        } catch (err) {
          // §25 fail-closed refusals (corrupt overwrite, repair verification)
          // surface as a result, not a thrown tool error.
          return { ok: false, error: err instanceof Error ? err.message : String(err) }
        }
      },
      presentCall: (args) => ({ card: 'generic', title: 'Remember', kind: 'other', rawInput: args.title }),
    },
    {
      name: 'veyra_recall',
      description:
        'Search durable engineering memory, architecture decisions, past troubleshooting solutions, '
        + 'constraints, and RAG knowledge. At the beginning of a new non-trivial engineering task, '
        + 'proactively perform a targeted recall for relevant historical knowledge. An injected recall '
        + 'snapshot is supplementary context, not a replacement for initial targeted recall. If no '
        + 'applicable memory is found, continue normal work immediately — never block on empty recall. '
        + 'Avoid unnecessary repeated recall calls for the same unresolved question. Never use for '
        + 'session continuity or current turn progress. Verify recalled knowledge against current '
        + 'repository evidence before acting; similarity is not authority.',
      parameters: {
        query: { type: 'string', required: true, description: 'What to look for.' },
        goal: { type: 'string', description: 'Optional goal-directed routing: the task you are working toward. Steers ranking toward relevant experience; it is a direction, never an authority, and never promotes or demotes anything. Omit for ordinary search.' },
        limit: { type: 'number', description: 'Max results (default 5, max 20).' },
        include_reusable: { type: 'boolean', description: 'Include cross-project reusable experience. Default true.' },
        kind: { type: 'string', enum: [...VALID_KINDS], description: 'Optional kind filter: memory | knowledge | evidence | observation | negative | unresolved. Omit for unified search (known-failed/unresolved then surface only as a bounded zero-score coverage tail).' },
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
        const { projectStore, reusableStore } = storesFor(runtime, exec, SCOPES.PROJECT, MEMORY_OPERATIONS.RECALL_MANUAL)
        const limit = Math.max(1, Math.min(Number(args.limit) || 5, 20))
        const includeReusable = args.include_reusable !== false
        // Phase 10 — goal is caller-supplied routing context only.
        const goal = String(args.goal ?? '').trim() ? args.goal : null
        const items = recall({
          projectStore,
          reusableStore,
          query: args.query,
          goal,
          limit,
          includeReusable,
          kind: args.kind || null,
        })
        // The library keeps zero-signal candidates recallable (recency pool).
        // At the tool surface that reads as an answer to a question it did not
        // answer, so a non-empty query with no genuine signal returns nothing.
        // FTS rank is not a signal test here: toFtsQuery OR-joins stopwords
        // ("and"), which match almost every body and yield relevance 1.
        // Evidence note/path/uri/anchor is included because veyra_search_text
        // indexes it (store.mjs): an evidence-only FTS match is genuine signal
        // even when title/body/tags share no query tokens.
        const evidenceSignalText = (ev) => {
          if (!Array.isArray(ev)) return ''
          const parts = []
          for (const e of ev) {
            if (!e) continue
            if (typeof e === 'string') { parts.push(e); continue }
            for (const k of ['note', 'path', 'uri', 'anchor']) {
              if (typeof e[k] === 'string' && e[k]) parts.push(e[k])
            }
          }
          return parts.join(' ')
        }
        const queryText = String(args.query ?? '').trim()
        const hasSignal = items.some((r) => r.negativeCoverage === true
          || tokenOverlap(queryText, [r.title || '', r.body || '', ...(r.tags || []), evidenceSignalText(r.evidence)].join(' ')).hits > 0
          || Number(r.scores?.semantic) >= RELEVANCE_SEM_FLOOR)
        const visible = queryText && !hasSignal ? [] : items
        projectStore.touch(visible.filter((r) => r.scope !== SCOPES.REUSABLE).map((r) => r.id))
        return {
          ok: true,
          count: visible.length,
          items: visible.map(recordView),
          disclaimer: 'Recalled memory is not repository truth. Verify before acting.',
        }
      },
      presentCall: (args) => ({ card: 'generic', title: 'Recall', kind: 'read', rawInput: args.query }),
    },
    {
      name: 'veyra_inspect',
      description:
        'Read one Veyra record by id in full: evidence anchors, causal facets, provenance, and relationships. '
        + 'Use when a recalled memory summary needs full details before applying.',
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
            chain: {
              type: 'array',
              description: '§16 memory provenance chain — Observation → … → Update/Supersession.',
              items: { type: 'object', additionalProperties: true },
            },
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
          if (value.chain?.length) {
            lines.push('')
            lines.push('Provenance chain (§16):')
            for (const row of value.chain) lines.push(`  ${row.stage}: ${row.state} — ${row.detail}`)
          }
          return textBlocks(lines.join('\n'))
        },
      },
      execute(args, exec) {
        const { projectStore, reusableStore } = storesFor(runtime, exec, SCOPES.PROJECT, MEMORY_OPERATIONS.INSPECT)
        const record = inspect({ projectStore, reusableStore, id: args.id })
        const payload = { ok: Boolean(record) }
        if (record) {
          payload.record = recordView(record)
          payload.chain = provenanceChain(record)
        }
        return payload
      },
      presentCall: (args) => ({ card: 'generic', title: 'Inspect', kind: 'read', rawInput: args.id }),
    },
    {
      name: 'veyra_forget',
      description:
        'Soft-forget a Veyra record. It remains inspectable but leaves recall. The reason '
        + 'is preserved in the record\'s lifecycle history. Protected records (canonical '
        + 'authority or explicitly protected) require override=true with a reason.',
      parameters: {
        id: { type: 'string', required: true, description: 'Record id to forget.' },
        reason: { type: 'string', description: 'Why the record is being forgotten — preserved in source.lifecycle.' },
        override: {
          type: 'boolean',
          description: 'Required true to forget a protected record; the reason is recorded as the justification.',
        },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: true,
          properties: {
            ok: { type: 'boolean' },
            record: RECORD_SCHEMA,
            error: { type: 'string' },
          },
        },
        render: (_args, value) => textBlocks(value.ok ? `Forgot ${value.record?.id}.` : (value.error || 'Not found.')),
      },
      execute(args, exec) {
        const { projectStore, reusableStore } = storesFor(runtime, exec, SCOPES.PROJECT)
        const existing = inspect({ projectStore, reusableStore, id: args.id })
        if (!existing) return { ok: false, error: 'not found' }
        const store = existing.scope === SCOPES.REUSABLE ? reusableStore : projectStore
        const result = lifecycleForget(store, args.id, {
          why: args.reason == null ? '' : String(args.reason),
          override: args.override === true,
        })
        if (!result.ok) return { ok: false, error: result.error }
        return { ok: true, record: recordView(result.record) }
      },
      presentCall: (args) => ({ card: 'generic', title: 'Forget', kind: 'other', rawInput: args.id }),
    },
    {
      name: 'veyra_promote',
      description:
        'Change a record\'s standing. Promoting a candidate to derived marks it as useful learned '
        + 'memory. Promoting to canonical requires explicit=true and should only happen when the '
        + 'user asked to treat the item as project truth. Veyra never auto-promotes to canonical. '
        + 'Set central=true to publish a workspace record into the shared Central Memories through '
        + 'the governed promotion path (evidence required, candidates refused, no silent overwrite).',
      parameters: {
        id: { type: 'string', required: true, description: 'Record id to promote.' },
        to: { type: 'string', enum: [...VALID_AUTHORITIES], description: 'derived (default) or canonical.' },
        explicit: {
          type: 'boolean',
          description: 'Required true when promoting to canonical. Confirms a user-requested promotion.',
        },
        central: {
          type: 'boolean',
          description: 'Publish this workspace record into Central Memories instead of only raising its local authority.',
        },
        reason: { type: 'string', description: 'Short reason recorded in the promotion ledger.' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: true,
          properties: {
            ok: { type: 'boolean' },
            error: { type: 'string' },
            record: RECORD_SCHEMA,
            central: { type: 'boolean' },
            action: { type: 'string' },
            centralId: { type: 'string' },
            authority: { type: 'string' },
          },
        },
        render: (_args, value) => textBlocks(
          value.ok
            ? (value.central
              ? `Central promotion ${value.action} (${value.centralId}) at ${value.authority}.`
              : `Promoted ${value.record?.id} to ${value.record?.authority}.`)
            : `Promote failed: ${value.error || 'unknown'}`,
        ),
      },
      execute(args, exec) {
        const to = args.to === AUTHORITIES.CANONICAL ? AUTHORITIES.CANONICAL : AUTHORITIES.DERIVED
        const explicit = args.explicit === true
        if (args.central === true) {
          const server = runtime.memoryServer
          if (!server) return { ok: false, error: 'central memories unavailable' }
          const result = server.promote({
            agent: exec?.agent,
            id: args.id,
            to,
            explicit,
            reason: typeof args.reason === 'string' ? args.reason : '',
          })
          if (!result.ok) return { ok: false, error: result.reason }
          return {
            ok: true,
            central: true,
            action: result.action,
            centralId: result.centralId,
            authority: result.authority,
          }
        }
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
      name: 'veyra_feedback',
      description:
        'Report the real-world outcome of APPLYING a Veyra memory (§19 feedback loop). '
        + 'success = the memory guidance was applied and verified working → the record strengthens '
        + '(observation ladder, validation/confidence progression). failure = it was applied and did '
        + 'not work → failure history is recorded and reliability decreases (validation and confidence '
        + 'demote one step; canonical records keep their validation — only history is recorded). '
        + 'Use after verifying a recalled fix or decision in practice.',
      parameters: {
        id: { type: 'string', required: true, description: 'Record id that was applied.' },
        outcome: { type: 'string', enum: ['success', 'failure'], required: true, description: 'success or failure of the application.' },
        note: { type: 'string', description: 'Short outcome note, e.g. "tests failed: writer timeout".' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: true,
          properties: {
            ok: { type: 'boolean' },
            error: { type: 'string' },
            record: RECORD_SCHEMA,
            feedback: { type: 'object', additionalProperties: true },
            previous: { type: 'object', additionalProperties: true },
          },
        },
        render: (_args, value) => {
          if (!value.ok) return textBlocks(`Feedback rejected: ${value.error || 'unknown'}`)
          const fb = value.feedback || {}
          const base = `Feedback recorded for ${value.record?.id}: ${fb.successes} success / ${fb.failures} failure (reliability ${fb.reliability}).`
          if (value.previous && (
            value.previous.validation !== value.record?.validation
            || value.previous.confidence !== value.record?.confidence
          )) {
            return textBlocks(`${base} Reliability decreased: validation ${value.previous.validation} → ${value.record?.validation}, confidence ${value.previous.confidence} → ${value.record?.confidence}.`)
          }
          return textBlocks(`${base} validation ${value.record?.validation}, confidence ${value.record?.confidence}.`)
        },
      },
      execute(args, exec) {
        const { projectStore, reusableStore } = storesFor(runtime, exec, SCOPES.PROJECT)
        const existing = inspect({ projectStore, reusableStore, id: args.id })
        if (!existing) return { ok: false, error: 'record not found' }
        const store = existing.scope === SCOPES.REUSABLE ? reusableStore : projectStore
        const res = recordFeedback(store, { id: args.id, outcome: args.outcome, note: args.note ?? null })
        let outcomeLink = null
        if (res.ok && typeof args.generationEventId === 'string' && args.generationEventId.trim()) {
          try { outcomeLink = recordExplicitOutcomeLink(store, { recordId: args.id, outcome: args.outcome, generationEventId: args.generationEventId.trim() }) } catch {}
        }
        if (!res.ok) return { ok: false, error: res.error }
        return {
          ok: true,
          record: recordView(res.record),
          feedback: res.feedback,
          previous: res.previous,
        }
      },
      presentCall: (args) => ({ card: 'generic', title: 'Feedback', kind: 'other', rawInput: `${args.outcome}: ${args.id}` }),
    },
    {
      name: 'veyra_recurrence',
      description:
        'Detect recurring engineering failures (§20): the same root cause, symptom, failed approach '
        + 'or remedy across records, or one record whose applications repeatedly failed. Read-only by '
        + 'default. With autoCandidate=true, a cluster that shares ONE verified remedy becomes a gated '
        + 'candidate for stronger engineering knowledge (write gate decides; canonical never automatic).',
      parameters: {
        threshold: { type: 'number', description: 'Minimum incidents per pattern (default 3, clamped to 2–50).' },
        autoCandidate: { type: 'boolean', description: 'Turn an eligible remedy-consistent root-cause cluster into a write-gate candidate. Default false.' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: true,
          properties: {
            ok: { type: 'boolean' },
            threshold: { type: 'number' },
            findings: { type: 'array', items: { type: 'object', additionalProperties: true } },
            candidates: { type: 'array', items: { type: 'object', additionalProperties: true } },
          },
        },
        render: (_args, value) => {
          if (!value.findings?.length) return textBlocks(`No recurring engineering problem detected at threshold ${value.threshold}.`)
          const lines = value.findings.map((f) => {
            const extras = []
            if (f.remedyConsistent) extras.push('one remedy')
            if (f.verifiedRemedy) extras.push('verified outcome')
            if (f.failureCount) extras.push(`${f.failureCount} failed applications`)
            return `  ${f.kind} [${f.count}]: "${f.key}"${extras.length ? ` — ${extras.join(', ')}` : ''}`
          })
          const head = `Recurrence scan (§20): ${value.findings.length} pattern(s) at threshold ${value.threshold}.`
          const cand = (value.candidates || []).length
            ? value.candidates.map((c) => `  candidate ${c.decision}: ${c.reason}${c.id ? ` → ${c.id}` : ''}`).join('\n')
            : (value.autoCandidate ? '  no eligible cluster (needs same root cause, one remedy, a verified outcome).' : '')
          return textBlocks([head, ...lines, ...(cand ? [cand] : [])].join('\n'))
        },
      },
      execute(args, exec) {
        const { cwd, projectStore, reusableStore } = storesFor(runtime, exec, SCOPES.PROJECT)
        const threshold = Math.max(2, Math.min(50, Number(args.threshold) || 3))
        const byId = new Map()
        for (const r of [...projectStore.list({ limit: 500 }), ...reusableStore.list({ limit: 500 })]) {
          if (r?.id && !byId.has(r.id)) byId.set(r.id, r)
        }
        const findings = detectRecurrence([...byId.values()], { threshold })
        const candidates = []
        if (args.autoCandidate === true) {
          for (const finding of findings.filter(eligibleForCandidate)) {
            const members = finding.recordIds.map((id) => byId.get(id)).filter(Boolean)
            const owner = members[0]?.scope === SCOPES.REUSABLE ? reusableStore : projectStore
            const res = recurrenceCandidate(owner, finding, members, { workspace: cwd })
            candidates.push({
              kind: finding.kind,
              key: finding.key,
              decision: res.decision,
              reason: res.reason,
              ...(res.record?.id ? { id: res.record.id } : {}),
            })
          }
        }
        return { ok: true, threshold, findings, candidates, autoCandidate: args.autoCandidate === true }
      },
      presentCall: (args) => ({ card: 'generic', title: 'Recurrence', kind: 'other', rawInput: `threshold ${args.threshold ?? 3}${args.autoCandidate ? ' + candidate' : ''}` }),
    },
    {
      name: 'veyra_health',
      description:
        'Memory-health report (§21): the nine quality categories (verified/reviewed/unverified/stale/'
        + 'invalid/contradicted/unresolved/negative/protected) and six maintenance findings (new '
        + 'contradictions, stale knowledge, unresolved investigations, repeated failures, unverified '
        + 'high-value candidates, memories requiring revalidation). Read-only — findings are evidence '
        + 'for explicit review, never automatic edits; contradictions stay visible.',
      parameters: {
        failureThreshold: { type: 'number', description: 'Failures required for a repeated-failure finding (default 2, clamped to 2–50).' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: true,
          properties: {
            ok: { type: 'boolean' },
            scanned: { type: 'number' },
            threshold: { type: 'number' },
            totalFindings: { type: 'number' },
            categories: { type: 'object', additionalProperties: true },
            counts: { type: 'object', additionalProperties: true },
            findings: { type: 'object', additionalProperties: true },
            writeGate: {
              description: 'Write-gate accounting: counts of ACCEPT/MERGE/DROP/DEFER learning decisions and their reasons. Null when no learning decision was recorded.',
              oneOf: [
                { type: 'object', additionalProperties: true },
                { type: 'null' },
              ],
            },
          },
        },
        render: (_args, value) => textBlocks(renderHealth(value)),
      },
      execute(args, exec) {
        const { cwd, projectStore, reusableStore } = storesFor(runtime, exec, SCOPES.PROJECT, MEMORY_OPERATIONS.HEALTH)
        const failureThreshold = Math.max(2, Math.min(50, Number(args.failureThreshold) || 2))
        const byId = new Map()
        for (const r of [...projectStore.list({ limit: 1000 }), ...reusableStore.list({ limit: 1000 })]) {
          if (r?.id && !byId.has(r.id)) byId.set(r.id, r)
        }
        // Write-gate accounting rides the same read-only report: it explains
        // learning decisions that produced no record (DROP / DEFER / MERGE).
        const writeGate = readWriteGateLedger(projectStore)
        const writeGateTrace = readWriteGateTrace(projectStore)
        const applyGeneration = summarizeGenerationEvidence(readGenerationEvidence(projectStore))
        const report = memoryHealth([...byId.values()], { workspace: cwd, failureThreshold, writeGate, writeGateTrace, applyGeneration })
        return { ok: true, ...report }
      },
      presentCall: (args) => ({ card: 'generic', title: 'Memory health', kind: 'other', rawInput: `failure threshold ${args.failureThreshold ?? 2}` }),
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
        const engine = runtime.codeEngine || createDegradedEngine()
        const status = await engine.getStatus(targetRepo)

        const projectStore = storesForRepository(runtime, targetRepo).projectStore
        const memories = projectStore ? projectStore.list({ limit: 500 }) : []
        let freshCount = 0
        let staleCount = 0
        let invalidCount = 0

        for (const mem of memories) {
          const f = checkRecordFreshness(mem, targetRepo)
          if (f.status === CODE_FRESHNESS.FRESH) freshCount++
          else if (f.status === CODE_FRESHNESS.POTENTIALLY_STALE) staleCount++
          else if (f.status === CODE_FRESHNESS.INVALID) invalidCount++
        }

        return {
          ok: true,
          status: status?.status || 'unindexed',
          degraded: Boolean(status?.degraded),
          // Omit message entirely when absent: an own key set to `undefined` is
          // not lossless JSON and DSH rejects the raw tool value before render.
          ...(status?.message ? { message: status.message } : {}),
          freshMemories: freshCount,
          staleMemories: staleCount,
          invalidMemories: invalidCount,
        }
      },
      presentCall: (args) => ({ card: 'generic', title: 'Code Status', kind: 'read', rawInput: args.repo || '' }),
    },
    {
      name: 'veyra_change_impact',
      description: 'Analyze the impact of code changes on Veyra engineering memory. Identifies potentially affected knowledge, evaluates freshness, classifies each evaluated record into a trusted-context category (trusted / review_required / stale / contradicted / insufficient_evidence), and generates review candidates without auto-promoting to canonical.',
      parameters: {
        changedFiles: {
          type: 'array',
          items: { type: 'string' },
          description: 'List of changed file paths (relative to repo root). If omitted, evaluates all memories against current repository state.',
        },
        repo: { type: 'string', description: 'Repository root path (defaults to current workspace).' },
        createCandidates: { type: 'boolean', description: 'Whether to create review candidate observations for affected memories (default: false).' },
        query: {
          type: 'string',
          description: 'Optional retrieval query. When changedFiles are given, retrieval-relevant knowledge is added to the trusted-context classification so unaffected fresh knowledge can be reported as trusted alongside change-affected knowledge.',
        },
        renames: {
          type: 'array',
          description: 'Optional Phase 1 explicit rename evidence: unambiguous mappings [{from,to}] (repo-relative). When changedFiles contains a rename target, an original anchored path may match through the mapping. Invalid/conflicting/out-of-repo mappings fail closed; never inferred.',
          items: {
            type: 'object',
            additionalProperties: true, properties: {
              from: { type: 'string', description: 'Original anchored path (repo-relative).' },
              to: { type: 'string', description: 'Changed target path present in changedFiles (repo-relative).' },
            },
            },
        },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: true,
          properties: {
            ok: { type: 'boolean' },
            repo: { type: 'string' },
            changedFiles: { type: 'array', items: { type: 'string' } },
            degraded: { type: 'boolean' },
            degradedReason: { type: 'string' },
            affectedMemories: {
              type: 'array',
              items: {
                type: 'object',
                additionalProperties: true,
                properties: {
                  memoryId: { type: 'string' },
                  title: { type: 'string' },
                  authority: { type: 'string' },
                  validation: { type: 'string' },
                  status: { type: 'string' },
                  freshness: { type: 'string' },
                  affectedAnchors: { type: 'array', items: { type: 'string' } },
                },
              },
            },
            candidatesCreated: { type: 'number' },
            candidateIds: { type: 'array', items: { type: 'string' } },
            context: {
              type: 'array',
              items: {
                type: 'object',
                additionalProperties: true,
                properties: {
                  memoryId: { type: 'string' },
                  title: { type: 'string' },
                  category: {
                    type: 'string',
                    enum: [
                      TRUST_CATEGORIES.TRUSTED,
                      TRUST_CATEGORIES.REVIEW_REQUIRED,
                      TRUST_CATEGORIES.STALE,
                      TRUST_CATEGORIES.CONTRADICTED,
                      TRUST_CATEGORIES.INSUFFICIENT_EVIDENCE,
                    ],
                  },
                  reasons: { type: 'array', items: { type: 'string' } },
                  action: { type: 'string' },
                  authority: { type: 'string' },
                  validation: { type: 'string' },
                  freshness: { type: 'string' },
                  temporal: { type: 'string' },
                  affected: { type: 'boolean' },
                  evidence: { type: 'array', items: { type: 'string' } },
                },
              },
            },
            summary: {
              type: 'object',
              additionalProperties: true,
              properties: {
                trusted: { type: 'number' },
                reviewRequired: { type: 'number' },
                stale: { type: 'number' },
                contradicted: { type: 'number' },
                insufficientEvidence: { type: 'number' },
              },
            },
          },
        },
        render: (_args, value) => {
          if (!value?.ok) return textBlocks(`Change impact analysis failed: ${value?.message || 'unknown error'}`)
          const lines = [
            `Change Impact Analysis for ${value.repo}`,
            `Changed files: ${value.changedFiles.length > 0 ? value.changedFiles.join(', ') : '(all memories evaluated)'}`,
            `Affected memories: ${value.affectedMemories.length}`,
            value.degraded ? `⚠️ Degraded: ${value.degradedReason}` : 'Code intelligence: available',
          ]
          if (value.affectedMemories.length > 0) {
            lines.push('\nAffected Memories:')
            for (const am of value.affectedMemories) {
              lines.push(`  - [${am.memoryId}] ${am.title} (${am.authority}/${am.validation}) [${am.freshness}]`)
              if (am.affectedAnchors.length > 0) {
                lines.push(`    Anchors: ${am.affectedAnchors.join(', ')}`)
              }
            }
          } else {
            lines.push('\nNo memories directly affected by the changed files.')
          }
          if (value.candidatesCreated > 0) {
            lines.push(`\nCreated ${value.candidatesCreated} review candidate(s): ${value.candidateIds.join(', ')}`)
          }
          if (Array.isArray(value.context) && value.context.length > 0) {
            const s = value.summary || {}
            lines.push('\nTrusted-context classification:')
            lines.push(`  trusted: ${s.trusted ?? 0} · review required: ${s.reviewRequired ?? 0} · stale: ${s.stale ?? 0} · contradicted: ${s.contradicted ?? 0} · insufficient evidence: ${s.insufficientEvidence ?? 0}`)
            const notable = value.context.filter((c) => c.category !== TRUST_CATEGORIES.TRUSTED)
            for (const c of notable.slice(0, 30)) {
              lines.push(`  - [${c.memoryId}] ${String(c.category).toUpperCase()}: ${(c.reasons || []).slice(0, 2).join('; ')} (action: ${c.action})`)
            }
            if (notable.length > 30) lines.push(`  ... +${notable.length - 30} more`)
          }
          return textBlocks(lines.join('\n'))
        },
      },
      async execute(args, exec) {
        const cwd = resolveWorkspace(exec?.agent) || runtime.fallbackCwd
        const targetRepo = args.repo || cwd
        const engine = runtime.codeEngine || createDegradedEngine()
        const projectStore = storesForRepository(runtime, targetRepo).projectStore
        const memories = projectStore ? projectStore.list({ limit: 500, includeForgotten: false }) : []

        const changedFiles = args.changedFiles && args.changedFiles.length > 0
          ? args.changedFiles
          : null

        let affectedMemories = []
        let degraded = false
        let degradedReason = null

        if (engine.isDegraded) {
          degraded = true
          degradedReason = 'Code intelligence binary unavailable; running in degraded mode. Only direct file-path matching is available.'
        }

        // If no specific changed files provided, evaluate all memories for freshness
        if (!changedFiles) {
          for (const mem of memories) {
            const f = checkRecordFreshness(mem, targetRepo)
            if (f.status !== CODE_FRESHNESS.FRESH) {
              affectedMemories.push({
                memoryId: mem.id,
                title: mem.title,
                authority: mem.authority,
                validation: mem.validation,
                status: mem.status,
                freshness: f.status,
                affectedAnchors: f.anchors.map((a) => a.anchor?.path || a.reason).filter(Boolean),
              })
            }
          }
        } else {
          // Use existing findAffectedMemories to match changed files against memory anchors.
          // Phase 1 explicit rename evidence is optional and fail-closed; absent => existing behavior.
          const affected = findAffectedMemories(targetRepo, changedFiles, memories, { renames: args.renames })
          for (const item of affected) {
            // item has memoryId, title, authority, validation, status, freshness, affectedAnchors, details
            affectedMemories.push({
              memoryId: item.memoryId,
              title: item.title,
              authority: item.authority,
              validation: item.validation,
              status: item.status,
              freshness: item.freshness,
              affectedAnchors: item.affectedAnchors.map((a) => a.path).filter(Boolean),
            })
          }
        }

        // Optionally create review candidates
        let candidatesCreated = 0
        const candidateIds = []
        if (args.createCandidates && projectStore && affectedMemories.length > 0) {
          // We need to get the full memory records for candidate creation
          for (const am of affectedMemories) {
            if (am.freshness === CODE_FRESHNESS.POTENTIALLY_STALE || am.freshness === CODE_FRESHNESS.INVALID) {
              const memRecord = projectStore.get(am.memoryId)
              if (memRecord) {
                const candidate = buildStaleReviewCandidate(
                  { memoryId: memRecord.id, title: memRecord.title, authority: memRecord.authority },
                  am.affectedAnchors[0] || changedFiles?.[0] || 'modified code',
                  am.freshness,
                )
                const result = projectStore.put(candidate)
                if (result?.record?.id) {
                  candidatesCreated++
                  candidateIds.push(result.record.id)
                }
              }
            }
          }
        }

        // Phase 2 — change-aware trusted-context classification (read-only).
        // Classifies the evaluated records into trusted / review_required /
        // stale / contradicted / insufficient_evidence with reasons. Never
        // writes: no promotion, no rewrite, no merge, no deletion.
        const annotated = annotateContradictions(memories)
        const byId = new Map(annotated.map((r) => [r.id, r]))
        const affectedIds = new Set(affectedMemories.map((a) => a.memoryId))
        const selectedIds = []
        const seenIds = new Set()
        const select = (id) => {
          if (id && !seenIds.has(id)) {
            seenIds.add(id)
            selectedIds.push(id)
          }
        }
        if (changedFiles) {
          for (const id of affectedIds) select(id)
          if (args.query) {
            const recalled = recall({
              projectStore,
              reusableStore: null,
              query: args.query,
              limit: 20,
              includeReusable: false,
            })
            for (const r of recalled) select(r.id)
          }
        } else {
          // Phase 1 semantics: without an explicit change list every memory
          // is evaluated against the current repository state.
          for (const m of memories) select(m.id)
        }

        const context = []
        for (const id of selectedIds) {
          const rec = byId.get(id) || projectStore.get(id)
          if (!rec) continue
          const t = classifyRecordTrust(rec, {
            workspace: targetRepo,
            changedFiles: changedFiles || null,
            degraded,
            renames: args.renames,
          })
          context.push({
            memoryId: rec.id,
            title: rec.title,
            category: t.category,
            reasons: t.reasons,
            action: t.action,
            authority: t.authority ?? '',
            validation: t.validation ?? '',
            freshness: t.freshness || 'unknown',
            temporal: t.temporal,
            affected: affectedIds.has(rec.id),
            evidence: t.evidence,
          })
        }
        const summary = { trusted: 0, reviewRequired: 0, stale: 0, contradicted: 0, insufficientEvidence: 0 }
        for (const c of context) {
          if (c.category === TRUST_CATEGORIES.TRUSTED) summary.trusted++
          else if (c.category === TRUST_CATEGORIES.REVIEW_REQUIRED) summary.reviewRequired++
          else if (c.category === TRUST_CATEGORIES.STALE) summary.stale++
          else if (c.category === TRUST_CATEGORIES.CONTRADICTED) summary.contradicted++
          else summary.insufficientEvidence++
        }

        return {
          ok: true,
          repo: targetRepo,
          changedFiles: changedFiles || [],
          renames: Array.isArray(args.renames) ? args.renames : [],
          degraded,
          degradedReason,
          affectedMemories,
          candidatesCreated,
          candidateIds,
          context,
          summary,
        }
      },
      presentCall: (args) => ({ card: 'generic', title: 'Change Impact', kind: 'read', rawInput: args.changedFiles?.join(', ') || '(full evaluation)' }),
    },
    {
      name: 'veyra_stale_ledger',
      description:
        'Read-only diagnostic: enumerate every memory record with validation=stale from the same project+reusable stores as veyra_health. '
        + 'Supports bounded pagination (offset, limit) and returns complete record fields plus evidence/freshness/path-resolution diagnostics. '
        + 'Never modifies memory, lifecycle, trust, authority, or triggers maintenance.',
      parameters: {
        scope: {
          type: 'string',
          enum: [...VALID_SCOPES],
          description: 'project (default) to use the same stores as veyra_health, or reusable.',
        },
        offset: { type: 'number', description: 'Zero-based offset into the stable stale-record list (default 0).' },
        limit: { type: 'number', description: 'Maximum stale records to return in this page (default 50, max 200).' },
        includeDiagnostics: {
          type: 'boolean',
          description: 'Include evidence anchors and freshness/path-resolution diagnostics when available (default true).',
        },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: true,
          properties: {
            ok: { type: 'boolean' },
            totalStale: { type: 'number' },
            returned: { type: 'number' },
            offset: { type: 'number' },
            limit: { type: 'number' },
            nextOffset: { type: 'number', description: 'Next offset when more records remain; omitted when complete.' },
            complete: { type: 'boolean' },
            scope: { type: 'string' },
            workspace: { type: 'string' },
            items: {
              type: 'array',
              items: {
                type: 'object',
                additionalProperties: true,
                properties: {
                  record: RECORD_SCHEMA,
                  diagnostics: { type: 'object', additionalProperties: true },
                },
              },
            },
          },
        },
        render: (_args, value) => {
          if (!value?.ok) return textBlocks(`Stale ledger failed: ${value?.error || 'unknown'}`)
          const head = `Stale ledger: ${value.totalStale} stale record(s), returned ${value.returned} at offset ${value.offset} (scope=${value.scope}, complete=${value.complete}).`
          if (!value.items?.length) return textBlocks(head)
          const lines = value.items.map((it) => `  ${it.record?.id}  ${it.record?.title || '(untitled)'}  [${it.record?.authority}/${it.record?.validation}]`)
          return textBlocks([head, ...lines].join('\n'))
        },
      },
      execute: async (args = {}, exec) => {
        // Strictly read-only. Uses the same store resolution as veyra_health.
        const { projectStore, reusableStore, cwd } = storesFor(runtime, exec, args.scope || SCOPES.PROJECT, MEMORY_OPERATIONS.HEALTH)
        const all = args.scope === SCOPES.REUSABLE
          ? reusableStore.list({ limit: 1000 })
          : [...projectStore.list({ limit: 1000 }), ...reusableStore.list({ limit: 1000 })]
        const byId = new Map()
        for (const r of all) if (!byId.has(r.id)) byId.set(r.id, r)
        const stale = [...byId.values()].filter((r) => r && r.validation === VALIDATIONS.STALE)

        const rawOffset = Number(args.offset)
        const rawLimit = Number(args.limit)
        const offset = Number.isFinite(rawOffset) ? Math.max(0, Math.floor(rawOffset)) : 0
        const limit = Number.isFinite(rawLimit) ? Math.min(200, Math.max(1, Math.floor(rawLimit))) : 50
        const page = stale.slice(offset, offset + limit)
        const nextOffset = offset + page.length < stale.length ? offset + page.length : null
        const includeDiagnostics = args.includeDiagnostics !== false

        const items = page.map((record) => {
          let diagnostics = null
          if (includeDiagnostics) {
            try {
              const anchors = extractAnchorsFromRecord(record)
              const freshness = checkRecordFreshness(record, cwd)
              const pathResolution = anchors.map((anc) => {
                if (!anc || !anc.path) {
                  return { anchor: anc, resolvedPath: null, status: 'unavailable', reason: 'No file path specified' }
                }
                let safeRel = null
                let resolveError = null
                try { safeRel = resolveRepoPath(cwd, anc.path) } catch (e) { resolveError = e instanceof Error ? e.message : String(e) }
                const base = { anchor: anc, resolvedPath: safeRel }
                if (resolveError) return { ...base, status: 'unresolved', reason: `Path resolution unavailable: ${resolveError}` }
                if (!safeRel) {
                  // A null path means the bridge could not resolve it at all —
                  // 'outside_or_invalid' would claim a repository verdict the
                  // resolution never reached. 'unresolved' already exists here
                  // for exactly this shape, so no new status enters the output.
                  if (!isCodeIntelligenceAvailable()) {
                    return { ...base, status: 'unresolved', reason: 'Code intelligence is unavailable; the anchor path could not be resolved' }
                  }
                  return { ...base, status: 'outside_or_invalid', reason: 'Path outside repository or invalid' }
                }
                try {
                  const af = checkAnchorFreshness(anc, cwd)
                  return { ...base, status: af.status || 'unknown', reason: af.reason || 'unresolved' }
                } catch (e) {
                  return { ...base, status: 'unresolved', reason: `Anchor freshness unavailable: ${e instanceof Error ? e.message : String(e)}` }
                }
              })
              diagnostics = {
                available: true,
                workspace: cwd,
                evidenceAnchors: anchors,
                recordFreshness: freshness,
                pathResolution,
              }
            } catch (e) {
              diagnostics = {
                available: false,
                workspace: cwd,
                error: e instanceof Error ? e.message : String(e),
                note: 'Diagnostics unavailable; record fields are still complete and read-only.',
              }
            }
          }
          return { record: recordView(record), diagnostics }
        })

        return {
          ok: true,
          totalStale: stale.length,
          returned: items.length,
          offset,
          limit,
          ...(nextOffset != null ? { nextOffset } : {}),
          complete: nextOffset == null,
          scope: args.scope || SCOPES.PROJECT,
          workspace: cwd,
          items,
        }
      },
      presentCall: (args) => ({ card: 'generic', title: 'Stale Ledger', kind: 'read', rawInput: args.scope || 'project' }),

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
