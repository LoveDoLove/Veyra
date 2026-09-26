/**
 * Veyra Settings + Network Graph sidebar — browser half of the plugin.
 *
 * Registers one top-level `settings.section` ("Veyra") in the DSH Settings
 * dialog and edits the Host entry through the official `configForms`
 * transport: describe mirror → staged draft → `settings.mutate` write, with
 * the Host re-validating against Veyra's Standard Schema (`src/config.mjs`)
 * and cordis remounting the plugin so changes apply live.
 *
 * Also registers the Network Graph sidebar entry through the same mechanism
 * dsh-context uses, in both of its placements: a `sidebar.footer.action`
 * button in the left sidebar (its "Context Insights" idiom) and a
 * `sidebarRightTabs` tab type with a guide capsule (its `sidebar.ts` idiom).
 * The button's click calls `sidebarRight.openTab`, which reveals the column;
 * the tab body is an iframe over the EXISTING `/veyra` page — no second
 * graph, no second navigation system. The registry/workspaces injects are
 * deferred, so a harness without them simply never fires and the settings
 * half keeps working.
 *
 * Pattern follows dsh-approval-gate's settings.section registration, but the
 * write path is the shared DSH settings document instead of custom HTTP.
 */
window.__ModuleLoader__.load({
  id: '@lovedolove/veyra',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })
    const React = require('react')

    /** Profile entry id (cordis.patch.yml insert id) = settings namespace. */
    const ENTRY_ID = 'veyra'
    const SECTION_ID = 'veyra.settings'
    const DEFAULT_RECALL_LIMIT = 5

    /** Right-Sidebar tab type identity: definition id (seat key) and kind (openTab name). */
    const GRAPH_TAB_ID = 'veyra-network-graph'
    const GRAPH_LABEL = 'Veyra Network Graph'
    /** Guide capsule position: after the shipped Files (10) and dsh-context (20) entries. */
    const GRAPH_GUIDE_ORDER = 30

    /** Set by the deferred `workspaces` inject; the tab body resolves cwd from it. */
    let workspacesFace = null
    /** Set by the deferred `sidebarRightTabs`/`sidebarRight` inject; the footer button's navigation face. */
    let sidebarRightFace = null

    const CSS = `
.vy-set{box-sizing:border-box;width:100%;max-width:720px;padding:0 0 28px;display:flex;flex-direction:column;gap:12px;color:var(--dsw-alias-label-primary)}
.vy-set-title{margin:0;font-size:16px;font-weight:500;line-height:24px}
.vy-set-intro{margin:0;color:var(--dsw-alias-label-tertiary);font-size:13px;line-height:20px}
.vy-set-card{border:1px solid var(--dsw-alias-border-l2);border-radius:12px;background:var(--dsw-alias-bg-layer-1);padding:12px 14px;display:flex;flex-direction:column;gap:8px}
.vy-set-card-title{font-size:14px;font-weight:500;line-height:20px}
.vy-set-card-sub{margin:0;color:var(--dsw-alias-label-tertiary);font-size:13px;line-height:20px}
.vy-set-row{display:flex;flex-wrap:wrap;align-items:center;gap:8px}
.vy-set-input{box-sizing:border-box;height:32px;min-width:0;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);border-radius:8px;outline:none;padding:0 10px;font:13px/20px var(--ds-font-family-code)}
.vy-set-input:focus{border-color:var(--dsw-alias-state-business-primary);box-shadow:0 0 0 2px color-mix(in srgb, var(--dsw-alias-state-business-primary) 18%, transparent)}
.vy-set-input-num{width:96px}
.vy-set-btn{font:inherit;font-size:12px;padding:6px 14px;border-radius:8px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-3);color:var(--dsw-alias-label-primary);cursor:pointer}
.vy-set-btn:disabled{opacity:.5;cursor:default}
.vy-set-check{display:flex;align-items:center;gap:8px;font-size:13px;line-height:20px;cursor:pointer}
.vy-set-ok{margin:0;color:var(--dsw-alias-state-success-primary);font-size:12px;line-height:18px}
.vy-set-err{margin:0;color:var(--dsw-alias-state-error-primary);font-size:12px;line-height:18px}
.vy-set-note{margin:0;color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px}
.vy-ov-entry{box-sizing:border-box;width:calc(100% + 4px);height:42px;color:var(--dsw-alias-label-primary);cursor:pointer;background:0 0;border:0;border-radius:12px;align-items:center;gap:8px;margin:0 -2px;padding:0 10px 0 8px;font-family:inherit;font-size:14px;line-height:22px;display:flex;overflow:hidden}
.vy-ov-entry:hover{background:var(--dsw-alias-interactive-bg-hover)}
.vy-ov-entry-rail{border-radius:50%;flex:none;justify-content:center;gap:0;width:36px;height:36px;margin:0;padding:0}
.vy-ov-entry-icon{flex:none}
.vy-ov-entry-label{text-align:left;white-space:nowrap;text-overflow:ellipsis;flex:auto;min-width:0;overflow:hidden}
`

    /**
     * Normalize a recall-limit entry before sending it to the Host.
     * Valid: finite number / numeric string >= 0 → truncated integer.
     * Invalid (blank, NaN, negative): null — the caller shows an error and
     * writes nothing, so a bad draft can never reach the settings document.
     */
    function normalizeRecallLimit(raw) {
      if (typeof raw === 'number') {
        if (!Number.isFinite(raw) || raw < 0) return null
        return Math.trunc(raw)
      }
      const text = String(raw == null ? '' : raw).trim()
      if (text === '') return null
      const n = Number(text)
      if (!Number.isFinite(n) || n < 0) return null
      return Math.trunc(n)
    }

    function recallText(snapshot) {
      const value = snapshot && snapshot.value
      const limit = value && value.recallLimit
      return String(limit === undefined || limit === null ? DEFAULT_RECALL_LIMIT : limit)
    }

    function VeyraSettings(props) {
      const configForms = props.configForms
      const form = configForms.get(ENTRY_ID)
      const [snap, setSnap] = React.useState(() => form.getSnapshot())
      const [draft, setDraft] = React.useState(() => recallText(form.getSnapshot()))
      const [busy, setBusy] = React.useState(false)
      const [msg, setMsg] = React.useState(null)
      React.useEffect(() => form.subscribe(() => setSnap(form.getSnapshot())), [form])

      const ready = snap.status === 'ready'
      const disabled = !snap.writable

      async function saveRecallLimit() {
        const n = normalizeRecallLimit(draft)
        if (n === null) {
          setMsg({ ok: false, text: 'Enter a whole number of 0 or more — 0 disables automatic recall.' })
          return
        }
        setBusy(true)
        setMsg({ ok: true, text: 'Saving…' })
        const ok = await form.set('recallLimit', n)
        setBusy(false)
        setMsg(ok
          ? { ok: true, text: 'Saved. Veyra re-applies without a restart.' }
          : { ok: false, text: 'The deployment did not accept this value.' })
      }

      const h = React.createElement
      return h('div', { className: 'vy-set' },
        h('h2', { className: 'vy-set-title' }, 'Veyra'),
        h('p', { className: 'vy-set-intro' }, 'Recall preferences for the engineering brain. Changes apply to new turns immediately.'),
        !ready ? h('p', { className: 'vy-set-note' }, snap.status === 'loading' ? 'Loading…' : 'Veyra settings are unavailable in this deployment.') : null,
        !ready ? null : h('div', { className: 'vy-set-card' },
          h('div', { className: 'vy-set-card-title' }, 'Recall limit'),
          h('p', { className: 'vy-set-card-sub' }, 'Maximum recalled records injected per turn. 0 disables automatic recalled-memory context only — tools, /veyra, Observatory and stored memory stay available. Default: 5.'),
          h('div', { className: 'vy-set-row' },
            h('input', {
              className: 'vy-set-input vy-set-input-num',
              type: 'number', min: 0, step: 1,
              value: draft, disabled,
              'aria-label': 'Recall limit',
              onChange: (e) => { setDraft(e.target.value); setMsg(null) },
            }),
            h('button', { className: 'vy-set-btn', disabled: disabled || busy, onClick: saveRecallLimit }, busy ? 'Saving…' : 'Save'),
          ),
          msg ? h('p', { className: msg.ok ? 'vy-set-ok' : 'vy-set-err' }, msg.text) : null,
        ),
        !ready ? null : h('div', { className: 'vy-set-card' },
          h('label', { className: 'vy-set-check' },
            h('input', {
              type: 'checkbox',
              checked: !(snap.value && snap.value.includeReusable === false),
              disabled,
              onChange: (e) => { void form.set('includeReusable', e.target.checked) },
            }),
            'Include cross-project reusable experience in recall',
          ),
        ),
      )
    }

    /**
     * The guide capsule / chip glyph: a five-node directed graph in
     * `currentColor`, matching the harness `IconProps` (`size`, `className`).
     */
    function NetworkGraphIcon(props) {
      const h = React.createElement
      const size = (props && props.size) || 20
      return h('svg', {
        width: size, height: size, viewBox: '0 0 24 24', fill: 'none',
        className: props && props.className, 'aria-hidden': 'true',
        xmlns: 'http://www.w3.org/2000/svg',
        stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round',
      },
        h('path', { d: 'M7 7 L12 12 M17 7 L12 12 M12 12 L7 17 M12 12 L17 17' }),
        h('circle', { cx: 7, cy: 7, r: 2, fill: 'currentColor', stroke: 'none' }),
        h('circle', { cx: 17, cy: 7, r: 2, fill: 'currentColor', stroke: 'none' }),
        h('circle', { cx: 12, cy: 12, r: 2, fill: 'currentColor', stroke: 'none' }),
        h('circle', { cx: 7, cy: 17, r: 2, fill: 'currentColor', stroke: 'none' }),
        h('circle', { cx: 17, cy: 17, r: 2, fill: 'currentColor', stroke: 'none' }),
      )
    }

    /**
     * The `/veyra` URL for the tab's session: the current DSH workspace path
     * (same lookup the shipped sidebar browser uses), never a hardcoded path.
     * No workspace match → plain `/veyra`; the server falls back to its own
     * cwd, so the entry still opens a working graph.
     */
    function graphUrlFor(sessionId) {
      try {
        const list = workspacesFace && workspacesFace.list
        const items = list && typeof list.getSnapshot === 'function' ? list.getSnapshot().items : null
        const ws = sessionId && Array.isArray(items)
          ? items.find((it) => it && Array.isArray(it.sessionIds) && it.sessionIds.indexOf(sessionId) >= 0)
          : null
        if (ws && ws.path) return '/veyra?cwd=' + encodeURIComponent(ws.path)
      } catch { /* fall through to the plain route */ }
      return '/veyra'
    }

    /** The existing Network Graph page, embedded — the tab body of our sidebar entry. */
    function NetworkGraphTabBody(props) {
      const sessionId = props && props.sessionId
      const [url, setUrl] = React.useState(() => graphUrlFor(sessionId))
      React.useEffect(() => {
        setUrl(graphUrlFor(sessionId))
        const list = workspacesFace && workspacesFace.list
        if (!list || typeof list.subscribe !== 'function') return
        return list.subscribe(() => setUrl(graphUrlFor(sessionId)))
      }, [sessionId])
      return React.createElement('iframe', {
        src: url,
        title: GRAPH_LABEL,
        style: { width: '100%', height: '100%', border: 0, display: 'block' },
      })
    }

    /** The open tab's chip: glyph + label, the shipped types' idiom. */
    function NetworkGraphTabTitle() {
      const h = React.createElement
      return h('span', { style: { display: 'inline-flex', alignItems: 'center', gap: '4px' } },
        h(NetworkGraphIcon, { size: 14 }),
        h('span', null, GRAPH_LABEL),
      )
    }

    /**
     * The left-sidebar footer action (dsh-context's "Context Insights"
     * idiom): icon plus label on the wide column, icon-only on the 56px rail,
     * stacked above Settings. Clicking reveals the right column with our tab —
     * `openTab` expands the column itself, because content the user cannot
     * see is not opened. Active state is the opened tab's chip, managed by
     * the sidebar.
     */
    function NetworkGraphFooterAction(props) {
      const wide = props && props.wide === true
      const h = React.createElement
      return h('button', {
        type: 'button',
        className: wide ? 'vy-ov-entry' : 'vy-ov-entry vy-ov-entry-rail',
        title: GRAPH_LABEL,
        'aria-label': GRAPH_LABEL,
        onClick: () => {
          try {
            if (sidebarRightFace && typeof sidebarRightFace.openTab === 'function') {
              sidebarRightFace.openTab(GRAPH_TAB_ID)
            }
          } catch { /* no session mounted or kind not in force: stay put */ }
        },
      },
        h(NetworkGraphIcon, { size: wide ? 16 : 18, className: 'vy-ov-entry-icon' }),
        wide ? h('span', { className: 'vy-ov-entry-label' }, GRAPH_LABEL) : null,
      )
    }

    /** Static face of the tab type: identity, chip copy, guide capsule. */
    function networkGraphTabDefinition() {
      return {
        id: GRAPH_TAB_ID,
        kind: GRAPH_TAB_ID,
        title: () => GRAPH_LABEL,
        keepMounted: true,
        guide: [{
          id: GRAPH_TAB_ID,
          order: GRAPH_GUIDE_ORDER,
          title: () => GRAPH_LABEL,
          description: () => 'Open this workspace\u2019s Veyra memory Network Graph (/veyra).',
          icon: NetworkGraphIcon,
        }],
      }
    }

    function apply(ctx) {
      const configForms = ctx.configForms
      let styleEl = null
      if (typeof document !== 'undefined') {
        try {
          styleEl = document.createElement('style')
          styleEl.setAttribute('data-plugin-css', 'veyra')
          styleEl.textContent = CSS
          document.head.appendChild(styleEl)
        } catch { /* styles are cosmetic */ }
      }
      ctx.effect(() => () => {
        try { styleEl && styleEl.remove() } catch { /* already gone */ }
      })
      // Section exists only while the Host serves the `veyra` settings
      // namespace: a deployment without Veyra's server half shows no trace.
      ctx.effect(() => configForms.whileServed([ENTRY_ID], () => ctx.slots.inject('settings.section', () => ctx.slots.register(
        { name: 'settings.section', id: SECTION_ID, order: 65, label: 'Veyra' },
        function (ownerProps) { return React.createElement(VeyraSettings, { configForms }) },
      ))))

      // Network Graph sidebar entry (dsh-context's mechanism, both of its
      // placements): deferred on `sidebarRightTabs` + `sidebarRight`, so a
      // harness without the registry never pends the plugin fiber — the
      // settings half above works either way. Guarded so a foreign registry
      // (throwing register, taken id) leaves the sidebar without this entry
      // instead of breaking the plugin.
      ctx.inject(['sidebarRightTabs', 'sidebarRight'], (scope) => {
        const disposers = []
        const own = (result) => { if (typeof result === 'function') disposers.push(result) }
        try {
          const tabs = scope && scope.sidebarRightTabs
          if (!tabs || typeof tabs.register !== 'function') return undefined
          own(tabs.register(networkGraphTabDefinition()))
          own(scope.slots.inject('sidebar.right.pane.tab', () => scope.slots.register(
            { name: 'sidebar.right.pane.tab', key: GRAPH_TAB_ID },
            NetworkGraphTabBody,
          )))
          own(scope.slots.inject('sidebar.right.pane.tab.title', () => scope.slots.register(
            { name: 'sidebar.right.pane.tab.title', key: GRAPH_TAB_ID },
            NetworkGraphTabTitle,
          )))
          own(scope.slots.inject('sidebar.footer.action', () => scope.slots.register(
            { name: 'sidebar.footer.action', id: GRAPH_TAB_ID, order: 20 },
            NetworkGraphFooterAction,
          )))
        } catch {
          for (const dispose of disposers) dispose()
          return undefined
        }
        // Navigation face only after every registration landed: a failed or
        // duplicate fire never clobbers a working entry's click target.
        sidebarRightFace = scope.sidebarRight
        return () => {
          sidebarRightFace = null
          for (const dispose of disposers) dispose()
        }
      })

      // Current workspace face for the tab body's cwd lookup; also deferred.
      ctx.inject(['workspaces'], (scope) => {
        workspacesFace = scope && scope.workspaces
        return () => { if (workspacesFace === (scope && scope.workspaces)) workspacesFace = null }
      })
    }

    exports.inject = ['slots', 'configForms']
    exports.apply = apply
    exports.normalizeRecallLimit = normalizeRecallLimit
    exports.VeyraSettings = VeyraSettings
    exports.ENTRY_ID = ENTRY_ID
    exports.SECTION_ID = SECTION_ID
    exports.networkGraphTabDefinition = networkGraphTabDefinition
    exports.NetworkGraphTabBody = NetworkGraphTabBody
    return module.exports
  },
})
