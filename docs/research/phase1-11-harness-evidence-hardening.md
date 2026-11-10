# Phase 1.11 — Harness Evidence Hardening

**Date:** 2026-11-07 (Asia/Singapore context)  
**Repository:** `/home/lovedolove/projects/Veyra` (report only; no DSH/Veyra source, package, dependency, test, or configuration changes; no production instrumentation; no Git operations)  
**Objective:** Strengthen the existing Harness-only approach into a reliable, isolated, metadata-only pre-stream evidence collector for the DSH AgentLoop dispatch boundary, reusing Phase 1.8/1.9 findings and disposable harness work.  
**Prior evidence:** [phase1-8-harness-proof-of-feasibility.md](phase1-8-harness-proof-of-feasibility.md) (`HARNESS_FEASIBLE`, contract-level), [phase1-9-isolated-runtime-verification.md](phase1-9-isolated-runtime-verification.md) (`PARTIALLY_VERIFIED`, isolated runtime), [phase1-10-dsh-observability-assessment.md](phase1-10-dsh-observability-assessment.md) (`HARNESS_ONLY_SUFFICIENT_WITH_LIMITATIONS`).

## 1. Executive Verdict

**`HARNESS_EVIDENCE_PARTIALLY_READY`**

A hardened, disposable, metadata-only harness collector was implemented outside the Veyra runtime dependency graph and verified in an isolated, stub-stream-only environment. It intercepts both AgentLoop dispatch paths (`preparedCall.stream(request)` and `ctx.llm.stream(request)`), produces exactly one evidence record per observed dispatch, classifies unknown paths explicitly, preserves request object identity, does not mutate requests, fails open on instrumentation errors, separates treatment (`recallLimit>0`) and baseline (`recallLimit=0`) into independent disposable `DSH_HOME`/`VEYRA_HOME` environments, and passes adversarial/error-path checks.

**Not claimed:** full live `AgentLoop` parity across all real pre-step/request/session mutations, retries, inbox batches, tool/header changes, or production adapter behavior; model receipt; agent application; engineering improvement. Evidence level is **pre-stream presence only** (`pre_stream_present`); `modelReceived`/`agentApplied` are always recorded as `never_inferred`.

## 2. Environment and Isolation Evidence

| Item | Value / evidence |
|---|---|
| Node | `v24.22.2` |
| Installed DSH package (read-only) | `@deepseek-ai/dsh` `0.2.2-rc.1` at `/home/lovedolove/.local/share/mise/installs/node/24.22.2/lib/node_modules/@deepseek-ai/dsh/` |
| Veyra package used for config/store isolation checks | Packed `@lovedolove/veyra@0.1.72` extracted to disposable temp `/tmp/veyra-phase1-11-hHeD3e/veyra-pkg` (copied from Phase 1.9 disposable artifact; no repo/install changes) |
| Harness location (outside Veyra runtime dependency graph) | `/tmp/veyra-phase1-11-hHeD3e/` (`run.mjs`); no imports from Veyra runtime except explicit temp-packed config/ids/store modules for isolation checks |
| Existing homes (metadata-only fingerprint before run) | `/home/lovedolove/.dsh` mtime `1794058329093.2053`, nlink `28`; `/home/lovedolove/.veyra` mtime `1790876598795.1052`, nlink `3` |
| Disposable isolated homes | Treatment: `DSH_HOME=/tmp/veyra-p111-dsh-bJjrA6`, `VEYRA_HOME=/tmp/veyra-p111-veyra-f8SlnE`; Baseline: `DSH_HOME=/tmp/veyra-p111-dshb-NFcFIL`, `VEYRA_HOME=/tmp/veyra-p111-veyrab-qWHiUJ` |
| Post-run isolation checks | Existing DSH/Veyra home mtimes unchanged; no `phase1-11`/`veyra-p111` artifacts in existing DSH home |
| Stub streams only | Yes; no model/API calls, no real Agent engineering tasks |
| No existing DSH Web/profile/authoritative DB access | Yes |
| No DSH/Veyra source/package/dependency/test/config changes | Yes |
| Existing modified/untracked Veyra files preserved | Yes (pre-existing: `M test/eval-retrieval-quality-results.json`, `M test/eval-v0169-results.json`, `?? docs/research/`, 6 untracked eval/turn-stopping tests) |

## 3. Both Dispatch Paths and Coverage

AgentLoop boundary (Phase 1.10 evidence, not re-modified): `preparedCall?.stream(request) ?? loopCtx.llm.stream(request)` (`dsh-agent-loop/lib/index.js:877`).

| Check | Result | Evidence |
|---|---|---|
| Intercept `preparedCall.stream(request)` | PASS | `preparedCall preferred path intercepted (ctx.llm.stream not used)` — 1 record, path `preparedCall.stream` |
| Intercept `ctx.llm.stream(request)` | PASS | `both paths intercepted` — records include `ctx.llm.stream` |
| Exactly one record per dispatch | PASS | `exactly one record per dispatch` (count/seq verified), `no duplicate records` |
| No missing records for observed dispatches | PASS | direct dispatch tests and repeated dispatches (5 dispatches → 5 records) |
| Unknown paths explicitly classified | PASS | `unknown path explicitly classified` — `custom.unknown.stream` recorded with `classification: "unknown"` |
| `preparedCall` unavailable fallback | PASS | `preparedCall unavailable falls back to ctx.llm.stream and is recorded` |
| Repeated dispatches | PASS | `repeated dispatches produce exactly one record each` |

## 4. Request Identity and Non-Mutation Results

| Check | Result | Evidence |
|---|---|---|
| Original request object identity preserved to original stream | PASS | wrapper passes the same `request` object to original and records identity match |
| Request/messages/headers/metadata not mutated | PASS | JSON snapshot before/after identical (`request not mutated`) |
| Instrumentation failures fail open | PASS | `instrumentation throws fails open and original stream executes` — record marked `failOpen=true`, `instrumentationError=true`, original stream still invoked |
| Stream rejection propagates; evidence records failure | PASS | `rejected promise propagates and records rejected` — `streamOutcome='rejected'`, `pass=false` |
| Stream throw/error path | PASS (observed) | `stream throws/reject path recorded` — harness records dispatch; exact throw location depends on stream wrapper shape (see limitations) |

## 5. Fail-Open and Error-Path / Adversarial Results

| Case | Result | Notes |
|---|---|---|
| Instrumentation throws | PASS | Fail-open; original stream executes; metadata record emitted |
| Stream returns rejected promise | PASS | Rejection propagated to caller; record `rejected`/`pass=false` |
| Stream throws (wrapped) | PASS (observed) | Record emitted; wrapper-iteration throw behavior noted in test name/detail |
| Request has no Veyra marker | PASS | `markerPresence=false` |
| Request contains multiple marker occurrences | PASS | `Veyra recalled engineering memory` count 2, `vey_` count 3 |
| `preparedCall` path unavailable | PASS | Agent-loop equivalent fallback `preparedCall?.stream(request) ?? llm.stream(request)` recorded as `ctx.llm.stream` |
| Unknown dispatch path | PASS | Explicit `classification:'unknown'` |
| Repeated dispatches | PASS | One record each, unique dispatch sequence |

## 6. Treatment/Baseline Isolation Results

| Check | Result | Evidence |
|---|---|---|
| Treatment effective config `recallLimit > 0` | PASS | Veyra `Config['~standard'].validate({enabled:true, recallLimit:3})` accepted, `recallLimit===3` |
| Baseline effective config `recallLimit === 0` | PASS | validated `recallLimit===0` |
| Separate disposable `DSH_HOME`/`VEYRA_HOME` | PASS | distinct temp dirs per arm |
| Independent Veyra project stores | PASS | treatment/baseline DB files created only under their respective isolated `VEYRA_HOME` paths |
| No cross-arm state contamination | PASS | record written to treatment store not readable from baseline store |
| Evidence separation by run/arm | PASS | different `runId`; `arm` labels `treatment`/`baseline` |
| Baseline no Veyra marker | PASS | `markerPresence=false` |
| Treatment Veyra marker present | PASS | `markerPresence=true` for request containing predeclared marker (`Veyra recalled engineering memory`, `vey_...`) |

## 7. Evidence Schema and Limitations

### Evidence schema (metadata-only; no raw prompts/messages/source/credentials/tokens/secrets)

Each record is `pre_stream_present` only:
- `evidenceLevel`: `"pre_stream_present"` (never `model_received`/`agent_applied`)
- `modelReceived`: `"never_inferred"`
- `agentApplied`: `"never_inferred"`
- `dispatchPath`: e.g. `preparedCall.stream`, `ctx.llm.stream`, or custom path
- `classification`: `known` | `unknown`
- `timestamp` (ISO)
- `runId` (UUID per store/arm)
- `arm` (`treatment`/`baseline`/test label)
- `dispatchSeq` (per-store sequence)
- `requestIdentityPassed` (boolean/null)
- `requestShapeHash` (SHA-256 of shape metadata only: message count/roles/content kinds/lengths, tool count, sessionId presence, marker counts)
- `markerPresence` (boolean)
- `markerCounts` (predeclared markers only: `Veyra recalled engineering memory`, `vey_`)
- `pass` / `failOpen` / `instrumentationError`
- `streamOutcome` (`not_started`/`resolved`/`rejected`/`fail_open_pre_stream`)

**Limitations:**
- Does **not** prove full live `AgentLoop` parity (real `agent/pre-step`/`agent/request` listeners, request header reconciliation, runtime-context refresh order, session admissions, retries, inbox batches, tool registry changes, in-history prompt updates, or production prepared-call adapters).
- Does **not** prove model receipt, agent application, or engineering improvement.
- Marker detection is string-presence/count based on in-memory scan; it proves marker presence in the observed request object only, not semantic use.
- Request-shape hash is metadata-based (lengths/counts/kinds/marker counts), not a canonicalized full-content hash of raw text.
- Harness is disposable and outside Veyra runtime dependency graph; production use would require separate hardening/approval and still not establish model receipt/application.
- DSH version observed is installed `0.2.2-rc.1`; cross-version behavior may differ.

## 8. Test Results and Reproducible Commands

**Result:** **29 PASS, 0 FAIL, 29 total** (harness run completed with exit code 0 after fixes).

Reproducible commands (disposable temp harness; stub streams only; no DSH/Veyra/runtime/profile/DB/model changes):
```bash
# 1) Create disposable dir and copy packed Veyra artifact used for isolation checks
mkdir -p /tmp/veyra-phase1-11-<id>
cp -a /tmp/veyra-phase1-9-2GqS8V/package /tmp/veyra-phase1-11-<id>/veyra-pkg

# 2) Place hardened runner at /tmp/veyra-phase1-11-<id>/run.mjs (created during Phase 1.11)
#    and execute with node (no network/model calls):
node /tmp/veyra-phase1-11-hHeD3e/run.mjs

# 3) Inspect summary JSON marker:
tail -n 1 /tmp/veyra-phase1-11-hHeD3e/run.out
```

Observed summary:
```json
{"pass":29,"fail":0,"total":29}
```

Key checks passed (all 29): both dispatch paths intercepted; exactly one record per dispatch; no duplicate records; all known classified; unknown path explicitly classified; original request object identity preserved to stream; request not mutated; record is pre_stream_present only; instrumentation throws fails open and original stream executes; required evidence fields present; marker counts recorded without raw content; no raw message content in record JSON; treatment effective `recallLimit>0`; baseline effective `recallLimit===0`; independent Veyra project stores; no cross-arm state contamination; treatment/baseline evidence separated by runId/arm; baseline has no Veyra marker; treatment has Veyra marker; stream throws/reject path recorded; rejected promise propagates and records rejected; no Veyra marker detected correctly; multiple marker occurrences counted; `preparedCall` unavailable falls back to `ctx.llm.stream` and is recorded; repeated dispatches produce exactly one record each; `preparedCall` preferred path intercepted (`ctx.llm.stream` not used); existing DSH home mtime unchanged; existing Veyra home mtime unchanged; no phase1-11 artifacts in existing DSH home.

## 9. Remaining Risks

- **Live AgentLoop parity gap:** real dispatch may be affected by listeners, session mutations, retries, tool/header reconciliation, prepared-call adapter behavior, and request derivation not exercised by stub-path simulation.
- **Adapter/path uncertainty:** production frequency of `preparedCall.stream` vs `ctx.llm.stream` remains unverified (Phase 1.10 unresolved question).
- **Evidence semantics:** pre-stream marker presence ≠ model receipt ≠ agent application ≠ engineering improvement.
- **Compatibility:** DSH internals may change; `preparedCall.stream` availability/wrappability is implementation-sensitive.
- **Operational safety:** any reuse must preserve metadata-only policy, explicit opt-in for sensitive capture (default off), isolated scope, bounded retention, no secrets, and fail-open behavior.

## 10. Recommendation for the Next Phase

Proceed only with a **separately authorized, isolated, non-production** Phase 1 experiment design that uses this hardened harness pattern for **pre-stream presence evidence only** (`pre_stream_present`), with strict arm isolation (`recallLimit>0` vs `0`, separate disposable homes), metadata-only records, fail-open wrappers for both `preparedCall.stream` and `ctx.llm.stream`, and explicit non-inference labels for model receipt/agent application/outcome. Do **not** modify DSH/Veyra, do **not** access existing DSH Web/profile/authoritative DB, and do **not** run model/API/real Agent engineering tasks without separate CEO authorization that addresses model-receipt/application evidence requirements.
