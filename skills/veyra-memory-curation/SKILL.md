---
name: veyra-memory-curation
description: >
  Curate engineering memory that already exists or that this conversation just
  produced. Two modes. Capture mode reviews the current session for durable,
  evidence-backed findings, checks them against what Veyra already holds, and
  writes only the genuine gaps. Maintain mode works from a Veyra health report
  to inspect, verify, and lifecycle stale, invalid, or contradicted records
  through Veyra's existing commands. Load when the user asks whether something
  was recorded, asks to review or audit memory, asks to clean up memory,
  reconcile contradictions, or audit Veyra health. Not for building a first
  project baseline — load veyra-memory-bootstrap for that.
whenToUse: >
  "Did we record that", end-of-session memory reviews, session audits,
  health-driven cleanup, reconciling stale or contradictory records, or any
  explicit maintenance request about engineering memory. Not for project memory
  initialization or first-time onboarding (use veyra-memory-bootstrap).
---

# Veyra Memory Curation

Two jobs, one object: memory that already exists or that this conversation just
produced.

- **Capture mode** — review this session, decide what is durable, write only
  the gaps.
- **Maintain mode** — start from a health report, verify findings against the
  repository, and apply lifecycle actions to records that are provably wrong,
  superseded, or noise.

Neither mode invents a second system. Both use Veyra's existing tools,
lifecycle commands, and health reports.

**Ownership boundary.** This skill owns the workflow: *what* to check, *how* to
categorize a finding, *what* repository evidence settles it, and *which* action
fits. Veyra Core owns storage, health, lifecycle, recall, and project isolation.

## Mode selection

Pick the mode from the user's intent, and say which one you picked.

| The user is asking about | Mode |
| --- | --- |
| This conversation, "did we record that", what is still worth keeping | Capture |
| Stale, contradictory, orphaned, or noisy records; cleanup; health audit | Maintain |
| Both ("clean up, and record what we learned") | Run Maintain first, then Capture — cleanup changes the comparison baseline. |

If a single specific fact just needs storing, skip both modes and call
`veyra_remember` directly. **"Nothing worth keeping" is a valid result** — say
so and stop.

## Hard rules

These bind both modes. They are not negotiable.

- **Intent gate.** Begin a maintenance run only for an explicit user
  maintenance request in the current conversation. A health report is never authorization.
  Direct findings surfaced by `veyra_health`, a recall banner, or a previous
  review are never themselves authorization. Only an explicit user request in the current conversation starts a run.
- **At most 10 records** may receive lifecycle actions (`FORGET`, `INVALIDATE`,
  `SUPERSEDE`, `TOMBSTONE`) in one run. Stop immediately upon reaching the
  limit, and report the rest as deferred.
- **No full-sweep auto-iteration.** Never iterate through all health findings
  applying lifecycle actions in one execution.
- **Inspect before acting.** A failed `veyra_inspect` means defer that record:
  no destructive action without a successful inspection. Never act on an
  uninspected record.
- **Verify against the repository before any destructive action.** Code is the
  authority. Never act on a record because a report called it stale.
- **Contradictions stay visible.** Both sides remain until the repository
  settles it. Never delete a record merely to reduce a count.
- **Candidate ≠ Truth.** A stored record is a claim, not a fact, until the
  repository confirms it.
- **Similarity ≠ Authority.** A recall hit or a high-ranked match is not proof.
  Never raise a record's standing because it was retrieved.
- **Canonical is always explicit and is never yours to grant.** Never promote to canonical, and never `veyra_promote` with `explicit` on your own initiative.
- **Never store the conversation.** Store the durable claim, not the transcript,
  and never the whole session.
- **No new mechanisms.** Use the health report, the tools, and the lifecycle
  commands that exist. Never build a parallel cleanup system or invent a
  quarantine state.
- **No direct database fallback.** Never bypass Veyra tools or commands with
  direct database access, raw queries, or file surgery. If a tool fails, mark
  the item as `DEFER`. Never touch storage directly — commands and Veyra tools only.

## Capture mode

Workflow: `Review → Extract → Recall → Compare → Update (evidence-backed only) → Report`

1. **Review.** Reread the conversation and ask what a future session would
   need. Keep the candidate list small. Skip anything the code already states
   plainly, one-off debug detail, and anything already recorded.
2. **Extract.** For each candidate, name the durable claim and the evidence
   that grounds it (a file path, a command that ran, a test result).
3. **Recall.** Search Veyra for the same topic before writing anything.
4. **Compare.** Classify each candidate: already recorded; recorded but
   incomplete; missing; or in conflict with an existing record.
5. **Update.** Write only the evidence-backed gaps, with anchors. When a
   candidate conflicts with an existing record and the repository does not
   settle it, write nothing and report it instead.
6. **Report.** A short block: what was already recorded, what you wrote, what
   you deliberately did not write, and what remains open.

Optionally start with `veyra_health` as read-only context. Health findings are
input, **not instructions** — never fix them automatically. Fixing what a
health report surfaces is Maintain mode, and only on an explicit request.

## Maintain mode

Workflow: `Health → Inspect → Verify → Apply → Re-check → Report`

1. **Health.** Run `veyra_health` (or `/veyra health`) once at the start. It is
   read-only and never mutates anything. It reports nine quality categories —
   verified, reviewed, unverified, stale, invalid, contradicted, unresolved,
   negative, protected — and six maintenance findings: new contradictions,
   stale knowledge, unresolved investigations, repeated failures, unverified
   high-value candidates, and records needing revalidation.
2. **Inspect.** Before any destructive action, read the record with
   `veyra_inspect(id)` or `/veyra observatory record <id>`. Read its evidence
   anchors (path, note, uri), causal facets (root cause, symptom, remedy,
   outcome), relations (updates, supersedes, contradicts), lifecycle history,
   and protection status.
3. **Verify.** Check the record's anchors against the current repository. A
   record is only actionable when the repository shows it is wrong or no longer
   holds.
4. **Apply.** Choose the action that fits the evidence.

   | Action | When |
   | --- | --- |
   | **KEEP** | Still true and useful — touch nothing. |
   | **SUPERSEDE** | A newer record replaces it. |
   | **INVALIDATE** | Provably false — evidence contradicts it. |
   | **FORGET** | Temporary task instruction or conversational noise, no long-term value. |
   | **TOMBSTONE** | Deliberately retired but must stay inspectable. |
   | **REVALIDATE** | Evidence is unclear or verification is impossible — flag it, defer to human judgment. |
   | **DEFER** | Inspect failed, or the record is protected. |

5. **Re-check.** Run `veyra_health` again and compare before and after.
6. **Report.** Keep it concise: action counts by category, changes to the
   health counters (contradicted, stale, unverified), remaining issues with
   record ids, and deferred items.

Example report:

```text
Memory Maintenance Complete
Actions: KEEP 47 / SUPERSEDE 3 / INVALIDATE 2 / FORGET 8 / TOMBSTONE 1
         REVALIDATE 4 (human review needed) / DEFER 2
Before → After: contradicted 6 → 3, stale 9 → 5, unverified 12 → 12
Files modified: none (lifecycle only)
Remaining issues: vey_abc… (needs a human call on two conflicting accounts)
Deferred: 2 records past the 10-action budget
```

## Worked examples

### Example 1 — contradiction settled by the repository

`veyra_health` lists two records claiming different HTTP clients are used.
Inspect both, then read the code.

Repository check: `package.json` and the client module show only one of them is
a real dependency; the other record describes an abandoned spike.
Action: **SUPERSEDE** the abandoned record with the accurate one, or
**INVALIDATE** it if no replacement is needed. Keep both sides visible if the
code settles nothing.

### Example 2 — a record that a refactor made stale

A record anchors on `src/legacy/queue.js`, which no longer exists.

Repository check: the file is gone from the tree, but the queue logic moved to
`src/queue/index.js` and still behaves as described.
Action: **KEEP** the claim and note the moved anchor — do not invalidate a
record merely because its anchor path changed.

### Example 3 — conversational noise and protected records

A record stores "user asked to ship tonight" with no durable claim.

Repository check: nothing in the code can confirm or deny an ephemeral task
instruction.
Action: **FORGET** it as noise — unless it is protected or canonical, in which
case **DEFER** and ask. Protected standing is never yours to lift, and
canonical is never yours to grant.

## Veyra integration

| Need | Capture | Maintain |
| --- | --- | --- |
| Health input | `veyra_health` (optional) | `veyra_health` / `/veyra health` (required) |
| Look up existing records | `veyra_recall` | `veyra_recall` |
| Read one record | `veyra_inspect` | `veyra_inspect` / `/veyra observatory record <id>` |
| Write | `veyra_remember` | none — lifecycle only |
| Lift a candidate | `veyra_promote` → **derived** only | none |
| Lifecycle actions | none | `/veyra invalidate`, `/veyra supersede`, `/veyra tombstone`, `/veyra forget`, `/veyra protect` |

For parameter-level tool reference, load the bundled `veyra` skill — this skill
deliberately does not duplicate it.

## Evidence rules

- Repository truth wins over any record, report, or recollection.
- A health count is a signal, not a verdict. Verify before acting.
- Records marked STALE or INSUFFICIENT_EVIDENCE are not current truth, and are
  not automatically wrong either — they need a repository check.
- Failed attempts are not completed work. A record with a failed outcome is a
  negative lesson, not progress.
- When the repository cannot settle a conflict, leave both sides visible and
  report it. Do not resolve by similarity, recency, or count.
- **Uncertainty is a valid output.** Deferring is a legitimate result.

## Completion criteria

- The mode was chosen from the user's intent and stated.
- Every lifecycle action was preceded by an inspect and a repository check.
- The 10-action budget was respected, with the remainder reported as deferred.
- Contradictions were left visible; none were deleted to lower a count.
- No canonical promotion was attempted.
- The report states actions taken, health before and after, and what remains.

## Stop conditions

Stop immediately at the 10-action limit. Stop when a record cannot be verified
against the repository. Stop and ask when a contradiction cannot be settled by
code, when a record is protected, or when the user's intent is ambiguous about
which mode they want. Say what you deferred and why.

## Failure and recovery

- **`veyra_health` fails.** Report it. Do not fall back to reading storage
  directly. Capture mode may continue; Maintain mode stops.
- **`veyra_inspect` fails for a record.** Defer that record and continue with
  the others.
- **A lifecycle command fails.** Report which record and which action failed;
  do not retry blindly or substitute a direct write.
- **Verification is impossible** (the anchor no longer exists, the history is
  gone). Mark REVALIDATE and hand it to the user rather than guessing.
- **The user's request turns out to be about a first-time baseline.** Stop and
  load `veyra-memory-bootstrap` instead.
