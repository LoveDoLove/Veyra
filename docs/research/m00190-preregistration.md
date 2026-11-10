# m00190 — Pre-registered experiment design

**Frozen:** 2026-11-10T11:41:11Z (2026-11-10 19:41:11 +08), before any arm ran.
**Authority:** CTO instruction m06223. Nothing in this file may be edited after the
first pilot arm starts; amendments, if any, are appended in §9 and reported as
deviations.

---

## 1. Hypothesis

> An agent that can reuse an engineering investigation it already completed does
> not have to repeat that investigation.

Operationalised: in a task that requires locating a defect whose root cause sits
several hops from the failing assertion, a session with a prior successful
investigation in its room will (a) perform fewer repeated investigations and
(b) read the same file fewer times than a session with an empty room.

## 2. Phase 0 — Fixture Pilot (gate)

Run exactly two arms on the pilot fixture: `pilot-ctl-1` (recall only) and
`pilot-mem-1` (learn + recall).

**The experiment proceeds only if BOTH hold in `pilot-ctl-1`:**

- **P-A** `repeatReads ≥ 1` — at least one file is read on ≥ 2 separate tool
  calls, i.e. repeated investigation actually occurs without memory.
- **P-B** `investigationCalls ≥ 6` — the control spends a real investigation
  budget before its first edit.

**And in `pilot-mem-1`:**

- **P-C** `recalled = true` — Veyra injects at least one `- [vey_…]` item, and the
  section is not the "No known engineering history" branch.

If any of P-A/P-B/P-C fails, **stop**, redesign the fixture, discard pilot data,
and re-run the pilot. Pilot data is never pooled into the formal result (§4).

## 3. Phase 1 — Formal paired experiment

- **n = 10 valid pairs** (20 arms), tags `mem-1..10` and `ctl-1..10`.
- Each pair uses the same fixture commit, the same prompt, the same model, the
  same DSH version, the same permission mode, and a wall-clock adjacency of
  ≤ 30 min between the two arms.
- Each arm gets a fresh `DSH_HOME`, a fresh `VEYRA_HOME`, a fresh room UUID, and
  a freshly cloned fixture workspace.
- **Memory arm:** learn session (fixes the defect) → `git checkout .` +
  `git clean -fd` → recall session (same prompt, defect present again).
- **Control arm:** no learn session, so the room stays empty. It still gets a
  recall-capable session, so the extra turn structure is identical.
- **Fixed model for the whole formal run.** If the route becomes unavailable
  mid-run, the run PAUSES; it does not switch models. Data collected on two
  models is reported as two populations and never pooled.

## 4. Pre-registered metrics

All metrics are computed from DSH's own durable session log
(`<DSH_HOME>/sessions/**/session.v4.jsonl.zstd`) and the arm's filesystem.
Nothing is self-reported by the agent.

### Primary metrics

| id | metric | exact computation |
|----|--------|-------------------|
| **M1** | repeated investigation count (`repeatReads`) | For the graded (final) session: count of `(tool, normalised path)` pairs whose call count is ≥ 2, summed over all `read`/`grep`/`glob` calls. A path is normalised to repo-relative. |
| **M2** | repeated file reads (`rereadFiles`) | Number of distinct paths read on ≥ 2 separate `read` calls. |
| **M3** | tokens | Sum of `usage.totalTokens` over all `assistant/message` events carrying a `usage` object in the graded session. Verified shape: `step/end` carries NO usage; `totalTokens = inputTokens + cacheReadTokens + outputTokens` per step, i.e. it is the tokens PROCESSED at that step (the whole prompt plus the completion), so the sum is total processed tokens across the session, which is also what the provider bills. Reported alongside its decomposition (fresh input / cache-read / output). |
| **M4** | wall duration (`durationMs`) | `last event timestamp − first event timestamp` in the graded session. |
| **M5** | correctness | `pass` iff `node --test test/*.test.mjs` exits 0 in the workspace AFTER the arm, AND `git diff` shows the defect site touched (`src/codec.mjs`), AND the test files are unmodified (`git diff --stat -- test/` is empty). |

M5's three-part definition matters: a suite can pass because the agent edited
the tests, which is not a fix. The prompt forbids it, and M5 enforces it.

### Secondary metrics

| id | metric | exact computation |
|----|--------|-------------------|
| **M6** | tool calls | count of `tool/call` events in the graded session |
| **M7** | investigation calls before first edit (`preEditCalls`) | count of tool calls before the first `edit`/`write` call |
| **M8** | repeated search/locate behaviour (`repeatBashProbe`) | count of `bash` calls whose command string repeats an earlier `bash` command verbatim |
| **M9** | error-fix count (`errorRecoveries`) | count of `tool/result` events with `isError: true` followed by another tool call |
| **M10** | did memory change the decision | boolean, judged from the graded session's assistant text: `true` iff the text cites the recalled lesson (mentions the codec-cache/keying root cause) AND the first edit targets `src/codec.mjs` AND no edit touches `src/stages/validate.mjs`. This is the only metric with a judgement component; its exact string test is recorded in the appendix per arm. |

### Derived statistics

- Per-pair delta = `mem − ctl`; report mean, median, sd, and the sign test
  (two-sided binomial) per metric.
- Report the variance ratio `sd(ctl) / sd(mem)` with an F-test where relevant.
- Report every arm's raw values; no value is dropped. Outliers are reported and
  flagged, never deleted (§4 of the CTO instruction).
- Retain all logs under `/tmp/m190/<tag>/`.

## 5. Acceptance criteria (CTO principle, made checkable)

The CTO's principle is a three-step proof. Each step maps to a pre-registered
test:

**Step 1 — repeated investigation really exists.**
Met if pilot P-A holds and `mean(ctl.repeatReads) ≥ 1`.

**Step 2 — memory reduces it.**
Met if `mean(mem.repeatReads) < mean(ctl.repeatReads)` AND the paired sign test
gives `p < 0.05` AND `mean(mem.rereadFiles) ≤ mean(ctl.rereadFiles)`.

**Step 3 — the saving is worth the memory overhead.**
Met if, among arms satisfying M5, the memory arm's token cost increase is
smaller than the token cost of the investigation it avoided. Operationally:
`mean(Δtokens) < mean(ΔrepeatReads) × mean(ctl.tokensPerRepeatRead)`, where
`tokensPerRepeatRead` is estimated as the mean per-call token cost of the
control arm's repeated calls.

**Final grade:**
- **EFFECTIVE** — Steps 1, 2, 3 all met, and no correctness regression
  (`mem` and `ctl` pass rates equal at 10/10 or the difference is not
  memory-attributable).
- **PARTIALLY EFFECTIVE** — Step 1 met and Step 2 met, but Step 3 not met, OR
  Step 2 met only on the secondary metrics.
- **NOT EFFECTIVE** — Step 1 met but Step 2 not met; or Step 1 not met after
  fixture redesign.

## 6. Threats to validity, declared in advance

1. **Small n.** n=10 pairs gives a sign test a floor p of 0.002 and a realistic
   detection threshold well above a 20% effect. Underpowered by construction;
   results are directional, not confirmatory.
2. **One fixture.** A single repository shape means the result generalises to
   "defects whose root cause is several hops from the symptom", not to all work.
3. **Model variance.** Sampling temperature and reasoning variance can dominate
   a single-arm measurement; pairing is the mitigation, and per-pair deltas with
   a sign test are the primary statistic rather than a pooled t-test.
4. **Prior-knowledge leak.** If the model has memorised a solution for this
   fixture shape, both arms benefit equally; pairing cancels it. If it has
   memorised the *prompt*, both arms collapse and the effect vanishes — that
   would read as NOT EFFECTIVE, and is reported as such.
5. **The recall snapshot is advisory.** Veyra prints a trust warning; the agent
   may ignore memory. Ignoring it is a real outcome, not a failed run.
6. **Fixture-reset confound.** `git checkout` between learn and recall rewrites
   file mtimes, which makes every recalled record `REVIEW_REQUIRED`. Disclosed,
   not fixed: fixing it would require a code change, which this instruction
   forbids.

## 7. Exclusions

An arm is **invalid** (recorded, excluded from pairing, and reported) if any of:
- the model route returns a 429/5xx and the arm ends without a graded session;
- `pilot`/`mem` learn session fails M5 (no correct lesson to reuse);
- the workspace reset between learn and recall does not reproduce the baseline
  failure;
- Veyra writes no record in the learn session (nothing to recall);
- the arm's session log is missing or unparseable.

Every exclusion is listed with its reason in the report; nothing is silently
dropped.

## 8. What this experiment may NOT claim

- It may not claim a general productivity improvement.
- It may not claim the effect is due to *understanding*; only to reuse.
- It may not pool pilot data with formal data.
- It may not report a metric computed a different way than §4 defines.
- It may not claim EFFECTIVE on a mechanism argument alone; Steps 1–3 are
  measurement gates.

## 9. Amendments

**A3 — 2026-11-10T11:47Z, after the pilot control arm, before any formal arm.**
M1/M2 counting widened: repeated investigation now counts files read through
`bash` (`cat`, `head`, `tail`, `sed`, `awk`, `nl`, `grep`, …, including `for f in
src/*.mjs; do cat -n "$f"; done` loops and glob arguments), not only `read`/
`grep`/`glob` tool calls. Reason: the pilot control arm read 5 files with the
`read` tool and then dumped the whole tree with bash, re-reading every one of
them; the original definition scored it `repeatReads = 0`, which would have
declared P-A failed on a measurement blind spot rather than on agent behaviour.
The corrected definition scores the same arm `repeatReads = 8`, `rereadFiles = 8`.
This widens WHAT IS COUNTED as a read; it does not change what counts as a
repeat (a file accessed on ≥ 2 separate calls). No formal arm had run.

**A4 — 2026-11-10T11:47Z, after the pilot control arm, before any formal arm.**
`recalled` is judged from the FIRST injected Veyra snapshot in the graded
session, not from any snapshot in it. Reason: the pilot control arm scored
`recalled: true` because the agent called `veyra_remember` near the end and DSH
re-injected the runtime context afterwards; the post-write snapshot carried a
`vey_` id while the snapshot the agent actually worked under (event index 11)
correctly said "No known engineering history". Counting any snapshot measures
"memory exists at session end", not "memory was present while the agent worked".
The corrected definition scores that arm `recalled: false`. No formal arm had run.

**A5 — 2026-11-10T11:55Z, after the pilot memory arm, before any formal arm.**
The task prompt used by every arm is now the prose form of the same instruction:

> The pipekit import pipeline has two failing tests. Find out why they fail and
> fix the cause so the whole suite passes. Do not modify anything under test/;
> the tests encode correct behaviour. Fix the underlying defect, not the
> assertions.

The original bulleted form is preserved verbatim at
`prompts/pipekit-bulleted.txt` and both forms were probed against the shipped
classifier before the change:

| prompt form | `userAssertsClaim` |
| --- | --- |
| bulleted (`Rules:` + `- ` items) | **true** |
| prose | false |
| numbered (`1.` / `2.`) | false |
| no rule lines | false |

Why this matters and what it cost: with the bulleted prompt the learn session
distilled two records and the write gate DEFERRED both with
`reason: "provenance-gated"` (`{"total":2,"decisions":{"accept":0,"defer":2}}`),
so the room held two `observation/unverified/candidate` records and the graded
session recalled nothing — pilot gate P-C failed. The mechanism is a real
product defect, not a fixture artefact: `IMPERATIVE_START` is anchored `^`, so a
markdown-bulleted imperative is not recognised as imperative, and the sentence
`- Fix the underlying defect, not the assertions.` then matches forbidden
`CLAIM_HINTS` (`do not` inside "not the") and is scored as a declarative user
claim. That sets `userClaimBearing` true, removes `userContextOnly` from the
record source, and `provenanceAllowsLearning` rejects every record carrying a
`user` origin — the same failure mode m00188 fixed, reachable through ordinary
markdown formatting.

Why the prompt changed rather than the classifier: this experiment's instruction
forbids changing Veyra core architecture, and `src/understand.mjs` is core. The
prompt is an experiment artefact and is allowed to change. Changing only the
presentation (bullets → prose) while keeping every instruction, every sentence
and the whole fixture identical does not steer the measurement: the agent still
has to diagnose the same defect under the same rules. The defect is reported in
the study as a finding with its own reproducer.

No formal arm had run.

**A1 — 2026-11-10T11:44Z, before any arm ran.** M3's event source corrected:
usage lives on `assistant/message` events, not `step/finish` (which carries only
`{turn, step}`). Verified on a real m00188 session that
`totalTokens = inputTokens + cacheReadTokens + outputTokens` at every step, so
the metric is "total processed tokens" and is reported with its decomposition.
The metric's MEANING is unchanged (a token-cost proxy); only the extraction event
name and the interpretation note changed. No arm had run, so no data is affected.

**A2 — 2026-11-10T11:44Z, before any arm ran.** The fixture's failing tests were
renamed away from diagnostic titles. The first draft named the failure
`'two pipelines with different separators each decode their own input'`, which
hands the root cause to the agent in the test output and would have suppressed
the very investigation this experiment measures. The renamed tests name the
*symptom* (an export does not ingest; a report is wrong), not the mechanism.
