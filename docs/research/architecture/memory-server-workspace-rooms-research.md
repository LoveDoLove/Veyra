# Veyra Architecture Research: Memory Server and Workspace Memory Rooms

**Audience:** CTO  
**Type:** Architecture research and technical investigation  
**Status:** Research only. CEO authorized research; implementation not authorized.  
**Date:** 2026-11-09  
**Scope:** Veyra memory architecture, DSH workspace/lifecycle contracts, and reference comparison with `dsh-mnemon`.  
**Constraint compliance:** No runtime implementation code, package metadata, dependency, schema, or memory-data changes were made. No production DSH Web database, restart, or configuration change was performed. Existing dirty and untracked files were preserved.

## 1. Executive summary

Veyra already has the right product goal and several safety invariants that must survive any redesign: engineering memory is evidence, not repository truth; candidates are not truth; similarity is not authority; automatic behavior never becomes canonical truth; project isolation is a hard boundary; writes are redacted before persistence; and observation or recall failures must not break the agent loop. The current implementation does not yet provide the workspace model requested by this research brief.

The main architectural gap is identity. Veyra currently resolves a workspace from session/header/cwd fallbacks and derives a project partition from `gitRoot|remote` (`src/ids.mjs:142-220`). It stores one SQLite database per derived project id and one shared reusable SQLite database (`src/ids.mjs:113-121`, `src/store.mjs:766-789`). That model gives path/repository-based isolation, not DSH-workspace-based isolation. Two DSH workspaces that point to the same repository can collapse into the same Veyra project id today, which conflicts with the required invariant that different DSH workspaces have independent private memory rooms unless explicit sharing is approved.

Installed DSH contracts show that DSH already has an authoritative workspace concept: `WorkspaceId` is a branded generated UUID, never a path; `Workspace.path` is the canonical `fs.realpath` of the create-time path; a workspace owns a manually ordered `sessionIds` set; and session attachment validates that the session header `cwd` resolves to an existing directory equal to the workspace path (`@deepseek-ai/dsh-workspace/lib/types/types.d.ts:61-137`, installed DSH node_modules). The session header carries `cwd` (`@deepseek-ai/dsh-session/lib/types/types.d.ts:39-57`), and the workspace controller exposes `WorkspaceView.workspaceId/path/title/sessionIds` (`@deepseek-ai/dsh-api-workspace-controller/lib/types/types.d.ts:24-74`).

The recommended direction is an in-process Veyra Memory Server service owned by the Veyra Cordis plugin lifecycle, not an external daemon. The service should expose a Memory Router below prompt and tool code, resolve authoritative workspace context from DSH session/workspace contracts, and fail closed when that context is unavailable or ambiguous. A Memory Room should be keyed primarily by DSH `WorkspaceId`. Central Memories should remain exactly one logical governed space, fed only by an explicit promotion pipeline from workspace evidence.

This design is **not yet fully ready for implementation** because the installed contracts reviewed here verify workspace and session data shapes, but they do not by themselves prove the exact Host/plugin API Veyra should use to resolve "current session belongs to workspace X" with sufficient authority and lifecycle guarantees in the running DSH Web host. The storage and migration path is feasible incrementally with SQLite-per-room plus one Central Memories database, but workspace-binding resolution and migration heuristics need a verified Host integration contract.

**CTO recommendation:** `PARTIALLY_READY`.

## 2. Current architecture findings based on source-code evidence

### 2.1 Plugin composition and lifecycle

**Verified facts (current Veyra).**

- Veyra is a DSH Cordis plugin named `veyra` that injects `tools` and registers runtime behavior in `apply(ctx, config)` (`src/plugin.mjs:62-121`).
- It registers system prompt guidance/context, model tools, `/veyra` commands, skills, a `/veyra` web endpoint, session/agent hooks, and Code Intelligence bridge/watcher wiring (`src/plugin.mjs:186-448`).
- It uses `ctx.effect` to register cleanup and disposers, and closes stores through `runtime.close()` / `closeAllStores()` during cleanup (`src/plugin.mjs:237-448`).
- Veyra has no separate "Memory Server" abstraction in `src/`. Memory access is performed by plugin/tool/context code through store and retrieval modules.

### 2.2 Workspace identity and storage layout

**Verified facts (current Veyra).**

- Veyra home resolves from config home, then `$VEYRA_HOME`, then `$DSH_HOME/veyra`, then `~/.dsh/veyra` (`src/ids.mjs:24-31`). Data is outside the user repository.
- Project identity is derived by `projectIdFor(cwd)`: resolve `cwd`, find a git root by walking up to 12 levels, read origin remote from `.git/config` without spawning git, build key `${gitRoot || resolved}|${remote}`, and hash it to `p_<sha256 prefix>` (`src/ids.mjs:142-220`).
- Storage paths are `projects/<projectId>/memory.db` and `reusable/memory.db` (`src/ids.mjs:113-121`).
- Workspace resolution prefers `session.header.cwd`, then `agent.session.header.cwd`, then several header/cwd fallbacks, then `process.cwd()` (`src/ids.mjs:94-109`). It is path/cwd-derived.
- Provenance dimensions record workspace/repository/remote/agent as attribution (`src/ids.mjs:150-160`), not as an authorization boundary.

**Current behavior implication.**

- A DSH workspace identity is not used. The partition key is repository/path oriented.
- Different DSH workspaces on the same repository and remote are likely to share the same Veyra project id, because the key ignores DSH `WorkspaceId` and uses `gitRoot|remote`.
- A workspace path is used for locating context and deriving partitioning, but the codebase's invariants state it must not become an authorization proof. The implementation still depends on cwd/header path quality for selecting the room.

### 2.3 Storage engine

**Verified facts (current Veyra).**

- Storage uses Node's built-in `node:sqlite` `DatabaseSync` (`src/store.mjs:21`), with no native addon dependency in Veyra source.
- Schema v1 includes `meta`, `memory`, FTS5 `memory_fts` and `memory_search_fts` tables, triggers, and indexes; WAL is enabled (`src/store.mjs:63-131`, `408-429`).
- `openProjectStore` and `openReusableStore` cache stores by db path key in `storeCache`; `closeAllStores` closes cached stores and clears watchers (`src/store.mjs:766-805`).
- Store writes merge/dedup evidence with a cap (`src/store.mjs` header evidence; put/merge logic exists in file) and parse JSON fail-closed for corruption paths.

**Current behavior implication.**

- SQLite-per-project plus one reusable SQLite database is already close to the requested per-room plus Central Memories physical shape.
- Connection ownership is process-local and cache-based, not exposed as a dedicated concurrency-managed service.
- Transaction boundaries and concurrent workspace write policy are not represented as a first-class Memory Server contract in Veyra source.

### 2.4 Recall and learning

**Verified facts (current Veyra).**

- Automatic recall is provided through a system prompt context provider. It resolves workspace from the agent, ensures watcher state, derives a query from claimed prompt/history/task intent/change signals, and fail-closes ambient recall when there is no task signal and no change signal/test hook (`src/context.mjs:95-160+`).
- Recall opens project and reusable stores, calls retrieval, applies applicability/zero-signal filtering, touches recalled ids, composes budgeted output, and emits generation evidence best-effort (`src/context.mjs:160+`).
- Retrieval is hybrid and safety-aware: lexical/semantic/intent/causal/relationship/evidence/validation/proximity/freshness/confidence/applicability/temporal/goal/anchor scoring with authority/lifecycle/polarity/eligibility handling, near-duplicate suppression, contradiction/topic banners, and negative/unresolved coverage (`src/retrieve.mjs:1-80+`, full file present).
- Learning uses write-gate verdicts `ACCEPT/MERGE/DROP/DEFER`, provenance checks, durability/grounding checks, narrative-only guards, evidence merge, and `strengthenMemory` that never auto-promotes canonical (`src/learn.mjs:22-180+`).
- Observation buffers turn events and distills candidates from tool/user signals; auto-captured records remain candidates (`src/observe.mjs:1-260`). Memory lifecycle supports guarded retirement/tombstone/protection (`src/lifecycle.mjs:1-260`).
- Model tools expose remember/recall/inspect/forget/promote/feedback/recurrence/health and select stores by resolved workspace/scope (`src/tools.mjs:1-220+`).

**Current behavior implication.**

- Veyra already has meaningful automatic recall and automatic learning behavior. A redesign must preserve these capabilities and their regression coverage, not merely move files around.
- The missing layer is authoritative routing/authorization and DSH-workspace room identity, not the absence of recall/learning logic.

## 3. dsh-mnemon architecture findings

### 3.1 Product and package shape

**Verified facts (`refs/dsh-mnemon`, v0.5.43).**

- `dsh-mnemon` is an ESM package for DSH `>=0.2.0-rc.2 <0.2.1-0 || >=0.2.1-rc.1 <0.3.0-0` (`refs/dsh-mnemon/package.json:1-96`).
- README describes a composable view-based context system: Sources own memory and operations, Strategy composes turn participation, and Core validates immutable Views. It includes runtime memory, project documents, memory spaces/providers, skills, local/per-provider storage, and Git sync/reconciliation (`refs/dsh-mnemon/README.md:1-173`).
- Storage model docs describe runtime memory, active/cold Documents, and Memory Spaces/providers with independent provider stores and graph/rank fusion (`refs/dsh-mnemon/docs/en/reference/storage-model.md:1-220+`).

### 3.2 Host lifecycle and runtime

**Verified facts.**

- The host plugin is a DSH Cordis plugin named `dsh-mnemon`, injecting `server`, `tools`, `skills`, `agentPresets`, and `systemPrompt`, and registers config/runtime/lifecycle/tools/system prompt/commands/skills/RPC/view/settings/remote services (`refs/dsh-mnemon/src/host/plugin.ts:1-120`).
- `createRuntimeGraph` builds a runtime generation with storage root, memory composition, composable turns, source host, and retire/dispose behavior (`refs/dsh-mnemon/src/host/runtime.ts:52-97`).
- `LiveMnemonRuntime` swaps stable proxy faces across generations, tracks workspace and agent graphs, and routes by workspace/session/agent (`refs/dsh-mnemon/src/host/runtime.ts:240-330+`).
- Lifecycle hooks agent/session behavior, including pre-step logic and idle review/task agents; it resolves session cwd from `agent.session.header?.cwd` and uses workspace paths for task agent directories and scope checks (`refs/dsh-mnemon/src/host/lifecycle.ts:220-380`, `969-1284`).

### 3.3 Scope and storage identity

**Verified facts.**

- Core operation scope is `MemoryOperationScope { storage: 'global'|'workspace'|'custom'|'workspaces'; workspaceId?; sessionId?; agentId? }` (`refs/dsh-mnemon/src/core/contracts/index.ts:1-37`).
- `agentScope` uses `agent.session.header?.cwd?.trim()` and sets `workspaceId` to `resolve(cwd)` when present (`refs/dsh-mnemon/src/host/runtime.ts:47-49`).
- Storage root selection supports `global`, `workspace` (`<workspace>/.mnemon`), `custom`, and `workspaces` (`<dataDir>/workspaces/<workspaceStorageId>`) (`refs/dsh-mnemon/src/host/storage-root.ts:17-28`). `workspaceStorageId` hashes canonical workspace path (`refs/dsh-mnemon/src/sdk/workspace-storage.ts:1-34`).
- Memory Spaces have independent provider/location/active state and are a control plane; activation of spaces is separate from Mnemon's default store (`refs/dsh-mnemon/docs/en/reference/storage-model.md:220-320+`).

**Reference implication.**

- dsh-mnemon demonstrates in-process lifecycle-managed runtime composition and path/workspace-root scoping patterns in DSH. It does not, in the evidence reviewed here, use DSH `WorkspaceId` UUID as the primary persisted workspace room key; it uses resolved workspace path/cwd-derived scope and canonical path hashing for the `workspaces` storage mode. Veyra must not copy this path-as-workspace-id assumption if it needs the stronger DSH-workspace isolation invariant.

## 4. DSH lifecycle and workspace API findings

### 4.1 Workspace contracts

**Verified facts (installed DSH `@deepseek-ai/dsh-workspace` and `@deepseek-ai/dsh-api-workspace-controller`).**

- `WorkspaceId` is a branded string, generated as a UUID and never a path (`@deepseek-ai/dsh-workspace/lib/types/types.d.ts:61-63`).
- A `Workspace` has stable `id`, canonical `path` (`fs.realpath` of the create-time path, never rewritten even if the directory disappears), `title`, timestamps, and manually owned `sessionIds` (`types.d.ts:65-107`).
- `attachSession` validates that a live or persisted session header `cwd` resolves to an existing directory whose canonical path equals the workspace path; it is idempotent aside from prune behavior (`types.d.ts:107-110`).
- `sessionIds` is a filtered synchronous view: candidates with missing headers, invalid cwd, or canonical cwd mismatches are never returned; ENOENT on a fully qualified cwd preserves an existing candidate as dangling symlink/missing-dir behavior (`types.d.ts:83-106`, `134-137`).
- The workspace domain spec stores durable registry state: `workspaceIds`, `defaultWorkspaceId`, archived/pinned session ids, and pending create/delete mutation (`@deepseek-ai/dsh-workspace/lib/types/spec.d.ts:7-37`).
- The controller/API surface exposes `WorkspaceView` and workspace namespace operations including create/list/follow/archive/pin/session insertion (`@deepseek-ai/dsh-api-workspace-controller/lib/types/types.d.ts:24-260`).

### 4.2 Session contracts

**Verified facts (installed DSH `@deepseek-ai/dsh-session`).**

- `SessionHeader` includes `version`, `id`, `createdAt`, optional absolute `cwd`, `parentSession`, `isSeeded`, optional `origin: 'subagent'`, `delegationDepth`, and `agentPreset` (`@deepseek-ai/dsh-session/lib/types/types.d.ts:39-57`).
- Request header events have canonicalization/folding helpers (`@deepseek-ai/dsh-session/lib/types/request-header.d.ts:1-80`).

### 4.3 Plugin/lifecycle surface

**Verified facts / observed contracts.**

- Cordis context is the plugin container and supports scoped child contexts; the installed context type mentions isolation/intercept maps and scoped service lookup (`@deepseek-ai/cordis/lib/types/context.d.ts:12-81`).
- Veyra and dsh-mnemon both use `ctx.effect` for cleanup registration in plugin code (`src/plugin.mjs:237-448`; dsh-mnemon host patterns). This is observed usage in the current host ecosystem, not a complete lifecycle specification extracted here.
- Veyra and dsh-mnemon register long-lived in-process behavior (system prompt, hooks, tools, watchers/runtime) through the plugin `apply` function and dispose in effects/cleanup.

**Assumptions / unresolved.**

- I did not verify a dedicated DSH "service registry" API specifically for Veyra to publish a Memory Server object to other plugins outside current Cordis context patterns.
- I did not verify a Host API that maps an arbitrary live agent/session directly to an authoritative DSH `WorkspaceId` from Veyra's current execution context. DSH has workspace accounting and session header cwd validation, but Veyra needs the exact supported lookup path.

## 5. Proposed target architecture

**Proposed design.**

```text
DSH Web / Cordis Host
        |
        v
Veyra Plugin apply(ctx, config)
        |
        v
VeyraMemoryServer (in-process, long-lived service)
        |
        +-- WorkspaceResolver      (authoritative session/agent -> WorkspaceBinding)
        +-- MemoryRouter           (operation -> allowed room, fail closed)
        +-- RecallEngine           (workspace recall + central recall)
        +-- LearningEngine         (observe/distill/candidate/update)
        +-- PromotionEngine        (workspace candidate -> central candidate -> decision)
        +-- LifecycleManager       (open/close DBs, health, backup hooks, migrations)
        |
        +-------------------------------+--------------------------------+
        |                                                                |
        v                                                                v
Workspace Memory Rooms                                      Central Memories
(one room per DSH WorkspaceId)                              (exactly one logical space)
        |                                                                |
        +-- room:<WorkspaceId A>/memory.db                               +-- central/memory.db
        +-- room:<WorkspaceId B>/memory.db                               +-- promotion ledger / audit
        +-- room:<WorkspaceId C>/memory.db                               +-- provenance backrefs
        +-- ...                                                          +-- contradiction / supersession links
```

```text
Request path (tool, hook, recall, promotion)
        |
        v
WorkspaceResolver
  - read agent/session identity
  - resolve authoritative DSH WorkspaceId
  - load WorkspaceBinding
  - reject if unavailable/ambiguous
        |
        v
MemoryRouter
  - check operation matrix
  - select Workspace Room and/or Central Memories
  - deny cross-workspace room access
        |
        v
Room/Central operation
  - SQLite read/write transaction
  - Veyra trust gates / validation / evidence
  - result + audit/provenance
```

**Why this shape.**

- It preserves Veyra's existing plugin-hosted, repository-external, SQLite-backed nature.
- It introduces a single authoritative service boundary for identity, routing, and lifecycle instead of scattering `resolveWorkspace` and store selection through call sites.
- It keeps Central Memories logically singular while preventing it from becoming an ungoverned dump.

## 6. Memory Server lifecycle design

### 6.1 Options evaluated

| Option | Assessment | Recommendation impact |
|---|---|---|
| In-process Memory Server managed by DSH/Cordis plugin lifecycle | Matches Veyra and dsh-mnemon host patterns; simplest operational model; can own SQLite connections and caches; startup/shutdown tied to plugin context/effects. | Recommended |
| Existing plugin runtime with ad hoc store access (current style, improved) | Lower initial refactor, but identity/routing/lifecycle rules remain easy to bypass; hard to make fail-closed and authoritative. | Rejected as target |
| Separate local daemon/process | Adds IPC, auth, startup supervision, crash recovery, version skew, and deployment complexity. Useful only if cross-process sharing or host isolation becomes necessary. | Rejected initially |

### 6.2 Proposed lifecycle

**Proposed design.**

1. **Construction during plugin apply:** create a `VeyraMemoryServer` instance with config, logger, clock, path resolver, and DSH workspace/session adapters. No mutable global singleton outside plugin-owned runtime.
2. **Lazy room open, eager core initialization:** initialize Central Memories and migration/health metadata eagerly or on first authorized use; open workspace room databases lazily by `WorkspaceId` and keep a bounded cache.
3. **Ready state:** mark the service ready only after core storage paths exist, Central Memories schema is valid/openable, and migration metadata has been checked. If core initialization fails, tool/context operations that require memory fail closed with a clear unavailable reason and do not break the agent loop.
4. **Operation execution:** every recall/learn/promote/inspect/forget operation acquires a resolved `WorkspaceBinding` and an operation context, then passes through `MemoryRouter`.
5. **Shutdown:** register `ctx.effect` disposer(s) that stop watchers/timers, flush pending work, checkpoint/close SQLite databases, and release room handles. Shutdown must be idempotent.
6. **Duplicate initialization prevention:** keep one server instance per Veyra plugin application; guard re-entrant initialization with an internal state machine (`uninitialized -> initializing -> ready/degraded/failed -> disposing -> disposed`). Do not use process-global mutable state except for explicitly test-scoped overrides.

**Concurrency and SQLite ownership.**

- Use Node `DatabaseSync` only behind room-scoped execution boundaries. SQLite writes should be serialized per database file; reads can be coordinated according to SQLite/WAL behavior but should not bypass the service's transaction discipline.
- Proposal: one writer queue per room database and one for Central Memories. Cross-room operations (promotion) run as a controlled two-phase workflow with audit records, not a distributed transaction claim. The report must not claim atomic cross-database commit across separate SQLite files.
- Promotion should write a durable promotion intent/audit record before applying destination writes, so partial failures are recoverable.

**Failure handling.**

- Central Memories unavailable: workspace-local recall/learning may continue in degraded mode if policy allows; cross-workspace recall/promotion fail closed.
- Workspace room unavailable/corrupt: fail closed for that room; do not read/write another room as substitute.
- Unknown workspace identity: fail closed. No ambient recall, no automatic learning into guessed rooms, no promotion.
- Partial service failure: health reports must distinguish core, central, room, resolver, and watcher states.

## 7. Workspace identity and isolation design

### 7.1 Identity model

The identities requested must be treated separately:

| Identity | Source | Role in proposed design |
|---|---|---|
| DSH Workspace ID | `WorkspaceId` UUID from DSH workspace contracts | Primary Memory Room key and authorization anchor. |
| Workspace filesystem path | `Workspace.path` / session header `cwd` / canonical path | Binding metadata and compatibility/migration signal; never sufficient for authorization. |
| Repository root | Git discovery from canonical path | Provenance and applicability metadata; not room identity. |
| Git remote identity | `.git/config` origin remote | Provenance/applicability metadata; not room identity. |
| Veyra Memory Room ID | Proposed stable internal id, equal to or derived 1:1 from DSH `WorkspaceId` | Storage partition key, e.g. `rooms/<workspaceId>/memory.db`. |

### 7.2 Authoritative resolution

**Proposed design.**

- `WorkspaceResolver` accepts execution context from Veyra hooks/tools (agent/session/tool execution), not arbitrary caller-selected room ids.
- It resolves the DSH session id and current session header `cwd` as evidence.
- Preferred authoritative path: query DSH workspace services/registry for the workspace that owns the session or whose validated path/candidate matches that session, then return a `WorkspaceBinding { workspaceId, workspacePath, sessionId, source, resolvedAt }`.
- If DSH exposes only path/session validation contracts and not a direct "session -> workspace id" lookup to plugins, Veyra must add a narrow adapter that uses verified Host services. A raw scan over guessed paths is insufficient as an authorization model.
- Fail closed when: no session context, no cwd, session maps to zero workspaces, session maps to more than one workspace, workspace status/registry is ambiguous, or resolver adapter is unavailable.

**Required invariant implementation rule.**

- Different DSH workspaces get different room ids even when they point to the same Git repository, because room selection keys on DSH `WorkspaceId`, not `gitRoot|remote`.
- Same repository may appear in room metadata for two rooms; Central Memories promotion decisions may still use repository evidence, but private room isolation remains intact.

### 7.3 Lifecycle cases

| Case | Proposed handling |
|---|---|
| Workspace rename/title change | No effect on room id; room is keyed by DSH `WorkspaceId`. Update cached binding metadata only. |
| Workspace path changes while workspace id remains stable | If DSH workspace path changes through supported contracts, update binding/path metadata. Do not rewrite history as a different room. If path changes outside DSH knowledge, resolver may fail closed until DSH state is consistent. |
| DSH restart | Room id survives because DSH workspace registry is durable (`workspaceDomainSpec`). Veyra reopens room by `WorkspaceId`. |
| Two workspaces, same Git repository | Two independent rooms; both can learn local knowledge. Central promotion must scrub workspace-specific paths/identities and keep provenance. |
| Workspace deleted/recreated later | Deletion should not automatically destroy memory data in place. Mark room binding as detached/archived and retain backups/audit. A recreated workspace gets a new DSH `WorkspaceId` unless DSH explicitly restores the same id; memory restoration/migration is an explicit operator/developer flow, never silent auto-merge. |
| Concurrent operations in different workspaces | Allowed, isolated by room database/queue. |
| Concurrent operations in same workspace | Serialized by room queue/transaction policy. |

## 8. Central Memories design

### 8.1 Purpose

Central Memories is the single logical space for reusable engineering knowledge that is safe and useful across workspaces. It is not a projection of every workspace record.

### 8.2 Admission policy

**Proposed design.** A record may enter Central Memories only through a promotion workflow:

```text
Workspace observation / explicit learning
  -> learning candidate (workspace room)
  -> evidence & validation checks
  -> decontextualization/sanitization
  -> reusable knowledge candidate
  -> promotion decision (authorized path)
  -> Central Memories record + provenance link
```

Eligibility criteria:

- The knowledge is not project-specific to paths, secrets, customer data, repo-unique identifiers, local URLs, machine-local configuration, or transient branch/worktree state.
- It has sufficient evidence: successful verified outcome, repeated validated pattern, or explicit human-approved canonicalization path where appropriate.
- Contradictions are visible; conflicting central records are linked, not silently merged.
- Provenance retains source workspace/room metadata in a controlled form, but recall text exposed to agents should avoid leaking unnecessary private workspace details.
- Failed or unverified experience is never promoted as authoritative central knowledge.

### 8.3 Retrieval policy

- Automatic recall may query Central Memories only after workspace context is resolved and only when the task is relevant.
- Central candidates rank below equivalent workspace-specific verified evidence unless the central item is clearly more applicable and trustworthy.
- Central Memories remains independent from individual workspace deletion; deleting a workspace room must not delete central provenance/audit needed for integrity.

### 8.4 Invariants preserved

- Candidate != truth.
- Similarity != authority.
- Automatic behavior != canonical truth.
- No silent merge.
- Contradictions remain visible.
- Repository truth remains authoritative.

## 9. Memory routing and authorization model

### 9.1 Route matrix

| Operation | Workspace Room | Central Memories | Other Workspace Rooms |
|---|---:|---:|---:|
| Automatic recall | Allowed (resolved room only) | Allowed when relevant and resolver succeeded | Denied |
| Automatic learning | Default destination | Promotion pipeline only | Denied |
| Manual recall | Current resolved room | Explicitly permitted by policy/tool mode | Denied |
| Search | Current resolved room | Permitted by policy | Denied |
| Update | Current resolved room | Authorized central maintenance operation only | Denied |
| Promotion | Read source room under resolved/authorized context | Controlled write | Denied |

### 9.2 Enforcement

**Proposed design.**

- Enforcement lives in `MemoryRouter`, below prompt text and below model tool handlers. Tools pass intent; router resolves and authorizes storage targets.
- Router inputs are execution context and operation type, not caller-supplied `cwd`, `projectId`, `workspaceId`, or room path for authorization.
- A caller-provided workspace selector may be accepted only for explicit administrative flows that independently verify authority against DSH contracts; ordinary agent recall/learning must not trust it.
- Router decisions are auditable: operation, resolved workspace id, selected targets, allow/deny reason, and fallback/degraded state.

### 9.3 Fail-closed cases

Deny and report unavailability or ambiguity when:

- session header/cwd is missing and no authoritative workspace binding can be resolved;
- multiple workspace candidates match;
- workspace registry lookup fails;
- target room id differs from resolved room;
- operation requests another workspace room;
- promotion source and destination invariants are not satisfied.

## 10. Automatic recall and learning integration

### 10.1 Automatic recall

**Proposed flow.**

1. Hook/context provider receives agent execution context.
2. `WorkspaceResolver` resolves authoritative `WorkspaceId` or fails closed.
3. `RecallEngine` builds query using existing Veyra task-intent/change-signal logic (preserve current fail-closed behavior when no task signal and no change signal).
4. `MemoryRouter` allows reads from resolved workspace room and, by policy, Central Memories.
5. Retrieve workspace-specific candidates first; retrieve applicable central candidates second.
6. Rank by task relevance, applicability, freshness, evidence, trust/authority, and contradiction visibility. Preserve Veyra's current anti-pollution guards (zero-signal filtering, applicability, lifecycle/authority gates).
7. Render compact context labeled as recalled evidence, never instructions.

### 10.2 Automatic learning

**Proposed flow.**

1. Observation hooks buffer turn signals as today.
2. `LearningEngine` distills a candidate in the resolved workspace room only.
3. Existing write gates, durability/grounding checks, provenance checks, redaction, and no-auto-canonical rules apply.
4. Outcome feedback updates records in the same workspace room unless an explicit promotion workflow is triggered.
5. Promotion is a separate decision: workspace evidence may become a reusable central candidate, but failed/unverified experience cannot become authoritative central knowledge.

### 10.3 Regression-sensitive behavior to preserve

- Auto-captured observations remain `candidate`.
- Canonical authority only through explicit user action.
- No silent merge across contradictory records.
- Repository truth remains authoritative.
- Observation and recall failures do not break the agent loop.
- `recallLimit=0` disables ambient recall.
- Existing safeguards around narrative-only learning, failed outcomes, redaction, contradiction visibility, and applicability should remain covered by Veyra's current tests and be ported/adapted in implementation phases.

## 11. Storage recommendation

### 11.1 Alternatives

| Option | Pros | Cons | Verdict |
|---|---|---|---|
| One SQLite DB per workspace room + one Central Memories SQLite DB | Strong failure isolation; easy per-room backup/migration/delete lifecycle; aligns with current `node:sqlite`/FTS5 stack; simple mental model. | Cross-room promotion is not one SQLite transaction; more file handles/cache management. | Recommended |
| One SQLite DB with room_id partitioning | Single connection/file; simpler global backup. | Weaker blast radius isolation; harder per-workspace export/delete/recovery; larger migration risk; row-level authorization mistakes become more dangerous. | Rejected |
| Keep current `projects/<hash>/memory.db` + `reusable/memory.db` naming only | Minimal code movement. | Preserves wrong identity model and migration ambiguity; path still central. | Rejected as target |
| External DB/service or embeddings/vector infra | Possible future retrieval experiments. | Unjustified operational complexity for requested scope; conflicts with "no additional infrastructure without measurable justification." | Rejected |

### 11.2 Recommended storage design

- Keep SQLite as the source of truth.
- Physical layout proposal:
  - `$VEYRA_HOME/central/memory.db`
  - `$VEYRA_HOME/rooms/<workspaceId>/memory.db`
  - `$VEYRA_HOME/rooms/<workspaceId>/room.json` (binding metadata/provenance; optional but useful)
  - `$VEYRA_HOME/migrations/ledger.json` or SQLite meta records
- Reuse Veyra schema patterns where valid (FTS5, WAL, meta, fail-closed corruption handling), but add room/central-aware metadata and migration bookkeeping.
- Maintain bounded caches of open `DatabaseSync` handles with explicit eviction/close on shutdown.
- For promotion, use an auditable outbox/intention record:
  1. write promotion intent in source room or central ledger;
  2. validate candidate and prepare central record;
  3. write central record;
  4. mark intent committed/linked.
  This avoids claiming impossible cross-file atomicity.

## 12. Security and failure analysis

| Risk | Current/proposed impact | Mitigation |
|---|---|---|
| Wrong workspace room selected | Cross-workspace leakage or polluted memory. | Authoritative `WorkspaceResolver`; Memory Router fail-closed; never use caller `cwd` as authorization. |
| Same repo in multiple DSH workspaces | Current model can merge by `gitRoot|remote`. | Key rooms by DSH `WorkspaceId`. |
| Path reused after delete/recreate | New workspace may inherit stale meaning if path-keyed. | New DSH workspace id => new room by default; restoration only explicit. |
| Central Memories pollution | Private/project-specific data leaks across workspaces. | Promotion pipeline with decontextualization, evidence, provenance, and explicit authorization. |
| SQLite corruption/partial writes | Room or central data unavailable. | WAL, integrity checks, fail-closed reads/writes, per-room isolation, backup/export hooks. |
| Promotion partial failure | Source marked promoted but central missing, or duplicate central entries. | Durable promotion intent/outbox and idempotent promotion ids. |
| Resolver dependency unavailable | Memory may attach to wrong context. | Fail closed; surface degraded health in `/veyra` diagnostics. |
| Secret persistence | Sensitive data in memory DB. | Preserve Veyra redaction-before-persistence on every write path. |
| Watcher/bridge failures | Degraded code context or observation quality. | Keep failures non-fatal to agent loop; mark evidence degraded. |

## 13. Migration strategy

### 13.1 Principles

- No existing memory data is discarded.
- Existing `projects/<projectId>/memory.db` databases remain readable until migrated or explicitly archived.
- Migration is reversible at the file/ledger level (keep originals; write mapping/audit records).

### 13.2 Phased plan

**Phase 0: research closure and Host contract verification (prerequisite).**
- Verify how Veyra can resolve authoritative DSH `WorkspaceId` for the active session/agent in DSH Web.
- Verify lifecycle hooks and any workspace-change events Veyra can observe.

**Phase 1: introduce Memory Server and Router behind compatibility adapters.**
- Keep current recall/learning algorithms.
- Add `WorkspaceResolver`/`MemoryRouter` interfaces.
- Route existing tool/context operations through the server.
- Support a compatibility mode that maps legacy project stores when authoritative workspace id is unavailable only for explicitly marked legacy reads/migrations, never for new cross-workspace-safe claims.

**Phase 2: workspace room binding and data import.**
- Create room per authoritative `WorkspaceId`.
- Build a migration scanner for `~/.dsh/veyra/projects/*/memory.db` and `reusable/memory.db`.
- For each legacy project DB, infer candidate bindings using stored provenance (`workspace`, repository root, git remote) and current DSH workspace registry where possible.
- If one legacy DB maps unambiguously to one DSH workspace id, import/copy into that room and record provenance.
- If mapping is ambiguous (same repo reused, missing provenance, multiple candidate workspaces), import into a quarantine/import bucket and require an explicit operator binding step. Do not guess.

**Phase 3: Central Memories promotion pipeline.**
- Keep existing reusable DB as migration source.
- Classify reusable records into: central-eligible, workspace-specific, ambiguous, or retired/unsafe.
- Preserve provenance and original ids in migration metadata.
- Do not silently publish ambiguous reusable records as central authoritative knowledge.

**Phase 4: remove legacy path-keyed selection.**
- After verified migration/binding coverage, stop using `gitRoot|remote` as the active room selector.
- Keep read-only legacy access for audit/recovery until a later approved cleanup.

### 13.3 Rollback

- Retain original `projects/*` and `reusable/memory.db` files unchanged during migration.
- Maintain a migration ledger mapping legacy record ids to room/central ids.
- Rollback switches the server to read-only compatibility mode or pre-migration mode; it does not delete migrated copies.

## 14. Architecture trade-offs and rejected alternatives

| Alternative | Why rejected / deferred |
|---|---|
| External Memory Server daemon | Operational complexity, IPC/auth/supervision/version skew; no proven need in current DSH plugin model. |
| Authorize by caller `cwd` or `sessionId` alone | Fails the required invariant; cwd is useful evidence but not authorization. DSH workspace path validation exists, but Veyra must resolve authoritative workspace binding. |
| Keep `gitRoot|remote` project id as the room key | Collapses multiple DSH workspaces on same repo; incompatible with required isolation. |
| Single shared DB partitioned by room id | Higher risk from authorization bugs and weaker operational isolation. |
| Auto-promote similar or frequently recalled records to Central Memories | Violates similarity != authority and candidate != truth; risks cross-workspace pollution. |
| Blindly migrate reusable DB into Central Memories | Existing reusable scope may contain workspace-specific knowledge or ambiguous provenance. |
| Introduce embeddings/external DB now | No measured justification provided; increases complexity before identity/routing correctness is solved. |

## 15. Unresolved questions and external dependencies

1. **Authoritative session-to-workspace resolution API:** What exact Host/plugin API should Veyra use in DSH Web to resolve the active DSH `WorkspaceId` for an agent/session? Installed contracts show workspace/session models and controller RPC vocabulary, but the plugin-side Host lookup path is not verified here.
2. **Workspace lifecycle events:** Can Veyra subscribe to workspace create/rename/delete/archive/session-move events in-process, or must it poll/follow controller state?
3. **Session archive/pin interaction:** Should archived sessions retain recall/learning eligibility in their workspace room? DSH workspace domain tracks archive/pin; Veyra policy is not defined.
4. **Missing-directory workspaces:** DSH workspace status can be `missing-dir`. Should Veyra allow read-only recall from the room, block learning, or fail closed?
5. **Legacy mapping UI/operator workflow:** Ambiguous legacy project imports need an explicit human binding flow. Where should that live (CLI, `/veyra` web endpoint, DSH UI extension)?
6. **Central promotion authority path:** Which explicit user action in DSH/Veyra authorizes promotion to Central Memories? Current Veyra has promotion concepts/tools; central promotion needs a stricter policy.
7. **Cross-database audit storage:** Should promotion ledgers live in Central Memories, source rooms, or both? Dual records improve recovery but add bookkeeping.
8. **Test/runtime fixtures for workspace registry:** Implementation will need isolated DSH workspace/session fixtures. This research did not inspect production data and did not run destructive experiments.

## 16. CTO recommendation and implementation phases

### 16.1 Recommended architecture

Adopt an **in-process Veyra Memory Server** owned by the Veyra Cordis plugin. It should centralize workspace resolution, memory routing/authorization, recall, learning, promotion, and SQLite lifecycle. Do not build a separate daemon. Do not keep the current path-hash project selector as the primary long-term room identity.

### 16.2 Is a Memory Server necessary, and which runtime model?

Yes, a Memory Server is necessary as an internal service boundary. The runtime model should be **in-process, plugin-managed, long-lived for the life of the DSH Web host/plugin context**, with lazy room database opening and explicit disposal through `ctx.effect`/plugin cleanup. A separate local daemon is not recommended.

### 16.3 Recommended Workspace Room identity

Primary room key: **DSH `WorkspaceId` (branded UUID)**.  
Binding metadata: canonical workspace path, workspace title snapshot, repository root, git remote hash, session provenance snapshots, and migration lineage.  
Authorization input: resolved DSH workspace binding from trusted host/session context.  
Never authorize by caller-supplied `cwd`, `projectId`, `sessionId`, or room path.

### 16.4 Recommended Central Memories model

Exactly one logical **Central Memories** space, physically backed by its own SQLite database and governance metadata. Admission only through a promotion pipeline from workspace evidence: candidate, validation, decontextualization, provenance, promotion decision, auditable write. No similarity-only promotion, no silent merge, no failed/unverified authoritative promotion.

### 16.5 Recommended storage design

SQLite remains the source of truth. Use **one SQLite database per workspace room** plus **one Central Memories SQLite database**, all under Veyra home outside user repositories. Keep `node:sqlite`/FTS5/WAL patterns where appropriate. Add room metadata and migration/promotion ledgers. Treat cross-database promotion as an auditable workflow, not a single atomic transaction.

### 16.6 What should be retained from current Veyra

- The product goal and safety invariants in `AGENTS.md` and Veyra guides.
- Redaction-before-persistence discipline.
- Candidate/derived/canonical trust model and no-auto-canonical behavior.
- Existing recall ranking concepts: task intent, applicability, freshness, evidence, contradictions, authority/lifecycle gating.
- Existing learning guards: write gate, durability/grounding, narrative-only handling, strengthen/failure feedback.
- SQLite + FTS5 local storage approach.
- Code Intelligence as an external bridge dependency, not vendored internals.
- Observation/recall failures remaining non-fatal to the agent loop.

### 16.7 What should be redesigned

- Workspace identity and room selection: replace `gitRoot|remote` primary partitioning with DSH `WorkspaceId` rooms.
- `resolveWorkspace` semantics: from cwd fallback selection to authoritative resolver with fail-closed behavior.
- Store selection and authorization: introduce `MemoryRouter` below tools/context.
- Reusable store role: evolve from a generic shared store into a governed Central Memories service with promotion workflow.
- Lifecycle management: formalize a Memory Server service with explicit init/health/dispose and per-room connection management.
- Migration/import tooling: add binding-aware migration for legacy project/reusable databases.

### 16.8 Proposed implementation phases

1. **Host contract verification spike:** prove authoritative session/agent to `WorkspaceId` resolution in the live DSH Web plugin environment; document unsupported cases.
2. **MemoryServer skeleton:** add in-process service, resolver/router interfaces, health reporting, and compatibility adapters; no behavior change for valid current flows.
3. **Workspace Room storage:** implement `rooms/<workspaceId>/memory.db`, binding metadata, per-room lifecycle, and dual-read compatibility where safe.
4. **Legacy migration/import:** scan legacy project/reusable DBs, build mapping ledger, import unambiguous data, quarantine ambiguous cases.
5. **Central Memories promotion:** implement governed promotion pipeline, provenance links, central retrieval policy, and audit/rollback records.
6. **Cutover and cleanup:** disable legacy path-hash room selection for active operations after migration coverage; retain old data for recovery.

### 16.9 Critical risks and unresolved dependencies

- **Critical dependency:** verified plugin/Host API for authoritative session-to-workspace resolution. Without it, Veyra cannot safely satisfy the required isolation invariant.
- **Critical risk:** ambiguous legacy migration from path/repo-keyed databases to DSH-workspace-keyed rooms.
- **Critical risk:** Central Memories promotion can leak private/project-specific details if decontextualization and policy checks are weak.
- **Operational risk:** per-room SQLite handle growth and promotion bookkeeping complexity.
- **Compatibility risk:** changing room identity affects recall continuity until migration/binding is complete.

### 16.10 Clear recommendation

**`PARTIALLY_READY`**

The architecture direction is strong and feasible as an incremental in-process redesign: DSH already provides workspace/session contracts that support stable workspace ids and path validation, and Veyra already has local SQLite storage plus recall/learning safeguards to preserve. Implementation should not begin until the Host/plugin contract for authoritative session-to-workspace resolution is verified and the legacy-to-room migration binding strategy is approved, especially for ambiguous same-repository cases.
