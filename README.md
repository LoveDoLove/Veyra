# Veyra

> **Veyra — Engineering Intelligence for Coding Agents**

Veyra is a plugin for [DeepSeek Harness](https://github.com/deepseek-ai/DeepSeek-Harness) (DSH) that gives your coding agent a persistent engineering memory.
It observes real work in the harness, keeps durable lessons and project documentation, and recalls them — with evidence — in later sessions and later projects.

[![npm](https://img.shields.io/npm/v/@lovedolove/veyra)](https://www.npmjs.com/package/@lovedolove/veyra)
[![license](https://img.shields.io/badge/license-MIT-blue)](https://github.com/LoveDoLove/Veyra/blob/main/LICENSE)
[![CI](https://github.com/LoveDoLove/Veyra/actions/workflows/ci.yml/badge.svg)](https://github.com/LoveDoLove/Veyra/actions/workflows/ci.yml)

- **Memory, not guesses.** Every record carries evidence anchors, a validation state, and an authority level. Your repository stays authoritative; Veyra never writes into it.
- **Hybrid Search over memory *and* documentation.** Lexical (SQLite FTS5 BM25 + exact symbols), semantic, causal-intent, and relationship signals in one ranked result with a transparent score breakdown.
- **Human surfaces.** `/veyra` slash commands, a read-only Knowledge Observatory, and an interactive Network Graph at `/veyra` in DSH Web.
- **Nothing to babysit.** Automatic capture, learning, and recall are on by default. You only intervene when you want to remember, forget, or promote something explicitly.

---

## Contents

- [Install](#install)
- [Quick Start](#quick-start)
- [How memory works](#how-memory-works)
- [Features](#features)
- [Commands](#commands)
- [Tools](#tools)
- [Skills](#skills)
- [Memory rules](#memory-rules)
- [Configuration](#configuration)
- [Architecture](#architecture)
- [Examples](#examples)
- [Troubleshooting](#troubleshooting)
- [Development](#development)
- [Compatibility](#compatibility)
- [License](#license)

---

## Install

Requirements: **Node ≥ 22.5 and < 25** and **DSH ≥ 0.1.2-rc.1** (`< 0.2.0`).

```sh
dsh plugin --profile web add @lovedolove/veyra
```

Then restart `dsh web`. A healthy boot prints these lines (the async ones can appear in any order):

```
[veyra] plugin loaded (home=/home/you/.dsh/veyra)
[veyra] registered /veyra
[veyra] Network Graph WebUI at /veyra
[veyra] registered skill: veyra, legacy-onboarding
[veyra] registered tools: veyra_remember, veyra_recall, veyra_inspect, veyra_forget, veyra_promote
```

Prefer the GUI? In DSH Web open **Settings → Plugins → Add plugin** and paste the package name `@lovedolove/veyra` — the dialog uses the same package name as the `dsh plugin add` command above.

Memory is stored under `$DSH_HOME/veyra/` (default `~/.dsh/veyra/`), never inside your repository. `VEYRA_HOME` overrides the storage root.

## Quick Start

Goal: go from a fresh install to useful recalled context in a few minutes.

1. **Install and restart** (above), confirm the `[veyra]` boot lines.
2. **Work normally.** Do a couple of real turns in a project — fix something, run tests, make a decision. Veyra observes the session, and at the end of a turn distills it into a *candidate*; durable, grounded lessons become *derived* memory.
3. **Check what it learned:**

   ```
   /veyra
   ```

   You get the project id, workspace, memory counts by authority, and health counts:

   ```
   Veyra project p_2d599165fe7aa1a7
   workspace: /home/you/projects/my-project
   home: /home/you/.dsh/veyra
   project memories: 3 (derived: 2, canonical: 0, candidate: 1)
   health: 1 verified, 2 reviewed
   reusable memories: 0
   ```

4. **Ask for it back.** Start a new session in the same project and ask the agent something like *"what do you already remember about this project's test setup?"* — or just ask a normal question: automatic recall injects the most relevant records into the turn, each with a `not repository truth` disclaimer.
5. **Inspect and curate:**

   ```
   /veyra recent                 # last records, candidates included
   /veyra recall sqlite wal      # hybrid search across project + reusable memory
   /veyra inspect vey_…          # full evidence, provenance, causal facets
   /veyra promote vey_… canonical   # only ever explicit, only ever on your word
   ```

6. **See it as a graph.** Open `/veyra` in the DSH Web address bar (or the **Veyra Network Graph** sidebar entry): a bounded overview of this workspace's records; hover → click → search, and `/veyra?id=<record>` centers the 1-hop Local Graph.
7. **First time in an unfamiliar repo?** Load the bundled `legacy-onboarding` skill — it builds a Project Memory Baseline instead of re-investigating next time.

That is the whole loop: **work → remember → recall → verify against the repo.**

## How memory works

1. **Do engineering in DSH as usual.** Veyra observes session activity without touching your files.
2. **End of a turn:** Veyra distills the turn into a candidate — files, symbols, test outcomes, claim signal, and structured causal facets `symptom → rootCause → remedy → verifiedOutcome`. Durable, grounded lessons become *derived* memory and are linked to neighbors: extended, updated, or contradicted. Near-duplicates are not cloned — repeated observations and verified test outcomes strengthen existing knowledge (`unverified → reviewed → verified`) and accumulate evidence anchors. Nothing is merged silently.
3. **Later sessions:** relevant memory and RAG knowledge are recalled automatically via **Hybrid Search**. Contradictions stay visible on both sides. Superseded, repository-drifted, and long-idle unverified memories drop out of ambient recall. Canonical is never assigned automatically.

Ask the agent to remember something important, or just keep going — automatic recall is already on.

## Features

| Area | What Veyra does |
| --- | --- |
| Ambient memory loop | Observes session events, distills turns into candidates, learns durable lessons, strengthens repeats, and marks drifted knowledge stale. |
| Hybrid Search | One query, several signals: FTS5 BM25 + symbol/path boosts, token-level semantic overlap, intent affinity, relationship graph cohesion — with a full transparent score breakdown. |
| Unified RAG | `kind: 'knowledge'` records hold project documentation next to engineering memory; both are searched together. |
| Causal knowledge | Structured `symptom → rootCause → remedy → verifiedOutcome` facets, plus contradiction detection and side-by-side views. |
| Knowledge Observatory | Read-only text dashboard: overview, search signals, record inspection, causality, relationships, contradictions. |
| Network Graph | Host-native SVG page at `/veyra` (overview + 1-hop Local Graph), served by the DSH web server; JSON at `/veyra/graph`, `/veyra/record`, `/veyra/search`. |
| Settings | `Recall limit` and `Include reusable` in the DSH Settings dialog (Veyra section); changes apply from the next turn, no restart. |
| Project isolation | Memory is keyed by workspace path + git remote. Two unrelated folders never share memory; `scope: 'reusable'` is opt-in. |
| Redaction | Secrets are redacted before anything is stored. |

## Commands

| Command | What it does |
| --- | --- |
| `/veyra` | Status and memory counts for this workspace |
| `/veyra observatory` | Knowledge Observatory overview: aggregate knowledge & health counts |
| `/veyra observatory search <query>` | Inspect hybrid search signals and score breakdowns |
| `/veyra observatory record <id>` | Deep inspection answering the 6 questions (What, Why, Where, When, Evidence, Validation) |
| `/veyra observatory causality` | Causal knowledge map (`symptom → rootCause → remedy → verifiedOutcome`) |
| `/veyra observatory relationships [id]` | Directed graph projection of knowledge links |
| `/veyra observatory local <id>` | 1-hop Local Graph around a record (default graph view) |
| `/veyra observatory graph [id]` | Local Graph when an id is given; otherwise the project edge list |
| `/veyra observatory contradictions` | Active conflicting claims shown side-by-side |
| `/veyra recall [query]` | Hybrid search project (+ reusable) memory |
| `/veyra recent` | Recent records, including candidates |
| `/veyra inspect <id>` | Read one record with deep provenance and causal facets |
| `/veyra forget <id>` | Soft-forget (leaves recall, stays inspectable) |
| `/veyra promote <id> [derived\|canonical]` | Change standing — **canonical only on explicit user request** |
| Network Graph WebUI | Host page at `/veyra` — bounded workspace overview; `/veyra?id=<record>` centers the 1-hop Local Graph |

## Tools

The agent gets the same operations as tools: `veyra_remember`, `veyra_recall`, `veyra_inspect`, `veyra_forget`, `veyra_promote`.
Load the bundled `veyra` skill for full guidance on when to call them.

## Skills

Two skills ship inside the package and register automatically (no separate install):

| Skill | Use it when |
| --- | --- |
| `veyra` | You need Veyra's own guidance: tool usage, candidate/derived/canonical, causal facets, hybrid search semantics, and the rule that repo truth wins. |
| `legacy-onboarding` | First entry into an unfamiliar, legacy, or not-yet-baselined project: baseline assessment, progressive investigation depth, evidence-first extraction, and building a Project Memory Baseline. |

## Memory rules

| What | Authority | Auto-recalled? |
| --- | --- | --- |
| Auto-captured observation | `candidate` | no |
| Remembered / learned lesson | `derived` | yes |
| Explicitly promoted truth | `canonical` | yes |

Canonical is never assigned automatically. Repo files stay authoritative. Similarity is not identity — overlapping memories are linked, not merged. Secrets are redacted. Projects are isolated; reusable memory is opt-in.

## Configuration

DSH Settings exposes **Recall limit** and **Include reusable** under a dedicated **Veyra** section. The Settings dialog writes through the shared DSH settings document, the Host re-validates against Veyra's schema, and the plugin remounts — a saved change applies from the next turn, no restart.

`recallLimit: 0` disables *automatic recalled-memory context only* — tools, `/veyra`, the Observatory, and stored memory all stay available.

Everything else is configured in the profile `cordis.patch.yml`:

```yaml
- id: veyra
  name: '@lovedolove/veyra'
  config:
    recallLimit: 5    # 0 = no automatic recall context (also settable in Settings)
    includeReusable: true
    observe: true      # capture session activity
    learn: true        # promote durable observations
    home: "~/.dsh/veyra"   # storage root (yaml-only)
```

`observe` / `learn` / `home` stay yaml-only, and `VEYRA_HOME` overrides the storage root from the environment.

## Architecture

```
  DSH host — Cordis plugin (src/plugin.mjs)
  session events ──► observe ──► candidate ──► learn ──► derived memory
                                                      │
  ┌───────────────────────────────────────────────────┼────────────────────────────────────────┐
  │  SQLite store  ~/.dsh/veyra/  (node:sqlite + FTS5, one DB per project)                     │
  └───────────────────────────────────────────────────┼────────────────────────────────────────┘
        projections (read-only)                      │
  ┌───┬─────────────────────┬─────────────────────────┬───────────────────┬────────────────────┐
      ▼                     ▼                         ▼                   ▼
      Hybrid Search         Local Graph (1-hop)       Agent context       Human surfaces
      recall / tools        derived, bounded          systemPrompt        /veyra commands
      observatory search    src/graph.mjs             section + context   Observatory text
                                                      (fail-closed)       Network Graph /veyra
```

The graph is a **derived projection, not a second store**; recall expands a bounded 1-hop of recall-eligible neighbors; agent context injection is fail-closed (empty string if recall throws).
Full write-up, including the external-comparison notes: [docs/architecture-graph.md](https://github.com/LoveDoLove/Veyra/blob/main/docs/architecture-graph.md).

## Examples

Real, reproducible examples live in [`examples/`](https://github.com/LoveDoLove/Veyra/tree/main/examples/):

- [`examples/cordis.patch.yml`](https://github.com/LoveDoLove/Veyra/blob/main/examples/cordis.patch.yml) — the plugin entry with every config key.
- [`examples/command-output.md`](https://github.com/LoveDoLove/Veyra/blob/main/examples/command-output.md) — captured `/veyra` output (status, recall, search, record) from a throwaway demo store.
- [`examples/make-demo-output.mjs`](https://github.com/LoveDoLove/Veyra/blob/main/examples/make-demo-output.mjs) — regenerates that file with the real command handler: `node examples/make-demo-output.mjs`.

## Troubleshooting

**No `[veyra]` lines at boot.** The plugin was installed into a different profile than the one you booted. `dsh plugin --profile web add …` installs into `web`; booting `dsh tui` (or another profile) will not have it. Also check **Settings → Plugins** that the plugin is enabled, not just installed.

**Node is too old.** Veyra requires Node ≥ 22.5 and < 25 (`engines.node`), and it uses `node:sqlite`, which first shipped in Node 22.5 — on an older Node the install is rejected or the plugin cannot load. Upgrade Node, then reinstall.

**"Plugin … is incompatible with dsh …" at install.** The package's `dsh.compatibility` range is `>=0.1.2-rc.1 <0.2.0-0`. Update DSH, or accept the risk explicitly with the exact-version exemption DSH prints (`dsh plugin --profile <name> allow-version …`).

**Automatic recall context is empty.** Check three things: (1) `recallLimit` is not `0` — Settings → Veyra; (2) the records you expect are not still `candidate` (candidates are never auto-recalled); (3) you are in the same project — run `/veyra` and confirm the workspace path and project id.

**The Veyra section is missing from Settings.** The section is served by the plugin's server half in the profile you booted. If the plugin is disabled or installed elsewhere, the dialog shows nothing — the rest of DSH Settings is unaffected.

**The Network Graph page looks empty.** Either the workspace really has no records yet (`/veyra recent`), or the page is resolving a different workspace than you expect — `/veyra` prints the workspace path it uses, and the sidebar entry passes the current workspace via `?cwd=`.

**Where is my data / how do I reset.** `$DSH_HOME/veyra/` (default `~/.dsh/veyra/`), or `$VEYRA_HOME` if set. Delete a project's store to start over; nothing is stored in your repository.

**Something wrote wrong memory.** `/veyra forget <id>` soft-forgets (inspectable, out of recall). Nothing becomes `canonical` without you running `/veyra promote <id> canonical`.

## Development

```sh
npm test               # node --test test/*.test.mjs
npm run pack:check     # npm pack --dry-run — what would be published
```

CI runs both on Node 22 and 24 for every push and pull request ([.github/workflows/ci.yml](https://github.com/LoveDoLove/Veyra/blob/main/.github/workflows/ci.yml)).
Publishing is automatic: every push to `main` publishes to npm (patch-bumped first if the version already exists) unless the commit message contains `[skip publish]`.

## Compatibility

| | |
| --- | --- |
| Node | `>=22.5.0 <25.0.0` |
| DSH | `>=0.1.2-rc.1 <0.2.0-0` |
| Verified on | DSH `0.1.7-rc.2` (`web` profile: plugin boot, tools, `/veyra` + `/veyra/graph` HTTP); CI on Node 22 and 24 |
| Profiles | installed per profile (`web`, `tui`, …); the Settings section and Network Graph need the web surface |
| Storage | `node:sqlite` + FTS5, one DB per project under the Veyra home |
| License | MIT |

Veyra is on a pre-1.0 `0.1.x` line — see the [CHANGELOG](https://github.com/LoveDoLove/Veyra/blob/main/CHANGELOG.md) for what shipped (the npm badge above shows the published version). APIs and command surface may still change between minor versions.

## License

MIT — see [LICENSE](https://github.com/LoveDoLove/Veyra/blob/main/LICENSE).
