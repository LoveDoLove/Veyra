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
import { projectIdFor } from './ids.mjs'
import { observatoryRecord, observatorySearch } from './observatory.mjs'
import { openProjectStore, openReusableStore } from './store.mjs'
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

export function cwdFromRequest(req, runtime) {
  const url = new URL(req.url || '/', 'http://127.0.0.1')
  const raw = url.searchParams.get('cwd')
  if (typeof raw === 'string' && raw.trim()) return resolve(raw.trim())
  return runtime?.fallbackCwd || process.cwd()
}

function openStores(runtime, cwd) {
  const projectId = projectIdFor(cwd)
  return {
    cwd,
    projectId,
    projectStore: openProjectStore(runtime.veyraHome, projectId),
    reusableStore: openReusableStore(runtime.veyraHome),
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

    const cwd = cwdFromRequest(req, runtime)
    const { projectStore, reusableStore, projectId } = openStores(runtime, cwd)
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
    const server = scope?.webServer
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
<title>Veyra Network Graph</title>
<style>
:root{--bg:#12141a;--panel:#1b1f28;--ink:#e8edf5;--muted:#8b95a8;--line:#2c3340;--sel:#f0c14b;--trust:#7dcea0;--inspect:#c39bd3;--contra:#e74c3c;--hist:#6c7585}
*{box-sizing:border-box}
html,body{margin:0;height:100%;background:var(--bg);color:var(--ink);font:13px/1.4 ui-sans-serif,system-ui,sans-serif}
#app{display:grid;grid-template-rows:auto 1fr;height:100%}
header{display:flex;flex-wrap:wrap;gap:8px;align-items:center;padding:8px 12px;border-bottom:1px solid var(--line);background:var(--panel)}
header h1{font-size:14px;margin:0 8px 0 0}
header input[type=search]{flex:1;min-width:160px;background:#0e1116;color:var(--ink);border:1px solid var(--line);border-radius:4px;padding:6px 8px}
header button,header select,header label{background:#0e1116;color:var(--ink);border:1px solid var(--line);border-radius:4px;padding:5px 8px}
header label{display:flex;gap:4px;align-items:center;font-size:12px;color:var(--muted)}
main{display:grid;grid-template-columns:1fr 320px;min-height:0}
@media(max-width:800px){main{grid-template-columns:1fr}}
#canvas-wrap{position:relative;min-height:0;border-right:1px solid var(--line)}
svg{width:100%;height:100%;display:block;background:#0e1116;touch-action:none}
#status{position:absolute;left:10px;top:10px;color:var(--muted);background:#0e1116cc;padding:4px 8px;border-radius:4px;max-width:70%}
#legend{position:absolute;left:10px;bottom:10px;color:var(--muted);background:#0e1116cc;padding:6px 8px;border-radius:4px;font-size:11px}
#loading{position:absolute;inset:0;display:flex;gap:10px;align-items:center;justify-content:center;background:#0e1116cc;color:var(--ink);z-index:5}
#loading[hidden]{display:none}
.spin{width:16px;height:16px;border:2px solid var(--line);border-top-color:var(--sel);border-radius:50%;animation:spin .8s linear infinite}
@keyframes spin{to{transform:rotate(360deg)}}
#tip{position:absolute;pointer-events:none;max-width:280px;background:#0e1116f2;border:1px solid var(--line);border-radius:4px;padding:6px 8px;font-size:11px;white-space:pre-line;z-index:6}
#tip[hidden]{display:none}
aside{overflow:auto;padding:12px;background:var(--panel)}
aside h2{font-size:14px;margin:0 0 8px}
aside .meta{color:var(--muted);font-size:12px}
aside .body{white-space:pre-wrap;margin:8px 0;padding:8px;background:#0e1116;border-radius:4px}
aside .warn{color:var(--contra)}
aside .actions{display:flex;gap:6px;flex-wrap:wrap;margin-top:8px}
aside .actions button{background:#0e1116;color:var(--ink);border:1px solid var(--line);border-radius:4px;padding:5px 8px;cursor:pointer}
.badge{display:inline-block;border:1px solid var(--line);border-radius:3px;padding:1px 5px;margin:0 4px 4px 0;font-size:11px}
#hits{list-style:none;margin:8px 0 0;padding:0}
#hits button{width:100%;text-align:left;background:#0e1116;color:var(--ink);border:1px solid var(--line);border-radius:4px;padding:6px;margin-bottom:6px;cursor:pointer}
.node.selected .ring{stroke:var(--sel);stroke-width:3}
.node.hover .shape{stroke:var(--sel);stroke-width:2.5}
.node.hover .ring{stroke:#f0c14b88}
.node.inspect .shape{fill:none;stroke-dasharray:4 3}
.node.historical{opacity:.55}
.node.forgotten .shape{stroke-dasharray:2 3}
.edge.contradicts{stroke:var(--contra);stroke-dasharray:6 4}
.edge.hl{stroke:var(--sel);stroke-width:2}
.edge-label{fill:var(--muted);font-size:10px}
</style>
</head>
<body>
<div id="app">
<header>
<h1>Veyra Network Graph</h1>
<form id="search-form"><input id="q" type="search" placeholder="Search → record → local graph"></form>
<label>hops <select id="hops"><option value="1" selected>1</option><option value="2">2</option></select></label>
<label><input id="trusted" type="checkbox"> trusted only</label>
<label><input id="hide-hist" type="checkbox"> hide historical</label>
<button type="button" id="overview">workspace overview</button>
<button type="button" id="fit">reset view</button>
</header>
<main>
<div id="canvas-wrap">
<div id="status">Loading workspace overview…</div>
<svg id="g" viewBox="0 0 960 640">
<defs>
<marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0 0L10 5L0 10z" fill="#8b95a8"/></marker>
<marker id="arrow-contra" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0 0L10 5L0 10z" fill="#e74c3c"/></marker>
</defs>
<g id="world"></g>
</svg>
<div id="loading" hidden><div class="spin"></div><span>Loading graph data…</span></div>
<div id="tip" hidden></div>
<div id="legend">
◆ canonical · ● derived · ■ candidate<br>
solid = trusted · hollow = inspect-only · faded = historical<br>
edges: labeled + directed · contradicts = dashed red ≠<br>
Visible ≠ trusted · Connected ≠ recall-eligible
</div>
</div>
<aside id="panel"><p class="meta">Loading… Graph is a projection over SQLite memory rows.</p></aside>
</main>
</div>
<script>
const $ = (id) => document.getElementById(id)
const params = new URLSearchParams(location.search)
const cwd = params.get('cwd') || ''
let hops = params.get('hops') === '2' ? 2 : 1
const state = {
  graph: null, selected: params.get('id') || '',
  vx: 0, vy: 0, scale: 1,
  pos: new Map(), edgeEls: new Map(),
  lastLoad: null, drag: null,
}
$('hops').value = String(hops)

function api(path, extra={}) {
  const u = new URL(path, location.origin)
  if (cwd) u.searchParams.set('cwd', cwd)
  for (const [k,v] of Object.entries(extra)) if (v != null && v !== '') u.searchParams.set(k, v)
  return fetch(u).then(r => r.json())
}
function setStatus(t){ $('status').textContent = t }
function setLoading(on){ $('loading').hidden = !on }
function errMsg(e){ return (e && e.message) || String(e) }
function shapeFor(n){
  if (n.authority === 'canonical') return 'diamond'
  if (n.authority === 'candidate') return 'square'
  return 'circle'
}
function valMark(v){
  return ({verified:'✓', reviewed:'~', unverified:'?', stale:'⌛', invalid:'✕'})[v] || '?'
}
function hopMap(graph){
  const hops = new Map()
  if (!graph.center) return hops
  hops.set(graph.center.id, 0)
  let frontier = [graph.center.id]
  for (let d = 0; d < 2; d++) {
    const next = []
    for (const id of frontier) {
      for (const e of graph.edges) {
        const other = e.fromId === id ? e.targetId : e.targetId === id ? e.fromId : null
        if (other && !hops.has(other)) { hops.set(other, d+1); next.push(other) }
      }
    }
    frontier = next
  }
  return hops
}
function layout(graph){
  const w=960,h=640,cx=480,cy=320
  const hm = hopMap(graph)
  const pos = new Map()
  if (!graph.center) {
    // Overview: deterministic concentric rings (≤14 per ring), then fitView scales to fit.
    const list = graph.nodes
    const per = 14
    list.forEach((n,i) => {
      const ring = Math.floor(i/per)
      const idx = i % per
      const count = Math.min(list.length - ring*per, per)
      const r = 170 + ring*170
      const a = (Math.PI*2*idx)/Math.max(count,1) - Math.PI/2
      pos.set(n.id, {x: cx + Math.cos(a)*r, y: cy + Math.sin(a)*r})
    })
    return pos
  }
  const rings = {0:[],1:[],2:[]}
  for (const n of graph.nodes) rings[Math.min(hm.get(n.id) ?? 1, 2)].push(n)
  if (rings[0][0]) pos.set(rings[0][0].id, {x:cx,y:cy})
  for (const hop of [1,2]) {
    const list = rings[hop]
    const r = hop === 1 ? 180 : 300
    list.forEach((n,i) => {
      const a = (Math.PI*2*i)/Math.max(list.length,1) - Math.PI/2
      pos.set(n.id, {x:cx + Math.cos(a)*r, y:cy + Math.sin(a)*r})
    })
  }
  return pos
}
function applyView(){
  $('world').setAttribute('transform', 'translate('+state.vx+','+state.vy+') scale('+state.scale+')')
}
// Client pixel → SVG viewBox coordinates (keeps pan/zoom correct under any container scale).
function svgPt(ev){
  const svg = $('g')
  const m = svg.getScreenCTM && svg.getScreenCTM()
  if (!m) return {x: ev.clientX, y: ev.clientY}
  const p = svg.createSVGPoint()
  p.x = ev.clientX; p.y = ev.clientY
  const q = p.matrixTransform(m.inverse())
  return {x: q.x, y: q.y}
}
function fitView(){
  const pos = state.pos
  if (!pos.size) { state.vx=0; state.vy=0; state.scale=1; applyView(); return }
  let minx=Infinity, miny=Infinity, maxx=-Infinity, maxy=-Infinity
  for (const p of pos.values()) {
    if (p.x<minx) minx=p.x; if (p.x>maxx) maxx=p.x
    if (p.y<miny) miny=p.y; if (p.y>maxy) maxy=p.y
  }
  const pad = 70
  const bw = Math.max(maxx-minx, 1), bh = Math.max(maxy-miny, 1)
  let s = Math.min((960-pad*2)/bw, (640-pad*2)/bh)
  s = Math.max(0.15, Math.min(s, 2))
  state.scale = s
  state.vx = 480 - ((minx+maxx)/2)*s
  state.vy = 320 - ((miny+maxy)/2)*s
  applyView()
}
function visibleNodes(graph){
  const trustedOnly = $('trusted').checked
  const hideHist = $('hide-hist').checked
  return graph.nodes.filter(n => {
    if (trustedOnly && !n.trusted && n.id !== graph.center?.id) return false
    if (hideHist && (n.forgotten || n.status !== 'current') && n.id !== graph.center?.id) return false
    return true
  })
}
function draw(){
  const graph = state.graph
  const world = $('world')
  world.innerHTML = ''
  state.pos = new Map()
  state.edgeEls = new Map()
  hideTip()
  if (!graph || !graph.nodes || !graph.nodes.length) return
  const keep = new Set(visibleNodes(graph).map(n => n.id))
  const pos = layout(graph)
  state.pos = pos
  for (const e of graph.edges) {
    if (!keep.has(e.fromId) || !keep.has(e.targetId)) continue
    const a = pos.get(e.fromId), b = pos.get(e.targetId)
    if (!a || !b) continue
    const contra = e.type === 'contradicts'
    const line = document.createElementNS('http://www.w3.org/2000/svg','line')
    line.setAttribute('x1', a.x); line.setAttribute('y1', a.y)
    line.setAttribute('x2', b.x); line.setAttribute('y2', b.y)
    line.setAttribute('stroke', contra ? '#e74c3c' : '#8b95a8')
    line.setAttribute('stroke-width', contra ? '2.2' : '1.4')
    line.setAttribute('marker-end', contra ? 'url(#arrow-contra)' : 'url(#arrow)')
    line.setAttribute('class', 'edge'+(contra?' contradicts':''))
    world.appendChild(line)
    state.edgeEls.set(e.id, { el: line, from: e.fromId, to: e.targetId })
    const label = document.createElementNS('http://www.w3.org/2000/svg','text')
    label.setAttribute('x', (a.x+b.x)/2); label.setAttribute('y', (a.y+b.y)/2 - 6)
    label.setAttribute('class','edge-label')
    label.setAttribute('text-anchor','middle')
    label.textContent = contra ? '≠ '+e.type : e.type
    world.appendChild(label)
  }
  for (const n of graph.nodes) {
    if (!keep.has(n.id)) continue
    const p = pos.get(n.id); if (!p) continue
    const g = document.createElementNS('http://www.w3.org/2000/svg','g')
    const cls = ['node']
    if (n.id === state.selected) cls.push('selected')
    if (!n.trusted) cls.push('inspect')
    if (n.forgotten || n.status !== 'current') cls.push('historical')
    if (n.forgotten) cls.push('forgotten')
    g.setAttribute('class', cls.join(' '))
    g.style.cursor = 'pointer'
    const ring = document.createElementNS('http://www.w3.org/2000/svg','circle')
    ring.setAttribute('class','ring')
    ring.setAttribute('cx', p.x); ring.setAttribute('cy', p.y); ring.setAttribute('r', n.id===(graph.center&&graph.center.id)?28:22)
    ring.setAttribute('fill','none'); ring.setAttribute('stroke', n.id===state.selected?'#f0c14b':'transparent')
    g.appendChild(ring)
    const shape = shapeFor(n)
    const el = shape === 'square'
      ? rect(p.x-12,p.y-12,24,24)
      : shape === 'diamond' ? diamond(p.x,p.y,16) : circ(p.x,p.y,14)
    el.setAttribute('class','shape')
    el.setAttribute('fill', n.trusted ? (n.authority==='canonical'?'#f0c14b': n.kind==='knowledge'?'#5dade2':'#7dcea0') : 'none')
    el.setAttribute('stroke', n.trusted ? '#e8edf5' : '#c39bd3')
    el.setAttribute('stroke-width','2')
    g.appendChild(el)
    const badge = document.createElementNS('http://www.w3.org/2000/svg','text')
    badge.setAttribute('x', p.x); badge.setAttribute('y', p.y+4)
    badge.setAttribute('text-anchor','middle'); badge.setAttribute('font-size','10'); badge.setAttribute('fill', n.trusted?'#12141a':'#e8edf5')
    badge.textContent = (n.kind||'?')[0].toUpperCase() + valMark(n.validation)
    g.appendChild(badge)
    const title = document.createElementNS('http://www.w3.org/2000/svg','text')
    title.setAttribute('x', p.x); title.setAttribute('y', p.y+32)
    title.setAttribute('text-anchor','middle'); title.setAttribute('fill','#e8edf5'); title.setAttribute('font-size','11')
    title.textContent = (n.title||n.id).slice(0,28)
    g.appendChild(title)
    g.addEventListener('mouseenter', (ev) => hoverNode(g, n, ev, true))
    g.addEventListener('mousemove', (ev) => moveTip(ev))
    g.addEventListener('mouseleave', () => hoverNode(g, n, null, false))
    g.addEventListener('click', (ev) => { ev.stopPropagation(); select(n.id) })
    world.appendChild(g)
  }
}
function hoverNode(g, n, ev, on){
  g.classList.toggle('hover', on)
  for (const rec of state.edgeEls.values()) {
    if (rec.from === n.id || rec.to === n.id) rec.el.classList.toggle('hl', on)
  }
  if (on) showTip(n, ev); else hideTip()
}
function showTip(n, ev){
  const tip = $('tip')
  tip.textContent = (n.title || n.id) + '\\n' +
    n.kind + ' · ' + n.authority + ' · ' + n.validation + ' · ' + (n.trusted ? 'trusted' : 'inspect-only') +
    (n.forgotten ? ' · forgotten' : '') + '\\n' + n.id
  tip.hidden = false
  moveTip(ev)
}
function moveTip(ev){
  if (!ev) return
  const tip = $('tip')
  if (tip.hidden) return
  const wrap = $('canvas-wrap').getBoundingClientRect()
  let x = ev.clientX - wrap.left + 14
  let y = ev.clientY - wrap.top + 14
  if (x + 290 > wrap.width) x = Math.max(4, wrap.width - 290)
  if (y + 80 > wrap.height) y = Math.max(4, wrap.height - 80)
  tip.style.left = x + 'px'
  tip.style.top = y + 'px'
}
function hideTip(){ $('tip').hidden = true }
function drawMessage(msg){
  state.graph = null
  state.pos = new Map()
  state.edgeEls = new Map()
  hideTip()
  $('world').innerHTML = ''
  state.vx = 0; state.vy = 0; state.scale = 1
  applyView()
  const t = document.createElementNS('http://www.w3.org/2000/svg','text')
  t.setAttribute('x', 480); t.setAttribute('y', 320)
  t.setAttribute('text-anchor','middle'); t.setAttribute('fill','#8b95a8'); t.setAttribute('font-size','16')
  t.textContent = msg
  $('world').appendChild(t)
}
function circ(x,y,r){ const e=document.createElementNS('http://www.w3.org/2000/svg','circle'); e.setAttribute('cx',x); e.setAttribute('cy',y); e.setAttribute('r',r); return e }
function rect(x,y,w,h){ const e=document.createElementNS('http://www.w3.org/2000/svg','rect'); e.setAttribute('x',x); e.setAttribute('y',y); e.setAttribute('width',w); e.setAttribute('height',h); return e }
function diamond(x,y,s){ const e=document.createElementNS('http://www.w3.org/2000/svg','polygon'); e.setAttribute('points', x+','+(y-s)+' '+(x+s)+','+y+' '+x+','+(y+s)+' '+(x-s)+','+y); return e }

function showError(msg, clear){
  if (clear !== false) drawMessage('Graph unavailable.')
  setStatus('Error · ' + msg)
  const el = $('panel')
  el.innerHTML = '<h2>Error</h2><p class="warn" id="err-msg"></p><div class="actions" id="err-actions"></div>'
  el.querySelector('#err-msg').textContent = msg
  const mk = (label, fn) => {
    const b = document.createElement('button')
    b.type = 'button'; b.textContent = label
    b.addEventListener('click', fn)
    return b
  }
  const box = el.querySelector('#err-actions')
  if (state.lastLoad) box.appendChild(mk('Retry', () => state.lastLoad()))
  box.appendChild(mk('Workspace overview', loadOverview))
}
function renderOverviewPanel(data, empty){
  const el = $('panel')
  if (empty) {
    el.innerHTML = '<h2>Empty graph</h2><p class="meta">No Veyra records exist for this workspace yet. Nodes and edges appear here once Veyra observes, learns, or remembers something — the graph never uses hardcoded data.</p>'
    return
  }
  el.innerHTML = '<h2>Workspace overview</h2><p class="meta" id="ov-meta"></p><p class="meta">Hover a node for a preview. Click it to open its record and center its Local Graph. Search narrows to a single record.</p>'
  el.querySelector('#ov-meta').textContent =
    data.nodes.length + ' records · ' + data.edges.length + ' relationships · ' +
    data.unresolved.length + ' unresolved · project ' + (data.projectId || '(unknown)')
}
async function loadOverview(){
  state.lastLoad = loadOverview
  setLoading(true)
  setStatus('Loading workspace overview…')
  try {
    const data = await api('/veyra/graph')
    if (!data.ok) { showError(data.error || 'Overview failed'); return }
    state.graph = data
    state.selected = ''
    const next = new URL(location.href)
    next.searchParams.delete('id')
    history.replaceState(null, '', next)
    if (!data.nodes.length) {
      drawMessage('No memories yet in this workspace.')
      setStatus('Empty · 0 nodes · 0 edges · no records to graph')
      renderOverviewPanel(data, true)
      return
    }
    setStatus('Overview · ' + data.nodes.length + ' nodes · ' + data.edges.length + ' edges · ' + data.unresolved.length + ' unresolved · ' + data.note)
    draw()
    fitView()
    renderOverviewPanel(data, false)
  } catch (err) {
    showError('Overview request failed: ' + errMsg(err))
  } finally {
    setLoading(false)
  }
}
async function loadGraph(id){
  if (!id) { loadOverview(); return }
  state.lastLoad = () => loadGraph(id)
  setLoading(true)
  setStatus('Loading graph…')
  try {
    const data = await api('/veyra/graph', { id, hops })
    if (!data.ok) { showError(data.error || 'Not found'); return }
    state.graph = data
    state.selected = data.center?.id || id
    setStatus('Local Graph · hops '+data.hops+' · '+data.nodes.length+' nodes · '+data.edges.length+' edges · '+data.note)
    const next = new URL(location.href)
    next.searchParams.set('id', state.selected)
    next.searchParams.set('hops', String(hops))
    history.replaceState(null, '', next)
    draw()
    fitView()
    select(state.selected, false)
  } catch (err) {
    showError('Graph request failed: ' + errMsg(err))
  } finally {
    setLoading(false)
  }
}
async function select(id, reload=true){
  state.selected = id
  draw()
  try {
    const rec = await api('/veyra/record', { id })
    renderPanel(rec)
  } catch (err) {
    renderPanel({ ok: false, error: 'Record request failed: ' + errMsg(err) })
  }
  if (reload && state.graph?.center?.id !== id) loadGraph(id)
}
function esc(s){ return String(s??'').replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c])) }
function renderPanel(rec){
  const el = $('panel')
  if (!rec || !rec.ok) { el.innerHTML = '<p class="warn">'+esc(rec?.error || 'No record')+'</p>'; return }
  const r = rec.record
  const ev = (r.evidence||[]).map(e => typeof e === 'string' ? e : [e.path,e.note,e.uri].filter(Boolean).join(' · ')).map(esc).join('<br>') || '(none)'
  const rel = (r.relations||[]).map(x => esc(x.type+' → '+x.targetId)).join('<br>') || '(none)'
  const inc = (rec.incoming||[]).map(x => esc(x.type+' ← '+x.fromId)).join('<br>') || '(none)'
  const c = rec.causal
  el.innerHTML = '<h2></h2><div class="meta"></div><div class="body"></div>'+
    (rec.contradictions?.length ? '<p class="warn">Contradicts: '+esc(rec.contradictions.join(', '))+'. Both sides stay visible. Believe the repository.</p>' : '')+
    '<p class="meta"><b>Evidence</b><br>'+ev+'</p>'+
    '<p class="meta"><b>Relations</b><br>'+rel+'<br>'+inc+'</p>'+
    (c ? '<p class="meta"><b>Causal</b><br>'+esc([c.symptom,c.rootCause,c.remedy,c.verifiedOutcome].filter(Boolean).join(' → '))+'</p>' : '')+
    '<p class="meta">trusted='+r.trusted+' · inspect-only='+(!r.trusted)+' · /veyra observatory record '+esc(r.id)+'</p>'
  el.querySelector('h2').textContent = r.title || r.id
  el.querySelector('.meta').textContent = r.id+' · '+r.kind+'/'+r.authority+'/'+r.validation+'/'+r.status+(r.forgotten?' forgotten':'')
  el.querySelector('.body').textContent = r.body || ''
}
$('search-form').addEventListener('submit', async (ev) => {
  ev.preventDefault()
  const q = $('q').value.trim()
  if (!q) return
  setStatus('Searching…')
  setLoading(true)
  try {
    const data = await api('/veyra/search', { q })
    const el = $('panel')
    if (!data.hits.length) { el.innerHTML = '<p class="meta">No matches.</p>'; setStatus('No matches'); return }
    el.innerHTML = '<h2>Search</h2><ul id="hits"></ul>'
    for (const h of data.hits) {
      const b = document.createElement('button')
      b.type='button'
      b.textContent = (h.trusted?'trusted':'inspect-only')+' · '+h.authority+'/'+h.validation+' · '+h.title
      b.addEventListener('click', () => loadGraph(h.id))
      $('hits').appendChild(b)
    }
    setStatus(data.hits.length+' hit(s). Pick one for Local Graph.')
  } catch (err) {
    showError('Search request failed: ' + errMsg(err), false)
  } finally {
    setLoading(false)
  }
})
$('hops').addEventListener('change', () => { hops = Number($('hops').value)||1; if (state.selected) loadGraph(state.selected) })
$('trusted').addEventListener('change', () => { if (state.graph) draw() })
$('hide-hist').addEventListener('change', () => { if (state.graph) draw() })
$('fit').addEventListener('click', fitView)
$('overview').addEventListener('click', loadOverview)
const svg = $('g')
svg.addEventListener('wheel', (ev) => {
  ev.preventDefault()
  const loc = svgPt(ev)
  const f = ev.deltaY < 0 ? 1.1 : 0.9
  const wx = (loc.x - state.vx) / state.scale
  const wy = (loc.y - state.vy) / state.scale
  state.scale = Math.max(0.15, Math.min(4, state.scale * f))
  state.vx = loc.x - wx * state.scale
  state.vy = loc.y - wy * state.scale
  applyView()
}, {passive:false})
svg.addEventListener('pointerdown', (ev) => {
  if (ev.target !== svg) return
  const p = svgPt(ev)
  state.drag = { x: p.x, y: p.y, vx: state.vx, vy: state.vy }
})
window.addEventListener('pointermove', (ev) => {
  if (!state.drag) return
  const p = svgPt(ev)
  state.vx = state.drag.vx + (p.x - state.drag.x)
  state.vy = state.drag.vy + (p.y - state.drag.y)
  applyView()
})
window.addEventListener('pointerup', () => { state.drag = null })
if (state.selected) loadGraph(state.selected)
else loadOverview()
</script>
</body>
</html>`
}
