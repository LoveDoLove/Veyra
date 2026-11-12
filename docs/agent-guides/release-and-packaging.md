# Release and Packaging

## Package manifest

`@lovedolove/veyra`, ESM, `main` and exports point at `src/plugin.mjs`;
`./client` points at `client.js`. `engines.node` is `>=22.12.0 <25.0.0`. The
floor is set by the bridge: `node:sqlite` needs 22.5+, but unflagged
`require(esm)` — which `src/cbm-bridge.mjs` relies on to load CBM synchronously
— only starts at 22.12.0. Below that the bridge would silently stub out while
`engines` claimed support.

Published file set (`files`): `src`, `skills`, `client.js`,
`cordis.patch.yml`, `LICENSE`, `README.md`, `CHANGELOG.md`, `THIRD_PARTY.md`.
Anything a user needs at runtime must be in that list; anything you add there is
part of the public contract.

## Dependency rules

- Veyra has no required runtime dependency. `@lovedolove/dsh-codebase-memory-mcp`
  is an optional peer that `src/cbm-bridge.mjs` resolves at runtime; when it is
  absent Veyra loads and its memory features run normally. Demoting it does not
  uninstall it: pnpm installs optional peers by default, and a profile that
  declares CBM keeps it.
- Host packages (`@deepseek-ai/cordis`, `@deepseek-ai/dsh-tools`) are optional
  peer dependencies, never regular dependencies.
- No `bundledDependencies`. Profiles install with pnpm; bundled packages are not
  fetched from the registry and git tarballs cannot carry `node_modules`.
- Every statically visible bare import in a shipped file must be builtin,
  host-provided, or declared. `scripts/runtime-deps-check.mjs` enforces this and
  fails closed. The bridge's specifier is not statically visible — the bridge
  loads it via `createRequire(…)` with the specifier in a constant — so that one
  runtime-resolved specifier is asserted by its own test in
  `test/runtime-deps-check.test.mjs`.

## Scripts

```sh
npm test               # node --test test/*.test.mjs
npm run pack:check     # npm pack --dry-run
node scripts/runtime-deps-check.mjs
```

## CI (`.github/workflows/ci.yml`)

Runs on every push to `main` and every pull request, on Node 22 and 24:

1. `npm install`
2. `node scripts/runtime-deps-check.mjs` (must pass before release)
3. `npm test`
4. `npm pack --dry-run`

A change that fails any of these is not mergeable.

## Publishing (`.github/workflows/publish-npm.yml`)

Triggers on a `v*.*.*` tag push or manual dispatch with a version input. Steps:

1. Checkout with full history; Node 24; upgrade npm to a version supporting
   `npm stage publish`.
2. `npm install`, `npm test`, runtime-deps check.
3. Validate the version: strict `X.Y.Z` (no prerelease or build metadata), must
   equal `package.json`, and must not already exist on the registry (HTTP 404
   proceeds; 200 blocks; anything else fails closed).
4. `npm stage publish --provenance --access public`.
5. Create a GitHub Release tagged `vX.Y.Z` with generated notes.

Do not push tags, dispatch the workflow, or run a publish from a working copy
unless the user explicitly asks for a release.

Step 4 **stages**; it does not publish. The package is invisible to the registry
until a maintainer with publish rights approves it — `GET /@lovedolove/veyra/<version>`
returns HTTP 404 and `dist-tags.latest` still names the previous version, while
the GitHub Release from step 5 already exists. That window is normal and is not
evidence of a failed release.

The approval is a manual, authenticated 2FA action (`npm stage list` →
`npm stage view <stage-id>` → `npm stage approve <stage-id>`), evidenced registry-side
by `_npmUser.approver`. Never script it with a 2FA-bypass token, never re-push a tag
to "retry" a staged or live version, and use `npm stage reject <stage-id>` before
re-staging a version that was staged with the wrong contents. Full mechanics,
verification commands, and failure handling:
[`docs/research/m00193-npm-staged-publishing-documentation.md`](../research/m00193-npm-staged-publishing-documentation.md).

## Versioning

- The project is on a pre-1.0 `0.3.x` line; APIs and the command surface may
  still change between minor versions.
- `CHANGELOG.md` has one section per released version, newest first, with
  `### Fixed` / `### Added` style headings. A behavior change that ships needs an
  entry.
- The version appears in `package.json`, the changelog heading, and the git tag.
  They must agree — the publish workflow refuses to proceed otherwise.
- The DSH compatibility block in `package.json` (`dshReleases`, `dshVersions`,
  `nodeVersions`) must be updated when a new DSH release is verified.
  `test/compatibility.test.mjs` checks the manifest.

## Release checklist

Before tagging:

```text
package.json version == CHANGELOG heading == intended tag
npm test green on Node 22 and 24 (CI is authoritative)
node scripts/runtime-deps-check.mjs green
npm run pack:check shows exactly the intended files
git archive HEAD | tar -x, then npm pack — record that shasum (working-copy
  packs differ by CRLF line endings and will never match the published one)
registry HTTP status for the intended version is 404 (not already taken)
README / guides updated for any behavior change
No secrets, no temp files, no unrelated diff
```

After the workflow reports the staged version:

```text
Actions run is success and the stage step printed "(staged with id <uuid>)"
Registry still 404s and dist-tags.latest still names the previous version
  — expected; this is the approval window, not a failure
npm login, then npm stage list -> npm stage view <stage-id>
npm stage approve <stage-id>            <- this is the publish (2FA prompt)
npm view @lovedolove/veyra@<version> version == <version>
npm view @lovedolove/veyra dist-tags.latest == <version>
dist.shasum == the git-archive shasum recorded above
npm audit signatures in a consumer install -> invalid: [], missing: []
attestation commit == git rev-list -n1 v<version>
gh release view v<version> -> isDraft false, tagName matches
```

Failure rules: an already-published version is immutable — release forward,
never rewrite. A wrong staged package is rejected (`npm stage reject <stage-id>`)
before any re-staging. A tag is never re-pushed to "retry" a release.

## Documentation parity

User-visible changes belong in `README.md` (and `README.zh-CN.md`), `docs/reference/`, plus the
changelog. If a behavior described in these agent guides changes, update the
guide in the same commit — a stale guide is a defect, not a backlog item.
