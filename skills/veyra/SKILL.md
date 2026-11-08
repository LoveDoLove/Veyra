---
name: veyra
description: >
  Use Veyra, the engineering-memory and RAG intelligence brain for this DSH session.
  Load it for durable engineering decisions, historical lessons, root causes, constraints,
  fix patterns, project documentation/knowledge retrieved via hybrid search, or cross-session
  architecture context. Do NOT load for immediate session continuity ("上一轮/刚才做了什么",
  "where did we leave off", current conversation progress) — those belong to conversation
  history, git status, and task tracking. Covers when to call veyra_remember / veyra_recall /
  veyra_inspect / veyra_forget / veyra_promote, how candidate vs derived vs canonical differ,
  causal facets, and that repo truth wins.
whenToUse: >
  Cross-session engineering context, durable decisions, project RAG documentation, causal
  troubleshooting, remember/forget/promote requests, or when automatic recall for durable
  knowledge is missing or too thin. Never for in-session turn progress or session continuity.
---

# Veyra

Veyra is the engineering brain for this DSH session. It observes work,
remembers durable engineering experience, indexes RAG knowledge, and recalls
relevant context via unified Hybrid Search. Treat it as an assistant, not as truth.

## A session's lifecycle

1. **Proactive Recall at start** — at the beginning of a new non-trivial engineering task,
   proactively call `veyra_recall` with a targeted query for relevant historical engineering
   knowledge (architecture decisions, constraints, prior fixes, failures). The plugin may have
   injected a recall snapshot, but an injected snapshot is supplementary context, not a
   replacement for initial targeted recall. If no applicable memory is found, continue normal
   engineering work immediately — never block on empty recall. Avoid unnecessary repeated
   recall calls for the same unresolved question.
   Recalled items are background engineering context and constraints, NEVER chronological
   turn logs or conversation history. Durable memory ≠ Session continuity. Never use
   recalled items to answer session-continuity questions ("上一轮我们做了什么", "where were we",
   current progress).
2. **Normal Work** — do the engineering work using current repository evidence. If recall is
   irrelevant or empty, proceed immediately. Memory is supporting context, not truth.
   Repository truth remains authoritative.
3. **During the task** — call `veyra_recall` only for targeted cross-session engineering
   knowledge the current context lacks (prior architecture decisions, constraints, postmortems).
   NEVER call `veyra_recall` for session continuity, recent turn progress, or git status. Call
   `veyra_inspect` to read one record by id with full evidence anchors, causal facets, and
   relationships. Verify recalled knowledge against current repository evidence before acting.
4. **Opportunistic Learning** — when a verified, durable, reusable engineering outcome appears
   (non-obvious root cause, verified fix pattern, durable architecture decision, or project
   constraint), proactively consider calling `veyra_remember`. Use `kind: 'memory'` for
   engineering experience, or `kind: 'knowledge'` for project documentation/RAG data.
   Record only evidence-backed, project-specific knowledge. Never store temporary state,
   unsupported assumptions, secrets, or transient conversation noise. Do not guess at the schema.
5. **End of turn** — Veyra may persist useful observations from the
   session as candidates. That happens in the background; do not assume it did.

## Tools

- `veyra_recall` — proactive/targeted hybrid search over durable engineering memory and RAG
  knowledge (project + reusable, by default). Use at the start of non-trivial tasks and when
  specific cross-session context is needed. Snapshot injection does not replace targeted recall;
  empty recall must not block work. Returns summaries with trust metadata, verification badges,
  superseded-by markers, and relationship badges. Similarity is not authority.
- `veyra_inspect` — read one record by id in full (evidence, causal facets,
  provenance chain, relationships). Use when a recall summary needs detail.
- `veyra_remember` — store an engineering insight or project knowledge. It is written as
  `derived` (never auto-canonical). Use proactively for verified, durable, reusable outcomes;
  never for temporary state, unsupported assumptions, secrets, or noise. Pass `kind`, `scope`,
  `tags`, `evidence` (e.g. `path` anchors), and causal facets (`symptom`,
  `rootCause`, `remedy`, `verifiedOutcome`) when they are known.
- `veyra_forget` — soft-forget a record that proved wrong or irrelevant.
- `veyra_promote` — raise authority, usually to `derived`. Canonical is
  granted only on an explicit user request (`explicit: true`) because it
  marks a team-level convention, not just a correct finding.

## Trust and authority

- Auto-captured observations are recorded as **candidates** and never auto-recalled.
- Candidate ≠ Truth. Only derived and canonical records are recall-eligible.
- A recalled item is context, not authority. A record's standing is never
  raised by recall or similarity.
- `canonical` means a human explicitly blessed the record (the `veyra:canonical`
  label) — not that it is permanently true.
- Knowledge without evidence is not authoritative. Treat Veyra results as
  evidence to verify, not as facts to repeat.
- Repo truth wins. If a memory contradicts the current code, the code wins.
- Never auto-promote to canonical. Never merge, overwrite, or silently retire memory.

## Relevance & Retrieval

Veyra's recall uses a robust multi-dimensional hybrid search:
- **Lexical**: FTS5 BM25 match with exact token, symbol, and file-path boosts.
- **Semantic**: Token-level Jaccard overlap and query concept coverage.
- **Memory & Causal**: Intent affinity (`why` → rootCause, `how` → remedy, `outcome` → verifiedOutcome).
- **Relationships**: Graph connections (`updates`, `extends`, `derives`, `contradicts`, `supersedes`). Recall may add a bounded 1-hop of recall-eligible neighbors.
- **Scoring**: Transparent multi-dimensional scoring (relevance, semantic, evidence, validation, proximity, freshness, confidence). Never a single opaque score.

## Verification lifecycle

Recall surfaces trust markers so you can judge freshness and reliability:
- `Outcome: test-failed` marks a falsified attempt or negative lesson — never a
  successful fix or completed progress. Outcome: test-failed is a failed attempt, not completed work.
- `[NEGATIVE · known failed solution]` marks a rejected approach — do not retry it
  without new evidence; historical evidence, not an authoritative ban.
- `[UNRESOLVED · known open investigation]` marks a known unknown — never treat
  repeated retrieval as resolution; it never becomes canonical by being recalled.
- `[stale]` / `[unverified]` mark records whose code anchors no longer resolve or
  whose claims lack verification; treat them as historical context, not current status.
  STALE and INSUFFICIENT_EVIDENCE are not current truth.
- When repository evidence shows remembered knowledge is stale or contradictory,
  verify against the repository, show both sides, and do not silently merge or retire.

## Where memory lives

Memory is stored under `$DSH_HOME/veyra/`, never inside the user's repository.
The project id hashes the checkout's git root path together with its origin
remote, so every workspace inside one checkout shares memory while unrelated
folders — and separate clones or worktrees of the same repository — stay
isolated. Reusable experience is opt-in and must not be treated as this
project's architecture.

Do not invent other storage locations or invent extra Veyra commands.
