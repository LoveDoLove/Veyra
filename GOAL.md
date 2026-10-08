# Veyra — Phase 4 Goal

## Real Coding-Agent Validation

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
Real Agent Validation
```

Phases 1–3 established the technical pipeline:

```text
Repository Change
    ↓
Change Signal
    ↓
Change Impact
    ↓
Trust Classification
    ↓
Ambient Agent Context
```

Phase 4 validates whether this pipeline provides useful information to a real coding-agent workflow.

This phase is primarily a **validation phase**, not a feature-expansion phase.

---

# Primary Goal

Demonstrate that Veyra's change-aware context helps a coding agent avoid relying on knowledge that may no longer be trustworthy after a repository change.

The practical question is:

> **When an agent changes code, does Veyra help the agent recognize affected or stale knowledge and verify it before relying on it?**

---

# Validation Method

Use the existing Veyra repository and existing coding-agent integration.

Do not create a synthetic architecture solely for testing.

Each scenario should follow:

```text
Initial Repository State
        ↓
Known Veyra Knowledge
        ↓
Agent / Code Change
        ↓
RepositoryWatcher
        ↓
Change Intelligence
        ↓
Trust Classification
        ↓
Ambient Agent Context
        ↓
Agent Decision
```

The validation should inspect the actual context exposed to the agent.

---

# Scenario A — Relevant Change

Create a controlled repository change that affects code referenced by existing Veyra knowledge.

Expected behavior:

```text
Changed code
    ↓
Affected knowledge detected
    ↓
Knowledge becomes review_required / stale
    ↓
Ambient context exposes the warning
```

Verify that:

* the affected knowledge is identified;
* the trust state is correct;
* the reason is understandable;
* the agent can recognize that the knowledge requires verification;
* canonical memory remains unchanged.

---

# Scenario B — Unrelated Change

Make a repository change that is unrelated to existing knowledge.

Expected behavior:

```text
Unrelated code change
    ↓
Unrelated knowledge remains trusted
```

Verify that:

* unrelated knowledge is not incorrectly marked stale;
* no false change impact is reported;
* ambient context does not introduce unnecessary warnings.

---

# Scenario C — Assumption-Breaking Change

Create a change that directly invalidates an existing engineering assumption.

For example:

```text
Existing knowledge:
"Component A uses implementation X."

Repository change:
Component A is changed to implementation Y.
```

Expected behavior:

```text
Old assumption
    ↓
Repository change
    ↓
REVIEW_REQUIRED / STALE
    ↓
Agent is warned before relying on old knowledge
```

Verify that the agent-facing context clearly communicates:

* what knowledge is affected;
* why it is affected;
* what action is appropriate.

---

# Scenario D — Degraded Code Intelligence

Run an equivalent relevant-change scenario with Code Intelligence unavailable.

Expected behavior:

```text
Code Intelligence unavailable
        ↓
Reduced evidence
        ↓
Explicit uncertainty
```

Verify:

* path-based evidence still works where available;
* symbol/call-graph impact is not fabricated;
* insufficient evidence is visible;
* no unsafe trust escalation occurs.

---

# Scenario E — Canonical Safety

For every scenario verify:

```text
Before Change
    ↓
Repository Change
    ↓
Agent Context
    ↓
After Change
```

The canonical memory store must remain unchanged unless an explicit existing Veyra write/promotion operation is invoked.

Automatic change-aware context must never modify canonical truth.

---

# Agent Evaluation

The validation should evaluate both:

## System Correctness

Whether Veyra correctly reports:

* changed files
* affected knowledge
* trust classification
* reasons
* degraded state
* project scope

## Agent Usefulness

Whether a coding agent can reasonably understand:

* which information may be stale;
* why it may be stale;
* whether verification is required;
* which information remains trustworthy.

The context should be useful without requiring the agent to understand Veyra's internal implementation.

---

# Evidence

Do not rely only on statements such as:

```text
"Test passed."
```

Collect concrete evidence from the actual workflow, such as:

* repository change;
* emitted change signal;
* ambient context;
* trust classification;
* agent-visible warning;
* canonical store state before/after;
* degraded behavior where applicable.

Keep the evidence concise and reproducible.

---

# Success Criteria

Phase 4 succeeds when the validation demonstrates:

### 1. Relevant Change Detection

A meaningful code change produces an appropriate change-aware context.

### 2. Trust Awareness

Affected knowledge is clearly marked as requiring review or being stale.

### 3. Unrelated Safety

Unrelated changes do not produce false warnings.

### 4. Agent Comprehension

A coding agent can understand the warning and recognize that verification is required.

### 5. Degraded Safety

Reduced Code Intelligence produces reduced confidence rather than fabricated confidence.

### 6. Canonical Safety

Automatic context generation does not modify canonical memory.

### 7. Isolation

The validation does not expose knowledge from another project/workspace.

### 8. Reproducibility

The scenarios can be repeated with consistent results.

---

# Scope Boundary

This phase must NOT introduce major new functionality.

Do not implement:

* new retrieval architecture
* graph impact engine
* embeddings
* vector database
* security scanner
* automatic canonicalization
* automatic promotion
* new watcher architecture
* persistent change ledger
* new agent framework
* dependency upgrades
* portfolio changes
* unrelated refactoring

If a missing capability prevents validation, document the limitation first.

Only implement a minimal fix when it is clearly required to validate an existing Phase 1–3 requirement.

---

# Deliverable

Produce a concise validation report containing:

1. scenarios executed;
2. repository changes used;
3. expected behavior;
4. observed behavior;
5. agent-visible context;
6. canonical store verification;
7. degraded-mode result;
8. failures or limitations;
9. final Phase 4 conclusion.

Do not claim success without concrete evidence.

---

# Definition of Done

Phase 4 is complete when the real coding-agent workflow demonstrates that:

```text
Code Change
    ↓
Veyra detects impact
    ↓
Veyra evaluates trust
    ↓
Agent receives useful context
    ↓
Agent can recognize uncertainty
    ↓
Canonical truth remains protected
```

At that point Veyra has demonstrated not only that Change Intelligence works technically, but that it provides meaningful value to coding agents.
