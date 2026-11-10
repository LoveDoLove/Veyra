/**
 * Client (browser half) contract test. Loads client.js in a sandbox the way
 * window.__ModuleLoader__ does.
 * Task 35: Settings UI removed, Network Graph tab remains.
 * Task 35.1: DSH 0.2.2-rc.1 sidebar registration contract.
 * Task 35.7: bottom-left sidebar.footer.action shortcut removed.
 * Task 36: workspace isolation — iframe uses authoritative cwd from DSH
 * workspaces.list (WorkspaceView.path/sessionIds), never sessionId as proof,
 * fails closed when workspace context unavailable.
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

function makeWorkspacesFace({ activeSessionId = '', items = [], snapshot } = {}) {
  let snap = snapshot || { items, archivedSessionIds: [], pinnedSessionIds: [], state: 'idle', phase: 'ready', error: null }
  const listeners = new Set()
  return {
    active: activeSessionId ? { sessionId: activeSessionId } : null,
    list: {
      getSnapshot: () => snap,
      subscribe: (fn) => { listeners.add(fn); return () => listeners.delete(fn) },
    },
    _setSnapshot(next) { snap = next; for (const fn of listeners) fn() },
    _listeners: listeners,
  }
}

function setup({
  activeSessionId = '',
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
  const face = workspacesFace || (activeSessionId || workspaceItems
    ? makeWorkspacesFace({ activeSessionId, items: workspaceItems || [] })
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

function renderTabBody(state) {
  const reg = state.slotRegistered.find((r) => r.meta?.key === 'veyra-network-graph' && r.meta?.name === 'sidebar.right.pane.tab')
  assert.ok(reg, 'tab body slot registration must exist')
  return reg.render()
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

test('package.json dsh.client.inject has no stale settings dependency (activation regression)', () => {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
  assert.ok(!pkg.dsh.client.inject.includes('@deepseek-ai/dsh-client-ui-settings'))
  assert.deepStrictEqual(pkg.dsh.client.inject, [
    '@deepseek-ai/dsh-client-ui-slots',
    '@deepseek-ai/dsh-client-ui-sidebar-right',
    '@deepseek-ai/dsh-api-workspace-controller',
  ])
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
    activeSessionId: 's42',
    workspaceItems: [
      { workspaceId: 'ws-a', path: cwdA, title: 'A', sessionIds: ['s42'] },
    ],
  })
  const tree = renderTabBody(state)
  const iframe = findNode(tree, (n) => n.type === 'iframe')
  assert.ok(iframe, 'tab body renders an iframe when authoritative cwd resolved')
  assert.match(iframe.props.src, /\/veyra\?mode=sidebar&cwd=/)
  assert.ok(iframe.props.src.includes(encodeURIComponent(cwdA)), 'iframe src carries authoritative workspace cwd')
  assert.ok(!iframe.props.src.includes('sessionId=s42'), 'sessionId must not be used as workspace proof in iframe URL')
})

test('Task 36: missing workspace context fails closed with explicit unavailable state (no fallback iframe)', () => {
  const { state } = setup({ activeSessionId: 's42', workspaceItems: [] })
  const tree = renderTabBody(state)
  const iframe = findNode(tree, (n) => n.type === 'iframe')
  assert.equal(iframe, null, 'no iframe when workspace cwd cannot be resolved')
  const unavailable = findNode(tree, (n) => n.props && n.props.className === 'veyra-graph-unavailable')
  assert.ok(unavailable, 'explicit unavailable state rendered')
})

test('Task 36: sessionId alone is never trusted as workspace proof', () => {
  const { mod } = setup()
  // Session maps to workspace B, but attacker-controlled caller should not be able
  // to select workspace A data by passing sessionId; resolver uses workspace list
  // mapping only and returns workspace B's path for that active session.
  const cwd = mod.__resolveActiveWorkspaceCwd({
    active: { sessionId: 's-b' },
    list: {
      getSnapshot: () => ({
        items: [
          { workspaceId: 'ws-a', path: '/work/a', sessionIds: ['s-a'] },
          { workspaceId: 'ws-b', path: '/work/b', sessionIds: ['s-b'] },
        ],
      }),
    },
  })
  assert.equal(cwd, '/work/b')
  // Unknown session => no cwd (fail closed), even if other workspaces exist.
  assert.equal(mod.__resolveActiveWorkspaceCwd({
    active: { sessionId: 's-x' },
    list: { getSnapshot: () => ({ items: [{ workspaceId: 'ws-a', path: '/work/a', sessionIds: ['s-a'] }] }) },
  }), '')
})

test('Task 36: resolver selects workspace A/B by authoritative mapping (switch evidence seam)', () => {
  const { mod } = setup()
  const items = [
    { workspaceId: 'ws-a', path: '/project-a', sessionIds: ['sess-a'] },
    { workspaceId: 'ws-b', path: '/project-b', sessionIds: ['sess-b'] },
  ]
  const list = { getSnapshot: () => ({ items }) }
  assert.equal(mod.__resolveActiveWorkspaceCwd({ active: { sessionId: 'sess-a' }, list }), '/project-a')
  assert.equal(mod.__resolveActiveWorkspaceCwd({ active: { sessionId: 'sess-b' }, list }), '/project-b')
  assert.equal(mod.__resolveActiveWorkspaceCwd({ active: { sessionId: 'sess-a' }, list }), '/project-a')
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
  // Still valid: tab registration + /veyra iframe + no broken legacy patterns
  assert.ok(src.includes('sidebarRightTabs'), 'tab registration preserved')
  assert.ok(src.includes('/veyra?mode=sidebar'), 'iframe endpoint preserved')
  assert.ok(!src.includes('child.sidebarRightTabs'), 'must not assume fiber-as-scope child properties')
  assert.ok(!src.includes('child(() =>'), 'must not call inject result as child scope callback')
  assert.ok(!src.includes("tabs.register(GRAPH_TAB_ID, networkGraphTabDefinition(),"), 'must not use 3-arg register form')
  assert.ok(!src.includes('configForms'))
  assert.ok(!src.includes('settings.section'))
})
