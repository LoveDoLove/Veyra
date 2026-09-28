# M11 — Recall Intelligence: Design Record

> Status: implemented and verified (2026-09-28)
> Baseline: `0.1.32` (`c2aebcd`); suite before: 337/337; suite after: 354/354
> Scope: recall selection only — `src/retrieve.mjs` plus `test/m11-recall-intelligence.test.mjs`
> Non-goals: embeddings, vector store, reranker, LLM judge, graph DB, remote services, migrations

## 1. Concrete problems demonstrated

All findings are evidence from probes (p1–p15) run against the actual code path
`plugin.mjs → buildRecallContext → recall → hybridRetrieve → rankRecords → compose/render`,
and from the deterministic benchmark (`0.1.32` vs candidate, 7 scenarios, 5 runs each).

1. **Metadata-only contamination.** A record with ZERO textual signal for the
   query (`relevance = 0 AND semantic = 0`) but perfect metadata — verified,
   fresh, high confidence, `test-passed` evidence, causal facets — composes
   ~0.80 and outranks a record that genuinely matches the query with weak
   metadata (0.776). Benchmark s1: baseline returns
   `PERFECT_META@0.804, GENUINE@0.776`; candidate returns `GENUINE, PERFECT_META`
   with **both composites byte-identical**. Benchmark s2 shows the same
   crossover with a zero-signal record at 0.684 beating a weak-but-real match
   at 0.6606.
2. **Redundant context.** Three wordings of one fact occupied 3 of 4 recall
   slots (probe p9); no stage in the pipeline ever compared two selected
   records against each other. Benchmark s3: baseline
   `NEAR1, NEAR2, NEAR3, ROLLBACK` (2 distinct facts, 931 rendered bytes) →
   candidate `NEAR1, ROLLBACK, OTHER` (3 distinct facts, 724 bytes).
3. **Measured but NOT demonstrated as harmful** (see §10): budget overflow past
   `limit`, `last_recalled_at` feedback having zero ranking effect, intent
   regex coverage gaps, weight sums 1.14–1.28.

## 2. Mechanisms kept (verified unchanged)

FTS/BM25 candidate generation, recency pool, `isRecallEligible` lifecycle
filtering, project isolation gate, kind filter, intent detection and affinity,
evidence/validation/freshness/proximity/confidence scoring tiers, relationship
cohesion, contradiction annotation and the "never hide one side" extras loop,
graph neighbor expansion (cap 4), polarity cap, `limit === 0` short-circuit,
`touch()` recency write, context composition/rendering, fail-closed provider.

## 3. Mechanisms modified (two small deterministic changes)

**A. Zero-signal demotion tier** — sort-only constraint in `rankRecords`,
active only when the query is non-empty: records with
`relevance > 0 || semantic > 0` form tier 1 and sort above tier 0; within a
tier the comparator is unchanged (composite, then polarity sort key). No score
is mutated — the same precedent as the polarity cap. Empty query: every record
is tier 0 by construction, so the recency pool ordering is untouched.

**B. Near-duplicate suppression** — `suppressNearDuplicates` in
`hybridRetrieve`, between `annotateContradictions` and the top-K slice.
Greedy keep-first over ranked order; suppression iff all guards pass:
no relation in either direction, no annotated-contradiction link, equal
negation parity, ≥ 4 shared tokens, containment
`|A ∩ B| / min(|A|, |B|) ≥ 0.5` (threshold calibrated on p15: 6/8 same-fact
rewordings caught, 0/12 false positives, gap 0.429/0.571). Suppression is
selection-only: no scores, no lifecycle, no relations are modified.

## 4. Why these were necessary (and nothing else)

- A cannot be fixed by weighting: any fixed weight vector still lets a
  metadata-strong zero-signal record exceed a metadata-weak match. It must be
  a constraint on *which* records may be considered "better", which is exactly
  what a sort-only tier expresses — and it needs the query to exist at all,
  hence the `hasQuery` gate (recency browsing without a query has no
  relevance to be wrong about).
- B cannot be fixed by scoring: redundancy is a property of two *selected*
  records relative to each other, invisible to per-record scoring. p13 showed
  plain Jaccard cannot separate same-fact (0.571) from different-fact (0.429)
  pairs; containment in the measured gap can.
- Everything else investigated (weight renormalization, intent regex
  widening, `last_recalled_at` ranking feedback, adaptive K) lacked a
  demonstrated harmful case or would break existing pinned semantics (§10).

## 5. Lifecycle / authority / validation interaction

Suppression runs strictly **after** eligibility and isolation gating: an
ineligible record can neither be selected nor have a neighbor suppressed in
its favor; a suppressed record is still eligible and may be recalled by a
later, differently-shaped query (it is removed from *this* result only).
`forgotten/invalid/stale/candidate/observation` exclusion, `status === current`
and derived/canonical requirements are upstream and untouched — benchmark s4
and the lifecycle test both return exactly `["OK"]`. No lifecycle field is
read or written by either change.

## 6. Fail-closed behavior

Both changes are pure, synchronous, allocation-bounded transformations over
records already in memory — they add no I/O, no parsing of external input and
no new failure surface. The provider's existing try/catch still degrades to
`''` on any error, and `tokenize`/`claimText` operate on in-record strings.
Malformed relations (`relations` non-array, missing `targetId`) yield "not
related" — conservative: the pair is *kept*, never wrongly suppressed.

## 7. Project isolation

Candidate gating (`scope` + `projectId` identity) happens before ranking, so
the pool either contains only this project's records or deliberately shared
reusable records; suppression never crosses that boundary because it only
compares records already admitted. The focused test pins that a byte-identical
reusable copy of a project claim is suppressed in favor of the project record
(preferProject order) while distinct reusable knowledge is still recalled.

## 8. Explainability

- Scores stay verbatim: tests assert `composite === plain weighted sum of the
  record's own dimensional scores (intent weights)` — the tier adds nothing to
  the numbers, so every existing explanation of "why is this 0.74" holds.
- Suppression is auditable: a reviewer can recompute the decision from two
  records with the three constants (`0.5`, `4`, guards) quoted above, and the
  code comment cites the calibration evidence.
- Ordering remains deterministic: tier → composite → polarity key → input
  order; five identical benchmark runs and the 5-run determinism test agree.

## 9. Regressions prevented (tests + benchmark)

`test/m11-recall-intelligence.test.mjs` (17 tests): both crossover fixtures
(scores asserted unmodified), uniform-zero-signal recency order, empty-query
order, 5-run determinism, redundancy collapse + slot backfill + composed
context, relation/negation/short-claim guards, lifecycle exclusion,
project-isolation + reusable sharing, M8 provenance recall, `last_recalled_at`
write-without-rank-effect, intent classification, stable tie-breaking,
`limit: 0`, contradiction extras past the limit. Full suite **354/354, twice**;
benchmark **baseline vs candidate, deterministic in all 7 scenarios × 5 runs**.

## 10. Explicitly identified but deferred

| Finding | Evidence | Why deferred |
| --- | --- | --- |
| Recall can exceed `limit` (extras + graph) | graph.test:238 pins `limit: 1` overflow as intended | Deliberate invariant (never hide contradictions); adaptive budgets are a P2 proposal only |
| `last_recalled_at` has zero ranking effect | p6: freshness never reads it | A recall-feedback loop changes ranking semantics; no demonstrated harm, needs its own milestone and evaluation |
| Intent regex coverage gaps (e.g. "outcome of…" → general) | p4, but p10: 0/60 ordering flips | Only causal-facet affinity provably flips ordering, and that is already implemented |
| Weight sums differ per intent (1.14–1.28) | audit | Cosmetic: renormalizing would change every pinned composite (e.g. F4-E 0.684) for no behavioral gain |
| Zero-signal pool fills context when nothing matches | deliberate recency design; calibration test requires rows returned | Correct fallback; redundancy suppression still prevents waste there (clones collapse, distinct rows kept — benchmark s5) |
| Embeddings / vector index / reranker / LLM judge | — | Not needed: the demonstrated problems were solved with two deterministic in-memory mechanisms |
