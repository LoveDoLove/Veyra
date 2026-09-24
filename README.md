# Veyra

Persistent engineering memory & Knowledge Observatory for [DeepSeek Harness](https://github.com/deepseek-ai/DeepSeek-Harness).

Install it, restart DSH, keep working. Veyra observes useful context, remembers durable lessons, indexes RAG documentation, and recalls them via unified Hybrid Search. It does not write into your repo.

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
3. On a later session in the same project, relevant memory and RAG knowledge are recalled automatically via **Hybrid Search** (combining lexical FTS5 BM25 + exact symbols, token-level semantic Jaccard overlap, intent affinity, and relationship graph signals). Contradictions stay visible on both sides. Superseded, repository-drifted, and long-idle unverified memories leave ambient recall. Canonical is never assigned automatically.

Ask the agent to remember something important, or just keep going — automatic recall is already on.

## Hybrid Search & Unified RAG

Veyra unifies Engineering Memory (`kind: 'memory'`) and Knowledge Base / RAG documentation (`kind: 'knowledge'`):
- **Lexical**: SQLite FTS5 BM25 ranking plus exact symbol and file-path boosts.
- **Semantic**: Token Jaccard overlap and query concept coverage.
- **Memory & Causal**: Intent affinity prioritizing root cause for *why*, remedy for *how*, verified outcomes for *did this fix it*.
- **Relationships**: Graph cohesion boosts interconnected knowledge.
- **Multi-Dimensional Ranking**: Composite score with full transparent breakdown (`relevance`, `semantic`, `evidence_strength`, `validation_tier`, `scope_proximity`, `freshness_tier`, `confidence`, `intent_affinity`, `relationship`).

## Commands & Knowledge Observatory

| Command | What it does |
| --- | --- |
| `/veyra` | Status and memory counts for this workspace |
| `/veyra observatory` | Open the Human Knowledge Observatory dashboard |
| `/veyra observatory search <query>` | Inspect hybrid search signals and score breakdowns |
| `/veyra observatory record <id>` | Deep inspection answering the 6 questions (What, Why, Where, When, Evidence, Validation) |
| `/veyra observatory causality` | Causal knowledge map (`symptom → rootCause → remedy → verifiedOutcome`) |
| `/veyra observatory relationships [id]` | Directed graph projection of knowledge links |
| `/veyra observatory local <id>` | 1-hop Local Graph around a record (default graph view) |
| `/veyra observatory graph [id]` | Local Graph when an id is given; otherwise the project edge list |
| `/veyra observatory contradictions` | Active conflicting claims shown side-by-side |
| `/veyra recall <query>` | Hybrid search project (+ reusable) memory |
| `/veyra recent` | Last 8 records, including candidates |
| `/veyra inspect <id>` | Read one record with deep provenance and causal facets |
| `/veyra forget <id>` | Soft-forget (leaves recall, stays inspectable) |
| `/veyra promote <id> canonical` | Mark as project truth — **only this is canonical** |

Tools with the same names (`veyra_remember`, `veyra_recall`, `veyra_inspect`, `veyra_forget`, `veyra_promote`) are available to the agent. Load the bundled `veyra` skill when you need full guidance.

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
