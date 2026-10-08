# Veyra — Product Direction

## Product Goal

**Veyra gives Coding Agents reliable, persistent, change-aware Engineering Memory.**

Veyra is an evidence-backed engineering memory system for coding agents.

Its purpose is to help agents retain engineering knowledge across sessions while understanding whether that knowledge is still applicable as the repository changes.

## Core Model

```text
Repository Truth + Engineering Memory
                ↓
      Applicability / Freshness
                ↓
              Trust
                ↓
          Agent Context
```

* **Repository Truth** — current code and repository structure.
* **Engineering Memory** — decisions, knowledge, observations, evidence, relationships, and historical context.
* **Applicability** — whether remembered knowledge still applies to the current project and context.
* **Freshness** — whether repository changes may have invalidated or weakened previous knowledge.
* **Trust** — the resulting confidence/state presented to the agent.
* **Agent Context** — useful memory supplied to the coding agent without turning memory into executable instructions.

## Current State

The core technical foundation is substantially complete.

Implemented capabilities include:

* Persistent SQLite + FTS5 engineering memory
* Evidence and authority tracking
* Candidate / canonical lifecycle
* Write-gate and canonical safety
* Contradiction, supersession, and relationship handling
* Negative and unresolved knowledge
* Applicability and temporal reasoning
* Causal and goal-directed retrieval
* Retrieval ranking and RRF
* Memory health and maintenance
* Safe forgetting and protection
* Corruption detection and fail-closed behavior
* Project/workspace isolation
* Secret protection
* Repository change intelligence
* Trust-aware agent context
* Ambient change-aware context
* Optional AST/code intelligence through the Dual-Brain integration
* Real DSH runtime validation

## Product Boundaries

Veyra is **not** intended to:

* Guarantee coding-agent correctness
* Replace repository truth
* Become an autonomous coding agent
* Become a generic cognitive architecture
* Implement multi-agent/swarm intelligence
* Treat memory as executable instructions
* Automatically promote observations into canonical truth
* Add complexity without a clear Engineering Memory benefit

Core invariants remain:

* Observe ≠ Store
* Candidate ≠ Truth
* Similarity ≠ Authority
* Similarity ≠ Applicability
* Historical memory ≠ Current truth
* Memory ≠ Executable instruction
* Automatic behavior never silently becomes canonical
* No silent merge
* Contradictions remain visible
* Repository truth remains authoritative
* Isolation fails closed

## Next Direction

The next stage is **product consolidation, not feature expansion**.

Priorities:

1. Keep the existing Engineering Memory architecture stable.
2. Align project documentation with the actual implementation.
3. Clearly communicate Veyra's product identity and differentiation.
4. Remove obsolete roadmap statements and stale capability claims.
5. Improve usability only where it directly strengthens reliable, contextual, change-aware Engineering Memory.
6. Avoid introducing new intelligence subsystems merely to create another development phase.

Any future feature should answer:

> **Does this make an agent's engineering memory more reliable, contextual, or able to adapt to project changes?**

If not, it is outside the current product direction.
