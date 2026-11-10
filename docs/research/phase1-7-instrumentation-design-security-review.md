# Phase 1.7 — Instrumentation Design & Security Review

**Date:** 2026-11-07  
**Scope:** read-only design and security review. No source, dependency, test, configuration, or runtime changes. No model/API calls or experiment execution. No modification or restart of existing DSH Web/profile. No Git staging/commits/pushes/tags/releases.  
**Objective:** evaluate the smallest safe instrumentation design needed to validate Veyra memory **delivery** and **application** evidence, building on Phase 1.6 feasibility findings.

**Evidence basis:** Phase 1.6 report (`docs/research/phase1-6-delivery-application-proof-feasibility.md`), Phase 1.5 report, Veyra v0.1.72 surfaces (`src/context.mjs`, `src/apply-generation-evidence.mjs`, `src/tools.mjs`, `src/health.mjs`), and inspected installed DSH surfaces (`dsh-system-prompt`, `dsh-agent-loop`, `dsh-agent`, `dsh-headless`, `dsh-llm`). “No X found/evidenced” means not evidenced in inspected supported surfaces; not proof of absence. No unsupported DSH APIs are assumed.

**Hard proof rule (must not be violated):** request/prompt presence does **not** prove model receipt, model attention, or agent application. Application/outcome require independent evidence.

---

## 1. Architecture comparison

Phase 1.6 identified the nearest evidenced admission boundary as the agent loop’s frozen request passed to `preparedCall?.stream(request) ?? ctx.llm.stream(request)`, after `agent/pre-step`, request preparation/reconciliation, runtime-fact refresh, message derivation, and request marking. No supported admission/model-receipt hook or headless request artifact was evidenced.

| Option | Where it observes | What it can prove (max) | Strengths | Weaknesses | Security/privacy profile | Recommendation |
|---|---|---|---|---|---|---|
| **A. Isolated harness interception (in-process, supported composition)** | Cordis/system-prompt/agent watermarks/waterfalls and request objects accessible in an isolated harness, if supported in that composition | **Pre-stream presence in observed request object** only when the harness can observe the exact final object/step boundary; otherwise partial/indirect. Never model receipt/use. | No product/runtime change to installed DSH; good for controlled experiments; can correlate Veyra generation with observed assembly/pre-step effects. | Fragile to DSH internals; may miss the exact final `stream(request)` object if not exposed; reconstructing from watermarks can be inferential; not a stable supported contract for CI/production tooling. | Lower blast radius if isolated; still can access sensitive prompt/request data in-process — must enforce same hash/no-raw defaults. | **Useful as a stopgap preflight** in a separately authorized isolated harness, but **not sufficient** as the primary proof mechanism. |
| **B. DSH-side instrumentation at final `stream(request)` boundary** | Agent-loop (or officially supported equivalent) immediately before/at `stream(request)` with the frozen/marked request | **Pre-stream delivery/admission to stream call** (strongest practical DSH-local proof): “this frozen request, with these marker/hash properties, was passed to the LLM stream path for this step.” Never model receipt/use. | Observes the correct boundary after pre-step/mutation; can emit a stable, minimal, privacy-controlled artifact; works for headless/agent runs if integrated; avoids harness guesswork. | Requires DSH code change + review/release/maintenance; cross-version compatibility; must be opt-in and carefully scoped. | Highest need for controls because it sits on sensitive boundary; safe if default no-raw, opt-in, isolated, bounded retention, no secrets. | **Preferred minimum implementation** for direct pre-stream delivery proof. |
| **C. Veyra-only instrumentation** | Veyra context generation/feedback/health (`veyra_apply_generation_v1`, outcome links) | **Generation** and explicit/non-causal linkage metadata only. | No DSH change; already implemented in Stage A. | **Cannot** prove DSH assembly survival, pre-step preservation, or admission to model stream. | Low incremental risk; must keep `delivery/used=NOT_VERIFIED`. | **Necessary but insufficient**; retain as correlation source. |
| **D. Headless NDJSON-only enhancement** | `dsh headless --json` output | Can prove delivery only if it carries verifiable admission/marker/hash fields from the real boundary. | Convenient capture format. | If implemented without DSH boundary instrumentation, it may summarize the wrong stage. Needs DSH/agent-loop source data. | Same prompt-leakage risks if raw payload added. | **Secondary transport**, not the source of truth; acceptable only if fed by option B. |

### Comparison conclusion

- **Isolated harness interception** can reduce uncertainty in a controlled, authorized environment but is **indirect/fragile** relative to the true admission point and does not create a supported proof contract.
- **DSH-side `stream(request)` instrumentation** is the **smallest change that directly targets the evidenced delivery boundary**. It is technically necessary if the goal is a reliable, repeatable, independently reviewable **pre-stream delivery proof** across runs/versions. If the goal is limited to best-effort preflight evidence in one controlled harness, option A may be used temporarily but must be labeled non-contractual and `NOT_VERIFIED` for model delivery.

---

## 2. Proposed minimum evidence schema

The schema is a **design proposal** (not implemented). It is split into evidence levels so consumers cannot overclaim. Default encoding: structured JSON/NDJSON record, UTF-8, stable field names, schema versioned.

### 2.1 Common envelope (all levels)

| Field | Type | Required | Description | Privacy |
|---|---|---|---|---|
| `schema` | string | yes | e.g. `veyra.experiment.evidence.v1` | non-sensitive |
| `evidence_level` | enum | yes | `CONTEXT_ASSEMBLED` \| `PRESENT_IN_FINAL_PRESTREAM_REQUEST` \| `MODEL_RECEIPT` \| `AGENT_APPLICATION` \| `ENGINEERING_OUTCOME` | non-sensitive |
| `experiment_id` | string | yes | Predeclared experiment identifier (not a secret) | non-sensitive |
| `run_id` | string | yes | Unique run attempt | non-sensitive |
| `correlation_id` | string | yes | Ties related records (session/turn/step chain); stable within run | non-sensitive |
| `timestamp_utc` | string (RFC3339) | yes | Event time | non-sensitive |
| `execution_stage` | enum/string | yes | e.g. `veyra.context.rendered`, `dsh.system_prompt.assembled`, `dsh.agent.pre_step`, `dsh.agent.request_frozen`, `dsh.llm.stream_admitted`, `harness.decision_trace`, `repo.outcome_verified` | non-sensitive |
| `arm` | enum | yes | `treatment` \| `baseline` \| `control` (predeclared) | non-sensitive |
| `source` | string | yes | Producing component, e.g. `veyra.p1-stage-a`, `dsh.agent-loop.instrumentation`, `experiment.harness` | non-sensitive |
| `integrity` | object | recommended | `{ algo: "sha256", canonicalization: "...", record_hash: "..." }` for the evidence record (excluding volatile transport metadata) | non-sensitive |

### 2.2 Veyra memory identifiers / hashes

| Field | Type | Required | Description | Privacy |
|---|---|---|---|---|
| `veyra_generation_event_id` | string | when available | P1 Stage A generation event ID (explicit correlation handle) | non-sensitive ID |
| `veyra_record_refs` | array | when available | Bounded list of `{ record_id: "vey_...", record_hash?: "...", anchor_hashes?: [...] }` for records intentionally targeted by the experiment | IDs/hashes only; no raw recalled content |
| `veyra_context_marker_hash` | string | optional | Hash of predeclared marker (e.g., canonical heading string) or marker template; never raw full context | hash only |
| `query_hash` | string | optional, opt-in | Hash of normalized query/input under predeclared canonicalization; **omitted by default** in Veyra Stage A posture and should remain opt-in | sensitive-adjacent; opt-in |

### 2.3 Delivery / request evidence (`PRESENT_IN_FINAL_PRESTREAM_REQUEST`)

| Field | Type | Required | Description | Privacy |
|---|---|---|---|---|
| `delivery_channel` | enum/string | yes | `preparedCall.stream` \| `ctx.llm.stream` \| `unknown` (only when truly unknowable; prefer explicit) | non-sensitive |
| `request_correlation` | object | yes | `{ session_id?, turn_id?, step_id?, agent_id?, profile_id? }` — non-secret identifiers available in isolated experiment | avoid user PII; use isolated IDs |
| `model_selector` | object | optional | Non-secret provider/model/profile label used for parity checks | no API keys/secrets |
| `final_request_hash` | object | yes | `{ algo:"sha256", canonicalization:"jcs"|"json-stable-v1", value:"..." }` over final admitted message/tool/request structure selected by schema | hash only; **no raw prompt** |
| `final_request_shape` | object | recommended | Counts/lengths only: message count, role counts, total chars/bytes, tool count, system/context block count | metadata only |
| `marker_proofs` | array | recommended | Predeclared marker checks: `{ marker_id, present: true|false, match_basis:"record_id"|"heading_hash"|"structured_ref", location_hint?: "message_index:role" }` | booleans/hashes/indices only |
| `mutation_lineage` | array/object | yes | Ordered/summary lineage: `context_assembled`, `pre_step_applied` (replaced? count), `request_waterfall_applied?`, `prompt_reconciled?`, `runtime_facts_refreshed?`, `messages_derived`, `request_frozen`, `stream_admitted` — booleans/counts/enum outcomes, no payloads | metadata only |
| `admission_result` | enum | yes | `stream_call_reached` \| `aborted_before_stream` \| `rejected_pre_step` \| `error_before_stream` | non-sensitive |

### 2.4 Model receipt (normally unavailable)

| Field | Type | Required | Description |
|---|---|---|---|
| `provider_receipt` | object | only if verifiable | Provider-signed/traceable receipt or equivalent independently verifiable artifact. **Do not populate from local stream call success.** |

### 2.5 Agent application

| Field | Type | Required | Description | Privacy |
|---|---|---|---|---|
| `decision_trace` | object | yes | Structured claim: cited `veyra_record_refs`/`veyra_generation_event_id`, quoted/paraphrased fact ID (not raw secret), intended action, alternatives considered | minimize raw text; may reference hashes/IDs |
| `action_refs` | array | recommended | Tool calls, diff files (paths), commands/tests invoked — bounded metadata | avoid embedding full diffs/secrets |
| `attribution_label` | enum | yes | `SUPPORTED_APPLICATION` \| `PLAUSIBLE_CORRELATION` \| `NOT_VERIFIED` \| `CONTRADICTED` | non-sensitive |
| `baseline_comparison` | object | recommended | Arm/parity/confound summary | non-sensitive |

### 2.6 Engineering outcome

| Field | Type | Required | Description |
|---|---|---|---|
| `outcome_checks` | array | yes | Repo-truth checks: test names/results, constraint checklist IDs, reproduction pass/fail, safety checks |
| `outcome_label` | enum | yes | `VERIFIED_SUCCESS` \| `VERIFIED_FAILURE` \| `MIXED` \| `NOT_VERIFIED` |
| `evidence_refs` | array | recommended | Paths/hashes to isolated artifacts (test logs, diffs) stored under controlled retention |

### 2.7 Canonicalization and hashing (design requirements)

- Use a **stable canonicalization** for `final_request_hash` (e.g., deterministic JSON canonicalization) and record it in the artifact. Hash instability destroys comparability.
- Include only fields defined by schema in the hashed payload; exclude timestamps/transport noise unless explicitly part of the contract.
- Hash algorithm default: `sha256`. If marker proofs use HMAC or keyed hashes, keys must be experiment-scoped secrets stored outside evidence artifacts and never committed.

---

## 3. Privacy and security assessment

### 3.1 Controls (required)

| Control | Design requirement | Rationale |
|---|---|---|
| **No raw prompt/source by default** | Admission artifacts store hashes, counts, booleans, indices, and predeclared marker proofs only. Raw request/messages/system prompt/source code forbidden unless a separately approved, explicitly scoped diagnostic mode is enabled. | Prompts/requests can contain secrets, credentials, proprietary code, customer data, and PII. |
| **Explicit opt-in** | Instrumentation disabled by default. Enable only via an explicit experiment configuration/flag in an isolated profile/home. No automatic enablement in normal DSH Web/profile runs. | Prevents accidental leakage in production/developer sessions. |
| **Isolated experiment scope** | Valid only under dedicated `DSH_HOME`/`VEYRA_HOME`, throwaway profile/workspace/session; never existing DSH Web/profile or authoritative runtime DB. Artifacts stored under isolated experiment path. | Limits blast radius and data mixing. |
| **Bounded retention** | Predeclared TTL/max size/count; automatic pruning or explicit deletion step; no indefinite retention by default. Retention policy recorded in experiment manifest. | Minimizes sensitive metadata exposure window. |
| **No credential/secret capture** | Schema excludes API keys, tokens, cookies, auth headers, environment secrets, and raw tool outputs known to carry secrets. Instrumentation must not dump provider request headers/bodies. Marker proofs use IDs/hashes, not recalled secret text. | Admission boundary is adjacent to provider calls; high leakage risk. |

### 3.2 Threats and mitigations

| Threat | Risk | Mitigation |
|---|---|---|
| Prompt/request exfiltration | High | No raw payload default; hash/shape/marker proofs; isolated local storage; opt-in. |
| Secret leakage via recalled memory markers | Medium | Bind proofs to `vey_...` IDs or hashes of predeclared markers; never hash/emit arbitrary secret-bearing recall text unless separately approved and redacted. |
| Cross-run/profile contamination | Medium | `experiment_id`/`run_id`/arm isolation; separate homes/profiles; fresh sessions. |
| Hash oracle / correlation attacks | Low–Medium | Use experiment-scoped canonicalization; avoid publishing hashes of sensitive raw secrets; limit who can access isolated artifacts. |
| False certainty / governance misuse | High | Schema enforces `evidence_level` and attribution labels; documentation/UI must not map pre-stream presence to “used by model”. |
| Supply-chain/maintenance risk (DSH change) | Medium | Smallest possible boundary; feature-flagged; tests in isolated harness; no behavior change when disabled. |

### 3.3 Data minimization decision

The minimum useful proof for delivery is: **(a)** correlation to Veyra generation/record refs, **(b)** proof the frozen pre-stream request contained predeclared Veyra markers/IDs, **(c)** mutation/admission stage metadata, and **(d)** arm/run parity metadata. Full prompt capture is **not required** for that proof and is disallowed by default.

---

## 4. Proof-level limitations

| Evidence level | Can prove | Cannot prove | Minimum producer |
|---|---|---|---|
| **Context assembled** | Veyra rendered a recall block / generation event occurred (P1 Stage A); DSH system-prompt assembled contexts/sections when observed in supported harness | That content survived pre-step/request mutation; that it reached `stream(request)`; model receipt; agent use; outcome caused by memory | Veyra + optionally DSH system-prompt observation |
| **Present in final pre-stream request** | The frozen request passed to the LLM stream path contained predeclared Veyra marker/record evidence for that step/run (if DSH boundary instrumentation or exact final-request harness observation is available) | Provider/network delivery; model receipt or attention; agent application; engineering outcome; causality | DSH-side `stream(request)` instrumentation (preferred) or exact isolated harness observation (labeled non-contractual) |
| **Model receipt** | Only a verifiable provider/model receipt/ack artifact, if one exists | Agent attention/use; correct application; outcome. Local `stream()` call success is **not** model receipt. | External/provider capability — **not evidenced/available** in inspected surfaces |
| **Agent application** | At best `SUPPORTED_APPLICATION`/correlation when pre-stream delivery is proven, decision trace cites specific memory, action is consistent, and confounds controlled | Model cognition/attention; proof from generation/delivery alone; causality without controls | Experiment harness/process + agent decision trace + DSH/Veyra correlation |
| **Engineering outcome** | Independently verified repo/runtime result (tests/constraints/safety/diff) | That memory caused the outcome; that memory was delivered/applied absent D/A evidence | Repo-truth verification |

**Non-inference rules:**
- `CONTEXT_ASSEMBLED` ≠ `PRESENT_IN_FINAL_PRESTREAM_REQUEST`.
- `PRESENT_IN_FINAL_PRESTREAM_REQUEST` ≠ `MODEL_RECEIPT`.
- `PRESENT_IN_FINAL_PRESTREAM_REQUEST` ≠ `AGENT_APPLICATION`.
- `AGENT_APPLICATION`/code match ≠ `ENGINEERING_OUTCOME` causality; outcomes must be independently verified.

---

## 5. Minimum implementation recommendation

### 5.1 Recommended boundary

**Implement the smallest DSH-side, opt-in, pre-stream admission evidence emitter at the agent-loop `stream(request)` boundary**, with headless/NDJSON as an optional transport consumer of the same artifact.

Rationale:
- It is the **smallest change that observes the correct evidenced boundary** after pre-step/request mutation.
- Veyra-only changes cannot close the delivery gap.
- Harness interception is useful but not a stable contract at the exact final boundary.

### 5.2 Minimum scope (if/when separately approved)

1. **DSH agent-loop:** emit `PRESENT_IN_FINAL_PRESTREAM_REQUEST` evidence only when experiment instrumentation is explicitly enabled in an isolated profile/home. Compute stable `final_request_hash`, `final_request_shape`, `mutation_lineage`, `delivery_channel`, correlation IDs, and predeclared marker proofs (IDs/heading hash supplied by isolated experiment config; no raw prompt).
2. **Transport (optional):** expose the same record through headless NDJSON or an isolated artifact file. Do not invent a new always-on public payload.
3. **Veyra:** no learning/retrieval behavior change. Optionally allow experiment harnesses to correlate by `veyra_generation_event_id` / `vey_...` record refs already available; keep Stage A `delivery/used=NOT_VERIFIED` unless a verified DSH admission artifact is explicitly correlated by approved process/tooling.
4. **Harness/process:** add structured decision-trace template for application/outcome (not DSH product behavior).

### 5.3 Is DSH modification actually necessary?

| Goal | DSH modification necessary? | Explanation |
|---|---|---|
| Prove Veyra generated context | **No** | P1 Stage A already provides local generation evidence. |
| Best-effort preflight that recall text appeared in accessible pre-step/assembly surfaces | **No**, in a separately authorized isolated harness | Uses supported composition/watermarks where accessible; evidence is limited/fragile and must not be called final delivery proof. |
| Reliable direct proof that Veyra marker/record evidence was present in the final request passed to `stream(request)` | **Yes (recommended)** | The exact final admitted request boundary is inside DSH agent-loop behavior; no supported external admission/model-receipt/headless request artifact was evidenced. A DSH-side emitter is the smallest reliable observer. |
| Prove model receipt or agent application | **DSH modification insufficient** | Model receipt/use is outside DSH/Veyra control; application requires decision/outcome evidence and controls. |

---

## 6. Compatibility, maintenance, and failure risks

| Risk | Impact | Mitigation |
|---|---|---|
| **DSH internal drift** (agent-loop refactor, request shape, preparedCall path, pre-step semantics) | Instrumentation breaks or observes wrong object | Keep emitter minimal and boundary-local; version `schema`; test against supported DSH versions in isolated harness; treat as diagnostic contract, not core product API unless formally promoted. |
| **Hash/canonicalization instability** | False mismatches across runs/versions | Version canonicalization; include `schema`/`canonicalization` fields; golden tests in isolated fixtures. |
| **Incomplete mutation lineage** | Overconfidence that request is “final” | Emit explicit stage `dsh.llm.stream_admitted`; record known mutation booleans only when sourced from actual decision objects; unknowns marked `unknown`. |
| **Performance overhead** | Latency/memory in instrumented runs | Opt-in only; compute hashes/marker proofs with bounded work; no raw payload serialization. |
| **Privacy regression** | Sensitive prompt/code leakage | Default no-raw; static schema allowlist; review for accidental payload inclusion; isolated retention/TTL. |
| **Marker spoofing / ambiguity** | Wrong record attributed | Use specific `vey_...` IDs/hashes from predeclared experiment manifest; require correlation with Veyra generation event; baseline arm checks. |
| **Headless transport mismatch** | Consumers trust summary events that lack boundary data | Source headless delivery evidence from the same DSH boundary artifact; do not infer from assistant text summaries. |
| **Operational misuse on production profile** | Data exposure / policy violation | Hard opt-in + isolated home/profile guardrails; explicit authorization; docs warn against production use. |
| **False governance signal** | “Delivered” treated as “used/effective” | Mandatory `evidence_level`/labels; preserve Veyra `delivery/used=NOT_VERIFIED` semantics unless correlated with verified pre-stream artifact under approved rules. |

---

## 7. Required approvals

Before any implementation or runtime probe:

1. **CEO design approval** of this Phase 1.7 schema, controls, and proof-level limitations.
2. **CEO implementation authorization** (separate) if DSH-side instrumentation is chosen — including target package/repo, change scope, tests, and release/versioning plan.
3. **Security/privacy review approval** for no-raw defaults, opt-in/isolation, retention, secret exclusion, and artifact storage.
4. **CEO authorization for isolated runtime verification** (separate) — dedicated `DSH_HOME`/`VEYRA_HOME`, throwaway profile/workspace, no existing DSH Web/profile/authoritative DB.
5. **Model/API execution authorization** (separate) only after non-model preflight and delivery-evidence preflight pass.
6. **Protocol approval** for attribution labels, baseline/treatment parity, task re-qualification (Issue #3 historical only), and evidence retention/deletion.

No approval above authorizes modifying or restarting the existing DSH Web/profile.

---

## 8. Final verdict

**`NOT_READY`**.

**Reasoning:** The smallest *safe design* is identifiable — a DSH-side, opt-in, isolated, no-raw, bounded-retention **pre-stream admission evidence** artifact at the `stream(request)` boundary, with explicit proof-level labels — but it is **not implemented, not security-reviewed as code, not versioned/released, and not verified in an authorized isolated runtime**. Existing supported surfaces still cannot provide direct pre-stream delivery proof, and no surface can provide model-receipt or agent-application proof by presence alone.

**Not granted:** `READY_FOR_IMPLEMENTATION_APPROVAL`. Implementation may become approvable only after CEO design approval, security/privacy approval, and a separately authorized minimal DSH implementation plan with isolated verification criteria.

*Stop condition met: report delivered; no instrumentation implemented; no experiments executed.*
