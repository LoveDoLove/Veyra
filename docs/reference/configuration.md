# Configuration and Storage

Veyra works with built-in defaults and needs no configuration. Everything below
is optional.

---

## Profile configuration

Settings live in the profile YAML, alongside every other plugin:

```yaml
- id: veyra
  name: '@lovedolove/veyra'
  config:
    recallLimit: 5        # 0 = no automatic recall context
    includeReusable: true # include Central Memories in recall
    observe: true         # capture session activity
    learn: true           # promote durable observations to memory
    codebaseWatch: true   # watch the repo and flag stale memories
    home: "~/.dsh/veyra"  # storage root
```

| Key | Default | Type | Meaning |
| --- | --- | --- | --- |
| `recallLimit` | `5` | number | Maximum records injected per turn. `0` disables automatic recall context only |
| `includeReusable` | `true` | boolean | Include Central Memories in recall results |
| `observe` | `true` | boolean | Capture session activity. `false` disables the whole observation pipeline |
| `learn` | `true` | boolean | Run the write gate and create derived memory |
| `codebaseWatch` | `true` | boolean | Watch the workspace for file changes to flag stale memories |
| `home` | `~/.dsh/veyra` | string | Storage root |

Only `recallLimit` and `includeReusable` are rendered in the DSH Settings
schema. `observe`, `learn`, `codebaseWatch`, and `home` are YAML-only.

Changes apply on the next turn or the next plugin remount. No restart is
required.

### `recallLimit: 0`

This disables automatic recall context and nothing else. `veyra_recall`, the
`/veyra` commands, the Observatory, and stored memory all keep working. It is
the switch used when you want to compare agent behaviour with and without
ambient memory.

---

## Environment variables

| Variable | Effect |
| --- | --- |
| `VEYRA_HOME` | Overrides the storage root. Takes effect when `config.home` is not set |
| `DSH_HOME` | Host root. Storage defaults to `$DSH_HOME/veyra/` |
| `CBM_EXE` | Path to a pre-existing `codebase-memory-mcp` binary, for Code Intelligence |

---

## Storage layout

```
$DSH_HOME/veyra/
  rooms/
    <roomId>/
      memory.db        one SQLite database per DSH workspace
  central/
    memory.db          knowledge promoted out of a room
```

Each database uses `node:sqlite` with FTS5. Nothing is stored inside your
repository.

A room id derives from the DSH `WorkspaceId`, never from a filesystem path. Two
workspaces on one repository therefore have separate memory.

The pre-rooms `projects/<projectId>` and `reusable/` directories are legacy.
Veyra never reads, writes, migrates, merges, or deletes them.

---

## Inspecting and resetting

`/veyra` prints the resolved room id and workspace path for the current
workspace, which is the fastest way to confirm you are looking at the memory you
expect.

To start one workspace over, delete its room directory under
`rooms/<roomId>/`. Other rooms and Central Memories are untouched.

---

## Disabling parts of the loop

| Goal | Setting |
| --- | --- |
| No ambient recall, keep the tools | `recallLimit: 0` |
| No automatic capture | `observe: false` |
| Capture but never learn | `observe: true`, `learn: false` |
| No staleness marking from file changes | `codebaseWatch: false` |
| No cross-workspace recall | `includeReusable: false` |
