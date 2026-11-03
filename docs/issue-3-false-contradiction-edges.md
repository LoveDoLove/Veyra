# Issue #3 — False Contradiction Edges from Replacement Language

**Status:** Investigation complete; implementation pending  
**Issue:** [#3 — False `contradicts` edges between unrelated records](https://github.com/LoveDoLove/Veyra/issues/3)  
**Repository:** [LoveDoLove/Veyra](https://github.com/LoveDoLove/Veyra)  
**Investigation date:** 2026-11-03

## 1. Executive summary

Issue #3 is a memory-integrity defect in Veyra's conflict classification path.

In `src/diff.mjs`, the replacement-language branch can classify two records as `DIFF.CONFLICT` solely because either record contains a replacement phrase. Unlike the polarity-mismatch branch immediately above it, this branch has no token-similarity floor and does not establish that the records describe the same subject.

The resulting false conflict can be persisted by the evolution pipeline as a `contradicts` relationship. Since contradiction has high precedence in trust classification, an unrelated record can then be reported as contradicted during recall. Promoting a record does not remove that relationship.

This is not a Code Intelligence / CBM defect. The affected behavior belongs to Veyra Memory. The immediate scope should therefore remain inside the Veyra repository.

## 2. Reproduction and root cause

The issue reporter reproduced the problem using two unrelated records from a 29-record project store:

- Record A: a cause analysis containing the phrase `rather than`.
- Record B: an unrelated TypeScript configuration fix concerning `declaration: true`.

The phrase detector recognizes `rather than` as replacement language. The records have negligible lexical overlap.

Reported observations:

- 8 of 8 top matches were classified as conflicts, with similarity scores around 0.026–0.069.
- The A/B pair was classified as conflict at similarity 0.0227.
- Their Jaccard similarity was 0.0488, below the configured conflict floor of 0.35.
- Replacing `rather than` with neutral wording removed the false conflicts.

The relevant classification shape is:

```js
if (polarityMismatch && tokenSim >= MIN_CONFLICT_SIM) {
  return DIFF.CONFLICT
}
if (replacementNew || replacementExisting) {
  return DIFF.CONFLICT
}
```

The second condition treats the presence of a phrase as sufficient evidence of contradiction. It does not require topical overlap, shared claim subject, or evidence that one claim actually replaces the other.

Replacement wording is only a linguistic signal. Phrases such as `rather than`, `instead of`, `deprecated`, `no longer`, and `switched from` can occur in explanatory prose without describing a relationship between the two records being compared.

## 3. Impact path

The defect can propagate through this path:

1. `diffMemory()` classifies an unrelated candidate/peer pair as `DIFF.CONFLICT`.
2. `evolveAgainst()` selects the strongest conflict match and adds a `contradicts` relation.
3. The relationship is persisted in the SQLite memory store.
4. Contradiction detection and trust projection consume the persisted relationship.
5. The affected record can be surfaced as `contradicted`, including in recall context.

The trust consequence is important: contradiction precedence is evaluated independently of a record's authority promotion. Setting a record to `canonical` does not repair an incorrect relationship. A false edge can therefore continue to poison trust output until the relationship itself is corrected.

The issue report also identifies a recovery gap: the public command/tool surface has no supported relation-detach operation. Soft-forgetting or promoting a record is not equivalent to removing one specific relationship.

## 4. Scope and ownership

### In scope

- Veyra's conflict classification in `src/diff.mjs`.
- The evolution path that turns a classification into a persisted relationship.
- Trust/contradiction projections affected by that relationship.
- A narrowly scoped, explicit recovery operation for incorrect relationships.
- Read-only inspection of historical relationships that may have been created by the defective classifier.
- Regression tests for classification, persistence, recovery, and trust output.

### Explicitly out of scope

- `@lovedolove/dsh-codebase-memory-mcp` (CBM): it provides structural code intelligence and is not the owner of Veyra's memory conflict classifier.
- Digital Life: no demonstrated dependency on this Veyra relationship-classification path.
- DSH host/core: no host change is required to correct Veyra's internal memory semantics.
- Automatic cleanup or deletion of existing user relationships.
- Unrelated dependency, architecture, documentation, or release changes.

## 5. Remediation plan

### Phase A — Prevent new false conflict edges

Correct the replacement-language classification so that a phrase alone cannot establish a conflict.

Requirements:

1. Replacement-language matches must not bypass the conflict similarity floor.
2. Similarity alone must not be treated as proof that two claims share a subject.
3. Where the implementation can establish claim-subject identity or an equivalent strong shared anchor, require that evidence before treating replacement wording as a conflict.
4. Preserve genuine conflicts and directional replacement/supersession behavior.
5. Do not broaden the change into a general rewrite of the diff or memory model.

A similarity-floor check is a useful minimum guard, but it should not be presented as proof of subject identity. Inspect the existing subject-matching and supersession logic before deciding whether it can be safely reused. If the current data model cannot establish the required relationship reliably, prefer a conservative non-conflict result over manufacturing a contradiction.

### Phase B — Add explicit relationship recovery

Provide a narrowly scoped, user-invoked way to detach an incorrect relationship. A command such as:

```text
/veyra unlink <id> contradicts <targetId>
```

is one possible interface; follow existing command conventions rather than adding multiple competing interfaces.

Requirements:

- Validate that both records exist and that the requested relationship is supported.
- Remove only the specified `contradicts` relationship, including its reciprocal representation where the store models it bidirectionally.
- Preserve every unrelated relationship and all record content, authority, validation, lifecycle history, evidence, and timestamps unless an existing audited mutation contract explicitly requires otherwise.
- Use a transaction and precondition checks so partial updates cannot leave an inconsistent pair.
- Return a clear before/after result.
- Never infer user intent or silently remove relationships.

Do not implement this by replacing the entire `relations` array with an empty array. Do not use `forget`, `promote`, or record deletion as a substitute for relationship repair.

### Phase C — Read-only historical audit

Add a bounded audit/report capability for existing `contradicts` edges that may have been created by the defective path.

The audit may flag candidates using low similarity, weak/missing shared-subject evidence, or replacement-language-only signals. These are review indicators, not proof that an edge is wrong.

Requirements:

- Read-only by default.
- Report both endpoints, relationship direction, relevant evidence, and why the edge was flagged.
- Do not automatically unlink, rewrite, invalidate, or demote any record.
- Keep the audit bounded and scoped to the selected project/store.
- If reliable historical provenance is unavailable, state that limitation instead of claiming an edge was definitely created by this bug.

## 6. Required regression coverage

At minimum, tests must cover:

1. **Unrelated replacement phrase:** one record contains `rather than`; an unrelated peer must not become a conflict.
2. **Other replacement phrases:** cover representative phrases such as `instead of`, `deprecated`, and `switched from`.
3. **Genuine polarity conflict:** related claims with meaningful subject overlap and opposing polarity remain detectable.
4. **Genuine replacement:** two claims about the same subject with explicit replacement evidence retain the intended directional behavior.
5. **Same file, different subject:** sharing a file path alone must not prove that two claims concern the same subject.
6. **End-to-end evolution:** the unrelated phrase must not create a persisted `contradicts` edge through `evolveAgainst()`.
7. **Trust projection:** the false-conflict reproduction must not produce a `contradicted` trust result.
8. **Unlink isolation:** unlinking one contradiction preserves all unrelated relationships and record fields.
9. **Bidirectional consistency:** both representations of a reciprocal contradiction are removed atomically.
10. **Post-recovery trust:** after an explicitly unlinked false edge, the record's trust result is recalculated without that contradiction.
11. **Safety/preconditions:** missing records, unsupported relation types, and absent edges fail clearly without partial mutation.
12. **Historical audit safety:** audit output does not mutate the store.

Run the focused tests first, then the full test suite and package checks. Add a test only when it asserts observable behavior; do not create redundant test scaffolding.

## 7. Implementation sequence and checkpoints

Keep the work finite and reviewable:

1. **Checkpoint 1 — Classifier fix:** implement Phase A and its focused regression tests; run the focused test files; commit.
2. **Checkpoint 2 — Recovery:** implement Phase B and its tests; run focused tests; commit.
3. **Checkpoint 3 — Historical audit:** implement Phase C as read-only and test non-mutation; commit.
4. **Final verification:** run the complete test suite and package checks; inspect the final diff and report exact results.

If Phase B or C requires a broader schema/API change than the existing store supports, stop and report the blocker before expanding scope. Do not compensate with direct database edits or an unreviewed migration.

## 8. Safety constraints

- No automatic deletion or repair of existing relationships.
- No silent changes to authority, validation, lifecycle state, or canonical status.
- No changes to CBM, Digital Life, DSH core, or unrelated packages.
- No live DSH Web process restart, termination, or configuration mutation for testing.
- Use isolated test data/profile for runtime verification.
- Do not publish or release unless explicitly requested.
- Do not claim completion without test output and commit references.

## 9. Completion criteria

The issue is ready for closure only when:

- Replacement-language-only text cannot create a contradiction between unrelated records.
- Genuine same-subject conflicts and intended replacement semantics remain covered by tests.
- The end-to-end evolution path does not persist the reported false edge.
- Users have an explicit, narrowly scoped way to repair an incorrect contradiction.
- Historical auditing is read-only and does not make unreviewed changes.
- Focused tests, full tests, and package checks pass.
- The final report lists changed files, commits, test commands/results, and any remaining limitations.

**Important:** Do not run an open-ended investigation loop. If a required behavior cannot be established from the existing code or tests, stop at that point, describe the uncertainty, and ask for a decision rather than repeatedly broadening the search or redesigning adjacent systems.
