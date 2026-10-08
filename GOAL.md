# Veyra — Phase 3 Goal

## Automatic Change-Aware Context

### Direction

```text
AI Coding Agents
    ↓
Repository Intelligence
    ↓
Change Intelligence
    ↓
Trusted Context
    ↓
Automatic Change-Aware Context
```

Phase 1 implemented Change Intelligence.

Phase 2 implemented Change-Aware Trusted Context.

Phase 3 connects the existing repository change signal to the existing agent context injection path.

The goal is:

> **When the repository changes, Veyra should be able to expose the resulting trust impact to the coding agent context without requiring the agent to manually call `veyra_change_impact`.**

---

# Primary Goal

Connect the existing:

```text
RepositoryWatcher / existing change signal
        ↓
Change Impact
        ↓
Trust Classification
        ↓
Ambient Agent Context
```

Do not redesign repository watching.

Do not create a second event system.

Do not create a new background daemon.

Reuse the existing Veyra watcher, lifecycle, context injection, and Change Intelligence primitives.

---

# Required Behavior

When Veyra receives an existing repository change event:

1. Identify the changed files using the existing change mechanism.
2. Evaluate the change using existing Change Intelligence.
3. Classify affected knowledge using existing trust classification.
4. Make the resulting change-aware context available through the existing ambient context injection path.
5. Preserve all existing trust and authority rules.

The agent should not need to manually invoke:

```text
veyra_change_impact
```

for the ambient context to become change-aware.

---

# Context Behavior

Ambient context should clearly distinguish:

```text
TRUSTED
REVIEW_REQUIRED
STALE
CONTRADICTED
INSUFFICIENT_EVIDENCE
```

Only include classifications supported by actual evidence.

Do not fabricate change impact.

Do not treat absence of change information as evidence that knowledge is current.

When no usable change signal exists, preserve the existing context behavior rather than inventing a change state.

---

# Change State

The ambient context may expose a concise change summary such as:

```text
Repository changes detected:
- src/auth/middleware.mjs

Knowledge impact:
- 2 review required
- 1 stale
- 5 trusted
```

The exact presentation should follow existing Veyra context conventions.

Do not expose unnecessary internal implementation details.

---

# Existing Architecture

Reuse:

* existing `RepositoryWatcher`
* existing plugin lifecycle
* existing change events/signals
* `veyra_change_impact`
* `classifyRecordTrust`
* existing freshness logic
* existing retrieval
* existing applicability / temporal logic
* existing authority / validation logic
* existing context injection
* existing project isolation

Do not introduce:

* another watcher
* another event bus
* another context system
* another retrieval engine
* persistent trust state
* a processing ledger unless strictly required for correctness

---

# Canonical Safety

Repository changes may automatically affect **context**.

They must never automatically modify canonical truth.

The following remain forbidden:

```text
Change
  ↓
Automatic canonical update
```

```text
Change
  ↓
Automatic promotion
```

```text
Change
  ↓
Silent rewrite
```

Automatic behavior may only produce:

```text
Change
  ↓
Impact
  ↓
Trust classification
  ↓
Agent context
```

---

# State Freshness

Trust classification should remain a read-time projection.

Do not persist trust state merely because a repository changed.

The current repository state must remain authoritative.

If the repository changes again, context should be recalculated using the latest available change information.

---

# Degraded Behavior

If Code Intelligence is unavailable:

* preserve existing degraded behavior
* expose insufficient evidence where appropriate
* allow safe path-based matching when supported
* never fabricate symbol or call-graph relationships
* never claim stronger confidence than the available evidence supports

If the watcher/change signal itself is unavailable:

* Veyra must continue operating normally
* do not fabricate changed files
* preserve normal context behavior

---

# Isolation

Change-aware ambient context must remain scoped to the current project/workspace.

A repository change from Project A must never affect:

* Project B
* another workspace
* unrelated repositories
* unrelated reusable/global knowledge

unless existing Veyra scope rules explicitly permit it.

Fail closed when scope cannot be established safely.

---

# Tests

Add focused tests for:

### 1. Watcher → Context

An existing repository change event can reach ambient context.

### 2. Changed Files

Changed files are propagated correctly.

### 3. Impact

Affected knowledge is classified using existing Change Intelligence.

### 4. Trust

Stale/review-required/contradicted knowledge is exposed correctly.

### 5. Unchanged Context

When no change signal exists, existing context behavior remains unchanged.

### 6. Repeated Changes

Repeated processing does not create duplicate state or accumulate stale context.

### 7. Latest Change

A newer repository change replaces or supersedes obsolete ambient change information safely.

### 8. Isolation

Change events cannot leak across projects/workspaces.

### 9. Degraded Code Intelligence

Missing Code Intelligence does not cause fabricated context.

### 10. Canonical Safety

Automatic context propagation never modifies canonical memory.

### 11. Existing Regression Suite

All existing tests continue to pass.

---

# Scope Boundary

Do NOT implement:

* watcher redesign
* new event bus
* background daemon
* persistent trust-state database
* embeddings
* vector database
* graph database
* new retrieval engine
* security scanning
* automatic canonicalization
* automatic promotion
* agent framework
* dependency upgrades
* portfolio changes
* unrelated refactoring

Do not expand the tool surface unless the existing architecture genuinely requires it.

`veyra_change_impact` already exists and should remain the explicit/manual inspection interface.

---

# Definition of Done

Phase 3 is complete when:

1. Existing repository change signals reach ambient context.
2. Changed files are propagated correctly.
3. Existing Change Intelligence evaluates their impact.
4. Existing trust classification is reflected in ambient context.
5. The agent no longer needs to manually call `veyra_change_impact` to receive basic change-aware context.
6. No canonical memory is automatically modified.
7. No persistent trust state is required.
8. Existing watcher behavior remains intact.
9. Project/workspace isolation remains intact.
10. Degraded behavior remains safe.
11. Repeated changes do not accumulate incorrect context.
12. Focused Phase 3 tests pass.
13. The complete Veyra test suite passes.

---

# Success Criterion

The practical question is:

> **When a coding agent changes repository code, can Veyra automatically expose the relevant trust impact in the agent's existing context without changing what Veyra considers canonical truth?**

If yes, Phase 3 is complete.

---

# Future Direction

After Phase 3:

```text
Repository Change
        ↓
Automatic Impact
        ↓
Automatic Trust Context
        ↓
Agent-aware Engineering Intelligence
```

Only after this pipeline is stable should deeper capabilities be considered:

* richer historical change analysis
* deeper graph impact analysis
* security risk analysis
* AI-generated code security
* research-oriented risk prioritisation
