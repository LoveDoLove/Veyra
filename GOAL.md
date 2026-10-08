# Veyra — Phase 5 Goal

## Correctness Hardening After Real-Agent Validation

### Direction

Phase 4 demonstrated that Veyra's core Change Intelligence → Trusted Context pipeline works in a real DSH runtime.

Phase 5 is not a feature expansion.

It is a focused correctness-hardening phase based on issues discovered during real validation.

The goal is:

> **Remove correctness risks that can violate Veyra's existing invariants without changing the architecture or expanding scope.**

---

# Primary Goal

Fix only correctness issues that were demonstrated or directly identified during Phase 4 validation.

Priority:

1. Project / workspace isolation correctness
2. Runtime configuration correctness
3. Regression protection
4. No behavioral expansion

---

# Issue 1 — Store Cache Isolation

## Problem

`openProjectStore` currently caches stores using a project-only cache key.

Conceptually:

```text
project:${projectId}
```

This can cause two different Veyra homes in the same process to share the first opened store when they use the same project id.

That violates the intended isolation model.

## Required Behavior

Different Veyra homes must never share a cached store instance merely because they have the same project id.

Conceptually:

```text
Veyra Home A + Project X
        ≠
Veyra Home B + Project X
```

The cache identity must include the storage/home boundary required by the existing architecture.

Do not redesign storage.

Do not create another database.

Do not change canonical storage.

Make the smallest correct cache-key fix.

---

# Issue 2 — Runtime `recallLimit`

## Problem

Phase 4 identified that configured `recallLimit` does not reach the runtime.

A boot configuration such as:

```text
recallLimit: 10
```

currently results in the existing runtime limit instead of the configured value.

## Required Behavior

If `recallLimit` is an existing supported configuration field, the configured value must reach the runtime component that consumes it.

Preserve existing defaults when the option is not supplied.

Do not invent new configuration semantics.

Do not change unrelated settings behavior.

---

# Regression Requirements

Add focused tests for both issues.

## Store Cache

Verify:

* same project id + different Veyra homes → different stores;
* data from Home A cannot appear in Home B;
* closing/reopening stores preserves expected behavior;
* existing single-home behavior remains unchanged.

## Recall Limit

Verify:

* configured value reaches runtime;
* default behavior remains unchanged;
* configured lower limit is respected;
* configured higher limit is respected where the existing retrieval contract permits it.

---

# Existing Invariants

All existing Veyra invariants remain mandatory.

Especially:

```text
Project isolation
Workspace isolation
Fail-closed scope
Canonical truth safety
Validation / authority semantics
```

No fix may weaken these invariants.

---

# Scope Boundary

Do NOT:

* redesign the storage layer;
* introduce a new database;
* introduce a cache subsystem;
* redesign retrieval;
* change Change Intelligence;
* change Trust Classification;
* change RepositoryWatcher;
* change agent context semantics;
* add security scanning;
* add embeddings;
* add graph infrastructure;
* upgrade dependencies;
* modify the portfolio;
* perform unrelated refactoring.

Only fix the identified correctness issues and add regression coverage.

If an issue cannot be safely fixed within the existing architecture, document it instead of expanding the architecture.

---

# Verification

Run:

1. focused tests for store isolation;
2. focused tests for recallLimit;
3. relevant existing regression tests;
4. complete `npm test`.

No Phase 4 behavior should regress.

The following must remain true:

```text
Change Intelligence        → unchanged
Trust Classification       → unchanged
Ambient Context            → unchanged
Canonical Safety           → unchanged
Project Isolation          → stronger
```

---

# Definition of Done

Phase 5 is complete when:

* Veyra store caching respects the Veyra-home boundary;
* different homes cannot accidentally share a cached project store;
* configured `recallLimit` reaches runtime;
* existing default behavior remains intact;
* regression tests cover both issues;
* Phase 1–4 tests continue passing;
* full test suite passes;
* no unrelated architecture or feature changes are introduced.

---

# Guiding Principle

> **Do not add more intelligence until the existing intelligence is trustworthy at its boundaries.**
