# Veyra Engineering Graph — Architecture Checkpoint

Baseline: verified Graph Foundation `@lovedolove/veyra@0.1.12` (`0.1.13` = CI bump).
Network Graph WebUI: `0.1.14`; bounded overview landing view: `0.1.18`.
Date: 2026-09-26 (last updated).
Status: graph is a derived projection, not a second store. WebUI is a host-native Observatory surface over that projection.

This checkpoint is grounded in the current repository. Prompt vocabulary that does
not exist in `src/types.mjs` is not adopted.

---

## 1. Current Architecture (repository evidence)

Veyra is a DSH Cordis plugin (`src/plugin.mjs`), not a standalone web app.

| Layer | Fact |
| --- | --- |
| Canonical store | `node:sqlite` + FTS5 under `$DSH_HOME/veyra/` |
| Identity | `memory.id` (`vey_…`); project id `p_` + sha256(gitRoot\|remote) |
| Relations | JSON array on the memory row: `{ type, targetId }` |
| Relation types | `updates \| extends \| derives \| contradicts \| supersedes` |
| Recall gate | `isRecallEligible`: not forgotten, `status===current`, not invalid/stale, not candidate, not observation, authority derived\|canonical |
| Search | Hybrid FTS5 + Jaccard + intent + relationship *score* |
| Graph today | Derived Local Graph (`src/graph.mjs`). Recall expands 1-hop eligible neighbors; `contradicts` still has its own extra |
| Human surface | `/veyra observatory *` read-only text, plus host HTTP Network Graph at `/veyra` |
| Agent surface | `systemPrompt.section` + `systemPrompt.context`, tools `remember/recall/inspect/forget/promote` |
| Fail-closed | empty string if recall throws; isolation is per-DB |

There is no Veyra web application and no graph table. DSH Web GUI is the host.
`needs-review` is not a Veyra validation. Closest values: `unverified` / `reviewed`.

```
Canonical SQLite
    ├── Search projection  → recall / observatory search
    ├── Graph projection   → local neighborhood (this stage)
    └── Context projection → agent prompt (bounded, eligible-only)
```

---

## 2. External Findings

### Supermemory

- Living memory graph with typed relations `updates | extends | derives`.
- Version chains (`isLatest`, `parentMemoryId`).
- Canvas visualization for humans.
- Retrieval remains semantic top-K. The graph is not the query engine.

### OpenViking

- Resource / Memory / Skill split; L0/L1/L2 context layers.
- Compile-time typed KG artifact (`entities/` + `relations.jsonl`).
- Memory graph is an HTML projection, not the database.
- Retrieval is intent + hierarchy + budget. Fail-closed query expansion.
- Agent context does not depend on the graph UI.

---

## 3. Adopt / Adapt / Reject / Defer

| Decision | Item | Why |
| --- | --- | --- |
| **Adopt** | Typed directed relations | Already in Veyra; keep the five existing types |
| **Adopt** | Graph as projection, not store | Matches OpenViking; preserves 0.1.12 SQLite as source of truth |
| **Adopt** | Fail-closed expansion | Invalid / stale / forgotten / candidate never enter trusted context |
| **Adopt** | Budget-bounded context | Agent gets a neighborhood, never the whole graph |
| **Adopt** | Agent path independent of UI | Existing tools + `systemPrompt.context` |
| **Adopt** | Both sides of a contradiction stay visible | Already implemented; keep as a hard extra, not a soft neighbor |
| **Adapt** | Supermemory version chain | Use existing `status` + `supersedes`. No `parentMemoryId` column |
| **Adapt** | OpenViking layers | Existing `kind` + `authority` already separate observation / derived / canonical |
| **Adapt** | Human graph | Host-native `/veyra` page over `localGraph` JSON plus a bounded `overviewGraph` landing view. Vanilla SVG. No D3, no React, no new web app |
| **Adapt** | Relationship-aware retrieval | After hybrid top-K, 1-hop expand through existing relations, then `isRecallEligible` |
| **Reject** | Neo4j / external graph DB | No concrete gap. Work would stop first if one appeared |
| **Reject** | New node types (file, commit, repo) | Not records today. Evidence paths stay metadata |
| **Reject** | New relation types for the UI | Visual categories are not semantics |
| **Reject** | `needs-review` vocabulary | Not in `VALID_VALIDATIONS` |
| **Reject** | Default full-project graph | Observatory already warns against this; Local Graph is the default |
| **Reject** | Auto-canonical, silent merge, hiding contradictions | Core invariants |
| **Reject** | SMFS / FUSE / connectors / remote APIs | Out of scope |
| **Adopt** | Host `webServer.register` | DSH already exposes named HTTP routes; `/veyra` is the plugin surface |
| **Defer** | Default 2-hop traversal | Add only if 1-hop is measurably thin |
| **Defer** | Edge-level validation / provenance | Relations are `{ type, targetId }` only. Inherit from endpoint records |
| **Defer** | Impact experiment (GOAL §22) | Requires live paired tasks after this projection ships |
| **Defer** | New MCP / extra tools | `veyra_inspect` already returns relations |

Update (Network Graph milestone): the WebUI landing page (no `id`) serves a
**bounded overview projection** — `overviewGraph()` in `src/graph.mjs`, the same
node/edge contract, the same `GRAPH_LIMITS` caps (40 nodes / 80 edges) and the
same isolation rules — so the page renders real workspace nodes without a known
id, or an honest empty state. It is discovery only: not a traversal or query
path, Local Graph stays the default graph view for any selected record, and the
rejection above still holds for an *unbounded* default full-project graph.

---

## 4. Graph Data Contract

### 4.1 Identity

- A **node** is exactly one memory row. Id = `record.id`.
- An **edge** is exactly one stored relation. Id = `${fromId}:${type}:${targetId}`.
- Projection never allocates a second id space.

### 4.2 Node

Projected fields (no body on the compact node):

```
id, title, kind, status, validation, authority, confidence,
scope, projectId, forgotten, evidenceCount, trusted
```

`trusted === isRecallEligible(record)`.

Classification (not new storage):

| Prompt term | Veyra fact |
| --- | --- |
| canonical entity | `authority === canonical` |
| derived entity | `authority === derived` |
| candidate entity | `authority === candidate` |
| historical entity | `status ∈ {deprecated, superseded, historical}` or `forgotten` |
| projected entity | the graph node itself |

Kind stays `observation | memory | knowledge | evidence`. Files mentioned in
`evidence[]` remain anchors, not nodes.

### 4.3 Edge

```
fromId → type → targetId
```

All five types are directional as stored.

| Type | Meaning already in evolve/store |
| --- | --- |
| `updates` | newer claim revises an older one |
| `extends` | related elaboration / near-duplicate link |
| `derives` | derived from |
| `contradicts` | opposing claim; both sides stay visible |
| `supersedes` | lifecycle replacement; target is typically `status=superseded` |

`contradicts` is **not** rewritten as undirected. Display and agent extras
follow both stored directions when present (evolve already writes the back-link
best-effort).

Edges have no independent validation, authority, or evidence. Trust is the
conjunction of the two endpoint records. A dangling `targetId` is kept as an
unresolved edge and is not turned into a synthetic node.

### 4.4 Lifecycle / authority / validation on the graph

These are record fields copied onto the node. They are not inferred from degree
or similarity.

Trusted traversal (agent, and Observatory “trusted” filter) excludes a node when
any of:

- `forgotten`
- `status !== current`
- `validation ∈ {invalid, stale}`
- `authority === candidate`
- `kind === observation`

Observatory Local Graph **may** show those nodes, labeled, because inspection
is not recall.

### 4.5 Provenance

Node → record (`veyra_inspect` / `observatory record`) → `evidence[]` +
`source` (session, tool, docPath, causal facets) → workspace path / test note.

The graph does not strip provenance; it also does not duplicate it.

### 4.6 Isolation

- Project DB and reusable DB stay separate.
- Traversal may resolve a `targetId` in the project store, then the reusable
  store if that store was provided.
- A reusable hit with `projectId === current project` is dropped (same rule as
  `hybridRetrieve`).
- Ambiguous / other-project ids fail closed: unresolved edge, no hop.

### 4.7 Traversal bounds

| Knob | Default | Cap |
| --- | --- | --- |
| Local Graph hops | 1 | 2 |
| Observatory nodes | 40 | 40 |
| Observatory edges | 80 | 80 |
| Agent extra neighbors | 4 | 4 |
| Agent contradiction extras | all eligible opposing sides of the current hit set | hit-set size |

Algorithm: BFS from the selected / recalled ids. Local Graph follows incoming
and outgoing stored relations. Agent expansion follows both, then applies
`isRecallEligible`.

`# ponytail: O(n) scan of store.list(), add an edge index if a project exceeds ~200 records.`

### 4.8 Determinism

Same store snapshot + same `{ id, hops, trustedOnly, includeReusable }` ⇒ same
node and edge sets, stable sort by `id`.

---

## 5. WebUI / Observatory

Graph Foundation (0.1.12/0.1.13) remains the derived projection. Network Graph
WebUI (0.1.14) is a host-native Observatory surface over that projection.

DSH already exposes `ctx.webServer.register`. Veyra uses that — the graph
ships no second app, no graph React bundle, and no D3. (The package does ship
`client.js`, but only for the Settings section and the sidebar entry; it is
not the graph surface.)

| Route | Role |
| --- | --- |
| `GET /veyra` | vanilla SVG Network Graph page (overview → local drill-down) |
| `GET /veyra/graph?id=&hops=&trustedOnly=&cwd=` | `localGraph` JSON + presentation marks |
| `GET /veyra/graph?cwd=` (no `id`) | bounded `overviewGraph` JSON for the landing view |
| `GET /veyra/record?id=&cwd=` | compact record JSON (inspect, not mutate) |
| `GET /veyra/search?q=&cwd=` | hybrid search hits → pick a center |

Landing (no `id`) = bounded workspace overview. Default graph for a selected
record = selected record + 1 hop. `hops=2` is user-controlled and clamped to
`GRAPH_LIMITS.maxHops`. `cwd` selects the project store the same way `/veyra`
slash commands do. Missing / other-project ids fail closed.

The page ships the interaction surface: zoom (wheel, cursor-anchored), pan
(pointer drag), node hover preview, node selection with drill-down, plus
loading / empty / error states with retry. No graph library — vanilla SVG.

Presentation marks (`selected`, `trusted`, `inspectOnly`, `historical`) are
computed from existing node fields. Filtering is client-side and does not
change memory. Visible ≠ trusted. Connected ≠ recall-eligible.

Slash Observatory commands stay text. `graph <id>` also prints the WebUI URL.

---

## 6. Agent Context

```
task text
  → hybridRetrieve (unchanged eligibility + ranking)
  → guarantee eligible contradiction partners
  → 1-hop eligible neighbors (cap 4)
  → re-rank
  → summarizeForPrompt
```

The agent does not receive the graph object. Neighbors appear as ordinary
recalled records, with an optional `via: { fromId, type }` explanation.

Failure: catch and return `''` (existing `createContextProvider` contract).

---

## 7. Risks

| Risk | Mitigation |
| --- | --- |
| Projection treated as a second truth | No graph table; functions only |
| Expansion noise | hop=1, maxExtra=4, eligibility gate |
| Isolation leak | resolve only in opened stores |
| Host UI expectation | `/veyra` on `webServer`; no second app |
| `list()` miss on large DBs | unresolved edge, not a guessed node |

---

## 8. Open Questions (not blocking this stage)

1. When (if ever) should evidence paths become first-class nodes?
2. Does 1-hop measurably help live DSH tasks? (GOAL §22)
3. Closed for this stage: host `webServer` is enough. A React `dsh.client`
   panel is not required for the graph. (The shipped `client.js` serves the
   Veyra Settings section and the sidebar entry, not the Network Graph.)

---

## 9. Implementation slice (ponytail)

Graph Foundation: `src/graph.mjs`. Network Graph WebUI: `src/webui.mjs`.
No new dependency, no schema migration, no new tool. Plugin registers
`/veyra` only when `ctx.webServer` exists.
