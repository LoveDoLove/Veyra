/**
 * Client (browser half) wiring test: loads client.js in a sandbox the way
 * window.__ModuleLoader__ does. Veyra's dedicated Settings UI has been removed;
 * the client bundle now registers only the Network Graph sidebar/tab surfaces.
 * Settings/configuration remains available via advanced YAML and Host APIs.
 * React is stubbed just enough to render the Network Graph tree and invoke
 * handlers.
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
      const cleanup = fn()
      if (typeof cleanup === 'function') state.cleanups.push(cleanup)
    },
    Fragment: 'Fragment',
  }
}

function setup({ activeSessionId = '' } = {}) {
  const definition = loadDefinition()
  const state = {
    stateIdx: 0,
    seed: {},
    cleanups: [],
    disposers: [],
    injected: [],
    registered: [],
    deferred: [],
    tabDefs: [],
    openedTabs: [],
  }
  const ctx = {
    slots: {
      inject: (name, factory) => { state.injected.push(name); const off = factory(ctx); state.disposers.push(off); return off },
      register: (meta, render) => { state.registered.push({ meta, render }); const off = () => {}; state.disposers.push(off); return off },
    },
    effect: (fn) => {
      const off = fn()
      if (typeof off === 'function') state.disposers.push(off)
      return off
    },
    inject: (names) => {
      const face = {}
      const child = (cb) => (typeof cb === 'function' ? cb(face) : undefined)
      if (names.includes('sidebarRightTabs')) {
        face.sidebarRightTabs = { register: (id, def, ui) => { state.tabDefs.push({ id, def, ui }); return () => {} } }
        child.sidebarRightTabs = face.sidebarRightTabs
      }
      if (names.includes('sidebarRight')) {
        face.sidebarRight = { openTab: (id) => state.openedTabs.push(id) }
        child.sidebarRight = face.sidebarRight
      }
      if (names.includes('workspaces')) {
        face.workspaces = { active: activeSessionId ? { sessionId: activeSessionId } : null }
        child.workspaces = face.workspaces
      }
      return child
    },
  }
  const mod = definition.factory((id) => {
    if (id === 'react') return makeReact(state)
    throw new Error(`unexpected require(${id})`)
  })
  mod.apply(ctx)
  return { mod, state }
}

function findNode(node, pred) {
  if (!node) return null
  if (pred(node)) return node
  for (const c of node.children || []) { const hit = findNode(c, pred); if (hit) return hit }
  return null
}

test('client bundle injects slots only (Settings UI removed)', () => {
  const def = loadDefinition()
  const mod = def.factory((id) => {
    if (id === 'react') return makeReact({ stateIdx: 0, seed: {}, cleanups: [] })
    throw new Error(`unexpected require(${id})`)
  })
  assert.deepStrictEqual(Array.isArray(mod.inject) ? [...mod.inject] : mod.inject, ['slots'])
  assert.equal(typeof mod.apply, 'function')
  assert.equal(mod.VeyraSettings, undefined)
  assert.equal(mod.ENTRY_ID, undefined)
  assert.equal(mod.SECTION_ID, undefined)
  assert.equal(mod.normalizeRecallLimit, undefined)
  assert.equal(typeof mod.networkGraphTabDefinition, 'function')
  assert.equal(typeof mod.NetworkGraphTabBody, 'function')
})

test('apply registers Network Graph tab/footer without configForms', () => {
  const { state } = setup()
  assert.deepEqual(state.injected, [])
  assert.equal(state.registered.length, 1)
  assert.equal(state.registered[0].meta.name, 'sidebar.footer.action')
  assert.equal(state.registered[0].meta.scope, 'root')
  assert.equal(state.registered[0].meta.kind, 'list')
  assert.equal(state.registered[0].render.name, 'Veyra Network Graph')
  assert.equal(state.tabDefs.length, 1)
  assert.equal(state.tabDefs[0].id, 'veyra-network-graph')
  assert.equal(state.tabDefs[0].ui.bucketId, 'sidebar-right')
  assert.equal(state.openedTabs.length, 0)
})

test('Network Graph footer click opens right-pane tab and iframe targets scoped page', () => {
  const { mod, state } = setup({ activeSessionId: 's42' })
  const footer = state.registered[0].render
  const tree = footer.content()
  const button = findNode(tree, (n) => n.type === 'button')
  assert.ok(button, 'footer renders a button')
  button.props.onClick()
  assert.deepEqual(state.openedTabs, ['veyra-network-graph'])
  const body = mod.NetworkGraphTabBody()
  const iframe = findNode(body, (n) => n.type === 'iframe')
  assert.ok(iframe, 'tab body renders an iframe')
  assert.equal(iframe.props.src, '/veyra?mode=sidebar&sessionId=s42')
})
