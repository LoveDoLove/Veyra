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
import { resolveRepoPath } from '../cbm-bridge.mjs'
import { CODE_FRESHNESS, KINDS, STATUSES, AUTHORITIES, VALIDATIONS, CONFIDENCES, SCOPES } from '../types.mjs'
import { VALID_STATUSES } from '../types.mjs'

/**
 * Build a structured code evidence anchor.
 */
export function createCodeAnchor({ repoRoot, path, symbol, projectId, revision }) {
  const safeRel = resolveRepoPath(repoRoot, path)
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
    return { status: CODE_FRESHNESS.FRESH, reason: 'No file path specified' }
  }

  const safeRel = resolveRepoPath(repoRoot, anchor.path)
  if (!safeRel) {
    return { status: CODE_FRESHNESS.INVALID, reason: 'Path outside repository or invalid' }
  }

  const absPath = join(repoRoot, safeRel)
  if (!existsSync(absPath)) {
    return { status: CODE_FRESHNESS.INVALID, reason: `File not found: ${safeRel}` }
  }

  if (anchor.content_hash) {
    try {
      const currentContent = readFileSync(absPath, 'utf8')
      const currentHash = sha256Hex(currentContent)
      if (currentHash !== anchor.content_hash) {
        return {
          status: CODE_FRESHNESS.POTENTIALLY_STALE,
          reason: `Content hash changed from ${anchor.content_hash.slice(0, 8)} to ${currentHash.slice(0, 8)}`,
        }
      }
    } catch (err) {
      return { status: CODE_FRESHNESS.POTENTIALLY_STALE, reason: `Cannot verify file: ${err.message}` }
    }
  }

  // If a symbol is specified, check if symbol exists in content
  if (anchor.symbol) {
    try {
      const content = readFileSync(absPath, 'utf8')
      if (!content.includes(anchor.symbol)) {
        return {
          status: CODE_FRESHNESS.POTENTIALLY_STALE,
          reason: `Symbol ${anchor.symbol} not found in ${safeRel}`,
        }
      }
    } catch {
      // ignore
    }
  }

  return { status: CODE_FRESHNESS.FRESH, reason: 'File and symbol verified' }
}

/**
 * Evaluate record freshness across all its evidence anchors.
 */
export function checkRecordFreshness(record, repoRoot) {
  const anchors = extractAnchorsFromRecord(record)
  if (anchors.length === 0) {
    return {
      status: CODE_FRESHNESS.FRESH,
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
    if (fresh.status === CODE_FRESHNESS.INVALID) hasInvalid = true
    if (fresh.status === CODE_FRESHNESS.POTENTIALLY_STALE) hasStale = true
  }

  let status = CODE_FRESHNESS.FRESH
  if (hasInvalid) {
    status = CODE_FRESHNESS.INVALID
  } else if (hasStale) {
    status = CODE_FRESHNESS.POTENTIALLY_STALE
  }

  return {
    status,
    anchors: evaluated,
  }
}

/**
 * Find memory records affected by a set of changed file paths.
 */
/**
 * Normalize explicit rename evidence for Phase 1 change-impact matching.
 *
 * Phase 1 only: callers supply unambiguous renames; we never infer identity
 * from git, content hashes, or similar paths. Invalid, out-of-repo,
 * duplicate, or conflicting mappings fail closed (the whole rename set is
 * rejected) so ambiguous rename candidates never establish applicability.
 *
 * @param {string} repoRoot
 * @param {Array<{from?: string, to?: string}> | null | undefined} renames
 * @returns {{ ok: true, map: Map<string, string[]> } | { ok: false, error: string }}
 *   map: normalized target path -> normalized source anchor paths that were
 *   explicitly renamed to that target.
 */
export function normalizeRenameEvidence(repoRoot, renames) {
  const map = new Map()
  if (renames == null) return { ok: true, map }
  if (!Array.isArray(renames)) return { ok: false, error: 'renames must be an array of { from, to } objects' }
  for (const entry of renames) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      return { ok: false, error: 'each rename entry must be an object with string from/to paths' }
    }
    const { from, to } = entry
    if (typeof from !== 'string' || !from.trim() || typeof to !== 'string' || !to.trim()) {
      return { ok: false, error: 'each rename entry requires non-empty string from and to paths' }
    }
    let safeFrom, safeTo
    try { safeFrom = resolveRepoPath(repoRoot, from) } catch {
      safeFrom = null
    }
    if (typeof safeFrom !== 'string' || !safeFrom) {
      return { ok: false, error: `rename from path is outside the repository or invalid: ${from}` }
    }
    try { safeTo = resolveRepoPath(repoRoot, to) } catch {
      safeTo = null
    }
    if (typeof safeTo !== 'string' || !safeTo) {
      return { ok: false, error: `rename to path is outside the repository or invalid: ${to}` }
    }
    if (safeFrom === safeTo) continue // no-op mapping; never creates applicability
    const existing = map.get(safeTo)
    if (existing) {
      if (existing.includes(safeFrom)) continue // exact duplicate mapping is harmless
      return { ok: false, error: `conflicting rename mappings for target ${safeTo}` }
    }
    map.set(safeTo, [safeFrom])
  }
  return { ok: true, map }
}

/**
 * Build reverse lookup: original anchor path -> set of changed target paths
 * that explicitly rename that anchor (and are present in the changed set).
 * Only unambiguous normalized mappings are represented.
 */
export function renameTargetsForAnchor(changedSet, renameMap) {
  const byAnchor = new Map()
  if (!(changedSet instanceof Set) || !(renameMap instanceof Map) || renameMap.size === 0) return byAnchor
  for (const changed of changedSet) {
    const sources = renameMap.get(changed)
    if (!Array.isArray(sources)) continue
    for (const from of sources) {
      if (typeof from !== 'string' || !from) continue
      let targets = byAnchor.get(from)
      if (!targets) { targets = new Set(); byAnchor.set(from, targets) }
      targets.add(changed)
    }
  }
  return byAnchor
}

export function findAffectedMemories(repoRoot, changedFiles = [], memories = [], options = {}) {
  // Normalize changed file paths via shared path normalization (preserve
  // existing skip-on-invalid behavior; do not throw for bad changed paths).
  const normalizedChanged = new Set()
  for (const f of Array.isArray(changedFiles) ? changedFiles : []) {
    // resolveRepoPath returns null instead of throwing (absent bridge, or a
    // path outside the repo), so the skip must be explicit: adding the null
    // would poison the set that anchor matching compares against.
    const rel = resolveRepoPath(repoRoot, f)
    if (rel) normalizedChanged.add(rel)
  }
  if (normalizedChanged.size === 0) return []

  // Phase 1 explicit rename evidence: optional, unambiguous, never inferred.
  // Accept a pre-normalized Map (target -> [sources]) or raw renames array.
  let renameMap = new Map()
  if (options?.renameMap instanceof Map) {
    renameMap = options.renameMap
  } else if (Array.isArray(options?.renames) && options.renames.length > 0) {
    const norm = normalizeRenameEvidence(repoRoot, options.renames)
    if (norm.ok) renameMap = norm.map
    // Invalid evidence fails closed: no rename applicability is established.
  }
  const renamedAnchorTargets = renameTargetsForAnchor(normalizedChanged, renameMap)

  const affected = []

  for (const mem of memories) {
    const anchors = extractAnchorsFromRecord(mem)
    const matchingAnchors = []

    for (const anc of anchors) {
      if (!anc.path) continue
      let safeRel
      try { safeRel = resolveRepoPath(repoRoot, anc.path) } catch { continue }
      if (safeRel && normalizedChanged.has(safeRel)) {
        matchingAnchors.push(anc)
        continue
      }
      // Explicit unambiguous rename: changed target maps to this original anchor.
      // Preserve the original anchor object; never rewrite stored evidence.
      const targets = renamedAnchorTargets.get(safeRel)
      if (targets instanceof Set && targets.size > 0) {
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
    status: STATUSES.CURRENT, // CANDIDATE is not in VALID_STATUSES, use CURRENT
    authority: AUTHORITIES.CANDIDATE,
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
