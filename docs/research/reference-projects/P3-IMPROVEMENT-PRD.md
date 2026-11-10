# P3 Product Improvement PRD — Write-Gate Observability (Evidence-Backed Gaps Only)

**Status:** Draft for CEO approval. **No implementation authorized.**  
**Depends on:** [P3-CURRENT-STATE-REVIEW.md](./P3-CURRENT-STATE-REVIEW.md)  
**Scope:** Minimal, evidence-backed improvements to write-gate explainability while reusing existing gate/ledger/health mechanisms. Research/documentation only in this phase.

## 1. Problem statement and evidence

Veyra already enforces and partially observes write gates (`ACCEPT|MERGE|DROP|DEFER`) in `src/learn.mjs`, records a bounded privacy-safe aggregate ledger in store meta KV (`recordWriteGateVerdict`/`readWriteGateLedger`), attaches `source.writeGate` to persisted ACCEPT/MERGE records, and surfaces ledger totals/reasons/recent in `src/health.mjs`. Tests `test/m1-write-gate.test.mjs` and `test/write-gate-ledger.test.mjs` cover decisions, invariants, ledger bounds, isolation, corrupt handling, and health surfacing.

**Evidence-backed gap:** per-decision explainability is insufficient for operators/debuggers after bounded ring eviction and for non-persisted decisions. The ledger stores decision/reason/at only (no candidate identity, no evidence references, no complete history). DROP/DEFER create no durable memory record. MERGE leaves only the latest `source.writeGate` on the neighbor plus aggregate counts. This is a genuine observability gap, not a request to change gate outcomes.

## 2. Existing capabilities to reuse

- Gate engine and verdicts: `WRITE_GATES`, `learningGuards`, `gateOnce`, `writeGate`, `maybeLearn`, `provenanceAllowsLearning`, `strengthenMemory` (`src/learn.mjs`).
- Aggregate ledger: `WRITE_GATE_LEDGER_KEY`, `recordWriteGateVerdict`, `readWriteGateLedger`, `LEDGER_REASON_LIMIT`, `LEDGER_RECENT_LIMIT` (`src/learn.mjs`) over existing store meta KV.
- Health surfacing: `memoryHealth`/report consumption of write-gate ledger (`src/health.mjs`).
- Existing tests and patterns: `test/m1-write-gate.test.mjs`, `test/write-gate-ledger.test.mjs`.
- Existing contradiction audit remains separate: `src/audit.mjs` (do not repurpose).

## 3. Exact proposed scope (minimal)

### In scope (if CEO approves implementation later)

1. **Bounded decision-explainability records (metadata only, append/bounded):** extend write-gate observability to retain a bounded, queryable history of gate decisions per store without storing candidate content. Each entry should include at minimum: decision, reason, timestamp, store scope marker, and a non-sensitive correlation key derived from already-available safe identifiers (e.g. candidate/content hash if already computed, target record id for ACCEPT/MERGE where known, evolve/guard source tag). **No raw prompt text, no raw user text, no full evidence payloads, no secrets.**
2. **Optional bounded evidence reference summary:** where safe and already available, record counts/types of evidence anchors (e.g. path count, presence of `test-passed`/`test-failed`, provenance-origin class already present) — not raw evidence values/URIs/paths beyond counts/classes unless an explicit privacy review approves. Default posture: metadata-only.
3. **Read/query surface reuse:** expose bounded decision history through existing health/tooling surfaces where appropriate (e.g. extend write-gate health payload or add a narrowly scoped read-only query path) rather than creating a second unrelated observability UI/store. Exact surface to be chosen during implementation design, constrained by existing DSH/Veyra tool patterns.
4. **MERGE reinforcement visibility (minimal):** make MERGE effects observable as metadata already implied by `strengthenMemory`/record state (e.g. previous→new observations/validation/confidence snapshot in the bounded decision entry, if cheap and safe) without changing reinforcement behavior.

### Out of scope

- Changing ACCEPT/MERGE/DROP/DEFER outcomes, thresholds, guards, provenance rules, or authority transitions.
- Auto-promotion, auto-canonicalization, or weakening `assertAuthorityTransition`.
- Persisting candidate body/title/raw evidence for DROP/DEFER decisions.
- A full append-only unbounded audit log.
- Duplicating the existing aggregate ledger; extend/reuse it or add one bounded companion structure only if justified.
- Reworking `src/audit.mjs` contradicts-edge audit.
- Runtime experiments, benchmarks, DSH Web/Profile/runtime changes.

## 4. Data/event model (proposed shape, minimal)

*Illustrative only; final schema to fit existing store/meta conventions and privacy review.*

```json
{
  "kind": "veyra.write_gate.decision",
  "at": "<iso8601>",
  "decision": "ACCEPT|MERGE|DROP|DEFER",
  "reason": "<bounded reason code>",
  "source": "learn.writeGate",
  "scope": "project|reusable",
  "candidateHash": "<optional, if already computed>",
  "targetRecordId": "<optional, ACCEPT/MERGE>",
  "guards": ["<optional guard tags>"],
  "evidenceSummary": {"pathCount": 0, "hasTestPass": false, "hasTestFail": false},
  "mergeEffect": {"observationsBefore": 0, "observationsAfter": 0, "validationBefore": "", "validationAfter": "", "confidenceBefore": "", "confidenceAfter": ""}
}
```

**Bounds:** fixed max entries (ring buffer), fixed max reason/field sizes, deterministic eviction (oldest first). No content fields.

## 5. Privacy and security constraints

- Never store candidate text, user prompts, raw tool output, secrets, or full evidence paths/URIs in decision history by default.
- Preserve existing redaction posture; observability must not create a bypass around `src/redact.mjs` expectations.
- Bounded retention; no unbounded growth.
- Best-effort recording: observability failures must not block or change learning decisions.
- Project isolation preserved (per-store/project data only).

## 6. Affected modules (if implemented later)

| Module | Expected change type | Notes |
|---|---|---|
| `src/learn.mjs` | Primary | Emit bounded decision metadata; reuse `recordWriteGateVerdict`/`writeGate`; keep gate semantics unchanged. |
| `src/store.mjs` and/or meta conventions | Possible small | Only if bounded history needs a dedicated meta key/helper; prefer existing meta KV patterns. |
| `src/health.mjs` | Small read-only | Surface bounded decision history summary/counts if added; keep read-only. |
| `src/tools.mjs` / observatory path | Possible small read-only | Only if an explicit query tool/surface is approved; avoid duplicate audit stores. |
| Tests: `test/m1-write-gate.test.mjs`, `test/write-gate-ledger.test.mjs`, new focused tests | Add/extend | Verify bounds, privacy (no content), MERGE metadata, non-interference, corrupt handling. |

## 7. Test and verification strategy (for future implementation)

- Unit tests: decision entry shape, bounds/eviction, per-store isolation, corrupt/missing data returns safe defaults.
- Invariant tests: DROP/DEFER still produce no memory records; MERGE still produces no second record and no authority change; ACCEPT still derived/non-canonical by default.
- Privacy tests: assert no candidate body/title/raw evidence strings in persisted decision history fixtures.
- Failure-injection tests: history/ledger write errors do not change gate verdict or throw through learning path.
- Health/tool read tests: bounded history surfaced read-only; empty/corrupt history handled.
- Regression: existing `m1-write-gate` and `write-gate-ledger` tests remain green.

## 8. Acceptance criteria

1. For each gate evaluation, a bounded metadata decision entry is queryable (within retention) with decision, reason, timestamp, and safe correlation fields; no raw content stored.
2. DROP/DEFER/ACCEPT/MERGE gate outcomes and invariants are unchanged from current behavior.
3. MERGE reinforcement behavior is unchanged; MERGE decision observability can explain that reinforcement occurred (metadata-level).
4. Aggregate ledger and health reporting continue to work; no duplicate aggregate source of truth.
5. Observability failures are best-effort and non-blocking.
6. Project isolation and redaction/privacy constraints hold.

## 9. Rollout considerations

- Backward-compatible: missing history/ledger data returns empty/null-safe structures.
- Keep bounded sizes conservative to avoid meta/storage bloat.
- If exposed via tools/UI, mark as diagnostic/observability data, not memory truth.
- No DSH runtime/profile changes required by design; stays inside Veyra storage/read surfaces.

## 10. Explicit non-goals

- Not a full audit/compliance log.
- Not a user-facing explanation of model reasoning beyond gate metadata.
- Not changing learning quality heuristics or contradiction handling.
- Not introducing external telemetry.

## 11. Risks and unresolved questions

| Risk / question | Notes |
|---|---|
| Meta KV size/growth | Needs bounded ring and size caps; confirm `store.mjs` meta behavior for larger values if history is stored as one blob. |
| Candidate correlation key safety | Hash/fingerprint must not enable content recovery; use existing computed hash where already safe. |
| Evidence path leakage | Raw paths/URIs may be sensitive; prefer counts/classes unless explicitly approved. |
| MERGE before/after snapshot cost | Keep cheap; may record only selected scalar fields. |
| Query surface choice | Health-only vs dedicated read tool vs observatory endpoint — pick smallest surface that fits existing patterns. |
| Evolve reason taxonomy | `src/evolve.mjs` reasons should be stable/bounded for observability; confirm during implementation. |

## 12. Recommendation

**Ready for CEO approval in principle, implementation design needed.** The gap is evidence-backed and narrow. Approve only a minimal metadata-only, bounded, best-effort observability extension that reuses `learn.mjs`/ledger/health and preserves all write-gate invariants.
