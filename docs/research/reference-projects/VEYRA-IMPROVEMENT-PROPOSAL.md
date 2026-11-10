# VEYRA-IMPROVEMENT-PROPOSAL.md

**Repository:** `/home/lovedolove/projects/Veyra`  
**Date:** 2026-11-07  
**Status:** Proposal for CEO review only. **No implementation authorized.**  
**Basis:** PRD §3/§6, `REFERENCE-RESEARCH-REPORT.md`, `REFERENCE-CAPABILITY-COMPARISON.md`, `VEYRA-CAPABILITY-GAP-ANALYSIS.md`.

## Principles (must hold for any future work)

1. Reuse existing Veyra capabilities (`observe/understand/learn/retrieve/context/store/trust/lifecycle/feedback/code linking`) and existing module boundaries.
2. Do not duplicate reference implementations; adapt patterns only where they fit Veyra's invariants.
3. Preserve all guardrails in `AGENTS.md`: Candidate≠Truth, repository truth wins, project isolation, redaction, fail-closed, no silent authority changes, no vendoring CBM internals, DSH Web safety.
4. Any future implementation requires a separate, CEO-approved PRD with scope, verification strategy, target release, and explicit non-goals.

## Proposals (prioritized, evidence-linked)

### P1 — Evidence of Generated / Delivered / Used (Apply + Improve)
**Problem:** PRD requires generated, delivered, and used memory as separate claims. Current feedback captures outcomes but delivery/use linkage is not fully explicit as auditable states.
**Reference patterns:** dsh-engram evidence batches/assess bind retrieval to refs; Veyra already has provenance, audit, context rendering, `veyra_feedback`.
**Proposal direction (future):** Introduce explicit, auditable events/states for (a) memory selected/generated for context, (b) delivered into prompt/context, (c) referenced/applied with outcome feedback — stored as provenance/audit metadata, not as authority changes. Reuse `audit.mjs`/store provenance patterns; keep read-only where possible.
**Risk:** Telemetry complexity, privacy/redaction scope. Must not log sensitive prompt content beyond existing redaction guarantees.
**Verification needed later:** deterministic tests for event recording, no authority/lifecycle side effects, redaction preserved.

### P2 — Evidence-Binding for High-Stakes Application (Apply/Understand)
**Problem:** Veyra presents trust/evidence well but lacks dsh-engram's forced "assess sufficiency" step that blocks answering without valid batch refs.
**Reference:** `dsh-engram/src/retrieve/evidence.ts` (`assessEvidence`, batch refs, forced sufficient rules).
**Proposal direction (future):** Add an optional evidence-binding workflow for critical recall/apply paths: recall returns evidence refs/anchors; a follow-up assessment (tool or internal check) records whether sufficient evidence was cited before acting. Reuse `trust.mjs`, `evidence.mjs`, `code/linking.mjs`, retrieval IDs. Must not auto-promote or treat binding as truth.
**Risk:** UX friction, agent compliance. Design as assistive guardrail, not hard block that breaks workflows without escape.
**Verification:** tests for batch/ref validation, insufficient handling, no false sufficient.

### P3 — Write-Gate Observability and Merge Reinforcement Review (Learn/Improve)
**Problem:** DROP/DEFER/MERGE decisions must be explainable; merge reinforcement patterns in dsh-engram are explicit.
**Reference:** `dsh-engram/src/write-disposition.ts` (`applyMerge` reinforces, audits), Veyra `learn.mjs` write gate.
**Proposal direction (future):** Ensure every write-gate verdict is persisted/queryable via existing audit/health surfaces (reuse `audit.mjs`, `health.mjs`, observatory). Separately evaluate whether MERGE paths should reinforce confidence/access in a Veyra-appropriate way (without weakening gates) — only after reviewing current `learn.mjs`/store behavior.
**Risk:** Over-reinforcement of weak memories. Must respect validation/confidence progression rules and candidate≠truth.

### P4 — Review/Revalidation Queue (Improve)
**Problem:** Stale/review-required/unresolved items are detected; sustained improvement benefits from explicit review workflows.
**Reference:** `dsh-engram/src/review/sm2.ts` (SM-2 scheduling), Veyra `health.mjs`/`trust.mjs`/`lifecycle.mjs`.
**Proposal direction (future):** Create a *suggestion-only* revalidation queue derived from health/trust signals (stale, review_required, unresolved, repeated failures). Never auto-change validation/authority; user/agent must act explicitly (`veyra_promote`, `veyra_forget`, update, feedback). SM-2-like scheduling only if it remains advisory.
**Risk:** Auto-churn, noisy queues. Keep bounded and transparent.

### P5 — Contradiction/Cluster Distillation with Guards (Learn/Improve)
**Problem:** Repeated patterns and contradictions could be distilled into clearer derived knowledge.
**Reference:** `dsh-engram/src/flywheel/distill.ts` (LLM distill + `supersedes` chains), Veyra `evolve.mjs`, `relationships.mjs`, `feedback.mjs`/recurrence.
**Proposal direction (future):** Only consider explicit, user/agent-triggered distillation that creates *derived* records through write gates, preserves provenance/evidence, links `supersedes`/contradiction relations, and never creates canonical. Reuse `veyra_recurrence` findings as input candidates. No LLM distillation in automatic background paths without strict gating and audit.
**Risk:** Hallucinated synthesis, authority leakage. High bar; defer unless clear need.

### P6 — Applicability and Change-Aware Context Refinement (Understand/Apply)
**Problem:** Applicability and repository-change awareness exist but can be surfaced more systematically.
**Reference:** Veyra `trust.mjs`, `code/linking.mjs`, `veyra_change_impact`; PRD §3 Understand/Apply.
**Proposal direction (future):** Standardize applicability fields (`toolchain/version/taskType/os/runtime` where available) and ensure ambient recall/change-impact paths consistently consult freshness/trust (reusing existing checks). Keep classification read-only.
**Risk:** False applicability matches. Fail closed on uncertainty.

## Explicitly Not Proposed Now

- Duplicating dsh-engram's Palace IA UI/metaphor or full 23-tool surface.
- Vendoring/forking CBM internals.
- Auto-canonicalization, silent merges, or weakening fail-closed gates.
- Background LLM agents making unsupervised memory authority changes.
- Runtime/benchmark experiments in this phase.

## Recommended Next Step (after CEO approval)

1. CEO selects 1–2 proposals (recommend P1 and/or P2 + P3 observability as highest PRD alignment with low invariant risk).
2. Draft a separate **Veyra Product Improvement PRD** per selection: scope, affected modules (reusing existing), data/audit model, test plan, rollout, acceptance criteria.
3. Implement only after that PRD is approved.
