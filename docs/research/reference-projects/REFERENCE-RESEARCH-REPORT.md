# REFERENCE-RESEARCH-REPORT.md

**Repository:** `/home/lovedolove/projects/Veyra`  
**Research phase:** Phase 1 (research only)  
**Date:** 2026-11-07  
**Status:** Complete (evidence-based, no modifications to Veyra or reference projects)

## Scope and Methodology

Researched local reference checkouts under `/home/lovedolove/projects/refs/` against PRD §3 six capabilities: **Experience / Learn / Remember / Understand / Apply / Improve**. Inspected actual source files, tests where present, flows/integration. Recorded exact file/function/evidence, limitations, relevance. Compared with Veyra implementation; no production/test/benchmark/API/runtime changes made.

**References present (from refs/):** `billion-context`, `codebase-memory-mcp`, `deepseek-harness`, `dsh-approval-gate`, `dsh-context`, `dsh-engram`, `dsh-market`, `dsh-memory`, `dsh-our-free-model`, `dsh-token-saver`, `dsh-univer-office`, `dsh-world`, `mnemon`, `OpenViking`, `supermemory`, `tencentdb-agent-memory`. PRD core list all present (`dsh-market, dsh-approval-gate, dsh-univer-office, dsh-memory, dsh-engram, dsh-context, billion-context, codebase-memory-mcp, dsh-our-free-model`).

**Veyra preserved state:** local modifications to `test/eval-retrieval-quality-results.json`, `test/eval-v0169-results.json`; untracked eval/turn-stopping tests remain untouched.

## Veyra baseline (for comparison)

**Core modules (from `src/`):** `plugin.mjs`, `observe.mjs`, `understand.mjs`, `learn.mjs`, `retrieve.mjs`, `context.mjs`, `store.mjs`, `types.mjs`, `redact.mjs`, `lifecycle.mjs`, `trust.mjs`, `feedback.mjs`, `evolve.mjs`, `negative.mjs`, `relationships.mjs`, `code/linking.mjs`, `code/retrieval.mjs`, `tools.mjs`, `commands.mjs`, `webui.mjs`, `health.mjs`, `consolidate.mjs`, `audit.mjs`, `diff.mjs`, `evidence.mjs`, `graph.mjs`, `ids.mjs`, `intent.mjs`, `migrate.mjs`, `observatory.mjs`, `skills.mjs`, `text.mjs`.  
**Storage:** outside repo under `$DSH_HOME/veyra/` (or `$VEYRA_HOME`), project/reusable DBs (`store.mjs` uses Node `node:sqlite` FTS5).  
**Invariants (enforced):** Observe≠Store; Candidate≠Truth (auto-captured candidates never ambient-recalled; canonical only via explicit `veyra_promote` with `explicit=true`); project isolation; fail-closed; redaction before persistence (`redact.mjs`); repository truth wins over memory; no silent merge/overwrite/retire of contradictions; negative/unresolved first-class; trust classification read-only projection; feedback loop separate from causal history.

## Reference Projects - Detailed Findings

### 1) `dsh-memory` (灵枢 LINGSHU) v0.9.23
**Type:** MCP-based long-term memory infrastructure (Python `md_cg` + DSH plugin TS bridge/hooks).  
**Evidence:**
- `dsh-memory/README.md`: pure-text md cognitive graph as truth source, deterministic rule裁决, auditable; tools renamed to `cg/stg/mdcg_*`; default readonly guest; identity facts not auto-recalled by default; committed writes, no silent forgetting, evidence/firewall/audit/reproducibility.
- `dsh-memory/src/hooks.ts`: filters real user messages, session/subagent/delegation filtering (`origin`/`delegationDepth`, relay `form==='relay'`) fail-open on missing; writes via `remember()` gated; appends to `_recent.jsonl` context window; redaction/prompt safety utilities.
- `dsh-memory/src/tools.ts`: dynamic tool discovery from MCP, registers core `cg/stg`, maps schemas to DSH params, session attribution via `attributeSession`.
- `dsh-memory/src/bridge.ts`: spawns Python `md_cg` MCP server over stdio; handshake/tools/list/call; debug log `~/.dsh/logs/lingshu-bridge-debug.log`; retries/give-up.
- `dsh-memory/md_cg/mcp_server.py` (start): exposes cg/stg kernel + many `mdcg_*` tools (`remember/rejected/unresolved/propose/get/search/recall/review_*/reflect/verify/flywheel/mine_fix_pairs/consistency/metacognition/self_state/predict/causal/forget/restore/protect/forgetting_history` etc). `mdcg_remember` with `gated=true` goes through active-forgetting gate (三问→四态 ACCEPT/MERGE/DROP/DEFER). Kernel (`cg`) has op routing with principal checks; forget has gated branch (autonomy tiers). Doc nodes filtered in some read paths (`_maybe_filter_docs`, drops `doc_*` when enabled).

**Capabilities mapping:**
- Experience: hook-based capture filtered by session/origin/relay.
- Learn: gated remember with four-state disposition + forgetting gate semantics (active forgetting) in Python core.
- Remember: committed writes, auditability, protection/forgetting history, identity facts handled carefully.
- Understand: cognitive graph model (md as truth), relations/causal/self-state/prediction tools exist as concepts.
- Apply: context window injection via hooks (`_recent.jsonl`), tools expose retrieval/recall.
- Improve: flywheel/reflect/consistency/metacognition/predict tools present.

**Limitations:** Core learning/disposition logic in Python (`md_cg`) not fully inspected in this pass; TS side is mostly bridge/hooks/tools. Benchmarks mentioned in README but not re-run (forbidden). Integration is MCP-centric vs Veyra's in-process plugin architecture.

**Relevance to Veyra:** Strong ideas around gated writes (four-state), active forgetting/guarded forget with audit trail, protection semantics, and auditability. Veyra has similar ideas (write gate with DROP/DEFER/MERGE/ACCEPT, lifecycle forget with override+history, protected records) but different implementation shape (in-process, SQLite/FTS5, strict fail-closed invariants).

### 2) `dsh-engram` (@kenz1117/dsh-engram) v0.13.9
**Type:** Local-first SQLite memory with hybrid search, evidence gate, provenance audit, SM-2, consolidation/flywheel, Palace IA model.  
**Evidence:**
- `README.md`: 23 tools, hybrid FTS5+local-vector RRF, evidence gate, provenance audit, SM-2 review (zh/en/ru). Palace IA: room#slot coordinates, fixed tour routes append-only, reusable skeleton per topic, placard discipline. Ingestion off/light/eager; 4-state disposition (accept/merge/defer/drop), contradiction edges, low-entropy drop. Session-start profile injection (curated>derived, budgets). Evidence gate: `engram_search` returns batch/refs; `engram_assess` code-forced sufficient only if claimed sufficient + valid batch refs + nextStrategy=answer. Flywheel: ingest/save → contradictions → hit reinforcement → distill (supersedes chain) → decay/archive (not applied to review-scheduled). Reflect/beliefs consolidation optional. Facts timeline, history backfill, export/mirror, Web panel. Tests include `evidence.spec.ts`, `ingest.spec.ts`, `profile-block.spec.ts`, `tools.spec.ts`, `rewrite.spec.ts`, `reflect.spec.ts`, `consolidation.spec.ts`, `migration-policy.spec.ts`, `jev-runtime.spec.ts`.
- `src/index.ts`: large plugin entry - profile injection (`renderProfile`/`renderProfileParts`, curated separate, graduated budgets, overflow index `+N more; use engram_search`, compress overflow with LLM audited fallback to index), observation injection limits, registers tools/routes/hooks, imports consolidation/history backfill/evidence batches/LLM routing.
- `src/ingest/hook.ts`: `IngestMode off|light|eager`, limits/confidence, `INGEST_MAX_TOKENS=4000`, chunked extraction on max-tokens (min chunk 80), parse entity/fact mentions with bounds, idempotency ops `ingest-done/pending/skip`, `IngestDeps` supports writeScope/perCandidateScope/resolveStore/openAuditStore/history (no SM-2 on backfill), judge provider hook, recall tool-call/result filtering to avoid feedback loops.
- `src/retrieve/evidence.ts`: `EvidenceBatches` per session (max 20), monotonic batch ids, verdict tracking, insufficient streak; `assessEvidence` forces sufficient only when claimed + accepted refs in batch + nextStrategy==='answer'; rejects unknown refs, drops over `MAX_EVIDENCE_REFS=8`, missing truncated to 160; `buildAssessReminder` nudges `engram_assess`. `NEXT_STRATEGIES` include `answer/search_keyword/search_room/search_timeline/ask_user/stop`.
- `src/retrieve/budget.ts`: `RECALL_PER_ITEM_CHARS=1200`, `RECALL_TOTAL_CHARS=4800`, `fitWithinBudget`, `enforceBudget` appends dropped count.
- `src/write-disposition.ts`: 4-state (accept/merge/defer/drop). `MERGE_COSINE=0.92`, `DEFER_COSINE=0.88`. Merge reinforces existing (`applyMerge` calls `store.reinforce`, audits). Defer can consult optional JudgeProvider (Jev) with fallback on failure; contradiction candidates may be deferred/built as edges.
- `src/flywheel/distill.ts`: distills memory clusters into higher-level skill/fact via LLM (max 30 inputs, 900 tokens), calls `store.supersedeMany` establishing `supersedes` chain, inherits confidence mean, attaches embeddings if possible.
- `src/review/sm2.ts`: SM-2 (ease min 1.3, initial 2.5, intervals 1/6/round(prev×ease), fail resets to 1 day, reps cleared).
- `src/store/interface.ts`: rich store API (rooms/slots/placards, routes, contradictions list/resolve, supersede, reinforce, facts timeline, entities, snapshots, forgetting/audit). SQLite backend implied.

**Capabilities mapping:**
- Experience: ingest hook with modes/idempotency/chunking, recall filtering.
- Learn: write-disposition (merge/defer/drop/accept), Jev judge optional, low-entropy drop, contradiction detection.
- Remember: palace model (spatial metaphor), curated vs derived separation, budgets, provenance/audit.
- Understand: facts/entities/timeline, contradictions as edges, reflect/consolidation.
- Apply: evidence-gated retrieval (batches + assess forcing), profile injection with budgets/overflow, recall budgets.
- Improve: flywheel (reinforce on merge/hits, distill supersedes, decay/archive), SM-2 review scheduling, reflect/consolidation.

**Limitations:** Heavier feature set (spatial UI metaphors, many tools). Evidence gate is strong but different from Veyra's trust classification. No direct equivalent to Veyra's explicit negative/unresolved kinds as first-class with specific retrieval tail behavior visible in same form; contradiction handling different.

**Relevance to Veyra:** Excellent patterns - evidence-gated retrieval with batch refs and forced sufficient logic, write disposition with merge reinforcement, distill/supersede chains, SM-2, budgeted injection. Veyra already has related pieces (write gate, contradictions visible both sides, negative tail, trust projection) - can learn from enforcement details.

### 3) `dsh-context`
**Type:** Context insight/management plugin (UI/dashboard focused).  
**Evidence:** README shows context composition browser, family/cluster views, `/context` command, diff/badges, settings. Sources under `src/client/*`, `src/host/*` (TS), tests in `tests/client/*`, `tests/host/*`. No obvious learning/memory store/ingest/recall loop comparable to Veyra/dsh-engram/dsh-memory.

**Relevance:** Primarily observability/UX for context composition, not a memory-learning system. Low direct relevance to the six capabilities as a learning engine.

### 4) `billion-context`
**Type:** Context compression plugin (bili).  
**Evidence:** README describes hierarchical/incremental compression, multi-generational context management, "5× fewer tokens", long sessions. Has Hermes plugin, paper, many tests (compression/folding/ACP related). Focus is on context size/retention across generations, not durable project memory with learning/feedback loops.

**Relevance:** Complementary to memory (manages context volume), different problem space than Veyra's engineering memory learning/apply/improve.

### 5) `codebase-memory-mcp`
**Type:** Structural code intelligence (C/MCP, knowledge graph).  
**Evidence:** README describes local code intelligence via MCP, hybrid LSP, knowledge graph, 17 MCP tools, supports many languages. AGENTS.md in Veyra says "Codebase Memory reflects this truth. Prefer cbm_trace for caller/callee, cbm_search for symbols, cbm_snippet for definitions, cbm_arch for deps." Veyra has CBM bridge integration (`plugin.mjs` registers engine/client/watcher, tools include code status/impact).

**Relevance:** Orthogonal/synergistic - provides structural code truth that Veyra uses for evidence anchors/freshness/trust; not a memory learning system itself.

### 6) Others in refs
**`dsh-market`** - plugin market/catalog UI. **`dsh-approval-gate`** - auto-approve gate with risk classification/learning rules/diff snapshots. **`dsh-univer-office`** - Univer office integration. **`dsh-our-free-model`** - free model provider integration. These are not memory-learning systems; limited relevance to the six capabilities.

**Additional memory-related refs present (not in PRD core list):** `mnemon`, `OpenViking`, `supermemory`, `tencentdb-agent-memory` - present in refs/ but not deeply inspected in this pass; scope notes say start from PRD list, no broadening without approval. Noted for completeness.

## Veyra vs References - Capability Comparison (high level)

| Capability | Veyra (current) | dsh-memory | dsh-engram | Notes |
|------------|-----------------|------------|------------|-------|
| Experience | `observe.mjs` filters noise, buffers tools, `distillBuffer` via understand; candidates never ambient-recalled. | Hook filters (user/session/origin/relay), gated remember, recent window. | Ingest hook (modes/chunking/idempotency), recall filtering. | All filter noise; Veyra strict about Observe≠Store. |
| Learn | `learn.mjs` evidence-aware, write gate (DROP/DEFER/MERGE/ACCEPT), evolves relations, negative/unresolved first-class, no silent auth promotion. | Python gate (三问→四态), forgetting gate, deterministic rules. | Write-disposition (merge/defer/drop/accept), Jev judge optional, low-entropy drop, contradictions. | Veyra has strong guards; dsh-engram has explicit cosine thresholds + judge; dsh-memory has active forgetting semantics. |
| Remember | SQLite/FTS5, project/reusable isolation, lifecycle (forget/tombstone with history+override), protection, redaction, candidates excluded from recall. | Committed writes, audit, protection/forgetting history, identity careful. | Palace (rooms/slots/routes), curated>derived, facts/entities, provenance/audit, export/mirror. | Different metaphors; all care about auditability/isolation. |
| Understand | `understand.mjs` distills claims, causal facets with strict gates (no temporal adjacency alone), quality gates, provenance. `retrieve.mjs` hybrid + intent + graph + contradictions both sides + neg tail. | Cognitive graph (md truth), relations/causal/self-state/predict/consistency. | Facts/timeline/entities, contradictions as edges, reflect/consolidation. | Veyra strong on causal rigor and contradiction transparency. |
| Apply | `context.mjs` ambient snapshot with budgets, trust/freshness/temporal, injection warnings. Retrieval eligible records only, neg coverage tail bounded. | Context window injection, recall tools. | Evidence-gated retrieval (batches/assess forced), profile injection with budgets/overflow, recall budgets. | dsh-engram's evidence gate (force sufficient only with valid batch refs + answer strategy) is a strong enforcement pattern; Veyra uses trust classification + eligibility gates. |
| Improve | `feedback.mjs` success strengthens (ladder/progression), failure records history + demotes reliability (canonical protected), recurrence detection (`veyra_recurrence`), trust classification read-only projection, change impact (`veyra_change_impact`). | Flywheel/reflect/consistency/metacognition/predict. | Flywheel (reinforce/merge hits), distill supersedes, SM-2 review, reflect/consolidation, decay/archive. | Veyra has explicit feedback semantics with canonical protection; dsh-engram has stronger spaced repetition + distillation; dsh-memory has metacognition/prediction. |

## Key Observations

1. **Gating discipline:** All three (Veyra, dsh-memory, dsh-engram) emphasize gates before write/recall. Veyra's invariants (Candidate≠Truth, repository truth wins, no silent promotion) are particularly strict.
2. **Evidence/contradictions:** dsh-engram enforces evidence gate at retrieval time with batch refs and forced assessment. Veyra surfaces contradictions on both sides and uses trust classification (read-only). Different enforcement points, complementary.
3. **Learning mechanics:** dsh-engram's merge reinforcement + distill/supersede chains and SM-2 are mature. Veyra's feedback loop is well-defined with canonical protection. dsh-memory's active forgetting gate is interesting.
4. **Context management:** billion-context addresses compression/volume; orthogonal to memory learning.
5. **Structural truth:** codebase-memory-mcp provides code intelligence that Veyra leverages for freshness/trust/anchors.

## Deliverables
This report is one of four required deliverables under `docs/research/reference-projects/` as specified in PRD §8.
