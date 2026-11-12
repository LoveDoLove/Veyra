# The Veyra Memory Model

What a memory record is, what it is allowed to become, and how Veyra decides
whether to trust it right now. This page is the reference; the reasoning behind
it is in the [whitepaper](../WHITEPAPER.md).

---

## 1. Three independent axes

A record carries three axes that never influence each other. Similarity to a
query affects ranking only.

| Axis | Values | Who moves it |
| --- | --- | --- |
| **Authority** | `candidate` → `derived` → `canonical` | The write gate for `derived`; an explicit user action for `canonical` |
| **Validation** | `unverified` → `reviewed` → `verified` | Accumulated confirmation across sessions and test outcomes |
| **Confidence** | `low` / `medium` / `high` | The capture and learning paths, from evidence strength |

**Only `derived` and `canonical` records are recall-eligible.** A `candidate`
is stored, inspectable, and visible in `/veyra recent`, but it is never injected
into the agent's context automatically.

**`canonical` is reachable only through an explicit user action.** There is no
code path that promotes to `canonical` on its own, and `assertAuthorityTransition`
refuses the attempt if one is written.

---

## 2. Record kinds

| Kind | Holds | Title is |
| --- | --- | --- |
| `observation` | What a turn did, before any judgement | a summary |
| `memory` | A durable engineering lesson | the lesson |
| `knowledge` | Project documentation kept next to memory (unified RAG) | the topic |
| `evidence` | A captured fact with anchors | the fact |
| `negative` | An approach that was tried and rejected | the hypothesis |
| `unresolved` | An open investigation | the question |

`negative` and `unresolved` are first-class: knowing what did not work, and what
is still unknown, is as useful to a later agent as knowing what worked.

---

## 3. Causal facets

A record may carry structured causal fields. They are extracted from text that
states them and are used by recall ranking and by merge decisions.

```
symptom → rootCause → remedy → verifiedOutcome
```

The `Root cause:` facet also decides whether a new record restates an existing
one. Whole-claim similarity cannot do this: over a real room the best pair of
genuinely duplicate claims scored 0.143, below the conflict floor, because body
lengths differ. Identical `Root cause:` lines score 1.000, a rewording scores
0.727 to 0.909, and a genuinely different cause scores at most 0.278.

The rule fails closed. A record with no `Root cause:` facet never becomes a
cause-duplicate, and a `CONFLICT` verdict is never overridden.

---

## 4. Lifecycle

| Action | Effect | Recall |
| --- | --- | --- |
| `protect` / `unprotect` | marks a record as guarded against forgetting | unchanged |
| `invalidate` | marks the claim as no longer true, reason kept | no |
| `supersede` | retires a record in favour of a replacement | no |
| `forget` | soft-forget, still inspectable | no |
| `tombstone` | terminal marker, still inspectable | no |

Lifecycle changes are explicit. The bundled `memory-maintenance` skill applies
them only when you ask for it; a health finding is never authorization.

The skill also reports three findings that are **not** store mutations, so
nothing is written for them: `KEEP` (the claim still holds), `REVALIDATE` (the
evidence is unclear, a human must check the repository) and `DEFER` (the finding
stays open for a later run).

---

## 5. Trust at read time

Every recalled record is classified against the current repository state. This
is a projection. It never writes, and it never changes authority or validation.

| Category | Meaning |
| --- | --- |
| `trusted` | Evidence anchors still resolve; nothing contradicts the record |
| `review_required` | The record is usable but needs a check before acting on it |
| `stale` | An anchored file changed; the claim may no longer hold |
| `contradicted` | Another record makes an opposing claim on the same subject |
| `insufficient_evidence` | The record cannot be checked right now, for example because Code Intelligence is unavailable |

`insufficient_evidence` is deliberately distinct from `stale`. A path that
cannot be resolved because the code-intelligence layer is absent says nothing
about whether the code changed, and Veyra does not pretend otherwise.

Stale records are penalized in ranking rather than hidden. Contradictions stay
visible: hiding them is a rejected behaviour.

---

## 6. Rooms, Central Memories, and promotion

Storage lives under `$DSH_HOME/veyra/` (or `$VEYRA_HOME`), never inside your
repository.

| Layer | Holds | Path |
| --- | --- | --- |
| **Memory Room** | Everything learned while working in one DSH workspace | `rooms/<roomId>/memory.db` |
| **Central Memories** | Knowledge explicitly promoted out of a room | `central/memory.db` |

A room is a DSH `WorkspaceId`, not a filesystem path. Two workspaces opened on
the same repository are two rooms with separate memory, and a workspace whose
identity cannot be resolved fails closed instead of guessing.

Promotion is the only way into Central Memories. No learning path writes there.
The pre-rooms `projects/` and `reusable/` databases are never read, written,
migrated, merged, or deleted.

---

## 7. Write gate

Automatic learning runs every observation through a gate that can accept, merge,
drop, or defer it. Each verdict is counted, with its reason, in a ledger you can
read through `/veyra health`.

Typical reasons a record is deferred rather than accepted:

- `provenance-gated` — the record's origin does not justify durable memory
- `context-provenance-no-test-evidence` — a context-derived claim with no test
  evidence behind it
- `canonical-requires-explicit-promotion` — anything that would become canonical

Merging is how repetition is handled. A repeated observation strengthens an
existing record instead of cloning it, and a record that restates an existing
root cause merges into it.

---

## 8. Redaction

Every write path goes through `src/redact.mjs` before persistence. Secrets are
removed by shape, and a validated tier catches payment cards (Luhn), IBANs
(ISO 13616 mod-97), and US SSNs that carry no secret-looking shape.

---

## 9. What Veyra never does

- It never writes into your repository.
- It never marks a record `verified` because the record claims success.
- It never treats a recalled memory as an instruction. Every recall block is
  prefixed with a notice that it is remembered experience, not repository truth.
- It never hides a contradiction, and it never merges two records that disagree.
