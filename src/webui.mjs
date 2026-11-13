/**
 * Veyra — Network Graph WebUI.
 *
 * Host-native Observatory surface. Not a store, not a second identity.
 * GET /veyra        HTML (vanilla SVG)
 * GET /veyra/graph  localGraph JSON with ?id, bounded overview JSON without
 * GET /veyra/record compact record JSON
 * GET /veyra/search hybrid search JSON
 */

import { resolve } from 'node:path'
import { GRAPH_LIMITS, localGraph, overviewGraph } from './graph.mjs'
import { observatoryRecord, observatorySearch } from './observatory.mjs'
import { MEMORY_OPERATIONS } from './memory-router.mjs'
import { isRecallEligible } from './types.mjs'

export const WEBUI_PATH = '/veyra'

export function classifyNode(node, centerId) {
  if (!node) return null
  const historical = Boolean(node.forgotten) || (node.status && node.status !== 'current')
  return {
    selected: node.id === centerId,
    trusted: Boolean(node.trusted),
    inspectOnly: !node.trusted,
    historical,
    forgotten: Boolean(node.forgotten),
    kind: node.kind,
    authority: node.authority,
    validation: node.validation,
    status: node.status,
  }
}

export function clampUiHops(hops) {
  if (hops == null || hops === '') return GRAPH_LIMITS.hops
  const n = Number(hops)
  if (!Number.isFinite(n)) return GRAPH_LIMITS.hops
  return Math.max(0, Math.min(Math.trunc(n), GRAPH_LIMITS.maxHops))
}

export const WORKSPACE_CONTEXT_UNAVAILABLE = 'WORKSPACE_CONTEXT_UNAVAILABLE'

export function workspaceUnavailable(message = 'Workspace context unavailable. Open the Network Graph from an active workspace session.') {
  return {
    ok: false,
    error: message,
    code: WORKSPACE_CONTEXT_UNAVAILABLE,
    view: 'unavailable',
    center: null,
    nodes: [],
    edges: [],
    unresolved: [],
  }
}

export function cwdFromRequest(req, runtime, { allowFallback = false } = {}) {
  const url = new URL(req.url || '/', 'http://127.0.0.1')
  const raw = url.searchParams.get('cwd')
  if (typeof raw === 'string' && raw.trim()) return resolve(raw.trim())
  // Task 36: never silently use plugin startup cwd for workspace-scoped graph
  // data when authoritative workspace context should be provided by the client.
  // fallback is retained only for explicit legacy/internal callers that opt in.
  if (allowFallback) return runtime?.fallbackCwd || process.cwd()
  return null
}

function openStores(runtime, cwd) {
  // The graph is a projection of one workspace's room plus Central Memories.
  // Without a room there is nothing to project, so refuse rather than open a
  // path-keyed store the clean-break architecture never writes again.
  const server = runtime.memoryServer
  if (!server) {
    const err = new Error('Veyra memory unavailable: memory-server-unavailable')
    err.code = 'VEYRA_WORKSPACE_UNAVAILABLE'
    throw err
  }
  const stores = server.storesForPath(cwd, MEMORY_OPERATIONS.RECALL_MANUAL)
  if (!stores.ok) {
    const err = new Error(`Veyra memory unavailable: ${stores.reason}`)
    err.code = 'VEYRA_WORKSPACE_UNAVAILABLE'
    throw err
  }
  return {
    cwd: stores.cwd,
    projectId: stores.projectId,
    projectStore: stores.projectStore,
    reusableStore: stores.reusableStore,
  }
}

export function buildGraphPayload({
  projectStore,
  reusableStore = null,
  id,
  hops = GRAPH_LIMITS.hops,
  trustedOnly = false,
  cwd = '',
  projectId = '',
} = {}) {
  const usedHops = clampUiHops(hops)
  const graph = localGraph({ projectStore, reusableStore, id, hops: usedHops, trustedOnly: Boolean(trustedOnly) })
  const centerId = graph.center?.id || id || null
  return {
    ok: Boolean(graph.center),
    view: 'local',
    hops: usedHops,
    maxHops: GRAPH_LIMITS.maxHops,
    limits: GRAPH_LIMITS,
    projectId: projectId || projectStore?.projectId || '',
    cwd,
    center: graph.center,
    nodes: graph.nodes.map((n) => ({ ...n, mark: classifyNode(n, centerId) })),
    edges: graph.edges,
    unresolved: graph.unresolved,
    error: graph.center ? null : (id ? 'Record not found' : 'Record id required'),
    note: 'Graph is a projection. Visible ≠ trusted. Connected ≠ recall-eligible.',
  }
}

/**
 * Landing view: bounded overview of every visible record in this workspace.
 * No id required, so the page always renders real Veyra nodes/edges (or an
 * honest empty state). Local Graph stays the view for any selected record.
 */
export function buildOverviewPayload({
  projectStore,
  reusableStore = null,
  cwd = '',
  projectId = '',
} = {}) {
  const graph = overviewGraph({ projectStore, reusableStore })
  return {
    ok: true,
    view: 'overview',
    limits: GRAPH_LIMITS,
    projectId: projectId || projectStore?.projectId || '',
    cwd,
    center: null,
    nodes: graph.nodes.map((n) => ({ ...n, mark: classifyNode(n, null) })),
    edges: graph.edges,
    unresolved: graph.unresolved,
    empty: graph.nodes.length === 0,
    error: null,
    note: 'Overview is a bounded projection of this workspace. Graph is a projection. Visible ≠ trusted. Connected ≠ recall-eligible.',
  }
}

function compactRecord(record) {
  if (!record) return null
  return {
    id: record.id,
    title: record.title,
    body: record.body,
    kind: record.kind,
    authority: record.authority,
    validation: record.validation,
    confidence: record.confidence,
    status: record.status,
    scope: record.scope,
    projectId: record.projectId || '',
    forgotten: Boolean(record.forgotten),
    trusted: isRecallEligible(record),
    tags: record.tags || [],
    evidence: record.evidence || [],
    relations: record.relations || [],
    source: record.source || null,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  }
}

export function buildRecordPayload({ projectStore, reusableStore = null, id } = {}) {
  const view = observatoryRecord({ projectStore, reusableStore, id })
  if (!view.ok) return { ok: false, error: view.error || 'not found', record: null }
  return {
    ok: true,
    record: compactRecord(view.data.record),
    incoming: view.data.incomingRelations,
    contradictions: view.data.contradictions,
    causal: view.data.causal,
    mark: classifyNode(compactRecord(view.data.record), id),
  }
}

export function buildSearchPayload({
  projectStore,
  reusableStore = null,
  query = '',
  limit = 8,
} = {}) {
  const view = observatorySearch({ projectStore, reusableStore, query, limit })
  return {
    ok: true,
    query,
    hits: (view.hits || []).map((r) => ({
      id: r.id,
      title: r.title,
      kind: r.kind,
      authority: r.authority,
      validation: r.validation,
      status: r.status,
      trusted: isRecallEligible(r),
      scores: r.scores || null,
    })),
  }
}

/**
 * Workspace switcher feed. Metadata only: no room store is opened and no
 * record is read, so listing workspaces cannot leak one workspace's memory
 * into another. The DSH workspace registry is the only authority for what
 * exists; when it is absent or broken this reports `null` rather than an
 * empty list, because "no workspaces" and "cannot ask" are different facts.
 */
export function buildWorkspacesPayload({ resolver } = {}) {
  const state = typeof resolver?.state === 'function' ? resolver.state() : null
  const listed = typeof resolver?.list === 'function' ? resolver.list() : null
  const workspaces = Array.isArray(listed)
    ? listed.map((workspace) => ({
      id: typeof workspace?.id === 'string' ? workspace.id : '',
      title: typeof workspace?.title === 'string' ? workspace.title : '',
      path: typeof workspace?.path === 'string' ? workspace.path : '',
    })).filter((workspace) => workspace.id && workspace.path)
    : null
  return {
    ok: workspaces !== null,
    registryState: state,
    workspaces: workspaces || [],
    error: workspaces === null ? 'workspace registry unavailable' : null,
  }
}

function send(res, status, type, body) {
  res.writeHead(status, {
    'content-type': type,
    'cache-control': 'no-store',
  })
  res.end(body)
}

function sendJson(res, status, obj) {
  send(res, status, 'application/json; charset=utf-8', JSON.stringify(obj))
}

export function handleVeyraHttp(runtime, req, res) {
  try {
    if ((req.method || 'GET').toUpperCase() !== 'GET') {
      sendJson(res, 405, { ok: false, error: 'GET only' })
      return
    }
    const url = new URL(req.url || WEBUI_PATH, 'http://127.0.0.1')
    const path = url.pathname.replace(/\/+$/, '') || WEBUI_PATH
    if (path === WEBUI_PATH) {
      send(res, 200, 'text/html; charset=utf-8', graphPage())
      return
    }

    // Read-only workspace discovery for the in-page switcher. Deliberately
    // before the cwd gate: a page opened without authoritative context must
    // still be able to list workspaces, and this path reads registry metadata
    // only — never a room store, so it cannot leak record data.
    if (path === `${WEBUI_PATH}/workspaces`) {
      const server = runtime?.memoryServer
      sendJson(res, 200, buildWorkspacesPayload({ resolver: server?.resolver }))
      return
    }

    // Task 36: sessionId is never used for workspace/data selection. Authoritative
    // workspace context must be provided explicitly as cwd by the client (resolved
    // from DSH workspaces API). Missing cwd fails closed — never fallback to
    // runtime.fallbackCwd/process startup cwd for graph data.
    const cwd = cwdFromRequest(req, runtime)
    if (!cwd) {
      sendJson(res, 409, workspaceUnavailable())
      return
    }
    let stores
    try {
      stores = openStores(runtime, cwd)
    } catch {
      sendJson(res, 409, workspaceUnavailable())
      return
    }
    const { projectStore, reusableStore, projectId } = stores
    const id = (url.searchParams.get('id') || '').trim()
    const hops = clampUiHops(url.searchParams.get('hops'))
    const trustedOnly = url.searchParams.get('trustedOnly') === '1'

    if (path === `${WEBUI_PATH}/graph`) {
      if (!id) {
        // No id → bounded workspace overview (real nodes, no hardcoded data).
        sendJson(res, 200, buildOverviewPayload({ projectStore, reusableStore, cwd, projectId }))
        return
      }
      const payload = buildGraphPayload({
        projectStore, reusableStore, id, hops, trustedOnly, cwd, projectId,
      })
      sendJson(res, payload.ok ? 200 : 404, payload)
      return
    }
    if (path === `${WEBUI_PATH}/record`) {
      const payload = buildRecordPayload({ projectStore, reusableStore, id })
      sendJson(res, payload.ok ? 200 : 404, payload)
      return
    }
    if (path === `${WEBUI_PATH}/search`) {
      const query = (url.searchParams.get('q') || url.searchParams.get('query') || '').trim()
      sendJson(res, 200, buildSearchPayload({ projectStore, reusableStore, query }))
      return
    }
    sendJson(res, 404, { ok: false, error: 'not found' })
  } catch (err) {
    sendJson(res, 400, { ok: false, error: err instanceof Error ? err.message : String(err) })
  }
}

export function registerWebUi(ctx, runtime) {
  const registerOn = (scope) => {
    // A service provided by a SIBLING fiber (the DSH profile mounts webServer and
    // third-party plugins as siblings) is reachable through ctx.get(), but a direct
    // property read needs `inject`, which this plugin does not declare. Read it the
    // same way the availability probe above does, and keep the property path for
    // plain-object scopes (tests).
    const server = typeof scope?.get === 'function' ? scope.get('webServer') : scope?.webServer
    if (!server || typeof server.register !== 'function') return false
    const handler = (req, res) => handleVeyraHttp(runtime, req, res)
    const add = () => server.register({ kind: 'prefix', path: WEBUI_PATH, handler })
    if (typeof scope.effect === 'function') scope.effect(add)
    else add()
    return true
  }

  if (typeof ctx?.inject === 'function' && typeof ctx.get === 'function' && ctx.get('webServer') === undefined) {
    try {
      ctx.inject(['webServer'], (scope) => {
        registerOn(scope)
      })
      return true
    } catch {
      return registerOn(ctx)
    }
  }
  return registerOn(ctx)
}

export function graphPage() {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="dark">
<title>Veyra Network Graph</title>
<style>*,*::before,*::after{box-sizing:border-box}
:root{
  --bg:#000003;--bg2:#0b0b10;--ink:#edeef0;--ink2:rgba(176,180,186,.8);--dim:rgba(140,146,156,.55);
  --line:rgba(255,255,255,.08);--glass:rgba(17,17,19,.72);
  --canonical:#ffc53d;--derived:#3de1f0;--candidate:#9b8cff;--ok:#3ddc97;--bad:#ff7a8a;
  --ease:cubic-bezier(.4,0,.2,1)
}
html,body{margin:0;height:100%;overflow:hidden;background:var(--bg);color:var(--ink);
  font:400 13px/20px ui-sans-serif,system-ui,-apple-system,"Segoe UI",Inter,sans-serif;
  -webkit-font-smoothing:antialiased;text-rendering:optimizeLegibility}
button{font:inherit;color:inherit;background:none;border:0;padding:0;cursor:pointer}
kbd{font:600 10px/1 ui-monospace,SFMono-Regular,Menlo,monospace;padding:3px 5px;border-radius:5px;
  border:1px solid var(--line);background:rgba(255,255,255,.04);color:var(--ink2)}
#scene{position:fixed;inset:0;width:100%;height:100%;display:block;cursor:grab;touch-action:none}
#scene.dragging{cursor:grabbing}
#veil{position:fixed;inset:0;pointer-events:none;z-index:1;
  background:radial-gradient(130% 95% at 50% 44%,rgba(0,0,0,0) 30%,rgba(0,0,0,.42) 74%,rgba(0,0,0,.8) 100%)}
.glass{background:var(--glass);backdrop-filter:blur(16px) saturate(1.4);-webkit-backdrop-filter:blur(16px) saturate(1.4);
  border:1px solid var(--line);border-radius:12px;
  box-shadow:0 8px 32px rgba(0,0,0,.55),inset 0 1px 0 rgba(255,255,255,.06)}
#hud{position:fixed;top:16px;left:16px;right:16px;z-index:6;display:flex;gap:10px;align-items:flex-start;pointer-events:none}
#hud>*{pointer-events:auto}
#wsChip{display:flex;align-items:center;gap:10px;height:44px;padding:0 12px;max-width:400px;
  transition:border-color 150ms var(--ease),background 150ms var(--ease)}
#wsChip:hover{border-color:rgba(255,255,255,.18);background:rgba(23,23,26,.82)}
#wsChip .dot{flex:none;width:8px;height:8px;border-radius:50%;background:var(--derived);box-shadow:0 0 12px currentColor}
#wsChip .dot.canonical{background:var(--canonical);color:var(--canonical)}
#wsChip .dot.derived{background:var(--derived);color:var(--derived)}
#wsChip .dot.candidate{background:var(--candidate);color:var(--candidate)}
#wsChip .dot.none{background:var(--dim);box-shadow:none}
#wsChip .txt{min-width:0;display:flex;flex-direction:column;gap:1px}
#wsChip .nm{font:600 13px/16px inherit;letter-spacing:.005em;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:200px}
#wsChip .pt{font:500 10.5px/13px ui-monospace,SFMono-Regular,Menlo,monospace;color:var(--dim);
  white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:240px}
#wsChip .cv{flex:none;color:var(--dim);font-size:9px;margin-left:2px}
#omni{flex:1;max-width:460px;height:44px;display:flex;align-items:center;gap:9px;padding:0 12px;cursor:text;
  transition:border-color 150ms var(--ease)}
#omni:hover{border-color:rgba(255,255,255,.16)}
#omni svg{flex:none;width:13px;height:13px;opacity:.6}
#omni .ph{flex:1;font:500 12.5px/16px inherit;color:var(--dim);white-space:nowrap;overflow:hidden}
#stat{display:flex;height:44px;align-items:stretch;margin-left:auto;overflow:hidden}
#stat .cell{padding:0 13px;display:flex;flex-direction:column;justify-content:center;gap:1px;border-left:1px solid rgba(255,255,255,.07)}
#stat .cell:first-child{border-left:0}
#stat b{font:600 13.5px/17px inherit;letter-spacing:-.01em;font-variant-numeric:tabular-nums}
#stat span{font:500 9px/11px inherit;letter-spacing:.1em;text-transform:uppercase;color:rgba(176,180,186,.55)}
#legend{position:fixed;left:16px;bottom:16px;z-index:6;padding:9px 12px;display:flex;flex-direction:column;gap:7px}
#legend .row{display:flex;align-items:center;gap:14px}
#legend .it{display:flex;align-items:center;gap:6px;font:500 11px/14px inherit;color:var(--ink2)}
#legend .sw{width:8px;height:8px;border-radius:50%;box-shadow:0 0 8px currentColor}
#legend .sw.canonical{background:var(--canonical);color:var(--canonical);border-radius:2px;transform:rotate(45deg)}
#legend .sw.derived{background:var(--derived);color:var(--derived)}
#legend .sw.candidate{background:var(--candidate);color:var(--candidate)}
#legend .honest{font:500 10px/14px inherit;letter-spacing:.01em;color:rgba(140,146,156,.6)}
#tools{position:fixed;right:16px;bottom:16px;z-index:6;display:flex;gap:8px}
#tools button{width:38px;height:38px;display:grid;place-items:center;border-radius:11px;color:var(--ink2);
  background:var(--glass);backdrop-filter:blur(16px) saturate(1.4);-webkit-backdrop-filter:blur(16px) saturate(1.4);
  border:1px solid var(--line);box-shadow:0 8px 32px rgba(0,0,0,.5);transition:color 150ms var(--ease),border-color 150ms var(--ease),background 150ms var(--ease)}
#tools button:hover{color:var(--ink);border-color:rgba(255,255,255,.2);background:rgba(28,28,32,.85)}
#tools button[aria-pressed="true"]{color:#0b0b10;background:rgba(61,225,240,.9);border-color:transparent}
#tools button.wide{width:auto;padding:0 11px;font:600 11px/1 inherit;letter-spacing:.02em}
#tools svg{width:15px;height:15px}
#insp{position:fixed;top:16px;right:16px;bottom:16px;width:352px;z-index:7;display:flex;flex-direction:column;
  transform:translateX(calc(100% + 24px));opacity:0;transition:transform 220ms var(--ease),opacity 220ms var(--ease);
  background:rgba(13,13,16,.88);backdrop-filter:blur(28px) saturate(1.3);-webkit-backdrop-filter:blur(28px) saturate(1.3);
  border:1px solid var(--line);border-radius:14px;box-shadow:0 16px 60px rgba(0,0,0,.7),inset 0 1px 0 rgba(255,255,255,.05)}
#insp.show{transform:none;opacity:1}
#insp .hd{padding:16px 16px 10px;display:flex;gap:10px;align-items:flex-start}
#insp .hd h2{margin:0;font:600 15px/21px inherit;letter-spacing:-.005em;flex:1;word-break:break-word}
#insp .x{flex:none;width:24px;height:24px;border-radius:7px;display:grid;place-items:center;color:var(--dim);font-size:13px}
#insp .x:hover{background:rgba(255,255,255,.07);color:var(--ink)}
#insp .chips{padding:0 16px 12px;display:flex;flex-wrap:wrap;gap:5px}
.chip{font:600 10px/1 inherit;letter-spacing:.04em;text-transform:uppercase;padding:4px 7px;border-radius:6px;
  border:1px solid rgba(255,255,255,.1);color:var(--ink2);background:rgba(255,255,255,.03)}
.chip.canonical{color:#1a1405;background:var(--canonical);border-color:transparent}
.chip.derived{color:#02181b;background:var(--derived);border-color:transparent}
.chip.candidate{color:#0b0820;background:var(--candidate);border-color:transparent}
.chip.ok{color:#02150e;background:var(--ok);border-color:transparent}
.chip.warn{color:#1a060a;background:var(--bad);border-color:transparent}
#insp .body{flex:1;overflow:auto;padding:0 16px 16px;overscroll-behavior:contain}
#insp .body::-webkit-scrollbar{width:8px}
#insp .body::-webkit-scrollbar-thumb{background:rgba(255,255,255,.12);border-radius:8px}
#insp .kv{display:grid;grid-template-columns:auto 1fr;gap:6px 12px;margin:0 0 14px;font:500 11.5px/16px inherit}
#insp .kv dt{color:var(--dim);letter-spacing:.02em}
#insp .kv dd{margin:0;color:var(--ink2);font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:10.5px;
  word-break:break-all}
#insp .prose{margin:0 0 14px;font:400 12.5px/20px inherit;color:rgba(224,228,236,.9);white-space:pre-wrap;word-break:break-word}
#insp h3{margin:16px 0 8px;font:600 9.5px/12px inherit;letter-spacing:.14em;text-transform:uppercase;color:var(--dim)}
#insp .warn{margin:0 0 14px;padding:9px 11px;border-radius:9px;font:500 11.5px/17px inherit;color:#ffd7dc;
  background:rgba(255,122,138,.09);border:1px solid rgba(255,122,138,.28)}
#insp ul{margin:0;padding:0;list-style:none;display:flex;flex-direction:column;gap:5px}
#insp li{font:500 11px/16px ui-monospace,SFMono-Regular,Menlo,monospace;color:var(--ink2);
  padding:6px 8px;border-radius:7px;background:rgba(255,255,255,.03);word-break:break-all}
#insp .ft{padding:12px 16px;border-top:1px solid rgba(255,255,255,.07);display:flex;gap:8px}
#insp .ft button{flex:1;height:32px;border-radius:8px;font:600 11.5px/1 inherit;letter-spacing:.02em;
  border:1px solid var(--line);color:var(--ink2);transition:all 150ms var(--ease)}
#insp .ft button:hover{color:var(--ink);border-color:rgba(255,255,255,.22);background:rgba(255,255,255,.05)}
#insp .ft button.pri{background:rgba(61,225,240,.14);border-color:rgba(61,225,240,.4);color:#b8f6ff}
#insp .ft button.pri:hover{background:rgba(61,225,240,.22)}
#pal{position:fixed;inset:0;z-index:9;display:none;place-items:start center;padding-top:14vh;
  background:rgba(0,0,3,.62);backdrop-filter:blur(6px);-webkit-backdrop-filter:blur(6px)}
#pal.show{display:grid}
#palBox{width:min(620px,92vw);max-height:64vh;display:flex;flex-direction:column;overflow:hidden;
  background:rgba(15,15,18,.94);backdrop-filter:blur(32px) saturate(1.3);-webkit-backdrop-filter:blur(32px) saturate(1.3);
  border:1px solid rgba(255,255,255,.1);border-radius:14px;box-shadow:0 28px 90px rgba(0,0,0,.8),inset 0 1px 0 rgba(255,255,255,.06)}
#palTop{display:flex;align-items:center;gap:10px;padding:0 14px;height:50px;border-bottom:1px solid rgba(255,255,255,.07)}
#palTop svg{width:14px;height:14px;opacity:.55;flex:none}
#palIn{flex:1;background:none;border:0;outline:0;font:500 14px/20px inherit;color:var(--ink)}
#palIn::placeholder{color:rgba(140,146,156,.7)}
#palList{overflow:auto;padding:6px;display:flex;flex-direction:column;gap:1px}
#palList::-webkit-scrollbar{width:8px}
#palList::-webkit-scrollbar-thumb{background:rgba(255,255,255,.12);border-radius:8px}
#palList .grp{display:flex;align-items:center;gap:8px;padding:9px 8px 5px;font:600 9px/12px inherit;
  letter-spacing:.14em;text-transform:uppercase;color:rgba(140,146,156,.65)}
#palList .grp::after{content:"";flex:1;height:1px;background:rgba(255,255,255,.07)}
#palList .pi{display:flex;align-items:center;gap:10px;padding:8px 9px;border-radius:8px;cursor:pointer;text-align:left;width:100%}
#palList .pi[aria-selected="true"]{background:rgba(255,255,255,.08)}
#palList .pi .ic{flex:none;width:16px;height:16px;border-radius:5px;display:grid;place-items:center;
  font:600 9px/1 ui-monospace,monospace;color:#06070c}
#palList .pi .tt{flex:1;min-width:0;font:500 12.5px/17px inherit;color:var(--ink);
  white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
#palList .pi .mt{flex:none;font:500 10px/14px ui-monospace,SFMono-Regular,Menlo,monospace;color:var(--dim);
  max-width:180px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
#palList .pi .tag{flex:none;font:600 9px/1 inherit;letter-spacing:.06em;text-transform:uppercase;color:var(--dim);
  border:1px solid var(--line);padding:3px 5px;border-radius:5px}
#palList .empty{padding:22px 10px;text-align:center;font:500 12px/18px inherit;color:var(--dim)}
#palFt{display:flex;align-items:center;gap:12px;padding:0 14px;height:38px;border-top:1px solid rgba(255,255,255,.07);
  font:500 10px/14px inherit;color:var(--dim)}
#palFt .sp{flex:1}
#tip{position:fixed;z-index:8;pointer-events:none;max-width:320px;padding:8px 10px;border-radius:9px;
  background:rgba(10,10,13,.94);border:1px solid rgba(255,255,255,.12);box-shadow:0 10px 34px rgba(0,0,0,.7)}
#tip .t{font:600 12px/16px inherit;margin-bottom:3px;word-break:break-word}
#tip .m{font:500 10.5px/15px ui-monospace,SFMono-Regular,Menlo,monospace;color:var(--ink2)}
#loading{position:fixed;left:50%;top:50%;transform:translate(-50%,-50%);z-index:7;display:flex;align-items:center;gap:10px;
  padding:10px 16px;border-radius:11px;font:500 12px/16px inherit;color:var(--ink2)}
#loading[hidden]{display:none}
#loading .spin{width:13px;height:13px;border-radius:50%;border:1.5px solid rgba(255,255,255,.18);
  border-top-color:var(--derived);animation:spin .8s linear infinite}
@keyframes spin{to{transform:rotate(360deg)}}
#msg{position:fixed;inset:0;z-index:8;display:none;place-items:center;padding:24px;
  background:radial-gradient(90% 70% at 50% 50%,rgba(0,0,3,.55),rgba(0,0,3,.86))}
#msg.show{display:grid}
#msg .card{width:min(520px,94vw);padding:22px 24px 20px;background:rgba(13,13,16,.92);
  backdrop-filter:blur(24px);-webkit-backdrop-filter:blur(24px);border:1px solid var(--line);border-radius:16px;
  box-shadow:0 24px 80px rgba(0,0,0,.75)}
#msg h2{margin:0 0 8px;font:600 16px/22px inherit;letter-spacing:-.005em}
#msg p{margin:0 0 10px;font:500 12px/19px inherit;color:var(--ink2)}
#msg p.fine{font:500 10.5px/16px inherit;color:var(--dim)}
#msg .row{display:flex;flex-wrap:wrap;gap:7px;margin:14px 0 0}
#msg .row button{height:32px;padding:0 12px;border-radius:8px;font:600 11.5px/1 inherit;letter-spacing:.02em;
  border:1px solid var(--line);color:var(--ink2);transition:all 150ms var(--ease)}
#msg .row button:hover{color:var(--ink);border-color:rgba(255,255,255,.22);background:rgba(255,255,255,.05)}
#msg .row button.pri{background:rgba(61,225,240,.16);border-color:rgba(61,225,240,.42);color:#b8f6ff}
#toast{position:fixed;left:50%;bottom:76px;transform:translate(-50%,10px);z-index:8;padding:8px 14px;border-radius:10px;
  font:600 11.5px/16px inherit;color:var(--ink);background:rgba(20,20,24,.94);border:1px solid var(--line);
  box-shadow:0 12px 40px rgba(0,0,0,.7);opacity:0;pointer-events:none;transition:opacity 180ms var(--ease),transform 180ms var(--ease)}
#toast.show{opacity:1;transform:translate(-50%,0)}
#a11y{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}
@media (max-width:860px){
  #omni{display:none}#stat .cell:nth-child(n+3){display:none}
  #wsChip .pt{display:none}#insp{width:min(352px,92vw)}
  #legend .honest{display:none}
}
@media (prefers-reduced-motion:reduce){
  *{animation-duration:.01ms !important;transition-duration:.01ms !important}
}

/* ---- workspace switcher panel ---- */
#wsPanel{position:fixed;z-index:38;top:56px;left:16px;width:340px;max-height:min(60vh,440px);
  display:none;flex-direction:column;padding:6px;overflow:hidden;
  background:rgba(14,14,17,.86);backdrop-filter:blur(20px) saturate(1.5);-webkit-backdrop-filter:blur(20px) saturate(1.5);
  border:1px solid rgba(255,255,255,.09);border-radius:14px;
  box-shadow:0 16px 48px rgba(0,0,0,.65),inset 0 1px 0 rgba(255,255,255,.07);
  transform:translateY(-6px) scale(.985);opacity:0;transform-origin:top left;
  transition:opacity 140ms var(--ease),transform 140ms var(--ease)}
#wsPanel.show{display:flex;opacity:1;transform:none}
#wsPanel .phead{display:flex;align-items:center;justify-content:space-between;
  padding:6px 8px 8px;font-size:11px;font-weight:600;letter-spacing:.06em;text-transform:uppercase;color:var(--dim)}
#wsPanel .phead kbd{font:600 10px/1 ui-monospace,SFMono-Regular,Menlo,monospace;color:var(--dim);
  padding:3px 5px;border:1px solid var(--line);border-radius:4px;background:rgba(255,255,255,.03)}
#wsList{overflow:auto;overscroll-behavior:contain;display:flex;flex-direction:column;gap:2px;padding:0 2px 2px}
.wsi{display:grid;grid-template-columns:26px 1fr auto;align-items:center;gap:9px;width:100%;
  padding:7px 8px;border:0;border-radius:9px;background:transparent;color:inherit;
  text-align:left;cursor:pointer;font:inherit;transition:background 120ms var(--ease)}
.wsi:hover,.wsi:focus-visible{background:rgba(255,255,255,.055);outline:none}
.wsi.on{background:rgba(61,225,240,.10);box-shadow:inset 0 0 0 1px rgba(61,225,240,.22)}
.wsi .tile{width:26px;height:26px;border-radius:7px;display:grid;place-items:center;
  font-size:10px;font-weight:700;letter-spacing:.02em;color:#0a0c11;text-transform:uppercase}
.wsi .tile.canonical{background:linear-gradient(160deg,#ffd97a,#ffc53d)}
.wsi .tile.derived{background:linear-gradient(160deg,#7ceef8,#3de1f0)}
.wsi .tile.candidate{background:linear-gradient(160deg,#b9aaff,#9b8cff)}
.wsi .meta{min-width:0;display:flex;flex-direction:column;gap:1px}
.wsi .nm{font-size:13px;line-height:18px;font-weight:600;letter-spacing:.005em;color:#edeef0;
  white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.wsi .pt{font:500 10px/14px ui-monospace,SFMono-Regular,Menlo,monospace;color:rgba(140,146,156,.72);
  white-space:nowrap;overflow:hidden;text-overflow:ellipsis;direction:rtl;text-align:left}
.wsi .cur{font-size:9px;font-weight:700;letter-spacing:.07em;text-transform:uppercase;
  color:#3de1f0;padding:2px 5px;border-radius:4px;background:rgba(61,225,240,.13)}
#wsPanel .empty{padding:14px 10px;font-size:12px;line-height:17px;color:var(--dim);text-align:center}
#wsPanel .pfoot{padding:8px 8px 4px;margin-top:2px;border-top:1px solid rgba(255,255,255,.06);
  font-size:11px;line-height:15px;color:rgba(140,146,156,.62)}
@media (max-width:860px){#wsPanel{left:10px;right:10px;width:auto}}
</style>
</head>
<body>
<canvas id="scene" aria-label="3D network graph of Veyra records"></canvas>
<div id="veil"></div>

<div id="hud">
  <button type="button" id="wsChip" class="glass" aria-haspopup="dialog" aria-expanded="false" title="Switch workspace (Ctrl+O)">
    <span class="dot" id="wsDot"></span>
    <span class="txt"><span class="nm" id="wsName">Workspace</span><span class="pt" id="wsPath"></span></span>
    <span class="cv" aria-hidden="true">⌄</span>
  </button>
  <div id="omni" class="glass" role="button" tabindex="0" title="Search records and workspaces (Ctrl+K)">
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><circle cx="7" cy="7" r="4.6"/><path d="M10.5 10.5 14 14" stroke-linecap="round"/></svg>
    <span class="ph">Search records, or switch workspace…</span>
    <kbd id="omniKbd">Ctrl K</kbd>
  </div>
  <div id="stat" class="glass">
    <div class="cell"><b id="sNodes">0</b><span>nodes</span></div>
    <div class="cell"><b id="sEdges">0</b><span>edges</span></div>
    <div class="cell"><b id="sCanon">0</b><span>canonical</span></div>
    <div class="cell"><b id="sTrust">0</b><span>trusted</span></div>
  </div>
</div>

<div id="wsPanel" aria-hidden="true">
  <div class="phead"><span>Workspaces</span><kbd>Ctrl O</kbd></div>
  <div id="wsList" role="listbox" aria-label="Workspaces"></div>
  <div class="pfoot">Each workspace has its own memory. Switching re-reads this graph from that workspace's store.</div>
</div>

<div id="legend" class="glass">
  <div class="row">
    <span class="it"><span class="sw canonical"></span>canonical</span>
    <span class="it"><span class="sw derived"></span>derived</span>
    <span class="it"><span class="sw candidate"></span>candidate</span>
  </div>
  <div class="honest">Visible ≠ trusted · Connected ≠ recall-eligible</div>
</div>

<div id="tools">
  <button type="button" id="orbit" aria-pressed="true" title="Auto-orbit (O)"><svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><ellipse cx="8" cy="8" rx="6.6" ry="3"/><circle cx="8" cy="8" r="1.6" fill="currentColor" stroke="none"/></svg></button>
  <button type="button" id="labels" aria-pressed="true" title="Labels (L)"><svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M3 12.5 7 3.5M9 12.5 13 3.5M5 9h6" stroke-linecap="round"/></svg></button>
  <button type="button" id="overview" class="wide" title="Workspace overview (Esc)">overview</button>
  <button type="button" id="fitView" title="Reset camera (F)"><svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M2.5 6V3.5H5M11 3.5h2.5V6M13.5 10v2.5H11M5 12.5H2.5V10" stroke-linecap="round"/><circle cx="8" cy="8" r="1.5"/></svg></button>
</div>

<aside id="insp" aria-label="Record inspector">
  <div class="hd"><h2 id="insTitle"></h2><button type="button" class="x" id="insClose" title="Close (Esc)">✕</button></div>
  <div class="chips" id="insChips"></div>
  <div class="body" id="insBody"></div>
  <div class="ft"><button type="button" class="pri" id="btnCenter">Center graph</button><button type="button" id="btnCopy">Copy id</button></div>
</aside>

<div id="pal" role="dialog" aria-modal="true" aria-label="Command palette">
  <div id="palBox">
    <div id="palTop">
      <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><circle cx="7" cy="7" r="4.6"/><path d="M10.5 10.5 14 14" stroke-linecap="round"/></svg>
      <input id="palIn" type="text" spellcheck="false" autocomplete="off" placeholder="Search records, or type a workspace name…" aria-label="Search">
    </div>
    <div id="palList" role="listbox"></div>
    <div id="palFt"><span><kbd>↑</kbd> <kbd>↓</kbd> move</span><span><kbd>↵</kbd> open</span><span><kbd>esc</kbd> close</span><span class="sp"></span><span id="palHint"></span></div>
  </div>
</div>

<div id="tip" hidden><div class="t"></div><div class="m"></div></div>
<div id="loading" hidden><div class="spin"></div><span id="loadText">Loading graph…</span></div>
<div id="msg" role="alert"><div class="card"><h2 id="msgTitle"></h2><p id="msgBody"></p><p class="fine" id="msgFine"></p><div class="row" id="msgRow"></div></div></div>
<div id="toast" role="status"></div>
<div id="a11y" aria-live="polite"></div>
<script>
"use strict";
/* Veyra Network Graph — scene, HUD and switcher.
   One file, no dependencies. Reads only the documented /veyra JSON endpoints
   and treats every payload as a projection: visible is not trusted, and
   connected is not recall-eligible. */

var $ = function (id) { return document.getElementById(id); };
var params = new URLSearchParams(location.search);
var state = {
  cwd: params.get('cwd') || '',
  view: 'overview',
  graph: null,
  selected: null,
  rec: null,
  workspaces: [],
  registryState: null,
  lastLoad: null,
  loading: false,
  orbit: true,
  labels: true,
  paletteOpen: false,
  items: [],
  index: 0,
  query: '',
  seq: 0,
  hits: []
};

var AUTH_COLOR = { canonical: '#ffc53d', derived: '#3de1f0', candidate: '#9b8cff' };
var AUTH_ORDER = ['canonical', 'derived', 'candidate'];
var VAL_MARK = { verified: '✓', reviewed: '~', unverified: '?', stale: '⌛', invalid: '✕' };
var EDGE_TYPES = { contradicts: '#ff7a8a', extends: '#3de1f0', supports: '#3ddc97', supersedes: '#ffc53d' };

var reduced = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

/* ---------------------------------------------------------------- transport */

function api(path, extra) {
  var q = new URLSearchParams();
  q.set('cwd', state.cwd);
  if (extra) Object.keys(extra).forEach(function (k) {
    if (extra[k] !== undefined && extra[k] !== null && extra[k] !== '') q.set(k, extra[k]);
  });
  var seq = ++state.seq;
  return fetch('/veyra' + path + '?' + q.toString(), { headers: { accept: 'application/json' } })
    .then(function (r) { return r.json().catch(function () { return { ok: false, error: 'bad response (' + r.status + ')' }; }); })
    .then(function (body) { body.__seq = seq; return body; });
}

function errText(body) {
  if (!body) return 'Request failed.';
  if (body.code === 'WORKSPACE_CONTEXT_UNAVAILABLE') return 'WORKSPACE_CONTEXT_UNAVAILABLE';
  return String(body.error || body.reason || 'Request failed.');
}

/* ------------------------------------------------------------------- chrome */

function say(text) { $('a11y').textContent = text; }

function toast(text) {
  var el = $('toast');
  el.textContent = text;
  el.classList.add('show');
  clearTimeout(toast._t);
  toast._t = setTimeout(function () { el.classList.remove('show'); }, 2400);
}

function setLoading(on, text) {
  state.loading = !!on;
  var el = $('loading');
  if (on) { if (text) $('loadText').textContent = text; el.hidden = false; }
  else el.hidden = true;
}

function hideMsg() { $('msg').classList.remove('show'); }

function showMsg(title, body, fine, actions) {
  $('msgTitle').textContent = title;
  $('msgBody').textContent = body || '';
  $('msgFine').textContent = fine || '';
  var row = $('msgRow');
  row.textContent = '';
  (actions || []).forEach(function (a) {
    var b = document.createElement('button');
    b.type = 'button';
    b.textContent = a.label;
    if (a.primary) b.className = 'pri';
    b.onclick = a.run;
    row.appendChild(b);
  });
  $('msg').classList.add('show');
}

function showUnavailable() {
  stop();
  clearScene();
  setLoading(false);
  showMsg(
    'Workspace context unavailable',
    'This page needs an authoritative workspace. ' + 'WORKSPACE_CONTEXT_UNAVAILABLE',
    'Veyra never falls back to the plugin startup directory and never uses sessionId as workspace proof.',
    [{ label: 'Retry', primary: true, run: function () { hideMsg(); loadOverview(); } }]
  );
  $('omni').classList.remove('on');
}

function showError(text) {
  setLoading(false);
  showMsg('Could not load the graph', text, 'Nothing was changed. The graph is a read-only projection.', [
    { label: 'Retry', primary: true, run: function () { hideMsg(); reload(); } }
  ]);
}

/* --------------------------------------------------------------- workspace */

function hueOf(id) {
  var h = 0;
  for (var i = 0; i < (id || '').length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  return AUTH_ORDER[h % 3];
}

function wsFor(cwd) {
  var p = String(cwd || '').replace(/\\/+$/, '');
  for (var i = 0; i < state.workspaces.length; i++) {
    if (String(state.workspaces[i].path).replace(/\\/+$/, '') === p) return state.workspaces[i];
  }
  return null;
}

function paintChip() {
  var ws = wsFor(state.cwd);
  var name = ws && ws.title ? ws.title : (state.cwd ? state.cwd.split('/').filter(Boolean).pop() : 'No workspace');
  $('wsName').textContent = name;
  $('wsPath').textContent = state.cwd || 'no cwd context';
  var dot = $('wsDot');
  dot.className = 'dot ' + (ws ? hueOf(ws.id) : 'none');
  document.title = 'Veyra Network Graph · ' + name;
}

function loadWorkspaces() {
  return fetch('/veyra/workspaces', { headers: { accept: 'application/json' } })
    .then(function (r) { return r.json(); })
    .then(function (body) {
      state.registryState = body.registryState || null;
      state.workspaces = Array.isArray(body.workspaces) ? body.workspaces : [];
      paintChip();
      return state.workspaces;
    })
    .catch(function () { state.workspaces = []; paintChip(); });
}

function switchWorkspace(ws) {
  if (!ws || !ws.path) return;
  if (ws.path === state.cwd) { closePalette(); return; }
  state.cwd = ws.path;
  state.selected = null;
  state.rec = null;
  closeInspector();
  paintChip();
  hideMsg();
  closePalette();
  loadOverview();
  toast('Switched to ' + (ws.title || ws.path));
}

/* ----------------------------------------------------------------- canvas */

var cv = $('scene');
var ctx = cv.getContext('2d');
var W = 0, H = 0, DPR = 1;
var cam = { yaw: 0.52, pitch: -0.30, dist: 900, focal: 900, spin: 0 };
var drag = { on: false, x: 0, y: 0, moved: 0 };
var hover = null;
var raf = 0, last = 0, idle = 0;
var nodes = [], byId = new Map(), edges = [], stars = [], rings = [];

function resize() {
  DPR = Math.min(window.devicePixelRatio || 1, 2);
  W = cv.clientWidth || window.innerWidth;
  H = cv.clientHeight || window.innerHeight;
  cv.width = Math.round(W * DPR);
  cv.height = Math.round(H * DPR);
  ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
  seedStars();
}

function seedStars() {
  stars = [];
  var n = W < 700 ? 110 : 190;
  for (var i = 0; i < n; i++) {
    var th = Math.random() * Math.PI * 2;
    var ph = Math.acos(2 * Math.random() - 1);
    var r = 700 + Math.random() * 900;
    stars.push({
      x: r * Math.sin(ph) * Math.cos(th),
      y: r * Math.cos(ph),
      z: r * Math.sin(ph) * Math.sin(th),
      a: 0.12 + Math.random() * 0.45,
      s: 0.4 + Math.random() * 0.9
    });
  }
}

function project(p) {
  var cy = Math.cos(cam.yaw), sy = Math.sin(cam.yaw);
  var cp = Math.cos(cam.pitch), sp = Math.sin(cam.pitch);
  var x1 = p.x * cy - p.z * sy;
  var z1 = p.x * sy + p.z * cy;
  var y1 = p.y * cp - z1 * sp;
  var z2 = p.y * sp + z1 * cp;
  var depth = cam.dist + z2;
  if (depth < 60) return null;
  var f = cam.focal / depth;
  return { x: W / 2 + x1 * f, y: H / 2 + y1 * f, f: f, depth: depth, z: z2 };
}

/* ----------------------------------------------------------------- layout */

var SHELL = { canonical: 0, derived: 1, candidate: 2 };
var SHELL_R = [104, 232, 372];

function hopMap() {
  var map = new Map();
  var g = state.graph;
  if (!g || !g.center) return map;
  var adj = new Map();
  (g.edges || []).forEach(function (e) {
    if (!adj.has(e.fromId)) adj.set(e.fromId, []);
    if (!adj.has(e.targetId)) adj.set(e.targetId, []);
    adj.get(e.fromId).push(e.targetId);
    adj.get(e.targetId).push(e.fromId);
  });
  var start = g.center.id;
  map.set(start, 0);
  var q = [start];
  while (q.length) {
    var cur = q.shift();
    var d = map.get(cur);
    if (d >= 2) continue;
    (adj.get(cur) || []).forEach(function (nb) {
      if (!map.has(nb)) { map.set(nb, d + 1); q.push(nb); }
    });
  }
  return map;
}

function seedPositions() {
  var g = state.graph;
  if (!g) return;
  var local = state.view === 'local' && g.center;
  var hops = local ? hopMap() : null;
  var groups = { canonical: [], derived: [], candidate: [] };
  (g.nodes || []).forEach(function (n) {
    var a = AUTH_COLOR[n.authority] ? n.authority : 'candidate';
    groups[a].push(n);
  });

  nodes = [];
  groups.canonical.concat(groups.derived, groups.candidate);
  nodes = (g.nodes || []).map(function (n) {
    var a = AUTH_COLOR[n.authority] ? n.authority : 'candidate';
    return {
      id: n.id, title: n.title || n.id, kind: n.kind, authority: a,
      validation: n.validation, status: n.status, trusted: !!n.trusted,
      forgotten: !!n.forgotten, evidenceCount: n.evidenceCount || 0, mark: n.mark || null,
      isCenter: local && g.center && g.center.id === n.id,
      hop: hops && hops.has(n.id) ? hops.get(n.id) : 99,
      x: 0, y: 0, z: 0, tx: 0, ty: 0, tz: 0,
      vx: 0, vy: 0, vz: 0, r: 6, sx: 0, sy: 0, sf: 1, sd: 0, phase: Math.random() * 6.283
    };
  });
  byId = new Map();
  nodes.forEach(function (n) { byId.set(n.id, n); });

  if (local) {
    var ringR = [0, 168, 296];
    var counts = {};
    var centerNode = byId.get(g.center.id);
    if (centerNode) { centerNode.tx = 0; centerNode.ty = 0; centerNode.tz = 0; }
    nodes.forEach(function (n) {
      if (n.isCenter) return;
      var h = Math.min(n.hop, 2);
      var k = counts[h] = (counts[h] || 0) + 1;
      var total = h === 1 ? 8 : 16;
      var ang = (k / total) * Math.PI * 2 + h * 0.6;
      var r = ringR[h];
      n.tx = Math.cos(ang) * r * (h === 1 ? 1 : 1.1);
      n.ty = (h - 1) * 58 + Math.sin(ang * 1.7) * 26;
      n.tz = Math.sin(ang) * r;
    });
  } else {
    AUTH_ORDER.forEach(function (a) {
      var list = groups[a];
      var tilt = a === 'canonical' ? 0 : a === 'derived' ? 0.36 : -0.30;
      var R = SHELL_R[SHELL[a]];
      var ct = Math.cos(tilt), st = Math.sin(tilt);
      list.forEach(function (n, i) {
        var node = byId.get(n.id);
        if (!node) return;
        var t = list.length === 1 ? 0.5 : i / list.length;
        var ph = Math.acos(1 - 2 * (t + 0.5 / Math.max(list.length, 1)));
        var th = 2.399963229728653 * i;
        var rr = R * (0.86 + 0.14 * ((i * 7 % 5) / 5));
        var x = rr * Math.sin(ph) * Math.cos(th);
        var y = rr * Math.cos(ph);
        var z = rr * Math.sin(ph) * Math.sin(th);
        node.tx = x;
        node.ty = y * 0.62 * ct - z * st * 0.62;
        node.tz = z * ct + y * 0.62 * st;
      });
    });
  }

  nodes.forEach(function (n) {
    if (state.view === 'local' && n.hop === 99) { n.tx = 0; n.ty = 0; n.tz = 0; }
    n.x = n.tx * 0.35 + (Math.random() - 0.5) * 60;
    n.y = n.ty * 0.35 + (Math.random() - 0.5) * 60;
    n.z = n.tz * 0.35 + (Math.random() - 0.5) * 60;
    var deg = 0;
    var base = 5.2 * Math.cbrt(1 + (n.evidenceCount || 0) * 1.1 + (n.isCenter ? 6 : 0));
    n.r = Math.max(3.4, Math.min(15, base));
    n.baseR = n.r;
  });

  edges = [];
  (g.edges || []).forEach(function (e) {
    var a = byId.get(e.fromId), b = byId.get(e.targetId);
    if (!a || !b || a === b) return;
    edges.push({ a: a, b: b, type: e.type || 'relates', id: e.id });
  });

  buildRings();
}

function buildRings() {
  rings = [];
  if (state.view === 'local') return;
  AUTH_ORDER.forEach(function (a, gi) {
    var tilt = gi === 0 ? 0 : gi === 1 ? 0.36 : -0.30;
    rings.push({ R: SHELL_R[gi], tilt: tilt, color: AUTH_COLOR[a] });
  });
}

/* ------------------------------------------------------------------ physics */

function step(dt) {
  var k = 1 - Math.pow(0.0009, dt / 1000);
  var damp = Math.pow(0.86, dt / 16.67);
  for (var i = 0; i < nodes.length; i++) {
    var n = nodes[i];
    if (n.isCenter) { n.x += (0 - n.x) * k; n.y += (0 - n.y) * k; n.z += (0 - n.z) * k; continue; }
    n.vx += (n.tx - n.x) * 3.2 * (dt / 1000);
    n.vy += (n.ty - n.y) * 3.2 * (dt / 1000);
    n.vz += (n.tz - n.z) * 3.2 * (dt / 1000);
    n.vx *= damp; n.vy *= damp; n.vz *= damp;
    n.x += n.vx * (dt / 16.67);
    n.y += n.vy * (dt / 16.67);
    n.z += n.vz * (dt / 16.67);
    n.y += Math.sin(performance.now() * 0.00042 + n.phase) * 0.10;
    n.x += Math.cos(performance.now() * 0.00037 + n.phase) * 0.10;
  }
}

/* -------------------------------------------------------------------- draw */

function draw(now) {
  ctx.clearRect(0, 0, W, H);
  var bg = ctx.createRadialGradient(W * 0.5, H * 0.42, 0, W * 0.5, H * 0.5, Math.max(W, H) * 0.72);
  bg.addColorStop(0, '#080b14');
  bg.addColorStop(0.55, '#04060c');
  bg.addColorStop(1, '#000003');
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, W, H);

  drawStars();
  if (!state.graph) return;
  drawRings();

  var proj = [];
  for (var i = 0; i < nodes.length; i++) {
    var n = nodes[i];
    var q = project(n);
    if (!q) { n.sd = -1; continue; }
    n.sx = q.x; n.sy = q.y; n.sf = q.f; n.sd = q.depth;
    proj.push(n);
  }

  var hi = hover || state.selected;
  drawEdges(proj, hi, now);
  proj.sort(function (a, b) { return b.sd - a.sd; });
  for (var j = 0; j < proj.length; j++) drawNode(proj[j], proj[j] === hi, now);
  if (hi) drawLabel(hi);
}

function drawStars() {
  var cy = Math.cos(cam.yaw * 0.4), sy = Math.sin(cam.yaw * 0.4);
  for (var i = 0; i < stars.length; i++) {
    var s = stars[i];
    var x1 = s.x * cy - s.z * sy;
    var z1 = s.x * sy + s.z * cy;
    var depth = cam.dist + z1;
    if (depth < 60) continue;
    var f = cam.focal / depth;
    var px = W / 2 + x1 * f;
    var py = H / 2 + s.y * f;
    if (px < -20 || px > W + 20 || py < -20 || py > H + 20) continue;
    ctx.globalAlpha = s.a * Math.min(1, 1200 / depth);
    ctx.fillStyle = '#cdd7ea';
    ctx.fillRect(px, py, s.s, s.s);
  }
  ctx.globalAlpha = 1;
}

function drawRings() {
  for (var r = 0; r < rings.length; r++) {
    var ring = rings[r];
    var tilt = ring.tilt, ct = Math.cos(tilt), st = Math.sin(tilt);
    for (var t = 0; t < 3; t++) {
      var roll = t * 0.9 + r * 0.4;
      ctx.beginPath();
      var started = false;
      for (var a = 0; a <= 64; a++) {
        var ang = (a / 64) * Math.PI * 2;
        var x = Math.cos(ang) * ring.R;
        var z = Math.sin(ang) * ring.R;
        var y0 = 0;
        var y = y0 * ct - z * st;
        var zz = y0 * st + z * ct;
        var cy2 = Math.cos(roll), sy2 = Math.sin(roll);
        var x2 = x * cy2 - y * sy2;
        var y2 = x * sy2 + y * cy2;
        var q = project({ x: x2, y: y2, z: zz });
        if (!q) { started = false; continue; }
        if (!started) { ctx.moveTo(q.x, q.y); started = true; } else ctx.lineTo(q.x, q.y);
      }
      ctx.strokeStyle = ring.color;
      ctx.globalAlpha = 0.055 - t * 0.012;
      ctx.lineWidth = 1;
      ctx.stroke();
    }
  }
  ctx.globalAlpha = 1;
}

function drawEdges(proj, hi, now) {
  for (var i = 0; i < edges.length; i++) {
    var e = edges[i];
    var a = e.a, b = e.b;
    if (a.sd < 0 || b.sd < 0) continue;
    var hot = hi && (a === hi || b === hi);
    var contra = e.type === 'contradicts';
    var p = Math.min(2, (a.sf + b.sf) / 2 * 620);
    var alpha = hot ? 0.34 : 0.06 + 0.11 * p;
    var mx = (a.sx + b.sx) / 2, my = (a.sy + b.sy) / 2;
    var dx = b.sx - a.sx, dy = b.sy - a.sy;
    var len = Math.hypot(dx, dy) || 1;
    var bow = hot ? 28 : 16;
    var cx = mx - (dy / len) * bow, cy = my + (dx / len) * bow;
    ctx.beginPath();
    ctx.moveTo(a.sx, a.sy);
    ctx.quadraticCurveTo(cx, cy, b.sx, b.sy);
    ctx.strokeStyle = contra ? EDGE_TYPES.contradicts : '#ffffff';
    ctx.globalAlpha = alpha;
    ctx.lineWidth = hot ? 1.4 : 1;
    if (contra) ctx.setLineDash([5, 4]); else ctx.setLineDash([]);
    ctx.stroke();
    ctx.setLineDash([]);
    if (hot || contra) {
      var t = reduced ? 0.5 : ((now * 0.00028 + i * 0.17) % 1);
      var px = (1 - t) * (1 - t) * a.sx + 2 * (1 - t) * t * cx + t * t * b.sx;
      var py = (1 - t) * (1 - t) * a.sy + 2 * (1 - t) * t * cy + t * t * b.sy;
      ctx.beginPath();
      ctx.arc(px, py, hot ? 2.2 : 1.6, 0, 6.283);
      ctx.fillStyle = contra ? EDGE_TYPES.contradicts : '#bff3ff';
      ctx.globalAlpha = hot ? 0.95 : 0.5;
      ctx.fill();
    }
  }
  ctx.globalAlpha = 1;
}

function drawNode(n, isHi, now) {
  var col = AUTH_COLOR[n.authority];
  var fade = Math.max(0.30, Math.min(1, 0.30 + (n.sf * 620) * 0.72));
  var r = Math.max(2.6, Math.min(17, n.baseR * (0.72 + n.sf * 470 * 0.55)));
  var pulse = n.isCenter ? 1 + Math.sin(now * 0.0016) * 0.06 : 1;
  r *= pulse;
  n.rr = r;

  // halo
  var g = ctx.createRadialGradient(n.sx, n.sy, 0, n.sx, n.sy, r * 5.4);
  g.addColorStop(0, col);
  g.addColorStop(0.22, col);
  g.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.globalAlpha = (isHi ? 0.5 : 0.30) * fade;
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.arc(n.sx, n.sy, r * (isHi ? 6.2 : 5.0), 0, 6.283);
  ctx.fill();

  // orbit trace for the primary 3D cue
  if (n.authority !== 'candidate' || isHi) {
    ctx.beginPath();
    ctx.ellipse(n.sx, n.sy, r * 2.05, r * 0.62, -0.38, 0, 6.283);
    ctx.strokeStyle = col;
    ctx.globalAlpha = (isHi ? 0.55 : 0.26) * fade;
    ctx.lineWidth = 1;
    ctx.stroke();
  }

  // body
  ctx.globalAlpha = Math.max(0.42, 0.55 + (n.sf * 620) * 0.45);
  var body = ctx.createRadialGradient(n.sx - r * 0.3, n.sy - r * 0.34, r * 0.1, n.sx, n.sy, r);
  body.addColorStop(0, '#ffffff');
  body.addColorStop(0.32, col);
  body.addColorStop(1, col);
  ctx.fillStyle = body;
  ctx.beginPath();
  ctx.arc(n.sx, n.sy, r, 0, 6.283);
  ctx.fill();

  // rim: dashed when not recall-eligible
  ctx.beginPath();
  ctx.arc(n.sx, n.sy, r + 1.2, 0, 6.283);
  ctx.strokeStyle = '#ffffff';
  ctx.globalAlpha = (n.trusted ? 0.32 : 0.46) * fade;
  ctx.lineWidth = 1;
  if (!n.trusted) ctx.setLineDash([2.5, 2.5]);
  ctx.stroke();
  ctx.setLineDash([]);

  // canonical diamonds
  if (n.authority === 'canonical') {
    for (var s = 0; s < 4; s++) {
      var ang = s * 1.5708 + 0.785;
      var dd = r * 2.2;
      ctx.beginPath();
      ctx.moveTo(n.sx + Math.cos(ang) * dd, n.sy + Math.sin(ang) * dd);
      ctx.lineTo(n.sx + Math.cos(ang + 0.34) * (dd + r * 0.5), n.sy + Math.sin(ang + 0.34) * (dd + r * 0.5));
      ctx.lineTo(n.sx + Math.cos(ang + 0.68) * dd, n.sy + Math.sin(ang + 0.68) * dd);
      ctx.closePath();
      ctx.strokeStyle = col;
      ctx.globalAlpha = 0.42 * fade;
      ctx.stroke();
    }
  }

  // selection ring
  if (state.selected === n.id) {
    ctx.beginPath();
    ctx.arc(n.sx, n.sy, r + 6 + Math.sin(now * 0.003) * 1.6, 0, 6.283);
    ctx.strokeStyle = col;
    ctx.globalAlpha = 0.75;
    ctx.lineWidth = 1.2;
    ctx.stroke();
  }
  ctx.globalAlpha = 1;
}

function drawLabel(n) {
  var col = AUTH_COLOR[n.authority];
  var r = n.rr || 6;
  var tx = n.sx + r * 2.4 + 8;
  var ty = n.sy + 4;
  var text = String(n.title || n.id);
  if (text.length > 34) text = text.slice(0, 33) + '…';
  ctx.font = '600 12px ui-sans-serif, -apple-system, "Segoe UI", Roboto, sans-serif';
  var wdt = ctx.measureText(text).width;
  if (tx + wdt > W - 16) tx = n.sx - r * 2.4 - 8 - wdt;
  ctx.globalAlpha = 0.92;
  ctx.fillStyle = 'rgba(6,9,16,.78)';
  ctx.beginPath();
  var bx = tx - 6, by = ty - 12, bw = wdt + 12, bh = 18;
  ctx.roundRect ? ctx.roundRect(bx, by, bw, bh, 5) : ctx.rect(bx, by, bw, bh);
  ctx.fill();
  ctx.fillStyle = '#edeef0';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, tx, ty - 2);
  ctx.fillStyle = col;
  ctx.globalAlpha = 0.75;
  ctx.font = '500 10px ui-monospace, SFMono-Regular, Menlo, monospace';
  var sub = String(n.authority || '') + ' · ' + String(n.validation || '') + (n.trusted ? ' · trusted' : ' · inspect');
  ctx.fillText(sub, tx, ty + 12);
  ctx.globalAlpha = 1;
  ctx.textBaseline = 'alphabetic';
}

function pick(mx, my) {
  var best = null, bestD = 1e9;
  for (var i = 0; i < nodes.length; i++) {
    var n = nodes[i];
    if (n.sd < 0) continue;
    var d = Math.hypot(n.sx - mx, n.sy - my);
    var lim = Math.max((n.rr || 6) * 2.2, 14);
    if (d < lim && d < bestD) { bestD = d; best = n; }
  }
  return best;
}

function loop(now) {
  raf = requestAnimationFrame(loop);
  var dt = Math.min(48, now - (last || now));
  last = now;
  if (!drag.on && state.orbit && !reduced) {
    idle += dt;
    if (idle > 700) cam.yaw += (dt / 1000) * 0.045;
  }
  step(dt);
  draw(now);
}

function start() { if (!raf) { last = 0; raf = requestAnimationFrame(loop); } }
function stop() { if (raf) { cancelAnimationFrame(raf); raf = 0; } }

function clearScene() { nodes = []; edges = []; byId = new Map(); rings = []; draw(performance.now()); }

/* ------------------------------------------------------------- interaction */

cv.addEventListener('pointerdown', function (ev) {
  drag.on = true; drag.x = ev.clientX; drag.y = ev.clientY; drag.moved = 0;
  cv.classList.add('dragging');
  cv.setPointerCapture && cv.setPointerCapture(ev.pointerId);
  idle = 0;
});
cv.addEventListener('pointermove', function (ev) {
  if (drag.on) {
    var dx = ev.clientX - drag.x, dy = ev.clientY - drag.y;
    drag.x = ev.clientX; drag.y = ev.clientY;
    drag.moved += Math.abs(dx) + Math.abs(dy);
    cam.yaw += dx * 0.006;
    cam.pitch = Math.max(-1.15, Math.min(1.15, cam.pitch + dy * 0.005));
    return;
  }
  var rect = cv.getBoundingClientRect();
  var hit = pick(ev.clientX - rect.left, ev.clientY - rect.top);
  if (hit !== hover) {
    hover = hit;
    cv.style.cursor = hit ? 'pointer' : 'grab';
    if (hit) showTip(hit, ev.clientX - rect.left, ev.clientY - rect.top);
    else hideTip();
  } else if (hit) {
    moveTip(ev.clientX - rect.left, ev.clientY - rect.top);
  }
});
cv.addEventListener('pointerup', function (ev) {
  cv.classList.remove('dragging');
  if (drag.on && drag.moved < 6) {
    var rect = cv.getBoundingClientRect();
    var hit = pick(ev.clientX - rect.left, ev.clientY - rect.top);
    if (hit) selectRecord(hit.id);
  }
  drag.on = false;
});
cv.addEventListener('pointerleave', function () { drag.on = false; cv.classList.remove('dragging'); hover = null; hideTip(); });
cv.addEventListener('wheel', function (ev) {
  ev.preventDefault();
  idle = 0;
  cam.dist = Math.max(420, Math.min(2400, cam.dist + ev.deltaY * 0.75));
}, { passive: false });

/* --------------------------------------------------------------- tooltip */

function showTip(n, x, y) {
  var el = $('tip');
  el.hidden = false;
  el.querySelector('.t').textContent = n.title || n.id;
  el.querySelector('.m').textContent =
    String(n.authority) + ' · ' + String(n.validation || 'unknown') +
    ' · ' + (n.trusted ? 'recall-eligible' : 'inspect only') +
    (n.evidenceCount ? ' · ' + n.evidenceCount + ' evidence' : '');
  moveTip(x, y);
}

function moveTip(x, y) {
  var el = $('tip');
  if (el.hidden) return;
  var w = el.offsetWidth || 200, h = el.offsetHeight || 54;
  var lx = x + 16, ly = y + 18;
  if (lx + w > W - 8) lx = x - w - 16;
  if (ly + h > H - 8) ly = y - h - 14;
  el.style.transform = 'translate(' + Math.max(8, lx) + 'px,' + Math.max(8, ly) + 'px)';
}

function hideTip() { $('tip').hidden = true; }

/* ------------------------------------------------------------- inspector */

function authorityChip(n) {
  var a = AUTH_COLOR[n.authority] ? n.authority : 'candidate';
  return '<span class="chip auth-' + a + '">' + esc(a) + '</span>';
}

function esc(s) {
  return String(s === undefined || s === null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function openInspector(id) {
  var n = byId.get(id);
  if (!n) return;
  state.selected = id;
  var el = $('insp');
  $('insTitle').textContent = n.title || n.id;
  var chips = [authorityChip(n)];
  chips.push('<span class="chip">' + esc(n.validation || 'unknown') + '</span>');
  chips.push('<span class="chip ' + (n.trusted ? 'ok' : 'warn') + '">' + (n.trusted ? 'recall-eligible' : 'inspect only') + '</span>');
  if (n.forgotten) chips.push('<span class="chip warn">forgotten</span>');
  $('insChips').innerHTML = chips.join('');
  $('insBody').innerHTML =
    '<dl class="kv">' +
    '<dt>id</dt><dd class="mono">' + esc(n.id) + '</dd>' +
    '<dt>kind</dt><dd>' + esc(n.kind || '—') + '</dd>' +
    '<dt>status</dt><dd>' + esc(n.status || '—') + '</dd>' +
    '<dt>confidence</dt><dd>' + esc(n.confidence || '—') + '</dd>' +
    '<dt>evidence</dt><dd>' + esc(String(n.evidenceCount || 0)) + '</dd>' +
    '</dl>' +
    (n.trusted ? '' : '<p class="warn">Not recall-eligible. Visible in the projection, but no agent will recall it until its authority is promoted.</p>') +
    '<p class="fine" id="insMore">Loading record…</p>';
  el.classList.add('show');
  say('Selected ' + (n.title || n.id));

  api('/record', { id: id }).then(function (body) {
    var more = $('insMore');
    if (!more) return;
    if (!body || !body.ok) { more.textContent = errText(body); return; }
    var r = body.record || {};
    var extra = '';
    if (r.body) extra += '<h3>Statement</h3><div class="prose">' + esc(r.body).replace(/\\n/g, '<br>') + '</div>';
    if (Array.isArray(r.evidence) && r.evidence.length) {
      extra += '<h3>Evidence</h3><ul>' + r.evidence.slice(0, 8).map(function (ev) {
        return '<li>' + esc(typeof ev === 'string' ? ev : (ev.ref || ev.path || ev.id || JSON.stringify(ev))) + '</li>';
      }).join('') + '</ul>';
    }
    if (Array.isArray(r.relations) && r.relations.length) {
      extra += '<h3>Relations</h3><ul>' + r.relations.slice(0, 10).map(function (rel) {
        return '<li><b>' + esc(rel.type || 'relates') + '</b> → ' + esc(rel.targetId || rel.id || '') + '</li>';
      }).join('') + '</ul>';
    }
    if (Array.isArray(body.contradictions) && body.contradictions.length) {
      extra += '<p class="warn">Contradicts ' + body.contradictions.length + ' record(s). Both sides stay visible; the repository wins.</p>';
    }
    more.outerHTML = extra || '<p class="fine">No further detail is stored for this record.</p>';
  }).catch(function () {
    var more = $('insMore');
    if (more) more.textContent = 'Record detail unavailable.';
  });
}

function closeInspector() {
  $('insp').classList.remove('show');
}

function selectRecord(id) {
  openInspector(id);
  state.selected = id;
  if (state.view === 'local' && state.graph && state.graph.center && state.graph.center.id === id) return;
  loadGraph(id);
}

/* ------------------------------------------------------------------- data */

function paintStats() {
  var g = state.graph;
  var ns = g && g.nodes ? g.nodes : [];
  var count = { canonical: 0, derived: 0, candidate: 0 };
  ns.forEach(function (n) { if (count[n.authority] !== undefined) count[n.authority]++; });
  $('sNodes').textContent = String(ns.length);
  $('sEdges').textContent = String((g && g.edges ? g.edges.length : 0));
  $('sCanon').textContent = String(count.canonical);
  $('sTrust').textContent = String(ns.filter(function (n) { return n.trusted; }).length);
}

function applyPayload(body) {
  state.graph = body;
  state.view = body.view === 'local' ? 'local' : 'overview';
  hideMsg();
  seedPositions();
  paintStats();
  start();
  var focus = body.center && body.center.id ? body.center.id : null;
  if (focus) {
    var n = byId.get(focus);
    if (n) { cam.dist = state.view === 'local' ? 720 : 900; }
  }
}

function loadOverview() {
  setLoading(true, 'Loading workspace…');
  state.view = 'overview';
  state.selected = null;
  closeInspector();
  return api('/graph', {}).then(function (body) {
    setLoading(false);
    if (body.__seq !== state.seq) return;
    if (!body.ok) { if (errText(body) === 'WORKSPACE_CONTEXT_UNAVAILABLE') showUnavailable(); else showError(errText(body)); return; }
    state.lastLoad = { kind: 'overview' };
    var u = new URL(location.href);
    u.searchParams.delete('id');
    u.searchParams.delete('hops');
    history.replaceState(null, '', u);
    applyPayload(body);
    if (body.empty) showMsg('No records yet', 'This workspace has no memory rows, so the projection is empty.', 'An empty graph is honest. Nothing is fabricated to fill it.', [{ label: 'Retry', primary: true, run: function () { hideMsg(); loadOverview(); } }]);
  }).catch(function () { setLoading(false); showError('The graph endpoint did not respond.'); });
}

function loadGraph(id) {
  setLoading(true, 'Loading record…');
  state.view = 'local';
  return api('/graph', { id: id, hops: 2 }).then(function (body) {
    setLoading(false);
    if (body.__seq !== state.seq) return;
    if (!body.ok) { if (errText(body) === 'WORKSPACE_CONTEXT_UNAVAILABLE') showUnavailable(); else showError(errText(body)); return; }
    state.lastLoad = { kind: 'local', id: id };
    var u = new URL(location.href);
    u.searchParams.set('id', id);
    u.searchParams.set('hops', '2');
    history.replaceState(null, '', u);
    applyPayload(body);
  }).catch(function () { setLoading(false); showError('The graph endpoint did not respond.'); });
}

function reload() {
  if (state.lastLoad && state.lastLoad.kind === 'local' && state.lastLoad.id) loadGraph(state.lastLoad.id);
  else loadOverview();
}

/* ---- named interaction entry points (kept as functions: the page contract
   names them, and the canvas listeners call through them) ---- */

function hoverNode(n, x, y) {
  hover = n;
  cv.style.cursor = n ? 'pointer' : 'grab';
  if (n) showTip(n, x, y); else hideTip();
}

function hoverEnd() {
  hover = null;
  cv.style.cursor = 'grab';
  hideTip();
}

function fitView() {
  cam.dist = 900;
  cam.yaw = 0.52;
  cam.pitch = -0.30;
  idle = 0;
}

/* ---- command palette: workspaces, records, and actions in one list ---- */

function fuzzy(hay, needle) {
  if (!needle) return 1;
  var h = String(hay || '').toLowerCase();
  var q = String(needle).toLowerCase();
  if (h.indexOf(q) !== -1) return 100 - h.indexOf(q);
  var hi = 0, score = 0;
  for (var i = 0; i < q.length; i++) {
    var k = h.indexOf(q.charAt(i), hi);
    if (k === -1) return 0;
    score += 1 / (1 + (k - hi));
    hi = k + 1;
  }
  return score;
}

function paletteItems() {
  var q = state.query.trim();
  var out = [];
  var i, ws, sc;

  for (i = 0; i < state.workspaces.length; i++) {
    ws = state.workspaces[i];
    if (state.cwd && samePath(ws.path, state.cwd)) continue;
    sc = Math.max(fuzzy(ws.title, q), fuzzy(ws.path, q));
    if (q && sc <= 0) continue;
    out.push({
      group: 'workspaces',
      key: 'ws:' + ws.id,
      title: ws.title || lastSeg(ws.path),
      meta: ws.path,
      tag: 'switch',
      score: (q ? sc : 40) + 20,
      run: function () { switchWorkspace(ws); }
    });
  }

  if (state.graph) {
    for (i = 0; i < nodes.length; i++) {
      var n = nodes[i];
      sc = Math.max(fuzzy(n.title, q), fuzzy(n.id, q));
      if (q && sc <= 0) continue;
      out.push({
        group: 'records',
        key: 'rec:' + n.id,
        title: n.title || n.id,
        meta: n.authority + ' · ' + (n.validation || 'unknown') + ' · ' + n.id,
        tag: n.authority,
        score: q ? sc : 10,
        run: (function (id) { return function () { selectRecord(id); }; })(n.id)
      });
    }
  }

  out.push({
    group: 'actions',
    key: 'act:overview',
    title: 'Workspace overview',
    meta: 'clear the local graph and return to the whole workspace',
    tag: 'action',
    score: (q ? Math.max(fuzzy('overview', q), fuzzy('workspace', q)) : 5),
    run: function () { state.selected = null; closeInspector(); loadOverview(); }
  });
  out.push({
    group: 'actions',
    key: 'act:fit',
    title: 'Reset camera',
    meta: 'restore the default orbit and distance',
    tag: 'action',
    score: (q ? Math.max(fuzzy('reset camera', q), fuzzy('fit', q)) : 4),
    run: function () { fitView(); }
  });

  out = out.filter(function (it) { return !q || it.score > 0; });
  out.sort(function (a, b) { return b.score - a.score; });
  return out.slice(0, 40);
}

function renderPalette() {
  var list = $('palList');
  state.items = paletteItems();
  if (state.index >= state.items.length) state.index = Math.max(0, state.items.length - 1);
  if (!state.items.length) {
    list.innerHTML = '<div class="empty">No matches. Every result comes from this workspace only.</div>';
    $('palHint').textContent = '';
    return;
  }
  var html = '';
  var group = '';
  for (var i = 0; i < state.items.length; i++) {
    var it = state.items[i];
    if (it.group !== group) {
      group = it.group;
      html += '<div class="grp">' + esc(group) + '</div>';
    }
    html += '<div class="pi' + (i === state.index ? ' on' : '') + '" role="option" data-i="' + i + '" aria-selected="' + (i === state.index ? 'true' : 'false') + '">'
      + '<span class="tt">' + esc(it.title) + '</span>'
      + '<span class="mt">' + esc(it.meta) + '</span>'
      + (it.tag ? '<span class="tag t-' + esc(it.tag) + '">' + esc(it.tag) + '</span>' : '')
      + '</div>';
  }
  list.innerHTML = html;
  $('palHint').textContent = state.workspaces.length + ' workspaces';
  var on = list.querySelector('.pi.on');
  if (on && on.scrollIntoView) on.scrollIntoView({ block: 'nearest' });
}

function openPalette(prefill) {
  state.paletteOpen = true;
  state.index = 0;
  state.query = prefill || '';
  $('palIn').value = state.query;
  $('pal').classList.add('show');
  $('pal').setAttribute('aria-hidden', 'false');
  renderPalette();
  setTimeout(function () { $('palIn').focus(); }, 0);
  say('Command palette opened');
}

function closePalette() {
  state.paletteOpen = false;
  $('pal').classList.remove('show');
  $('pal').setAttribute('aria-hidden', 'true');
}

function paletteMove(delta) {
  if (!state.items.length) return;
  state.index = (state.index + delta + state.items.length) % state.items.length;
  var rows = $('palList').querySelectorAll('.pi');
  for (var i = 0; i < rows.length; i++) {
    var on = Number(rows[i].getAttribute('data-i')) === state.index;
    rows[i].classList.toggle('on', on);
    rows[i].setAttribute('aria-selected', on ? 'true' : 'false');
    if (on && rows[i].scrollIntoView) rows[i].scrollIntoView({ block: 'nearest' });
  }
}

function paletteRun() {
  var it = state.items[state.index];
  if (!it) return;
  closePalette();
  it.run();
}

/* ---- workspace flyout (the second door: Ctrl+O) ---- */

function renderWsPanel() {
  var host = $('wsList');
  var html = '';
  if (!state.workspaces.length) {
    html = '<div class="empty">'
      + (state.registryState === 'available'
        ? 'The workspace registry lists nothing yet.'
        : 'The DSH workspace registry is unavailable, so there is nothing to switch to. Veyra does not guess.')
      + '</div>';
  } else {
    for (var i = 0; i < state.workspaces.length; i++) {
      var ws = state.workspaces[i];
      var on = state.cwd && samePath(ws.path, state.cwd);
      html += '<button type="button" class="wsi' + (on ? ' on' : '') + '" data-id="' + esc(ws.id) + '">'
        + '<span class="tile ' + hueOf(ws.id) + '">' + esc((ws.title || lastSeg(ws.path)).slice(0, 2).toUpperCase()) + '</span>'
        + '<span class="meta"><span class="nm">' + esc(ws.title || lastSeg(ws.path)) + '</span>'
        + '<span class="pt">' + esc(ws.path) + '</span></span>'
        + (on ? '<span class="cur">current</span>' : '')
        + '</button>';
    }
  }
  host.innerHTML = html;
}

function openWsPanel() {
  renderWsPanel();
  $('wsPanel').classList.add('show');
  $('wsChip').setAttribute('aria-expanded', 'true');
}

function closeWsPanel() {
  $('wsPanel').classList.remove('show');
  $('wsChip').setAttribute('aria-expanded', 'false');
}

function toggleWsPanel() {
  if ($('wsPanel').classList.contains('show')) closeWsPanel(); else openWsPanel();
}

/* ---- small shared helpers ---- */

function samePath(a, b) {
  if (!a || !b) return false;
  return String(a).replace(/\\/+$/, '') === String(b).replace(/\\/+$/, '');
}

function lastSeg(p) {
  var s = String(p || '').replace(/\\/+$/, '');
  var i = s.lastIndexOf('/');
  return i === -1 ? s : s.slice(i + 1);
}

/* ---- wiring ---- */

function setPressed(id, on) {
  var el = $(id);
  if (el) el.setAttribute('aria-pressed', on ? 'true' : 'false');
}

function boot() {
  resize();
  paintChip();

  $('wsChip').addEventListener('click', function (ev) { ev.stopPropagation(); toggleWsPanel(); });
  $('wsChip').addEventListener('keydown', function (ev) {
    if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); toggleWsPanel(); }
  });
  $('wsList').addEventListener('click', function (ev) {
    var row = ev.target.closest ? ev.target.closest('.wsi') : null;
    if (!row) return;
    var id = row.getAttribute('data-id');
    for (var i = 0; i < state.workspaces.length; i++) {
      if (state.workspaces[i].id === id) { closeWsPanel(); switchWorkspace(state.workspaces[i]); return; }
    }
  });

  $('omni').addEventListener('click', function () { openPalette(''); });
  $('omni').addEventListener('keydown', function (ev) {
    if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); openPalette(''); }
  });

  $('palIn').addEventListener('input', function () { state.query = this.value; state.index = 0; renderPalette(); });
  $('pal').addEventListener('click', function (ev) { if (ev.target === $('pal')) closePalette(); });
  $('palList').addEventListener('click', function (ev) {
    var row = ev.target.closest ? ev.target.closest('.pi') : null;
    if (!row) return;
    state.index = Number(row.getAttribute('data-i'));
    paletteRun();
  });
  $('palList').addEventListener('mousemove', function (ev) {
    var row = ev.target.closest ? ev.target.closest('.pi') : null;
    if (!row) return;
    var i = Number(row.getAttribute('data-i'));
    if (i !== state.index) { state.index = i; paletteMove(0); }
  });

  $('insClose').addEventListener('click', closeInspector);
  $('btnCenter').addEventListener('click', function () {
    if (state.selected) { var id = state.selected; closeInspector(); loadGraph(id); }
  });
  $('btnCopy').addEventListener('click', function () {
    var id = state.selected;
    if (!id) return;
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(id).then(function () { toast('Record id copied'); }, function () { toast(id); });
    } else { toast(id); }
  });

  $('orbit').addEventListener('click', function () { state.orbit = !state.orbit; setPressed('orbit', state.orbit); idle = 0; });
  $('labels').addEventListener('click', function () { state.labels = !state.labels; setPressed('labels', state.labels); });
  $('overview').addEventListener('click', function () { state.selected = null; closeInspector(); loadOverview(); });
  $('fitView').addEventListener('click', function () { fitView(); });

  window.addEventListener('resize', resize);

  document.addEventListener('keydown', function (ev) {
    var typing = ev.target && /input|textarea|select/i.test(ev.target.tagName || '');
    var mod = ev.ctrlKey || ev.metaKey;

    if (mod && (ev.key === 'k' || ev.key === 'K')) { ev.preventDefault(); if (state.paletteOpen) closePalette(); else openPalette(''); return; }
    if (mod && (ev.key === 'o' || ev.key === 'O')) { ev.preventDefault(); closeWsPanel(); openPalette(''); return; }

    if (state.paletteOpen) {
      if (ev.key === 'ArrowDown') { ev.preventDefault(); paletteMove(1); return; }
      if (ev.key === 'ArrowUp') { ev.preventDefault(); paletteMove(-1); return; }
      if (ev.key === 'Enter') { ev.preventDefault(); paletteRun(); return; }
      if (ev.key === 'Escape') { ev.preventDefault(); closePalette(); return; }
      return;
    }
    if (ev.key === 'Escape') {
      if ($('wsPanel').classList.contains('show')) { closeWsPanel(); return; }
      if (state.selected) { state.selected = null; closeInspector(); loadOverview(); return; }
    }
    if (typing) return;
    if (ev.key === 'o' || ev.key === 'O') { state.orbit = !state.orbit; setPressed('orbit', state.orbit); idle = 0; return; }
    if (ev.key === 'l' || ev.key === 'L') { state.labels = !state.labels; setPressed('labels', state.labels); return; }
    if (ev.key === 'f' || ev.key === 'F') { fitView(); return; }
    if (ev.key === '/') { ev.preventDefault(); openPalette(''); return; }
  });

  $('orbit').addEventListener('pointermove', function () { idle = 0; });

  setPressed('orbit', state.orbit);
  setPressed('labels', state.labels);

  loadWorkspaces().then(function () {
    if (!state.cwd) { showUnavailable(); return undefined; }
    return loadOverview();
  }).catch(function (err) {
    showError(err && err.message ? err.message : 'Could not load this workspace.');
  });
}

boot();

</script>
</body>
</html>`;
}
