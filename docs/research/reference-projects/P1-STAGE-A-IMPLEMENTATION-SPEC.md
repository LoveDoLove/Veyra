# P1 Stage A Implementation Specification — Generation Evidence (Final, Implementation-Ready)

**Status:** Final specification for CEO implementation authorization (Stage A only). **No implementation authorized by this document.**  
**Date (source context):** 2026-11-07 (Asia/Singapore)  
**Scope:** Veyra-local, metadata-only evidence for recall context **generation** (`generated`, `generated_empty`, `generation_error`), with mandatory `NOT_VERIFIED` labeling for **delivery** and **used**. Explicit-only outcome linkage. No DSH Host API invention, no prompt interception, no automatic attribution.

## 1. Evidence baseline (reuse, do not replace)

| Capability | Current implementation | Reuse rule |
|---|---|---|
| Recall generation | `src/context.mjs`: `createContextProvider`, query resolution/rendering; `src/retrieve.mjs`: `recall`/`hybridRetrieve`/`summarizeForPrompt` | Instrument generation completion points; do not change ranking/render semantics. |
| DSH integration | `src/plugin.mjs`: `systemPrompt.context` provider `veyra:recall` (order 200) + guidance section | Registration remains the same. Do not add Host callbacks/interception. |
| Explicit outcome | `src/feedback.mjs`: `recordFeedback` stores per-record success/failure in `source.feedback` | Reuse as outcome source. Optional explicit linkage only; never infer. |
| Rendering tests | `test/m6-context.test.mjs` | Preserve rendering behavior; add additive telemetry tests separately. |
| Bounded observability patterns | P3 meta-ledger style (`store.setMeta`/`getMeta`, bounded, best-effort, read-only health) | Reuse pattern; do not duplicate P3 ledger semantics. |

## 2. Stage A boundaries and truth labels

| Stage | Stage A evidence | Allowed label(s) | Forbidden inference |
|---|---|---|---|
| Generated | Veyra-local completion of generation/render path | `generated`, `generated_empty`, `generation_error` | Does **not** imply DSH admission or model receipt. |
| Delivered | None in Stage A | `NOT_VERIFIED` always | Provider registration/invocation **≠** delivery. No Host APIs assumed. |
| Used | None in Stage A | `NOT_VERIFIED` always | Delivery/feedback **≠** use. No output heuristics. |
| Outcome | Existing explicit `veyra_feedback` per record | `outcome_recorded` / explicit feedback states when recorded | Feedback **≠** proof a specific memory was generated/delivered/used unless explicitly linked by caller. |

Every persisted/read event must carry `delivery.status='NOT_VERIFIED'` and `used.status='NOT_VERIFIED'` in Stage A.

## 3. Generation event lifecycle and boundaries

### 3.1 Lifecycle

1. **Start boundary (logical):** recall provider/generation path begins for a Veyra-local generation attempt. *Optional internal marker only; not required to persist unless cheap.*
2. **Selection boundary:** `recall`/retrieval returns candidate records (possibly empty). Capture bounded metadata: result count, selected record IDs/count.
3. **Render boundary:** context text rendered/composed (possibly empty or truncated by Veyra budgets). Capture rendered char count and empty flag.
4. **Completion boundary (persist):** on successful completion, persist one bounded `generation` event with status `generated` or `generated_empty`. On caught error in the generation path (if instrumented without altering caller-visible behavior), persist `generation_error` with safe error class only. Persistence is best-effort.
5. **Read boundary:** health/diagnostic read surfaces report bounded events/states; no mutation.

### 3.2 Event boundary rules

- **One event per Veyra-local generation completion** (not per retrieved record). If multiple recall passes occur in one provider invocation, define a deterministic rule: either one aggregated event per invocation or one per pass with a shared `invocationId`; spec chooses **one event per provider invocation completion** for minimal volume unless implementation evidence shows a need to split.
- **Empty is not error:** zero selected records or zero rendered chars after valid execution => `generated_empty`.
- **Error classification:** `generation_error` uses bounded class codes (`query_resolution`, `retrieval`, `render`, `storage_read`, `unknown`) and never raw error messages/stacks/prompts.
- **No prompt interception:** do not capture assembled Host prompt, model messages, or DSH internals. Only Veyra-local inputs/outputs already available inside Veyra modules.

## 4. Safe per-turn correlation and memory-reference metadata

- **`eventId`:** bounded store-local id (e.g. `vge_<scope>_<seq>`), unique within retention window.
- **`at`:** ISO8601 timestamp.
- **`scope`:** `project|reusable|mixed|unknown` based on stores queried/results.
- **Per-turn correlation (safe):** Stage A has **no verified Host turn ID**. Allowed correlation fields: `queryHash` (optional non-reversible hash of normalized query text; use existing normalization; do not store raw query), `queryClass` (optional bounded enum such as `claimed_prompt|task_intent|change_signal|empty|unknown` if derivable without raw text), `sessionHint` **only if** Veyra already has a safe non-sensitive internal session/runtime handle available in that code path and privacy review approves; default omit. Never store Host conversation IDs, user IDs, or raw prompts.
- **Memory references:** `resultCount`, bounded `recordRefs` array of record IDs (max 16; if more, store first N by Veyra’s existing order plus `recordRefsTruncated:true` and `totalResultCount`). IDs are internal handles; project-isolated.
- **Output metadata:** `renderedChars` (integer), `charBudget` (if known), `empty` boolean.

## 5. Minimal data/event schemas

### 5.1 Generation event (`veyra_apply_generation_v1` companion/meta key)

```json
{
  "v": 1,
  "updatedAt": "2026-11-07T09:30:00.000Z",
  "nextSeq": 7,
  "entries": [
    {
      "eventId": "vge_p_000007",
      "at": "2026-11-07T09:29:58.000Z",
      "kind": "veyra.apply.generation",
      "source": "veyra.context.createContextProvider",
      "scope": "project",
      "status": "generated",
      "queryHash": "<optional non-reversible hash>",
      "queryClass": "claimed_prompt",
      "resultCount": 3,
      "recordRefs": ["vey_a", "vey_b", "vey_c"],
      "recordRefsTruncated": false,
      "renderedChars": 1240,
      "charBudget": 4000,
      "delivery": {
        "status": "NOT_VERIFIED",
        "source": "stage-a-local",
        "detail": "no supported DSH admission evidence"
      },
      "used": {
        "status": "NOT_VERIFIED",
        "source": "stage-a-local",
        "detail": "no supported attribution evidence"
      }
    }
  ]
}
```

**Status enum:** `generated | generated_empty | generation_error`.

**Error variant (minimal):**
```json
{
  "status": "generation_error",
  "errorClass": "retrieval",
  "resultCount": 0,
  "recordRefs": [],
  "renderedChars": 0,
  "delivery": {"status": "NOT_VERIFIED", "source": "stage-a-local", "detail": "generation failed locally"},
  "used": {"status": "NOT_VERIFIED", "source": "stage-a-local", "detail": "no supported attribution evidence"}
}
```

### 5.2 Explicit outcome linkage (optional, caller-supplied only)

Stored either as bounded companion metadata (`veyra_apply_outcome_link_v1`) or as an additive explicit field on feedback handling — **implementation chooses smallest path that does not alter existing `source.feedback` semantics**.

```json
{
  "v": 1,
  "updatedAt": "2026-11-07T09:31:00.000Z",
  "entries": [
    {
      "linkId": "vol_p_000001",
      "at": "2026-11-07T09:31:00.000Z",
      "kind": "veyra.apply.outcome_link",
      "recordId": "vey_b",
      "outcome": "success",
      "generationEventId": "vge_p_000007",
      "attribution": "explicit_linked",
      "notePresent": false
    }
  ]
}
```

Rules:
- `generationEventId` accepted only when explicitly passed by caller/tool; validate format/bounds; unknown IDs may be stored as explicit but unresolvable metadata or rejected safely (deterministic choice documented in implementation).
- `attribution` enum: `explicit_linked | explicit_unlinked`. Default for normal feedback with no linkage: no link event required, or `explicit_unlinked` only if explicitly represented.
- Never infer from text, timing, or co-occurrence.

## 6. Bounded storage and privacy/redaction requirements

| Parameter | Default | Hard cap / behavior |
|---|---|---|
| Generation entries per store | 64 | Max 128; oldest evicted first |
| `recordRefs` per event | <=16 | truncate with `recordRefsTruncated` |
| `queryHash` | optional | non-reversible; omit raw query |
| Error detail | class code only | no message/stack/prompt/content |
| Outcome link entries per store | 64 | Max 128 |
| Serialized blob | <=32 KiB per key | evict oldest until under cap |
| Storage | existing meta KV, per project/reusable store | no new DB schema required by default |
| Writes | best-effort, never throws into recall/feedback path | telemetry failure must not change recall result, rendering, or feedback outcome |
| Reads | tolerant | corrupt/missing => empty safe structure |
| Redaction | no raw sensitive content | do not bypass `src/redact.mjs` posture; telemetry stores metadata only |

## 7. Module-level change scope

| Module | Change | Rationale |
|---|---|---|
| `src/context.mjs` | Instrument `createContextProvider` completion/error boundaries to emit bounded generation metadata; preserve returned text/behavior. | Primary Veyra-local generation boundary. |
| `src/retrieve.mjs` | Optional minimal: expose safe counts/selected IDs already produced, or accept callback/hook only if needed; avoid changing retrieval semantics. | Supply memory-reference metadata. |
| `src/plugin.mjs` | **No Host API additions.** Wiring only if a runtime/store handle must be passed for best-effort persistence. | No prompt interception, no invented callbacks. |
| `src/feedback.mjs` | Accept optional explicit linkage metadata parameter/path **only if caller supplies it**; preserve existing feedback behavior and `source.feedback` writes. | Explicit outcome linkage without inference. |
| `src/tools.mjs` | Optional minimal: allow feedback/diagnostic tools to pass/read explicit linkage or generation summaries; no automatic linkage. | Tool-surface reuse. |
| `src/store.mjs` / meta conventions | Reuse existing meta KV; add key constants/helpers only as needed. No schema migration. | Bounded storage. |
| `src/health.mjs` or existing read-only diagnostic path | Add additive Stage A summary: generation counts by status, recent bounded events, delivery/used always `NOT_VERIFIED`. Read-only. | Observability surface. |
| `test/m6-context.test.mjs` | Regression only (or additive assertions proving no behavior change where practical). | Protect rendering. |
| New focused tests (e.g. `test/apply-generation-evidence.test.mjs`, feedback-link tests per convention) | Deterministic Stage A behavior. | Verification. |

## 8. Deterministic test plan

| ID | Type | Setup | Action | Expected |
|---|---|---|---|---|
| P1-T1 | Unit | Provider returns records and rendered text | Complete generation | Event status `generated`; counts/recordRefs/renderedChars set; `delivery.status=NOT_VERIFIED`; `used.status=NOT_VERIFIED`; no raw query/content. |
| P1-T2 | Unit | Query resolves but retrieval returns zero / render empty | Complete generation | Status `generated_empty`; `resultCount=0` or `empty=true` as defined. |
| P1-T3 | Unit | Inject/cause safe local generation failure path | Complete/error handling | Status `generation_error` with bounded `errorClass`; no raw message/stack; caller-visible behavior unchanged where contract requires. |
| P1-T4 | Bounds | >16 records, >max events | Persist/read | `recordRefs` truncated deterministically with flag/count; events evicted oldest-first; size cap respected. |
| P1-T5 | Privacy | Sensitive-looking query/content fixtures | Generate | Serialized events contain no raw query, no rendered memory text, no prompts, no secrets. |
| P1-T6 | Isolation | Project/reusable stores | Generate in scopes | Events isolated per store/scope. |
| P1-T7 | Failure injection | meta `setMeta` throws | Generate/feedback | Recall/feedback result unchanged; no throw escapes. |
| P1-T8 | Outcome linkage explicit | Call feedback with explicit `generationEventId` | Record feedback | Link entry `explicit_linked` stored only when supplied; existing `source.feedback` behavior unchanged. |
| P1-T9 | Outcome linkage absent | Normal feedback call | Record feedback | No inferred link; feedback still recorded normally. |
| P1-T10 | State integrity | Any Stage A path | Inspect all events | No path sets `delivery.status` or `used.status` to verified/admitted/used; always `NOT_VERIFIED`. |
| P1-T11 | Read surface | Populated events | Health/diagnostic read | Additive summary shows generation states and explicit `NOT_VERIFIED` for delivery/used; read-only. |
| P1-T12 | Regression | `test/m6-context.test.mjs` cases | Run relevant tests | Rendering/composition behavior unchanged. |

Deterministic only: fixed clocks/injectable time where practical, temp stores, no network/API/DSH runtime experiments.

## 9. Acceptance criteria

1. Stage A records bounded Veyra-local generation evidence with status `generated`, `generated_empty`, or `generation_error`.
2. Every generation/read model explicitly labels `delivery` and `used` as `NOT_VERIFIED` in Stage A.
3. No code infers delivery from provider registration/invocation, no code infers use from delivery/output/feedback, and no code infers memory causality from feedback.
4. Outcome linkage exists only when explicitly supplied by the caller; normal feedback remains valid without linkage.
5. No raw prompts, recalled/rendered content, user/model messages, secrets, or Host internals are stored; no prompt interception is introduced.
6. Telemetry is bounded, best-effort, per-store isolated, and does not alter recall/feedback behavior.
7. No DSH Host APIs/callbacks are invented or required for Stage A.

## 10. Non-goals

- Proving DSH prompt admission, model receipt, or Agent use (Stage B, Host-dependent, gated separately).
- Heuristic attribution, citation scraping, or output-based “used memory” detection.
- Causal scoring from outcomes to memories.
- Prompt interception, model middleware, or Host runtime changes.
- Replacing/rewriting `veyra_feedback` semantics.
- External telemetry, benchmarks, or runtime experiments.

## 11. Migration and compatibility considerations

- **Backward compatible:** missing generation/link keys => empty/unknown-safe reads; `delivered/used` reported `NOT_VERIFIED`.
- **Forward compatible:** readers ignore unknown fields; version key `v=1` allows future evolution.
- **No DB schema migration required** if using existing meta KV. Table-based storage would require separate review (not proposed).
- **Volume control:** one event per provider invocation completion + ring cap keeps growth bounded; can add sampling later only if evidence shows volume issues (not in Stage A).
- **Stage B gate:** delivered/used may move beyond `NOT_VERIFIED` only after documented, supported DSH evidence exists and a separate approved spec/implementation is authorized. Stage A code must make that gate explicit.
- **Rollback:** disabling Stage A emission/reads leaves recall and feedback functional; no migration needed.
