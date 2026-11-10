# P3 Current-State Review — Write-Gate Observability

**Status:** CEO-approved review (P3), research/documentation only. No production or test code changes.  
**Date (source context):** 2026-11-07 (Asia/Singapore)  
**Scope:** Existing Veyra write-gate decisions (ACCEPT / MERGE / DROP / DEFER), observability, audit sufficiency, MERGE reinforcement effects, and reuse opportunities. Evidence is from repository source and tests as read; no tests executed, no runtime experiments.

## 1. Sources inspected

| Area | Files / tests |
|---|---|
| Write gate | `src/learn.mjs` (682 lines) — `WRITE_GATES`, `learningGuards`, `gateOnce`, `writeGate`, `maybeLearn`, `recordWriteGateVerdict`, `readWriteGateLedger`, `strengthenMemory`, `provenanceAllowsLearning`, `remember`, `promote` |
| Contradiction audit | `src/audit.mjs` (248 lines) — `auditContradictionEdges` (Issue #3 Phase C, `contradicts` edges only) |
| Memory health | `src/health.mjs` (258 lines) — `memoryHealth` / `memoryHealthReport`, consumes `readWriteGateLedger` via optional `writeGate` |
| Write-gate behavior | `test/m1-write-gate.test.mjs` |
| Ledger behavior / health surfacing | `test/write-gate-ledger.test.mjs` |

Related modules noted (not fully re-traced in this pass): `src/store.mjs` meta KV (`setMeta`/`getMeta`) used by ledger; `src/evolve.mjs` (`evolveAgainst`, relation candidates) feeding MERGE/DEFER; `src/negative.mjs` (`addRejected`/`addUnresolved`); `src/types.mjs` authority/eligibility; `src/observatory.mjs` (general observability surface, not read here).

## 2. Existing write-gate decisions (verified)

### 2.1 Decision set and recording

| Decision | Where produced | Recorded on persisted memory record | Recorded in ledger/meta | Queryable today |
|---|---|---|---|---|
| `ACCEPT` | `gateOnce` in `src/learn.mjs` creates derived record with `source.writeGate:{decision:ACCEPT,reason:'new-derived-knowledge'}` | **Yes** (`source.writeGate` on accepted record) | **Yes** (count/reason/recent ring via `recordWriteGateVerdict`) | Record: via store/inspect paths that expose `source` (implementation-dependent). Ledger: via `readWriteGateLedger` / `veyra_health` write-gate section |
| `MERGE` | `gateOnce` merge branch sets `neighborRecord.source.writeGate={decision,reason}` (reason from evolve verdict, default `updated-existing-memory`), calls `strengthenMemory`, `store.put(neighborRecord, {explicitCanonical: neighbor.authority===AUTHORITIES.CANONICAL})` | **Yes, on neighbor** (overwrites neighbor `source.writeGate` with latest merge verdict) | **Yes** | Neighbor record’s latest `source.writeGate`; ledger aggregate/recent |
| `DROP` | Guards (`no-record`, non-durable), verbatim hash duplicate (`verbatim-duplicate`), evolve may produce DROP in edge cases | **No record persisted** (by design) | **Yes** | Ledger aggregate/recent only |
| `DEFER` | Guards (`provenance-gated`, `context-provenance-no-test-evidence`, `canonical-requires-explicit-promotion`), evolve defer | **No record persisted** | **Yes** | Ledger aggregate/recent only |

**Evidence:** `src/learn.mjs` exports/uses `WRITE_GATES`; `gateOnce` branches; `writeGate` wraps `gateOnce` + `recordWriteGateVerdict`; tests in `test/m1-write-gate.test.mjs` and `test/write-gate-ledger.test.mjs`.

### 2.2 Ledger implementation

- **Storage:** existing meta KV — `store.setMeta(WRITE_GATE_LEDGER_KEY, ...)` / `store.getMeta(...)`. No new table/schema in `learn.mjs`.
- **Shape (normalized):** `total`, `decisions.{ACCEPT,MERGE,DROP,DEFER}`, `reasons` (bounded map, `LEDGER_REASON_LIMIT=24`), `recent` (bounded ring, `LEDGER_RECENT_LIMIT=8`, entries `{decision, reason, at}`), `updatedAt`.
- **Privacy/content:** records decision + reason only, never candidate content (`recordWriteGateVerdict` comment and implementation).
- **Robustness:** best-effort, never throws; `readWriteGateLedger` returns `null` for missing/corrupt/non-object; `test/write-gate-ledger.test.mjs` covers corrupt ledger and setMeta throw.
- **Scope:** per store/project ledger isolation (`test/write-gate-ledger.test.mjs`).

### 2.3 Reasons observed in code/tests

| Reason | Decision | Source |
|---|---|---|
| `no-record` | DROP | `learningGuards` |
| `provenance-gated` | DEFER | `learningGuards` |
| `context-provenance-no-test-evidence` | DEFER | `learningGuards` |
| `canonical-requires-explicit-promotion` | DEFER | `learningGuards` |
| `not-durable` | DROP | `learningGuards` |
| `verbatim-duplicate` | DROP | `gateOnce` |
| `new-derived-knowledge` | ACCEPT | `gateOnce` |
| `updated-existing-memory` (default) / evolve-supplied reason | MERGE/DEFER/DROP | `gateOnce` merge/defer handling |

Exact evolve reasons depend on `src/evolve.mjs` verdicts (not exhaustively enumerated here).

## 3. Queryability assessment

| Question | Current state | Evidence / limitation |
|---|---|---|
| Are decisions recorded? | **Partially yes.** ACCEPT/MERGE recorded on records; all four recorded as aggregates/reasons/recent in ledger. | `learn.mjs`, ledger tests. |
| Are reasons queryable? | **Yes, in aggregate/recent form** per store via ledger/health. **Not** as a complete historical per-decision log. | Ledger keeps bounded reasons/recent; no append-only decision journal found. |
| Are evidence references queryable for each decision? | **Not for gate decisions.** Ledger intentionally stores no content/evidence refs. Persisted records may carry evidence (`evidence[]`, `source`), but DROP/DEFER produce no record and MERGE only updates neighbor `source.writeGate`. | `recordWriteGateVerdict` stores decision/reason/at only. |
| Is audit sufficient to explain each decision? | **No for full per-decision explainability.** Sufficient for aggregate observability and recent decision/reason samples; insufficient for reconstructing “why this specific candidate was dropped/deferred/merged” after recent ring eviction or when evidence/candidate identity is needed. | Bounded `reasons`/`recent`; no candidate hash/id/content pointer in ledger. |
| Is contradiction audit a write-gate audit? | **No.** `src/audit.mjs` audits historical `contradicts` edges only; read-only, bounded, explicitly notes missing relation provenance. | `audit.mjs` header and behavior. |

## 4. MERGE reinforcement — verified behavior and authority/confidence/validation effects

### 4.1 What MERGE does

In `gateOnce` (`src/learn.mjs`): when `evolveAgainst` returns merge, Veyra sets `neighborRecord.source.writeGate={decision:MERGE, reason: verdict.reason||'updated-existing-memory'}`, calls `strengthenMemory(neighborRecord, candidate, {workspace})`, persists neighbor with `store.put(neighborRecord, {explicitCanonical: neighbor.authority===AUTHORITIES.CANONICAL})`, and returns `{record:neighborRecord, verdict:MERGE,...}`. **No second record is created.**

### 4.2 `strengthenMemory` effects (verified)

| Field/aspect | Effect | Authority impact |
|---|---|---|
| Observations | Increments `observations` count | No |
| Relations/tags | Carries/merges relations and tags (subject to function logic) | No |
| Causal | Merges causal fields (implementation in `strengthenMemory`) | No |
| Validation | Progression: `unverified/stale → reviewed` after `obs>=2`; `reviewed → verified` after `obs>=3 + hasPassedTest`; narrative-only non-unverified may be downgraded to `unverified` (guarded) | No |
| Confidence | `verified → HIGH`; `reviewed + LOW → MEDIUM`; otherwise preserved by existing rules | No |
| Authority | **Never changed** (`strengthenMemory` never changes authority; MERGE persists with `explicitCanonical` only when neighbor already canonical) | **None** |

**Evidence:** `src/learn.mjs` `strengthenMemory` and MERGE branch; `test/m1-write-gate.test.mjs` “MERGE strengthens the existing record without creating a second one”.

### 4.3 Canonical safety

MERGE can update an existing canonical neighbor’s content/observations/validation/confidence only through the code paths above; it does **not** auto-promote to canonical (`assertAuthorityTransition`/types guard canonical transitions; `promote` requires explicit). Persisting an already-canonical neighbor uses `explicitCanonical` flag consistent with its current authority.

## 5. Existing modules to reuse (P3)

| Need | Reuse | Do not duplicate |
|---|---|---|
| Gate decisions | `WRITE_GATES`, `learningGuards`, `gateOnce`, `writeGate`, `maybeLearn` in `src/learn.mjs` | Do not add a parallel gate engine |
| Aggregate ledger | `recordWriteGateVerdict` / `readWriteGateLedger` / `WRITE_GATE_LEDGER_KEY` meta KV | Do not create duplicate aggregate storage or second ledger unless evidence shows meta KV cannot meet a bounded, privacy-safe requirement |
| Health surfacing | `src/health.mjs` write-gate section and `readWriteGateLedger` consumption | Do not add separate health counters for the same facts |
| Write-gate tests | `test/m1-write-gate.test.mjs`, `test/write-gate-ledger.test.mjs` | Extend patterns, don’t fork behavior |
| Contradiction audit | `src/audit.mjs` for `contradicts` edges only | Do not overload contradiction audit with write-gate per-decision logs |
| Store meta | `src/store.mjs` meta KV (used by ledger) | Avoid schema changes unless justified |

## 6. Gaps (evidence-backed)

1. **Per-decision explainability is bounded/lossy.** DROP/DEFER have no persisted record; ledger recent ring is bounded (`LEDGER_RECENT_LIMIT=8`) and reasons bounded (`LEDGER_REASON_LIMIT=24`). After eviction, a specific past decision cannot be reconstructed.
2. **No evidence references in gate ledger.** Ledger stores decision/reason/at only (intentional privacy choice). This prevents explaining decisions with evidence pointers from the ledger alone.
3. **No stable decision identity/correlation.** Recent entries lack candidate fingerprint/id linkage (beyond implicit timing), making correlation to tool events/records difficult.
4. **MERGE observability is “latest verdict on neighbor” + aggregate.** Neighbor `source.writeGate` reflects latest merge; prior merge history on that neighbor is not an explicit append-only chain in the reviewed code.
5. **Aggregate-only health view is not a per-decision timeline.** `veyra_health` surfaces totals/reasons/recent, which is useful but not sufficient for debugging a specific rejected candidate.

## 7. Non-gaps / guardrails to preserve

- Write gates remain the source of decisions; no weakening.
- DROP/DEFER do not create durable records.
- MERGE does not create a second record and does not change authority.
- Candidate content is not stored in the existing ledger (privacy/redaction posture).
- Best-effort ledger recording must not break learning (`recordWriteGateVerdict` never throws).

## 8. Conclusion

Veyra already has **basic write-gate observability**: decisions are emitted, ACCEPT/MERGE verdicts are attached to persisted records (`source.writeGate`), and a bounded privacy-safe ledger is stored in meta KV and surfaced in health. **Genuine gaps** are in *per-decision, queryable, bounded explainability* (especially for DROP/DEFER and historical correlation) without duplicating storage or storing raw sensitive content. P3 implementation PRD should target only those evidence-backed gaps with minimal, append/bounded design and explicit privacy limits.
