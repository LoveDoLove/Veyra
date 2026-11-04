# Safety and Invariants

The rules a change must not break. If a change requires violating one of these,
the change is wrong — stop and reconsider the design.

## 1. Repository truth wins

Memory is recalled context, never authority over code. Every injected record is
labelled `not repository truth` (`GUIDANCE_TEXT` in `src/context.mjs`). Never
present a memory as a fact about current code, and never let memory silently
override what the agent observes in the repository.

The character budget cannot weaken that labelling. `joinWithBudget`
(`src/context.mjs`) allocates per RECORD BLOCK, and a block has two tiers.
Attribution — header, trust line, evidence, banners — is emitted whole or not at
all and is never trimmed. Detail — the body line and the causal facets — is
expendable and is dropped first; it is recoverable through `veyra_recall`. A cut
must never leave a header whose trust line fell past it, and a record whose
attribution alone does not fit is dropped whole rather than half-rendered.
The allocator is also greedy-but-skipping: a record too large for the remaining
room is dropped and shorter records behind it may still be emitted. Skipping is
preference-preserving (output stays in rank order, a skipped block never
displaces a higher-ranked kept one) and prevents one verbose record from
silently emptying recall. The trimmed pass only decides WHICH records survive;
leftover room then restores detail in rank order, so detail never competes with a
record's place and a comfortable recall is not rendered as attribution-only
stubs.

## 2. Candidates are not truth

- Auto-captured observations are stored with `authority = candidate`.
- `isLifecycleEligible` rejects `candidate`; `isRecallEligible` additionally
  rejects `observation`.
- Therefore candidates never appear in ambient recall. They are inspectable via
  `/veyra recent` and can be reviewed later.

Do not add a path that lets a candidate reach agent context.

Refusing to learn is also observable, and stays inert. `writeGate` records its
verdict (decision + reason only) into the store's existing `meta` key/value
table via `recordWriteGateVerdict`, and `/veyra health` renders that tally.
Three properties make this safe and must be preserved:

- It stores no record content — never a title, body, evidence row or source —
  so it is not a second memory store and not a new unredacted write path.
- It is not a memory row: `list()` and `count()` never see it, so it cannot be
  recalled, promoted, or mistaken for knowledge.
- It is best-effort accounting, never authority: recording a DROP or DEFER
  changes nothing about what was learned, and a failing `meta` write is
  swallowed so learning proceeds exactly as before.

A DROP/DEFER tally entry is not a finding and must never be counted as one —
`memoryHealth` reports it separately from `findings`/`totalFindings`.

## 3. Canonical requires explicit human action

`assertAuthorityTransition` throws unless `explicit` is set when moving to
`canonical`. `promote` defaults to `derived`. No learning, maintenance,
consolidation, or feedback path may assign `canonical`.

Corollary: feedback raises *validation* (unverified → reviewed → verified) and
never *authority*. Keep those ladders separate.

## 4. Fail closed

- A structurally corrupt row is never returned as authoritative;
  `isLifecycleEligible` rejects it, and `MemoryStore.put` refuses to overwrite it
  unless `repair: true` is explicitly passed.
- Unknown enum values are rejected by allow-list, not tolerated by deny-list.
- A schema version mismatch refuses to open the store.
- An unavailable service (settings, webServer, tools, skills, commands) degrades
  that feature and leaves the rest working.

## 5. Project isolation

- Project id is derived from resolved workspace + git remote, so checkouts of the
  same remote share memory and unrelated folders never collide.
- Project and reusable stores are separate databases. Cross-project exposure only
  happens through the reusable store, and only when `includeReusable` is on.
- Storage lives under `$DSH_HOME/veyra/` (or `$VEYRA_HOME`), **never** inside the
  user's repository.
- HTTP and command surfaces resolve the workspace from the request/runtime; a
  payload must never mix stores from different projects.

## 6. Redaction before persistence

`src/redact.mjs` scrubs bearer tokens, key assignments, prefixed API keys, PEM
private keys, and secret-looking env assignments. Every write path runs through
it before bytes reach disk. Never add a write path that skips scrubbing, and
never log unredacted content.

A second tier catches identifiers that shape alone cannot identify — payment
cards (Luhn), IBANs (ISO 13616 mod-97), and US SSNs (structural rules). Each
match is validated individually; a value that fails its checksum is left
byte-identical. Placeholders are fixed (`[REDACTED_CARD]`, `[REDACTED_IBAN]`,
`[REDACTED_SSN]`) and never echo any part of the value.

Precision is part of this invariant, not a nicety: redaction that mangles
ordinary engineering text destroys the memory it protects. A bare run of 13-19
digits is therefore only a card when it carries card grouping **and** a
plausible IIN (2-6), or when payment wording sits beside it. Do not widen these
rules without re-measuring false positives against the repository first.

## 7. Never break the agent loop

Observation, automatic recall, learning, and maintenance are best-effort and
wrapped. A failure in any of them degrades a feature; it must not throw into the
host turn. Conversely, do not swallow errors on the persistence path — those must
surface as refusals.

## 8. Similarity is not identity

Overlapping memories are linked (`updates`, `extends`, `derives`, `contradicts`,
`supersedes`), not silently merged. Verbatim duplicates are deduped by content
hash with evidence merged; paraphrase is a new linked record. Do not "improve"
this into aggressive merging.

## 9. Contradictions are directional and auditable

A `contradicts` edge must be produced by real evidence — a lexical floor plus a
shared-subject anchor (`src/diff.mjs`). Removing an edge is an explicit,
transactional operation (`/veyra unlink`), and auditing edges is read-only
(`/veyra audit contradictions`). Do not add automatic edge deletion.

## 10. Read-only means read-only

`observatory.mjs`, `health.mjs`, `audit.mjs`, and `consolidate.mjs` must never
mutate records or authority. Health findings are information, not authorization
to act.

## 11. No repository writes, no network, no background daemons

The memory path writes only to the Veyra home and makes no network calls. The
only external process is the optional Code Intelligence daemon, owned by the
bridge package.

## 12. DSH Web is untouchable

Never kill, stop, restart, or duplicate the running DSH Web, and never change its
port. Tests must not bind that port or touch a live DSH home. If a restart is
required, stop and tell the user.
