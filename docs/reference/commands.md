# Command Reference

Every command is read-only unless it names a lifecycle action. `/veyra` with no
argument prints the same help text shown here.

---

## Status and search

| Command | What it does |
| --- | --- |
| `/veyra` | Status for this workspace: resolved room, record counts, version |
| `/veyra recall [query]` | Hybrid search over project and reusable memory |
| `/veyra recent` | The last eight records, including candidates |
| `/veyra inspect <id>` | Deep evidence, provenance, and causal inspection |
| `/veyra health [threshold]` | Memory-health findings. Read-only, never mutates |

## Lifecycle

| Command | What it does |
| --- | --- |
| `/veyra forget <id> [override] [reason]` | Soft-forget. The reason is kept in lifecycle history |
| `/veyra invalidate <id> [reason]` | Mark the claim invalid, reason kept |
| `/veyra supersede <id> <replacementId> [why]` | Retire a record in favour of another |
| `/veyra tombstone <id> [override] [reason]` | Retire to historical. Still inspectable |
| `/veyra protect <id> [reason]` | Guard a memory against forgetting |
| `/veyra unprotect <id>` | Remove the protection mark |
| `/veyra promote <id> [derived\|canonical]` | Change standing. `canonical` requires an explicit user instruction |

## Graph maintenance

| Command | What it does |
| --- | --- |
| `/veyra unlink <id> contradicts <targetId> [why]` | Detach one false `contradicts` edge, in both directions |
| `/veyra audit contradictions` | Read-only audit of contradiction edges. Changes nothing |

## Knowledge Observatory

Read-only projections of what is stored. None of them writes.

| Command | What it does |
| --- | --- |
| `/veyra observatory` or `observatory overview` | Aggregate knowledge and health counts |
| `/veyra observatory search <query>` | Hybrid search signals and score breakdown |
| `/veyra observatory record <id>` | Deep evidence and provenance inspection |
| `/veyra observatory causality` | Causal knowledge map, symptom to fix |
| `/veyra observatory relationships [id]` | Directed edges, optionally filtered to one record |
| `/veyra observatory local <id>` | One-hop neighbourhood around a record |
| `/veyra observatory graph [id]` | Local graph for one record, or every edge |
| `/veyra observatory contradictions` | Active conflicting claims side by side |
| `/veyra observatory consolidation` | Consolidation candidates. Read-only proposals |

## Code intelligence

These need the Codebase Memory plugin for full function and degrade without it.

| Command | What it does |
| --- | --- |
| `/veyra code status` | Index status and per-memory freshness |
| `/veyra code index` | Trigger a repository reindex |
| `/veyra code trace <symbol>` | Trace the call graph for a symbol |
| `/veyra code impact` | Memories affected by recently changed code |

## Web surfaces

| Surface | What it shows |
| --- | --- |
| `/veyra` in DSH Web | Workspace overview as a bounded network graph |
| `/veyra?id=<record>` | One-hop local graph centred on a record |
| `/veyra/graph` | JSON projection of the graph |
| `/veyra/record` | JSON projection of one record |
| `/veyra/search` | JSON projection of a search |

The web surfaces are read-only and require the web profile.
