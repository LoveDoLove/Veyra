# Architecture

## Product identity

Veyra (`@lovedolove/veyra`) is a **DSH Cordis plugin** that gives coding agents
reliable, persistent, change-aware **engineering memory** — evidence-backed,
project-isolated, and checked against the current repository.

It is not a standalone service, not a web application, and not a documentation
system. It runs inside DeepSeek Harness (DSH) as a plugin and stores its state
outside the user's repository.

## Scope

**In scope**

- Observe agent sessions and distill durable engineering lessons.
- Persist those lessons with evidence anchors, authority, validation, and
  lifecycle state.
- Recall relevant lessons into agent context and answer explicit searches.
- Track whether remembered knowledge still applies after the repository changes.
- Provide human-readable inspection surfaces (slash commands, Observatory,
  Network Graph WebUI).
- Optionally expose structural code intelligence through an external bridge.

**Out of scope**

- Writing anything into the user's repository.
- Being authoritative over code. Repository truth always wins.
- Acting as a general documentation store or wiki.
- Bundling or reimplementing the Code Intelligence engine (see
  [CBM integration](./cbm-integration.md)).

## The two layers

| Layer | Holds | Source of truth | Owner |
| --- | --- | --- | --- |
| **Veyra Memory** | Engineering lessons, root causes, decisions, constraints, causal chains (`symptom → rootCause → remedy → verifiedOutcome`), negative and unresolved knowledge | Epistemic state accumulated across sessions | This repository |
| **Code Intelligence** | AST-level structural facts: symbols, files, call graphs, hierarchies | The live repository | `@lovedolove/dsh-codebase-memory-mcp` + external native daemon |

They answer different questions and must never be conflated. A memory can be
marked stale by a structural change; a structural fact is never a memory.

## Data flow

```text
DSH session events
      │
      ▼
  observe            src/observe.mjs      lossy activity buffer, never stored as truth
      │
      ▼
  understand         src/understand.mjs   distill a turn into a structured claim or null
      │
      ▼
  candidate          authority = candidate   (never auto-recalled)
      │
      ▼
  learn              src/learn.mjs        write gate: ACCEPT / MERGE / DROP / DEFER
      │
      ▼
  derived memory     authority = derived     (recall-eligible)
      │
      ├──► SQLite store     $DSH_HOME/veyra/projects/<projectId>/memory.db
      │                     $DSH_HOME/veyra/reusable/memory.db
      │
      ▼  read-only projections
  ┌───────────────┬──────────────┬───────────────┬────────────────────┐
  │ Hybrid search │ Local graph  │ Agent context │ Human surfaces     │
  │ retrieve.mjs  │ graph.mjs    │ context.mjs   │ commands / webui   │
  └───────────────┴──────────────┴───────────────┴────────────────────┘
```

The graph and the Observatory are **derived projections, not second stores**.

## Orthogonal state dimensions

Every record carries independent dimensions (`src/types.mjs`). Do not collapse
them:

- **kind** — `observation`, `memory`, `knowledge`, `evidence`, `negative`, `unresolved`
- **authority** — `candidate`, `derived`, `canonical`
- **validation** — `unverified`, `reviewed`, `verified`, `stale`, `invalid`
- **status** — `current`, `deprecated`, `superseded`, `historical`
- **scope** — `project`, `reusable`
- **confidence** — `low`, `medium`, `high`
- **relations** — `updates`, `extends`, `derives`, `contradicts`, `supersedes`

Authority and validation are separate on purpose: feedback can raise validation
without ever raising authority.

## Trust is computed at read time

Trust is not stored as a verdict. `src/trust.mjs` classifies a record **at read
time** against the current repository state into `trusted`,
`review_required`, `stale`, `contradicted`, or `insufficient_evidence`. This is
why repository changes can weaken a memory without rewriting it.

## Storage and identity

- Root: `config.home` → `$VEYRA_HOME` → `$DSH_HOME/veyra` (`src/ids.mjs`).
- One SQLite database per project; one shared reusable database.
- Project id: stable hash of resolved workspace path plus git remote, so two
  checkouts of the same remote share memory and unrelated folders never collide.
- Schema: `node:sqlite` with FTS5, `SCHEMA_VERSION = 1`. A mismatched version
  refuses to open rather than guessing.

## Hard boundaries

1. **Memory never enters the repository.** All writes go under the Veyra home.
2. **Candidates never become truth automatically.** See
   [safety and invariants](./safety-and-invariants.md).
3. **The host owns the agent loop.** Every observation, recall, and maintenance
   path is best-effort and must not break a turn.
4. **Code Intelligence is a dependency, not code.** Veyra owns only the linking
   and unified retrieval glue.
5. **Configuration is Veyra's.** Veyra works automatically with built-in defaults. Advanced YAML/programmatic configuration is validated through Veyra's `Config` (`src/config.mjs`); never patch DSH core or another plugin to fix Veyra. There is no dedicated Settings UI.

## Related

- Where each of these lives: [codebase map](./codebase-map.md)
- The invariants behind them: [safety and invariants](./safety-and-invariants.md)
- Host seams: [DSH integration](./dsh-integration.md)
