# Veyra — Engineering Goal

## Direction

**AI Coding Agents → Repository Intelligence → Change Intelligence → Trusted Context**

Veyra is an engineering intelligence layer for coding agents.

Its purpose is not to become another memory system, code search engine, or autonomous agent framework.

Veyra should help coding agents understand:

1. what the repository knows,
2. what the repository changed,
3. which knowledge may be affected,
4. which knowledge is still trustworthy,
5. what context can safely be provided to the agent.

---

# Current Position

Veyra already provides the foundation for:

* structured memory
* knowledge and evidence
* negative and unresolved knowledge
* validation states
* authority levels
* confidence
* scope and project isolation
* temporal applicability
* relations
* contradiction and supersession
* FTS5-based retrieval
* hybrid retrieval signals
* code intelligence integration
* graceful degradation
* DSH integration

The current system can answer questions similar to:

> **"What does this repository know?"**

The next capability must answer:

> **"What changed, and what knowledge might no longer be trustworthy because of that change?"**

---

# Primary Goal

## Build Change Intelligence

Implement the smallest production-quality Change Intelligence capability using the existing Veyra architecture.

The target flow is:

```text
Repository / Code Change
        ↓
Change Observation
        ↓
Affected Code / Knowledge Detection
        ↓
Applicability / Temporal Evaluation
        ↓
Potentially Stale / Review-Required Knowledge
        ↓
Explicit Change-Impact Result
        ↓
Human / Agent Validation
        ↓
Canonical update only when existing authority rules permit
```

The critical rule is:

> **A code change must never automatically become canonical memory.**

Change detection produces evidence and candidates.

It does not bypass Veyra's existing truth, validation, authority, or isolation model.

---

# Phase 1 — Change Observation

Veyra must be able to represent a repository/code change using existing primitives where possible.

A change should be represented as an observation or change signal containing enough information to reason about its impact.

At minimum, the system should be able to distinguish:

* changed files
* changed code areas when available
* repository/project scope
* change identity
* processing state

Do not introduce a second change database.

Do not create a competing graph.

Reuse existing Veyra storage and relation mechanisms.

---

# Phase 2 — Change Impact

Given a change, identify potentially affected knowledge.

Use existing:

* code intelligence
* relations
* retrieval
* applicability
* temporal information
* project/workspace scope
* knowledge metadata

The system should be able to produce an explicit result such as:

```text
Change
  ↓
Affected code
  ↓
Related knowledge
  ↓
Impact assessment
```

Possible outcomes include:

* unaffected
* potentially affected
* stale candidate
* review required
* insufficient evidence

The result must remain explainable.

Veyra should be able to show **why** knowledge was considered affected.

---

# Phase 3 — Staleness and Review Signals

When a change conflicts with or potentially invalidates existing knowledge:

* do not silently rewrite the knowledge
* do not silently delete it
* do not silently promote a new candidate
* do not silently merge conflicting information

Instead, produce an explicit signal.

For example:

```text
Knowledge K
    ↓
Related to changed code
    ↓
Current applicability uncertain
    ↓
Review required
```

Existing validation states and authority levels must remain authoritative.

A change may cause knowledge to become:

* potentially stale
* review-required
* contradicted
* invalid

only through the existing Veyra rules.

---

# Phase 4 — Candidate Updates

Change Intelligence may identify candidate updates.

Examples:

```text
Existing knowledge:
"Module A uses Redis for session storage."

Code change:
Module A session storage implementation changed.

Result:
Candidate:
"Module A may no longer use Redis for session storage."

Status:
Candidate / Unverified
```

The candidate must not become canonical automatically.

Canonical promotion must continue to require the existing validation and authority rules.

---

# Phase 5 — Safe Reprocessing

Processing the same change repeatedly must be safe.

Repeated processing must not create:

* duplicate state
* duplicate memories
* silent merges
* conflicting canonical records
* unbounded derived records

Change processing should be deterministic or idempotent where practical.

A repository change should have a stable identity when the available source permits it.

---

# Core Invariants

All existing Veyra invariants remain mandatory.

## Truth

```text
Observation ≠ Store
Candidate ≠ Truth
Similarity ≠ Authority
Similarity ≠ Applicability
Historical Memory ≠ Current Truth
Memory ≠ Executable Instruction
```

## Authority

Automatic processing must never bypass:

* validation
* authority
* contradiction handling
* supersession
* canonical promotion rules

## Repository Authority

Repository truth remains authoritative.

Memory must not override verified repository evidence.

## Isolation

All change intelligence must preserve:

* project isolation
* workspace isolation
* reusable/global isolation
* fail-closed behavior

A change from one project must never affect knowledge belonging to another project.

## Security

All existing secret-scrubbing and sensitive-data protections remain unchanged.

Do not weaken them for change processing.

## Degradation

If Code Intelligence is unavailable:

* Veyra must continue operating safely
* the change signal may remain incomplete
* the system must expose the limitation
* it must not fabricate affected-code relationships

---

# Retrieval Integration

Change Intelligence should reuse the existing retrieval system.

Do not create a separate retrieval engine.

Existing signals may be used to identify related knowledge, including:

* lexical relevance
* BM25
* token overlap
* intent
* relations
* applicability
* temporal relevance
* authority
* validation
* code intelligence

The change-impact result must remain explainable.

The system should prefer:

```text
Evidence + relation + applicability
```

over:

```text
Similarity alone
```

---

# Code Intelligence Integration

Code Intelligence remains an external capability.

Veyra should reuse the existing Code Intelligence integration.

Do not embed another code analysis engine into Veyra.

If the external code intelligence binary is unavailable:

```text
Change detected
    ↓
Code impact analysis unavailable
    ↓
Return limited / insufficient-evidence result
```

Never fabricate code relationships.

---

# Testing Requirements

Change Intelligence is not complete until it has focused regression coverage.

At minimum, tests must verify:

### 1. Unrelated Change

An unrelated code change does not affect unrelated knowledge.

### 2. Related Change

A relevant code change can identify potentially affected knowledge.

### 3. Stale Knowledge

Potentially stale knowledge is surfaced explicitly.

It is not silently rewritten.

### 4. Candidate Safety

A detected update remains candidate/unverified unless existing rules permit promotion.

### 5. Canonical Safety

Change processing cannot bypass canonical authority.

### 6. Contradiction Visibility

Conflicting evidence remains visible.

### 7. Isolation

A change in Project A cannot affect Project B.

### 8. Degraded Code Intelligence

Missing Code Intelligence does not cause fabricated results or unsafe failures.

### 9. Reprocessing

Processing the same change repeatedly does not create duplicate or silently merged state.

### 10. Existing Regression Suite

All existing Veyra tests continue to pass.

---

# Scope Boundary

The following are explicitly **out of scope** for this phase.

Do not implement them unless they are directly required by Change Intelligence.

* new database
* graph database
* embeddings
* vector database
* new memory system
* autonomous agent framework
* swarm / hive architecture
* automatic canonicalization
* speculative security scanner
* full static-analysis engine
* large new tool surface
* portfolio changes
* DSH Web restart/replacement
* dependency upgrades
* unrelated refactoring
* secrets/config changes
* architecture rewrite

Do not solve future problems before the current Change Intelligence capability works.

---

# Implementation Principle

Prefer:

```text
Existing primitive
        ↓
Small extension
        ↓
Focused tests
        ↓
Verified behavior
```

over:

```text
New abstraction
        ↓
New subsystem
        ↓
Migration
        ↓
More complexity
```

Reuse existing Veyra primitives wherever they already express the required behavior.

Do not redesign working architecture merely to make the new capability look cleaner.

---

# Definition of Done

Phase 1 is complete when:

* Veyra can represent a repository/code change.
* Veyra can identify potentially affected knowledge using existing mechanisms.
* Veyra can produce an explicit change-impact result.
* Potentially stale knowledge is surfaced.
* Candidate updates remain candidates.
* Canonical truth cannot be bypassed.
* Contradictions remain visible.
* Project/workspace isolation remains intact.
* Code Intelligence failure degrades safely.
* Reprocessing is safe.
* Focused Change Intelligence tests pass.
* The complete existing test suite passes.
* No unrelated architecture or project changes are required.

---

# Next Direction

Once Change Intelligence is stable, the next progression is:

```text
Repository Intelligence
        ↓
Change Intelligence
        ↓
Change → Knowledge Impact
        ↓
Trusted Context
        ↓
Agent-aware Context
```

The long-term goal is for Veyra to help a coding agent understand:

```text
What is true?
What changed?
What may now be stale?
What evidence supports it?
What context is safe to use?
```

This is the core engineering direction.

---

# Long-Term Research Direction

A future research direction may connect Veyra with:

**AI-generated code security**

The intended relationship is:

```text
AI Coding Agents
        ↓
Generated / Modified Code
        ↓
Repository Change Intelligence
        ↓
Affected Knowledge / Components
        ↓
Risk / Trust Analysis
        ↓
Security Review Prioritisation
```

This is a later research direction, not part of the current implementation phase.

Do not prematurely turn Veyra into a security scanner.

The immediate objective is to make Change Intelligence correct, explainable, isolated, and trustworthy.

---

# Guiding Principle

> **Veyra should not merely remember what happened.**
>
> **Veyra should understand when repository changes make previously known information less trustworthy — and expose that uncertainty without pretending it is truth.**
