/**
 * Veyra — DSH tools.
 *
 * Eight model-facing tools:
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
import { projectIdFor, provenanceDimensions, resolveWorkspace } from './ids.mjs'
import { openProjectStore, openReusableStore } from './store.mjs'
import { inspect, recall, summarizeForPrompt, temporalState } from './retrieve.mjs'
import { provenanceChain } from './context.mjs'
import { promote, remember } from './learn.mjs'
import { forget as lifecycleForget } from './lifecycle.mjs'
import { detectRecurrence, eligibleForCandidate, recordFeedback, recurrenceCandidate } from './feedback.mjs'
import { memoryHealth, renderHealth } from './health.mjs'
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
    // Phase 4 §11/§13 — "still valid?" and "applicable here?" answered
    // straight from the view: validity state on the temporal axis plus
    // the context captured when the memory was written.
    temporal: temporalState(record),
    context: record.source?.context ?? null,
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
        'Store durable engineering knowledge in Veyra. Use for decisions, root causes, constraints, '
        + 'fix patterns, RAG documentation (kind: \'knowledge\'), and reusable lessons. Stored items become '
        + 'derived memory (never canonical). Secrets are redacted. Project scope is the default; use '
        + 'reusable only for experience that is truly project-agnostic.',
      parameters: {
        title: { type: 'string', required: true, description: 'Short title for the memory.' },
        body: { type: 'string', required: true, description: 'The knowledge itself, with enough context to reuse later.' },
        kind: { type: 'string', enum: [...VALID_KINDS], description: 'observation | memory | knowledge | evidence | negative (known failed approach) | unresolved (known open investigation). Default memory (or knowledge for RAG). negative: title = hypothesis, body = rejection reason. unresolved: title = question, body = known clues.' },
        scope: { type: 'string', enum: [...VALID_SCOPES], description: 'project (default) or reusable.' },
        tags: { type: 'array', items: { type: 'string' }, description: 'Optional short tags.' },
        evidence: {
          type: 'array',
          items: { type: 'object', additionalProperties: true },
          description: 'Optional evidence anchors (path, note, uri).',
        },
        confidence: { type: 'string', enum: [...VALID_CONFIDENCES], description: 'low | medium | high. Default medium.' },
        validFrom: { type: 'string', description: 'Optional §13 ISO date: when this knowledge takes effect (before that it reads as not_yet_effective, never hidden).' },
        validUntil: { type: 'string', description: 'Optional §13 ISO date: when this knowledge expires (after that it reads as expired — demoted, never deleted).' },
        context: { type: 'object', additionalProperties: true, description: 'Optional §12 applicability context (toolchain, version, taskType, …). os/runtime are auto-captured; supplied keys win.' },
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
        'Unified Hybrid Search across Veyra memory and RAG knowledge. Combines lexical, semantic, '
        + 'intent, and relationship signals with transparent ranking. Automatic recall already runs '
        + 'each turn; use this for targeted queries beyond automatic context.',
      parameters: {
        query: { type: 'string', required: true, description: 'What to look for.' },
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
        const { projectStore, reusableStore } = storesFor(runtime, exec, SCOPES.PROJECT)
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
      name: 'veyra_feedback',
      description:
        'Report the real-world outcome of APPLYING a Veyra memory (§19 feedback loop). '
        + 'success = the memory\'s guidance was applied and verified working → the record strengthens '
        + '(observation ladder, validation/confidence progression). failure = it was applied and did '
        + 'not work → failure history is recorded and reliability decreases (validation and confidence '
        + 'demote one step; canonical records keep their validation — only history is recorded). '
        + 'Memory stays evidence, never instructions; feedback never changes authority.',
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
          },
        },
        render: (_args, value) => textBlocks(renderHealth(value)),
      },
      execute(args, exec) {
        const { cwd, projectStore, reusableStore } = storesFor(runtime, exec, SCOPES.PROJECT)
        const failureThreshold = Math.max(2, Math.min(50, Number(args.failureThreshold) || 2))
        const byId = new Map()
        for (const r of [...projectStore.list({ limit: 200 }), ...reusableStore.list({ limit: 200 })]) {
          if (r?.id && !byId.has(r.id)) byId.set(r.id, r)
        }
        const report = memoryHealth([...byId.values()], { workspace: cwd, failureThreshold })
        return { ok: true, ...report }
      },
      presentCall: (args) => ({ card: 'generic', title: 'Memory health', kind: 'other', rawInput: `failure threshold ${args.failureThreshold ?? 2}` }),
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
          const text = value?.raw?.trim()
          if (!text || text === 'No projects indexed.') return textBlocks('No projects indexed.')
          return textBlocks(text)
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
          return textBlocks(value?.overview || value?.raw || (value?.ok ? 'No architectural summary available.' : value?.message || 'Arch query failed.'))
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
