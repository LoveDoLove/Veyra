# Veyra — The Engineering Brain for DSH

Veyra is a native [DeepSeek Harness](https://github.com/deepseek-ai/DeepSeek-Harness) plugin that gives DSH agents persistent engineering experience across sessions and projects.

**observe → understand → remember → recall → apply → learn**

Memory is ambient during ordinary engineering work. You should not have to manage it for day-to-day use.

## What it does

- Observes DSH session activity (messages, tools, files) without treating every event as knowledge.
- Remembers durable engineering experience — decisions, root causes, constraints, fix patterns.
- Recalls relevant memory automatically into the agent's turn context.
- Distinguishes candidates from derived memory from canonical knowledge.
- Isolates projects. Reusable experience is opt-in and never treated as another project's truth.
- Redacts secrets before anything is persisted.
- Lives **outside** the user's repository (`$DSH_HOME/veyra/`), so it never mutates `docs/` or `AGENTS.md`.

## Principles

- Observe ≠ Store
- Candidate ≠ Truth
- Similarity ≠ Authority
- Memory ≠ Knowledge
- Knowledge without evidence is not authoritative
- Repository truth remains authoritative
- Automatic behavior must not silently create authoritative truth
- Project isolation must be preserved
- Memory assists engineering; it does not replace verification

## Install

Veyra is a DSH bundle plugin.

```sh
dsh plugin --profile web add @lovedolove/veyra
```

Or from a local checkout / packed tarball:

```sh
dsh plugin --profile web add /path/to/Veyra
dsh plugin --profile web add ./lovedolove-veyra-0.1.0.tgz
```

Restart (or reload) the profile after install. On boot you should see:

```
[veyra] plugin loaded (home=...)
```

Dev overlay, without installing into the active profile:

```yaml
# /tmp/veyra.dev.patch.yml
- insert:
    - id: veyra
      name: '/absolute/path/to/Veyra/src/plugin.mjs'
```

```sh
dsh --profile <isolated-profile> --patch /tmp/veyra.dev.patch.yml
```

Do not attach a dev overlay to a DSH Web process someone is already using.

## How memory works

| Kind | Authority | In automatic recall? |
| --- | --- | --- |
| Observation (auto-captured) | `candidate` | no |
| Remembered / learned experience | `derived` | yes |
| Explicitly promoted project truth | `canonical` | yes |
| Forgotten, stale, invalid, superseded | — | no |

Canonical authority is **never** assigned automatically. Only `/veyra promote <id> canonical` or `veyra_promote` with `explicit: true` can do that, and that is a user action.

Storage:

```
$DSH_HOME/veyra/projects/<projectId>/memory.db
$DSH_HOME/veyra/reusable/memory.db
```

`projectId` is `sha256(gitRoot|gitRemote)` (falling back to the resolved workspace path). Two checkouts of the same remote share a project; unrelated folders do not.

The database is Node's built-in `node:sqlite` with FTS5. There are no native addons.

## Tools

| Tool | Purpose |
| --- | --- |
| `veyra_remember` | Keep durable knowledge (always derived, never canonical) |
| `veyra_recall` | Targeted search beyond the automatic context |
| `veyra_inspect` | Read one record, including candidates |
| `veyra_forget` | Soft-forget (leaves recall, stays inspectable) |
| `veyra_promote` | Change standing; canonical requires `explicit: true` |

Slash command: `/veyra`, `/veyra recall …`, `/veyra recent`, `/veyra inspect <id>`, `/veyra forget <id>`, `/veyra promote <id> [derived|canonical]`.

## Configuration

Optional `config:` on the Cordis row:

```yaml
- id: veyra
  name: '@lovedolove/veyra'
  config:
    home: '~/.dsh/veyra'   # override storage root
    recallLimit: 5
    includeReusable: true
    observe: true
    learn: true
```

`VEYRA_HOME` overrides the storage root. `$DSH_HOME` is respected when resolving the default.

## Development

```sh
npm test
npm pack
```

Requires Node 22.5+ (`node:sqlite`).

## License

MIT
