# Veyra — dsh-memory Capability Integration

## 1. Goal

Study and selectively absorb the strongest engineering-memory capabilities from:

```text
/home/lovedolove/projects/refs/dsh-memory
```

into Veyra.

The goal is **not** to copy dsh-memory wholesale, replace Veyra's architecture, or turn Veyra into a generic cognitive-agent operating system.

The goal is to evolve Veyra's existing engineering-memory lifecycle using proven ideas from dsh-memory while preserving Veyra's core identity and invariants.

Veyra remains:

> **Engineering Intelligence for Coding Agents**

with repository truth, evidence, validation, authority, project isolation, and engineering context as first-class concerns.

---

# 2. Core Direction

dsh-memory should be treated as a **reference implementation and source of engineering ideas**, not as Veyra's target architecture.

The desired evolution is:

```text
Current:

Observe
  ↓
Store
  ↓
Retrieve


Target:

Observe
  ↓
Decide
  ↓
Remember
  ↓
Validate
  ↓
Establish Authority
  ↓
Retrieve
  ↓
Check Applicability
  ↓
Check Temporal Validity
  ↓
Apply as Evidence
  ↓
Verify Against Repository Truth
  ↓
Update / Supersede / Invalidate
  ↓
Maintain Memory Health
```

The central idea is:

> **Memory is a lifecycle, not merely a database record.**

---

# 3. Reference Repository

Primary reference:

```text
/home/lovedolove/projects/refs/dsh-memory
```

The reference implementation must be studied at source-code level.

Do not rely only on README documentation.

Inspect relevant:

* source code;
* data models;
* memory lifecycle;
* write/decision logic;
* retrieval;
* ranking;
* semantic/unification logic;
* causal memory;
* temporal handling;
* forgetting;
* identity/provenance;
* metacognition;
* memory health;
* safety mechanisms;
* hooks;
* tests;
* mutation tests;
* corruption/recovery tests;
* release gates;
* recent fixes and regressions.

When the reference contains a mature implementation that is useful to Veyra, prefer adapting or copying the relevant implementation into Veyra and modifying it to fit Veyra's architecture rather than unnecessarily reimplementing the same mechanism.

Before copying code:

* verify licensing;
* verify architectural compatibility;
* verify dependency impact;
* preserve Veyra's semantics;
* avoid importing unrelated reference architecture.

---

# 4. Veyra Identity

Veyra is not:

* a generic chatbot memory system;
* a generic personal memory system;
* a generic cognitive-agent OS;
* a generic multi-agent orchestration framework;
* a second graph database;
* a documentation-generation system;
* a passive project-memory archive.

Veyra is:

> **Automation-first engineering intelligence for coding agents.**

Its purpose is to automatically discover, validate, maintain, retrieve, and deliver useful engineering memory while remaining grounded in repository truth.

Manual documentation maintenance must not become the primary mechanism for maintaining Veyra memory.

---

# 5. Existing Veyra Foundation

Preserve and strengthen Veyra's existing concepts:

```text
Observation
Memory
Knowledge
Evidence

Candidate
Derived
Canonical

Unverified
Reviewed
Verified
Stale
Invalid

Updates
Extends
Derives
Contradicts
Supersedes
```

Causal structure:

```text
symptom
  ↓
rootCause
  ↓
remedy
  ↓
verifiedOutcome
```

Canonical storage remains:

```text
Project SQLite
  +
FTS5
  +
Veyra relations
```

Do not introduce a competing canonical storage layer.

---

# 6. Non-Negotiable Invariants

All work must preserve these invariants.

```text
Observe ≠ Store

Candidate ≠ Truth

Similarity ≠ Authority

Similarity ≠ Applicability

Automatic behavior never becomes canonical by itself

No silent merge

Contradictions remain visible

Repository truth is authoritative

Historical memory ≠ Current truth

Attribution ≠ Authority

Memory ≠ Executable Instruction

Project isolation is fail-closed

Workspace isolation is fail-closed

Reusable-memory isolation is fail-closed

Secrets are scrubbed
```

Any proposed feature that violates these invariants must be rejected or redesigned.

---

# 7. P0 — Core Capabilities to Absorb

## 7.1 Memory Write Gate

Introduce an explicit decision layer between observation and memory persistence.

Target:

```text
Observation
    ↓
Write Gate
    ↓
ACCEPT
MERGE
DROP
DEFER
    ↓
Candidate / Evidence / Negative / Unresolved
```

The write gate should evaluate factors such as:

* relevance;
* novelty;
* duplication;
* project scope;
* evidence;
* provenance;
* contradiction;
* confidence;
* applicability;
* temporal context;
* safety.

The write gate must not directly create canonical truth.

### Required behavior

Veyra should be able to explain:

```text
Why was this stored?
Why was it merged?
Why was it rejected?
Why was it deferred?
```

---

# 8. Negative Memory

Introduce first-class negative engineering memory.

Examples:

```text
attempted solution
failed fix
rejected approach
known-bad configuration
disproven assumption
previous failed experiment
```

Negative memory is historical evidence.

It is not automatically authoritative.

Example:

```text
Attempt:
Use approach X.

Result:
Failed because Y.

Status:
Negative.
```

Future retrieval should be able to surface this information to prevent repeated mistakes.

---

# 9. Unresolved / Known-Unknown Memory

Represent problems that have been investigated but remain unresolved.

Distinguish:

```text
No known memory
```

from:

```text
Known unresolved investigation
```

Example:

```text
Symptom:
Deployment fails after step 4.

Known:
Failure consistently occurs at step 4.

Unknown:
Root cause has not been established.

Status:
UNRESOLVED
```

Unresolved knowledge must never be promoted to canonical knowledge merely because it is repeatedly retrieved.

---

# 10. Multi-Channel Retrieval

Strengthen Veyra retrieval using multiple complementary signals.

Existing:

```text
FTS5 / BM25
Token overlap
Intent
Relations
```

Potential additional channels:

```text
Causal relevance
Evidence strength
Negative history
Temporal validity
Applicability
Failure history
Provenance
```

The system should combine these signals through a deterministic rank-fusion mechanism such as RRF where appropriate.

Do not introduce embeddings merely for feature parity.

---

# 11. Retrieval Explainability

Retrieval should be inspectable.

A result should be explainable in terms of signals such as:

```text
lexical: high
intent: medium
relation: high
causal: high
evidence: verified
temporal: current
applicability: strong
negative-history: relevant
```

The exact scoring model may evolve.

The important requirement is that retrieval does not become an opaque ranking mechanism.

---

# 12. Applicability-Aware Retrieval

A similar memory is not necessarily an applicable memory.

Capture context such as:

```text
project
workspace
repository
environment
OS
runtime
toolchain
package manager
version
configuration
task type
```

Target behavior:

```text
Similarity
+
Context compatibility
+
Evidence
+
Temporal validity
```

Core invariant:

```text
Similarity ≠ Applicability
```

An incompatible memory must not outrank a directly applicable memory merely because its text is more similar.

---

# 13. Temporal Validity

Strengthen Veyra's stale and supersession semantics.

Potential fields:

```text
observed_at
valid_from
valid_until
superseded_at
```

Potential states:

```text
current
historical
superseded
stale
invalid
```

Historical knowledge should remain available when useful while no longer being presented as current truth.

Example:

```text
Old API:
valid_until = 2026-09-30

New API:
valid_from = 2026-10-01
supersedes = old memory
```

---

# 14. Causal Memory

Veyra already has a strong causal model.

Do not replace it.

Strengthen it using relevant dsh-memory ideas.

Target:

```text
Symptom
  ↓
Root Cause
  ↓
Remedy
  ↓
Verified Outcome
```

Causal retrieval should prioritize verified historical cause/effect chains for recurring engineering problems.

Example:

```text
Symptom:
DSH tool unavailable.

Root Cause:
Incorrect provider registration.

Remedy:
Correct provider registration.

Verified Outcome:
Tool became callable in live DSH Web.
```

The causal chain should remain connected to its evidence and verification history.

---

# 15. Provenance

Strengthen provenance across the entire memory lifecycle.

Useful dimensions:

```text
project
repository
workspace
session
agent
source
timestamp
evidence
validation state
```

Do not confuse provenance with authority.

An agent-generated observation remains an observation until validated.

---

# 16. Memory Provenance Chain

Where practical, preserve the lifecycle chain:

```text
Observation
  ↓
Evidence
  ↓
Candidate
  ↓
Validation
  ↓
Promotion
  ↓
Retrieval
  ↓
Application
  ↓
Verification
  ↓
Update / Supersession / Invalidation
```

This should allow Veyra to answer:

> Where did this memory come from, why was it trusted, and what happened when it was used?

---

# 17. Evidence Strength

Study and selectively absorb dsh-memory's handling of evidence quality.

Veyra should be able to distinguish between:

```text
single observation
repeated observation
independent evidence
repository evidence
test evidence
verified outcome
```

Evidence strength must remain separate from authority.

For example:

```text
High confidence
≠
Canonical authority
```

Repository truth and validation rules remain authoritative.

---

# 18. Deduplication and Merge Quality

Improve the quality of:

```text
ACCEPT
MERGE
DROP
DEFER
```

particularly around duplicate or overlapping memories.

Detect:

```text
exact duplicates
semantic duplicates
updates
extensions
contradictions
supersessions
```

Never silently merge contradictory information.

When two memories conflict, preserve the contradiction and its evidence.

---

# 19. Memory Feedback Loop

Memory should learn from actual engineering outcomes.

Target:

```text
Retrieve
  ↓
Apply
  ↓
Verify
  ↓
Success / Failure
  ↓
Feedback
  ↓
Update Memory
```

For example:

```text
Memory recommended approach X.

Agent applied X.

Tests failed.

Result:
memory reliability decreased / failure history updated.
```

A successful verified outcome should strengthen useful engineering knowledge.

---

# 20. Repeated Failure / Recurrence Detection

Detect recurring engineering problems.

Potential patterns:

```text
recurring symptom
recurring root cause
recurring failed approach
recurring remedy
recurring regression
```

This can enable Veyra to discover higher-value engineering knowledge automatically.

Example:

```text
Same dependency issue
→ 4 incidents
→ same root cause
→ same verified remedy
```

This should become a candidate for stronger engineering knowledge.

---

# 21. Memory Health

Introduce automated memory-health signals.

Potential categories:

```text
verified
reviewed
unverified
stale
invalid
contradicted
unresolved
negative
protected
```

Memory health should identify:

```text
new contradictions
stale knowledge
unresolved investigations
repeated failures
unverified high-value candidates
memories requiring revalidation
```

The `/memory-review` capability should evolve toward automated memory maintenance rather than manual database inspection.

---

# 22. Forgetting and Invalidation

Do not treat forgetting as unconditional deletion.

Where appropriate, preserve historical metadata:

```text
what was invalidated
when
why
what contradicted it
what replaced it
```

Support:

```text
invalidate
supersede
forget
tombstone
```

while keeping obsolete knowledge out of active retrieval.

---

# 23. Memory Protection

Study dsh-memory's memory-protection mechanisms.

Introduce protection selectively for important memories.

Protection must not override:

```text
repository truth
verified contradiction
security requirements
invalid state
```

A protected memory can still become invalid or superseded.

---

# 24. Memory Safety

Treat all memory as untrusted evidence.

Memory must never automatically become executable instructions.

Protect against:

```text
prompt injection
malicious repository content
malicious documentation
unsafe commands
secret persistence
instruction laundering
corrupted memory
```

Target:

```text
Memory
  ↓
Evidence
  ↓
Validation
  ↓
Agent Context
```

Not:

```text
Memory
  ↓
Execute
```

---

# 25. Corruption and Recovery

Study dsh-memory's corruption and UTF-8 hardening work.

Apply equivalent principles where appropriate to Veyra.

Consider:

```text
corrupted records
unreadable records
partial writes
invalid states
rollback
recovery
fail-closed behavior
```

A corrupted memory must not silently become authoritative.

---

# 26. Mutation and Regression Testing

Memory systems require stronger regression discipline than ordinary CRUD systems.

Add tests for:

```text
write decisions
merge decisions
contradictions
negative memory
unresolved memory
retrieval ranking
temporal validity
applicability
causal retrieval
invalidations
forgetting
corruption
isolation
security
```

Where valuable, use mutation testing to verify that tests actually protect lifecycle invariants.

---

# 27. P1 — Advanced Capabilities

Study and selectively absorb:

```text
Reflection
Feedback loops
Advanced memory maintenance
Metacognition
Memory self-state
Memory prediction
Goal-directed retrieval
Multi-agent attribution
```

Only implement these when there is a concrete engineering-memory use case.

Do not add them merely because dsh-memory has them.

---

# 28. Explicitly Do Not Import

## 28.1 Markdown Cognitive Graph

Do not make Markdown cognitive graph storage a second Veyra source of truth.

Veyra remains:

```text
SQLite
+
FTS5
+
Veyra relations
```

The graph visualization layer may continue to exist, but canonical memory storage must remain Veyra's existing model.

---

## 28.2 Hive / Swarm Architecture

Do not turn Veyra into a generic multi-agent orchestration framework.

Agent/session attribution is useful.

Hive orchestration is not a current Veyra requirement.

---

## 28.3 Large Generic Tool Surface

Do not copy dsh-memory's entire tool surface.

Prefer strengthening:

```text
veyra_remember
veyra_recall
veyra_inspect
veyra_forget
veyra_promote
```

Add tools only when a concrete engineering-memory workflow requires them.

---

## 28.4 Generic Cognitive-Agent OS

Do not import unrelated:

```text
identity systems
generic self-models
general-purpose prediction
generic personal memory
agent personality
task orchestration
```

unless a future Veyra requirement clearly justifies them.

---

# 29. Phased Implementation Roadmap

Implementation must proceed incrementally.

Do not perform one large dsh-memory-to-Veyra rewrite.

---

## Phase 0 — Reference Baseline

**Status: COMPLETE** — gap analysis recorded in `docs/capability-matrix.md` (21 capabilities with `file:symbol` citations).

### Goal

Understand dsh-memory and establish a precise Veyra gap analysis.

### Tasks

Inspect:

```text
/home/lovedolove/projects/refs/dsh-memory
```

Map:

* memory lifecycle;
* write gate;
* deduplication;
* merge;
* negative memory;
* unresolved memory;
* retrieval;
* ranking;
* RRF/fusion;
* applicability;
* temporal semantics;
* causal memory;
* provenance;
* feedback;
* recurrence;
* forgetting;
* protection;
* health;
* safety;
* corruption handling;
* mutation/regression testing.

### Deliverable

A capability matrix:

```text
Capability
→ dsh-memory implementation
→ current Veyra implementation
→ gap
→ Veyra integration point
→ priority
→ relevant tests
```

### Exit Criteria

No implementation is based solely on assumptions or README-level behavior.

---

# Phase 1 — Memory Decision Layer

**Status: COMPLETE** — `ACCEPT / MERGE / DROP / DEFER` write gate implemented in `src/learn.mjs` (`writeGate`, `WRITE_GATES`, integrated with Candidate/Evidence/Validation/Authority); `test/m1-write-gate.test.mjs` (9 tests).

Implement:

```text
Observation
  ↓
Write Gate
  ↓
ACCEPT / MERGE / DROP / DEFER
```

Integrate with Veyra's existing:

```text
Candidate
Evidence
Validation
Authority
```

Add focused regression tests.

### Exit Criteria

Veyra can explain why an observation was accepted, merged, rejected, or deferred.

---

# Phase 2 — Negative and Unresolved Memory

**Status: COMPLETE** — `KINDS.NEGATIVE` / `KINDS.UNRESOLVED` in `src/types.mjs` (+ lifecycle/recall eligibility split); idempotent writers `addRejected` / `addUnresolved` / `slugify` in `src/negative.mjs`, ported from dsh-memory `mdcg.py` + `tasks.py`; kind routing in `src/learn.mjs` (`remember()`); zero-score negative-coverage tail (`NEG_COVERAGE_MAX = 3`) in `src/retrieve.mjs`; render markers `[NEGATIVE · known failed solution]` / `[UNRESOLVED · known open investigation]` in `src/retrieve.mjs` + `src/context.mjs`; empty-recall state "No known engineering history" in `src/context.mjs`; `test/m2-negative-unresolved.test.mjs` (11 tests). Suite: 480 pass / 0 fail.

Implement:

```text
Negative
Unresolved
```

Ensure retrieval can distinguish:

```text
Known solution
Known failed solution
Known unresolved investigation
No known history
```

### Exit Criteria

Agents can avoid repeating known failed approaches and can recognize known unknowns.

---

# Phase 3 — Retrieval Fusion

**Status: COMPLETE** — causal retrieval channel + deterministic reciprocal-rank fusion added in src/retrieve.mjs (causalRelevance / causalText, RRF_K = 60 and FUSION_WEIGHT = 0.06 copied from dsh-memory md_cg/mdcos.py, reciprocalRankFusion across the nine §10 signals, sort-only `scores.fusion = composite + 0.06 * rrf`; `scores.composite` stays the plain weighted sum, polarity cap holds on both scores, empty-query pools keep the legacy chain). test/m3-fusion.test.mjs (12 tests). Suite: 492 pass / 0 fail.

Strengthen retrieval with:

```text
FTS5 / BM25
Token overlap
Intent
Relations
Causal
Evidence
Negative
Temporal
Applicability
```

Introduce RRF or equivalent deterministic fusion where beneficial.

### Exit Criteria

Retrieval quality improves without requiring unnecessary vector infrastructure.

---

# Phase 4 — Applicability and Temporal Semantics

**Status: COMPLETE** — §13 temporal validity in src/retrieve.mjs (`temporalBounds` / `temporalState`: canonical `source.temporal` with `valid_from`/`valid_until` read-side aliases copied from dsh-memory `md_cg/nodefile.py:133-138`, unparseable endpoints fail open per `mdcos.py`, states `current` / `not_yet_effective` / `expired`); §12 applicability context auto-captured on the write path in src/learn.mjs (`remember()` stamps `source.context` os/runtime + agent keys; `validFrom`/`validUntil` ride the source bag); `contextCompatibility` compares only keys both sides state, runtime at major-version granularity; both dimensions enter `FUSION_CHANNELS` as sort-only channels (`applicability`, `temporal_validity` — 11 total) plus a query-gated eligibility cap that holds non-eligible `fusion` below the best eligible alternative (`rank_limited` for §11 explainability); `composite` untouched (M11 pin), expired never removed, not_yet_effective never demoted; record views expose `temporal` + `context` (`recordView`, `RECORD_SCHEMA`, `veyra_remember` params in src/tools.mjs). `test/m4-applicability-temporal.test.mjs` (14 tests). Suite: 506 pass / 0 fail.

Implement contextual applicability and temporal validity.

### Exit Criteria

Veyra can independently answer:

```text
Is this memory relevant?
Is it applicable here?
Is it still valid?
```

---

# Phase 5 — Causal and Provenance Strengthening

**Status: COMPLETE** — §14 causal quality multiplier in `src/retrieve.mjs` (`causalRelevance`: `quality = 0.5 + 0.3*verified + 0.2*(documented/3)` where documented = non-empty [symptom, rootCause, remedy] — verified+complete chains score ×1.0 so legacy behavior stays byte-identical, fragments/unverified degrade smoothly but never to 0; participates only through the causal/RRF channel, `scores.composite` untouched); §15 attribution dimensions in `src/ids.mjs` (`provenanceDimensions`: workspace / repository / remote / agent via `findGitRoot` + `readGitRemote`) stamped into `source.provenance` **beside** `origins` on the capture path (`distillBuffer` / `candidateFromBuffer` / plugin turn-stop, cwd-gated so legacy call sites keep the exact `['origins']` shape) and on deliberate writes (`veyra_remember`) — `origins` remain the only M9 gate currency and dimensions never open the automatic-learning gate (provenance ≠ authority); §16 memory provenance chain in `src/context.mjs` (`provenanceChain`: Observation → Evidence → Candidate → Validation → Promotion → Retrieval → Application → Verification → Update/Supersession, read-only over facts the record already persists, honest `unknown` / `not-yet` / `not-tracked` states — Application is never invented: memory is evidence, not instructions) exposed as `payload.chain` + inspect-card render in `veyra_inspect` (`src/tools.mjs`). `test/m5-causal-provenance.test.mjs` (10 tests). Suite: 516 pass / 0 fail.

Strengthen:

```text
Symptom
→ Root Cause
→ Remedy
→ Verified Outcome
```

and provenance:

```text
project
repository
session
agent
source
timestamp
evidence
validation
```

### Exit Criteria

Recurring engineering problems can reuse verified causal knowledge.

---

# Phase 6 — Feedback and Recurrence

**Status: COMPLETE** — §19 feedback loop in `src/feedback.mjs` (`recordFeedback`: success strengthens via the existing observation ladder — obs≥3 + test evidence → verified/high + `promotion-candidate` tag, obs≥2 → reviewed/medium; failure records bounded history (`source.feedback.history`, 10 entries, counters never bounded) and demotes validation + confidence one rank each — canonical records get history only, validation/confidence/observations untouched; `causal.verifiedOutcome` is never synthesized or rewritten, authority is never changed) surfaced as **`veyra_feedback`** (`src/tools.mjs`, §19: deliberate agent report of a real application outcome, renders reliability change X→Y); §20 recurring-problem detection in `src/feedback.mjs` (`detectRecurrence`: recurring root cause / recurring symptom / recurring regression / recurring remedy / failed approach / recurring failure, threshold clamped 2–50, `remedyConsistent` + `verifiedRemedy` facets on causal clusters) surfaced as **`veyra_recurrence`** (read-only scan by default; writes only on explicit `autoCandidate=true` and only through the write gate — `recurrenceCandidate` → `writeGate` → derived candidate with DERIVES edges to every incident, `automatic:false`, never canonical; ineligible clusters report but never write). `test/m6-feedback-recurrence.test.mjs` (15 tests) + tool-count guards updated 12→14 (`compatibility`, `dsh-runtime`, `plugin`, `m4-applicability-temporal`). Suite: 531 pass / 0 fail.

Implement:

```text
Retrieve
→ Apply
→ Verify
→ Feedback
→ Update
```

Add recurring failure/root-cause detection where justified.

### Exit Criteria

Actual engineering outcomes can improve memory quality automatically.

---

# Phase 7 — Memory Health and Maintenance

**Status: COMPLETE** — §21 memory-health engine `src/health.mjs` (`memoryHealth`: nine quality categories — verified/reviewed/unverified/stale/invalid/contradicted/unresolved/negative/protected, buckets intentionally overlap, forgotten records excluded — plus six maintenance findings: contradiction pairs via `detectContradictions` (banner keeps both sides visible), stale knowledge, unresolved investigations, repeated failures via `feedbackStats` clamped threshold 2–50, unverified high-value candidates via `hasGrounding` (confidence HIGH OR grounded evidence — never auto-promoted), revalidation candidates via `verifyEvidenceHealth` broken/partial on trusted records; protected = `authority === CANONICAL` mapping, protection never shields rotting evidence; `renderHealth` caps long sections at 20 visible) surfaced read-only as **`/veyra health [threshold]`** (`src/commands.mjs:104`, merges project+reusable stores, dedup by id) and the **`veyra_health`** tool (`src/tools.mjs`, §21 output schema + `renderHealth` render, `presentCall` → "Memory health"). `skills/memory-review/SKILL.md` strengthened: ownership paragraph now routes through `veyra_health`/`/veyra health`, workflow gains a `Health` stage + step 0 "Run the automated health pass first" (findings are input to review, verify against the repository, never auto-fix), report gains an optional `Health (§21): <n> finding(s)` closing line. All six required headings/phrases preserved. `test/m7-memory-health.test.mjs` (16 tests incl. read-only byte-identical scans, threshold clamping, empty-store renders) + tool-count guards updated 14→15 (`compatibility`, `dsh-runtime`×2, `m4-applicability-temporal`, `plugin` + names list); `docs/capability-matrix.md` Health row + verdict refreshed. Suite: 547 pass / 0 fail.

Strengthen `/memory-review` and automated maintenance.

Surface:

```text
stale
contradicted
unresolved
negative
unverified
repeated failures
revalidation candidates
```

### Exit Criteria

Veyra can automatically identify memory-quality problems without requiring manual documentation maintenance.

---

# Phase 8 — Forgetting and Protection

Implement safe:

```text
invalidate
supersede
forget
tombstone
protect
```

with historical reasoning preserved where useful.

### Exit Criteria

Obsolete memory leaves active retrieval without destroying useful lifecycle history.

**Status: COMPLETE** — §22/§23 lifecycle in src/lifecycle.mjs (`forget` `invalidate` `supersede` `tombstone` `protect` `unprotect`): every action appends a bounded `source.lifecycle` trail entry (max 10) preserving the §22 list — when, why, contradictedBy, replacedBy — and obsolete records leave active retrieval via the existing recall gate (forgotten / status ≠ current / validation invalid) while `store.get` keeps them inspectable. Guard design: `guardedRetire` is fail-closed guard-first — explicit protection blocks `forget`/`tombstone` unless `override` supplies a reason (override recorded in history, copied from dsh-memory `md_cg/protect.py` `guard_forget`/`AUTO_PROTECT_IMPORTANCE`/`ProtectionError` + explicit-override semantics), while `invalidate`/`supersede` stay unguarded because §23 requires "a protected memory can still become invalid or superseded"; canonical authority is implicitly protected (`protectionOf` returns the canonical tier) and `unprotect` reports `stillProtected` for it (Automatic ≠ Canonical stays intact — canonical itself is only ever explicit). Surfaces: `/veyra forget|invalidate|supersede|tombstone|protect|unprotect` verbs + help/registerCommand hints (src/commands.mjs), `veyra_forget` tool gains auditable `reason`/`override` params and renders the guard text (src/tools.mjs), health counts `categories.protected` (src/health.mjs), `provenanceChain` stage "Update/Supersession" surfaces lifecycle reasoning without duplicating relation detail (src/context.mjs). Implementation note: lifecycle re-puts of canonical records pass `{ explicitCanonical: true }` via `putResult` because `assertAuthorityTransition` throws on any write whose authority is canonical without the flag — lifecycle actions never change authority, so the flag asserts "explicit user action, no auto-promotion". Tests: test/m10-forgetting-protection.test.mjs (12 tests) + test/plugin.test.mjs:481 amended — a plain `veyra_forget` on a canonical fixture is now asserted refused first, then completed with `override` + reason (Phase 8 required behavior change; earlier "ungated canonical forget" contract retired deliberately). Suite: 559 pass / 0 fail.

---

# Phase 9 — Safety and Reliability Hardening

Harden:

**Status: COMPLETE** — §24 memory safety in `src/learn.mjs` + `src/redact.mjs` + `src/types.mjs`: deep secret scrubbing of nested `source`/`evidence`/tag payloads (`scrubDeep`, accumulator-based, depth-capped, `api_key`/`secret`/`password`/`token`/`access_key`/`private_key` → `[REDACTED_SECRET]`, byte-identical ordinary text); untrusted memory is labeled evidence-only on render (`injectionWarning` in `src/context.mjs` + `src/retrieve.mjs` summarizeForPrompt); M1–M4 mutation guards (isLifecycleEligible fails closed on `record.corrupt` and unknown validation/authority). §25 corruption + recovery in `src/store.mjs`: strict JSON column parsing (`parseJsonStrict` pushes broken field names into `record.corrupt`), structural field validation (`recordStructuralFields`), row corruption tagging in `rowToRecord`, fail-closed `PRAGMA quick_check` wrapping in `openDatabase` (garbage / non-database header → `Veyra refuses to open corrupted store`), corrupt-row overwrite guard (`repair: true` required in `put`), verified repair path via `veyra_remember` tool (`repair` boolean param). Health reporting for corrupted records in `src/health.mjs` (`memoryHealth` accepts array OR object with `.list()`, corrupted-record count + section). `test/m13-safety-hardening.test.mjs` (12 tests) + identifier-splitting FTS regression fix in `test/retrieve-identifier.test.mjs` (`source: []` → `source: {}` — corrupt source column was failing closed recall eligibility). Suite: 571 pass / 0 fail.

```text
prompt injection
secret scrubbing
corruption
recovery
rollback
fail-closed isolation
invalid state handling
```

Add regression and mutation coverage.

### Exit Criteria

Untrusted, corrupted, stale, or malicious memory cannot silently become authoritative engineering behavior.

---

# Phase 10 — Advanced Capabilities

Only after Phases 1–9 are stable.

Evaluate:

```text
metacognition
self-state
prediction
goal-directed retrieval
advanced reflection
multi-agent attribution
```

Every capability requires:

```text
clear engineering use case
measurable benefit
Veyra-native implementation
regression coverage
no scope violation
```

---

# Phase 11 — Benchmark and Final Hardening

Measure:

```text
write precision
duplicate suppression
false memory rate
negative-memory recall
unresolved-memory recall
retrieval relevance
applicability accuracy
temporal correctness
causal retrieval quality
contradiction detection
stale-memory detection
feedback effectiveness
recurrence detection
memory safety
project isolation
```

Use:

```text
unit tests
integration tests
retrieval fixtures
lifecycle fixtures
contradiction cases
corruption cases
mutation tests where useful
```

Remove features that increase complexity without measurable benefit or meaningful invariant improvement.

---

# 30. Recommended Execution Order

```text
Phase 0
  ↓
Phase 1 — Write Gate
  ↓
Phase 2 — Negative / Unresolved
  ↓
Phase 3 — Retrieval Fusion
  ↓
Phase 4 — Applicability / Temporal
  ↓
Phase 5 — Causal / Provenance
  ↓
Phase 6 — Feedback / Recurrence
  ↓
Phase 7 — Memory Health
  ↓
Phase 8 — Forgetting / Protection
  ↓
Phase 9 — Safety / Reliability
  ↓
Phase 10 — Advanced Capabilities
  ↓
Phase 11 — Benchmark / Hardening
```

Do not skip directly to advanced cognitive capabilities.

---

# 31. Phase Completion Rules

Every phase must leave Veyra in a working state.

For each phase:

1. Inspect the current Veyra implementation.
2. Inspect the corresponding dsh-memory implementation.
3. Identify the smallest Veyra-native change.
4. Implement it.
5. Add focused regression tests.
6. Run the relevant test suite.
7. Verify Veyra invariants.
8. Verify project/workspace/reusable isolation.
9. Verify safety behavior.
10. Record the resulting behavior.
11. Only then proceed.

Avoid broad cross-phase refactors.

---

# 32. Implementation Rules

* Prefer minimal changes.
* Preserve existing Veyra architecture.
* Reuse mature reference code when appropriate.
* Do not duplicate existing Veyra functionality unnecessarily.
* Do not introduce a second canonical storage system.
* Do not silently change memory semantics.
* Do not silently merge contradictions.
* Do not weaken authority rules.
* Do not weaken isolation.
* Do not treat memory as executable instructions.
* Do not introduce embeddings without a concrete requirement.
* Do not add generic agent functionality.
* Do not expand the tool surface without a clear use case.
* Do not perform unrelated refactoring.
* Add regression tests for new behavior.
* Verify existing tests remain passing.
* Prefer automated memory discovery and maintenance over manual documentation workflows.

---

# 33. Success Criteria

The integration is successful when Veyra can:

* automatically decide whether an observation should become memory;
* reject or defer low-value observations;
* merge legitimate updates without silently hiding contradictions;
* remember failed and rejected engineering approaches;
* explicitly represent unresolved engineering questions;
* retrieve memories using multiple complementary signals;
* distinguish similarity from applicability;
* distinguish current knowledge from historical knowledge;
* retrieve verified causal engineering knowledge;
* preserve full useful provenance;
* understand evidence strength;
* learn from successful and failed memory applications;
* detect recurring engineering failures;
* identify stale, conflicting, invalid, and unresolved memory;
* safely invalidate and forget obsolete memory;
* protect important memory without overriding repository truth;
* treat memory as untrusted evidence rather than executable instructions;
* survive corrupted or invalid memory states safely;
* continuously maintain memory quality without manual documentation maintenance.

---

# 34. Final Definition of Done

The final system should evolve from:

```text
Observe
→ Store
→ Retrieve
```

toward:

```text
Observe
→ Decide
→ Remember
→ Validate
→ Establish Authority
→ Retrieve
→ Check Applicability
→ Check Temporal Validity
→ Apply as Evidence
→ Verify Against Repository Truth
→ Learn From Outcome
→ Detect Recurrence
→ Update / Supersede / Invalidate
→ Maintain Memory Health
```

while remaining:

> **Veyra — Engineering Intelligence for Coding Agents**

The outcome must be a stronger Veyra, not a Veyra-shaped fork of dsh-memory.
