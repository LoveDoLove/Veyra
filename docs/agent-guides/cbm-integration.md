# CBM / Code Intelligence Integration

## The boundary

Code Intelligence is an **optional external peer**, not Veyra code.

```text
Veyra (this repo)
  src/plugin.mjs          imports the bridge, wires the engine and watcher
  src/code/linking.mjs    evidence anchor <-> code freshness
  src/code/retrieval.mjs  unified memory + structural retrieval
  src/tools.mjs           veyra_code_status, veyra_change_impact
        |
        v
@lovedolove/dsh-codebase-memory-mcp   (optional peer, loaded via src/cbm-bridge.mjs)
  discovery - client - engine - watcher - cbm_* tool definitions - bridge
        |  stdio JSON-RPC 2.0
        v
codebase-memory-mcp native daemon      (optional, external binary, MIT, DeusData)
```

Everything below the first box belongs to the bridge package. **Do not
reimplement, vendor, or copy bridge internals into `src/`.** A previous attempt
to bundle the bridge was removed deliberately (see `CHANGELOG.md`); the current
shape — a declared **optional peer** — is the intended one.

## What Veyra imports

`src/plugin.mjs` imports the bridge namespace once —
`import { cbm, createDegradedEngine } from './cbm-bridge.mjs'`
(`src/plugin.mjs:33`) — and re-exports five helper bindings (`findExe`,
`getOrCreateClient`, `createClient`, `cbmApply`, `autoStartCodebaseMemory`,
`src/plugin.mjs:499-503`) because `src/plugin.mjs` is the package's
`main`/`exports` target. The engine and the watcher are constructed from members
of that namespace: `cbm.CodeIntelligenceEngine` (`src/plugin.mjs:132`) and
`cbm.RepositoryWatcher` (`src/plugin.mjs:198`).

Every other importer goes through the same bridge, never through the package
directly:

- `src/plugin.mjs:33` — `{ cbm, createDegradedEngine }`
- `src/tools.mjs:52` — `{ cbm, createDegradedEngine, resolveRepoPath }`
- `src/commands.mjs:29` — `{ createDegradedEngine }`
- `src/store.mjs:42` — `{ cbm }`
- `src/trust.mjs:28` — `{ resolveRepoPath }`
- `src/understand.mjs:25` — `{ resolveRepoPath }`
- `src/code/linking.mjs:19` — `{ resolveRepoPath }`
- `src/code/retrieval.mjs:20` — `{ cbm }`

Namespace members used under `src/`: `sanitizeCodeContent`, `RepositoryWatcher`,
`CodeIntelligenceEngine`, `getOrCreateClient`, `findExe`, `createClient`,
`closeAllWatchers`, `cbmApply`, `available`, `autoStartCodebaseMemory`.

The six `cbm_*` tools — `cbm_projects`, `cbm_search`, `cbm_snippet`, `cbm_trace`,
`cbm_arch`, and `cbm_search_code` — are registered by the Codebase Memory
plugin's own `apply()`, not by Veyra. Veyra defines only its eleven `veyra_*`
tools. Their schemas and execute paths still live in the bridge package, so
Veyra never owns them; and because Veyra ships no skill naming them, an agent
running without that plugin sees no `cbm_*` tool at all.

## Degraded mode is a first-class state

When the package is absent the bridge reports `available: false` and the engine
is a null-object:

- The six `cbm_*` tools are not registered at all — they belong to the Codebase
  Memory plugin, which is not loaded without it.
- `veyra_code_status` reports degraded, with install guidance.
- All Veyra Memory tools, `/veyra`, Observatory, and hybrid search keep working.
- Automatic recall context carries the degraded flag so reduced evidence is
  visible rather than fabricated.

Never make the memory layer depend on Code Intelligence being available, and
never fabricate structural facts when the engine is degraded.

## Freshness, not authority

`src/code/linking.mjs` answers: given changed files or symbols, which memories
are affected, and does an evidence anchor still resolve? Its output feeds trust
classification and stale review candidates. It must never:

- promote authority,
- auto-invalidate a record,
- or write structural facts into memory as if they were lessons.

Change impact produces review candidates; a human or the normal learning path
decides what happens next.

## Dependency rules

1. The bridge is declared in `dependencies` or `peerDependencies` — today it is
   an optional peer — never `bundledDependencies`, and never a `file:` or
   git-tarball install path. The declaration is still required: demoting it to a
   peer buys load safety, not removal.
2. `@deepseek-ai/*` packages are host-provided and must stay peer/optional, not
   dependencies.
3. `node scripts/runtime-deps-check.mjs` must pass. It reads quoted import
   literals, so it enforces this for every **statically visible** bare import —
   builtin, host-provided, or declared in `dependencies`/`peerDependencies`. It
   cannot see the bridge's own specifier: `src/cbm-bridge.mjs` loads the package
   through `createRequire(…)` with the specifier held in a constant, so
   `extractSpecifiers` returns nothing for that file. A dedicated test in
   `test/runtime-deps-check.test.mjs` ("the bridge specifier is declared even
   though the guard cannot see it") reads the bridge's own constants instead. So
   the guard's coverage of ordinary imports is unchanged and complete; the one
   runtime-resolved specifier is covered by its own test rather than by the scan.
   A declared optional peer counts as declared there, because the bridge
   resolves it at runtime.
4. Upgrading the bridge is a dependency change: bump the range, run the full
   suite, and check the `code-*` tests plus `veyra_code_*` behavior.
5. Do not add a second code-intelligence implementation, a fallback parser, or a
   local symbol index inside Veyra.

## Testing this area

`code-linking.test.mjs`, `code-retrieval.test.mjs`, `code-tools.test.mjs`,
`code-lifecycle.test.mjs`, `code-eager-startup.test.mjs`,
`code-commands.test.mjs`, `change-impact.test.mjs`, and
`phase3-change-context.test.mjs` cover the Veyra-owned glue. They must pass
without a native binary present — degraded behavior is the default in CI.

Never start or index a real repository during tests beyond the temp fixtures the
existing tests already use.
