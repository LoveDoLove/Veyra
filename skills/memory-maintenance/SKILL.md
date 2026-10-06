---
name: memory-maintenance
description: >
  Agent-executable memory maintenance workflow using Veyra's existing health
  reports and lifecycle commands. Runs health findings, inspects records,
  verifies against repository truth, applies lifecycle actions (KEEP /
  SUPERSEDE / INVALIDATE / FORGET / TOMBSTONE / REVALIDATE / DEFER), and
  reports before/after health changes. Use when the user asks to clean up
  memory, maintain engineering knowledge, reconcile stale or contradictory
  records, or audit Veyra health.
whenToUse: >
  Explicit memory maintenance requests, periodic health audits, or when health
  findings accumulate (contradictions, stale knowledge, unresolved
  investigations, repeated failures, unverified candidates).
---

# Memory Maintenance

Agent-executable maintenance workflow for Veyra engineering memory. Uses
**existing** health reports and lifecycle commands — never invents a second
cleanup system, never modifies memory semantics.

**Ownership boundary.** This skill owns the workflow: *what* to check, *how* to
categorize findings, *what* repository evidence validates, *which* lifecycle
action fits. Veyra Core owns storage, health, lifecycle (`/veyra invalidate`,
`/veyra supersede`, `/veyra tombstone`, `/veyra forget`, `/veyra protect`),
recall, and project isolation. Never reimplement any of that here.

## Workflow

`Health → Inspect → Verify → Apply → Re-check → Report`

### 1. Run health

Call `/veyra health` (or `veyra_health`) once at the start. Reports:

- **Nine quality categories**: verified / reviewed / unverified / stale /
  invalid / contradicted / unresolved / negative / protected
- **Six findings**: new contradictions, stale knowledge, unresolved
  investigations, repeated failures, unverified high-value candidates, memories
  requiring revalidation

Read-only. Health never mutates records.

### 2. Inspect findings

For each finding category, inspect specific records with `veyra_inspect(id)` or
`/veyra observatory record <id>`. Read:

- Full evidence anchors (path, note, uri)
- Causal facets (root cause, symptom, remedy, outcome)
- Relations (updates, supersedes, contradicts)
- Lifecycle history
- Protection status

### 3. Verify against repository

For engineering knowledge (kind: memory/knowledge/evidence), check repository
truth:

- **Evidence paths**: do the files still exist? Are line numbers still valid?
  Use `read` (file tool), `git log`, `git blame`, `grep` for the code the
  memory claims.
- **Causal claims**: does the current code still exhibit the symptom or root
  cause? Did the remedy actually land?
- **Contradictions**: are BOTH claims still true, or did one become obsolete?
- **Stale knowledge**: is the remembered constraint / pattern / decision still
  in effect?

**Repository truth wins.** If current code contradicts memory, the memory is
wrong — not the code.

### 4. Categorize and apply

For each inspected record, pick ONE action:

| Action | When | Command |
|--------|------|---------|
| **KEEP** | Evidence valid, claim current, engineering value remains | (no action) |
| **SUPERSEDE** | A newer fact clearly replaces this one (e.g., old config superseded by new config) | `/veyra supersede <old> <new> <why>` |
| **INVALIDATE** | Repository evidence proves the claim is now false (e.g., "X is forbidden" but X is now used everywhere) | `/veyra invalidate <id> <why>` |
| **FORGET** | Conversational noise, agent narration, temporary task state, no long-term engineering value | `/veyra forget <id> <why>` |
| **TOMBSTONE** | Historical note with zero active relevance, pure archaeology | `/veyra tombstone <id> [override] <why>` |
| **REVALIDATE** | Evidence unclear but might still be valuable; mark for human review | (mark in report, no auto-action) |
| **DEFER** | Cannot safely judge without more context or human input | (mark in report, no auto-action) |

**Hard rules**:

- **Never auto-delete contradictions** just to lower the health number.
  Contradictions stay visible until ONE is verified false.
- **Never delete historical engineering knowledge** just because it is old.
  "Stale" means "current code diverged from the claim", not "claim is
  timestamped last year".
- **Never promote to canonical without explicit human approval.** Canonical
  standing requires `/veyra promote <id> canonical` with `explicit: true`.
- **Never bulk delete**, never silent merge, never direct database mutation.
- **Preserved evidence trumps similarity/confidence.** A low-confidence memory
  with valid repository anchors is more valuable than a high-confidence
  candidate with no evidence.

### 5. Protected records

Canonical authority is implicitly protected. Records with explicit
`source.protection` require `/veyra forget <id> override <why>` or
`/veyra tombstone <id> override <why>`. The override reason is recorded.

Protection does **not** shield a record from repository truth:

- `/veyra invalidate` still works (repository contradiction)
- `/veyra supersede` still works (replacement fact)

### 6. Examples

#### Scenario A: Stale knowledge

**Finding**: "Decision: use CommonJS require() for all imports"  
Repository check: package.json shows `"type": "module"`, all code uses ESM.  
**Action**: `INVALIDATE` — `/veyra invalidate <id> repository uses ESM, not CommonJS`

#### Scenario B: Supersession

**Finding**: "API base is https://api-v1.example.com"  
**Later memory**: "API base is https://api-v2.example.com"  
Repository check: .env and code both use v2.  
**Action**: `SUPERSEDE` — `/veyra supersede <old> <new> v2 replaced v1`

#### Scenario C: Real contradiction

**Finding**: Two memories:
- "auth tokens expire after 1 hour"
- "auth tokens expire after 24 hours"

Repository check: `src/auth.js:42` shows `expiresIn: '24h'`.  
**Actions**:
1. `INVALIDATE` the 1-hour claim — `/veyra invalidate <id1> code shows 24h`
2. `KEEP` the 24-hour claim (it is correct)

#### Scenario D: Conversational noise

**Finding**: "User asked to rename the file"  
**Action**: `FORGET` — `/veyra forget <id> temporary task instruction, no long-term value`

#### Scenario E: Unclear evidence

**Finding**: "Database migration requires manual rollback script"  
Repository check: migration files exist, but unclear if the rollback
requirement is still true.  
**Action**: `REVALIDATE` — mark in report, defer to human judgment.

### 7. Re-check and report

After applying lifecycle actions, call `/veyra health` again. Report:

```
Memory Maintenance Complete

Actions:
- KEEP: 47
- SUPERSEDE: 3
- INVALIDATE: 2
- FORGET: 8
- TOMBSTONE: 1
- REVALIDATE: 4 (human review needed)
- DEFER: 2

Health before:
- Contradicted: 6
- Stale: 12
- Unverified: 23

Health after:
- Contradicted: 1 (deferred, needs domain expertise)
- Stale: 4 (all marked REVALIDATE)
- Unverified: 19

Remaining issues:
- [vey_abc123] contradicts [vey_def456]: token expiry ambiguity (DEFER)
- [vey_ghi789] evidence path missing (REVALIDATE)

Files modified: none (lifecycle only)
```

Keep the report **concise**. List action counts, health delta, and any
unresolved issues requiring human judgment.

## Non-goals

- **Not a scheduled job**. Run when requested, not on a timer.
- **Not a bulk delete tool**. Every action must be evidence-backed.
- **Not a canonical promotion gate**. Canonical is always explicit.
- **Not a contradiction resolver**. Contradictions surface for human review; we
  only invalidate the provably-false side.

## Boundaries

This workflow is **read-verify-apply**. It never:

- Invents new lifecycle states or commands
- Reimplements health, storage, or recall
- Auto-merges contradictions
- Promotes to canonical without explicit user confirmation
- Modifies code or configuration (lifecycle actions only)

Repository truth remains authoritative. Veyra settings stay owned by Veyra.

## When NOT to use

- Routine work sessions — let automatic observation capture what matters.
- Single-record updates — call `veyra_remember` or `/veyra invalidate` directly.
- Research or exploration — memory-maintenance is for cleanup, not discovery.
