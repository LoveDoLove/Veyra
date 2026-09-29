/**
 * Veyra — M12 C3: Consolidation Detection.
 *
 * `detect → propose → surface`. This module DETECTS consolidation candidates
 * and returns them as non-authoritative proposals. It never merges, never
 * deletes, never rewrites history, and NEVER changes authority / validation /
 * status / forgotten on any record. Every proposal is a plain object that is
 * surfaced for review — an automatic proposal is not canonical knowledge.
 *
 * All five target types REUSE existing engines (no second scoring / dedup /
 * relation engine):
 *   - exact/near duplicate      → `diffMemory` + `strongestMatch` (diff.mjs)
 *   - contradiction clusters    → `detectContradictions` (evolve.mjs) + union-find
 *   - replacement candidates    → `supersedeEligible` (evolve.mjs) — "A may be superseded by B"
 *   - outdated                  → `verifyEvidenceHealth` (evolve.mjs) — evidence files deleted
 *   - retirement candidates     → existing lifecycle-freshness (`validation` stale/invalid)
 *
 * Complexity (documented per the maintenance contract):
 *   - Input is bounded to `limit` records (default 200 = MAINTENANCE_LIST_LIMIT),
 *     read from the existing `store.list` — NOT an unbounded DB scan.
 *   - duplicate pass  O(n²) pair comparisons (n ≤ limit)
 *   - replacement pass O(k·n) where k = records carrying replacement language (rare);
 *     relevance-scoped, then ONE neighbour through the production `evolveAgainst`
 *     path, so a replacement claim can surface at most one proposal per record
 *   - contradiction / outdated / retirement passes are O(n) / O(edges)
 *   - Runs only inside the existing maintenance cadence (~every 5th turn) and
 *     on-demand from read-only Observatory. No scheduler, worker, or daemon.
 *
 * Per-type proposal lists are capped (`PROPOSAL_LIMIT`) while `counts` reports
 * the true detection totals.
 */

import { STATUSES, VALIDATIONS, AUTHORITIES } from './types.mjs'
import { DIFF, diffMemory, strongestMatch, replacementEvidence, sharesSubject } from './diff.mjs'
import { detectContradictions, verifyEvidenceHealth, supersedeEligible, evolveAgainst } from './evolve.mjs'

/** Ceiling on surfaced proposals per type. Counts remain uncapped. */
export const PROPOSAL_LIMIT = 20

/** Input ceiling — matches the existing maintenance list limit. */
const DETECTION_LIST_LIMIT = 200

export const PROPOSAL_TYPES = Object.freeze({
  DUPLICATE: 'duplicate',
  CONTRADICTION: 'contradiction',
  OUTDATED: 'outdated',
  REPLACEMENT: 'replacement',
  RETIREMENT: 'retirement',
})

function brief(record) {
  if (!record) return null
  return {
    id: record.id,
    title: record.title || record.id,
    kind: record.kind || null,
    status: record.status || null,
    validation: record.validation || null,
    authority: record.authority || null,
    updatedAt: record.updated_at || null,
  }
}

/** Shared file/path evidence between two records (from stored provenance only). */
function sharedPaths(a, b) {
  const paths = (r) => {
    const out = new Set()
    for (const e of r?.evidence || []) if (e && typeof e.path === 'string' && e.path) out.add(e.path)
    for (const f of r?.source?.files || []) if (typeof f === 'string' && f) out.add(f)
    return out
  }
  const left = paths(a)
  const right = paths(b)
  const shared = []
  for (const p of left) if (right.has(p)) shared.push(p)
  return shared.sort()
}

/** Connected components over an undirected edge list (union-find). */
function connectedClusters(pairs) {
  const parent = new Map()
  const find = (x) => {
    if (parent.get(x) === x) return x
    parent.set(x, find(parent.get(x)))
    return parent.get(x)
  }
  const union = (a, b) => {
    const ra = find(a)
    const rb = find(b)
    if (ra !== rb) parent.set(ra, rb)
  }
  for (const p of pairs) {
    if (!parent.has(p.a)) parent.set(p.a, p.a)
    if (!parent.has(p.b)) parent.set(p.b, p.b)
    union(p.a, p.b)
  }
  const groups = new Map()
  for (const id of parent.keys()) {
    const root = find(id)
    if (!groups.has(root)) groups.set(root, [])
    groups.get(root).push(id)
  }
  return [...groups.values()].filter((g) => g.length >= 2)
}

/**
 * Detect consolidation candidates across a bounded record list.
 *
 * PURE + READ-ONLY: reads the records it is given, returns proposals, and
 * never mutates its inputs or any store.
 *
 * @param {object[]} records  bounded record list (e.g. from `store.list({limit})`)
 * @param {object}   [opts]
 * @param {string}   [opts.workspace]  enables outdated/evidence-health detection
 * @param {number}   [opts.limit]      input ceiling (default 200)
 * @returns {{ candidates: object[], counts: object, truncated: boolean }}
 */
export function detectConsolidationCandidates(records, { workspace = null, limit = DETECTION_LIST_LIMIT } = {}) {
  const list = (Array.isArray(records) ? records : [])
    .filter((r) => r && r.id && !r.forgotten)
    .slice(0, limit)

  const candidates = []
  const counts = {
    [PROPOSAL_TYPES.DUPLICATE]: 0,
    [PROPOSAL_TYPES.CONTRADICTION]: 0,
    [PROPOSAL_TYPES.OUTDATED]: 0,
    [PROPOSAL_TYPES.REPLACEMENT]: 0,
    [PROPOSAL_TYPES.RETIREMENT]: 0,
    total: 0,
  }
  const shown = { [PROPOSAL_TYPES.DUPLICATE]: 0, [PROPOSAL_TYPES.CONTRADICTION]: 0, [PROPOSAL_TYPES.OUTDATED]: 0, [PROPOSAL_TYPES.REPLACEMENT]: 0, [PROPOSAL_TYPES.RETIREMENT]: 0 }

  const push = (type, cand) => {
    counts[type] += 1
    counts.total += 1
    if (shown[type] < PROPOSAL_LIMIT) {
      shown[type] += 1
      candidates.push({ type, ...cand })
    }
  }

  // ── 1. Exact / near duplicates (reuse diffMemory → strongestMatch) ──
  const seenPairs = new Set()
  for (let i = 0; i < list.length; i++) {
    const others = list.slice(i + 1)
    if (!others.length) continue
    const diff = diffMemory(list[i], others, { limit: others.length })
    const dup = strongestMatch(diff, DIFF.DUPLICATE)
    if (!dup || !dup.record) continue
    const key = [list[i].id, dup.record.id].sort().join('::')
    if (seenPairs.has(key)) continue
    seenPairs.add(key)
    const shared = sharedPaths(list[i], dup.record)
    push(PROPOSAL_TYPES.DUPLICATE, {
      why: `near-identical claims (similarity ${dup.similarity.toFixed(2)})`,
      records: [brief(list[i]), brief(dup.record)],
      evidence: shared.length ? shared.map((p) => ({ path: p })) : [{ note: 'high claim similarity, no shared path evidence' }],
      proposedAction: 'review-merge',
      similarity: dup.similarity,
    })
  }

  // ── 2. Contradiction clusters (reuse detectContradictions + union-find) ──
  const { pairs } = detectContradictions(list)
  if (pairs.length) {
    const byId = new Map(list.map((r) => [r.id, r]))
    for (const cluster of connectedClusters(pairs)) {
      const members = cluster.map((id) => brief(byId.get(id))).filter(Boolean)
      push(PROPOSAL_TYPES.CONTRADICTION, {
        why: `${cluster.length} records linked by contradicts relations`,
        records: members,
        evidence: pairs
          .filter((p) => cluster.includes(p.a) && cluster.includes(p.b))
          .map((p) => ({ relation: 'contradicts', from: p.a, to: p.b })),
        proposedAction: 'review-contradiction',
        cluster,
      })
    }
  }

  // ── 3. Replacement candidates "A may be superseded by B" (reuse supersedeEligible) ──
  //
  // Detection stays read-only and the supersession gate is untouched — still
  // byte-identical `supersedeEligible()`. What is scoped is WHICH pairs may
  // reach it, in three stages, all reusing existing machinery:
  //
  //   1. relevance  — only records whose claims share at least one token may
  //                   compete as the neighbour. Sharing a repository path
  //                   proves two records touch the same file; it does not
  //                   prove the same subject was revised. Without this stage a
  //                   shared path alone would nominate any path-sharing peer,
  //                   which is how unrelated audit records in the same repo
  //                   became replacement proposals.
  //   2. evolution  — `evolveAgainst` picks the neighbour production itself
  //                   would consider (duplicate short-circuit first, then the
  //                   strongest conflict/update match), so a record yields at
  //                   most one candidate instead of one per peer.
  //   3. supersession — `supersedeEligible()`, unmodified, decides.
  //
  // `store` is null: `linkConflict` is guarded by `if (store && …)` and
  // `linkUpdate` by `store && supersedeEligible(…)`, so both short-circuit to
  // false without writing. Detection is never mutation.
  //
  // Branches production never lets reach supersession are skipped too:
  // `duplicate` returns before any supersession, and `extend` / `add` are not
  // replacement signals. Only `conflict` and `update` carry a neighbour that
  // `supersedeEligible` was ever applied to in production.
  for (let i = 0; i < list.length; i++) {
    if (!replacementEvidence(list[i])) continue // supersedeEligible requires replacement language on incoming
    // Stage 1 — candidate relevance. `similarity <= 0` is the boundary diff.mjs
    // itself draws for "no relationship"; `> 0` is any shared claim token.
    const relevant = diffMemory(list[i], list, { limit: list.length }).matches
      .filter((m) => m.similarity > 0 && m.record && m.record.id !== list[i].id)
      .map((m) => m.record)
    if (!relevant.length) continue // provenance overlap without claim overlap
    // Stage 2 — production neighbour selection, read-only.
    const selected = evolveAgainst(null, list[i], relevant)
    const neighbor = selected?.neighbor
    if (!neighbor) continue
    if (selected.action !== 'conflict' && selected.action !== 'update') continue
    // Stage 3 — the existing, unmodified supersession gate.
    if (!supersedeEligible(list[i], neighbor)) continue
    const shared = sharedPaths(list[i], neighbor)
    push(PROPOSAL_TYPES.REPLACEMENT, {
      why: `${list[i].title || list[i].id} states a directional replacement of subject-sharing record ${neighbor.title || neighbor.id}`,
      records: [brief(neighbor), brief(list[i])], // [older, newer]
      evidence: [
        { note: 'replacement language on incoming record' },
        ...(shared.length ? shared.map((p) => ({ path: p })) : [{ note: 'shared subject via provenance' }]),
      ],
      proposedAction: 'review-supersession',
    })
  }

  // ── 4. Outdated (reuse verifyEvidenceHealth — all referenced files deleted) ──
  if (workspace) {
    for (const rec of list) {
      const health = verifyEvidenceHealth(rec, workspace)
      if (health.status !== 'broken') continue
      push(PROPOSAL_TYPES.OUTDATED, {
        why: 'all referenced evidence files are gone from the workspace',
        records: [brief(rec)],
        evidence: (health.missingPaths || []).map((p) => ({ path: p, state: 'missing' })),
        proposedAction: 'review-freshness',
      })
    }
  }

  // ── 5. Retirement candidates (reuse existing lifecycle-freshness flags) ──
  for (const rec of list) {
    if (rec.status !== STATUSES.CURRENT) continue // non-current records are already retired
    if (rec.validation !== VALIDATIONS.STALE && rec.validation !== VALIDATIONS.INVALID) continue
    push(PROPOSAL_TYPES.RETIREMENT, {
      why: `current record flagged validation=${rec.validation} by existing lifecycle freshness`,
      records: [brief(rec)],
      evidence: [{ note: `validation=${rec.validation}`, authority: rec.authority || null }],
      proposedAction: 'review-retirement',
    })
  }

  const truncated = Object.keys(shown).some((k) => counts[k] > shown[k])
  return { candidates, counts, truncated }
}
