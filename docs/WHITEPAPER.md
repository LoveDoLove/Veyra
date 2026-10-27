# Veyra: Engineering Intelligence for Coding Agents

**Technical whitepaper — @lovedolove/veyra v0.1.57**

Status of claims in this document: every implementation claim is traceable to the
repository source at the revision stated (v0.1.57, commit 75d74ab, clean tree).
Verification claims cite the test suite or the dated runtime record named in §11
and §15. Where a property is designed for but not yet proven in use, it is
labeled *unproven* in §12 and §13. Nothing in this paper should be read as a
performance or outcome guarantee beyond the stated evidence.

**繁體中文 (Traditional Chinese): [docs/WHITEPAPER.zh-TW.md](./WHITEPAPER.zh-TW.md)**

---

## 1. Executive summary

Coding agents repeatedly re-derive what a project already knows: why a
particular build flag exists, which fix was tried and rejected, what a
canonical architectural decision is, and what changed recently. Veyra gives
them a persistent, per-project **engineering memory** that is:

- **Grounded** — every record carries evidence anchors into the repository
  (file paths, notes, URIs), and out-of-repository paths can never become
  evidence (§6).
- **Trustable by construction** — an authority ladder
  (`candidate → derived → canonical`) where only a human, via an explicit
  tool call, can promote to canonical; similarity of a recalled record to the
  current task never confers authority (§3, §6).
- **Change-aware** — freshness and trust are evaluated at read time against
  repository state, so stale knowledge is demoted, not silently served (§6, §7).
- **Advisory, not executable** — recalled memory is injected as context with a
  standing disclaimer that it is not repository truth and not an instruction;
  the repository remains the single source of truth (§3, §7).

Veyra ships as a DSH (DeepSeek Harness) plugin: pure ESM, zero runtime
dependencies, one SQLite+FTS5 database per project under $DSH_HOME, optional
structural code intelligence through an external graph binary, and a bounded,
read-only web surface. It is evaluated by a 29-test, 45-dimension benchmark
harness that re-asserts its own result table on every run, plus runtime,
isolation/security, and end-to-end suites.

The paper deliberately separates four layers of claim throughout:
**design goals** (§12.1), **implemented** (§12.2), **verified** (§12.3), and
**unproven** (§12.4). Two real projects have exercised the system end to end —
SmartTrip (a web application, 10-level end-to-end verification passed) and
dsh-token-saver (legacy onboarding of 85 records, one auto-recall quality
defect found and root-caused). The measurement question *"does Veyra improve
agent task outcomes?"* remains explicitly open: the paired-task impact
experiment is frozen and reproducible but not yet run (§11.3).

---

## 2. Background: the problem

A coding agent's context window is a working set, not a store. Across sessions
it loses:

1. **Architecture rationale** — *why* the project picked Postgres over a
   graph database, which fix pattern was rejected and for what symptom.
2. **Troubleshooting history** — the root cause of a previously fixed bug and
   the remedy that actually worked (and the ones that did not).
3. **Constraints** — "must support Node 22", "no new dependencies",
   "do not touch module X".
4. **Freshness** — which of the above still hold after the code changed.

Existing mitigations each fail part of this:
conversation history is per-session and ungrounded; documentation drifts from
code (the SmartTrip store surfaced two real drift cases: a removed feature
still advertised in docs, and a doc claim contradicting measured egress
behavior, §11.1); ad-hoc markdown knowledge files have no lifecycle, no
authority model, and no read-time trust evaluation.

Veyra's position: engineering memory is a **first-class, per-project,
evidence-anchored, versioned store** with explicit authority, validation, and
freshness axes — projected into the agent's context only through a bounded,
gated recall path, and always re-checked against the repository at read time.

---

## 3. Design principles and core invariants

Veyra's behavior is organized around one trust chain:

    Repository Truth + Engineering Memory
        → Applicability & Freshness
        → Trust
        → Agent Context

Memory is useful to an agent only when it is *trustworthy in this repository
state, for this task*, and even then it arrives as **context, not
instruction**. The five invariants below are load-bearing: each has a named
mechanism, and each is protected by a test dimension (column D of §12.3).

| # | Invariant | Statement | Mechanism | Guard |
|---|-----------|-----------|-----------|-------|
| P1 | **Observe ≠ Store** | Seeing something happen is not the same as it being true. The observe pipeline records *candidates only*; the noise filter drops non-technical text; the capture gate keeps only technical facets. | `src/observe.mjs:42` `isNoiseText`, `src/observe.mjs:174` `candidateFromBuffer` | D2 (0 false memories from 4 noise probes), D3 |
| P2 | **Candidate ≠ Truth** | Low-authority records are never auto-recalled and never promoted automatically. The write gate defers automatic learning behind provenance; canonical authority is reachable only through an explicit, human-issued `veyra_promote`. | `src/learn.mjs:218` `learningGuards` (DEFER `provenance-gated` at :221, `canonical-requires-explicit-promotion` at :224); recall gate `isRecallEligible` in `src/types.mjs` (excludes candidate and observation kinds; requires authority derived or canonical) | D31 (0 automatic→canonical attempts), D31b (1 explicit promotion), D4/D5 |
| P3 | **Similarity ≠ Authority** | A record that textually matches the query well still carries whatever authority it actually has. Authority, validation, confidence, and evidence strength score *independently* of lexical or semantic similarity; similarity contributes to ranking only, and low-similarity is a floor, never a veto — high-similarity likewise never promotes. | Scoring functions in `src/retrieve.mjs`: `evidenceStrength` :25, `validationTier` :60, `authorityTier` :78, `confidenceScore` :93, `lexicalScore` :146, `semanticSimilarity` :210; records with <4 shared tokens are never suppressed on that basis (:794) | D12/D13 (causal verified outranks suspected 0.567; no causal false signal), D14–D15b |
| P4 | **Similarity ≠ Applicability** | A record can be textually near-relevant yet inapplicable to the current toolchain, task, or time window. Applicability is judged from structured context keys and temporal bounds, not from the query match; the default scope term measures scope proximity, not applicability. | `src/retrieve.mjs`: `scopeProximity` :87, `contextCompatibility` :476, `temporalBounds` :414, `temporalState` :434; `src/retrieve.mjs:512` RRF fusion (K=60, weight 0.06) | D10 (6/6), D11 (4/4) |
| P5 | **Memory ≠ Executable Instruction** | Recalled memory enters the agent's context annotated as remembered experience: "not repository truth; verify against the codebase; similarity is not authority." It can be ignored at cost to the agent's task quality; it is never a command. The plugin itself performs no writes to the user's repository. | Context builder `src/context.mjs:521` `buildRecallContext` (empty string only when zero records; fail-closed on recall errors), injection warning at render (`src/context.mjs:249`, scrubbed via `src/redact.mjs`); hostile injection signals (`ignore_previous`, role overrides) are *detected and flagged*, not obeyed (D30/D30b) | D30, D30b |

A sixth principle, **Repository Truth**, underlies all five: no stored
record outranks the repository, trust is re-derived at every read (§6), and
the system is engineered so that *hiding contradictions is a rejected
behavior* — contradictions stay visible (D14–D15b).

---

## 4. System architecture

Veyra is a DSH plugin (compatible DSH releases 0.1.2-rc.1 through 0.2.0-rc.2
per `package.json`; the README troubleshooting entry states the published
range `>=0.1.2-rc.1 <0.3.0-0`; Node `>=22.5.0 <25.0.0` required for
`node:sqlite`). It has zero runtime dependencies; the shipped module graph is
pure ESM, roughly 180 kB packed.

### 4.1 The dual-brain model

    ```mermaid
    graph TB
        AGENT["Coding agent session<br/>system-prompt context: remembered, advisory"]
        subgraph PLUG["VEYRA PLUGIN (DSH)"]
            OBS["observe → capture gate<br/>→ write gate (DEFERs) → SQLite store"]
            RET["retrieve (hybrid + RRF + 1-hop graph)<br/>→ context projection"]
            LIFE["lifecycle: protect / invalidate / supersede<br/>/ forget / tombstone"]
            TRUST["trust (read-time classification) · redact · security"]
        end
        STORE["Per-project store<br/>$DSH_HOME/veyra/projects/&lt;p_id&gt;/memory.db (+ FTS5)"]
        CBM["codebase-memory-mcp binary (external)<br/>absent → degraded mode; memory layer intact"]
        AGENT -- "recall (gated, bounded)" --> RET
        AGENT -- "observe / learn" --> OBS
        OBS --> STORE
        RET --> STORE
        TRUST --> STORE
        RET -. "stdio JSON-RPC (optional)" .-> CBM
    ```

Four **projections** of one store, not four stores:

1. **Hybrid search** — lexical (FTS5) + semantic (Jaccard token overlap)
   channels fused by reciprocal-rank fusion (`src/retrieve.mjs:532`).
2. **Local graph** — a derived SQLite projection over the memory rows and
   their relations column; nodes are record ids, edges are
   `{type, targetId}` with types exactly
   `updates | extends | derives | contradicts | supersedes`
   (`src/types.mjs`; `src/graph.mjs` `localGraph`). It is *not* a
   second source of truth; an edge inherits trust from its endpoint records
   (`trusted === isRecallEligible`). Bounded by default: 1-hop expansion,
   caps of 40 nodes / 80 edges (`GRAPH_LIMITS`, hops=1, maxHops=2). The
   WebUI landing page serves the same contract as an overview projection
   (`src/webui.mjs:189` `handleVeyraHttp`, registered at :236 — a
   **read-only** `/veyra` surface; verified against mutation attempts, §11.1).
3. **Agent context** — the recall projection of §7, with disclaimer and
   injection-warning scrubbing.
4. **Human surfaces** — the read-only WebUI and the five bundled agent skills
   (`veyra`, `codebase-memory`, `legacy-onboarding`, `memory-review`,
   `memory-maintenance`).

**Storage identity.** One SQLite+FTS5 database per project under
`$DSH_HOME/veyra/projects/<p_id>/memory.db` (default `~/.dsh/veyra`;
overridable with `VEYRA_HOME`). The project id `p_<16hex>` is derived from
`sha256(gitRoot|remote)` (`src/store.mjs` `projectIdFor`); record ids are
`vey_<hash>_<suffix>`. Nothing is written into the user's repository.
Indexes: `memory`, `memory_fts`, `memory_search_fts`. Deduplication is
by content hash at write time (store-level early return).

**Optional code intelligence.** `src/code/` (`client`, `engine`,
`discovery`, `linking`, `watcher`) speaks JSON-RPC 2.0 over stdio to an
external native graph binary (env `CBM_EXE` or PATH). When the binary is
absent the layer degrades: every memory-layer function remains fully
operational; structural queries simply do not exist.

**Configuration.** `recallLimit` (default 5, `src/types.mjs:82`
`DEFAULT_RECALL_LIMIT`; `src/config.mjs:26` `normalizeRecallLimit` maps
undefined/null/empty to the default and honors an explicit 0),
`includeReusable`, `observe`, `learn`, `codebaseWatch`, `home`.

---

## 5. Memory lifecycle

Records carry six kinds, three authority levels, five validations, and
lifecycle actions. The full diagram:

    ```mermaid
    graph TD
        EVT["agent events"] -->|observeEvent| NOISE["noise filter (isNoiseText)<br/>+ capture gate"]
        NOISE --> C["candidate<br/>auto-captured; never auto-recalled<br/>write gate learningGuards: DEFERs"]
        C -->|"veyra_promote to derived<br/>marks 'useful learned memory'"| D["derived — auto-recall eligible<br/>validation: unverified → reviewed → verified<br/>(human review steps only)"]
        D -->|"veyra_promote explicit: true<br/>the ONLY path; never automatic"| K["canonical — project truth<br/>recall-eligible; failure-immune at verified"]
    ```

Kinds (orthogonal to authority): `observation`, `memory`, `knowledge`,
`evidence`, `negative` (a known-failed approach: title is the hypothesis,
body is the rejection reason), `unresolved` (an open investigation: title is
the question, body is the known clues).

Lifecycle actions (`src/lifecycle.mjs`): `protectionOf` :101,
`protect` :120, `unprotect` :136, `invalidate` :155, `supersede` :180,
`forget` :217 (soft — the record stays inspectable and leaves recall; the
reason is preserved in lifecycle history; protected records require
override + reason), `tombstone` :234.

Evolution (`src/evolve.mjs`): `markStale` / `sweepStale` detect records
whose evidence no longer holds against repository state; stale records leave
the recall pool (D18: 0 stale records recalled) but are *kept visible* as
stale, never deleted silently.

**Negative and unresolved channels** are first-class, not special cases:
they participate in recall so that a query about a failing approach surfaces
the known-failed attempt first (D4/D4b/D5: negative+unresolved recall 1.0,
top result the specific deadlock rejection rather than a plausible-looking
answer; D6: idempotence — repeated asks do not duplicate).

**Feedback loop (§19 of the design, `src/feedback`)**: applying a memory in
practice and reporting the outcome (`veyra_feedback`) strengthens verified
records on success and demotes on failure (D21 demotion ladder 1.0). Two
deliberate asymmetries, both tested:

- **Success never self-verifies** (D22): a verified record that merely
  "worked" drops to reviewed — verification is a human review step, not an
  application counter.
- **Canonical is failure-immune** (D22b): a failure against a canonical
  record records history but keeps verified status; canonical authority is
  human-granted and human-withdrawn.

**Recurrence detection (§20, `src/negative`, `veyra_recurrence`)** finds
the same root cause / symptom / failed remedy across records (or one record
with repeated application failures); read-only by default. A cluster that
shares one verified remedy may be elevated to a write-gate candidate (D23–D25
all 1.0). It never auto-promotes; the promotion decision stays with P2.

**Health (§21, `src/health`)** classifies the store into nine quality
categories (verified / reviewed / unverified / stale / invalid / contradicted
/ unresolved / negative / protected) and produces six maintenance findings
(new contradictions, stale knowledge, unresolved investigations, repeated
failures, unverified high-value candidates, records needing revalidation) —
findings are *evidence for explicit review*, never automatic edits.

---

## 6. Evidence and the trust mechanism

### 6.1 Evidence anchors

Every record may carry evidence anchors: repository-relative file `path`,
free-text `note`, or external `uri`. Two hard rules:

- **Out-of-repository paths never become evidence** — an anchor that does not
  resolve in the project is demoted at read time (D16 broken-evidence
  demotion), and the noise/capture gate (P1) keeps only technical facets
  (record vey_1a148b492d3 in the Veyra store documents this P0 repair).
- **Evidence health is continuously checked** (D19: 5/5) — an invalid anchor
  visibly flags the record (`CODE EVIDENCE INVALID: anchored file missing or
  symbol unresolvable`), which is exactly how the auto-recall defect in
  §11.2 was found and recorded.

### 6.2 Trusted-context classification at read time

Trust is a **function of the read, not a stored column**. At read time
`src/trust.mjs:95` `classifyRecordTrust` places each record into one of
five categories (`TRUST_CATEGORIES` at :34):
`trusted | review_required | stale | contradicted | insufficient_evidence`,
with an accompanying action vocabulary (`TRUST_ACTIONS` at :43: use as
context / revalidate / …). The tool `veyra_change_impact` runs this
classification over the changed files of a diff so an agent sees, before
relying on recalled knowledge, which of it the change may have invalidated —
without auto-promoting or auto-demoting anything. Freshness tiers
(`src/retrieve.mjs:102`) and temporal bounds (`:414`, `:434`) feed the
same classification.

**Contradiction policy:** contradictions are detected (D14), kept visible in
the store and in recall output (D15), and scored precisely (D15b). Hiding or
silent-merging a contradiction is on the *reject* list of the architecture
decisions (`docs/architecture-graph.md` §3) — resolving it is a human act
(supersede/invalidate), never a retrieval act.

---

## 7. Recall and retrieval

### 7.1 Pipeline

    ```mermaid
    graph TD
        Q["query (+ optional goal)"]
        LEX["lexical channel (FTS5)<br/>lexicalScore :146"]
        SEM["semantic channel (Jaccard token overlap)<br/>semanticSimilarity :210"]
        FUSE["reciprocal-rank fusion<br/>RRF_K=60, FUSION_WEIGHT=0.06 (:512/:532)"]
        RANK["rankRecords :561 — per-record factors:<br/>evidenceStrength :25 · validationTier :60 · authorityTier :78<br/>confidenceScore :93 · freshnessTier :102 · scopeProximity :87<br/>relationshipScore :223 · causalRelevance :310<br/>temporalBounds/State :414/:434 · contextCompatibility :476"]
        GOAL["goal affinity (optional)<br/>goalAffinity :352 at GOAL_WEIGHT 0.7 (:331)<br/>a ranking direction, never an authority"]
        GRPH["1-hop graph expansion over fused top-K<br/>(GRAPH_LIMITS; caps §4.1)"]
        GATE["recall gate isRecallEligible (src/types.mjs; applied :970, :1029)<br/>not forgotten · status current · not invalid/stale<br/>NOT candidate · NOT observation<br/>authority ∈ {derived, canonical}"]
        TAIL["negative/unresolved coverage tail<br/>NEG_COVERAGE_MAX (def :856, value 3)<br/>known-failed approaches surface even when low-ranked"]
        LIM["limit handling: limit === 0 → [] (:952)<br/>slice at Math.max(0, limit − negTail) (:1014)"]
        CTX["buildRecallContext :521 → agent context<br/>disclaimer + injection warning scrubbed (src/redact.mjs)<br/>empty string only when zero records; fail-closed on recall errors"]
        Q --> LEX
        Q --> SEM
        LEX --> FUSE
        SEM --> FUSE
        FUSE --> RANK
        RANK --> GOAL
        GOAL --> GRPH
        GRPH --> GATE
        GATE --> TAIL
        TAIL --> LIM
        LIM --> CTX
    ```

M11 (`docs/m11-recall-intelligence.md`, verified 2026-09-28 at v0.1.32;
suite grew 337 → 354 tests) fixed the two structural defects found by the
probe suite: **(a)** metadata-only contamination — records carrying zero
query signal were composing scores to ~0.80 and beating a true 0.776
match; such zero-signal composition is now suppressed; **(b)** redundancy —
three phrasings of one fact collapsed to three distinct facts in one context
(931 → 724 bytes). Stated non-goals of that milestone: no embeddings, no
vector store, no reranker, no LLM judge, no graph database, no remote
service, no migrations — the hybrid-lexical-plus-RRF design is deliberate.

### 7.2 Limit handling (a fixed bug, worth stating)

At v0.1.14, `recallLimit: 0` was coerced to the default 5 and the retrieval
path floored the limit to 1, so "recall off" was impossible — this blocked
the paired-task impact experiment's isolation arm (§11.3) and was frozen as
an open question in the architecture doc. The product bug is fixed
(`src/config.mjs:26` honors an explicit 0; `src/retrieve.mjs:952` returns
an empty list) and D31/D31b plus the regression tests hold it. The *result*
of the experiment, however, was never measured — see §11.3.

---

## 8. Bootstrapping existing projects

The `legacy-onboarding` skill addresses the cold-start problem: an
unfamiliar project with no memory baseline. Its contract, in one line each:
assess the existing baseline; discover the repository; pick a progressive
investigation depth; extract **only durable engineering knowledge grounded in
verifiable evidence**; produce a **Project Memory Baseline** that future
agents recall instead of re-investigating. Every item captured is a
candidate (P1/P2): it enters recall only after an explicit promotion, and
its evidence anchors keep it checkable (and auto-demotable when they go
stale). §11.2 is the live example.

---

## 9. Security and isolation

| Property | Mechanism | Guard |
|---|---|---|
| Per-project store isolation | one `memory.db` per project id; reusable-scope records shared only behind `includeReusable` (opt-in) | D32: 0 cross-project leaks across 2 queries; test `isolation-security-benchmark` |
| Secret hygiene | `scrub` / `redact` (`src/redact.mjs:45` / :74) strip secrets from title, body, tags, evidence, and source columns at write time | D26: 0 leaks; D26b: bearer/JWT-style tokens scrubbed |
| Injection resistance | recalled content is rendered *as data*: hostile markers (`ignore_previous`, role-override phrasings) are detected at render and a warning is scrubbed in, never executed | D30 detect, D30b 0 false-positives |
| Corruption fail-closed | a store that fails integrity checks is refused, not repaired or half-read: the literal error "Veyra refuses to open corrupted store" | D27–D29 (flag, exclude, surface, refuse) |
| WebUI read-only | the `/veyra` surface accepts no mutations (`src/webui.mjs:189`) | SmartTrip level L9, §11.1 |
| Canonical safety | no automated path — write gate, feedback loop, or recurrence — can reach canonical authority (P2) | D31 (0 attempts under both defer reasons), D31b (explicit works) |
| No repository writes | the plugin writes only under $DSH_HOME/veyra | architecture invariant, `docs/architecture-graph.md` §3 |

---

## 10. Evaluation methodology

**Primary harness:** `test/m15-benchmark.test.mjs` — 29 tests covering
45 labeled dimensions (D1–D32, with sub-dimensions), documented in
`docs/BENCHMARK.md`. The harness **re-asserts its own result table on every
run**: a benchmark regression fails the build rather than silently changing
a published number. Two accounting policies: a null denominator is reported
as null (never 0), and the BLINDSPOT policy records *known-uncovered*
behavior (currently 0 items); today's table carries no blindspot.

Headline dimensions (all verified at v0.1.57 by `npm test`):

| Dimension | What it measures | Result |
|---|---|---|
| D1–D3b | write precision / false memories / dedup / false merges | 1 / 0 / 1 (5/5 restatements produce no new row) / 0 |
| D4–D6 | negative & unresolved recall, idempotence | 1 / 1 / 1 |
| D7–D8 | top-1 and MRR over 5 labelled queries | 1 / 1 |
| D9/D9b | off-topic suppression | 0 / 0 |
| D10–D11 | applicability, temporal | 6/6, 4/4 |
| D12–D13 | causal strength ordering, causal false signal | verified(1) > suspected(0.567) / 0 |
| D14–D15b | contradiction detect / visibility / precision | 1 / 1 / 1 |
| D16, D18–D19 | broken-evidence demotion, stale leaves recall, evidence health | / 0 / 5/5 |
| D20 | feedback reliability, 2 successes vs 3 failures over 5 attempts | 0.4 — an **arithmetic identity** of the fixture, not a target value |
| D21, D22, D22b | demotion ladder / success-never-self-verifies / canonical immunity | 1 / 1 / 1 |
| D23–D25 | recurrence detect / eligibility / precision | 1 / 1 / 1 |
| D26, D26b | secret leak / bearer-JWT scrub | 0 / scrubbed |
| D27–D29 | corruption flag / exclusion / surfacing / corrupt-store refusal | all verified |
| D30, D30b | injection detect / false-positive | detected / 0 |
| D31, D31b | automatic→canonical attempts / explicit promotion | 0 / 1 |
| D32 | cross-project leak | 0 |

**Complementary suites:** `test/isolation-security-benchmark.test.mjs`
(project isolation + security properties), `test/dsh-runtime.test.mjs`
(real DSH runtime integration), `test/e2e-workflow.test.mjs` (full
observe→learn→recall→lifecycle workflow), ten `test/code-*.test.mjs`
(modules of the optional code-intelligence layer), plus per-milestone suites
(`m1`–`m14`, e.g. `m11` = recall-intelligence probes, `m3` = RRF
fusion, `m4` = applicability/temporal, `m5` = causal provenance,
`m10` = forgetting & protection, `m12` ×3, `m13` = safety hardening,
`m14` = goal retrieval, `m1-write-gate`, `m2-negative-unresolved`).
CI runs `npm test` and `npm run pack:check` (packed-size invariant).

**Honest caveat on evaluation:** the dimensions are *fixture-based*. They
prove the *mechanisms* behave as specified over constructed stores; they do
not measure agent task outcomes, and they are not "wild" benchmarks. §11
is where real, un-constructed stores meet the system.

---

## 11. Cross-project validation

Two production stores exercised Veyra outside its own development loop.
Both are stated precisely, including what was *not* measured.

### 11.1 SmartTrip (p_6aed36ea45dd7de9) — end-to-end integration

SmartTrip is a Next.js + Supabase web application. On 2026-09-24 a full
ten-level end-to-end verification was run against the live store and **all
levels passed**:

L1 plugin installation · L2 profile integration · L3 project-store creation ·
L4 write path · L5 read/recall · L6 authority model · L7 store isolation ·
L8 network graph projection · L9 WebUI mutation protection (read-only
surface held against mutation attempts) · L10 fresh-session persistence.

What the store contained and demonstrated (23 records: 16 derived/unverified,
1 canonical/reviewed, 2 superseded, 1 stale, 2 candidate):

- A **real architectural decision** — "D1: Supabase REST, not TCP" — was
  stored, promoted to canonical by explicit human action, and was recalled
  both by its exact wording and by a paraphrase. This is the canonical-path
  proof (P2) in a real store, not a fixture.
- The store **surfaced genuine documentation drift** in the SmartTrip repo:
  a removed chat-refine feature still advertised by docs/README/upgrade
  modal; and a measured Gemini egress region (Asia) contradicting the doc
  claim (US) — a live example of Repository-Truth over stale documentation.
- The store also shows the *unverified majority* is normal: 16 of 23 records
  await application feedback before they may be trusted (the P2 design, not a
  defect).

The run was recorded in Veyra's own store (p_2d599165fe7aa1a7, 430 records)
as vey_1a0d44d8401 ("What does SmartTrip use for Supabase data access?")
and vey_1a0d4545572 (the L1–L10 pass report).

### 11.2 dsh-token-saver (p_0fd9252c3955a1c2) — legacy onboarding + a found defect

On 2026-10-27 the `legacy-onboarding` skill baselined dsh-token-saver, a
mature DSH context-engineering plugin: 85 records (66 candidate/unverified,
16 derived/unverified, 1 derived/reviewed, 1 candidate/stale) —
architecture overview, stable prompt-cache layout, prompt shaping, context
pressure and LLM-summary compaction, and the RTK table filter. All are
*unverified by construction* (§8): the baseline is recall-eligible only after
explicit promotion; as of this writing it is still candidate-weighted.

**Defect found in live use (stated plainly):** auto-recall surfaced
*irrelevant reusable records with stale anchors* into dsh-token-saver
sessions — for example Cloudflare Workers "Issues" monitoring knowledge and
wrangler source-map knowledge whose anchors (`wrangler.jsonc`) do not
resolve in that project, plus a DSH plugin-integration-pattern record with
missing source files. The evidence-health machinery flagged each
(`CODE EVIDENCE INVALID`) and the root cause was analyzed and recorded in
the store ("Veyra auto-recall noise observed in a dsh-token-saver session
(2026-10) — root cause analyzed"). Two honest qualifications:

- This is a **single observed session population, not a measured noise rate**;
  the reusable-scope channel is opt-in (`includeReusable`) and the noise
  came specifically from *reusable* records whose anchors outlived their
  origin project.
- **No before/after improvement for dsh-token-saver was measured.** Nothing
  in this store has been quantitatively A/B tested.

### 11.3 The impact question — explicitly open

The paired-task experiment that would answer *"does Veyra improve coding
agents?"* is specified and frozen in `docs/experiment-impact.md`: a
5-task protocol (v0.1.14, commit 1c17f70) with real implementation tasks and
a controlled "no recall" arm (`recallLimit: 0`). It was **blocked at
freeze**: `recallLimit: 0` was coerced to 5 and the retrieval path floored
the limit to 1 (live probe: limit 0 → 1 record, 678-char prompt), so the
isolation arm leaked — the document forbids every workaround and records:
*"Architecture open question #2 not updated: no measured paired result."*

The underlying product bug has since been fixed (§7.2) — the experiment is
now *runnable* — **but it has not been re-run, and no measured utility
statement about task outcomes exists for Veyra.** This is the largest single
gap between "implemented and verified" and "proven useful" in this paper,
and it is scheduled rather than assumed (§14).

### 11.4 Generality, honestly scoped

Both validation stores are DSH-plugin-adjacent projects on the same
machine; the SmartTrip store is small (23 records) and the dsh-token-saver
onboarding produced unverified candidates. Neither result generalizes to,
e.g., an unfamiliar large monorepo, a non-DSH host, or a hostile
contribution environment. The benchmark (which is fixture-based, §10) and
these two stores are all the validation this paper claims.

---

## 12. Capability statement

### 12.1 Design goals

A reliable, persistent, change-aware engineering memory for coding agents:
grounded in repository evidence; authority, validation, freshness, and
applicability as explicit, independent axes; advisory context injection;
per-project isolation; no repository writes; deterministic, bounded,
fail-closed behavior; and eventual *measured* demonstration of utility on
paired tasks (the experiment, §11.3).

### 12.2 Implemented

| Capability | Where |
|---|---|
| Observe → capture gate → write gate → store pipeline | `src/observe.mjs`, `src/learn.mjs`, `src/store.mjs` |
| Six record kinds; authority ladder; validations | `src/types.mjs` |
| Lifecycle: protect / invalidate / supersede / forget / tombstone | `src/lifecycle.mjs` |
| Evolution: staleness marking and sweeps | `src/evolve.mjs` |
| Hybrid recall: lexical + semantic + RRF + goal affinity + 1-hop graph + negative tail | `src/retrieve.mjs`, `src/graph.mjs` |
| Read-time trusted-context classification, change-impact analysis | `src/trust.mjs` |
| Feedback loop with deliberate asymmetries; recurrence detection; health reports | `src/feedback`, `src/negative`, `src/health` |
| Context projection with disclaimer + injection warning; secret scrubbing | `src/context.mjs`, `src/redact.mjs` |
| Read-only WebUI; observatory projections | `src/webui.mjs` |
| Optional code intelligence (external graph binary, degraded mode) | `src/code/` |
| Five bundled skills | `skills/` |
| 29-test / 45-dimension benchmark harness + complementary suites | `test/`, `docs/BENCHMARK.md` |

### 12.3 Verified

- **All §10 dimension results** at v0.1.57 via `npm test` (the harness
  re-asserts the table; CI enforces it).
- **Recall-intelligence fixes** (M11, v0.1.32 baseline, suite 337→354):
  metadata-only contamination suppression and redundancy dedup, probes p1–p15.
- **Runtime and integration**: `dsh-runtime`, `e2e-workflow`,
  `isolation-security-benchmark` suites.
- **SmartTrip L1–L10** (2026-09-24, live store, §11.1) — including canonical
  promotion, paraphrase recall, WebUI read-onlyness, and cross-session
  persistence.
- **Recall-off is real** (`recallLimit: 0` → empty context, §7.2).

### 12.4 Unproven (stated, not footnoted)

1. **Task-outcome utility** — no measured paired-task result exists (§11.3).
2. **Onboarding coverage** — what fraction of a real codebase's durable
   knowledge a legacy-onboarding pass captures is unmeasured; dsh-token-saver
   has no before/after (§11.2).
3. **Auto-recall noise rate** — the reusable-scope noise was observed in one
   session population; a rate has not been measured.
4. **Generality beyond DSH-plugin-adjacent stores** — both validation stores
   are same-host, same-lineage (§11.4).
5. **Failure asymmetry in the wild** — D22/D22b are fixture-verified
   properties; their behavior on long-lived real stores (e.g., Veyra's own
   430-record store) is inferred, not audited.
6. **Semantic recall beyond lexical+RRF** — by design no embeddings exist
   (M11 non-goals); whether the lexical-plus-overlap ceiling ever bites in
   large stores is unmeasured.

### 12.5 Capability gaps versus the prior art

Against the `dsh-memory` reference engine (the sibling local checkout
`../refs/dsh-memory`, the Python `md_cg` lineage; source-level matrix in
`docs/capability-matrix.md`, Phase 0),
remaining named gaps: a deterministic cross-channel RRF *judge*, independent
applicability-condition judging, decayed-temporal v2, causal-chain walk and
explain, an append-only provenance ledger, and admission-style autonomy
readings. These are *gap listings*, not promises.

---

## 13. Known limitations

1. **Deterministic retrieval only** — lexical + Jaccard-overlap channels; no
   embeddings, vector store, reranker, LLM judge, or remote service (design
   choice, M11 non-goals).
2. **Fixture-based benchmark** — mechanism verification, not outcome
   measurement (§10, §11.3).
3. **Evidence granularity** — anchors are file/symbol/URI level; out-of-repo
   paths are barred from evidence, so web-sourced knowledge carries URI
   anchors whose resolution is not re-checked at read time (D19 checks the
   repository side).
4. **Onboarding volume asymmetry** — a legacy-onboarding pass writes many
   candidates and few validated records; recall eligibility lags the
   baseline by an explicit-promotion step by design (dsh-token-saver:
   66/85 candidate).
5. **Reusable-scope noise** — cross-project records can be recalled into a
   project where their anchors no longer resolve; the flags are automatic
   (evidence health) but suppression quality for reusable records is the
   open item from §11.2.
6. **Human-bound steps** — verification, canonical promotion, contradiction
   resolution, and forgetting of protected records require a human; the
   system deliberately cannot close those loops by itself (P2).
7. **Host requirement** — DSH plugin; Node ≥ 22.5 (`node:sqlite`). The
   optional graph layer requires the external CBM binary or degrades.
8. **Advisory memory** — agents may ignore recalled memory (P5); the value
   proposition is therefore *bounded by agent compliance*, which the impact
   experiment (§11.3) is designed to measure.

---

## 14. Future direction

The GOAL document's posture: **the core technical foundation is substantially
complete; the remaining direction is consolidation, not feature sprawl.**
Specifically, with the architecture's reject/defer list
(`docs/architecture-graph.md` §3) held as a standing boundary:

- **Reject (standing):** external graph DBs (Neo4j or otherwise); new node
  types (file/commit/repo); new UI relation types; a "needs-review"
  vocabulary; default full-project graphs; **auto-canonical, silent merge,
  and hiding contradictions** (core invariants); FUSE/SMFS connectors and
  remote APIs.
- **Defer (standing):** default 2-hop traversal (only if 1-hop proves
  measurably thin), edge-level validation/provenance (relations stay
  `{type, targetId}` and inherit endpoint trust), new MCP tools
  (`veyra_inspect` already returns relations).
- **Next concrete step:** run the frozen paired-task impact experiment
  (§11.3) now that its blocking product bug is fixed; publish the first
  measured utility numbers or the first honest null result.
- **Named open items:** close the reusable-scope noise item (§11.2/§13.5);
  the §12.5 gap list remains an agenda, not a commitment; consolidation of
  the milestone test suites is a maintenance task, not a feature.

---

## 15. Traceability

| Source of a claim in this paper | Location |
|---|---|
| Traditional Chinese edition | `docs/WHITEPAPER.zh-TW.md` |
| Product goal, trust chain, current-state list | `GOAL.md` |
| Facts baseline, adopt/reject/defer, graph contract, WebUI read-onlyness | `docs/architecture-graph.md` (§3 table; baselines 0.1.12/0.1.14/0.1.18) |
| 45-dimension benchmark table + harness policy | `docs/BENCHMARK.md`, `test/m15-benchmark.test.mjs` |
| Recall-intelligence milestone, non-goals, probes p1–p15 | `docs/m11-recall-intelligence.md` (verified 2026-09-28 @ 0.1.32) |
| Frozen impact-experiment protocol and its blockage | `docs/experiment-impact.md` (5-task freeze at v0.1.14 / 1c17f70) |
| Capability gaps vs prior art | `docs/capability-matrix.md` (Phase 0 vs `../refs/dsh-memory`, the sibling local checkout) |
| Retrieval pipeline | `src/retrieve.mjs` (lines cited in §4/§7) |
| Write gate, provenance defers | `src/learn.mjs:186/218/221/224` |
| Recall gate, record kinds, default limit | `src/types.mjs` (`isRecallEligible`, :82) |
| Lifecycle actions | `src/lifecycle.mjs:101–234` |
| Trust classification | `src/trust.mjs:34/43/95` |
| Context + injection warning | `src/context.mjs:249/521` |
| Redaction | `src/redact.mjs:45/74` |
| Observe pipeline | `src/observe.mjs:42/82/174` |
| Limit handling | `src/config.mjs:26`, `src/retrieve.mjs:952/1014` |
| Graph projection | `src/graph.mjs` (`localGraph`, GRAPH_LIMITS) |
| WebUI | `src/webui.mjs:189/236` |
| Code intelligence | `src/code/` (client/engine/discovery/linking/watcher) |
| CI | `.github/workflows/`: `npm test`, `npm run pack:check` |
| SmartTrip live-store record (L1–L10 pass 2026-09-24; drift cases) | Veyra store p_2d599165fe7aa1a7: vey_1a0d44d8401, vey_1a0d4545572; SmartTrip store p_6aed36ea45dd7de9 |
| dsh-token-saver onboarding (2026-10-27) + auto-recall noise record | store p_0fd9252c3955a1c2 (85 records; root-cause record "auto-recall noise … (2026-10)") |

Revision context: v0.1.57 @ 75d74ab, clean tree at writing time.

---

## 16. Glossary

- **Authority ladder** — candidate → derived → canonical; the only
  auto-recalled authorities are derived and canonical; canonical only via
  explicit human promotion.
- **Recall gate (`isRecallEligible`)** — a record may be auto-recalled iff
  it is not forgotten, has status current, is not invalid or stale, is not
  a candidate or an observation, and has authority derived or canonical.
- **RRF** — reciprocal-rank fusion of the lexical and semantic channels
  (K=60, fusion weight 0.06).
- **Evidence anchor** — a record's grounding: repository path, note, or URI;
  out-of-repo paths cannot be evidence.
- **Trusted-context category** — the five-way read-time classification of
  §6.2.
- **DEFER** — the write gate's "not yet" verdict with a reason string
  (`provenance-gated`, `canonical-requires-explicit-promotion`).
- **Tombstone** — the terminal lifecycle marker of a forgotten record.
- **Degraded mode** — operation with the external code-intelligence binary
  absent; the memory layer is unaffected.
