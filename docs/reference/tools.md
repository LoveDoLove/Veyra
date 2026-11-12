# Tools and Skills

Veyra exposes eleven model-facing tools and four bundled skills. Code
Intelligence tools come from a separate plugin.

Every tool is optional. Veyra's memory loop runs without any of them: tools are
the manual surface on top of it.

---

## Memory tools

| Tool | Parameters | What it does |
| --- | --- | --- |
| `veyra_remember` | `title`, `body`, `kind`, `scope`, `tags`, `evidence`, `confidence`, `validFrom`, `validUntil`, `context`, `id`, `repair` | Store durable, evidence-backed engineering knowledge. Record only what a later engineer would need: a non-obvious root cause, a verified fix pattern, a durable architecture decision, a project constraint. |
| `veyra_recall` | `query`, `goal`, `limit`, `kind` | Search memory for the current task. Returns the records and a `generationEventId` identifying the dispatch. |
| `veyra_inspect` | `id` | Read one record in full: evidence anchors, causal facets, provenance, relationships. |
| `veyra_forget` | `id`, `reason`, `override` | Soft-forget. The record leaves recall but stays inspectable. Protected or canonical records need `override: true` with a reason. |
| `veyra_promote` | `id`, `to`, `explicit`, `central`, `reason` | Change standing. `canonical` requires `explicit: true` and should only follow an explicit user instruction. `central: true` publishes the record to Central Memories. |
| `veyra_feedback` | `id`, `outcome`, `note`, `generationEventId` | Report the real-world outcome of applying a memory. `success` strengthens the record; `failure` records failure history. Passing the `generationEventId` from the recall that surfaced it attributes the outcome explicitly. |
| `veyra_recurrence` | `threshold`, `autoCandidate` | Read-only detection of recurring failures: the same root cause, symptom, rejected approach, or remedy across records. With `autoCandidate: true`, a cluster sharing one verified remedy becomes a gated candidate. |
| `veyra_health` | `failureThreshold` | The nine quality categories and six maintenance findings, plus write-gate accounting. Read-only. |
| `veyra_stale_ledger` | `scope`, `offset`, `limit`, `includeDiagnostics` | Read-only enumeration of every record with `validation: stale`, with evidence, freshness, and path-resolution diagnostics. Paginated. |

## Change intelligence

| Tool | Parameters | What it does |
| --- | --- | --- |
| `veyra_change_impact` | `changedFiles`, `repo`, `createCandidates`, `query`, `renames` | Map a set of changed files to affected memories and affected evidence anchors, classify each record's trust, and optionally propose review candidates. Never auto-promotes anything. |

## Code intelligence

| Tool | Parameters | What it does |
| --- | --- | --- |
| `veyra_code_status` | `repo` | Index status and per-memory freshness. Degrades to a structured error with install guidance when the code-intelligence layer is unavailable. |

The six `cbm_*` tools (`cbm_projects`, `cbm_search`, `cbm_snippet`, `cbm_trace`,
`cbm_arch`, `cbm_search_code`) belong to the
[Codebase Memory plugin](https://www.npmjs.com/package/@lovedolove/dsh-codebase-memory-mcp).
Veyra registers none of them. See [code intelligence](./code-intelligence.md).

---

## Skills

Four skills ship inside the package and register automatically.

| Skill | Use it when |
| --- | --- |
| `veyra` | You need Veyra's own guidance: tool usage, the authority ladder, causal facets, hybrid search semantics, and the rule that repository truth wins. |
| `legacy-onboarding` | First entry into an unfamiliar or legacy repository: baseline assessment, progressive investigation depth, evidence-first extraction, and a Project Memory Baseline. |
| `memory-review` | You want to audit a conversation for durable engineering memory: what is already recorded, what is missing, what looks stale or conflicting. |
| `memory-maintenance` | The user explicitly asks to clean up or maintain memory. Applies lifecycle actions with before/after reporting. A health finding alone is never authorization. |

---

## Choosing between a tool and the loop

The automatic loop captures what a turn actually did. The tools exist for
knowledge that the loop cannot infer, and for explicit human control.

| Situation | Use |
| --- | --- |
| A turn produced a fix and a passing test | Nothing. The loop captures it. |
| You learned something the loop would miss (an external constraint, a decision made in conversation) | `veyra_remember` |
| You are starting a task and want a targeted search | `veyra_recall` |
| You applied a memory and it worked, or did not | `veyra_feedback` |
| The user wants a record treated as project truth | `veyra_promote` with `explicit: true` |
