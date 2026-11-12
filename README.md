# Veyra

[English](README.md) · [简体中文](README.zh-CN.md)

**Engineering memory for coding agents.** Veyra learns the lessons your agent
already paid for, remembers the ones that held up, and puts them back in front
of it the next time the same problem appears.

No manual bookmarking. No re-deriving the same root cause next week.

[![npm](https://img.shields.io/npm/v/@lovedolove/veyra?color=16a34a)](https://www.npmjs.com/package/@lovedolove/veyra)
[![CI](https://github.com/LoveDoLove/Veyra/actions/workflows/ci.yml/badge.svg)](https://github.com/LoveDoLove/Veyra/actions/workflows/ci.yml)
[![node](https://img.shields.io/badge/node-%3E%3D22.12%20%3C25-16a34a)](package.json)
[![license](https://img.shields.io/badge/license-MIT-16a34a)](LICENSE)

A plugin for [DeepSeek Harness](https://github.com/deepseek-ai/DeepSeek-Harness).
Pure ESM. No daemon. No API keys. 263.8 kB packed.

---

## The problem

A coding agent's context window is a working set, not a store. Every session it
relearns the same things.

- Why the build needs that flag.
- Which fix was tried and rejected, and what it broke.
- That this module must stay untouched until the migration lands.
- Which of these facts stopped being true when the file changed.

Conversation history does not survive the session. Docs drift away from the
code. A folder of markdown notes has no lifecycle, no authority model, and no
way to tell you it went stale.

## What Veyra does

Veyra turns the work an agent already did into durable, evidence-backed memory,
and injects the relevant parts automatically.

| | |
| --- | --- |
| **It captures without being asked** | Veyra watches session events and distills each turn into an observation. A governed gate decides whether it earned a place in memory. A turn that produced nothing durable is dropped, not stored. |
| **It recalls without being asked** | At the start of a turn, the most relevant records are injected into context, each labelled with its trust state. The agent never has to remember to search. |
| **It refuses to invent evidence** | A path mentioned in prose is not a changed file. A symbol name in a sentence is not a symbol. Only real, resolved anchors ground a record. |
| **It knows when it might be wrong** | Every recalled record is re-checked against the current repository and classified `trusted`, `review_required`, `stale`, `contradicted`, or `insufficient_evidence`. |
| **It never becomes the source of truth** | The repository always wins. `canonical` authority is reachable only through an explicit human action. Nothing is written into your repo. |
| **It keeps workspaces apart** | Memory is partitioned into rooms keyed by the DSH workspace identity, never by filesystem path. Two workspaces on one repo never see each other's memory. |

## Quick start

```sh
dsh plugin --profile web add @lovedolove/veyra
```

Restart DSH. That is the whole setup.

Then just work. At the end of a turn that produced something durable, Veyra
stores it. At the start of the next turn in the same workspace, it comes back.

Check it:

```
/veyra                  status for this workspace
/veyra recent           what was stored, including candidates
/veyra recall sqlite wal
/veyra inspect vey_…
```

Open `/veyra` in the DSH Web address bar to see the same memory as a graph.

## The loop

```
   work happens
        │
        ▼
   observe ──► observation ──► write gate ──► derived memory
   (what changed,             (accept /        (recall-eligible)
    what passed,               merge /
    what was tried)            drop / defer)
        │                          │
        │                          ▼
        │                     SQLite + FTS5
        │                     one room per workspace
        ▼                          │
   next turn ◄── trust check ◄─────┘
              (fresh? contradicted? checkable?)
```

Four things make the loop honest:

1. **Capture needs evidence.** Files that actually changed, tests that actually
   ran, a root cause that is actually stated.
2. **Learning needs durability.** A one-off command is not a lesson.
3. **Recall needs relevance.** Hybrid search over lexical, semantic, intent,
   and graph signals, with a visible score breakdown.
4. **Reuse needs freshness.** Code that moved demotes the memory that describes
   it.

## Two layers, one rule

| Layer | Answers | Source of truth |
| --- | --- | --- |
| **Veyra Memory** | What did we learn the hard way? | Accumulated evidence, per workspace |
| **Code Intelligence** | What is the code right now? | The live repository AST |

Code Intelligence is optional and lives in a separate plugin. It can mark a
memory stale. It can never overwrite one.

**The rule in both directions: repository truth wins.** A memory that says the
code does something is a claim to verify, not a fact to act on.

## Memory rules

| What | Authority | Auto-recalled |
| --- | --- | --- |
| Auto-captured observation | `candidate` | no |
| Learned or explicitly remembered lesson | `derived` | yes |
| Explicitly promoted truth | `canonical` | yes |

Similarity is not identity, so overlapping memories are linked, not merged.
Similarity is not authority, so a good match never promotes a record.

## Documentation

| Document | What it covers |
| --- | --- |
| [Documentation index](docs/README.md) | Every document, grouped by audience |
| [Whitepaper](docs/WHITEPAPER.md) · [简体中文](docs/WHITEPAPER.zh-CN.md) | Vision, design principles, architecture, core concepts, technical design, future direction |
| [Memory model](docs/reference/memory-model.md) | Authority, validation, kinds, causal facets, lifecycle, trust, rooms and promotion |
| [Tools](docs/reference/tools.md) | All eleven tools, their parameters, and the four bundled skills |
| [Commands](docs/reference/commands.md) | Every `/veyra` command, including the Observatory |
| [Configuration](docs/reference/configuration.md) | Settings, environment variables, storage layout, reset |
| [Code Intelligence](docs/reference/code-intelligence.md) | The optional structural layer, install, degradation, freshness |
| [Troubleshooting](docs/reference/troubleshooting.md) | Symptom, cause, fix |
| [Benchmark](docs/BENCHMARK.md) | The measured 45-dimension harness and what each number means |
| [Architecture graph](docs/architecture-graph.md) | Contracts, rejections, and the standing design boundary |
| [CHANGELOG.md](CHANGELOG.md) | Every released version and what changed in it |
| [Retrieval effectiveness](RETRIEVAL-EFFECTIVENESS-GOAL.md) | The goal, the experiment, and the record of what the retrieval work proved |
| [Contributing](CONTRIBUTING.md) | How to report, propose, verify, and land a change |
| [Security policy](SECURITY.md) | Supported versions, what is stored, what is redacted, the threat model |
| [AGENTS.md](AGENTS.md) | Entry point for agents working on Veyra itself |

## Requirements

| | |
| --- | --- |
| Node | `>=22.12.0 <25.0.0` (`node:sqlite`, plus the unflagged `require(esm)` the bridge uses) |
| DSH | `>=0.1.2-rc.1 <0.3.0-0` |
| Storage | `node:sqlite` + FTS5, under `$DSH_HOME/veyra/` or `$VEYRA_HOME` |
| Runtime dependency | None required. Codebase Memory is an optional peer |

Installed per profile (`web`, `tui`, …). The Network Graph needs the web
surface.

## What is measured, and what is not

Measured: the memory loop closes. A recall dispatch is observable, repeated
recall is bounded, a restated root cause merges, and capture stops inventing
evidence. The suite is 1173 tests, and the benchmark harness re-asserts its own
table on every run.

Not measured: whether an agent with Veyra completes real tasks faster or better
than one without. That needs a paired experiment, and the repo says so instead
of implying otherwise. The whitepaper keeps design goals, implemented
behaviour, verified behaviour, and unproven claims in separate sections.

## Development

```sh
npm test               # node --test test/*.test.mjs
npm run pack:check     # what would be published
```

CI runs both on Node 22 and 24. See [AGENTS.md](AGENTS.md) for the rules that
apply to changes here.

## License

MIT. See [LICENSE](LICENSE) and [THIRD_PARTY.md](THIRD_PARTY.md).

Veyra is pre-1.0. The command surface and APIs may still change between minor
versions.
