# Autonomous Engineering Memory Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Veyra capture only evidence-backed engineering knowledge and prove, per turn, that recalled memory actually reached the agent — without adding a manual step for the agent.

**Architecture:** Four independent phases on existing seams. Capture quality is fixed inside `extractSymbols`/`hasGrounding`/`collectFiles`. Delivery attribution is fixed inside `recordGenerationEvidence` plus one declared tool parameter. Recall cost is fixed in `src/context.mjs`. Curation is fixed in the existing `agent/turn-stopping` handler. No new module, dependency, daemon, or storage location.

**Tech Stack:** Node ≥22.5 ESM, `node --test`, existing SQLite/FTS5 `MemoryStore`, Cordis plugin hooks.

**Spec:** `docs/superpowers/specs/2026-11-11-autonomous-engineering-memory-design.md`

## Global Constraints

- Baseline before any task: `node --test test/*.test.mjs` → `# tests 1113 / pass 1113 / fail 0`. Every task ends at 1113 + its own added tests, zero failures.
- Never write outside the workspace room: storage stays under `$DSH_HOME/veyra/rooms/<roomId>/`, keyed by `WorkspaceId`, never by path (`src/rooms.mjs`).
- `canonical` is assigned only by explicit user action; `assertAuthorityTransition` must keep refusing otherwise.
- Every persistence path goes through `src/redact.mjs`; no task adds a bypass.
- `isLifecycleEligible`/`isRecallEligible` (`src/types.mjs:97,122`) are not modified.
- Observation and recall failures degrade; they never throw into the agent loop. New turn-stop work stays inside `try/catch`.
- No test may touch the live DSH home or `http://127.0.0.1:3080`; all fixtures use `os.tmpdir()`.
- No new npm dependency. No retrieval-scoring re-tuning. No embedding or vector store.
- Every new threshold is a named exported constant, never a bare literal.

## Review Focus

1. **False grounding survives the fix** — a prose sentence must not yield symbol evidence, because `sym:` alone currently sets `confidence: medium`. Pinned by `real prose yields no symbols` (Task 1) and `symbol-only evidence is not grounding` (Task 2).
2. **Delivery label overclaims** — `DELIVERED` must never be written for the context-provider path, only for a tool dispatch that returned records. Pinned by `context provider path stays NOT_VERIFIED` (Task 4).
3. **Recall write widens access** — recording delivery must not let a read operation write anywhere it could not before. Pinned by `recall delivery write is refused without a workspace binding` (Task 4).
4. **Near-duplicate merge eats distinct lessons** — a looser duplicate threshold could merge two different root causes. Pinned by `distinct root causes are not merged` (Task 7) plus the existing `test/m12-consolidation.test.mjs:105` false-duplicate test.
5. **Automatic outcome inflates confidence** — a turn that passed tests must not silently promote a memory. Pinned by `auto outcome never changes confidence` (Task 8).

---

### Task 1: Code-shape guard for symbol evidence

**Files:**
- Modify: `src/understand.mjs:71` (regex area), `src/understand.mjs:477-487` (`extractSymbols`)
- Test: `test/symbol-evidence.test.mjs` (Create)

**Interfaces:**
- Consumes: nothing new.
- Produces: `extractSymbols(text: string): string[]` — unchanged signature and return type; now returns only identifiers followed by a code shape. `CODE_SHAPE_AFTER` is a new module-level `RegExp`.

- [ ] **Step 1: Write the failing test**

Create `test/symbol-evidence.test.mjs`:

```js
import test from 'node:test'
import assert from 'node:assert/strict'
import { extractSymbols } from '../src/understand.mjs'

test('real prose yields no symbols', () => {
  const prose = 'I need to check the body signature and the args that the function receives. The const value is undefined here.'
  assert.deepEqual(extractSymbols(prose), [])
})

test('code-shaped declarations still yield symbols', () => {
  assert.deepEqual(extractSymbols('export async function lockWriter() {}'), ['lockWriter'])
  assert.deepEqual(extractSymbols('export function lockWriter() { return 1 }'), ['lockWriter'])
  assert.deepEqual(extractSymbols('const path = 1'), ['path'])
  assert.deepEqual(extractSymbols('class Foo {'), ['Foo'])
})

test('prose mention of a real identifier is not a declaration', () => {
  assert.deepEqual(extractSymbols('Looking at this, the `const body` line matters.'), [])
})

test('live garbage title yields no symbols', () => {
  assert.deepEqual(extractSymbols('Cause: of low quality? Let me verify quickly the actual reason: looksDurable = logic'), [])
})
```

- [ ] **Step 2: Run it and watch it fail**

Run: `node --test test/symbol-evidence.test.mjs`
Expected: exactly 2 of 4 tests fail (measured):
- `real prose yields no symbols` → `actual: [ 'receives', 'value' ]`
- `prose mention of a real identifier is not a declaration` → `actual: [ 'body' ]`

The other two already pass today and are regression guards, not driver tests:
`code-shaped declarations still yield symbols` and `live garbage title yields no
symbols` (that title has no `SYMBOL_RE` match at all). If you see any other
failure count, stop — the fixture drifted, not the code.

- [ ] **Step 3: Implement the guard**

In `src/understand.mjs`, next to `SYMBOL_RE` (:71), add:

```js
// A declaration is only a declaration when a code shape follows the name.
// `const value` inside a sentence is prose, and prose symbols become `sym:`
// evidence, which is enough to make a record look grounded (learn.hasGrounding).
const CODE_SHAPE_AFTER = /^[)\s]*[(){}[\]=:,;]/
```

In `extractSymbols` (:477), inside the `while` loop, replace the unconditional `found.push(match[1])` with:

```js
const rest = text.slice(match.index + match[0].length)
if (rest === '' || CODE_SHAPE_AFTER.test(rest)) found.push(match[1])
```

- [ ] **Step 4: Run to pass, then the full suite**

Run: `node --test test/symbol-evidence.test.mjs` → 4 pass.
Run: `node --test test/brain.test.mjs test/code-commands.test.mjs test/code-linking.test.mjs test/code-tools.test.mjs test/health-learning.test.mjs test/title-generation-regression.test.mjs`
Expected: all pass, including `test/brain.test.mjs:34` (`sym:lockWriter`) and `:37`.
Run: `node --test test/*.test.mjs` → 1117 pass, 0 fail.

- [ ] **Step 5: Commit**

```bash
git add src/understand.mjs test/symbol-evidence.test.mjs
git commit -m "fix: require a code shape before recording symbol evidence"
```

---

### Task 2: Grounding means a real location or a real test signal

**Files:**
- Modify: `src/learn.mjs:69-76` (`hasGrounding`)
- Verify unchanged: `src/health.mjs:130,134` (the other `hasGrounding` callers — health findings consume the same predicate; do not edit them, but their fixtures are the blast radius)
- Test: `test/grounding-integrity.test.mjs` (Create)

**Interfaces:**
- Consumes: `extractSymbols` guard from Task 1.
- Produces: `hasGrounding(candidate): boolean` — same signature; `note` values matching `/^sym:/` no longer ground a record on their own.

**Blast radius (read before editing).** `hasGrounding` has two call sites:
`src/learn.mjs:675` (confidence assignment) and `src/health.mjs:130,134` (health
findings). Tightening it changes health output too, so the at-risk existing
fixture is `test/health-learning.test.mjs:97-103`; run that file together with
`test/learn-safety.test.mjs` and `test/m6-feedback-recurrence.test.mjs` before
accepting the change.

- [ ] **Step 1: Write the failing test**

Create `test/grounding-integrity.test.mjs`:

```js
import test from 'node:test'
import assert from 'node:assert/strict'
import { hasGrounding } from '../src/learn.mjs'

test('symbol-only evidence is not grounding', () => {
  assert.equal(hasGrounding({ evidence: [{ note: 'sym:receives' }, { note: 'sym:value' }] }), false)
})

test('a real path is grounding', () => {
  assert.equal(hasGrounding({ evidence: [{ path: 'src/store.mjs' }] }), true)
})

test('a test signal is grounding', () => {
  assert.equal(hasGrounding({ evidence: [{ note: 'test-passed: 42 pass' }] }), true)
})

test('path plus symbol is grounding', () => {
  assert.equal(hasGrounding({ evidence: [{ path: 'src/x.mjs' }, { note: 'sym:lockWriter' }] }), true)
})
```

- [ ] **Step 2: Run it and watch it fail**

Run: `node --test test/grounding-integrity.test.mjs`
Expected: `symbol-only evidence is not grounding` fails with `actual: true`.

- [ ] **Step 3: Implement**

Replace the body of `hasGrounding` (`src/learn.mjs:69`):

```js
export function hasGrounding(candidate) {
  const evidence = candidate?.evidence || []
  // A symbol note only says a name appeared; it is not a location and not a
  // result. Counting it as ground is what gave prose records `medium`.
  const located = evidence.some((item) => item && (item.path || item.uri || item.anchor))
  if (located) return true
  const signalled = evidence.some((item) => typeof item?.note === 'string' && item.note && !/^sym:/.test(item.note))
  if (signalled) return true
  const files = candidate?.source?.files || []
  return files.length > 0
}
```

- [ ] **Step 4: Run to pass, then the suite**

Run: `node --test test/grounding-integrity.test.mjs` → 4 pass.
Run: `node --test test/learn-safety.test.mjs test/health-learning.test.mjs test/m6-feedback-recurrence.test.mjs`
Expected: all pass unchanged — those fixtures ground via `path: 'src/x.mjs'` / `path: 'src/store.mjs'`.
Run: `node --test test/*.test.mjs` → 1121 pass, 0 fail.

- [ ] **Step 5: Commit**

```bash
git add src/learn.mjs test/grounding-integrity.test.mjs
git commit -m "fix: stop treating symbol-only evidence as grounding"
```

---

### Task 3: Writes performed through bash are evidence

**Files:**
- Modify: `src/observe.mjs:58-70` (`mutatesFiles`), `src/observe.mjs:183-195` (`collectFiles`)
- Test: `test/bash-write-evidence.test.mjs` (Create)

**Interfaces:**
- Consumes: `summarizeArgs` already retains `command` (`src/observe.mjs:170`).
- Produces: `collectFiles(files: Set<string>, args: object): void` — same signature, now also adds paths from `args.command`. `commandWritePaths(command: string): string[]` is a new module-private helper. `mutatesFiles` stays module-private.

- [ ] **Step 1: Write the failing test**

Create `test/bash-write-evidence.test.mjs`:

```js
import test from 'node:test'
import assert from 'node:assert/strict'
import { observeEvent, newBuffer } from '../src/observe.mjs'

function call(buffer, name, args) {
  observeEvent(buffer, {}, { type: 'tool/call', data: { name, arguments: JSON.stringify(args), callId: 'c1' } })
}

test('sed -i records the edited file', () => {
  const b = newBuffer()
  call(b, 'bash', { command: "sed -i 's/a/b/' src/store.mjs" })
  assert.ok(b.files.has('src/store.mjs'))
})

test('shell redirection records the target file', () => {
  const b = newBuffer()
  call(b, 'bash', { command: 'echo "x" > src/new.mjs' })
  assert.ok(b.files.has('src/new.mjs'))
})

test('tee records its target file', () => {
  const b = newBuffer()
  call(b, 'bash', { command: 'cat a | tee src/out.mjs' })
  assert.ok(b.files.has('src/out.mjs'))
})

test('scratch and device paths are not evidence', () => {
  const b = newBuffer()
  call(b, 'bash', { command: 'node probe.cjs > /dev/null 2>&1' })
  call(b, 'bash', { command: 'echo x > /tmp/probe.cjs' })
  assert.deepEqual([...b.files], [])
})

test('a read-only bash command records nothing', () => {
  const b = newBuffer()
  call(b, 'bash', { command: 'grep -rn lockWriter src/' })
  assert.deepEqual([...b.files], [])
})
```

- [ ] **Step 2: Run it and watch it fail**

Run: `node --test test/bash-write-evidence.test.mjs`
Expected: the first three tests fail with `files` empty; the last two already pass.

- [ ] **Step 3: Implement**

Next to `mutatesFiles` (`src/observe.mjs:58`) add:

```js
// A write performed through bash leaves no file evidence today: `sed -i` and
// `>` both change the repo while `mutatesFiles` sees only `run_code`.
// A single regex cannot do this — `sed -i 's/a/b/' f.mjs` would capture the
// script, not the file — so the command is tokenized instead.
const REDIRECT_TARGET = />>?\s*([^\s;|&>]+)/g
const SED_IN_PLACE = /\bsed\s+-i\S*\s+(.*)$/g
const TEE_TARGET = /\btee(?:\s+-a)?\s+(.*)$/g
const NON_EVIDENCE_PATH = /^(?:\/dev\/null|\/dev\/stdout|\/dev\/stderr|\/tmp\/|\.git\/)/

function commandWritePaths(command) {
  const out = []
  if (typeof command !== 'string' || !command) return out
  let m
  REDIRECT_TARGET.lastIndex = 0
  while ((m = REDIRECT_TARGET.exec(command))) out.push(m[1])
  SED_IN_PLACE.lastIndex = 0
  while ((m = SED_IN_PLACE.exec(command))) {
    // Drop the quoted script and flags; what remains ends with the file.
    const tokens = m[1].replace(/(?:'[^']*'|"[^"]*")/g, ' ').trim().split(/\s+/).filter(Boolean)
    const files = tokens.filter((t) => !t.startsWith('-') && !/^s[/|#]/.test(t))
    if (files.length) out.push(files[files.length - 1])
  }
  TEE_TARGET.lastIndex = 0
  while ((m = TEE_TARGET.exec(command))) {
    const files = m[1].split(/\s+/).filter(Boolean).filter((t) => !t.startsWith('-'))
    if (files.length) out.push(files[0])
  }
  return out.filter((p) => !NON_EVIDENCE_PATH.test(p))
}
```

Do **not** export `mutatesFiles` — it stays module-private exactly as it is today; the tests drive it through `observeEvent`. Add one branch to its existing body:

```js
if (name === 'bash' && typeof args?.command === 'string' && commandWritePaths(args.command).length > 0) {
  return true
}
```

Every pattern above is a global regex, so `lastIndex` persists between calls: reset it before each use, as shown. A missed reset makes the second identical call silently find nothing.

**Known limitation — multi-file `sed -i` (record it, do not hide it).**
`sed -i 's/x/y/' src/a.mjs src/b.mjs` yields `["src/b.mjs"]` only: the
`sed` branch takes `files[files.length - 1]`, so every earlier file is dropped.
This is acceptable for the phase goal — one real edited file is enough to make a
record grounded, and the failure direction is under-claiming, not false evidence —
but it must be visible. Add this comment directly above the `sed` branch:

```js
// Multi-file `sed -i … a b c` records only the LAST path; earlier targets are
// dropped. Under-claims evidence (safe direction). Do not treat one recorded
// path as the complete write set.
```

Do not attempt to parse every trailing token: `sed -i 's/a b/c/' f.mjs` and
`sed -i -e 's/x/y/' f.mjs` make token-splitting unreliable, and a wrong guess
would invent evidence for files that were never written.

In `collectFiles` (`src/observe.mjs:183`), after the existing `code` scan:

```js
if (typeof args?.command === 'string') {
  for (const target of commandWritePaths(args.command)) files.add(target)
}
```

- [ ] **Step 4: Run to pass, then the suite**

Run: `node --test test/bash-write-evidence.test.mjs` → 5 pass.
Run: `node --test test/observe.test.mjs test/brain.test.mjs test/turn-stopping-learning.test.mjs`
Run: `node --test test/*.test.mjs` → 1126 pass, 0 fail.

- [ ] **Step 5: Commit**

```bash
git add src/observe.mjs test/bash-write-evidence.test.mjs
git commit -m "feat: count bash writes as file modification evidence"
```

---

### Task 4: A recall dispatch is provably delivered

**Files:**
- Modify: `src/apply-generation-evidence.mjs:35-40` (`notVerified` area), `:133-160` (`recordGenerationEvidence`), `:62-63` (`normalizeEntry`), `:167-180` (`summarizeGenerationEvidence`)
- Modify: `src/memory-router.mjs:18-29` (`MEMORY_OPERATIONS`), `:51-61` (`RULES`)
- Modify: `src/tools.mjs:435-450` (`veyra_recall` execute tail)
- Test: `test/recall-delivery.test.mjs` (Create); Modify: `test/apply-generation-evidence.test.mjs:46-72,123-132`

**Interfaces:**
- Consumes: `recordGenerationEvidence(store, payload)`; `server.storesFor(agent, operation)`.
- Produces: `DELIVERY = { DELIVERED: 'DELIVERED', NOT_VERIFIED: 'NOT_VERIFIED' }` exported from `src/apply-generation-evidence.mjs`; `recordGenerationEvidence` accepts `delivery` and `source` overrides; `MEMORY_OPERATIONS.RECORD_DELIVERY = 'record.delivery'`; `veyra_recall` result gains `generationEventId: string | null`.

- [ ] **Step 1: Write the failing test**

Create `test/recall-delivery.test.mjs`:

```js
import test from 'node:test'
import assert from 'node:assert/strict'
import { recordGenerationEvidence, readGenerationEvidence, DELIVERY } from '../src/apply-generation-evidence.mjs'
import { openProjectStore } from '../src/store.mjs'
import { testHome, roomStore } from './helpers/room.mjs'

test('a tool dispatch records DELIVERED with tool provenance', async (t) => {
  const home = testHome(t)
  const store = roomStore(home, '/repo/a')
  store.put(makeRecord())
  recordGenerationEvidence(store, {
    status: 'generated', source: 'tool', queryClass: 'explicit_query',
    resultCount: 1, recordRefs: ['vey_x'], renderedChars: 120,
    delivery: { status: DELIVERY.DELIVERED, source: 'tool-dispatch' },
  })
  const entry = readGenerationEvidence(store).entries.at(-1)
  assert.equal(entry.delivery.status, 'DELIVERED')
  assert.equal(entry.used.status, 'NOT_VERIFIED')
})

test('the default stays NOT_VERIFIED', async (t) => {
  const home = testHome(t)
  const store = roomStore(home, '/repo/b')
  recordGenerationEvidence(store, { status: 'generated', queryClass: 'change_signal' })
  assert.equal(readGenerationEvidence(store).entries.at(-1).delivery.status, 'NOT_VERIFIED')
})
```

- [ ] **Step 2: Run it and watch it fail**

Run: `node --test test/recall-delivery.test.mjs`
Expected: first test fails — `entry.delivery.status` is `'NOT_VERIFIED'` because `normalizeEntry` (:65) hardcodes it.

- [ ] **Step 3: Implement the evidence side**

In `src/apply-generation-evidence.mjs`, add next to `notVerified` (:35):

```js
export const DELIVERY = Object.freeze({ DELIVERED: 'DELIVERED', NOT_VERIFIED: 'NOT_VERIFIED' })
// Only the tool dispatch can prove a returned payload: `visible` is handed back
// to the model-facing call. The context provider has no such surface, so it is
// deliberately NOT in this set — its entries stay NOT_VERIFIED forever.
const DELIVERABLE_SOURCES = new Set(['tool'])
```

Change `recordGenerationEvidence` (:133) to accept `delivery` and validate it:

```js
export function recordGenerationEvidence(store, { status, queryClass = 'unknown', resultCount = 0, recordRefs = [], renderedChars = 0, charBudget, errorClass, at, scope, source, delivery } = {}) {
  const resolvedDelivery = delivery && delivery.status === DELIVERY.DELIVERED && DELIVERABLE_SOURCES.has(source)
    ? { status: DELIVERY.DELIVERED, source: delivery.source || source, detail: 'returned to the model-facing dispatch; model receipt not provable' }
    : notVerified('delivery')
  // … existing body, using resolvedDelivery in the entry
}
```

In `normalizeEntry` (`:49`, whose parameter is `e`), stop overwriting a stored `DELIVERED`:

```js
const delivery = e.delivery?.status === DELIVERY.DELIVERED
  ? { status: DELIVERY.DELIVERED, source: boundedText(e.delivery.source, 48) || 'tool-dispatch', detail: boundedText(e.delivery.detail, 96) || '' }
  : notVerified('delivery')
```

Place it in the returned object literal in place of the current `delivery: notVerified('delivery'),` line (`:65`).

Leave `used` hardcoded `notVerified('used')` — Task 8 is what changes attribution, through the link log, not this field.

Also update `summarizeGenerationEvidence(log)` (`:167-180`). It currently hardcodes both labels, so every reporting surface would keep saying `NOT_VERIFIED` even after entries carry `DELIVERED`:

```js
delivery: notVerified('delivery'),
used: notVerified('used'),
```

Replace the `delivery` line with the count-derived label — an aggregate is only `DELIVERED` when at least one retained entry says so, and the source names the first such entry:

```js
const delivered = log.entries.filter((e) => e.delivery?.status === DELIVERY.DELIVERED)
// An aggregate label may only claim delivery when a retained entry proves one.
delivery: delivered.length
  ? { status: DELIVERY.DELIVERED, source: delivered[0].delivery.source || 'tool-dispatch', count: delivered.length }
  : notVerified('delivery'),
```

Leave its `used` line at `notVerified('used')`. This is the label `veyra_code_status` reports through `summarizeGenerationEvidence(readGenerationEvidence(projectStore))` (`src/tools.mjs:798`), so without this edit Task 4 would record `DELIVERED` and still report `NOT_VERIFIED` everywhere a user can look.

- [ ] **Step 4: Implement the write authorization**

In `src/memory-router.mjs`, add to `MEMORY_OPERATIONS` (`:18`): `RECORD_DELIVERY: 'record.delivery'`, and to `RULES` (`:51`): `[MEMORY_OPERATIONS.RECORD_DELIVERY]: { workspace: 'write', central: 'none' }`.

- [ ] **Step 5: Wire it in the recall tool**

At the end of `veyra_recall`'s execute (`src/tools.mjs:445`, after the `touch`), before `return`:

```js
let generationEventId = null
try {
  const writeStores = runtime.memoryServer?.storesFor?.(exec?.agent, MEMORY_OPERATIONS.RECORD_DELIVERY)
  if (writeStores?.ok && writeStores.projectStore) {
    const emitted = recordGenerationEvidence(writeStores.projectStore, {
      status: visible.length ? 'generated' : 'generated_empty',
      source: 'tool',
      queryClass: 'explicit_query',
      resultCount: visible.length,
      recordRefs: visible.map((r) => r.id).filter(Boolean),
      renderedChars: JSON.stringify(visible).length,
      delivery: { status: DELIVERY.DELIVERED, source: 'tool-dispatch' },
    })
    // recordGenerationEvidence returns the capped log, not the entry.
    generationEventId = emitted?.entries?.at(-1)?.eventId ?? null
  }
} catch { /* telemetry never breaks a recall */ }
```

Add `generationEventId` to the returned object.

- [ ] **Step 6: Update the pinned expectations**

In `test/apply-generation-evidence.test.mjs`, the context-provider assertions at `:54-55`, `:71-72`, `:128-132` stay `NOT_VERIFIED` — do not change them. Rename the test at `:123` to `P1-T10/T11 reporting: context path delivery/used stay NOT_VERIFIED`, and add:

```js
test('tool dispatch is DELIVERED, context path is not', async (t) => { /* asserts both labels side by side */ })
```

- [ ] **Step 7: Run to pass, then the suite**

Run: `node --test test/recall-delivery.test.mjs test/apply-generation-evidence.test.mjs` → all pass.
Run: `node --test test/router*.test.mjs test/tools.test.mjs` — if a router test enumerates `RULES` exhaustively, add the new row there too.
Run: `node --test test/*.test.mjs` → 1129 pass, 0 fail.

- [ ] **Step 8: Commit**

```bash
git add src/apply-generation-evidence.mjs src/memory-router.mjs src/tools.mjs test/recall-delivery.test.mjs test/apply-generation-evidence.test.mjs
git commit -m "feat: record a recall dispatch as delivered evidence"
```

---

### Task 5: `veyra_feedback` can name the recall it judges

**Files:**
- Modify: `src/tools.mjs:630-641` (declaration), `:676` (already forwards)
- Test: `test/feedback-attribution.test.mjs` (Create)

**Interfaces:**
- Consumes: `generationEventId` returned by `veyra_recall` (Task 4); `recordExplicitOutcomeLink` (`src/apply-generation-evidence.mjs:214`).
- Produces: `veyra_feedback` parameters gain `generationEventId?: string`; result gains `attribution: 'explicit_linked' | 'none'`.

- [ ] **Step 1: Write the failing test**

Create `test/feedback-attribution.test.mjs`:

```js
import test from 'node:test'
import assert from 'node:assert/strict'
import { createToolHarness } from '../src/tools.mjs'

test('declared generationEventId reaches the outcome link', async (t) => {
  const h = await makeHarnessWithDeliveredRecall(t)   // uses helpers/room.mjs + one veyra_remember
  const gen = h.recallResult.generationEventId
  assert.ok(gen, 'recall must return a generation event id')
  const res = await h.call('veyra_feedback', { id: h.recordId, outcome: 'success', generationEventId: gen })
  assert.equal(res.attribution, 'explicit_linked')
  assert.equal(h.links().length, 1)
})

test('an unknown generationEventId links nothing but still records feedback', async (t) => {
  const h = await makeHarnessWithDeliveredRecall(t)
  const res = await h.call('veyra_feedback', { id: h.recordId, outcome: 'success', generationEventId: 'vge_p_nope' })
  assert.equal(res.attribution, 'none')
  assert.equal(h.links().length, 0)
  assert.equal(res.feedback.successes >= 1, true)
})
```

- [ ] **Step 2: Run it and watch it fail**

Run: `node --test test/feedback-attribution.test.mjs`
Expected: `res.attribution` is `undefined` — the parameter is not declared, so `args.generationEventId` never arrives.

- [ ] **Step 3: Implement**

In the `veyra_feedback` `parameters` object (`src/tools.mjs:637`), add:

```js
generationEventId: {
  type: 'string',
  description: 'The generationEventId returned by the veyra_recall call that surfaced this record. Enables explicit attribution.',
},
```

No forwarding code changes: `:675-677` already calls `recordExplicitOutcomeLink` with `args.generationEventId` and stores the result in `outcomeLink`. Only the *declaration* is missing, so `args` never carries the field. Add the returned attribution explicitly:

```js
attribution: outcomeLink ? 'explicit_linked' : 'none',
```

`recordExplicitOutcomeLink` returns `null` unless the id matches an existing `generationEventId` in the log (`src/apply-generation-evidence.mjs:221`), which is what makes the unknown-id case report `none` rather than fabricate a link.

- [ ] **Step 4: Run to pass, then the suite**

Run: `node --test test/feedback-attribution.test.mjs` → 2 pass.
Run: `node --test test/m6-feedback-recurrence.test.mjs test/tools.test.mjs`
Run: `node --test test/*.test.mjs` → 1131 pass, 0 fail.

- [ ] **Step 5: Commit**

```bash
git add src/tools.mjs test/feedback-attribution.test.mjs
git commit -m "feat: let feedback bind to the recall that surfaced the record"
```

---

### Task 6: An unchanged recall set renders compactly

**Files:**
- Modify: `src/context.mjs:471-480` (module state area), `:264` (`renderAgentContext` signature), `:264-330` (`renderAgentContext` block assembly), `:890-900` (the `renderAgentContext` call inside `buildRecallContext`)
- Test: `test/recall-compaction.test.mjs` (Create)

**Interfaces:**
- Consumes: `renderAgentContext(composed, { heading, changes, budget })`; the resolved `records` and the resolved `workspace` string already present in `buildRecallContext` (`src/context.mjs:852`).
- Produces: `COMPACT_AFTER_REPEATS = 2` and `RENDER_MEMORY_CAP = 32` exported from `src/context.mjs`; `renderAgentContext` gains option `compact = false`. **`createContextProvider` is not modified** — it never sees `records`, so the decision cannot live there.

- [ ] **Step 1: Write the failing test**

Create `test/recall-compaction.test.mjs`:

```js
import test from 'node:test'
import assert from 'node:assert/strict'
import { buildRecallContext, COMPACT_AFTER_REPEATS, RENDER_MEMORY_CAP } from '../src/context.mjs'
import { testHome, roomStore } from './helpers/room.mjs'

function seed(store, n = 5) {
  for (let i = 0; i < n; i++) {
    store.put({
      title: `Lesson ${i}: writer lock ordering`,
      body: `Root cause: the writer lock ordering is inverted. ${'Detail sentence. '.repeat(20)}`,
      kind: 'memory', authority: 'derived', validation: 'unverified',
      confidence: 'medium', status: 'current', scope: 'project',
      tags: [], relations: [], evidence: [{ path: `src/f${i}.mjs` }], source: {},
    })
  }
}

const idsOf = (text) => text.match(/\[vey_[a-z0-9_]+\]/g) || []

function fixture(t, name = 'compact-a') {
  const home = testHome(t)
  const workspace = `/repo/${name}`
  const store = roomStore(home, workspace)
  seed(store)
  return {
    store, workspace,
    render: () => buildRecallContext({
      projectStore: store, workspace, query: '', changedFiles: ['src/a.mjs'], limit: 5,
    }),
  }
}

test('a repeated set renders compact and keeps every id', (t) => {
  const f = fixture(t)
  const first = f.render()
  f.render()
  const third = f.render()
  assert.ok(third.length < first.length * 0.5, `expected compaction, got ${third.length} vs ${first.length}`)
  for (const id of idsOf(first)) assert.ok(third.includes(id), `compacted output dropped ${id}`)
})

test('the first and second render are still full', (t) => {
  const f = fixture(t, 'compact-b')
  const first = f.render()
  const second = f.render()
  assert.equal(COMPACT_AFTER_REPEATS, 2)
  assert.ok(RENDER_MEMORY_CAP > 0)
  assert.ok(second.length > first.length * 0.9)
})

test('a changed set renders full again', (t) => {
  const f = fixture(t, 'compact-c')
  f.render(); f.render(); f.render()
  f.store.put({
    title: 'Lesson new: unrelated indexing bug',
    body: 'Root cause: the index was not rebuilt. '.repeat(20),
    kind: 'memory', authority: 'derived', validation: 'unverified',
    confidence: 'medium', status: 'current', scope: 'project',
    tags: [], relations: [], evidence: [{ path: 'src/new.mjs' }], source: {},
  })
  const changed = f.render()
  assert.ok(changed.length > 600, 'compact form leaked into a changed set')
})

test('a different workspace is not compacted', (t) => {
  const f = fixture(t, 'compact-d')
  f.render(); f.render(); f.render()
  const other = fixture(t, 'compact-e')
  assert.ok(other.render().length > 600)
})

test('render memory is bounded', (t) => {
  assert.equal(RENDER_MEMORY_CAP, 32)
})

// Regression guard for the banner-before-header ordering in renderAgentContext.
// A contradicted record renders `> ⚠️ …` lines BEFORE `- [id] (…) title`, so any
// compact transform that keeps `lines[0]` keeps the warning and drops the id.
test('a contradicted record keeps its id in the compact form', (t) => {
  const home = testHome(t)
  const workspace = '/repo/compact-f'
  const store = roomStore(home, workspace)
  seed(store)
  store.put({
    title: 'Writer lock ordering inverted',
    body: 'Root cause: the writer lock ordering is inverted.',
    kind: 'memory', authority: 'derived', validation: 'unverified',
    confidence: 'medium', status: 'current', scope: 'project',
    tags: [], relations: [], evidence: [{ path: 'src/lock.mjs' }], source: {},
    contradictionBanners: ['This memory contradicts [vey_zzz] on lock ordering.'],
  })
  const render = () => buildRecallContext({
    projectStore: store, workspace, query: '', changedFiles: ['src/a.mjs'], limit: 6,
  })
  const first = render()
  render()
  const third = render()
  assert.ok(first.includes('> ⚠️'), 'fixture must render a contradiction banner')
  for (const id of idsOf(first)) {
    assert.ok(third.includes(`- [${id.slice(1, -1)}]`), `compacted output dropped the header for ${id}`)
  }
})
```

- [ ] **Step 2: Run it and watch it fail**

Run: `node --test test/recall-compaction.test.mjs`
Expected: import error — `COMPACT_AFTER_REPEATS` is not exported yet. After adding only the constants it fails on `a repeated set renders compact` because every render is the same length.

- [ ] **Step 3: Implement the module state**

In `src/context.mjs`, next to `taskIntentCache` (`:476`), add:

```js
// A room that keeps recalling the same set every turn is paying the full
// body/evidence cost for information the agent has already been shown.
// Keyed by the resolved workspace string because that is what buildRecallContext
// receives; createContextProvider never sees the record set.
export const COMPACT_AFTER_REPEATS = 2
export const RENDER_MEMORY_CAP = 32
const renderMemory = new Map()   // workspace → { key, renders }
```

- [ ] **Step 4: Implement the compact rendering**

In `renderAgentContext` (`:264`), change the signature to accept `compact = false`:

```js
export function renderAgentContext(composed, { heading = 'Veyra recalled engineering memory', changes = null, budget = DEFAULT_RECALL_CHARS, compact = false } = {}) {
```

Keep the whole function as it is — the loop, the framing lines, and `blocks` are unchanged. Change only the return:

```js
// Compact keeps the attribution lines of every record and drops the detail.
// `lines[0]` is NOT reliably the header: contradiction banners are pushed
// before it (`for (const banner of rec.contradictionBanners || []) { lines.push(...) }`
// precedes the `- [${rec.id}]` push), so a contradicted record would lose its
// id and keep only a warning about a record the agent can no longer identify.
const headerOf = (lines) => {
  const found = lines.find((line) => line.startsWith('- ['))
  return found ?? lines[0]
}
const rendered = compact
  ? blocks.map((b) => ({ lines: [...b.lines.filter((line) => line.startsWith('> ⚠️ ')), headerOf(b.lines)], expendable: [] }))
  : blocks
return joinWithBudget(framing, rendered, budget)
```

`headerOf` selects the real header `- [${rec.id}] (${scope}/${auth}…) ${rec.title}`
by prefix rather than by index, falling back to `lines[0]` only if no header
exists. The compact block keeps the record's contradiction banners (they are
attribution, and dropping them would hide a known conflict) plus that one header,
so ids, authority, validation, confidence and contradiction state all survive
while body, evidence and causal facets drop.

Note that `joinWithBudget`'s own trimmed tier is NOT a substitute for this: it
drops `expendable` offsets but deliberately keeps `evidence:` lines, so a record
could still render its evidence without its own header if compact relied on the
budget tier alone.

- [ ] **Step 5: Decide compactness inside `buildRecallContext`**

In `buildRecallContext` (`:852`), immediately before the `renderAgentContext` call (step 6 of that function):

```js
const renderKey = records.map((r) => r.id).sort().join(',')
const memoKey = workspace || cwd || ''
const prev = renderMemory.get(memoKey)
const renders = prev && prev.key === renderKey && renderKey ? prev.renders + 1 : 1
renderMemory.delete(memoKey)
renderMemory.set(memoKey, { key: renderKey, renders })
if (renderMemory.size > RENDER_MEMORY_CAP) renderMemory.delete(renderMemory.keys().next().value)
const compact = renders > COMPACT_AFTER_REPEATS
```

Then pass `compact` into the existing call:

```js
const rendered = renderAgentContext(composeAgentContext(records, { … }), { changes: changedFiles, budget, compact })
```

Leave `emitGenerationEvidence` untouched — it already records `renderedChars`, which is exactly the number this task moves.

- [ ] **Step 6: Run to pass, then the suite**

Run: `node --test test/recall-compaction.test.mjs` → 6 pass.
Run: `node --test test/context*.test.mjs test/recall-limit-regression.test.mjs test/apply-generation-evidence.test.mjs`
Run: `node --test test/*.test.mjs` → 1137 pass, 0 fail.

- [ ] **Step 7: Commit**

```bash
git add src/context.mjs test/recall-compaction.test.mjs
git commit -m "feat: render an unchanged recall set compactly"
```

---

### Task 7: Duplicate root causes merge; different ones do not

**Files:**
- Modify: `src/diff.mjs:29-50` (facet extraction area), `:95-130` (`diffMemory`)
- Test: `test/root-cause-merge.test.mjs` (Create)

**Interfaces:**
- Consumes: `jaccard` (`src/text.mjs:46`), `claimText` (`src/diff.mjs`).
- Produces: `CAUSE_FACET_SIM = 0.7` and `extractCauseLine(record): string` exported from `src/diff.mjs`; `diffMemory` returns `matches[].causeSimilarity` and `causeDuplicate: boolean`.

**Why not a whole-claim threshold:** measured over the 21 real pairs in the live room, whole-claim `jaccard` maxes out at **0.143** — below `MIN_CONFLICT_SIM` (0.35). Body-length asymmetry (1149 vs 748 chars, dominated by `Files touched`/`Tools`/`Symbols` lines) crushes similarity, so *no* whole-claim threshold can ever merge the true duplicate pair without also merging unrelated records. Comparing the extracted `Root cause:` facet separates them cleanly: the true pair scores **1.000**, reworded variants **0.727–0.909**, every other pair **≤0.278**.

- [ ] **Step 1: Write the failing test**

Create `test/root-cause-merge.test.mjs`:

```js
import test from 'node:test'
import assert from 'node:assert/strict'
import { diffMemory, extractCauseLine, DIFF, CAUSE_FACET_SIM } from '../src/diff.mjs'

// Verbatim from two live records whose Root cause lines are identical.
const CAUSE_A = 'client-side resolveActiveWorkspaceCwd depends on bestEffortActiveSessionId which reads a non-existent active.sessionId'
const a = { id: 'vey_a', title: 'Cause: client-side — resolveActiveWorkspaceCwd depends on bestEffortActiveSessionId',
  body: `Symptom: cwd is wrong.\nRoot cause: ${CAUSE_A}\nFiles touched: src/workspace.mjs, src/session.mjs, src/index.mjs\nTools: bash, read, edit` }
const b = { id: 'vey_b', title: 'Cause: client-side resolveActiveWorkspaceCwd depends on bestEffortActiveSessionId',
  body: `Root cause: ${CAUSE_A}\nFiles touched: src/workspace.mjs\nTools: bash` }

test('extractCauseLine returns the Root cause facet', () => {
  assert.equal(extractCauseLine(a), CAUSE_A)
  assert.equal(extractCauseLine({ title: 'Engineering observation', body: 'no facet here' }), '')
})

test('an identical root cause is a duplicate despite a much shorter body', () => {
  assert.equal(diffMemory(b, [a]).suggestion, DIFF.DUPLICATE)
})

test('a reworded root cause is still a duplicate', () => {
  const c = { ...b, id: 'vey_c', body: `Root cause: resolveActiveWorkspaceCwd depends on bestEffortActiveSessionId, which reads a non-existent active.sessionId\nTools: bash` }
  assert.equal(diffMemory(c, [a]).suggestion, DIFF.DUPLICATE)
})

test('a different root cause is never a duplicate', () => {
  const d = { id: 'vey_d', title: 'Cause: writer lock is never released on timeout',
    body: 'Root cause: the writer lock is never released when the timeout fires, so the next turn deadlocks.\nTools: bash' }
  assert.notEqual(diffMemory(d, [a]).suggestion, DIFF.DUPLICATE)
  assert.equal(diffMemory(d, [a]).causeDuplicate, false)
})

test('records without a root cause are never cause-duplicates', () => {
  const e = { id: 'vey_e', title: 'Engineering observation', body: 'General note about writer locks.' }
  const f = { id: 'vey_f', title: 'Engineering observation', body: 'General note about writer locks.' }
  assert.equal(diffMemory(f, [e]).causeDuplicate, false)
})

test('the threshold is a named constant in a defensible band', () => {
  assert.equal(CAUSE_FACET_SIM, 0.7)
})
```

- [ ] **Step 2: Run it and watch it fail**

Run: `node --test test/root-cause-merge.test.mjs`
Expected: import error — `extractCauseLine` and `CAUSE_FACET_SIM` are not exported.

- [ ] **Step 3: Implement facet extraction**

In `src/diff.mjs`, above `classify` (near `MIN_CONFLICT_SIM` at `:55`):

```js
// A restated cause is the duplicate that matters: two records stating the same
// Root cause are one lesson, even when their bodies differ by 400 chars of
// template lines. Measured on the live room: identical causes score 1.000,
// rewording scores 0.727-0.909, and different causes score <=0.278, so 0.7
// separates them with margin on both sides.
export const CAUSE_FACET_SIM = 0.7
const CAUSE_LINE = /^\s*Root cause:\s*(.+)$/im

export function extractCauseLine(record) {
  const text = `${record?.title || ''}\n${record?.body || ''}`
  const match = text.match(CAUSE_LINE)
  return match ? match[1].trim() : ''
}
```

- [ ] **Step 4: Compare facets in `diffMemory`**

In `diffMemory` (`:95`), inside the per-record loop where `similarity` is computed, add the facet comparison and include it in the match object:

```js
const incomingCause = extractCauseLine(incoming)
const recordCause = extractCauseLine(rec)
const causeSimilarity = incomingCause && recordCause ? jaccard(incomingCause, recordCause) : 0
```

Then push `causeSimilarity` alongside the existing fields, and keep the existing `classify` call unchanged so all present behaviour is preserved:

```js
matches.push({ id: rec.id, record: rec, similarity, causeSimilarity, suggestion: classify(similarity, newText, existingText, { subjectShared: sharesSubject(incoming, rec) }) })
```

After the loop, before the aggregate `suggestion` computation, promote a facet match to DUPLICATE — but only when the facet is genuinely the same cause:

```js
// A matching cause outranks additive wording drift: the bodies differ because
// one turn touched more files, not because the lesson differs.
for (const m of matches) {
  if (m.causeSimilarity >= CAUSE_FACET_SIM && m.suggestion !== DIFF.CONFLICT) m.suggestion = DIFF.DUPLICATE
}
const causeDuplicate = matches.some((m) => m.causeSimilarity >= CAUSE_FACET_SIM)
```

Return `causeDuplicate` in the `diffMemory` result object alongside `suggestion` and `matches`.

- [ ] **Step 5: Run to pass, then the suite**

Run: `node --test test/root-cause-merge.test.mjs` → 6 pass.
Run: `node --test test/brain.test.mjs test/m12-consolidation.test.mjs test/issue3-classifier.test.mjs test/regression-false-positives.test.mjs test/contradiction-integrity.test.mjs test/evolve*.test.mjs test/learn*.test.mjs`
Expected: all pass. The conflict-first rule keeps `test/issue3-classifier.test.mjs` green, and no existing fixture carries a shared `Root cause:` line, so no verdict changes.
Run: `node --test test/*.test.mjs` → 1143 pass, 0 fail.

- [ ] **Step 6: Commit**

```bash
git add src/diff.mjs test/root-cause-merge.test.mjs
git commit -m "feat: merge records that restate the same root cause"
```

---

### Task 8: A turn that passes tests records a non-causal outcome signal

**Files:**
- Modify: `src/plugin.mjs:364-456` (`agent/turn-stopping` handler) and its import block (`:17-43`)
- Modify: `src/apply-generation-evidence.mjs` (`APPLY_AUTO_OUTCOME_KEY`, writer/reader/normalizer)
- Modify: `src/understand.mjs:673` (`function testOutcomeFrom` → `export function testOutcomeFrom`)
- Test: `test/turn-outcome-signal.test.mjs` (Create)

**Interfaces:**
- Consumes: `readGenerationEvidence(store)` (Task 4 entries with `DELIVERY.DELIVERED`), `testOutcomeFrom(buffer.tools, [...buffer.files])` (exported by this task), `projectStore` and `buffer` already resolved in the handler.
- Produces: `recordAutoOutcomeSignal(store, { recordId, generationEventId, signal, at }): object | null`; `readAutoOutcomeSignals(store): { available, count, entries }`; `APPLY_AUTO_OUTCOME_KEY = 'veyra_apply_auto_outcome_v1'`; `AUTO_OUTCOME = { CONTRADICTED: 'CONTRADICTED', PLAUSIBLE: 'PLAUSIBLE_CORRELATION' }`; `export function testOutcomeFrom` in `src/understand.mjs`.

**Why the signal is `testOutcomeFrom`, not a regex over `buffer.tools`.** `test-passed` and `test-failed` are *evidence notes* Veyra derives itself (`src/evidence.mjs:40-41` `NOTES`, pushed as `{ note: 'test-failed' }` / `{ note: 'test-passed' }` at `src/understand.mjs:713-714`, folded into `VERIFIED_OUTCOMES` at `:132` and the `verified-test` tag at `:729`). They never appear in a tool call or a tool preview: `buffer.tools` holds `{ name, args }` for calls plus `{ name: '<tool>:result', preview }` for results (`src/observe.mjs:150`), and a test-runner preview contains `ℹ fail 0`, not the literal `test-passed`. `testOutcomeAnalysis(tools, files)` at `src/understand.mjs:626` is the one place that turns those previews into an outcome, via `readTestResult` (`:607`) and this ordered rule (`:663-667`):

```js
if (sawFailure && !(recoveredPass && correctiveAfterFailure)) outcome = 'test-failed'
else if (sawPass || recoveredPass) outcome = 'test-passed'
else if (hasTestTool || (files || []).some((f) => /test|spec/i.test(f))) outcome = 'tests-touched'
```

Reusing it keeps failure/recovery semantics in one place. Its wrapper `testOutcomeFrom(tools, files)` (`:673`) returns just the `outcome`, which is all this task needs, so this task exports that wrapper instead of copying the analysis: `function testOutcomeFrom` → `export function testOutcomeFrom`. `files` must be an array — `buffer.files` is a `Set`, so pass `[...buffer.files]`.

`tests-touched` is **not** a signal. It means test files were in play, not that anything passed; mapping it to `PLAUSIBLE_CORRELATION` would turn "this was test-adjacent" into a false success claim. Only `test-passed` and `test-failed` produce a signal, and `null` produces none.

- [ ] **Step 1: Write the failing test**

Create `test/turn-outcome-signal.test.mjs`, following the `apply()` + `mockCtx()` + `_listeners` harness already used in `test/turn-stopping-learning.test.mjs` (its `prepareWorkspace`, `mockCtx`, and `fakeRegistry(paths)` plumbing are the pattern; the room must resolve or the handler returns before reaching any of this).

The seed step needs Task 4: write a record, then `recordGenerationEvidence(projectStore, { status: 'generated', resultCount: 1, recordRefs: [rec.id], source: 'tool', delivery: { status: DELIVERY.DELIVERED, source: 'tool-dispatch' } })`.

`source` must be `'tool'` — it is the field `recordGenerationEvidence` checks against `DELIVERABLE_SOURCES`, and `delivery.source` is only the free-text label recorded inside the delivery object. Seeding with `source: 'tool-dispatch'` would fail that check and write `NOT_VERIFIED`, so the test would then prove nothing while still appearing to use the delivered path. Both the test's `roomStore(home, '/repo/a')` and the plugin's memory server address the same SQLite file, which is what the existing turn-stopping tests rely on.

Drive the turn through `session/event`, not by reaching into the buffer: a `tool/call` for `bash` with `args.command = 'node --test test/*.test.mjs'`, then a `tool/result` whose text carries real runner output. These exact preview strings were verified against `distillBuffer` and produce these outcomes, so use them rather than inventing output shapes:

| `preview` | outcome | evidence note | tags |
| --- | --- | --- | --- |
| `ℹ tests 1113\nℹ pass 1113\nℹ fail 0` | `test-passed` | `test-passed` | `verified-test` |
| `ℹ tests 1113\nℹ pass 1111\nℹ fail 2\n✖ failing tests:` | `test-failed` | `test-failed` | — |
| `no runner output here` + a `test/` file in the turn | `tests-touched` | `tests-touched` | `tested` |

The `tool/result` must carry the output as its message text, because `observeEvent` stores it as `preview` (`src/observe.mjs:146-151`) and `readTestResult` (`src/understand.mjs:607`) parses exactly that field. `TOOL_SIGNAL` must contain `bash` for the result to be buffered at all — it does.

The recovery rule matters for the third row: `test-failed` wins unless a failure was followed by a corrective tool call and then a pass. A fixture that fires a failure and then a pass with no `edit`/`write`/`str_replace_editor`/`run_code` in between is still `test-failed`, so do not assume a bare fail-then-pass pair reads as recovery.

```js
test('a delivered record plus passing tests records PLAUSIBLE_CORRELATION', async (t) => {
  // seed DELIVERED generation evidence, then this turn runs tests that pass
  assert.equal(signals.at(-1).signal, 'PLAUSIBLE_CORRELATION')
  assert.equal(signals.at(-1).attribution, 'turn_test_evidence')
  assert.equal(signals.at(-1).recordId, rec.id)
})

test('auto outcome never changes confidence', async (t) => {
  assert.equal(record.confidence, before.confidence)
  assert.equal(record.validation, before.validation)
})

test('failing tests record CONTRADICTED', async (t) => {
  assert.equal(signals.at(-1).signal, 'CONTRADICTED')
})

test('a turn that only touches test files records no signal', async (t) => {
  // a test-file edit with no runner output is 'tests-touched', not a pass
  assert.equal(signals.length, 0)
})

test('no delivered recall means no signal', async (t) => {
  assert.equal(signals.length, 0)
})
```

- [ ] **Step 2: Run it and watch it fail**

Run: `node --test test/turn-outcome-signal.test.mjs` → `signals` is undefined.

- [ ] **Step 3: Implement the log**

In `src/apply-generation-evidence.mjs`, following the `APPLY_OUTCOME_LINK_KEY` pattern (:15, :214):

```js
export const APPLY_AUTO_OUTCOME_KEY = 'veyra_apply_auto_outcome_v1'
export const AUTO_OUTCOME = Object.freeze({ CONTRADICTED: 'CONTRADICTED', PLAUSIBLE: 'PLAUSIBLE_CORRELATION' })
```

`recordAutoOutcomeSignal(store, { recordId, generationEventId, signal, at })` writes a bounded entry with `kind: 'veyra.apply.auto_outcome'` and `attribution: 'turn_test_evidence'`, and rejects any `signal` outside the allowed values (fail closed, returning `null`). It must never call `recordFeedback`, `strengthenMemory`, or `promote`.

`readAutoOutcomeSignals(store)` wraps `readLog` so callers do not have to know that an empty log reads as `null`:

```js
export function readAutoOutcomeSignals(store) {
  const log = readLog(store, APPLY_AUTO_OUTCOME_KEY, normalizeAutoOutcomeLog)
  return { available: Boolean(log), count: log?.entries.length ?? 0, entries: log?.entries ?? [] }
}
```

**`appendEntry` is not reusable as-is — it is hardwired to the generation normalizer.** Its body (`:110-130`) ends with `return capAndStore(store, key, log)` after `log = raw ? normalizeLog(JSON.parse(raw)) : emptyLog()`, and `normalizeLog`/`normalizeEntry` reject anything whose `status` is not one of `generated | generated_empty | generation_error` (`:46-47`, `:73-85`). A signal entry has `signal`, not `status`, so the first read after a restart would normalize it away: the write survives in SQLite but every later `readAutoOutcomeSignals` returns nothing. Give this log its own normalizer and follow `recordExplicitOutcomeLink`'s self-contained shape (`:214-247`) instead of `appendEntry`:

```js
const AUTO_OUTCOME_ENTRY_LIMIT = 64
// AUTO_OUTCOME is keyed CONTRADICTED / PLAUSIBLE but the stored value is
// PLAUSIBLE_CORRELATION, so membership must test the VALUES, not the keys.
const AUTO_OUTCOME_VALUES = new Set(Object.values(AUTO_OUTCOME))

function normalizeAutoOutcomeLog(value) {
  const log = emptyLog()
  if (!value || typeof value !== 'object') return log
  log.updatedAt = boundedText(value.updatedAt, 40)
  log.nextSeq = Number.isFinite(value.nextSeq) && value.nextSeq >= 1 ? Math.trunc(value.nextSeq) : 1
  if (Array.isArray(value.entries)) {
    for (const e of value.entries.slice(-ENTRY_HARD_LIMIT)) {
      if (!e || typeof e !== 'object') continue
      const recordId = boundedText(e.recordId, 128)
      const eventId = boundedText(e.eventId, 64)
      const at = boundedText(e.at, 40)
      if (!AUTO_OUTCOME_VALUES.has(e.signal) || !recordId || !eventId || !at) continue
      log.entries.push({
        eventId, at, kind: 'veyra.apply.auto_outcome', recordId, signal: e.signal,
        generationEventId: boundedText(e.generationEventId, 64),
        attribution: 'turn_test_evidence',
      })
    }
  }
  return log
}
```

The same value check guards the writer: reject a `signal` unless `AUTO_OUTCOME_VALUES.has(signal)`.

Write with the same read-normalize-mutate-store-capped sequence `recordExplicitOutcomeLink` uses (guarding `getMeta`/`setMeta`, `nextSeq`, `store.scope` for the `p`/`r` prefix, `capAndStore`), and read with `readLog(store, APPLY_AUTO_OUTCOME_KEY, normalizeAutoOutcomeLog)` — that helper already returns `null` on an empty or unreadable log.

- [ ] **Step 4: Emit it from the turn-stop handler**

In `src/plugin.mjs`, add the import (neither module is imported there today):

```js
import { readGenerationEvidence, recordAutoOutcomeSignal, AUTO_OUTCOME, DELIVERY } from './apply-generation-evidence.mjs'
import { testOutcomeFrom } from './understand.mjs'
```

`src/understand.mjs` imports only `types.mjs`, `redact.mjs`, `text.mjs`, `ids.mjs`, and the CBM package, so it cannot cycle back into `plugin.mjs`.

Insert inside the existing handler `try` (which begins at `:365`), **immediately after the `const candidate = candidateFromBuffer(buffer, {...})` call (`:383-389`) and before the `if (!candidate) return` guard at `:390`**, at the handler's try-body level:

```js
// Turn-end outcome signal (non-causal). Test evidence from this turn makes a
// delivered record *correlated* with a pass, never verified: `test-passed` is a
// local observation, not a model receipt. Nothing here may touch confidence,
// validation, or authority.
try {
  const outcome = testOutcomeFrom(buffer.tools, [...buffer.files])
  const signal = outcome === 'test-passed' ? AUTO_OUTCOME.PLAUSIBLE
    : outcome === 'test-failed' ? AUTO_OUTCOME.CONTRADICTED : null
  if (signal) {
    // readLog returns null when nothing has ever been recorded (`:98-107`), so
    // this must be optional-chained: a fresh room has no generation log at all.
    const delivered = readGenerationEvidence(projectStore)?.entries
      ?.filter((e) => e.delivery?.status === DELIVERY.DELIVERED)
      .at(-1)
    if (delivered) {
      for (const recordId of delivered.recordRefs.slice(0, 5)) {
        recordAutoOutcomeSignal(projectStore, { recordId, generationEventId: delivered.eventId, signal })
      }
    }
  }
} catch { /* turn-end signal is best-effort */ }
```

Placement is load-bearing. `if (!candidate) return` fires on turns that produced no durable observation — a short "did it pass?" turn is exactly that shape — so a signal block placed after it would silently skip most of the turns whose test evidence matters. The block runs on every observed turn-end, independently of whether this turn's own buffer yields a candidate. `buffer` and `projectStore` are both in scope at that point; `storesFor` has already failed closed above if the room could not resolve.

Note in a comment that `runtime.observe: false` disables this path, which is the existing contract: the whole handler is registered inside `if (runtime.observe)` (`src/plugin.mjs:363`).

Do not call `recordFeedback`, `strengthenMemory`, or `promote` — this signal is a separate log with its own key, and a correlated pass must never strengthen a record's standing.

- [ ] **Step 5: Run to pass, then the suite**

Run: `node --test test/turn-outcome-signal.test.mjs` → 5 pass.
Run: `node --test test/turn-stopping-learning.test.mjs test/turn-stopping-contradiction.test.mjs test/plugin.test.mjs test/m5-maintenance.test.mjs`
Run: `node --test test/*.test.mjs` → 1148 pass, 0 fail.

- [ ] **Step 6: Commit**

```bash
git add src/plugin.mjs src/apply-generation-evidence.mjs src/understand.mjs test/turn-outcome-signal.test.mjs
git commit -m "feat: record a non-causal outcome signal at turn end"
```

---

### Task 9: Measure the loop end to end

**Files:**
- Create: `test/eval-autonomy-cycle.mjs`
- Test: `test/eval-autonomy-cycle.test.mjs` (Create)

**Interfaces:**
- Consumes: `test/helpers/room.mjs` (`testHome`, `testRuntime`, `roomStore`, `agentFor`), `test/helpers/eval-output.mjs` (`publishEvalResult`), `createToolHarness` (`src/tools.mjs:1323`), `buildRecallContext` (`src/context.mjs:852`), `maybeLearn` (`src/learn.mjs:742`), `readGenerationEvidence`/`summarizeGenerationEvidence`/`readAutoOutcomeSignals` (`src/apply-generation-evidence.mjs` — Task 8 adds the outcome reader to this same module, not a new one), `readWriteGateLedger` (`src/learn.mjs`), `extractSymbols` (`src/understand.mjs:477`).
- Produces: `runAutonomyCycle({ home, cwd, turns = 3, seed = true })` → `{ tokensPerTurn, distinctSets, deliveryCoverage, mergeRate, proseSymbolLeaks, seeded, generationCount, generationSummary, autoOutcomeSignals, ledger, constraints }`; CLI `node test/eval-autonomy-cycle.mjs [--output path]` (writes the run artifact to `os.tmpdir()`; tracked artifact only under `VEYRA_EVAL_WRITE_TRACKED=1`).

**What this task may NOT claim.** It measures the loop's *mechanics*, not its effect on a model. `deliveryCoverage` means "a `veyra_recall` dispatch returned records", never "the model received them" — `docs/research/phase1-6-delivery-application-proof-feasibility.md` establishes that no supported public surface exposes the admitted request or confirms model receipt. `tokensPerTurn` derives from `renderedChars / 4` and is an estimate; the graded token metric remains `docs/research/m00190-preregistration.md` M3. Do not present either as a causal effect.

**Why `symbolPrecision` is dropped.** The original metric was "symbols from prose fixtures ÷ symbols from code fixtures". It is not a precision: after Task 1 the prose numerator is 0 by construction, so the ratio is always 0 and can never be anything else — it would assert its own premise. Replace it with `proseSymbolLeaks`, an absolute count that must be 0, and let Task 1's `test/symbol-evidence.test.mjs` own the positive direction.

**Fixture facts that break earlier drafts (do not re-introduce them):**
- `fixtureRepo(t)` does not exist. Build the fixture with `mkdtempSync(os.tmpdir(), ...)` + `git init` + explicit `-c user.name`/`-c user.email`, the way `test/eval-v0169-ab.mjs` does.
- `createToolHarness({ veyraHome, fallbackCwd })` is dead since v0.2.0 (`dd22b63 feat!: workspace-room memory server and governed automatic memory (v0.2.0)`): it throws `Veyra memory unavailable: memory-server-unavailable at requireStores (src/tools.mjs:133:17)`, code `VEYRA_MEMORY_UNAVAILABLE`. Do not copy `test/eval-v0169-ab.mjs`'s harness construction — copy only its temp-repo and `main().catch(...)` shape.
- `readGenerationEvidence(store)` returns **`null`**, not an empty log, on a fresh room (`readLog` (`src/apply-generation-evidence.mjs:98`) returns `log.entries.length > 0 ? log : null`).
- `readWriteGateLedger(store)` also returns **`null`** when no ledger exists or `total === 0`.
- `publishEvalResult(result)` with no options THROWS (`resolveEvalOutput` requires both `trackedPath` and `runPath`).
- `veyra_remember` never writes the write-gate ledger; only `maybeLearn`/`writeGate` does. Measured: two `veyra_remember` calls → ledger still `null`.

- [ ] **Step 1: Write the failing test**

Create `test/eval-autonomy-cycle.test.mjs`:

```js
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execSync } from 'node:child_process'
import { runAutonomyCycle } from './eval-autonomy-cycle.mjs'
import { testHome } from './helpers/room.mjs'

function fixtureRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'veyra-cycle-'))
  execSync('git init -q', { cwd: dir })
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true })
  fs.writeFileSync(path.join(dir, 'src', 'lock.mjs'), 'export function lockWriter() {}\n')
  execSync('git add -A && git -c user.name=veyra-eval -c user.email=veyra-eval@example.invalid commit -qm init', { cwd: dir })
  return dir
}

test('the cycle reports every headline metric', async (t) => {
  const home = testHome(t)
  const cwd = fixtureRepo()
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }))
  const r = await runAutonomyCycle({ home, cwd, turns: 3 })
  for (const k of ['tokensPerTurn', 'distinctSets', 'deliveryCoverage', 'mergeRate', 'proseSymbolLeaks']) {
    assert.equal(typeof r[k], 'number', `${k} missing`)
  }
  assert.ok(r.deliveryCoverage > 0, 'a veyra_recall dispatch must count as delivered')
  assert.equal(r.proseSymbolLeaks, 0, 'prose must not produce symbol evidence')
  assert.ok(r.mergeRate >= 0 && r.mergeRate <= 1, 'mergeRate must be a ratio')
})

test('a fresh room reports zero rather than throwing', async (t) => {
  const home = testHome(t)
  const cwd = fixtureRepo()
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }))
  const r = await runAutonomyCycle({ home, cwd, turns: 0, seed: false })
  assert.equal(r.tokensPerTurn, 0)
  assert.equal(r.distinctSets, 0)
  assert.equal(r.deliveryCoverage, 0)
  assert.equal(r.mergeRate, 0)
  assert.equal(r.ledger, null)
  assert.equal(r.generationSummary, null)
})
```

- [ ] **Step 2: Run it and watch it fail**

Run: `node --test test/eval-autonomy-cycle.test.mjs` → cannot resolve `runAutonomyCycle`.

- [ ] **Step 3: Implement the harness**

Create `test/eval-autonomy-cycle.mjs`. Keep the module importable — the test imports it, so the CLI must be guarded by a main check (this repository has no such idiom yet; introduce it here and nowhere else):

```js
// Veyra autonomy-cycle evaluation - mechanics only, never a model-effect claim.
// Usage: node test/eval-autonomy-cycle.mjs [--output /tmp/eval-autonomy.json]
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { createToolHarness } from '../src/tools.mjs'
import { buildRecallContext } from '../src/context.mjs'
import { maybeLearn, readWriteGateLedger } from '../src/learn.mjs'
import { readGenerationEvidence, summarizeGenerationEvidence, readAutoOutcomeSignals } from '../src/apply-generation-evidence.mjs'
import { extractSymbols } from '../src/understand.mjs'
import { testRuntime, roomStore, agentFor } from './helpers/room.mjs'
import { publishEvalResult } from './helpers/eval-output.mjs'

export const PROSE_FIXTURES = [
  'I need to check the body signature and the args that the function receives. The const value is undefined here.',
  'Looking at this, the `const body` line matters.',
  'Cause: of low quality? Let me verify quickly the actual reason: looksDurable = logic',
]

const CHARS_PER_TOKEN = 4

function ratio(numerator, denominator) {
  return denominator > 0 ? numerator / denominator : 0
}

export async function runAutonomyCycle({ home, cwd, turns = 3, seed = true } = {}) {
  const runtime = testRuntime(home, cwd)
  const store = roomStore(home, cwd)
  const agent = agentFor(cwd)
  const tools = createToolHarness(runtime)

  // Seed real, recall-eligible records through the tool surface so recall has
  // something to deliver; `{ agent }` is required or the store resolution fails.
  // `veyra_remember` returns `{ ok, created, duplicate, redacted, record, disclaimer }`
  // — the id lives at `res.record.id`, NOT `res.id`.
  const seeded = []
  if (seed) {
    for (let i = 0; i < 5; i++) {
      const res = await tools.call('veyra_remember', {
        title: `Lesson ${i}: writer lock ordering`,
        body: `Root cause: the writer lock ordering is inverted. ${'Detail sentence. '.repeat(20)}`,
        kind: 'memory',
      }, { agent })
      if (res?.ok && res.record?.id) seeded.push(res.record.id)
    }
  }

  for (let turn = 0; turn < turns; turn++) {
    await tools.call('veyra_recall', { query: 'writer lock ordering', limit: 5 }, { agent })
  }

  // mergeRate needs the write gate, and only maybeLearn writes its ledger.
  // Gated on `seed` so the empty-room test really starts empty.
  if (seed) {
    for (let i = 0; i < 2; i++) {
      maybeLearn(store, {
        title: `Stock drift after restart ${i}`,
        body: 'Root cause: the event bus redelivers in-flight events after restart.\nFiles touched: src/lock.mjs',
        kind: 'memory',
        authority: 'derived',
        source: { automatic: false, tool: 'eval-autonomy-cycle' },
        evidence: [{ path: 'src/lock.mjs', note: 'test-passed' }],
      }, { workspace: cwd })
    }
  }

  const log = readGenerationEvidence(store)
  const entries = log?.entries ?? []
  const summary = summarizeGenerationEvidence(log)
  const ledger = readWriteGateLedger(store)

  const withResults = entries.filter((e) => e.resultCount > 0)
  const delivered = withResults.filter((e) => e.delivery?.status === 'DELIVERED')
  const sets = new Set(entries.map((e) => [...(e.recordRefs || [])].sort().join(',')))

  const totalChars = entries.reduce((sum, e) => sum + (e.renderedChars || 0), 0)
  const tokensPerTurn = entries.length ? (totalChars / CHARS_PER_TOKEN) / entries.length : 0

  return {
    tokensPerTurn,
    distinctSets: sets.size,
    deliveryCoverage: ratio(delivered.length, withResults.length),
    mergeRate: ledger ? ratio(ledger.decisions.merge, ledger.decisions.accept + ledger.decisions.merge) : 0,
    proseSymbolLeaks: PROSE_FIXTURES.reduce((n, text) => n + extractSymbols(text).length, 0),
    seeded,
    generationCount: entries.length,
    generationSummary: summary,
    autoOutcomeSignals: readAutoOutcomeSignals(store),
    ledger,
    constraints: {
      deliveryClaim: 'tool dispatch returned records; model receipt not provable',
      tokensPerTurn: 'renderedChars / 4, an estimate; graded metric is m00190 M3',
      mergeRate: 'write-gate decisions from maybeLearn, not from veyra_remember',
    },
  }
}

async function main() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'veyra-cycle-home-'))
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'veyra-cycle-repo-'))
  const report = await runAutonomyCycle({ home, cwd, turns: 3 })
  publishEvalResult(report, {
    trackedPath: path.resolve('test/eval-autonomy-cycle-results.json'),
    runPath: path.join(os.tmpdir(), 'eval-autonomy-cycle-results.json'),
    argv: process.argv,
    env: process.env,
    cwd: process.cwd(),
  })
  fs.rmSync(home, { recursive: true, force: true })
  fs.rmSync(cwd, { recursive: true, force: true })
  console.log('--- autonomy cycle ---')
  for (const k of ['tokensPerTurn', 'distinctSets', 'deliveryCoverage', 'mergeRate', 'proseSymbolLeaks']) {
    console.log(`${k}: ${report[k]}`)
  }
}

// The test imports this module, so only run the CLI when invoked directly.
const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href
if (invokedDirectly) main().catch((error) => { console.error('EVAL FAILED:', error); process.exit(1) })
```

Two details that decide whether this works at all:
- `readGenerationEvidence` and `readWriteGateLedger` both return `null` on a fresh room — every read above is `?.`-guarded and every ratio passes through `ratio()` so a denominator of 0 yields `0`, not `NaN`.
- The `seed: false` flag exists precisely so the empty-room test really starts empty. Seeding and the `maybeLearn` calls are both gated on it; without the flag, `ledger` would be non-null even at `turns: 0` and the second test's `assert.equal(r.ledger, null)` would fail. Do not remove the flag and do not soften the assertion — a non-null ledger on an unseeded room is a real finding, so report it instead.

- [ ] **Step 4: Run to pass, then the suite**

Run: `node --test test/eval-autonomy-cycle.test.mjs` → 2 pass.
Run: `node test/eval-autonomy-cycle.mjs --output /tmp/eval-autonomy.json` → prints the five metrics; the run artifact lands in `os.tmpdir()`, and the tracked artifact is skipped unless `VEYRA_EVAL_WRITE_TRACKED=1`.
Run: `node --test test/*.test.mjs` → 1150 pass, 0 fail.

- [ ] **Step 5: Commit**

```bash
git add test/eval-autonomy-cycle.mjs test/eval-autonomy-cycle.test.mjs
git commit -m "test: measure the autonomous memory cycle end to end"
```

---

## Spec Coverage

| Design section | Task |
| --- | --- |
| §2.3 symbol noise → false grounding | 1, 2 |
| §2.3 invisible bash writes | 3 |
| §2.2 delivery unobservable, attribution unreachable | 4, 5 |
| §2.1 fixed cost of repeated recall | 6 |
| §2.4 merge never fires | 7 |
| §2.5 curation is detection-only, §4 step 4 | 8 |
| Exit criteria for every phase | 9 |

Not covered by design (explicit non-goals): embeddings, daemons, model-receipt proof, automatic `canonical`.

## Execution Order

Tasks 1→2→3 are one phase: 1 alone is safe but leaves confidence low; 1+2+3 together restore it with real evidence. Tasks 4 and 5 are independent of 1–3 and may run in parallel. Task 6 depends on Task 4 for a meaningful `delivery` alongside its token number. Tasks 7 and 8 depend on 4. Task 9 last.
