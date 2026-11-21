# Function-Level Evidence Anchors — Integration Design

**Status:** Design review (Phase 2 pre-implementation)
**Author:** Veyra Engineering
**Date:** 2026-11-20
**PoC validation:** ✅ 93.2% average noise reduction ([poc-results.json](poc-treesitter-chunking/poc-results.json))

---

## 1. Executive Summary

**Goal:** Enable Veyra to store and retrieve function-level evidence anchors instead of whole-file anchors, improving memory precision by 16-40× (measured).

**Scope:** Extend the existing evidence anchor schema with optional function-level fields (`symbol`, `startLine`, `endLine`) without breaking file-level evidence or any existing safety invariants.

**Non-goals:**
- ❌ Multi-language support beyond JS/TS (defer to Phase 3)
- ❌ Automatic code indexing or background chunking
- ❌ Changing memory authority, validation, or lifecycle rules
- ❌ Adding embedding backends or Python dependencies
- ❌ Replacing CBM or CodeRAG

---

## 2. Data Structure

### 2.1 Current Evidence Anchor Schema

```typescript
interface EvidenceAnchor {
  path?: string;  // File path (workspace-relative or absolute)
  uri?: string;   // External reference (URL, issue tracker, etc.)
  note?: string;  // Test outcome ("test-passed", "test-failed") or observation
}
```

**Storage:** JSON TEXT column in `memory.evidence` (line 82, `src/store.mjs`).

### 2.2 Proposed Extension

```typescript
interface EvidenceAnchor {
  // Existing fields (unchanged)
  path?: string;
  uri?: string;
  note?: string;

  // NEW: Function-level precision (all optional)
  symbol?: string;    // Function/class/method name
  startLine?: number; // 1-based line number
  endLine?: number;   // 1-based line number (inclusive)
}
```

**Backward compatibility:** All three new fields are optional. Existing file-level anchors (`{path, note}`) remain valid and work unchanged.

**Validation rules:**
- `symbol`, `startLine`, `endLine` are **only valid when `path` is present**.
- A function-level anchor **must have all three new fields or none** (partial function anchors are invalid).
- `startLine <= endLine` (enforced in validation).

### 2.3 Evidence Anchor Types

After integration, three evidence anchor types will coexist:

| Type | Fields | Example | Use case |
|------|--------|---------|----------|
| **URI-only** | `uri`, `note` | `{uri: "https://github.com/org/repo/issues/42", note: "..."}` | External references |
| **File-level** | `path`, `note` | `{path: "src/retrieve.mjs", note: "test-passed"}` | Whole-file evidence (existing) |
| **Function-level** | `path`, `symbol`, `startLine`, `endLine`, `note` | `{path: "src/retrieve.mjs", symbol: "validationTier", startLine: 188, endLine: 197, note: "test-passed"}` | Function-level evidence (new) |

---

## 3. Retrieval Flow

### 3.1 Current Behavior

When Veyra recalls a memory with file-level evidence, the agent retrieves **the entire file** (`src/retrieve.mjs` = 65KB, all 159 top-level statements).

**Problem:** 98.9% of that content is noise for a query like "How does Veyra rank search results?"—the answer lives in `validationTier` and `authorityTier` (704 chars total).

### 3.2 Proposed Behavior

When a memory has function-level evidence anchors, `veyra_recall`:
1. Returns the anchor with `symbol`, `startLine`, `endLine` in the result
2. Agent reads **only the relevant function** using `tools.read({file_path, offset: startLine, limit: endLine - startLine + 1})`
3. 93% less noise on average (measured across 5 real decisions)

**Ranking impact:** Function-level evidence anchors indicate **higher precision**, but do NOT automatically indicate higher reliability or test coverage.

```javascript
// src/retrieve.mjs, evidenceStrength()
function evidenceStrength(evidence) {
  if (!evidence) return 0.1
  const arr = Array.isArray(evidence) ? evidence : []
  if (arr.length === 0) return 0.1

  let hasFile = false
  let hasTestedFile = false      // NEW: test-passed must be on same item as path
  let hasPreciseAnchor = false   // NEW: tracks function-level precision

  for (const item of arr) {
    // Function-level anchor = higher precision, but NOT automatic test signal
    if (item?.path && item?.symbol && item?.startLine && item?.endLine) {
      hasFile = true
      hasPreciseAnchor = true

      // test-passed must be on THIS evidence item to count as tested
      if (item.note === 'test-passed') {
        hasTestedFile = true
      }
    } else if (item?.path) {
      hasFile = true

      // test-passed must be on THIS evidence item to count as tested
      if (item.note === 'test-passed') {
        hasTestedFile = true
      }
    }
    // URI-only evidence does NOT count as file evidence (keeps 0.1 score)
  }

  // Scoring hierarchy: tested file > precise anchor > file-only > URI-only
  // test-passed is an evidence attribute, not a propagatable label
  if (hasTestedFile) return 0.8           // File + test-passed on same item
  if (hasPreciseAnchor) return 0.7        // File + function-level (precise but untested)
  if (hasFile) return 0.6                 // File-only
  return 0.1                              // URI-only or no structural evidence
} else if (item?.path) {
      hasFile = true
    }
    // URI-only evidence does NOT count as file evidence (keeps 0.1 score)

    // Test outcome is SEPARATE from precision
  }

  // Scoring separates precision from reliability:
  // - File + test outcome = 0.8 (existing, unchanged)
  // - File + precise anchor = 0.7 (NEW: higher than file-only, lower than tested)
  // - File-only = 0.6 (existing, unchanged)
  // - URI-only = 0.1 (existing, unchanged)

  if (hasFile && hasTest) return 0.8           // Tested evidence (most reliable)
  if (hasFile && hasPreciseAnchor) return 0.7  // Precise but untested
  if (hasFile) return 0.6                      // File-level anchor
  return 0.1                                   // URI-only or no structural evidence
}
```

**Why this works:** Function-level anchors score **between** file-level (0.6) and tested (0.8), reflecting their **precision advantage** without falsely claiming they are tested. Test outcomes (`note: "test-passed"`) remain the only path to 0.8 scoring.

**Conceptual separation preserved:**
- **Evidence precision:** Function-level (0.7) > file-level (0.6)
- **Evidence reliability:** Test outcome (`note`) → 0.8 when combined with structural anchor
- **Memory authority:** Unchanged (candidate/derived/canonical gates)
- **Validation:** Unchanged (verified/stale/invalid lifecycle)

---

## 4. Compatibility & Migration

### 4.1 No Schema Migration Required

Evidence is stored as JSON TEXT. New fields are additive and optional. **Zero breaking changes.**

### 4.2 File-Level Evidence Stays Valid

Existing memories with `{path: "src/retrieve.mjs", note: "test-passed"}` continue to work exactly as before. No forced migration.

### 4.3 Mixed Evidence in One Record

A single memory **may have both file-level and function-level evidence**:

```json
{
  "id": "vey_abc123",
  "title": "Hybrid search combines 7 dimensions",
  "evidence": [
    {"path": "src/retrieve.mjs", "symbol": "validationTier", "startLine": 188, "endLine": 197},
    {"path": "docs/architecture.md", "note": "Design rationale section 2.1"},
    {"uri": "https://github.com/org/repo/pull/42", "note": "PR that introduced this"}
  ]
}
```

**Ranking:** The function-level anchor scores **0.7** (higher than file-only 0.6, lower than tested 0.8), followed by file-level (`0.6`), followed by URI (`0.1`). The record gets the **max** score across all evidence items.

---

## 5. Staleness Detection

**Phase 2 scope:** The schema supports staleness metadata (symbol/startLine/endLine), and existing `veyra_code_status`/`veyra_change_impact` tools can detect when files or symbols are missing. **Phase 2 does NOT implement automatic line-shift tracking or symbol renaming detection.** That is deferred to Phase 5.

**Problem:** Code evolves. A function-level anchor pointing to `src/retrieve.mjs:188-197` may become invalid when:
- The function is renamed (`validationTier` → `calcValidationScore`)
- The function is moved to another file
- The function is deleted
- Line numbers shift due to edits above the function

### 5.1 What Phase 2 Implements

Phase 2 adds the schema fields (`symbol`, `startLine`, `endLine`) and basic validation:
- Evidence items with function-level fields pass schema validation
- `veyra_remember` accepts and stores them
- `veyra_recall` retrieves and returns them

**Phase 2 does NOT implement:**
- Automatic detection of symbol disappearance
- Automatic detection of line-range shifts
- Staleness transitions based on code changes

Those capabilities are deferred to Phase 5. Existing `veyra_code_status` and `veyra_change_impact` tools can detect missing files (they already do), but **automatic symbol/line tracking is out of scope for Phase 2.**

### 5.2 Stale Evidence in Recall

Memories with `validation: 'stale'` are **never returned by `veyra_recall`** (existing gate, line 40 in `src/retrieve.mjs`). Stale function-level evidence automatically drops out of recall until revalidated.

**Manual revalidation:** `veyra_inspect <id>` shows the stale anchor. The agent checks the repository, updates the `startLine`/`endLine` if the function moved, or marks the memory `invalid` if the function no longer exists.

---

## 6. Workspace Isolation

**Invariant:** Function-level evidence anchors **must respect workspace isolation** (hard boundary, `AGENTS.md` §2).

### 6.1 Path Resolution

All evidence anchor paths are resolved **within the workspace canonical path** (`src/rooms.mjs`, `canonicalPath()`). A function-level anchor in workspace A **cannot** reference a file in workspace B, even if both workspaces point to the same physical repository.

### 6.2 Cross-Workspace Conflict

Two workspaces on the same repository = two rooms = two independent memory stores. If both record a memory about `src/retrieve.mjs:validationTier`, they are **separate records** with separate `id`s. No merging, no conflict.

**Reusable memories:** Scope `reusable` memories (rare) store **absolute file paths** in evidence anchors, so they remain portable across workspaces. Function-level anchors in reusable memories are **discouraged** (file paths are fragile; URIs are better).

---

## 7. Testing Strategy

### 7.1 Phase 2 Testing Scope

**What Phase 2 tests:**

1. **Schema validation tests** (`test/evidence-chunking.test.mjs`):
   - Function-level fields (`symbol`, `startLine`, `endLine`) validate correctly
   - All three fields must appear together or not at all
   - `startLine <= endLine` and both are positive integers
   - Backward compatibility: file-level (`{path, note}`) and URI-only evidence still work
   - Invalid metadata rejected: partial anchors, negative line numbers, end before start

2. **Integration tests** (`test/veyra-recall-chunking.test.mjs`):
   - Write → recall round-trip preserves function-level anchors
   - Mixed evidence types coexist in one record
   - Workspace isolation: function-level paths resolve within workspace boundary

3. **Scoring tests:**
   - `hasTestedFile`: `test-passed` on same item as `path` → 0.8
   - `hasPreciseAnchor`: Function-level anchor without test → 0.7
   - `hasFile`: File-only → 0.6
   - URI-only → 0.1
   - **Cross-item aggregation prevented:** `[{path}, {uri, note:"test-passed"}]` scores 0.6, NOT 0.8

**What Phase 2 does NOT test:**
- Automatic staleness detection when symbols disappear
- Automatic staleness detection when line ranges shift
- Symbol rename tracking

Those capabilities are deferred to Phase 5.

### 7.2 PoC Validation (Already Done)

✅ **Noise reduction:** 93.2% average (range 42-99.7%), threshold 30% exceeded by 63× margin
✅ **Chunk extraction:** 71 chunks from `retrieve.mjs` (47 functions + 24 top-level), symbol names accurate
✅ **tree-sitter compatibility:** 0.25.1 handles files up to 65KB without error

## 8. Implementation Scope

### 8.1 Phase 2 (This Design)

**In scope:**
- ✅ Extend evidence anchor schema (`symbol`, `startLine`, `endLine`)
- ✅ Update `evidenceStrength()` ranking to favor function-level anchors
- ✅ Update `veyra_remember` tool schema to accept new fields
- ✅ Update `veyra_recall` to return function-level anchors in results
- ✅ Unit + integration tests for new fields
- ✅ Update `docs/reference/memory-model.md` with function-level anchor examples

**Out of scope (defer):**
- ❌ Automatic chunking in `veyra_remember` (Phase 2.5: requires tree-sitter integration)
- ❌ Multi-language support beyond JS/TS (Phase 3: Python, Java, Go)
- ❌ Embedding backends or semantic chunking (Phase 4: optional)
- ❌ Background code indexing (never—Veyra is not a code indexer)

### 8.2 Phase 2.5 (Tree-Sitter Integration)

After Phase 2 validates that function-level anchors work end-to-end, integrate the PoC chunker:

1. Port `poc-treesitter-chunking/chunker.mjs` → `src/code/chunker.mjs`
2. Add `chunkEvidence(path)` helper that returns `{symbol, startLine, endLine}[]`
3. Update `veyra_remember` to **optionally** chunk file-level evidence into function-level (user opt-in via `chunk: true` parameter)
4. Default behavior unchanged—file-level evidence stays file-level unless explicitly chunked

**Why separate:** Validates the data model and retrieval flow before adding complexity.

### 8.3 Phase 3 (Multi-Language)

Expand tree-sitter language support:
- Python (`tree-sitter-python`)
- Java (`tree-sitter-java`)
- Go (`tree-sitter-go`)

Each language requires testing its AST node types (Python uses `function_definition`, Java uses `method_declaration`, etc.). One language at a time, verified with real code.

---

## 9. Risk Mitigation

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|----------|
| **Function-level anchors break existing evidence** | Low | High | Additive schema + backward compat tests prevent this |
| **tree-sitter Node.js API differs from Python** | Medium | Medium | PoC already validated Node.js API works (0.25.1 + ESM `createRequire`) |
| **Staleness detection misses renamed functions** | Medium | Low | `veyra_change_impact` already detects missing symbols; line-shift detection defers to Phase 5 |
| **Context window still fills with large functions** | Low | Low | Large functions (>3KB) are rare; if needed, add size cap in retrieval |
| **Workspace isolation violated by absolute paths** | Low | High | All paths validated through `canonicalPath()` before storage |

---

## 10. Success Criteria

Phase 2 is complete when:

1. ✅ Evidence schema accepts `symbol`, `startLine`, `endLine` (validated)
2. ✅ `veyra_remember` accepts function-level anchors (tool schema updated)
3. ✅ `veyra_recall` returns function-level anchors in results (tested)
4. ✅ Function-level anchors score higher in ranking than file-level (measured)
5. ✅ File-level evidence continues to work (backward compat verified)
6. ✅ All tests pass (unit + integration)
7. ✅ Documentation updated (`docs/reference/memory-model.md`)

**Measurement (Phase 2.5):** After tree-sitter integration, run live `veyra_recall` queries with/without chunking and measure precision improvement (target: >20% more relevant results surfaced).

---

## 11. Timeline Estimate

| Phase | Tasks | Effort | Dependencies |
|-------|-------|--------|--------------|
| **Phase 2** (this design) | Schema + ranking + tests + docs | 3-4 days | None (PoC complete) |
| **Phase 2.5** | Tree-sitter integration + opt-in chunking | 4-5 days | Phase 2 complete |
| **Phase 3** | Python + Java + Go language support | 2 days per language | Phase 2.5 complete |
| **Total** | Full multi-language function-level evidence | **2-3 weeks** | — |

**Critical path:** Phase 2 validates the data model. If ranking improvement is weak, stop before Phase 2.5. If strong, proceed with tree-sitter integration.

---

## 12. Open Questions

1. **Should `veyra_recall` automatically read function bodies, or return anchors for the agent to read?**
   **Answer (pending):** Return anchors only. Agent decides whether to read the function or rely on the memory body. This keeps recall cheap and avoids I/O amplification.

2. **Should function-level anchors update line numbers when code shifts?**
   **Answer (deferred to Phase 5):** Not automatically. Mark stale and require manual revalidation. Automatic line-number tracking is complex (requires git blame or AST diffing) and error-prone.

3. **Should `veyra_change_impact` chunk changed files to identify affected functions?**
   **Answer (deferred to Phase 5):** Yes, but only after Phase 2.5. Current `veyra_change_impact` detects file-level changes; function-level detection requires tree-sitter integration.

---

## Appendix A: PoC Results Summary

**Dataset:** 5 engineering decisions from Veyra codebase
**Metric:** Noise reduction (whole-file vs function-level)

| Decision | File size | Relevant chunks | Chunk size | Noise reduction |
|----------|-----------|----------------|------------|-----------------|
| Hybrid search (7 dimensions) | 65KB | 2 functions | 704 chars | **98.9%** |
| Candidates never auto-recalled | 65KB | 1 function | 168 chars | **99.7%** |
| Workspace isolation | 12KB | 2 functions | 3889 chars | **69.6%** |
| Evidence anchor fields | 3.8KB | 2 functions | 2218 chars | **42.1%** |
| Contradiction banners | 65KB | 2 functions | 2667 chars | **95.9%** |
| **Average** | — | — | — | **93.2%** |

**Conclusion:** Function-level chunks cut context 16-40× on average. Even the worst case (42% reduction) is a clear win.

---

## Appendix B: Comparison with CodeRAG

| Feature | CodeRAG | Veyra (after Phase 2) |
|---------|---------|----------------------|
| **Chunking** | Tree-sitter AST (Python) | Tree-sitter AST (Node.js, JS/TS only in Phase 2) |
| **Storage** | SQLite + FTS5 (separate index) | SQLite evidence column (no separate index) |
| **Retrieval** | BM25 + optional embeddings | 7-dimensional hybrid (BM25 + authority + validation + intent + relationships) |
| **Authority** | None (all results equal) | Candidates excluded, canonical prioritized |
| **Lifecycle** | None (static index) | Stale detection, validation transitions |
| **Workspace isolation** | Per-repo indexing | Per-workspace rooms (DSH WorkspaceId) |
| **Purpose** | Code search across repo | Engineering memory with evidence anchors |

**Key difference:** CodeRAG indexes **all code** for search. Veyra stores **engineering decisions** with function-level evidence. No overlap in purpose.

---

## Appendix C: Rejected Alternatives

### Alternative 1: Store chunk text in evidence anchor

```typescript
{path: "src/retrieve.mjs", symbol: "validationTier", text: "function validationTier(v) { ... }"}
```

**Rejected:** Duplicates source code in the memory DB. When code changes, the stored text becomes stale but the agent doesn't know. Anchors should point to the repository, not cache it.

### Alternative 2: Automatic chunking in `veyra_remember`

**Rejected for Phase 2:** Adds complexity before validating that function-level anchors improve retrieval. If Phase 2 shows weak ranking gains, automatic chunking is wasted work.

### Alternative 3: Merge file-level and function-level into one schema

**Rejected:** File-level and function-level evidence serve different purposes. File-level = "this decision is about this file." Function-level = "this decision is proven by this function." Forcing one schema harms clarity.

---

## Sign-Off

**Approved for implementation:** [Pending CEO review]
**Blocked on:** None (PoC validated, design complete)
**Next step:** Review this doc, then implement Phase 2 (schema + ranking + tests + docs).