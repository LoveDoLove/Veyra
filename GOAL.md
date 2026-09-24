# Veyra — Engineering Intelligence Graph & Agent Context

## Goal

Evolve Veyra from a verified Engineering Knowledge System into an **Engineering Intelligence Layer for coding agents**.

The next stage will establish a lifecycle-aware, evidence-backed engineering graph that can:

1. organize engineering knowledge and its relationships;
2. expose that knowledge through an interactive WebUI Network Graph;
3. provide graph-aware context to coding agents;
4. preserve Veyra's existing lifecycle, validation, authority, provenance, and read-only guarantees;
5. validate whether Veyra measurably improves real coding-agent engineering work.

The objective is **not** to build a generic knowledge graph, generic RAG system, or visualization-only graph.

The objective is:

> **Help coding agents understand the engineering context behind a codebase before they make changes.**

---

# 1. Starting Baseline

Veyra `0.1.12` is the verified baseline.

The current baseline has already established:

* Engineering knowledge storage;
* Memory / RAG capabilities;
* Lifecycle handling;
* Authority handling;
* Validation;
* Evidence / provenance;
* Relationships;
* Causality;
* Contradiction inspection;
* Knowledge Observatory;
* DSH slash-command integration;
* live authenticated DSH operation;
* read-only Observatory behavior;
* regression coverage;
* CI and npm publication;
* live DSH installation and runtime verification.

Therefore:

> **Do not destabilize or unnecessarily redesign the verified 0.1.12 foundation.**

All new work must build on the verified baseline unless architecture research demonstrates a concrete reason for change.

---

# 2. External Architecture References

The next architecture stage must explicitly study and compare:

* Supermemory
* OpenViking

The purpose is not to copy either project.

The purpose is to identify useful architectural patterns and decide explicitly what Veyra should:

* Adopt;
* Adapt;
* Reject;
* Defer.

## Supermemory Research Focus

Study:

* Living Knowledge Graph;
* relationship-aware memory;
* knowledge evolution;
* relationship expansion during retrieval;
* contextual retrieval;
* memory / knowledge distinction;
* graph-assisted context construction.

Relevant architectural question:

> How can relationships improve retrieval beyond ordinary top-K semantic search?

## OpenViking Research Focus

Study:

* Agent Context Database architecture;
* unified context model;
* Knowledge Graph;
* typed entities;
* typed relationships;
* provenance;
* visualization-ready graph representation;
* agent-oriented context retrieval;
* source-grounded knowledge.

Relevant architectural question:

> How can a knowledge graph become an Agent Context infrastructure rather than merely a database structure?

---

# 3. Veyra Architectural Principle

The central architecture should remain:

```text
                    Veyra
                      │
             Canonical Knowledge
                      │
          ┌───────────┼───────────┐
          │           │           │
          ▼           ▼           ▼
        Search      Graph      Context
      Projection   Projection  Projection
          │           │           │
          ▼           ▼           ▼
        Recall      WebUI       Agent
```

The canonical engineering knowledge remains the source of truth.

Graph is a **first-class derived projection**, not a second canonical database.

Do not introduce a separate graph database unless architecture research demonstrates a concrete requirement that cannot reasonably be satisfied by the existing architecture.

---

# 4. Engineering Graph Goal

Build a graph model capable of representing engineering context across:

* knowledge;
* memory;
* observations;
* evidence;
* files;
* decisions;
* historical events;
* relationships;
* lifecycle state;
* authority;
* validation;
* provenance.

The graph must preserve semantic meaning.

A graph edge must not merely mean:

```text
A is connected to B
```

It must communicate:

```text
A
  └── relationship type ──> B
          │
          ├── validation
          ├── provenance
          └── authority/context
```

The graph must therefore remain **evidence-aware and lifecycle-aware**.

---

# 5. Graph Node Model

Define a formal Graph Node contract.

The specification must distinguish between:

* canonical entities;
* projected entities;
* derived entities;
* historical entities;
* candidate entities.

Do not create duplicate canonical models solely for graph rendering.

The architecture must answer:

* What becomes a node?
* What remains metadata?
* What is merely a projection?
* What identifies a node?
* How is node lifecycle represented?
* How is authority represented?
* How is validation represented?
* How is provenance represented?

---

# 6. Graph Edge Model

Define a formal Graph Edge contract.

The design must preserve Veyra's existing relationship semantics.

The architecture must answer:

* What relationship types exist today?
* Which are directional?
* Which are symmetric, if any?
* How is relationship validation represented?
* How is evidence attached?
* How is provenance preserved?
* How are historical relationships handled?
* How are invalid relationships excluded from trusted context?

Do not invent new relationship types merely because the UI needs additional visual categories.

---

# 7. Lifecycle-Aware Graph

The graph must distinguish current and historical knowledge.

For example:

```text
CURRENT
   │
SUPERSEDES
   │
   ▼
HISTORICAL
```

The UI and Agent Context layer must not treat:

* current;
* superseded;
* forgotten;
* candidate;
* invalid;
* needs-review

as equivalent.

This is a correctness requirement, not merely a visualization feature.

---

# 8. Authority-Aware Graph

Graph traversal and Agent Context must account for authority.

The system must distinguish appropriate authority states such as:

```text
CANONICAL
DERIVED
CANDIDATE
```

The exact values must be derived from the current Veyra model rather than invented during implementation.

Authority must affect context selection where appropriate.

---

# 9. Validation-Aware Graph

Graph traversal must not blindly trust every edge.

The architecture must define behavior for:

```text
VERIFIED
NEEDS REVIEW
INVALID
LEGACY / UNTYPED
```

Invalid knowledge or invalid relationships must not silently enter trusted Agent Context.

This must remain fail-closed.

---

# 10. Provenance and Evidence

Every important engineering relationship should remain explainable.

The architecture must support:

```text
What?
Why?
Where?
When?
Evidence?
Validation?
Authority?
Lifecycle?
```

A user or Agent should be able to move from:

```text
Graph Node
   ↓
Relationship
   ↓
Evidence
   ↓
Original engineering source
```

without losing provenance.

---

# 11. Network Graph WebUI

Build an interactive WebUI Network Graph as part of the Engineering Observatory.

The initial UI should support:

### Overview

Existing Observatory overview remains the system-level entry point.

### Record

Existing record inspection remains the detailed knowledge view.

### Local Graph

Default graph view:

```text
Selected Node
    +
Related Nodes
    +
1–2 hop expansion
```

### Project Graph

Optional broader project-level exploration.

### Relationship View

Focus on relationship structure.

### Causality View

Focus on causal relationships already represented by Veyra.

Do not begin with an uncontrolled full-project graph.

---

# 12. Graph Interaction

The WebUI should support, as justified by the architecture:

* node selection;
* node detail inspection;
* edge selection;
* relationship detail;
* expand;
* collapse;
* filtering;
* lifecycle filtering;
* authority filtering;
* validation filtering;
* search-to-graph navigation;
* graph-to-record navigation.

The graph must remain understandable when the knowledge base grows.

---

# 13. Search ↔ Record ↔ Graph

These should become one coherent Observatory workflow.

```text
Search
  ↓
Record
  ↓
Local Graph
  ↓
Related Record
  ↓
Evidence
```

And:

```text
Graph Node
  ↓
Record
  ↓
Evidence
```

The user should not need to understand Veyra's internal storage model to navigate the knowledge graph.

---

# 14. Agent Context Integration

After the Graph model is stable, expose graph-aware context to coding agents.

The Agent must not depend on the WebUI.

The architecture should be:

```text
Coding Task
    ↓
Veyra Context Request
    ↓
Relevant Knowledge
    ↓
Graph Expansion
    ↓
Lifecycle / Authority / Validation Filtering
    ↓
Evidence Selection
    ↓
Engineering Context
    ↓
Coding Agent
```

The Agent should receive **relevant context**, not the entire graph.

---

# 15. Context Retrieval Goal

The Agent Context layer should answer questions such as:

* What engineering knowledge is relevant to this file?
* What architectural decisions affect this area?
* What previous incidents are related?
* What historical decisions were superseded?
* What constraints are known?
* What evidence supports these constraints?
* Which information is canonical?
* Which information requires review?
* What relationships connect this code to previous engineering decisions?

This should extend existing retrieval rather than replace it blindly.

---

# 16. Graph-Aware Retrieval

Research and define whether Veyra should implement a pipeline similar to:

```text
Semantic / lexical retrieval
          ↓
Candidate nodes
          ↓
Relationship expansion
          ↓
Lifecycle filtering
          ↓
Authority filtering
          ↓
Validation filtering
          ↓
Evidence / provenance selection
          ↓
Context ranking
          ↓
Agent Context
```

The exact implementation must be determined from repository evidence and the Supermemory / OpenViking study.

Do not assume that graph expansion is always beneficial.

Traversal depth, limits, ranking, and filtering must be bounded.

---

# 17. DSH Integration

Veyra remains a DSH-native system.

The Agent Context architecture must integrate naturally with DSH rather than creating a parallel agent framework.

The design must identify:

* existing DSH integration points;
* MCP interfaces;
* slash commands where appropriate;
* automatic context opportunities;
* explicit context requests;
* lifecycle of agent sessions;
* failure behavior when Veyra is unavailable.

Veyra must not become a blocking dependency that prevents normal coding-agent operation unless explicitly designed and justified.

---

# 18. Read-Only Observatory Guarantee

The current Observatory read-only guarantee must remain.

Graph visualization must not accidentally introduce mutation.

Default graph operations should be:

```text
READ
TRAVERSE
FILTER
INSPECT
```

Any future mutation capability must be explicitly designed and separately verified.

---

# 19. Performance Boundaries

The architecture must explicitly define limits for:

* graph traversal depth;
* node count;
* edge count;
* response size;
* WebUI rendering;
* context size;
* search expansion;
* concurrent queries.

Avoid designs that work only for a tiny development database.

The graph must degrade gracefully as project knowledge grows.

---

# 20. Security and Isolation

The existing Veyra isolation guarantees must remain intact.

Graph queries must respect:

* project boundaries;
* workspace boundaries;
* global scope rules;
* authorization;
* evidence visibility;
* lifecycle restrictions.

No graph traversal may accidentally cross an isolation boundary.

This must be fail-closed.

---

# 21. Testing Strategy

Testing must cover four levels.

## Unit

* node projection;
* edge projection;
* lifecycle filtering;
* authority filtering;
* validation filtering;
* provenance;
* traversal;
* ranking.

## Integration

* canonical store → graph projection;
* graph → context;
* DSH → Veyra;
* Observatory → graph;
* search → graph.

## UI

* graph rendering;
* node selection;
* edge selection;
* filters;
* record navigation;
* empty graph;
* invalid relationship handling;
* large graph behavior.

## Live Verification

Verify through the actual authenticated DSH environment.

Do not treat mocked or sidecar behavior as proof of live DSH integration.

---

# 22. Engineering-Agent Impact Experiment

The final purpose of this stage is measurable validation.

Use controlled tasks where the same coding-agent task is performed with:

```text
Baseline Agent
```

and:

```text
Agent + Veyra Context
```

The experiment must avoid confirmation bias.

Possible measurements:

* correctness;
* regression count;
* unnecessary changes;
* architecture violations;
* consistency with existing decisions;
* repeated historical mistakes;
* evidence-backed decisions;
* rework;
* verification quality;
* time to correct implementation.

The experiment must permit the outcome:

> Veyra does not measurably improve the task.

The objective is measurement, not proving a predetermined conclusion.

---

# 23. Implementation Phases

## Phase 0 — Architecture Research

Study:

* Supermemory;
* OpenViking;
* current Veyra.

Produce:

```text
Adopt
Adapt
Reject
Defer
```

decision matrix.

No implementation.

---

## Phase 1 — Graph Data Contract

Define:

* node model;
* edge model;
* lifecycle;
* validation;
* authority;
* provenance;
* identity;
* projection rules;
* traversal semantics.

No UI implementation yet.

---

## Phase 2 — Graph Projection

Implement the graph projection over the existing canonical Veyra data.

Requirements:

* no second source of truth;
* deterministic projection;
* isolation;
* lifecycle awareness;
* validation awareness;
* bounded traversal.

---

## Phase 3 — Network Graph WebUI

Add the Observatory Network Graph.

Initial scope:

* Local Graph;
* node inspection;
* edge inspection;
* filters;
* record navigation;
* search integration.

Avoid unnecessary visualization features.

---

## Phase 4 — Agent Context

Connect graph-aware retrieval to the Agent Context layer.

Initial goal:

```text
Task
 ↓
Relevant Context
 ↓
Graph Expansion
 ↓
Evidence-backed Context
```

Do not expose the entire graph to the Agent.

---

## Phase 5 — Live DSH Verification

Verify the complete chain:

```text
DSH
 ↓
Veyra
 ↓
Context
 ↓
Graph
 ↓
Evidence
 ↓
Coding Agent
```

using the actual live environment.

---

## Phase 6 — Engineering Impact Experiment

Run controlled coding tasks with and without Veyra.

Collect objective evidence.

Produce an Engineering Intelligence validation report.

---

# 24. Definition of Success

This stage succeeds only when all of the following are true:

### Architecture

Veyra has a clearly defined engineering graph model.

### Data Integrity

Graph projection does not become a competing source of truth.

### Explainability

Important graph relationships can be traced back to evidence.

### Lifecycle Safety

Superseded, forgotten, candidate, invalid, and current knowledge are not conflated.

### WebUI

Humans can explore engineering relationships through Network Graph.

### Agent Context

Coding agents can consume relevant graph-aware engineering context without depending on the UI.

### DSH

The functionality works through the real DSH integration.

### Isolation

Project/workspace/global boundaries remain enforced.

### Verification

Automated and live tests provide evidence for the implementation.

### Impact

The controlled experiment provides evidence about whether Veyra changes coding-agent engineering quality.

---

# 25. Non-Goals

This stage does **not** aim to:

* build a generic social/semantic knowledge graph;
* replace SQLite with Neo4j;
* build a generic RAG platform;
* create a second canonical knowledge store;
* reproduce Supermemory;
* reproduce OpenViking;
* build a graph purely for visual aesthetics;
* expose the entire knowledge base to agents;
* automatically trust every relationship;
* remove lifecycle or validation semantics;
* introduce broad external integrations prematurely;
* sacrifice correctness for retrieval speed.

---

# 26. Final Product Direction

The intended evolution is:

```text
Veyra 0.1.12
Verified Engineering Knowledge System
              │
              ▼
Engineering Intelligence Graph
              │
       ┌──────┴──────┐
       ▼             ▼
    WebUI          Context
    Graph           Engine
       │             │
       ▼             ▼
     Human         Coding Agent
    Explorer       Integration
       │             │
       └──────┬──────┘
              ▼
      Engineering Decisions
              │
              ▼
           Evidence
              │
              ▼
        Measurable Impact
```

The ultimate objective is not:

> “Veyra has a graph.”

It is:

> **Veyra can provide a coding agent with trustworthy, explainable, lifecycle-aware engineering context at the moment that context matters.**

That is the capability that must eventually distinguish Veyra from ordinary memory, RAG, and knowledge-graph systems.
