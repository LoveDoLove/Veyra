/**
 * Veyra — ambient prompt guidance and per-turn recall context.
 *
 * Two DSH injection points:
 *   - systemPrompt.section  — static rules (memory ≠ truth)
 *   - systemPrompt.context  — dynamic recall snapshot each assemble
 *
 * Recalled items are always framed as non-authoritative experience.
 */

import { DEFAULT_RECALL_LIMIT, RELATIONS, STATUSES } from './types.mjs'
import { extractText, projectIdFor, resolveWorkspace } from './ids.mjs'
import { openProjectStore, openReusableStore } from './store.mjs'
import { recall } from './retrieve.mjs'
import { checkRecordFreshness } from './code/linking.mjs'

/** Evidence items rendered per record before the rest are summarised as a count. */
export const CONTEXT_EVIDENCE_LIMIT = 3

/** Characters kept per rendered evidence field. */
const EVIDENCE_FIELD_CHARS = 120

/** Records scanned when resolving inbound supersession. Bounded, never recursive. */
const INBOUND_SCAN_LIMIT = 200

/**
 * Resolve which recalled records a record RETIRED, and which recalled records
 * retired it.
 *
 * M1 stores `retired --supersedes--> replacement`, so the replacement holds no
 * backward edge. A superseded record is not recall-eligible, which means the
 * only record that knows "this replaced something" can never reach the agent
 * on its own. This resolves that fact by scanning INBOUND edges at composition
 * time.
 *
 * Read-only by construction: it only reads, and it never writes a relation.
 * Adding `replacement --supersedes--> retired` would break the M1 contract
 * ("exactly one supersedes edge per supersede event") and is explicitly not
 * done here.
 */
function resolveSupersession(records, stores) {
  const incoming = new Map(records.map((r) => [r.id, r]))
  // Project isolation: only names reachable from a record already in context,
  // or from a row the same store already exposes. The reusable store is allowed
  // only when the caller asked for it, and a reusable row must not belong to
  // the project being served.
  const projectId = records.find((r) => r.scope !== 'reusable')?.projectId
  const visible = (row) => {
    if (!row) return false
    if (row.projectId === projectId) return true
    return row.scope === 'reusable'
  }
  const lookup = (id) => {
    if (incoming.has(id)) return incoming.get(id)
    // The predecessor is not recall-eligible, so it is not in the recalled set.
    // Read it by id only — never to add it to the context, only to name it.
    for (const store of stores) {
      if (store && store.projectId !== projectId && store.projectId !== 'reusable') continue
      const row = store?.get?.(id)
      if (row && visible(row)) return row
    }
    return null
  }
  // One bounded pass over the candidate pool, indexed by what each record
  // supersedes. No recursion, no per-record scan.
  const supersededBy = new Map() // replacementId -> retiredId
  for (const store of stores) {
    if (!store?.list) continue
    if (store.projectId !== projectId && store.projectId !== 'reusable') continue
    for (const row of store.list({ limit: INBOUND_SCAN_LIMIT })) {
      if (!visible(row)) continue
      for (const rel of row?.relations || []) {
        if (rel?.type !== RELATIONS.SUPERSEDES || !rel.targetId) continue
        if (!supersededBy.has(rel.targetId)) supersededBy.set(rel.targetId, row.id)
      }
    }
  }
  return {
    // For a recalled REPLACEMENT: which retired record it replaced.
    replaces: (record) => {
      const id = supersededBy.get(record.id)
      if (!id) return null
      const prev = lookup(id)
      return { id, title: prev?.title || null, known: Boolean(prev) }
    },
    // For a recalled RETIRED record (it can arrive via expansion): its successor.
    replacedBy: (record) => {
      const rel = (record.relations || []).find((r) => r?.type === RELATIONS.SUPERSEDES)
      if (!rel?.targetId) return null
      const succ = incoming.get(rel.targetId)
      return { id: rel.targetId, title: succ?.title || null, known: incoming.has(rel.targetId) }
    },
  }
}

/**
 * Format one stored evidence item using only fields Veyra already persists:
 * path, uri, anchor, note. Nothing is invented or rewritten.
 */
function renderEvidenceItem(item) {
  if (typeof item === 'string') return item.slice(0, EVIDENCE_FIELD_CHARS)
  if (!item || typeof item !== 'object') return ''
  const parts = []
  if (item.path) parts.push(`path=${item.path}`)
  if (item.uri) parts.push(`uri=${item.uri}`)
  if (item.anchor) parts.push(`anchor=${item.anchor}`)
  if (item.note) parts.push(`note=${item.note}`)
  if (!parts.length) return ''
  return parts.join(' ').slice(0, EVIDENCE_FIELD_CHARS)
}

/**
 * Compose the ephemeral, engineering-aware view of a recall result.
 *
 * Everything here is derived from fields that already exist on the record:
 * lifecycle `status`, the stored `evidence[]`, and the `supersedes` relations
 * of records in the project. Nothing is stored, and no new memory kind,
 * column, or table is introduced. This is a read-time projection, not a
 * subsystem.
 */
export function composeAgentContext(records, { stores = [], workspace = null } = {}) {
  if (!Array.isArray(records) || records.length === 0) return []
  const sup = resolveSupersession(records, stores)
  return records.map((rec) => {
    const evidence = (rec.evidence || [])
      .map(renderEvidenceItem)
      .filter(Boolean)
    const shown = evidence.slice(0, CONTEXT_EVIDENCE_LIMIT)
    const extra = evidence.length - shown.length
    let codeFreshness = null
    if (workspace) {
      try {
        codeFreshness = checkRecordFreshness(rec, workspace)
      } catch {}
    }
    return {
      record: rec,
      status: rec.status,
      isRetired: rec.status === 'superseded',
      replaces: sup.replaces(rec),
      replacedBy: sup.replacedBy(rec),
      evidence: shown,
      evidenceOverflow: extra > 0 ? extra : 0,
      codeFreshness,
    }
  })
}

/**
 * Render the composed context. The record line keeps the existing shape so
 * nothing that already worked regresses; lifecycle, evidence, and supersession
 * are added as bounded extra lines.
 */
export function renderAgentContext(composed, { heading = 'Veyra recalled engineering memory' } = {}) {
  if (!Array.isArray(composed) || composed.length === 0) return ''
  const lines = [
    heading,
    '',
    'These items are remembered engineering experience, not repository truth.',
    'Verify against the current codebase before acting. Similarity is not authority.',
    '',
  ]
  for (const entry of composed) {
    const rec = entry.record
    const statusTag = entry.status && entry.status !== 'current' ? `/${entry.status}` : ''
    const auth = rec.authority === 'canonical' ? 'canonical' : rec.authority
    const contra = rec.contradictions?.length ? `; CONTRADICTS ${rec.contradictions.join(', ')}` : ''
    const scope = rec.scope === 'reusable' ? 'reusable' : 'project'
    for (const banner of rec.contradictionBanners || []) {
      lines.push(`> ⚠️ ${banner}`)
    }
    const kindTag = rec.kind === 'knowledge'
      ? ' [KNOWLEDGE]'
      : rec.kind === 'negative'
        ? ' [NEGATIVE · known failed solution]'
        : rec.kind === 'unresolved'
          ? ' [UNRESOLVED · known open investigation]'
          : ''
    lines.push(`- [${rec.id}] (${scope}/${auth}${statusTag}/${rec.validation}/${rec.confidence}${contra})${kindTag} ${rec.title}`)

    if (entry.codeFreshness?.status === 'potentially_stale') {
      lines.push('  • ⚠️ [CODE EVIDENCE STALE: anchored file was modified]')
    } else if (entry.codeFreshness?.status === 'invalid') {
      lines.push('  • ⚠️ [CODE EVIDENCE INVALID: anchored file missing or symbol unresolvable]')
    }

    if (entry.replaces) {
      const title = entry.replaces.title ? ` — ${entry.replaces.title}` : ''
      lines.push(`  • Replaces superseded memory: [${entry.replaces.id}]${title}`)
    }
    if (entry.replacedBy) {
      const title = entry.replacedBy.title ? ` — ${entry.replacedBy.title}` : ''
      lines.push(`  • Replaced by current memory: [${entry.replacedBy.id}]${title}`)
    }
    if (rec.via?.type && rec.via.fromId) {
      lines.push(`  • via ${rec.via.type} ← [${rec.via.fromId}]`)
    }
    for (const ev of entry.evidence) {
      lines.push(`  • evidence: ${ev}`)
    }
    if (entry.evidenceOverflow > 0) {
      lines.push(`  • evidence: +${entry.evidenceOverflow} more`)
    }

    const causal = rec.source?.causal
    if (causal && (causal.symptom || causal.rootCause || causal.remedy || causal.verifiedOutcome)) {
      if (causal.symptom) lines.push(`  • Symptom: ${causal.symptom}`)
      if (causal.rootCause) lines.push(`  • Root cause: ${causal.rootCause}`)
      if (causal.remedy) lines.push(`  • Remedy: ${causal.remedy}`)
      if (causal.verifiedOutcome) lines.push(`  • Outcome: ${causal.verifiedOutcome}`)
    } else {
      const docPath = rec.source?.docPath || rec.source?.uri || rec.evidence?.[0]?.path
      if (rec.kind === 'knowledge' && docPath) {
        lines.push(`  • Source: ${docPath}`)
      }
      const body = String(rec.body || '').replace(/\s+/g, ' ').trim()
      if (body) lines.push(`  ${body.slice(0, 360)}`)
    }
  }
  return lines.join('\n')
}

export const GUIDANCE_TEXT = [
  'Veyra Agent Policy — Veyra engineering intelligence is available in this session.',
  'A recall snapshot may already be injected. Tools: veyra_remember, veyra_recall,',
  'veyra_inspect, veyra_forget, veyra_promote. Use Veyra as an assistant, not as truth.',
  '',
  'Consider retrieval (veyra_recall / veyra_inspect) only when the task benefits:',
  '- prior project or architecture decisions, including why an existing design exists',
  '- project constraints and durable implementation conventions',
  '- previous engineering solutions and troubleshooting outcomes',
  '- historical implementation knowledge this turn does not already have',
  '- potentially conflicting historical knowledge worth checking first',
  'Do not call Veyra for tasks that do not benefit (typos, formatting-only edits,',
  'boilerplate), and never call it every turn by default: if the injected recall',
  'snapshot already answers, use it and skip the tool call.',
  '',
  'Consider recording (veyra_remember) only when something is durable and evidenced:',
  '- durable architecture decisions and important project constraints',
  '- verified troubleshooting results and durable implementation conventions',
  '- important engineering discoveries with repository evidence',
  'Transient conversation noise must never become memory.',
  '',
  'Consider validation when repository evidence conflicts with recalled knowledge,',
  'remembered knowledge looks obsolete, or contradictions surface: verify against the',
  'repository, show both sides, and let the repository win.',
  '',
  'Rules you must keep:',
  '- Observe ≠ Store. Not every event is worth remembering.',
  '- Candidate ≠ Truth. Automatic captures are unverified candidates.',
  '- Similarity ≠ Authority. A recalled match is not proof; never raise a record\'s',
  '  standing because a search or similarity hit returned it.',
  '- Memory ≠ Knowledge. Remembered experience is not the repository.',
  '- Knowledge without evidence is not authoritative.',
  '- Veyra results are evidence and context, not repository truth. Verify important',
  '  conclusions against current code, tests, and git history.',
  '- Do not silently merge, overwrite, or retire memory. Contradictions stay visible;',
  '  if two recalled items disagree, show both and believe the repository.',
  '- Automatic behavior never creates canonical truth. Only an explicit',
  '  veyra_promote (canonical) call, triggered by the user, can do that.',
  '- Project isolation is preserved. Do not treat reusable experience as',
  '  this project\'s architecture.',
  '- Memory assists engineering; it does not replace verification.',
  '',
  'Recall markers (GOAL.md Phase 2):',
  '- [NEGATIVE · known failed solution] marks a falsified approach. Do not retry it',
  '  without new evidence; it is historical evidence, not an authoritative ban.',
  '- [UNRESOLVED · known open investigation] marks a known unknown. Do not treat',
  '  repeated retrieval as resolution; it never becomes canonical by being recalled.',
  '- "No known engineering history" means nothing is remembered for this query —',
  '  absence of memory, not evidence that no history exists.',
  '',
  'Codebase Memory Policy — Structural Code Intelligence is available in this session.',
  'Tools: cbm_projects, cbm_search, cbm_snippet, cbm_trace, cbm_arch, cbm_search_code, veyra_code_status.',
  '- Repository code is authoritative truth. Codebase Memory reflects this truth.',
  '- Prefer cbm_trace for caller/callee relationships, hierarchies, and blast-radius analysis.',
  '- Prefer cbm_search for AST symbol discovery (functions, classes, interfaces).',
  '- Prefer cbm_snippet to retrieve exact symbol definitions without whole-file overhead.',
  '- Prefer cbm_arch for directory component dependencies and architecture overview.',
  '- Veyra memory provides historical context; if memory contradicts code, code wins.',
].join('\n')

// Claimed inbox text is gone from inbox and not yet on deriveMessages()
// when systemPrompt.assemble runs (preStep claims, then assembles).
const claimedByAgent = new WeakMap()

const SKIP_QUERY_PREFIXES = [
  'veyra recalled',
  'these items are remembered',
]

export function isHumanUserMessage(message) {
  if (!message || typeof message !== 'object') return false
  if (message.role && message.role !== 'user') return false
  const kind = message.source?.kind
  return !kind || kind === 'user'
}

export function queryTextFromMessage(message) {
  const text = extractText(message?.content ?? message).trim()
  if (!text) return ''
  const lower = text.toLowerCase()
  if (SKIP_QUERY_PREFIXES.some((p) => lower.startsWith(p))) return ''
  return text.slice(0, 800)
}

export function rememberClaimedPrompt(agent, message) {
  if (!agent || !isHumanUserMessage(message)) return
  const text = queryTextFromMessage(message)
  if (text) claimedByAgent.set(agent, text)
}

function latestHumanQuery(messages) {
  if (!Array.isArray(messages)) return ''
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i]
    if (!isHumanUserMessage(msg)) continue
    const text = queryTextFromMessage(msg)
    if (text) return text
  }
  return ''
}

export function queryFromAssemble(assembleContext) {
  const agent = assembleContext?.agent
  if (!agent) return ''
  const claimed = claimedByAgent.get(agent)
  if (claimed) return claimed

  const session = agent.session
  try {
    if (typeof session?.deriveMessages === 'function') {
      const fromHistory = latestHumanQuery(session.deriveMessages())
      if (fromHistory) return fromHistory
    }
  } catch {
    // deriveMessages is host-defined; fall through
  }

  // Rare: assemble without a prior claim still seeing queued human text.
  const fromInbox = latestHumanQuery(agent.inbox?.nextStep) || latestHumanQuery(agent.inbox?.nextTurn)
  if (fromInbox) return fromInbox
  return ''
}

export function buildRecallContext({ veyraHome, cwd, query = '', limit = DEFAULT_RECALL_LIMIT, includeReusable = true }) {
  if (limit === 0) return ''
  const workspace = cwd || process.cwd()
  const projectId = projectIdFor(workspace)
  const projectStore = openProjectStore(veyraHome, projectId)
  const reusableStore = includeReusable ? openReusableStore(veyraHome) : null
  const records = recall({
    projectStore,
    reusableStore,
    query,
    limit,
    includeReusable,
  })
  if (records.length === 0) {
    // GOAL.md Phase 2 — "no known history" must be a distinguishable state,
    // not silence: an agent has to be able to tell apart "known solution /
    // known failed solution / known unresolved / nothing remembered here".
    // `limit: 0` above stays silent — recall is disabled there.
    return [
      'Veyra recalled engineering memory',
      '',
      'No known engineering history: Veyra has no eligible recall for this query.',
      'Absence of memory is not evidence. Verify against the repository.',
      '',
    ].join('\n')
  }
  projectStore.touch(records.filter((r) => r.scope !== 'reusable').map((r) => r.id))
  if (reusableStore) reusableStore.touch(records.filter((r) => r.scope === 'reusable').map((r) => r.id))
  // M6 Phase-1: compose the engineering-aware view (lifecycle, evidence,
  // inbound supersession) before rendering. Read-time projection only.
  return renderAgentContext(composeAgentContext(records, { stores: [projectStore, reusableStore], workspace }))
}

export function createContextProvider(runtime) {
  return (assembleContext) => {
    try {
      const agent = assembleContext?.agent
      const cwd = resolveWorkspace(agent) || runtime.fallbackCwd
      runtime.ensureWatcher?.(cwd)
      const query = queryFromAssemble(assembleContext)
      return buildRecallContext({
        veyraHome: runtime.veyraHome,
        cwd,
        query,
        limit: runtime.recallLimit,
        includeReusable: runtime.includeReusable,
      })
    } catch (err) {
      runtime.log?.warn?.(`[veyra] recall context failed: ${err instanceof Error ? err.message : String(err)}`)
      return ''
    }
  }
}

// ── §16 memory provenance chain ──────────────────────────────────────────────

/**
 * §16 — read-only lifecycle chain over facts a record already persists, in
 * GOAL.md §16 order:
 *
 *   Observation → Evidence → Candidate → Validation → Promotion →
 *   Retrieval → Application → Verification → Update/Supersession
 *
 * Answers, per record: where did this memory come from, why was it trusted,
 * and what happened when it was used. It never invents telemetry — stages
 * Veyra does not persist say so honestly (`not-tracked` / `not-yet`), and a
 * legacy record says `unknown`. Provenance ≠ authority: the chain reports
 * states, it never grants them (a rich chain leaves authority/validation
 * exactly where the gates put them).
 */
export function provenanceChain(record) {
  const rec = record && typeof record === 'object' ? record : {}
  const src = rec.source && typeof rec.source === 'object' ? rec.source : {}
  const prov = src.provenance && typeof src.provenance === 'object' ? src.provenance : null
  const origins = Array.isArray(prov?.origins) && prov.origins.length ? prov.origins : null
  const agent = prov?.agent && (prov.agent.provider || prov.agent.model)
    ? `${prov.agent.provider || '?'}/${prov.agent.model || '?'}`
    : null
  const session = src.sessionId ? `${src.sessionId}${src.turn != null ? ` turn ${src.turn}` : ''}` : null
  const where = prov?.workspace || null
  const relations = Array.isArray(rec.relations) ? rec.relations : []
  const evidence = Array.isArray(rec.evidence) ? rec.evidence : []
  const rows = []

  // 1 — Observation: when, where, and by-what it was captured.
  const obsBits = [
    session && `session ${session}`,
    origins && `origins [${origins.join(', ')}]`,
    where && `workspace ${where}`,
    agent && `agent ${agent}`,
  ].filter(Boolean)
  rows.push(obsBits.length
    ? { stage: 'Observation', state: 'recorded', at: rec.createdAt || null, detail: obsBits.join(' · ') }
    : { stage: 'Observation', state: 'unknown', at: rec.createdAt || null, detail: 'legacy record — capture context not recorded' })

  // 2 — Evidence: anchors attached at capture or review.
  rows.push(evidence.length
    ? { stage: 'Evidence', state: 'recorded', at: null, detail: `${evidence.length} anchor(s): ${evidence.map((e) => e?.path || e?.note || 'note').join(', ')}` }
    : { stage: 'Evidence', state: 'none', at: null, detail: 'no evidence anchors' })

  // 3 — Candidate: how it entered the store (Observe ≠ Store — automatic
  // capture and deliberate writes are both acts of entering the store).
  rows.push({
    stage: 'Candidate',
    state: 'recorded',
    at: rec.createdAt || null,
    detail: src.tool ? `deliberate write via ${src.tool}` : src.automatic ? 'distilled from a turn (write gate)' : 'entered the store',
  })

  // 4 — Validation: candidate → review ladder.
  const validation = rec.validation || 'candidate'
  rows.push(validation === 'candidate'
    ? { stage: 'Validation', state: 'pending', at: rec.updatedAt || null, detail: 'still a candidate — not yet validated' }
    : { stage: 'Validation', state: 'recorded', at: rec.updatedAt || null, detail: `validation ${validation}` })

  // 5 — Promotion: authority level actually granted (never inferred).
  const authority = rec.authority || 'candidate'
  rows.push(authority === 'canonical'
    ? { stage: 'Promotion', state: 'recorded', at: rec.updatedAt || null, detail: 'explicitly promoted to canonical' }
    : authority === 'derived'
      ? { stage: 'Promotion', state: 'recorded', at: rec.updatedAt || null, detail: 'admitted as derived by the write gate — useful, not truth' }
      : { stage: 'Promotion', state: 'pending', at: null, detail: 'no promotion yet' })

  // 6 — Retrieval: last time recall surfaced it (telemetry, may be absent).
  rows.push(rec.lastRecalledAt
    ? { stage: 'Retrieval', state: 'recorded', at: rec.lastRecalledAt, detail: 'last surfaced by recall' }
    : { stage: 'Retrieval', state: 'not-yet', at: null, detail: 'never recalled yet' })

  // 7 — Application: deliberately NOT tracked — memory is evidence, not
  // instructions; what an agent did with a recollection is outside Veyra.
  rows.push({ stage: 'Application', state: 'not-tracked', at: null, detail: 'application happens in the agent — Veyra stores evidence, not instructions' })

  // 8 — Verification: validated or evidenced as verified.
  const verifiedNote = evidence.find((e) => /test-passed|verified|reproduc/i.test(String(e?.note || '')))
  rows.push(validation === 'verified' || verifiedNote
    ? { stage: 'Verification', state: 'recorded', at: null, detail: validation === 'verified' ? 'marked verified' : `evidence note: ${verifiedNote.note}` }
    : { stage: 'Verification', state: 'pending', at: null, detail: 'no verified outcome yet' })

  // 9 — Update / Supersession. `supersedes` is directed retired →
  // replacement (M1 contract), so an edge here means THIS record was
  // retired in favour of its target.
  const retired = relations.filter((r) => r?.type === RELATIONS.SUPERSEDES)
  const status = rec.status || STATUSES.CURRENT
  if (retired.length) {
    rows.push({ stage: 'Update/Supersession', state: 'recorded', at: rec.updatedAt || null, detail: `retired — replaced by ${retired.map((r) => r.targetId).join(', ')}` })
  } else if (rec.forgotten) {
    rows.push({ stage: 'Update/Supersession', state: 'recorded', at: rec.updatedAt || null, detail: 'forgotten (soft-deleted, off recall)' })
  } else if (status !== STATUSES.CURRENT) {
    rows.push({ stage: 'Update/Supersession', state: 'recorded', at: rec.updatedAt || null, detail: `status ${status}` })
  } else if (validation === 'stale' || validation === 'invalid') {
    // evolve demotes the review ladder too — a demotion is an update.
    rows.push({ stage: 'Update/Supersession', state: 'recorded', at: rec.updatedAt || null, detail: `validation demoted to ${validation}` })
  } else {
    rows.push({ stage: 'Update/Supersession', state: 'none', at: rec.updatedAt || null, detail: 'no update, retirement, or invalidation yet' })
  }
  // §22 — surface the preserved lifecycle reasoning (what happened, when,
  // why, what contradicted it, what replaced it). Gated on presence: records
  // without `source.lifecycle` render byte-identically to before.
  const lifecycle = Array.isArray(rec.source?.lifecycle) ? rec.source.lifecycle : null
  if (lifecycle?.length) {
    const last = lifecycle[lifecycle.length - 1]
    const row = rows[rows.length - 1]
    const parts = [`${last.action} @ ${last.at}`]
    if (last.why) parts.push(last.why)
    if (last.contradictedBy && !row.detail.includes(last.contradictedBy)) parts.push(`contradicted by ${last.contradictedBy}`)
    if (last.replacedBy && !row.detail.includes(last.replacedBy)) parts.push(`replaced by ${last.replacedBy}`)
    row.detail += ` · ${parts.join(' · ')}`
  }
  return rows
}
