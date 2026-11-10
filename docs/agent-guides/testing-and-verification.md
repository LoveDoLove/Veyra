# Testing and Verification

## Layout

- `npm test` runs `node --test test/*.test.mjs` — 106 test files.
- `test/helpers/dsh.mjs` locates an installed DSH for real-runtime tests. It is
  not a test file and is not run directly.
- `test/helpers/room.mjs` builds the workspace-room fixtures: `testRuntime`,
  `testRuntimeWithStores`, `roomStore`, `centralStore`, `agentFor`,
  `fakeRegistry`, `roomIdFor`. Tests drive the real resolver, router and Memory
  Server through a fake registry, so a test cannot pass against a store the
  production path would never open. It is test-only; nothing in `src/` imports
  it.
- `test/eval-v0164-ab.mjs` and `test/phase4-validate.mjs` are **manual harnesses**
  and are not part of `npm test`.

Current baseline on Node 24: **1044 tests, 1044 pass, 0 fail, 0 skipped.** Some
tests are environment-gated (no discoverable DSH install, or
`@deepseek-ai/cordis` not resolvable) and report as skipped where the gate does
not open, so a run can legitimately show fewer tests. Report exact counts from
your own run; never quote a number you did not observe.

## Running

```sh
npm test                                  # full suite
node --test test/<name>.test.mjs          # one file
DSH_INSTALL=/path/to/dsh npm test         # force a specific DSH for runtime tests
node scripts/runtime-deps-check.mjs       # release guardrail for bare imports
npm run pack:check                        # npm pack --dry-run
```

CI (`.github/workflows/ci.yml`) runs the runtime-deps check, `npm test`, and
`npm pack --dry-run` on Node 22 and 24 for every push and pull request. A change
that passes locally must also be valid on Node 22.

## What the suites protect

| Area | Representative files |
| --- | --- |
| Domain constants and gates | `types.test.mjs`, `config.test.mjs` |
| Write gate and learning safety | `m1-write-gate.test.mjs`, `learn-safety.test.mjs`, `learn-relation-pool.test.mjs` |
| Retrieval and ranking | `retrieve.test.mjs`, `retrieve-evidence.test.mjs`, `retrieve-identifier.test.mjs`, `retrieve-polarity.test.mjs`, `m3-fusion.test.mjs` |
| Recall budget and context | `recall-budget.test.mjs`, `m6-context.test.mjs`, `recall-limit-regression.test.mjs` |
| Trust and provenance | `trusted-context.test.mjs`, `m8-provenance.test.mjs`, `m9-provenance-gate.test.mjs` |
| Lifecycle and forgetting | `m10-forgetting-protection.test.mjs`, `m5-maintenance.test.mjs` |
| Health, consolidation, feedback | `m7-memory-health.test.mjs`, `m12-consolidation.test.mjs`, `m6-feedback-recurrence.test.mjs` |
| Isolation and security | `isolation-security-benchmark.test.mjs`, `redact.test.mjs`, `m13-safety-hardening.test.mjs` |
| Workspace rooms and the registry | `memory-rooms.test.mjs`, `memory-rooms-dsh-registry.test.mjs`, `memory-server-safety.test.mjs` |
| Governed promotion refusals | `promotion-refusals.test.mjs` |
| Memory Server end to end | `memory-server-dsh.test.mjs` |
| Code Intelligence glue | `code-linking.test.mjs`, `code-retrieval.test.mjs`, `code-tools.test.mjs`, `code-lifecycle.test.mjs` |
| Host seams | `plugin.test.mjs`, `settings.test.mjs`, `skills.test.mjs`, `webui.test.mjs`, `compatibility.test.mjs`, `dsh-runtime.test.mjs` |
| Packaging | `runtime-deps-check.test.mjs` |

## Rules for new tests

1. **Reproduce first.** The test must fail against the old behavior. If it passes
   before your change, it does not prove anything about the fix.
2. **Assert the requirement, not the implementation.** Prefer observable outcomes
   (what is recalled, what authority results, what the gate decides) over
   internal call counts.
3. **Isolate state.** Use `openEphemeralStore` or a temp home. Never read or
   write the live `$DSH_HOME`, never bind the DSH Web port, never hit the
   network.
4. **Regression tests name the failure.** Follow the existing convention: a short
   comment stating the bug and the invariant it protects.
5. **Do not weaken existing assertions** to make a change pass. If an assertion is
   genuinely wrong, change it deliberately and explain why.
6. **Do not skip a test to go green.** Skips are for environment gaps only, and
   they carry an explicit reason string.

## Verifying outside the suite

Some behavior cannot be proven by unit tests:

- **Plugin boot and host registration** — use the composed-runtime pattern in
  `test/dsh-runtime.test.mjs`: a fresh Cordis context with the real host service
  classes, a temp home, no ports.
- **HTTP surface** — drive the handler in-process (as `webui.test.mjs` does)
  rather than starting a server.
- **Packaging** — `npm pack --dry-run` and the runtime-deps guardrail, not a real
  publish.

Never verify by restarting, stopping, or reconfiguring the running DSH Web. If
verification would require that, stop and report instead.

## Completion evidence

A completion report must state what was run and what it returned. "Tests pass"
without the command and counts is not evidence.
