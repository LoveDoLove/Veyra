# Development Workflow

How to land a change in this repository.

## 1. Establish the baseline

Before editing:

```sh
git status              # must be clean or knowingly dirty
git log --oneline -5    # current version and recent intent
node --version          # must satisfy >=22.12.0 <25.0.0
```

Run the suite once so you know the starting state:

```sh
npm test
```

## 2. Read before writing

1. `AGENTS.md` — guardrails and routing.
2. The guide for your topic (see [the index](./README.md)).
3. The file headers of every module you will touch. They state purpose and the
   reason for non-obvious decisions.
4. The tests that already cover the area — they encode the intended behavior.

## 3. Plan the smallest correct change

Write down, before editing:

- The behavior that is wrong or missing, and its evidence in the source.
- The owning module (see [codebase map](./codebase-map.md)).
- The invariant your change must not weaken (see
  [safety and invariants](./safety-and-invariants.md)).
- The test that will fail before the change and pass after it.

If the plan needs a new module, dependency, schema field, or host service, stop
and justify it against [engineering principles](./engineering-principles.md)
first.

## 4. Implement

- Match the existing style: ESM, `node:` builtins, no semicolons, single quotes,
  two-space indent, file-header block comments explaining *why*.
- Reuse the owning module's functions instead of re-deriving logic at the call
  site.
- Keep the change scoped. Do not reformat, rename, or reorder unrelated code.
- Wrap turn-path work in the existing best-effort style; let persistence
  failures surface as refusals.

## 5. Verify

Minimum for any code change:

```sh
npm test                        # full suite
node scripts/runtime-deps-check.mjs   # if you touched imports or dependencies
npm run pack:check              # if you touched the published file set
```

For behavior that cannot be proven by unit tests (host wiring, HTTP surface,
plugin boot), verify against a real runtime in an isolated home, never the live
one. See [testing and verification](./testing-and-verification.md).

## 6. Review your own diff

```sh
git diff
git diff --stat
```

Check every file is intentional. Confirm no unrelated formatting, no deleted
tests, no weakened assertions, no accidental secrets, and no change to files the
task did not ask for.

## 7. Documentation parity

If you changed a behavior described in `README.md`, `GOAL.md`, a bundled skill's
`SKILL.md`, or one of these guides, update that description in the same change.
Frontmatter in `skills/*/SKILL.md` is the source of truth; `src/skills.mjs` must
match it.

## 8. Commit

- One logical change per commit.
- Follow the existing message convention: `type(scope): summary`, for example
  `fix(diff): gate replacement-language conflicts on lexical floor`.
- Common types in this history: `feat`, `fix`, `docs`, `chore`, `ci`.
- Do not push, tag, or release unless the user explicitly asks.
- Version bumps and changelog entries belong to the release flow, not to a
  feature commit, unless the task is a release.

## Anti-patterns

- Editing DSH core or a DSH profile to work around a Veyra problem.
- Adding a test that asserts current behavior without asserting the requirement.
- Deleting or skipping a failing test instead of understanding it.
- Declaring success from a green run of only the tests you wrote.
- Making a "drive-by" improvement in an unrelated file.
