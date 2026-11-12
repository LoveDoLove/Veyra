# Agent Guides — Index

Task-specific engineering guidance for coding agents working on Veyra. The rules
and routing live in [`AGENTS.md`](../../AGENTS.md); this directory holds the
detail that would make that entry point too long to be read every time.

**Read only the guides your task needs.** Each document owns exactly one topic
and does not restate the others.

| Document | Owns | Read it when |
| --- | --- | --- |
| [architecture.md](./architecture.md) | What Veyra is, product scope, the two layers, data flow, trust model, hard boundaries | You need the mental model before touching anything, or you are unsure whether a change belongs in Veyra at all |
| [codebase-map.md](./codebase-map.md) | File-by-file responsibilities and where each behavior lives | You know *what* to change but not *where* |
| [engineering-principles.md](./engineering-principles.md) | Design rules: boundaries, smallest change, when a new module/dependency/field is justified | You are choosing a design, or a change feels like it wants to grow |
| [safety-and-invariants.md](./safety-and-invariants.md) | Authority, trust, recall eligibility, project isolation, redaction, fail-closed behavior | Any change touches persistence, retrieval, ranking, lifecycle, or agent context |
| [development-workflow.md](./development-workflow.md) | How to plan, implement, and land a change in this repository | You are about to start editing |
| [testing-and-verification.md](./testing-and-verification.md) | Test layout, how to run, what each suite protects, regression rules | You are writing or running tests, or need to prove a change works |
| [dsh-integration.md](./dsh-integration.md) | Cordis plugin lifecycle, host seams, tools, commands, skills, settings, WebUI | You touch `src/plugin.mjs` or anything that registers with the host |
| [cbm-integration.md](./cbm-integration.md) | Code Intelligence boundary: the optional `@lovedolove/dsh-codebase-memory-mcp` peer, the bridge that loads it, and what degrades without it | You touch `src/code/*`, `veyra_code_*`, `veyra_change_impact`, or anything `cbm_*` |
| [release-and-packaging.md](./release-and-packaging.md) | `package.json`, published file set, CI, npm staged publishing and approval, versioning | You change dependencies, packaging, workflows, or prepare a release |

## Precedence

1. Direct instructions from the user for the current task.
2. [`AGENTS.md`](../../AGENTS.md) — the guardrails that always apply.
3. The guide for the topic you are changing.
4. Product documents (`README.md`, [`PRODUCT-EVOLUTION-BLUEPRINT.md`](../PRODUCT-EVOLUTION-BLUEPRINT.md), `docs/WHITEPAPER.md`,
   `CHANGELOG.md`) — context and history, **not** current technical truth.

If a guide and the source code disagree, the source code wins and the guide is
wrong. Fix the guide in the same change.

## Evidence rule

Every technical claim in these guides is grounded in the repository at version
`0.3.0`. Do not extend them with invented APIs, modules, tests, or workflows.
When you change behavior, update the guide that describes it.
