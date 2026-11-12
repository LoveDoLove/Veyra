# Contributing to Veyra

Thank you for taking the time. This page is a map. The rules live in
[AGENTS.md](AGENTS.md) and the guides it routes to, and this page does not
repeat them.

## Before you start

Read [AGENTS.md](AGENTS.md). It states the guardrails that every change must
respect and it routes each task to the guide that owns it. If you plan to change
code, the two guides you need are
[development workflow](docs/agent-guides/development-workflow.md) for the
landing procedure and
[testing and verification](docs/agent-guides/testing-and-verification.md) for
what counts as evidence.

## Report a bug

Open an issue with the bug template. Include the DSH version, the Node version,
and the exact output. Run `/veyra` and `/veyra health` first, because those
report the storage root and any unhealthy records, and the answer is often
there.

## Propose a change

Open an issue before a large change. Small fixes can go straight to a pull
request. A change that adds a dependency, a module, or a schema field needs a
stated reason, because [engineering principles](docs/agent-guides/engineering-principles.md)
restricts that by default.

## Set up a checkout

```sh
git clone https://github.com/LoveDoLove/Veyra.git
cd Veyra
node --version        # must satisfy >=22.12.0 <25.0.0
npm test              # establishes the baseline before you change anything
```

There is no build step and no dependencies to install. `npm install` only
materialises the optional peer packages for the test suite.

## Verify your change

```sh
npm test                            # the full suite
node scripts/runtime-deps-check.mjs # when you touch imports or dependencies
npm run pack:check                  # when you touch the published file set
```

CI runs the same three on Node 22 and 24. A pull request that changes behavior
without a test that would have caught the old behavior is incomplete. Do not
delete or weaken a failing test to make a branch green.

If your change touches host wiring, verify it in an isolated DSH home. Never
point a test or a manual check at a live profile, and never restart DSH Web.
[Development workflow](docs/agent-guides/development-workflow.md) covers this in
detail.

## Style

Match the surrounding code. ESM only, `node:` builtins, no semicolons, single
quotes, two space indent, and a file header comment that explains why the module
exists. Do not reformat a file you are not otherwise changing.

## Commits

One logical change per commit, with a `type(scope): summary` message. The types
are `feat`, `fix`, `docs`, `chore`, and `ci`. Do not bump the version in a
feature commit, because version bumps belong to the release flow.

## Pull requests

Describe what changed and why, then state what you ran to verify it. Include the
test counts from `npm test`. If you changed a documented behavior, update the
document in the same pull request, because
[development workflow](docs/agent-guides/development-workflow.md) requires
documentation parity.

## Documentation

Each document owns one topic and does not restate the others. Start at
[docs/README.md](docs/README.md) to find the owner of a topic before you add a
new file. The Chinese versions of the README and the whitepaper live beside
their English originals.

## Security

Do not open a public issue for a security problem. See [SECURITY.md](SECURITY.md).

## License

Contributions are accepted under the MIT license that covers this project. See
[LICENSE](LICENSE).
