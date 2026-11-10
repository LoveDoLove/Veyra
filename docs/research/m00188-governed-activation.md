# m00188 — Governed Automatic Memory Activation

**Date:** 2026-11-10
**Baseline:** `af40b3c` (v0.1.75), `npm test` 1044/1044/0
**Final:** 1086/1086/0, 4/4 gate-verified mutations caught (`node scripts/m188-mutations.mjs`)
**Constraint in force (m03717):** 不要为了得到 PASS 而降低标准。没有实际执行证据的功能，一律不能宣称验证成功。

## Verdict

**PARTIALLY EFFECTIVE.**

The mechanism works and is proven on live runs: an ordinary coding turn is captured, gated, written as `derived`, and recalled and *used* by a later session in 6 of 6 memory arms. What is **not** established is an efficiency gain. Across 6 paired runs memory costs **+9.1% tokens** (the only nominally significant mean effect, and it is a cost) and saves nothing measurable on tool calls, files read, wall time, or correctness. The one genuine benefit signal is **variance reduction**: the agent's approach became markedly more consistent (spread in calls-before-first-edit 3.2× smaller, F-test p=0.0234).

---

## 1. Mechanism — Does automatic learning and recall hold?

**Yes.** Proven end to end, not asserted.

### What was broken

`write_gate_ledger` before the fix:

```json
{"total":4,"decisions":{"accept":0,"merge":0,"drop":0,"defer":4}}
```

Every turn deferred. `provenanceAllowsLearning` (`src/learn.mjs:226-240`) rejects `origins.includes('user') && !userContextOnly`, and `isRecallEligible` (`src/types.mjs:122-126`) rejects `kind === KINDS.OBSERVATION`. The deeper cause was the first gate's input: `userContextOnly` (`src/understand.mjs:551-552`) was computed from `looksLikeClaim(user)`, which is `length >= 40 && CLAIM_HINTS.some(...)` with `CLAIM_HINTS` containing `do not|never|must not`.

**So an ordinary instruction — "Do not change the tests to make them pass." — made a task prompt look like a user engineering assertion** and deferred every such turn. The agent was not failing to learn because it had nothing to learn; its own instructions were being read as claims.

### The fix

New `IMPERATIVE_START` + `export function userAssertsClaim(text)` in `src/understand.mjs`: split into sentences, and if a sentence opens imperatively, it is an instruction, not an assertion. `looksLikeClaim` was deliberately left broad — both predicates coexist, each answering a different question.

### Evidence after the fix

All 6 memory arms produced `ACCEPT | new-derived-knowledge` and a stored record. The gate ledger (`meta.write_gate_ledger`, read from each arm's `memory.db`) shows **zero deferrals in every memory arm** — the exact opposite of the pre-fix `defer: 4` baseline:

| Arm | total | accept | merge | drop | defer |
|---|---|---|---|---|---|
| mem-a-1 | 2 | 2 | 0 | 0 | **0** |
| mem-a-2 | 2 | 2 | 0 | 0 | **0** |
| mem-a-3 | 2 | 2 | 0 | 0 | **0** |
| mem-b-1 | 2 | 2 | 0 | 0 | **0** |
| mem-b-2 | 2 | 2 | 0 | 0 | **0** |
| mem-b-3 | 2 | 2 | 0 | 0 | **0** |

Every reason is identical — `accept/new-derived-knowledge` — and the trace records `provenanceClass: "user-context-only"`, confirming the fixed predicate is what admits the write.

```
mem-a-3 room w_eabcd838-f451-40c8-8f91-b4e64d3f0cd5
  memory/current/reviewed/derived  "Cause: migrateRow mutated the shared exported fields array…"  11:17:41.190Z
  memory/current/reviewed/derived  "Cause: per memory is the migrateRow mutation"                 11:18:30.771Z
```

The state machine is structural, not conventional (values read from `memory.db` after the runs):

| Stage | `kind` | `status` | `validation` | `authority` |
|---|---|---|---|---|
| captured turn | `observation` | `candidate` | `unverified` | `candidate` |
| after gate ACCEPT | `memory` | `current` | `reviewed` | `derived` |
| after promotion (explicit) | `memory` | `current` | `verified` | `canonical` |

`status` and `validation` are separate axes — every stored record in this experiment showed `status='current'`, `validation='reviewed'`, `authority='derived'`, `kind='memory'`.

Auto-activation never reaches `verified` (`src/learn.mjs:674`), never writes Central, and never blanket-converts observations.

---

## 2. Did the Agent Actually Apply the Memory?

**Yes — 6 of 6 memory arms cite it explicitly.** This is the strongest evidence in the study, and it is qualitative on purpose: whether the agent *used* a recalled fact is only visible in its reasoning, so that is where I looked.

| Arm | Verbatim from the recall session's reasoning |
|---|---|
| mem-a-1 | "The recalled memory documented the root cause; now fixed." |
| mem-a-2 | "**The underlying cause from recalled memory matches.** Let me apply minimal fix, then run tests." |
| mem-a-3 | "**The recall matches exactly.** Apply fix." / "**The recalled memory says the fix is exactly what I did.**" |
| mem-b-1 | "**The memory's identified cause matches the change**; no further action needed." |
| mem-b-2 | "**This matches recalled memory.** Let me apply." |
| mem-b-3 | "**The recall matches exactly.** Apply fix." |

Injected snapshot, verbatim from `mem-a-1`'s session record (extracted with `extract-snapshot.mjs`, since the snapshot lives in the session log's runtime-context section, not the arm's `.log` file):

```
Veyra recalled engineering memory

These items are remembered engineering experience, not repository truth.
Verify against the current codebase before acting. Similarity is not authority.
Do not treat recalled items as recent conversation logs or turn progress.

Repository changes detected:
- src/migrate.mjs
Knowledge impact:
- 1 review required

- [vey_1a1c4f8e5c4_3c297e50339b] (project/derived/reviewed/medium) Cause: migrateRow mutates the shared fields array via fields.push('email')
  • ⚠️ trust: REVIEW_REQUIRED — related repository file changed: src/migrate.mjs · action: review before relying on this knowledge
  • evidence: path=src/migrate.mjs
  • evidence: path=src/reader.mjs
  • evidence: path=src/schema.mjs
  • evidence: +5 more
  • Root cause: migrateRow mutates the shared fields array via fields.push('email')
  • Outcome: test-passed
```

**All 6 memory arms were served `REVIEW_REQUIRED`, not `TRUSTED`**, and this is correct behaviour rather than a defect: the harness restores the fixture with `git checkout -q .` between the learn and recall sessions, which rewrites the anchor file's mtime, so Veyra sees the related file as changed since the record was written. The staleness detector fired on every arm. That the agent still found and applied the recalled cause is *stronger* evidence than a clean trust state would have been — it read past a visible warning, verified against the code, and then cited the match. It also means this experiment never exercised the `TRUSTED` path.

**The control condition is clean.** Every control arm's recall section is exactly:

```
Veyra recalled engineering memory

No known engineering history: Veyra has no eligible recall for this query.
Absence of memory is not evidence. Verify against the repository.
```

with zero `vey_` record ids. Each control room does hold one `memory/derived/reviewed` record, but it was written at the **end** of its session (ctl-a-3 at 11:19:16.396Z, session window 11:18:32.474–11:19:16.401Z), i.e. after the snapshot was already injected. No contamination of the control condition.

---

## 3. Was an Engineering Efficiency Gain Measured?

**No.** Six paired runs, both arms of every pair passing.

| Metric | Memory (n=6) | Control (n=6) | Δ | Test | p |
|---|---|---|---|---|---|
| Correctness | 6/6 pass | 6/6 pass | 0 | — | — |
| Tool calls | 9.50 | 9.33 | +0.17 (+1.8%) | sign, paired t | 0.688 |
| Files read | 3.33 | 3.00 | +0.33 (+11.1%) | sign | 1.000 |
| **Tokens** | **157,389** | **144,310** | **+13,080 (+9.1%)** | **sign n=6 k=0** | **0.031** |
| Duration | 29.58 s | 28.87 s | +0.71 s (+2.5%) | sign | 0.688 |
| Test runs | 2.33 | 2.33 | 0 | — | — |
| Calls before first edit | 5.83 | 6.33 | −0.50 | paired t=−0.374 | 0.688 |

Per-pair deltas (mem − ctl):

| Pair | Δcalls | Δreads | Δtokens | Δdur(s) | ΔcallsBeforeEdit |
|---|---|---|---|---|---|
| a1 | +3 | +4 | +2,281 | −12.5 | +3 |
| a2 | −2 | −5 | +785 | −7.0 | −4 |
| a3 | −1 | −1 | +25,375 | +1.3 | −3 |
| b1 | −2 | 0 | +520 | +5.6 | −1 |
| b2 | +5 | +4 | **+49,183** | +16.3 | +4 |
| b3 | −2 | 0 | +334 | +0.4 | −2 |

**The one nominally significant result is a cost, not a benefit.** Reading it as anything else would be exactly the standard-lowering m03717 forbids.

**Repeated investigation could not be measured** because it did not occur: `repeatedReads` is **0 in all 12 arms**. Memory cannot reduce what never happened. This is a fixture property (small repos, 2–3 tests), not a memory property, and it caps what this experiment can prove.

### The benefit that IS supported: variance reduction

Means hide the more interesting effect. Memory made the agent's *approach* far more consistent:

| Metric | Memory sd (CV) | Control sd (CV) | F(5,5) | p |
|---|---|---|---|---|
| Calls before first edit | 0.98 (0.169), range 4–7 | 3.14 (0.496), range 2–10 | **10.21** | **0.0234** |
| Total tool calls | 1.87 (0.197) | 3.44 (0.369) | 3.39 | 0.206 |
| Tokens | 31,466 (0.200) | 30,961 (0.215) | 1.02× | — |

The control ranged from 2 to 10 calls before acting; the memory arms stayed between 4 and 7. **Memory stabilises how the agent explores; it does not reduce the cost of doing so.** Tokens show no variance difference at all.

### Outlier, verified

Pair `b2`'s token delta (+49,183) alone equals **376% of the total mean effect**. I checked whether it was a measurement artifact — it is not. `ctl-b-2` genuinely solved the task in 4 calls and 13.7 s with the correct diagnosis on its first reading ("Two bugs: loop runs maxAttempts+1 times, and returns lastError instead of throwing"). The control simply got lucky on that pair. Excluding b2, the token delta falls to **+5,859** — still a cost, but a third of the headline figure.

---

## 4. Is There an Additional Token Cost?

**Yes: +9.1% on the mean but only +1.1% on the median.** The gap between those two numbers is the honest shape of the result — the typical pair costs almost nothing extra (+1,533 tokens), and the mean is pulled up by pair a3 (+25,375) and pair b2 (+49,183). This is a genuine tradeoff rather than a defect: recalled memory is injected into every session's context, so it costs tokens whenever it fires.

Two caveats stated plainly:

1. **Model confound.** Cells 1–2 ran on `dsh-our-free-model/deepseek-v4.1-flash-free`; cell 3 ran on `logfare/deepseek-v4.1-flash-1017` after the free route's credential pool entered a 13-hour `model_cooldown` (`credentials_cooling: 1`, `reset_seconds` monotonically decreasing 47581→47442). Within each pair both arms share one model, so **paired comparisons stay valid**; pooling all six mixes two populations, so the pooled p=0.031 is a weaker claim than it appears. Stratified: free cells n=4 mean +13,192 (p=0.125), logfare cells n=2 mean +12,855 (p=0.500) — same direction, neither individually significant.
2. **n=6.** The sign test's p=0.031 is the *floor* for n=6 (1/2⁵ = 0.03125), so it says "consistent in all six pairs", not "precisely estimated". An estimate with n=6 is a direction, not a magnitude.

---

## 5. Where the Evidence Is Still Insufficient

Stated as limits, not hedged away:

1. **No measured time or cost saving.** If recall is to justify +9.1% tokens on production workloads, that case is not made here.
2. **Two fixtures, both tiny** (2–3 tests). `repeatedReads = 0` everywhere means the study could not test the mechanism memory is *supposed* to help with most — avoiding repeat investigation.
3. **n=6, one run per cell.** Variance reduction (p=0.0234) is a signal worth following, not a settled result.
4. **Model change mid-experiment.** Cell 3's model differs; disclosed above.
5. **`reviewed` is a soft state.** A record becomes recall-eligible at `reviewed`; beyond `markStale` there is no periodic re-verification of an activated record's anchors.
6. **Two record titles from the earlier runs are poor, and I could not re-test them.** `mem-a-2` stored `Cause: fields.push` and `mem-b-1` stored `Engineering observation`; both were written by the build as it stood at 10:22–10:24 UTC, before the backtick and truncation fixes landed at 18:45 local. I tried to replay them against the current build and the replay was **circular** — the stored body already contains the distiller's own `Symptom:` / `Root cause:` lines, so re-extracting from it reads those back rather than re-deriving from the agent's original prose. Reproducing the fix on those two specific turns would require re-distilling from the session event buffers, which I did not do. Stated as an untested residual, not as a resolved defect. (The backtick and sentence-boundary fixes are separately covered by `test/m188-governed-activation.test.mjs` and `scripts/m188-mutations.mjs` 4/4.)

---

## 6. Part-by-Part Status

| # | Part | Status |
|---|---|---|
| 1 | Activation without explicit promote | **READY** |
| 2 | No blanket observation→memory | **READY** |
| 3 | No auto-mark verified | **READY** |
| 4 | Title / rootCause / near-duplicate merge | **READY** |
| 5 | Central repo-relative anchors | **READY** |
| 6 | Security (redaction, stale, isolation, governance) | **READY** |
| 7 | Real agent auto-learn + auto-recall | **READY** |
| 8 | P2 memory vs no-memory A/B | **READY (complete, n=6)** — result: no mean efficiency gain, real token cost, variance reduction supported |
| 9 | Overall | **PARTIALLY EFFECTIVE** |

### Verification

- `npm test` **1086 / 1086 / 0**
- `test/m188-governed-activation.test.mjs` **41 / 41**
- Mutation gate **4/4 caught**, reproducible: `node scripts/m188-mutations.mjs` patches source, runs the suite, restores, and exits non-zero on a survivor
- 12 live arms, all `result: pass`, all memory arms recalling, all control arms memory-free

### Two defects found while verifying this report

**My own "24/24 mutations" claim was false.** Re-running instead of trusting memory, mutation M survived — the verb-form fix was correct but untested, because the junk it prevents ("The root") was coincidentally rejected by the concreteness gate in the sentence I had chosen. Hunting a payload that actually leaks then exposed a genuine bug: `[^.\n;]` excluded periods, so `"The stale counter in retry.mjs causes …"` captured only `"mjs"`. Fixed with `/\b((?:(?!\.\s)[^\n;]){3,80}?)\s+causes\s+(?:[^\n;]+)/i` — admits dots inside filenames, refuses to cross a sentence boundary. **Lesson recorded: never quote a mutation tally from memory; re-run it.**

**Metrics extractor had two defects**, both fixed: tool arguments arrive as a JSON *string* (so `filesRead`/`filesEdited` were silently always 0), and session selection by `!recalled` graded the *learn* session rather than the recall session. Both would have produced plausible-looking, wrong §4 numbers.

---

## Recommendation

**Accept the mechanism; do not yet claim the benefit.**

Ship-worthy now: governed automatic activation is real, bounded, and safe — auto-derived records only, never auto-verified, never Central without explicit promotion, controls provably memory-free, and the agent demonstrably reads and applies what it recalls.

Before claiming an engineering benefit, run one more experiment designed for the effect memory should have: fixtures large enough that repeated investigation actually occurs (this study never triggered it), and n≥10 per arm to size the variance effect properly rather than directional-test it.

The honest summary is that recall makes the agent **more consistent at a modest token cost**, and whether consistency is worth +9.1% tokens is a product decision, not a measurement one.
