# CBM Decoupling — Design

Date: 2026-11-11
Status: proposed (planning only; no code changed)
Related: `AGENTS.md` §2, `docs/agent-guides/cbm-integration.md`, `CHANGELOG.md` (the removed `bundledDependencies` entry)

## 1. Intent

`@lovedolove/dsh-codebase-memory-mcp` ("CBM") should be a **separate plugin that
Veyra can use when it is present and survive when it is not**. Today it is a
hard load-time dependency: Veyra cannot be imported at all without it, and both
packages fight over the same six tool names.

The goal is *not* to delete the Code Intelligence feature. It is to make the
boundary real in both directions:

1. **Veyra loads and works without CBM installed.** Memory capture, recall,
   trust, health, and the Observatory keep working; Code Intelligence reports
   itself unavailable instead of taking the plugin down.
2. **`cbm_*` tools belong to the CBM plugin.** Veyra stops defining them, so
   the duplicate-registration race disappears by construction rather than by
   load order.
3. **The dependency declaration stops claiming CBM is mandatory.**

Capability parity when *both* are installed: unchanged. That is the acceptance
bar — this change must not remove a single working capability from a host that
has CBM.

## 2. What is actually coupled (measured, not assumed)

### 2.1 The load-time barrier is real and total

Copying `src/` to `/tmp/cbmtest` and importing it with CBM unresolvable:

```
FAILED to load: ERR_MODULE_NOT_FOUND | Cannot find package
'@lovedolove/dsh-codebase-memory-mcp' imported from /tmp/cbmtest/src/store.mjs
```

Not a degraded mode — the plugin does not load. Yet `README.md:43` says "When
it is not installed, Veyra Memory runs normally without interruption" and
`README.md:153` says the same for degraded mode. Both are false as written. The
existing `isDegraded` flag (`src/context.mjs:1013`, `src/tools.mjs:1016`,
`src/code/retrieval.mjs:101`) guards an absent **daemon binary**, never an
absent **package**.

### 2.2 Nine static ESM imports across eight files

| File | Symbols |
| --- | --- |
| `src/plugin.mjs:33-42` | `CodeIntelligenceEngine, RepositoryWatcher, FRESHNESS_STATUS, autoStartCodebaseMemory, findExe, getOrCreateClient, createClient, cbmApply` |
| `src/tools.mjs:44` | `CodeIntelligenceEngine, FRESHNESS_STATUS, createCbmToolDefinitions` |
| `src/tools.mjs:46` | `resolveSafeRepoPath` (subpath `/discovery`) |
| `src/commands.mjs:28` | `CodeIntelligenceEngine, FRESHNESS_STATUS` |
| `src/store.mjs:42` | `closeAllWatchers` |
| `src/trust.mjs:28` | `FRESHNESS_STATUS, resolveSafeRepoPath` |
| `src/understand.mjs:25` | `resolveSafeRepoPath` |
| `src/code/linking.mjs:19` | `FRESHNESS_STATUS, resolveSafeRepoPath` |
| `src/code/retrieval.mjs:19` | `FRESHNESS_STATUS, sanitizeCodeContent` |

### 2.3 Duplicate tool registration — a load-order race with a hidden failure

Veyra registers the six `cbm_*` tools itself:

```js
// src/tools.mjs:804
...createCbmToolDefinitions(runtime),
```

CBM's own `apply()` registers the same six:

```js
// CBM src/index.mjs:146-150
const toolNames = registerCbmTools(ctx, client)
```

and `registerCbmTools` swallows the collision:

```js
// CBM src/tools.mjs:355-358
} catch (err) {
  // If already registered or cannot register, skip
```

DSH's registry throws hard on duplicates (`dsh-tools/lib/index.js:385`
`tool "${name}" is already registered`). So whichever plugin applies second
fails silently for all six tools and logs nothing. No live profile hits this
today only because Veyra is installed in neither profile.

### 2.4 Everything the runtime actually needs from an engine

The complete `runtime.codeEngine` surface used anywhere in `src/`:

```
.client.isAvailable
.indexRepository(cwd, { mode })
.isDegraded
.dispose()
.searchSymbols(repoRoot, …)
.searchCodeText(repoRoot, …)
.getStatus(cwd)                 // src/commands.mjs:399, src/tools.mjs:840
.traceCallPath(cwd, { symbol }) // src/commands.mjs:442
```

Eight members, not six. `getStatus` and `traceCallPath` are reached through
`veyra_code_status` and the `/veyra-code` command, so a degraded engine missing
either fails with `TypeError` precisely on the path that exists to survive the
missing package.

Every consumer already guards with `?.` or `if (engine.isDegraded)` — except
the construction sites: `src/plugin.mjs:129`, `src/commands.mjs:396`,
`src/tools.mjs:839`, `:1004`.

### 2.5 `createRequire` loads the ESM package synchronously

Measured on Node v24.22.2 (`process.features.require_module === true`):

```
r('@lovedolove/dsh-codebase-memory-mcp')            → 49 exports, FRESHNESS_STATUS present
r('@lovedolove/dsh-codebase-memory-mcp/discovery')  → resolveSafeRepoPath: function
```

CBM contains no top-level `await`, so `require(esm)` returns the namespace
synchronously and never `ERR_REQUIRE_ASYNC_MODULE`. This matters because
`apply(ctx, config)` is synchronous (`src/plugin.mjs:160`) and Cordis invokes it
with no promise contract (`cordis/lib/index.js:1608`). A `createRequire` bridge
therefore preserves the sync lifecycle — no `apply` rewrite.

**Version floor:** `require(esm)` is unflagged from **Node 22.12.0**. Veyra
currently declares `engines.node: ">=22.5.0 <25.0.0"`. See §10 — this is the one
decision in this design that needs explicit sign-off.

### 2.6 The dependency declaration cannot control installation

Measured, same manifest (`peerDependencies` + `peerDependenciesMeta.optional`):

| Manager | Result |
| --- | --- |
| pnpm 12.18.0 | `+ is-number 7.0.0` — **installed anyway** (`autoInstallPeers=true` default) |
| npm 12.2.2 | `up to date` — not installed |

- `"pnpm": { "autoInstallPeers": false }` inside `package.json`: **no effect**.
- `autoInstallPeers: false` in `pnpm-workspace.yaml`: **works** — but that file
  belongs to the installing project, i.e. the DSH profile.
- DSH forwards plugin management to pnpm (`@deepseek-ai/dsh/lib/bin.js:116-120`).

And the live profile already installs CBM for itself:

```
~/.dsh/profiles/web/package.json
  dependencies["@lovedolove/dsh-codebase-memory-mcp"] = "github:LoveDoLove/dsh-codebase-memory-mcp"
```

So demoting Veyra's declaration **cannot** remove CBM from that profile. This is
why §11 is not optional reading: the demotion is a correctness statement, not an
uninstall lever, and the design must say so rather than imply otherwise.

## 3. Options considered

| | Approach | Verdict |
| --- | --- | --- |
| 甲 | Bridge only; keep the `dependencies` entry and the six tools in Veyra | Fixes the crash and the race, but the packaging still claims CBM is mandatory |
| **乙** | **甲 + demote the declaration to an optional peer + CBM owns `cbm_*`** | **Chosen** (m00598, m00647) |
| 丙 | CBM calls `ctx.reflect.provide('codebaseMemory', api)`; Veyra reads it tolerantly | Cleanest contract, zero npm coupling — but requires publishing a new CBM version first, and Veyra cannot do it alone |

乙 is 甲 plus a packaging statement, so it is one path, not two. 丙 stays a
possible follow-up once CBM ships a version that provides a service.

## 4. The bridge: `src/cbm-bridge.mjs`

One new module. It is the **only** file allowed to name the CBM specifier.

```js
// Shape, not final code.
const EMPTY = Object.freeze({
  available: false,
  CodeIntelligenceEngine: null,
  RepositoryWatcher: null,
  FRESHNESS_STATUS: CODE_FRESHNESS,   // Veyra-owned enum, §4.2
  resolveSafeRepoPath: null,
  sanitizeCodeContent: null,
  closeAllWatchers: () => {},
  autoStartCodebaseMemory: null,
  findExe: null,
  getOrCreateClient: null,
  createClient: null,
  cbmApply: null,
})

export function loadCbmBridge() {
  try {
    const req = createRequire(import.meta.url)
    const api = req('@lovedolove/dsh-codebase-memory-mcp')
    const discovery = req('@lovedolove/dsh-codebase-memory-mcp/discovery')
    return Object.freeze({ ...api, ...discovery, available: true })
  } catch {
    return EMPTY
  }
}
```

Rules for this module:

- **It never throws.** Any failure — missing package, `ERR_REQUIRE_ESM`, a
  future `ERR_REQUIRE_ASYNC_MODULE`, a corrupt install — returns the
  unavailable object. The plugin must load regardless.
- **It is loaded once** at module evaluation and frozen; there is no retry
  loop, no timer, no watcher. This is not a new service, scheduler, or daemon.
- **It copies no bridge internals.** It only re-exports what the package itself
  exports. `AGENTS.md` §2 ("CBM stays a dependency, not a copy") and
  `docs/agent-guides/cbm-integration.md` ("Do not reimplement, vendor, or copy
  bridge internals into `src/`") both remain true under this design.

### 4.1 What each caller gets when CBM is absent

| Symbol | Absent behaviour | Why it is safe |
| --- | --- | --- |
| `CodeIntelligenceEngine`, `RepositoryWatcher`, `createClient`, `getOrCreateClient`, `findExe`, `cbmApply`, `autoStartCodebaseMemory` | `null` | All call sites gain an explicit guard; the three bare `new CodeIntelligenceEngine()` sites become a degraded-engine factory (§4.3) |
| `closeAllWatchers` | no-op `() => {}` | No watchers can exist when `RepositoryWatcher` is `null` (`src/store.mjs:828`) |
| `sanitizeCodeContent` | `null` | Only reachable after `searchCodeText`, which requires a live engine (`src/code/retrieval.mjs:126`) |
| `resolveSafeRepoPath` | `null` | Callers degrade to "anchor unresolved", never to "anchor fresh" — see §4.4 |
| `FRESHNESS_STATUS` | Veyra-owned `CODE_FRESHNESS` — see §4.2 |

### 4.2 `FRESHNESS_STATUS` is a wire contract, not bridge internals

Three string values travel over stdio JSON-RPC from the native daemon:
`fresh`, `potentially_stale`, `invalid`. Veyra's own storage, trust categories,
and retrieval penalties are written against those literal strings; they must
exist even when the package that re-exports them does not.

So Veyra declares its own frozen enum in `src/types.mjs`:

```js
export const CODE_FRESHNESS = Object.freeze({
  FRESH: 'fresh',
  POTENTIALLY_STALE: 'potentially_stale',
  INVALID: 'invalid',
})
```

and a test asserts parity whenever the bridge is available:

```js
assert.deepEqual(CODE_FRESHNESS, cbmBridge.FRESHNESS_STATUS)
```

This is declaring the protocol Veyra already depends on, with a test that fails
if the daemon's vocabulary ever drifts — not a reimplementation of bridge logic.

### 4.3 Degraded engine (a null-object, not a stub implementation)

The three unguarded construction sites get one factory:

```js
export function createDegradedEngine() {
  return {
    isDegraded: true,
    client: { isAvailable: false },
    async indexRepository() { return { ok: false, error: 'code-intelligence-unavailable' } },
    async searchSymbols()     { return { ok: false, error: 'code-intelligence-unavailable' } },
    async searchCodeText()    { return { ok: false, error: 'code-intelligence-unavailable' } },
    async traceCallPath()     { return { ok: false, error: 'code-intelligence-unavailable' } },
    async getStatus()         { return { ok: false, error: 'code-intelligence-unavailable' } },
    dispose() {},
  }
}
```

**Eight members, not six.** `traceCallPath` and `getStatus` are not optional:
`src/commands.mjs:399` calls `engine.getStatus()`, `src/commands.mjs:442` calls
`engine.traceCallPath(...)`, and `src/tools.mjs:840` reaches `getStatus` through
`veyra_code_status`. Omitting either turns a degraded engine into a runtime
`TypeError` at exactly the moment the degradation path is supposed to be safest.

This satisfies exactly the §2.4 surface and nothing more. Existing consumers
already branch on `isDegraded` before calling the async methods, so the factory
only has to be *safe*, not *useful*.

### 4.4 `resolveSafeRepoPath` absent means "no anchor", and that is correct

`src/understand.mjs:691` runs on the memory-capture hot path. With the bridge
absent it must still produce a record. The rule:

- bridge present → `resolveSafeRepoPath(workspace, path)`, unchanged.
- bridge absent → return `null`, exactly as the function already does when a
  path escapes the workspace.

The second rule is not an approximation of the first; it is the same outcome the
code already chooses for the same reason. `repoRelativeAnchor` (`:688-694`)
returns `null` for an out-of-bounds path, and `evidenceFrom` (`:698-702`)
responds with `if (!anchor) continue` under the comment *"null = the path escaped
the workspace: it stays in `source.files` provenance and never becomes a code
anchor."* Null is the established vocabulary for "this path is not a verifiable
anchor", and an absent path-boundary authority is exactly that case.

Consequence, stated plainly: without CBM, Veyra persists the record but drops the
code anchor; the path survives only in `source.files` provenance. This is
strictly better than the alternative considered and rejected — passing the
absolute path through — which would have persisted anchors the current code
correctly discards, and trust evaluation would later read them as evidence.
Degrading to "no anchor" costs a portable pointer; degrading to "unverified
absolute anchor" costs the integrity of the evidence channel. Writing a local
path-boundary checker instead would be copying security-sensitive bridge
internals, which the guardrail forbids.

The behaviour lives in one place — `resolveRepoPath(repoRoot, targetPath, ns = cbm)`
in `src/cbm-bridge.mjs` — so the policy cannot drift between the capture path,
trust scoring, and anchor freshness. Its third parameter exists only so the
absent case is unit-testable without module mocking.

## 5. Handing the six tools to CBM

### 5.1 Removals

| Site | Change |
| --- | --- |
| `src/tools.mjs:804` | delete `...createCbmToolDefinitions(runtime),` |
| `src/tools.mjs:44` | drop `createCbmToolDefinitions` from the import (keep `CodeIntelligenceEngine`, `FRESHNESS_STATUS` via the bridge) |
| `src/skills.mjs:46-55` | remove Veyra's `codebase-memory` skill entry — CBM ships the same skill (`skills/`), and DSH resolves the collision first-wins-with-warning (`dsh-skill/lib/index.js:322-330`) |
| `skills/codebase-memory/SKILL.md` | delete the directory |

Net: `buildToolDefinitions` returns **11** tools (`veyra_code_status` plus the
ten `veyra_*`), down from 17.

### 5.2 Why removal, not delegation

Keeping the splice and letting CBM's silent `catch` absorb the duplicate means
ownership depends on apply order, and the loser's failure is invisible. Removing
the definitions makes the duplicate impossible. A host that installs Veyra
without the CBM plugin loses six tools that could never have worked there
anyway — they require the CBM daemon.

### 5.3 `registerTools` becomes duplicate-tolerant anyway

Independent of ownership, `registerTools(ctx, runtime, scope)`
(`src/tools.mjs:1294`) currently logs `[veyra] tool register failed: …` and
continues. That behaviour stays; no `ctx.tools.get()` pre-check is added. DSH's
read API (`get(name, scope, toolSet)` at `dsh-tools/lib/index.js:519`) is
view-scoped, and the test fake at `test/plugin.test.mjs:55` provides only
`register`. Probing registry internals would be both fragile and unnecessary
once Veyra defines no name CBM also defines.

## 6. Guidance text must stop claiming availability unconditionally

`src/context.mjs:459-465` injects, on every turn:

```
'Codebase Memory Policy — Structural Code Intelligence is available in this session.',
'Tools: cbm_projects, cbm_search, …',
```

With CBM absent that sentence is false and the tool names do not exist. The
block becomes conditional on bridge availability and on
`runtime.codeEngine?.isDegraded !== true`; when unavailable it emits a single
line stating that Code Intelligence is unavailable, so the agent does not
attempt the tools. `src/skills.mjs:50-51`'s duplicate guidance disappears with
the skill in §5.1.

This also resolves the double system-prompt section: `veyra:guidance` (order
3050) and `codebase-memory:guidance` (order 3040) currently both fire.

## 7. Dependency declaration

`package.json`:

```diff
-  "dependencies": {
-    "@lovedolove/dsh-codebase-memory-mcp": "^0.1.6"
-  },
+  "dependencies": {},
+  "peerDependencies": {
+    "@deepseek-ai/cordis": ">=4.0.1-rc.1 <5.0.0-0",
+    "@deepseek-ai/dsh-tools": ">=0.1.2-rc.1 <0.3.0-0",
+    "@lovedolove/dsh-codebase-memory-mcp": "^0.1.6"
+  },
+  "peerDependenciesMeta": {
+    "@deepseek-ai/cordis": { "optional": true },
+    "@deepseek-ai/dsh-tools": { "optional": true },
+    "@lovedolove/dsh-codebase-memory-mcp": { "optional": true }
+  }
```

Semantics this buys: "Veyra runs with or without CBM." Semantics it does **not**
buy: "installing Veyra will not install CBM" — pnpm 12 installs optional peers
(§2.6). The README must say exactly that, and `CHANGELOG.md` must record it.

## 8. Guardrails this design amends (needs sign-off)

Three artefact-level rules currently forbid the target state. Each needs an
explicit, narrow amendment — not a deletion:

1. `AGENTS.md` §2, "CBM stays a dependency, not a copy."
   → *"CBM stays a separate package. Veyra may load it through a guarded bridge
   that degrades to null; Veyra must not copy bridge internals into `src/`, and
   must not register `cbm_*` tools that belong to CBM's plugin."*
2. `docs/agent-guides/cbm-integration.md`, "Veyra registers the six `cbm_*`
   tools **through the bridge's factory**" → replace with the new ownership
   statement, and redraw the boundary diagram so the arrow is "optional peer,
   loaded through `src/cbm-bridge.mjs`".
3. `test/runtime-deps-check.test.mjs:88-91`, which asserts CBM **must** be in
   `dependencies` → assert it is declared in `dependencies` **or** an optional
   `peerDependencies` entry, and that every shipped import specifier resolves
   through the bridge module.

`scripts/runtime-deps-check.mjs:175-186` (`checkRuntimeImports`) counts a
violation whenever a bare specifier is not in `dependencies`. That function and
the guard test must change together, or the bridge's own `require()` trips the
checker. Note that moving the specifier behind `require()` does not evade it —
the checker scans `require('…')` too (`:159`).

A fourth class of text is falsified by §7 without being a guardrail, so it is
listed here rather than left to the implementation task: four agent guides state
that CBM **is** Veyra's runtime dependency.

| Location | Current text | Becomes |
| --- | --- | --- |
| `docs/agent-guides/release-and-packaging.md:16` | "Exactly one runtime dependency today: …" | CBM is an optional peer resolved by the bridge |
| `docs/agent-guides/engineering-principles.md:40` | "`package.json` declares one: …", and step 2 of its rule, "a declared entry in `dependencies`" | same, and "`dependencies` or `peerDependencies`" |
| `docs/agent-guides/architecture.md:39` | Code Intelligence layer row naming CBM | same layer, marked an optional peer |
| `docs/agent-guides/README.md:19` | "… and the `@lovedolove/dsh-codebase-memory-mcp` dependency" | "… the optional Code Intelligence bridge" |

`engineering-principles.md:40` is the one with teeth: its step 2 is an
instruction to future contributors, so leaving "in `dependencies`" there would
teach the next person to reintroduce exactly the hard dependency this design
removes.

## 9. Test plan

Baseline: `node --test test/*.test.mjs` → `tests 1113, pass 1113, fail 0`.

Changed assertions:

| File | Change |
| --- | --- |
| `test/compatibility.test.mjs:134` | `assert.equal(defs.length, 17)` → `11`, with the comment corrected (it currently mis-counts its own categories) |
| `test/plugin.test.mjs:177-182` | drop the six `cbm_*` name assertions |
| `test/code-lifecycle.test.mjs:70-75` | drop the six `cbm_*` name assertions |
| `test/code-tools.test.mjs` | rewrite the "includes all 7 code intelligence tools" test to assert `veyra_code_status` only; **delete** the degraded-status test (it exercises `tools.get('cbm_*')`, which no longer exists) and the two render tests (`cbm_projects` `value.raw`, `cbm_arch` `value.overview`) |
| `test/code-lifecycle.test.mjs:78` | guidance assertion flips: under a degraded engine the section must *not* contain `cbm_trace` |
| `test/plugin.test.mjs:320-322` | unchanged by design — its `apply()` has no binary, so `guidanceText === GUIDANCE_TEXT` still holds |
| `test/runtime-deps-check.test.mjs:88-91` | accept optional peer (§8.3) |
| `test/skills.test.mjs` | length assertions are dynamic (`BUNDLED_SKILL_DEFINITIONS.length`) — re-verify after the skill removal |

New tests (the ones that would have caught the old behaviour):

1. **Loads without CBM.** Import `src/plugin.mjs` in a temp tree where the
   specifier is unresolvable; assert the import succeeds and
   `loadCbmBridge().available === false`.
2. **Degrades, does not crash.** With the bridge unavailable, `apply()` on a
   fake ctx completes, registers 11 tools, and `buildRecallContext` still
   renders memory.
3. **Enum parity.** When CBM *is* resolvable, `assert.deepEqual(CODE_FRESHNESS,
   bridge.FRESHNESS_STATUS)`.
4. **No `cbm_*` ownership left in Veyra.**
   `buildToolDefinitions(runtime).filter(d => d.name.startsWith('cbm_')).length
   === 0`.
5. **Bridge is the only specifier site.** A source scan asserting exactly one
   file under `src/` names `@lovedolove/dsh-codebase-memory-mcp`.

Target: `1113 → 1125` tests, all passing. The five behaviours above are the ones
that must exist; the implementation plan grows them into 15 named tests across
the eight tasks, and deletes 3 that test tools Veyra no longer defines.

## 10. The one decision that needs your sign-off beyond approach

The bridge needs `require(esm)`, unflagged only from **Node 22.12.0**. Veyra
declares `engines.node: ">=22.5.0 <25.0.0"` and
`dsh.compatibility.nodeVersions: ">=22.5.0 <25.0.0"`.

Three ways out:

- **(a) Bump the floor to `>=22.12.0`.** Honest, and DSH itself requires
  `>=24.9.0`, so no real host is affected. Touches `package.json` `engines` and
  `dsh.compatibility.nodeVersions`.
- **(b) Keep 22.5 and degrade on 22.5–22.11.** The bridge's `catch` covers
  `ERR_REQUIRE_ESM`, so those hosts simply never get Code Intelligence even when
  CBM is installed — a silent capability loss on a version band nothing runs.
- **(c) Async `import()` fallback.** Rejected: `apply` is synchronous, and making
  it await would change the Cordis lifecycle contract for a version band DSH
  does not support.

Recommendation: **(a)**. It is a two-line metadata change with a truthful
compatibility claim, versus a silent regression under (b).

## 11. What this design does NOT achieve

Stated explicitly so nobody reads more into it than it delivers:

- **It does not uninstall CBM.** pnpm still installs an optional peer, and the
  live profile declares CBM directly (§2.6). Only that profile's own manifest
  can remove it.
- **It does not delete Code Intelligence.** `src/code/linking.mjs`,
  `src/code/retrieval.mjs`, `veyra_code_status`, and `veyra_change_impact`
  remain Veyra features that *use* CBM. Removing them is option 讀法 B, which
  was not chosen.
- **It does not make CBM provide a service.** That is 丙, and it needs a new CBM
  release.
- **It does not repair an already-broken profile.** Existing installs that hit
  the duplicate-registration race keep working after upgrade, because Veyra
  stops registering the names — but nothing rewrites the profile.

## 12. Acceptance criteria

1. `node --test test/*.test.mjs` passes with the new count and zero failures.
2. Importing `src/plugin.mjs` in a tree with no CBM package succeeds; `apply()`
   completes; memory recall and capture still work; Code Intelligence reports
   unavailable.
3. With CBM installed, every currently working capability is unchanged: 6
   `cbm_*` tools registered by the CBM plugin, `veyra_code_status` accurate,
   freshness/trust/penalty behaviour identical.
4. `grep -rn "cbm_" src/` finds no tool *definitions* — only guidance text that
   is now conditional, and `src/cbm-bridge.mjs`'s specifier.
5. `README.md:43` and `:153` describe the new, true behaviour, and §11's limits
   appear in `CHANGELOG.md`.
6. No new dependency, service, scheduler, or daemon; no unrelated changes.

## 13. Risks

| Risk | Mitigation |
| --- | --- |
| The bridge's `catch` hides a genuine CBM defect, so a broken install looks like "not installed" | Log at `warn` once when the bridge is unavailable *and* the package directory exists; the degrade path stays quiet only when the package is genuinely absent |
| `require(esm)` semantics change in a future Node | The bridge is one function returning a frozen object; a future `ERR_REQUIRE_ASYNC_MODULE` degrades rather than crashes. Verified absent today by scan |
| Silent capability loss on Node 22.5–22.11 | Resolved by §10(a) |
| Someone re-adds a `cbm_*` definition later | Test 4 in §9 fails on any reintroduction |
| Profiles already broken by the old race | §11 — upgrade fixes ownership, not the profile |
