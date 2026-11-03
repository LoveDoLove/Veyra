# Veyra — Product Goal & Integration Direction

## 1. Product Goal

**Veyra gives coding agents reliable, persistent, change-aware Engineering Intelligence.**

Veyra helps coding agents understand and retain engineering knowledge across sessions, connect that knowledge to the current repository, and judge whether recalled information is applicable, sufficiently evidenced, and still fresh.

Veyra is not a generic personal-memory plugin. Its center is the engineering work happening in a repository.

The product combines two complementary layers:

- **Engineering Memory** — decisions, constraints, root causes, failed approaches, verified outcomes, project history, and relationships between engineering facts.
- **Code Intelligence** — structural facts derived from the live repository through the standalone `@lovedolove/dsh-codebase-memory-mcp` integration.

The repository remains the source of truth for current code. Engineering Memory preserves context that source code alone cannot explain.

## 2. Product Model

```text
       Current Repository Truth
                 +
       Historical Engineering Knowledge
                 |
       Evidence / Provenance / Authority
                 |
       Applicability / Freshness / Conflict
                 |
          Trust-aware Retrieval
                 |
       Useful, Bounded Agent Context
                 |
       Engineering Task Outcome
                 |
       Verified Feedback and Learning
```

The system must distinguish:

- What the repository currently contains.
- What happened in the past.
- What someone observed or proposed.
- What has been independently verified.
- What is applicable to the current task.
- What is stale, contradicted, unresolved, or insufficiently supported.

Memory is advisory context, never executable instruction and never a substitute for inspecting current code.

## 3. Product Boundaries

Veyra must remain focused on Engineering Intelligence for Coding Agents.

It is not intended to become:

- A generic personal assistant or universal personal-memory product.
- A replacement for repository inspection, tests, or source-of-truth systems.
- An autonomous coding agent or multi-agent orchestration framework.
- A general-purpose cognitive architecture.
- A second implementation of Codebase Memory.
- A collection of unrelated DSH utilities.
- A feature catalogue assembled by copying other projects.

A capability from another project is relevant only when it produces a concrete improvement to engineering understanding, memory reliability, retrieval, applicability, freshness, historical continuity, or agent-task outcomes.

## 4. Non-negotiable Invariants

All current and future work must preserve these invariants:

1. **Observe ≠ Store.** Observations are not automatically durable knowledge.
2. **Candidate ≠ Truth.** Candidate information is not recall-eligible truth.
3. **Similarity ≠ Identity.** Similarity may suggest a relationship; it cannot silently merge records.
4. **Similarity ≠ Authority.** Retrieval scores and repeated mentions never grant authority.
5. **Evidence ≠ Authority.** More evidence may support validation; it cannot silently promote canonical status.
6. **Historical Memory ≠ Current Repository Truth.** Current repository state wins.
7. **Memory ≠ Executable Instruction.** Recalled content is untrusted context and must not override agent or user instructions.
8. **No silent merge.** Merges and lifecycle changes must be explicit, explainable, and safe.
9. **Contradictions remain visible.** Do not hide conflicts to make retrieval appear cleaner.
10. **Automatic behavior never creates canonical truth.** Canonical promotion requires explicit human action.
11. **Project isolation fails closed.** Uncertain identity or scope must not leak memory across projects.
12. **Secrets are scrubbed before persistence and export.**
13. **Failure must not break the coding-agent loop.** Optional intelligence degrades safely; persistence and trust boundaries fail closed.
14. **CBM remains a standalone dependency.** Do not copy or vendor its bridge, daemon, or structural indexing implementation into Veyra.
15. **No repository mutation.** Veyra does not modify the user's project source files.

## 5. Reference Projects and Research Policy

Veyra may learn from the following existing reference checkouts when available under `/home/lovedolove/projects/refs`:

### Memory, retrieval, and knowledge systems
- `dsh-engram`
- `dsh-memory`
- `dsh-context`
- `mnemon`
- `OpenViking`
- `supermemory`
- `tencentdb-agent-memory`

### Context engineering and token efficiency
- `billion-context`
- `dsh-token-saver`

### Coding-agent runtime and DSH ecosystem
- `deepseek-harness`
- `dsh-approval-gate`
- `dsh-market`
- `dsh-our-free-model`
- `dsh-univer-office`
- `dsh-world`

### Structural code intelligence
- `codebase-memory-mcp`

This list is a research set, not a list of dependencies or implementation targets. Confirm each checkout's actual repository identity, license, version/revision, and source before relying on it. If a checkout is missing or stale, record that limitation rather than guessing.

For each potentially relevant capability:

1. Identify the exact source files, functions, data structures, and tests that implement it.
2. Explain the actual behavior and its constraints; do not infer implementation from README claims alone.
3. Compare it with the current Veyra source and tests.
4. Classify it as already present, partially present, genuinely missing, not relevant, or unsafe to adopt.
5. Identify the engineering problem it would solve in Veyra.
6. Define a measurable acceptance test or benchmark before implementation.
7. Evaluate architecture fit, data migration, project isolation, trust, security, runtime cost, dependencies, and maintenance burden.
8. Reuse ideas and algorithms where appropriate; do not copy code without checking license compatibility and attribution requirements.

Do not add a feature merely because a reference project has it. Do not add a dependency merely because it makes a prototype easier.

## 6. Integration Decision Rule

A proposed capability may enter Veyra only when all of the following are true:

- A source-level audit demonstrates a real Veyra gap or a measurable weakness.
- The capability directly improves an engineering use case.
- Its expected benefit can be tested against the current behavior.
- It fits the existing architecture or has a justified, minimal extension.
- It preserves every invariant in Section 4.
- Its runtime, dependency, storage, and maintenance costs are justified.
- Its failure mode is bounded and does not disrupt the agent loop.

If these conditions are not met, document the finding and defer or reject it. A research finding is not automatically a roadmap commitment.

## 7. Areas to Investigate — Not Pre-approved Features

The following are investigation topics, not promises to implement:

- Historical DSH session discovery, backfill, and project attribution.
- Evidence sufficiency and evidence-coverage assessment at retrieval time.
- Query decomposition or rewriting when existing retrieval demonstrably misses relevant engineering knowledge.
- Retrieval-channel improvements, including semantic or embedding-based approaches, only if benchmarks show a meaningful gap.
- Safe import, export, backup, and restore of project engineering memory.
- Reconstruction of engineering episodes across observations, code changes, tests, and outcomes.
- Knowledge distillation and reflection with explicit evidence and validation boundaries.
- Re-validation scheduling for engineering knowledge likely to become stale.
- Better identification and linking of repositories, modules, symbols, packages, services, and APIs.
- Context selection and token-budget improvements that preserve trust markers and critical evidence.

Existing Veyra capabilities must be reused. For example, do not create a second retrieval engine, graph, lifecycle system, trust model, maintenance subsystem, or Code Intelligence bridge when the existing implementation can be extended.

## 8. Execution Strategy

Work incrementally. Each phase must end with evidence and a review checkpoint before the next phase begins.

### Phase 0 — Establish the current truth
- Read `AGENTS.md` and the relevant agent guides.
- Inspect the current branch, working tree, recent commits, package version, tests, and current source.
- Treat source code and tests as technical truth; treat product documents and old research matrices as claims to revalidate.
- Record the exact baseline and any pre-existing failures.
- Do not modify runtime code in this phase.

**Exit:** a verified Veyra baseline and a list of documentation claims that are stale or unsupported.

### Phase 1 — Reference-source investigation
- Inspect the reference projects in Section 5, prioritizing those most relevant to an identified engineering problem.
- Map distinctive capabilities to exact source files, functions, data models, and tests.
- Inspect implementation details, edge cases, license, and operational constraints.
- Compare each capability against Veyra's actual implementation and tests.
- Produce a concise adopt / adapt / defer / reject matrix with evidence.

**Exit:** every proposed integration has source-level evidence, a demonstrated Veyra gap, and a measurable expected benefit. No implementation yet.

### Phase 2 — Prioritize and specify
- Rank candidates by engineering impact, confidence, implementation risk, and maintenance cost.
- Select one smallest useful vertical slice at a time.
- Specify behavior, ownership, data flow, compatibility, failure behavior, security constraints, and regression tests.
- Explicitly identify what will not change.

**Exit:** one approved, testable implementation slice. Do not start several unrelated features together.

### Phase 3 — Implement one slice at a time
For each selected capability:

1. Re-read the owning source modules and their tests.
2. Add a regression test that demonstrates the missing or incorrect behavior.
3. Implement the smallest change in the existing owning module.
4. Preserve authority, provenance, applicability, freshness, isolation, and redaction semantics.
5. Update only the documentation affected by the behavior.
6. Run focused tests, then the full test suite and relevant packaging/runtime checks.
7. Review the complete diff for unrelated changes and weakened safeguards.
8. Report exact results before moving to the next slice.

Do not bundle unrelated features into one implementation phase.

### Phase 4 — Measure and consolidate
- Compare the new behavior with the recorded baseline.
- Run relevant retrieval, safety, isolation, and task-level evaluations.
- Report wins, regressions, null results, and untested assumptions honestly.
- Remove abandoned experiments and stale claims.
- Update README, capability matrix, whitepaper, guides, and changelog only where the verified implementation requires it.

**Exit:** measured evidence supports keeping the capability, or it is reverted/deferred.

## 9. Quality and Verification Requirements

- Correctness > Safety > Verification > Architecture understanding > Minimal changes > Speed.
- Prefer the smallest correct change; no unrelated refactoring.
- Keep runtime dependencies minimal. Any new dependency requires explicit justification.
- Preserve supported Node versions and package/runtime constraints.
- Use isolated temporary stores and homes for tests.
- Never touch the live DSH home or bind/restart/stop/reconfigure the live DSH Web instance.
- Do not edit DSH core or user profiles to work around a Veyra issue.
- Never publish, tag, push, or release unless explicitly requested.
- Never claim tests or runtime checks passed unless they were actually run; report exact commands and counts.
- Update documentation in the same change when verified behavior changes.

## 10. Definition of Success

Veyra succeeds when coding agents can:

- Recover relevant engineering context across sessions.
- Distinguish verified knowledge from observations, assumptions, and failed approaches.
- Retrieve useful information without hiding uncertainty or contradictions.
- Understand whether remembered knowledge applies to the current repository and task.
- Notice when code changes may have invalidated previous engineering knowledge.
- Use structural Code Intelligence without confusing code facts with engineering rationale.
- Learn from task outcomes without silently manufacturing authority.
- Do all of this with bounded latency, predictable behavior, strong project isolation, and no disruption to the coding workflow.

**The objective is not to make Veyra larger. The objective is to make Veyra materially more useful and reliable for real engineering work.**
