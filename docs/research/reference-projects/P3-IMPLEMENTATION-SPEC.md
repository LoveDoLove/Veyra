# P3 Implementation Specification — Write-Gate Observability (Final, Implementation-Ready)

**Status:** Final specification for CEO implementation authorization. **No implementation authorized by this document.**  
**Date (source context):** 2026-11-07 (Asia/Singapore)  
**Scope:** Minimal, evidence-backed traceability for `ACCEPT|MERGE|DROP|DEFER` write-gate decisions. Reuses existing write-gate engine, aggregate ledger, and health surfaces. Does **not** weaken gates, duplicate aggregate storage, or persist sensitive candidate content.

## 1. Evidence baseline (reuse, do not replace)

| Capability | Current implementation | Reuse rule |
|---|---|---|
| Gate decisions | `src/learn.mjs`: `WRITE_GATES`, `learningGuards`, `gateOnce`, `writeGate`, `maybeLearn` | Keep as sole decision authority. No parallel gate path. |
| Aggregate ledger | `src/learn.mjs`: `WRITE_GATE_LEDGER_KEY='write_gate_ledger'`, `recordWriteGateVerdict`, `readWriteGateLedger`, meta KV via `store.setMeta`/`getMeta` | Keep as aggregate source of truth for totals/reasons/recent counts. Extend in place; do not create a second aggregate ledger. |
| Health surfacing | `src/health.mjs`: consumes `readWriteGateLedger` as `writeGate` accounting (not memory-quality finding) | Reuse existing write-gate section; add bounded trace summary only as additive read-only fields. |
| MERGE reinforcement | `src/learn.mjs`: `strengthenMemory`, merge branch persists neighbor with `explicitCanonical` only when already canonical; no second record; no authority change | Preserve behavior exactly. Observability records before/after metadata only. |
| Tests/patterns | `test/m1-write-gate.test.mjs`, `test/write-gate-ledger.test.mjs` | Extend; do not fork semantics. |

## 2. Problem and minimum additional metadata

**Gap:** aggregate ledger gives totals/reasons/recent samples, but cannot reliably explain a specific decision after ring eviction, cannot correlate decisions safely, and stores no evidence-reference summary or MERGE before/after trace.

**Minimum additional metadata (per decision trace entry):**
- Identity/correlation (safe): `traceId` (bounded unique per store, monotonic/ULID-like local sequence acceptable), `at` (ISO8601), `decision`, `reason` (bounded code), `scope` (`project|reusable`), `source` (`learn.writeGate`).
- Candidate correlation (safe): `candidateHash` (reuse hash already computed by `learningGuards`/`gateOnce` when available; omit if unavailable) — **not raw content**. Optional `candidateKind`/`candidateAuthority` class only if already on candidate (bounded enum/class, no text).
- Target correlation: `targetRecordId` for ACCEPT/MERGE when known; `existingRecordId` for verbatim-duplicate/drop cases when known and safe; omit otherwise.
- Guard/provenance class summary (no raw values): `guard` or `reasonSource` tag (bounded), `provenanceClass` (`automatic|explicit|user-context-only|unknown` derived from existing candidate/source flags), `evidenceSummary` counts/classes only.
- MERGE before/after (MERGE only): bounded scalar snapshot `{observationsBefore, observationsAfter, validationBefore, validationAfter, confidenceBefore, confidenceAfter, authority}`. Authority included to prove it did not change.

**Explicitly excluded:** candidate title/body, user/assistant/tool text, raw evidence paths/URIs/notes, secrets, full relation arrays, unbounded stacks.

## 3. Safe decision correlation

- **Primary key:** `traceId` (store-local, bounded namespace). Example format: `wgt_<storeScope>_<base36Counter>` or equivalent deterministic bounded form generated without randomness requirements.
- **Secondary correlation:** `candidateHash` (existing content hash) + `targetRecordId` + `at`. Hash is correlation-only; do not store preimage.
- **No cross-sensitive joins:** do not store session transcript IDs, raw prompt IDs, or external user identifiers unless an existing Veyra-safe identifier is already present and approved; default omit.
- **Deduplication view:** same `candidateHash` + same `decision`/`reason` near-term may appear multiple times (truthful); consumers must not assume uniqueness except `traceId`.

## 4. Data/event schema (minimal)

### 4.1 Decision trace entry (new bounded companion, metadata only)

Stored under meta key `write_gate_trace_v1` (companion to existing `write_gate_ledger`; **not** a duplicate aggregate ledger).

```json
{
  "v": 1,
  "updatedAt": "2026-11-07T09:30:00.000Z",
  "nextSeq": 42,
  "entries": [
    {
      "traceId": "wgt_p_00002a",
      "at": "2026-11-07T09:29:58.000Z",
      "decision": "MERGE",
      "reason": "updated-existing-memory",
      "source": "learn.writeGate",
      "scope": "project",
      "candidateHash": "<existing hash or omitted>",
      "candidateClass": {"kind": "memory", "authority": "candidate"},
      "targetRecordId": "vey_...",
      "provenanceClass": "automatic",
      "evidenceSummary": {
        "anchorCount": 2,
        "hasPathAnchor": true,
        "hasTestPass": true,
        "hasTestFail": false
      },
      "mergeEffect": {
        "observationsBefore": 2,
        "observationsAfter": 3,
        "validationBefore": "reviewed",
        "validationAfter": "verified",
        "confidenceBefore": "medium",
        "confidenceAfter": "high",
        "authority": "derived"
      }
    }
  ]
}
```

**Field rules:**
- `decision` enum: `ACCEPT|MERGE|DROP|DEFER`.
- `reason` max 64 chars, normalized code string.
- `scope` enum: `project|reusable`.
- `candidateHash` optional string max 128.
- `candidateClass` optional bounded enums; no text.
- `evidenceSummary` counts/booleans only; never paths/URIs/notes.
- `mergeEffect` present only for `MERGE`; all scalar/bounded.
- Unknown/extra fields ignored on read (forward-safe).

### 4.2 Aggregate ledger (existing, unchanged source of truth)

`write_gate_ledger` remains: `total`, `decisions`, bounded `reasons`, bounded `recent`, `updatedAt`. Continue writing it on every verdict as today. Trace companion is additive detail; if trace write fails, aggregate ledger still attempts/behaves per existing best-effort rules.

## 5. Bounded retention and storage behavior

| Parameter | Default | Hard cap / behavior |
|---|---|---|
| Trace entries per store | 64 | Max 128; oldest evicted first (ring) |
| `reason` length | <=64 | truncate/normalize deterministically |
| `evidenceSummary` keys | fixed set | ignore unknown keys |
| `nextSeq` | monotonic integer | wrap-safe formatting not required initially; if numeric overflow risk, reset sequence with new prefix while preserving ring order (implementation detail) |
| Storage location | store meta KV | `write_gate_trace_v1` per project/reusable store, same isolation as existing ledger |
| Write path | best-effort | never throws into gate decision path; failure to record trace/ledger must not change ACCEPT/MERGE/DROP/DEFER verdict |
| Read path | tolerant | missing/corrupt/non-object/invalid entries => return safe empty/filtered structure, never throw; do not affect memory health scan correctness except additive reporting |

**Size guard:** before `setMeta`, serialize and enforce max serialized bytes (suggested 32 KiB hard cap for trace blob); if exceeded, evict oldest until under cap. This prevents meta bloat.

## 6. Module-level change scope

| Module | Change | Rationale |
|---|---|---|
| `src/learn.mjs` | Add `WRITE_GATE_TRACE_KEY`, trace normalization/append/read helpers; extend `recordWriteGateVerdict` (or companion `recordWriteGateTrace`) to capture safe metadata from verdict/candidate/hash/target/merge before-after; keep `writeGate` verdict semantics identical. Reuse existing aggregate ledger call. | Central, single write-gate path. |
| `src/store.mjs` | **No required schema change.** Only if needed: tiny helper reuse for meta get/set patterns; avoid new tables. | Existing meta KV already used. |
| `src/health.mjs` | Add additive read-only `writeGateTrace` summary (e.g. `available`, `count`, `recent` bounded metadata entries or counts by decision) alongside existing `writeGate` ledger. Tolerant of null/corrupt. | Reuse health surface; no mutation. |
| `src/tools.mjs` (or existing observatory read path) | Optional/minimal: expose bounded trace read through an existing read-only diagnostic path only if one already fits (prefer health/observatory pattern). **Do not add a new write path or duplicate audit store.** | Keep surface minimal. |
| `src/audit.mjs` | **No change.** Contradicts-edge audit remains separate. | Avoid scope creep/duplication. |
| `src/observatory.mjs` | Optional read-only integration only if it already surfaces write-gate/health diagnostics; no new persistence. | Reuse related observatory module per order. |
| `test/m1-write-gate.test.mjs` | Regression assertions unchanged outcomes; optional assertions that trace does not affect verdicts. | Protect invariants. |
| `test/write-gate-ledger.test.mjs` | Extend for trace companion: bounds, isolation, corrupt handling, merge metadata, no-content/privacy, best-effort on write failure. | Verify new behavior. |
| New focused test (name per repo convention, e.g. `test/write-gate-trace.test.mjs`) | Deterministic trace behavior. | Isolation/clarity. |

## 7. Deterministic test plan

| ID | Type | Setup | Action | Expected |
|---|---|---|---|---|
| P3-T1 | Unit | Temp stores, known candidate | ACCEPT through `maybeLearn`/`writeGate` | Verdict ACCEPT unchanged; aggregate ledger increments; trace entry has decision/reason/at/traceId/scope/candidateHash?/targetRecordId; no body/title/raw evidence. |
| P3-T2 | Unit | Existing neighbor + evolving candidate | MERGE | Verdict MERGE unchanged; no second record; neighbor authority unchanged; trace has `mergeEffect` with before/after scalars and same authority. |
| P3-T3 | Unit | Non-durable candidate | DROP | No memory record persisted; aggregate+trace record DROP with reason; no content stored. |
| P3-T4 | Unit | Provenance-gated / context-only no test evidence | DEFER | No memory record persisted; trace reason matches guard. |
| P3-T5 | Bounds | > max entries decisions | Read trace | Only newest max retained (or deterministic ring policy), `traceId`s present, size under cap. |
| P3-T6 | Isolation | Project + reusable stores | Decisions in each | Traces/ledgers independent. |
| P3-T7 | Corruption | `setMeta` invalid/corrupt trace blob | Read/append next | `read` returns safe empty/filtered; next append recovers or starts bounded fresh structure; gate verdict unaffected. |
| P3-T8 | Failure injection | `store.setMeta` throws for trace key only / any meta write | Run gate | Verdict returned as normal; no throw escapes; aggregate best-effort behavior consistent with existing pattern. |
| P3-T9 | Privacy | Candidate with title/body/evidence paths | Record trace | Serialized trace contains no title/body/raw path/URI/note/secret values. |
| P3-T10 | Health | Populated trace+ledger | `memoryHealth`/report | Existing `writeGate` ledger present; additive `writeGateTrace` summary present/read-only; no mutation. |
| P3-T11 | Regression | Existing `m1-write-gate` cases | Run relevant tests | All prior invariants pass (DROP no row, MERGE reinforces/no second row, DEFER preserves candidate, provenance gate). |
| P3-T12 | Regression | Existing `write-gate-ledger` cases | Run relevant tests | Aggregate totals/reasons/recent/bounds/isolation/corrupt handling unchanged. |

All tests must be deterministic (fixed timestamps via injectable clock if needed, or assert shape/ranges; no network/runtime experiments).

## 8. Acceptance criteria

1. Every write-gate verdict (ACCEPT/MERGE/DROP/DEFER) produces/attempts a bounded trace entry with safe correlation metadata, without changing the verdict.
2. Existing aggregate `write_gate_ledger` remains the aggregate source of truth and continues to be updated; no duplicate aggregate ledger.
3. DROP/DEFER still persist no memory records; ACCEPT/MERGE record behavior unchanged.
4. MERGE still reinforces neighbor, creates no second record, and never changes authority; trace includes bounded before/after scalars proving authority unchanged.
5. Trace contains no candidate content, raw evidence values, or secrets; bounded retention/size caps enforced.
6. Trace/ledger write failures are best-effort and never break learning.
7. Health (and any reused read-only surface) exposes additive trace observability without mutating stores.

## 9. Non-goals

- Changing gate heuristics, thresholds, provenance rules, or learning outcomes.
- Full append-only compliance audit log or external telemetry.
- Storing DROP/DEFER candidate bodies for later replay.
- Auto-promotion/canonicalization or authority changes.
- Modifying `src/audit.mjs` contradicts-edge audit.
- DSH Web/Profile/runtime, LLM/API, or network behavior.

## 10. Migration and compatibility considerations

- **Backward compatible:** missing `write_gate_trace_v1` => empty trace, normal behavior. Existing `write_gate_ledger` readers unaffected.
- **Forward compatible:** readers ignore unknown trace fields/versions > supported by filtering or version gate (`v!==1` => treat as empty or best-effort parse).
- **No DB schema migration required** if using existing meta KV (consistent with current ledger). If implementation later chooses a table, that requires a separate reviewed migration; not proposed here.
- **Runtime cost:** O(1) append + bounded eviction on gate path; small JSON blob. Acceptable if capped.
- **Rollback:** removing trace reads/writes leaves aggregate ledger intact; no data migration needed.
