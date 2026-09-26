---
name: legacy-onboarding
description: >
  Onboard an unfamiliar, legacy, or not-yet-baselined project into Veyra.
  Assesses the existing memory baseline, discovers the repository, chooses a
  progressive investigation depth, extracts only durable engineering knowledge
  grounded in verifiable evidence, and builds a Project Memory Baseline that
  future agents can recall instead of re-investigating. Load it the first time
  you work in an old or foreign codebase, when asked "what is this project /
  how does this work" with no baseline available, before high-risk legacy
  changes (auth, data, infrastructure, migrations), or when existing Veyra
  memory looks stale. Skip it for trivial tasks in projects that already have
  a good baseline.
whenToUse: >
  First entry into a new, legacy, or unfamiliar project; a missing or stale
  Veyra baseline; high-risk changes to old systems; or an explicit request to
  understand or onboard an unfamiliar repository.
---

# Legacy Project Onboarding

Turn an unfamiliar project into a stable **Project Memory Baseline**: a small
set of high-value, evidence-anchored Veyra records answering what this project
is, how it is built, what constrains it, and what must not be broken — so the
next agent recalls instead of re-discovering.

**Ownership boundary.** This skill owns decisions: *whether* to investigate,
*how deep*, *what* to extract, *how* to ground it, *when to stop*. Veyra Core
owns storage, lifecycle, validation, promotion, relationships, recall, and
project isolation. Never reimplement any of that here, never invent states or
commands Veyra does not have, and never duplicate Veyra's tool documentation —
load the bundled `veyra` skill for tool reference.

Onboarding is **progressive, not ceremonial**: it runs when there is genuine
knowledge to gain, deepens only where risk justifies it, and always yields to
the actual task.

## Trigger and applicability

Use when any of these holds:

- First substantive work in this project and Veyra has no (or thin) baseline.
- Existing memory exists but current repository evidence suggests it drifted.
- The task will modify high-risk legacy areas (authentication, database,
  infrastructure, core APIs, migrations, compatibility shims, long-lived
  workarounds, large deletions).
- The user explicitly asks to onboard, survey, or explain this repository.

Do **not** use when:

- The task is trivial (typo, small UI tweak, obvious one-line fix) — work
  normally and let Veyra's automatic observation capture anything durable.
- A reliable baseline already answers the current task — recall, top up only
  what the task needs, and continue. Re-onboarding a known project is waste.

### Scenario routing

| Situation | Action |
| --- | --- |
| A. No baseline (first entry) | Run the workflow; Standard depth (Shallow if the task itself is trivial) |
| B. Solid baseline exists | Recall first; judge staleness; investigate only what the current task adds |
| C. Baseline exists but looks stale | Compare recalled claims to current repository evidence; update or supersede — never blind-duplicate |
| D. High-risk legacy change | Escalate to Deep (targeted) before touching the system |
| E. Trivial task | Shallow; run no archaeology; store nothing unless something durable surfaces on its own |

## Depth control

Depth is chosen per task, announced in one line before investigating, and
re-evaluated when the task's risk changes. Default is the lowest depth that
answers the task.

- **Shallow** — current project structure, relevant files, current
  configuration, ambient Veyra context. No history digging.
- **Standard** — adds relevant documentation, architecture of the touched
  area, recent git history for those paths, existing recorded decisions.
- **Deep** — adds targeted archaeology: major migrations, reverts,
  compatibility constraints, deprecated systems, incident-driven fixes,
  long-lived workarounds, and pivotal architectural decisions **that bear on
  the change at hand**. Deep is always targeted; never sweep the whole history
  because the project is old.

Escalate one level when the task touches shared state, public contracts, or
data lifecycles. Go straight to Deep for the high-risk list above. De-escalate
as soon as the risk is contained.

## Workflow

`Assess → Discover → Investigate → Extract → Ground → Validate → Record or
Hold → Baseline → Continue`

1. **Assess.** Read the injected Veyra context; query the baseline
   (`veyra_recall` on project identity / architecture / stack / constraints,
   or `/veyra` for record counts). Classify the situation (A–E) and pick a
   depth. A baseline that is current, substantive, and covers the task means
   scenario B: skip discovery and go straight to targeted investigation.
2. **Discover.** Establish what the project *is*: README/docs, manifests and
   lockfiles, configuration, entry points, directory layout, tests, CI, and
   agent instruction files (AGENTS.md/CLAUDE.md and friends). Confirm doc
   claims against code — code is the authority.
3. **Investigate.** At the chosen depth, gather history only where it matters:
   git log/blame on the touched paths, migration and revert commits, changelogs,
   decision records, config evolution. Note *when* things changed, not just
   *that* they changed.
4. **Extract.** Select only knowledge with long-term engineering value:

   **Record:** architecture decisions and their rationale; system and
   compatibility constraints; important migrations (from → to, when, what broke);
   legacy behavior that still ships; known workarounds and why they exist;
   recurring incidents; security-sensitive design constraints; deployment
   constraints; non-obvious dependencies; decisions whose original author and
   reason are gone.

   **Skip:** routine implementation details, one-off debug findings, commit
   messages without durable content, anything the code already states plainly,
   restatements of existing memory, and speculation.
5. **Ground.** Anchor each item to evidence, strongest available first:

   ```text
   current repository file → verified project documentation → git commit
   → tests / CI evidence → historical artifacts → agent inference
   ```

   Inference is the weakest anchor and never stands alone as fact.
6. **Validate.** Check every item against the current repository:
   **confirmed** → ready to record; **contradicted** → repository wins, and if
   the old behavior still matters, record it explicitly as historical rather
   than deleting it silently; **unverifiable** → hold as uncertainty (below).
7. **Record or Hold.** Before writing anything: `veyra_recall` the same topic
   and compare. Prefer *recall → compare → update/extend/relate* over blind
   add.

   | Finding | Action |
   | --- | --- |
   | Already exists, unchanged | Do not write again |
   | Existing claim + new nuance | Write the extension; Veyra links it |
   | My claim reflects newer repo state | Write it; Veyra's evolution links the two and demotes the stale claim where its lifecycle allows |
   | My claim conflicts with existing memory | Repo decides; if genuinely unresolved, keep both sides visible and hold |
   | Knowledge is historical, not current | Write it *framed as historical* (see Evidence rules) |
   | Evidence too weak | Hold — do not force it into memory |

   When writing (`veyra_remember`): project scope unless the lesson is truly
   project-agnostic; `knowledge` for project documentation, decisions, and
   constraints; `memory` for engineering lessons; short stable tags; honest
   confidence (low when thin); evidence anchors for every claim. Use
   `veyra_promote` only to lift a useful candidate to **derived**; never to
   canonical. **Canonical is never yours to grant** — it requires an explicit
   user action; never call promote with canonical/`explicit` yourself.

   **Hold (quarantine in practice).** Veyra has no quarantine state, and you
   must not invent one. Holding means: store nothing, or store with explicit
   "unverified" framing, low confidence, and evidence noting exactly what is
   missing — then surface it as an open question to the user. Never upgrade
   held knowledge by repetition.
8. **Baseline.** A completed baseline is a recallable *set* of focused
   records, not one giant project summary. It is done when a future agent,
   using only recall, can answer:

   ```text
   What is this project?  Current main stack?  Major architecture?
   Where are the key modules?  Important architectural decisions?
   Legacy constraints?  Which historical facts still affect the system?
   Known workarounds?  Which knowledge is verified vs uncertain?
   What must be checked before touching the core?
   ```

9. **Continue.** Return to the actual task. On later visits, recall first and
   investigate only deltas.

## Veyra integration

Use existing capabilities only — this skill adds no storage, no lifecycle,
and no second workflow:

| Need | Capability |
| --- | --- |
| Existing project context | Injected Veyra recall snapshot at session start; `/veyra` for baseline counts |
| Targeted search beyond the snapshot | `veyra_recall` |
| Read one record with evidence and links | `veyra_inspect` |
| Add knowledge | `veyra_remember`, with evidence anchors and honest confidence |
| Correct a record's standing | `veyra_promote` → derived only; canonical requires an explicit user action, never you |
| Relationships and contradictions | Maintained automatically by Veyra's evolution; visible via inspect and recall banners — never managed by hand |
| Human review of what was stored | `/veyra` and its Observatory subcommands |

For parameter-level tool reference, load the bundled `veyra` skill — this
skill deliberately does not duplicate it.

## Evidence rules

- **Current evidence outranks everything.** A claim about *now* must point at
  the current repository. Documentation that disagrees with code is itself a
  durable finding (doc drift), not a tie to break silently.
- **Historical evidence ≠ current truth.** Old facts (e.g. "the datastore is
  MongoDB" from 2021, superseded by a 2024 PostgreSQL migration) are stored
  framed as historical — title/body say what was true *until when*, and the
  current state is stored separately from current evidence. Never store an old
  state as a bare present-tense claim. Veyra's own lifecycle (superseded
  status, update/supersedes links, contradiction banners) then keeps both
  sides visible without any extra mechanism from you.
- **Conflicting evidence.** Never pick a winner from similarity or recency
  alone. Verify against the repository; if the repo cannot settle it, record
  both sides visibly (Veyra keeps contradictions banner-visible) or hold and
  ask the maintainer.
- **Inference.** Label it. Write "inferred from X" in the body, use low
  confidence, and attach whatever anchor exists. Inference without support is
  reported to the user, not remembered as fact.
- **Uncertainty is a valid output.** Stop-condition knowledge (below) stays
  uncertain on purpose. Completing onboarding never outranks preserving doubt.

## Completion criteria

- Scenario (A–E) and depth were assessed and stated.
- The baseline checklist above is answerable from recall alone.
- Every stored record carries evidence anchors, or is explicitly framed as
  unverified with low confidence.
- No duplicate records of existing knowledge; contradictions are visible on
  both sides; no canonical promotions were attempted.
- Open questions and held items were reported to the user.
- The original task is unblocked — onboarding never becomes the blocker.

## Stop conditions

Stop inferring and preserve the uncertainty when any of these appears:

- Evidence for a claim is insufficient or single-source weak (inference only).
- Historical sources contradict each other and the repository cannot settle it.
- You cannot determine whether a historical behavior or constraint still applies.
- A compatibility constraint seems to exist but cannot be verified.
- An architectural decision's current validity is unknowable from available material.
- The decision genuinely belongs to the user or a maintainer.

In each case: state what is known, what is unknown, and what evidence would
resolve it — then ask or proceed with the task. Do not manufacture certainty
to "finish" onboarding.

## Failure and recovery

- **Veyra unavailable or a tool errors** — degrade to plain repository
  investigation; do the task; report that the baseline could not be written so
  it can be retried later. Never loop retrying, never fake stored records.
- **Project identity unclear** (no git, odd layout) — proceed anyway; Veyra
  attaches memory to the workspace project automatically. Note the limitation.
- **Git history missing, squashed, or shallow** — say so, rely on current
  evidence plus documentation, and skip historical claims entirely rather
  than guessing them.
- **Evidence runs out mid-extraction** — drop to the next lower depth, hold
  the unsupported items, and finish with an honest uncertainty list.
- **Baseline already exists but is wrong** — repository truth wins; write the
  corrected claim so Veyra supersedes the stale one. Do not edit around it or
  create parallel copies.
