# Veyra Reference Research PRD

**Document Type:** Product Research Requirements Document  
**Project:** Veyra — Engineering Intelligence for Coding Agents  
**Status:** Approved  
**Owner:** CEO  
**Execution Owner:** CTO / Senior Engineer

## 1. Product Vision

Veyra's core objective:

> Enable Coding Agents to automatically remember what they learn and automatically use those memories to improve future work.

The target capability loop is:

`Experience → Learn → Remember → Understand → Apply → Improve`

Veyra is not merely a memory store or retrieval tool. It should accumulate engineering experience, understand the resulting memories, apply them appropriately in future work, and improve through evidence.

## 2. Research Objectives

The research must answer:

1. How do existing projects implement automatic experience capture and learning?
2. How do they assess memory value, trust, applicability, and lifecycle?
3. How do they retrieve relevant memories and deliver context to Coding Agents?
4. How do they establish whether an Agent actually used memory and whether it improved the result?
5. Which capabilities does Veyra already have, and which gaps are demonstrable?

## 3. Research Scope

### 3.1 Experience — Automatic Experience Capture
- How agent activity is observed and valuable engineering events identified.
- How tool output, errors, edits, and task outcomes are handled.
- How irrelevant and sensitive information is excluded.

### 3.2 Learn — Automatic Learning
- How reusable knowledge is extracted from work sessions.
- How verified success, failure, and accidental outcomes are distinguished.
- How candidate knowledge is validated.
- How duplicates, contradictions, and incorrect learning are handled.

### 3.3 Remember — Memory Storage & Lifecycle
- Memory types, provenance, evidence, and persistence.
- Update, strengthening, invalidation, staleness, and retirement.
- Trust and authority boundaries.
- Prevention of unverified memories becoming authoritative.

### 3.4 Understand — Memory Understanding & Retrieval
- Current task intent and repository context.
- Applicability to repository, code state, and task.
- Freshness, trust, and evidence-aware selection.
- Handling irrelevant and contradictory memories.

### 3.5 Apply — Automatic Context Delivery & Application
- Automatic retrieval triggers and timing.
- Context delivery to Coding Agents.
- Context budgets and protection against irrelevant or unsafe injection.
- Evidence that context was generated, delivered, and actually used. These are separate claims.

### 3.6 Improve — Feedback & Continuous Improvement
- Outcome signals after memory use.
- Identification of helpful, ineffective, or harmful memories.
- Evidence-based memory refinement.
- Evaluation of sustained improvement, not only isolated test success.

## 4. Reference Projects

Research local checkouts under `~/projects/refs/`. First inspect the directory and confirm which projects actually exist. Candidate projects include:

- `dsh-market`
- `dsh-approval-gate`
- `dsh-univer-office`
- `dsh-memory`
- `dsh-engram`
- `dsh-context`
- `billion-context`
- `codebase-memory-mcp`
- `dsh-our-free-model`

This list is a research starting point, not an assertion that every directory exists. Do not clone additional projects or broaden the scope without approval. Additional local projects may be included only when directly relevant, with the reason documented.

## 5. Research Method

Inspect, where relevant:

1. Repository structure and entry points.
2. Core implementation and end-to-end execution flow.
3. Hooks, tools, skills, providers, and context integration.
4. Storage, retrieval, ranking, and lifecycle mechanisms.
5. Tests and evaluation methods.
6. Failure handling, limitations, privacy, and safety boundaries.

For each material finding, record:
- Project and exact file/function or test location.
- What the implementation actually does.
- Evidence type: source code, test, runtime, documentation only, or not verified.
- What the evidence proves and does not prove.
- Strengths, limitations, and relevance to Veyra.

Documentation claims alone must not be reported as verified implementation. Passing tests do not, by themselves, prove real Agent utility.

## 6. Veyra Capability Gap Analysis

Compare findings against Veyra's current implementation. Classify every capability as exactly one of:

- **Already Implemented** — implementation and sufficient evidence exist.
- **Partially Implemented** — foundations exist, but an important part remains unproven or incomplete.
- **Missing** — evidence demonstrates that the capability is absent.
- **Not Applicable** — unsuitable for Veyra's product objective or constraints.

Prioritize reuse of Veyra's existing automatic observation, learning, memory, recall, and context-delivery foundations. Do not rebuild existing capabilities merely to imitate a reference project.

Preserve Veyra's invariants: observation is not truth; candidates are not authoritative; similarity is not applicability; contradictions remain visible; repository truth wins; project isolation is fail-closed; secrets are redacted before persistence; memory is context, not instruction.

## 7. Evaluation Requirements

Evaluate the full loop and keep these stages distinct:

| Stage | Evaluation question |
| --- | --- |
| Experience | Was valuable engineering experience captured? |
| Learn | Was correct, reusable knowledge extracted? |
| Remember | Was it stored with evidence, trust, and lifecycle controls? |
| Understand | Was the right memory selected for the current task? |
| Apply | Was it delivered to and actually used by the Agent? |
| Improve | Did its use improve the task outcome? |

Never treat memory generated, stored, retrieved, or context delivered as proof of Agent utilization or task improvement.

## 8. Deliverables

Produce these four research documents:

1. `REFERENCE-RESEARCH-REPORT.md` — implementation-level findings for each inspected reference project.
2. `REFERENCE-CAPABILITY-COMPARISON.md` — comparison across the six capability stages.
3. `VEYRA-CAPABILITY-GAP-ANALYSIS.md` — evidence-based assessment of Veyra's current capabilities.
4. `VEYRA-IMPROVEMENT-PROPOSAL.md` — prioritized improvement options, expected value, evidence, risks, and unresolved questions.

Place deliverables under `docs/research/reference-projects/`. Do not create empty or speculative reports; clearly mark incomplete areas.

## 9. Constraints and Non-Goals

During this research phase:

- Do not modify Veyra production source code, tests, package files, dependencies, schemas, or runtime configuration.
- Do not modify reference project checkouts.
- Do not introduce architecture or implement proposed improvements.
- Do not run benchmarks, agent/model/API experiments, or runtime experiments unless separately approved.
- Do not submit upstream issues, PRs, or proposals.
- Do not commit, push, tag, or release unless separately authorized.
- Do not access or alter live DSH profiles, DSH Web runtime, credentials, or authoritative live databases.
- Preserve all existing local modifications and untracked files. No destructive Git commands or cleanup.
- Report limitations and unknowns honestly; do not invent evidence.

Read Veyra's `AGENTS.md` and the relevant agent guides before research. The repository and current source code remain authoritative.

## 10. Acceptance Criteria

Research is complete only when:

- [ ] Actual local reference directories and selected scope are recorded.
- [ ] All six capability stages have research findings or explicit evidence-backed gaps.
- [ ] Material claims cite exact source/test locations and evidence strength.
- [ ] Reference implementations are compared with their limitations.
- [ ] Veyra's existing architecture and capabilities are assessed.
- [ ] Every assessed capability is classified using the four categories above.
- [ ] Genuine gaps are separated from unverified observability or evidence limitations.
- [ ] Improvement options are prioritized with rationale, expected value, risks, and dependencies.
- [ ] No unauthorized code, environment, or repository changes were made.

## 11. Decision Gate

After the four deliverables are ready, stop and submit them for CEO review.

Only after CEO approval may the team draft a separate **Veyra Product Improvement PRD** that selects improvements, implementation scope, verification strategy, and target release.

**Final principle:** Veyra's success is measured not by how many memories it stores, but by whether Coding Agents automatically learn from engineering experience, correctly apply that knowledge in future work, and improve their results.
