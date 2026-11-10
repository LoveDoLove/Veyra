# m00190 — Repeated Investigation & Engineering Benefit Validation

**Verdict: NOT EFFECTIVE**

Veyra's automatic learning and recall activated correctly in every arm: all ten
memory arms learned, all ten wrote recall-eligible `memory/reviewed/derived`
records, all ten recalled, and in at least four arms the agent visibly used the
recalled root cause to skip straight to the fix. Task correctness was 20/20.

But the study was built to answer one question — does memory reduce **repeated
investigation** — and on that question the data says no: `repeatReads` 6.30
(memory) vs 6.80 (control), paired sign test **p = 0.7266**. Under the
pre-registered acceptance rule, Step 2 is not met, so the verdict is NOT
EFFECTIVE regardless of how favourable the other columns look.

The finding that actually decides the business question is worse than a null
result. The mean learning session costs **258,022 tokens**. The measured
recall-side saving is **39,125 tokens** per session. Memory therefore costs
**1.90×** a control session end-to-end (462,197 vs 243,299 mean tokens) and
would need **6.6 reuses of the same knowledge** before it pays for itself —
against a fixture where the studied reuse is a single follow-up task.

---

## 1. Experiment design and pre-registered metrics

The whole design, including the acceptance rule and the exclusion rules, was
frozen before any arm ran and is published verbatim at
[`m00190-preregistration.md`](m00190-preregistration.md) (sha256
`41f47ca1564a969b90f6c13c1406839899974e84bd3f3c20515ba058f495557e`).

**Hypothesis.** An agent that can reuse an engineering investigation it already
completed does not have to repeat that investigation.

**Fixture — `pipekit`.** A 20-file, 16-test CSV import pipeline with one real
cross-file defect: `src/codec.mjs` `compileDecoder` keys its module-scope cache
on `const key = options.codec` alone while the decoder closure captures
`separator` and `trim`, so two pipelines sharing codec `csv` share the first
decoder built. The defect is only reachable through
`test/importer.test.mjs` → `src/importer.mjs` → `src/pipeline.mjs` →
`src/registry.mjs` → `src/stages/parse.mjs` → `src/codec.mjs` → `src/options.mjs`.
The fixture carries a red herring — `src/stages/validate.mjs` has a guard
`if (options.validate && columns >= 1 === false)` that looks broken and is
correct — and `scripts/trace.mjs` prints a hint pointing at it, so an agent that
trusts the hint "fixes" a non-defect. Correct fix: 16/16. Validate-fix: 14/2.

**Arms.** Ten pairs, `mem-i` and `ctl-i` run adjacently. Each arm has a fresh
DSH home, a fresh Veyra home, its own room UUID and its own clone of the
fixture. Memory arms run a learn session (solve the defect), then the fixture is
reset with `git checkout -q .` + `git clean -qfd`, then the graded session runs
on the same defect. Control arms skip the learn session and run only the graded
session. Both then get the identical prompt.

**Task prompt** (prose form — Amendment A5):

> The pipekit import pipeline has two failing tests. Find out why they fail and
> fix the cause so the whole suite passes. Do not modify anything under test/;
> the tests encode correct behaviour. Fix the underlying defect, not the
> assertions.

**Model.** `logfare/deepseek-v4.1-flash-1017` via `http://localhost:20128/v1`
for all twenty arms — verified identical across every arm from each arm's
`model.txt`; the unique model string across the run is exactly that one value.

**Metrics, all computed mechanically** from the DSH session log
(`session.v4.jsonl.zstd`) and the arm filesystem, never from agent
self-report:

| id | metric | definition |
| --- | --- | --- |
| M1 | `repeatReads` | a file accessed on ≥ 2 separate calls contributes N−1 |
| M2 | `rereadFiles` | distinct files read more than once |
| M3 | `tokens` | Σ `usage.totalTokens` over `assistant/message`, with decomposition |
| M4 | `durationMs` | last − first event timestamp |
| M5 | correctness | suite exit 0 AND `src/codec.mjs` touched AND `git status --porcelain -- test/` empty |
| M6 | `toolCalls` | count of `tool/call` |
| M7 | `preEditCalls` | calls before the first `edit`/`write` |
| M8 | `repeatBashProbe` | verbatim repeated bash commands |
| M9 | `errorRecoveries` | an error result followed by further work |
| M10 | memory changed decision | agent prose + files viewed, inspected manually |

**Acceptance, frozen.** Step 1: control `mean(repeatReads) ≥ 1`. Step 2:
`mean(mem.repeatReads) < mean(ctl.repeatReads)` AND paired sign test
`p < 0.05` AND `mean(mem.rereadFiles) ≤ mean(ctl.rereadFiles)`. Step 3:
`mean(Δtokens) < mean(ΔrepeatReads) × mean(ctl.tokensPerRepeatRead)`.
EFFECTIVE requires 1+2+3 with no correctness regression; PARTIALLY EFFECTIVE
requires Step 1+2 but not 3; NOT EFFECTIVE is Step 1 met but Step 2 not.

---

## 2. Fixture pilot results

The pilot passed all three gates and is **excluded from the formal data below**,
as pre-registered.

| gate | requirement | `pilot-ctl-1` / `pilot-mem-2` | result |
| --- | --- | --- | --- |
| P-A | control `repeatReads ≥ 1` | 8 | PASS |
| P-B | control `preEditCalls ≥ 6` | 10 | PASS |
| P-C | memory arm recalls | `true` | PASS |

`pilot-ctl-1`: `repeatReads 8`, `rereadFiles 8`, `preEditCalls 10`,
`toolCalls 14`, `tokens 229,184`, `steps 11`, `53.9 s`, `recalled false`.
`pilot-mem-2`: `recalled true`, `repeatReads 8`, `rereadFiles 7`,
`preEditCalls 13`, `toolCalls 18`, `tokens 279,475`, `steps 13`, `65.0 s`,
learn session 15 tool calls.

The pilot also found three defects **in the measurement instruments** and one in
the **product**, all of them fixed before any formal arm ran. They are disclosed
here because they are part of what this study learned:

- **A3 — the metric was blind to bash.** `pilot-ctl-1` first scored
  `repeatReads 0`, which would have declared P-A failed. It was wrong: the agent
  never used the `read` tool, it read everything via
  `for f in src/*.mjs; do cat -n "$f"; done`. Counting only `read`/`grep`/`glob`
  lost 7 bash reads. Corrected to 8.
- **A4 — recall was judged from any snapshot.** The control arm scored
  `recalled true` because the agent called `veyra_remember` at the end of the
  session and DSH re-injected context; the snapshot it actually worked under
  (event index 11) said "No known engineering history". Now judged from the
  first snapshot only.
- **A5 — the bulleted prompt silently disabled recall** (the product defect; see
  §7). `pilot-mem-1` is the evidence. It was not misclassified by any harness
  bug — it ran a full learn session at 19:51:43 that fixed the defect
  (`learn-result.txt` = `fixed`) — yet its gate ledger reads
  `{"total":2,"decisions":{"accept":0,"defer":2},"reasons":{"defer/provenance-gated":2}}`
  and its room held only `observation/candidate/unverified` records, so its
  graded session was told `No known engineering history: Veyra has no eligible
  recall for this query`. `pilot-mem-2`, run minutes later with the identical
  task expressed as prose, produced `accept 2`, two
  `memory/derived/reviewed` records, and a real injection. The only difference
  was list formatting. That single pair is why the formal prompt is prose.
- **A6 — a near-miss in the tag classifier, caught by reading the glob rather
  than the output.** The runner had been written as `[[ "$TAG" == mem-* ]]`,
  which does **not** match `pilot-mem-1` (a shell glob anchors at the start), so
  an arm named `pilot-mem-*` would have silently executed the control path — no
  learn session, no memory — while still being labelled a memory arm. It was
  changed to `*mem-*` at 19:50:22, and `pilot-mem-1` did not start until
  19:50:36, so **no arm, pilot or formal, was ever misclassified**; the
  timestamps and the presence of `learn.log`/`learn-result.txt` prove it.
  Recorded because a classifier that fails silently is worth knowing about, not
  because it corrupted data.

---

## 3. Raw data for the ten valid pairs

Twenty arms run, twenty arms valid, zero exclusions. Each memory arm's learn
session reached `fixed` (M5 on the learn task), each memory arm recalled
(`- [vey_` item present at first snapshot), each control arm did not.

| pair | arm | recall | correct | repeatReads | rereadFiles | toolCalls | preEdit | tokens | steps | dur (s) | session |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | mem | true | pass | 3 | 2 | 14 | 8 | 236,324 | 11 | 44.7 | `060f2c93` |
| 1 | ctl | false | pass | 12 | 12 | 18 | 14 | 231,206 | 11 | 85.6 | `201d1d4f` |
| 2 | mem | true | pass | 0 | 0 | 13 | 10 | 178,251 | 9 | 46.6 | `c41ce57b` |
| 2 | ctl | false | pass | 1 | 1 | 26 | 19 | 298,016 | 14 | 66.5 | `60d0f6c0` |
| 3 | mem | true | pass | 6 | 6 | 15 | 11 | 162,504 | 8 | 50.8 | `dc4ecaeb` |
| 3 | ctl | false | pass | 24 | 14 | 15 | 10 | 334,185 | 16 | 67.4 | `c185a991` |
| 4 | mem | true | pass | 0 | 0 | 13 | 10 | 162,189 | 8 | 44.0 | `0a4c7b6c` |
| 4 | ctl | false | pass | 1 | 1 | 12 | 10 | 137,120 | 7 | 40.5 | `f766faf2` |
| 5 | mem | true | pass | 25 | 19 | 19 | 14 | 247,437 | 11 | 61.6 | `caa3fb1f` |
| 5 | ctl | false | pass | 11 | 11 | 22 | 19 | 239,451 | 11 | 42.6 | `fd65eb66` |
| 6 | mem | true | pass | 7 | 7 | 17 | 12 | 212,511 | 10 | 43.9 | `fead51c2` |
| 6 | ctl | false | pass | 4 | 4 | 12 | 8 | 180,486 | 9 | 33.4 | `08905998` |
| 7 | mem | true | pass | 1 | 1 | 13 | 7 | 159,224 | 8 | 30.8 | `9f2f9459` |
| 7 | ctl | false | pass | 1 | 1 | 28 | 22 | 282,598 | 13 | 59.1 | `841ef503` |
| 8 | mem | true | pass | 19 | 10 | 17 | 12 | 310,508 | 14 | 101.5 | `f7d6b4d2` |
| 8 | ctl | false | pass | 0 | 0 | 17 | 13 | 205,894 | 10 | 49.6 | `8aba669a` |
| 9 | mem | true | pass | 0 | 0 | 14 | 12 | 160,375 | 8 | 37.7 | `66dd1a82` |
| 9 | ctl | false | pass | 0 | 0 | 16 | 12 | 202,695 | 10 | 51.9 | `0d461911` |
| 10 | mem | true | pass | 2 | 2 | 20 | 15 | 212,425 | 10 | 56.3 | `85f5a287` |
| 10 | ctl | false | pass | 14 | 11 | 19 | 16 | 321,342 | 15 | 65.9 | `73ad4485` |

Learning session cost per memory arm (tokens / tool calls):
`mem-1` 180,240/12 · `mem-2` 357,342/16 · `mem-3` 252,859/17 ·
`mem-4` 258,037/14 · `mem-5` 159,288/14 · `mem-6` 227,496/14 ·
`mem-7` 333,540/15 · `mem-8` 336,680/27 · `mem-9` 254,435/21 ·
`mem-10` 220,307/15. Mean **258,022**.

---

## 4. Token, time, investigation cost and correctness

| metric | memory (n=10) | control (n=10) | Δ mean | mem better | ctl better | ties | sign test p |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `repeatReads` | 6.30 (median 2.50) | 6.80 (median 2.50) | **−0.50** | 5 | 3 | 2 | **0.7266** |
| `rereadFiles` | 4.70 (median 2.00) | 5.50 (median 2.50) | −0.80 | 5 | 3 | 2 | 0.7266 |
| `tokens` | 204,174.80 | 243,299.30 | −39,124.50 | 5 | 5 | 0 | 1.0000 |
| `durationMs` | 51,780.5 | 56,235.4 | −4,454.9 | 6 | 4 | 0 | 0.7539 |
| `toolCalls` | 15.50 | 18.50 | −3.00 | 5 | 3 | 2 | 0.7266 |
| `preEditCalls` | 11.10 | 14.30 | −3.20 | 6 | 2 | 2 | 0.2891 |
| `repeatBashProbe` | 0 | 0 | 0 | 0 | 0 | 10 | 1.0000 |
| `errorRecoveries` | 0 | 0 | 0 | 0 | 0 | 10 | 1.0000 |
| correctness | 10/10 | 10/10 | 0 | — | — | — | — |

**Correctness: 10/10 in both conditions.** Every one of the twenty arms produced
a real fix of `src/codec.mjs` with no test file touched (`git status --porcelain
-- test/` empty in all twenty). Memory did not damage correctness, and it did not
improve it either — this fixture's defect is findable without help.

The twenty fixes are genuinely independent rather than one memorised patch:
`mem-8`, `mem-9` and `mem-10` all landed on
`const key = JSON.stringify([options.codec, options.separator, options.trim])`,
while `ctl-8` introduced a `cacheKey(options)` helper, `ctl-9` used
`JSON.stringify(options, Object.keys(options).sort())` and `ctl-10` used
`decoderKey(options)`. One arm, `ctl-2`, additionally touched `src/options.mjs`;
the other nineteen changed only `src/codec.mjs`.

**The primary metric did not separate.** The means differ by 0.50 reads, the
medians are identical (2.50 each), and five pairs favour memory while three
favour control with two tied. That is a coin flip, and the sign test says so.

**Why the mean is so noisy: the distribution is bimodal, not shifted.**

| pair | mem | ctl | | pair | mem | ctl |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | 3 | 12 | | 6 | 7 | 4 |
| 2 | 0 | 1 | | 7 | 1 | 1 |
| 3 | 6 | 24 | | 8 | **19** | **0** |
| 4 | 0 | 1 | | 9 | 0 | 0 |
| 5 | **25** | **11** | | 10 | 2 | 14 |

Pairs 2, 4 and 9 are near-zero on both sides: the agent found the defect
immediately. Pairs 1, 3 and 10 show a large saving. Pairs 5 and 8 show the
opposite — the memory arm investigated *far more* than the control. A ±0.50
mean over a range of 0–25 is not a small effect on a shifted distribution; it is
noise on a bimodal one.

**The recall-side token saving is real but is not a win**, because it omits what
learning cost:

| quantity | mean tokens |
| --- | --- |
| learn session (memory arms only) | 258,022 |
| graded session, memory | 204,175 |
| graded session, control | 243,299 |
| recall-side saving per session | −39,125 |
| **memory total (learn + graded)** | **462,197** |
| **memory total vs control** | **+218,898 = 1.90×** |
| payback: learn cost ÷ per-session saving | **6.59 reuses** |

A memory arm spends 462,197 tokens to do what a control arm does in 243,299.
The 16% graded-session saving is swamped 5.6× by what it cost to produce the
memory. Break-even needs ~6.6 identical reuses of the same knowledge; this
fixture exercises one.

---

## 5. Did memory actually reduce repeated investigation?

**Activation: yes, unambiguously.** All ten memory arms have an identical
`write_gate_ledger`: `total 2`, `decisions {accept: 2, merge: 0, drop: 0,
defer: 0}`, `reasons {"accept/new-derived-knowledge": 2}`. Not one record was
deferred in any arm. All ten produced recall-eligible
`memory/reviewed/derived` records and all ten recalled. Every learn session
reported `fixed`, so each memory arm really did solve the defect before the
reset. (`mem-7` holds three records rather than two — the two gate-accepted ones
plus one `memory/derived/unverified` written at 12:17:35.871Z — but its ledger is
still `accept 2`.)

**Use: yes, in at least four arms — visible in the agent's own words.**

- `mem-3`, first reasoning step, before any file read: *"The cause is confirmed:
  `compileDecoder` caches decoders under `options.codec` alone, so the first CSV
  dialect compiled is reused for every later separator/trim configuration."*
- `mem-10`, first reasoning step: *"Both failures are the same defect:
  `src/codec.mjs` caches decoders under the key `options.codec`, which is
  `'csv'` for every CSV dialect."*
- `mem-1`, step 2: *"Root cause found: `compileDecoder` caches by
  `options.codec` alone, so all CSV configurations share the first decoder
  built."*, then step 3: *"Let me update the recalled memory record, which is now
  flagged for review because this exact file changed."*

An agent that names the exact root cause in its first sentence did not discover
it by reading seven files. Memory visibly short-circuited discovery.

**Reduction: no measurable effect.** Despite that, `repeatReads` did not fall.
The likely mechanism, visible in the data, is that the graded task still requires
*verification*: the recalled item is explicitly advisory ("Similarity is not
authority", "verify against the current codebase"), and the fixture reset has
just rewritten `src/codec.mjs`'s mtime, so the record is delivered
`REVIEW_REQUIRED`. The agent therefore confirms the fix by reading the code and
running the suite anyway. Memory removed the *search* but not the *check*, and
`repeatReads` counts both. This is consistent with the arms that read 13 files
before editing despite already knowing the answer.

**Directional supporting signals, none significant.** `preEditCalls` 11.10 vs
14.30 (p=0.2891), `toolCalls` 15.50 vs 18.50 (p=0.7266), `durationMs` 51.8 s vs
56.2 s (p=0.7539) all favour memory; steps 9.7 vs 11.6. The variance pattern
replicates m00189: `preEditCalls` sd 2.47 vs 4.60 (F(9,9)=3.46, one-sided
p=0.0392), `toolCalls` sd 2.59 vs 5.42 (F=4.37, one-sided p=0.0193) — memory
makes the *approach* more consistent even when it does not make it shorter.
`repeatReads` sd 8.74 vs 8.12 shows no variance difference at all.

**Step 3 is met but vacuously, and must not be claimed.** The frozen rule
computes `tokensPerRepeatRead = 35,779` and `ΔrepeatReads = −0.50`, giving a
break-even threshold of −17,890 which the −39,125 token delta clears. But with
Δrepeat near zero that threshold is meaningless. A per-pair check of "avoided
repeat ⇒ saved tokens" is consistent in only 6 of 10 pairs and contradicts in 4
(pair 1: Δrepeat −9, Δtokens **+5,118**; pair 4: Δrepeat −1, Δtokens **+25,069**;
pair 7: Δrepeat 0, Δtokens −123,374; pair 9: Δrepeat 0, Δtokens −42,320).
`corr(Δrepeat, Δtokens) = 0.729` across pairs, but the per-pair accounting does
not hold. Reporting Step 3 as "met" without this caveat would be dishonest.

---

## 6. Statistical limits, confounders, and what remains unverified

**Limits.**

1. **n=10 is underpowered.** The sign test has a floor p of 0.002 and needs 8/10
   one-directional pairs to reach p<0.05. A real effect smaller than the
   binomial resolution cannot be detected. Results are directional, not
   confirmatory.
2. **One fixture, one defect shape.** A module-scope cache-key bug that is
   findable in 13 file reads. Nothing here generalises to defects with different
   search structure.
3. **Bimodal outcome.** With several arms at 0–1 repeats in both conditions,
   the mean is dominated by a few arms; a Wilcoxon or a hurdle model would be
   more appropriate than a mean, but the metric and test were frozen in advance
   and are reported as frozen.
4. **Sign test ignores magnitude.** Pair 8's +19 counts the same as pair 4's −1.
5. **`tokens` is total processed tokens**, i.e. Σ(prompt + completion) per step,
   not unique tokens; it is reported with decomposition and is valid for
   same-model comparison, not as billing.

**Confounders, disclosed.**

1. **Model** — a single model throughout (verified: one unique `model.txt`
   value), so no m00189-style mixed-population problem.
2. **Fixture-reset confound** — `git checkout -q .` + `git clean -qfd` between
   learn and graded sessions rewrites `src/codec.mjs`'s mtime, so every recalled
   record is delivered `REVIEW_REQUIRED` rather than `TRUSTED`. This *suppresses*
   measured benefit directly: it tells the agent to re-verify. Not fixed,
   because fixing it needs a code change the instruction forbids. A study that
   removes it would likely see larger savings.
3. **Learn-session cost is attributed to the memory arm** — correct for
   end-to-end accounting, and the reason the 1.90× ratio exists. A user who
   reuses knowledge many times would amortise it; this fixture exercises one
   reuse.
4. **Prompt form** (A5) — prose, not the original bullets, because the shipped
   classifier treats a bulleted imperative as a user claim. See §7.
5. **Warm caches and provider variance** — arms ran sequentially, `mem-i` then
   `ctl-i`; no arm was rate-limited or re-run.
6. **Amendments A1–A6 all predate the first formal arm** and are recorded in the
   frozen document; none relaxes a threshold.

**Unverified.**

- Whether memory reduces investigation on a defect the agent could *not*
  plausibly re-derive, where removed search dominates removed verification.
- Whether the effect is larger when the record is delivered `TRUSTED` (no reset
  confound).
- Whether `repeatReads` is the right primary metric at all. It is defensible a
  priori, but this run suggests recall changes *where* an agent looks, not
  necessarily *how often*, so a metric like "files read before the first
  correct hypothesis" may separate where repeat-reads does not.
- Long-horizon amortisation. One learn → six recalls was never tested.

---

## 7. Defects found in Veyra during this study

These are product findings, reported as findings, not fixed (the instruction
forbids core changes).

**A5 — a markdown bullet defeats the imperative classifier, and in doing so
fabricates a "user claim".** `IMPERATIVE_START` (`src/understand.mjs:37`) is
anchored `^\s*` — it tolerates leading whitespace but not a list marker. A
bulleted instruction line therefore fails the imperative test, and
`userAssertsClaim` (`src/understand.mjs:429-442`) falls through to
`CLAIM_HINTS` (`src/understand.mjs:27-30`), which matches ordinary instruction
vocabulary: `- Do not modify anything under test/` hits `/do not/` and
`- Find out why they fail and fix the cause…` hits `/the cause/`. Those matches
set `userClaimBearing` true (`:806`), remove `userContextOnly` from the record
source (`:807`, `:835`), and `provenanceAllowsLearning`
(`src/learn.mjs:226-240`) then rejects every record carrying a `user` origin.

Verified directly, and the bullet is the sole trigger — the same four sentences
give `userAssertsClaim` **true** as `- ` bullets, **true** as `* ` bullets, and
**false** once the marker is stripped (also false numbered, and false in prose
form). With the bulleted prompt the gate deferred both records
(`{"total":2,"decisions":{"accept":0,"defer":2}}`, `reason: "provenance-gated"`)
and recall returned nothing — the m00188 failure mode, reachable through nothing
more exotic than writing the task as a list. The original prompt is preserved at
`prompts/pipekit-bulleted.txt`.

(An earlier draft of this section blamed `do not` matching inside "not the".
That was wrong: `/\bdo not\b/` does not match "not the". The real triggers are the
list marker defeating `IMPERATIVE_START`, plus `the cause` and `do not` matching
as plain keywords in lines that are instructions, not assertions.)

**A6 — a silent classifier, caught before it fired.** (Harness, not product.) The
arm runner classified memory vs control with `[[ "$TAG" == mem-* ]]`, a shell
glob that anchors at the start of the string and therefore does **not** match
`pilot-mem-1`. An arm named `pilot-mem-*` would have taken the control path —
no learn session — while every log still called it a memory arm. Caught by
reading the glob, not by noticing a bad number: the fix to `*mem-*` landed at
19:50:22 and `pilot-mem-1` began at 19:50:36, so no arm was ever affected.

**A7 — "Files touched" reports reads as edits.** A recalled record body claims
edits that never happened. `mem-7`'s record lists `Files touched:
.../src/codec.mjs, .../test/importer.test.mjs, .../src/options.mjs,
.../src/importer.mjs, src/codec.mjs`, but that arm's working tree is
` M src/codec.mjs` only — it never wrote `test/importer.test.mjs`. The cause is
in the collector, not the renderer: `collectFiles` (`src/observe.mjs:154`) is
called for every tool in `INTERESTING_TOOLS` (`src/observe.mjs:35`), which
includes `read`, `grep` and `glob`, and it records `args.path` / `args.file_path`
for all of them. `distillBuffer` then unions that with
`extractMentionedPaths(\`${user}\n${assistant}\`)` (`src/understand.mjs:715-717`)
and renders it at `src/understand.mjs:768` as `Files touched:`. So a file the
agent merely *opened* — or merely *named in prose* — is presented to the next
session as touched. This matters more than a cosmetic label: it is the field a
future agent would use to decide which files a change affected, and it is
unverified by construction, because prose-scraped paths carry no provenance at
all. Reported, not fixed.

---

## 8. CTO acceptance recommendation

**Do not adopt automatic learning on the strength of a benefit case. The
measured benefit does not exist yet, and the cost does.**

- **What is proven:** the mechanism works end to end — learning activates,
  records become recall-eligible, recall reaches the agent, and agents visibly
  use it to name the root cause immediately. Correctness is unharmed (20/20).
- **What is not proven:** that this reduces repeated investigation. Primary
  metric p=0.7266 with identical medians.
- **What is proven against:** end-to-end cost is 1.90× control, payback needs
  ~6.6 reuses, and this study exercises one.

**Recommendation: keep the mechanism, do not advertise the benefit, and re-test
under conditions that give the benefit a chance to appear** — before writing any
claim into a release note:

1. Remove the reset confound so records arrive `TRUSTED` (needs an approved code
   change; today the fixture reset forces `REVIEW_REQUIRED` and instructs
   re-verification, which suppresses exactly the saving being measured).
2. Use a defect the agent cannot cheaply re-derive, so removed search dominates
   removed verification.
3. Measure the right thing: "files read before the first correct hypothesis"
   alongside `repeatReads`, given the bimodal distribution found here.
4. Test amortisation (one learn → several recalls) rather than a single reuse.
5. n≥20 pairs for a binary-sign-test design, or switch to a magnitude-aware
   test with a larger n.

Until then the honest position is: **memory costs about twice as much as it
saves in a single-reuse setting, and its investigation-saving effect is
unproven.**

---

## Appendix — artifacts

| artifact | path |
| --- | --- |
| Pre-registration (frozen) | `docs/research/m00190-preregistration.md` |
| Fixture builder | `/home/lovedolove/.cache/ael/m190/make-ws-m190.sh` |
| Arm runner | `/home/lovedolove/.cache/ael/m190/run-arm-m190.sh` |
| Formal driver | `/home/lovedolove/.cache/ael/m190/run-formal.sh` |
| Metric extractor | `/home/lovedolove/.cache/ael/m190/metrics-m190.mjs` |
| Analysis | `/home/lovedolove/.cache/ael/m190/analyse-m190.mjs` |
| Raw arms (20) | `/tmp/m190/{mem,ctl}-{1..10}/` |
| Pilot arms (excluded) | `/tmp/m190/pilot-{ctl-1,mem-1,mem-2}/` |
| Task prompts | `/home/lovedolove/.cache/ael/m190/prompts/` |

Raw arms are retained in full: session logs under `home/sessions/`, Veyra rooms
under `veyra/rooms/`, suite output in `result.txt`, and the model used in
`model.txt`. Nothing was deleted, no outlier was excluded, and no arm was
re-run.
