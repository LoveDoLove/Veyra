/**
 * Veyra Settings — browser half of the plugin.
 *
 * Registers one top-level `settings.section` ("Veyra") in the DSH Settings
 * dialog and edits the Host entry through the official `configForms`
 * transport: describe mirror → staged draft → `settings.mutate` write, with
 * the Host re-validating against Veyra's Standard Schema (`src/config.mjs`)
 * and cordis remounting the plugin so changes apply live.
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
    }

    exports.inject = ['slots', 'configForms']
    exports.apply = apply
    exports.normalizeRecallLimit = normalizeRecallLimit
    exports.VeyraSettings = VeyraSettings
    exports.ENTRY_ID = ENTRY_ID
    exports.SECTION_ID = SECTION_ID
    return module.exports
  },
})
