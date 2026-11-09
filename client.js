/**
 * Veyra Network Graph sidebar — browser half of the plugin.
 *
 * Registers the Network Graph sidebar entry through the same mechanism
 * dsh-context uses, in both of its placements: a `sidebar.footer.action`
 * button in the left sidebar (its "Context Insights" idiom) and a
 * `sidebarRightTabs` tab type with a guide capsule (its `sidebar.ts` idiom).
 * The button's click calls `sidebarRight.openTab`, which reveals the column;
 * the tab body is an iframe over the EXISTING `/veyra` page — no second
 * graph, no second navigation system. The registry/workspaces injects are
 * deferred, so a harness without them simply never fires.
 *
 * Veyra operates automatically with built-in defaults; the dedicated Settings
 * UI has been removed. Advanced configuration remains available via YAML.
 */
window.__ModuleLoader__.load({
  id: '@lovedolove/veyra',
  factory: (require) => {
    var module = { exports: {} }
    var exports = (module.exports = {})
    var React = require('react')
    var el = React.createElement

    var GRAPH_TAB_ID = 'veyra-network-graph'
    var G = '#16a34a'
    var GRAPH_CSS = [
      '.veyra-graph-tab{height:100%;min-height:0;overflow:hidden;background:transparent;}',
      '.veyra-graph-frame{display:block;width:100%;height:100%;border:0;background:transparent;}',
    ].join('\n')

    // Deferred inject faces: a second `ctx.inject` on these mutates the child
    // fiber's registry (Cordis mutates child.inject, never re-adds the dep) so
    // the first registration never fires. We read the live face instead.
    var sidebarRightFace = null
    var workspacesFace = null

    function currentSessionId() {
      var s = workspacesFace && workspacesFace.active && workspacesFace.active.sessionId
      return typeof s === 'string' ? s : ''
    }

    function graphUrlFor(sessionId) {
      var base = '/veyra?mode=sidebar'
      return sessionId ? base + '&sessionId=' + encodeURIComponent(sessionId) : base
    }

    // The renderer looks up the pane layout by `id` (name), and falls back to
    // the `sidebar-right` bucket; dsh-context's tab makes that id explicit.
    function networkGraphTabDefinition() {
      return {
        id: GRAPH_TAB_ID,
        label: 'Veyra Network Graph',
        description: 'A network graph of Veyra’s reusable and scoped knowledge — follow links, inspect nodes, and watch the map grow as you work.',
        capsule: {
          title: 'Veyra Network Graph',
          variant: 'info',
          text:
            'This view maps Veyra’s knowledge graph: reusable experience and project-scoped records, plus the links between them. Use it to see what Veyra knows, how ideas connect, and where it is drawing context from. The graph refreshes as you work.',
        },
      }
    }

    function NetworkGraphIcon() {
      return el(
        'svg',
        { viewBox: '0 0 24 24', width: 16, height: 16, 'aria-hidden': 'true', focusable: 'false' },
        el('g', { fill: 'none', stroke: G, strokeWidth: 1.8, strokeLinecap: 'round', strokeLinejoin: 'round' },
          el('circle', { cx: 6, cy: 6, r: 2 }),
          el('circle', { cx: 18, cy: 6, r: 2 }),
          el('circle', { cx: 6, cy: 18, r: 2 }),
          el('circle', { cx: 18, cy: 18, r: 2 }),
          el('circle', { cx: 12, cy: 12, r: 2.4 }),
          el('path', { d: 'M7.8 7.2L10.2 10.2M16.2 7.2L13.8 10.2M7.8 16.8L10.2 13.8M16.2 16.8L13.8 13.8' }),
        ),
      )
    }

    function NetworkGraphTabTitle() {
      return el(
        React.Fragment,
        null,
        el('style', null, GRAPH_CSS),
        el('span', { className: 'inline-flex items-center gap-1.5 whitespace-nowrap' },
          el(NetworkGraphIcon),
          'Veyra Network Graph',
        ),
      )
    }

    function NetworkGraphTabBody() {
      var sessionId = currentSessionId()
      return el(
        React.Fragment,
        null,
        el('style', null, GRAPH_CSS),
        el('section', { className: 'veyra-graph-tab', 'aria-label': 'Veyra Network Graph' },
          el('iframe', {
            className: 'veyra-graph-frame',
            src: graphUrlFor(sessionId),
            title: 'Veyra Network Graph',
            loading: 'lazy',
            referrerPolicy: 'same-origin',
          }),
        ),
      )
    }

    // dsh-context's footer-action idiom: a real <button> so the wide/narrow
    // list item receives focus, hover, and cursor from the slot's button rule;
    // the icon rides in `list.icon`, the visible name in `list.name`.
    function NetworkGraphFooterAction() {
      return el('button', {
        type: 'button',
        'aria-label': 'Veyra Network Graph',
        title: 'Veyra Network Graph',
        onClick: function () { if (sidebarRightFace) sidebarRightFace.openTab(GRAPH_TAB_ID) },
      })
    }

    function apply(ctx) {
      var slots = ctx.slots
      var disposers = []

      if (slots) {
        // Same registration shape dsh-context uses in `registerSidebar()`:
        // sidebarRightTabs/sidebarRight/workspaces are deferred injects, so read
        // their live faces from the child scope instead of declaring them.
        disposers.push(ctx.effect(function () {
          var scope = ctx
          if (!scope.inject) return
          var child = scope.inject(['sidebarRightTabs'])
          if (!child) return
          child(() => {
            var face = child.sidebarRightTabs
            if (!face || typeof face.register !== 'function') return
            sidebarRightFace = child.sidebarRight
            return face.register(GRAPH_TAB_ID, networkGraphTabDefinition(), {
              tab: { icon: NetworkGraphIcon, title: NetworkGraphTabTitle, body: NetworkGraphTabBody },
              bucketId: 'sidebar-right',
            })
          })
        }))
        disposers.push(ctx.effect(function () {
          var scope = ctx
          if (!scope.inject) return
          var child = scope.inject(['sidebarRight'])
          if (!child) return
          child(() => { sidebarRightFace = child.sidebarRight; return () => { if (sidebarRightFace === child.sidebarRight) sidebarRightFace = null } })
        }))
        // Follow the active session: re-render the tab body (fresh iframe URL)
        // when the session changes, mirroring dsh-context's `scope.effect`.
        disposers.push(ctx.effect(function () {
          var scope = ctx
          if (!scope.inject) return
          var child = scope.inject(['workspaces'])
          if (!child) return
          child(() => { workspacesFace = child.workspaces; return () => { if (workspacesFace === child.workspaces) workspacesFace = null } })
        }))
        disposers.push(slots.register(
          { name: 'sidebar.footer.action', scope: 'root', order: 35, kind: 'list' },
          { icon: NetworkGraphIcon, name: 'Veyra Network Graph', content: NetworkGraphFooterAction },
        ))
      }

      return () => { for (var i = disposers.length - 1; i >= 0; i--) if (typeof disposers[i] === 'function') disposers[i]() }
    }

    exports.inject = ['slots']
    exports.apply = apply
    exports.networkGraphTabDefinition = networkGraphTabDefinition
    exports.NetworkGraphTabBody = NetworkGraphTabBody
    return module.exports
  },
})
