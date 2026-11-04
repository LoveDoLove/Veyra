## [Unreleased]

### Fixed

- **Recall budget no longer cuts through a record**: the injected context is now allocated per RECORD BLOCK instead of by truncating the joined text. `joinWithBudget` in `src/context.mjs` previously sliced the rendered string at the character budget and backed up to the last newline, so a record could be cut in the middle: the header survived while its trust line, evidence and contradiction banner fell past the cut, leaving an unattributed claim in the prompt — the exact failure the trust markers exist to prevent. Allocation now treats each record (banners, header, trust, evidence, causal detail, body) as one unit that is emitted whole or dropped whole, retries the kept prefix without detail (body and causal facets) before it gives up a record, keeps the framing while it fits and the heading always, and states the cut with the unchanged notice. Measured on a 50-record extreme recall: at every budget from 500 to 2000 the number of headers equals the number of trust lines (previously budget 1200 emitted 3 headers with only 2 trust lines). Behaviour is unchanged when everything fits — same string, no notice.

- **One oversized record no longer empties recall**: `joinWithBudget` in `src/context.mjs` walked the ranked record blocks and STOPPED at the first block that did not fit the character budget. A single verbose record at the head of the ranking therefore consumed the entire allowance and every smaller record behind it was silently lost — the agent saw framing plus the truncation notice and could not distinguish "nothing matched" from "rank 1 was long". The allocator now skips a block that does not fit and keeps considering shorter later blocks, adapted from `fitWithinBudget` in dsh-engram `src/retrieve/budget.ts` (`if (used + size > totalBudget) { dropped += 1; continue }`). Selection stays greedy in rank order, so a skipped block never displaces a higher-ranked kept one. Measured on a fixture of one ~2.4k-char causal record followed by eight ~190-char records: budgets 400–2500 previously kept ZERO records; now budget 800 keeps 2, 1200 keeps 5, 1600 keeps 7, and 2000 keeps all 8, with headers still equal to trust lines at every budget. When everything fits, behaviour is unchanged.
- **Recall detail is expendable, records are not**: a record block now has two tiers — attribution (header, trust line, evidence, banners) and detail (the body line and the four causal facets). Only detail is dropped when the budget is tight, and it is dropped before any record loses its place. Previously the causal facets had no length cap and the body-retry tier never applied to them, so a record with long causal detail had no expendable part at all: measured on a fixture, a record with 1500-char facets rendered a 6.2k-char block and was dropped whole even at the default 6000-char budget, while its attribution is ~170 chars. Now that record keeps its header, trust line and evidence, and `veyra_recall` recovers the detail. The trimmed pass decides WHICH records survive; leftover room then restores detail in rank order, so a comfortable recall shows full records instead of attribution-only stubs (measured: 1 oversized + 8 small records at the default budget now use 5877 of 6000 chars with full detail on the top record, instead of 2201 chars with no detail at all). A record whose attribution alone cannot fit is still dropped whole — never half a block.

- **Card-context detection no longer fires on ordinary substrings**: `CARD_CONTEXT` in `src/redact.mjs` matched payment terms anywhere in the string, so `discard 4111111111111111`, `unpaid balance …`, `cardboard …`, `discharge …`, `accredit …` and `wildcard …` all redacted a Luhn-valid number that merely sat next to one of those words. Every context term is now word-bounded (`\b`); the multi-word form `american express`, the bare `pan` and the special forms `cc_num` / `cc number` are kept; the ordinary engineering verbs `discover` and `charging` are deliberately left out of the list (a Discover card is still caught through `card` / `credit` or through the grouping/IIN rule). Measured: the 9 false-positive strings now pass through byte-identical, and 9 legitimate positives — including `American Express`, `PAN`, `cc_num` and a grouped `4111 1111 1111 1111` without any context word — are still redacted. `test/redact-pii.test.mjs` gains two regression tests (whole-word negatives, whole-word positives). Other PII patterns were audited for the same class of boundary issue: `secret_key_assignment` requires `:` / `=` immediately after the keyword and `env_assignment` is uppercase-only, so neither has a live substring-boundary defect; the keyword-substring behaviour on uppercase env names is intentional fail-closed over-redaction and is left unchanged.

### Added

- **Checksum- or structure-validated PII is redacted before it reaches memory**: `src/redact.mjs` only ever caught credentials of known SHAPE (bearer tokens, prefixed keys, PEM blocks, quoted secret and env assignments). Anything identifiable only by a checksum or a structural rule passed through unchanged and was persisted verbatim — measured before this change, a Luhn-valid payment card, a valid ISO-13616 IBAN and a structurally valid US SSN all returned `clean: true` from `scrub()`. A second, per-match-validated tier now catches them (Luhn mod-10, IBAN mod-97 with letter expansion, SSN area/group/serial rules), adapted from mnemon `internal/safety/mask.go` (Apache-2.0, "patterns, checksums, no model"). Placeholders are fixed — `[REDACTED_CARD]`, `[REDACTED_IBAN]`, `[REDACTED_SSN]` — because mnemon's "ending in NNNN" style would echo real digits into persisted memory. Its email/phone/account/passport/license kinds were rejected: measured against this repository, an email rule alone would rewrite the ordinary engineering string `git@github.com`, and those kinds carry no checksum or reliable structural rule. Precision is treated as part of the contract: a bare 13-19 digit run is a card only when it carries card grouping **and** a plausible IIN (2-6), or when payment wording sits beside it, so a Luhn-passing snowflake id or the grouped table row `1000 2000 3000 4000` is left byte-identical. Verified by `test/redact-pii.test.mjs` (9 tests): 8/8 validated identifiers caught, 12/12 ordinary engineering strings untouched, and the tier fired in exactly one of 155 scanned repository files — its own test fixture. Values that fail their check are never rewritten, and redaction stays idempotent.
- **Every learning decision is now accounted for**: `writeGate` (`src/learn.mjs`) already returned a four-state verdict — ACCEPT / MERGE / DROP / DEFER with a reason — but `maybeLearn` reduced it to `writeGate(...).record ?? null`, so the automatic per-turn learner and feedback-driven learning kept the written record and threw the verdict away. Only ACCEPT left a trace (as `source.writeGate` on the record); MERGE, DROP and DEFER left nothing, and no surface could answer "why was this turn not learned?". The gate now records its verdict itself, so every caller — per-turn learning, feedback, explicit candidate review — is tallied exactly once. The tally rides the store's existing `meta` key/value table through new `getMeta`/`setMeta` methods on `MemoryStore`, so there is no schema migration, no new table and no new column; it stores only the decision and reason strings (never title, body, evidence or source), so it cannot become a second memory store or a new unredacted write path, and it is never a memory row — `list()` and `count()` do not see it. Accounting is bounded (24 reason buckets plus an `other` overflow, 8 most recent verdicts) and best-effort: a failing `meta` write is swallowed and learning proceeds unchanged. `/veyra health` and `veyra_health` report it as `writeGate` accounting — decisions, top reasons, and the reminder that DROP and DEFER leave no record by design — deliberately kept out of `findings`/`totalFindings`, because a deferred candidate is not a memory-quality problem. Idea taken from dsh-engram `src/write-disposition.ts` (every disposition is observable, a deferral is persisted rather than silently dropped) and the dropped/truncated accounting line in tencentdb-agent-memory `MemoryCore/src/core/hooks/auto-recall.ts`. `test/write-gate-ledger.test.mjs` (10 tests) covers the tally, the no-content property, restart persistence, ledger failure not breaking learning, bounding, the read-only health surface, `maybeLearn`'s unchanged contract, and a schema guard that the `veyra_health` output avoids JSON Schema type arrays (the DSH tool validator accepts `oneOf` beside annotations, not `type: [...]`).

## [0.1.68] - 2026-11-03

### Fixed

- **False contradiction edges (Issue #3)**: replacement-language classification no longer manufactures `contradicts` relations. `classify()` in `src/diff.mjs` previously returned `DIFF.CONFLICT` whenever either claim contained a replacement phrase (`rather than`, `instead of`, `deprecated`, `switched from`, …) with no similarity floor, so one ordinary phrase turned a note into a conflict magnet against peers sharing ~2% of tokens, poisoning both records' trust and surviving `promote` to canonical. The replacement branch now requires a shared-subject anchor (`sharesSubject()` provenance overlap, the same predicate the supersede gate already used) **and** the existing `MIN_CONFLICT_SIM` lexical threshold before it may report a conflict. Same-subject replacements below the floor become `UPDATE`, preserving directional `supersedes` behaviour; zero-overlap matches stay `ADD`. Near-verbatim and polarity branches are unchanged, so genuine conflicts are still detected.

### Added

- **Transactional relation detach**: `/veyra unlink <id> contradicts <targetId> [why]` (`src/relationships.mjs`) removes exactly one `contradicts` edge in both directions inside `BEGIN IMMEDIATE`, using the prior `relations` value as an exact SQL precondition so a concurrent change aborts the whole operation with `nothing was changed`. Only the named edge is removed; every other relation and every field — authority, validation, source, evidence, timestamps — is preserved, and trust reclassifies once the edge is gone. Refuses missing records, cross-store pairs, self-links, absent edges, malformed relations, and any non-`contradicts` type. Previously the only way to detach a false edge was direct SQLite surgery.
- **Read-only contradiction audit**: `/veyra audit contradictions` (`src/audit.mjs`) reports existing `contradicts` edges carrying the defect's signature — claim similarity below the conflict floor, no shared-subject anchor, replacement wording without a subject, or a dangling target — with both endpoints, edge direction, similarity, subject status, per-edge reasons, and the exact `unlink` command to run. Strictly read-only: nothing is unlinked, rewritten, invalidated, or demoted. Bounded to 200 records per store and 50 rendered findings, and it states the provenance limitation (Veyra records no relation provenance, so a flagged edge may be genuine).

## [0.1.67] - 2026-11-03

### Changed

- **Codebase Memory bridge**: upgraded `@lovedolove/dsh-codebase-memory-mcp` from `^0.1.5` to `^0.1.6`. The 0.1.6 release refreshes the CBM README, CHANGELOG, and bundled skill to document the lazily started daemon lifecycle; its runtime source and public exports are unchanged, so Veyra's CBM integration needs no code changes.

## [0.1.66] - 2026-11-03

### Fixed

- **DSH plugin packaging**: removed `bundledDependencies` and rely on declared registry `dependencies` (`@lovedolove/dsh-codebase-memory-mcp: ^0.1.5`). DSH uses `pnpm` to install profile plugins, which does not materialize `bundledDependencies` for git or remote specifications and causes `ERR_MODULE_NOT_FOUND Cannot find module '@lovedolove/dsh-codebase-memory-mcp'`. Declared registry `dependencies` is the DSH-supported mechanism for bundled components.

### Added

- **Runtime dependency check**: added `scripts/runtime-deps-check.mjs` guardrail to `.github/workflows/ci.yml` and `.github/workflows/publish-npm.yml` to verify that all bare runtime imports across shipped files are declared in `dependencies`.
- **Packaging regression test**: added `test/runtime-deps-check.test.mjs` verifying comment stripping, string spans, bare specifier extraction, host-provided dependency handling, and asserting that `package.json` contains no `bundledDependencies` and declares `@lovedolove/dsh-codebase-memory-mcp`.

## [0.1.65] - 2026-11-03

### Added

- **Codebase Memory bundling**: bundle `@lovedolove/dsh-codebase-memory-mcp` as a `bundledDependency`, automatically providing all 6 CBM tools (`cbm_projects`, `cbm_search`, `cbm_snippet`, `cbm_trace`, `cbm_arch`, `cbm_search_code`) upon Veyra installation without requiring a separate plugin.

### Changed

- **CBM extraction and deduplication**: separated CBM ownership into `@lovedolove/dsh-codebase-memory-mcp`, removed duplicate internal CBM modules (`src/code/{client,discovery,engine,types,watcher}.mjs`) from Veyra, and re-routed internal imports to the bundled package.
- **CI and publish workflows**: added `npm install` before tests and packaging in `.github/workflows/ci.yml` and `.github/workflows/publish-npm.yml` to ensure reproducible test runs and verified bundled package artifacts on clean checkouts.

## [0.1.63] - 2026-10-31

### Fixed

- **Web UI**: read the host-provided `webServer` service via `ctx.get`, so a sibling-provided service is found — the direct lookup no longer misses services injected by sibling plugins (PR #2, @Wish985-cell).

### Changed

- **Release pipeline**: explicitly set `draft: false` on the GitHub Release step, so every release is published and never left as a draft.

## [0.1.62] - 2026-10-31

### Fixed

- **Continuous learning**: evidence-gated auto-learning from normal coding-agent turns. User task context + assistant fix + code edit + test-passed output now produces derived, recallable memory (M9 provenance gate and test-outcome regex fix).

### Added

- **Regression tests**: M9 provenance gate user-context-only path; '0 failed' / '0 failures' test-outcome edge case.

# Changelog

## [0.1.61] - 2026-10-30

Fix engineering memory recall after DSH Compaction.

### Fixed

- **Compaction continuity**: restore task intent from compact checkpoints and handle continuation prompts, preserving session and project isolation.
- **Query resolution**: accept `compact-checkpoint` messages, extract intent from `Primary Request and Intent` and `Key Technical Concepts`, and fall back to session-scoped task intent cache.

### Added

- **Regression tests**: `test/compaction-continuity.test.mjs` covering intent extraction, trivial prompt filtering, message walkback, session/project isolation, and end-to-end recall after compaction.

All notable changes to `@lovedolove/veyra` are documented here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/);
versions follow [Semantic Versioning](https://semver.org/) on a pre-1.0 `0.1.x` line.

> **Note on version ranges.** Releases are published by pushing a version tag (e.g., `v0.1.60`).
> The tag version must match `package.json` and must not already exist on npm.
> Each published version gets a matching GitHub Release (`vX.Y.Z`) created by the publish
> workflow.

## [0.1.51] - 2026-10-08

Change intelligence phases 1–4 — trust-classified, change-aware recall —
plus store-cache isolation hardening.

### Added

- Read-time **trust classification** (`src/trust.mjs`): every record projects
  `trusted / review_required / stale / contradicted / insufficient_evidence`
  with reasons and a suggested action. A pure read-time projection — it never
  writes and never changes a record's authority or validation; candidates can
  never project as `trusted`; precedence is
  `contradicted > stale > insufficient_evidence > review_required > trusted`.
- **`veyra_change_impact` tool**: maps an explicit `changedFiles` list to
  affected memories, affected evidence anchors, optional review candidates, and
  per-category summary counts. Without the code-intelligence binary it degrades
  to direct file-path matching (`degraded: true`) and never fabricates symbol
  or call-graph evidence.
- **Change-aware ambient context** (`src/context.mjs`): a repository change
  summary leads the recall block and every recalled record renders its trust
  category and action; with no change signal the assembled context stays
  byte-identical, repeated changes don't accumulate, and the projection fails
  closed across workspaces.
- Phase 4 validation harness (`test/phase4-validate.mjs`): standalone, run
  explicitly (not part of `npm test`) — real DSH host services, real repository
  edits restored byte-exactly, and store snapshots proving canonical memory is
  never mutated by the change pipeline.

### Fixed

- `src/store.mjs` cache keys now include the resolved database path
  (`project:${projectDbPath(veyraHome, projectId)}` and
  `reusable:${reusableDbPath(veyraHome)}`) instead of the bare project id and
  the `'reusable'` literal, so the same project id opened under two different
  Veyra homes can never share a cached store.

Full suite: 755 tests passing.

## [0.1.48] – 0.1.50 - 2026-10-07

Tool-output validation, skill-routing boundaries, and memory-title shape.

### Fixed

- Records without `source.context` omit the `context` key instead of emitting
  `null`, which DSH's tool-output validator rejects for object-typed fields.
- Skill routing tightened: bundled skill frontmatter trigger words re-synced
  with `skills/`, the "when health findings accumulate" trigger removed from
  `memory-maintenance` (maintenance now gates on explicit user intent — health
  findings are never authorization), and the `memory-review` workflow order
  corrected.
- Activity-shaped memory titles eliminated: `deriveTitle` drops the
  `Fix: work on X` / `Worked on X` / `Used X` fallbacks, a first-line title must
  pass a claim gate (minimum length plus claim keywords), and only genuine
  causal claims get claim-bearing titles — anything else becomes a neutral
  "Engineering observation". Covered by 23 regression tests.

## [0.1.45] – 0.1.47 - 2026-10-06

False-positive fixes, plus the memory-maintenance skill.

### Added

- Bundled **`memory-maintenance`** skill: applies lifecycle actions (keep /
  supersede / invalidate / forget / tombstone / revalidate / defer) over the
  memory-health findings with before/after reporting.
- Memory-maintenance safety limits enforced by the skill definition itself,
  with a dedicated test suite.

### Fixed

- False positives in change diffing, evidence health, and contradiction
  detection (`src/diff.mjs`, `src/evolve.mjs`, `src/health.mjs`), covered by a
  dedicated regression suite.

## [0.1.42] – 0.1.44 - 2026-10-05

The GOAL-driven memory-lifecycle phases 0–11, and eager Code Intelligence
startup.

### Added

- Memory-lifecycle phases 0–11: write gate, negative (known-failed) knowledge,
  retrieval fusion, applicability and temporal validity, causal provenance, and
  the `veyra_feedback` application loop with recurrence detection (phases 0–6);
  `veyra_health` memory-health findings and `/veyra health` (phase 7, §21);
  forgetting with `protect` / `unprotect` (phase 8, §22/§23); safety and
  reliability hardening — corruption detection, injection warnings, secret
  scrubbing, fail-closed repair (phase 9, §24/§25); goal-directed retrieval
  via `veyra_recall`'s
  `goal` argument (phase 10); and the §30 retrieval benchmark (phase 11).
- `GOAL.md` rewritten as the dsh-memory capability-integration plan that drove
  these phases (not published in the npm tarball).

### Changed

- Code Intelligence starts eagerly: the plugin launches the
  `codebase-memory-mcp` daemon when it loads instead of on the first `cbm_*`
  call, removing first-use latency; the binary stays optional and every code
  tool still degrades gracefully without it.

## [0.1.40] – 0.1.41 - 2026-10-02

### Fixed

- Code-intelligence tool results render correctly in the tool output.
- `veyra_code_status` omits `message` instead of returning `undefined`.

## [0.1.38] – 0.1.39 - 2026-10-01

Dual-Brain — Code Intelligence via `codebase-memory-mcp` — and
lifecycle-scoped DSH service registrations.

### Added

- **Dual-Brain architecture**: `src/code/` adds a stdio JSON-RPC client,
  path-confined discovery of the external `codebase-memory-mcp` binary
  (`CBM_EXE` / `CODEBASE_MEMORY_EXE` / `PATH`) with secret redaction, evidence
  anchor freshness, dual-brain hybrid retrieval, and a debounced filesystem
  watcher; seven Code Intelligence tools (six `cbm_*` plus
  `veyra_code_status`); `/veyra code [status | index | trace | impact]`; the
  bundled `codebase-memory` skill; `THIRD_PARTY.md`. No binaries ship with the
  package — when the binary is absent every code tool returns a structured,
  actionable error and Veyra Memory keeps working.

### Changed

- DSH service registrations and event listeners are bound to the Cordis scope
  effect, so plugin teardown releases them cleanly.
- npm publishing switched to Trusted Publishing (OIDC) — CI no longer holds a
  long-lived npm token.

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
