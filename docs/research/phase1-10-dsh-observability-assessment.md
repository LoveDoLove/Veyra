# Phase 1.10 — Existing DSH Observability Assessment

**Date:** 2026-11-07 (Asia/Singapore context)  
**Repository:** `/home/lovedolove/projects/Veyra` (read-only inspection; no Veyra/DSH source, dependency, test, config, runtime, profile, or DB changes)  
**Objective:** Determine whether existing DSH runtime capabilities can provide reliable evidence that Veyra recall context is present in the final request immediately before model streaming, without modifying DSH or Veyra.  
**Prior evidence (not repeated):** [phase1-8-harness-proof-of-feasibility.md](phase1-8-harness-proof-of-feasibility.md) (`HARNESS_FEASIBLE`, contract-level, non-model, metadata-only), [phase1-9-isolated-runtime-verification.md](phase1-9-isolated-runtime-verification.md) (`PARTIALLY_VERIFIED`, isolated runtime, `preparedCall.stream` interception with request identity/fail-open/treatment-baseline separation). Phase 1.8/1.9 do not prove full live `AgentLoop` post-mutation delivery in all real pre-step/request/session mutations, model receipt, or agent application.

## 1. Executive Summary

Installed DSH `@deepseek-ai/dsh` **0.2.2-rc.1** (Node v24.22.2 install path) exposes several hooks/waterfalls relevant to request construction (`system-prompt/assemble`, `agent/pre-step`, deprecated `agent/request`, `agent/request-error`, `llm/stream`) and request identity helpers (`markAgentLoopRequest` / `isAgentLoopRequest`). However, **no inspected existing, supported/public agent-loop or LLM hook receives the exact frozen `markAgentLoopRequest` object after `buildRequest` and immediately before the final stream dispatch** for the preferred path.

The actual agent-loop stream boundary is:

```js
// @deepseek-ai/dsh-agent-loop/lib/index.js:877
const stream = preparedCall?.stream(request) ?? this.loopCtx.llm.stream(request);
```

The frozen request is built immediately before this at `:868`/`:1078`/`:1084-1085` (`session.deriveMessages()`, deep-freeze, `markAgentLoopRequest(Object.freeze(...))`). `agent/request` (`:994`) runs earlier, during `prepareRequest` (`:842`/`:1005`) and before `buildRequest`, final message derivation/freeze, and stream dispatch; agent type contracts also state it cannot mutate messages and runs before system prompt/accepted user batch commit in the loop flow. `agent/pre-step` (`:685`) is earlier still and observes/replaces proposed messages entering the step, not the final frozen stream request.

`dsh-llm`’s `llm/stream` waterfall (`@deepseek-ai/dsh-llm/lib/types/index.d.ts:45`, `lib/index.js:2402`) receives `options` and can wrap/observe streaming inside `LlmRuntime.stream()`. **It is bypassed when the agent-loop uses `preparedCall.stream(request)`** (the preferred branch at `:877`). Therefore `llm/stream` alone cannot provide complete pre-stream observation for the actual agent-loop path. Headless NDJSON (`dsh-headless`) projects committed session events and contains no request payload/admission/model-receipt proof.

**Distinctions (non-negotiable):** context assembled ≠ final request contains context; final pre-stream presence ≠ model receipt; model receipt ≠ Agent application; Agent application ≠ engineering improvement.

## 2. Investigation Scope and Environment/Version

| Item | Value / evidence |
|---|---|
| Scope | Read-only inspection of installed DSH runtime public/internal observability surfaces: AgentLoop lifecycle/mutations, `agent/pre-step`, request preparation/reconciliation/session mutations, `prepareCall`/`preparedCall.stream`/`ctx.llm.stream`, hooks/events/callbacks/diagnostics/tracing/metadata, final pre-stream observation feasibility, request identity/correlation/Veyra marker verification without raw prompt persistence. |
| DSH package | `@deepseek-ai/dsh/package.json` → `"version": "0.2.2-rc.1"` at `/home/lovedolove/.local/share/mise/installs/node/24.22.2/lib/node_modules/@deepseek-ai/dsh/` |
| Agent loop | `@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-agent-loop/lib/index.js`, `lib/types/index.d.ts`, README.i18n/zh |
| Agent contracts | `@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-agent/lib/types/runtime-types.d.ts`, `lib/index.js` |
| LLM runtime | `@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-llm/lib/index.js`, `lib/types/index.d.ts`, `lib/typert.host.js` |
| System prompt | `@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-system-prompt/lib/index.js` |
| Session | `@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-session/lib/index.js` |
| Headless | `@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-headless/lib/index.js`, `lib/json-stream-Dc3g2Bl1.js`, `lib/types/json-stream.d.ts` |
| Prior reports | Phase 1.8/1.9 in `docs/research/` (read-only) |
| Out of scope / not done | DSH/Veyra modifications; existing DSH Web/profile/authoritative runtime DB access; credentials/tokens/secrets; model/API calls/real Agent tasks; raw prompt/source/message persistence; Git staging/commits/pushes/tags/releases. Existing modified/untracked Veyra files preserved. |

## 3. Request Lifecycle and Mutation Sequence

Evidence from `dsh-agent-loop/lib/index.js` (installed 0.2.2-rc.1; line numbers from installed bundle):

1. **Pre-step assembly/input decision** (`:666-713`, `:685`): `preStep` resolves tool set (`:673-677`), assembles system prompt (`:679-683`), runs `dispatch.waterfall("agent/pre-step", ...)` (`:685-697`). Default decision projects runtime context sections (`renderContextSections`/`runtimeContext.project`, `:691-696`) and returns `enter` with claimed messages plus runtime context. `agent/pre-step` can reject or replace messages (type contract `dsh-agent/lib/types/runtime-types.d.ts:332`).
2. **Step request preparation** (`:833-842`, `:986-1016`): `step` renders prompt (`:839`) and calls `prepareRequest` (`:842`). `prepareRequest` seeds config from selection/controls (`:988-993`), runs `dispatch.waterfall("agent/request", ...)` (`:994-998`, deprecated), enforces provider/model/reasoningEffort unchanged (`:1000-1001`), calls `llm.prepareCall(proposedConfig, signal)` (`:1005`), returns `{config, preparedCall}` (`:1012-1015`).
3. **Runtime context refresh and prompt/session commits** (`:843-867`): refreshes system-prompt runtime contexts (`systemPrompt.refreshContext`, `:843-846`), projects runtime context (`:847`), computes prompt commits (`:850-853`, considers `preparedCall.systemPromptUpdate`, request-series/tool changes), appends system messages (`:854-858`), admits user/runtime-context messages for first attempt (`:860-866`).
4. **Final request construction** (`:868-871`, `:1018-1093`): `buildRequest` (`:868`) canonicalizes header (`:1021-1025`), appends request/header/context events as needed (`:1029-1075`), reads `session.deriveMessages()` (`:1078`), deep-freezes derived messages not already frozen (`:1079-1083`), freezes boundary array (`:1084`), returns `markAgentLoopRequest(Object.freeze({...header.config, messages: boundaryMessages, toolHistory, tools?, sessionId, signal}))` (`:1085-1092`).
5. **Stream dispatch (final boundary)** (`:872-877`): creates assistant-stream attempt (`:872-874`) and dispatches `const stream = preparedCall?.stream(request) ?? this.loopCtx.llm.stream(request);` (`:877`). This is the nearest evidenced pre-provider stream boundary in agent-loop.
6. **Post-dispatch/error** (`:878-934`): consumes stream, appends assistant/attempt records; on request failure may consult `dispatch.waterfall("agent/request-error", ...)` (`:929-934`) using `preparedCall?.retryPolicy`.

**Mutation implication:** mutations/commits can occur after `agent/request` and before `:877` (runtime context refresh `:843`, prompt projection/commits `:850-858`, user/runtime-context admission `:860-866`, header/context/session request events `:1029-1075`, final `deriveMessages` + freeze `:1078-1085`). Therefore hooks before `buildRequest` cannot, by themselves, prove final pre-stream presence.

## 4. Evidence-Backed Findings (Required Questions)

### Q1. Can existing DSH hooks observe all request mutations before streaming?

**No, not as a complete/supported final-boundary observation.**

- `agent/pre-step` (`dsh-agent-loop/lib/index.js:685`; `dsh-agent/lib/types/runtime-types.d.ts:332`) runs before request preparation/final construction and sees proposed step messages, not the frozen stream request.
- `agent/request` (`dsh-agent-loop/lib/index.js:994`; `dsh-agent/lib/types/runtime-types.d.ts:362`) is deprecated, replaces call-config controls only, must preserve provider/model/reasoningEffort, and cannot mutate messages; it runs during `prepareRequest` before `buildRequest` and stream dispatch.
- After `agent/request`/`prepareCall`, the loop still refreshes runtime context, commits prompt/system/user/runtime-context messages, reconciles tool/request headers, derives session messages, freezes, marks, and dispatches (`:843-877`, `:1018-1093`).
- No inspected hook receives the request after `:1085` and before/at `:877` except method interception of `preparedCall.stream` / `ctx.llm.stream` or LLM-internal `llm/stream` behavior (see Q2).

### Q2. Can an existing callback inspect the exact request passed to the final stream boundary?

**Partially, but not completely/safely as a supported agent-loop admission contract.**

- **Agent-loop boundary:** exact request object is passed at `:877` as `request` to `preparedCall?.stream(request)` or `this.loopCtx.llm.stream(request)`. No Cordis event/waterfall is emitted at that point in inspected agent-loop code.
- **`llm/stream` waterfall (existing):** `dsh-llm/lib/types/index.d.ts:45` declares `Events['llm/stream']` waterfall `(options: GenerateOptions, next) => AsyncIterable<StreamChunk>`; `dsh-llm/lib/index.js:2402` executes `this.ctx.waterfall(this, "llm/stream", options, () => this.adapterStream(options, prepared))` from `LlmRuntime.stream()` (`:2396-2402`). This can observe `options` inside `ctx.llm.stream()`.
- **Critical gap:** when agent-loop takes the preferred branch, it calls `preparedCall?.stream(request)` (`:877`) and does **not** call `ctx.llm.stream(request)`. Therefore `llm/stream` cannot observe requests dispatched through `preparedCall.stream`. Phase 1.8/1.9 addressed this by wrapping both `preparedCall.stream` and/or the prepared-call path; that is harness/service interception, not a native admission hook.
- **Request identity:** `markAgentLoopRequest`/`isAgentLoopRequest`/`AGENT_LOOP_REQUESTS` exist (`dsh-llm/lib/index.js:358,377,384,386,2434`; agent-loop applies marker at `:1085`). Typert host docs (`dsh-llm/lib/typert.host.js:733-742`, nearby 252/256/257/388) state LOOP-built requests carry marker, arrive deep-frozen, and `llm/stream` receives full request; this supports marker-based identification where `llm/stream`/wrapped stream is reached, but it is not an admission artifact/event.

### Q3. Can the observation distinguish context assembly from final pre-stream presence?

**Only with careful boundary selection; existing agent hooks alone cannot.**

- **Assembly:** `system-prompt/assemble` waterfall (`dsh-system-prompt/lib/index.js:401`, `renderPrompt` `:119`) and Veyra’s registered context (`veyra:recall`, order 200, prior Phase 1 evidence) occur in system-prompt assembly/rendering. This proves assembly/candidate context, not final stream admission.
- **Pre-step/request hooks:** `agent/pre-step`/`agent/request` occur before final freeze/stream and/or cannot observe post-request mutations/messages; they cannot prove final pre-stream presence.
- **Final boundary candidate:** interception at `preparedCall.stream` and `ctx.llm.stream` (harness) can observe the request object passed to stream dispatch. `llm/stream` can observe only when `ctx.llm.stream` path executes. None of these proves model receipt.
- **Conclusion:** distinguishing assembly from final pre-stream presence requires observing at/inside the final stream dispatch path (both branches). Existing high-level hooks do not provide that complete distinction.

### Q4. Can Treatment and Baseline be distinguished without modifying DSH?

**Yes, in isolated in-process harness conditions with metadata-only evidence; not as a DSH-native admission feature.**

- Phase 1.9 (prior, non-model, isolated) proved treatment `recallLimit=3` vs baseline `recallLimit=0` separation with `preparedCall.stream` interception, metadata-only hashes/marker booleans, request identity preserved, no raw prompt persistence.
- Veyra rendered recall content is distinguishable by predeclared markers (e.g., `Veyra recalled engineering memory`; `vey_<id>` refs in rendered block, per Veyra context behavior/prior reports) when present in the observed request content/shape. Evidence should use predeclared marker presence/hash/counts, not raw prompt retention.
- This distinction does **not** prove final live `AgentLoop` post-mutation behavior in every real turn, model receipt, agent application, or engineering improvement.

### Q5. Can request identity and correlation be preserved?

**Partially.**

- `markAgentLoopRequest`/`isAgentLoopRequest` provide process-local LOOP request identity (`dsh-llm/lib/index.js:358,377,384,386`; applied `dsh-agent-loop/lib/index.js:1085`). Useful for distinguishing LOOP-built requests in-process.
- Agent-loop request includes `sessionId` (`:1090-1091`) and is created with `signal`; turn/step are available in loop scope but the frozen request envelope itself (as built at `:1085-1092`) does not explicitly carry turn/step/correlation IDs in the inspected shape. Correlation would need harness-side IDs/hashes derived at observation time (metadata-only), not a native DSH admission artifact.
- `llm/stream`/service interception can attach external correlation metadata, but that is observer-side correlation, not proof of a DSH-native admission record.

### Q6. Are these capabilities documented/supported contracts or implementation details?

**Mixed; the critical boundary is not a supported admission contract.**

- **More contract-like/type-documented:** `agent/pre-step`, `agent/request` (explicitly deprecated/limited), `agent/request-error`, `llm/stream` waterfall signatures in `dsh-agent`/`dsh-llm` type declarations; `LlmRuntime.stream`/`prepareCall` APIs.
- **Implementation-detail risk:** exact agent-loop mutation ordering/commit sequence, internal `buildRequest` shape, `preparedCall.stream` preference over `ctx.llm.stream` at `:877`, `markAgentLoopRequest` WeakSet process-local identity, session `deriveMessages` internals, and absence of admission event are observed in installed bundles/implementation and may change across versions. Typert host comments document frozen/marker behavior but do not create a stable public admission artifact API.
- **Not a supported contract:** “observe exact final request after all mutations immediately before model streaming” via existing hooks/events.

### Q7. What are the compatibility and version risks?

- **Path split risk:** code assuming `ctx.llm.stream` / `llm/stream` observes all agent-loop requests misses `preparedCall.stream` dispatches. Future adapters/prepared calls may change stream routing.
- **Ordering risk:** agent-loop may reorder refresh/commit/derive/build steps; hooks that worked before/after specific mutations can become stale.
- **Request-shape risk:** `GenerateOptions`/request envelope fields, tool history, session/request-context fields, and frozen/marker behavior may evolve.
- **Observability-surface risk:** `llm/stream` remains a waterfall contract, but its sufficiency for agent-loop admission depends on dispatch path. `agent/request` is already deprecated.
- **Version evidence:** findings apply to installed DSH 0.2.2-rc.1; Phase 1.9 requested DSH 0.1.72 but npm/runtime used 0.2.2-rc.1 (prior report) — cross-version claims require re-verification.

## 5. Comparison of Approaches A/B/C

| Approach | What it can prove | What remains unproven / limitations | Verdict |
|---|---|---|---|
| **A. Harness-only interception** (Phase 1.8/1.9 style; wrap `preparedCall.stream` and `ctx.llm.stream` in isolated in-process runtime) | Contract-level and isolated-runtime (partial) observation of request passed to stream dispatch for wrapped paths; metadata-only hash/marker/request identity; treatment/baseline separation; fail-open behavior (as tested). | Not a DSH-native/supported admission API; full live `AgentLoop` post-mutation proof across all real pre-step/request/session mutations not established; no model receipt; no agent application/outcome; brittle to internal dispatch/ordering changes; requires careful isolation and no raw persistence. | **Feasible with limitations** (strongest non-modifying option evidenced). |
| **B. Existing DSH observability** (hooks/waterfalls/events/diagnostics as-is, no DSH modification) | `system-prompt/assemble`/Veyra context show assembly; `agent/pre-step`/`agent/request`/`agent/request-error` show pre-stream lifecycle points; `llm/stream` can observe requests that reach `LlmRuntime.stream()`; `markAgentLoopRequest`/`isAgentLoopRequest` aid in-process identification. | No complete final-boundary hook for `preparedCall.stream` preferred path; `agent/request` too early/cannot see final messages; no dedicated admission artifact/correlation record; headless has no request payload; cannot reliably prove “exact final request after all mutations immediately before streaming” across agent-loop paths. | **Insufficient** for the required final pre-stream admission proof. |
| **C. DSH-side instrumentation** (last resort; not implemented) | Could emit an opt-in, metadata-only admission artifact at/after `buildRequest` freeze and immediately before `:877`, including channel (`preparedCall.stream` vs `ctx.llm.stream`), request hash/marker proof, LOOP marker, session/correlation IDs, and mutation lineage/version metadata; could define a stable contract. | Requires DSH changes/review/release; still cannot prove model receipt, agent application, or engineering improvement; must enforce privacy (no raw prompt/source by default, explicit opt-in, isolated scope, bounded retention, no secret capture). | **Only needed if** a supported/stable, path-complete admission contract is required beyond harness-only limitations. |

## 6. Security and Compatibility Assessment

- **Security:** This assessment performed read-only inspection of installed package source/types only. No existing DSH Web profile, authoritative runtime DB, credentials, tokens, provider secrets, or unrelated user data accessed. No model/API calls or real Agent tasks executed. No raw prompts/source code/message content persisted. Any future observation must remain metadata-only by default (hashes, predeclared marker booleans/counts, IDs, sizes, channel/path, version, pass/fail), with explicit opt-in for any sensitive capture, isolated scope, bounded retention, and no secret capture.
- **Compatibility:** `llm/stream` is the most relevant existing runtime interception surface but is path-incomplete for agent-loop’s `preparedCall.stream` preference. `agent/request` is deprecated and unsuitable for final request observation. Harness interception is implementation-sensitive. A DSH-side artifact would reduce ambiguity but introduces maintenance/API obligations.

## 7. Explicit Unresolved Questions

1. **Full live `AgentLoop` parity:** Does harness interception at `preparedCall.stream`/`ctx.llm.stream` observe the exact request after *all* real pre-step listeners, `agent/request` listeners, runtime-context refreshes, prompt/tool/header reconciliations, session admissions, and `deriveMessages` mutations in production-like turns (including retries, inbox batches, tool registry changes, in-history prompt updates)?
2. **`llm/stream` reachability in real adapters:** In deployed DSH 0.2.2-rc.1 configurations, how often do prepared calls supply `preparedCall.stream` vs falling back to `ctx.llm.stream`, and can `llm/stream` ever observe the prepared-call path?
3. **Model receipt/application:** No inspected observability surface proves provider/model receipt, attention/use of Veyra context, or engineering outcome.
4. **Cross-version stability:** Do DSH 0.1.72-era installs (if obtained) preserve the same `:877` dispatch, `llm/stream` semantics, marker behavior, and mutation ordering?
5. **Correlation schema:** If evidence is collected, what minimal metadata-only schema is acceptable (experiment/run/correlation IDs, hashes, marker proofs, channel, version) without leaking sensitive content?

## 8. Recommendation for the Next Phase

1. **For non-modifying pre-stream evidence:** continue **harness-only interception** (Approach A) with strict metadata-only capture, fail-open behavior, isolated runtime/profile/temp homes, and explicit limitations: wrap **both** `preparedCall.stream` and `ctx.llm.stream`; record channel, `isAgentLoopRequest`, request-shape hash, predeclared marker proofs, session/correlation IDs, DSH/Veyra/Node versions, and effective config. Do not claim model receipt/application/outcome.
2. **If a supported, path-complete admission contract is required:** pursue **DSH-side instrumentation** (Approach C) as a narrowly scoped, opt-in, metadata-only pre-stream admission artifact emitted immediately before `:877` (or an equivalent single dispatch point), reviewed for privacy/compatibility. Do not implement without separate approval.
3. **Do not rely on existing agent hooks alone** (`agent/pre-step`, `agent/request`) or `llm/stream` alone as proof of final pre-stream presence for the preferred `preparedCall.stream` path.

## 9. Verdict

**`HARNESS_ONLY_SUFFICIENT_WITH_LIMITATIONS`**

Existing DSH observability surfaces are insufficient as a complete, supported proof that Veyra recall context is present in the exact final request immediately before model streaming across agent-loop dispatch paths (especially the preferred `preparedCall.stream` path). Harness-only interception (wrapping both `preparedCall.stream` and `ctx.llm.stream`, as in Phase 1.8/1.9) is feasible for limited, metadata-only, non-model pre-stream observation with explicit isolation and fail-open controls, but it remains implementation-sensitive and does not prove model receipt, agent application, or engineering improvement.
