# Retrieval Effectiveness Goal

> Status: investigation and validation plan only. No runtime implementation is approved by this document.
> Baseline: `main` at `d08ea67f4380cb27072312227a317bc0e93035c7` (Veyra v0.1.71).

## 1. Product goal

Veyra is moving toward **Automatic Engineering Intelligence for Coding Agents**.

Its primary product outcome is not storing more records or exposing more tools. It is reliably delivering the small amount of historical engineering knowledge that materially helps the current coding task, at the point the agent can use it, without requiring the user to know what to search for.

**Retrieval effectiveness is the current product bottleneck to investigate.** Automatic delivery already has an implementation path: Veyra registers a dynamic `systemPrompt.context` provider (`src/plugin.mjs`) and builds a per-turn recall snapshot (`src/context.mjs`). The open question is whether the query and candidate-selection path consistently identifies the right knowledge for real tasks, and whether the delivered context is useful rather than merely present.

This goal does not turn Veyra into a session transcript, task tracker, autonomous coding agent, generic RAG service, or replacement for repository inspection.

## 2. User-visible outcome

For a task that can benefit from durable cross-session engineering knowledge:

1. Veyra uses the current project identity and available turn context to retrieve relevant eligible records automatically.
2. The retrieved set prioritizes task-relevant knowledge, not merely recent or lexically adjacent records.
3. It preserves project isolation and distinguishes project-specific from reusable knowledge.
4. It preserves evidence, validation, authority, freshness, temporal validity, and contradiction signals.
5. It delivers a bounded, attributable context block without requiring a manual search prompt.
6. If there is no sufficiently relevant knowledge, it does not manufacture relevance; absence is explicit where appropriate.
7. The agent can inspect or explicitly search further when the automatic snapshot is insufficient.

Veyra remains advisory. Current repository code, tests, and explicit user instructions remain authoritative.

## 3. Current implementation — verified source map

The following is a source-based inventory, not a claim that every path is effective in real agent use.

| Concern | Current owner | Verified behavior |
| --- | --- | --- |
| Per-turn automatic entry | `src/plugin.mjs`, `src/context.mjs` | Registers a dynamic `systemPrompt.context` provider; context is composed and rendered for prompt assembly. |
| Query and retrieval | `src/context.mjs`, `src/retrieve.mjs` | Builds a recall snapshot and calls the existing retrieval path; inspect query derivation and candidate selection before proposing changes. |
| Candidate eligibility and ranking | `src/retrieve.mjs`, `src/types.mjs` | Applies eligibility/project scope and hybrid signals; ranking includes lexical, semantic, intent, evidence, validation, confidence, freshness, relationship/causal signals and rank fusion. |
| Intent | `src/intent.mjs` | Detects WHY / WHEN / HOW / ENTITY / GENERAL and reweights; intent does not grant authority. |
| Storage/search | `src/store.mjs` | SQLite + FTS5; project and reusable stores are separate. |
| Context quality and budget | `src/context.mjs` | Adds trust/evidence/contradiction/temporal framing and applies a bounded record-block character budget. |
| Code-aware retrieval | `src/code/retrieval.mjs`, CBM dependency | Combines Veyra memory with optional structural code facts; CBM remains a separate package. |
| Manual fallback | `src/tools.mjs` | Exposes explicit recall and inspection tools; these supplement, not replace, automatic context delivery. |

### Important distinction

Automatic prompt injection is already present. The product gap must not be described simplistically as “Veyra has no automation” or “the agent must always call a tool.” The investigation must determine whether the automatic query has enough task signal, whether retrieval returns the right records, and whether the final prompt context is actionable.

## 4. Evidence and known limitations

### 4.1 Existing evaluation harness

`test/eval-retrieval-quality.mjs` is a deterministic, isolated harness. It creates a fixture repository and temporary Veyra homes, uses the tool harness, and covers:

- D1 retrieval relevance and unrelated-query false positives.
- D2 evidence quality and ranking.
- D3 applicability when an evidence-anchored file changes or moves.
- D4 stale handling in rendered context.
- D5 visibility of conflicting root-cause claims.
- D6 a with-Veyra versus empty-store context comparison.

The harness writes `test/eval-retrieval-quality-results.json` by default. Any new run for this investigation **must** use `VEYRA_EVAL_WRITE_TRACKED=0` so committed or user-local evaluation artifacts are not overwritten. Preserve all existing local modifications.

### 4.2 Historical committed evaluation snapshot

The committed `test/eval-retrieval-quality-results.json` is timestamped 2026-11-05 and records four failures at that snapshot:

- D1.1: root cause ranked #3 rather than #1.
- D1.2: unrelated query returned five records rather than zero.
- D2.1: the evidenced root cause ranked below a same-topic record without evidence.
- D3.2: a moved evidence-anchored file was not detected in that harness run.

This is a historical artifact, not proof of v0.1.71 behavior. The v0.1.70 changelog records subsequent retrieval ranking / eligibility / zero-signal fixes and explicit rename-evidence support. Re-run the current harness against the current source before treating any of these as open defects. Do not silently rewrite the committed result or claim the old failures are still present.

### 4.3 Additional historical task evaluation

`test/eval-v0169-results.json` records a synthetic stock-idempotency task where a recalled root-cause memory ranked first and reduced the illustrated workflow from five investigation operations to two. The same snapshot also records failures in change-impact detection, contradiction count reporting, and write-gate accounting. This is useful as a task-shaped example, but it is not a controlled, current product benchmark and its measurements must not be generalized.

### 4.4 Test coverage

The repository already has focused retrieval, ranking, fusion, polarity, identifier, evidence, recall-budget, context, trust, provenance, and code-retrieval tests. Unit-test volume is not a substitute for an end-to-end measure of whether useful knowledge is automatically surfaced for representative engineering tasks.

## 5. Problem hypotheses to test — not conclusions

Investigate these in order. Do not assume any hypothesis is true until reproduced.

1. **Insufficient query signal:** the automatic context query may not represent the task's key entities, intent, file paths, symbols, error messages, or desired outcome.
2. **Candidate recall gaps:** useful records may not enter the candidate pool because of query terms, FTS tokenization, eligibility, scope, or retrieval-channel limitations.
3. **Ranking defects:** relevant records may be present but lose to weaker lexical matches, recency, unsupported records, or channel-fusion effects.
4. **Applicability mismatch:** a semantically relevant record may belong to another project, version, runtime, platform, or historical state.
5. **Context selection loss:** a useful record may rank well but be excluded by record-count or character-budget selection, or be rendered without the detail the task needs.
6. **Delivery timing / lifecycle mismatch:** prompt assembly may occur before enough task context exists, or the automatic snapshot may not refresh when the task evolves.
7. **Agent-use mismatch:** relevant context may be delivered but ignored, misunderstood, or overridden by stronger current repository evidence.

For every reproduced issue, record the exact layer, evidence, impact, and smallest plausible correction. Keep retrieval relevance separate from trust and applicability: a high similarity score must not confer authority or applicability.

## 6. Evaluation plan

### Phase 0 — Establish a current, reproducible baseline

Read the current source and tests at the pinned baseline. Record:

- commit SHA, package version, Node version, test command, and exact test counts;
- current automatic context query derivation and provider lifecycle;
- current retrieval pipeline stages, candidate-pool boundaries, and final ordering;
- current relevant test files and known skips/failures;
- the current result of the isolated retrieval-quality harness, written only to a temporary output path or with tracked writes disabled;
- whether the historical D1/D2/D3 failures still reproduce on v0.1.71.

Do not access the authoritative live DSH SQLite database, alter the live DSH home, restart or reconfigure DSH Web, or use live user memory as a benchmark fixture.

**Exit:** a verified source map and current baseline, with historical findings classified as reproduced, fixed, obsolete, or inconclusive.

### Phase 1 — Build task-shaped retrieval cases

Use a small, deterministic suite grounded in real engineering patterns, not only keyword toy examples. Include:

- exact error / identifier / symbol lookup;
- paraphrased root-cause and remedy lookup;
- “why was this design chosen?” decision lookup;
- negative knowledge (“what was tried and failed?”);
- related-file / path / module context;
- version- or runtime-specific constraints;
- stale or superseded knowledge;
- conflicting historical claims;
- unrelated tasks and zero-signal queries;
- same-topic records with different evidence quality;
- project isolation and reusable-memory boundaries.

Each case must define the task, expected relevant record IDs, acceptable alternatives, records that must not surface near the top, applicability constraints, and the reason each expected result matters.

Separate query retrieval tests from automatic prompt-injection tests. A manual `veyra_recall` success does not prove automatic context delivery works.

**Exit:** a compact, deterministic benchmark set with explicit expected outcomes and no dependence on the user's live store.

### Phase 2 — Measure the whole delivery path

For each task, capture:

- whether the correct knowledge is in the candidate pool;
- its final rank and top-K inclusion;
- precision@K and recall@K where relevance labels support them;
- reciprocal rank / rank of the first useful record;
- false-positive rate on unrelated tasks;
- applicable versus inapplicable / stale / contradicted record handling;
- whether the automatic context contains the useful record and its required attribution;
- context characters and approximate token cost;
- whether manual fallback search was required;
- task outcome in a controlled with-Veyra / without-Veyra comparison.

Report counts and denominators. Do not combine synthetic retrieval metrics with human task outcomes into one score. Do not set arbitrary numeric targets until the baseline and benchmark coverage are understood.

**Exit:** a clear diagnosis of whether failures originate in query construction, candidate generation, ranking, applicability/trust, context budgeting/rendering, delivery timing, or agent use.

### Phase 3 — Prioritize one smallest useful vertical slice

Rank only reproduced issues by user impact, confidence in root cause, expected measurable benefit, implementation risk, runtime cost, and maintenance cost.

Prefer improving an existing owner (`src/context.mjs`, `src/retrieve.mjs`, `src/intent.mjs`, or `src/code/retrieval.mjs`) over introducing another retrieval engine or service.

Before implementation, specify:
- the exact failure and reproduction;
- the owning module;
- the intended observable behavior;
- the regression test and benchmark case;
- effects on project isolation, eligibility, authority, evidence, freshness, contradiction visibility, latency, and context budget;
- explicit non-goals and rollback boundary.

**Exit:** one reviewable implementation proposal. This document alone does not authorize implementation.

### Phase 4 — Validate product impact

Only after an approved implementation:
- run focused regression tests and the full suite;
- rerun the same benchmark unchanged;
- compare before/after metrics and task outcomes;
- verify no trust, authority, isolation, or context-attribution regression;
- report failures and trade-offs, not only improvements.

**Exit:** evidence that the change improves useful automatic context delivery on the targeted task class without unacceptable regressions.

## 7. Success criteria

The product succeeds when representative tasks show that Veyra:

- automatically surfaces the correct durable engineering knowledge without a user-authored search query;
- avoids surfacing unrelated or inapplicable records as if they were useful;
- preserves evidence, provenance, trust, conflict, and project boundaries;
- stays within a predictable context and latency budget;
- reduces repeated investigation or manual retrieval in controlled task comparisons.

Track at least these measures independently:

| Measure | Meaning |
| --- | --- |
| Recall@K | Share of labeled relevant records retrieved in the top K. |
| Precision@K | Share of top-K records judged relevant to the task. |
| MRR / first-useful rank | How early the first useful record appears. |
| Irrelevant delivery rate | Unrelated records included in automatic context. |
| Applicability correctness | Whether scope, version, freshness, and conflict constraints are respected. |
| Automatic useful-context rate | Tasks where automatic context contains at least one genuinely useful, applicable record. |
| Missed-context rate | Tasks with known relevant memory that automatic delivery fails to surface. |
| Manual retrieval fallback rate | Tasks requiring an explicit search because automatic context was insufficient. |
| Context cost / latency | Characters or tokens delivered and time spent in the retrieval path. |
| Task efficiency | Difference in repeated exploration / operations / time in controlled paired tasks. |

Do not optimize for a high recall count by flooding the prompt. Do not optimize precision by suppressing useful contradictions or by hiding the absence of knowledge. Do not treat agent acceptance as proof that a memory is true.

## 8. Non-goals and guardrails

- No runtime code changes in Phases 0–2.
- No new database, embedding service, external model call, dependency, daemon, scheduler, schema field, or second retrieval engine without measured evidence and a separate decision.
- No automatic promotion to canonical authority.
- No automatic merge, deletion, invalidation, or lifecycle transition as part of retrieval.
- No change to repository source files or live DSH state.
- No DSH Web stop, restart, second instance, port change, or profile modification.
- No access to authoritative live SQLite data for benchmark setup.
- No overwriting committed or local evaluation artifacts; use `VEYRA_EVAL_WRITE_TRACKED=0`.
- No commit to `main`, tag, npm publish, or release as part of this investigation.
- Preserve all user-local modifications and unrelated work.

## 9. Immediate next action

Execute **Phase 0 only**: inspect the current source and relevant tests, run the isolated retrieval evaluation with tracked artifact writes disabled, and produce a concise evidence report. Do not proceed to Phase 1 or change code until the Phase 0 baseline is reviewed.
