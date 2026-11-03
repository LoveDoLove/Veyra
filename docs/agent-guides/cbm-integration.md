# CBM / Code Intelligence Integration

## The boundary

Code Intelligence is an **external dependency**, not Veyra code.

```text
Veyra (this repo)
  src/plugin.mjs          imports the bridge, wires the engine and watcher
  src/code/linking.mjs    evidence anchor <-> code freshness
  src/code/retrieval.mjs  unified memory + structural retrieval
  src/tools.mjs           veyra_code_status, veyra_change_impact
        |
        v
@lovedolove/dsh-codebase-memory-mcp   (declared runtime dependency)
  discovery - client - engine - watcher - cbm_* tool definitions - bridge
        |  stdio JSON-RPC 2.0
        v
codebase-memory-mcp native daemon      (optional, external binary, MIT, DeusData)
```

Everything below the first box belongs to the bridge package. **Do not
reimplement, vendor, or copy bridge internals into `src/`.** A previous attempt
to bundle the bridge was removed deliberately (see `CHANGELOG.md`); the current
shape — a declared dependency — is the intended one.

## What Veyra imports

`src/plugin.mjs` imports `CodeIntelligenceEngine`, `RepositoryWatcher`,
`FRESHNESS_STATUS`, `autoStartCodebaseMemory`, `findExe`, `getOrCreateClient`,
`createClient`, and `cbmApply` from the bridge, and re-exports several of them.
`src/tools.mjs` imports `createCbmToolDefinitions`; `src/commands.mjs`,
`src/code/linking.mjs`, and `src/code/retrieval.mjs` also import from the bridge
(`FRESHNESS_STATUS`, `resolveSafeRepoPath`, `sanitizeCodeContent`).

Veyra registers the six `cbm_*` tools **through the bridge's factory**, not by
defining them itself. `src/tools.mjs` imports `createCbmToolDefinitions` and
splices the result into `buildToolDefinitions`, so the tool definitions,
schemas, and execute paths all live in the bridge package. The six tools are
`cbm_projects`, `cbm_search`, `cbm_snippet`, `cbm_trace`, `cbm_arch`, and
`cbm_search_code`; Veyra's guidance text and the `codebase-memory` skill tell
the agent when to prefer them.

## Degraded mode is a first-class state

When the native binary is absent:

- `cbm_*` tools and `veyra_code_status` return a structured error with install
  guidance.
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

1. The bridge is declared in `dependencies` — never `bundledDependencies`, and
   never a `file:` or git-tarball install path.
2. `@deepseek-ai/*` packages are host-provided and must stay peer/optional, not
   dependencies.
3. `node scripts/runtime-deps-check.mjs` must pass; it fails on any bare import
   that is neither builtin, host-provided, nor declared.
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
