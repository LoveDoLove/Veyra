# Engineering Principles

Rules for deciding *what* to build and *how far* a change may reach.

## Smallest correct change

Change the least code that fully solves the problem. "Fully" is the constraint:
a patch that fixes the symptom but leaves the invariant violated is not small,
it is incomplete. Prefer extending an existing function over adding a parallel
one; the maintenance cadence, write gate, and retrieval pipeline each exist once
on purpose so behavior cannot drift.

## Preserve module ownership

Each module owns one stage. Do not let a surface (tool, command, WebUI) grow its
own copy of domain logic — call the owning module. Concretely:

- Persistence goes through `MemoryStore`; nothing else opens SQLite.
- Authority transitions go through `learn.mjs` / `lifecycle.mjs`; nothing else
  assigns `canonical`.
- Eligibility is decided by `types.mjs` gates, not re-derived per call site.
- Read-only surfaces (`observatory.mjs`, `health.mjs`, `audit.mjs`,
  `consolidate.mjs`) never mutate records.

## Derived, never duplicated

The graph, Observatory, and WebUI payloads are projections computed from the
store. Never persist a projection as a second source of truth, and never let a
cache become authoritative.

## When a new module is justified

Only when the current owner would otherwise mix two unrelated responsibilities,
and the new file has a single clear purpose documented in its header. Do not
create a module for a handful of lines that belong where they are.

## When a new dependency is justified

Almost never. The current required runtime dependency set is empty; the bridge
(`@lovedolove/dsh-codebase-memory-mcp`) is a declared optional peer rather than a
required dependency. The set stays deliberately minimal because `dsh plugin add`
installs with pnpm and undeclared or bundled runtime deps have already caused
`ERR_MODULE_NOT_FOUND` at plugin load. A new dependency requires:

1. Evidence that the current code cannot reasonably do the job.
2. A declared entry in `dependencies` or `peerDependencies` (never
   `bundledDependencies`).
3. Passing `node scripts/runtime-deps-check.mjs`.
4. Review of the install path, since profiles install from the registry.

Do not add a dependency for something the standard library or an existing module
already does.

## When a schema field is justified

Only when an existing dimension cannot express the needed state and the field is
required for a stated invariant. Schema changes carry a version obligation
(`SCHEMA_VERSION`) and a migration path (`src/migrate.mjs`); a mismatched
version must refuse to open, not guess.

## Orthogonality

Keep kind, authority, validation, status, scope, and confidence independent.
Collapsing them (for example "verified means canonical") destroys the ability to
reason about trust and is a design regression.

## Determinism and locality

- No network calls in the memory path.
- No repository writes, ever.
- No timers, schedulers, workers, or daemons unless the requirement explicitly
  demands them; maintenance runs off the existing turn lifecycle.
- Behavior must be reproducible in tests with isolated temp homes.

## Failure containment

Anything on the agent's turn path (observe, recall, learn, maintenance) is
best-effort: wrap it so a failure degrades that one feature instead of breaking
the turn. Anything on the persistence path (writes, authority, schema) fails
closed: refuse rather than write a degraded record.

## Comments document *why*

File headers explain purpose and the reason for a non-obvious decision, often
citing the source the code was adapted from. Match that style. Do not add
comments that restate the code.

## Do not drift the public surface casually

Tool names, command syntax, setting keys, and environment variables are consumed
by users and other agents. Changing them is a product change, not a refactor, and
needs a changelog entry and documentation update.
