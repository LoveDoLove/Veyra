# Veyra Documentation

An index of everything in `docs/`. Each document owns one topic and does not
restate the others.

---

## Start here

| Document | What it is |
| --- | --- |
| [../README.md](../README.md) · [../README.zh-CN.md](../README.zh-CN.md) | The front door: what Veyra is, quick start, capability summary |
| [WHITEPAPER.md](./WHITEPAPER.md) · [WHITEPAPER.zh-CN.md](./WHITEPAPER.zh-CN.md) | Vision, design principles, architecture, core concepts, technical design, future direction |

## User reference

How the product behaves, for the person using it.

| Document | Covers |
| --- | --- |
| [reference/memory-model.md](./reference/memory-model.md) | Authority, validation, kinds, causal facets, lifecycle, trust, rooms, promotion |
| [reference/tools.md](./reference/tools.md) | All eleven tools, their parameters, and the four bundled skills |
| [reference/commands.md](./reference/commands.md) | Every `/veyra` command, including the Observatory and web surfaces |
| [reference/configuration.md](./reference/configuration.md) | Settings, environment variables, storage layout, reset |
| [reference/code-intelligence.md](./reference/code-intelligence.md) | The optional structural layer, install, degradation, freshness |
| [reference/troubleshooting.md](./reference/troubleshooting.md) | Symptom, cause, fix |

## Architecture and design

How it is built and why, for the person changing it.

| Document | Covers |
| --- | --- |
| [architecture-graph.md](./architecture-graph.md) | Contracts, standing rejections, and the design boundary |
| [m11-recall-intelligence.md](./m11-recall-intelligence.md) | The recall-intelligence milestone, non-goals, and probes |
| [issue-3-false-contradiction-edges.md](./issue-3-false-contradiction-edges.md) | The false-contradiction defect and its fix |
| [agent-guides/architecture.md](./agent-guides/architecture.md) | Product scope, layers, data flow, trust model, hard boundaries |

## Product and strategy

| Document | Covers |
| --- | --- |
| [PRODUCT-EVOLUTION-BLUEPRINT.md](./PRODUCT-EVOLUTION-BLUEPRINT.md) | Product direction, evolution priorities, version decision criteria |
| [REFERENCE-RESEARCH-PRD.md](./REFERENCE-RESEARCH-PRD.md) | Reference-project research and capability gap analysis |
| [capability-matrix.md](./capability-matrix.md) | Per-capability comparison against the reference projects |

## Evaluation

| Document | Covers |
| --- | --- |
| [BENCHMARK.md](./BENCHMARK.md) | The measured 45-dimension harness and how to read each number |
| [experiment-impact.md](./experiment-impact.md) | The frozen paired-task impact protocol |
| [research/](./research/) | Dated investigation reports, pre-registrations, and results |

## Contributor guides

For agents and humans working on Veyra itself. The rules and routing live in
[../AGENTS.md](../AGENTS.md); these guides hold the detail.

| Document | Covers |
| --- | --- |
| [agent-guides/README.md](./agent-guides/README.md) | The index and precedence order |
| [agent-guides/codebase-map.md](./agent-guides/codebase-map.md) | Where each behaviour lives |
| [agent-guides/engineering-principles.md](./agent-guides/engineering-principles.md) | Design rules and when growth is justified |
| [agent-guides/safety-and-invariants.md](./agent-guides/safety-and-invariants.md) | Authority, trust, isolation, redaction, fail-closed |
| [agent-guides/development-workflow.md](./agent-guides/development-workflow.md) | How to plan, implement, and land a change |
| [agent-guides/testing-and-verification.md](./agent-guides/testing-and-verification.md) | Test layout, suites, regression rules |
| [agent-guides/dsh-integration.md](./agent-guides/dsh-integration.md) | Cordis lifecycle, host seams, tools, commands, settings |
| [agent-guides/cbm-integration.md](./agent-guides/cbm-integration.md) | The optional Code Intelligence peer and the bridge |
| [agent-guides/release-and-packaging.md](./agent-guides/release-and-packaging.md) | Packaging, CI, npm staged publishing, versioning |

## Design records

`docs/superpowers/` holds the design specs and implementation plans for work
that has shipped. They are historical records of a decision, not current
documentation. When a spec and the source disagree, the source wins.

| Document | Status |
| --- | --- |
| [superpowers/specs/2026-11-11-cbm-decoupling-design.md](./superpowers/specs/2026-11-11-cbm-decoupling-design.md) | Implemented |
| [superpowers/plans/2026-11-11-cbm-decoupling.md](./superpowers/plans/2026-11-11-cbm-decoupling.md) | Implemented |
| [superpowers/specs/2026-11-11-autonomous-engineering-memory-design.md](./superpowers/specs/2026-11-11-autonomous-engineering-memory-design.md) | Implemented |
| [superpowers/plans/2026-11-11-autonomous-engineering-memory.md](./superpowers/plans/2026-11-11-autonomous-engineering-memory.md) | Implemented |
