---
name: memory-review
description: >
  Review the current conversation for durable engineering memory worth keeping
  and check whether Veyra already recorded it. Extracts a small set of
  evidence-backed engineering facts from this session, recalls the existing
  memory, classifies each fact as already recorded, missing, or
  stale/conflicting, updates only evidence-backed gaps through existing Veyra
  tools, and ends with a short review report. Load when the user asks to
  review memory, audit what this session stored, check whether something from
  this conversation was recorded, or reconcile conversation findings with
  Veyra.
whenToUse: >
  End-of-session or mid-session memory audits, "did we record that"
  questions, and reconciling this conversation's findings against existing
  Veyra memory.
---

# Memory Review

Review the **current conversation** for engineering facts worth keeping long
term, check them against what Veyra already holds, and give the user a short
report. This skill decides *what* to look for, *how* to compare, and *what* to
report; Veyra Core still owns storage, lifecycle, validation, promotion,
relationships, recall, and project isolation.

**Ownership boundary.** Use existing Veyra capabilities only — `veyra_recall`,
`veyra_inspect`, `veyra_remember`, `veyra_promote`, `veyra_health`, and the
`/veyra` command (`/veyra health` is the read-only maintenance findings surface).
Never reimplement storage, never invent states or commands Veyra does not have,
and load the bundled `veyra` skill for tool-level reference instead of
duplicating it.

## Trigger and applicability

Use when:

- The user asks to review, audit, or reconcile memory for this conversation.
- A long or high-stakes session is ending and the user wants to know what was
  captured.
- The user asks whether something from this session was already recorded.

Do not use when:

- The user wants one specific fact remembered — call `veyra_remember`
  directly.
- The conversation produced nothing durable — "nothing worth keeping" is a
  valid review result; say so and stop.

## Workflow

`Review → Health → Extract → Recall → Compare → Update (evidence-backed only) → Report`

0. **Run the automated health pass first.** Call `veyra_health` (or
   `/veyra health`) once at the start. It reports the nine §21 quality
   categories and six maintenance findings — contradictions, stale knowledge,
   unresolved investigations, repeated failures, unverified high-value
   candidates, and records needing revalidation. These findings are input to
   the review, not instructions: verify anything suspicious against the
   repository before acting, never auto-fix, and remember the scan is
   read-only.

1. **Review the conversation.** Reread the current conversation end to end.
   List only what has long-term engineering value: durable decisions and their
   rationale, root causes with verified fixes, constraints, non-obvious project
   facts, recurring pitfalls, workarounds and why they exist.
2. **Extract candidates.** Keep the list small — a review surfaces a handful of
   items, not a transcript. Skip routine task chatter, transient state, things
   the repository already states plainly, one-off debug noise, restatements of
   existing memory, and speculation. Note the in-conversation evidence for each
   candidate (file, command output, test result); inference alone is not
   evidence.
3. **Recall existing memory.** Run `veyra_recall` per candidate topic — one
   focused query per topic, not one giant query over the whole session. Read
   anything close with `veyra_inspect`.
4. **Compare and classify** each candidate:

   | Classification | Meaning | Action |
   | --- | --- | --- |
   | Already recorded | Existing memory covers it, unchanged | Do not write again |
   | Missing | No existing coverage, evidence-backed | Write via `veyra_remember` |
   | Extension | Existing record + new nuance from this session | Write the extension; Veyra links it |
   | Stale or conflicting | Conversation or repository evidence contradicts an existing record | Verify against the repository first; write the newer claim so Veyra supersedes it, or report the conflict unresolved |
   | Not worth keeping | No durable value, or evidence too weak | Drop it, or report as held |

5. **Update with evidence only.** Write `Missing` and `Extension` items with
   `veyra_remember`: evidence anchors for every claim, honest confidence, short
   stable tags. For stale items the repository is the tiebreaker — never pick
   a winner from similarity or recency alone. Weak or unverifiable items are
   reported as held, not written.
6. **Report.** Give the user the review report below.

## Principles

- **Candidate ≠ Truth.** Everything extracted from this conversation —
  including records Veyra auto-captured this session — is a candidate until
  evidence backs it.
- **Similarity ≠ Authority.** A recall hit that sounds alike is not proof that
  a fact is already recorded or already correct.
- **Never store the conversation.** The review extracts a few durable facts; it
  does not mirror the transcript. If nearly everything looks worth keeping, the
  filter has failed.
- **Never promote to canonical.** Canonical requires the user's explicit
  action. This skill only writes derived records via `veyra_remember` and may
  lift a genuinely useful candidate to derived only when the user asks.
- **No new mechanisms.** No conversation parser, no scoring system, no new
  storage, no new CLI: the Veyra tools and `/veyra` are the whole toolbox.
- **Repository truth remains authoritative.** When memory conflicts with the
  current codebase, tests, or git history, believe the repository.
- **Project isolation is preserved.** A reusable lesson does not become this
  project's architecture.

## Review report

One line per item, then a closing summary:

```text
Memory review — <n> candidates

✔ already recorded   <fact> (vey_…)
＋ missing → written  <fact> (vey_…)   [or: → held, evidence too weak]
~ extension → written <fact> (vey_… updates vey_…)
! stale/conflict      <fact> vs vey_… → resolved by <repo evidence> | needs your decision

Summary: written <a>, already recorded <b>, held <c>, conflicts <d>.
```

If the automated health pass surfaced findings, add one closing line such as
`Health (§21): <n> finding(s) from veyra_health — see /veyra health for the
full list.` Report them; never fix them automatically.

End by naming anything the user must decide (held items, unresolved conflicts).
If there was nothing worth keeping, say exactly that.

## Completion criteria

- Every candidate is classified and appears in the report.
- Only evidence-backed `Missing` / `Extension` items were written; nothing was
  duplicated; no canonical promotion was attempted.
- Stale or conflicting memory was verified against the repository or reported
  as unresolved — never resolved by similarity or recency alone.
- The report is short: what already exists, what was added, what is held or
  disputed.

## Failure and recovery

- **A Veyra tool errors** — report what could not be checked; do not fake
  stored records and do not loop retries.
- **Recall returns nothing relevant** — treat the item as missing only after a
  second focused query; otherwise report coverage as unverified.
- **Evidence runs out** — hold the item, report it, and stop. A review that
  writes nothing is still a completed review.
