---
name: veyra
description: >
  Use Veyra, the engineering-memory and RAG intelligence brain for this DSH session.
  Load it when the user refers to earlier work ("like last time", "what did we decide"),
  asks to remember or forget something, wants a lesson, root cause, constraint, or fix
  pattern kept, needs project documentation/knowledge retrieved via hybrid search, or
  when the task needs project context this turn does not already have — even if nobody
  says "memory". Covers when to call veyra_remember / veyra_recall / veyra_inspect /
  veyra_forget / veyra_promote, how candidate vs derived vs canonical differ, causal facets,
  and that repo truth wins.
whenToUse: >
  Earlier-session context, remember/forget/promote requests, durable engineering
  decisions, project RAG documentation, causal troubleshooting, or when automatic
  recall is missing or too thin.
---

# Veyra

Veyra is the engineering brain for this DSH session. It observes work,
remembers durable engineering experience, indexes RAG knowledge, and recalls
relevant context via unified Hybrid Search. Treat it as an assistant, not as truth.

## A session's lifecycle

1. **Start** — the plugin has usually already injected a recall snapshot
   (look for a Veyra context block). If it already answers the question, use
   it and skip a tool call.
2. **During the task** — call `veyra_recall` for targeted hybrid search when the
   injected snapshot is missing or too thin. Call `veyra_inspect` to read one
   record by id with full evidence anchors, causal facets, and relationships.
3. **Data in** — when a durable decision, root cause, constraint, fix pattern,
   or project guideline appears, call `veyra_remember`. Use `kind: 'memory'` for
   engineering experience, or `kind: 'knowledge'` for project documentation.
   Do not mirror routine conversational chatter.
4. **End** — the plugin observes the turn and may persist a *candidate*.
   Durable observations can be promoted to *derived*. That is not canonical.

## Tools

| Tool | Use it for |
| --- | --- |
| `veyra_remember` | Keep a durable lesson or RAG knowledge. Always stored as **derived**. |
| `veyra_recall` | Unified Hybrid Search (lexical + semantic + causal + relations). |
| `veyra_inspect` | Read one `vey_…` id with evidence anchors, causal facets, and graph relations. |
| `veyra_forget` | Soft-forget. Leaves recall, stays inspectable. |
| `veyra_promote` | Change standing. **canonical requires `explicit: true`**. |

The user-facing `/veyra` command covers the same operations, plus the human Knowledge Observatory.

## Hybrid Search & Unified RAG

Veyra retrieves project knowledge and engineering memory together through a multi-signal pipeline:
- **Lexical**: FTS5 BM25 match with exact token, symbol, and file-path boosts.
- **Semantic**: Token-level Jaccard overlap and query concept coverage.
- **Memory & Causal**: Intent affinity (`why` → rootCause, `how` → remedy, `outcome` → verifiedOutcome).
- **Relationships**: Graph connections (`updates`, `extends`, `derives`, `contradicts`, `supersedes`). Recall may add a bounded 1-hop of recall-eligible neighbors.
- **Scoring**: Transparent multi-dimensional scoring (relevance, semantic, evidence, validation, proximity, freshness, confidence). Never a single opaque score.

## Structured Causal Knowledge

Engineering troubleshooting captures four explicit causal facets:
- **Symptom**: Observed failure, error message, or broken state.
- **Root Cause**: Underlying defect or mechanism producing the symptom.
- **Remedy**: Concrete change or fix that addresses the root cause.
- **Verified Outcome**: Deterministic outcome confirming the remedy (e.g. passing test).

*Negative Rules*: Temporal adjacency alone creates no causal link. Simultaneous changes
do not arbitrarily identify one root cause. A failed remedy is never a verified remedy.

## Authority

| Standing | How it is created | Auto-recalled? |
| --- | --- | --- |
| `candidate` | Automatic observation | no |
| `derived` | `veyra_remember` or learned promotion | yes |
| `canonical` | Explicit `veyra_promote` only | yes |

Automatic behavior never creates canonical truth. Only an explicit
`veyra_promote` with `explicit: true`, triggered by the user, can do that.

## Knowledge Observatory (Human Surface)

Humans can explore Veyra's internal state via the `/veyra observatory` slash command:
- `/veyra observatory overview`: Memory, RAG knowledge, validation health, and graph counts.
- `/veyra observatory search <q>`: Inspect hybrid search signals and dimensional scores.
- `/veyra observatory record <id>`: Deep inspection answering the 6 questions (What, Why, Where, When, Evidence, Validation).
- `/veyra observatory causality`: Map of all symptom → root cause → remedy → outcome chains.
- `/veyra observatory relationships [id]`: Directed graph projection of knowledge links.
- `/veyra observatory local <id>`: 1-hop Local Graph around a record (default graph view).
- `/veyra observatory graph [id]`: Local Graph when an id is given; otherwise the project edge list.
- `/veyra observatory contradictions`: Conflicting knowledge claims displayed side-by-side.
- Network Graph WebUI: host page `/veyra` shows a bounded workspace overview; `/veyra?id=<record>` centers the Local Graph over the same derived projection. Visible ≠ trusted.

## Rules you must keep

- Observe ≠ Store. Not every event is worth remembering.
- Candidate ≠ Truth. Automatic captures are unverified.
- Similarity ≠ Authority. A recalled match is not proof.
- Memory ≠ Knowledge. Remembered experience is not the repository.
- Knowledge without evidence is not authoritative.
- Repository truth remains authoritative. When memory conflicts with the
  current codebase, tests, or git history, believe the repository.
- Project isolation is preserved. Do not treat reusable experience as this
  project's architecture.
- Memory assists engineering; it does not replace verification.
- Similarity ≠ identity. Overlapping memories are linked, never silently merged.
- If two recalled items contradict, keep both and believe the repository.

## Where memory lives

Memory is stored under `$DSH_HOME/veyra/`, never inside the user's repository.
The project id hashes the checkout's git root path together with its origin
remote, so every workspace inside one checkout shares memory while unrelated
folders — and separate clones or worktrees of the same repository — stay
isolated. Reusable experience is opt-in and must not be treated as this
project's architecture.

Do not invent other storage locations or invent extra Veyra commands.
