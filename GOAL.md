# Veyra — 0.1.8 Goal

## Purpose

Veyra is a **DSH-native Engineering Intelligence system** that gives agents persistent, searchable, evidence-aware engineering knowledge.

Veyra combines:

- engineering memory
- RAG / knowledge-base retrieval
- hybrid search
- project and workspace context
- causal knowledge
- relationships
- evidence and provenance
- lifecycle and authority
- contradiction detection
- agent context injection
- human-facing knowledge inspection

Veyra is not limited to one retrieval technique. RAG, lexical search, semantic search, vector search, relationship traversal, and memory retrieval are mechanisms that Veyra can combine to produce useful engineering context.

The core objective is:

> **Make engineering knowledge continuously available to agents while preserving provenance, authority, lifecycle, isolation, and verification.**

---

# 1. Core Engineering Intelligence Loop

Veyra follows:

```text
Observe
  ↓
Understand
  ↓
Remember
  ↓
Retrieve
  ↓
Apply
  ↓
Verify
  ↓
Learn
```

The system should progressively transform raw engineering interactions into useful, retrievable, and appropriately trusted knowledge.

Veyra must distinguish between:

```text
observation
inference
memory
evidence
validation
authority
```

These are related but not interchangeable.

---

# 2. What Veyra Is

Veyra is:

### 2.1 Engineering Memory

Persistent knowledge derived from engineering work, including:

- decisions
- implementation discoveries
- solved problems
- failures
- fixes
- verified outcomes
- architectural relationships
- causal relationships
- project conventions
- reusable engineering knowledge

### 2.2 RAG / Knowledge Retrieval

Veyra can retrieve knowledge from indexed engineering sources.

Sources may include:

- repository documentation
- source code
- configuration
- project knowledge bases
- indexed technical documents
- engineering memory
- other explicitly supported knowledge sources

RAG is therefore a **first-class Veyra capability**.

### 2.3 Hybrid Search

Veyra should support combining multiple retrieval signals.

Conceptually:

```text
                   Query
                     │
          ┌──────────┼──────────┐
          ▼          ▼          ▼
       Lexical    Semantic    Memory
       Search      Search      Search
          │          │          │
          └──────────┼──────────┘
                     ▼
                Fusion / Rank
                     │
                     ▼
          Lifecycle / Authority
               Filtering
                     │
                     ▼
          Evidence / Provenance
                     │
                     ▼
             Agent Context
```

Hybrid Search means:

> **RAG + Engineering Memory in a single retrieval flow.**

It should allow knowledge-base information and engineering-specific context to be retrieved together.

Veyra should not assume that one retrieval technique is universally sufficient.

---

# 3. What Veyra Is Not

These distinctions describe architectural boundaries, not capability prohibitions.

### 3.1 Not Merely Generic RAG

Veyra can use RAG.

However, Veyra's purpose extends beyond retrieving documents and placing them into an LLM context.

Veyra adds:

- persistent engineering memory
- lifecycle
- authority
- evidence
- provenance
- causal knowledge
- relationships
- contradiction handling
- learning
- project isolation
- DSH-native agent integration

### 3.2 Not Merely Chat-History Storage

Veyra may learn from conversations.

However, raw conversation history is not the desired knowledge model.

Veyra should extract useful engineering knowledge from interactions rather than treating every conversation turn as equally valuable memory.

### 3.3 Not Merely a Documentation Replacement

Veyra can retrieve documentation and project knowledge.

However, documentation represents only one category of engineering knowledge.

Veyra additionally captures:

- why decisions were made
- what failed
- what fixed the problem
- what was verified
- what knowledge superseded earlier knowledge
- relationships between engineering facts

### 3.4 Not Primarily a Graph Database

Veyra may expose relationship and causal graph views.

Those relationships are projections of Veyra knowledge.

A graph database is not required to define the product's conceptual model.

### 3.5 Not Merely a Vector Database

Veyra may use embeddings and vector search where appropriate.

Vector similarity alone is insufficient to establish:

- identity
- authority
- truth
- causality
- validity
- project ownership

Semantic similarity is a retrieval signal, not an authority mechanism.

### 3.6 Not an Autonomous Agent

Veyra provides intelligence and context to agents.

The DSH agent remains responsible for acting.

Veyra should not silently become an independent autonomous actor merely because it can retrieve, analyze, or organize knowledge.

### 3.7 Not an Unconditional Source of Truth

Veyra must never treat stored memory as automatically authoritative.

Knowledge requires appropriate:

- evidence
- validation
- authority
- lifecycle state
- provenance

---

# 4. Core Invariants

The following distinctions are fundamental:

```text
memory != truth

retrieval != authority

similarity != identity

candidate != canonical

evidence != authority

validation != authority

freshness != validity

inference != observation

RAG != memory

memory != documentation

retrieval != action
```

These invariants must remain visible in implementation, retrieval, agent integration, and documentation.

---

# 5. Veyra 0.1.7 Baseline

Veyra 0.1.8 builds on the verified 0.1.7 baseline.

The baseline already includes:

- persistent local knowledge storage
- SQLite
- FTS5 retrieval
- intent-aware recall
- causal facets
- symptom/root-cause/remedy representation
- verified outcome tracking
- contradiction detection
- lifecycle-aware memory handling
- project isolation
- memory inspection
- DSH integration foundations
- automated tests
- npm packaging

The 0.1.8 goal is not to discard these capabilities.

It is to make them:

1. more accessible to the DSH agent,
2. more observable to humans,
3. more capable as a unified retrieval system.

---

# 6. Veyra 0.1.8 Goal

The primary goal of 0.1.8 is:

> **Make Veyra understandable to the agent, powerful as a hybrid retrieval system, and observable to humans.**

Three areas are mandatory:

```text
Agent Capability
       +
Hybrid Retrieval
       +
Knowledge Observatory
```

---

# 7. Agent Capability Discovery

Before implementation, inspect the **actual installed DSH environment**.

Do not assume tool, skill, command, hook, or prompt-injection names.

Discover:

- actual DSH agent skill mechanism
- actual Veyra plugin registration
- actual tool exposure mechanism
- actual command exposure mechanism
- actual prompt injection mechanism
- actual skill discovery mechanism
- existing DSH context injection patterns
- Veyra's current agent-facing integration
- Veyra's storage/read APIs
- Veyra's retrieval APIs
- existing inspection/debugging capabilities

The implementation must use the actual interfaces discovered in the repository and installed environment.

No hypothetical DSH API should be invented.

---

# 8. Veyra Agent Skill

Veyra must have a clear agent-facing capability surface.

The DSH agent should be able to understand that Veyra can provide:

- memory recall
- hybrid knowledge retrieval
- project context
- engineering decisions
- causal knowledge
- evidence/provenance
- relationships
- contradictions
- knowledge inspection
- context suitable for current work

The skill must describe **actual implemented capabilities only**.

Documentation must not claim a tool or command that does not exist.

The skill should teach the agent:

```text
when Veyra is useful
what Veyra can retrieve
how to query it
how to interpret returned knowledge
how authority/lifecycle affect results
how to inspect evidence
how to handle contradictions
```

---

# 9. Prompt Injection

Veyra's agent integration must be audited and updated so the agent knows when and how to use Veyra.

The intended pipeline is:

```text
Veyra Knowledge
      ↓
Retrieval
      ↓
Lifecycle Filtering
      ↓
Authority Filtering
      ↓
Project Isolation
      ↓
Intent / Relevance Filtering
      ↓
Structured Context
      ↓
DSH Agent Prompt
```

Injected knowledge must remain bounded and structured.

The system must preserve:

- project isolation
- reusable/global knowledge boundaries
- candidate exclusion where required
- lifecycle rules
- authority rules
- contradiction warnings
- evidence/provenance
- secret scrubbing
- prompt-size limits

Veyra must not blindly inject every retrieved memory into every agent interaction.

---

# 10. Hybrid Retrieval

Veyra 0.1.8 should establish the architecture for Hybrid Search.

The retrieval system should be able to combine, where available:

### Lexical retrieval

Examples:

- SQLite FTS5
- exact terms
- identifiers
- filenames
- symbols
- error messages
- configuration keys

### Semantic retrieval

Potential mechanisms include:

- embeddings
- vector indexes
- semantic similarity

Semantic retrieval may be introduced where justified by actual engineering requirements.

### Memory retrieval

Signals include:

- intent
- lifecycle
- authority
- verification
- project scope
- causal facets
- relationships
- historical relevance

### Relationship retrieval

Signals may include:

- supersession
- contradiction
- causality
- dependency
- affected components
- related decisions

The final retrieval layer should combine appropriate signals rather than assuming one ranking mechanism is sufficient.

---

# 11. Retrieval Authority

Retrieval ranking must not determine truth.

A highly similar result does not automatically become authoritative.

The system must distinguish:

```text
retrieval score
knowledge confidence
validation state
authority
```

These are separate dimensions.

A retrieval pipeline may therefore find a candidate while later filtering determines whether that candidate is appropriate for agent context.

---

# 12. Knowledge Observatory

Veyra 0.1.8 should introduce a read-only **Knowledge Observatory**.

The Observatory is a projection of existing Veyra state.

It must not become a second source of truth.

Conceptually:

```text
                 Veyra Core
                     │
              ┌──────┴──────┐
              │             │
              ▼             ▼
        Agent Surface   Human Surface
              │             │
              ▼             ▼
         Context        Observatory
```

The Observatory should make Veyra knowledge understandable without requiring the user to inspect SQLite manually.

---

# 13. Observatory Capabilities

The Observatory should provide read-only inspection for:

### Knowledge

- memory records
- knowledge categories
- lifecycle state
- scope
- authority
- timestamps

### Search

- search queries
- matched knowledge
- ranking/relevance
- retrieval source

### Evidence

Show:

```text
What does Veyra know?
Why does Veyra know it?
Where did it come from?
When was it observed?
What evidence supports it?
What validation occurred?
```

### Causality

Expose:

```text
Symptom
   ↓
Root Cause
   ↓
Remedy
   ↓
Verified Outcome
```

### Relationships

Expose relationships such as:

```text
supersedes
evolved_from
resolves
caused_by
affects
belongs_to
contradicts
derived_from
```

Where relationships exist.

### Contradictions

The Observatory should make conflicting knowledge visible rather than silently collapsing it.

---

# 14. Human Surface vs Agent Surface

The two surfaces have different goals.

### Agent Surface

Optimize for:

- compactness
- relevance
- deterministic structure
- low token cost
- actionable context
- authority/lifecycle awareness

### Human Surface

Optimize for:

- explainability
- provenance
- inspection
- exploration
- relationship visibility
- causal understanding
- debugging

The human Observatory should therefore expose more information than the normal agent context.

---

# 15. Evidence and Provenance

Every important piece of engineering knowledge should be traceable where possible.

The system should support answering:

```text
Where did this knowledge originate?

What interaction produced it?

What repository/project was involved?

What file/code/configuration supported it?

Was it explicitly stated or inferred?

Was it verified?

Has it been superseded?

Does contradictory knowledge exist?
```

Veyra must avoid presenting unsupported inference as established fact.

---

# 16. Causal Knowledge

Causal information is a first-class engineering-memory capability.

Veyra should preserve explicit distinctions between:

```text
symptom
root cause
remedy
verified outcome
```

Causality must not be inferred solely from:

- temporal adjacency
- files being edited together
- tools being called sequentially
- simultaneous changes

Explicit causal evidence or sufficiently strong verification is required.

---

# 17. Lifecycle and Authority

Veyra knowledge must remain lifecycle-aware.

Possible states may include concepts such as:

```text
candidate
validated
verified
superseded
invalid
conflicted
```

Exact states must follow the implemented schema rather than being invented by documentation.

The system must distinguish:

```text
stored
retrievable
validated
verified
authoritative
```

These are not equivalent.

---

# 18. Project Isolation

Knowledge must respect scope.

Conceptually:

```text
Project
  ↓
Workspace
  ↓
Global / Reusable
```

Veyra must not leak project-specific knowledge into unrelated projects merely because it is semantically similar.

Cross-project reuse must be explicit and appropriately classified.

---

# 19. Security

Veyra must preserve:

- secret scrubbing
- project isolation
- bounded prompt injection
- safe provenance rendering
- lifecycle filtering
- authority filtering
- contradiction visibility
- no accidental exposure of sensitive context

Retrieval should not bypass security boundaries.

---

# 20. Architecture Boundaries

Veyra should remain:

- DSH-native
- local-first where practical
- evidence-aware
- retrieval-flexible
- extensible
- inspectable
- testable

Veyra should avoid introducing infrastructure merely because it is fashionable.

Potential technologies such as:

- vector indexes
- embeddings
- graph projections
- external knowledge bases
- remote services

may be adopted when they solve a demonstrated Veyra requirement.

They are implementation choices, not architectural identities.

Do not introduce:

- a graph database merely to visualize relationships
- a vector database merely to claim semantic search
- external services without demonstrated need
- an LLM dependency where deterministic logic is sufficient
- duplicate sources of truth

---

# 21. Schema Policy

Prefer extending existing Veyra structures when they are sufficient.

Avoid schema changes unless the current representation cannot support the required capability.

For example, hybrid retrieval should not automatically require a new database architecture if existing SQLite/FTS5 plus an appropriately designed derived index can support the requirement.

Any new index must remain a derived representation of canonical Veyra knowledge.

---

# 22. Verification

Veyra 0.1.8 must be verified at multiple levels.

### Unit tests

Verify:

- hybrid retrieval logic
- ranking/fusion
- lifecycle filtering
- authority filtering
- project isolation
- causal retrieval
- relationship retrieval
- contradiction handling
- evidence/provenance
- prompt-context generation

### Integration tests

Verify:

```text
query
  ↓
retrieval
  ↓
filtering
  ↓
context generation
  ↓
agent-facing output
```

### Observatory tests

Verify:

- read-only behavior
- search
- knowledge inspection
- evidence display
- causal relationships
- contradictions
- lifecycle/authority display

### DSH verification

Verify the actual installed DSH integration.

Do not claim runtime verification unless it was actually performed.

---

# 23. DSH Runtime Safety

The existing DSH Web environment is a live development environment.

During Veyra development:

**DO NOT:**

- kill DSH
- restart DSH
- disable the DSH Web profile
- replace the active profile
- reload the active runtime
- modify unrelated DSH runtime configuration
- restart WSL or the machine

Do not use:

```text
kill
pkill
killall
```

unless explicitly authorized for a future task.

If runtime verification would require disrupting the active environment, document it as unverified rather than pretending it succeeded.

---

# 24. Documentation

Documentation must describe the implementation that actually exists.

At minimum, 0.1.8 should update documentation for:

- Veyra architecture
- hybrid retrieval
- agent skill
- prompt injection
- Observatory
- evidence/provenance
- causal knowledge
- relationships
- security boundaries
- usage and inspection

Documentation must not describe hypothetical capabilities as completed features.

---

# 25. Versioning

The implementation must remain version-consistent.

Update:

- package version
- documentation references
- tests
- changelog/release information where present

Only release after verification succeeds.

Do not claim a release until:

```text
tests pass
package validation passes
working tree is understood
Git state is understood
release artifacts are verified
```

---

# 26. Long-Term Direction

Veyra should evolve toward an engineering intelligence layer that sits between the developer's work and the agent.

Long-term:

```text
Developer
    │
    ▼
   DSH
    │
    ▼
  Veyra
    │
    ├── Hybrid Search
    ├── RAG
    ├── Engineering Memory
    ├── Project Context
    ├── Causal Knowledge
    ├── Relationships
    ├── Evidence
    ├── Authority
    ├── Lifecycle
    └── Learning
    │
    ▼
 Agent Context
```

The objective is not to replace the agent.

The objective is to give the agent a persistent engineering understanding that ordinary stateless retrieval cannot provide.

---

# 27. Success Criteria for 0.1.8

Veyra 0.1.8 is successful when:

1. The DSH agent can discover and understand Veyra's actual capabilities.
2. The Veyra agent skill accurately describes implemented tools/capabilities.
3. Prompt injection correctly exposes relevant Veyra knowledge to the agent.
4. RAG and engineering memory can participate in the same retrieval architecture.
5. Hybrid retrieval combines appropriate lexical, semantic, memory, and relationship signals where implemented.
6. Retrieval does not bypass lifecycle, authority, security, or project boundaries.
7. Humans can inspect Veyra knowledge through the Knowledge Observatory.
8. Users can inspect evidence and provenance.
9. Users can inspect causal relationships.
10. Users can identify contradictory knowledge.
11. Agent-facing context remains compact and bounded.
12. Human-facing observability remains detailed and explainable.
13. Tests cover the new behavior and existing 0.1.7 behavior remains intact.
14. Documentation matches actual implementation.
15. No unsupported completion or runtime-verification claims are made.
16. The live DSH environment remains operational and undisturbed.

---

# 28. Final Architectural Principle

Veyra should not be defined by what retrieval technology it uses.

It should be defined by **how it turns engineering knowledge into trustworthy, appropriately scoped, retrievable context for agents.**

Therefore:

```text
RAG                 → supported
Hybrid Search       → first-class capability
Vector Search       → supported where useful
Semantic Search     → supported where useful
Lexical Search      → supported
Engineering Memory  → core
Evidence             → core
Provenance           → core
Authority            → core
Lifecycle            → core
Causality            → core
Relationships        → core
Agent Integration    → core
Human Observatory   → core
```

The central distinction is:

> **Veyra is not “RAG instead of memory” or “memory instead of RAG.” Veyra combines knowledge retrieval and engineering memory into an evidence-aware intelligence layer for DSH agents.**
