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
| **Code Intelligence** | AST-level structural facts: symbols, files, call graphs, hierarchies | The live repository | Optional peer `@lovedolove/dsh-codebase-memory-mcp` (resolved via `src/cbm-bridge.mjs`) + external native daemon |

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
      ├──► SQLite store     $DSH_HOME/veyra/rooms/<roomId>/memory.db
      │                     $DSH_HOME/veyra/central/memory.db
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
- Schema: `node:sqlite` with FTS5, `SCHEMA_VERSION = 1`. A mismatched version
  refuses to open rather than guessing.

There is exactly one layout since the clean break.

| Layout | Project memory | Shared memory | Enabled when |
| --- | --- | --- | --- |
| Memory Server | `rooms/<roomId>/memory.db` | `central/memory.db` | DSH workspace registry is available |

The pre-rooms layout — `projects/<projectId>/memory.db` and
`reusable/memory.db`, both keyed by a hash of path plus git remote — is **no
longer read, written, migrated, merged, or deleted**. It stays on disk,
untouched, and the running system never opens it. There is no compatibility
mode and no `--dry-run` import path, because a path-derived identity cannot
express two workspaces on one repository, and any import would have to guess
which workspace owns each record.

**A room is a DSH WorkspaceId, not a path** (`src/rooms.mjs`). Two workspaces
opened on the same repository are two rooms with separate memory. `w_<id>` is
the room id, with a hashed form for ids that are not filesystem-safe, so a
workspace id can never traverse out of `rooms/`.

The resolver (`src/workspace-resolver.mjs`) answers one question — *which
workspace is this turn?* — in a fixed order: session id → exact path →
path containment → fail. It never falls back to "close enough": a failure is
reported as `ambiguous-session`, `ambiguous-path`, `unresolved`,
`registry-unreadable`, `registry-not-ready`, `registry-unavailable`, or
`no-context`, and the caller degrades. Containment may only **narrow** a
candidate set: when several registered roots contain the cwd, the **deepest
canonical root wins**, so a nested workspace never maps to its parent's room,
and equal-depth candidates stay `ambiguous-path`.

`RESOLUTION_MODES` therefore has one member, `registry`, and
`resolver.mode()` returns it unconditionally — a second answer there would be
a lie, because no resolution can reach a second model. The three-state
registry diagnostic lives in `resolver.state()` (`available`, `absent`,
`unavailable`) and is surfaced by `health().registryState`:

- `absent` — the host never declared a workspace service, so no workspace id
  can exist. Resolution fails closed with `workspace-registry-unavailable`.
- `unavailable` — declared but unobtainable, or `list()` threw because the
  Host has not finished initialising it. A **fault**, not missing capability;
  resolution fails closed with `workspace-registry-not-ready`. Reporting a
  transient fault as permanent absence is how a "temporary" workaround becomes
  permanent. Because a getter that answers is not the same as a registry that
  works, `state()` calls `list()` rather than trusting the getter alone —
  otherwise a not-started registry reports `available` while every resolution
  refuses.

Central Memories is the only cross-workspace store, and promotion is the only
way in (`src/promotion.mjs`). `veyra_promote` refuses a `candidate`, refuses
`canonical` without `explicit: true`, and requires evidence or
`validation: verified`; a record whose content hash already exists in Central
is linked rather than duplicated.

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
