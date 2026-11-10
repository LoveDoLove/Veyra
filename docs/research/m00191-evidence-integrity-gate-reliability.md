# m00191 — Engineering Evidence Integrity & Learning Gate Reliability

**Repository:** `/home/lovedolove/projects/Veyra` (`@lovedolove/veyra`)
**Baseline commit:** `af40b3c chore: prepare v0.1.75 release` (nothing committed in this round)
**Scope:** minimal repair of the two product defects m00190 exposed, plus regression and mutation tests.
**Verdict:** **READY**

Two sentences carry the acceptance argument:

- **A7** — a file the agent merely *read* can no longer appear as a file it *changed*. Modification evidence now has exactly one source: a tool call that reliably mutates.
- **A5** — the same words in prose, `- `, `* `, `+ `, `1. `, `1) `, and every task-checkbox form (`- [ ] `, `- [x] `, `- [X] `, `* [ ] `, `* [x] `, `+ [ ] `, `1. [ ] `) now produce the identical governance decision, and the fix comes from normalising the text, not from relaxing the gate.
- **Addendum (m07123)** — `- [ ] Do not weaken the tests.` classifies as an instruction exactly like its prose twin. This was the last layout where the *container* decided the verdict, and it sits on the main path: it is what every GitHub issue and PR checklist looks like.

Everything below is this round's own execution. No result is carried over from an earlier round.

---

## 1. A7 — Files touched evidence integrity

### 1.1 Root cause

`observeEvent` recorded file paths for every tool in `INTERESTING_TOOLS`, and `distillBuffer` then unioned in every path named anywhere in the conversation text. Neither step asked *whether the file was modified*.

**Defect site — `src/observe.mjs` (pre-fix):**

```js
if (INTERESTING_TOOLS.has(name)) {
  buffer.tools.push({ name, args: summarizeArgs(args) })
  collectFiles(buffer.files, args)        // ← every tool, no mutation test
}
```

`INTERESTING_TOOLS` includes `read`, `grep`, `glob`, `bash` and `run_code`. `collectFiles` accepts no tool name, so it had no way to know that `read({path:'test/importer.test.mjs'})` changes nothing.

**Second defect site — `src/understand.mjs` `distillBuffer` (pre-fix):**

```js
const files = [...new Set([
  ...(buffer.files || []),
  ...extractMentionedPaths(`${user}\n${assistant}`),   // ← prose merged in
])].slice(0, 12)
```

`files` then drove five consumers — `deriveTitle`, `testOutcomeAnalysis`, `evidenceFrom` (through `repoRelativeAnchor`), `tagsFor` (the `edited` tag), and `describesWork` — and was finally rendered as `Files touched: …`.

**The observed damage (m00190):** the `mem-7` record claimed it had touched `test/importer.test.mjs`; `git status` showed only ` M src/codec.mjs`. The read was indistinguishable from an edit. Because a later agent reads that record as evidence, a false "I changed this file" claim is not cosmetic — it misdirects the next investigation and can trigger a bogus stale/review verdict on the wrong file.

### 1.2 Fix

Modification evidence now comes from one place only: a call that reliably mutates.

**`src/observe.mjs`**

```js
const MUTATING_TOOLS = new Set(['edit', 'write', 'str_replace_editor'])

function mutatesFiles(name, args) {
  if (MUTATING_TOOLS.has(name)) return true
  if (name !== 'run_code') return false
  const description = typeof args?.description === 'string' ? args.description : ''
  const code = typeof args?.code === 'string' ? args.code : ''
  return /(?:edit|write)/i.test(description) || /(?:tools\.edit|tools\.write)/.test(code)
}
```

```js
if (INTERESTING_TOOLS.has(name)) {
  buffer.tools.push({ name, args: summarizeArgs(args) })   // observation evidence: unchanged
  if (mutatesFiles(name, args)) collectFiles(buffer.files, args)   // modification evidence: gated
}
```

The distinction the report requires already existed in the data model — `buffer.tools` records *what the agent did* (read, grep, bash, edit), while `buffer.files` should record *what changed*. The bug was that the second stream was being written from the first. No new structure was introduced; one wrong write was removed.

**`src/understand.mjs`**

```js
const files = [...new Set(buffer.files || [])].slice(0, 12)
```

Prose paths no longer enter modification evidence. `extractMentionedPaths` is untouched and still used where it belongs — relevance, subject matching, anchoring of *claims about* files.

**Fails closed:** an unrecognised tool, and a `run_code` whose own description and code carry no edit/write signal, are treated as non-mutating. `run_code` mirrors the existing corrective-action rule in `understand.mjs` so that tagging and evidence cannot disagree about the same call.

**The four categories are now distinct:**

| Category | Where it lives | Example |
| --- | --- | --- |
| read | `buffer.tools` only | `read`, `grep`, `glob` |
| search | `buffer.tools` only | `bash` tree scan, `grep` |
| write/edit | `buffer.tools` + `buffer.files` + `evidence[].path` | `edit`, `write`, `str_replace_editor`, mutating `run_code` |
| actual Git change | git / `changeSignals` (separate subsystem, untouched) | `git status` |

### 1.3 Evidence

Live end-to-end probe on the exact m00190 `mem-7` shape (read `test/importer.test.mjs`, grep `src`, edit `src/codec.mjs`):

```
buffer.files  : [ 'src/codec.mjs' ]
source.files  : [ 'src/codec.mjs' ]
body Files ln : Files touched: src/codec.mjs
evidence paths: [ 'src/codec.mjs', { note: 'test-passed' } ]
claim on read file? no (correct)
```

Prose-only probe (no mutating call at all, paths named in both user and assistant text):

```
source.files  : []
body has Files line? false
```

The record that previously asserted an edit now asserts nothing, and the record that really did edit still names exactly the edited file.

---

## 2. A5 — Learning Gate format reliability

### 2.1 Root cause

`userAssertsClaim` classifies each sentence of the user turn. A sentence that opens with an imperative is skipped as an instruction; anything that survives `IMPERATIVE_START` *and* matches `CLAIM_HINTS` marks the turn as a user-authored claim, which suppresses `userContextOnly`, which makes `provenanceAllowsLearning` false, which defers the whole turn.

`IMPERATIVE_START` is anchored `^\s*`. It tolerates leading whitespace; it does not tolerate a list marker. So `- Do not weaken the tests.` fell through to `CLAIM_HINTS`, which matches `\bdo not\b` — an *instruction word* — and the instruction became a claim.

**Defect site — `src/understand.mjs` (pre-fix):**

```js
for (const sentence of sentences) {
  if (sentence.length < 12) continue
  if (IMPERATIVE_START.test(sentence)) continue          // ← anchored on the marker
  if (!CLAIM_HINTS.some((re) => re.test(sentence))) continue
  return true
}
```

**Reproduced pre-fix predicate** (same regexes, marker not stripped):

```
PRE-FIX predicate (no marker normalisation):
  INSTRUCTION
    prose          -> false
    dash           -> true     ← defect
    star           -> true     ← defect
    plus           -> true     ← defect
    numbered       -> false
    numberedParen  -> true     ← defect
  CLAIM
    prose          -> true
    dash           -> true
    star           -> true
    plus           -> true
    numbered       -> true
    numberedParen  -> true
```

Identical meaning, opposite governance outcome, decided by typesetting. This is precisely what m00190 hit: `pilot-mem-1` received a bulleted prompt and deferred 2/2 (`{"total":2,"decisions":{"accept":0,"defer":2},"reasons":{"defer/provenance-gated":2}}`), while `pilot-mem-2` with the same content as prose learned 2/2.

### 2.2 Fix

Normalise the incidental markdown prefix before classifying, then judge with exactly the same rules.

```js
const LIST_MARKER = /^(?:[-*+]|\d{1,3}[.)])\s+/
const TASK_BOX = /^(?:\[[ xX]\]\s*)+/
```

```js
const bare = sentence.replace(LIST_MARKER, '').replace(TASK_BOX, '')
if (bare.length < 12) continue
if (IMPERATIVE_START.test(bare)) continue
if (!CLAIM_HINTS.some((re) => re.test(bare))) continue
return true
```

**Why this is not a loosening.** Three things are deliberately unchanged:

1. `IMPERATIVE_START` — not widened, not unanchored. Its alternation is identical.
2. `CLAIM_HINTS` — not widened; still required, and still checked *after* the marker is stripped, so a bulleted sentence with no claim hint stays a non-claim.
3. `looksLikeClaim` — untouched. It is the broad, deliberately loose predicate pinned by `test/m9-provenance-gate.test.mjs` and `src/learn.mjs:27,33`; the fix is confined to the narrow predicate that governs learning.

Nothing else about a sentence changes. A marker is removed; the sentence's words, punctuation, and structure are what get judged. The normalisation cannot admit content the gate would otherwise refuse, because the gate still runs on the remaining text.

**Length-threshold detail worth recording.** The guard moved from `sentence.length` to `bare.length`, so the threshold now measures words rather than words plus marker padding. The value 12 is unchanged and no new threshold was introduced.

This is not cosmetic — it closes the last place where the marker itself decided the verdict. `- The cause.` is 12 characters raw and 10 bare; `The cause.` is 10 both. Pre-fix the bullet cleared the length guard, reached `CLAIM_HINTS`, and returned **true** while its prose twin returned **false**. Post-fix both return **false**, because the guard now sees the same 10 characters in both. The direction is *narrower*, not looser: a sentence that only qualified by virtue of its bullet prefix no longer qualifies. Verified this round:

```
'- The cause.'   full=12 bare=10  pre=true   post=false
'The cause.'     full=10 bare=10  pre=false  post=false
=> pre-fix dash-vs-prose differed (true), post-fix agree (true)
```

#### 2.2.1 Addendum — markdown task checkboxes

The core fix normalised the bullet but not the task checkbox inside it, so the defect survived one level down. `- [ ] Do not weaken the tests.` — the ordinary GitHub-task form — still reached `CLAIM_HINTS`, still hit `do not`, and was still read as a user-authored technical claim. Same for `- [x]` and `- [X]`. Verified pre-fix this round:

```
'- Do not weaken the tests.'        -> false   (fixed by the core change)
'- [ ] Do not weaken the tests.'    -> true    (NOT fixed)
'- [x] Do not weaken the tests.'    -> true    (NOT fixed)
'- [X] Do not weaken the tests.'    -> true    (NOT fixed)
```

**Two-step strip, and why it is two steps.** The first attempt folded the checkbox into the list-marker regex as an optional tail:

```js
const LIST_MARKER = /^(?:[-*+]|\d{1,3}[.)])\s+(?:\[[ xX]\]\s*)?/   // REJECTED
```

That fixed twelve formats but left **`1. [ ] …` still `true`**. The cause is upstream: the sentence splitter is `/(?<=[.!?;])\s+|\n+/`, which breaks after `1.`, so a numbered task item reaches the classifier with its list marker already consumed and the sentence starting at `[ ]`. A regex that requires a marker in front of the checkbox leaves exactly that one layout unfixed. Splitting the strip makes the checkbox removable whether or not a marker survived the split.

**Non-loosening holds for the addendum too.** The checkbox is stripped, then `IMPERATIVE_START` and `CLAIM_HINTS` run unchanged on the remainder. A `[ ]` prefix cannot smuggle a claim past the imperative guard, and it cannot make a hintless sentence qualify. Both directions were tested explicitly (§3).

**Scope of the change.** `LIST_MARKER` loses the optional checkbox tail, `TASK_BOX` is new, and the `bare` assignment gains one `.replace`. `IMPERATIVE_START`, `CLAIM_HINTS`, `looksLikeClaim`, and the splitter are untouched. No A7 code was modified.

### 2.3 Evidence

Live probe through the **real gate** (`writeGate`), one turn per format, identical text, same tool activity (`edit src/codec.mjs` + `bash npm test` + `ok 16 tests passed\n[exit code: 0]`):

**Instructions — all six plain formats accept:**

```
prose          userClaim=false userContextOnly=true  learnable=true  gate=ACCEPT/new-derived-knowledge
dash           userClaim=false userContextOnly=true  learnable=true  gate=ACCEPT/new-derived-knowledge
star           userClaim=false userContextOnly=true  learnable=true  gate=ACCEPT/new-derived-knowledge
plus           userClaim=false userContextOnly=true  learnable=true  gate=ACCEPT/new-derived-knowledge
numbered       userClaim=false userContextOnly=true  learnable=true  gate=ACCEPT/new-derived-knowledge
numberedParen  userClaim=false userContextOnly=true  learnable=true  gate=ACCEPT/new-derived-knowledge
```

That probe predates the addendum and covers six formats. After the addendum the gate-level parity test was extended to iterate **all thirteen** formats by extending the shared `FORMATS` map, so it now asserts the stronger claim on its own:

```
A5: every list format reaches the same gate decision
  FORMATS = prose, dash, star, plus, numbered, numberedParen,
            dash-open, dash-done, dash-DONE, star-open, star-done,
            plus-open, numbered-open
  assert.equal(distinct.size, 1)        // every format agrees
  assert.deepEqual([...distinct], ['ACCEPT'])
  => 13 formats, 1 distinct decision, ACCEPT
```

This is stronger evidence than a printed table because it *fails* if any single format disagrees.

**Genuine user claims — still defer in every format:**

```
prose          userClaim=true  userContextOnly=undefined learnable=false gate=DEFER/provenance-gated
dash           userClaim=true  userContextOnly=undefined learnable=false gate=DEFER/provenance-gated
star           userClaim=true  userContextOnly=undefined learnable=false gate=DEFER/provenance-gated
plus           userClaim=true  userContextOnly=undefined learnable=false gate=DEFER/provenance-gated
numbered       userClaim=true  userContextOnly=undefined learnable=false gate=DEFER/provenance-gated
numberedParen  userClaim=true  userContextOnly=undefined learnable=false gate=DEFER/provenance-gated
```

A genuinely claim-bearing prompt is still `DEFER/provenance-gated` in every format — the fix did not open a path for user-authored technical claims to be learned as if the agent had verified them.

---

## 3. New regression tests

New file: **`test/m191-evidence-integrity.test.mjs`** (385 lines, LF, 24 tests).

It asserts both layers on purpose. Asserting only the gate would be vacuous — other rules also defer, so a gate-only test can pass for the wrong reason, which is exactly what the order forbids. The text layer is tested directly, and then the gate decision it is supposed to cause is tested on top.

**A7 (10 tests):** read; grep/glob; bash; write; edit (including that the anchor is still a real path); `str_replace_editor` + `run_code` opaque + `run_code` **read-only with an extractable path** + `run_code` explicit edit; prose-only paths; no tool activity; read-then-edit; tool names preserved.

The read-only `run_code` case exists because mutation testing demanded it — see §4.

**A5, plain formats (9 tests):** instruction parity across all six plain formats; claim parity across all six plain formats; cross-format unanimity as a single property (`new Set(verdicts).size === 1`); non-loosening (`'- Add a null check to the parser before the loop runs.'` → false, `'- Do not introduce a race in the writer path.'` → false, `'- There is a race in the writer path because the lock is released early.'` → true); mixed list judged sentence by sentence; and gate-level ACCEPT parity, cross-format equality, and claim-bearing DEFER.

**A5, checkbox addendum (5 tests):** the `FORMATS` map gained seven task-list entries — `dash-open` (`- [ ] `), `dash-done` (`- [x] `), `dash-DONE` (`- [X] `), `star-open` (`* [ ] `), `star-done` (`* [x] `), `plus-open` (`+ [ ] `), `numbered-open` (`N. [ ] `) — bringing it to **thirteen** formats, and `CHECKBOX_FORMATS` is derived from it by name filter so the two can never drift apart. The five tests are:

1. `A5: task checkboxes do not change how an instruction is judged` — `- [ ] Do not weaken the tests.` classifies exactly like the prose sentence.
2. `A5: a numbered task checkbox is stripped even though the splitter ate the marker` — the layout my first attempt left broken, plus the orphaned `'[ ] Do not weaken the tests.'` that reaches the classifier when the splitter has consumed `1.`.
3. `A5: task checkboxes do not change how a declarative claim is judged` — the fix must not turn a real claim into an instruction in the other direction either.
4. `A5: checkbox normalisation does not loosen the gate` — after stripping the box, `CLAIM_HINTS` is still required; hintless text stays unlearnable.
5. `A5: every checkbox format agrees with prose, exactly` — one distinct verdict across the whole checkbox family.

Because the pre-existing gate-level test iterates `Object.entries(FORMATS)`, extending that map automatically extended it from six formats to thirteen with no edit to the assertion itself. That is the desired shape: the property ("every format agrees") was already written correctly, and the addendum only widened the input set it runs over.

**Result this round:**

```
node --test test/m191-evidence-integrity.test.mjs
ℹ tests 24   ℹ pass 24   ℹ fail 0   ℹ duration_ms 226.134585

--test-name-pattern='A5: (task checkboxes|a numbered task checkbox|checkbox normalisation|every checkbox format|only real checkbox)'
ℹ tests 5    ℹ pass 5    ℹ fail 0
```

**Repaired pre-existing fixture — `test/title-generation-regression.test.mjs:142`.**

After the A7 fix this test failed (`assert.ok(record)` → null). The cause is instructive: its local `makeBuffer` helper ignores its `files:` argument, and both of its text lines were below the noise floor (`MIN_OBSERVATION_CHARS = 40`, `src/types.mjs:85`). The record had existed **only** because the `read` call was miscounted as a modification — that fabricated `Files touched: src/store.mjs` line was the entire body. The test was passing on the defect.

Repaired by giving the fixture a user line that survives the noise filter (`'Running the test suite to verify the change in the store module.'`, 65 chars), removing the `files:` argument that never worked, and adding an assertion that a read leaves no modification evidence. **The product fix was not weakened to accommodate the fixture.** Suite result: 26/26.

---

## 4. Mutation tests and independence proof

Script: **`scripts/m191-mutations.mjs`** (160 lines, new).

### 4.1 Design

Fourteen mutations, each asserting one part of the two fixes — plus the addendum — is load-bearing:

| # | Mutation | Must be caught by |
| --- | --- | --- |
| A7-1 | restore unconditional `collectFiles` (the original defect) | A7 tests |
| A7-2 | `MUTATING_TOOLS.has(name)` → `return false` | A7 tests |
| A7-3 | empty the mutating-tool set | A7 tests |
| A7-4 | unknown tools count as mutations (a read becomes an edit) | A7 tests |
| A7-5 | `run_code` always counts as a mutation | A7 tests |
| A7-6 | re-merge `extractMentionedPaths` into `files` | A7 tests |
| A5-1 | don't normalise the marker at all (`bare = sentence`) | A5 text tests |
| A5-2 | test `IMPERATIVE_START` on the un-normalised sentence | A5 text tests |
| A5-3 | anchor `LIST_MARKER` with `$` so it never matches | A5 text tests |
| A5-4 | `return true` at the top of the loop (gate loosened) | A5 text tests |
| A5-5 | `TASK_BOX` never matches (the addendum defect) | checkbox tests |
| A5-6 | checkbox stripped only when a list marker precedes it (my rejected v1) | checkbox tests |
| A5-7 | `TASK_BOX` anchored with `$` so it never matches | checkbox tests |
| A5-8 | checkbox strip loosened into a blanket prefix wipe | checkbox tests |

### 4.2 Independence

Independence is enforced by the test selection, not asserted in prose:

- **A7 mutations** run against `--test-name-pattern='A7:'`. Every A7 test reads `buffer.files`, `record.source.files`, or `record.body` directly — none of them goes through the write gate.
- **A5 mutations** run against `--test-name-pattern='A5: (instructions|declarative|identical|normalisation|mixed)'`, which selects **only the five text-layer tests**. Verified:

  ```
  node --test --test-name-pattern='A5: (instructions|declarative|identical|normalisation|mixed)' …
  ✔ A5: instructions are not user claims in ANY list format
  ✔ A5: declarative claims are user claims in EVERY list format
  ✔ A5: identical meaning gives an identical verdict across formats
  ✔ A5: normalisation does not loosen the gate — claim hints are still required
  ✔ A5: mixed list is judged sentence by sentence, not by its first line
  ℹ tests 5   ℹ pass 5
  ```

  Every `gateFor`-based test (ACCEPT parity, DEFER parity) is excluded by the pattern, so **no gate-level assertion can catch an A5 text-layer mutation.** If a gate test were doing the catching, the A5 mutations would not prove the normalisation is load-bearing.

- **Checkbox mutations** (addendum) run against their own narrowed pattern, `'A5: (task checkboxes|a numbered task checkbox|checkbox normalisation|every checkbox format|only real checkbox)'`, which selects **only the five checkbox tests**. Verified:

  ```
  node --test --test-name-pattern='A5: (task checkboxes|a numbered task checkbox|checkbox normalisation|every checkbox format|only real checkbox)' …
  ✔ A5: task checkboxes do not change how an instruction is judged
  ✔ A5: a numbered task checkbox is stripped even though the splitter ate the marker
  ✔ A5: task checkboxes do not change how a declarative claim is judged
  ✔ A5: checkbox normalisation does not loosen the gate
  ✔ A5: every checkbox format agrees with prose, exactly
  ℹ tests 5   ℹ pass 5
  ```

  This is narrowed a second time on purpose. The plain-bullet A5 tests would *also* fail under several checkbox mutations, and letting them be the catchers would hide the fact that the checkbox fix specifically is load-bearing. The bullet tests are excluded here, so a regression in `TASK_BOX` cannot be masked by the bullet path still working.

The script also refuses to run a mutation whose target pattern is missing or ambiguous, restores the source immediately after each mutation (so a crash cannot leave a mutated tree), restores again in `finally`, and then **re-reads both files to prove byte-for-byte restoration** before exiting. Exit code is 0 only if all fourteen were caught *and* both files were restored.

### 4.3 Results

First run: **9/10**. `A7-5` (make `run_code` always mutate) survived.

That was a real gap in my test, not a weak fix. The `run_code` "inspect" case had no extractable path, so `collectFiles` added nothing and the always-mutate mutation was invisible — the test could not distinguish "the judgement was correct" from "there was nothing to judge". Fixed by adding a read-only `run_code` case that *does* name a file:

```js
code: 'await tools.read({ file_path: "src/cache.ts" })'
```

The path is extractable, so only the mutation judgement can keep it out of modification evidence.

Second and third runs, identical, on the final normalised source:

```
CAUGHT   A7-1: record every tool path as a modification (the original defect)
CAUGHT   A7-2: never treat a known mutator as mutating
CAUGHT   A7-3: mutating-tool set emptied
CAUGHT   A7-4: unknown tools count as mutations (read becomes an edit)
CAUGHT   A7-5: run_code always counts as a mutation
CAUGHT   A7-6: prose-mentioned paths merged back into modification evidence
CAUGHT   A5-1: list markers not normalised at all
CAUGHT   A5-2: imperative guard reads the un-normalised sentence
CAUGHT   A5-3: marker regex can never match a sentence that has content
CAUGHT   A5-4: over-normalisation — every sentence counts as a claim (gate loosened)
```

Addendum run, after the checkbox fix and its four new mutations:

```
CAUGHT   A5-5: task checkbox not stripped (the addendum defect)
         -> A5: task checkboxes do not change how an instruction is judged
CAUGHT   A5-6: checkbox stripped only when a list marker precedes it
         -> A5: task checkboxes do not change how an instruction is judged
CAUGHT   A5-7: checkbox regex cannot match a sentence with content after it
         -> A5: task checkboxes do not change how an instruction is judged
CAUGHT   A5-8: checkbox strip loosened into a blanket prefix wipe
         -> A5: task checkboxes do not change how an instruction is judged;
            A5: checkbox normalisation does not loosen the gate;
            A5: every checkbox format agrees with prose, exactly

Source restored byte-for-byte: YES
14/14 caught
exit=0
```

`A5-6` is the mutation that reproduces my own rejected first attempt — folding the checkbox into the list-marker regex. It is caught, which means the numbered-task layout that attempt left broken is now genuinely covered by a test rather than only by manual probing.

`A5-8` replaces the strip with a blanket "wipe every non-alphanumeric prefix" — the obvious wrong way to normalise. It is caught by three tests at once, including the non-loosening test, because over-normalisation lets content through that the strict rules would have refused.

Repeatability: three runs of the 10-mutation suite, identical outcomes; the addendum suite run once more after the final edit with the same 14/14. Source restoration verified by re-reading both files and by `git diff --stat` returning the same shape afterwards.

---

## 5. Full test results

All numbers below were produced **this round**, after the final edit.

| Run | Command | Result |
| --- | --- | --- |
| New regression file | `node --test test/m191-evidence-integrity.test.mjs` | **24 / 24 pass / 0 fail** (`duration_ms 226.134585`) |
| A7 subset | `node --test --test-name-pattern='A7:' …` | **10 / 10 pass / 0 fail** |
| A5 text subset | `--test-name-pattern='A5: (instructions\|…)'` | **5 / 5 pass / 0 fail** |
| A5 checkbox subset | `--test-name-pattern='A5: (task checkboxes\|…)'` | **5 / 5 pass / 0 fail** |
| Mutation gate | `node scripts/m191-mutations.mjs` | **14 / 14 caught**, restored YES, exit 0 |
| Full suite | `npm test` | **1110 tests / 1110 pass / 0 fail**, 13 suites, `duration_ms 4264.824414` |

Full suite composition: 1086 pre-existing + 24 new = 1110.

Intermediate results worth disclosing:
- After the A7 fix but before the A5 fix, the full suite was **1086 / 1085 pass / 1 fail** — the `title-generation-regression` fixture described in §3. That failure was the A7 defect becoming visible, and it was repaired at the fixture, not at the product.
- After the A5 core fix the suite was 1105 / 1105. The addendum added 5 tests (19 → 24) and changed no product behaviour except the checkbox path, so the only movement is 1105 → 1110.

---

## 6. Changed files and Git state

HEAD is still `af40b3c chore: prepare v0.1.75 release`. **Nothing was committed, pushed, tagged, released, or published.**

| File | Change |
| --- | --- |
| `src/observe.mjs` | `MUTATING_TOOLS` + `mutatesFiles`; gate `collectFiles` behind it (`1 file changed, 28 insertions(+), 1 deletion(-)`) |
| `src/understand.mjs` | `LIST_MARKER` + `TASK_BOX` + two-step strip in `userAssertsClaim`; `files` no longer merges prose paths |
| `test/m191-evidence-integrity.test.mjs` | **new** (385 lines, 24 tests) |
| `scripts/m191-mutations.mjs` | **new** (160 lines, 14 mutations) |
| `test/title-generation-regression.test.mjs` | fixture repaired (it was passing on the A7 defect) |

`git diff --stat` reports 55 files / `2277 insertions(+), 915 deletions(-)`. **That is not this round.** The working tree already carried the uncommitted m00188 work (activation, context, learn, tools, webui, client.js, docs, ~45 test files) when m00191 began; those files must be preserved and were not touched. This round's edits are the five files above and nothing else — confirmed by reading the hunk map of `src/understand.mjs` and matching every remaining hunk to pre-existing m00188 work. This round's own tracked diff is `3 files changed, 372 insertions(+), 49 deletions(-)` (`src/observe.mjs` 28 ++-, `src/understand.mjs` 382 ++++, `test/title-generation-regression.test.mjs` 11 +-), the large `src/understand.mjs` figure being almost entirely pre-existing m00188 hunks (30 of them) plus my two small hunks.

`git status --porcelain` count is **82**, unchanged from before this round — no pre-existing modification or untracked file was lost, and the five new/changed paths were already inside that count.

**Line-ending incident, disclosed:** while editing `src/observe.mjs`, my own write path converted the file to CRLF (213 CRLF lines) while `HEAD` and every other file in the repository are LF (`.gitattributes` = `* text=auto`; `core.autocrlf` unset). Git warned on the next diff. I normalised the file back to LF (213 bytes removed, 0 CR remaining), which shrank `git diff --stat src/observe.mjs` from a 368-line phantom churn to the true `28 insertions(+), 1 deletion(-)`, and re-verified the fix intact at `src/observe.mjs:47`, `:58`, `:139`. The mutation suite was then re-run on the normalised source so the result corresponds to the exact bytes the full suite validated. Lesson recorded: check `grep -c $'\r'` against `git show HEAD:<file>` after any bulk rewrite, before reporting a diff.

Line endings were checked again at the end of the addendum: `grep -c $'\r'` returns **0** for `src/understand.mjs`, `test/m191-evidence-integrity.test.mjs`, `scripts/m191-mutations.mjs`, and `test/title-generation-regression.test.mjs`. The addendum edit touched only lines that were already LF and introduced none.

**Untracked files preserved:** all pre-existing untracked files remain untouched, including the new `test/m191-evidence-integrity.test.mjs` and `scripts/m191-mutations.mjs`.

Production `~/.dsh/veyra/` was not read or written. No DSH Web process was stopped, restarted, disabled, or reconfigured.

---

## 7. Known limits and unresolved issues

1. **`run_code` classification is heuristic.** A `run_code` call mutates only if its `description` mentions edit/write or its `code` invokes `tools.edit`/`tools.write`. Code that writes through a shell-out (`await tools.bash({command:'sed -i …'})`) or a dynamic dispatcher is classified as non-mutating. This direction is deliberate — it fails closed, and a missed modification is far less harmful than a fabricated one — but it is a heuristic, not a proof, and cannot be made exact without executing or statically analysing arbitrary code.
2. **`bash` mutations are not tracked.** `sed -i`, `> file`, `git apply` inside `bash` never reach `buffer.files`, before or after this change. Modification evidence for shell-driven edits was already absent; the fix does not add it, because doing so reliably would require parsing shell semantics. Recorded here so no one reads `files` as a complete change set.
3. **Git truth is a separate subsystem.** `buffer.files` is *observed activity*, not a diff. Where a record genuinely needs ground truth, the change-signal path (`src/context.mjs:758`, `recordRepositoryChange`) is the authority — the two were not merged and should not be.
4. **The marker regex is markdown-shaped.** `- `, `* `, `+ `, `1. `, `1)` are recognised, and task-list boxes `- [ ] `/`- [x] `/`- [X] ` are stripped by `TASK_BOX` (addendum). Still **not** recognised: `a) `, `• `, and any other bullet glyph outside `-`/`*`/`+`. These were left out to keep the change minimal; each closes with a one-line regex extension if a real corpus shows them. Task boxes were promoted from residual to fixed because `- [ ] Do not weaken the tests.` is not an exotic glyph — it is what every GitHub issue and PR checklist looks like, so the defect sat squarely on the main path.
5. **A7 alters distilled record bodies.** Turns that only read files now produce a body without a `Files touched:` line, which changes what `MIN_OBSERVATION_CHARS` sees and therefore which turns are durable at all. This is the intended correction, but it means A7 is a behavioural change to what gets remembered, not just a labelling fix. `src/diff.mjs:21` strips `Files touched` from claim text (`TEMPLATE_LINES`), so contradiction detection is unaffected — verified by the full suite.
6. **Neither fix has been validated on live agent traffic.** All evidence here is unit- and gate-level, plus one probe reproducing the m00190 `mem-7` shape. Whether the corrected evidence actually improves a later agent's behaviour is an effectiveness question, and m00190 is the cautionary precedent: mechanism-correct did not mean outcome-effective.

---

## 8. CTO acceptance recommendation

**READY.**

Against the CEO principle — *"不能只让测试通过，必须证明错误证据不会再被当成事实，且语义相同的输入不会因格式不同而得到不同治理结果"* — both halves have execution evidence, not just green tests:

**错误证据不会再被当成事实 (false evidence is no longer treated as fact).** The `mem-7` shape — read `test/importer.test.mjs`, edit `src/codec.mjs` — now reports `source.files = ['src/codec.mjs']` and never mentions the read file. A prose-only turn reports `source.files = []` and renders no `Files touched:` line. Demonstrated live in §1.3, asserted in ten regression tests, and proven load-bearing by six mutations, including one that restores the original defect verbatim (A7-1) and one that re-merges prose paths (A7-6).

**语义相同的输入不会因格式不同而得到不同治理结果 (identical meaning gets identical governance).** The pre-fix predicate genuinely produced opposite verdicts for the same words in prose versus a bullet (`false` vs `true`), reproduced from the actual regexes in §2.1. Post-fix, all thirteen forms — prose, six bullet layouts, and seven task-checkbox layouts — reach `ACCEPT/new-derived-knowledge` for instructions and `DEFER/provenance-gated` for genuine claims, shown through the real `writeGate`, not a stub. The addendum closed the last layout family where the container decided the verdict: `- [ ] Do not weaken the tests.` was `true` before and is `false` now. Eight A5 mutations killed by text-layer tests alone, with every gate-level test excluded from the mutation run, so the proof cannot be borrowed from another rejection gate — and the four checkbox mutations run against a *second* narrowed pattern that also excludes the plain-bullet tests, so a checkbox regression cannot be masked by the bullet path still working.

**What I would want a reviewer to check:**

- That A5's normalisation does not widen the gate. The evidence is §2.3's second table: claim-bearing prompts still defer in every format, and `CLAIM_HINTS` is still consulted after stripping.
- That the `title-generation-regression` fixture repair is not papering over the product. The fixture had been passing *because of* the defect; the assertion added in its place now guards the correct behaviour.
- That the addendum's two-step strip is deliberate rather than sloppy. §2.2.1 gives the rejected one-regex attempt, the numbered-item failure it left behind, and the mutation (A5-6) that now pins it.
- That §7.4's remaining gaps (`a) `, `• `) are accepted as bounded residuals rather than oversights, and §7.5 (A7 changes what gets remembered) is accepted as intended.

**Not authorised and not done:** no architecture change, no change to the auto-learn or auto-recall mechanism, no change to Clean Break / Workspace Isolation / Central Promotion, no new dependency, no touch to old `projects/` or `reusable/` or production `~/.dsh/veyra/`, no DSH Web restart, no commit / push / tag / release / publish.
