# Memory Portability — Minimal Export / Import Design

**Status:** design proposal, not implemented. Nothing in this document is authorized to land without the product decision in §9.
**Scope:** one user, one host at a time. Not a sync feature, not a merge feature.
**Related:** `docs/capability-matrix.md:56` (the Defer row this reopens), `GOAL.md` §7, `docs/agent-guides/safety-and-invariants.md:108`.

The problem this solves is narrow and real: memory lives in `$DSH_HOME/veyra/`, outside the
repository and outside version control, and room identity is a DSH `WorkspaceId` that a new
machine or a new path re-mints. Moving a project's engineering memory to another host
therefore has no supported path today. The design below adds that path **without touching
room identity, isolation, or authority rules**.

## 1. Non-goals

- No change to room keying. `WorkspaceId` stays the only room identity.
- No automatic restore on workspace open. Import is an explicit operator command.
- No merge, no deduplication across rooms, no conflict resolution.
- No network transport, no hosted backup, no scheduler, no daemon.
- No import into `Central`. Central is reachable only through governed promotion.
- No `reusable/` support. That layout is dead (`src/rooms.mjs:9-12`).

## 2. Format

A single JSON file, UTF-8, written atomically. Extension `.veyra.json`.

```jsonc
{
  "format": "veyra-memory-export",
  "formatVersion": 1,
  "schemaVersion": 1,                  // record schema, mirrors types.mjs SCHEMA_VERSION
  "exportedAt": "2026-11-11T16:20:00.000Z",
  "exporter": { "name": "@lovedolove/veyra", "version": "0.2.1" },

  "origin": {
    "roomId": "w_0f218005-d94d-495c-a94a-254f31c6df7b",
    "workspaceId": "0f218005-d94d-495c-a94a-254f31c6df7b",
    "workspacePath": "/home/lovedolove/projects/Veyra",   // provenance only
    "title": "Veyra",
    "recordCount": 412
  },

  "redaction": { "applied": true, "policy": "redact.mjs/scrub+redact" },

  "digest": {
    "algorithm": "sha256",
    "canonicalization": "records sorted by id; JSON.stringify(record) per line, joined by \n",
    "value": "…64 hex…"
  },

  "records": [
    {
      "id": "vey_1a1c9907fef_9a396419c167",
      "kind": "memory",
      "status": "current",
      "validation": "reviewed",
      "authority": "derived",
      "confidence": "medium",
      "scope": "project",
      "projectId": "w_0f218005-d94d-495c-a94a-254f31c6df7b",
      "title": "…",
      "body": "…",
      "tags": ["…"],
      "evidence": [{ "path": "src/promotion.mjs", "note": "…" }],
      "relations": [{ "type": "contradicts", "target": "vey_…" }],
      "source": { "workspace": "/home/lovedolove/projects/Veyra", "…": "…" },
      "contentHash": "…",
      "forgotten": 0,
      "createdAt": "2026-11-01T…",
      "updatedAt": "2026-11-09T…",
      "lastRecalledAt": null
    }
  ]
}
```

Four rules that matter more than the field list:

1. **The digest is over records only**, after redaction, in the canonical order stated in the
   file. `origin`, `exportedAt` and `exporter.version` are excluded, so a re-export of
   unchanged data on a different day produces the same digest. That is what makes a
   round-trip testable.
2. **`origin.workspacePath` is a label, never a lookup key.** Import must not use it to decide
   which room receives the records; the destination room is chosen by the operator and the
   current resolver (§6). This is the same rule `binding.json` already follows
   (`src/memory-server.mjs:144-151`: "never the authority for room identity").
3. **Forgotten records are exported** (`forgotten: 1`), because a forgotten record is evidence of
   a decision. They are imported as forgotten. Dropping them silently would resurrect them as
   absent and lose the lifecycle reason.
4. **`authority`, `validation`, `status` travel as stored values.** Import does not upgrade any
   of them (§7). A `canonical` record arrives canonical, a `candidate` arrives candidate.

## 3. Export

```
/veyra export [--out <path>] [--room <roomId>] [--include-forgotten]
```

- Default output: `<cwd>/.veyra-export-<roomId>-<yyyymmddThhmmss>.json`. An explicit `--out`
  is required to write outside the working directory.
- Default room: the room resolved for the current workspace. `--room` is an operator escape
  hatch for exporting a room that no longer resolves; it is a **read-only** selection and still
  requires the room id to match `SAFE_ROOM_ID` (`src/rooms.mjs:29`) after the `w_` prefix is
  stripped.
- Reads through the existing store API only: `MemoryStore.list({ includeForgotten })`. No raw
  SQL in the export path.
- Before writing, every record is re-scrubbed with `scrub()` (`src/redact.mjs:161`). Persisted
  bodies are already redacted at write time; the second pass is cheap insurance against a
  pattern added since the record was written, and it is the only reason `redaction.applied`
  can honestly be `true`.
- Write to `<path>.tmp` then `rename()`. Never overwrite an existing file without `--force`.
- Output is `0600`; the file contains engineering detail about private code.

**What export must never do:** open a different room's database as a side effect of `--room`,
enumerate `rooms/` to "find the right one", or write anything into the repository without an
explicit `--out`.

## 4. Import

```
/veyra import <path> [--dry-run] [--force] [--allow-count-mismatch]
```

Two phases. `--dry-run` runs phase 1 only and prints the same report.

### Phase 1 — validate, mutate nothing

Refuse (not warn) on any of:

| Check | Failure code |
|---|---|
| File parses as JSON, `format === 'veyra-memory-export'` | `import/not-an-export` |
| `formatVersion` is 1 | `import/unsupported-format-version` |
| `schemaVersion === SCHEMA_VERSION` (`src/types.mjs:79`) | `import/schema-version-mismatch` |
| Recomputed digest equals `digest.value` | `import/digest-mismatch` |
| `records.length === origin.recordCount` (unless `--allow-count-mismatch`) | `import/count-mismatch` |
| Every record passes `rowToRecord`-equivalent validation: known `kind/status/validation/authority/confidence/scope` enum values, JSON columns parse | `import/malformed-record` |
| No duplicate `id` inside the file | `import/duplicate-id` |
| Target room resolves and is writable | `import/room-unresolved` |

A malformed record fails the **whole** import. There is no partial import, because a half-restored
room is worse than an empty one — the operator cannot tell what is missing.

### Phase 2 — write

- **Only inserts. Never updates an existing row.** If `id` already exists in the target room,
  that record is skipped and counted in `skipped`. Whether it differs is not examined: replacing
  a live record with an older export is exactly the silent downgrade the authority rules exist
  to prevent.
- `INSERT OR IGNORE` semantics via `MemoryStore.put()` is **not** usable here — `put()` updates
  on conflict. Import needs its own narrow insert path in `src/store.mjs` (one prepared
  statement, no authority transition, no merge logic), or the same guarantee expressed as
  "read ids first, then put only missing ones". Either is acceptable; the guarantee is.
- `projectId` is **rewritten** to the destination room id. The record's own `projectId` from the
  export is kept in `source.importedFrom.projectId` for provenance.
- `source.importedFrom` is added to every imported record:
  `{ roomId, workspacePath, exportedAt, fileDigest }`. This is what makes a later promotion
  decision reviewable, and it is what `/veyra inspect` shows the operator.
- The import is a single SQLite transaction. On any error the transaction rolls back and the
  room is byte-identical to before.
- **Post-import reconciliation:** if the destination binding already has a `workspacePath`
  ("Veyra", for example) that differs from `origin.workspacePath`, those paths now appear in
  imported records' `source` and `evidence` anchors. This is expected and is not an error: the
  code they refer to may simply be a different checkout. It only becomes a problem at promotion
  time — which is where it is already caught (§7).
- One `meta` entry is written for audit: `import:<digest>` → `{at, from, inserted, skipped}`.
  The `meta` table is invisible to `list()/search()` by construction
  (`src/store.mjs:532-543`), so this cannot masquerade as knowledge.

## 5. Why the digest is enough, and what it does not prove

`sha256` over canonical record JSON proves **the file was not edited or truncated after export**.
It does not prove the records were true when exported, and it says nothing about the exporting
host. Say that in the command output; do not let a green check read as a trust signal.

The digest also makes the failure mode honest: a truncated copy of a 2.2 MB `-wal` file is the
most likely real-world corruption, and it produces a legible `import/digest-mismatch` instead of
a half-populated room.

## 6. Relationship to the resolver — the part that must not be fudged

Import targets **the room the current workspace resolves to**, through the same path every other
operation uses: `createWorkspaceResolver(...).resolve(source)` (`src/workspace-resolver.mjs:210-298`).
There is no bypass, no `--room` write mode, and no path-matching fallback. If the resolver fails
closed (`workspace-registry-unavailable`, `workspace-registry-not-ready`, ambiguous
membership), import fails with `import/room-unresolved` and the operator is told why.

The consequence is honest and must be stated in the command output: **the new machine gets a new
`WorkspaceId`, so the imported records land in a new room.** That is not a bug. The room is a
partition, not an identity claim; what the operator gets back is the content, with provenance
showing where it came from. Anything that pretends the two rooms are "the same room" would be
exactly the guess that v0.2.0 deliberately refused to make (commit `dd22b63`).

## 7. The promotion interaction — where portability actually breaks today

`sameWorkspace()` (`src/promotion.mjs:80-90`) compares a record's `source.workspace` against the
current binding's `workspacePath` and denies with `promotion/cross-workspace-source`
(`src/promotion.mjs:107-109`) on mismatch. After an import, most records carry the **old** path,
so they cannot be promoted into Central from the new room.

This design does not loosen that check, because loosening it is what would let one project's
knowledge leak into Central under another project's name. The correct resolution is
operator-driven and narrower than it looks:

> **Promotion after an import requires the operator to acknowledge the provenance transfer.**
> The proposed command: `/veyra import <path> --adopt-provenance`, which rewrites
> `source.workspace` from the export's `origin.workspacePath` to the current binding's path, and
> records the original value in `source.importedFrom.workspacePath`.

That is an **authority-adjacent** operation and is deliberately not part of the default import.
It must be:
- explicit at the command line,
- recorded in the record's provenance, not silently applied,
- unavailable for records whose `authority` is already `canonical` (a canonical record's origin
  is not the importer's to rewrite).

Without `--adopt-provenance`, imported records are fully usable for recall in the new room and
simply cannot be promoted. That is a defensible default: recall is private, promotion is shared.

## 8. Failure modes, in order of likelihood

1. **Operator copies `memory.db` without `-wal`.** Not this feature's problem, but it is why
   export should be the recommended path rather than file copying. Export reads through SQLite,
   which sees the WAL correctly.
2. **Digest mismatch after a partial copy.** Legible refusal; nothing written.
3. **Import into a room that already has data.** Ids collide → skipped, not overwritten. No
   dedup, so near-duplicates become two records. Accepted: deduplication is a separate,
   evidence-gated decision (`src/consolidate.mjs` proposes; it does not merge).
4. **Stale `schemaVersion`.** Refused. When the record schema changes, the bump must ship with a
   migration or with a documented refusal; silently reading old columns is not on the table.
5. **Exported file is world-readable.** Avoided by `0600` and by refusing to write outside cwd
   without `--out`.

## 9. What must be decided before any code is written

| # | Decision | Recommendation | Why it cannot be defaulted |
|---|---|---|---|
| 1 | Is export/import in scope for 0.3, or still deferred? | In scope — the portability gap is now the reported pain, not a hypothetical | Reopening a Defer row needs a recorded trigger; this is that trigger |
| 2 | Does import get `--adopt-provenance`? | Yes, but as a separate explicit flag | It edits provenance, which is one step from authority |
| 3 | JSON file or a directory bundle? | JSON file | One file is one digest, one atomic rename, one thing to copy wrong |
| 4 | Does export include `candidate` records? | Yes, all of them | Candidates are cheap and the operator may want the full picture; they cannot be recalled anyway |
| 5 | Does export include Central? | No, separately and later | Central is cross-project by definition; its export needs its own leak analysis |

## 10. Test plan (the tests that would fail today)

- Round-trip: export → import into an empty room → every field except `projectId` and
  `source.importedFrom` is identical; digest stable across a re-export.
- Digest: flip one character in one `body` → `import/digest-mismatch`, room untouched.
- Truncation: cut the file at 80% → parse or digest failure, never a partial import.
- Idempotence: import the same file twice → second run inserts 0, skips N, room byte-identical.
- Conflict: pre-existing record with the same id and different content → skipped, original
  unchanged (this is the anti-downgrade test).
- Isolation: a record exported from room A, imported into room B, must not appear in room C's
  `list()/search()`; and A's own database must be unmodified by the import.
- Authority: a `canonical` record imports as `canonical`; a `candidate` imports as `candidate`;
  neither is upgraded, and `--adopt-provenance` refuses on canonical.
- Redaction: a body containing an AWS key, planted before export, is scrubbed in the file.
- Resolver: import with an unresolvable workspace → `import/room-unresolved`, no file writes.
- Enum: a record with `kind: "note"` → whole import refused, not silently dropped.

## 11. Deliberately excluded, with the reason

- **Backup scheduling.** A daemon violates "no background services"
  (`docs/capability-matrix.md:51`, Reject).
- **Encrypted export.** A correct encryption story needs key management; without it, "encrypted"
  means "obfuscated". Defer until there is a transport that leaves the host.
- **Cross-room merge / reconciliation UI.** Merge is a knowledge decision, not a file operation;
  it belongs to `src/consolidate.mjs` proposals, which stay read-only.
- **Import into Central.** Requires the leak analysis Central's admission policy already
  presumes (`src/promotion.mjs`); a file-based bypass would undo it.
- **Automatic restore on first open of a familiar repository.** This is the shape the user
  originally proposed (a repository-level id). It is excluded here for the reason argued
  earlier: a self-declared id is not verifiable, so it cannot authorize a room.
