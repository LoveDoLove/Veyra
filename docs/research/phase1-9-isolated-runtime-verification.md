# Phase 1.9 — Isolated Runtime Verification

**Date:** 2026-11-07  
**Authorization:** CEO approved isolated, non-model runtime verification only (Phase 1.8 contract-level feasibility accepted).  
**Scope:** prove whether the Phase 1.8 harness approach works with a genuinely isolated DSH + Veyra runtime for runtime isolation, effective configuration, and final stream-boundary observability — without modifying DSH or Veyra source/packages, without existing DSH Web/profile/authoritative DB access, without model/API calls, and without real Agent engineering tasks.

**Hard limits:** this is **not** Phase 1 experiment execution. Stream/request presence is **not** model receipt and **not** agent application. Results distinguish **actual runtime/package evidence** from **simulated/stub behavior**.

## 1. Exact isolation mechanism and evidence

### Mechanism
| Boundary | Mechanism | Evidence |
|---|---|---|
| DSH home | `DSH_HOME=<disposable /tmp dir>` passed only to the verification process; resolved via installed `@deepseek-ai/dsh-home-paths` `resolveDshHome()` | `dsh-home-paths resolves to isolated DSH_HOME` **PASS** (`resolvedDsh === /tmp/veyra-p19-dshhome-*`) |
| Veyra home | `VEYRA_HOME=<disposable /tmp dir>` passed only to the verification process; resolved via Veyra v0.1.72 `resolveVeyraHome({}, process.env)` from `src/ids.mjs` | `veyra resolveVeyraHome({}, env) resolves to isolated VEYRA_HOME` **PASS** |
| Existing DSH Web/profile | Not modified, not restarted, not read as authoritative target; preflight fingerprint recorded | Existing `/home/lovedolove/.dsh` `mtime=1794058329 nlink=28` unchanged after runs; `0` phase19 artifacts found under `/home/lovedolove/.dsh` |
| Existing Veyra data | Not modified | Existing `/home/lovedolove/.veyra` `mtime=1790876598 nlink=3` unchanged after runs; `0` phase19 artifacts found under `/home/lovedolove/.veyra` |
| Existing profile DB/sessions | Not accessed as authoritative runtime DB; test project DB created only under isolated `VEYRA_HOME` | `store: project db created under isolated VEYRA_HOME` **PASS**; `store: no writes to existing VEYRA/DSH homes for test project` **PASS**; `post: no test project in existing VEYRA/DSH homes` **PASS** |

### Preflight
- Existing DSH home: `/home/lovedolove/.dsh` (metadata-only fingerprint; profile/session files present in environment, not accessed by verification).
- Existing Veyra home: `/home/lovedolove/.veyra`.
- Isolation could be proven before/after: disposable temp homes only, resolved path checks passed, no test-project leakage to existing homes, existing home fingerprints unchanged.

## 2. Runtime loading and effective configuration

| Item | Observed (actual) |
|---|---|
| DSH installation | `@deepseek-ai/dsh` **0.2.2-rc.1** at `/home/lovedolove/.local/share/mise/installs/node/24.22.2/lib/node_modules/@deepseek-ai/dsh` (installed package; not modified). *Note:* CEO request named “DSH v0.1.72”; installed/released DSH package available in this environment is 0.2.2-rc.1 — used as-is, no installation/profile changes. |
| Veyra package | **`@lovedolove/veyra@0.1.72`** (npm pack tarball extracted to disposable temp; runtime modules imported from that package; dependency `@lovedolove/dsh-codebase-memory-mcp` symlinked in disposable temp `node_modules` only to satisfy ESM resolution for store import — no Veyra source/dependency/config changes in repo or installed packages). |
| Node | `v24.22.2` |
| Veyra config schema (effective) | `Config['~standard'].validate({recallLimit:3,includeReusable:true}).value.recallLimit === 3` **PASS**; `recallLimit:0` preserved **PASS** |
| Veyra normalization (effective) | `normalizeRecallLimit(0) === 0` **PASS**; `normalizeRecallLimit(5) === 5` **PASS** |
| Veyra context provider | `createContextProvider` available from v0.1.72 `src/context.mjs` **PASS** |

**Evidence class:** actual package/runtime module loading and config validation in an isolated Node process with isolated env vars. No DSH Web/profile boot, no existing authoritative DB.

## 3. Actual stream interception evidence

### Contract evidence (actual, installed DSH)
- `dsh-agent-loop` stream boundary (inspected): `preparedCall?.stream(request) ?? this.loopCtx.llm.stream(request)` (`node_modules/@deepseek-ai/dsh-agent-loop/lib/index.js:877`), with `prepareCall` at `:1005`. This is the same preferred interception contract established in Phase 1.8.

### Harness integration evidence (actual, non-model, stub)
Phase 1.8-style wrapper (no DSH modification) intercepted the **`preparedCall.stream`** channel:

| Arm | Interception | Channel | Request identity preserved | Veyra marker in intercepted request | Test marker in intercepted request |
|---|---:|---|---:|---:|---:|
| Treatment (`recallLimit=3`) | **PASS** | `preparedCall.stream` | **PASS** (`requestObject === req`) | `true` (matches generated context) | `false` (no eligible seeded recall surfaced for this minimal context/query) |
| Baseline (`recallLimit=0`) | **PASS** | `preparedCall.stream` | **PASS** | `false` | `false` |

- Hashes recorded (metadata-only, SHA-256 over request-shape serialization): treatment `8800e8d5…`, baseline `94d74eac…` (no raw prompt/content persisted).
- Baseline produced no Veyra recall marker in generated context (`ctxTextLen=0`, `hasVeyraMarker=false`) — consistent with `recallLimit:0`.
- Treatment produced a Veyra marker header with “No known engineering history…” for this minimal invocation/query; interception still proved marker presence can be distinguished at the final wrapped stream boundary.

**Post-mutation claim (bounded):** interception was exercised on the wrapped `preparedCall.stream(request)` path used by agent-loop’s preferred contract. This verification did **not** run a full DSH `AgentLoop`/Cordis agent turn through all real pre-step/request-mutation waterfalls and live session plumbing; therefore it **does not prove** interception after every possible live DSH mutation in a full agent runtime. It **does prove** the harness can wrap the agent-loop’s preferred stream entrypoint and observe the request object passed to that boundary without modifying DSH.

## 4. Treatment / Baseline isolation results

| Check | Result | Detail |
|---|---:|---|
| Separate effective configs | **PASS** | treatment `recallLimit=3`, baseline `recallLimit=0` |
| Config preservation/normalization | **PASS** | schema preserves 0 and 3; `normalizeRecallLimit(0)===0` |
| Separate runs / isolated Veyra state | **PASS** | both arms used isolated `VEYRA_HOME`; stores opened under isolated home only; no writes to existing homes |
| Baseline disables recall marker | **PASS** | baseline generated context had no `Veyra recalled engineering memory` marker |
| Harness observes both arms | **PASS** | both intercepted at `preparedCall.stream`; request identity preserved |
| Full runtime session parity (live agent profiles, model/tool/permission parity) | **NOT VERIFIED** | no real agent tasks/model calls; no live DSH Web/profile/session orchestration |

## 5. Request identity and fail-open verification

| Verification | Result | Evidence |
|---|---:|---|
| Request identity preserved through pass-through | **PASS** | `requestObject === req` in treatment and baseline; separate stub check confirmed `finish.requestIdentity === req` on `preparedCall.stream` |
| Fail-open behavior | **PASS** | wrapper caught instrumentation error and still yielded original stub stream; original request identity preserved (`PASS fail-open preserves request identity and original stream execution`) |

Fail-open was verified in an isolated non-model stub check (instrumentation throws, wrapper catches, original stream executes). It was not verified against real DSH session persistence/network/provider failure modes.

## 6. Privacy and security assessment

- **No raw prompts/content persisted by verification recorder:** recorder stored only channel, SHA-256 hash of request-shape serialization, marker booleans, lengths/count-style shape facts, and object identity checks.
- **No source code persisted** as evidence payload.
- **No credentials/tokens/secrets** read or persisted; no API/model calls.
- **Existing DSH profile/authoritative runtime DB not accessed**; existing homes unchanged by fingerprint/leakage checks.
- **Disposable scope:** temp dirs under `/tmp/veyra-phase1-9-*` and `/tmp/veyra-p19-*` for extracted package, isolated homes, and result artifacts.
- **Risk note:** this was a local diagnostic script, not production instrumentation. Any future experiment instrumentation must keep no-raw-prompt default, explicit opt-in, bounded retention, and isolated scope.

## 7. Remaining limitations

1. **No full DSH `AgentLoop` live turn executed.** Interception proved on the wrapped `preparedCall.stream` contract and Veyra context/provider path, not as a complete end-to-end DSH agent runtime turn with all pre-step/request/session mutations.
2. **DSH version naming mismatch:** request referenced DSH v0.1.72; environment provided installed `@deepseek-ai/dsh` 0.2.2-rc.1. Used installed DSH packages read-only; no install/profile changes.
3. **Veyra runtime loaded from disposable npm-packed v0.1.72** with a temp-only CBM dependency symlink for module resolution (needed because `store.mjs` imports `@lovedolove/dsh-codebase-memory-mcp`). This does not modify DSH/Veyra installations or repo; it is a test-loading convenience.
4. **Treatment marker showed “No known engineering history”** in this minimal invocation; seeded isolated record was not surfaced by the minimal context/query shape. This still verified baseline-vs-treatment marker/config isolation and interception, but did not prove retrieval of a specific seeded record in this harness script.
5. **No model receipt / agent application / engineering outcome** evidence. Pre-stream observation only.
6. **No live DSH Web/headless profile session parity** verification; Phase 2.2/paired runtime controls remain outside this report’s proof.

## 8. Final verdict

**PARTIALLY_VERIFIED**

**Why:** isolation and effective configuration were proven with disposable `DSH_HOME`/`VEYRA_HOME`, installed DSH path resolution, Veyra v0.1.72 config/provider/store behavior, and no leakage to existing DSH/Veyra homes. The Phase 1.8 harness approach successfully wrapped and observed the **agent-loop preferred `preparedCall.stream` contract** with request identity preserved, fail-open behavior, metadata-only capture, and treatment/baseline `recallLimit` separation (`0` vs `>0`) without modifying DSH. However, this did **not** execute a full live DSH `AgentLoop` agent turn, so it does not yet establish final post-mutation observability across the complete DSH runtime stack as `ISOLATED_RUNTIME_VERIFIED`.

**Stop condition met:** non-model isolated runtime verification completed; report delivered. No Phase 1 experiments executed.
