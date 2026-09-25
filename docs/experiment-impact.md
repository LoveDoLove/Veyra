# Phase 6 — Engineering Impact Experiment

**Author:** session (auto-generated)
**Date:** 2026-09-25
**Veyra version:** `@lovedolove/veyra@0.1.14` (`1c17f70`, main)
**Workspace:** `/home/lovedolove/projects/Veyra`
**Model (intended, both arms):** `omniroute/free-stack`
**Store source:** `$DSH_HOME/veyra/projects/p_2d599165fe7aa1a7/memory.db` (real project store; no fake memories seeded)
**Status:** **BLOCKED at time of write** — Baseline could not be isolated via `recallLimit: 0` (runtime coerced `0` → `5`; retrieval floored `limit` to `1`). The Settings & Runtime Configuration milestone fixes those product bugs (`normalizeRecallLimit` keeps explicit `0`; `hybridRetrieve` short-circuits at `limit === 0`). Phase 6 itself was **not** run here. After live Settings can set `recallLimit: 0` without touching this Web profile, re-verify empty automatic context, then execute the frozen paired tasks.

---

## Objective

Measure whether Veyra's Engineering Graph context changes coding-agent quality on **real implementation tasks** in this repository. Null result is acceptable. Do not manufacture memories or alter Veyra to improve the outcome.

## Hypothesis

- **Veyra arm:** same prompt, model, workspace, tools, starting repo state; normal Veyra context injection (`systemPrompt.section` + `systemPrompt.context` via `createContextProvider` → `buildRecallContext` → `recall` with `limit: runtime.recallLimit`).
- **Baseline arm:** identical except Veyra **context is suppressed** by `recallLimit: 0`.

If the arms differ measurably (correctness ↑, architecture/constraint violations ↓, unnecessary changes ↓, rework turns ↓), that supports Veyra utility. If not, the conclusion is "no difference" or "hurts". Repository truth remains the scoring authority.

---

## Isolation verification (`recallLimit: 0`)

Verified 2026-09-25 against **repository code** and a **live Node probe** of the real project store. No DSH Web process, port, profile, or config was changed.

### Product code

`createRuntime` treats non-positive `recallLimit` as unset:

```js
// src/plugin.mjs:79
recallLimit: Number(config.recallLimit) > 0 ? Number(config.recallLimit) : DEFAULT_RECALL_LIMIT
```

`DEFAULT_RECALL_LIMIT` is `5` (`src/types.mjs:69`). Therefore plugin config `recallLimit: 0` becomes `5`.

Even if a caller bypasses `createRuntime` and passes `limit: 0` into retrieval, `hybridRetrieve` still floors the slice:

```js
// src/retrieve.mjs:282
const limited = ranked.slice(0, Math.max(1, limit))
```

`buildRecallContext` then injects whatever `recall()` returned; it only returns `''` when `records.length === 0` (`src/context.mjs:119`).

### Live probe (same store this session uses)

| Input | Result |
| --- | --- |
| `createRuntime` coerce `0` / `-1` / `''` / `undefined` | all become `5` |
| `hybridRetrieve({ limit: 0 })` | **1 record**, not 0 (`vey_1a0d4037c37_1b752f39d747`) |
| `buildRecallContext({ limit: 0 })` | **678 chars**, not empty; contains that `vey_…` id |
| `hybridRetrieve({ limit: 5 })` / default | 5 records, 2598-char prompt |

So `recallLimit: 0` **does not suppress Veyra context**. Both intended arms would receive recalled records.

### Paths that would isolate Baseline — all forbidden by this run

| Candidate | Why it is not allowed |
| --- | --- |
| Honor `0` in `createRuntime` / remove `Math.max(1, limit)` | Redesigns Veyra to make the experiment possible |
| Set `VEYRA_HOME` to an empty dir on this Web process | Profile / env / config change on the running DSH Web |
| Disable or uninstall `@lovedolove/veyra` in the `web` profile | Profile / config change; would also drop tools/skills/`/veyra` |
| Boot stock `headless` (no Veyra installed) | Different profile and a different tool surface (no `veyra_*`, no guidance section). Also a profile switch the run forbade as a substitute for `recallLimit: 0` |
| Start a second DSH Web / change ports | Explicitly forbidden |
| Seed empty memories / forget eligible records | Manufactures or alters the store to improve the experiment |

**Blocker:** `recallLimit: 0` cannot isolate Baseline without touching DSH Web or changing Veyra. Per the run constraint, **stop here. Do not run the five paired tasks.**

Architecture open question #2 is **not** updated: there is no measured paired result.

---

## Frozen protocol (tasks locked before any arm ran)

The five tasks below were frozen **before** any Baseline/Veyra coding arm was executed. They are real implementation tasks in this repo, not theoretical Q&A. They were **not run**, because isolation failed.

Shared constraints for every task (both arms, if a future run unblocks isolation):

- Workspace: `/home/lovedolove/projects/Veyra` at `1c17f70` (clean `src/`, untracked protocol doc only).
- Same prompt text, same model (`omniroute/free-stack`), same tools, same starting tree.
- Do not bump `package.json` version from `0.1.14`.
- Do not touch SmartTrip. Do not redesign Veyra. Do not add Neo4j / a second store / new relation types / new node types.
- Score against repository truth (`src/`, `test/`, `docs/architecture-graph.md`, git), not against recalled text.
- Restore the tree between arms (or work on a throwaway branch / revert) so arm 2 starts from the same files.

### Task 1 — Graph node identity (implementation)

> Add a unit test (prefer extending `test/graph.test.mjs`) that `projectNode(record).id === record.id` for a stored row, that `localGraph` edge ids are exactly `` `${fromId}:${type}:${targetId}` ``, and that the projection does not allocate a second identity for the same record. Do not introduce a new id helper, graph table, or Neo4j.

**Ground truth:** `src/graph.mjs` `projectNode` / `projectEdge`; `docs/architecture-graph.md` §4.1. Related memory (not truth): `vey_1a0d3f977ab_cb4b83b4b508`.

### Task 2 — Frozen architecture limits (implementation)

> Add a unit test that `VALID_RELATIONS` is exactly `updates|extends|derives|contradicts|supersedes` and that `GRAPH_LIMITS` keeps default `hops === 1` and `maxHops === 2`. Do not add relation types or raise the hop cap.

**Ground truth:** `src/types.mjs` `RELATIONS` / `VALID_RELATIONS`; `src/graph.mjs` `GRAPH_LIMITS`; Reject table in `docs/architecture-graph.md` §3. Related memory: `vey_1a0d3f977ab_cb4b83b4b508`, `vey_1a0d424749f_c7fe901f9939`.

### Task 3 — Project isolation (implementation)

> Add a unit test that `projectIdFor` of this Veyra checkout is not equal to `projectIdFor` of a temporary directory that is not this git root (different path / no shared remote). Assert the id matches `^p_[0-9a-f]{16}$`. Do not read, import, or modify SmartTrip.

**Ground truth:** `src/ids.mjs` `projectIdFor` = `p_` + sha256(`gitRoot|remote`)[:16]. Isolation is a hard boundary. Related memory: project `p_2d599165fe7aa1a7` vs other project dirs under `$DSH_HOME/veyra/projects/`.

### Task 4 — `/veyra` rawInput remainder (implementation)

> Tighten or add a test that `handleVeyraCommand` prefers `invocation.rawInput` so `rawInput: 'observatory overview'` reaches the overview branch even when `text` / `input` / `args` are empty. Do not rename the DSH field and do not break the older fallbacks.

**Ground truth:** `src/commands.mjs:50` (`rawInput || text || input || args`); existing coverage in `test/plugin.test.mjs` and `test/graph.test.mjs`. Related memory (1-hop pair): `vey_1a0d3da4138_8b2537d952f3` `extends` `vey_1a0d3d067ee_f0fdbc58dd94`.

### Task 5 — Document current `recallLimit: 0` behavior without changing it (implementation)

> Add a unit test that the **current** product behavior is: a runtime built the same way as `createRuntime` with `recallLimit: 0` uses `DEFAULT_RECALL_LIMIT`, and `hybridRetrieve({ limit: 0 })` still returns at least one eligible record when the store is non-empty. **Do not change** `src/plugin.mjs` or `src/retrieve.mjs` to honor zero. This task is the null/control: Veyra context may tempt an agent to "fix" the no-op.

**Ground truth:** `src/plugin.mjs:79`; `src/retrieve.mjs:282`; `src/types.mjs` `DEFAULT_RECALL_LIMIT`. This file's isolation section is the measured evidence that the no-op is real.

---

## Scoring rubric (per task × arm) — unused this run

| Criterion | How measured |
| --- | --- |
| Correctness | Tests pass; assertions match repository contracts |
| Architecture / constraint violations | Flag Neo4j, second store, new relations, hop-cap raise, version bump, SmartTrip edits |
| Unnecessary changes | Diff outside the named test file / required assertion |
| Rework turns | Follow-up corrections needed to match ground truth |
| Veyra context | Record ids actually injected (Veyra arm) vs empty context (Baseline) |
| Timing | Wall-clock if available; secondary |

**Verdict per pair:** helps / no difference / hurts.

## Paired results

| Pair | Baseline | Veyra | Verdict |
| --- | --- | --- | --- |
| Task 1 | **not run** | **not run** | n/a — isolation blocked |
| Task 2 | **not run** | **not run** | n/a — isolation blocked |
| Task 3 | **not run** | **not run** | n/a — isolation blocked |
| Task 4 | **not run** | **not run** | n/a — isolation blocked |
| Task 5 | **not run** | **not run** | n/a — isolation blocked |

No arm logs. No memories manufactured. No `src/` changes.

---

## Store richness at freeze time

Live list of `$DSH_HOME/veyra/projects/p_2d599165fe7aa1a7` (2026-09-25):

| Metric | Value |
| --- | --- |
| Project records listed | 54 |
| Recall-eligible | 25 |
| Forgotten | 1 |
| Reusable records | 0 |
| Relation types present | `extends`, `updates`, `supersedes` |
| `contradicts` edges | 0 |
| Eligible→eligible hop used by Task 4 | `vey_1a0d3da4138_8b2537d952f3` `extends` `vey_1a0d3d067ee_f0fdbc58dd94` |

Machine dump: `/tmp/veyra-phase6/store-snapshot.json`.

---

## Architecture Q2

`docs/architecture-graph.md` §8 question 2 ("Does 1-hop measurably help live DSH tasks?") stays **open**. Updating it requires a measured paired result. This run produced a **protocol + isolation blocker**, not an impact measurement.

---

## File policy

- `docs/experiment-impact.md` ← this file (frozen protocol + blocker)
- **No changes to:** `src/`, `test/`, `package.json`, SmartTrip, DSH Web, `cordis.patch.yml`
- Do not commit or push automatically
- Do not bump `0.1.14`

---

## What a later run must do to unblock

1. Product change (out of scope here): make `recallLimit: 0` mean "inject nothing" in `createRuntime` **and** stop flooring `hybridRetrieve` at 1 — then re-verify with the same live probe.
2. Or an explicit user waiver to isolate Baseline by a non-`recallLimit` method (empty `VEYRA_HOME`, Veyra-less profile) **without** treating that as a DSH Web / redesign violation.
3. Then execute the five frozen tasks above, score helps / no difference / hurts, and only then edit architecture Q2.
