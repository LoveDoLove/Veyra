# Phase 1.6 — Delivery & Application Proof Feasibility

**Date:** 2026-11-07  
**Scope:** read-only investigation and approved documentation only. No source, dependency, test, configuration, or runtime changes. No model/API calls or experiment execution. No modification or restart of existing DSH Web/profile. No Git staging/commits/pushes/tags/releases.  
**Objective:** resolve Phase 1.5 observability gaps by determining whether Veyra memory **delivery** to, and **application** by, a Coding Agent can be independently proved with existing supported mechanisms.

**Evidence sources (inspected):** installed DSH packages under `/home/lovedolove/.local/share/mise/installs/node/24.22.2/lib/node_modules/@deepseek-ai/dsh/node_modules/` — `@deepseek-ai/dsh-system-prompt` (`lib/types/index.d.ts`, `lib/index.js`), `dsh-agent-loop` (`lib/index.js`, `lib/types/runtime-context.d.ts`), `dsh-agent` (`lib/index.js`, `lib/types/archive-admission.d.ts`, `lib/types/runtime-types.d.ts`, event docs/types), `dsh-headless` (`lib/types/index.d.ts`, `lib/index.js`), `dsh-llm` (`lib/types/types.d.ts`, `call-config.d.ts`); Veyra v0.1.72 surfaces `src/plugin.mjs`, `src/context.mjs`, `src/apply-generation-evidence.mjs`, `src/tools.mjs`, `src/health.mjs`; prior reports `docs/research/phase1-readiness-closure-report.md`, `docs/research/phase1-5-experiment-infrastructure-readiness.md`.

**Interpretation rule:** “no X found” means not evidenced in the inspected supported surfaces; it is not proof that an undocumented/private path does not exist. This report does not invent or rely on unsupported DSH APIs.

---

## 1. Exact delivery boundary and supporting evidence

### 1.1 Context assembly (Veyra contribution)

| Stage | Mechanism | Evidence |
|---|---|---|
| Veyra registers recall context | `scope.systemPrompt.context(...)` name `veyra:recall`, order `200` | `src/plugin.mjs:264-267` (prior Phase 1/1.5 evidence) |
| Veyra renders recall text | `createContextProvider` builds recall block with heading `Veyra recalled engineering memory`, record IDs `vey_...`, evidence/trust lines; emits P1 Stage A generation event | `src/context.mjs` |
| Veyra generation evidence | `veyra_apply_generation_v1` statuses `generated` / `generated_empty` / `generation_error`; `delivery.status=NOT_VERIFIED`, `delivery.source=stage-a-local`, `delivery.reason="no supported DSH admission evidence"`; `used.status=NOT_VERIFIED`, `used.source=stage-a-local` | `src/apply-generation-evidence.mjs` |

**Fact:** Veyra can prove *local generation* (a recall block was produced/attempted with bounded metadata). Veyra does **not** claim delivery or use.

### 1.2 DSH system-prompt assembly

| Boundary element | Evidence (inspected) | Relevance to delivery proof |
|---|---|---|
| `SystemPrompt.assemble(context)` builds `PromptAssembly` (`sections`, `contexts`, `toolSchemas`, `variables`) and runs Cordis waterfall `system-prompt/assemble` with `(assembly, context, ...)` | `dsh-system-prompt/lib/types/index.d.ts`, `lib/index.js` | A harness/plugin with supported access to the same Cordis context/waterfall can observe post-assembly content **before** LLM admission, *if executed in an isolated harness under separate authorization*. Not a delivery-to-model proof by itself. |
| `renderContextSections(assembly)` / `joinContextSections` / `renderPrompt` produce prompt text | same | Rendered text is inspectable in-process; still pre-admission. |
| `systemPrompt.refreshContext(assembly, ...)` refreshes accepted runtime facts without full reassembly | same | Runtime facts can change; proof must bind to the specific step/request. |
| `PromptContext` carries agent/scope/signal/workspace/session/model context | `lib/types/index.d.ts` | Enables correlation keys in a controlled harness; no model-receipt. |

### 1.3 Agent-loop pre-admission mutation and request freeze

| Boundary element | Evidence (inspected) | Relevance |
|---|---|---|
| `agent/pre-step` waterfall receives proposed messages/turn/step/signal/modelSelection; may reject or replace messages; fallback projects runtime context after listeners | `dsh-agent` runtime-types/READMEs, `dsh-agent-loop/lib/index.js` (~685+ region inspected), `dsh-agent/lib/index.js` | **Critical gap boundary:** content present in system-prompt/assembly can be altered, removed, or displaced before the request is frozen. Proof must observe at/after final pre-step + request derivation, not only at context generation. |
| `agent/request` waterfall can replace sampling/controls (deprecated path noted) | agent docs/types | Can affect request construction; not an admission receipt. |
| Step execution: pre-step decision → `agent/request` waterfall + `prepareCall()` → reconcile rendered prompt via prepared-call capability (`systemPromptUpdate` in-history handling) → refresh registered runtime facts → append accepted user batch/runtime-context candidate → restore removed runtime context → `deriveMessages()` + `header.config` + `header.tools` (no `system` field in derived request shape) → `markAgentLoopRequest` → `preparedCall?.stream(request) ?? ctx.llm.stream(request)` | `dsh-agent-loop/lib/index.js` (step/request path inspected) | The **nearest evidenced admission point** is the call to `stream(request)` with the frozen/marked request. Before this call, DSH can still mutate/reconcile messages. |
| No `llm/*` Cordis waterfall/emit events found in `dsh-llm/lib/types` | `dsh-llm/lib/types/types.d.ts`, `call-config.d.ts`, package search | No supported public LLM-admission event surface was evidenced for observing the final outbound request. |
| No `admission` / `model-receipt` / `beforeModel` hook found in agent-loop/agent/headless lib search | inspected agent packages | No supported delivery receipt or model-side acknowledgment surface evidenced. |

### 1.4 Headless observability

| Surface | Evidence | Relevance |
|---|---|---|
| `dsh headless --json` emits NDJSON events to stdout | `dsh-headless/lib/types/index.d.ts`, `lib/index.js`, CLI help | Useful for isolated run control and coarse run/session/output capture. |
| Implementation projects run/session/output events (assistant text summary, stderr/reasoning projection as inspected) | `dsh-headless/lib/index.js` | **Not evidenced** to emit assembled prompt, frozen LLM request payload, context-provider admission, or Veyra delivery markers. Cannot serve as direct delivery proof without additional supported instrumentation/artifact. |

### 1.5 Delivery boundary (conclusion)

**Exact boundary (best evidenced):** *request admitted to the LLM stream* at `preparedCall?.stream(request) ?? ctx.llm.stream(request)` in the agent loop, after pre-step, request waterfall/prepareCall, prompt reconciliation/runtime-fact refresh, message derivation, and request freeze/marking.

**Practical proof boundary available today (indirect):** Veyra local generation (`veyra_apply_generation_v1`) proves a recall block was produced; DSH system-prompt/agent-loop internals show where it *could* be included, but **no supported surface was evidenced that exports the final admitted request or confirms model receipt**.

---

## 2. Whether direct delivery proof is technically possible

### 2.1 With existing supported/public surfaces only

**No, not fully/directly provable as “delivered to the model”.**

Reasons:
1. **No delivery/admission receipt:** no `llm/*` event, no model-receipt, and no headless NDJSON field was evidenced to expose the final outbound request or confirm provider admission.
2. **Post-generation mutation:** `agent/pre-step`, request preparation/reconciliation, runtime-fact refresh, and message derivation occur after context assembly; generated Veyra text can be absent from the frozen request.
3. **Headless gap:** NDJSON output is not evidenced to contain prompt/request payload.
4. **P1 Stage A design is explicit:** Veyra intentionally records `delivery=NOT_VERIFIED` with “no supported DSH admission evidence”.

### 2.2 With supported in-process harness access (isolated, separately authorized)

**Partially possible as “present in final frozen request before `stream(request)`”, not as “received/used by model”.**

A test/harness composed in-process with the same Cordis services *may* observe `system-prompt/assemble`, register controlled `agent/pre-step`/`agent/request` listeners, or inspect request-preparation boundaries if those surfaces remain supported and accessible in that composition. This can produce **direct pre-stream evidence** that a Veyra marker/record ID appeared in the final derived request messages for a specific step. It still does **not** prove:
- the provider accepted/transmitted the exact payload;
- the model attended to or used the memory.

Such a harness is an experiment/runtime probe in effect; it requires separate CEO authorization, isolated `DSH_HOME`/`VEYRA_HOME`, and must not touch existing DSH Web/profile.

### 2.3 With smallest new instrumentation (not implemented)

**Yes, direct pre-stream delivery proof becomes feasible** if DSH (preferred) or an authorized harness exposes a minimal, privacy-controlled artifact for the frozen admitted request (see §5). Model receipt/use remains outside Veyra/DSH control unless the provider exposes verifiable receipts.

---

## 3. Application attribution methodology

Application cannot be inferred from generation or delivery. Attribution requires a **traceable, conservative evidence chain** with explicit confidence labels.

### 3.1 Minimal evidence chain

| Link | Evidence | Directness | Notes |
|---|---|---|---|
| **R — Record** | Veyra record ID (`vey_...`), version/hash/scope if available, recalled text/facts, evidence anchors | Direct (Veyra store) | Bind to exact record, not topic similarity. |
| **G — Generated** | `veyra_apply_generation_v1` event: `generated`/`generated_empty`/`generation_error`, invocation correlation, bounded refs, `delivery/used=NOT_VERIFIED` | Direct (Veyra local) | Necessary precondition; never sufficient for delivery. |
| **D — Delivered (pre-stream)** | Supported artifact showing final frozen request/messages for the step **contained** the Veyra marker and/or specific `vey_...` ID(s) from R, with step/invocation/session correlation; baseline arm absent or controlled | Direct only with supported request artifact/interceptor; otherwise `NOT_VERIFIED` | Must be captured **after** pre-step/request derivation. A headless NDJSON summary is insufficient unless it carries the required payload/hash proof under a supported contract. |
| **A — Applied** | Agent’s explicit, contemporaneous decision trace cites R/G facts (or the specific `vey_...`/quoted constraint) **and** subsequent action/code/tool change is consistent with that cited fact; alternative explanations considered | Mostly inferential; strongest available without model internals | Do **not** treat “code matches memory” alone as application. Require citation/decision trace + consistency + counterfactual awareness. `veyra_feedback`/`veyra_apply_outcome_link_v1` with valid `generationEventId` is **explicit linkage**, non-causal and non-verifying. |
| **O — Outcome** | Independently verified engineering result: tests, constraint checklist, diff/rework analysis, safety checks, reproduction/fix confirmation | Direct (repo/runtime truth) | Outcome can be positive/negative regardless of application claim; attribute cautiously. |

### 3.2 Attribution labels

| Label | Criteria |
|---|---|
| `PROVED_APPLIED` | Not currently attainable with available DSH/model surfaces. Would require verifiable model-attention/receipt plus R→D→A→O chain. |
| `SUPPORTED_APPLICATION` (strongest realistic) | D=`PROVED_DELIVERED_PRESTREAM` **and** explicit agent decision trace cites R **and** action/change is consistent **and** O is independently verified **and** baseline/confounds do not explain result better. Still not proof of model cognition. |
| `PLAUSIBLE_CORRELATION` | G present, A/O consistent with R, but D unproven or decision trace absent. |
| `NOT_VERIFIED` | Missing D and/or missing traceable A evidence. Default when direct proof is unavailable. |
| `CONTRADICTED` | D disproves presence, or agent trace/action/outcome conflicts with R. |

### 3.3 Controls to reduce false attribution

- **Treatment/baseline isolation:** `recallLimit>0` vs `recallLimit:0` (code-fixed in v0.1.72; live effective runtime parity still unverified). Separate session/context and isolated `DSH_HOME`/`VEYRA_HOME`/store.
- **Parity:** identical repo revision, task, model, tools, permissions, prompts except the controlled variable.
- **Record binding:** match specific `vey_...` IDs/anchors; avoid “any memory about X”.
- **Predeclare success/failure criteria** from repo-truth (tests/constraints), per Phase 1.5.
- **Record confounds:** existing repo state, agent prior knowledge, non-Veyra context, retries.

---

## 4. Existing capabilities versus missing capabilities

| Capability | Existing (verified/inspected) | Missing / gap |
|---|---|---|
| Memory generation evidence | Veyra P1 Stage A `veyra_apply_generation_v1`, `veyra_health.applyGeneration`; bounded metadata, no raw query/content/secrets; delivery/used `NOT_VERIFIED` | — (for generation claim) |
| Veyra identifiability in rendered text | Recall heading `Veyra recalled engineering memory` and `vey_...` record IDs in `src/context.mjs` output | Stable machine-readable marker contract not specified for proof; text matching is harness logic, not a DSH contract |
| DSH context assembly observation | `system-prompt/assemble` waterfall, `PromptAssembly`, render helpers in-process | Observation requires supported harness composition; not a model-delivery receipt |
| Pre-stream mutation visibility | `agent/pre-step`/`agent/request` watermarks/waterfalls and request derivation path visible in installed code | No supported exported artifact proving final admitted request content |
| LLM admission receipt | None evidenced | **Missing:** supported hook/event/artifact at/after final `stream(request)` (or equivalent) exposing enough proof (ideally hashes/markers + correlation) without leaking secrets |
| Model receipt/use | None evidenced/controlled by Veyra/DSH | **Missing/unavailable:** provider/model-side receipt or attention proof |
| Headless run capture | `dsh headless --json` NDJSON run/session/output events | **Missing:** prompt/request/admission fields or verifiable delivery markers |
| Explicit outcome linkage | `veyra_feedback` optional `generationEventId`; `recordExplicitOutcomeLink` with valid retained ID (non-causal) | No automatic causal attribution; depends on caller discipline |
| Isolated environment primitives | `--profile`, headless flags, `VEYRA_HOME`/`DSH_HOME` path controls, in-process test composition patterns | Live isolated runtime parity and profile/config behavior **unverified**; no dedicated “proof artifact” mode |

---

## 5. Smallest required instrumentation, if any

Existing supported surfaces are **insufficient for direct delivery proof** and insufficient for strong application proof. The smallest change that materially closes the delivery gap is a **DSH-side, opt-in pre-stream admission artifact**. Veyra-only changes cannot prove DSH/LLM admission.

### 5.1 Smallest viable instrumentation (recommended candidate)

**Owner:** **DSH** (agent-loop / LLM call boundary), not Veyra core learning/retrieval behavior.  
**Form:** opt-in, isolated-experiment-only diagnostic artifact/event emitted **after** final request freeze/mark and **before or at** `stream(request)`, carrying:

- correlation IDs: session/run, turn, step, model selection/profile (non-secret), timestamp;
- `delivery.channel`: e.g. `preparedCall.stream` or `ctx.llm.stream`;
- prompt/request proof: **content hash** (and optional byte/token length/counts) of the final admitted messages/system context; **must not include raw prompt by default**;
- optional marker proof: boolean/hash evidence for predeclared experiment markers (e.g., Veyra recall heading or selected `vey_...` IDs) computed by the harness from known candidate markers, so the artifact can confirm presence without dumping full context;
- mutation lineage (minimal): whether pre-step replaced messages / request waterfall altered request, if available from existing decision objects.

**Where:** DSH agent-loop call site (the inspected `stream(request)` boundary) or an officially supported hook that exposes the same frozen request. Veyra should continue emitting `veyra_apply_generation_v1`; a harness may correlate generation IDs with DSH admission artifacts.

### 5.2 Alternatives (larger or less direct)

| Option | Owner | Tradeoff |
|---|---|---|
| Headless NDJSON `request_admitted` event with hashes/marker proof | DSH/headless | Good for isolated CLI runs; requires headless+agent-loop contract. |
| Public `llm/before-stream` or `agent/request-admitted` Cordis event exposing frozen request metadata | DSH | Powerful but broader API surface; needs careful stability/security review. |
| Harness registers supported pre-step/request watermarks and reconstructs request | Experiment harness, only if supported | Still inferential unless it can observe the exact final object passed to `stream(request)`; fragile to internal changes. |
| Veyra-side richer generation metadata (record hashes, rendered marker hash) | Veyra | Improves correlation but **cannot** prove delivery/admission; keep `delivery=NOT_VERIFIED`. |

### 5.3 Security and privacy implications

- **Prompt/data leakage:** raw request/prompt artifacts can contain secrets, proprietary code, credentials, and personal data. Default must be **no raw content**; use hashes/lengths/marker booleans.
- **Secret/PII in markers:** marker matching against `vey_...` IDs is low risk; matching arbitrary recalled text can leak. Use IDs/hashes selected by the experiment protocol.
- **Scope/control:** opt-in only; disabled by default; restricted to isolated experiment profiles/homes; explicit retention/TTL and local-only storage.
- **Integrity:** artifacts should include correlation IDs and tamper-evident metadata where feasible; avoid mutable global state.
- **Authorization boundary:** any instrumentation or runtime probe requires CEO approval and separate implementation/execution authorization; never enable on production profile.

### 5.4 Application-attribution instrumentation (separate, smaller policy change)

Direct model “use” proof is not realistically available. The smallest *process* instrumentation is a **structured decision-trace convention** in the experiment harness (or optionally a DSH artifact): when an agent claims to apply memory, it records `generationEventId`/`vey_...` IDs, cited fact, intended action, and resulting diff/test. This improves evidence quality but remains partly inferential.

---

## 6. Isolated runtime verification prerequisites

These steps are prerequisites only; **not executed** in Phase 1.6.

1. **CEO authorization** for isolated runtime preflight/probes, separate from this read-only report.
2. **Isolated homes/profiles:** dedicated `DSH_HOME` and `VEYRA_HOME` paths, never the existing DSH Web/profile or authoritative runtime DB. Use throwaway profile names/workspaces.
3. **Parity matrix:** document and hold constant repo revision, task prompt, model/provider, tools, permissions, approval policy, and non-Veyra system context except the controlled arm.
4. **Arm configuration:** treatment `recallLimit>0`, baseline `recallLimit:0`; verify *effective* runtime config in the isolated environment before runs (current blocker: live parity unverified).
5. **State seeding:** predeclared Veyra records/seeds; record store paths and hashes; fresh session per run unless session continuity is the tested variable.
6. **Non-model preflight:** in-process or isolated checks that Veyra registers context, generation events are written/readable, and baseline suppresses recall where expected.
7. **Delivery-proof preflight (if instrumented):** validate admission artifact schema, correlation IDs, hash/marker correctness, privacy defaults (no raw prompt), and that treatment/baseline produce distinguishable evidence.
8. **Capture bundle:** git revision, config snapshot, arm label, session/run IDs, Veyra generation/feedback/health outputs, DSH artifacts (if authorized), agent transcript/decision trace, diffs, and test/outcome results.
9. **Safety gates:** no writes outside isolated homes/workspaces; no network/model calls without explicit execution authorization; preserve existing modified/untracked files in the main repo.

---

## 7. Final verdict

**`NOT_READY`** for implementation approval as a claim that delivery/application can already be independently proved.

**Rationale:**
- **Delivery:** Veyra proves local generation (P1 Stage A), but direct proof that Veyra memory was included in the *final request admitted to the model* is **not technically possible with existing evidenced supported surfaces**. The nearest boundary is `stream(request)` in the agent loop; no supported admission receipt/model-receipt/headless request artifact was evidenced.
- **Application:** cannot be inferred from generation/delivery. Strongest realistic outcome is `SUPPORTED_APPLICATION`/`NOT_VERIFIED`/correlation with explicit trace controls; `PROVED_APPLIED` is not currently attainable.
- **Path forward:** a smallest DSH-side, opt-in, privacy-controlled pre-stream admission artifact (hash/marker proof, no raw prompt by default) can make **pre-stream delivery proof** feasible in isolated experiments. Application attribution still requires structured decision traces and independent outcomes; model-use proof remains unavailable.

**Classification for CEO decision:** **READY_FOR_IMPLEMENTATION_APPROVAL is not granted.** The smallest instrumentation is identified (§5), but implementation requires separate design/security review and explicit authorization; isolated runtime verification prerequisites remain unmet (§6).

