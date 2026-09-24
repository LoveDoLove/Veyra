/**
 * Veyra — derived Engineering Graph projection.
 *
 * Not a store. Nodes are memory rows; edges are stored relations.
 * See docs/architecture-graph.md.
 */

import { isRecallEligible, RELATIONS, SCOPES, VALID_RELATIONS } from './types.mjs'

export const GRAPH_LIMITS = Object.freeze({
  hops: 1,
  maxHops: 2,
  maxNodes: 40,
  maxEdges: 80,
  maxAgentExtra: 4,
  listLimit: 200,
})

export function projectNode(record) {
  if (!record) return null
  return {
    id: record.id,
    title: record.title || '',
    kind: record.kind,
    status: record.status,
    validation: record.validation,
    authority: record.authority,
    confidence: record.confidence,
    scope: record.scope,
    projectId: record.projectId || '',
    forgotten: Boolean(record.forgotten),
    evidenceCount: Array.isArray(record.evidence) ? record.evidence.length : 0,
    trusted: isRecallEligible(record),
  }
}

export function projectEdge(fromId, type, targetId) {
  return {
    id: `${fromId}:${type}:${targetId}`,
    fromId,
    type,
    targetId,
  }
}

function inIsolation(record, projectId) {
  if (!record) return false
  if (record.scope === SCOPES.REUSABLE) return record.projectId !== projectId
  if (projectId && record.projectId && record.projectId !== projectId) return false
  return true
}

// ponytail: O(n) list() scan; add an edge index if a project exceeds ~200 records.
function loadPool(projectStore, reusableStore) {
  const map = new Map()
  const add = (rec) => {
    if (rec?.id && !map.has(rec.id)) map.set(rec.id, rec)
  }
  for (const rec of projectStore?.list?.({ limit: GRAPH_LIMITS.listLimit, includeForgotten: true }) || []) add(rec)
  for (const rec of reusableStore?.list?.({ limit: GRAPH_LIMITS.listLimit, includeForgotten: true }) || []) add(rec)
  return map
}

function resolveRecord(id, pool, projectStore, reusableStore) {
  if (!id) return null
  if (pool.has(id)) return pool.get(id)
  const rec = projectStore?.get?.(id) || reusableStore?.get?.(id) || null
  if (rec) pool.set(id, rec)
  return rec
}

function incomingIndex(pool) {
  const incoming = new Map()
  for (const rec of pool.values()) {
    for (const rel of rec.relations || []) {
      if (!rel?.targetId || !VALID_RELATIONS.includes(rel.type)) continue
      const list = incoming.get(rel.targetId) || []
      list.push({ fromId: rec.id, type: rel.type })
      incoming.set(rel.targetId, list)
    }
  }
  return incoming
}

function clampHops(hops) {
  const n = Number(hops)
  if (!Number.isFinite(n)) return GRAPH_LIMITS.hops
  return Math.max(0, Math.min(Math.trunc(n), GRAPH_LIMITS.maxHops))
}

/**
 * Local neighborhood around one record. Inspection is not recall:
 * untrusted nodes stay visible unless trustedOnly is set.
 */
export function localGraph({
  projectStore,
  reusableStore = null,
  id,
  hops = GRAPH_LIMITS.hops,
  trustedOnly = false,
} = {}) {
  const empty = { center: null, nodes: [], edges: [], unresolved: [] }
  if (!id) return empty

  const projectId = projectStore?.projectId
  const pool = loadPool(projectStore, reusableStore)
  const centerRec = resolveRecord(id, pool, projectStore, reusableStore)
  if (!centerRec || !inIsolation(centerRec, projectId)) return empty

  const incoming = incomingIndex(pool)
  const nodeMap = new Map([[centerRec.id, projectNode(centerRec)]])
  const edgeMap = new Map()
  const unresolved = []
  const seenUnresolved = new Set()
  const depthLimit = clampHops(hops)
  const frontier = [{ id: centerRec.id, depth: 0 }]

  const consider = (fromId, type, targetId, depth) => {
    if (!VALID_RELATIONS.includes(type)) return
    const edgeId = `${fromId}:${type}:${targetId}`
    if (edgeMap.has(edgeId) || edgeMap.size >= GRAPH_LIMITS.maxEdges) return

    const fromRec = resolveRecord(fromId, pool, projectStore, reusableStore)
    const toRec = resolveRecord(targetId, pool, projectStore, reusableStore)
    if (!fromRec || !toRec) {
      if (!seenUnresolved.has(edgeId)) {
        seenUnresolved.add(edgeId)
        unresolved.push(projectEdge(fromId, type, targetId))
      }
      return
    }
    if (!inIsolation(fromRec, projectId) || !inIsolation(toRec, projectId)) return

    for (const rec of [fromRec, toRec]) {
      if (nodeMap.has(rec.id)) continue
      if (trustedOnly && rec.id !== centerRec.id && !isRecallEligible(rec)) return
      if (nodeMap.size >= GRAPH_LIMITS.maxNodes) return
      nodeMap.set(rec.id, projectNode(rec))
      if (depth + 1 < depthLimit) frontier.push({ id: rec.id, depth: depth + 1 })
    }
    edgeMap.set(edgeId, projectEdge(fromId, type, targetId))
  }

  while (frontier.length) {
    const { id: currentId, depth } = frontier.shift()
    if (depth >= depthLimit) continue
    const rec = resolveRecord(currentId, pool, projectStore, reusableStore)
    if (!rec) continue
    for (const rel of rec.relations || []) {
      if (!rel?.targetId) continue
      consider(rec.id, rel.type, rel.targetId, depth)
    }
    for (const inc of incoming.get(currentId) || []) {
      consider(inc.fromId, inc.type, currentId, depth)
    }
  }

  const nodes = [...nodeMap.values()].sort((a, b) => a.id.localeCompare(b.id))
  const edges = [...edgeMap.values()].sort((a, b) => a.id.localeCompare(b.id))
  unresolved.sort((a, b) => a.id.localeCompare(b.id))
  return { center: projectNode(centerRec), nodes, edges, unresolved }
}

/**
 * 1-hop recall-eligible neighbors of an already-retrieved hit set.
 * Skips `contradicts` — that path stays dedicated in hybridRetrieve.
 */
export function expandEligibleNeighbors({
  projectStore,
  reusableStore = null,
  records = [],
  maxExtra = GRAPH_LIMITS.maxAgentExtra,
  includeReusable = true,
} = {}) {
  const cap = Math.max(0, Math.min(Number(maxExtra) || 0, GRAPH_LIMITS.maxAgentExtra))
  if (!records.length || cap === 0) return []

  const projectId = projectStore?.projectId
  const seedIds = new Set(records.map((r) => r.id).filter(Boolean))
  const seen = new Set(seedIds)
  const extras = []

  const take = (rec, via) => {
    if (!rec || seen.has(rec.id) || !isRecallEligible(rec) || !inIsolation(rec, projectId)) return
    if (rec.scope === SCOPES.REUSABLE && !includeReusable) return
    seen.add(rec.id)
    extras.push({ ...rec, via })
  }

  const resolve = (targetId) => {
    const fromProject = projectStore?.get?.(targetId)
    if (fromProject) return fromProject
    if (!includeReusable) return null
    return reusableStore?.get?.(targetId) || null
  }

  for (const rec of records) {
    if (extras.length >= cap) break
    for (const rel of rec.relations || []) {
      if (extras.length >= cap) break
      if (!rel?.targetId || rel.type === RELATIONS.CONTRADICTS) continue
      if (!VALID_RELATIONS.includes(rel.type) || seen.has(rel.targetId)) continue
      take(resolve(rel.targetId), { fromId: rec.id, type: rel.type })
    }
  }

  if (extras.length >= cap) return extras

  const pool = [
    ...(projectStore?.list?.({ limit: GRAPH_LIMITS.listLimit }) || []),
    ...((includeReusable && reusableStore) ? reusableStore.list({ limit: GRAPH_LIMITS.listLimit }) : []),
  ]
  for (const peer of pool) {
    if (extras.length >= cap) break
    if (!peer || seen.has(peer.id)) continue
    for (const rel of peer.relations || []) {
      if (!rel?.targetId || rel.type === RELATIONS.CONTRADICTS) continue
      if (!VALID_RELATIONS.includes(rel.type) || !seedIds.has(rel.targetId)) continue
      take(peer, { fromId: rel.targetId, type: rel.type })
      break
    }
  }

  return extras
}
