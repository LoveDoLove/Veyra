# AGENTS.md — Veyra Coding Agent Entry Point

Veyra is a **DSH Cordis plugin** (`@lovedolove/veyra`) that gives coding agents
evidence-backed, project-isolated engineering memory plus an optional structural
Code Intelligence layer. The repository is the source of truth; memory is not.

This file holds only **rules** and **routing**. Details live in
[`docs/agent-guides/`](docs/agent-guides/README.md) — read only what your task needs.

---

## 1. Read the guide for your task

| If the task is about… | Read |
| --- | --- |
| Product direction, evolution priorities, and version decisions | [Product Evolution Blueprint](docs/PRODUCT-EVOLUTION-BLUEPRINT.md) |
| Reference-project research, capability comparison, and Veyra gap analysis | [Reference Research PRD](docs/REFERENCE-RESEARCH-PRD.md) |
| What Veyra is, its scope, layers, data flow, boundaries | [architecture](docs/agent-guides/architecture.md) |
| Finding the file that owns a behavior | [codebase map](docs/agent-guides/codebase-map.md) |
| Design decisions, boundaries, when to add a module/dependency/field | [engineering principles](docs/agent-guides/engineering-principles.md) |
| Memory authority, trust, isolation, redaction, fail-closed rules | [safety and invariants](docs/agent-guides/safety-and-invariants.md) |
| How to plan and land a change | [development workflow](docs/agent-guides/development-workflow.md) |
| Tests, verification, regression prevention | [testing and verification](docs/agent-guides/testing-and-verification.md) |
| Cordis/DSH lifecycle, tools, commands, settings, WebUI seams | [DSH integration](docs/agent-guides/dsh-integration.md) |
| `cbm_*` tools, Code Intelligence, the bridge package | [CBM integration](docs/agent-guides/cbm-integration.md) |
| `package.json`, CI, npm publishing, releases | [release and packaging](docs/agent-guides/release-and-packaging.md) |

**Before planning or proposing a version change, read the Product Evolution
Blueprint.** It defines product direction and decision criteria; it does not
override the guardrails in this file or authorize implementation by itself.

When a task spans several areas, read the guides in that order; architecture and
safety come before implementation detail.

---

## 2. Non-negotiable guardrails

**Repository truth wins.** Veyra memory is recalled context, never authority over
the current code. Never state that code does something because a memory says so.

**Candidates are not truth.** Auto-captured observations stay `candidate` and are
never auto-recalled. Only `derived` and `canonical` records are recall-eligible.
`canonical` is assigned **only** by an explicit user action
(`assertAuthorityTransition` refuses it otherwise). Never write a path that
promotes authority implicitly.

**Project isolation is a hard boundary.** Storage lives under
`$DSH_HOME/veyra/` (or `$VEYRA_HOME`), never inside the user's repository, and
records are partitioned per project id derived from workspace + git remote.

**Fail closed.** Corrupt records, unknown enum values, and unavailable services
must degrade or refuse — never silently become authoritative. Observation and
recall failures must never break the agent loop.

**Secrets are redacted before persistence.** Every write path goes through
`src/redact.mjs`. Never add a write path that bypasses it.

**CBM stays a dependency, not a copy.** Code Intelligence bridge internals
(discovery, client, engine, watcher, `cbm_*` tool definitions) belong to
`@lovedolove/dsh-codebase-memory-mcp`. Do not re-implement or vendor them into
`src/`. See [CBM integration](docs/agent-guides/cbm-integration.md).

**Settings belong to Veyra.** Veyra configuration is owned by Veyra's
`Config`/`client.js`. Do not work around Veyra problems by editing DSH core,
DSH profiles, or another plugin.

**Do not introduce architecture without evidence and necessity.** No new
dependency, module, schema field, service, scheduler, or daemon unless the
current code demonstrably needs it and the change is reviewed as such.

**No unrelated changes.** Do not refactor, reformat, rename, or "clean up" code
outside the task. Do not modify files unrelated to the request.

**No vision/image-capable workflows.**

---

## 3. DSH Web safety (absolute)

- **NEVER kill DSH Web.**
- **NEVER stop DSH Web.**
- **NEVER restart DSH Web.**
- **NEVER start a second DSH Web.**
- **NEVER change the DSH Web port.**
- If a DSH Web restart is required, **STOP and tell the user.**

Tests must never bind the live DSH Web port or touch a live DSH home. Use
isolated temp homes and in-process composition (see
[testing and verification](docs/agent-guides/testing-and-verification.md)).

---

## 4. Working rules

- Understand the existing architecture before changing code.
- Prefer the smallest correct change that fully solves the task.
- Match existing module boundaries, naming, and comment style; this codebase
  documents *why* in file headers — keep that convention.
- Change behavior only with a test that would have caught the old behavior.
- Local reference checkouts, when present, live under
  `/home/lovedolove/projects/refs`. They are context, not truth.
- Verify with tests and real runtime behavior. Never claim success without evidence.
- Commit only what the task asked for. Do not push or release unless explicitly
  instructed.

---

## 5. Before reporting completion

```text
Relevant guide(s) read
Tests run and passing (report exact counts)
Git diff reviewed — only intended files changed
Runtime behavior verified when applicable
No unrelated changes
No safety invariant weakened
```
