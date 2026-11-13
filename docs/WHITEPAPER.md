# Veyra: Engineering Intelligence for Coding Agents

[English](WHITEPAPER.md) · [简体中文](WHITEPAPER.zh-CN.md)

**Technical whitepaper — `@lovedolove/veyra` v0.3.1**

This edition describes the current release. Every implementation claim is
traceable to the source tree named in §15. Where a property is designed for but
not proven in use, it is labelled *unproven* in §12.4 and §13. Nothing here is a
performance or outcome guarantee beyond the stated evidence.

Earlier editions of this paper were pinned to specific commits and cited line
numbers. That made them precise and unmaintainable at the same time. This
edition cites files, not lines, and states the release it describes.

---

## 1. Executive summary

Coding agents repeatedly re-derive what a project already knows: why a build
flag exists, which fix was tried and rejected, what constraint governs a module,
and what changed since last week. Veyra gives them a persistent,
workspace-isolated **engineering memory** that is:

- **Grounded.** Every record carries evidence anchors into the repository.
  A path that cannot be resolved is never evidence.
- **Trustable by construction.** Authority is an explicit ladder
  (`candidate → derived → canonical`). Only an explicit human action reaches
  `canonical`. Similarity to the current task never confers authority.
- **Change-aware.** Freshness and trust are evaluated at read time against the
  repository, so drifted knowledge is demoted instead of silently served.
- **Advisory.** Recalled memory arrives as context with a standing notice that
  it is not repository truth and not an instruction.

Veyra ships as a DeepSeek Harness plugin: pure ESM, no required runtime
dependency, one SQLite + FTS5 database per DSH workspace, and an optional
structural code-intelligence layer supplied by a separate plugin.

The paper separates four layers of claim: **design goals** (§12.1),
**implemented** (§12.2), **verified** (§12.3), and **unproven** (§12.4). The
measurement question *"does Veyra improve agent task outcomes?"* is answered
honestly: it has not been measured yet (§11.4, §13).

---

## 2. The problem

A context window is a working set, not a store. Across sessions an agent loses:

1. **Architecture rationale** — why this database, why this boundary, which
   approach was rejected and for what symptom.
2. **Troubleshooting history** — the root cause of a fixed bug, the remedy that
   worked, and the ones that did not.
3. **Constraints** — "must support Node 22", "no new dependencies", "do not
   touch this module until the migration lands".
4. **Freshness** — which of the above still hold after the code changed.

Existing mitigations each fail part of this. Conversation history is
per-session and ungrounded. Documentation drifts from code. A folder of markdown
notes has no lifecycle, no authority model, and no read-time trust evaluation.

Veyra's position: engineering memory is a first-class, per-workspace,
evidence-anchored store with explicit authority, validation, and freshness axes,
projected into agent context only through a bounded, gated recall path, and
re-checked against the repository on every read.

---

## 3. Design principles

Veyra is organized around one trust chain:

```
Repository Truth + Engineering Memory
    → Applicability and Freshness
    → Trust
    → Agent Context
```

Memory is useful only when it is trustworthy *in this repository state, for this
task*, and even then it arrives as context, not instruction.

| # | Invariant | What it rules out | Mechanism |
| --- | --- | --- | --- |
| P1 | **Observe ≠ Store** | Recording that something happened as if it were true | The observe pipeline produces candidates only; a noise filter and a capture gate keep technical facets |
| P2 | **Candidate ≠ Truth** | Low-authority records being recalled or promoted silently | The write gate defers automatic learning behind provenance; `canonical` requires an explicit promotion |
| P3 | **Similarity ≠ Authority** | A good lexical match raising a record's standing | Authority, validation, confidence, and evidence strength score independently of similarity |
| P4 | **Similarity ≠ Applicability** | A near-relevant record being treated as applicable | Applicability comes from structured context keys and temporal bounds |
| P5 | **Memory ≠ Instruction** | Recalled text being obeyed as a command | The context builder prefixes every recall block with a not-repository-truth notice |

A sixth principle underlies all five: **Repository Truth**. No stored record
outranks the repository, trust is re-derived on every read, and hiding a
contradiction is a rejected behaviour.

---

## 4. Architecture

### 4.1 The dual-brain model

Veyra connects two layers that answer different questions.

| Layer | Holds | Source of truth |
| --- | --- | --- |
| **Veyra Memory** | Lessons, root causes, decisions, constraints, causal chains, with evidence anchors, validation, and authority | Accumulated, evidence-backed epistemic state |
| **Code Intelligence** | Symbols, files, call graphs, class hierarchies | The live repository AST |

They are not interchangeable. A record saying "the login function was refactored
to use JWTs" is an engineering lesson. The call graph of `login()` today is
structural truth. Code Intelligence can mark a memory *potentially stale*. It
never overwrites memory, and memory never overrides code.

### 4.2 The memory server

One server instance per plugin lifecycle owns:

- a workspace resolver,
- a memory router,
- one private **Memory Room** per DSH workspace,
- one shared **Central Memories** store,
- a governed promotion path between them.

It runs no daemon, no timer, and no background job. Every failure path degrades
to an empty result rather than an exception inside the agent loop.

### 4.3 Data flow

```
  DSH host — Cordis plugin (src/plugin.mjs)
  session events ──► observe ──► observation ──► write gate ──► derived memory
                                                        │
                                          promotion (explicit only)
                                                        ▼
                                               Central Memories

  ┌───────────────────────────────────────────────────────────────┐
  │  Memory Server  $DSH_HOME/veyra/   (node:sqlite + FTS5)       │
  │  rooms/<roomId>/memory.db   ·   central/memory.db             │
  └───────────────────────────────────────────────────────────────┘
        read-only projections
  ┌──────────────┬──────────────┬──────────────┬─────────────────┐
  ▼              ▼              ▼              ▼
  hybrid recall  local graph    agent context  human surfaces
  tools          src/graph.mjs  system prompt  /veyra, Observatory
                                (fail-closed)  Network Graph
```

The local graph is a derived projection, not a second store.

### 4.4 Runtime shape

| Property | Value |
| --- | --- |
| Package | `@lovedolove/veyra`, 273.3 kB packed, 51 files |
| Module system | Pure ESM |
| Required runtime dependencies | None |
| Optional peer | `@lovedolove/dsh-codebase-memory-mcp`, loaded through `src/cbm-bridge.mjs` |
| Node | `>=22.12.0 <25.0.0` |
| DSH | `>=0.1.2-rc.1 <0.3.0-0` |
| Storage | `node:sqlite` + FTS5 |

The Node floor has two reasons. `node:sqlite` first shipped in 22.5. The bridge
loads the Codebase Memory package with an unflagged `require(esm)`, which starts
at 22.12.0. Below that floor the bridge would silently degrade while `engines`
claimed support, so the manifest tells the truth instead.

---

## 5. Core concepts

### 5.1 Record

A record is one piece of engineering knowledge with:

- **identity** — a stable id, a kind, a scope,
- **content** — title, body, tags, optional causal facets,
- **evidence** — anchors into the repository, plus notes and URIs,
- **axes** — authority, validation, confidence,
- **lifecycle** — status, protection, relationships, history,
- **provenance** — how it was captured and by what.

### 5.2 Kinds

| Kind | Meaning |
| --- | --- |
| `observation` | What a turn did, before judgement |
| `memory` | A durable engineering lesson |
| `knowledge` | Project documentation kept beside memory, searched together |
| `evidence` | A captured fact with anchors |
| `negative` | An approach that was tried and rejected |
| `unresolved` | An open investigation |

`negative` and `unresolved` are first class. Knowing what failed, and what is
still unknown, is as valuable to a later agent as knowing what worked.

### 5.3 The three axes

| Axis | Values | Moved by |
| --- | --- | --- |
| Authority | `candidate` → `derived` → `canonical` | Write gate; explicit human action for canonical |
| Validation | `unverified` → `reviewed` → `verified` | Repeated confirmation across sessions and test outcomes |
| Confidence | `low` / `medium` / `high` | Evidence strength at capture and learning |

Only `derived` and `canonical` are recall-eligible. Candidates are stored and
inspectable but never injected.

### 5.4 Causal facets

A record may carry `symptom → rootCause → remedy → verifiedOutcome`. These are
used by ranking and by merge decisions.

The `Root cause:` facet decides whether a new record restates an existing one.
Whole-claim comparison cannot do this: over a real room, the best pair of
genuinely duplicate claims scored 0.143, below the conflict floor, because body
lengths differed by an order of magnitude. Identical root-cause lines score
1.000, a rewording scores 0.727 to 0.909, and a genuinely different cause scores
at most 0.278.

The rule fails closed: no facet means no cause-duplicate, and a `CONFLICT`
verdict is never overridden.

### 5.5 Relationships

Records link to each other as `updates`, `extends`, `derives`, `contradicts`, or
`supersedes`. Links are derived at write time from the diff between the incoming
record and its nearest neighbours. A contradiction stays visible; resolving it
is a human act.

### 5.6 Rooms and Central Memories

| Layer | Holds | Path |
| --- | --- | --- |
| Memory Room | Everything learned in one DSH workspace | `rooms/<roomId>/memory.db` |
| Central Memories | Knowledge explicitly promoted out of a room | `central/memory.db` |

A room is a DSH `WorkspaceId`, never a filesystem path. Two workspaces on one
repository are two rooms. A workspace whose identity cannot be resolved fails
closed rather than guessing. Promotion is the only way into Central Memories.

The pre-rooms `projects/` and `reusable/` databases are legacy: never read,
written, migrated, merged, or deleted.

---

## 6. Memory lifecycle

### 6.1 Capture

Veyra observes session events. Only tools that can actually mutate files
contribute modification evidence. A `read`, a `grep`, or a `glob` is activity,
never an edit. A path mentioned in prose is not a changed file, and a quoted
redirect is not a write.

The observation records files, symbols, test outcomes, claim signal, and
structured causal facets. Symbols require a code shape: an identifier followed
by an argument list, a block, or an assignment. Prose that happens to contain
the word `const` produces nothing.

### 6.2 The write gate

The gate reads text, not formatting. The same instruction is judged the same
whether it arrives as prose, a bullet, a numbered list, or a checkbox item, so a
checkbox is never a way around it.

Verdicts are `accept`, `merge`, `drop`, and `defer`. Every verdict is counted
with its reason in a ledger that `/veyra health` reports.

Grounding is required. A `sym:` note is not grounding; a real path, URI, or
anchor is. This is what stops a symbol-shaped string from setting confidence on
a record with no anchor.

### 6.3 Recall

At the start of a turn, the relevant records are retrieved and injected as a
compact block. Each record carries its trust state. Learning and recall can be
disabled independently.

When the same record set is rendered for the third time in a workspace, Veyra
switches to a compact form: header and warnings only, body and evidence dropped.
Warnings survive on purpose. A record whose anchored file changed must still
show its review warning, and a header-only form silenced exactly that.

### 6.4 Feedback

`veyra_feedback` reports whether applying a memory worked. Success strengthens
the record; failure records failure history. An explicit `generationEventId`
from the recall that surfaced the record attributes the outcome to that
dispatch.

### 6.5 Maintenance

Lifecycle actions are explicit: protect, unprotect, invalidate, supersede,
forget, tombstone. The bundled `veyra-memory-curation` skill applies them on
request with before/after reporting. A health finding is never authorization by
itself. The skill also reports `KEEP`, `REVALIDATE` and `DEFER`; those are
recommendations in a report, not store mutations, and nothing is written for
them.

---

## 7. Evidence and trust

### 7.1 Anchors

Evidence anchors point at files, symbols, notes, or URIs. Paths outside the
repository can never become evidence. Anchors are what make a record checkable
later, and checkability is what separates memory from rumour.

### 7.2 Read-time classification

Every recalled record is classified against the current repository:

| Category | Meaning |
| --- | --- |
| `trusted` | Anchors resolve; nothing contradicts the record |
| `review_required` | Usable, but verify before acting |
| `stale` | An anchored file changed; the claim may no longer hold |
| `contradicted` | Another record makes an opposing claim |
| `insufficient_evidence` | The record cannot be checked right now |

The classification is a projection. It never writes and never changes authority
or validation.

### 7.3 Unverifiable is not stale

When the code-intelligence layer is absent, anchors cannot be resolved at all.
Veyra reports the freshness as unverifiable and classifies the record as
`insufficient_evidence`. It does not claim the path was outside the repository,
and it does not escalate the record to `stale`.

This distinction was a real defect in an earlier release. The old code
fabricated a reason, and the trust layer escalated the fabricated reason above
`review_required`. A record was demoted for a fact nobody had checked.

### 7.4 Delivery

A `veyra_recall` dispatch records its own evidence: the record refs it returned,
the rendered size, and a delivery status. Only the tool path can be
`DELIVERED`. The ambient context provider stays `NOT_VERIFIED` permanently,
because nothing in DSH proves that a model received the injected text. Veyra
records presence, not comprehension.

---

## 8. Recall and retrieval

### 8.1 Pipeline

One query produces several independent signals:

| Signal | Weight | Source |
| --- | --- | --- |
| Relevance | 0.32 | FTS5 BM25 with symbol and path boosts |
| Evidence | 0.18 | Anchor strength and resolution |
| Validation | 0.18 | Validation tier |
| Proximity | 0.14 | Scope and context proximity |
| Freshness | 0.08 | Read-time code freshness |
| Confidence | 0.10 | Record confidence |
| Semantic | 0.10 | Token-level overlap, not embeddings |
| Relationship | 0.04 | Graph cohesion |

The channels are fused with reciprocal-rank fusion (`RRF_K = 60`, fusion weight
`0.06`). A `goal` argument adds affinity with weight `0.7`, steering ranking
toward work in progress. It is a direction, never an authority.

Every result carries a score breakdown, so a ranking can be explained rather
than trusted.

### 8.2 Determinism

There are no embeddings, no vector store, no reranker, and no remote service.
This is a design choice, not a gap to be filled: it keeps recall reproducible,
auditable, and free of network dependencies. The cost is a ceiling on
paraphrase recall, which is stated in §13.

### 8.3 Limit handling

`recallLimit` bounds how many records are injected per turn. `0` disables
automatic recall context and nothing else: tools, commands, the Observatory, and
stored memory keep working. That makes it the switch for comparing behaviour
with and without ambient memory.

---

## 9. Code Intelligence

The structural layer is optional and split across two independent pieces:

| Piece | Supplies |
| --- | --- |
| `@lovedolove/dsh-codebase-memory-mcp` plugin | The six `cbm_*` tools and the bridge |
| `codebase-memory-mcp` native binary | Indexing and answers |

Veyra declares the plugin package as an optional peer and loads it through
`src/cbm-bridge.mjs`, the only file in `src/` that names the package. When the
package is absent, the bridge returns a frozen stub and Veyra continues with
memory fully functional.

Veyra registers no `cbm_*` tool. That is a deliberate boundary: two plugins
registering the same tool names is a load-order race, and the failure is silent.
The tools belong to the plugin that owns the bridge.

Demoting the dependency buys load safety, not removal. pnpm installs optional
peers by default, and a profile that lists the plugin keeps it.

A package that is present but fails to load is different from a package that is
absent. Veyra warns once for the first case and stays silent for the second,
because a clean install should not warn.

---

## 10. Security and isolation

| Concern | Guarantee |
| --- | --- |
| Repository writes | None. Veyra never writes into the user's repository |
| Secrets | Every write path redacts before persistence |
| Redaction depth | Shape tier plus a validated tier: payment cards (Luhn), IBANs (ISO 13616 mod-97), US SSNs |
| Workspace isolation | Rooms keyed by `WorkspaceId`, never by path; unresolvable identity fails closed |
| Cross-workspace leakage | Only explicit promotion reaches Central Memories |
| Prompt injection in memory | Hostile signals are detected and flagged, never obeyed |
| Hostile recall content | Scrubbed before rendering |
| Failure behaviour | Degrade to an empty result; never throw into the agent loop |

The plugin also refuses to be the source of truth for code. That is a security
property as much as a design one: a memory that could outrank the repository
would be an injection surface.

---

## 11. Verification

### 11.1 The suite

1173 tests across 13 suites run on Node 22 and 24 in CI, together with a
runtime-dependency guard and a pack check. The suite covers lifecycle,
contradiction handling, corruption, isolation, redaction, retrieval ranking,
context rendering, plugin lifecycle, and the Code Intelligence boundary.

### 11.2 The benchmark

`docs/BENCHMARK.md` reports 29 tests over 45 dimensions, run by
`test/m15-benchmark.test.mjs` against purpose-built fixtures. The harness prints
the same table it asserts on, so the document and the run cannot drift apart.
Every number is a rate where `1` is the safe outcome, and each row carries its
evidence.

This is mechanism verification. It proves the machinery behaves as specified on
fixtures. It does not measure task outcomes.

### 11.3 Cross-project exercise

Two real stores exercised the system end to end in 2026-09 and 2026-10: a web
application project and a legacy repository onboarding. They produced the
drift cases and the auto-recall noise observation that shaped later work.

Those runs used the pre-rooms, path-keyed storage layout. That layout no longer
exists, so the runs are **historical evidence about behaviour**, not
current-state evidence about storage. They are reported as such.

### 11.4 What has not been measured

Whether an agent with Veyra completes real engineering tasks better than one
without. That requires a paired experiment with matched tasks, isolated arms, and
a pre-registered metric. The protocol and its blockers are documented in
`docs/research/`, and prior attempts returned null or inconclusive results that
are recorded rather than buried.

---

## 12. Capability statement

### 12.1 Design goals

A reliable, persistent, change-aware engineering memory for coding agents:
grounded in repository evidence; authority, validation, freshness, and
applicability as independent axes; advisory context injection; per-workspace
isolation; no repository writes; deterministic, bounded, fail-closed behaviour;
and eventual *measured* demonstration of utility on paired tasks.

### 12.2 Implemented

| Capability | Where |
| --- | --- |
| Observe → capture gate → write gate → store | `src/observe.mjs`, `src/learn.mjs`, `src/store.mjs` |
| Six kinds, three axes | `src/types.mjs` |
| Lifecycle actions and history | `src/lifecycle.mjs` |
| Staleness marking and evolution | `src/evolve.mjs` |
| Hybrid recall with score breakdown | `src/retrieve.mjs` |
| Local graph projection | `src/graph.mjs` |
| Read-time trust classification | `src/trust.mjs` |
| Context rendering and compaction | `src/context.mjs` |
| Feedback, recurrence, health | `src/feedback.mjs`, `src/negative.mjs`, `src/health.mjs` |
| Redaction | `src/redact.mjs` |
| Memory server, rooms, routing | `src/memory-server.mjs`, `src/rooms.mjs`, `src/memory-router.mjs` |
| Code freshness and code retrieval | `src/code/linking.mjs`, `src/code/retrieval.mjs` |
| Optional-peer bridge | `src/cbm-bridge.mjs` |
| Observatory, WebUI, Network Graph | `src/observatory.mjs`, `src/webui.mjs` |
| Four bundled skills | `skills/` |

### 12.3 Verified

- 1173 tests pass on Node 22 and 24.
- The runtime-dependency guard passes on every shipped file.
- The pack check produces a valid 52-file tarball.
- The 45-dimension benchmark re-asserts its own table.
- `recallLimit: 0` produces an empty context and nothing else changes.
- An absent Codebase Memory package loads, degrades, and leaves memory working.
- A broken install warns once; a clean install stays silent.
- A degraded layer reports unverifiable evidence instead of a fabricated reason.
- A cause-duplicate reaches the merge decision, not only the diff.

### 12.4 Unproven

1. **Task-outcome utility.** No measured paired-task result exists.
2. **Onboarding coverage.** What fraction of a real codebase's durable knowledge
   a bootstrap pass captures is unmeasured.
3. **Auto-recall noise rate.** Noise was observed in one session population; a
   rate has not been measured.
4. **Generality.** Validation has been on DSH-adjacent projects on one host.
5. **Long-lived store behaviour.** Failure-asymmetry properties are
   fixture-verified; their behaviour on a years-old store is inferred.
6. **Paraphrase ceiling.** Without embeddings, the lexical-plus-overlap ceiling
   in large stores is unmeasured.

---

## 13. Known limitations

1. **Deterministic retrieval only.** No embeddings, vector store, reranker, LLM
   judge, or remote service.
2. **Fixture-based benchmark.** Mechanism verification, not outcome
   measurement.
3. **Anchor granularity.** File, symbol, and URI level. URI anchors are not
   re-resolved at read time.
4. **Onboarding asymmetry.** A legacy pass writes many candidates and few
   validated records; recall eligibility lags by an explicit promotion step.
5. **Human-bound steps.** Verification, canonical promotion, contradiction
   resolution, and forgetting protected records require a human by design.
6. **Host requirement.** A DSH plugin on Node `>=22.12 <25`.
7. **Advisory memory.** Agents may ignore recalled memory. The value
   proposition is bounded by compliance, which is why the paired experiment
   matters.
8. **Delivery ceiling.** Veyra can prove a dispatch happened. It cannot prove a
   model read the text.

---

## 14. Future direction

The posture is consolidation, not feature sprawl.

- **Reject (standing):** external graph databases; new node types; new UI
  relation types; a "needs-review" vocabulary; default full-project graphs;
  auto-canonical, silent merge, and hiding contradictions; remote APIs.
- **Defer (standing):** default two-hop traversal; edge-level
  validation/provenance; additional MCP tools.
- **Next concrete step:** run the paired-task impact experiment and publish
  either the first measured utility numbers or the first honest null result.
- **Named open items:** the reusable-scope noise item, the paraphrase ceiling,
  and consolidation of the milestone test suites.

The gap list in `docs/capability-matrix.md` is an agenda, not a promise.

---

## 15. Traceability

| Claim | Source |
| --- | --- |
| Architecture, boundaries, standing rejections | `docs/architecture-graph.md` |
| Measured benchmark table | `docs/BENCHMARK.md`, `test/m15-benchmark.test.mjs` |
| Capability gaps versus prior art | `docs/capability-matrix.md` |
| Product direction and decision criteria | `docs/PRODUCT-EVOLUTION-BLUEPRINT.md` |
| Paired-experiment protocol and results | `docs/research/` |
| Write gate, ledger, provenance defers | `src/learn.mjs` |
| Recall eligibility, kinds, axes | `src/types.mjs` |
| Retrieval weights and fusion | `src/retrieve.mjs` |
| Trust classification | `src/trust.mjs` |
| Context rendering and compaction | `src/context.mjs` |
| Lifecycle | `src/lifecycle.mjs` |
| Redaction | `src/redact.mjs` |
| Observe pipeline and bash-write evidence | `src/observe.mjs` |
| Causal facets and merge | `src/diff.mjs`, `src/evolve.mjs` |
| Delivery and outcome evidence | `src/apply-generation-evidence.mjs` |
| Bridge and degradation | `src/cbm-bridge.mjs` |
| Plugin lifecycle and host seams | `src/plugin.mjs` |
| Packaging, CI, publishing | `package.json`, `.github/workflows/` |

---

## 16. Glossary

- **Authority ladder** — `candidate → derived → canonical`. Only derived and
  canonical are recall-eligible; canonical only by explicit human promotion.
- **Candidate** — an auto-captured observation. Stored, inspectable, never
  auto-recalled.
- **Causal facet** — a structured `symptom`, `rootCause`, `remedy`, or
  `verifiedOutcome` field on a record.
- **Central Memories** — the shared store reached only through explicit
  promotion.
- **DEFER** — the write gate's "not yet" verdict, with a reason string.
- **Delivery** — evidence that a recall dispatch happened. Never evidence that a
  model read it.
- **Memory Room** — one workspace's private store, keyed by DSH `WorkspaceId`.
- **RRF** — reciprocal-rank fusion across retrieval channels (`K = 60`).
- **Tombstone** — the terminal lifecycle marker of a forgotten record.
- **Unverifiable** — freshness that cannot be checked because the
  code-intelligence layer is unavailable. Distinct from stale.
- **Write gate** — the decision point that turns an observation into durable
  memory, or refuses to.
