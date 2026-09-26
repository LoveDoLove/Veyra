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
import { closeAllStores, openProjectStore } from '../src/store.mjs'
import { projectIdFor } from '../src/ids.mjs'
import { GRAPH_LIMITS } from '../src/graph.mjs'
import {
  buildGraphPayload,
  buildOverviewPayload,
  classifyNode,
  clampUiHops,
  graphPage,
  handleVeyraHttp,
  registerWebUi,
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
  const aId = projectIdFor(cwdA)
  const bId = projectIdFor(cwdB)
  const storeA = openProjectStore(dir, aId)
  const storeB = openProjectStore(dir, bId)
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
  const projectId = projectIdFor(cwd)
  const store = openProjectStore(dir, projectId)
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
  const freshStore = openProjectStore(fresh, projectIdFor(join(fresh, 'ws')))
  const empty = buildOverviewPayload({ projectStore: freshStore, cwd: join(fresh, 'ws'), projectId: projectIdFor(join(fresh, 'ws')) })
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
  const projectId = projectIdFor(cwd)
  const store = openProjectStore(dir, projectId)
  const { root, child, contra } = seed(store, projectId)
  const runtime = { veyraHome: dir, fallbackCwd: cwd }

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

  const freshCwd = join(dir, 'fresh-ws')
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
  const projectId = projectIdFor(cwd)
  const store = openProjectStore(dir, projectId)
  const { root, child } = seed(store, projectId)
  const runtime = { veyraHome: dir, fallbackCwd: cwd }

  const page = await (async () => {
    const { req, res, done } = mockReqRes('/veyra')
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
    const { req, res, done } = mockReqRes('/veyra/graph', 'POST')
    handleVeyraHttp(runtime, req, res)
    return done
  })()
  assert.equal(post.status, 405)

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
  const runtime = { veyraHome: dir, fallbackCwd: cwd }
  const invocation = { agent: { session: { header: { cwd } } } }
  const store = openProjectStore(dir, projectIdFor(cwd))
  const { root, child } = seed(store, projectIdFor(cwd))
  const graph = handleVeyraCommand(runtime, { ...invocation, rawInput: `observatory graph ${root.id}` })
  assert.equal(graph.kind, 'success')
  assert.ok(graph.text.includes('VEYRA OBSERVATORY — LOCAL GRAPH'))
  assert.ok(graph.text.includes(child.id))
  assert.ok(graph.text.includes(`/veyra?id=${root.id}&cwd=`))

  closeAllStores()
  rmSync(dir, { recursive: true, force: true })
})
