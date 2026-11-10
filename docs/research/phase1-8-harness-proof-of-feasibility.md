# Phase 1.8 — Harness-Only Proof of Feasibility

**Date:** 2026-11-07  
**Scope:** read-only investigation of installed DSH runtime/test composition patterns + minimal disposable non-model harness prototype outside the Veyra source tree. No DSH source/package modifications. No existing DSH Web/profile changes or restarts. No authoritative runtime database access. No model/API calls or real Agent task execution. No Veyra source/dependency/test/config changes. All existing modified and untracked Veyra files preserved. No Git staging/commits/pushes/tags/releases.

**Objective:** prove whether an isolated in-process Harness can observe the final DSH `stream(request)` boundary without modifying DSH.

**Hard limits:** request presence is not model receipt and not agent application. This report distinguishes **actual runtime/package evidence** from **simulated/stub harness behavior**.

---

## 1. Harness architecture and interception point

### 1.1 Inspected DSH/runtime evidence (actual)

| Evidence | Source (installed DSH, inspected) | Relevance |
|---|---|---|
| Agent-loop resolves stream as `preparedCall?.stream(request) ?? this.loopCtx.llm.stream(request)` at the step’s request-send boundary | `/home/lovedolove/.local/share/mise/installs/node/24.22.2/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-agent-loop/lib/index.js:877` | The harness must observe **both** paths to cover the real boundary: the prepared-call stream (preferred when present) and the direct `llm.stream` fallback. |
| Agent-loop obtains a prepared call via `await this.loopCtx.llm.prepareCall(proposedConfig, signal)` | same, `:1005` | Wrapping `prepareCall` is required to intercept `preparedCall.stream(request)`. Wrapping only `llm.stream` is insufficient when `preparedCall.stream` is used. |
| `markAgentLoopRequest` freezes request objects | `@deepseek-ai/dsh-llm/lib/index.js:377,386,2434` and agent-loop build path `:1085` area (inspected) | Request objects passed to stream are DSH-prepared/frozen requests; pass-through must preserve identity/behavior. |
| Cordis-style in-process composition is used in Veyra runtime tests | `test/dsh-runtime.test.mjs:24,35-37,70,89,100-119,220-226` (`mkdtempSync`, `Context`, `ctx.provide`, `ctx.plugin` with real DSH host services) | Supports feasibility of isolated in-process harness composition patterns. This report does **not** claim the prototype executed a full DSH agent turn. |
| LLM runtime is Cordis/typert-backed service; stream/prepareCall contract visible in impl | `@deepseek-ai/dsh-llm/lib/index.js` (`prepareCall` ~1749/2225, `stream` ~2398, wrapped prepared dispatch returns `stream: (options) => adapterCall.stream(options)` ~2262) | Confirms the service contract the harness wrapper targets. |

### 1.2 Disposable prototype (simulated/stub, outside Veyra tree)

- **Location (disposable, temp):** `/tmp/veyra-phase1-8-harness-xyHdXQ/harness-proof.mjs`
- **Execution:** `node /tmp/veyra-phase1-8-harness-xyHdXQ/harness-proof.mjs` (no model/API calls)
- **Stub LLM:** deterministic async generator yielding `content-start`, `content-delta`, `content-end`, `finish(kind:'stop')`; **no provider/network/model call**.
- **Harness wrapper:**
  - wraps `llm.stream(request)` by creating a delegating object (`Object.create(llm)`) and recording before `yield* original.stream(...)`;
  - wraps `llm.prepareCall(...)` and, when a prepared call has `stream`, wraps `prepared.stream(request)` the same way;
  - records **delivery channel** (`ctx.llm.stream` or `preparedCall.stream`), **SHA-256 hash** of a stable request-shape serialization, **shape metadata** (message count, serialized shape bytes), **predeclared marker proofs** (boolean presence of supplied marker strings), `hasTools`, and `sessionIdPresent`;
  - **never persists raw prompt/content/secret** (marker strings used in this prototype were predeclared test markers, not secrets; production design must use IDs/hashes of predeclared markers only).
- **Fail-open:** instrumentation exceptions are caught and do not block the original stream unless explicitly configured for test assertion.

### 1.3 Result summary (actual prototype run)

Command/result (non-model):
```text
PASS wraps ctx.llm.stream and observes final request shape without raw persistence
PASS wraps preparedCall.stream path (agent-loop preferred path)
PASS instrumentation failure does not prevent original stream (fail-open)
PASS pass-through preserves request object identity for inspection boundary
PASS Veyra treatment/baseline recallLimit config isolation is representable (non-model)
{ "passed": 5, "failed": 0 }
```

---

## 2. Exact evidence of interception at the final stream boundary

| Question | Evidence type | Finding |
|---|---|---|
| Can an external harness observe the `llm.stream(request)` contract call? | **Simulated** (stub LLM + wrapper) | **Yes.** Wrapper observed request and stub stream completed (`ctx.llm.stream` record, marker proofs, hash/shape recorded). |
| Can it observe the `preparedCall.stream(request)` path used by agent-loop when prepared? | **Simulated** + **actual package evidence** | **Yes at contract level.** Wrapper intercepted `preparedCall.stream`; agent-loop source shows this is the preferred path (`preparedCall?.stream(request) ?? ...`). |
| Is this proven as the *exact final DSH `stream(request)` boundary inside a real full agent turn* (after all DSH pre-step/request mutation/runtime behavior)? | **Not proven** | **No.** Prototype used a stub LLM contract and did not execute a full DSH agent-loop turn with real system-prompt assembly, pre-step waterfalls, request reconciliation, and live service graph. Interception is proven for the **agent-loop’s stream call contract**; full runtime final-boundary proof in an isolated DSH composition remains a **separately authorized runtime preflight**. |
| Can Veyra context be distinguished? | **Simulated** marker proof + **actual Veyra render pattern** (prior evidence) | **Yes, by predeclared markers**. Prototype distinguished `Veyra recalled engineering memory`/`vey_test123` presence and absence without persisting raw content. Real runs must use predeclared record IDs/marker hashes from experiment manifests. |

**Conclusion:** A harness can **intercept the stream contract** that agent-loop uses (`preparedCall.stream` or `llm.stream`) without modifying DSH packages. This is **strong feasibility evidence** for pre-stream observation, but **not equivalent** to a complete, authorized, full-runtime proof of the final post-mutation request in every DSH execution mode.

---

## 3. Pass-through behavior verification

| Check | Evidence type | Result |
|---|---|---|
| Original stream executes after instrumentation | Simulated | **Pass.** Stub stream completed; `finish` chunk observed. |
| Request object identity preserved to downstream stream | Simulated | **Pass.** Wrapped stream passed the same request object reference to the original stream (`seen === req`, including frozen object). |
| Behavior preserved on instrumentation failure | Simulated | **Pass (fail-open).** When recorder threw `instrumentation boom`, wrapped stream still completed with original `finish` chunk. |
| Request mutation/content injection by harness | Simulated | **Not observed.** Wrapper recorded metadata and delegated with original request; no request rewrite performed. (Full runtime should add immutability/assertion checks in authorized preflight.) |

---

## 4. Privacy and failure-safety results

| Control | Evidence type | Result |
|---|---|---|
| No raw prompt/secret persisted | Simulated | **Pass for prototype record shape.** Recorded hash/shape/marker booleans only; assertion confirmed serialized record did not contain raw Veyra recall content. Prototype marker strings were predeclared test values, not secrets. |
| Instrumentation failure safety | Simulated | **Pass (fail-open).** Original stream still executed when recorder failed. |
| Real model/API calls | Actual execution constraint | **Pass.** Stub stream only; no provider/network/model call. |
| DSH/Veyra source or installed DSH changes | Actual | **Pass.** No DSH source/package modifications; no Veyra source/dependency/test/config changes; prototype outside Veyra tree. |
| Existing DSH Web/profile/authoritative DB untouched | Actual | **Pass.** No DSH Web/profile changes/restarts; no authoritative runtime DB access. |

**Residual privacy risk (design):** a real harness with access to request objects can still see raw content in memory. Production/experiment implementation must enforce predeclared marker IDs/hashes, no raw payload export, opt-in, isolated scope, and bounded retention (per Phase 1.7).

---

## 5. Treatment/Baseline isolation feasibility

| Aspect | Evidence type | Finding |
|---|---|---|
| Veyra recall arm configuration is representable (`recallLimit>0` vs `0`) | **Simulated/non-model** | **Feasible at config/module level.** Prototype imported Veyra `src/context.mjs` and represented independent treatment/baseline config objects (`3` vs `0`). |
| Full isolated DSH runtime arm parity (effective settings, fresh sessions, no contamination, identical model/tools/permissions except arm) | **Not proven** | **Unverified in live isolated runtime.** Harness feasibility does not prove DSH profile/config loading, session isolation, or effective runtime parity. Requires separately authorized isolated `DSH_HOME`/`VEYRA_HOME` preflight. |
| Baseline/treatment delivery distinction in stream evidence | **Feasible by design** | If final request observation is captured in authorized full-runtime preflight, marker proofs/hashes can distinguish treatment-present vs baseline-absent Veyra context; still not model receipt/application. |

---

## 6. Known limitations

1. **Not a full DSH agent turn:** prototype did not run `dsh-agent-loop`/`dsh-agent` with real system-prompt assembly, `agent/pre-step`, request reconciliation, runtime-context refresh, or real Cordis service graph.
2. **Stub boundary only:** proves wrapper mechanics and stream-contract interception; real adapters/preparedCall internals may differ by provider path and must be validated in authorized isolated runtime.
3. **Service injection path unproven end-to-end:** the wrapper targets `llm.stream`/`prepareCall` contract; exact safe injection point in a full DSH runtime (service replacement, plugin-provided wrapper, or harness-owned context composition) requires authorized runtime preflight.
4. **No model receipt/use:** cannot prove provider admission, model attention, or agent application.
5. **No authoritative DB/Web interaction:** by design; runtime behavior in those environments is out of scope.
6. **Marker proof policy:** prototype used plain marker strings for test clarity; real evidence artifacts must avoid raw sensitive marker payloads and use predeclared IDs/hashes/canonical marker contracts.

---

## 7. Whether DSH modification can be avoided

**Provisionally yes for harness-based pre-stream observation feasibility, with caveats.**

- **Avoidable now (evidenced):** a disposable external harness can wrap the `llm.prepareCall`/`preparedCall.stream`/`llm.stream` contract used by agent-loop and observe request metadata in a non-model stub setting, fail-open, without modifying DSH packages or Veyra.
- **Still required before claiming full final-boundary proof:** separately authorized isolated runtime preflight that composes real DSH services/agent-loop, confirms the wrapper observes the actual post-mutation `stream(request)` call, and validates parity/safety controls.
- **DSH modification remains optional but potentially valuable:** if harness injection cannot be made stable/supported across DSH versions or cannot access the exact final boundary in production-like compositions, the Phase 1.7 DSH-side opt-in admission artifact becomes the more reliable contract.

---

## 8. Final verdict

**`HARNESS_FEASIBLE`** (for contract-level, non-model, fail-open interception of the DSH agent-loop stream boundary via `prepareCall`/`preparedCall.stream`/`llm.stream` wrapping, without DSH modification).

**Not claimed:** final post-mutation delivery proof in a full live DSH agent runtime, model receipt, or agent application. Those require separately authorized isolated runtime preflight and, for application/receipt claims, additional evidence/controls beyond request presence.

*Stop condition met: prototype executed (non-model, stub only) and report delivered. No Phase 1 experiments executed.*
