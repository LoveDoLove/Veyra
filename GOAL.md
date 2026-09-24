# Veyra — Engineering Intelligence Goal

## Purpose

Veyra is a DSH-native engineering intelligence system that continuously observes engineering work, extracts durable knowledge, recalls relevant context, and learns from verified outcomes.

Veyra is not a generic RAG system, chat history store, or repository documentation generator.

Its purpose is to turn engineering work into **evidence-backed, reusable engineering knowledge** while preserving repository truth and explicit authority boundaries.

---

# Core Loop

Veyra's long-term goal is:

```text
observe
  ↓
understand
  ↓
remember
  ↓
recall
  ↓
apply
  ↓
learn
  ↺
```

Each stage has a distinct responsibility.

### Observe

Capture useful engineering signals from DSH turns without storing raw conversational history as memory.

Signals may include:

- touched files
- symbols
- commands
- test execution
- test results
- errors
- decisions
- claims
- outcomes

Observation must remain lightweight and non-authoritative.

---

### Understand

Transform observed signals into structured engineering meaning.

Current capabilities include:

- deterministic lexical distillation
- file extraction
- symbol extraction
- claim extraction
- deterministic test outcome detection

The next evolution is:

```text
raw engineering signals
        ↓
context
        ↓
intent
        ↓
action / decision
        ↓
cause
        ↓
outcome
        ↓
engineering lesson
```

Understanding must distinguish observed evidence from inferred relationships.

Temporal proximity alone must never be treated as proof of causality.

---

### Remember

Persist useful engineering knowledge with explicit lifecycle semantics.

Memory categories include:

```text
candidate
derived
canonical
```

Candidate observations must not automatically become durable authoritative knowledge.

Explicit promotion remains the authority boundary.

---

### Recall

Retrieve relevant engineering knowledge based on the current engineering intent.

Current retrieval uses:

- SQLite
- FTS5
- lexical relevance
- BM25-style scoring
- intent affinity
- contradiction awareness

Recall is contextual assistance, not authority.

Retrieved memory must never override repository, source code, configuration, test, or runtime evidence.

---

### Apply

Inject relevant memory into the DSH engineering context so that an agent can use previous engineering experience when solving the current task.

Injected memory is contextual guidance.

It is never authoritative merely because it was retrieved.

---

### Learn

Learn from repeated observations and verified outcomes.

Current learning includes:

- ADD
- DUPLICATE
- CONFLICT
- UPDATE
- evidence accumulation
- observation counts
- validation progression
- confidence progression
- repository evidence health
- promotion candidates

Learning must preserve:

```text
evidence ≠ authority
confidence ≠ validation
validation ≠ authority
```

Repeated evidence may strengthen knowledge but must not silently create canonical authority.

---

# Authority Model

Veyra must preserve these invariants:

```text
memory ≠ truth
retrieval ≠ authority
similarity ≠ identity
candidate ≠ derived ≠ canonical
evidence ≠ authority
confidence ≠ validation
validation ≠ authority
freshness ≠ validity
```

The repository remains authoritative for repository facts.

Source code, configuration, tests, runtime behavior, and explicit user decisions take precedence over remembered knowledge.

Canonical authority requires an explicit authority transition.

Veyra must never silently promote inferred or repeated knowledge into canonical truth.

---

# Security and Isolation

Veyra must maintain:

- project isolation
- optional reusable-memory isolation
- secret scrubbing
- candidate exclusion from normal recall
- provenance-aware knowledge
- explicit authority transitions

Memory from one project must never silently become project-local knowledge in another project.

---

# Current Release Baseline

## Veyra 0.1.6

Release:

```text
Version: 0.1.6
Commit: f880995
```

0.1.6 established:

- automatic observation
- candidate capture
- lexical distillation
- file/symbol/claim extraction
- deterministic test outcome detection
- explicit memory creation
- automatic learning
- ADD / DUPLICATE / CONFLICT / UPDATE
- evidence accumulation
- validation progression
- confidence progression
- promotion candidates
- repository evidence health
- stale/broken evidence handling
- SQLite FTS retrieval
- intent-aware retrieval
- system-prompt injection
- project isolation
- reusable memory
- secret scrubbing
- explicit canonical promotion

The 0.1.6 release is the verified baseline for subsequent development.

---

# 0.1.7 Goal — Structured Causal Engineering Understanding

## Objective

Move Veyra from isolated lexical signals toward **structured engineering experience**.

The target representation is:

```text
Problem / Symptom
        ↓
Root Cause
        ↓
Remedy / Action
        ↓
Verified Outcome
```

The purpose is not to create a generic causal graph.

The purpose is to allow Veyra to recognize bounded engineering cause/effect patterns from observable development activity.

---

# 0.1.7 Scope

Veyra should extend deterministic understanding so that compatible signals from an engineering turn can produce structured causal facets:

```text
symptom
rootCause
remedy
verifiedOutcome
```

Potential supporting context:

```text
files
symbols
commands
test results
errors
decisions
claims
timestamps / ordering
evidence anchors
```

Causal extraction must remain provenance-aware.

Every inferred relationship should retain enough evidence to explain why it was created.

---

# Causal Evidence Rules

The following distinction is mandatory:

```text
observed fact
    ≠
inferred relationship
    ≠
verified causal relationship
```

For example:

```text
test failed
→ file edited
→ test passed
```

may support a causal candidate.

It does not automatically prove:

```text
edited file = root cause
```

or:

```text
edited file = complete remedy
```

Causal confidence must therefore depend on evidence quality rather than simple temporal proximity.

---

# 0.1.7 Deterministic-First Requirement

0.1.7 must not require an LLM or external model runtime.

Preferred approach:

```text
deterministic signals
        +
explicit ordering
        +
known engineering patterns
        +
test outcomes
        +
provenance
        ↓
bounded causal candidate
```

Model-assisted distillation remains a future capability.

It must not be introduced merely to compensate for weak deterministic design.

---

# Retrieval Goal

Structured causal knowledge should improve intent-aware recall.

For example:

```text
why
→ prioritize symptom / root cause

how
→ prioritize remedy / action

what happened
→ prioritize observed outcome

did this fix it
→ prioritize verified outcome
```

Retrieval must continue to distinguish contextual memory from authoritative repository evidence.

---

# Negative Requirements

0.1.7 must NOT:

- introduce LLM runtime dependencies
- introduce embeddings
- introduce vector databases
- introduce generic RAG infrastructure
- create an opaque graph database
- silently promote causal candidates to canonical knowledge
- infer causality solely from temporal adjacency
- replace existing ADD / DUPLICATE / CONFLICT / UPDATE semantics
- break project isolation
- weaken secret scrubbing
- bypass evidence requirements
- make retrieved memory authoritative
- require a DSH Web restart
- redesign Veyra's architecture

---

# Success Criteria

0.1.7 is successful when:

### Understanding

Deterministic multi-step engineering activity can produce structured causal facets where sufficient evidence exists.

### Safety

Unrelated or weakly related signals do not create false causal relationships.

### Provenance

Causal facets can be traced back to their supporting engineering evidence.

### Learning

Existing evolution semantics continue to work without silent merges or silent canonicalization.

### Validation

A causal candidate does not become authoritative merely because it was inferred.

### Retrieval

`why` and `how` intent can surface useful causal context.

### Regression Safety

Existing 0.1.6 behavior remains intact.

---

# Future Goals

The following remain intentionally deferred until evidence justifies them:

## Model-Assisted Distillation

Use bounded model assistance for complex unstructured engineering turns where deterministic extraction is demonstrably insufficient.

Requirements:

- provenance
- uncertainty
- bounded scope
- explicit authority boundaries
- graceful failure
- controlled runtime cost

---

## Vector / Hybrid Retrieval

Consider embeddings or hybrid retrieval only after measurable lexical retrieval failures are demonstrated.

Do not introduce vector search as a feature goal by itself.

---

## Knowledge Maintenance

Future maintenance may address:

- compaction
- superseded knowledge
- long-term lifecycle management
- relationship maintenance
- stale knowledge
- storage growth

Maintenance must remain bounded and must not silently invalidate canonical knowledge.

---

# Long-Term Direction

Veyra should evolve toward:

```text
engineering activity
        ↓
observable evidence
        ↓
structured understanding
        ↓
validated engineering knowledge
        ↓
contextual recall
        ↓
better engineering decisions
        ↓
new evidence
        ↺
```

The system should become progressively more useful without becoming progressively less trustworthy.

The central design principle is:

> **Veyra may infer engineering knowledge, but evidence and explicit authority determine what can be trusted.**
