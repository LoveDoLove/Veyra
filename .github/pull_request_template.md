<!--
Thank you for the pull request. Keep it to one logical change. The rules live
in CONTRIBUTING.md and AGENTS.md; this template asks only what a reviewer
cannot infer from the diff.
-->

## What changed

<!-- One paragraph. What behavior is different now than before? -->

## Why

<!-- The problem this solves. Link the issue if there is one: "Fixes #123". -->

## How it was verified

<!--
Paste the real output, not a claim. The minimum is `npm test`. Add
`node scripts/runtime-deps-check.mjs` if you touched imports or dependencies,
and `npm run pack:check` if you touched the published file set.

    ℹ tests 1173
    ℹ pass 1173
    ℹ fail 0
-->

```text

```

## Checklist

- [ ] A test would have caught the old behavior, or the change has no behavior to test
- [ ] No test was deleted or weakened
- [ ] Documentation updated in this PR if a documented behavior changed
- [ ] No unrelated files, reformatting, or drive-by cleanup
- [ ] One logical change, with a `type(scope): summary` commit message

## Notes for the reviewer

<!-- Anything non-obvious: a tradeoff, a rejected alternative, a follow-up you deliberately left out. -->
