# P1 Product Improvement PRD — Generated / Delivered / Used / Outcome Evidence (Evidence-Backed Gaps Only)

**Status:** Draft for CEO approval. **No implementation authorized.**  
**Depends on:** [P1-CURRENT-STATE-REVIEW.md](./P1-CURRENT-STATE-REVIEW.md)  
**Scope:** Minimal, evidence-backed observability for recall-application stages. This PRD explicitly separates what Veyra can evidence from what depends on DSH Host capabilities.

## 1. Problem statement and evidence

Veyra generates/renders recall context via `src/context.mjs`/`src/retrieve.mjs` and registers a `systemPrompt.context` provider in `src/plugin.mjs`, but no inspected code persists per-turn **generated/delivered/used** evidence. `test/m6-context.test.mjs` validates rendering behavior, not DSH admission or Agent use. `src/feedback.mjs` records explicit per-record outcomes, but feedback is not automatic proof that a particular memory was generated, delivered, or used. The gap is the inability to make **separately evidenced** claims for generated/delivered/used/outcome states.

**Hard constraints:** provider invocation ≠ delivery; delivery ≠ use; feedback ≠ automatic proof of specific memory use. Missing evidence must remain `NOT_VERIFIED`. Do not invent DSH Host capabilities or rely on unsupported APIs.

## 2. Existing capabilities to reuse

- Generation/rendering: `createContextProvider`, query resolution, `recall`/`hybridRetrieve`, `summarizeForPrompt`/rendering.
- DSH integration point: `systemPrompt.context` registration (`src/plugin.mjs`).
- Outcome feedback: `recordFeedback` / `source.feedback` (`src/feedback.mjs`).
- Bounded observability/health patterns: existing meta-ledger and health-surfacing style from write-gate observability (reuse patterns only where non-duplicative).
- Tests: `test/m6-context.test.mjs` for rendering invariants; feedback/write-gate test patterns for bounded metadata.

## 3. Exact proposed scope (minimal, staged by evidence availability)

### Stage A — Veyra-local evidence only (implementable without invented Host APIs)

1. **Generated (Veyra-local):** when Veyra’s recall provider/generation path completes, record a bounded metadata event: timestamp, scope/project, query-hash or query-class (not raw query text by default), result count, rendered-char count/empty flag, selected record IDs/count (bounded), and status `generated` or `generated_empty` or `generation_error` (metadata only). This proves *Veyra generated output*, not Host admission.
2. **Outcome linkage (explicit only):** when `veyra_feedback` records an outcome, allow optional bounded linkage metadata **only when explicitly supplied by the caller/tool path** (e.g. generation event id / record id already known). Never infer linkage. Unlinked feedback remains valid.
3. **State vocabulary:** persist/report states as `generated`, `generated_empty`, `generation_error`, `delivered=NOT_VERIFIED`, `used=NOT_VERIFIED`, `outcome_recorded` (explicit feedback) with clear separation. No code path may set `delivered` or `used` to verified without direct Host evidence.

### Stage B — Host-dependent evidence (only if DSH exposes supported APIs/callbacks)

4. **Delivered (Host-confirmed):** only if DSH provides a supported, documented callback/event/result indicating context admission/truncation/omission, record bounded delivery metadata (`delivered`, `delivered_truncated`, `not_admitted`, or `NOT_VERIFIED`) referencing the generation event. If no such API exists, remain `NOT_VERIFIED`.
5. **Used (Host/model-confirmed):** only if DSH/model tooling provides supported attribution evidence (e.g. explicit citation/tooling signal). Otherwise remain `NOT_VERIFIED`. No heuristic “looks used” classification in scope.

### Out of scope

- Inventing DSH Host callbacks, prompt-assembly hooks, token-admission APIs, or model-citation APIs.
- Treating provider registration/invocation as delivery.
- Treating delivery as use.
- Treating feedback as automatic proof of memory use or causal outcome.
- Storing raw prompts, raw model context, raw user text, or secrets in telemetry.
- Automatic causal attribution from outcomes to memories.
- DSH Web/Profile/runtime changes, benchmarks, runtime experiments.

## 4. Data/event model (proposed, minimal)

*Illustrative; final fields subject to privacy review and existing storage conventions.*

```json
{
  "kind": "veyra.apply.generation",
  "id": "<bounded id>",
  "at": "<iso8601>",
  "scope": "project|reusable|mixed",
  "status": "generated|generated_empty|generation_error",
  "queryHash": "<optional non-reversible hash>",
  "resultCount": 0,
  "recordIds": ["<bounded ids>"],
  "renderedChars": 0,
  "delivery": {"status": "NOT_VERIFIED", "source": "veyra-local", "detail": "no supported DSH admission evidence"},
  "used": {"status": "NOT_VERIFIED", "source": "veyra-local", "detail": "no supported attribution evidence"}
}
```

Optional explicit outcome linkage (separate record/field), only when caller supplies it:
```json
{
  "kind": "veyra.apply.outcome_link",
  "at": "<iso8601>",
  "recordId": "vey_...",
  "outcome": "success|failure|unknown",
  "generationEventId": "<optional explicit>",
  "attribution": "explicit_unlinked|explicit_linked",
  "notePresent": true
}
```

**Bounds:** ring buffer/max entries/field sizes; no raw content.

## 5. Privacy and security constraints

- No raw prompts, user messages, recalled content, model responses, or secrets.
- Record IDs/hashes/counts/classes only where needed; query hashing must be non-reversible/salted if used.
- Respect redaction boundaries and project isolation.
- Bounded retention and best-effort writes; observability must not break recall/feedback.
- Host-provided delivery/use data (if ever available) stored as minimal metadata only.

## 6. Affected modules (if implemented later)

| Module | Stage | Expected change type | Notes |
|---|---|---|---|
| `src/context.mjs` / `src/retrieve.mjs` | A | Small metadata emission | Emit generation event at Veyra-local completion points; no behavior change to ranking/rendering. |
| `src/plugin.mjs` | A/B | Wiring only if needed | Register no new Host assumptions; only consume supported Host evidence if later documented. |
| `src/feedback.mjs` / `src/tools.mjs` | A | Optional explicit linkage | Accept optional explicit generation linkage; do not infer. |
| `src/store.mjs` meta/helpers or narrow companion storage | A | Small bounded storage | Reuse meta/bounded patterns; avoid schema sprawl. |
| `src/health.mjs` or read-only tool/observatory | A | Read-only surfacing | Report counts/states including `NOT_VERIFIED` clearly. |
| Tests (`m6-context`, feedback tests, new focused tests) | A/B | Add/extend | Verify states, no raw content, `NOT_VERIFIED` defaults, non-inference, Host-evidence gating. |

## 7. Test and verification strategy (for future implementation)

- Unit tests: generation event bounds, `generated/generated_empty/generation_error`, no raw content, per-project isolation.
- State tests: `delivered`/`used` default and remain `NOT_VERIFIED` without supported Host evidence; no path sets verified from invocation/feedback alone.
- Feedback linkage tests: explicit linkage stored only when provided; unlinked feedback unchanged; no automatic attribution.
- Failure-injection: telemetry write failures do not alter recall results or feedback outcomes.
- Rendering regression: `test/m6-context.test.mjs` behavior unchanged.
- Host-dependent tests (Stage B, only if APIs exist): mock documented Host callbacks; verify bounded admission/attribution mapping.

## 8. Acceptance criteria

1. Veyra can report bounded, metadata-only **generated** evidence for local recall generation events, distinct from delivery/use.
2. `delivered` and `used` are reported as `NOT_VERIFIED` unless/until supported direct Host evidence exists; no invented APIs.
3. Explicit feedback outcomes can be reported and optionally linked only by explicit caller-supplied linkage; no automatic causal attribution.
4. Generated/delivered/used/outcome states are represented separately in any read/report surface.
5. No raw prompts/content/secrets are stored; project isolation and best-effort behavior preserved.

## 9. Rollout considerations

- Ship Stage A independently of DSH Host changes.
- Stage B requires a documented DSH capability review before implementation; if absent, keep delivered/used `NOT_VERIFIED`.
- Read surfaces must label Veyra-local vs Host-confirmed evidence sources.
- Backward-compatible empty/unknown state handling.

## 10. Explicit non-goals

- Proving model cognition or “true understanding.”
- Heuristic use detection from natural-language output.
- Replacing `veyra_feedback` semantics.
- Building a full observability/telemetry platform.
- Any claim of delivered/used without direct supported evidence.

## 11. Risks and unresolved questions

| Risk / question | Notes |
|---|---|
| DSH Host admission evidence availability | **Unresolved/critical for Stage B.** Must be confirmed from supported DSH APIs/docs before any delivered implementation. |
| DSH attribution evidence availability | **Unresolved/critical for used stage.** Likely unavailable; default remains `NOT_VERIFIED`. |
| Generation event volume/noise | Provider may run frequently; needs strict bounds/sampling policy decision. |
| Query hashing privacy | Raw query text may be sensitive; prefer non-reversible hash or coarse class. |
| Record ID exposure in telemetry | IDs are internal handles; acceptable if bounded and project-isolated, but confirm policy. |
| User-facing interpretation | Surfaces must avoid implying delivery/use from generation/feedback. |

## 12. Recommendation

**Stage A is ready for CEO approval as a narrowly scoped PRD** (Veyra-local generated evidence + explicit outcome linkage + mandatory `NOT_VERIFIED` for delivered/used). **Stage B is not implementation-ready** until supported DSH Host evidence APIs are verified; it should remain a gated follow-up with explicit “no invented APIs” acceptance criteria.
