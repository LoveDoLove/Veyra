# Veyra Phase 0 — Source-Level Capability Matrix

**Status:** Phase 0 (establish the current truth) and Phase 1 (reference-source investigation) deliverable. This file replaces the earlier Phase-0 draft that covered only `dsh-memory` and cited line numbers from the retired 1,500-line `GOAL.md`.

**Verified:** 2026-11-04. Veyra cells were checked against this working tree (`ccc08a8` plus the uncommitted recall-budget, write-gate and redaction changes; full suite 860 tests / 854 pass / 6 skipped / 0 fail). Reference cells were checked by opening the checkouts in §1 at the listed revisions.

**Evidence rule:** README text is not evidence. Where a reference and Veyra disagree, the Veyra source and tests win. Line numbers drift; symbol names are the durable anchor.

## Method and decision vocabulary

- Scope: the 16 reference projects in `GOAL.md` §5, grouped as in that section.
- Each row records the reference feature, the exact source symbol(s), what Veyra does today (verified `file:symbol`), the actual gap, a proposed integration point, compatibility/risk, tests and measurable acceptance criteria, and one decision.
- **Adopt** — behavior taken nearly as-is. **Adapt** — the idea is reimplemented in Veyra's architecture. **Defer** — a real gap, not justified now; the trigger that would reopen it is recorded. **Reject** — unsafe, out of scope, or duplicates an existing dependency.
- `GOAL.md` §6 gate: a real gap or measurable weakness shown by source audit; a direct engineering use case; a benefit testable against current behavior; fit with the existing architecture (or a justified minimal extension); every §4 invariant preserved; justified runtime/dependency/storage/maintenance cost; a bounded failure mode that cannot break the agent loop. A finding is not a roadmap commitment.
- License rule: AGPL (`OpenViking`) and unclear-license (`tencentdb-agent-memory`, custom Tencent terms) code is read for ideas only; nothing is copied. MIT/Apache-2.0 source may be adapted, with attribution in `CHANGELOG.md`.

## 1. Reference inventory

| # | Project | Upstream | Revision | License | Stack | What was verified |
|---|---------|----------|----------|---------|-------|-------------------|
| 1 | `dsh-engram` | `github.com/kenz1117/dsh-engram` | `532f1ed` | MIT | TypeScript (154 files) | Write disposition bands, recall budget, evidence sufficiency, selection rationale, consolidation/flywheel/backup |
| 2 | `dsh-memory` | `github.com/FuRongJun-1999/dsh-memory` | `2a9b549` | MIT | Python `md_cg` | Duplicate bands, lifecycle, write gate, RRF, admission, conflict surface, trust, repeat guard, sleep/scrub/whitebox |
| 3 | `dsh-context` | `github.com/bowenliang123/dsh-context` | `73fd9a5` | Apache-2.0 | TypeScript (331 files) | DSH Web GUI only; no memory engine |
| 4 | `mnemon` | `github.com/mnemon-dev/mnemon` | `bbc9151` | Apache-2.0 | Go (632 files) | Checksum PII mask, native BM25/vector index, entity/intent retrieval |
| 5 | `OpenViking` | `github.com/volcengine/OpenViking` | `5760af6f` | AGPL-3.0 | Rust | LLM digest compression in a shared memory plugin (idea-only) |
| 6 | `supermemory` | `github.com/supermemoryai/supermemory` | `16ed414` | MIT | TypeScript (hosted product) | No adoptable local algorithm |
| 7 | `tencentdb-agent-memory` | `github.com/TencentCloud/tencentdb-agent-memory` | `ecc01a5` | Tencent terms | TypeScript/Go (944 files) | Recall budget accounting, LLM two-phase dedup |
| 8 | `billion-context` | `github.com/ranxianglei/billion-context` | `9dc4c9459` | MIT | TypeScript (1717 files) | Context pruning/summary, protected-tool policy |
| 9 | `dsh-token-saver` | `github.com/Shaw529/dsh-token-saver` | `0576ed3` | MIT | TypeScript | Head/tail truncation, grep folding |
| 10 | `deepseek-harness` | `github.com/deepseek-ai/deepseek-harness` | `8bd073392e` | MIT | TS monorepo | DSH core; not a memory engine |
| 11 | `dsh-approval-gate` | `github.com/moon09300731/dsh-approval-gate` | `8419bc3` | MIT | JavaScript | SAFE/RISKY tool pre-judgment |
| 12 | `dsh-market` | `github.com/dsh-market/dsh-market` | `c57e77a` | MIT | TypeScript | Plugin marketplace; "memory" only means in-memory caches |
| 13 | `dsh-our-free-model` | `github.com/zouyuxuan122/dsh-our-free-model` | `b52fa86` | MIT | JavaScript | Model aggregation/routing |
| 14 | `dsh-univer-office` | `github.com/dream-num/dsh-univer-office` | `b7dea7c` | Apache-2.0 | TypeScript | Office/spreadsheet viewers |
| 15 | `dsh-world` | `github.com/chenkezhen480/dsh-world` | `d0b0ba7` | MIT | TypeScript | Personal companion memory (`conversation`/`diary`) |
| 16 | `codebase-memory-mcp` | `github.com/DeusData/codebase-memory-mcp` | `190abae9` | MIT | C | Structural code intelligence; already Veyra's only dependency |

## 2. Capability matrix

### 2.1 Memory and knowledge

| Reference · feature | Exact reference source | Veyra today (verified) | Actual gap / improvement | Proposed integration | Risks / compatibility | Tests / acceptance | Decision |
|---|---|---|---|---|---|---|---|
| `dsh-memory` · write gate with four verdicts and accounting | `md_cg/forgetting.py:58-59` `DUP_MERGE=0.85`/`DUP_DROP=0.60`, `:277` `assess`; `md_cg/writepipe.py` | `src/learn.mjs:62` `WRITE_GATES`, `:239` `learningGuards`, `:498` `writeGate`, `:348`/`:379` verdict ledger; `src/health.mjs:52`/`:189` | Closed this pass: every decision is now recorded (decision + reason, no content) and surfaced in health | Done — reuse the existing meta table | Inert metadata; no migration; bounded; best-effort so a ledger failure cannot break learning | `test/write-gate-ledger.test.mjs` (9) | **Adopt** (done) |
| `dsh-memory` · lifecycle transition machine | `md_cg/lifecycle.py:187` `can_transition`, `:323` `set_state` | `src/lifecycle.mjs:101` `protectionOf`, `:120` `protect`, `:155` `invalidate`, `:180` `supersede`, `:217` `forget`, `:234` `tombstone`; `src/types.mjs:22` `STATUSES` | Veyra encodes transitions as explicit audited actions, not a generic matrix; observable behavior is equivalent for its record model | None needed | A generic state machine would add surface without behavior; architecture mismatch | Existing lifecycle tests (`m10`, `m5`, `supersedes-direction`) | **Reject** |
| `dsh-memory` · deterministic cross-channel RRF | `md_cg/mdcos.py:75` `RRF_K=60`; RRF formula in the retrieval path | `src/retrieve.mjs:519` `RRF_K=60`, `:520` `FUSION_WEIGHT`, `:522` `FUSION_CHANNELS`, `:539` `reciprocalRankFusion` | Already implemented (deterministic, eight channels) | None | None | `test/m3-fusion.test.mjs`, `test/retrieve-calibration.test.mjs` | **Adopt** (done) |
| `dsh-memory` · duplicate classification bands | `md_cg/forgetting.py:181` `redundancy`, `:277` `assess` | `src/consolidate.mjs:118` `detectConsolidationCandidates`, `src/evolve.mjs:223` `evolveAgainst`, `src/diff.mjs:55` `MIN_CONFLICT_SIM=0.35` | Veyra compares token overlap + relations; it has no embedding cosine, so the 0.85/0.60 bands do not apply | Defer until a vector channel exists | Adding embeddings would add a dependency/model call; the deterministic gate must stay authoritative | `test/m12-consolidation.test.mjs`, `test/issue3-classifier.test.mjs` | **Defer** |
| `dsh-memory` · conflict surface | `md_cg/conflict_surface.py` (explicit contradiction pairs) | `src/diff.mjs:93` `diffMemory`, `src/evolve.mjs:223` bidirectional `CONTRADICTS`, `src/observatory.mjs:486` `contradictions` | Veyra surfaces conflicts in diff/health/observatory without a separate pair table | None needed | A second contradiction store would risk divergence | `test/m5-maintenance.test.mjs`, `test/issue3-relationships.test.mjs` | **Adapt** (done) |
| `dsh-memory` · trust verification state machine | `md_cg/trust.py` (verification state: unverified/verified/expired/doubted/rechecking) | `src/trust.mjs:33` `TRUST_CATEGORIES`, `:94` `classifyRecordTrust`; `src/evidence.mjs:115` `classifyEvidenceRelation` | Veyra classifies at read time from evidence anchors; it does not persist a per-record verification state machine | Defer | Persisted state needs a schema field + migration; only justified by a measured freshness failure | `test/trusted-context.test.mjs` | **Defer** |
| `dsh-memory` · admission-style autonomy readings | `md_cg/admission.py` (R1-R4; fail-closed `ok=None`) | `src/health.mjs:52` `memoryHealth` (nine finding categories) | Veyra has no autonomy modes, so there is nothing to admit | Defer | Would require an autonomy model Veyra deliberately does not have | n/a | **Defer** |
| `dsh-memory` · repeat guard / write limit / sleep / scrub / whitebox | `repeat_guard.py:51`/`:98`, `writelimit.py:62`, `sleep.py`, `scrub.py`, `whitebox.py` | none; `src/plugin.mjs:51` `MAINTENANCE_EVERY_N_TURNS=5` is a lightweight periodic hook, not a daemon | Real capabilities, but they need a background service or write throttling Veyra's invariants do not allow | None | Violates "no background services"; high maintenance cost | n/a | **Reject** |
| `dsh-engram` · recall budget | `src/retrieve/budget.ts:10` `RECALL_PER_ITEM_CHARS=1200`, `:13` `RECALL_TOTAL_CHARS=4800`, `:31` `fitWithinBudget`, `:58` `enforceBudget` | `src/context.mjs:37` `DEFAULT_RECALL_CHARS=6000`, `:69` `joinWithBudget`, two-tier allocation | Closed this pass: allocation is per record block, skips an oversized record instead of emptying recall, and treats detail as expendable | Done | CRLF file; notice text is byte-stable; no new dependency | `test/recall-budget-integrity.test.mjs` (7), `test/recall-budget-allocation.test.mjs` (11), `test/recall-budget.test.mjs` | **Adapt** (done) |
| `dsh-engram` · write disposition cosine bands | `src/write-disposition.ts:27` `MERGE_COSINE=0.92`, `:29` `DEFER_COSINE=0.88`, `:179-190` ladder | `src/learn.mjs:239` `learningGuards` (provenance/durability gates) | Veyra's gate is provenance-based, not cosine-based; no embedding channel | Defer | Same embedding dependency as the duplicate bands | `test/m1-write-gate.test.mjs`, `test/m9-provenance-gate.test.mjs` | **Defer** |
| `dsh-engram` · evidence sufficiency loop | `src/retrieve/evidence.ts:16` `MAX_EVIDENCE_REFS=8`, `:19` `MAX_MISSING_CHARS=160`, `:22` `MAX_BATCHES_PER_SESSION=20`, `:43` `INSUFFICIENT_HINT_THRESHOLD=2`, `:51` `buildAssessReminder` | `src/retrieve.mjs:27` `evidenceStrength`; `src/evidence.mjs:30`/`:115`; `src/health.mjs` unverified-high-value findings | Veyra scores and audits evidence but never prompts the agent to collect more | Defer | Needs an agent-turn surface; only justified by a measured recall-without-evidence case | `test/m12-evidence-intelligence.test.mjs`, `test/retrieve-evidence.test.mjs` | **Defer** |
| `dsh-engram` · selection rationale | `src/selection-rationale.ts:12` `Reason`, `:15` `buildSelectionRationale`, `:32` `wrapWithRationale` | `src/retrieve.mjs:568` `rankRecords`, `src/context.mjs:195` `renderEvidenceItem` | Veyra renders evidence but does not attach a one-word reason per recalled item | Defer | Low value; adds output bytes to a budgeted surface | `test/m11-recall-intelligence.test.mjs` | **Defer** |
| `dsh-engram` · consolidation/reflection + backup tar | `src/consolidation/{reflect.ts,run.ts}`, `src/flywheel/distill.ts`, `src/backup/{tar-stream.ts,tar.ts}` | `src/consolidate.mjs:118` (proposals only); `src/migrate.mjs:96`/`:213` (plan/mirror removal only) | No import/export/backup/restore; `GOAL.md` §7 names this as an open investigation area | Defer — decision required | A backup format + restore validation is a significant design decision; risk of cross-project leakage | n/a | **Defer** |
| `mnemon` · checksum-validated PII masking | `internal/safety/mask.go:58` `Mask`, `:124` `luhnValid`, `:141` `consistentGroups`, `:148` `ibanValid` | `src/redact.mjs:20` `PATTERNS`, `:122` `VALIDATED_PATTERNS`, `:161` `scrub` | Closed this pass: Luhn cards, ISO-13616 IBAN and structural SSNs with fixed placeholders; precision rules avoid rewriting engineering strings | Done | No dependency; patterns stay deterministic; all writes already pass through `scrub` | `test/redact-pii.test.mjs` (9; 8/8 true positives, 12/12 ordinary strings untouched, 9/9 card-context false positives clean) | **Adapt** (done) |
| `mnemon` · native BM25 / vector index / entity-intent retrieval | `internal/records/{native_bm25.go,vectors.go}`, `internal/retrieval/{entities.go,intent.go}` | `src/retrieve.mjs:147` `lexicalScore`, `:211` `semanticSimilarity` (token overlap), `src/intent.mjs:89` `intentAffinity`; SQLite FTS5 in `src/store.mjs` | No BM25 or vector index; retrieval is deterministic token overlap + FTS | Defer | New dependency/complexity; only justified by a measured large-store recall miss | `test/retrieval-quality-benchmark.test.mjs` | **Defer** |
| `tencentdb-agent-memory` · recall budget accounting | `MemoryCore/src/core/hooks/auto-recall.ts:33` `RECALL_TRUNCATION_SUFFIX`, `:34` `MIN_TRUNCATED_RECALL_LINE_CHARS=40`, `:854` `applyRecallBudget`, `:911` accounting log | `src/context.mjs:69` `joinWithBudget` + truncation notice | The notice does not report how many records were dropped | Defer | Notice length is computed before selection (chicken-and-egg); an additive suffix stays test-compatible | `test/recall-budget*.test.mjs` | **Defer** |
| `tencentdb-agent-memory` · LLM two-phase dedup | `MemoryCore/src/core/dedup/l1-dedup.ts` (423 lines) | `src/consolidate.mjs:118` deterministic proposals | A model call in the write path is non-deterministic and cannot fail closed cheaply | None | Contradicts fail-closed and no-model-in-write-path rules | n/a | **Reject** |
| `OpenViking` · LLM digest compression | `examples/memory-plugin-shared/lib/recall-compress-core.mjs` | `src/context.mjs:69` deterministic budget | Non-deterministic recall output; AGPL code cannot be copied | None | Model call inside recall; license | n/a | **Reject** |
| `supermemory` · hosted memory product | hosted `apps/`/`packages/` | Veyra's local SQLite store | No local algorithm to adopt; product is a service | None | Would add a service dependency | n/a | **Reject** |

### 2.2 Context engineering

| Reference · feature | Exact reference source | Veyra today (verified) | Actual gap / improvement | Proposed integration | Risks / compatibility | Tests / acceptance | Decision |
|---|---|---|---|---|---|---|---|
| `dsh-token-saver` · head/tail truncation | `src/lib/truncate.ts:1` `TruncateOptions`, `:19-21` `headBytes 16*1024`/`tailBytes 8*1024`, `:25` `truncate`, `:80`/`:109`; `src/lib/fold-grep.ts` | `src/context.mjs:69` record-block character budget | Veyra has no raw tool-output truncation surface; DSH owns tool results | None | Duplicating an orchestration-layer concern would conflict with the host | `test/recall-budget*.test.mjs` | **Reject** |
| `billion-context` · prune/summary + protected tools | `kernel/src/prune.ts:4` `SUMMARY_HEADER`, `:17` `summaryMessageId`, `:130` `prune`; `kernel/src/protected.ts` `ALWAYS_PROTECTED_TOOLS` | `src/context.mjs` reads `compact-checkpoint` sources; no compression | Context compaction belongs to the host/orchestrator, not the memory plugin | None | Two compressors would race over the same conversation | `test/compaction-continuity.test.mjs` | **Reject** |

### 2.3 DSH ecosystem

| Reference · feature | Exact reference source | Veyra today (verified) | Actual gap / improvement | Proposed integration | Risks / compatibility | Tests / acceptance | Decision |
|---|---|---|---|---|---|---|---|
| `deepseek-harness` · DSH core | monorepo `apps/`/`packages/` | Veyra is a Cordis plugin on top of it | Not a memory engine; Veyra must not modify DSH core | None | Invariant: never modify DSH core or profiles | `test/dsh-runtime.test.mjs` | **Reject** |
| `dsh-approval-gate` · SAFE/RISKY pre-judgment | `src/index.mjs` (1508 lines) | Veyra does not gate tool calls | Different plugin's responsibility | None | Duplicate risk logic would fight the approval plugin | `test/isolation-security-benchmark.test.mjs` | **Reject** |
| `dsh-market` · plugin marketplace | `src/` (198 files) | n/a | "Memory" mentions are in-memory caches | None | Wrong domain | n/a | **Reject** |
| `dsh-our-free-model` · model aggregation | `src/{adapter,aggregate,anthropic,catalog,combos,core}.js` | n/a | No engineering-memory capability | None | Wrong domain | n/a | **Reject** |
| `dsh-univer-office` · office viewers | `packages/{unit-comparison-viewer,univerfile-sqlite}` | n/a | No engineering-memory capability | None | Wrong domain | n/a | **Reject** |
| `dsh-world` · personal companion memory | `src/memory.ts` (197), `src/memoryStore.ts` (165), `src/memoryFiles.ts` (135); `MEMORY_KINDS=["conversation","diary"]` | Veyra stores engineering records with provenance | Wrong domain (personal chat/diary) | None | Would pollute project memory | n/a | **Reject** |
| `dsh-context` · DSH Web GUI | `src/{client,host,shared}` (331 files) | Veyra's WebUI is a read-only view (`src/webui.mjs`) | Not a memory engine | None | Out of scope | n/a | **Reject** |

### 2.4 Code intelligence

| Reference · feature | Exact reference source | Veyra today (verified) | Actual gap / improvement | Proposed integration | Risks / compatibility | Tests / acceptance | Decision |
|---|---|---|---|---|---|---|---|
| `codebase-memory-mcp` · structural code intelligence | `src/mcp/*.c`, `src/pipeline/*.c` | Dependency `@lovedolove/dsh-codebase-memory-mcp ^0.1.6`; bridge `src/code/{linking,retrieval}.mjs`; tools `veyra_code_status`/`veyra_change_impact` | Already integrated as a dependency | None | `AGENTS.md` forbids vendoring or re-implementing it | `test/code-*.test.mjs` | **Reject** (duplication) |

## 3. Implemented in this pass (measured)

Four integrations were selected under the §6 gate and landed together with regression tests. Nothing else in this matrix was implemented.

| # | Problem (measured) | Change | Files | Tests |
|---|--------------------|--------|-------|-------|
| 1 | Tail slicing cut through a record block: budget 1200 produced 3 headers but only 2 trust lines; budget 400 produced an orphan header | Allocation unit is the record block; whole blocks only; heading always kept | `src/context.mjs:69` | `test/recall-budget-integrity.test.mjs` (7) |
| 2 | `break` on the first non-fitting block let one oversized rank-1 record empty recall (budgets 400–2500 → 0 headers) | Skip instead of stop; attribution never dropped, detail expendable and restored in rank order | `src/context.mjs:69` | `test/recall-budget-allocation.test.mjs` (11) |
| 3 | `writeGate` computed MERGE/DROP/DEFER + reason but `maybeLearn` returned `record ?? null`, leaving no trace | Bounded verdict ledger in the existing meta table; health accounting; no migration | `src/learn.mjs:348`/`:379`/`:498`, `src/store.mjs:539`/`:545`, `src/health.mjs:52`/`:189` | `test/write-gate-ledger.test.mjs` (9) |
| 4 | No checksum- or structure-validated PII patterns (only prefix/format patterns) | Luhn cards, ISO-13616 IBAN, structural SSNs with precision rules | `src/redact.mjs:122`/`:161` | `test/redact-pii.test.mjs` (7) |

Verification for the whole tree: `npm test` → 860 tests, 854 pass, 0 fail, 6 skipped; `node scripts/runtime-deps-check.mjs` → ok (34 shipped files, 10 bare specifiers); `npm run pack:check` → clean, 46 files.

## 4. Deferred and rejected

**Deferred (trigger in parentheses):** embedding-based duplicate/write-disposition bands (a vector channel is added); persisted trust verification state (a measured freshness failure); evidence-sufficiency reminder loop (a measured recall-without-evidence case); per-item selection rationale (a recall-quality request that justifies the bytes); BM25/vector index (a measured large-store miss); recall drop-count in the notice (a budget-computation change); import/export/backup/restore (a design decision is required first); admission-style autonomy readings (an autonomy model is introduced); richer applicability-condition judging (a measured wrong-context recall; today `src/retrieve.mjs:483` compares only keys both sides state and fails open); an append-only provenance ledger (an audit requirement the bounded, content-free verdict ledger cannot satisfy).

**Rejected (reason):** `dsh-memory` repeat guard/sleep/scrub/whitebox (background service; violates invariants); `tencentdb-agent-memory` LLM dedup and `OpenViking` LLM digest (non-deterministic model call in the write/recall path, and AGPL for the latter); `supermemory` (hosted service, no local algorithm); `dsh-token-saver` and `billion-context` (orchestration-layer concerns owned by the host); `deepseek-harness`, `dsh-approval-gate`, `dsh-market`, `dsh-our-free-model`, `dsh-univer-office`, `dsh-world`, `dsh-context` (no engineering-memory capability, or wrong domain); `codebase-memory-mcp` (duplication forbidden; it is already the dependency).

## 5. Veyra anchors used above

`src/retrieve.mjs` `evidenceStrength:27`, `lexicalScore:147`, `semanticSimilarity:211`, `RRF_K:519`, `reciprocalRankFusion:539`, `rankRecords:568`, `hybridRetrieve:952`, `recall:1068`; `src/context.mjs` `DEFAULT_RECALL_CHARS:37`, `joinWithBudget:69`, `renderEvidenceItem:195`, `composeAgentContext:216`, `renderAgentContext:264`, `buildRecallContext:790`; `src/learn.mjs` `WRITE_GATES:62`, `learningGuards:239`, `recordWriteGateVerdict:348`, `readWriteGateLedger:379`, `writeGate:498`, `maybeLearn:513`, `remember:523`; `src/store.mjs` `getMeta:539`, `setMeta:545`, `put:550`; `src/health.mjs` `memoryHealth:52`, `renderHealth:189`; `src/lifecycle.mjs` `protect:120`, `invalidate:155`, `supersede:180`, `forget:217`, `tombstone:234`; `src/redact.mjs` `PATTERNS:20`, `VALIDATED_PATTERNS:112`, `scrub:151`; `src/consolidate.mjs` `detectConsolidationCandidates:118`; `src/evolve.mjs` `evolveAgainst:223`; `src/diff.mjs` `MIN_CONFLICT_SIM:55`, `diffMemory:93`; `src/observatory.mjs` `contradictions:486`; `src/migrate.mjs` `planProject:96`, `planAll:213` (no import/export/backup).

## 6. Limitations

- This matrix is a snapshot: it was verified on 2026-11-04 and line numbers will drift. The symbol names are the stable reference.
- Reference behavior was read at the revisions in §1; none of the reference code is vendored or executed.
- The "no embedding/vector channel" and "no model/network call in `src/`" claims are negative findings from a full-tree search, not a proof about future code.
- No recall-quality benchmark was run in this pass; the existing benchmark tests were green in the full suite.

## 7. Second pass (2026-11-04) — PII audit

Re-verification of the redaction rows (mnemon row 2, gap row 4) against the working tree after the card-context fix. All claims below were measured, not inferred:

- **Whole-word card context** (mnemon row 2, gap row 4): `CARD_CONTEXT` (`src/redact.mjs:97`) now matches payment terms as whole words. Measured: the 9 false-positive strings (`discard`/`unpaid`/`cardboard`/`discharge`/`recharge`/`accredit`/`wildcard`/`charging the battery id`/`discover the` adjacent to Luhn-valid `4111111111111111`) pass through byte-identical; 9 legitimate positives — including the multi-word `American Express`, bare `pan`, the special forms `cc_num`/`cc number`, and a grouped `4111 1111 1111 1111` with no context word — are still redacted. Regression: `test/redact-pii.test.mjs` (9 tests).
- **Checksum vs structural** (mnemon row 2): `ssnValid` (`src/redact.mjs:115`) applies the US SSN section rules (no zero area/group/serial, area not 666, area below 900) — it is a structural check, not a checksum. The "checksum-validated" wording in docs and comments was corrected to "validated tier (checksum or structural rule)". No implementation change.
- **Other PII patterns audited** (no change): `secret_key_assignment` requires `:`/`=` immediately after the keyword and `env_assignment` is an uppercase-name pattern, so neither has a live substring-boundary defect. `env_assignment` keyword-substring behaviour on uppercase names is the intentional fail-closed over-redaction recorded in §2 row 2.

Findings of this pass, in the task's classification vocabulary:

| Finding | Classification |
| --- | --- |
| Whole-word card context | Was "missing"; now implemented in-tree and verified (Adopt) |
| SSN described as checksum-validated | Partially implemented (docs only); corrected, implementation unchanged |
| Substring-boundary defects in other PII patterns | Already correct (no live defect found; the env over-redaction is by design) |
| LLM-based PII/dedup (mnemon, tencentdb, OpenViking rows) | Not suitable for Veyra (rejected in pass 1, re-confirmed) |
