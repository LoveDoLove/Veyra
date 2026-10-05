# Veyra Phase 11 — Measured Benchmark

All numbers below are **measured**, not asserted. They are produced by
`test/m15-benchmark.test.mjs` (29 tests, 45 dimensions) running the real
`src/` pipeline against purpose-built lifecycle, contradiction, and corruption
fixtures. Regenerate with:

```bash
node --test --test-reporter=spec test/m15-benchmark.test.mjs
```

The harness prints the same table it asserts on, so the document and the run
can never drift apart.

## How to read the numbers

Metrics are rates in `[0,1]` where **`1` is always the safe outcome**, except
for the four rows explicitly marked *(inverse)*, where `0` is the safe
outcome. Each row carries the observed evidence next to the number so a
regression can be read without re-running the suite.

`rate(hits, total)` returns **`null` for an empty denominator** rather than a
fabricated `0` or `1`. The `REPORT` test re-asserts that no measured row is
`null`. A dimension with no observable surface is therefore reported as a
**BLINDSPOT** in the table below — never as a passing score. There are
currently **no BLINDSPOT dimensions**; all 15 Phase-11 axes expose a directly
measurable surface.

## Measured table

| Dim | Metric | Value | Observed evidence |
|---|---|---|---|
| `D1` | write precision | **1** | accepted 4/4 durable claims |
| `D2` | false memory rate | **0** *(inverse)* | admitted 0/4 automatic noise records |
| `D3` | duplicate suppression | **1** | 5/5 restatements did not create a new row (rows 1 → 1) |
| `D3b` | false-merge rate | **0** *(inverse)* | distinct facts sharing a title were kept as 2 separate derived rows |
| `D4` | negative-memory recall | **1** | query matched 2 negative records; top = Raising the SQLite busy_timeout fixes the concurrent-put deadlock |
| `D4b` | negative top-1 accuracy | **1** | the busy_timeout rejection ranked first |
| `D5` | unresolved-memory recall | **1** | query matched 1 unresolved record |
| `D6` | negative idempotence | **1** | 4/4 re-falsifications were no-ops |
| `D7` | retrieval top-1 accuracy | **1** | 5/5 labelled queries hit their target first |
| `D8` | retrieval MRR | **1** | MRR over 5 labelled queries |
| `D9` | off-topic false signal | **0** *(inverse)* | 5 rows returned, 0 carrying non-zero query signal |
| `D9b` | off-topic recall suppression | **0** *(inverse)* | off-topic query returned 5 recency-pool rows, all at zero query signal |
| `D10` | applicability accuracy | **1** | 6/6 labelled context cases |
| `D11` | temporal correctness | **1** | 4/4 labelled temporal-window cases |
| `D12` | causal verified > suspected | **1** | verified causal 1 vs suspected 0.567 |
| `D13` | causal false signal | **1** | causal signal on an unrelated query = 0 |
| `D14` | contradiction detection | **1** | 1 pair found; health lists 1 |
| `D15` | contradiction visibility in recall | **1** | 2 contradicting records, all present in recall |
| `D15b` | contradiction precision | **1** | 0 false pairs over 3 unrelated records |
| `D16` | broken-evidence detection | **1** | broken-evidence demotion fired |
| `D17` | idle-memory detection | **1** | idle demotion fired |
| `D18` | stale leaves recall | **0** *(inverse)* | 1 row before demotion → 0 after |
| `D19` | evidence-health classification | **1** | 5/5 labelled cases |
| `D20` | feedback reliability | **0.4** | 2S/3F over 5 attempts — arithmetic identity, not a target |
| `D21` | validation demotion ladder | **1** | verified → reviewed → unverified |
| `D22` | success never self-verifies | **1** | after success validation = reviewed |
| `D22b` | canonical immunity | **1** | canonical after failure = verified |
| `D23` | recurrence detection | **1** | root-cause finding over 3 of 4 records |
| `D24` | recurrence eligibility | **1** | 2 findings, 1 root-cause, eligible = true |
| `D25` | recurrence precision | **1** | 0 findings for a single-occurrence root cause |
| `D26` | secret leak rate | **0** *(inverse)* | write flagged redacted; secret absent from title/body/tags/evidence/source |
| `D26b` | secret field coverage | **1** | bearer JWT scrubbed from body |
| `D27` | corruption flag rate | **1** | corrupt fields flagged: `["tags"]` |
| `D28` | corruption recall exclusion | **1** | 0 rows recalled; corrupted row not present |
| `D28b` | corruption health surfacing | **1** | `health.corruptedRecords = 1` |
| `D29` | corrupt-store refusal | **1** | refused with `Veyra refuses to open corrupted store: … (file is not a database)` |
| `D30` | injection detection | **1** | hostile signals `[ignore_previous, role_override]`; benign signals `[]` |
| `D30b` | injection false-positive rate | **0** *(inverse)* | ordinary engineering prose does not trip the detector |
| `D31` | automatic→canonical attempts | **0** *(inverse)* | automatic attempt → `DEFER (provenance-gated)`; write-path attempt → `DEFER (canonical-requires-explicit-promotion)` |
| `D31b` | explicit promotion | **1** | `promote(..., explicit: true)` → canonical |
| `D32` | cross-project leak rate | **0** *(inverse)* | 0 cross-project rows across 2 queries |
| `D32b` | project recall isolation | **1** | alpha 1, beta 1 |
| `D33` | reusable cross-project reach | **1** | 1 reusable row reachable from `proj-alpha` |
| `D33b` | reusable identity leakage | **0** *(inverse)* | no reusable row is relabelled as the querying project |
| `D33c` | `includeReusable=false` | **1** | 1 row with reusable excluded |

## Phase-11 axis coverage

Every one of the 15 dimensions GOAL.md requires has at least one measured
metric above.

| GOAL.md Phase-11 axis | Dimensions |
|---|---|
| write precision | `D1`, `D2` |
| duplicate suppression | `D3`, `D3b` |
| false memory rate | `D2`, `D25` |
| negative-memory recall | `D4`, `D4b`, `D6` |
| unresolved-memory recall | `D5` |
| retrieval relevance | `D7`, `D8`, `D9`, `D9b` |
| applicability accuracy | `D10` |
| temporal correctness | `D11` |
| causal retrieval quality | `D12`, `D13` |
| contradiction detection | `D14`, `D15`, `D15b` |
| stale-memory detection | `D16`, `D17`, `D18` |
| feedback effectiveness | `D20`, `D21`, `D22`, `D22b` |
| recurrence detection | `D23`, `D24`, `D25` |
| memory safety | `D19`, `D26`, `D26b`, `D27`, `D28`, `D28b`, `D29`, `D30`, `D30b`, `D31`, `D31b` |
| project isolation | `D32`, `D32b`, `D33`, `D33b`, `D33c` |

## What the numbers say about the invariants

The measured behaviour is the evidence for the design claims, so each claim
is tied to the metric that would collapse if it were violated.

- **Automatic ≠ canonical.** `D31` measures two separate automatic routes —
  the observe path (`provenance-gated`) and the write path
  (`canonical-requires-explicit-promotion`) — and both stop with a `DEFER`
  verdict rather than writing. `D31b` confirms the only surviving route is an
  explicit `promote(..., { explicit: true })`. Zero rows reached canonical
  automatically in this run.
- **Candidate ≠ truth.** `D2` admits none of 4 automatic noise records; `D21`
  shows failures demote validation verified → reviewed → unverified; `D22`
  shows a single success only reaches `reviewed`, never `verified`, and
  `D22b` shows canonical immunity.
- **Similarity ≠ authority / applicability.** `D1` and `D10` measure that the
  gate is durable-shape, not similarity; `D32`/`D33b` measure that similarity
  never crosses a project boundary.
- **Similarity ≠ applicability.** `D10` scores 6/6 labelled context cases, and
  `D11` scores 4/4 temporal windows — the two sort-only Phase-4 channels.
- **Contradictions stay visible.** `D14` finds the pair, `D15` keeps both
  sides in recall, `D15b` holds precision at 0 false pairs over 3 unrelated
  records. Detection is relation-driven, so it cannot invent a conflict.
- **Repository truth is authoritative.** `D16` demotes a record whose evidence
  file was deleted; `D29` refuses to open a structurally corrupt store rather
  than degrading to a partial read.
- **Memory is evidence, not instructions.** `D30` flags injected
  role-override and ignore-previous content, `D30b` stays at 0
  false positives on ordinary engineering prose.
- **Secrets are protected.** `D26`/`D26b` show the raw token absent from every
  persisted field while the `[REDACTED…]` placeholder keeps the claim readable.
- **Historical ≠ current.** `D18` measures that a demoted row leaves the recall
  pool entirely (1 → 0) instead of being quietly down-ranked.

## Removing complexity (Phase 11 rule)

GOAL.md Phase 11 ends with: *"Remove features that increase complexity without
measurable benefit or meaningful invariant improvement."*

No feature was removed, and this is the measured reason rather than an
assumption. A feature only qualified if it carried no observable effect in the
table above **and** no invariant depended on it. No row qualified on either
count: every Phase 1–10 capability is both load-bearing for a named invariant
and moves at least one number in this table. The harness itself is
test-only — Phase 11 added **zero** lines to `src/`, because each of the 15
axes already had an exported, directly measurable surface. Where a dimension
came back saturated (for example `D18` at 0 rather than a graded rate, and
`D3b`/`D30b`/`D32` at perfect boundaries), the correct response was to state
the bound, not to add machinery to produce a more interesting-looking number.

## Known limits of this benchmark

Stated plainly so the numbers are not over-read:

- Fixture-driven, not corpus-driven. The sizes are small (3–8 records per
  scenario) because the harness tests invariant behaviour, not throughput.
- Retrieval rates are exact-boundary assertions. `D7`'s 5/5 top-1 accuracy is
  a small-sample result; it demonstrates correct ranking order, not a
  production-grade recall curve.
- `D20` (0.4) is an arithmetic identity over a scripted 2S/3F sequence, not a
  quality score — the feedback layer is measured by `D21`/`D22`, which assert
  the state transitions.
- `D12`'s verified-vs-suspected gap (1 vs 0.567) is measured on one pair; it
  confirms the ordering is present, not that the weighting is tuned.
- Corruption cases operate on real on-disk SQLite via raw byte writes
  (`D27`, `D29`) rather than mocking, so the quarantine and refusal paths are
  exercised for real.
