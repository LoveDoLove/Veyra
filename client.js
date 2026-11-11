/**
 * Veyra Network Graph sidebar — browser half of the plugin.
 *
 * Registers the Network Graph as a `sidebarRightTabs` tab type with a guide
 * capsule (dsh-context sidebar tab pattern). The tab body is an iframe over
 * the EXISTING `/veyra` page — no second graph, no second navigation system.
 * The registry/workspaces injects are deferred, so a harness without them
 * simply never fires.
 *
 * Veyra operates automatically with built-in defaults; the dedicated Settings
 * UI and bottom-left footer shortcut button have been removed. Advanced
 * configuration remains available via YAML.
 *
 * Task 36: workspace isolation — iframe URL carries authoritative `cwd` resolved
 * from DSH workspaces API (`workspaces.list.getSnapshot()/subscribe()` +
 * `WorkspaceView.path/sessionIds`). sessionId is never used as workspace proof.
 * Missing/unresolvable workspace context fails closed (explicit unavailable state).
 */
window.__ModuleLoader__.load({
  id: '@lovedolove/veyra',
  factory: (require) => {
    var module = { exports: {} }
    var exports = (module.exports = {})
    var React = require('react')
    var el = React.createElement

    var GRAPH_TAB_ID = 'veyra-network-graph'
    var GRAPH_KIND = GRAPH_TAB_ID
    var GRAPH_LABEL = 'Veyra Network Graph'
    var GRAPH_GUIDE_ORDER = 35
    var G = '#16a34a'
    var GRAPH_CSS = [
      '.veyra-graph-tab{height:100%;min-height:0;overflow:hidden;background:transparent;}',
      '.veyra-graph-frame{display:block;width:100%;height:100%;border:0;background:transparent;}',
      '.veyra-graph-unavailable{box-sizing:border-box;height:100%;padding:16px;color:var(--dsw-alias-label-secondary,#475569);font:13px/1.45 system-ui,sans-serif;}',
      '.veyra-graph-unavailable h3{margin:0 0 8px;font-size:14px;color:var(--dsw-alias-label-primary,#0f172a);}',
      '.veyra-graph-unavailable p{margin:0 0 8px;}',
    ].join('\n')

    // Deferred inject face: authoritative workspace controller/model (IWorkspaces).
    var workspacesFace = null
    var workspaceListeners = []
    var workspaceVersion = 0

    function notifyWorkspaceListeners() {
      workspaceVersion += 1
      for (var i = 0; i < workspaceListeners.length; i++) {
        try { workspaceListeners[i]() } catch (_) {}
      }
    }

    function subscribeWorkspaceState(listener) {
      if (typeof listener !== 'function') return function () {}
      workspaceListeners.push(listener)
      var list = workspacesFace && workspacesFace.list
      var unsub = list && typeof list.subscribe === 'function' ? list.subscribe(notifyWorkspaceListeners) : null
      return function () {
        if (unsub) try { unsub() } catch (_) {}
        var idx = workspaceListeners.indexOf(listener)
        if (idx >= 0) workspaceListeners.splice(idx, 1)
      }
    }

    function bestEffortActiveSessionId(face) {
      // DSH workspace-controller does not expose an "active session" API; Veyra
      // previously read a best-effort `active.sessionId` shape from the injected
      // face. Keep that as a non-authoritative hint only for mapping a session to
      // its workspace row. Never use sessionId as workspace proof and never guess.
      var active = (face || workspacesFace) && (face || workspacesFace).active
      var sid = active && (active.sessionId || (active.session && active.session.sessionId) || active.id)
      return typeof sid === 'string' && sid ? sid : ''
    }

    function listWorkspaceItems(face) {
      var f = face || workspacesFace
      var list = f && f.list
      var snap = list && typeof list.getSnapshot === 'function' ? list.getSnapshot() : null
      return snap && Array.isArray(snap.items) ? snap.items : []
    }

    function cwdFromItems(items, sessionId) {
      if (!sessionId) return ''
      for (var i = 0; i < items.length; i++) {
        var item = items[i]
        if (!item || !Array.isArray(item.sessionIds) || item.sessionIds.indexOf(sessionId) < 0) continue
        // WorkspaceView.path is the canonical host directory path (DSH API).
        return typeof item.path === 'string' && item.path ? item.path : ''
      }
      return ''
    }

    // Task 37: the tab is a 'session'-scoped keyed seat, so the ui-session
    // BUILTIN_SOURCE hands it its own sessionId as a prop (props: ['sessionId']).
    // That session maps to exactly one workspace row; when no row claims it the
    // tab fails closed instead of showing whichever workspace the controller
    // last marked active.
    function resolveWorkspaceCwdForSession(sessionId, face) {
      if (typeof sessionId !== 'string' || !sessionId) return ''
      return cwdFromItems(listWorkspaceItems(face), sessionId)
    }

    function resolveActiveWorkspaceCwd(face) {
      return cwdFromItems(listWorkspaceItems(face), bestEffortActiveSessionId(face || workspacesFace))
    }

    function graphUrlFor(cwd) {
      return cwd ? '/veyra?mode=sidebar&cwd=' + encodeURIComponent(cwd) : ''
    }

    function NetworkGraphIcon(props) {
      var size = (props && props.size) || 20
      return el('svg', { width: size, height: size, viewBox: '0 0 24 24', fill: 'none', 'aria-hidden': true, focusable: 'false' },
        el('circle', { cx: '12', cy: '6', r: '2.1', fill: G }),
        el('circle', { cx: '6.5', cy: '16.5', r: '2.1', fill: G }),
        el('circle', { cx: '17.5', cy: '16.5', r: '2.1', fill: G }),
        el('path', { d: 'M10.5 7.6 7.8 14.8M13.5 7.6l2.7 7.2M8.8 16.5h6.4', stroke: G, 'stroke-width': '1.7', 'stroke-linecap': 'round' })
      )
    }

    // Tab definition carries id/kind/title/guide; body/title render via keyed
    // slot registrations (DSH 0.2.2-rc.1 sidebarRightTabs.register contract).
    function networkGraphTabDefinition() {
      return {
        id: GRAPH_TAB_ID,
        kind: GRAPH_KIND,
        title: function () { return GRAPH_LABEL },
        keepMounted: true,
        guide: [{
          id: GRAPH_TAB_ID,
          order: GRAPH_GUIDE_ORDER,
          title: function () { return GRAPH_LABEL },
          description: function () { return 'Open Veyra memory Network Graph (/veyra).' },
          icon: NetworkGraphIcon,
        }],
      }
    }

    function useWorkspaceCwd(sessionId) {
      var own = typeof sessionId === 'string' && sessionId ? sessionId : ''
      var state = React.useState(function () {
        return { version: workspaceVersion, cwd: resolveCwd(own) }
      })
      var value = state[0]
      var setValue = state[1]
      React.useEffect(function () {
        function sync() {
          setValue({ version: workspaceVersion, cwd: resolveCwd(own) })
        }
        sync()
        return subscribeWorkspaceState(sync)
      }, [own])
      return value.cwd
    }

    function resolveCwd(sessionId) {
      return sessionId
        ? resolveWorkspaceCwdForSession(sessionId, workspacesFace)
        : resolveActiveWorkspaceCwd(workspacesFace)
    }

    function NetworkGraphTabBody(props) {
      var cwd = useWorkspaceCwd(props && props.sessionId)
      var src = graphUrlFor(cwd)
      return el('div', { className: 'veyra-graph-tab' },
        el('style', null, GRAPH_CSS),
        src
          ? el('iframe', {
              key: src,
              className: 'veyra-graph-frame',
              src: src,
              title: GRAPH_LABEL,
              loading: 'lazy',
            })
          : el('div', { className: 'veyra-graph-unavailable', role: 'status' },
              el('h3', null, 'Workspace context unavailable'),
              el('p', null, 'Open the Veyra Network Graph from an active DSH workspace session so Veyra can resolve the workspace directory authoritatively.'),
              el('p', null, 'Veyra never falls back to the plugin startup directory and never uses a session ID as workspace proof.')
            )
      )
    }

    function NetworkGraphTabTitle() {
      return el(
        React.Fragment,
        null,
        el('style', null, GRAPH_CSS),
        el('span', { className: 'inline-flex items-center gap-1.5 whitespace-nowrap' },
          el(NetworkGraphIcon),
          GRAPH_LABEL,
        ),
      )
    }

    function apply(ctx) {
      if (!ctx || !ctx.slots) return

      // Network Graph tab (dsh-context/DSH 0.2.x): deferred Cordis inject with a
      // callback. sidebarRightTabs is injected lazily, so a harness without the
      // registry never pends the plugin fiber. Guarded so a foreign registry
      // leaves the sidebar without this tab instead of breaking activation.
      // Task 35.7 removed the bottom-left sidebar.footer.action shortcut button.
      ctx.inject(['sidebarRightTabs'], function (scope) {
        var disposers = []
        var own = function (result) { if (typeof result === 'function') disposers.push(result) }
        try {
          var tabs = scope && scope.sidebarRightTabs
          if (!tabs || typeof tabs.register !== 'function') return
          own(tabs.register(networkGraphTabDefinition()))
          own(scope.slots.inject('sidebar.right.pane.tab', function () {
            return scope.slots.register({ name: 'sidebar.right.pane.tab', key: GRAPH_TAB_ID }, NetworkGraphTabBody)
          }))
          own(scope.slots.inject('sidebar.right.pane.tab.title', function () {
            return scope.slots.register({ name: 'sidebar.right.pane.tab.title', key: GRAPH_TAB_ID }, NetworkGraphTabTitle)
          }))
        } catch (_e) {
          for (var i = 0; i < disposers.length; i++) disposers[i]()
          return
        }
        return function () {
          for (var j = 0; j < disposers.length; j++) disposers[j]()
        }
      })

      // Authoritative workspace face for cwd resolution.
      // Task 36: cwd is resolved from workspaces.list snapshot items
      // (WorkspaceView.path/sessionIds), never guessed and never proven by
      // sessionId alone.
      // Task 37: the tab resolves cwd for the sessionId prop DSH hands to a
      // session-scoped keyed seat, so each session's tab shows its own
      // workspace; only a tab without that prop falls back to the
      // controller-wide best-effort hint.
      ctx.inject(['workspaces'], function (scope) {
        workspacesFace = scope && scope.workspaces
        notifyWorkspaceListeners()
        return function () {
          if (workspacesFace === (scope && scope.workspaces)) workspacesFace = null
          notifyWorkspaceListeners()
        }
      })
    }

    exports.inject = ['slots']
    exports.apply = apply
    exports.networkGraphTabDefinition = networkGraphTabDefinition
    exports.NetworkGraphTabBody = NetworkGraphTabBody
    // Task 36 test/debug seam: pure resolver for authoritative workspace mapping.
    exports.__resolveActiveWorkspaceCwd = resolveActiveWorkspaceCwd
    // Task 37 seam: per-session resolver used by the keyed session-scoped tab.
    exports.__resolveWorkspaceCwdForSession = resolveWorkspaceCwdForSession
    return module.exports
  },
})
