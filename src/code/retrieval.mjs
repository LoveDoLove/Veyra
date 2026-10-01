/**
 * Veyra Code Intelligence — Unified Search & Retrieval Pipeline.
 *
 * Implements Stage 6:
 *   - Multi-source execution:
 *       1. Code Intelligence (symbols, graph, call paths, snippet context)
 *       2. Engineering Memory (decisions, constraints, patterns, RAG knowledge)
 *       3. Evidence & Freshness evaluation (fresh, potentially_stale, invalid)
 *       4. Validation & Authority verification
 *   - Transparent, explainable score decomposition
 *   - Clean distinction between Code Truth (authoritative repository state)
 *     and Memory (historical context, non-authoritative)
 *   - Discrepancy & contradiction detection between memory claims and current code
 *   - Graceful degradation when code intelligence engine is unavailable
 */

import { hybridRetrieve } from '../retrieve.mjs'
import { checkRecordFreshness } from './linking.mjs'
import { FRESHNESS_STATUS } from './types.mjs'
import { sanitizeCodeContent } from './discovery.mjs'

/**
 * Execute a unified search across Code Intelligence and Engineering Memory.
 */
export async function unifiedRetrieve({
  query,
  repoRoot,
  projectStore,
  reusableStore = null,
  codeEngine = null,
  limit = 5,
  codeLimit = 5,
  includeCode = true,
  includeMemory = true,
}) {
  const result = {
    query,
    code: [],
    memories: [],
    contradictions: [],
    degraded: false,
    degradedReason: null,
  }

  // 1. Engineering Memory Retrieval
  if (includeMemory && projectStore) {
    try {
      const memoryHits = hybridRetrieve({
        projectStore,
        reusableStore,
        query,
        limit,
      })

      // Evaluate code anchor freshness for each memory hit
      for (const hit of memoryHits) {
        let freshness = { status: FRESHNESS_STATUS.FRESH, anchors: [] }
        if (repoRoot) {
          freshness = checkRecordFreshness(hit, repoRoot)
        }

        const enrichedHit = {
          ...hit,
          freshness: freshness.status,
          anchorDetails: freshness.anchors,
        }

        // Freshness penalty for ranking if stale or invalid
        if (freshness.status === FRESHNESS_STATUS.POTENTIALLY_STALE) {
          enrichedHit.scores = {
            ...enrichedHit.scores,
            freshness_penalty: 0.15,
            composite: Math.max(0, Number((enrichedHit.scores.composite - 0.15).toFixed(4))),
          }
        } else if (freshness.status === FRESHNESS_STATUS.INVALID) {
          enrichedHit.scores = {
            ...enrichedHit.scores,
            freshness_penalty: 0.35,
            composite: Math.max(0, Number((enrichedHit.scores.composite - 0.35).toFixed(4))),
          }
        }

        result.memories.push(enrichedHit)

        // Flag discrepancies if evidence is invalid or stale
        if (freshness.status === FRESHNESS_STATUS.INVALID) {
          result.contradictions.push({
            type: 'invalid_code_evidence',
            memoryId: hit.id,
            title: hit.title,
            message: `Memory references code that no longer exists: ${freshness.anchors.map((a) => a.anchor?.path || a.reason).join(', ')}`,
          })
        }
      }
    } catch (err) {
      // Memory failure should not crash code search
    }
  }

  // 2. Code Intelligence Retrieval
  if (includeCode && codeEngine && repoRoot) {
    if (codeEngine.isDegraded) {
      result.degraded = true
      result.degradedReason = 'Code intelligence binary is unavailable; running in degraded mode.'
    } else {
      try {
        const symbolRes = await codeEngine.searchSymbols(repoRoot, {
          query,
          limit: codeLimit,
        })

        if (symbolRes.ok && symbolRes.raw) {
          result.code.push({
            type: 'symbols',
            raw: symbolRes.raw,
          })
        }

        const textRes = await codeEngine.searchCodeText(repoRoot, {
          query,
          limit: codeLimit,
        })

        if (textRes.ok && textRes.results) {
          result.code.push({
            type: 'code_text',
            results: sanitizeCodeContent(textRes.results),
          })
        }
      } catch (err) {
        result.degraded = true
        result.degradedReason = `Code intelligence query failed: ${err.message}`
      }
    }
  }

  return result
}

/**
 * Format unified retrieval results into clean markdown for agent prompt injection.
 */
export function formatUnifiedForPrompt(unifiedResult) {
  const sections = []

  // Notice if degraded
  if (unifiedResult.degraded) {
    sections.push(`> ⚠️ [CODE INTELLIGENCE DEGRADED: ${unifiedResult.degradedReason || 'Service unavailable'}. Memory remains active.]`)
  }

  // Contradictions / Stale Evidence Warnings
  if (unifiedResult.contradictions.length > 0) {
    for (const c of unifiedResult.contradictions) {
      sections.push(`> ⚠️ [CODE DISCREPANCY: Memory [${c.memoryId}] '${c.title}' references deleted or invalid code. Verify against current repository.]`)
    }
  }

  // Code Intelligence (Repository Truth)
  if (unifiedResult.code.length > 0) {
    sections.push('### Repository Code (Authoritative)')
    for (const c of unifiedResult.code) {
      if (c.type === 'symbols' && c.raw) {
        sections.push('```\n' + c.raw.trim() + '\n```')
      } else if (c.type === 'code_text' && c.results) {
        sections.push('```\n' + c.results.trim() + '\n```')
      }
    }
  }

  // Engineering Memory (Historical Context)
  if (unifiedResult.memories.length > 0) {
    sections.push('### Veyra Engineering Memory (Contextual / Historical)')
    for (const m of unifiedResult.memories) {
      const freshnessTag = m.freshness && m.freshness !== FRESHNESS_STATUS.FRESH ? ` [${m.freshness.toUpperCase()}]` : ''
      const line = `- [${m.id}] (${m.scope}/${m.status}/${m.validation}/${m.confidence})${freshnessTag} ${m.title}\n  ${m.body}`
      sections.push(line)
    }
  }

  return sections.join('\n\n')
}
