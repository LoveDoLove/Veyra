# Veyra examples

Real files you can copy or run — nothing here is hand-written sample output.

| File | What it is |
| --- | --- |
| [`cordis.patch.yml`](cordis.patch.yml) | The complete plugin entry for a DSH profile's `cordis.patch.yml`, with every accepted config key and which of them are also editable in DSH Settings → Veyra. |
| [`command-output.md`](command-output.md) | Captured output of `/veyra`, the Observatory (`overview`, `search`, `record`, `local`), `/veyra recent`, and `/veyra recall` — produced by the real command handler against a throwaway demo store. The four records in it are clearly-labeled demo content. |
| [`make-demo-output.mjs`](make-demo-output.mjs) | Regenerates `command-output.md` from source: `node examples/make-demo-output.mjs`. Ids and timestamps are pinned, so reruns are stable; score breakdowns can shift slightly as freshness tiers age. |

Everything else you need is in the [README](../README.md):

- Install and boot verification → *Install*
- The shortest path to a first recalled memory → *Quick Start*
- What to do when something does not work → *Troubleshooting*
