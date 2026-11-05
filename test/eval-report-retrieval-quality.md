# Veyra Retrieval Quality & Applicability Evaluation - Final Report

**Date**: 2026-11-04
**Baseline**: origin/main @ 83a44f9 (chore(release): v0.1.69)
**Fixture**: isolated git "stockctl v0.2.0" with planted double-deduct bug (src/warehouse.mjs); temp veyra homes A/B under os.tmpdir; the workspace path is carried in every tool call (exec.agent.session.header.cwd = FIX) so records land in the FIX project id.
**Reproduce**: node test/eval-retrieval-quality.mjs -> 5 PASS / 5 FAIL; the 5 FAIL are genuine Veyra-side retrieval-quality findings (D3.1 harness check-field bug fixed, now PASS). No Veyra source changes.

## 1. Reproducible, isolated evaluation cases

| Dim | Case | What it checks |
| --- | --- | --- |
| D1.1 | 4 memories exist (RC root-cause, SCHEMA, NEG, distractor) -> RC must rank #1 for its own precise root-cause query | retrieval relevance / top-k precision |
| D1.2 | zero-overlap query "kubernetes" -> irrelevance floor | whether hybridRetrieve returns an empty / distinguishable list when nothing matches |
| D2.1 | evidenced verified record vs no-evidence unsupported same-topic record | whether evidence quality participates in ranking |
| D3.1 | in-place anchored-file change -> category review_required | applicability: change_impact flags the record |
| D3.2 | file MOVE src/warehouse.mjs -> src/stock/warehouse.mjs | applicability under a path change (rename blindness) |
| D4.1 | buildRecallContext budget ladder [200..8000] -> two-tier render, whole-record truncation | context budget + retrieval efficiency |
| D5.1 | two mutually-exclusive root-cause records coexist, no silent merge | contradiction PRESERVATION |
| D5.2 | the two conflicting claims are proactively LINKED | contradiction DETECTION |
| D6.1 / D6.2 | arm A (with Veyra) vs arm B (empty store) | baseline comparison |

## 2. Precision@k / relevant retrieval

precisionAt1 = 1.0 (top-1 is in the relevant set {RC, SCHEMA, NEG})
precisionAt3 = 0.667
precisionAt5 = 0.60

Ordering for the root-cause query: [SCHEMA (rank1), RC (rank2), DISTR (rank3), ...]
Ordering for "why does warehouse stock drift low": [noEvidence-speculation (rank1), RC (rank2)]

Genuine finding: RC (the record carrying verified file+test evidence, confidence high) ranks #2 on BOTH its own precise query and the symptom query. precisionAt1 counts SCHEMA as "relevant" so it reads 1.0, but the record with the strongest evidence is not top-1.

## 3. False-positive / false-negative examples

FP - surface-term beats confidence (D1.1): a low-confidence distractor record containing the phrase "Unrelated to the stock drift" ranks ABOVE the high-confidence root-cause for a ['stock drift'] query. The pool is lexical-only (no embeddings in src/), so a meta-commentary phrase can outrank the true cause.

FP - no irrelevance floor (D1.2): the zero-overlap "kubernetes" query returns 5 records (the pool limit) instead of an empty/distinguishable list. This is the engine returning a best-effort candidate set even when nothing matches - the agent must filter noise it was told nothing exists for.

FN - rename blindness (D3.2): moving the file src/warehouse.mjs -> src/stock/warehouse.mjs (same content) makes change_impact report affectedMemories=[] because matching is on the literal path string in affectedAnchors. The record is still 100% applicable to the new path but is silently dropped from the affected set.

FN - no contradiction linking (D5.2): two root-cause records assert mutually-exclusive causes. Veyra correctly does NOT silently merge or pick an authority (count>=2, both visible), but contradictions=0 and no banner - the system never tells the agent these two conflict.

## 4. Applicability & contradiction handling

- D3.1 in-place anchored-file change: PASS - category=review_required, affectedAnchors=["src/warehouse.mjs"].
- D3.2 file move: FAIL - affectedMemories=[], category=null at the new path (path-literal, not content/graph-aware).
- D5.1 preservation: PASS - both conflicting records coexist and are returned; no silent merge/substitution.
- D5.2 detection: FAIL - contradictions=0, no banner; the conflict is never surfaced.

## 5. Baseline vs Veyra task outcomes

| Curve | arm B (no memory) | arm A (Veyra) |
| --- | --- | --- |
| context chars | 176 (empty-store marker) | 2364 |
| recall count | 0 | 3 |
| relevant root cause surfaced | no | yes (rank2) |
| disagreement surfaced | n/a | both records, but not linked |
| tokenCost (approx) | ~44 tok | ~591 tok |
| absence distinguished | yes ("No known engineering history") | n/a |

Verdict: Veyra reliably SURFACES the relevant memory when a real store exists (D6.1 PASS) and correctly DISTINGUISHES ABSENCE (D6.2 PASS). The weak point is RANKING QUALITY: evidence-bearing verified records lose to lexical, lower-confidence records (D1.1/D2.1), and there is no irrelevance floor (D1.2).

## 6. Prioritized implementation recommendation

Single highest-priority slice: evidence-aware ranking + contradiction digest in the retrieval pool.

Why:
- D1.1/D2.1/D1.2 are all ranking-quality defects that dilute which record the agent reads first. A bounded fix in src/retrieve.mjs (no new runtime dependency, no schema change, no new store) is to sort the pooled hybridRetrieve candidates by a composite evidence+confidence+lexical score, and to return an empty/distinguishable list when no candidate exceeds a relevance threshold.
- D5.2 is a low-risk, high-signal add: when two returned records carry same-topic, mutually-exclusive claims, attach a contradictions digest [{otherMemoryId, signal}] plus a "[Contradicts memory: <title>]" line. It is an informational digest - it does NOT merge, choose, or change authority.

Concrete work items:
1. src/retrieve.mjs: add evidenceScore(record) mapping validation tier (verified > derived/candidate) and confidence to a float; composite = evidenceScore + lexicalScore; sort before applying limit.
2. Add an irrelevance floor: if the top composite score is below a threshold, return [] plus a "No known engineering history" marker (matches the already-correct arm-B behavior).
3. contradictions digest: pair-wise text-overlap + negation hints among returned records, reusing existing jaccard/hasNegation primitives (no LLM call).
4. Regression tests: (a) RC ranks #1 on its precise query with the evidence gate; (b) zero-overlap query returns [] + marker; (c) two conflicting records yield a non-empty contradictions digest.

Reject / defer:
- Rename blindness (D3.2) needs content-graph awareness (path-move + hash), a larger indexing pass - defer.
- LLM-in-the-loop compression/dedup (OpenViking, tencentdb) - already rejected: nondeterministic, opposite of fail-closed.
- supermemory / dsh-world / dsh-memory autonomy subsystems - already rejected: no adoptable algorithm or wrong domain.

Re-measure: after the fix, rerun node test/eval-retrieval-quality.mjs; expected RC rank 1 (D1.1 PASS), empty+marker on pure zero-overlap (D1.2 PASS), RC #1 vs no-evidence same-topic (D2.1 PASS), non-empty contradictions digest (D5.2 PASS); D3.1 / D6.1 / D6.2 / D4.1 unchanged.

---
Generated from the isolated eval harness test/eval-retrieval-quality.mjs on origin/main @ 83a44f9. No Veyra source, architecture, trust boundary, or memory authority rules were modified; no version bump, commit, push, tag, npm publish, or release was performed.
