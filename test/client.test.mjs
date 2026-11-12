/**
 * Client (browser half) contract test. Loads client.js in a sandbox the way
 * window.__ModuleLoader__ does.
 * Task 35: Settings UI removed, Network Graph tab remains.
 * Task 35.1: DSH 0.2.2-rc.1 sidebar registration contract.
 * Task 35.7: bottom-left sidebar.footer.action shortcut removed.
 * Task 36: workspace isolation — iframe uses authoritative cwd from DSH
 * workspaces.list (WorkspaceView.path/sessionIds), never sessionId as proof,
 * fails closed when workspace context unavailable.
 * Task 37: the tab is a 'session'-scoped keyed seat, so it receives its own
 * sessionId from the ui-session BUILTIN_SOURCE prop roster; that session is
 * mapped through workspaces.list to its workspace row, so two sessions in two
 * workspaces each get their own graph, regardless of which is active.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'

function loadDefinition() {
  const src = readFileSync(new URL('../client.js', import.meta.url), 'utf8')
  let definition
  const sandbox = {
    window: { __ModuleLoader__: { load: (d) => { definition = d } } },
    console,
  }
  vm.runInNewContext(src, sandbox, { filename: 'client.js' })
  assert.ok(definition, 'client.js called __ModuleLoader__.load')
  return definition
}

function makeReact(state) {
  return {
    createElement: (type, props, ...children) => ({
      type,
      props: props || {},
      children: children.flat().filter((c) => c !== null && c !== undefined && c !== false),
    }),
    useState: (init) => {
      const i = state.stateIdx++
      if (!Object.hasOwn(state.seed, i)) state.seed[i] = typeof init === 'function' ? init() : init
      return [state.seed[i], (v) => { state.seed[i] = v }]
    },
    useEffect: (fn) => {
      // In this harness, effects run immediately so initial sync is testable.
      const cleanup = fn()
      if (typeof cleanup === 'function') state.cleanups.push(cleanup)
    },
    Fragment: 'Fragment',
  }
}

function makeWorkspacesFace({ items = [], snapshot } = {}) {
  let snap = snapshot || { items, archivedSessionIds: [], pinnedSessionIds: [], state: 'idle', phase: 'ready', error: null }
  const listeners = new Set()
  // Shape mirrors the real IWorkspaces face: only `list` (plus imperative
  // methods). There is no `active` member on the real service, so the fake must
  // not grow one either.
  return {
    list: {
      getSnapshot: () => snap,
      subscribe: (fn) => { listeners.add(fn); return () => listeners.delete(fn) },
    },
    _setSnapshot(next) { snap = next; for (const fn of listeners) fn() },
    _listeners: listeners,
  }
}

function setup({
  workspaceItems = null,
  workspacesFace = null,
  deferSidebarTabs = false,
  noSidebarTabs = false,
} = {}) {
  const definition = loadDefinition()
  const state = {
    stateIdx: 0, seed: {}, cleanups: [], disposers: [],
    slotInjected: [], slotRegistered: [], tabDefs: [], ctxInjects: [], rootSlotInjected: [],
  }
  const face = workspacesFace || (workspaceItems !== null
    ? makeWorkspacesFace({ items: workspaceItems })
    : null)
  const scopeBase = {
    slots: {
      inject: (name, factory) => { state.slotInjected.push(name); const off = factory(scopeBase); return off },
      register: (meta, render) => { state.slotRegistered.push({ meta, render, scope: 'deferred' }); return () => {} },
    },
    sidebarRightTabs: { register: (def) => { state.tabDefs.push(def); return () => {} } },
    sidebarRight: {},
    workspaces: face,
  }
  const ctx = {
    slots: {
      inject: (name, factory) => { state.rootSlotInjected.push(name); const off = factory(ctx); return off },
      register: (meta, render) => { state.slotRegistered.push({ meta, render, scope: 'root' }); return () => {} },
    },
    // DSH 0.2.x/Cordis deferred inject: ctx.inject(deps, cb) calls cb(scope).
    inject: (names, cb) => {
      state.ctxInjects.push(names)
      if (deferSidebarTabs && names.join(',') === 'sidebarRightTabs') return undefined
      if (noSidebarTabs && names.join(',') === 'sidebarRightTabs') {
        const scope = { ...scopeBase, sidebarRightTabs: undefined }
        if (typeof cb === 'function') return cb(scope)
        return undefined
      }
      const scope = { ...scopeBase }
      if (typeof cb === 'function') return cb(scope)
      return undefined
    },
  }
  const mod = definition.factory((id) => {
    if (id === 'react') return makeReact(state)
    throw new Error(`unexpected require(${id})`)
  })
  mod.apply(ctx)
  return { mod, state, scopeBase, ctx, workspacesFace: face }
}

function findNode(node, pred) {
  if (!node) return null
  if (pred(node)) return node
  for (const c of node.children || []) { const hit = findNode(c, pred); if (hit) return hit }
  return null
}

function renderTabBody(state, props) {
  const reg = state.slotRegistered.find((r) => r.meta?.key === 'veyra-network-graph' && r.meta?.name === 'sidebar.right.pane.tab')
  assert.ok(reg, 'tab body slot registration must exist')
  return reg.render(props)
}

test('client bundle exports/inject: Settings UI removed, Network Graph tab remains (no footer button)', () => {
  const def = loadDefinition()
  const mod = def.factory((id) => {
    if (id === 'react') return makeReact({ stateIdx: 0, seed: {}, cleanups: [] })
    throw new Error(`unexpected require(${id})`)
  })
  assert.deepStrictEqual(Array.from(mod.inject), ['slots'])
  assert.equal(typeof mod.apply, 'function')
  for (const removed of ['VeyraSettings', 'ENTRY_ID', 'SECTION_ID', 'normalizeRecallLimit', 'NetworkGraphFooterAction']) {
    assert.equal(mod[removed], undefined, `${removed} must not be exported`)
  }
  assert.equal(typeof mod.networkGraphTabDefinition, 'function')
  assert.equal(typeof mod.NetworkGraphTabBody, 'function')
  assert.equal(typeof mod.__resolveActiveWorkspaceCwd, 'function', 'Task 36 resolver seam')
})

test('package.json dsh.client.inject names only real client-plugin rows (activation regression)', () => {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
  assert.ok(!pkg.dsh.client.inject.includes('@deepseek-ai/dsh-client-ui-settings'))
  // Deps are package-name edges between dsh.client rows, so every entry must be a
  // package that itself declares dsh.client. `dsh-client-ui-slots` is a baseline
  // module (resolved by the frontend module map), not a client-plugin row, so it
  // can never satisfy the edge.
  assert.deepStrictEqual(pkg.dsh.client.inject, [
    '@deepseek-ai/dsh-client-ui-sidebar-right',
    '@deepseek-ai/dsh-api-workspace-controller',
  ])
  for (const dep of pkg.dsh.client.inject) {
    assert.match(dep, /^@deepseek-ai\/dsh-/, `${dep} must be a bare DSH package name`)
  }
})

test('DSH 0.2.2-rc.1 registration: Network Graph tab deferred; bottom-left footer button removed (Task 35.7)', () => {
  const { state } = setup()
  // Footer shortcut button removed: no sidebar.footer.action registration.
  assert.ok(!state.rootSlotInjected.includes('sidebar.footer.action'), 'footer action must not be registered')
  assert.ok(!state.slotInjected.includes('sidebar.footer.action'), 'footer action must not be registered in deferred scope')
  assert.ok(!state.slotRegistered.some((r) => r.meta?.name === 'sidebar.footer.action'), 'footer action slot must not exist')

  // Tab type still deferred on sidebarRightTabs only.
  assert.ok(state.ctxInjects.some((n) => n.join(',') === 'sidebarRightTabs'))
  assert.ok(!state.ctxInjects.some((n) => n.join(',') === 'sidebarRightTabs,sidebarRight'), 'sidebarRight not needed after footer removal')
  assert.equal(state.tabDefs.length, 1)
  assert.equal(state.tabDefs[0].id, 'veyra-network-graph')
  assert.equal(state.tabDefs[0].kind, 'veyra-network-graph')
  assert.ok(Array.isArray(state.tabDefs[0].guide) && state.tabDefs[0].guide.length > 0)
  assert.equal(state.slotInjected.filter((n) => n === 'sidebar.right.pane.tab').length, 1)
  assert.equal(state.slotInjected.filter((n) => n === 'sidebar.right.pane.tab.title').length, 1)
  const body = state.slotRegistered.find((r) => r.meta?.name === 'sidebar.right.pane.tab')
  const title = state.slotRegistered.find((r) => r.meta?.name === 'sidebar.right.pane.tab.title')
  assert.ok(body && (body.meta.key === 'veyra-network-graph' || body.meta.id === 'veyra-network-graph'))
  assert.ok(title && (title.meta.key === 'veyra-network-graph' || title.meta.id === 'veyra-network-graph'))
})

test('Task 36: Network Graph iframe uses authoritative workspace cwd, not sessionId proof', () => {
  const cwdA = '/home/test/workspace-a'
  const { state } = setup({
    workspaceItems: [
      { workspaceId: 'ws-a', path: cwdA, title: 'A', sessionIds: ['s42'] },
    ],
  })
  const tree = renderTabBody(state, { sessionId: 's42' })
  const iframe = findNode(tree, (n) => n.type === 'iframe')
  assert.ok(iframe, 'tab body renders an iframe when authoritative cwd resolved')
  assert.match(iframe.props.src, /\/veyra\?mode=sidebar&cwd=/)
  assert.ok(iframe.props.src.includes(encodeURIComponent(cwdA)), 'iframe src carries authoritative workspace cwd')
  assert.ok(!iframe.props.src.includes('sessionId=s42'), 'sessionId must not be used as workspace proof in iframe URL')
})

test('Task 36: missing workspace context fails closed with explicit unavailable state (no fallback iframe)', () => {
  const { state } = setup({ workspaceItems: [] })
  const tree = renderTabBody(state, { sessionId: 's42' })
  const iframe = findNode(tree, (n) => n.type === 'iframe')
  assert.equal(iframe, null, 'no iframe when workspace cwd cannot be resolved')
  const unavailable = findNode(tree, (n) => n.props && n.props.className === 'veyra-graph-unavailable')
  assert.ok(unavailable, 'explicit unavailable state rendered')
})

test('Task 36: no active-workspace accessor exists, so the prop-less path fails closed', () => {
  const { mod } = setup({
    workspaceItems: [{ workspaceId: 'ws-a', path: '/work/a', sessionIds: ['s-a'] }],
  })
  // IWorkspaces exposes no active session: a face-shaped argument changes nothing.
  assert.equal(mod.__resolveActiveWorkspaceCwd(), '')
  assert.equal(mod.__resolveActiveWorkspaceCwd({
    active: { sessionId: 's-a' },
    list: { getSnapshot: () => ({ items: [{ workspaceId: 'ws-a', path: '/work/a', sessionIds: ['s-a'] }] }) },
  }), '', 'there is no active-session field to read, so this must stay empty')
})

test('Task 36: prop-less tab render fails closed even when a workspace row would match', () => {
  const { state } = setup({
    workspaceItems: [{ workspaceId: 'ws-a', path: '/project-a', sessionIds: ['sess-a'] }],
  })
  const tree = renderTabBody(state)
  assert.equal(findNode(tree, (n) => n.type === 'iframe'), null, 'no cwd can be resolved without the sessionId prop')
  assert.ok(findNode(tree, (n) => n.props && n.props.className === 'veyra-graph-unavailable'), 'explicit unavailable state rendered')
})

test('Task 36: resolver selects workspace A/B by authoritative mapping (switch evidence seam)', () => {
  const { mod } = setup()
  const items = [
    { workspaceId: 'ws-a', path: '/project-a', sessionIds: ['sess-a'] },
    { workspaceId: 'ws-b', path: '/project-b', sessionIds: ['sess-b'] },
  ]
  const list = { getSnapshot: () => ({ items }) }
  assert.equal(mod.__resolveWorkspaceCwdForSession('sess-a', { list }), '/project-a')
  assert.equal(mod.__resolveWorkspaceCwdForSession('sess-b', { list }), '/project-b')
  assert.equal(mod.__resolveWorkspaceCwdForSession('sess-a', { list }), '/project-a')
})

test('Task 37: each session-scoped tab resolves its OWN workspace cwd from the sessionId prop', () => {
  const items = [
    { workspaceId: 'ws-a', path: '/home/test/workspace-a', sessionIds: ['sess-a'] },
    { workspaceId: 'ws-b', path: '/home/test/workspace-b', sessionIds: ['sess-b'] },
  ]
  // Two sessions live in two different workspaces: each session-scoped keyed
  // seat must render ITS OWN graph, never a neighbour's.
  const tabB = setup({ workspaceItems: items })
  const iframeB = findNode(renderTabBody(tabB.state, { sessionId: 'sess-b' }), (n) => n.type === 'iframe')
  assert.ok(iframeB, 'session B tab renders an iframe')
  assert.ok(iframeB.props.src.includes(encodeURIComponent('/home/test/workspace-b')), 'session B gets workspace B cwd')
  assert.ok(!iframeB.props.src.includes(encodeURIComponent('/home/test/workspace-a')), 'session B never borrows another workspace cwd')
  assert.ok(!iframeB.props.src.includes('sess-b'), 'sessionId stays out of the iframe URL')

  const tabA = setup({ workspaceItems: items })
  const iframeA = findNode(renderTabBody(tabA.state, { sessionId: 'sess-a' }), (n) => n.type === 'iframe')
  assert.ok(iframeA, 'session A tab renders an iframe')
  assert.ok(iframeA.props.src.includes(encodeURIComponent('/home/test/workspace-a')), 'session A gets workspace A cwd')
})

test('Task 37: a session no workspace row claims fails closed', () => {
  const { state } = setup({
    workspaceItems: [{ workspaceId: 'ws-a', path: '/home/test/workspace-a', sessionIds: ['sess-a'] }],
  })
  const tree = renderTabBody(state, { sessionId: 'sess-orphan' })
  assert.equal(findNode(tree, (n) => n.type === 'iframe'), null, 'no iframe for an unmapped session')
  assert.ok(findNode(tree, (n) => n.props && n.props.className === 'veyra-graph-unavailable'), 'explicit unavailable state rendered')
})

test('Task 37: resolver maps a session-only lookup and refuses empty/unknown input', () => {
  const { mod } = setup()
  const list = {
    getSnapshot: () => ({
      items: [
        { workspaceId: 'ws-a', path: '/project-a', sessionIds: ['sess-a'] },
        { workspaceId: 'ws-b', path: '/project-b', sessionIds: ['sess-b'] },
      ],
    }),
  }
  const face = { list }
  assert.equal(mod.__resolveWorkspaceCwdForSession('sess-a', face), '/project-a')
  assert.equal(mod.__resolveWorkspaceCwdForSession('sess-b', face), '/project-b')
  assert.equal(mod.__resolveWorkspaceCwdForSession('sess-unknown', face), '')
  assert.equal(mod.__resolveWorkspaceCwdForSession('', face), '')
  assert.equal(mod.__resolveWorkspaceCwdForSession(undefined, face), '')
  assert.equal(mod.__resolveWorkspaceCwdForSession('sess-a', null), '', 'no workspaces face => fail closed')
})

test('client source has no bottom-left footer button registration or sessionId-as-cwd proof (Task 35.7/36 regression)', () => {
  const src = readFileSync(new URL('../client.js', import.meta.url), 'utf8')
  // No actual footer slot registration (comment mentions "footer shortcut button" removal are fine)
  assert.ok(!src.includes("name: 'sidebar.footer.action'"), 'must not register sidebar.footer.action slot meta')
  assert.ok(!src.includes("ctx.slots.inject('sidebar.footer.action'"), 'must not inject sidebar.footer.action')
  assert.ok(!src.includes('NetworkGraphFooterAction'), 'footer action component must be removed')
  assert.ok(!src.includes('sidebarRightFace'), 'footer-only openTab face must be removed')
  assert.ok(!src.includes('.openTab('), 'footer-only openTab call must be removed')
  // Task 36: authoritative cwd required; sessionId must not be passed as graph cwd/proof.
  assert.ok(src.includes('workspaces.list'), 'must resolve cwd from workspaces.list API')
  assert.ok(src.includes('cwd='), 'iframe URL must carry cwd parameter')
  assert.ok(!src.includes('graphUrlFor(currentSessionId())'), 'must not build iframe URL from sessionId alone')
  assert.ok(!src.includes('sessionId=${'), 'iframe URL must not carry sessionId as workspace proof')
  assert.ok(src.includes('Workspace context unavailable') || src.includes('workspace context unavailable'), 'must render explicit unavailable state')
  // Task 36 regression: IWorkspaces has no active-session accessor, so reading
  // one (or scanning for it) would silently fail closed forever.
  assert.ok(!src.includes('bestEffortActiveSessionId'), 'must not read a non-existent active-session shape')
  assert.ok(!/\.active\b(?!Session)/.test(src.replace(/archivedSessionIds|pinnedSessionIds/g, '')), 'must not read a `.active` member off the workspaces face')
  // Still valid: tab registration + /veyra iframe + no broken legacy patterns
  assert.ok(src.includes('sidebarRightTabs'), 'tab registration preserved')
  assert.ok(src.includes('/veyra?mode=sidebar'), 'iframe endpoint preserved')
  assert.ok(!src.includes('child.sidebarRightTabs'), 'must not assume fiber-as-scope child properties')
  assert.ok(!src.includes('child(() =>'), 'must not call inject result as child scope callback')
  assert.ok(!src.includes("tabs.register(GRAPH_TAB_ID, networkGraphTabDefinition(),"), 'must not use 3-arg register form')
  assert.ok(!src.includes('configForms'))
  assert.ok(!src.includes('settings.section'))
})
