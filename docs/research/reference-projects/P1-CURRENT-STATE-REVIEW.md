# P1 Current-State Review — Generated / Delivered / Used / Outcome Evidence

**Status:** CEO-approved review (P1), research/documentation only. No production or test code changes.  
**Date (source context):** 2026-11-07 (Asia/Singapore)  
**Scope:** Evidence available for recall/context **Generated**, **Delivered**, **Used**, and **Outcome** stages. Evidence is from repository source and tests as read; no tests executed, no runtime experiments, no DSH Host API assumptions.

## 1. Sources inspected

| Area | Files / tests |
|---|---|
| Recall generation | `src/retrieve.mjs` (1366 lines) — `hybridRetrieve`, `recall`, ranking, eligibility, neg coverage tail, `summarizeForPrompt` |
| Context composition/provider | `src/context.mjs` (978 lines) — `createContextProvider`, `buildRecallContext`/rendering, `queryFromAssemble`, prompt/intent/change signal helpers; budgets/warnings |
| DSH integration | `src/plugin.mjs` (esp. ~240-290) — registers `systemPrompt.section` `veyra:guidance` (order 3050) and `systemPrompt.context` `veyra:recall` (order 200, `text: createContextProvider(runtime)`) |
| Outcome feedback | `src/feedback.mjs` (290 lines) — `recordFeedback`, `success`/`failure`, `source.feedback` history, strengthen/demote behavior |
| Contradiction audit (non-delivery) | `src/audit.mjs` — `contradicts` edges only |
| Context/rendering tests | `test/m6-context.test.mjs` (composition/rendering, supersession, evidence, contradictions, causal facets, isolation, deterministic, no mutation) |

Related but not fully inspected here: `src/tools.mjs` recall/feedback tool handlers, `src/store.mjs` touch/recall metadata, DSH `systemPrompt`/`agent` host internals (external to Veyra; not assumed).

## 2. Stage-by-stage evidence

### 2.1 Generated — Was memory context generated?

| Item | Assessment |
|---|---|
| **Existing event/metadata** | No explicit persisted “generation event”/telemetry record found. Generation occurs when `createContextProvider(runtime)` is invoked and it recalls/renders context (via `recall`/`buildRecallContext`/render path), or when recall tools/query paths run. `retrieve.mjs`/`context.mjs` produce in-memory results. |
| **Source module/function** | `src/context.mjs`: `createContextProvider`, `queryFromAssemble`, recall/render helpers. `src/retrieve.mjs`: `recall`, `hybridRetrieve`, `summarizeForPrompt`. `src/plugin.mjs`: registers provider as `systemPrompt.context` text function. |
| **Existing test evidence** | `test/m6-context.test.mjs` verifies composition/rendering outputs (supersession naming, evidence rendering, contradiction banners, causal facets, isolation, deterministic, no mutation). This supports **rendering/generation behavior in tests**, not DSH admission or use. |
| **What can be proven** | Veyra code can generate recall text/records given inputs (query/runtime/stores) under tested/local execution paths. Provider registration exists. |
| **What cannot be proven** | That DSH Host invoked the provider for a specific real turn; that generation completed for a specific production session; that generated text was non-empty/admitted; any global generation rate. |
| **Privacy/redaction limitations** | Generated context may include memory summaries/evidence labels; Veyra already applies budgets/warnings/redaction-related practices in context/render paths (inspect `context.mjs`/`redact.mjs` usage), but no generation telemetry schema reviewed. A future event must avoid storing raw prompts/secrets. |
| **Evidence type** | **Indirect / code-capability evidence.** Direct per-turn generated event: **unavailable**. |

### 2.2 Delivered — Was it actually admitted into the Agent’s context?

| Item | Assessment |
|---|---|
| **Existing event/metadata** | **None found in inspected Veyra code.** No delivery callback, no admission receipt, no persisted “delivered” marker, no token/context-window confirmation. |
| **Source module/function** | Provider is registered in `src/plugin.mjs` (`systemPrompt.context` `veyra:recall`, order 200). Actual admission into the assembled model prompt is performed by DSH Host/runtime (`systemPrompt` composition) — outside Veyra code inspected. |
| **Existing test evidence** | No test found proving DSH Host admitted Veyra recall into the model’s final context. `test/m6-context.test.mjs` proves Veyra rendering behavior only. |
| **What can be proven** | Veyra registers a recall context provider with DSH’s prompt system (static code fact). |
| **What cannot be proven** | Provider invocation for a specific turn; returned text accepted/admitted; truncation/omission by Host; placement relative to token limits; that the Agent actually received the text. **Provider invocation is not proof of delivery.** |
| **Privacy/redaction limitations** | Delivery evidence, if ever available from Host, should not duplicate sensitive content; prefer admission metadata (admitted yes/no/unknown, byte/token counts, truncation flag) if Host exposes it. |
| **Evidence type** | **Unavailable / NOT_VERIFIED** from Veyra evidence alone. Registration is direct code evidence of intent/integration point, not delivery. |

### 2.3 Used — Is there reliable evidence the Agent referenced or applied it?

| Item | Assessment |
|---|---|
| **Existing event/metadata** | **None found.** No “memory used/cited/applied” event, no attribution from Agent output/tool calls back to specific recalled record IDs in the inspected modules. |
| **Source module/function** | Not present in inspected `context.mjs`/`retrieve.mjs`/`plugin.mjs`/`feedback.mjs`/`audit.mjs`. |
| **Existing test evidence** | No tests for used-memory attribution found in inspected test. |
| **What can be proven** | Nothing reliable from inspected Veyra code about actual Agent use/reference/application of a specific recalled memory. |
| **What cannot be proven** | That the Agent read, cited, reasoned from, or applied any delivered memory; which record influenced behavior. **Delivery is not proof of utilization.** |
| **Privacy/redaction limitations** | Inferring use from model output would be heuristic and sensitive; explicit, bounded attribution would require careful design and likely Host/model instrumentation not assumed here. |
| **Evidence type** | **Unavailable / NOT_VERIFIED.** |

### 2.4 Outcome — Was the resulting work successful, unsuccessful, or unknown?

| Item | Assessment |
|---|---|
| **Existing event/metadata** | **Explicit per-record feedback exists** via `veyra_feedback`/`recordFeedback` (`src/feedback.mjs`): stores `source.feedback` stats/history (`success`/`failure`, note, timestamp), strengthens on success, demotes reliability on failure for non-canonical (canonical validation/confidence protected; history still recorded). |
| **Source module/function** | `src/feedback.mjs`: `recordFeedback(store,{id,outcome,note})`; writes record `source.feedback`. `src/tools.mjs` exposes feedback (per tools summary; handler details not re-read fully). |
| **Existing test evidence** | Feedback behavior is covered in Veyra’s feedback-related tests/codebase patterns (not exhaustively enumerated in this pass); current-state evidence is primarily source-level from `feedback.mjs`. |
| **What can be proven** | When feedback is explicitly recorded for a record ID, Veyra can prove that outcome signal was stored for that record. |
| **What cannot be proven** | That the outcome was caused by a specific generated/delivered/used memory; that feedback corresponds to a particular recall turn; automatic attribution. **Feedback is not automatically proof that a particular memory was used.** |
| **Privacy/redaction limitations** | Feedback notes may contain sensitive detail; `recordFeedback` stores note in `source.feedback.history` — any extension must respect redaction/privacy constraints. |
| **Evidence type** | **Direct for explicit per-record outcome signals; indirect/unavailable for memory-causal attribution.** |

## 3. Summary matrix

| Stage | Direct evidence in Veyra? | Indirect evidence | Status | Key constraint |
|---|---|---|---|---|
| Generated | No persisted per-turn event | Provider/rendering code + `m6-context` rendering tests | **NOT_VERIFIED** per turn | Invocation/completion unknown without Host signal |
| Delivered | No | Provider registration only | **NOT_VERIFIED** | Provider invocation ≠ delivery; DSH admission unknown |
| Used | No | None reliable | **NOT_VERIFIED** | Delivery ≠ use; no attribution |
| Outcome | Yes, explicit per-record feedback | None needed for existence of feedback | **Partially verified (explicit feedback only)** | Feedback ≠ proof specific memory used/caused outcome |

## 4. Gaps (evidence-backed)

1. **No generated-event telemetry:** cannot answer “was recall context generated this turn?” from stored Veyra evidence.
2. **No delivery/admission evidence:** DSH Host admission is external; Veyra cannot prove delivered state.
3. **No use attribution:** cannot prove a memory was referenced/applied by the Agent.
4. **Outcome is disconnected from apply stages:** `veyra_feedback` records per-record outcome but not linkage to generated/delivered/used events for that turn/memory instance.

## 5. Existing capabilities to reuse

- Recall/generation path: `createContextProvider`, `recall`/`hybridRetrieve`, `summarizeForPrompt`/rendering (`src/context.mjs`, `src/retrieve.mjs`).
- Integration point: `src/plugin.mjs` `systemPrompt.context` registration.
- Outcome path: `recordFeedback` and `source.feedback` (`src/feedback.mjs`).
- Observability patterns: bounded/meta/health patterns from P3 area (`src/learn.mjs` ledger style, `src/health.mjs`) — only if a minimal non-duplicative event model is later approved.
- Existing rendering tests: `test/m6-context.test.mjs`.

## 6. Conclusion

P1’s core PRD separation (generated/delivered/used/outcome) is **not currently evidenced as distinct verifiable stages** in Veyra. Only explicit per-record outcome feedback is directly recorded; generation is code-capable but not per-turn evidenced; delivery and use are **NOT_VERIFIED** from Veyra/inspected DSH integration. Any improvement PRD must avoid inventing Host capabilities, label unknown states `NOT_VERIFIED`, and keep scope minimal.
