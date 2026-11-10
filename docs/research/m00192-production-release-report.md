# m00192 — Production Release: v0.2.0

**Repository:** `/home/lovedolove/projects/Veyra` (`@lovedolove/veyra`)
**Release commit:** `dd22b6317109626d406eead507842ae45f6b08f5` (`main`, parent `af40b3c chore: prepare v0.1.75 release`)
**Tag:** `v0.2.0` (annotated, tag object `0b3e141043b87985fbad5bcefeedc2bec2798ffb`)
**npm:** `@lovedolove/veyra@0.2.0`, live as `latest` since `2026-11-10T14:53:54.277Z`
**GitHub Release:** https://github.com/LoveDoLove/Veyra/releases/tag/v0.2.0
**Verdict:** **PRODUCTION_RELEASED**

Everything below is this round's own execution against the released artifact. No result is carried over from an earlier round, and no gate was relaxed to reach a pass.

---

## 1. What shipped

v0.2.0 replaces per-project memory with a **workspace-room memory server** partitioned by DSH `WorkspaceId`, and puts every automatic learning path behind a governed gate.

| Change | Where |
| --- | --- |
| Room partitioning by `WorkspaceId`, not by path | `src/rooms.mjs`, `src/workspace-resolver.mjs` |
| Operation-based routing; Central reachable only via governed promotion | `src/memory-router.mjs`, `src/promotion.mjs` |
| Memory Server wiring for DSH (resolve → room → store) | `src/memory-server.mjs` |
| Learned records land `memory/reviewed/derived`; canonical needs explicit promotion | `src/learn.mjs`, `src/store.mjs` |
| Modification evidence comes only from real mutating tool calls | `src/observe.mjs` |
| Gate normalises Markdown list markers and task checkboxes | `src/learn.mjs` |
| Code spans and paths no longer read as prose | `src/text.mjs` |

**Breaking:** pre-0.2.0 memory is not carried forward. Records under `projects/<projectId>` and `reusable/` stay on disk, untouched and unread — a deliberate clean break, not a migration that has yet to run.

Release diffstat: **106 files changed, 13238 insertions(+), 968 deletions(-)** — 49 added, 57 modified.

---

## 2. Verification gates (all executed this round)

### 2.1 Test suite — PASS, and stable

`npm test` on the released tree, run 5 consecutive times:

```
run 1 exit=0 pass=1110 fail=0
run 2 exit=0 pass=1110 fail=0
run 3 exit=0 pass=1110 fail=0
run 4 exit=0 pass=1110 fail=0
run 5 exit=0 pass=1110 fail=0
```

1110 tests, 13 suites, 0 failures, 0 cancelled, 0 skipped, `duration_ms` 2463–2728.

The same suite inside the CI publish run reported `tests 1110 / suites 13 / pass 1100 / fail 0 / cancelled 0 / skipped 10`, with every skip carrying the reason `# no DSH install found (set DSH_INSTALL to run)` (plus one `# @deepseek-ai/cordis not resolvable`). Those ten are environment-gated DSH-integration tests; locally, where a DSH install exists, all 1110 execute and pass. This is a difference in environment, not in result.

### 2.2 Mutation tests — PASS

| Suite | Result | Mutants |
| --- | --- | --- |
| `scripts/m191-mutations.mjs` | **14/14 caught**, `Source restored byte-for-byte: YES` | A7-1…A7-6 modification detection, A5-1…A5-8 sentence normalisation |
| `scripts/m188-mutations.mjs` | **4/4 caught** | K no pre-match masking, L allow bare symbol, M allow "cause is", N restore code spans never |

### 2.3 Dependencies and exports — PASS

`node scripts/runtime-deps-check.mjs` → `runtime-deps: ok — 40 shipped file(s), 11 bare import specifier(s), all declared in dependencies.` The 40 are 39 `src/**/*.mjs` (including `src/code/linking.mjs` and `src/code/retrieval.mjs`) plus `client.js`.

Exports were verified from a **clean consumer install**, not from the repo — an in-repo self-import produces a misleading `ERR_PACKAGE_PATH_NOT_EXPORTED`. From `/tmp/pub-consumer`:

```
@lovedolove/veyra            → 18 named exports
@lovedolove/veyra/dsh        → 18 named exports
@lovedolove/veyra/package.json → 0.2.0
@lovedolove/veyra/client     → client.js
```

### 2.4 Package inspection — PASS

| Property | Committed tree (`git archive` + `npm pack`) | Published artifact |
| --- | --- | --- |
| shasum | `64034109c7adc5664c1931bf247d3c52e9758bb5` | `64034109c7adc5664c1931bf247d3c52e9758bb5` |
| size | 262.0 kB | 262.0 kB |
| unpacked | 855.6 kB | 855564 |
| files | 52 | 52 |

`diff -r` between the extracted published tarball and the CI package → **IDENTICAL to committed tree**.

A working-copy `npm pack` gives a different shasum (`8daca27d…`, 262.6 kB) purely because the working copy holds CRLF line endings that Git normalises on commit (`src/text.mjs` 97, `src/evolve.mjs` 584, `src/diff.mjs` 168, `skills/legacy-onboarding/SKILL.md` 269). Packing from `git archive HEAD` reproduces the published bytes exactly — that is the authoritative comparison.

### 2.5 Version and documentation consistency — PASS

- `package.json` `"version": "0.2.0"`; `CHANGELOG.md:1` `## [0.2.0] - 2026-11-10`; `README.zh-TW.md:373` `0.2.0`.
- `grep -rn "0\.1\.75\|0\.1\.66\|0\.1\.x"` over every shipped doc → **no matches**.
- The `0.2.2-rc.1` compatibility row is evidenced, not asserted: `package.json:81`, the fix recorded at `CHANGELOG.md:97`, code comments at `test/dsh-runtime.test.mjs:115` and `test/phase4-validate.mjs:161`, and the installed host itself (`dsh --version` → `0.2.2-rc.1`).

### 2.6 Security — PASS

52 shipped files scanned: **no** lifecycle scripts (`preinstall`/`install`/`postinstall`/`prepublish`/`prepare`/`prepack`/`postpack`); **zero** secret-pattern hits (`npm_`, `ghp_`, `github_pat_`, `sk-`, `AKIA`, `xox`, `PRIVATE KEY`); **zero** `Bearer`/password lines. The single absolute-path hit is `./CHANGELOG.md:84` inside historical prose — release history, deliberately preserved.

Only bare imports are `@lovedolove/dsh-codebase-memory-mcp` and its `/discovery` subpath, both declared.

### 2.7 No stubs, no legacy fallback — PASS

- Stub scan (`TODO|FIXME|XXX|not implemented|placehold`) over shipped `src/` → only `src/redact.mjs:5` (comment) and `src/webui.mjs:366` (an HTML `placeholder` attribute).
- Every `projects/`/`reusable/` mention in `src/` is a comment, e.g. `src/memory-server.mjs:20-21` "The old `projects/<projectId>` and `reusable/` directories are never opened here" and `src/workspace-resolver.mjs:218` "stays on disk, untouched and unread". `projectDbPath`/`reusableDbPath` (`src/ids.mjs:109,113`) and `openProjectStore`/`openReusableStore` (`src/store.mjs:767,780`) are export-only for tests; the production path is `openRoomStore` (`src/store.mjs:798`).

### 2.8 Actions workflow — PASS

`.github/workflows/publish-npm.yml`: triggers `push: tags: ['v*.*.*']` and `workflow_dispatch`, `permissions {contents: write, id-token: write}`, OIDC Trusted Publishing, no `NPM_TOKEN`. Version validation fails closed on a non-`X.Y.Z` tag, a mismatch with `package.json`, a registry HTTP 200, a curl failure, or any unexpected status.

---

## 3. Release execution

| Step | Result |
| --- | --- |
| `git push origin main` | `af40b3c..dd22b63  main -> main` |
| `git tag -a v0.2.0` | tag object `0b3e141043b87985fbad5bcefeedc2bec2798ffb` |
| `git push origin v0.2.0` | `* [new tag] v0.2.0 -> v0.2.0` |
| CI (`42837817099`) | `completed success`, 22s |
| Publish (`42837861033`) | `✓ publish in 37s` — every step green |
| GitHub Release | created `2026-11-10T14:48:24Z`, `isDraft: false` |
| npm `0.2.0` | live `2026-11-10T14:53:54.277Z`, `dist-tags {"latest":"0.2.0"}` |

The local and remote tag objects are byte-identical (`0b3e1410…`), and the tag resolves to `dd22b63`.

---

## 4. Published-artifact verification

The release is only real if the artifact on the registry is the artifact that was tested. Each of these checks was run against the published package.

**4.1 Registry metadata**

```
version:      0.2.0
shasum:       64034109c7adc5664c1931bf247d3c52e9758bb5   ← identical to CI
integrity:    sha512-8NF/z32lot8u3JeT7kE2CAmdWm0IKnuuPbn7lVUjhLa79zekHZkfuv2pnEbfDjXrzc1Vnq7BeOFiXAEWfwB9ow==
fileCount:    52
unpackedSize: 855564
dependencies: {"@lovedolove/dsh-codebase-memory-mcp":"^0.1.6"}
engines:      {"node":">=22.5.0 <25.0.0"}
```

**4.2 Provenance** — two attestations are attached. The SLSA one binds the artifact to this exact commit:

```
predicateType: https://slsa.dev/provenance/v1
buildType:     https://slsa-framework.github.io/github-actions-buildtypes/workflow/v1
workflow:      .github/workflows/publish-npm.yml
ref:           refs/tags/v0.2.0
repository:    https://github.com/LoveDoLove/Veyra
commit:        dd22b6317109626d406eead507842ae45f6b08f5
```

`_npmUser` records the OIDC publisher together with the human approval that took the package live:

```
{"name":"GitHub Actions","email":"npm-oidc-no-reply@github.com",
 "approver":{"name":"lovedolove","email":"v0130p5100cuboss@gmail.com"},
 "trustedPublisher":{"id":"github","oidcConfigId":"6b6f5e31-747f-44d7-ac58-e7b821fe2cf1"}}
```

**4.3 Installability** — `npm install @lovedolove/veyra@0.2.0` in a clean directory: `added 2 packages`, `found 0 vulnerabilities`, all four export paths resolve.

**4.4 Behaviour end-to-end** — the probe imported only the published copy:

```
storesOk:        true
roomId:          w_11111111-2222-3333-4444-555555555555   ← equals roomIdForWorkspaceId(workspaceId)
written:         1
search:          vey_1a1c5f826ee_fcf2228b1db9 / "compileDecoder caches on codec alone" / authority derived
canonicalRefused: true   ("Veyra refuses to auto-promote memory to canonical authority")
centralCount:    0
roomFiles:       ["binding.json","memory.db","memory.db-shm","memory.db-wal"]
centralFiles:    ["memory.db","memory.db-shm","memory.db-wal"]
legacyDirs:      []
health:          {"phase":"ready","mode":"registry","registryState":"available","bindingsWritten":1,"lastError":null}
```

That is the whole architecture in one run: a record written into a workspace room, recalled from it, canonical refused without explicit promotion, nothing leaked into Central, and no legacy directory created.

**4.5 Host activation** — `dsh plugin --profile web add @lovedolove/veyra@0.2.0` into a throwaway `DSH_HOME`, then a real `dsh web` boot:

```
[veyra] Network Graph WebUI at /veyra
[veyra] plugin loaded (home=/tmp/dshm-pub/veyra)
[veyra] registered /veyra
[veyra] registered skill: veyra, codebase-memory, legacy-onboarding, memory-review, memory-maintenance
[veyra] registered tools: veyra_remember, veyra_recall, veyra_inspect, veyra_forget, veyra_promote,
        veyra_feedback, veyra_recurrence, veyra_health, cbm_projects, cbm_search, cbm_snippet, cbm_trace,
        cbm_arch, cbm_search_code, veyra_code_status, veyra_change_impact, veyra_stale_ledger
```

`grep -c "did not activate"` → **0**. The `web boot: 1 entry did not activate` defect from the v0.1.75 era does not reproduce.

---

## 5. Note on the publish mechanism

The workflow runs `npm stage publish`, which **stages** the package and defers the proof-of-presence to a human approval. Immediately after the workflow finished, `GET .../veyra/0.2.0` returned `"version not found: 0.2.0"` (HTTP 404) and `dist-tags` still said `0.1.75`; roughly four minutes later the version was live.

This is the established behaviour of this repository, not a regression: run `42613928255` for v0.1.75 ended the same way (`has been staged with tag latest`, staged id `b39622e9-…`) and its package also went live minutes later at `2026-11-09T12:07:31.194Z`. The `approver` field in `_npmUser` is the record of that human step.

Worth fixing independently: the approval step is not documented anywhere in the repo (`grep -rn "stage approve\|stage list\|2FA\|proof-of-presence"` → no matches), so the release process cannot be reproduced from the repository alone. That is a documentation gap for the next round, not a defect in this release.

---

## 6. Changed files and Git state

- Commit `dd22b63` on `main`; parent `af40b3c`.
- 106 files changed: 49 added, 57 modified.
- Added source: `src/rooms.mjs`, `src/workspace-resolver.mjs`, `src/memory-router.mjs`, `src/memory-server.mjs`, `src/promotion.mjs`; mutation harnesses `scripts/m188-mutations.mjs`, `scripts/m191-mutations.mjs`; `test/helpers/room.mjs`; 18 new test files; 23 files under `docs/research/`.
- Working tree clean at release; `docs/research/` was committed because the shipping `CHANGELOG.md:43` cites `docs/research/m00190-repeated-investigation-benefit.md`, and an untracked file would leave that citation dangling on GitHub.

---

## 7. Known limits

These are stated plainly, and none is claimed as a gain:

- **No measured efficiency improvement is claimed.** The m00190 study found n=10 pairs with 20/20 arms correct; repeat-reads 6.30 vs 6.80, p=0.7266, and memory about 1.9× tokens. That is a tie, and the release does not present it as a win.
- **Pre-0.2.0 memory is not migrated.** By design. The old directories are left untouched and unread.
- **Ten CI tests skip** in an environment without a DSH install. They are DSH-integration tests and they run and pass locally.
- **The staged-publish approval step is undocumented** (section 5).
- **`docs/research/` carries absolute local paths** in historical prose, the same class as the pre-existing `CHANGELOG.md:84` entry. The account name is already public through the repository URL.

---

## 8. CTO acceptance recommendation

**Recommend acceptance.** The released artifact is byte-identical to the tested tree, its provenance binds to commit `dd22b63`, it installs cleanly into a fresh consumer project and into a fresh DSH home, and its behaviour matches the architecture the release claims: memory partitioned by workspace room, Central reachable only through governed promotion, canonical memory refused without explicit approval, no legacy directory created, and a clean boot with all 17 tools and 5 skills registered.

The one process gap — an undocumented human approval step between staging and publication — should be closed in the next round so the release path is reproducible from the repository alone.
