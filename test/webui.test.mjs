import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { IncomingMessage, ServerResponse } from 'node:http'
import { Socket } from 'node:net'
import { AUTHORITIES, KINDS, RELATIONS, VALIDATIONS } from '../src/types.mjs'
import { apply } from '../src/plugin.mjs'
import { handleVeyraCommand } from '../src/commands.mjs'
import { closeAllStores } from '../src/store.mjs'
import { GRAPH_LIMITS } from '../src/graph.mjs'
import { roomIdFor, roomStore, testRuntime } from './helpers/room.mjs'
import {
  buildGraphPayload,
  buildOverviewPayload,
  classifyNode,
  clampUiHops,
  cwdFromRequest,
  graphPage,
  handleVeyraHttp,
  registerWebUi,
  WORKSPACE_CONTEXT_UNAVAILABLE,
} from '../src/webui.mjs'

function seed(store, projectId) {
  const root = store.put({
    title: 'WAL is required',
    body: 'Always enable WAL for DatabaseSync.',
    authority: AUTHORITIES.DERIVED,
    validation: VALIDATIONS.VERIFIED,
    projectId,
  })
  const child = store.put({
    title: 'FTS5 triggers follow WAL',
    body: 'FTS triggers must stay in the same WAL writer.',
    authority: AUTHORITIES.DERIVED,
    validation: VALIDATIONS.VERIFIED,
    projectId,
    relations: [{ type: RELATIONS.UPDATES, targetId: root.record.id }],
  })
  const candidate = store.put({
    title: 'Guess about WAL',
    body: 'Maybe WAL is optional.',
    authority: AUTHORITIES.CANDIDATE,
    kind: KINDS.OBSERVATION,
    projectId,
    relations: [{ type: RELATIONS.EXTENDS, targetId: root.record.id }],
  })
  const contra = store.put({
    title: 'WAL is optional',
    body: 'Opposing claim stays visible.',
    authority: AUTHORITIES.DERIVED,
    validation: VALIDATIONS.UNVERIFIED,
    projectId,
    relations: [{ type: RELATIONS.CONTRADICTS, targetId: root.record.id }],
  })
  return { root: root.record, child: child.record, candidate: candidate.record, contra: contra.record }
}

function mockReqRes(url, method = 'GET') {
  const req = new IncomingMessage(new Socket())
  req.method = method
  req.url = url
  let status = 0
  let headers = {}
  const chunks = []
  const res = new ServerResponse(req)
  res.writeHead = (code, hdrs) => {
    status = code
    headers = hdrs || {}
    return res
  }
  res.end = (body) => {
    if (body) chunks.push(Buffer.from(body))
    res.emit('finish')
    return res
  }
  return {
    req,
    res,
    done: new Promise((resolve) => res.on('finish', () => {
      const body = Buffer.concat(chunks).toString('utf8')
      resolve({ status, headers, body })
    })),
  }
}

test('classifyNode and hop clamp keep inspect-only distinct from trusted', () => {
  const trusted = classifyNode({
    id: 'a', trusted: true, forgotten: false, status: 'current',
    kind: 'memory', authority: 'derived', validation: 'verified',
  }, 'a')
  assert.equal(trusted.selected, true)
  assert.equal(trusted.trusted, true)
  assert.equal(trusted.inspectOnly, false)
  assert.equal(trusted.historical, false)

  const inspect = classifyNode({
    id: 'b', trusted: false, forgotten: true, status: 'superseded',
    kind: 'observation', authority: 'candidate', validation: 'unverified',
  }, 'a')
  assert.equal(inspect.selected, false)
  assert.equal(inspect.inspectOnly, true)
  assert.equal(inspect.historical, true)
  assert.equal(clampUiHops(9), GRAPH_LIMITS.maxHops)
  assert.equal(clampUiHops('nope'), GRAPH_LIMITS.hops)
})

test('graph payload is localGraph plus presentation marks; isolation stays fail-closed', () => {
  const dir = mkdtempSync(join(tmpdir(), 'veyra-webui-'))
  const cwdA = join(dir, 'proj-a')
  const cwdB = join(dir, 'proj-b')
  const aId = roomIdFor(cwdA)
  const bId = roomIdFor(cwdB)
  const storeA = roomStore(dir, cwdA)
  const storeB = roomStore(dir, cwdB)
  const { root, child, candidate, contra } = seed(storeA, aId)
  storeB.put({
    title: 'B only',
    body: 'Must not leak into A graph.',
    authority: AUTHORITIES.DERIVED,
    projectId: bId,
  })

  const payload = buildGraphPayload({
    projectStore: storeA, id: root.id, hops: 1, cwd: cwdA, projectId: aId,
  })
  assert.equal(payload.ok, true)
  assert.equal(payload.view, 'local')
  assert.equal(payload.hops, 1)
  assert.equal(payload.center.id, root.id)
  assert.ok(payload.nodes.some((n) => n.id === child.id && n.trusted === true && n.mark.trusted === true))
  const cand = payload.nodes.find((n) => n.id === candidate.id)
  assert.equal(cand.trusted, false)
  assert.equal(cand.mark.inspectOnly, true)
  assert.ok(payload.edges.some((e) => e.type === RELATIONS.CONTRADICTS && e.fromId === contra.id))
  assert.ok(payload.nodes.every((n) => n.projectId === aId))
  assert.ok(!payload.nodes.some((n) => n.title.includes('B only')))

  const missing = buildGraphPayload({ projectStore: storeA, id: 'vey_missing' })
  assert.equal(missing.ok, false)

  closeAllStores()
  rmSync(dir, { recursive: true, force: true })
})

test('overview payload is the bounded projection with presentation marks', () => {
  const dir = mkdtempSync(join(tmpdir(), 'veyra-ovp-'))
  const cwd = join(dir, 'ws')
  const projectId = roomIdFor(cwd)
  const store = roomStore(dir, cwd)
  const { root, child, candidate, contra } = seed(store, projectId)

  const payload = buildOverviewPayload({ projectStore: store, cwd, projectId })
  assert.equal(payload.ok, true)
  assert.equal(payload.view, 'overview')
  assert.equal(payload.center, null)
  assert.equal(payload.empty, false)
  assert.equal(payload.projectId, projectId)
  assert.ok(payload.nodes.length >= 4)
  assert.ok(payload.nodes.every((n) => n.mark && n.mark.selected === false))
  assert.equal(payload.nodes.find((n) => n.id === candidate.id).mark.inspectOnly, true)
  assert.equal(payload.nodes.find((n) => n.id === child.id).mark.trusted, true)
  assert.ok(payload.edges.some((e) => e.type === RELATIONS.CONTRADICTS && e.fromId === contra.id))
  assert.ok(payload.nodes.some((n) => n.id === root.id && n.mark.historical === false))

  const fresh = mkdtempSync(join(tmpdir(), 'veyra-ovp-empty-'))
  const freshCwd = join(fresh, 'ws')
  const freshStore = roomStore(fresh, freshCwd)
  const empty = buildOverviewPayload({ projectStore: freshStore, cwd: freshCwd, projectId: roomIdFor(freshCwd) })
  assert.equal(empty.ok, true)
  assert.equal(empty.empty, true)
  assert.deepEqual(empty.nodes, [])
  assert.deepEqual(empty.edges, [])

  closeAllStores()
  rmSync(dir, { recursive: true, force: true })
  rmSync(fresh, { recursive: true, force: true })
})

test('GET /veyra/graph without id serves the overview; empty workspace stays honest', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'veyra-http-ov-'))
  const cwd = join(dir, 'ws')
  const freshCwd = join(dir, 'fresh-ws')
  const projectId = roomIdFor(cwd)
  const store = roomStore(dir, cwd)
  const { root, child, contra } = seed(store, projectId)
  // Both cwds must be registry workspaces: the resolver has no path fallback, so an
  // unregistered path fails closed with 409 instead of opening a room.
  const runtime = testRuntime(dir, cwd, { paths: [cwd, freshCwd] })

  const ov = await (async () => {
    const { req, res, done } = mockReqRes(`/veyra/graph?cwd=${encodeURIComponent(cwd)}`)
    handleVeyraHttp(runtime, req, res)
    return done
  })()
  const body = JSON.parse(ov.body)
  assert.equal(ov.status, 200)
  assert.equal(body.view, 'overview')
  assert.equal(body.center, null)
  assert.ok(body.nodes.some((n) => n.id === root.id))
  assert.ok(body.nodes.some((n) => n.id === child.id))
  assert.ok(body.edges.some((e) => e.type === RELATIONS.CONTRADICTS && e.fromId === contra.id))
  assert.ok(body.nodes.every((n) => n.mark))

  const missing = await (async () => {
    const { req, res, done } = mockReqRes(`/veyra/graph?id=vey_nope&cwd=${encodeURIComponent(cwd)}`)
    handleVeyraHttp(runtime, req, res)
    return done
  })()
  assert.equal(missing.status, 404)
  assert.equal(JSON.parse(missing.body).ok, false)

  const emptyRes = await (async () => {
    const { req, res, done } = mockReqRes(`/veyra/graph?cwd=${encodeURIComponent(freshCwd)}`)
    handleVeyraHttp(runtime, req, res)
    return done
  })()
  const emptyBody = JSON.parse(emptyRes.body)
  assert.equal(emptyRes.status, 200)
  assert.equal(emptyBody.ok, true)
  assert.equal(emptyBody.empty, true)
  assert.equal(emptyBody.nodes.length, 0)
  assert.equal(emptyBody.edges.length, 0)

  closeAllStores()
  rmSync(dir, { recursive: true, force: true })
})

test('HTTP GET /veyra serves page; /graph /record /search stay read-only and isolated', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'veyra-http-'))
  const cwd = join(dir, 'ws')
  const projectId = roomIdFor(cwd)
  const store = roomStore(dir, cwd)
  const { root, child } = seed(store, projectId)
  const runtime = testRuntime(dir, cwd)

  // Task 36: /veyra HTML page is served (client resolves cwd and shows unavailable state
  // when cwd is absent). API data endpoints fail closed without authoritative cwd.
  const noCwdPage = await (async () => {
    const { req, res, done } = mockReqRes('/veyra')
    handleVeyraHttp(runtime, req, res)
    return done
  })()
  assert.equal(noCwdPage.status, 200)
  assert.match(noCwdPage.headers['content-type'], /text\/html/)
  assert.match(noCwdPage.body, /Veyra Network Graph/)

  const page = await (async () => {
    const { req, res, done } = mockReqRes(`/veyra?cwd=${encodeURIComponent(cwd)}`)
    handleVeyraHttp(runtime, req, res)
    return done
  })()
  assert.equal(page.status, 200)
  assert.match(page.headers['content-type'], /text\/html/)
  assert.match(page.body, /Veyra Network Graph/)
  assert.match(page.body, /Visible ≠ trusted/)
  assert.match(graphPage(), /contradicts/)
  // page ships the interaction + state surface, not a static demo
  assert.match(page.body, /id="loading"/)
  assert.match(page.body, /id="tip"/)
  assert.match(page.body, /id="overview"/)
  assert.match(page.body, /function loadOverview/)
  assert.match(page.body, /function hoverNode/)
  assert.match(page.body, /function fitView/)
  assert.match(page.body, /Retry/)
  assert.match(page.body, /WORKSPACE_CONTEXT_UNAVAILABLE/)
  assert.match(page.body, /never falls back to the plugin startup directory/)
  assert.match(page.body, /never uses sessionId as workspace proof/)

  const graph = await (async () => {
    const { req, res, done } = mockReqRes(`/veyra/graph?id=${root.id}&cwd=${encodeURIComponent(cwd)}`)
    handleVeyraHttp(runtime, req, res)
    return done
  })()
  const g = JSON.parse(graph.body)
  assert.equal(graph.status, 200)
  assert.equal(g.ok, true)
  assert.equal(g.hops, 1)
  assert.ok(g.nodes.some((n) => n.id === child.id))

  const other = await (async () => {
    const { req, res, done } = mockReqRes(`/veyra/graph?id=${root.id}&cwd=${encodeURIComponent(join(dir, 'other'))}`)
    handleVeyraHttp(runtime, req, res)
    return done
  })()
  const leaked = JSON.parse(other.body)
  assert.equal(leaked.ok, false)
  assert.equal(leaked.nodes.length, 0)

  const rec = await (async () => {
    const { req, res, done } = mockReqRes(`/veyra/record?id=${root.id}&cwd=${encodeURIComponent(cwd)}`)
    handleVeyraHttp(runtime, req, res)
    return done
  })()
  assert.equal(JSON.parse(rec.body).record.id, root.id)

  const search = await (async () => {
    const { req, res, done } = mockReqRes(`/veyra/search?q=FTS5&cwd=${encodeURIComponent(cwd)}`)
    handleVeyraHttp(runtime, req, res)
    return done
  })()
  assert.ok(JSON.parse(search.body).hits.some((h) => h.id === child.id))

  const post = await (async () => {
    const { req, res, done } = mockReqRes(`/veyra/graph?cwd=${encodeURIComponent(cwd)}`, 'POST')
    handleVeyraHttp(runtime, req, res)
    return done
  })()
  assert.equal(post.status, 405)

  // Task 36: sessionId cannot be used to retrieve workspace data when cwd missing.
  const sessionIdProbe = await (async () => {
    const { req, res, done } = mockReqRes(`/veyra/graph?id=${root.id}&sessionId=s-attacker-owned`)
    handleVeyraHttp(runtime, req, res)
    return done
  })()
  assert.equal(sessionIdProbe.status, 409)
  assert.equal(JSON.parse(sessionIdProbe.body).code, WORKSPACE_CONTEXT_UNAVAILABLE)

  closeAllStores()
  rmSync(dir, { recursive: true, force: true })
})

test('plugin registers /veyra HTTP prefix when webServer exists; slash graph still text', () => {
  const dir = mkdtempSync(join(tmpdir(), 'veyra-reg-'))
  const routes = []
  const ctx = {
    tools: { register() {} },
    commands: { register() {} },
    skills: { register() {}, registerProvider() { return () => {} } },
    systemPrompt: { section() {}, context() {} },
    on() {},
    effect: (fn) => fn(),
    webServer: {
      register(route) {
        routes.push(route)
        return () => {}
      },
    },
  }
  const dispose = apply(ctx, { home: dir, observe: false })
  assert.ok(routes.some((r) => r.kind === 'prefix' && r.path === '/veyra'))
  assert.equal(registerWebUi({ webServer: { register(r) { routes.push(r); return () => {} } } }, { log: { info() {} } }), true)
  dispose?.()

  const cwd = join(dir, 'ws')
  const runtime = testRuntime(dir, cwd)
  const invocation = { agent: { session: { header: { cwd } } } }
  const store = roomStore(dir, cwd)
  const { root, child } = seed(store, roomIdFor(cwd))
  const graph = handleVeyraCommand(runtime, { ...invocation, rawInput: `observatory graph ${root.id}` })
  assert.equal(graph.kind, 'success')
  assert.ok(graph.text.includes('VEYRA OBSERVATORY — LOCAL GRAPH'))
  assert.ok(graph.text.includes(child.id))
  assert.ok(graph.text.includes(`/veyra?id=${root.id}&cwd=`))

  closeAllStores()
  rmSync(dir, { recursive: true, force: true })
})


test('Task 36: cwdFromRequest fails closed (no silent startup/fallback cwd)', () => {
  const runtime = { veyraHome: '/tmp/vh', fallbackCwd: '/tmp/startup-should-never-leak' }
  assert.equal(cwdFromRequest({ url: '/veyra/graph' }, runtime), null)
  assert.equal(cwdFromRequest({ url: '/veyra/graph?sessionId=s1' }, runtime), null)
  assert.equal(cwdFromRequest({ url: '/veyra/graph?cwd=' }, runtime), null)
  assert.equal(cwdFromRequest({ url: '/veyra/graph?cwd=%20' }, runtime), null)
  const ok = cwdFromRequest({ url: `/veyra/graph?cwd=${encodeURIComponent('/work/ws')}` }, runtime)
  assert.equal(ok, join('/work/ws'))
  // Explicit opt-in only (not used by graph HTTP handlers).
  assert.equal(cwdFromRequest({ url: '/veyra/graph' }, runtime, { allowFallback: true }), '/tmp/startup-should-never-leak')
})

test('Task 36: workspace isolation — A/B records, switch A->B->A, reusable scoped, no silent cross-workspace leak', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'veyra-wsiso-'))
  const cwdA = join(dir, 'workspace-a')
  const cwdB = join(dir, 'workspace-b')
  const pidA = roomIdFor(cwdA)
  const pidB = roomIdFor(cwdB)
  // Identity now comes from the workspace registry, so two registered workspaces are
  // two rooms even when their paths look alike. Distinct rooms must stay distinct.
  assert.notEqual(pidA, pidB, 'distinct registered workspaces must resolve to distinct room ids')

  const storeA = roomStore(dir, cwdA)
  const storeB = roomStore(dir, cwdB)
  const recA = storeA.put({
    title: 'Workspace A sqlite fix', body: 'A-only WAL fix evidence',
    authority: AUTHORITIES.DERIVED, validation: VALIDATIONS.VERIFIED, projectId: pidA,
  }).record
  const recB = storeB.put({
    title: 'Workspace B css theme', body: 'B-only theme token evidence',
    authority: AUTHORITIES.DERIVED, validation: VALIDATIONS.VERIFIED, projectId: pidB,
  }).record
  // Reusable memory is a separate store (correctly scoped/shared by design at store level,
  // but graph endpoints are project-scoped by cwd/projectId; records appear only when queried
  // through that store context). Put a project-linked record in each to prove project isolation.
  const runtime = testRuntime(dir, cwdA, { paths: [cwdA, cwdB] })

  async function get(path) {
    const { req, res, done } = mockReqRes(path)
    handleVeyraHttp(runtime, req, res)
    const out = await done
    return { status: out.status, body: JSON.parse(out.body) }
  }

  // 1) Workspace A displays Project A records.
  const a1 = await get(`/veyra/graph?id=${recA.id}&cwd=${encodeURIComponent(cwdA)}`)
  assert.equal(a1.status, 200)
  assert.equal(a1.body.ok, true)
  assert.equal(a1.body.projectId, pidA)
  assert.ok(a1.body.nodes.some((n) => n.id === recA.id && n.projectId === pidA))
  assert.ok(!a1.body.nodes.some((n) => n.id === recB.id || n.title.includes('Workspace B')))

  // 2) Workspace B displays Project B records.
  const b1 = await get(`/veyra/graph?id=${recB.id}&cwd=${encodeURIComponent(cwdB)}`)
  assert.equal(b1.status, 200)
  assert.equal(b1.body.ok, true)
  assert.equal(b1.body.projectId, pidB)
  assert.ok(b1.body.nodes.some((n) => n.id === recB.id && n.projectId === pidB))
  assert.ok(!b1.body.nodes.some((n) => n.id === recA.id || n.title.includes('Workspace A')))

  // 3) Switching A -> B updates graph context (different cwd request).
  const switchB = await get(`/veyra/graph?cwd=${encodeURIComponent(cwdB)}`)
  assert.equal(switchB.body.projectId, pidB)
  assert.ok(switchB.body.nodes.some((n) => n.id === recB.id))
  assert.ok(!switchB.body.nodes.some((n) => n.id === recA.id))

  // 4) Returning B -> A restores Project A.
  const backA = await get(`/veyra/graph?cwd=${encodeURIComponent(cwdA)}`)
  assert.equal(backA.body.projectId, pidA)
  assert.ok(backA.body.nodes.some((n) => n.id === recA.id))
  assert.ok(!backA.body.nodes.some((n) => n.id === recB.id))

  // 7) Missing/invalid workspace context does not silently display another workspace's graph.
  for (const path of ['/veyra/graph', '/veyra/graph?sessionId=s1', `/veyra/graph?id=${recA.id}`, `/veyra/record?id=${recA.id}`, '/veyra/search?q=sqlite']) {
    const bad = await get(path)
    assert.equal(bad.status, 409, `missing cwd must fail closed for ${path}`)
    assert.equal(bad.body.code, WORKSPACE_CONTEXT_UNAVAILABLE)
    assert.ok(!String(bad.body.error || '').includes('Workspace A') && !String(bad.body.error || '').includes('Workspace B'))
  }

  // 8) Session IDs cannot be used to retrieve an unrelated workspace's data.
  const spoof = await get(`/veyra/graph?id=${recA.id}&sessionId=s-other&cwd=${encodeURIComponent(cwdB)}`)
  assert.equal(spoof.status, 404, 'authoritative cwd B must not expose A record even if sessionId supplied')
  assert.equal(spoof.body.ok, false)

  // Cross-workspace search isolation.
  const searchA = await get(`/veyra/search?q=sqlite&cwd=${encodeURIComponent(cwdA)}`)
  assert.ok(searchA.body.hits.some((h) => h.id === recA.id))
  assert.ok(!searchA.body.hits.some((h) => h.id === recB.id))
  const searchB = await get(`/veyra/search?q=theme&cwd=${encodeURIComponent(cwdB)}`)
  assert.ok(searchB.body.hits.some((h) => h.id === recB.id))
  assert.ok(!searchB.body.hits.some((h) => h.id === recA.id))

  closeAllStores()
  rmSync(dir, { recursive: true, force: true })
})

test('Task 36: same repository root follows existing project identity rules', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'veyra-sameroot-'))
  // Identity is now the workspace room registered for a canonical path, not a hash of the
  // cwd string: one repository root keeps ONE room id however its path is spelled, while a
  // different registered path is a different room.
  const cwd1 = join(dir, 'repo-root')
  const cwd2 = cwd1 // same root, spelled without a trailing separator
  assert.equal(roomIdFor(cwd1), roomIdFor(cwd2), 'one canonical path must map to one room')
  assert.equal(roomIdFor(cwd1), roomIdFor(join(cwd1, '.')), 'path normalization must not fork the room')
  const otherRoot = join(dir, 'repo-other')
  assert.notEqual(roomIdFor(cwd1), roomIdFor(otherRoot), 'a distinct registered path is a distinct room')
  const pid = roomIdFor(cwd1)
  const store = roomStore(dir, cwd1)
  const rec = store.put({
    title: 'Same root record', body: 'shared project identity',
    authority: AUTHORITIES.DERIVED, projectId: pid,
  }).record
  const runtime = testRuntime(dir, cwd1)
  async function get(path) {
    const { req, res, done } = mockReqRes(path)
    handleVeyraHttp(runtime, req, res)
    return JSON.parse((await done).body)
  }
  const g1 = await get(`/veyra/graph?id=${rec.id}&cwd=${encodeURIComponent(cwd1)}`)
  const g2 = await get(`/veyra/graph?id=${rec.id}&cwd=${encodeURIComponent(cwd2 + '/')}`)
  assert.equal(g1.ok, true)
  assert.equal(g2.ok, true)
  assert.equal(g1.projectId, pid)
  assert.equal(g2.projectId, pid)

  // Also verify path normalization: cwdFromRequest resolves cwd.
  const runtime2 = { veyraHome: dir, fallbackCwd: '/nope' }
  const norm = cwdFromRequest({ url: `/veyra/graph?cwd=${encodeURIComponent(cwd1 + '/')}` }, runtime2)
  assert.ok(norm)
  closeAllStores()
  rmSync(dir, { recursive: true, force: true })
})

test('Task 36: reusable records remain correctly scoped (project store isolation, reusable store separate)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'veyra-reusable-'))
  const cwdA = join(dir, 'wa')
  const cwdB = join(dir, 'wb')
  const pidA = roomIdFor(cwdA)
  const pidB = roomIdFor(cwdB)
  const storeA = roomStore(dir, cwdA)
  const storeB = roomStore(dir, cwdB)
  storeA.put({ title: 'A only reusable-ish project record', authority: AUTHORITIES.DERIVED, projectId: pidA })
  storeB.put({ title: 'B only project record', authority: AUTHORITIES.DERIVED, projectId: pidB })
  const runtime = testRuntime(dir, cwdA, { paths: [cwdA, cwdB] })
  async function overview(cwd) {
    const { req, res, done } = mockReqRes(`/veyra/graph?cwd=${encodeURIComponent(cwd)}`)
    handleVeyraHttp(runtime, req, res)
    return JSON.parse((await done).body)
  }
  const oa = await overview(cwdA)
  const ob = await overview(cwdB)
  assert.ok(oa.nodes.some((n) => /A only/.test(n.title)))
  assert.ok(!oa.nodes.some((n) => /B only/.test(n.title)))
  assert.ok(ob.nodes.some((n) => /B only/.test(n.title)))
  assert.ok(!ob.nodes.some((n) => /A only/.test(n.title)))
  closeAllStores()
  rmSync(dir, { recursive: true, force: true })
})

test('Task 36.1: forged/unrelated/nonexistent/unauthorized cwd cannot leak other workspace data; server ownership verification unavailable via DSH handler contract', async () => {
  // Security contract (DSH 0.2.2-rc.1, Veyra /veyra prefix handler):
  // - handleVeyraHttp receives only (runtime, req, res); no per-request session/
  //   workspace/requester identity is provided by the web handler contract.
  // - Veyra does not inject ctx.workspaceRegistry/workspaceController and no DSH
  //   API was found that binds an HTTP request to authoritative workspace ownership.
  // - Therefore server CANNOT verify that an explicit cwd query parameter belongs to
  //   the requester's active DSH workspace/session. Veyra must not invent a DSH API.
  // - Missing cwd fails closed (409 WORKSPACE_CONTEXT_UNAVAILABLE). An explicit cwd is
  //   resolved against the workspace registry and opens only that workspace's room;
  //   a cwd that is not a registered workspace fails closed with the same 409 instead
  //   of opening a path-derived store. It never silently returns another workspace's
  //   project data.
  const dir = mkdtempSync(join(tmpdir(), 'veyra-36-1-'))
  const cwdA = join(dir, 'authorized-a')
  const cwdB = join(dir, 'authorized-b')
  const pidA = roomIdFor(cwdA)
  const pidB = roomIdFor(cwdB)
  const storeA = roomStore(dir, cwdA)
  const storeB = roomStore(dir, cwdB)
  const recA = storeA.put({ title: 'A secret marker', body: 'A-only', authority: AUTHORITIES.DERIVED, validation: VALIDATIONS.VERIFIED, projectId: pidA }).record
  const recB = storeB.put({ title: 'B secret marker', body: 'B-only', authority: AUTHORITIES.DERIVED, validation: VALIDATIONS.VERIFIED, projectId: pidB }).record
  // Only A and B are registered workspaces; every other cwd below is unregistered.
  const runtime = testRuntime(dir, cwdA, { paths: [cwdA, cwdB] })

  async function get(path) {
    const { req, res, done } = mockReqRes(path)
    handleVeyraHttp(runtime, req, res)
    const out = await done
    let body
    try { body = JSON.parse(out.body) } catch { body = { raw: out.body } }
    return { status: out.status, body }
  }
  function assertNoCrossLeak(body) {
    const text = JSON.stringify(body)
    assert.ok(!text.includes(recA.id), 'must not leak workspace A record id')
    assert.ok(!text.includes(recB.id), 'must not leak workspace B record id')
    assert.ok(!text.includes('A secret marker'), 'must not leak workspace A marker')
    assert.ok(!text.includes('B secret marker'), 'must not leak workspace B marker')
  }

  // Unrelated cwd (not A/B): unregistered, so it resolves to no room and fails closed
  // instead of opening a path-derived store of its own.
  const unrelated = join(dir, 'unrelated-forged-workspace')
  assert.notEqual(roomIdFor(unrelated), pidA)
  assert.notEqual(roomIdFor(unrelated), pidB)
  for (const path of [
    `/veyra/graph?cwd=${encodeURIComponent(unrelated)}`,
    `/veyra/graph?id=${recA.id}&cwd=${encodeURIComponent(unrelated)}`,
    `/veyra/search?q=secret&cwd=${encodeURIComponent(unrelated)}`,
    `/veyra/record?id=${recA.id}&cwd=${encodeURIComponent(unrelated)}`,
  ]) {
    const r = await get(path)
    assertNoCrossLeak(r.body)
    // Meaning changed: the old path-derived rule served 200 for any cwd; the room rule
    // has no path fallback, so an unregistered cwd is unavailable rather than scoped.
    assert.equal(r.status, 409)
    assert.equal(r.body.code, WORKSPACE_CONTEXT_UNAVAILABLE)
  }

  // Nonexistent cwd: not a registered workspace, so the room cannot be resolved and the
  // handler fails closed. Must not leak A/B data.
  const nonexistent = join(dir, 'does-not-exist', 'forged', 'path')
  const n1 = await get(`/veyra/graph?cwd=${encodeURIComponent(nonexistent)}`)
  assert.equal(n1.status, 409)
  assert.equal(n1.body.code, WORKSPACE_CONTEXT_UNAVAILABLE)
  assertNoCrossLeak(n1.body)
  const n2 = await get(`/veyra/graph?id=${recB.id}&cwd=${encodeURIComponent(nonexistent)}`)
  assert.equal(n2.status, 409)
  assert.equal(n2.body.code, WORKSPACE_CONTEXT_UNAVAILABLE)
  assertNoCrossLeak(n2.body)

  // Forged cwd targeting startup/internal-like path: no fallback-to-startup leak, no A/B
  // leak, and no room to scope to because the path is not a registered workspace.
  const forgedStartupLike = '/tmp/startup-must-not-appear'
  const f1 = await get(`/veyra/graph?cwd=${encodeURIComponent(forgedStartupLike)}`)
  assert.equal(f1.status, 409)
  assert.equal(f1.body.code, WORKSPACE_CONTEXT_UNAVAILABLE)
  assertNoCrossLeak(f1.body)
  const f2 = await get(`/veyra/search?q=A+secret&cwd=${encodeURIComponent(forgedStartupLike)}`)
  assert.equal(f2.status, 409)
  assertNoCrossLeak(f2.body)

  // Unauthorized/arbitrary cwd: the registry is the authority, so a path nobody registered
  // has no room at all — fail closed rather than open a store derived from the cwd string.
  const unauthorized = join(dir, 'somebody-elses-workspace')
  const ua = await get(`/veyra/graph?cwd=${encodeURIComponent(unauthorized)}&sessionId=attacker`)
  assert.equal(ua.status, 409)
  assert.equal(ua.body.code, WORKSPACE_CONTEXT_UNAVAILABLE)
  assertNoCrossLeak(ua.body)
  const ua2 = await get(`/veyra/record?id=${recA.id}&cwd=${encodeURIComponent(unauthorized)}`)
  assert.equal(ua2.status, 409)
  assertNoCrossLeak(ua2.body)

  // Missing cwd remains fail-closed regardless of forged/attacker sessionId.
  for (const path of ['/veyra/graph', `/veyra/graph?sessionId=${encodeURIComponent(unauthorized)}`, '/veyra/record?id=vey_fake']) {
    const missing = await get(path)
    assert.equal(missing.status, 409)
    assert.equal(missing.body.code, WORKSPACE_CONTEXT_UNAVAILABLE)
    assertNoCrossLeak(missing.body)
  }

  // Preserve normal Workspace A/B isolation and same-repo identity behavior.
  const a = await get(`/veyra/graph?id=${recA.id}&cwd=${encodeURIComponent(cwdA)}`)
  const b = await get(`/veyra/graph?id=${recB.id}&cwd=${encodeURIComponent(cwdB)}`)
  assert.equal(a.status, 200)
  assert.equal(b.status, 200)
  assert.equal(a.body.projectId, pidA)
  assert.equal(b.body.projectId, pidB)
  assert.ok(a.body.nodes.some((n) => n.id === recA.id))
  assert.ok(!a.body.nodes.some((n) => n.id === recB.id))
  assert.ok(b.body.nodes.some((n) => n.id === recB.id))
  assert.ok(!b.body.nodes.some((n) => n.id === recA.id))
  // Identity is registry/room based now: path spelling must not fork a room, and two
  // separately registered workspaces must remain two distinct rooms.
  assert.equal(roomIdFor(cwdA), roomIdFor(join(cwdA, '.')))
  assert.notEqual(roomIdFor(cwdA), roomIdFor(cwdB))

  closeAllStores()
  rmSync(dir, { recursive: true, force: true })
})
