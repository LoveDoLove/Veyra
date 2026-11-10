# VEYRA-CAPABILITY-GAP-ANALYSIS.md

**Repository:** `/home/lovedolove/projects/Veyra`  
**Date:** 2026-11-07  
**Basis:** `REFERENCE-RESEARCH-REPORT.md`, `REFERENCE-CAPABILITY-COMPARISON.md`, PRD §3, Veyra source inspection.  
**Constraint:** Analysis only; no implementation. Gaps are opportunities relative to references and PRD goals, not instructions to change code.

## Method

Compared Veyra's current implementation (evidence in report/comparison) against PRD §3 capability areas and patterns observed in `dsh-memory`, `dsh-engram`, `billion-context`, `codebase-memory-mcp`. Gaps focus on *missing or weaker enforcement/coverage* where Veyra already has foundations to reuse.

## Gaps by Capability

### 1. Experience
**Current strength:** Strict Observe≠Store, noise filtering, signal-based buffering, candidate-only output, no ambient recall of candidates (`observe.mjs`, `understand.mjs`).
**Gaps / opportunities:**
- **Outcome capture granularity:** Experience capture is turn/tool-buffer oriented; PRD asks for "outcomes" as first-class signals. Veyra has `veyra_feedback` (explicit outcomes) and evidence anchors, but automatic linkage from observed turn outcomes to specific memory applications is limited (by design - application is agent work). Gap: clearer separation/evidence trail for "generated vs delivered vs used" at experience level (PRD Apply/Improve overlap).
- **Ingestion modes/idempotency:** `dsh-engram` offers off/light/eager + idempotent ingest ops and chunking for long inputs. Veyra has deterministic observation/distill but no equivalent user-configurable ingestion policy surface in inspected core (may exist via config; not deeply verified). Opportunity to make capture policy explicit without weakening guards.

### 2. Learn
**Current strength:** Evidence-aware learning, write gate (DROP/DEFER/MERGE/ACCEPT) with reasons, durability/quality gates, causal rigor (no temporal adjacency alone), negative/unresolved first-class, no silent authority promotion (`learn.mjs`, `understand.mjs`, `types.mjs`).
**Gaps / opportunities:**
- **Near-duplicate merge reinforcement:** Veyra evolves relations and has content-hash/neighbor logic; `dsh-engram` reinforces existing entries on merge (`applyMerge` → `store.reinforce`, accessCount/confidence bump) with explicit cosine thresholds (`MERGE_COSINE=0.92`, `DEFER_COSINE=0.88`). Veyra may achieve similar ends differently; gap to assess is whether merge outcomes consistently strengthen signal without creating duplicates. (Evidence of exact reinforcement semantics not fully traced in `learn.mjs` partial read.)
- **Contradiction candidate handling at write time:** `dsh-engram` can defer/defer-with-judge and build contradiction edges. Veyra surfaces contradictions on retrieval/trust and tracks relations; write-time contradiction disposition could be made more explicit as a gated decision (reusing existing relation/contradiction model).
- **Low-entropy/drop observability:** `dsh-engram` drops low-entropy/batch duplicates explicitly; Veyra has noise/durability gates and write-gate accounting intent. Ensure all DROP/DEFER/MERGE decisions remain observable (health/audit) for "why not learned?"

### 3. Remember
**Current strength:** SQLite/FTS5 outside repo, project/reusable isolation, redaction on all write paths, lifecycle forget/tombstone with history and protected override, fail-closed enums/eligibility, schema migration support implied (`store.mjs`, `lifecycle.mjs`, `redact.mjs`, `types.mjs`).
**Gaps / opportunities:**
- **Structured knowledge surfaces:** `dsh-engram` maintains facts/entities/timeline and Palace spatial organization. Veyra stores records with evidence/causal facets/relations and has graph/intent modules; may lack a first-class "facts timeline" or entity dictionary view for Understand/Apply. Opportunity to expose existing structured data (causal facets, evidence anchors, relations) as navigable surfaces without changing storage authority.
- **Export/mirror/audit UX:** `dsh-engram` has export/mirror and Web panel features. Veyra has WebUI/observatory/commands; parity in portability/audit workflows not assessed - gap if users need easy export of project memory with provenance.

### 4. Understand
**Current strength:** High-quality claim distillation, causal rigor, provenance origins (fail-closed), hybrid retrieval with intent/graph cohesion/freshness/validation/confidence, contradictions both sides visible, negative/unresolved bounded coverage tail, read-only trust classification (`understand.mjs`, `retrieve.mjs`, `trust.mjs`, `code/linking.mjs`).
**Gaps / opportunities:**
- **Applicability/context matching:** `trust.mjs` flags applicability conflicts when captured context conflicts with runtime, but applicability modeling depth (toolchain/version/taskType beyond what is stored) may be limited compared to PRD's "applicability" emphasis. Veyra already stores `context` in source/provenance paths - opportunity to make applicability checks more systematic using existing fields.
- **Change-aware retrieval integration:** `veyra_change_impact` and trust classification exist; retrieval can add code-anchor affinity when `changedFiles` provided (`retrieve.mjs` notes). Gap: ensuring ambient recall and explicit recall consistently leverage change/freshness signals when repository changes are detected (without over-claiming).
- **Metacognition/consistency diagnostics:** `dsh-memory` exposes metacognition/consistency/self-check tools. Veyra has `veyra_health`, observatory, trust, but fewer explicit "self-check/consistency report" surfaces. Opportunity to extend health/observatory using existing data (contradictions, stale, unresolved, repeated failures).

### 5. Apply
**Current strength:** Budgets, eligibility gates, injection warnings, trust/freshness/temporal presentation, neg coverage tail, no instruction-shaped injection trusted (`context.mjs`, `retrieve.mjs`, `redact.mjs`).
**Gaps / opportunities:**
- **Evidence-gated sufficiency enforcement:** `dsh-engram` requires `engram_assess` with batch refs and code-forces sufficient only with valid refs + `nextStrategy=answer`. Veyra relies on trust categories + eligibility and presents evidence, but does not have an equivalent "assessment step" that blocks "answer as if sufficient" without explicit evidence binding. Gap: consider a lightweight evidence-binding mechanism for high-stakes recall/application flows, reusing existing evidence anchors and trust projection (without changing authority rules).
- **Generated/delivered/used evidence separation:** PRD requires these as separate claims. Veyra has prompt rendering and feedback, but explicit telemetry/evidence that memory was *delivered* in context and later *used* (tied to outcome) is not clearly exposed as separate auditable states in inspected modules. Opportunity to make delivery/application evidence explicit via existing audit/health/provenance patterns.
- **Trigger/timing policy clarity:** When to inject ambient recall vs require explicit `veyra_recall` is partly policy; clarify/document triggers using existing `systemPrompt.context` and tool patterns.

### 6. Improve
**Current strength:** Explicit feedback loop with canonical protection, validation/confidence demotion on failure (non-canonical), recurrence detection that can gate candidates, trust/read-only projections, change impact (`feedback.mjs`, `trust.mjs`, `tools.mjs`, `evolve.mjs`).
**Gaps / opportunities:**
- **Spaced repetition / review scheduling:** `dsh-engram` uses SM-2 for due reviews. Veyra has lifecycle/validation progression and health findings but no SM-2-style scheduling. Gap: for memories that benefit from periodic revalidation, a review queue could improve sustained quality (must remain read-only suggestions or explicit actions, never auto-canonicalize).
- **Distillation/supersession of clusters:** `dsh-engram` distills clusters into higher-level skill/fact with `supersedes` chains. Veyra has relations (updates/extends/derives/supersedes/contradicts) and evolve logic; automated distillation into new derived records could help but carries risk - any such path must go through write gates, remain non-canonical, preserve provenance, and surface contradictions.
- **Helpful/harmful signal richness:** Feedback is binary success/failure plus notes. PRD mentions "helpful, harmful, or irrelevant." Veyra could capture richer outcome dimensions (with guardrails) to refine retrieval/learning without weakening invariants.

## Cross-cutting Gaps

1. **Evidence of use:** Strongest cross-cutting gap relative to PRD - distinguishing generated, delivered, and used memory applications as separate evidence claims.
2. **Observability of learning decisions:** Write-gate reasons exist conceptually; ensure all automatic decisions (especially drops/defers/merges) are consistently auditable/queryable.
3. **Review workflows:** Review-required/stale/unresolved items are detected; workflows to resolve them (explicit, user-driven) could be clearer.

## Non-gaps (must preserve)

- Candidate≠Truth, no auto-canonicalization.
- Repository truth wins, fail-closed behavior.
- Project isolation, redaction before persist.
- Contradictions remain visible; no silent merge/overwrite/retire.
- CBM as dependency (no vendoring internals).
