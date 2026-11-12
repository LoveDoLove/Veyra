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
import { CODE_FRESHNESS } from '../types.mjs'
import { cbm } from '../cbm-bridge.mjs'
import { scrub } from '../redact.mjs'

/**
 * CBM's `sanitizeCodeContent` scrubs secrets out of raw code text. Without the
 * bridge the same pass must still happen, so it falls back to Veyra's own
 * scrubber — which returns `{ clean, scrubbed, … }`, not a string, hence
 * `.scrubbed`. The `typeof` guard mirrors the upstream function's opening
 * `if (typeof content !== 'string') return ''`, so a null/non-string result
 * degrades to an empty string instead of changing shape.
 */
const sanitizeCode = typeof cbm.sanitizeCodeContent === 'function'
  ? cbm.sanitizeCodeContent
  : (text) => (typeof text === 'string' ? scrub(text).scrubbed : '')

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
        let freshness = { status: CODE_FRESHNESS.FRESH, anchors: [] }
        if (repoRoot) {
          freshness = checkRecordFreshness(hit, repoRoot)
        }

        const enrichedHit = {
          ...hit,
          freshness: freshness.status,
          anchorDetails: freshness.anchors,
        }

        // An unverifiable anchor is INVALID on the wire but carries no evidence
        // that the code changed: it must not be penalised as stale evidence nor
        // declared a contradiction. Downgrading it would turn "unknown" into
        // "gone", which is exactly the fabrication this bridge used to make.
        const unverifiable = freshness.unverifiable === true

        // Freshness penalty for ranking if stale or invalid
        if (!unverifiable && freshness.status === CODE_FRESHNESS.POTENTIALLY_STALE) {
          enrichedHit.scores = {
            ...enrichedHit.scores,
            freshness_penalty: 0.15,
            composite: Math.max(0, Number((enrichedHit.scores.composite - 0.15).toFixed(4))),
          }
        } else if (!unverifiable && freshness.status === CODE_FRESHNESS.INVALID) {
          enrichedHit.scores = {
            ...enrichedHit.scores,
            freshness_penalty: 0.35,
            composite: Math.max(0, Number((enrichedHit.scores.composite - 0.35).toFixed(4))),
          }
        }

        result.memories.push(enrichedHit)

        // Flag discrepancies if evidence is invalid or stale
        if (!unverifiable && freshness.status === CODE_FRESHNESS.INVALID) {
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
            results: sanitizeCode(textRes.results),
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
      const freshnessTag = m.freshness && m.freshness !== CODE_FRESHNESS.FRESH ? ` [${m.freshness.toUpperCase()}]` : ''
      const line = `- [${m.id}] (${m.scope}/${m.status}/${m.validation}/${m.confidence})${freshnessTag} ${m.title}\n  ${m.body}`
      sections.push(line)
    }
  }

  return sections.join('\n\n')
}
