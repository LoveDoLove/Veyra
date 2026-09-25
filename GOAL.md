# Veyra — Settings & Runtime Configuration

## Goal

Make Veyra's user-adjustable runtime behavior configurable through the DSH Settings surface, while preserving Veyra's existing architecture invariants and fail-closed boundaries.

Use `dsh-approval-gate` as a reference for how a DSH plugin can expose user-facing configuration in Settings and support runtime configuration changes. Do not copy its implementation or modify Veyra's architecture to match it.

Reference:
https://github.com/moon09300731/dsh-approval-gate

## Primary Outcome

Veyra should expose a small, explicit Settings surface for behavior that users are legitimately allowed to control.

The first required setting is:

- `recallLimit`
  - `0` = disable automatic recalled-memory context
  - positive integer = maximum number of recalled records
  - default = existing `DEFAULT_RECALL_LIMIT` (`5`)
  - invalid negative values = existing safe default behavior

The setting must flow consistently through:

`DSH Settings → Veyra runtime configuration → recall → context injection`

## Initial Settings Surface

Only expose settings that represent user-level runtime preferences.

### Recall

- Recall limit
  - default: `5`
  - minimum: `0`
  - `0` means no automatic recall context

- Include reusable
  - default: existing behavior
  - controls whether reusable memories participate in recall

### Observation

If the existing runtime already exposes a user-configurable observation behavior, expose it only if it can be integrated without changing existing lifecycle semantics.

Do not invent new observation semantics merely to populate Settings.

### Graph Context

Only expose graph behavior that is already intended to be user-configurable.

Do not expose architecture safety limits as arbitrary user controls.

For example:

- Do not allow users to raise the hard graph hop ceiling beyond the existing architecture limit.
- Do not allow users to redefine relation types.
- Do not allow users to change node identity or project isolation.

## Architecture Invariants

These remain implementation-owned and are NOT user settings:

- SQLite remains the canonical memory store.
- `record.id` remains node identity.
- Existing relationship types remain authoritative.
- `isRecallEligible` remains the trust/eligibility boundary.
- Project/reusable isolation remains fail-closed.
- Graph remains a derived projection.
- No Neo4j or second graph database.
- No second identity model.
- No new relation types merely for Settings.
- Existing graph safety limits remain enforced.

Settings may control runtime behavior within these boundaries, but must never weaken the architecture.

## Recall Limit Semantics

The existing bug/ambiguity must be resolved:

```text
recallLimit = undefined → default 5
recallLimit = 5         → up to 5 records
recallLimit = 1         → up to 1 record
recallLimit = 0         → 0 records / no recall context
negative value          → safe default
```

`recallLimit = 0` must not:

- silently become `5`
- retrieve one record because of a minimum-one slice
- inject recalled memory into the agent context

This must be enforced both at runtime configuration and retrieval boundaries.

`recallLimit = 0` means **disable automatic recall context only**. It does not uninstall Veyra, remove Veyra tools, disable Observatory, delete memory, or change project isolation.

## Settings UX Requirements

Follow the DSH Settings integration pattern used by mature DSH plugins where applicable.

The UI should:

- clearly group Veyra settings
- show current values
- show safe defaults
- explain `0` as "disabled" for recall
- validate numeric bounds
- persist configuration through the supported DSH mechanism
- apply supported changes without unnecessary restart if DSH supports the required mechanism

Do not modify DSH core or global DSH configuration.

Do not require users to manually edit Veyra source code.

## Phase 6 Relationship

This milestone unblocks the Engineering Impact Experiment.

After implementation and verification:

1. Set Baseline:
   `recallLimit = 0`
2. Verify:
   `0 recalled records`
   `empty automatic Veyra context`
3. Set Veyra arm:
   `recallLimit = 5`
4. Verify normal recall.
5. Execute the five already-frozen Phase 6 tasks.
6. Only after paired measurements update architecture question Q2.

The Settings implementation itself is not evidence for Q2.

## Vision Restriction

The current `omniroute/free-stack` setup has a known vision issue.

Do not use vision/image-capable workflows, tools, or models for this milestone or the subsequent Phase 6 experiment.

All implementation and verification work must remain text/code based.

## DSH Web Safety

The existing DSH Web environment is an active environment and must not be disturbed during development verification.

Do not:

- stop it
- kill it
- restart it
- reload it
- change its port
- start a second DSH Web
- change `~/.dsh/profiles/web`
- change the Web profile runtime configuration
- uninstall/reinstall Veyra in the live Web profile

If live Settings verification cannot be performed without violating these constraints, verify through repository tests/static evidence and report the limitation. Do not work around it by modifying the live Web environment.

## Verification

Required:

- unit tests for configuration normalization
- unit tests for `recallLimit = 0`
- retrieval test proving `limit = 0` returns no records
- context test proving zero recall produces no automatic recall context
- tests for normal positive limits
- tests for default behavior
- Settings integration tests where supported
- existing `npm test`

No package version bump unless explicitly requested after implementation verification.

No commit or push automatically.

## Success Criteria

The milestone is complete only when:

1. Veyra exposes the intended user-configurable runtime settings through the DSH Settings surface.
2. `recallLimit = 0` genuinely disables automatic recall context.
3. Positive recall limits retain existing behavior.
4. Architecture invariants remain enforced.
5. Existing tests pass.
6. No DSH Web environment changes were required.
7. The implementation is documented sufficiently for future Phase 6 execution.
