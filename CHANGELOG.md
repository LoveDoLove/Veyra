# Changelog

All notable changes to `@lovedolove/veyra` are documented here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/);
versions follow [Semantic Versioning](https://semver.org/) on a pre-1.0 `0.1.x` line.

> **Note on version ranges.** Every push to `main` publishes to npm and patch-bumps
> automatically, so a change sometimes ships as the version that follows the one in
> `package.json` at commit time. Entries below are therefore grouped by the version
> range in which the change actually shipped, not by commit order. Each published
> version also gets a matching GitHub Release (`vX.Y.Z`) created by the publish
> workflow.

## [0.1.37] - 2026-09-29

Veyra Agent Policy — the system-prompt guidance becomes a complete agent
policy present at every DSH model step, plus DSH 0.2.0-rc.2 compatibility
metadata.

### Changed

- `src/context.mjs` `GUIDANCE_TEXT`: rewritten as the Veyra Agent Policy —
  availability (five tools, injected recall snapshot), retrieval triggers
  (`veyra_recall` / `veyra_inspect`), explicit non-retrieval rules (trivial
  tasks, never every turn, skip the tool call when the injected snapshot
  already answers), recording triggers (`veyra_remember`) with the rule that
  transient conversation noise must never become memory, validation triggers
  for conflicting or obsolete knowledge, and interpretation rules (results are
  evidence and context, not repository truth; verify important conclusions
  against current code, tests, and git history; similarity never raises a
  record's standing; no silent merge/overwrite/retire — contradictions stay
  visible and the repository wins). All prior invariants are preserved
  (`Observe ≠ Store`, `Candidate ≠ Truth`, `Similarity ≠ Authority`,
  `Memory ≠ Knowledge`, canonical only via explicit `veyra_promote`,
  fail-closed project isolation).
- The policy stays the single static `veyra:guidance` section (order 3050)
  re-assembled by DSH `preStep` before every model step — no second injection
  channel, no per-step dynamic evaluation.

### Added

- `package.json`: `0.2.0-rc.2` declared `compatible` in
  `dsh.compatibility.dshReleases`.
- Tests: policy-coverage and single-static-section assertions
  (`test/plugin.test.mjs`), assembled-policy plus no-duplicate-on-reassembly
  assertions against the real DSH services (`test/dsh-runtime.test.mjs`), and
  `0.2.0-rc.2` admitted to the range and release-matrix checks
  (`test/compatibility.test.mjs`).

## [0.1.36] - 2026-09-29

M12 — evidence intelligence, distillation quality gating, and read-only
consolidation proposals.

### Added

- `src/evidence.mjs`: pure five-state evidence/claim relation classifier
  (`supports`, `contradicts`, `unrelated`, `insufficient`, `ambiguous`) with
  subject-compatibility checks; only structured signals count — prose never
  counts as a test outcome.
- `src/consolidate.mjs`: read-only consolidation detection over bounded store
  lists, producing non-authoritative proposals (duplicate, contradiction,
  outdated, replacement, retirement) — never merges, deletes, or rewrites
  records.
- `/veyra observatory consolidation` (aliases: `consolidate`, `proposals`):
  read-only proposal surface rendering type, why, affected records, evidence,
  and a review-only action per store while preserving project/reusable
  isolation. The maintenance log now reports proposal counts.

### Changed

- `src/understand.mjs`: distillation quality gate drops malformed causal facets
  (regex or truncation artifacts) at the capture boundary — structural
  validation only, never rewrites or fabricates; raw evidence and prose stay
  intact.
- `src/evolve.mjs`: absolute evidence paths are checked as given instead of
  being joined onto the workspace root (which misreported existing files as
  missing); `supersedeEligible` exported for reuse.

Adds three M12 suites (63 tests); full suite: 424 passing.

## [0.1.21] - 2026-09-26

Launch-readiness pass: docs, examples and metadata only — no core changes.

### Added

- `CHANGELOG.md`, grouped by the version range each change shipped in.
- `examples/`: the complete `cordis.patch.yml`, plus `make-demo-output.mjs`, which regenerates `command-output.md` (status, Observatory, recall) from the real `/veyra` command handler against a throwaway demo store.

### Changed

- README rewritten for first-time visitors around the positioning line **Veyra — Engineering Intelligence for Coding Agents**: Install (CLI + GUI + boot-line verification), a 7-step Quick Start, Features/Commands/Skills tables re-verified against the code, an Architecture intro with an aligned diagram, Troubleshooting, Examples and a Compatibility table (verified on DSH `0.1.7-rc.2`). Repo-file links are absolute GitHub URLs so they also resolve on npmjs.
- `/veyra` help banner now reports the installed package version via `packageVersion()` instead of a hardcoded `v0.1.14`, and uses the positioning line.
- `package.json`: description aligned with the positioning, extra keywords, `CHANGELOG.md` added to `files`, `engines.node` bounded to `<25.0.0` to match `dsh.compatibility.nodeVersions`, `dshReleases` += live-verified `0.1.7-rc.2`.

### Fixed

- `skills/veyra/SKILL.md`: clones and worktrees do **not** share project memory — `projectIdFor` hashes `gitRoot|remote`, so separate checkouts stay isolated (probe-verified).
- `docs/architecture-graph.md`: wrong checkpoint date, identity row corrected to `sha256(gitRoot|remote)`, stale "no `dsh.client` bundle" statement removed (`client.js` serves Settings and the sidebar entry).
- `publish-npm.yml`: stale "this repository is private" provenance comment.

## [0.1.20] - 2026-09-26

### Added

- Bundled `legacy-onboarding` skill: baseline assessment, progressive investigation depth, evidence-first extraction, and building a Project Memory Baseline for unfamiliar or legacy repositories.

## [0.1.19] - 2026-09-26

### Added

- Sidebar entry for the Network Graph (dsh-context `sidebar.footer.action` pattern), passing the current workspace through to `/veyra?cwd=`.

## [0.1.18] - 2026-09-26

### Added

- Bounded workspace overview as the Network Graph landing view, plus the full interaction states (hover → click → search) over the real record projection.

## [0.1.17] - 2026-09-26

### Added

- Dedicated **Veyra** section in the DSH Settings dialog (`Recall limit`, `Include reusable`); saved changes re-validate on the Host and apply from the next turn without a restart.

## [0.1.14] – 0.1.16 - 2026-09-25

### Added

- Host-native **Network Graph WebUI** at `/veyra` (vanilla SVG served by the DSH web server) over the derived Local Graph, with JSON endpoints `/veyra/graph`, `/veyra/record`, `/veyra/search`.
- Runtime recall settings (`recallLimit`, `includeReusable`) registered with the DSH native Settings service.

### Fixed

- `recallLimit: 0` is kept as an explicit `0` (it previously coerced to the default `5`), so automatic recall context can actually be disabled; retrieval short-circuits at `limit === 0`.

## [0.1.12] – 0.1.13 - 2026-09-24

### Added

- Derived **Local Graph projection** (`src/graph.mjs`): a bounded 1-hop neighborhood over stored relation edges; recall expands recall-eligible neighbors through it.

### Fixed

- `/veyra observatory` subcommands consume DSH's `rawInput`.

## [0.1.9] – 0.1.11 - 2026-09-24

### Fixed

- Tool outputs satisfy DSH's JSON schema validation (no `undefined` fields), `recordView` round-trips losslessly, and `forget` stays inside the record's own store.

## [0.1.8] - 2026-09-24

### Added

- **Hybrid Search**: SQLite FTS5 BM25 plus exact symbol/path boosts, token-level semantic overlap, intent affinity, and relationship cohesion, reported as a transparent multi-dimensional score breakdown.
- **Unified RAG**: `kind: 'knowledge'` project documentation retrieved together with engineering memory.
- **Knowledge Observatory**: `/veyra observatory` read-only dashboard — overview, search signals, record inspection, causality, relationships, contradictions.

## [0.1.7] - 2026-09-24

### Added

- Structured causal extraction and remedy distillation: `symptom → rootCause → remedy → verifiedOutcome` facets on records.

## [0.1.4] – 0.1.6 - 2026-09-24

### Added

- Understand / evolve / intent loop: staleness marking, intent-aware retrieval, and repository knowledge health.

### Fixed

- DSH-native observe/recall so the ambient memory loop actually runs.

## [0.1.0] – 0.1.3 - 2026-09-24

### Added

- Initial release: native Cordis plugin with session observation, candidate → derived learning, the `veyra_*` tools, the `/veyra` command, system-prompt guidance plus per-turn recall context, and the bundled `veyra` skill.
- npm publishing pipeline (publish on every `main` push) and CI on Node 22/24.
