# CBM Decoupling — Implementation Plan

**Goal:** Make `@lovedolove/dsh-codebase-memory-mcp` ("CBM") genuinely optional
for Veyra: the plugin loads and works when the package is absent, `cbm_*` tools
belong to the CBM plugin alone, and the package manifest stops claiming CBM is
mandatory.

**Architecture:** One new module `src/cbm-bridge.mjs` becomes the only file in
`src/` that names the CBM specifier. It loads the package through
`createRequire(import.meta.url)` and returns a frozen namespace; on any failure
it returns a frozen unavailable object whose symbols are `null` (or no-ops).
Every other module imports from the bridge and branches on `cbm.available`. Six
`cbm_*` tool definitions are deleted from Veyra, not delegated.

**Tech Stack:** Node ≥22.12.0 ESM (Task 7 raises the floor from `>=22.5.0` for
`require(esm)`), `node:test`, `node:module` `createRequire`, Cordis plugin
lifecycle (`apply` stays synchronous).

**Spec:** `docs/superpowers/specs/2026-11-11-cbm-decoupling-design.md`

**Global Constraints** (apply to every task; do not restate them per task):

- **No new dependency, service, scheduler, daemon, or timer.** The bridge loads
  once at module evaluation and never retries.
- **`apply()` must stay synchronous.** No top-level `await`, no promise return
  from `apply`, no async bridge loader.
- **Exactly one file in `src/` may contain the literal string
  `@lovedolove/dsh-codebase-memory-mcp`: `src/cbm-bridge.mjs`.**
- **No bridge internals copied into `src/`.** No reimplementation of
  `resolveSafeRepoPath`, `sanitizeCodeContent`, discovery, client, engine, or
  watcher. The bridge only re-exports what the package exports.
- Every memory write still goes through `src/redact.mjs`.
- `isLifecycleEligible` / `isRecallEligible` (`src/types.mjs:97,122`) are not
  touched.
- Tests never touch a live DSH home and never bind `127.0.0.1:3080`. Use
  `test/helpers/room.mjs` (`testHome`, `testRuntime`, `roomStore`, `agentFor`).
- Do not modify files outside the task's `Files` list.

**Suite ladder.** Baseline before Task 1: `node --test test/*.test.mjs` →
`tests 1113, pass 1113, fail 0`. Each task states its expected delta; the ladder
is non-monotonic because Task 5 deletes three obsolete tests.

**Review Focus:** (1) `apply()` remains synchronous and never throws when the
bridge is unavailable; (2) `cbm_*` appears nowhere in `src/` as a tool
definition; (3) trust evaluation fails closed (bridge absent ⇒ `INVALID`, never
`FRESH`); (4) memory capture still writes a record when the bridge is absent —
the anchor is dropped, not the record; (5) no test asserts a capability that no
longer exists.

---

## File Structure

| File | Responsibility | Task |
| --- | --- | --- |
| `src/types.mjs` | + `CODE_FRESHNESS` frozen enum (wire contract) | 1 |
| `src/cbm-bridge.mjs` | **new** — sole CBM specifier site; `cbm` namespace, `createDegradedEngine()` | 2 |
| `src/understand.mjs` | capture path: anchor fails closed to `null` when bridge absent | 3 |
| `src/trust.mjs` | trust scoring: fail-closed repo-relative resolution | 3 |
| `src/code/linking.mjs` | anchor freshness: fail-closed resolution | 3 |
| `src/tools.mjs` | bridge imports; drop `cbm_*` splice; guarded engine fallbacks | 4, 5 |
| `src/commands.mjs` | bridge imports; guarded engine fallback | 4 |
| `src/store.mjs` | bridge import for `closeAllWatchers` | 4 |
| `src/code/retrieval.mjs` | bridge imports; sanitize fallback | 4 |
| `src/plugin.mjs` | bridge imports; guarded `createRuntime`; watcher guard; re-exports; conditional guidance | 4, 6 |
| `src/context.mjs` | split `CODE_INTELLIGENCE_GUIDANCE` out of `GUIDANCE_TEXT` | 6 |
| `src/skills.mjs` | remove the `codebase-memory` skill entry | 6 |
| `skills/codebase-memory/` | **deleted** | 6 |
| `package.json` | `dependencies` → `{}`; CBM → optional peer | 7 |
| `scripts/runtime-deps-check.mjs` | merge peer declarations at the call site | 7 |
| `test/*.test.mjs` | see per-task Files lists | all |
| `AGENTS.md`, `docs/agent-guides/{cbm-integration,release-and-packaging,engineering-principles,architecture,README}.md`, `README.md`, `CHANGELOG.md` | truth updates | 8 |

---

## Task 1: Declare `CODE_FRESHNESS` as a Veyra-owned wire contract

The three freshness strings travel over stdio JSON-RPC from the native daemon and
Veyra's storage, trust labels, and retrieval penalties are written against those
literals. They must exist when the package that re-exports them does not.

**Files:**
- Modify: `src/types.mjs` (after the `VALID_RELATIONS` line at `:68`)
- Test: `test/types.test.mjs` (append; this file exists with 6 `test(` blocks today)

**Interfaces:**
- Produces: `export const CODE_FRESHNESS = Object.freeze({ FRESH: 'fresh', POTENTIALLY_STALE: 'potentially_stale', INVALID: 'invalid' })`
- Produces: `export const VALID_CODE_FRESHNESS = Object.freeze(Object.values(CODE_FRESHNESS))`

- [ ] **Step 1: Write the failing test.**

The file already opens with `import { test } from 'node:test'`,
`import assert from 'node:assert/strict'` and a multi-line
`import { AUTHORITIES, KINDS, STATUSES, VALIDATIONS, assertAuthorityTransition, isRecallEligible } from '../src/types.mjs'`.
**Extend those existing imports** — add `CODE_FRESHNESS` and
`VALID_CODE_FRESHNESS` to the `../src/types.mjs` specifier list — and append
only the test block. A second `import test from 'node:test'` in the same
module is a syntax error.

```js
test('CODE_FRESHNESS is a frozen stdio wire contract', () => {
  assert.deepEqual(CODE_FRESHNESS, {
    FRESH: 'fresh',
    POTENTIALLY_STALE: 'potentially_stale',
    INVALID: 'invalid',
  })
  assert.ok(Object.isFrozen(CODE_FRESHNESS))
  assert.deepEqual([...VALID_CODE_FRESHNESS], ['fresh', 'potentially_stale', 'invalid'])
})
```

- [ ] **Step 2: Run it, expect failure.**
  `node --test test/types.test.mjs` → fails, `CODE_FRESHNESS` is not
  exported.

- [ ] **Step 3: Implement in `src/types.mjs`.**

```js
// Code freshness is a stdio wire contract with the Code Intelligence daemon,
// not a bridge implementation detail: these three literals are persisted in
// record anchors, rendered in trust labels, and scored in retrieval. Declaring
// them here keeps Veyra correct when the bridge package is absent.
export const CODE_FRESHNESS = Object.freeze({
  FRESH: 'fresh',
  POTENTIALLY_STALE: 'potentially_stale',
  INVALID: 'invalid',
})
export const VALID_CODE_FRESHNESS = Object.freeze(Object.values(CODE_FRESHNESS))
```

- [ ] **Step 4: Run the suite.**
  `node --test test/*.test.mjs` → `tests 1114, pass 1114, fail 0`.

- [ ] **Step 5: Commit.**
  `git commit -am "types: declare CODE_FRESHNESS as a Veyra-owned wire contract"`

---

## Task 2: Add `src/cbm-bridge.mjs`

**Files:**
- Create: `src/cbm-bridge.mjs`
- Create: `test/cbm-bridge.test.mjs`

**Interfaces:**
- Produces: `export const cbm` — frozen namespace. When available it is
  `{ ...mainExports, ...discoveryExports, available: true }`. When unavailable it
  is exactly:
  ```js
  { available: false, CodeIntelligenceEngine: null, RepositoryWatcher: null,
    FRESHNESS_STATUS: CODE_FRESHNESS, resolveSafeRepoPath: null,
    sanitizeCodeContent: null, closeAllWatchers: () => {},
    autoStartCodebaseMemory: null, findExe: null, getOrCreateClient: null,
    createClient: null, cbmApply: null }
  ```
- Produces: `export function loadCbmBridge({ requireFrom = import.meta.url } = {})` —
  never throws; returns the same shape as `cbm`.
- Produces: `export function createDegradedEngine()` — see contract below.
- Produces: `export function resolveRepoPath(repoRoot, targetPath, ns = cbm)` —
  repo-relative resolution, or `null` when no path-boundary authority exists:
  ```js
  // Fail closed: without the bridge there is no boundary authority, so nothing
  // resolves. Callers already treat null as "no verifiable anchor" — they skip
  // the anchor and keep the path in provenance — so an absent bridge costs a
  // code anchor, never a record and never a false claim.
  export function resolveRepoPath(repoRoot, targetPath, ns = cbm) {
    if (!ns.available || typeof ns.resolveSafeRepoPath !== 'function') return null
    try { return ns.resolveSafeRepoPath(repoRoot, targetPath) } catch { return null }
  }
  ```
  The `ns` parameter exists only so the absent case is testable without module
  mocking; production callers omit it.
- `cbm.available` is the single availability flag callers branch on.

`createDegradedEngine()` returns exactly these eight members (the complete
`runtime.codeEngine` surface measured across `src/`):

```js
{
  isDegraded: true,
  client: { isAvailable: false },
  indexRepository: async () => ({ ok: false, degraded: true, message: 'Code intelligence degraded' }),
  searchSymbols:   async () => ({ ok: false, degraded: true, symbols: [], message: 'Code intelligence degraded' }),
  searchCodeText:  async () => ({ ok: false, degraded: true, message: 'Code intelligence degraded' }),
  traceCallPath:   async () => ({ ok: false, degraded: true, message: 'Code intelligence degraded' }),
  getStatus:       async () => ({ status: 'degraded', degraded: true, message: 'Code intelligence degraded' }),
  dispose: () => {},
}
```

- [ ] **Step 1: Write the failing tests.**

```js
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { loadCbmBridge, createDegradedEngine, cbm } from '../src/cbm-bridge.mjs'
import { CODE_FRESHNESS } from '../src/types.mjs'

test('bridge exposes the full namespace when the package is installed', () => {
  const loaded = loadCbmBridge()
  assert.equal(loaded.available, true)
  for (const name of ['CodeIntelligenceEngine', 'RepositoryWatcher',
    'autoStartCodebaseMemory', 'findExe', 'getOrCreateClient', 'createClient',
    'cbmApply', 'closeAllWatchers', 'resolveSafeRepoPath', 'sanitizeCodeContent']) {
    assert.equal(typeof loaded[name], 'function', `${name} must be a function`)
  }
  assert.ok(Object.isFrozen(loaded))
})

test('bridge degrades to a frozen unavailable stub when the package cannot resolve', () => {
  const dir = mkdtempSync(join(tmpdir(), 'veyra-no-cbm-'))
  try {
    const loaded = loadCbmBridge({ requireFrom: join(dir, 'noop.mjs') })
    assert.equal(loaded.available, false)
    assert.equal(loaded.CodeIntelligenceEngine, null)
    assert.equal(loaded.RepositoryWatcher, null)
    assert.equal(loaded.resolveSafeRepoPath, null)
    assert.equal(loaded.sanitizeCodeContent, null)
    assert.equal(typeof loaded.closeAllWatchers, 'function')
    assert.deepEqual(loaded.FRESHNESS_STATUS, CODE_FRESHNESS)
    assert.ok(Object.isFrozen(loaded))
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('bridge never throws for a corrupt require base', () => {
  for (const base of ['', '\0bad\0path', '/nonexistent/深入/path.mjs']) {
    assert.doesNotThrow(() => loadCbmBridge({ requireFrom: base }))
    assert.equal(loadCbmBridge({ requireFrom: base }).available, false)
  }
})

test('upstream FRESHNESS_STATUS agrees with CODE_FRESHNESS', () => {
  if (!cbm.available) return // parity is only checkable when the package exists
  assert.deepEqual(cbm.FRESHNESS_STATUS, CODE_FRESHNESS)
})

test('degraded engine satisfies the complete codeEngine surface', async () => {
  const engine = createDegradedEngine()
  assert.equal(engine.isDegraded, true)
  assert.equal(engine.client.isAvailable, false)
  const s = await engine.getStatus('/tmp')
  assert.equal(s.status, 'degraded')
  assert.equal(s.degraded, true)
  for (const r of [await engine.searchSymbols('/tmp', {}), await engine.searchCodeText('/tmp', {}),
    await engine.traceCallPath('/tmp', {}), await engine.indexRepository('/tmp', {})]) {
    assert.equal(r.ok, false)
    assert.equal(r.degraded, true)
  }
  assert.doesNotThrow(() => engine.dispose())
})

test('resolveRepoPath returns null when no boundary authority exists', () => {
  const noBridge = { available: false, resolveSafeRepoPath: null }
  assert.equal(resolveRepoPath('/repo', '/repo/a.mjs', noBridge), null)
  const throwing = { available: true, resolveSafeRepoPath: () => { throw new Error('boom') } }
  assert.equal(resolveRepoPath('/repo', '/repo/a.mjs', throwing), null)
  const working = { available: true, resolveSafeRepoPath: () => 'a.mjs' }
  assert.equal(resolveRepoPath('/repo', '/repo/a.mjs', working), 'a.mjs')
})
```

- [ ] **Step 2: Run, expect failure.** `node --test test/cbm-bridge.test.mjs` →
  cannot resolve `../src/cbm-bridge.mjs`.

- [ ] **Step 3: Implement `src/cbm-bridge.mjs`.**

```js
/**
 * The only module that names the Codebase Memory package.
 *
 * Code Intelligence is an optional Codebase Memory plugin, not Veyra code. This
 * bridge loads it synchronously (createRequire resolves the ESM package without
 * a top-level await, so plugin `apply` stays synchronous) and degrades to a
 * frozen stub when it is absent. It copies no bridge internals: it re-exports
 * what the package exports and nothing more.
 *
 * Loaded once, at module evaluation. No retry, no timer, no watcher.
 */
import { createRequire } from 'node:module'
import { CODE_FRESHNESS } from './types.mjs'

const SPECIFIER = '@lovedolove/dsh-codebase-memory-mcp'
const DISCOVERY_SPECIFIER = '@lovedolove/dsh-codebase-memory-mcp/discovery'

const unavailable = () => Object.freeze({
  available: false,
  CodeIntelligenceEngine: null,
  RepositoryWatcher: null,
  FRESHNESS_STATUS: CODE_FRESHNESS,
  resolveSafeRepoPath: null,
  sanitizeCodeContent: null,
  closeAllWatchers: () => {},
  autoStartCodebaseMemory: null,
  findExe: null,
  getOrCreateClient: null,
  createClient: null,
  cbmApply: null,
})

export function loadCbmBridge({ requireFrom = import.meta.url } = {}) {
  try {
    const req = createRequire(requireFrom)
    const api = req(SPECIFIER)
    const discovery = req(DISCOVERY_SPECIFIER)
    return Object.freeze({ ...api, ...discovery, available: true })
  } catch {
    // Absent, corrupt, or a future require(esm) semantic change: Veyra must
    // still load, so every failure path is the same degraded stub.
    return unavailable()
  }
}

/** Frozen at module evaluation; never reloaded. */
export const cbm = loadCbmBridge()

/**
 * Null-object satisfying exactly the members `src/` reads from `codeEngine`.
 * Being safe is the requirement; being useful is not — every consumer already
 * branches on `isDegraded` before calling the async members.
 */
export function createDegradedEngine() {
  const degraded = 'Code intelligence degraded'
  return {
    isDegraded: true,
    client: { isAvailable: false },
    indexRepository: async () => ({ ok: false, degraded: true, message: degraded }),
    searchSymbols: async () => ({ ok: false, degraded: true, symbols: [], message: degraded }),
    searchCodeText: async () => ({ ok: false, degraded: true, message: degraded }),
    traceCallPath: async () => ({ ok: false, degraded: true, message: degraded }),
    getStatus: async () => ({ status: 'degraded', degraded: true, message: degraded }),
    dispose: () => {},
  }
}
```

- [ ] **Step 4: Run.** `node --test test/cbm-bridge.test.mjs` passes; then
  `node --test test/*.test.mjs` → `tests 1120, pass 1120, fail 0` (+6).

- [ ] **Step 5: Commit.**
  `git commit -am "cbm: add a self-degrading bridge as the sole specifier site"`

---

## Task 3: Migrate the memory and trust path to the bridge

Three files on the capture/trust path. All three fail closed when the bridge is
absent, which is exactly what they already do for an out-of-bounds path: the
anchor is dropped and the path survives only in `source.files` provenance. A
record is still captured; it simply carries no unverifiable code anchor.

**Files:**
- Modify: `src/understand.mjs:25` (import), `src/understand.mjs:688-694` (`repoRelativeAnchor`)
- Modify: `src/trust.mjs:28` (import), `src/trust.mjs:205`, `:228`
- Modify: `src/code/linking.mjs:19` (import) and **all six** call sites: `:27`, `:109`, `:219`, `:225`, `:268`, `:293`
- Create: `test/cbm-bridge-absent.test.mjs`

**Interfaces:**
- Consumes: `cbm`, `resolveRepoPath` from `src/cbm-bridge.mjs`.
- Every former `resolveSafeRepoPath(a, b)` call becomes `resolveRepoPath(a, b)`.
  No local `safeRel` helper is introduced — the bridge owns the one policy.

- [ ] **Step 1: Write the failing test.**

```js
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

// The absent-bridge behaviour itself is unit-tested in
// test/cbm-bridge.test.mjs via resolveRepoPath's injectable namespace. What
// these tests pin is that the three call sites actually route through it,
// because a direct `resolveSafeRepoPath` import would silently restore the
// hard dependency the whole change exists to remove.
test('the capture and trust path resolve anchors through the bridge', () => {
  for (const file of ['../src/understand.mjs', '../src/trust.mjs', '../src/code/linking.mjs']) {
    const src = readFileSync(new URL(file, import.meta.url), 'utf8')
    assert.ok(!src.includes('resolveSafeRepoPath'),
      `${file} must not call resolveSafeRepoPath directly`)
    assert.ok(src.includes('resolveRepoPath') || src.includes('repoRelativeAnchor'),
      `${file} must resolve paths through the bridge`)
  }
})

test('createCodeAnchor still refuses an out-of-repo path', async () => {
  const { createCodeAnchor } = await import('../src/code/linking.mjs')
  assert.throws(
    () => createCodeAnchor({ repoRoot: '/tmp/repo-a', path: '/tmp/outside/b.mjs' }),
    /escapes repository boundary/,
  )
})
```

- [ ] **Step 2: Run, expect failure.** The first test fails: all three files
  still import `resolveSafeRepoPath`.

- [ ] **Step 3: Implement.**

  In `src/understand.mjs`, replace the import at `:25` with
  `import { cbm, resolveRepoPath } from './cbm-bridge.mjs'` and change only the
  resolution line of `repoRelativeAnchor`:

  ```js
  function repoRelativeAnchor(workspace, path) {
    if (!workspace || !isAbsolute(path)) return path
    // Unresolvable (out of bounds, or no bridge) returns null, which
    // evidenceFrom treats identically: the anchor is dropped and the path stays
    // in source.files provenance. An anchor we cannot verify is worse than no
    // anchor, because trust evaluation would later read it as evidence.
    return resolveRepoPath(workspace, path)
  }
  ```

  Note this also removes the local `try/catch`, because `resolveRepoPath` already
  swallows and returns `null`.

  In `src/code/linking.mjs`, replace the import at `:19` and all six call sites
  — `:27` (`createCodeAnchor`), `:109` (`checkAnchorFreshness`), `:219`/`:225`
  (rename mapping validation), `:268` (`findAffectedMemories` normalization),
  `:293` (anchor matching). Five of the six sit inside `try { … } catch`, and
  those `try/catch` blocks **stay**: `resolveRepoPath` returns `null` rather than
  throwing, but the catch documents the invariant and the surrounding logic
  already treats `null` as "not a usable repo-relative path", so behaviour is
  unchanged either way.

  One site needs more than a rename. `src/code/linking.mjs:268` reads
  `try { normalizedChanged.add(resolveSafeRepoPath(repoRoot, f)) } catch { /* skip paths outside repo */ }`.
  Under the bridge an absent namespace makes `resolveRepoPath` return `null`,
  and `.add(null)` would silently insert `null` into the set — which
  `findAffectedMemories` then compares against real relative paths. Guard it
  explicitly:
  ```js
  const rel = resolveRepoPath(repoRoot, f)
  if (rel) normalizedChanged.add(rel)
  ```
  This is the one place where replacing the call is not behaviour-preserving on
  its own, because the old code relied on a throw to skip the insert.

  In `src/code/linking.mjs:26` (`createCodeAnchor`) the existing
  `if (!safeRel) throw` guard stays, and stays reachable: with a valid bridge an
  out-of-repo path still throws, and with no bridge every path throws — correct
  fail-closed behaviour for anchor creation.

  In `src/trust.mjs`, replace the import at `:28` and both call sites — no
  guard needed at either. `:205` already ends `.filter(Boolean)`, so a `null`
  from an absent bridge is dropped exactly like a path that threw before.
  `:228` reads `try { rel = resolveSafeRepoPath(workspace, a.path) } catch { continue }`
  followed by `if (changedSet.has(rel))`; a `null` simply fails the `has` test,
  which is the same outcome as the `continue` it replaces. Keep both `try/catch`
  blocks for the same reason as above.

- [ ] **Step 4: Run.** `node --test test/*.test.mjs` → `tests 1122, pass 1122, fail 0` (+2).

- [ ] **Step 5: Commit.**
  `git commit -am "memory: resolve repo-relative anchors through the CBM bridge"`

---

## Task 4: Migrate tools, commands, store, retrieval, and plugin to the bridge

After this task no file in `src/` except `src/cbm-bridge.mjs` names the package.

**Files:**
- Modify: `src/tools.mjs:44`, `:46`, `:839`, `:1004`, `:1245`
- Modify: `src/commands.mjs:28`, `:396`
- Modify: `src/store.mjs:42`, `:828`
- Modify: `src/code/retrieval.mjs:19`, `:126`
- Modify: `src/plugin.mjs:33-42` (import), `:129-136` (engine), `:186` (eager start), `:192-194` (watcher guard), `:212` (`FRESHNESS_STATUS` → `CODE_FRESHNESS`), `:480-490` (re-exports)
- Test: `test/cbm-bridge-absent.test.mjs` (append)

**Interfaces:**
- `src/plugin.mjs` keeps its five-name re-export block
  (`findExe, getOrCreateClient, createClient, cbmApply, autoStartCodebaseMemory`).
  Destructure them from the bridge at module scope and re-export the locals:
  ```js
  const { findExe, getOrCreateClient, createClient, cbmApply, autoStartCodebaseMemory } = cbm
  export { findExe, getOrCreateClient, createClient, cbmApply, autoStartCodebaseMemory }
  ```
  **Why keep them at all:** `src/plugin.mjs` is this package's `main` and
  `exports` target, so these five names are Veyra's public module surface.
  Dropping exported names would be a breaking API change unrelated to
  decoupling. They are `null` when the bridge is unavailable, which is safe
  because no other module in `src/` imports them and the one internal use
  (`:185` `autoStartCodebaseMemory(...)`) sits behind
  `:184` `if (shouldEagerStart && runtime.codeEngine?.client?.isAvailable)`.
  Note `test/code-eager-startup.test.mjs` imports these five **directly from the
  CBM package**, not from `src/plugin.mjs` — its function assertions are about
  CBM, not about Veyra's re-exports, so this change does not touch it.
- `src/plugin.mjs` `createRuntime` engine construction becomes:
  ```js
  const codeEngine = typeof cbm.CodeIntelligenceEngine === 'function'
    ? new cbm.CodeIntelligenceEngine({
        exePath: config.codebaseMemoryBin,
        defaultPort: config.codebaseMemoryPort,
        log,
      })
    : createDegradedEngine()
  ```
- `ensureWatcher` gains an early return: `if (typeof cbm.RepositoryWatcher !== 'function') return`
  immediately after the existing `if (!runtime.codebaseWatch || !cwd || watchers.has(cwd)) return`.
- `src/tools.mjs:839` / `:1004` and `src/commands.mjs:396`: replace every
  `runtime.codeEngine || new CodeIntelligenceEngine()` with
  `runtime.codeEngine || createDegradedEngine()`.
- `src/store.mjs:828`: `closeAllWatchers()` → `cbm.closeAllWatchers?.()`.
- `src/code/retrieval.mjs:126`: `sanitizeCodeContent(textRes.results)` →
  ```js
  const sanitize = typeof cbm.sanitizeCodeContent === 'function'
    ? cbm.sanitizeCodeContent
    : (text) => (typeof text === 'string' ? scrub(text).scrubbed : '')
  ```
  `scrub` is already exported from `src/redact.mjs:161` and returns an object
  (`{ clean, scrubbed, redactionsCount, detectedPatterns }`), not a string — so
  `.scrubbed` is required, and the non-string guard is not decoration: the
  upstream function these semantics come from
  (`sanitizeCodeContent` in CBM's `src/discovery.mjs`) opens with
  `if (typeof content !== 'string') return ''`. Dropping the guard would change
  behaviour for a `null` result instead of merely including a fallback.
  `textRes.results` is already a scrubbed **string** here (CBM's engine returns
  `sanitizeCodeContent(raw)` where `raw` is `res.content?.[0]?.text || ''`), so
  this call is a second, harmless pass. Add `import { scrub } from '../redact.mjs'`
  to `src/code/retrieval.mjs` — its current import block is only
  `hybridRetrieve`, `checkRecordFreshness`, and the CBM specifier at `:19`.
- `FRESHNESS_STATUS` references become `CODE_FRESHNESS` imported from
  `src/types.mjs` in `src/tools.mjs`, `src/commands.mjs`, `src/code/retrieval.mjs`,
  and `src/plugin.mjs`. Keep usages identical: the values are the same literals.
- **`src/tools.mjs:1245` (staleness handler) — do not "fix" it into throwing.**
  Today it reads `try { safeRel = resolveSafeRepoPath(cwd, anc.path) } catch (e) { resolveError = … }`,
  returns `status: 'unresolved'` when `resolveError` is set, and
  `status: 'outside_or_invalid'` when `safeRel` is falsy. Under the bridge,
  `resolveRepoPath` returns `null` instead of throwing, so an absent bridge
  reports **`outside_or_invalid`**, not `unresolved`. That is the correct
  outcome — nothing resolved, and no boundary authority to distinguish
  "outside the repo" from "unavailable" — and the two statuses describe the same
  refusal to the caller. Replace only the call: `resolveRepoPath(cwd, anc.path)`.
  Keep the `try/catch` and the `resolveError` branch anyway; `resolveRepoPath`
  never throws, but the branch documents the invariant and costs nothing.

- [ ] **Step 1: Write the failing tests.**

```js
test('exactly one file under src/ names the codebase memory package', async () => {
  const { readdirSync, readFileSync } = await import('node:fs')
  const { join } = await import('node:path')
  const root = new URL('../src/', import.meta.url).pathname
  const offenders = []
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) { walk(full); continue }
      if (!entry.name.endsWith('.mjs')) continue
      if (readFileSync(full, 'utf8').includes('@lovedolove/dsh-codebase-memory-mcp')) {
        offenders.push(full.slice(root.length))
      }
    }
  }
  walk(root)
  assert.deepEqual(offenders, ['cbm-bridge.mjs'])
})

test('plugin apply completes and registers tools with a degraded engine', async () => {
  // test/helpers/ holds only dsh.mjs, eval-output.mjs, room.mjs — there is no
  // shared plugin mock. plugin.test.mjs, loop.test.mjs and the three
  // turn-stopping tests each redefine mockCtx() locally; this file follows the
  // same convention with only the members apply() touches.
  const { apply } = await import('../src/plugin.mjs')
  const { testHome } = await import('./helpers/room.mjs')
  const tools = []
  const sections = []
  const contexts = []
  const ctx = {
    tools: { register: (def) => tools.push(def) },
    commands: { register: () => {} },
    skills: { register: () => {}, registerProvider: () => () => {} },
    systemPrompt: { section: (s) => sections.push(s), context: (c) => contexts.push(c) },
    on: () => () => {},
    effect: (factory) => factory(),
    logger: { info: () => {}, warn: () => {}, debug: () => {}, error: () => {} },
  }
  const dispose = apply(ctx, { home: testHome(t), observe: true })
  assert.deepEqual(tools.filter((d) => d.name.startsWith('cbm_')), [])
  assert.ok(tools.some((d) => d.name === 'veyra_recall'))
  dispose?.()
})
```

`apply()` here runs with no `codebaseMemoryBin`, so the engine is degraded — which
is exactly the case this test exists to prove survives.

- [ ] **Step 2: Run, expect failure.** The specifier scan finds six offending
  files: `cbm-bridge.mjs` (the one legitimate site) plus the five this task has
  not yet migrated — `code/retrieval.mjs`, `commands.mjs`, `plugin.mjs`,
  `store.mjs`, `tools.mjs`. Task 3 already took `understand.mjs`, `trust.mjs`,
  and `code/linking.mjs` off the list.

- [ ] **Step 3: Implement the migrations listed under **Files** and **Interfaces**.**

  Verification greps after this task:
  ```
  grep -rn "@lovedolove/dsh-codebase-memory-mcp" src/     # only src/cbm-bridge.mjs
  grep -rn "new CodeIntelligenceEngine" src/              # no bare constructions
  grep -rn "FRESHNESS_STATUS" src/                        # no references outside cbm-bridge.mjs
  ```

- [ ] **Step 4: Run.** `node --test test/*.test.mjs` → `tests 1124, pass 1124, fail 0` (+2).
  `test/code-eager-startup.test.mjs` must still pass unchanged.

- [ ] **Step 5: Commit.**
  `git commit -am "tools: read Code Intelligence through the CBM bridge everywhere"`

---

## Task 5: Delete the six `cbm_*` definitions from Veyra

**Files:**
- Modify: `src/tools.mjs:804` (delete the splice line)
- Modify: `test/code-tools.test.mjs` (rewrite `:11`, delete `:39`, `:205`, `:227`, append one)
- Modify: `test/compatibility.test.mjs:134`
- Modify: `test/plugin.test.mjs:175-185`
- Modify: `test/code-lifecycle.test.mjs:70-75`

**Interfaces:**
- `buildToolDefinitions(runtime)` returns **11** definitions: `veyra_code_status`
  and the ten `veyra_*` tools. No `cbm_*` definition is produced, ever.
- The surviving code-intelligence tests exercise only `veyra_code_status`.

- [ ] **Step 1: Write the failing test (append to `test/code-tools.test.mjs`).**

```js
test('Veyra defines no cbm_* tools — those belong to the Codebase Memory plugin', () => {
  const defs = buildToolDefinitions({ veyraHome: '/tmp/veyra-no-cbm', fallbackCwd: '/tmp' })
  assert.equal(defs.length, 11)
  assert.deepEqual(defs.filter((d) => d.name.startsWith('cbm_')), [])
  assert.ok(defs.some((d) => d.name === 'veyra_code_status'))
})
```

- [ ] **Step 2: Run, expect failure.** `defs.length` is 17.

- [ ] **Step 3: Implement.**

  - Delete `src/tools.mjs:804` (`...createCbmToolDefinitions(runtime),`).
  - Drop `createCbmToolDefinitions` from the `src/tools.mjs:44` import (Task 4
    already replaced that import with the bridge; confirm the name is gone).
  - Rewrite `test/code-tools.test.mjs:11` — rename it
    `'buildToolDefinitions includes veyra_code_status with a valid schema'`, drop
    the six `cbm_*` assertions, keep the loop that asserts every definition
    compiles (`name`, `description`, `execute`, `presentCall`,
    `toRawOutputSchema`).
  - Delete the three tests that can no longer be true:
    `:39` `'code intelligence tools return graceful degraded status when engine is offline'`
    (it calls `tools.get('cbm_projects')` / `tools.get('cbm_search')`),
    `:205` `'cbm_projects render uses value.raw text, not value.projects array'`,
    `:227` `'cbm_arch render uses value.overview, not value.raw'`.
  - `test/compatibility.test.mjs:134`: `assert.equal(defs.length, 11)` and correct
    the comment to `// 10 veyra_* + veyra_code_status`.
  - `test/plugin.test.mjs:175-185`: delete the six `'cbm_*'` entries from the
    expected-name array.
  - `test/code-lifecycle.test.mjs:70-75`: delete the six
    `assert.ok(toolNames.includes('cbm_*'))` lines; keep the
    `veyra_code_status` assertion.

- [ ] **Step 4: Run.** `node --test test/*.test.mjs` → `tests 1122, pass 1122, fail 0` (−3 deleted, +1 added from a base of 1124).

- [ ] **Step 5: Commit.**
  `git commit -am "tools: hand the six cbm_* tools to the Codebase Memory plugin"`

---

## Task 6: Remove the duplicate skill and make guidance conditional

**Files:**
- Delete: `skills/codebase-memory/` (directory, including `SKILL.md`)
- Modify: `src/skills.mjs:46-56`
- Modify: `src/context.mjs:459-466`
- Modify: `src/plugin.mjs` `registerPrompt` (`:245-270`)
- Modify: `test/code-lifecycle.test.mjs:78` (assertion must move to the degraded expectation)
- Test: `test/cbm-bridge-absent.test.mjs` (append)

**Interfaces:**
- `src/context.mjs` produces `export const CODE_INTELLIGENCE_GUIDANCE` — the
  eight-line Codebase Memory block joined with `'\n'`. `GUIDANCE_TEXT` keeps
  everything except that block, so it is unchanged for a host without Code
  Intelligence.
- `registerPrompt` composes:
  ```js
  const guidanceText = cbm.available && runtime.codeEngine?.isDegraded !== true
    ? `${GUIDANCE_TEXT}\n\n${CODE_INTELLIGENCE_GUIDANCE}`
    : GUIDANCE_TEXT
  ```
  and registers `text: guidanceText`. With a degraded engine (the test default)
  `text === GUIDANCE_TEXT`, so `test/plugin.test.mjs:321`'s identity assertion
  keeps holding.
- `BUNDLED_SKILL_DEFINITIONS` drops to 4 entries.

**One existing assertion must flip.** `test/code-lifecycle.test.mjs:78` reads
`assert.ok(sections.some((s) => s.name === 'veyra:guidance' && s.text.includes('Codebase Memory')))`.
That test's `apply()` passes `codebaseMemoryBin: '/nonexistent/codebase-memory-mcp'`,
so `client.isAvailable` is false and `isDegraded` is true — under the new
conditional the guidance correctly omits the block. Replace it with the degraded
expectation, which is the stronger assertion anyway:

```js
assert.ok(sections.some((s) => s.name === 'veyra:guidance' && !s.text.includes('cbm_trace')))
```

- [ ] **Step 1: Write the failing test.**

```js
test('guidance omits Code Intelligence instructions when the engine is degraded', async () => {
  const { GUIDANCE_TEXT, CODE_INTELLIGENCE_GUIDANCE } = await import('../src/context.mjs')
  assert.ok(!GUIDANCE_TEXT.includes('cbm_trace'))
  assert.ok(CODE_INTELLIGENCE_GUIDANCE.includes('cbm_trace'))
  assert.ok(!GUIDANCE_TEXT.includes(CODE_INTELLIGENCE_GUIDANCE))
})

test('Veyra no longer bundles a codebase-memory skill', async () => {
  const { BUNDLED_SKILL_DEFINITIONS } = await import('../src/skills.mjs')
  assert.equal(BUNDLED_SKILL_DEFINITIONS.some((s) => s.name === 'codebase-memory'), false)
  assert.equal(BUNDLED_SKILL_DEFINITIONS.length, 4)
})
```

- [ ] **Step 2: Run, expect failure.** `CODE_INTELLIGENCE_GUIDANCE` is not
  exported; the skill is still listed.

- [ ] **Step 3: Implement.**

  - `src/context.mjs`: cut lines `:459-466` out of the `GUIDANCE_TEXT` array and
    emit them as `export const CODE_INTELLIGENCE_GUIDANCE = [ /* the eight
    original lines, verbatim */ ].join('\n')`. Keep the blank line at `:458`
    inside `GUIDANCE_TEXT` so the array still ends with `''` before `].join('\n')`
    — that preserves the exact trailing shape for degraded hosts.
  - `src/skills.mjs`: delete the `codebase-memory` entry (`:46-56`).
  - Delete the `skills/codebase-memory/` directory.
  - `src/plugin.mjs`: import `CODE_INTELLIGENCE_GUIDANCE`, compute
    `guidanceText` as above inside `registerPrompt` (so it is evaluated per
    apply, after `createRuntime`), and pass it to `systemPrompt.section`.
    Import `cbm` if Task 4 has not already.

- [ ] **Step 4: Run.** `node --test test/*.test.mjs` → `tests 1124, pass 1124, fail 0` (+2).
  `test/skills.test.mjs:114` is dynamic and needs no edit; confirm it still passes.

- [ ] **Step 5: Commit.**
  `git commit -am "skills: drop the duplicate codebase-memory skill; gate CI guidance"`

---

## Task 7: Demote the dependency declaration

The guard function itself needs **no change**: `checkRuntimeImports(deps, ...)`
already derives its allowed set from `Object.keys(deps)`. Merging the peer map at
the two call sites is sufficient.

**Files:**
- Modify: `package.json`
- Modify: `scripts/runtime-deps-check.mjs` (its own `checkRuntimeImports` call)
- Modify: `test/runtime-deps-check.test.mjs` (assertion at `:87-91`, call at `:97`, append one test)

**Interfaces:**
- `package.json`: `@lovedolove/dsh-codebase-memory-mcp` leaves `dependencies`
  (which is currently its only entry, so it becomes `{}`) and moves into
  `peerDependencies` (`"^0.1.6"`) with
  `peerDependenciesMeta["@lovedolove/dsh-codebase-memory-mcp"].optional = true`.
- Both call sites become
  `checkRuntimeImports({ ...(pkg.dependencies ?? {}), ...(pkg.peerDependencies ?? {}) }, fileMap)`.
- `engines.node` becomes `">=22.12.0 <25.0.0"` and
  `dsh.compatibility.nodeVersions` the same — `require(esm)` is unflagged only
  from Node 22.12.0, and DSH itself requires `>=24.9.0`, so no real host is
  affected.

- [ ] **Step 1: Write the failing test.** Append to
  `test/runtime-deps-check.test.mjs`, which already imports `readFileSync` from
  `node:fs` at `:3` — do not re-import it inside the test.

```js
test('CBM is declared as an optional peer, not a runtime dependency', () => {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
  // Not `deepEqual(dependencies, {})`: a future legitimate dependency must not
  // break a test that only cares where CBM is declared.
  assert.equal(pkg.dependencies?.['@lovedolove/dsh-codebase-memory-mcp'], undefined)
  assert.ok(pkg.peerDependencies?.['@lovedolove/dsh-codebase-memory-mcp'])
  assert.equal(pkg.peerDependenciesMeta?.['@lovedolove/dsh-codebase-memory-mcp']?.optional, true)
  assert.match(pkg.engines.node, />=22\.12\.0/)
})
```

- [ ] **Step 2: Run, expect failure.**

- [ ] **Step 3: Implement.**

  - Edit `package.json`: empty `dependencies`, add the peer entries, bump both
    Node ranges to `">=22.12.0 <25.0.0"`.
  - `test/runtime-deps-check.test.mjs:87-91`: replace the
    `assert.ok(pkg.dependencies?.['@lovedolove/dsh-codebase-memory-mcp'], ...)`
    assertion with the peer assertion above.
  - Update both `checkRuntimeImports` invocations to merge peer declarations.
  - `scripts/runtime-deps-check.mjs`: merge peer declarations at its own call
    site; add a one-line comment stating that an optional peer is a declared
    dependency for this check, because the bridge resolves it at runtime and
    degrades when it is missing.

- [ ] **Step 4: Run.** `node --test test/*.test.mjs` → `tests 1125, pass 1125, fail 0` (+1).
  Also run `node scripts/runtime-deps-check.mjs` → exits 0.

- [ ] **Step 5: Commit.**
  `git commit -am "package: declare CBM as an optional peer; require Node 22.12+"`

---

## Task 8: Make the documentation true

**Files:**
- Modify: `AGENTS.md` §2
- Modify: `docs/agent-guides/cbm-integration.md`
- Modify: `docs/agent-guides/release-and-packaging.md:16`
- Modify: `docs/agent-guides/engineering-principles.md:40`
- Modify: `docs/agent-guides/architecture.md:39`
- Modify: `docs/agent-guides/README.md:19`
- Modify: `README.md:43`, `:153`
- Modify: `CHANGELOG.md`

**Interfaces:** none — documentation only. No test changes; suite stays at
`1125`.

- [ ] **Step 1: `AGENTS.md` §2.** Replace the "CBM stays a dependency, not a copy"
  paragraph with:
  > **CBM stays a separate package.** Veyra loads it through
  > `src/cbm-bridge.mjs`, which is the only file naming the specifier and which
  > degrades to a frozen stub when the package is absent. Do not copy bridge
  > internals into `src/`, and do not register `cbm_*` tools — those belong to
  > the Codebase Memory plugin.

- [ ] **Step 2: `docs/agent-guides/cbm-integration.md`.**
  - Redraw the diagram's last box as
    `@lovedolove/dsh-codebase-memory-mcp   (optional peer, loaded via src/cbm-bridge.mjs)`.
  - Replace "Veyra registers the six `cbm_*` tools **through the bridge's
    factory**…" with a statement that CBM's own plugin registers them and Veyra
    defines none. This also covers the paragraph after it, which currently ends
    "…Veyra's guidance text and the `codebase-memory` skill tell the agent when
    to prefer them" — the skill is deleted in Task 6.
  - Replace the "When the native binary is absent:" bullet list under
    `## Degraded mode is a first-class state` with: the bridge reports
    `available: false`, the engine is a null-object, `veyra_code_status`
    reports degraded, and all Veyra Memory features continue. The first bullet
    ("`cbm_*` tools and `veyra_code_status` return a structured error with
    install guidance") is the false one — the `cbm_*` tools are not registered
    at all. Keep the section's closing paragraph and the "Automatic recall
    context carries the degraded flag" bullet: both remain true.
  - Keep "Do not reimplement, vendor, or copy bridge internals into `src/`"
    verbatim — it is still true.

- [ ] **Step 3: the four agent guides that still assert CBM is the runtime
  dependency.** Task 7 moves CBM out of `dependencies`, so each of these becomes
  false unless edited. They are one sentence each; keep the edits that small.

  - `docs/agent-guides/release-and-packaging.md:16` — replace
    "Exactly one runtime dependency today: `@lovedolove/dsh-codebase-memory-mcp`."
    with: Veyra has no required runtime dependency. `@lovedolove/dsh-codebase-memory-mcp`
    is an optional peer that `src/cbm-bridge.mjs` resolves at runtime; when it is
    absent Veyra loads and its memory features run normally.
  - `docs/agent-guides/engineering-principles.md:40` — replace
    "(`package.json` declares one: `@lovedolove/dsh-codebase-memory-mcp`)"
    with a clause saying CBM is a declared optional peer, not a required
    dependency, and **change step 2 of the four-step rule** from "A declared
    entry in `dependencies` (never `bundledDependencies`)" to "A declared entry
    in `dependencies` or `peerDependencies` (never `bundledDependencies`)". Do
    not touch step 1 (evidence), step 3 (`node scripts/runtime-deps-check.mjs`),
    or step 4 (review the install path) — all three remain exactly right.
  - `docs/agent-guides/architecture.md:39` — in the Code Intelligence layer row,
    mark `@lovedolove/dsh-codebase-memory-mcp` as an optional peer resolved via
    `src/cbm-bridge.mjs`. Leave the native-daemon half of the row alone: the
    daemon really is external and CBM really does own it.
  - `docs/agent-guides/README.md:19` — change the cbm-integration.md index line
    from describing "the `@lovedolove/dsh-codebase-memory-mcp` dependency" to the
    optional bridge and what degrades without it.

  Add one sentence to `docs/agent-guides/cbm-integration.md` (already in Step 2's
  file) stating that `scripts/runtime-deps-check.mjs` treats a declared optional
  peer as declared, because the bridge resolves it at runtime.

- [ ] **Step 4: `README.md`.**
  - `:43`: state that when the CBM plugin is absent Veyra loads and runs its
    memory features, and Code Intelligence reports itself unavailable; when
    present, the CBM plugin provides the six `cbm_*` tools.
  - `:153`: state that without CBM the `cbm_*` tools are simply not registered
    (they belong to that plugin) and `veyra_code_status` reports degraded.

- [ ] **Step 5: `CHANGELOG.md`.** Under an Unreleased/next entry, record:
  - Veyra loads without the Codebase Memory package; the bridge degrades.
  - `cbm_*` ownership moved to the Codebase Memory plugin (6 definitions
    removed; 17 → 11 tools; 5 → 4 bundled skills).
  - Dependency declaration demoted to an optional peer; **this does not
    uninstall CBM** — pnpm installs optional peers, and a profile that declares
    CBM directly keeps it.
  - Minimum Node raised to 22.12.0 for `require(esm)`.

- [ ] **Step 6: Run and commit.**
  `node --test test/*.test.mjs` → `tests 1125, pass 1125, fail 0`.
  `git commit -am "docs: describe CBM as an optional plugin, not a dependency"`

---

## Spec Coverage

| Spec section | Task |
| --- | --- |
| §2 measured coupling (context for every task) | 1–8 |
| §4 bridge module, never throws, loaded once, copies nothing | 2 |
| §4.1 per-symbol absent behaviour | 2, 3, 4 |
| §4.2 `CODE_FRESHNESS` wire contract + parity test | 1, 2 |
| §4.3 degraded engine | 2 (**amended: eight members, not six** — `getStatus` and `traceCallPath` are called at `src/commands.mjs:399`, `:442`, `src/tools.mjs:840`) |
| §4.4 `resolveSafeRepoPath` absent ⇒ `null` (no anchor) for capture, fail-closed for trust | 3 |
| §5.1 removals (splice, imports, skill) | 5, 6 |
| §5.2 removal not delegation | 5 |
| §5.3 `registerTools` stays duplicate-tolerant | 5 (no change — verified by Task 5's suite run) |
| §6 conditional guidance | 6 |
| §7 manifest | 7 |
| §8 guardrail amendments | 7 (`runtime-deps-check`), 8 (`AGENTS.md`, `cbm-integration.md`) |
| §8 fallout: four guides asserting CBM is the runtime dependency (`release-and-packaging.md:16`, `engineering-principles.md:40`, `architecture.md:39`, `README.md:19`) | 8 (not in the spec — discovered during self-review; Task 7 falsifies them) |
| §9 test plan | 1–8 (**amended: three tests deleted, so the target is 1125, not 1118**) |
| §10 Node floor → option (a) | 7 |
| §11 stated limits | 8 |
| §12 acceptance criteria | final review |
| §13 risks (warn-once logging) | **deferred** — see Execution Order note |

## Execution Order

Tasks 1 → 8 in order. Dependencies:

- Task 2 requires Task 1 (`CODE_FRESHNESS`).
- Task 3 requires Task 2.
- Task 4 requires Task 3 (the specifier scan only passes when every caller uses
  the bridge).
- Task 5 requires Task 4 (the splice line is only safe to delete after the import
  is bridge-based).
- Task 6 requires Task 4 (needs `cbm` in `plugin.mjs`).
- Task 7 requires Tasks 2–6 (the guard must pass with the final file set).
- Task 8 requires Task 7 (it documents the shipped state).

Two deliberate scope decisions:

1. **§13's warn-once logging is not implemented.** Distinguishing "package absent"
   from "package present but broken" needs a filesystem probe that a
   `createRequire` failure does not give us, and the spec itself classes it as a
   risk mitigation rather than an acceptance criterion. A host that is missing
   CBM behaves identically whether the install is broken or simply absent, and
   both are covered by `veyra_code_status` reporting degraded. Revisit only if a
   real broken-install case is observed.
2. **The `defs.length` comment is corrected, not just the number.** The original
   comment's own arithmetic was wrong (it claimed 9 `veyra_*` where there are 11
   definitions including `veyra_code_status`).

Final verification for the whole branch:

```
node --test test/*.test.mjs        # tests 1125, pass 1125, fail 0
node scripts/runtime-deps-check.mjs
grep -rn "@lovedolove/dsh-codebase-memory-mcp" src/     # only src/cbm-bridge.mjs
grep -rn "cbm_" src/ | grep -v cbm-bridge               # no tool definitions
git diff --stat                                          # only the files above
```
