# DSH / Cordis Integration

Veyra is a native Cordis plugin. `src/plugin.mjs` exports `name = 'veyra'`,
`inject = ['tools']`, and `apply(ctx, config)`. Everything the host sees is
registered there or delegated from there.

## The seams Veyra uses

| Seam | Registered from | Behavior |
| --- | --- | --- |
| `settings.configure` | `plugin.mjs` via `ctx.inject(['settings'])` | Surfaces the Veyra Settings section (`Config` in `src/config.mjs`) |
| `systemPrompt.section` | `registerPrompt` | Static `GUIDANCE_TEXT` — memory is not repository truth |
| `systemPrompt.context` | `registerPrompt` | Per-turn automatic recall via `createContextProvider(runtime)` |
| `ctx.tools.register` | `registerTools` | 16 tools: ten `veyra_*` plus six `cbm_*` from the bridge factory |
| `ctx.commands.register` | `registerCommand` | The `/veyra` slash command |
| `ctx.skills.registerProvider` (fallback `register`) | `registerSkills` | Five bundled skills at rank 600 |
| `ctx.webServer.register` | `registerWebUi` | `/veyra` HTTP prefix, GET-only |
| `session/event` | `plugin.mjs` | Observation buffer; compaction checkpoint recovery |
| `agent/inbox/claimed` | `plugin.mjs` | Remembers the claimed prompt as recall query context |
| `agent/turn-stopping` | `plugin.mjs` | Candidate capture, `maybeLearn`, staleness marking, maintenance cadence |

## Registration discipline

Every registration follows the same shape and you must keep it:

1. Prefer `ctx.inject([service], fn)` so the seam works when the host provides
   the service as a sibling fiber.
2. Fall back to direct registration when `inject` is unavailable or throws.
3. Wrap in `scope.effect(...)` when available so remount and teardown are clean.
4. On failure, log a warning and continue — a missing service degrades one
   feature; it must not abort plugin load.
5. Return early (not throw) when the service object is absent.

## Runtime object

`createRuntime(ctx, config)` produces the object threaded through every surface.
It carries the resolved Veyra home, recall limit and character budget, the
reusable-store switch, the code engine, logging, and feature toggles
(`observe`, `learn`, `codebaseWatch`). Surfaces receive `runtime` — they do not
resolve configuration themselves.

Accepted `config:` keys (defaults shown) are documented in `plugin.mjs`:
`home`, `recallLimit`, `includeReusable`, plus feature toggles and
`eagerStartCodebaseMemory`.

## Tools

`buildToolDefinitions` in `src/tools.mjs` returns 16 definitions: ten Veyra
tools — `veyra_remember`, `veyra_recall`, `veyra_inspect`, `veyra_forget`,
`veyra_promote`, `veyra_feedback`, `veyra_recurrence`, `veyra_health`,
`veyra_code_status`, `veyra_change_impact` — and six `cbm_*` definitions
obtained from `createCbmToolDefinitions(runtime)` in the bridge package (see
[CBM integration](./cbm-integration.md)).

Two schema rules matter:

- Output schemas must be the **raw** JSON Schema subset `ctx.tools.register`
  validates. `required` is only legal on `type: "object"` as a string array.
- Per-property `required: true` is the author-facing DSL, converted by
  `defineTool`. When `defineTool` cannot be imported (a profile-installed plugin
  cannot resolve DSH's `node_modules`), `fallbackDefineTool` is used — so a new
  tool must be valid under both paths.

`createToolHarness(runtime)` executes tool definitions without Cordis; use it in
tests rather than composing a host.

## Command

`/veyra` is one command with a subcommand grammar parsed in
`handleVeyraCommand`. Adding a subcommand means updating the parser, the help
text, and the `input.hint` in `registerCommand` together. Keep read-only
subcommands read-only.

## Skills

`skills/<name>/SKILL.md` frontmatter is the source of truth.
`BUNDLED_SKILL_DEFINITIONS` in `src/skills.mjs` must stay in parity — a test
asserts it for all five skills. When adding or changing a skill, update both.

## Settings and the browser half

- Host schema: `src/config.mjs` (`recallLimit`, `includeReusable`, both
  volatile). A saved change applies from the next turn; no restart.
- `client.js` is the browser half: it registers the `settings.section` and the
  Network Graph sidebar entry, and writes through the official `configForms`
  transport (describe mirror, staged draft, `settings.mutate`).
- Settings are Veyra's own. Never patch DSH core or another plugin to change
  Veyra behavior.

## WebUI

`src/webui.mjs` registers a `prefix` handler at `WEBUI_PATH = '/veyra'`.
Endpoints are GET-only and return 405 otherwise:

- `GET /veyra` — HTML graph page
- `GET /veyra/graph[?id=&hops=&trustedOnly=]` — overview when no id, else local graph
- `GET /veyra/record?id=`
- `GET /veyra/search?q=`

The workspace is resolved per request. Payloads are read-only projections and
must never mix project stores.

## Lifecycle and teardown

`apply` returns a cleanup function and also registers it through `ctx.effect`.
Cleanup stops watchers, disposes the code engine, and closes all stores. Keep
new resources inside that path so a remount does not leak.

## Compatibility

`package.json` declares the supported DSH range (`>=0.1.2-rc.1 <0.3.0-0`) and an
explicit verified-release map. `test/compatibility.test.mjs` and
`test/dsh-runtime.test.mjs` check the manifest and the composed host-service
runtime against a real install when one is discoverable; they skip with an
explicit reason otherwise.

## DSH Web safety

Tests and verification must never touch the live DSH Web: no binding its port,
no starting a second instance, no restart, no reconfiguration. Compose host
services in-process with an isolated temp home instead. See
[testing and verification](./testing-and-verification.md).
