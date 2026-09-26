# Veyra command output — demo store

Captured on 2026-09-26 from `@lovedolove/veyra@0.1.20` by running the real
`handleVeyraCommand` handler against a throwaway demo store.

- The four records below are **demo content**, clearly labeled as such — they are not real project knowledge.
- Absolute temp paths are normalized to `~/.dsh/veyra` and `/path/to/your/project`; the project id is masked.
- Regenerate with `node examples/make-demo-output.mjs` (ids and timestamps are pinned; score breakdowns may shift
  slightly as freshness tiers age).

### `/veyra`

```
Veyra project p_0000000000000000
workspace: /path/to/your/project
home: ~/.dsh/veyra
project memories: 4 (derived: 3, canonical: 0, candidate: 1)
health: 1 verified, 1 reviewed
reusable memories: 0

Veyra — Engineering Intelligence for Coding Agents (v0.1.20)

/veyra                                     status for this workspace
/veyra observatory [subcommand]            human knowledge observatory
       observatory overview                aggregate knowledge & health counts
       observatory search <query>          inspect hybrid search signals
       observatory record <id>             deep evidence & provenance inspection
       observatory causality               causal knowledge map (symptom→fix)
       observatory relationships [id]      directed edges (optional filter)
       observatory local <id>              1-hop neighborhood around a record
       observatory graph [id]              local graph if id given, else all edges
       Network Graph WebUI                 /veyra (workspace overview) · /veyra?id=<record> (local graph)
       observatory contradictions          conflicts and opposing claims
/veyra recall [q]                          hybrid search project (+ reusable) memory
/veyra recent                              last 8 memories (including candidates)
/veyra inspect <id>                        deep evidence, provenance & causal inspect
/veyra forget <id>                         soft-forget a record
/veyra promote <id> [derived|canonical]    promote standing (canonical requires user explicit)

Canonical promotion is an explicit user action. Automatic capture
never creates authoritative truth. Memory lives in $DSH_HOME/veyra/.
```

### `/veyra observatory overview`

```
════════════════════════════════════════════════════════════════════════
 VEYRA KNOWLEDGE OBSERVATORY — OVERVIEW
════════════════════════════════════════════════════════════════════════
 Project ID   : p_0000000000000000
 Workspace    : /path/to/your/project
 Veyra Home   : ~/.dsh/veyra
 Total Memory : 4 active (4 total, 0 forgotten)

── Knowledge Kinds (Unified RAG + Memory) ──────────────────────────────
  • Engineering Memory : 2
  • Knowledge / RAG    : 1
  • Evidence Anchors   : 0
  • Observations       : 1

── Authority Standing ──────────────────────────────────────────────────
  • Canonical (User-promoted Truth) : 0
  • Derived   (Learned / Remembered): 3
  • Candidate (Automatic / Raw)     : 1

── Validation & Health ─────────────────────────────────────────────────
  • Verified   (Tests confirmed)    : 1
  • Reviewed   (Inspected)          : 1
  • Unverified (Awaiting proof)     : 2
  • Stale / Invalid                 : 0 stale, 0 invalid

── Structure & Intelligence ────────────────────────────────────────────
  • Causal Knowledge Records        : 1
  • Relationship Edges              : 1
  • Active Contradictions           : 0
════════════════════════════════════════════════════════════════════════
```

### `/veyra observatory search sqlite mutex wal`

```
════════════════════════════════════════════════════════════════════════
 VEYRA OBSERVATORY — HYBRID SEARCH INSPECTION
 Query : "sqlite mutex wal"
 Found : 3 match(es)
════════════════════════════════════════════════════════════════════════

[#1] [vey_19a60f100000_5e0a11c0ffee] Serialize SQLite writes behind a mutex
    Kind       : MEMORY | Authority: derived | Validation: verified | Scope: project
    Composite  : 1.0249
    Signals    : Lexical=0.86 | Semantic=0.657 | Evidence=1 | Validation=1 | Proximity=1 | Freshness=1 | IntentAffinity=+0 | Relationship=0.1
    Root Cause : two DatabaseSync writers in the same process
    Remedy     : serialize all writes behind one async mutex
    Outcome    : npm test → 110 pass
    Next       : /veyra observatory record vey_19a60f100000_5e0a11c0ffee
                 /veyra observatory local vey_19a60f100000_5e0a11c0ffee

[#2] [vey_19a60f200000_0badc0de1234] Set busy_timeout on every connection
    Kind       : MEMORY | Authority: derived | Validation: reviewed | Scope: project
    Composite  : 0.6162
    Signals    : Lexical=0.15 | Semantic=0.222 | Evidence=0.7 | Validation=0.7 | Proximity=1 | Freshness=1 | IntentAffinity=+0 | Relationship=0.35
    Next       : /veyra observatory record vey_19a60f200000_0badc0de1234
                 /veyra observatory local vey_19a60f200000_0badc0de1234

[#3] [vey_19a60f300000_42cafe000001] Demo project test command
    Kind       : KNOWLEDGE | Authority: derived | Validation: unverified | Scope: project
    Composite  : 0.4550
    Signals    : Lexical=0 | Semantic=0 | Evidence=0.7 | Validation=0.25 | Proximity=1 | Freshness=1 | IntentAffinity=+0 | Relationship=0.1
    Next       : /veyra observatory record vey_19a60f300000_42cafe000001
                 /veyra observatory local vey_19a60f300000_42cafe000001

 Invariant: Search scores reflect contextual relevance, not authority.
════════════════════════════════════════════════════════════════════════
```

### `/veyra observatory record vey_19a60f100000_5e0a11c0ffee`

```
════════════════════════════════════════════════════════════════════════
 VEYRA OBSERVATORY — RECORD DETAIL: [vey_19a60f100000_5e0a11c0ffee]
════════════════════════════════════════════════════════════════════════

1. WHAT DOES VEYRA KNOW?
   Title       : Serialize SQLite writes behind a mutex
   Kind        : MEMORY (Engineering Memory)
   Authority   : DERIVED (Derived Memory)
   Validation  : VERIFIED
   Confidence  : HIGH
   Scope       : project (Project: p_0000000000000000)
   Status      : current
   Tags        : sqlite, wal, mutex

   Content:
     Concurrent DatabaseSync writes deadlock in WAL mode. Queue every write through a single async mutex in src/store.mjs; reads stay concurrent.

2. WHY DOES VEYRA KNOW IT?
   Origin Reason : Turn observation / distillation
   Observations  : 1 observation(s) accumulated
   Durable Signal: engineering-lesson

3. WHERE DID IT COME FROM? (PROVENANCE)
   Session ID    : (unknown)
   Tool / Action : session-distiller
   Doc / URI Path: (not specified)
   Workspace     : p_0000000000000000

4. WHEN WAS IT OBSERVED?
   Created At    : 2026-09-24T09:10:00.000Z
   Updated At    : 2026-09-25T08:00:00.000Z
   Last Recalled : (never recalled yet)

5. WHAT EVIDENCE SUPPORTS IT?
   [1] path: src/store.mjs
   [2] note: npm test → 110 pass

6. WHAT VALIDATION OCCURRED?
   Validation Tier : verified
   Confidence Tier : high
   Verification    : Verified by deterministic outcome (passing test / verified execution)

── Causal Facets (Four-Facet Lifecycle) ────────────────────────
  Symptom          : SQLITE_BUSY errors under parallel tool calls
    ↓ Root Cause   : two DatabaseSync writers in the same process
    ↓ Remedy       : serialize all writes behind one async mutex
    ↓ Outcome      : npm test → 110 pass

── Knowledge Relationships ──────────────────────────────────────
  ← [vey_19a60f200000_0badc0de1234] (Set busy_timeout on every connection) connects with EXTENDS

 Next: /veyra observatory local vey_19a60f100000_5e0a11c0ffee
════════════════════════════════════════════════════════════════════════
```

### `/veyra observatory local vey_19a60f100000_5e0a11c0ffee`

```
════════════════════════════════════════════════════════════════════════
 VEYRA OBSERVATORY — LOCAL GRAPH
 Center : [vey_19a60f100000_5e0a11c0ffee] Serialize SQLite writes behind a mutex (memory/derived/verified/current)
 Hops   : 1  |  Nodes: 2  |  Edges: 1
 Trust  : center is recall-eligible
════════════════════════════════════════════════════════════════════════

── Nodes ────────────────────────────────────────────────────────────────
 * [vey_19a60f100000_5e0a11c0ffee] Serialize SQLite writes behind a mutex (memory/derived/verified/current) [trusted]
   [vey_19a60f200000_0badc0de1234] Set busy_timeout on every connection (memory/derived/reviewed/current) [trusted]

── Edges ────────────────────────────────────────────────────────────────
  [vey_19a60f200000_0badc0de1234] --[ EXTENDS ]--> [vey_19a60f100000_5e0a11c0ffee]

 Invariant: Graph is a projection. Memory rows remain the source of truth.
 Next: /veyra observatory record <id>
 WebUI: /veyra?id=vey_19a60f100000_5e0a11c0ffee&cwd=%2Fpath%2Fto%2Fyour%2Fproject  (Local Graph, hops=1)
════════════════════════════════════════════════════════════════════════
```

### `/veyra recent`

```
- vey_19a60f400000_c0011de00001 [observation/candidate/unverified] Candidate: flaky test observed in webui suite
- vey_19a60f100000_5e0a11c0ffee [memory/derived/verified] Serialize SQLite writes behind a mutex
- vey_19a60f300000_42cafe000001 [knowledge/derived/unverified] Demo project test command
- vey_19a60f200000_0badc0de1234 [memory/derived/reviewed] Set busy_timeout on every connection
```

### `/veyra recall sqlite write lock`

```
- vey_19a60f100000_5e0a11c0ffee [project/derived] Serialize SQLite writes behind a mutex
- vey_19a60f200000_0badc0de1234 [project/derived] Set busy_timeout on every connection
- vey_19a60f300000_42cafe000001 [project/derived] Demo project test command
```
