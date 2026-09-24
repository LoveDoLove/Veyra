# Veyra

Persistent engineering memory for [DeepSeek Harness](https://github.com/deepseek-ai/DeepSeek-Harness).

Install it, restart DSH, keep working. Veyra observes useful context, remembers durable lessons, and recalls them on later turns. It does not write into your repo.

## Install

```sh
dsh plugin --profile web add @lovedolove/veyra
```

Restart `dsh web`. A good boot looks like this:

```
[veyra] plugin loaded (home=...)
[veyra] registered /veyra
[veyra] registered skill: veyra
[veyra] registered tools: veyra_remember, veyra_recall, veyra_inspect, veyra_forget, veyra_promote
```

Requires Node 22.5+ and DSH `>=0.1.2-rc.1`. Memory lives in `$DSH_HOME/veyra/`.

## Daily use

You do not manage memory for ordinary work.

1. Do engineering in DSH as usual.
2. Veyra distills the turn into a candidate (files, symbols, test outcomes, claim signal, and structured causal facets: `symptom → rootCause → remedy → verifiedOutcome`). Durable, grounded lessons become derived memory and are linked to neighbors — extended, updated, or contradicted. Near-duplicates are not cloned; instead, repeated observations and verified test outcomes strengthen existing knowledge (unverified → reviewed → verified) and accumulate evidence anchors. Nothing is merged silently.
3. On a later session in the same project, relevant memory is injected automatically. Recall is intent-aware (`why` → symptom/cause, `how` → remedy, `did this fix it` → outcome, `what happened` → symptom). Contradictions stay visible on both sides. Superseded, repository-drifted, and long-idle unverified memories leave ambient recall. Canonical is never assigned automatically.

Ask the agent to remember something important, or just keep going — automatic recall is already on.

## Commands

| Command | What it does |
| --- | --- |
| `/veyra` | Status for this workspace |
| `/veyra recall <query>` | Search project (+ reusable) memory |
| `/veyra recent` | Last 8 records, including candidates |
| `/veyra inspect <id>` | Read one record |
| `/veyra forget <id>` | Soft-forget (leaves recall, stays inspectable) |
| `/veyra promote <id> canonical` | Mark as project truth — **only this is canonical** |

Tools with the same names (`veyra_remember`, `veyra_recall`, …) are available to the agent. Load the bundled `veyra` skill when you need the full remember / recall / promote rules.

## Memory rules

| What | Authority | Auto-recalled? |
| --- | --- | --- |
| Auto-captured observation | `candidate` | no |
| Remembered / learned lesson | `derived` | yes |
| Explicitly promoted truth | `canonical` | yes |

Canonical is never assigned automatically. Repo files stay authoritative. Similarity is not identity: overlapping memories are linked, not merged. Secrets are redacted. Projects are isolated; reusable memory is opt-in.

## Config (optional)

In the profile `cordis.patch.yml`:

```yaml
- id: veyra
  name: '@lovedolove/veyra'
  config:
    recallLimit: 5
    includeReusable: true
    observe: true
    learn: true
```

`VEYRA_HOME` overrides the storage root.

## License

MIT
