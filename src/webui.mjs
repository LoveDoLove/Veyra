/**
 * Veyra — Network Graph WebUI.
 *
 * Host-native Observatory surface. Not a store, not a second identity.
 * GET /veyra        HTML (vanilla SVG)
 * GET /veyra/graph  localGraph JSON
 * GET /veyra/record compact record JSON
 * GET /veyra/search hybrid search JSON
 */

import { resolve } from 'node:path'
import { GRAPH_LIMITS, localGraph } from './graph.mjs'
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
      const payload = buildGraphPayload({
        projectStore, reusableStore, id, hops, trustedOnly, cwd, projectId,
      })
      sendJson(res, payload.ok || !id ? 200 : 404, payload)
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
aside{overflow:auto;padding:12px;background:var(--panel)}
aside h2{font-size:14px;margin:0 0 8px}
aside .meta{color:var(--muted);font-size:12px}
aside .body{white-space:pre-wrap;margin:8px 0;padding:8px;background:#0e1116;border-radius:4px}
aside .warn{color:var(--contra)}
.badge{display:inline-block;border:1px solid var(--line);border-radius:3px;padding:1px 5px;margin:0 4px 4px 0;font-size:11px}
#hits{list-style:none;margin:8px 0 0;padding:0}
#hits button{width:100%;text-align:left;background:#0e1116;color:var(--ink);border:1px solid var(--line);border-radius:4px;padding:6px;margin-bottom:6px;cursor:pointer}
.node.selected .ring{stroke:var(--sel);stroke-width:3}
.node.inspect .shape{fill:none;stroke-dasharray:4 3}
.node.historical{opacity:.55}
.node.forgotten .shape{stroke-dasharray:2 3}
.edge.contradicts{stroke:var(--contra);stroke-dasharray:6 4}
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
<button type="button" id="fit">reset view</button>
</header>
<main>
<div id="canvas-wrap">
<div id="status">Default: selected record + 1 hop. Visible ≠ trusted.</div>
<svg id="g" viewBox="0 0 960 640">
<defs>
<marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0 0L10 5L0 10z" fill="#8b95a8"/></marker>
<marker id="arrow-contra" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0 0L10 5L0 10z" fill="#e74c3c"/></marker>
</defs>
<g id="world"></g>
</svg>
<div id="legend">
◆ canonical · ● derived · ■ candidate<br>
solid = trusted · hollow = inspect-only · faded = historical<br>
edges: labeled + directed · contradicts = dashed red ≠
</div>
</div>
<aside id="panel"><p class="meta">Select a node. Graph is a projection over SQLite memory rows.</p></aside>
</main>
</div>
<script>
const $ = (id) => document.getElementById(id)
const params = new URLSearchParams(location.search)
const cwd = params.get('cwd') || ''
let hops = params.get('hops') === '2' ? 2 : 1
let state = { graph: null, selected: params.get('id') || '', vx:0, vy:0, scale:1, drag:null }
$('hops').value = String(hops)

function api(path, extra={}) {
  const u = new URL(path, location.origin)
  if (cwd) u.searchParams.set('cwd', cwd)
  for (const [k,v] of Object.entries(extra)) if (v != null && v !== '') u.searchParams.set(k, v)
  return fetch(u).then(r => r.json())
}
function setStatus(t){ $('status').textContent = t }
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
  if (!graph || !graph.center) return
  const keep = new Set(visibleNodes(graph).map(n => n.id))
  const pos = layout(graph)
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
    ring.setAttribute('cx', p.x); ring.setAttribute('cy', p.y); ring.setAttribute('r', n.id===graph.center.id?28:22)
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
    g.addEventListener('click', (ev) => { ev.stopPropagation(); select(n.id) })
    world.appendChild(g)
  }
}
function circ(x,y,r){ const e=document.createElementNS('http://www.w3.org/2000/svg','circle'); e.setAttribute('cx',x); e.setAttribute('cy',y); e.setAttribute('r',r); return e }
function rect(x,y,w,h){ const e=document.createElementNS('http://www.w3.org/2000/svg','rect'); e.setAttribute('x',x); e.setAttribute('y',y); e.setAttribute('width',w); e.setAttribute('height',h); return e }
function diamond(x,y,s){ const e=document.createElementNS('http://www.w3.org/2000/svg','polygon'); e.setAttribute('points', x+','+(y-s)+' '+(x+s)+','+y+' '+x+','+(y+s)+' '+(x-s)+','+y); return e }

async function loadGraph(id){
  if (!id) { setStatus('Search or open /veyra?id=<record>. Default is Local Graph, 1 hop.'); state.graph=null; draw(); return }
  setStatus('Loading graph…')
  const data = await api('/veyra/graph', { id, hops })
  state.graph = data
  state.selected = data.center?.id || id
  if (!data.ok) { setStatus(data.error || 'Not found'); draw(); renderPanel({ok:false,error:data.error}); return }
  setStatus('Local Graph · hops '+data.hops+' · '+data.nodes.length+' nodes · '+data.edges.length+' edges · '+data.note)
  const next = new URL(location.href)
  next.searchParams.set('id', state.selected)
  next.searchParams.set('hops', String(hops))
  history.replaceState(null, '', next)
  draw()
  select(state.selected, false)
}
async function select(id, reload=true){
  state.selected = id
  draw()
  const rec = await api('/veyra/record', { id })
  renderPanel(rec)
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
})
$('hops').addEventListener('change', () => { hops = Number($('hops').value)||1; if (state.selected) loadGraph(state.selected) })
$('trusted').addEventListener('change', () => { if (state.graph) draw() })
$('hide-hist').addEventListener('change', () => { if (state.graph) draw() })
$('fit').addEventListener('click', () => { state.vx=0; state.vy=0; state.scale=1; applyView() })
const svg = $('g')
svg.addEventListener('wheel', (ev) => {
  ev.preventDefault()
  const f = ev.deltaY < 0 ? 1.1 : 0.9
  state.scale = Math.max(0.3, Math.min(3, state.scale * f))
  applyView()
}, {passive:false})
svg.addEventListener('pointerdown', (ev) => { if (ev.target === svg) state.drag = {x:ev.clientX-state.vx, y:ev.clientY-state.vy} })
window.addEventListener('pointermove', (ev) => { if (!state.drag) return; state.vx = ev.clientX-state.drag.x; state.vy = ev.clientY-state.drag.y; applyView() })
window.addEventListener('pointerup', () => { state.drag = null })
if (state.selected) loadGraph(state.selected)
else setStatus('Search or open /veyra?id=<record>. Default is Local Graph, 1 hop.')
</script>
</body>
</html>`
}
