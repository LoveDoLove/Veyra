# Goal: Integrate Code Intelligence into Veyra

## Objective

Directly integrate the useful, production-ready core implementation from the upstream `codebase-memory-mcp` project into Veyra.

The goal is to make Veyra understand both:

* **Code** — repository structure, files, symbols, relationships, dependencies, search, and change impact.
* **Engineering Memory** — decisions, observations, evidence, validation state, and historical context.

Do **not** integrate the separate `dsh-codebase-memory-mcp` plugin.

Use the upstream `codebase-memory-mcp` source at:

`/home/lovedolove/projects/refs/codebase-memory-mcp`

as the primary implementation reference.

For DSH integration, use the **official DeepSeek Harness documentation** at:

`/home/lovedolove/projects/refs/deepseek-harness/docs`

as the authoritative reference.

Do not use unrelated third-party DSH plugins as the API/design source when official documentation provides the relevant mechanism.

---

# Core Architecture

Veyra should evolve toward:

```text
Veyra
├── Code Intelligence
│   ├── Repository Ingestion
│   ├── File Discovery / Filtering
│   ├── Index Lifecycle
│   ├── Parsing
│   ├── Symbols
│   ├── Relationships
│   ├── Dependency / Call Graph
│   ├── Data Flow
│   ├── Semantic / Structural Search
│   ├── Similarity / Clone Detection
│   └── Change Impact
│
├── Engineering Memory
│   ├── Memory
│   ├── Evidence
│   ├── Validation
│   └── Relations
│
├── Unified Retrieval
│
└── DSH Integration
```

The exact set of Code Intelligence features included in the first production release must be determined from the upstream implementation and feasibility analysis.

Do not blindly import every upstream feature.

---

# 1. Upstream Code Intelligence Analysis

Inspect the complete upstream implementation before designing equivalent Veyra code.

Focus on:

* repository discovery
* file filtering
* indexing pipeline
* incremental indexing
* background watcher
* Tree-sitter parsing
* symbol extraction
* symbol resolution
* LSP/type resolution
* call relationships
* dependency relationships
* graph construction
* data-flow analysis
* semantic search
* structural/full-text search
* vector search
* clone/similarity detection
* cross-service/cross-repository relationships
* change impact analysis
* persistent storage
* query execution
* index lifecycle
* error recovery
* performance characteristics

For every major upstream component, determine whether it should be:

* reused directly
* copied and adapted
* wrapped behind a Veyra abstraction
* replaced by existing Veyra functionality
* deferred

Do not reimplement mature functionality without a concrete reason.

Do not copy the upstream MCP server/client integration merely because it exists.

---

# 2. Code Intelligence Boundary

Code Intelligence and Engineering Memory must remain separate concepts.

Code Intelligence answers:

```text
What exists in the repository?
Where is it?
How is it connected?
What depends on it?
What changed?
What may be affected?
```

Engineering Memory answers:

```text
What did we learn?
What decision was made?
Why was it made?
What happened previously?
What evidence supports it?
How was it validated?
Is it still trustworthy?
```

Do not convert every code entity, symbol, or relationship into a Veyra memory row.

Code index data should have its own representation and lifecycle.

---

# 3. Repository Ingestion

Implement a controlled repository ingestion layer.

It must:

* operate only within the authorized Veyra project/workspace scope
* normalize repository paths
* safely handle symlinks
* avoid path traversal
* identify supported source files
* ignore irrelevant files/directories
* avoid indexing secrets
* avoid unnecessary binary/generated/build artifacts

The implementation must explicitly consider common exclusions such as:

```text
.git
node_modules
vendor
dist
build
coverage
.cache
temporary files
binary files
generated output
```

Do not hard-code an incomplete universal exclusion list if the upstream implementation already provides a mature filtering mechanism.

Prefer the upstream implementation where practical.

---

# 4. Index Lifecycle

Code indexing must have an explicit lifecycle.

At minimum support:

```text
Not Indexed
    ↓
Initial Index
    ↓
Ready
    ↓
Incremental Update
    ↓
Ready
```

Also handle:

```text
Index Failure
    ↓
Recover / Retry
    ↓
Previous Valid Index
```

and:

```text
Large Repository Change
    ↓
Rebuild / Recovery Index
```

The agent must never be given a silently corrupted or obviously partial index.

If an incremental update fails, preserve the last known-good index where possible.

---

# 5. Persistent Index Storage

Use the most appropriate mature storage mechanism from the upstream implementation or existing Veyra architecture.

Do not introduce another database without demonstrating why existing storage cannot satisfy the requirement.

The index must support:

* persistence across DSH sessions
* project isolation
* deterministic project identity
* index versioning
* schema/version migration
* safe update/rebuild
* recovery from failed indexing
* corruption detection where practical

Index schema changes must not silently invalidate existing Veyra Memory data.

Keep Code Intelligence storage logically distinguishable from canonical Memory storage.

---

# 6. Incremental Indexing and Watcher

Reuse the upstream incremental indexing and background watcher implementation where practical.

The system should detect:

* file creation
* file modification
* file deletion
* rename/move where detectable

and update only the affected index data.

Avoid full repository re-indexing for ordinary small changes.

The watcher must:

* debounce bursts of changes
* avoid duplicate work
* avoid blocking normal DSH interaction
* recover from watcher errors
* respect project boundaries
* expose its current state

A manual/full rebuild must remain available for recovery or large repository changes.

---

# 7. Code Intelligence Capabilities

The integrated subsystem should support the following capabilities where the upstream implementation can provide them reliably:

### Repository structure

* files
* modules
* packages
* services

### Symbols

* functions
* classes
* methods
* interfaces
* types
* variables
* other supported language symbols

### Relationships

* definitions
* references
* calls
* imports
* dependencies
* inheritance/implementation where supported

### Advanced analysis

Where practical and production-ready:

* data flow
* semantic relationships
* code similarity
* clone detection
* cross-service relationships
* cross-repository relationships
* change impact

### Search

Support the strongest useful combination of:

* structural search
* lexical/full-text search
* symbol search
* semantic search
* graph-aware retrieval

Do not add expensive capabilities solely because the upstream project supports them.

Prioritize correctness and useful agent retrieval over feature count.

---

# 8. Unified Retrieval

Extend Veyra retrieval so an agent can retrieve:

```text
Code Intelligence
+
Engineering Memory
+
Evidence
+
Validation
```

A query such as:

> How does authentication work?

should be able to retrieve relevant:

* files
* symbols
* definitions
* references
* dependencies
* implementation details
* engineering memories
* evidence
* validation state

The retrieval layer should preserve provenance.

Every returned result should remain distinguishable as:

```text
Code
Memory
Evidence
Validation
```

Do not flatten everything into indistinguishable text.

Do not create an unrelated second retrieval architecture if the existing Veyra retrieval system can be extended cleanly.

---

# 9. Code ↔ Memory / Evidence Linking

Create explicit links between Code Intelligence entities and Veyra Memory/Evidence.

For example:

```text
Code Entity
    ↓
Evidence
    ↓
Memory
    ↓
Validation
```

Example:

```text
Code:
src/payment/stripe.ts
symbol: createCheckoutSession

Evidence:
source location + symbol identity + relevant content/version

Memory:
"Payment uses Stripe Checkout."

Validation:
verified
```

The link should preserve enough provenance to determine:

* which repository
* which file
* which symbol
* which relevant code relationship
* which indexed revision/version
* when it was observed

Avoid relying only on raw text paths.

---

# 10. Code Change → Memory Maintenance

Use code change information to identify potentially affected Memory/Evidence.

Example:

```text
Existing Memory:
"Project uses Stripe only."

Code Change:
src/payment/paypal.ts added.

Result:
Potential contradiction / stale-memory candidate.
```

The system should identify:

* affected code entities
* affected evidence
* memories depending on affected evidence
* potentially stale memories
* potential contradictions

But:

```text
Potential Change
≠
Automatic Invalidation
```

Do not automatically:

* invalidate Memory
* promote a candidate
* change authority
* merge memories
* declare a contradiction as truth

Veyra's existing validation model remains authoritative.

---

# 11. Evidence Freshness

Code-backed evidence must be version-aware.

When possible, associate evidence with:

* repository/project identity
* normalized path
* symbol/entity identity
* indexed revision or content fingerprint
* observation time

When the referenced code changes, the evidence may become:

```text
fresh
potentially stale
invalid
```

according to Veyra's existing validation semantics.

Do not infer semantic invalidity merely from a file modification.

A changed file should normally produce a candidate for review, not automatic invalidation.

---

# 12. Veyra Invariants

Preserve all existing Veyra invariants:

* `Observe ≠ Store`
* `Candidate ≠ Truth`
* `Similarity ≠ Authority`
* automatic behavior never becomes canonical silently
* no silent merge
* contradictions remain visible
* repository/code truth is authoritative
* project/workspace/reusable isolation fails closed
* secrets are scrubbed

Code Intelligence must not weaken any of these rules.

---

# 13. DSH Integration

Integrate with DeepSeek Harness using the official documentation under:

`/home/lovedolove/projects/refs/deepseek-harness/docs`

First inspect the official documentation and current source where necessary.

Use the documented DSH mechanisms for:

* plugin registration
* `inject`
* services/providers
* `ctx.tools`
* tool registration
* tool execution
* Skills
* skill providers/consumers
* commands
* injection
* lifecycle
* disposal
* scoped registration
* session/agent integration

The official documentation explicitly defines service dependencies through `inject` and exposes services such as `ctx.tools`; the tool system also separates registration/schema from execution. Follow those documented contracts rather than inventing another integration layer.

For Skills, follow the official skill registry/provider/consumer model rather than treating Skills as arbitrary prompt files.

The integration must also behave correctly across plugin lifecycle and disposal/hot-reload where supported by DSH.

Do not invent undocumented DSH APIs.

Do not use an unrelated plugin implementation as the authority for DSH behavior.

---

# 14. DSH Agent Experience

The agent should be able to use Veyra naturally without manually understanding the internal index implementation.

Expose only the necessary model-facing capabilities.

Avoid exposing unnecessary low-level indexing internals as agent tools.

The agent should be able to:

```text
discover relevant code
→ retrieve structural context
→ retrieve related memory
→ inspect evidence
→ reason about changes
→ validate conclusions
```

The system should prefer progressive disclosure rather than injecting the entire index into every prompt.

---

# 15. Performance and Resource Control

Production indexing must not make DSH unusable.

Measure and control:

* initial indexing time
* incremental indexing time
* memory usage
* disk usage
* query latency
* watcher overhead
* large-repository behavior

Indexing should run asynchronously/backgrounded where the architecture supports it.

Normal DSH requests should not wait unnecessarily for a complete re-index.

For large repositories:

* process incrementally
* avoid unnecessary duplicate parsing
* avoid unbounded memory growth
* avoid loading the entire repository into every query

Reuse upstream performance optimizations where they are mature and compatible.

---

# 16. Failure and Degraded Modes

Define safe behavior when:

* a parser does not support a language
* a file cannot be read
* an index operation fails
* the watcher fails
* the index database is unavailable
* semantic indexing fails
* a repository is too large
* a project is deleted/moved
* a DSH service is unavailable

A partial Code Intelligence failure must not corrupt or silently alter canonical Memory.

Where possible:

```text
Code Intelligence unavailable
        ↓
Memory remains available
        ↓
Agent receives explicit degraded-state information
```

Do not report indexing as successful without evidence.

---

# 17. Observability

Expose enough state for production diagnosis.

At minimum track:

* index status
* last successful index
* current indexing operation
* changed files
* indexed file/symbol counts where available
* indexing errors
* watcher status
* index version
* repository/project identity

Errors must be actionable.

Do not claim an index is ready when indexing actually failed or remains incomplete.

---

# 18. Security and Isolation

Every Code Intelligence operation must respect Veyra's existing isolation model.

Never allow:

* cross-project index leakage
* workspace leakage
* reusable-store leakage
* unauthorized filesystem access
* arbitrary indexing outside the authorized project scope
* secrets entering persistent indexes

Verify:

* project identity
* path normalization
* symlink behavior
* filesystem boundaries
* secret scrubbing
* stored source/provenance data

Treat repository content as untrusted input.

---

# 19. Licensing and Attribution

The upstream project is MIT licensed.

If upstream source code is copied or substantially adapted:

* preserve the required license/notice
* retain required attribution
* identify reused upstream components where appropriate
* keep Veyra's own licensing boundaries clear

Do not copy upstream code without preserving its licensing obligations.

---

# 20. Tests

Add production-level tests for:

### Indexing

* initial repository indexing
* incremental indexing
* file creation
* file modification
* file deletion
* rename/move where supported
* rebuild/recovery

### Code Intelligence

* file discovery
* symbol extraction
* references
* calls
* dependencies
* graph relationships
* code search
* semantic search where integrated
* impact analysis where integrated

### Memory integration

* Code → Evidence linking
* Evidence → Memory linking
* stale evidence detection
* potential contradiction detection
* no automatic canonicalization
* no silent invalidation

### Isolation

* project isolation
* workspace isolation
* reusable isolation
* path traversal protection
* symlink boundary behavior
* secret scrubbing

### DSH integration

Verify against the official DSH implementation:

* plugin registration
* required `inject` dependencies
* service availability
* tool registration
* tool schema visibility
* tool execution
* Skill registration/invocation where used
* lifecycle/disposal
* scoped behavior
* reload behavior where supported

### Regression

All existing Veyra tests must continue passing.

---

# 21. Implementation Order

Implement in controlled stages.

## Stage 1 — Upstream Integration Foundation

* inspect upstream architecture
* identify reusable components
* preserve upstream license
* integrate repository ingestion
* integrate core indexing
* integrate persistent index
* establish Veyra project isolation

## Stage 2 — Code Intelligence

* parsing
* symbols
* relationships
* code search
* graph queries
* incremental indexing

## Stage 3 — Production Lifecycle

* watcher
* debounce
* recovery
* rebuild
* migrations
* observability
* performance controls

## Stage 4 — Memory Integration

* Code entity references
* evidence provenance
* freshness tracking
* affected-memory detection
* contradiction/stale candidates

## Stage 5 — Unified Retrieval

* code + memory retrieval
* provenance-preserving results
* ranking/query planning
* semantic search where appropriate

## Stage 6 — DSH Integration

* official plugin lifecycle
* tools
* skills
* providers/services
* injection
* agent-facing retrieval
* actual DSH verification

Do not move to later stages while the previous foundation is demonstrably broken.

---

# 22. Scope Control

Do **not**:

* integrate the existing `dsh-codebase-memory-mcp` plugin
* replace Veyra Memory with `codebase-memory-mcp`
* replace Veyra's validation model
* introduce another graph database without demonstrated need
* blindly copy the entire upstream repository
* reimplement mature upstream indexing unnecessarily
* create a human-managed documentation/export workflow as the primary feature
* silently change Veyra architecture
* weaken project/workspace/reusable isolation
* invent undocumented DSH APIs
* expose unnecessary low-level index internals to the model
* automatically invalidate or canonicalize Memory from code changes
* block normal DSH requests on avoidable full-repository indexing
* claim completion without test/evidence verification

Do not expand scope into unrelated Veyra features.

---

# 23. Completion Criteria

The goal is complete only when:

1. Veyra contains a working Code Intelligence subsystem.
2. Mature upstream indexing/parsing/search functionality has been reused where practical.
3. Veyra understands repository structure, symbols, and relationships.
4. Initial indexing works reliably.
5. Incremental indexing works reliably.
6. Background change detection works without disrupting normal DSH usage.
7. Failed indexing preserves a usable last-known-good state where possible.
8. Index storage supports versioning/migration/recovery.
9. Code search provides useful structural/lexical results.
10. Semantic search is integrated where proven useful and production-safe.
11. Code entities have stable provenance.
12. Code changes can identify affected evidence.
13. Potentially stale/contradictory memories can be surfaced.
14. Code changes never silently change Memory authority or validation state.
15. Code and Memory participate in unified retrieval.
16. Retrieval preserves source/provenance distinctions.
17. DSH integration follows official documented mechanisms.
18. Tools/Skills/providers/lifecycle behavior are verified in a real DSH environment.
19. Project/workspace/reusable isolation is verified.
20. Security and secret-scrubbing behavior is verified.
21. Performance is measured on representative repositories.
22. Failure/degraded behavior is explicitly tested.
23. Production observability exists for indexing state and failures.
24. Existing Veyra functionality and tests remain intact.
25. Upstream license/attribution requirements are preserved.
26. No unrelated architecture or feature expansion was introduced.

---

# Final Product Direction

Veyra should evolve from:

```text
Engineering Memory
```

into:

```text
Code Intelligence
+
Engineering Memory
+
Evidence
+
Validation
+
Automatic Maintenance
```

The distinction remains:

```text
Code Intelligence
= What the repository currently contains
  and how the code is connected.

Engineering Memory
= What the engineering process learned,
  decided, observed, and verified.

Evidence
= What supports those claims.

Validation
= How trustworthy/current those claims are.
```

The final system should allow a coding agent to move from:

```text
Question
  ↓
Relevant Code
  ↓
Relevant Memory
  ↓
Evidence
  ↓
Validation
  ↓
Action
  ↓
Code Change
  ↓
Incremental Re-index
  ↓
Affected Evidence / Memory Detection
```

This is the intended production direction for Veyra's Code Intelligence integration.
