/**
 * Client (browser half) wiring test: loads client.js in a sandbox the way
 * window.__ModuleLoader__ does, then proves the DSH Settings seam:
 *   - settings.section registration (id/order/label)
 *   - whileServed watch on the `veyra` namespace
 *   - configForms reads/writes (recallLimit save, includeReusable toggle)
 *   - recall-limit normalization rejects invalid drafts before any write
 * React is stubbed just enough to render the section tree and invoke handlers.
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
      children: children.filter((c) => c !== null && c !== undefined),
    }),
    useState: (init) => {
      const i = state.stateIdx++
      if (!Object.hasOwn(state.seed, i)) state.seed[i] = typeof init === 'function' ? init() : init
      return [state.seed[i], (v) => { state.seed[i] = v }]
    },
    useEffect: (fn) => {
      const cleanup = fn()
      if (typeof cleanup === 'function') state.cleanups.push(cleanup)
    },
  }
}

function setup({ snapshot } = {}) {
  const definition = loadDefinition()
  const state = {
    stateIdx: 0,
    seed: {},
    cleanups: [],
    disposers: [],
    injected: [],
    registered: [],
    formCalls: [],
    subscribed: [],
    deferred: [],
    tabDefs: [],
    openedTabs: [],
  }
  const fakeForm = {
    getSnapshot: () => snapshot || { status: 'ready', writable: true, revision: 3, value: { recallLimit: 5, includeReusable: true } },
    subscribe: (fn) => { state.subscribed.push(fn); return () => { state.unsubscribed = true } },
    set: (field, value) => { state.formCalls.push([field, value]); return Promise.resolve(true) },
  }
  const React = makeReact(state)
  const face = definition.factory((spec) => {
    if (spec === 'react') return React
    throw new Error(`unexpected require: ${spec}`)
  })
  const ctx = {
    slots: {
      inject: (name, factory) => { state.injected.push(name); return factory() },
      register: (opts, comp) => { state.registered.push({ opts, comp }); return () => { state.slotDisposed = true } },
    },
    configForms: {
      whileServed: (ns, register) => {
        state.watched = ns
        const off = register()
        return () => { state.unwatched = ns; if (typeof off === 'function') off() }
      },
      get: (id) => { state.formNs = id; return fakeForm },
    },
    effect: (fn) => {
      const dispose = fn()
      state.disposers.push(dispose)
      return dispose
    },
    // Deferred cordis inject: recorded; the test decides when — and with
    // which fake scope — each callback fires (real cordis fires them when
    // the services appear).
    inject: (names, cb) => {
      state.deferred.push({ names: [...names], cb })
      return { dispose() {} }
    },
  }
  // Right-Sidebar tab registry double with the real registry's throw-on-duplicate-id contract.
  const tabs = {
    register: (def) => {
      if (state.tabDefs.some((d) => d.id === def.id)) throw new Error(`id "${def.id}" already in use`)
      state.tabDefs.push(def)
      return () => { state.tabDefDisposed = true }
    },
  }
  const fireSidebar = () => {
    const entry = state.deferred.find((d) => d.names.includes('sidebarRightTabs'))
    assert.ok(entry, 'sidebar registration rides a deferred sidebarRightTabs inject')
    assert.ok(entry.names.includes('sidebarRight'), 'the navigation face rides the same inject')
    return entry.cb({
      sidebarRightTabs: tabs,
      sidebarRight: { openTab: (kind) => state.openedTabs.push(kind) },
      slots: ctx.slots,
    })
  }
  const fireWorkspaces = (items) => {
    const entry = state.deferred.find((d) => d.names.includes('workspaces'))
    assert.ok(entry, 'cwd lookup rides a deferred workspaces inject')
    return entry.cb({ workspaces: { list: { getSnapshot: () => ({ items }), subscribe: (fn) => { state.wsSubscribed = fn; return () => {} } } } })
  }
  const seatOf = (name) => state.registered.find((r) => r.opts.name === name)
  return { definition, face, state, fakeForm, React, ctx, fireSidebar, fireWorkspaces, seatOf }
}

function walk(node, out = []) {
  if (Array.isArray(node)) { node.forEach((n) => walk(n, out)); return out }
  if (!node || typeof node !== 'object' || node.type === undefined) return out
  out.push(node)
  node.children.forEach((c) => walk(c, out))
  return out
}

/** Render the registered section the way the shell would (one hook pass). */
function renderSection(state) {
  const wrapper = state.registered[0].comp({})
  state.stateIdx = 0
  return walk(wrapper.type(wrapper.props))
}

function findButton(nodes, label) {
  return nodes.find((n) => n.type === 'button' && n.children.includes(label))
}

test('client face declares its services and normalizes recall drafts', () => {
  const { face, definition } = setup()
  assert.equal(definition.id, '@lovedolove/veyra')
  assert.deepEqual([...face.inject], ['slots', 'configForms'])
  assert.equal(typeof face.apply, 'function')
  const { normalizeRecallLimit } = face
  assert.equal(normalizeRecallLimit('5'), 5)
  assert.equal(normalizeRecallLimit(0), 0)
  assert.equal(normalizeRecallLimit('0'), 0)
  assert.equal(normalizeRecallLimit(7.9), 7)
  assert.equal(normalizeRecallLimit(' -1 '), null)
  assert.equal(normalizeRecallLimit('abc'), null)
  assert.equal(normalizeRecallLimit(''), null)
  assert.equal(normalizeRecallLimit(NaN), null)
})

test('package manifest wires the client half the way DSH discovers it', () => {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
  // dsh-client-modules scans `dsh.client` declarations of profile packages
  assert.equal(pkg.dsh.client.platform, 'web')
  assert.deepEqual([...pkg.dsh.client.inject], [
    '@deepseek-ai/dsh-client-ui-settings',
    '@deepseek-ai/dsh-client-ui-slots',
    '@deepseek-ai/dsh-client-ui-sidebar-right',
    '@deepseek-ai/dsh-api-workspace-controller',
  ])
  assert.equal(pkg.exports['./client'], './client.js')
  assert.ok(pkg.files.includes('client.js'), 'client.js ships in the npm tarball')
})

test('apply registers a Veyra settings.section while the host serves the namespace', () => {
  const { face, state, ctx } = setup()
  face.apply(ctx)
  assert.deepEqual([...state.watched], ['veyra'])
  assert.deepEqual(state.injected, ['settings.section'])
  assert.equal(state.registered.length, 1)
  const { opts, comp } = state.registered[0]
  assert.equal(opts.name, 'settings.section')
  assert.equal(opts.id, 'veyra.settings')
  assert.equal(opts.order, 65)
  assert.equal(opts.label, 'Veyra')
  assert.equal(typeof comp, 'function')
  renderSection(state)
  assert.equal(state.formNs, 'veyra', 'form resolves against the profile entry id')
  // cleanup: the page disposer unwatches (disposing the slot registration),
  // and the earlier effect disposers run without throwing
  const unwatch = state.disposers.at(-1)
  assert.equal(typeof unwatch, 'function')
  unwatch()
  assert.deepEqual([...state.unwatched], ['veyra'])
  assert.equal(state.slotDisposed, true)
  state.disposers.slice(0, -1).forEach((d) => d())
})

test('section renders current values and writes edits through configForms', async () => {
  const { face, state, ctx } = setup()
  face.apply(ctx)
  const nodes = renderSection(state)
  assert.equal(state.subscribed.length, 1, 'subscribes to form snapshot changes')

  const numberInput = nodes.find((n) => n.type === 'input' && n.props.type === 'number')
  assert.ok(numberInput, 'recall limit input rendered')
  assert.equal(numberInput.props.value, '5')
  assert.equal(numberInput.props.min, 0)
  assert.equal(numberInput.props.disabled, false)

  const save = findButton(nodes, 'Save')
  assert.ok(save, 'save button rendered')
  await save.props.onClick()
  assert.deepEqual(state.formCalls, [['recallLimit', 5]])

  const checkbox = nodes.find((n) => n.type === 'input' && n.props.type === 'checkbox')
  assert.ok(checkbox, 'includeReusable checkbox rendered')
  assert.equal(checkbox.props.checked, true)
  await checkbox.props.onChange({ target: { checked: false } })
  assert.deepEqual(state.formCalls.at(-1), ['includeReusable', false])

  // GOAL UX copy: 0 means disabled, default shown
  const text = nodes.flatMap((n) => n.children).filter((c) => typeof c === 'string').join(' ')
  assert.match(text, /0 disables automatic recalled-memory context/)
  assert.match(text, /Default: 5/)
})

test('invalid recall draft shows an error and writes nothing', async () => {
  const { face, state, ctx } = setup()
  face.apply(ctx)
  let nodes = renderSection(state)
  // seed[1] is the draft: poison it, then re-render and hit Save
  nodes.find((n) => n.type === 'input' && n.props.type === 'number').props.onChange({ target: { value: '-1' } })
  assert.equal(state.seed[1], '-1')
  nodes = renderSection(state)
  await findButton(nodes, 'Save').props.onClick()
  assert.equal(state.formCalls.length, 0, 'no write reached the settings document')
  assert.equal(state.seed[3].ok, false, 'error feedback shown')
  assert.match(state.seed[3].text, /whole number/)
})

test('read-only or unavailable host state disables the controls', () => {
  const { face, state, ctx } = setup({
    snapshot: { status: 'ready', writable: false, revision: 7, value: { recallLimit: 2, includeReusable: false } },
  })
  face.apply(ctx)
  const nodes = renderSection(state)
  const numberInput = nodes.find((n) => n.type === 'input' && n.props.type === 'number')
  assert.equal(numberInput.props.disabled, true)
  assert.equal(numberInput.props.value, '2')
  assert.equal(findButton(nodes, 'Save').props.disabled, true, 'save disabled when read-only')
  const checkbox = nodes.find((n) => n.type === 'input' && n.props.type === 'checkbox')
  assert.equal(checkbox.props.checked, false)
  assert.equal(checkbox.props.disabled, true)
})

test('apply defers the sidebar registration instead of hard-pending it', () => {
  const { face, ctx, state } = setup()
  face.apply(ctx)
  assert.deepEqual([...face.inject], ['slots', 'configForms'], 'module injects unchanged')
  assert.ok(state.deferred.some((d) => d.names.includes('sidebarRightTabs')))
  assert.ok(state.deferred.some((d) => d.names.includes('workspaces')))
  assert.equal(state.tabDefs.length, 0, 'nothing registers until the registry appears')
})

test('sidebar fires exactly once: one tab type, body seat and chip title', () => {
  const { face, ctx, state, fireSidebar, seatOf } = setup()
  face.apply(ctx)
  const dispose = fireSidebar()

  assert.equal(state.tabDefs.length, 1)
  const def = state.tabDefs[0]
  assert.equal(def.id, 'veyra-network-graph')
  assert.equal(def.kind, 'veyra-network-graph')
  assert.equal(def.title(), 'Veyra Network Graph')
  const entry = def.guide[0]
  assert.equal(entry.id, 'veyra-network-graph')
  assert.equal(entry.title(), 'Veyra Network Graph')
  assert.equal(typeof entry.icon, 'function')
  assert.equal(typeof entry.description(), 'string')

  const body = seatOf('sidebar.right.pane.tab')
  const chip = seatOf('sidebar.right.pane.tab.title')
  assert.equal(body.opts.key, 'veyra-network-graph', 'body keyed by the definition id')
  assert.equal(chip.opts.key, 'veyra-network-graph')

  // Left-sidebar footer entry: one registration, right label, opens our tab.
  const footer = seatOf('sidebar.footer.action')
  assert.equal(state.registered.filter((r) => r.opts.name === 'sidebar.footer.action').length, 1, 'footer entry registered once')
  assert.equal(footer.opts.id, 'veyra-network-graph')
  assert.equal(footer.opts.order, 20, 'after dsh-context (order 10)')
  state.stateIdx = 0
  const wideBtn = walk(footer.comp({ wide: true })).find((n) => n.type === 'button')
  assert.equal(wideBtn.props['aria-label'], 'Veyra Network Graph')
  assert.ok(wideBtn.children.some((c) => c.type === 'span' && c.children.includes('Veyra Network Graph')), 'wide column shows the label')
  wideBtn.props.onClick()
  assert.deepEqual(state.openedTabs, ['veyra-network-graph'], 'click opens our tab through sidebarRight')
  state.stateIdx = 0
  const railBtn = walk(footer.comp({ wide: false })).find((n) => n.type === 'button')
  assert.ok(!railBtn.children.some((c) => c.type === 'span'), '56px rail is icon-only')

  // A second fire against the real registry's throw-on-duplicate contract
  // must not crash the plugin or double-register the entry (guarded).
  assert.doesNotThrow(() => fireSidebar())
  assert.equal(state.tabDefs.length, 1, 'still exactly one tab type')

  assert.equal(typeof dispose, 'function')
  dispose()
  assert.equal(state.tabDefDisposed, true, 'teardown unregisters the type')
  wideBtn.props.onClick()
  assert.equal(state.openedTabs.length, 1, 'teardown clears the navigation face')
})

test('tab body embeds /veyra with the current workspace cwd, never a hardcoded path', () => {
  const { face, ctx, state, fireSidebar, fireWorkspaces, seatOf } = setup()
  face.apply(ctx)
  fireWorkspaces([
    { workspaceId: 'w1', path: '/srv/project-alpha', sessionIds: ['s-42'], title: 'alpha' },
    { workspaceId: 'w2', path: '/srv/project-beta', sessionIds: [], title: 'beta' },
  ])
  fireSidebar()
  assert.equal(state.tabDefs.length, 1)

  // Two passes per render: the effect settles the URL, the second pass is the
  // re-render React performs — the stub has no reconciler.
  const renderBody = (props) => {
    const pass = () => { state.stateIdx = 0; return walk(seatOf('sidebar.right.pane.tab').comp(props)) }
    pass()
    return pass()
  }

  const iframe = renderBody({ sessionId: 's-42' }).find((n) => n.type === 'iframe')
  assert.ok(iframe, 'body renders the existing page')
  assert.equal(iframe.props.src, '/veyra?cwd=' + encodeURIComponent('/srv/project-alpha'))
  assert.equal(iframe.props.title, 'Veyra Network Graph')

  const noMatch = renderBody({ sessionId: 'unknown-session' }).find((n) => n.type === 'iframe')
  assert.equal(noMatch.props.src, '/veyra', 'no workspace match falls back to the plain route')
  assert.ok(!JSON.stringify(noMatch.props).includes('/home/lovedolove/projects/Veyra'))

  // No workspaces face at all (harness without it): still a working route.
  const bare = setup()
  bare.face.apply(bare.ctx)
  bare.fireSidebar()
  const barePass = () => { bare.state.stateIdx = 0; return walk(bare.seatOf('sidebar.right.pane.tab').comp({ sessionId: 's-42' })) }
  barePass()
  const bareIframe = barePass().find((n) => n.type === 'iframe')
  assert.equal(bareIframe.props.src, '/veyra')
})
