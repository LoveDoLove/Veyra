# Phase 1.5 — Experiment Infrastructure Readiness

**Status:** Read-only investigation + approved documentation only (no infrastructure implemented, no experiment executed)  
**Date:** 2026-11-07 (Asia/Singapore)  
**Repository:** `/home/lovedolove/projects/Veyra`  
**Target release:** Veyra `v0.1.72` (current `main`/`package.json` 0.1.72)  
**Objective:** Assess infrastructure readiness to validate Veyra's core value: **Coding Agents automatically learn from engineering experience and correctly apply that knowledge in subsequent tasks.**

## 0. Scope, constraints, and evidence boundaries

- **Performed (read-only):** inspected surviving repository artifacts (`RETRIEVAL-EFFECTIVENESS-GOAL.md`, `docs/experiment-impact.md`, `docs/research/phase1-readiness-closure-report.md`, Veyra source/tests/docs), Veyra v0.1.72 observability/config code (`src/apply-generation-evidence.mjs`, `src/context.mjs`, `src/config.mjs`, `src/ids.mjs`, `src/tools.mjs`, `src/health.mjs`, `src/plugin.mjs`, `src/retrieve.mjs`), installed DSH CLI help (`dsh --help`, `dsh headless --help`), DSH `profile-boot`/`system-prompt` type surfaces in the installed package, and existing in-process test composition patterns (`test/dsh-runtime.test.mjs`, `test/plugin.test.mjs`). Created only this report under approved scope.
- **Not performed:** no source/dependency/test/configuration/runtime changes; no experiment execution; no model/API calls; no DSH Web stop/restart/disable/reconfigure; no modification of existing DSH profile or authoritative runtime DB; no Git staging/commit/push/tag/release. Existing modified/untracked files preserved.
- **Evidence labels:** **Verified** = directly observed in code/types/help/docs in this investigation. **Inferred** = plausible from observed surfaces but not runtime-verified here; must not be treated as fact. **Unverified** = requires separate authorized runtime validation.

## 1. Isolated experiment environment

### 1.1 Verified DSH/Veyra capabilities relevant to isolation

| Capability | Verified evidence | Relevance |
|---|---|---|
| DSH profiles | `dsh [--profile] <name>` boots a profile under `$DSH_HOME/profiles`; `--patch` overlays; `--from-default-profile`; `dsh headless` runs as `--profile headless` and exits. | Separate profile/home could isolate experiment state from the active Web profile, but profile creation/mutation must not touch the existing profile/authoritative DB. |
| DSH home resolution | DSH CLI imports `resolveDshHome()` (`lib/bin.js`); startup/log paths reference `DSH_HOME/logs`; profile boot resolves home-level patch (`$DSH_HOME/cordis.patch.yml`) per call. | **Inferred:** a separate process with an isolated `DSH_HOME` can use an isolated DSH home. **Unverified** without authorized runtime probe. |
| Headless controlled runs | `dsh headless --json` emits newline-delimited run events to stdout; supports `--session-id`, `--permission-mode`, `--approval-policy`, `--add-dir`. | Useful for controlled single-Harness execution capture **if** run with isolated home/config and no model/API calls during this phase; execution itself requires separate authorization. |
| Veyra storage isolation | Veyra resolves home via `resolveVeyraHome`: `config.home` > `VEYRA_HOME` > `DSH_HOME/veyra` > `~/.dsh/veyra` (`src/ids.mjs:33-41`). Project DB path is `veyraHome/projects/<projectId>/memory.db`; reusable `veyraHome/reusable/memory.db` (`src/ids.mjs:109-115`, `src/store.mjs`). Project identity hashes resolved workspace + git remote (`src/ids.mjs`). | Veyra data can be isolated by `VEYRA_HOME` and/or isolated `DSH_HOME`, plus isolated workspace/repo state as needed. |
| Veyra baseline arm control (code) | `normalizeRecallLimit` preserves explicit `0` (`src/config.mjs:26,78-83`); `createContextProvider` short-circuits when `limit===0` (`src/context.mjs:806,833`); `retrieve.recall` returns `[]` when `limit===0` (`src/retrieve.mjs:1167`). Plugin registers `systemPrompt.context` `veyra:recall` order 200 (`src/plugin.mjs:264-267`). | Baseline can disable automatic recall in code; **live effective DSH settings/runtime isolation remains unverified**. |
| In-process deterministic harness | Existing tests compose Cordis + real DSH host services in-process with temp homes/workspaces (`test/dsh-runtime.test.mjs`, `test/plugin.test.mjs` use `mkdtempSync`, temp `VEYRA_HOME`/profile dirs, `createRequire`). | Supports deterministic infrastructure/behavior checks without full DSH Web boot, but does not by itself prove live DSH Web/headless delivery to a model. |

### 1.2 Isolated environment options

| Option | Description | Pros | Cons / risks | Verdict |
|---|---|---|---|---|
| **A. Isolated DSH home + separate headless profile/process** | Run `dsh --profile headless` (or controlled profile) in a process with `DSH_HOME` set to a fresh temp/experiment directory; point Veyra to isolated `VEYRA_HOME` or allow it under that home; use isolated workspace. | Closest to real DSH runtime; can exercise plugin/context registration path; avoids existing Web/profile. | Requires separate authorization for runtime probe/execution; profile/state initialization behavior under fresh home is **unverified**; must ensure no writes to existing `~/.dsh` or authoritative DB; model/API calls only if later authorized. | **Recommended primary approach** for real-runtime validation, subject to isolated preflight. |
| **B. In-process Cordis/DSH-service composition (test-harness style)** | Compose Veyra plugin with real DSH host service packages in-process using temp dirs, similar to `test/dsh-runtime.test.mjs`/`test/plugin.test.mjs`. | No DSH Web; deterministic; easy to control `VEYRA_HOME`/workspace; no existing profile mutation. | May not prove end-to-end headless/Web delivery, session persistence, or actual model-visible prompt admission; composition must mirror real registration carefully. | **Recommended for infrastructure preflight and observability checks** (non-model), not sufficient alone for end-to-end core-value claim. |
| **C. Use existing DSH Web/profile** | Run in current environment. | None for isolation. | Violates constraints (no existing profile/authoritative runtime DB modification; no DSH Web reconfig/stop/restart risk). Contaminates evidence. | **Rejected**. |

### 1.3 Recommended approach

Use a **two-layer isolation plan**:

1. **Layer 1 — Deterministic preflight (no model calls):** in-process composition or isolated non-network harness checks in temp `VEYRA_HOME`/workspace to verify Veyra config normalization (`recallLimit:0`), context provider behavior, generation evidence recording, `veyra_health`/feedback linkage semantics, and project isolation. This can be run only under separately authorized, non-destructive execution scope; this Phase 1.5 does **not** execute it.
2. **Layer 2 — Isolated runtime execution (separately authorized):** run controlled single-Harness headless tasks with `DSH_HOME`/`VEYRA_HOME` pointed to fresh isolated directories, isolated workspace/repo snapshot, explicit model/permission/tool settings, and no access to existing DSH profile/DB/Web. Capture JSON run events/artifacts as available. Any model/API call requires explicit execution authorization.

## 2. Treatment/baseline isolation design

| Dimension | Treatment | Baseline | Evidence required before execution |
|---|---|---|---|
| Veyra automatic recall | Enabled; `recallLimit > 0` (default 5 unless logged). | Disabled; `recallLimit == 0`. | Effective config snapshot per arm; `veyra_health`/context behavior confirms no automatic recall in baseline (**Unverified live**). |
| Plugin/environment | Same Veyra version (`v0.1.72`), same isolated DSH home/profile template, same plugin enablement state except intentional setting under test. | Same. | Isolated environment manifest; no existing profile/DB touched. |
| Workspace/repo state | Identical commit/snapshot per task pair. | Identical. | `git rev-parse HEAD` or snapshot hash; diff of allowed fixture inputs only. |
| Model/tool/permissions | Identical and logged. | Identical and logged. | Run manifest; `dsh headless` options/session metadata where available. |
| Veyra memory state | Predeclared seed manifest (evidence-backed) or empty; same starting state policy across arms unless the arm difference is the memory being tested and that is explicitly designed. | Predeclared; if baseline tests “no memory”, seed may differ only by authorized design and must be logged. | Seed IDs/hashes/inspect output; no fabricated memories. |
| Session contamination | Fresh isolated session/context per arm run. | Fresh isolated session/context. | Session IDs/logs; no reuse of treatment-visible context. |
| Veyra mutation during task | No manual `veyra_remember/promote/forget/feedback` unless symmetrically allowed and logged. | Same restriction. | Tool-call log/review. |

**Hard isolation rule:** the only intended causal differences must be explicitly declared (normally automatic recall availability and/or predeclared memory state). Any other difference is a confound and forces `inconclusive` or rerun only if separately authorized.

## 3. Generated / Delivered / Applied / Outcome evidence design

Do **not** infer delivery from generation, or application from delivery.

### 3.1 GENERATED

**Definition:** Veyra produced recall/context-generation output for the relevant invocation.

| Evidence source (v0.1.72, verified) | What it proves | What it does not prove |
|---|---|---|
| `veyra_apply_generation_v1` / `recordGeneration` (`src/apply-generation-evidence.mjs`) statuses `generated`, `generated_empty`, `generation_error` | Veyra-local generation completion occurred (or empty/error) with bounded metadata: `queryClass`, `queryChars`, `resultCount`, bounded `recordRefs` (id/scope/surface), `renderedChars`, `charBudget`, scope, `providerMs`; one completion event/invocation semantics. | Not DSH admission, not model receipt, not use. |
| `veyra_health` `applyGeneration` summary (`src/health.mjs`, `src/tools.mjs`) | Read-only aggregate/recent generation visibility. | Same limitations. |
| Context provider short-circuit at `recallLimit:0` (`src/context.mjs`) | Baseline should not generate automatic recall context; generation evidence may record empty/error/none depending path. | Live runtime behavior still **unverified**. |

**Minimum GENERATED evidence:** for treatment positive cases, a captured `generated` event (or explicit `generated_empty` with reason) attributable to the run; for baseline `recallLimit:0`, evidence consistent with no automatic recall generation/context.

### 3.2 DELIVERED

**Definition:** The generated memory/context was actually included in the Agent/model's available input for the target step.

| Candidate method | Status | Assessment |
|---|---|---|
| P1 Stage A `delivery.status` | **Verified always `NOT_VERIFIED`** (`stage-a-local`, `src/apply-generation-evidence.mjs`) | Cannot be used as DELIVERED proof. |
| DSH `systemPrompt.context` registration (`veyra:recall`, order 200) | **Verified registration** | Proves capability/path exists, not per-step admission. |
| DSH `system-prompt` assembly/render types (`assemble`, `PromptAssembly`, `renderContextSections`/`renderContextSnapshot`, `joinContextSections`) | **Verified type surface in installed package** | **Inferred potential:** an authorized isolated runtime diagnostic using supported APIs might expose assembled/snapshot sections. **No delivery/admission/model-receipt callback/API evidenced**; not runtime-verified; may require host cooperation or unsupported internals — do not invent APIs. |
| `dsh headless --json` run events | **Verified CLI option exists** | **Unverified** whether events include assembled prompt/context content or only lifecycle/output events. Must be checked only in isolated authorized runtime. |
| Operator-visible prompt payload / DSH diagnostic export | **Unverified** | Acceptable only if produced by a supported DSH/runtime mechanism in an isolated authorized environment; otherwise unavailable. |

**Minimum DELIVERED evidence:** a supported runtime artifact showing the Veyra context contribution (or attributable equivalent) was present in the assembled model-facing input for the target step. If unavailable, record **DELIVERED = NOT_VERIFIED** and limit conclusions accordingly.

### 3.3 APPLIED

**Definition:** The Agent demonstrably used the memory during task execution (the memory influenced a decision/action/output).

| Evidence source | Status | Assessment |
|---|---|---|
| P1 Stage A `used.status` | **Verified always `NOT_VERIFIED`** | Cannot be used as APPLIED proof. |
| Explicit `veyra_apply_outcome_link_v1` with valid retained `generationEventId` (`src/apply-generation-evidence.mjs`, `src/tools.mjs`) | **Verified capability** | Proves explicit operator/tool linkage intent only when supplied; **non-causal/non-inferential**. Useful as supporting metadata, not sufficient alone. |
| `veyra_feedback` optional `generationEventId` | **Verified** | Same: explicit linkage only. |
| Decision trace in transcript/log citing record ID/fact + consistent diff/test behavior | Method, **Unverified availability** in target runtime until capture plan is authorized/tested | Strongest practical application evidence if captured; requires careful attribution and alternative-explanation review. |

**Minimum APPLIED evidence:** a traceable chain: specific recalled fact/record ID referenced or clearly reflected in decision trace, and resulting code/test behavior consistent with that fact, with confounds considered. Optional explicit linkage may supplement but not replace traceability.

### 3.4 OUTCOME

**Definition:** The application (or task execution) produced a measurable engineering result.

| Evidence | Examples | Notes |
|---|---|---|
| Repo-truth acceptance tests | pass/fail counts, specific assertions, commands run | Primary objective signal. |
| Correctness/constraint checklist | respects architecture limits, isolation, API contracts, no unnecessary files | Prevents “tests pass but wrong change”. |
| Diff/rework metrics | files changed, unnecessary edits, follow-up corrections/turns | Compare arms per task. |
| Safety checks | no secret leakage, no fabricated memory, no protected-scope mutation | Mandatory guardrails. |

**Minimum OUTCOME evidence:** per-arm test command(s) + results + diff summary + constraint checklist + verdict (`helps`/`no difference`/`hurts`/`inconclusive`).

## 4. Existing v0.1.72 capabilities and remaining gaps

| Area | Existing v0.1.72 capability (verified) | Remaining gap |
|---|---|---|
| Baseline control | `recallLimit:0` preserved/short-circuited in config/context/retrieve. | Live DSH runtime/effective-settings isolation unverified. |
| Generation observability | P1 Stage A `veyra_apply_generation_v1`, bounded metadata, statuses, `recordRefs`, `veyra_health` summaries. | No per-step model-prompt admission proof; generation can occur without delivery. |
| Outcome linkage metadata | `veyra_apply_outcome_link_v1` + `veyra_feedback` optional explicit `generationEventId`. | Explicit only, caller-supplied, non-causal; unavailable unless ID retained and intentionally linked. |
| Storage isolation | `VEYRA_HOME`/`DSH_HOME`/config.home resolution; project/reusable DB paths; project identity hashing. | Isolated runtime profile/home behavior under DSH CLI unverified. |
| Controlled run surfaces | `dsh headless --json` and headless options exist; in-process test harness patterns exist. | Event/content payloads for delivery evidence unverified; model/API execution not authorized in this phase. |
| DSH prompt assembly | Veyra registers `systemPrompt.context`; DSH system-prompt types expose assemble/render APIs. | No evidenced delivery/admission/model-receipt/use callback; using internals would risk unsupported assumptions. |

## 5. Minimum prerequisites for safe experiment execution

1. **CEO-selected, re-qualified tasks** with repo-truth oracles and memory-relevance rationale (Issue #3 historical only).
2. **Isolated environment authorized and created** (fresh `DSH_HOME`/profile/workspace/`VEYRA_HOME` as applicable), with proof no existing DSH Web/profile/authoritative runtime DB is touched.
3. **Non-model preflight passed** in isolated environment: config isolation, Veyra context/generation behavior, observability capture paths, and seed/state manifests.
4. **Authorized runtime preflight** (separate authorization) for live arm-control and, if possible, supported delivery-evidence capture; no model/API calls unless explicitly authorized.
5. **Execution protocol approved** with observability contract: how GENERATED/DELIVERED/APPLIED/OUTCOME will be captured; explicit `NOT_VERIFIED` handling where direct evidence is unavailable.
6. **Model/API execution authorization** (separate, explicit) if Coding Agent/model runs are used.
7. **Safety gates:** preserve unrelated local modifications/untracked files; no fabricated memories; no protected-scope mutation; redaction/secret checks; stop on confounds.

## 6. Risks, limitations, and verification criteria

| Risk / limitation | Impact | Mitigation / verification criterion |
|---|---|---|
| **DELIVERED not directly observable** (major) | Cannot prove end-to-end context admission; core claim weakened. | Pass only with direct supported runtime evidence, or explicitly report delivery `NOT_VERIFIED` and limit claim to generation/retrieval/application/outcome correlation. |
| **APPLIED attribution ambiguous** | Outcome may come from model priors/repo inspection, not memory. | Require decision trace + cited record/fact + consistent diff/tests + confound review; optional explicit linkage only supplemental. |
| **Live isolation unverified** (B2/B4 legacy) | Baseline/treatment contamination invalidates comparison. | Isolated runtime preflight must demonstrate intended difference and parity on other dimensions before execution. |
| **Fresh DSH home/profile behavior unknown** | Isolated runtime may fail or differ unexpectedly. | Preflight in temp DSH home; document exact bootstrap steps; no existing environment changes. |
| **Model nondeterminism/cost** | Results may vary; execution has external effects. | Controlled prompts/settings, repeated runs only if authorized, per-task reporting, explicit budget/approval. |
| **Issue/task staleness** | Frozen tasks may no longer match v0.1.72. | CEO re-qualification and oracle refresh before execution. |

**Verification criteria for future execution approval:**
- [ ] Isolated environment created and proven non-invasive.
- [ ] Arm-control preflight evidence captured.
- [ ] GENERATED evidence path validated.
- [ ] DELIVERED evidence path validated **or** explicitly accepted as `NOT_VERIFIED` with narrowed claim.
- [ ] APPLIED evidence rubric validated on at least one dry-run/example.
- [ ] OUTCOME oracles/tests prepared per selected task.
- [ ] Evidence retention/reproducibility manifest complete.

## 7. Final verdict

**`NOT_READY`**

Phase 1.5 infrastructure is **not ready for CEO execution approval**. Veyra v0.1.72 provides useful building blocks (code-level `recallLimit:0` baseline control, P1 Stage A generation evidence, explicit outcome-link metadata, `VEYRA_HOME`/DSH-home-based storage isolation, DSH headless/profile surfaces, and in-process test harness patterns), but the minimum infrastructure for a credible core-value experiment is incomplete: **live isolated DSH runtime arm-control is unverified**, **DELIVERED cannot be independently proven from current Veyra-local evidence and no DSH delivery/admission callback was evidenced in inspected types**, **APPLIED remains attribution-dependent**, and **no authorized isolated runtime preflight/execution has been performed**. Execution approval should wait until prerequisites in §5 are satisfied (or explicitly narrowed with accepted `NOT_VERIFIED` delivery/use limitations).

