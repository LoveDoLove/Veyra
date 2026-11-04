# Codebase Map

Where each behavior lives, as of `0.1.68`. The file headers are the
authoritative description of each module — they state purpose and the reason for
non-obvious decisions. This map is for navigation, not a substitute for reading
the module you are about to change.

## Root

| Path | Responsibility |
| --- | --- |
| `AGENTS.md` | Coding agent entry point: rules + routing (this guide set) |
| `CLAUDE.md` | Pointer to `AGENTS.md` only |
| `README.md` / `README.zh-TW.md` | User-facing product docs: install, commands, tools, config, troubleshooting |
| `GOAL.md` | Product direction and the principles the code is built to |
| `CHANGELOG.md` | Released history, one section per version |
| `THIRD_PARTY.md` | Third-party attributions |
| `cordis.patch.yml` | Bundle patch that inserts the `veyra` plugin into a DSH profile |
| `client.js` | Browser half: Settings section + Network Graph sidebar entry |
| `scripts/runtime-deps-check.mjs` | Release guardrail: every bare import must be builtin, host-provided, or a declared dependency |
| `package.json` | Package manifest, published file set, DSH compatibility block |
| `.github/workflows/ci.yml` | Push/PR: runtime-dep check, `npm test`, `npm pack --dry-run` on Node 22 and 24 |
| `.github/workflows/publish-npm.yml` | Tag/manual: version validation, staged npm publish, GitHub Release |

## Entry point and host wiring

| File | Responsibility |
| --- | --- |
| `src/plugin.mjs` | Cordis `apply()`: builds the runtime, registers settings, tools, skills, command, WebUI, and all lifecycle event handlers; owns cleanup |

## Domain model

| File | Responsibility |
| --- | --- |
| `src/types.mjs` | All domain constants and gates: kinds, statuses, validations, authorities, confidences, scopes, relations, `SCHEMA_VERSION`, `DEFAULT_RECALL_LIMIT`, `MIN_OBSERVATION_CHARS`, `MAX_MEMORY_BODY_CHARS`, `isLifecycleEligible`, `isRecallEligible`, `assertAuthorityTransition` |
| `src/config.mjs` | Runtime Settings schema (`recallLimit`, `includeReusable`) plus `normalizeRecallLimit` |
| `src/ids.mjs` | Veyra home resolution, project identity, record ids, content hashing, workspace/git-root discovery |

## Capture → learning

| File | Responsibility |
| --- | --- |
| `src/observe.mjs` | Turns session events into a per-session activity buffer; noise filtering; `candidateFromBuffer` |
| `src/understand.mjs` | Distills a buffer into a structured engineering claim: causal facets, symbols, paths, titles; returns `null` for noise |
| `src/learn.mjs` | The write gate: `WRITE_GATES` (ACCEPT / MERGE / DROP / DEFER), `hasGrounding`, `provenanceAllowsLearning`, `gateOnce` (decision + write) wrapped by `writeGate` (decision + verdict accounting), `maybeLearn`, `remember`, `reviewCandidate`, `promote`, `strengthenMemory`; `recordWriteGateVerdict` / `readWriteGateLedger` keep the bounded decision+reason tally in the store's `meta` table |
| `src/diff.mjs` | Classifies a new claim against a neighbour: add / update / conflict, with the lexical floor and shared-subject anchor that prevent false contradictions |
| `src/evidence.mjs` | Evidence relations and test outcomes; `subjectsCompatible`, `classifyEvidenceRelation` |
| `src/negative.mjs` | Writers for `negative` (known failed approach) and `unresolved` (known open investigation) records |
| `src/redact.mjs` | Secret scrubbing applied on every write path; `scrub` runs a shape tier (`PATTERNS`) then a validated tier (`VALIDATED_PATTERNS`: Luhn cards, ISO-13616 IBANs, SSNs by structural rule) |

## Persistence and lifecycle

| File | Responsibility |
| --- | --- |
| `src/store.mjs` | `node:sqlite` + FTS5 storage: schema, `MemoryStore`, `put`/`get`/`list`/`search`/`forget`, `getMeta`/`setMeta` (the existing `meta` key/value table, used for schema version and small bookkeeping that is not a memory row), dedupe, corrupt-row refusal, `openProjectStore`, `openReusableStore`, `openEphemeralStore` |
| `src/lifecycle.mjs` | Lifecycle transitions: forget, invalidate, supersede, tombstone, protect/unprotect |
| `src/evolve.mjs` | Staleness: `markStale`, `sweepStale` |
| `src/consolidate.mjs` | Read-only detection of consolidation candidates — never mutates |
| `src/relationships.mjs` | Directed relations: formatting, transactional `unlinkRelation` |
| `src/audit.mjs` | Read-only audit of suspicious `contradicts` edges |
| `src/feedback.mjs` | Application-outcome feedback and recurrence detection |
| `src/migrate.mjs` | Store migration utilities |
| `src/health.mjs` | `memoryHealth` categories and `renderHealth` text; also renders the optional write-gate ledger (`writeGate` accounting) without counting it as a finding |
| `src/trust.mjs` | Read-time trust classification against current repository state |

## Retrieval and context

| File | Responsibility |
| --- | --- |
| `src/retrieve.mjs` | Hybrid search and ranking: eligibility gate, FTS5 BM25, identifier and evidence signals, intent reweighting, transparent score breakdown |
| `src/intent.mjs` | Query intent detection (WHY / WHEN / HOW / ENTITY / GENERAL); reweights only, never grants authority |
| `src/text.mjs` | Tokenization, Jaccard/overlap, negation and replacement-language detection |
| `src/context.mjs` | Per-turn automatic recall: query derivation, `composeAgentContext`, `renderAgentContext` with a record-block character budget (`joinWithBudget` drops a record whole, never through it; attribution is never trimmed, detail — body and causal facets — is expendable and restored when room is left), `GUIDANCE_TEXT` (`not repository truth`), compaction checkpoints, claimed-prompt memory |
| `src/graph.mjs` | Bounded 1-hop local graph projection over stored relations |

## Code Intelligence (Veyra-owned glue only)

| File | Responsibility |
| --- | --- |
| `src/code/linking.mjs` | Evidence-anchor ↔ code freshness: `checkRecordFreshness`, `findAffectedMemories`, stale review candidates |
| `src/code/retrieval.mjs` | Unified retrieval pipeline across memory and structural code facts |

Bridge internals do **not** live here. See [CBM integration](./cbm-integration.md).

## Surfaces

| File | Responsibility |
| --- | --- |
| `src/tools.mjs` | Model-facing tool definitions: 10 `veyra_*` tools plus 6 `cbm_*` spliced in from the bridge factory, schema shaping, `registerTools`, `createToolHarness` for tests |
| `src/commands.mjs` | `/veyra` slash command parsing, dispatch, help text, `packageVersion` |
| `src/skills.mjs` | `BUNDLED_SKILL_DEFINITIONS` and bundled skill provider registration |
| `src/observatory.mjs` | Read-only Observatory projections: overview, record, search, causality, relationships, local graph, contradictions, consolidation |
| `src/webui.mjs` | `/veyra` HTTP surface: HTML page plus `/graph`, `/record`, `/search` JSON endpoints, GET-only |

## Bundled skills

`skills/<name>/SKILL.md` — five skills shipped in the package: `veyra`,
`codebase-memory`, `legacy-onboarding`, `memory-review`, `memory-maintenance`.
Frontmatter is the source of truth; `src/skills.mjs` must stay in parity (a test
asserts it).

## Tests

`test/*.test.mjs` (75 files) plus `test/helpers/dsh.mjs`. See
[testing and verification](./testing-and-verification.md).

## Non-test files in `test/`

`test/eval-v0164-ab.mjs` and `test/phase4-validate.mjs` are manual harnesses and
are **not** run by `npm test`. Do not convert them into tests implicitly, and do
not assume they run in CI.
