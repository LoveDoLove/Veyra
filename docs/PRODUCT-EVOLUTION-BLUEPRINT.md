# Veyra Product Evolution Blueprint

> Status: **Product direction and version-decision authority**
> Owner: CEO / CTO
> Last updated: 2026-11-06
> Scope: Product outcomes, evolution priorities, decision gates, and non-negotiable boundaries.
> This document guides product and version decisions. It does not authorize implementation, experiments, releases, or changes to technical invariants by itself.

## 1. Executive direction

Veyra is an **Automatic Learning and Memory System for Coding Agents**.

**Mission:** Enable Coding Agents to automatically remember what they learn and automatically use those memories to improve future work.

Veyra is not successful merely because it captures more observations, stores more records, exposes more tools, or injects more context. It must learn durable engineering knowledge from experience, understand when that knowledge applies, and make useful knowledge available to the Coding Agent at the right task moment.

The intended product loop is:

**Experience → Learn → Remember → Understand → Apply → Improve**

In practical terms:

1. A Coding Agent performs engineering work.
2. Veyra automatically observes relevant experience without interrupting the task.
3. Veyra distills candidate knowledge and evaluates its evidence, reliability, and scope.
4. Veyra retains durable knowledge with provenance and lifecycle state.
5. On a later task, Veyra automatically identifies and delivers applicable knowledge.
6. The agent can use that knowledge alongside current repository evidence.
7. New outcomes provide further experience that can refine or challenge prior knowledge.

**Product outcome:** Coding Agents should become more effective across tasks and sessions because they can automatically learn from and reuse prior engineering experience—without treating memory as authority over the current repository.

## 2. Product principles

All product and version decisions must follow these principles:

- **Automatic by default:** Capture and useful recall should happen through the existing agent lifecycle, without requiring users to remember special commands.
- **Useful learning over data accumulation:** Prefer a small amount of durable, actionable knowledge over large volumes of raw observations.
- **Automatic use matters as much as automatic capture:** Stored knowledge that never reaches a relevant task does not complete the product loop.
- **Evidence before confidence:** Preserve source evidence, provenance, validation, and uncertainty. A successful action is not automatically a verified general rule.
- **Applicability before similarity:** Textual or semantic similarity does not establish project, version, runtime, platform, or temporal applicability.
- **Repository truth remains authoritative:** Memory is advisory context. Current code, tests, runtime evidence, and explicit user instructions take precedence.
- **Low interruption:** Veyra should improve the agent workflow without turning ordinary coding into a memory-management workflow.
- **Local-first and isolated:** Preserve project isolation and avoid unnecessary external services or network dependencies.
- **Incremental evolution:** Prefer the smallest evidence-backed improvement to the existing architecture over parallel systems or speculative infrastructure.

## 3. Current foundations and honest limits

The current implementation already provides important parts of the automatic loop:

- Session event observation and buffering.
- Candidate construction and persistence through the existing learning path.
- Structured engineering records, provenance, evidence, trust, and lifecycle handling.
- SQLite and FTS5-backed storage and retrieval.
- Automatic per-turn context delivery through the existing dynamic systemPrompt.context provider.
- Intent-aware retrieval and bounded context rendering.
- Maintenance and lifecycle operations.
- Optional Code Intelligence through the separate CBM dependency.

These are implementation foundations, not proof that Veyra consistently learns the right lessons, delivers them at the right time, or improves real Coding Agent outcomes.

Do not describe Veyra as lacking automatic capture or automatic recall. The open product questions concern the quality and effectiveness of the complete loop.

## 4. Product gaps to resolve

### 4.1 Learning quality

Can Veyra distinguish durable engineering knowledge from incidental session activity?

Examples of potentially useful knowledge include:

- Verified root causes and their evidence.
- Effective fixes and the conditions under which they work.
- Explicit technical decisions and their rationale.
- Reusable procedures and constraints.
- Failed approaches and the reasons they failed.
- Version-, runtime-, platform-, or repository-specific discoveries.

A single successful action, unverified observation, or repeated statement must not be promoted into authoritative knowledge without sufficient evidence.

### 4.2 Understanding and applicability

Can Veyra determine whether a memory applies to the current task?

Relevant dimensions include task intent, repository identity, current code state, file and symbol relationships, version/runtime constraints, freshness, temporal validity, evidence quality, contradictions, and scope.

Similarity is a retrieval signal—not proof of applicability, authority, or correctness.

### 4.3 Automatic utilization

Can Veyra automatically deliver the right knowledge at the right time, in a bounded and attributable form?

The existing automatic context provider is the delivery foundation and should be reused. Do not rebuild prompt injection or add another retrieval system without evidence that the existing path cannot meet a demonstrated requirement.

### 4.4 Demonstrable improvement

Can Veyra show that useful memory changes agent behavior or improves engineering outcomes?

Evidence should distinguish:
- Knowledge stored.
- Knowledge retrieved.
- Knowledge included in automatic context.
- Knowledge actually considered or used by the agent.
- A measurable effect on task correctness, investigation effort, or other task outcomes.

These are different stages. Evidence for one stage must not be presented as proof of the next.

### 4.5 Reusable capability evolution

Can repeated, evidence-backed experience mature into reusable Engineering Skills or procedures?

A candidate capability must be derived from multiple relevant experiences where appropriate, preserve its applicability boundaries, and be tested before adoption. Do not automatically rewrite or promote active skills from a single successful session.

## 5. Target capability model

The target model has six connected capabilities. This is a product model, not a mandate to create six services or modules.

1. **Experience capture** — Automatically observe relevant task events and outcomes while preserving source and session provenance.
2. **Learning and reflection** — Identify candidate lessons, decisions, causes, remedies, constraints, and failed approaches; distinguish evidence from inference.
3. **Structured engineering memory** — Retain useful knowledge with explicit scope, evidence, authority, validation, freshness, relationships, and lifecycle state.
4. **Memory understanding** — Interpret current task intent and determine which memories are relevant, applicable, reliable, current, and safe to use.
5. **Automatic utilization** — Deliver a small, attributable set of applicable memories through the existing automatic context path; remain silent rather than manufacture relevance when no useful memory exists.
6. **Feedback and improvement** — Use subsequent outcomes to strengthen, qualify, supersede, or challenge prior knowledge through existing governed lifecycle paths.

The architecture should remain grounded in current module ownership. A capability in this model does not automatically justify a new module, dependency, schema field, daemon, scheduler, model call, or database.

## 6. Evolution priorities

Priorities describe product outcomes, not pre-approved implementation tasks.

### P0 — Reliable learning and automatic utilization

Establish that Veyra can:
- Distill useful, evidence-backed engineering knowledge from experience.
- Preserve uncertainty and applicability boundaries.
- Automatically deliver applicable knowledge for later tasks.
- Avoid irrelevant, stale, contradicted, or out-of-scope delivery.
- Attribute delivered knowledge so its origin and limits are inspectable.

This priority completes the core memory loop. Do not optimize storage volume or retrieval scores in isolation.

### P1 — Progressive understanding and experience consolidation

Improve how Veyra organizes and presents knowledge as complexity grows. Consider progressive disclosure (for example, concise summaries with access to supporting detail) only when a demonstrated context or usability problem justifies it.

Consolidation must preserve provenance and source evidence. Summaries are navigation aids, not replacements for the underlying records.

### P2 — Engineering Skill evolution

Explore a governed path from repeated experience to reusable capability:

**Experience → Skill Candidate → Draft → Backtest → Review → Adoption**

A candidate remains non-authoritative until it passes relevant backtests and the required review/adoption gate. Preserve the original evidence and clearly state applicability limits. No silent modification of active skills and no automatic promotion from one successful event.

## 7. Reference-project lessons and adoption boundaries

External projects are sources of ideas, not architectural authorities. Adopt a pattern only when it solves a demonstrated Veyra problem and preserves Veyra's invariants.

- **Mnemon:** Separate model-assisted decisions about what to remember or recall from deterministic storage, retrieval, and lifecycle mechanics. Borrow the explicit lifecycle discipline; do not make an external model a hidden authority.
- **OpenViking:** Progressive disclosure can reduce context cost. Summaries must retain links to source material and must not replace provenance.
- **Supermemory:** Automatic extraction, temporal evolution, and repository-aware memory are useful reference patterns. Preserve Veyra's local-first operation and explicit scope boundaries; a hosted memory service is not implied.
- **TencentDB Agent Memory:** Experience can mature into higher-level reusable engineering assets. Keep separate evidence, validation, backtesting, and adoption gates; do not reproduce a broad server architecture by default.
- **dsh-world:** Reflection over accumulated events may be useful as a learning pattern. Veyra is not a digital-life, companion, or persona system.
- **dsh-engram:** Evidence gates, source provenance, and careful review of candidate memories reinforce Veyra's trust model. Do not duplicate existing Veyra mechanisms without a proven gap.
- **dsh-mnemon:** Drafting and backtesting proposed skill improvements before adoption is a useful governance pattern. Active skills must not be silently rewritten.

## 8. Non-negotiable invariants

Every product proposal and implementation must preserve these boundaries:

- Observe ≠ Store.
- Candidate ≠ Truth.
- Similarity ≠ Authority.
- Similarity ≠ Applicability.
- Agent acceptance or use ≠ Verification.
- Memory ≠ Instruction.
- Current repository and runtime evidence remain authoritative.
- Evidence and provenance must remain attributable.
- No silent merge or concealment of contradictions.
- No implicit promotion to canonical authority.
- No cross-project leakage; isolation fails closed.
- Secrets are scrubbed before persistence.
- Stale, invalid, superseded, and contradicted knowledge must not be presented as unqualified current truth.
- Memory-path failures must not break the Coding Agent's task.
- Preserve the existing local-first design unless a separately approved, evidence-backed decision changes it.

## 9. Version decision framework

Every proposed version change should answer the following questions before implementation:

1. **Product alignment:** Which part of Experience → Learn → Remember → Understand → Apply → Improve does this improve?
2. **Demonstrated problem:** What user-visible or engineering limitation exists? Is it reproduced or otherwise supported by reliable evidence?
3. **Current ownership:** Which existing module or lifecycle stage owns the behavior?
4. **Smallest solution:** Can the problem be solved within the current architecture?
5. **Trust and applicability:** How does the proposal preserve evidence, authority, scope, freshness, contradiction handling, and isolation?
6. **Verification:** What focused regression test and outcome evidence would demonstrate success?
7. **Trade-offs:** What are the effects on latency, context cost, reliability, compatibility, maintenance, and failure containment?
8. **Release readiness:** Are documentation, tests, packaging, compatibility, and rollback expectations satisfied?

Use one of these decision outcomes:

- **APPROVE** — Evidence and scope justify the proposed change.
- **APPROVE WITH LIMITS** — A bounded implementation or validation step is justified; explicit limits remain.
- **DEFER** — The idea may be valuable, but prerequisites or evidence are missing.
- **REJECT** — The proposal conflicts with product direction, invariants, or demonstrated user value.
- **INVESTIGATE** — A specific, bounded question needs evidence before a build decision.

A Blueprint alignment is necessary but not sufficient for approval. This document does not authorize code changes, experiments involving agents/models/network/credentials, commits, pushes, tags, or releases.

## 10. Product measures

Evaluate the loop in distinct stages and report counts, denominators, and limitations.

- **Learning quality:** proportion of captured candidates that become useful, evidence-backed knowledge; false-learning and unsupported-generalization cases.
- **Applicability correctness:** whether scope, repository, version, runtime, freshness, and contradiction constraints are respected.
- **Automatic useful-context rate:** representative tasks where automatic context contains at least one genuinely useful and applicable memory.
- **Missed-context rate:** tasks with known relevant memory that automatic delivery fails to surface.
- **Irrelevant delivery rate:** unrelated or inapplicable records included in automatic context.
- **Utilization evidence:** whether delivered knowledge is demonstrably considered or used; distinguish observation from causal proof.
- **Task outcomes:** correctness and acceptance-test results in controlled comparisons.
- **Repeated investigation:** avoidable rediscovery or repeated operations across sessions.
- **Context cost and latency:** bounded context size and retrieval overhead.
- **Knowledge reliability:** stale, contradicted, invalid, or later-disproven memory exposure.

Do not collapse these into an arbitrary composite score. Retrieval metrics, synthetic fixture results, delivery observations, and real task outcomes must be reported separately.

## 11. Current evidence and research status

The retrieval-effectiveness investigation is documented in [RETRIEVAL-EFFECTIVENESS-GOAL.md](../RETRIEVAL-EFFECTIVENESS-GOAL.md). Its findings must be read with their stated scope and limitations.

As of this Blueprint's last update:

- The deterministic retrieval-quality evaluation recorded D1–D6 passing, 10/10 checks, with zero failures in its recorded run.
- The Phase 2.1 task-shaped integrity evaluation recorded 48/48 checks and 5/5 tasks passing, with isolation passing.
- These results support specific isolated harness behavior; they do not prove real-world Coding Agent improvement.
- Paired real-agent experiments were not executed. Phase 2.2 was classified INCONCLUSIVE.
- Phase 1 delivery/observation preparation was blocked by the absence of a supported, safe method to capture and verify the final outbound model request and isolate credentials under the approved constraints.
- Phase 3 concluded NO_JUSTIFIED_VERTICAL_SLICE. No production retrieval change was justified by the evidence then available.

Therefore, do not claim that Veyra has proven real-world effectiveness or that a production retrieval defect exists based only on these evaluations. Do not restart the closed retrieval-tuning investigation or expand benchmarks without a newly reproduced production problem or a materially improved, safe experiment capability.

## 12. Explicit non-goals

Veyra is not intended to become:

- A digital-life core, companion, persona, or general-purpose personal memory system.
- A generic hosted RAG platform or transcript archive.
- An autonomous coding agent that replaces the user's chosen agent.
- A task tracker or project-management system.
- A system that treats memory as a command or overrides current repository truth.
- A system that automatically promotes observations to canonical knowledge or rewrites active skills.
- A reason to add embeddings, external databases, hosted services, model calls, daemons, schedulers, or parallel retrieval engines without evidence and separate approval.

## 13. Roadmap gates

Progress through these gates only when the preceding evidence supports it:

1. **Learning-quality gate:** demonstrate that captured experience becomes durable, appropriately scoped, evidence-backed knowledge without unacceptable false learning.
2. **Automatic-utilization gate:** demonstrate that applicable knowledge is automatically delivered at the right task moment, with attribution and bounded cost.
3. **Engineering-effectiveness gate:** demonstrate improved task outcomes or reduced repeated investigation through a safe, controlled, reproducible evaluation.
4. **Progressive-understanding gate:** establish a concrete context, navigation, or comprehension problem that progressive disclosure solves.
5. **Skill-evolution gate:** demonstrate repeatable candidate generation, backtesting, review, and safe adoption without silently changing active capabilities.

Passing a gate authorizes consideration of the next decision; it does not automatically authorize implementation or release.

## 14. CEO / CTO decision agreement

CEO and CTO decisions for Veyra should remain aligned on one product outcome:

**Veyra enables Coding Agents to automatically learn from engineering experience, retain trustworthy knowledge, and automatically apply relevant memories to improve future work.**

The CEO owns product direction and prioritization. The CTO owns technical feasibility, evidence quality, architecture integrity, and safe implementation. Both must reject activity that increases technical complexity without a demonstrated contribution to the product outcome.

When evidence is insufficient, defer or investigate narrowly. Do not manufacture certainty, ship speculative changes, or treat activity volume as product progress.

## Appendix A — Reference projects

- [Mnemon](https://github.com/mnemon-dev/mnemon)
- [OpenViking](https://github.com/volcengine/OpenViking)
- [Supermemory](https://github.com/supermemoryai/supermemory)
- [Claude Supermemory](https://github.com/supermemoryai/claude-supermemory)
- [TencentDB Agent Memory](https://github.com/TencentCloud/TencentDB-Agent-Memory)
- [dsh-world](https://github.com/chenkezhen480/dsh-world)
- [dsh-engram](https://github.com/kenz1117/dsh-engram)
- [dsh-mnemon](https://github.com/omdsh-dev/dsh-mnemon)

## Appendix B — Current Veyra source entry points

These paths are orientation references, not a substitute for reading current source:

- **src/plugin.mjs** — session lifecycle, observation/learning integration, and automatic context-provider registration.
- **src/context.mjs** — automatic recall context construction and rendering.
- **src/retrieve.mjs** — retrieval and candidate selection.
- **src/intent.mjs** — recall intent classification.
- **src/store.mjs** — persistent memory storage and search.
- **src/types.mjs** — record types, eligibility, and trust-related gates.
- **src/redact.mjs** — secret redaction before persistence.
- **src/code/retrieval.mjs** and the CBM dependency — optional structural Code Intelligence integration.
