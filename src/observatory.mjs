/**
 * Veyra — Knowledge Observatory.
 *
 * Read-only human-facing projection of Veyra's engineering intelligence.
 * The Observatory is NOT a second source of truth; it projects existing
 * SQLite/store state with deep explanatory context, provenance, causal
 * understanding, and relationship graphs.
 *
 * Invariants (GOAL.md):
 *   - Human surface is explanatory, deep, and provenance-focused.
 *   - Agent surface remains compact, actionable, and token-efficient.
 *   - Contradictions are surfaced, never silently merged or resolved.
 *   - Memory is not truth; similarity is not authority.
 */

import { AUTHORITIES, KINDS, RELATIONS, SCOPES, STATUSES, VALIDATIONS } from './types.mjs'
import { hybridRetrieve } from './retrieve.mjs'

/**
 * High-level knowledge overview projection.
 */
export function observatoryOverview({ projectStore, reusableStore = null, cwd = '', projectId = '', veyraHome = '' } = {}) {
  const projectRecords = projectStore ? projectStore.list({ limit: 200, includeForgotten: true }) : []
  const reusableRecords = reusableStore ? reusableStore.list({ limit: 200, includeForgotten: true }) : []
  const allRecords = [...projectRecords, ...reusableRecords]

  const countBy = (records, field, val) => records.filter((r) => r[field] === val && !r.forgotten).length

  const kindCounts = {
    memory: countBy(allRecords, 'kind', KINDS.MEMORY),
    knowledge: countBy(allRecords, 'kind', KINDS.KNOWLEDGE),
    evidence: countBy(allRecords, 'kind', KINDS.EVIDENCE),
    observation: countBy(allRecords, 'kind', KINDS.OBSERVATION),
  }

  const authorityCounts = {
    canonical: countBy(allRecords, 'authority', AUTHORITIES.CANONICAL),
    derived: countBy(allRecords, 'authority', AUTHORITIES.DERIVED),
    candidate: countBy(allRecords, 'authority', AUTHORITIES.CANDIDATE),
  }

  const validationCounts = {
    verified: countBy(allRecords, 'validation', VALIDATIONS.VERIFIED),
    reviewed: countBy(allRecords, 'validation', VALIDATIONS.REVIEWED),
    unverified: countBy(allRecords, 'validation', VALIDATIONS.UNVERIFIED),
    stale: countBy(allRecords, 'validation', VALIDATIONS.STALE),
    invalid: countBy(allRecords, 'validation', VALIDATIONS.INVALID),
  }

  const forgottenCount = allRecords.filter((r) => r.forgotten).length
  const causalRecords = allRecords.filter((r) => r.source?.causal && (
    r.source.causal.symptom || r.source.causal.rootCause || r.source.causal.remedy || r.source.causal.verifiedOutcome
  ))

  const relationsCount = allRecords.reduce((acc, r) => acc + (r.relations?.length || 0), 0)
  const contradictionCount = allRecords.filter((r) => (r.relations || []).some((rel) => rel.type === RELATIONS.CONTRADICTS)).length

  const data = {
    projectId,
    workspace: cwd,
    veyraHome,
    totalRecords: allRecords.length,
    activeRecords: allRecords.length - forgottenCount,
    forgottenCount,
    kindCounts,
    authorityCounts,
    validationCounts,
    causalRecordsCount: causalRecords.length,
    relationsCount,
    contradictionCount,
  }

  const formatted = [
    '════════════════════════════════════════════════════════════════════════',
    ` VEYRA KNOWLEDGE OBSERVATORY — OVERVIEW`,
    '════════════════════════════════════════════════════════════════════════',
    ` Project ID   : ${projectId || '(none)'}`,
    ` Workspace    : ${cwd || '(none)'}`,
    ` Veyra Home   : ${veyraHome || '(none)'}`,
    ` Total Memory : ${data.activeRecords} active (${data.totalRecords} total, ${forgottenCount} forgotten)`,
    '',
    '── Knowledge Kinds (Unified RAG + Memory) ──────────────────────────────',
    `  • Engineering Memory : ${kindCounts.memory}`,
    `  • Knowledge / RAG    : ${kindCounts.knowledge}`,
    `  • Evidence Anchors   : ${kindCounts.evidence}`,
    `  • Observations       : ${kindCounts.observation}`,
    '',
    '── Authority Standing ──────────────────────────────────────────────────',
    `  • Canonical (User-promoted Truth) : ${authorityCounts.canonical}`,
    `  • Derived   (Learned / Remembered): ${authorityCounts.derived}`,
    `  • Candidate (Automatic / Raw)     : ${authorityCounts.candidate}`,
    '',
    '── Validation & Health ─────────────────────────────────────────────────',
    `  • Verified   (Tests confirmed)    : ${validationCounts.verified}`,
    `  • Reviewed   (Inspected)          : ${validationCounts.reviewed}`,
    `  • Unverified (Awaiting proof)     : ${validationCounts.unverified}`,
    `  • Stale / Invalid                 : ${validationCounts.stale} stale, ${validationCounts.invalid} invalid`,
    '',
    '── Structure & Intelligence ────────────────────────────────────────────',
    `  • Causal Knowledge Records        : ${causalRecords.length}`,
    `  • Relationship Edges              : ${relationsCount}`,
    `  • Active Contradictions           : ${contradictionCount}`,
    '════════════════════════════════════════════════════════════════════════',
  ].join('\n')

  return { ok: true, data, formatted }
}

/**
 * Deep explanatory projection of a single knowledge record answering the 6 questions.
 */
export function observatoryRecord({ projectStore, reusableStore = null, id } = {}) {
  if (!id) return { ok: false, error: 'Record id required', formatted: 'Error: record id required' }
  const record = projectStore?.get(id) || reusableStore?.get(id) || null
  if (!record) {
    return { ok: false, error: 'Record not found', formatted: `Record ${id} not found.` }
  }

  const causal = record.source?.causal
  const hasCausal = causal && (causal.symptom || causal.rootCause || causal.remedy || causal.verifiedOutcome)

  // Find incoming relations from peers in both stores
  const incomingRelations = []
  const checkPool = [
    ...(projectStore ? projectStore.list({ limit: 100 }) : []),
    ...(reusableStore ? reusableStore.list({ limit: 50 }) : []),
  ]
  for (const peer of checkPool) {
    if (!peer || peer.id === record.id) continue
    for (const rel of peer.relations || []) {
      if (rel.targetId === record.id) {
        incomingRelations.push({ fromId: peer.id, type: rel.type, title: peer.title })
      }
    }
  }

  const lines = [
    '════════════════════════════════════════════════════════════════════════',
    ` VEYRA OBSERVATORY — RECORD DETAIL: [${record.id}]`,
    '════════════════════════════════════════════════════════════════════════',
    '',
    '1. WHAT DOES VEYRA KNOW?',
    `   Title       : ${record.title}`,
    `   Kind        : ${record.kind.toUpperCase()} (${record.kind === KINDS.KNOWLEDGE ? 'RAG / Documented Knowledge' : 'Engineering Memory'})`,
    `   Authority   : ${record.authority.toUpperCase()} (${record.authority === AUTHORITIES.CANONICAL ? 'User-explicit Truth' : 'Derived Memory'})`,
    `   Validation  : ${record.validation.toUpperCase()}`,
    `   Confidence  : ${record.confidence.toUpperCase()}`,
    `   Scope       : ${record.scope} (Project: ${record.projectId})`,
    `   Status      : ${record.status}${record.forgotten ? ' [FORGOTTEN]' : ''}`,
    `   Tags        : ${(record.tags || []).join(', ') || '(none)'}`,
    '',
    '   Content:',
    ...record.body.split('\n').map((l) => `     ${l}`),
    '',
    '2. WHY DOES VEYRA KNOW IT?',
    `   Origin Reason : ${record.source?.tool ? `Explicit tool invocation (${record.source.tool})` : 'Turn observation / distillation'}`,
    `   Observations  : ${record.source?.observations || 1} observation(s) accumulated`,
    `   Durable Signal: ${record.source?.signal || (record.tags?.includes('causal') ? 'causal-pattern' : 'engineering-lesson')}`,
    '',
    '3. WHERE DID IT COME FROM? (PROVENANCE)',
    `   Session ID    : ${record.source?.sessionId || '(unknown)'}`,
    `   Tool / Action : ${record.source?.tool || 'session-distiller'}`,
    `   Doc / URI Path: ${record.source?.docPath || record.source?.uri || '(not specified)'}`,
    `   Workspace     : ${record.projectId || 'local'}`,
    '',
    '4. WHEN WAS IT OBSERVED?',
    `   Created At    : ${record.createdAt}`,
    `   Updated At    : ${record.updatedAt}`,
    `   Last Recalled : ${record.lastRecalledAt || '(never recalled yet)'}`,
    '',
    '5. WHAT EVIDENCE SUPPORTS IT?',
  ]

  if (!record.evidence?.length) {
    lines.push('   (No explicit evidence anchors attached)')
  } else {
    for (const [idx, ev] of record.evidence.entries()) {
      if (typeof ev === 'string') {
        lines.push(`   [${idx + 1}] ${ev}`)
      } else {
        const details = []
        if (ev.path) details.push(`path: ${ev.path}`)
        if (ev.note) details.push(`note: ${ev.note}`)
        if (ev.uri) details.push(`uri: ${ev.uri}`)
        lines.push(`   [${idx + 1}] ${details.join(' | ') || JSON.stringify(ev)}`)
      }
    }
  }

  lines.push('')
  lines.push('6. WHAT VALIDATION OCCURRED?')
  lines.push(`   Validation Tier : ${record.validation}`)
  lines.push(`   Confidence Tier : ${record.confidence}`)
  if (record.validation === VALIDATIONS.VERIFIED) {
    lines.push('   Verification    : Verified by deterministic outcome (passing test / verified execution)')
  } else if (record.validation === VALIDATIONS.REVIEWED) {
    lines.push('   Verification    : Reviewed by engineer or explicit user promotion')
  } else {
    lines.push('   Verification    : Unverified candidate/memory; repository code remains authoritative')
  }

  if (hasCausal) {
    lines.push('')
    lines.push('── Causal Facets (Four-Facet Lifecycle) ────────────────────────')
    lines.push(`  Symptom          : ${causal.symptom || '(none)'}`)
    lines.push(`    ↓ Root Cause   : ${causal.rootCause || '(none)'}`)
    lines.push(`    ↓ Remedy       : ${causal.remedy || '(none)'}`)
    lines.push(`    ↓ Outcome      : ${causal.verifiedOutcome || '(unverified)'}`)
  }

  if ((record.relations || []).length || incomingRelations.length) {
    lines.push('')
    lines.push('── Knowledge Relationships ──────────────────────────────────────')
    for (const rel of record.relations || []) {
      lines.push(`  → ${rel.type.toUpperCase()} [${rel.targetId}]`)
    }
    for (const inc of incomingRelations) {
      lines.push(`  ← [${inc.fromId}] (${inc.title}) connects with ${inc.type.toUpperCase()}`)
    }
  }

  const contradictions = (record.relations || []).filter((r) => r.type === RELATIONS.CONTRADICTS)
  if (contradictions.length) {
    lines.push('')
    lines.push('── ⚠️ Contradiction Alert ───────────────────────────────────────')
    for (const c of contradictions) {
      const opposing = projectStore?.get(c.targetId) || reusableStore?.get(c.targetId)
      lines.push(`  • Contradicts: [${c.targetId}] ${opposing ? opposing.title : '(opposing record)'}`)
      if (opposing) {
        lines.push(`    Opposing body: ${opposing.body.slice(0, 160)}...`)
      }
    }
    lines.push('  Rule: Both sides remain visible. Believe repository truth.')
  }

  lines.push('════════════════════════════════════════════════════════════════════════')

  return {
    ok: true,
    data: {
      record,
      causal: hasCausal ? causal : null,
      incomingRelations,
      contradictions: contradictions.map((c) => c.targetId),
    },
    formatted: lines.join('\n'),
  }
}

/**
 * Hybrid Search inspection with transparent score breakdown and retrieval sources.
 */
export function observatorySearch({
  projectStore,
  reusableStore = null,
  query = '',
  limit = 8,
  includeReusable = true,
  kind = null,
} = {}) {
  const hits = hybridRetrieve({
    projectStore,
    reusableStore,
    query,
    limit,
    includeReusable,
    kind,
  })

  const lines = [
    '════════════════════════════════════════════════════════════════════════',
    ` VEYRA OBSERVATORY — HYBRID SEARCH INSPECTION`,
    ` Query : "${query}"`,
    ` Found : ${hits.length} match(es)`,
    '════════════════════════════════════════════════════════════════════════',
  ]

  if (hits.length === 0) {
    lines.push(' No matching knowledge found in project or reusable stores.')
  } else {
    for (const [idx, r] of hits.entries()) {
      const sc = r.scores || {}
      lines.push('')
      lines.push(`[#${idx + 1}] [${r.id}] ${r.title}`)
      lines.push(`    Kind       : ${r.kind.toUpperCase()} | Authority: ${r.authority} | Validation: ${r.validation} | Scope: ${r.scope}`)
      lines.push(`    Composite  : ${sc.composite?.toFixed(4) || 'N/A'}`)
      lines.push(`    Signals    : Lexical=${sc.lexical ?? sc.relevance} | Semantic=${sc.semantic} | Evidence=${sc.evidence_strength} | Validation=${sc.validation_tier} | Proximity=${sc.scope_proximity} | Freshness=${sc.freshness_tier} | IntentAffinity=+${sc.intent_affinity} | Relationship=${sc.relationship}`)
      if (r.source?.causal) {
        const c = r.source.causal
        if (c.rootCause) lines.push(`    Root Cause : ${c.rootCause}`)
        if (c.remedy) lines.push(`    Remedy     : ${c.remedy}`)
        if (c.verifiedOutcome) lines.push(`    Outcome    : ${c.verifiedOutcome}`)
      }
      if (r.contradictions?.length) {
        lines.push(`    ⚠️ Contradicts: ${r.contradictions.join(', ')}`)
      }
    }
  }

  lines.push('')
  lines.push(' Invariant: Search scores reflect contextual relevance, not authority.')
  lines.push('════════════════════════════════════════════════════════════════════════')

  return { ok: true, hits, formatted: lines.join('\n') }
}

/**
 * Causal Knowledge map inspection.
 */
export function observatoryCausality({ projectStore, reusableStore = null, limit = 25 } = {}) {
  const allRecords = [
    ...(projectStore ? projectStore.list({ limit: 100 }) : []),
    ...(reusableStore ? reusableStore.list({ limit: 50 }) : []),
  ]

  const causalRecords = allRecords.filter((r) => {
    const c = r.source?.causal
    return c && (c.symptom || c.rootCause || c.remedy || c.verifiedOutcome)
  }).slice(0, Math.max(1, limit))

  const lines = [
    '════════════════════════════════════════════════════════════════════════',
    ` VEYRA OBSERVATORY — CAUSAL KNOWLEDGE MAP (${causalRecords.length} records)`,
    '════════════════════════════════════════════════════════════════════════',
  ]

  if (causalRecords.length === 0) {
    lines.push(' No structured causal knowledge recorded yet.')
  } else {
    for (const [idx, r] of causalRecords.entries()) {
      const c = r.source.causal
      lines.push('')
      lines.push(`[${idx + 1}] [${r.id}] ${r.title} (${r.authority}/${r.validation})`)
      lines.push(`    Symptom          : ${c.symptom || '(not stated)'}`)
      lines.push(`      ↓ Root Cause   : ${c.rootCause || '(not stated)'}`)
      lines.push(`      ↓ Remedy       : ${c.remedy || '(not stated)'}`)
      lines.push(`      ↓ Outcome      : ${c.verifiedOutcome || '(unverified)'}`)
      if (r.evidence?.length) {
        const evPaths = r.evidence.map((e) => (typeof e === 'string' ? e : e.path || e.note)).filter(Boolean)
        if (evPaths.length) lines.push(`    Evidence Anchors : ${evPaths.join(', ')}`)
      }
    }
  }

  lines.push('')
  lines.push(' Invariant: Temporal adjacency alone never creates causality.')
  lines.push('════════════════════════════════════════════════════════════════════════')

  return { ok: true, data: causalRecords, formatted: lines.join('\n') }
}

/**
 * Relationship graph inspection.
 */
export function observatoryRelationships({ projectStore, reusableStore = null, id = null, limit = 50 } = {}) {
  const allRecords = [
    ...(projectStore ? projectStore.list({ limit: 100 }) : []),
    ...(reusableStore ? reusableStore.list({ limit: 50 }) : []),
  ]

  const edges = []
  const recordMap = new Map(allRecords.map((r) => [r.id, r]))

  for (const rec of allRecords) {
    for (const rel of rec.relations || []) {
      if (id && rec.id !== id && rel.targetId !== id) continue
      edges.push({
        fromId: rec.id,
        fromTitle: rec.title,
        type: rel.type,
        targetId: rel.targetId,
        targetTitle: recordMap.get(rel.targetId)?.title || '(external/unindexed)',
      })
    }
  }

  const limitedEdges = edges.slice(0, Math.max(1, limit))

  const lines = [
    '════════════════════════════════════════════════════════════════════════',
    ` VEYRA OBSERVATORY — RELATIONSHIP GRAPH (${limitedEdges.length} edges)`,
    id ? ` Scope: filtered to record [${id}]` : ' Scope: project & reusable stores',
    '════════════════════════════════════════════════════════════════════════',
  ]

  if (limitedEdges.length === 0) {
    lines.push(' No relationship edges recorded.')
  } else {
    for (const e of limitedEdges) {
      lines.push(`  [${e.fromId}] --[ ${e.type.toUpperCase()} ]--> [${e.targetId}]`)
      lines.push(`    Source: "${e.fromTitle}"`)
      lines.push(`    Target: "${e.targetTitle}"`)
    }
  }

  lines.push('════════════════════════════════════════════════════════════════════════')

  return { ok: true, data: limitedEdges, formatted: lines.join('\n') }
}

/**
 * Contradictions inspection.
 */
export function observatoryContradictions({ projectStore, reusableStore = null } = {}) {
  const allRecords = [
    ...(projectStore ? projectStore.list({ limit: 100 }) : []),
    ...(reusableStore ? reusableStore.list({ limit: 50 }) : []),
  ]

  const pairs = []
  const seenPairKeys = new Set()

  for (const rec of allRecords) {
    for (const rel of rec.relations || []) {
      if (rel.type !== RELATIONS.CONTRADICTS) continue
      const pairKey = [rec.id, rel.targetId].sort().join(':')
      if (seenPairKeys.has(pairKey)) continue
      seenPairKeys.add(pairKey)
      const opposing = projectStore?.get(rel.targetId) || reusableStore?.get(rel.targetId) || null
      pairs.push({ a: rec, b: opposing, targetId: rel.targetId })
    }
  }

  const lines = [
    '════════════════════════════════════════════════════════════════════════',
    ` VEYRA OBSERVATORY — CONTRADICTION INSPECTION (${pairs.length} conflicts)`,
    '════════════════════════════════════════════════════════════════════════',
  ]

  if (pairs.length === 0) {
    lines.push(' No active contradictions recorded. All knowledge claims are aligned.')
  } else {
    for (const [idx, p] of pairs.entries()) {
      lines.push('')
      lines.push(`[Conflict #${idx + 1}]`)
      lines.push(`  Side A: [${p.a.id}] (${p.a.authority}/${p.a.validation}) "${p.a.title}"`)
      lines.push(`          ${p.a.body.slice(0, 180)}...`)
      if (p.b) {
        lines.push(`  Side B: [${p.b.id}] (${p.b.authority}/${p.b.validation}) "${p.b.title}"`)
        lines.push(`          ${p.b.body.slice(0, 180)}...`)
      } else {
        lines.push(`  Side B: [${p.targetId}] (missing from active stores)`)
      }
      lines.push('  Action: Do not resolve automatically. Verify against codebase or tests.')
    }
  }

  lines.push('════════════════════════════════════════════════════════════════════════')

  return { ok: true, data: pairs, formatted: lines.join('\n') }
}
