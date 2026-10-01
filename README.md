# Veyra

> **Veyra — Engineering Intelligence for Coding Agents**

Veyra is a plugin for [DeepSeek Harness](https://github.com/deepseek-ai/DeepSeek-Harness) (DSH) that gives your coding agent a persistent, evidence-backed engineering memory **and** a structural code intelligence layer — the Dual-Brain architecture.

[![npm](https://img.shields.io/npm/v/@lovedolove/veyra)](https://www.npmjs.com/package/@lovedolove/veyra)
[![license](https://img.shields.io/badge/license-MIT-blue)](https://github.com/LoveDoLove/Veyra/blob/main/LICENSE)
[![CI](https://github.com/LoveDoLove/Veyra/actions/workflows/ci.yml/badge.svg)](https://github.com/LoveDoLove/Veyra/actions/workflows/ci.yml)

---

## The Dual-Brain architecture

Veyra runs two complementary layers that answer different questions:

| Brain | What it holds | Source of truth |
| --- | --- | --- |
| **Veyra Memory** | Engineering lessons, root causes, decisions, constraints, and causal chains (`symptom → rootCause → remedy → verifiedOutcome`) — with evidence anchors, validation states, and authority levels | Epistemic state that accumulates across sessions |
| **Code Intelligence** | AST-level structural facts: symbols, files, call graphs, class hierarchies — always derived from the live repository | The repository itself, via `codebase-memory-mcp` |

**These are not the same thing.** A Veyra memory record that says "the login function was refactored to use JWTs" is an engineering lesson; the call graph of `login()` today is structural truth. Code Intelligence can mark a memory *potentially stale* when files it references have changed — it never silently overwrites Veyra memory.

---

## What Veyra does

- **Persistent engineering memory.** Every record carries evidence anchors, a validation state (`unverified → reviewed → verified`), an authority level (`candidate → derived → canonical`), and causal facets. Your repository stays authoritative; Veyra never writes into it.
- **Hybrid search.** One query, several signals: FTS5 BM25 + symbol/path boosts, token-level semantic overlap, intent affinity (why / how / what-changed), and relationship graph cohesion — with a transparent score breakdown.
- **Code Intelligence.** When `codebase-memory-mcp` is installed, seven agent tools give structural call-graph tracing, AST-level symbol search, file/component architecture summaries, and code-grounded search. When it is not installed, Veyra Memory runs normally without interruption.
- **Memory freshness.** Code Intelligence watches changed files, flags memories whose evidence anchors point to modified or deleted code, and applies retrieval penalties to stale records.
- **Human surfaces.** `/veyra` slash commands, a read-only Knowledge Observatory, and an interactive Network Graph at `/veyra` in DSH Web.
- **Zero runtime npm dependencies.** The package is pure ESM, ~130 kB packed.

---

## Contents

- [Install](#install)
- [Quick Start](#quick-start)
- [How memory works](#how-memory-works)
- [Code Intelligence](#code-intelligence)
- [Features](#features)
- [Commands](#commands)
- [Tools](#tools)
- [Skills](#skills)
- [Memory rules](#memory-rules)
- [Configuration](#configuration)
- [Architecture](#architecture)
- [Troubleshooting](#troubleshooting)
- [Development](#development)
- [Compatibility](#compatibility)
- [License](#license)

---

## Install

```sh
dsh plugin --profile web add @lovedolove/veyra
```

Restart DSH (or reload the profile) — Veyra activates automatically. No API keys, no external services, no configuration required to start using memory.

---

## Quick Start

1. **Do real work in DSH.** Veyra observes session events automatically.
2. **At end of turn**, Veyra distills what happened into a candidate memory. Durable lessons become *derived* memory linked to neighbors.
3. **Check what was stored:**

   ```
   /veyra recent
   ```

4. **Ask for it back.** In a later session in the same project, automatic recall injects the most relevant records into the turn — each marked `not repository truth`. Or search explicitly:

   ```
   /veyra recall sqlite wal
   ```

5. **Inspect, curate, and promote:**

   ```
   /veyra inspect vey_…           deep evidence, provenance, causal facets
   /veyra forget vey_…            soft-forget (leaves recall, stays inspectable)
   /veyra promote vey_… canonical only ever explicit, only ever on your word
   ```

6. **See it as a graph.** Open `/veyra` in the DSH Web address bar — a bounded workspace overview; `/veyra?id=<record>` centers the 1-hop Local Graph.

7. **Unfamiliar repo?** Load the bundled `legacy-onboarding` skill — it builds a Project Memory Baseline from evidence before your first change.

---

## How memory works

1. Veyra observes session activity without touching your files.
2. End of a turn: Veyra distills the turn into a candidate — files, symbols, test outcomes, claim signal, and structured causal facets. Durable, grounded lessons become *derived* memory and are linked to neighbors (extended, updated, or contradicted). Near-duplicates are not cloned; repeated observations and verified outcomes strengthen existing records rather than adding new ones.
3. Automatic recall injects the top-N most relevant records into the agent's system-prompt context at the start of each turn, with a clear `not repository truth` notice.
4. Validation advances (`unverified → reviewed → verified`) as the same lesson is confirmed across sessions and test outcomes. **Nothing becomes `canonical` without an explicit human instruction.**

---

## Code Intelligence

Code Intelligence is an **optional** structural layer powered by the external [codebase-memory-mcp](https://github.com/DeusData/codebase-memory-mcp) native daemon. Veyra does not bundle a native binary.

### Install the native engine

```sh
curl -fsSL https://raw.githubusercontent.com/DeusData/codebase-memory-mcp/main/install.sh | bash
```

The upstream installer places the binary in `~/.local/bin` on Linux/macOS and `%LOCALAPPDATA%\Programs\codebase-memory-mcp\` on Windows. See the [upstream README](https://github.com/DeusData/codebase-memory-mcp) for supported platforms and verification details.

Or set `CBM_EXE=/path/to/codebase-memory-mcp` to point to a pre-existing binary.

### When the binary is absent

Code Intelligence enters **degraded mode**: all seven `cbm_*` tools and `veyra_code_status` return a structured error with installation guidance. All Veyra Memory tools, Observatory, slash commands, and hybrid search continue working without any interruption.

### What Code Intelligence provides

| Tool | What it does |
| --- | --- |
| `cbm_projects` | List indexed projects |
| `cbm_search` | Find symbols, functions, classes, files by name/label |
| `cbm_snippet` | Retrieve exact symbol definition with line context |
| `cbm_trace` | Trace inbound/outbound call graph from a symbol |
| `cbm_arch` | Directory-level component dependency overview |
| `cbm_search_code` | Regex search over indexed repository files |
| `veyra_code_status` | Index status and memory freshness report |

### /veyra code commands

| Command | What it does |
| --- | --- |
| `/veyra code status` | Index status and per-memory freshness (`FRESH / POTENTIALLY_STALE / INVALID`) |
| `/veyra code index` | Trigger repository reindexing |
| `/veyra code trace <symbol>` | Trace call graph for a symbol |
| `/veyra code impact` | Check which memories reference recently changed code |

### Code truth vs. Veyra memory

The distinction matters:

- **Code Intelligence** reports structural facts from the live AST: who calls `login()`, what `AuthService` exposes. These are authoritative for the current state of the repository.
- **Veyra Memory** records engineering knowledge: why `login()` was changed, what the failure mode was, what the constraint is for future callers. These persist *across* refactors — and Code Intelligence will flag them as potentially stale when the referenced file changes, so you know to verify them.

Neither brain replaces the other.

---

## Features

| Feature | Description |
| --- | --- |
| Ambient memory loop | Observes session events, distills turns into candidates, learns durable lessons, strengthens repeats, marks drifted knowledge stale. |
| Hybrid Search | FTS5 BM25 + symbol/path boosts, token-level semantic overlap, intent affinity, relationship graph cohesion — with a transparent score breakdown. |
| Unified RAG | `kind: 'knowledge'` records hold project documentation next to engineering memory; both are searched together. |
| Causal knowledge | Structured `symptom → rootCause → remedy → verifiedOutcome` facets, contradiction detection, and side-by-side conflict views. |
| Code freshness | Evidence anchors track files and symbols; changed or deleted files mark memory `POTENTIALLY_STALE` or `INVALID` and apply retrieval penalties. |
| Knowledge Observatory | Read-only text dashboard: overview, search signals, record inspection, causality, relationships, contradictions, and consolidation proposals. |
| Network Graph | Host-native SVG page at `/veyra` (overview + 1-hop Local Graph), served by the DSH web server; JSON at `/veyra/graph`, `/veyra/record`, `/veyra/search`. |
| Settings | `Recall limit` and `Include reusable` in the DSH Settings dialog (Veyra section); changes apply from the next turn, no restart. |
| Project isolation | Memory is keyed by workspace path + git remote. Two unrelated folders never share memory; `scope: 'reusable'` is opt-in. |
| Secret redaction | Secrets are redacted before anything is stored. |

---

## Commands

| Command | What it does |
| --- | --- |
| `/veyra` | Status and memory counts for this workspace |
| `/veyra observatory` | Knowledge Observatory overview |
| `/veyra observatory search <query>` | Inspect hybrid search signals and score breakdowns |
| `/veyra observatory record <id>` | Deep inspection (What, Why, Where, When, Evidence, Validation) |
| `/veyra observatory causality` | Causal knowledge map |
| `/veyra observatory relationships [id]` | Directed graph projection of knowledge links |
| `/veyra observatory local <id>` | 1-hop Local Graph around a record |
| `/veyra observatory contradictions` | Active conflicting claims side-by-side |
| `/veyra observatory consolidation` | Consolidation candidates — read-only, never changes records |
| `/veyra recall [query]` | Hybrid search project (+ reusable) memory |
| `/veyra recent` | Recent records, including candidates |
| `/veyra inspect <id>` | Read one record with deep provenance and causal facets |
| `/veyra forget <id>` | Soft-forget |
| `/veyra promote <id> [derived\|canonical]` | Change standing — **canonical only on explicit user request** |
| `/veyra code status` | Code Intelligence index status and memory freshness |
| `/veyra code index` | Trigger repository reindexing |
| `/veyra code trace <symbol>` | Trace call graph for a symbol |
| `/veyra code impact` | Check memories affected by changed code |
| Network Graph | `/veyra` in DSH Web; `/veyra?id=<record>` centers the 1-hop view |

---

## Tools

**Memory tools** (always available):
`veyra_remember`, `veyra_recall`, `veyra_inspect`, `veyra_forget`, `veyra_promote`

**Code Intelligence tools** (require `codebase-memory-mcp` binary; degrade gracefully when absent):
`cbm_projects`, `cbm_search`, `cbm_snippet`, `cbm_trace`, `cbm_arch`, `cbm_search_code`, `veyra_code_status`

Load the bundled `veyra` skill for full guidance on when to call each tool and how they interact.

---

## Skills

Four skills ship inside the package and register automatically (no separate install):

| Skill | Use it when |
| --- | --- |
| `veyra` | You need Veyra's own guidance: tool usage, candidate/derived/canonical, causal facets, hybrid search semantics, and the rule that repo truth wins. |
| `codebase-memory` | You are using Code Intelligence tools (`cbm_*`): when to prefer `cbm_trace` vs. grep, how to navigate from a symbol to its call graph, and how Code Intelligence and Veyra Memory complement each other. |
| `legacy-onboarding` | First entry into an unfamiliar or legacy repo: baseline assessment, progressive investigation depth, evidence-first extraction, and building a Project Memory Baseline. |
| `memory-review` | You want to audit this conversation for durable engineering memory: what is already recorded, what is missing, what looks stale or conflicting. |

---

## Memory rules

| What | Authority | Auto-recalled? |
| --- | --- | --- |
| Auto-captured observation | `candidate` | no |
| Remembered / learned lesson | `derived` | yes |
| Explicitly promoted truth | `canonical` | yes |

Canonical is never assigned automatically. Repository files stay authoritative — Veyra never writes into your repo. Similarity is not identity: overlapping memories are linked, not merged. Secrets are redacted. Projects are isolated; reusable memory is opt-in.

---

## Configuration

DSH Settings exposes **Recall limit** and **Include reusable** under a dedicated **Veyra** section. A saved change applies from the next turn, no restart.

`recallLimit: 0` disables automatic recall context only — tools, `/veyra`, Observatory, and stored memory all stay available.

Everything else is configured in the profile `cordis.patch.yml`:

```yaml
- id: veyra
  name: '@lovedolove/veyra'
  config:
    recallLimit: 5       # 0 = no automatic recall context (also settable in Settings)
    includeReusable: true
    observe: true        # capture session activity
    learn: true          # promote durable observations
    codebaseWatch: true  # watch repo for file changes to flag stale memories
    home: "~/.dsh/veyra" # storage root (yaml-only)
```

`observe` / `learn` / `home` / `codebaseWatch` are yaml-only. `VEYRA_HOME` overrides the storage root from the environment.

---

## Architecture

```
  DSH host — Cordis plugin (src/plugin.mjs)
  session events ──► observe ──► candidate ──► learn ──► derived memory
                                                      │
  ┌──────────────────────────────────────────────────────────────────────────┐
  │  SQLite store  ~/.dsh/veyra/  (node:sqlite + FTS5, one DB per project)  │
  └──────────────────────────────────────────────────────────────────────────┘
        projections (read-only)
  ┌───────────────┬────────────────┬─────────────────┬────────────────────────┐
  ▼               ▼                ▼                 ▼
  Hybrid Search   Local Graph      Agent context     Human surfaces
  recall/tools    (1-hop, bounded) systemPrompt      /veyra commands
  observatory     src/graph.mjs    (fail-closed)     Observatory / Network Graph

  ┌──────────────────────────────────────────────────────────────────────────┐
  │  Code Intelligence  src/code/  (optional — requires codebase-memory-mcp)│
  │                                                                          │
  │  stdio JSON-RPC 2.0 ──► cbm_* tools ──► freshness checks ──► retrieval  │
  │  client.mjs  engine.mjs  discovery.mjs  linking.mjs  watcher.mjs        │
  │                                                                          │
  │  Degraded when binary absent: memory layer unaffected                   │
  └──────────────────────────────────────────────────────────────────────────┘
```

The local graph is a **derived projection, not a second store**. Code Intelligence is an **optional layer** communicating with an external native daemon over stdio; it never modifies Veyra Memory directly.

Full write-up: [docs/architecture-graph.md](https://github.com/LoveDoLove/Veyra/blob/main/docs/architecture-graph.md)

---

## Troubleshooting

**No `[veyra]` lines at boot.** The plugin was installed into a different profile than the one you booted. `dsh plugin --profile web add …` installs into `web`; booting `dsh tui` will not have it. Also check **Settings → Plugins**.

**Node is too old.** Veyra requires Node ≥ 22.5 and < 25 (`engines.node`). It uses `node:sqlite`, which first shipped in Node 22.5. Upgrade Node, then reinstall.

**"Plugin … is incompatible with dsh …"** The package's compatibility range is `>=0.1.2-rc.1 <0.3.0-0`. Update DSH, or accept the risk with the exact-version exemption DSH prints.

**Automatic recall context is empty.** Check: (1) `recallLimit` is not `0` — Settings → Veyra; (2) records you expect are not still `candidate` (candidates are never auto-recalled); (3) you are in the same project — run `/veyra` and confirm the workspace path and project id.

**Code Intelligence shows "degraded".** The `codebase-memory-mcp` binary is not on your PATH and `CBM_EXE` is not set. Install via the curl command above or set `CBM_EXE=/path/to/binary`. All Veyra Memory tools continue working.

**`/veyra code status` reports stale memories.** The referenced files changed since the memory was recorded. Verify the memory against the current repo (`/veyra inspect <id>`), update it with `veyra_remember`, or forget it if it no longer applies.

**The Network Graph page looks empty.** Either the workspace has no records yet (`/veyra recent`), or the page resolves a different workspace — `/veyra` prints the workspace path it uses.

**Where is my data / how do I reset.** `$DSH_HOME/veyra/` (default `~/.dsh/veyra/`), or `$VEYRA_HOME` if set. Delete a project's store to start over; nothing is stored in your repository.

**Something wrote wrong memory.** `/veyra forget <id>` soft-forgets (inspectable, out of recall). Nothing becomes `canonical` without you running `/veyra promote <id> canonical`.

---

## Development

```sh
npm test               # node --test test/*.test.mjs  (456 tests)
npm run pack:check     # npm pack --dry-run — what would be published
```

CI runs both on Node 22 and 24 for every push and pull request.
Publishing is automatic: every push to `main` publishes to npm (patch-bumped first if the version already exists) unless the commit message contains `[skip publish]`. Every published version gets a matching GitHub Release tagged `vX.Y.Z`.

---

## Compatibility

| | |
| --- | --- |
| Node | `>=22.5.0 <25.0.0` |
| DSH | `>=0.1.2-rc.1 <0.3.0-0` |
| Verified on | DSH `0.1.7-rc.2` (plugin boot, tools, `/veyra` + `/veyra/graph`); DSH `0.2.0-rc.1` (real compatibility gate + composed-host-service runtime); CI on Node 22 and 24 |
| Profiles | Installed per profile (`web`, `tui`, …); Settings section and Network Graph require the web surface |
| Storage | `node:sqlite` + FTS5, one DB per project under the Veyra home |
| Code Intelligence | Optional; requires external `codebase-memory-mcp` binary (MIT, DeusData) |
| License | MIT |

Veyra is on a pre-1.0 `0.1.x` line — see the [CHANGELOG](https://github.com/LoveDoLove/Veyra/blob/main/CHANGELOG.md) for what shipped. APIs and command surface may still change between minor versions.

---

## License

MIT — see [LICENSE](https://github.com/LoveDoLove/Veyra/blob/main/LICENSE).

Third-party attributions — see [THIRD_PARTY.md](https://github.com/LoveDoLove/Veyra/blob/main/THIRD_PARTY.md).
