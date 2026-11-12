# Code Intelligence

Code Intelligence answers a different question from memory. Memory holds what
was learned; Code Intelligence reports what the code is right now, from the live
AST.

It is optional. Without it, every memory feature keeps working.

---

## Two pieces, both separate from Veyra

| Piece | What it is | Where it comes from |
| --- | --- | --- |
| Codebase Memory plugin | Registers the six `cbm_*` tools and the bridge code | [`@lovedolove/dsh-codebase-memory-mcp`](https://www.npmjs.com/package/@lovedolove/dsh-codebase-memory-mcp) |
| Native engine | The `codebase-memory-mcp` binary that indexes and answers queries | [DeusData/codebase-memory-mcp](https://github.com/DeusData/codebase-memory-mcp) |

Veyra declares the plugin package as an **optional peer** and loads it through
`src/cbm-bridge.mjs`. That file is the only place in `src/` that names the
package. When the package is absent, the bridge returns a frozen stub and Veyra
continues.

Veyra ships no native binary and no bridge internals. It keeps only two files of
its own in this area: `src/code/linking.mjs` (evidence anchors against code
freshness) and `src/code/retrieval.mjs` (the retrieval pipeline that consumes
freshness).

**Demoting the dependency does not uninstall it.** The change buys load safety,
not removal: pnpm installs optional peers by default, and a profile that already
lists the plugin keeps it.

---

## Installing it

```sh
# the plugin: registers the six cbm_* tools
dsh plugin --profile web add @lovedolove/dsh-codebase-memory-mcp

# the native engine
curl -fsSL https://raw.githubusercontent.com/DeusData/codebase-memory-mcp/main/install.sh | bash
```

The installer places the binary in `~/.local/bin` on Linux and macOS, and in
`%LOCALAPPDATA%\Programs\codebase-memory-mcp\` on Windows. Set
`CBM_EXE=/path/to/binary` to use an existing install instead.

---

## What you get

| Tool | What it does |
| --- | --- |
| `cbm_projects` | List indexed projects |
| `cbm_search` | Find symbols, functions, classes, and files by name or label |
| `cbm_snippet` | Retrieve an exact symbol definition with line context |
| `cbm_trace` | Trace the inbound or outbound call graph from a symbol |
| `cbm_arch` | Directory-level component dependency overview |
| `cbm_search_code` | Regex search over indexed repository files |

Veyra adds `veyra_code_status` (index status and per-memory freshness) and
`veyra_change_impact` (changed files to affected memories).

---

## Freshness

Every memory whose evidence anchors point into the repository is checked at read
time against the current code.

| Status | Meaning |
| --- | --- |
| `fresh` | The anchored file and symbol still resolve as recorded |
| `potentially_stale` | The anchored file changed since the record was written |
| `invalid` | The anchored file or symbol no longer exists |

Stale records are penalized in retrieval rather than hidden, and every recalled
record carries its trust category. See the
[memory model](./memory-model.md#5-trust-at-read-time).

### When the layer is unavailable

If the bridge is absent, Veyra cannot resolve anchors at all. It reports the
freshness as **unverifiable** rather than inventing a reason. That is different
from `stale`: an unresolvable path because the checker is missing says nothing
about whether the code changed.

The classification is `insufficient_evidence`, the render marks the bullet as
unverifiable, and retrieval does not apply the stale penalty. A memory that
cannot be checked is not a memory that is wrong.

---

## Degraded mode

Without the plugin, the six `cbm_*` tools are simply not registered.
`veyra_code_status` returns a structured error with install guidance. Memory
tools, slash commands, the Observatory, the Network Graph, and hybrid search are
unaffected.

Without the native binary but with the plugin installed, the plugin registers
its tools and they report the missing engine. Veyra's guidance text names the
capability as unavailable rather than claiming the plugin is not installed.

A package that is present but fails to load is different from a package that is
absent. Veyra warns once through the plugin log for the first case and stays
silent for the second, because a clean install should not produce warnings.

---

## Design boundary

Code Intelligence never modifies Veyra memory directly. It can mark a record
stale, and it can tell retrieval to rank it lower. It cannot change a record's
authority, validation, or content.

The rule holds in both directions: a memory never overrides what the code says.
Repository truth wins.
