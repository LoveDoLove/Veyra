---
name: veyra
description: >
  Use Veyra, the engineering-memory brain for this DSH session. Load it when
  the user refers to earlier work ("like last time", "what did we decide"),
  asks to remember or forget something, wants a lesson, root cause, constraint,
  or fix pattern kept, or when the task needs project context this turn does
  not already have — even if nobody says "memory". Covers when to call
  veyra_remember / veyra_recall / veyra_inspect / veyra_forget / veyra_promote,
  how candidate vs derived vs canonical differ, and that repo truth wins.
whenToUse: >
  Earlier-session context, remember/forget/promote requests, durable engineering
  decisions, or when automatic recall is missing or too thin.
---

# Veyra

Veyra is the engineering brain for this DSH session. It observes work,
remembers durable experience, and recalls it later. Treat it as an assistant,
not as truth.

## A session's lifecycle

1. **Start** — the plugin has usually already injected a recall snapshot
   (look for a Veyra context block). If it already answers the question, use
   it and skip a tool call.
2. **During the task** — call `veyra_recall` only when the injected snapshot
   is missing or too thin. Call `veyra_inspect` to read one record by id,
   including candidates and forgotten items.
3. **Data in** — when a durable decision, root cause, constraint, or fix
   pattern appears, call `veyra_remember`. Do not mirror routine conversation.
4. **End** — the plugin observes the turn and may persist a *candidate*.
   Durable observations can be promoted to *derived*. That is not canonical.

## Tools

| Tool | Use it for |
| --- | --- |
| `veyra_remember` | Keep a durable lesson. Always stored as **derived**. |
| `veyra_recall` | Targeted search beyond the automatic snapshot. |
| `veyra_inspect` | Read one `vey_…` id, including candidates / forgotten. |
| `veyra_forget` | Soft-forget. Leaves recall, stays inspectable. |
| `veyra_promote` | Change standing. **canonical requires `explicit: true`**. |

The user-facing `/veyra` command covers the same operations.

## Authority

| Standing | How it is created | Auto-recalled? |
| --- | --- | --- |
| `candidate` | Automatic observation | no |
| `derived` | `veyra_remember` or learned promotion | yes |
| `canonical` | Explicit `veyra_promote` only | yes |

Automatic behavior never creates canonical truth. Only an explicit
`veyra_promote` with `explicit: true`, triggered by the user, can do that.

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
A git repository (or its remote) maps to one project id, so clones and
worktrees of the same repo share project memory. Reusable experience is
opt-in and must not be treated as this project's architecture.

Do not invent other storage locations or invent extra Veyra commands.
