---
name: veyra-memory-bootstrap
description: >
  Build a project memory baseline in Veyra — the first-time onboarding pass
  that discovers an unfamiliar, legacy, or not-yet-baselined repository and
  records 4-8 durable, evidence-anchored facts a future session can recall
  instead of re-investigating. Load at first entry into an old or foreign
  codebase, when recall returns nothing or is too thin to answer "what is this
  project, what are its constraints, what breaks here", when the user asks to
  onboard or survey a project, when the user explicitly asks to initialize
  memory (初始化记忆, 建立记忆基线, "init memory"), or before high-risk work on
  authentication, databases, infrastructure, core APIs, migrations, or
  compatibility shims. Not for capturing this conversation's own findings and
  not for cleaning up records that already exist — load veyra-memory-curation
  for both of those.
whenToUse: >
  First substantive work in a project whose Veyra memory is empty or too thin
  to be useful, an explicit onboard or "initialize memory" request, a baseline
  that has drifted from the code, or a high-risk change to a legacy area. Not
  for recording a session's own findings, and not for health-driven cleanup of
  records that already exist — those are veyra-memory-curation.
---

# Veyra Memory Bootstrap

Onboard a project into Veyra: discover it, extract the durable engineering
knowledge that is actually load-bearing, ground every claim in evidence, and
leave behind a recallable baseline. A future session should be able to answer
"what is this project and what breaks here" from recall alone.

**Ownership boundary.** This skill owns decisions: *whether* to investigate,
*how deep*, *what* to extract, *how* to ground it, *when to stop*. Veyra Core
owns storage, lifecycle, validation, promotion, relationships, recall, and
project isolation.

**A baseline is not a summary.** Four to eight focused records beat one giant
project write-up. If a fact would not change what a future agent does, it does
not belong in the baseline.

## Trigger and applicability

Use this skill when any of these hold:

- The user explicitly asks to initialize, onboard, or survey a project's memory.
- This is the first substantive task in a repository whose Veyra memory is
  empty, obviously thin, or visibly unrelated to the code.
- Existing memory has drifted and no longer describes the current repository.
- You are about to change a high-risk legacy area — authentication, database,
  infrastructure, core APIs, migrations, compatibility shims, long-lived
  workarounds, or a large deletion.

Do **not** use it when:

- The task is trivial (a typo, a formatting pass, a one-file edit with no
  structural questions).
- A reliable baseline already answers the task. **Re-onboarding a known
  project is waste** — recall first and stop if the answer is already there.
- The request is to record this session's findings, or to clean up, audit, or
  reconcile records that already exist. Load `veyra-memory-curation` instead.

### Scenario routing

| Scenario | Action |
| --- | --- |
| No baseline exists (first entry) | Run the workflow at **Standard** depth (drop to **Shallow** if the task is genuinely trivial). |
| Baseline exists and answers the task | Stop. Report that it exists, use it, do not re-onboard. |
| Baseline exists but has drifted on the area you are touching | Targeted investigation of that area only, then record the delta. |
| User explicitly asks to initialize memory | The baseline **is** the task — run the workflow end to end now. |
| Baseline exists but is thin, stale, or wrong | Report what is missing, then refresh just those parts. |

**Init mode.** When the user explicitly asks to initialize memory, building the
baseline is the deliverable, not a side effect of some other task. Step 1 still
applies: recall first. If a substantive baseline already exists, say so, offer
to refresh the drifted areas, and stop — do not blind-duplicate. Init mode
changes the posture, never the invariants.

## Depth control

Depth is chosen per task, announced in one line before investigating, and
re-evaluated when the task's risk changes. Default to the lowest depth that
answers the task.

- **Shallow** — structure, entry points, manifests, config, tests, and ambient
  Veyra context. No history digging. Enough for "where does this live".
- **Standard** — Shallow plus documentation, the architecture of the area you
  are touching, recent git history for those paths, and recorded decisions.
- **Deep** — Standard plus targeted archaeology: major migrations, reverts,
  compatibility constraints, deprecated systems, incident-driven fixes, and
  pivotal architecture decisions **that bear on the change at hand**. Deep is
  always targeted; never sweep the whole history because the project is old.

Escalate one level when the change touches shared state, public contracts, or
data lifecycles. De-escalate as soon as the risk is contained.

## Workflow

`Assess → Discover → Investigate → Extract → Ground → Validate → Record or Hold → Baseline → Continue`

1. **Assess.** Recall what Veyra already knows about this project and read the
   scenario table above. Decide the depth and say it out loud before digging.

2. **Discover.** Prefer the Codebase Memory tools (`cbm_arch`, `cbm_search`)
   and `veyra_code_status` for AST index freshness. Establish config and
   boundaries from README/docs, manifests, lockfiles, entry points, layout,
   tests, CI, and `AGENTS.md`/`CLAUDE.md`. **Confirm doc claims against code —
   code is the authority.**

   **Anti-bloat budget.** Never dump recursive directory trees, full git logs,
   or read generated build artifacts (`node_modules/`, `dist/`, `.wrangler/`,
   `build/`).

3. **Investigate.** Follow the depth you chose, and only where the task points.

4. **Extract.** Produce records against the baseline schema below. Target 4-8
   records total for a first pass.

5. **Ground.** Anchor every claim in this order of strength:

   `current repository file → verified project documentation → git commit →
   tests / CI evidence → historical artifacts → agent inference`

   Inference is the weakest anchor and never stands alone as fact.

6. **Validate.** For each candidate: confirmed → ready to write; contradicted →
   the repository wins, and if the old behavior still matters, record it
   explicitly as historical rather than deleting it silently; unverifiable →
   hold it.

7. **Record or Hold.** Recall the same topic and compare before writing.

   | Finding | Action |
   | --- | --- |
   | Already recorded, unchanged | Do not write it again. |
   | Recorded, and you have genuine new nuance | Write the extension. |
   | Recorded, but your evidence is newer repo state | Write the correction. |
   | Conflicts with an existing record | The repository decides; if it genuinely cannot, hold and keep both sides visible. |
   | Historically true, no longer true | Write it framed as historical. |
   | Evidence too weak | Hold. |

   Writing rules: project scope unless truly project-agnostic; `knowledge` for
   documentation, decisions, and constraints, `memory` for engineering lessons;
   short stable tags; honest confidence; evidence anchors on every claim.
   `veyra_promote` only lifts a candidate to **derived**.

   **Canonical is never yours to grant** — it requires an explicit user action;
   never call promote with canonical or `explicit` yourself.

8. **Baseline.** Done when a future agent using only recall can answer the
   checklist below, and every record carries at least one repository file
   anchor (`path=...`).

9. **Continue.** Transition immediately into the original coding task. Onboarding
   never becomes the blocker.

## Baseline schema

Target 4-8 records covering these four parts:

1. **Identity and architecture topology** — what this project is, the main
   stack, the major components, where the key modules live.
2. **Invariants and system constraints** — what must not be broken, which
   constraints are structural rather than stylistic.
3. **Build, test, and CI pipeline** — how to build, how to test, what CI runs,
   what a green run looks like.
4. **Historical pitfalls and workarounds** — which old facts still affect the
   system today, and what workarounds exist and why.

**Skip:** routine implementation detail, one-off debug findings, commit
messages with no durable content, anything the code already states plainly,
restatements of existing memory, and speculation.

Completion checklist — a future agent should be able to answer:

- What is this project, and what is the current main stack?
- What is the major architecture, and where are the key modules?
- Which architectural decisions matter?
- Which legacy constraints still bind the system?
- Which historical facts still affect the code today?
- Which workarounds exist, and why?
- Which knowledge is verified, and which is uncertain?
- What must be checked before touching the core?

**Validation gate.** Run `veyra_health` to confirm no orphaned or broken
records, then run one sample `veyra_recall` on the primary subsystem.

## Veyra integration

| Need | Use |
| --- | --- |
| Existing context | The injected recall snapshot and `/veyra` counts. |
| Look up a topic before writing | `veyra_recall` |
| Read one record in full | `veyra_inspect` |
| Write a grounded record | `veyra_remember` |
| Lift a candidate to derived | `veyra_promote` (never canonical) |
| Verify the result | `veyra_health` |
| Relationships and contradictions | Maintained automatically by Veyra's evolution; visible via inspect and recall banners — never managed by hand. |

For parameter-level tool reference, load the bundled `veyra` skill — this skill
deliberately does not duplicate it.

## Evidence rules

- Current evidence outranks everything else.
- Documentation that disagrees with the code **is itself a durable finding
  (doc drift)**, not a tie to break silently.
- **Historical evidence ≠ current truth.** Store old facts as "what was true
  *until when*", never as a bare present-tense claim.
- Conflicting evidence: never pick a winner from similarity or recency alone.
  If the repository cannot settle it, record both sides visibly or hold and ask.
- Inference must be labeled "inferred from X" and carry low confidence.
- **Uncertainty is a valid output.**

**Hold.** Veyra has no quarantine state, and you must not invent one. Holding
means: store nothing, or store with explicit unverified framing, low confidence,
and an evidence note saying exactly what is missing — then surface it to the
user as an open question. Never upgrade held knowledge by repetition.

## Completion criteria

- The scenario and depth were assessed and stated.
- The baseline checklist is answerable from recall alone.
- Every record has evidence anchors or explicit unverified framing.
- No duplicates were created; contradictions remain visible on both sides.
- No canonical promotion was attempted.
- Open questions and held items were reported.
- The original task is unblocked.

## Stop conditions

Stop investigating when further digging would not change a record or a
decision. Stop writing when a candidate has no anchor. Stop and ask when the
evidence is genuinely unresolvable, when the repository contradicts the user's
premise, or when a needed source is unavailable. In every case, say what you
could not establish and why.

## Failure and recovery

- **Recall fails or returns nothing.** Report it and continue; an unavailable
  memory service never blocks onboarding.
- **Write fails.** Report the failure with the record's intended content and
  anchor, and continue the original task. Do not silently drop it.
- **A premise turns out to be false** (the project is not what the user said,
  a module does not exist). Say so plainly, with the evidence, before
  proceeding. Do not build a baseline on a premise the repository contradicts.
- **The repository is far larger than the budget allows.** Narrow to the area
  the task touches, record that the rest is unbootstrapped, and say so.
