/**
 * Veyra Code Intelligence — Code ↔ Evidence ↔ Memory Linking.
 *
 * Implements Stage 5:
 *   - Explicit provenance chain: Code Entity -> Evidence Anchor -> Memory Record -> Validation State
 *   - Structured anchor creation and parsing
 *   - Freshness evaluation (fresh, potentially_stale, invalid)
 *   - Impact analysis: detecting memories affected by code modifications/deletions
 *   - Review candidate generation without silent invalidation or auto-canonicalization
 *   - Invariants:
 *       Observe ≠ Store
 *       Candidate ≠ Truth
 *       Code changes NEVER silently alter, invalidate, or canonicalize Memory
 */

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { sha256Hex } from '../ids.mjs'
import { FRESHNESS_STATUS } from './types.mjs'
import { resolveSafeRepoPath } from './discovery.mjs'
import { KINDS, STATUSES, AUTHORITIES, VALIDATIONS, CONFIDENCES, SCOPES } from '../types.mjs'

/**
 * Build a structured code evidence anchor.
 */
export function createCodeAnchor({ repoRoot, path, symbol, projectId, revision }) {
  const safeRel = resolveSafeRepoPath(repoRoot, path)
  if (!safeRel) {
    throw new Error(`Anchor path escapes repository boundary: ${path}`)
  }

  const absPath = join(repoRoot, safeRel)
  let contentHash = null
  if (existsSync(absPath)) {
    try {
      const content = readFileSync(absPath, 'utf8')
      contentHash = sha256Hex(content)
    } catch {
      // ignore read error
    }
  }

  return {
    path: safeRel,
    symbol: symbol || null,
    project_id: projectId || null,
    revision: revision || null,
    content_hash: contentHash,
    timestamp: Date.now(),
  }
}

/**
 * Extract structured code anchors from a memory record.
 */
export function extractAnchorsFromRecord(record) {
  if (!record) return []
  const rawEvidence = record.evidence
  let items = []

  if (typeof rawEvidence === 'string') {
    try {
      const parsed = JSON.parse(rawEvidence)
      items = Array.isArray(parsed) ? parsed : [parsed]
    } catch {
      // Plain text or legacy format
      items = [rawEvidence]
    }
  } else if (Array.isArray(rawEvidence)) {
    items = rawEvidence
  } else if (rawEvidence && typeof rawEvidence === 'object') {
    items = [rawEvidence]
  }

  const anchors = []
  for (const it of items) {
    if (!it) continue
    if (typeof it === 'string') {
      const pathMatch = it.match(/^path=(.+)$/i)
      if (pathMatch) {
        anchors.push({ path: pathMatch[1].trim() })
      } else if (it.startsWith('sym:') || it.startsWith('symbol:')) {
        anchors.push({ symbol: it.replace(/^(sym:|symbol:)/, '').trim() })
      }
    } else if (typeof it === 'object') {
      if (it.path || it.symbol || it.uri) {
        anchors.push({
          path: it.path || null,
          symbol: it.symbol || null,
          content_hash: it.content_hash || it.contentHash || null,
          revision: it.revision || null,
          note: it.note || null,
        })
      }
    }
  }

  return anchors
}

/**
 * Check freshness of a single code anchor against repo state.
 */
export function checkAnchorFreshness(anchor, repoRoot) {
  if (!anchor || !anchor.path) {
    return { status: FRESHNESS_STATUS.FRESH, reason: 'No file path specified' }
  }

  const safeRel = resolveSafeRepoPath(repoRoot, anchor.path)
  if (!safeRel) {
    return { status: FRESHNESS_STATUS.INVALID, reason: 'Path outside repository or invalid' }
  }

  const absPath = join(repoRoot, safeRel)
  if (!existsSync(absPath)) {
    return { status: FRESHNESS_STATUS.INVALID, reason: `File not found: ${safeRel}` }
  }

  if (anchor.content_hash) {
    try {
      const currentContent = readFileSync(absPath, 'utf8')
      const currentHash = sha256Hex(currentContent)
      if (currentHash !== anchor.content_hash) {
        return {
          status: FRESHNESS_STATUS.POTENTIALLY_STALE,
          reason: `Content hash changed from ${anchor.content_hash.slice(0, 8)} to ${currentHash.slice(0, 8)}`,
        }
      }
    } catch (err) {
      return { status: FRESHNESS_STATUS.POTENTIALLY_STALE, reason: `Cannot verify file: ${err.message}` }
    }
  }

  // If a symbol is specified, check if symbol exists in content
  if (anchor.symbol) {
    try {
      const content = readFileSync(absPath, 'utf8')
      if (!content.includes(anchor.symbol)) {
        return {
          status: FRESHNESS_STATUS.POTENTIALLY_STALE,
          reason: `Symbol ${anchor.symbol} not found in ${safeRel}`,
        }
      }
    } catch {
      // ignore
    }
  }

  return { status: FRESHNESS_STATUS.FRESH, reason: 'File and symbol verified' }
}

/**
 * Evaluate record freshness across all its evidence anchors.
 */
export function checkRecordFreshness(record, repoRoot) {
  const anchors = extractAnchorsFromRecord(record)
  if (anchors.length === 0) {
    return {
      status: FRESHNESS_STATUS.FRESH,
      anchors: [],
      reason: 'No code anchors attached',
    }
  }

  const evaluated = []
  let hasInvalid = false
  let hasStale = false

  for (const anc of anchors) {
    const fresh = checkAnchorFreshness(anc, repoRoot)
    evaluated.push({ anchor: anc, ...fresh })
    if (fresh.status === FRESHNESS_STATUS.INVALID) hasInvalid = true
    if (fresh.status === FRESHNESS_STATUS.POTENTIALLY_STALE) hasStale = true
  }

  let status = FRESHNESS_STATUS.FRESH
  if (hasInvalid) {
    status = FRESHNESS_STATUS.INVALID
  } else if (hasStale) {
    status = FRESHNESS_STATUS.POTENTIALLY_STALE
  }

  return {
    status,
    anchors: evaluated,
  }
}

/**
 * Find memory records affected by a set of changed file paths.
 */
export function findAffectedMemories(repoRoot, changedFiles = [], memories = []) {
  const normalizedChanged = new Set(
    changedFiles.map((f) => resolveSafeRepoPath(repoRoot, f)).filter(Boolean)
  )

  if (normalizedChanged.size === 0) return []

  const affected = []

  for (const mem of memories) {
    const anchors = extractAnchorsFromRecord(mem)
    const matchingAnchors = []

    for (const anc of anchors) {
      if (!anc.path) continue
      const safeRel = resolveSafeRepoPath(repoRoot, anc.path)
      if (safeRel && normalizedChanged.has(safeRel)) {
        matchingAnchors.push(anc)
      }
    }

    if (matchingAnchors.length > 0) {
      const freshness = checkRecordFreshness(mem, repoRoot)
      affected.push({
        memoryId: mem.id,
        title: mem.title,
        authority: mem.authority,
        validation: mem.validation,
        status: mem.status,
        affectedAnchors: matchingAnchors,
        freshness: freshness.status,
        details: freshness.anchors,
      })
    }
  }

  return affected
}

/**
 * Generate a candidate review observation when code changes affect memory evidence.
 * Invariant: Never alters canonical or existing memory; creates a candidate for review.
 */
export function buildStaleReviewCandidate(affectedMemory, changedFile, reason) {
  return {
    kind: KINDS.OBSERVATION,
    status: STATUSES.CANDIDATE,
    authority: AUTHORITIES.UNVERIFIED,
    validation: VALIDATIONS.UNVERIFIED,
    confidence: CONFIDENCES.MEDIUM,
    scope: SCOPES.PROJECT,
    title: `[Review Needed] Code change in ${changedFile} may affect memory: ${affectedMemory.title}`,
    body: `Evidence anchor in ${changedFile} was modified or deleted (${reason}).\nAffected memory: [${affectedMemory.memoryId}] ${affectedMemory.title} (Authority: ${affectedMemory.authority}).\nPlease review whether this memory remains accurate.`,
    evidence: [
      {
        path: changedFile,
        note: `Referenced by memory ${affectedMemory.memoryId}`,
      },
    ],
    tags: ['code-change-impact', 'review-candidate'],
  }
}
