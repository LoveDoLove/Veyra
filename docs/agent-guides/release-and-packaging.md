# Release and Packaging

## Package manifest

`@lovedolove/veyra`, ESM, `main` and exports point at `src/plugin.mjs`;
`./client` points at `client.js`. `engines.node` is `>=22.5.0 <25.0.0`
(`node:sqlite` requires 22.5+).

Published file set (`files`): `src`, `skills`, `client.js`,
`cordis.patch.yml`, `LICENSE`, `README.md`, `CHANGELOG.md`, `THIRD_PARTY.md`.
Anything a user needs at runtime must be in that list; anything you add there is
part of the public contract.

## Dependency rules

- Exactly one runtime dependency today: `@lovedolove/dsh-codebase-memory-mcp`.
- Host packages (`@deepseek-ai/cordis`, `@deepseek-ai/dsh-tools`) are optional
  peer dependencies, never regular dependencies.
- No `bundledDependencies`. Profiles install with pnpm; bundled packages are not
  fetched from the registry and git tarballs cannot carry `node_modules`.
- Every bare import in a shipped file must be builtin, host-provided, or
  declared. `scripts/runtime-deps-check.mjs` enforces this and fails closed.

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

## Versioning

- The project is on a pre-1.0 `0.1.x` line; APIs and the command surface may
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

```text
package.json version == CHANGELOG heading == intended tag
npm test green on Node 22 and 24 (CI is authoritative)
node scripts/runtime-deps-check.mjs green
npm run pack:check shows exactly the intended files
README / guides updated for any behavior change
No secrets, no temp files, no unrelated diff
```

## Documentation parity

User-visible changes belong in `README.md` (and `README.zh-TW.md`) plus the
changelog. If a behavior described in these agent guides changes, update the
guide in the same commit — a stale guide is a defect, not a backlog item.
