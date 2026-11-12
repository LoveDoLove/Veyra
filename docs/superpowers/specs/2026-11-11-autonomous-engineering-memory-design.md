# Autonomous Engineering Memory — Design

Date: 2026-11-11
Status: implemented (2026-11-12) — see
`docs/superpowers/plans/2026-11-11-autonomous-engineering-memory.md` for the
measured per-task ladder. Two behaviours changed while executing: compact
rendering keeps every warning line (§4.1), and the turn-end signal reuses
`testOutcomeFrom` rather than inspecting tool text (§4.4).
Related: `docs/PRODUCT-EVOLUTION-BLUEPRINT.md`, `docs/research/phase1-6-delivery-application-proof-feasibility.md`

## 1. Intent

Veyra should learn from a Coding Agent's own work without the agent being told
to save anything, and should put that knowledge back in front of the agent at
the moment it is relevant — without the agent being told to look.

The loop we want:

1. while working, notice experience worth keeping;
2. after the task, consolidate what was learned;
3. when a new task starts, retrieve what is relevant;
4. actually apply it;
5. accumulate genuine engineering knowledge over time.

Steps 1 and 3 exist already. Step 2 is one record at a time with no curation.
Step 4 is unmeasured and unmeasured *because* it is unobservable. Step 5 is
blocked by step 1 producing noise that outranks real knowledge.

## 2. What the current system actually does (evidence)

Measured on the live room
`$DSH_HOME/veyra/rooms/w_0f218005-…/memory.db` and by executing the real
functions, not by reading comments.

### 2.1 Recall already fires automatically — too often, with the same content

- `veyra_apply_generation_v1` has `nextSeq 3716`; `entries` retains 48.
- All 48 retained entries are `queryClass: change_signal`, `resultCount: 5`.
- Rendered size 4875 chars, then 5870 chars — about 1.5K tokens per turn.
- Those 48 injections drew from only **3 distinct top-5 sets** over 6 records.
- `deliveryStatuses: ['NOT_VERIFIED']`, `usedStatuses: ['NOT_VERIFIED']`, and
  `veyra_apply_outcome_link_v1` does not exist: zero outcome links ever.

So automatic retrieval is not the missing piece. Paying a fixed 1.5K tokens per
turn to re-inject the same five records is.

### 2.2 Delivery is structurally unobservable

- `src/apply-generation-evidence.mjs:65-66,153-154,176-177` hardcode
  `delivery: notVerified('delivery')` and `used: notVerified('used')`.
- `src/health.mjs:202-203,287` surfaces exactly those constants.
- The only attribution path is `recordExplicitOutcomeLink`
  (`src/apply-generation-evidence.mjs:214`), reached solely from
  `src/tools.mjs:676`, which requires `args.generationEventId` — a parameter
  `veyra_feedback` (`src/tools.mjs:630-641`) does not declare. The path is
  unreachable from the public tool surface.
- `recordFeedback` (`src/feedback.mjs:70`) has no automatic caller.

Per `docs/research/phase1-6-delivery-application-proof-feasibility.md`,
model receipt cannot be proven from any public DSH surface. But a
**`veyra_recall` tool dispatch** is different: the tool returned those records
into the model-facing dispatch. That is provable pre-stream delivery and we
currently throw it away.

### 2.3 Capture admits noise that then outranks real knowledge

- `extractSymbols` (`src/understand.mjs:477`) applies `SYMBOL_RE`
  (`src/understand.mjs:71`) to raw text, so prose yields symbols. Executed:
  a prose sentence → `["receives","value"]`; "the `const body` line" → `["body"]`.
- `hasGrounding` (`src/learn.mjs:69`) returns true when *any* evidence item has
  `path|uri|anchor|note`. `sym:` is a `note`. So a prose symbol makes a record
  "grounded", and `src/learn.mjs:675` gives it `confidence: medium` instead of
  `low`. This is the mechanism behind the six noisy records that recall keeps
  selecting, including one titled `Cause: of low quality? Let me verify…`.
- `mutatesFiles` (`src/observe.mjs:58`) is applied to tool args, and
  `collectFiles` (`src/observe.mjs:183`) reads `path`/`file_path` and
  `path:`/`file_path:` inside `code`. A `bash` call that writes with `sed -i`
  or `>` leaves no file evidence, so work done through bash is invisible while
  a `/tmp` probe script counts as a touched file.
- `extractCausalFacets` (`src/understand.mjs:292`) receives combined
  user+assistant text, so an agent's musing and a user's statement are
  indistinguishable, and `deriveTitle` (`src/understand.mjs:537`) builds a
  `Cause:` title from either.

### 2.4 Near-duplicates never merge

`src/diff.mjs:57` only returns `DUPLICATE` when `tokenSim > 0.9` and the text is
not more than 25% longer. Reworded restatements of the same root cause score
below that and become a second record. The live write-gate ledger is
`{"total":13,"decisions":{"accept":6,"merge":0,"drop":3,"defer":4}}`: merge has
never fired in production, and two near-identical root-cause records were both
accepted.

Lowering the threshold is not the fix. Measured over all 21 pairs among the live
derived records, whole-claim `jaccard` never exceeds **0.143** — below even
`MIN_CONFLICT_SIM` (0.35). Body-length asymmetry (the same cause yields claims of
246 and 1149 characters, padded with `Files touched`/`Tools`/`Symbols` template
lines) dominates the comparison, so no whole-claim threshold separates the true
duplicate pair from unrelated records: at any value that merges one, all 42
ordered pairs stay `add`. The same pair's extracted `Root cause:` lines, by
contrast, score **1.000**, with every other pair at **≤0.278**. The defect is the
unit of comparison, not the constant.

### 2.5 Curation is detection-only

`detectConsolidationCandidates` (`src/consolidate.mjs:118`) is pure; at
`src/plugin.mjs:436` its result is counted and logged and then discarded. The
turn-stopping handler (`src/plugin.mjs:364-456`) is synchronous, fire-and-forget,
and registered only inside `if (runtime.observe)`.

## 3. Approaches considered

**A. New retrieval system / embeddings.** Rejected. The blueprint §4.3 and §12
forbid rebuilding retrieval without evidence the existing path fails. The
measured problem is not ranking quality; it is that the same five records are
re-injected and that the records themselves are noise.

**B. Agent-facing memory tools with stronger prompts.** Rejected as the primary
mechanism. It is the manual plugin the user explicitly does not want, and
`GUIDANCE_TEXT` (5856 chars) already asks the agent to call the tools; the
measured result was zero outcome links.

**C. Make evidence trustworthy, make delivery observable, spend fewer tokens on
a better set, and curate at turn end.** Chosen. Every change is local, most are
inside functions that already exist, and each is independently verifiable
against a measured number (capture precision, tokens per turn, delivery
records, merge count).

Rejected within C: a scheduler or daemon. The turn boundary already exists and
is observed; a timer adds a lifecycle the architecture does not have.

## 4. Design

Four phases, each shippable alone, each with a measured exit criterion.

**Phase A — Evidence integrity.** Symbol evidence must come from code, and
grounding must mean a real location or a real test signal. Consequence:
`confidence: medium` starts meaning something, which is what Phase C and the
recall ranking depend on.

**Phase B — Delivery observability.** A `veyra_recall` dispatch is recorded as
`DELIVERED` from inside `veyra_recall`'s own execute, where the returned
`visible` set is already in hand; `veyra_feedback` gains the `generationEventId`
it already forwards internally, closing the attribution loop that today cannot
be entered. The context-provider path stays `NOT_VERIFIED`, because it cannot be
proven — the asymmetry is deliberate and is stated in the code and the health
output rather than smoothed over.

**Phase C — Selective recall.** Identical consecutive recall sets render in a
compact form. This is the only change in the plan that reduces cost, and its
criterion is a token number, not a passing test.

**Phase D — Turn-end curation.** Records that restate the same `Root cause:`
facet merge at write time, so the ledger's `merge: 0` becomes non-zero on real
duplicates without touching the classifier. Consolidation proposals stay
advisory. A delivered record whose turn ended with passing test evidence records
a non-causal outcome automatically. The signal is the outcome Veyra already
derives from tool-result previews (`test-passed` / `test-failed`), not a string
match over tool arguments — `tests-touched` is deliberately excluded, because
"test files were in play" is not evidence that anything passed. The signal is
written to its own bounded log and never touches a record's confidence,
validation, or authority: a passing test correlates with a delivered record, it
does not verify it.

## 5. Non-goals

- No embeddings, hosted RAG, daemon, scheduler, or background worker.
- No model-receipt proof, no `PROVED_APPLIED` claim.
- No automatic `canonical`. Promotion stays an explicit user action.
- No new storage location; all writes stay in the workspace room.
- No change to the `candidate` → `derived` gate ordering or to
  `isRecallEligible`.
- No re-tuning of retrieval scoring in this plan.

## 6. Risks

- Tightening `hasGrounding` lowers confidence on records produced by prose-only
  turns, which reduces what recall returns until Phase A's bash-write detection
  lands. Tasks are ordered A1 (symbols) → A2 (grounding) → A3 (bash writes) so
  the recovery ships in the same phase.
- Recording delivery sits on the tool path, inside `veyra_recall`'s execute.
  It is wrapped so it can never throw; a telemetry failure must not fail a
  recall.
- Compact recall could hide a record the agent needed. Mitigation: the compact
  form keeps every id and title, and full text returns as soon as the set
  changes.
