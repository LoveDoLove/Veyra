# Veyra — Phase 2 Goal

## Direction

**AI Coding Agents → Repository Intelligence → Change Intelligence → Trusted Context**

Phase 1 established Change Intelligence:

```text
Code Change
    ↓
Affected Knowledge
    ↓
Freshness / Review Signal
```

Phase 2 connects this capability to agent context.

The goal is:

> **When repository code changes, Veyra should help a coding agent distinguish trustworthy context from context that may require review.**

---

# Primary Goal

Build the smallest production-quality **Change-Aware Trusted Context** capability using the existing Veyra architecture.

Target flow:

```text
Code Change
    ↓
Change Impact
    ↓
Affected Knowledge
    ↓
Freshness / Authority / Applicability
    ↓
Trusted Context Result
    ↓
Agent
```

The output must help an agent understand:

* what knowledge is relevant
* what knowledge is still trustworthy
* what knowledge may be stale
* what knowledge requires review
* why the knowledge received that status

---

# Core Rule

Change-aware context must **not** create a second truth system.

The existing Veyra rules remain authoritative.

In particular:

```text
Candidate ≠ Canonical
Similarity ≠ Authority
Similarity ≠ Applicability
Historical Memory ≠ Current Truth
Memory ≠ Executable Instruction
```

Change Intelligence may affect context selection.

It must not silently promote, rewrite, merge, or delete canonical knowledge.

---

# Phase 2 Capability

Extend the existing Change Intelligence result into an explicit trusted-context result.

For a given repository change and context query, Veyra should be able to classify relevant knowledge into categories such as:

```text
TRUSTED
REVIEW_REQUIRED
STALE
CONTRADICTED
INSUFFICIENT_EVIDENCE
```

Use existing validation, authority, applicability, temporal, relation, and freshness information.

Do not introduce a new truth model merely to represent these categories.

If existing enums or result types already express the distinction, reuse them.

---

# Context Selection

The system should prefer knowledge that has stronger evidence and applicability.

Conceptually:

```text
Relevant
    +
Applicable
    +
Fresh
    +
Sufficient Authority
    ↓
Trusted Context
```

Knowledge that is relevant but stale or uncertain must remain visible as such.

Do not silently discard uncertainty.

---

# Explainability

Every change-aware context result should provide enough information to understand why a record was included or excluded.

For example:

```text
Knowledge:
    K123

Status:
    REVIEW_REQUIRED

Reason:
    Related repository file changed

Evidence:
    file anchor match

Freshness:
    stale

Authority:
    canonical

Action:
    review before relying on this knowledge
```

The exact output structure should follow existing Veyra conventions.

Do not invent a large new explanation framework.

---

# Existing Retrieval

Reuse the existing retrieval system.

Do not create:

* a second search engine
* a second ranking system
* a vector database
* an embedding pipeline

Use existing retrieval and ranking signals where appropriate.

Change impact should act as an additional trust/context signal rather than replacing retrieval.

---

# Agent Context

The capability should be usable by coding agents through the existing Veyra interface.

Prefer extending existing tools or context injection points over creating a large new tool surface.

If an existing tool can expose the required information safely, extend it rather than creating another overlapping API.

The final agent-facing context must clearly distinguish:

```text
Trusted context
```

from:

```text
Review-required context
```

and:

```text
Insufficient evidence
```

---

# Safety

Change-aware context must never:

* automatically canonicalize candidates
* silently rewrite memories
* silently delete stale knowledge
* hide contradictions
* cross project boundaries
* treat similarity as authority
* treat historical memory as current repository truth
* fabricate code relationships when Code Intelligence is unavailable

---

# Code Intelligence Degradation

If Code Intelligence is unavailable:

```text
Change-aware context
        ↓
Reduced evidence
        ↓
Lower confidence / insufficient evidence
```

The system may still use safe direct evidence such as file anchors.

It must not fabricate symbol-level or call-graph relationships.

The degraded state must remain observable.

---

# Testing Requirements

Add focused tests for:

### 1. Trusted Context

Relevant, fresh, sufficiently authoritative knowledge can be returned as trusted context.

### 2. Changed Knowledge

Relevant knowledge affected by a repository change is marked appropriately.

### 3. Review Required

Stale or uncertain knowledge is surfaced as requiring review.

### 4. Contradiction

Contradictory knowledge remains visible.

### 5. Candidate Safety

Candidates cannot become canonical through context generation.

### 6. Applicability

Knowledge outside the applicable project/scope is not returned as trusted context.

### 7. Temporal Validity

Expired or stale temporal knowledge is not presented as current trusted context.

### 8. Degraded Code Intelligence

Missing Code Intelligence does not produce fabricated trusted context.

### 9. Isolation

Context from another project cannot leak into the current project.

### 10. Existing Regression

All existing Veyra tests remain passing.

---

# Scope Boundary

Do not implement these in this phase:

* autonomous agent behavior
* automatic canonical promotion
* security scanning
* vulnerability detection
* embeddings
* vector databases
* graph database
* new memory architecture
* large tool surface
* watcher redesign
* dependency upgrades
* portfolio changes
* unrelated refactoring
* new external services

Do not redesign existing architecture.

---

# Definition of Done

Phase 2 is complete when:

* Change Intelligence can influence agent context selection.
* Relevant fresh knowledge can be identified as trusted.
* Potentially stale knowledge is explicitly marked.
* Contradictions remain visible.
* Applicability and temporal validity are respected.
* Authority remains authoritative.
* Candidate knowledge cannot silently become canonical.
* Code Intelligence degradation remains safe.
* Project/workspace isolation remains intact.
* Agent-facing context clearly communicates trust/review status.
* Focused Phase 2 tests pass.
* The complete existing Veyra test suite passes.

---

# Product Outcome

After Phase 2, Veyra should be able to move from:

```text
"What changed?"
```

to:

```text
"What changed, and which context should my coding agent trust?"
```

That is the intended next step toward:

```text
Repository Intelligence
        ↓
Change Intelligence
        ↓
Trusted Context
        ↓
Agent-aware Engineering Intelligence
```

The implementation must remain small, explainable, and grounded in repository evidence.
