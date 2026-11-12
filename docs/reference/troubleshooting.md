# Troubleshooting

Each entry states the symptom, the cause, and the fix. If a symptom is not here,
`/veyra` is the first thing to run: it prints the resolved room, the workspace
path, and record counts.

---

## Nothing appears at boot

**Symptom.** No `[veyra]` lines in the DSH log.

**Cause.** The plugin was installed into a different profile than the one that
booted. `dsh plugin --profile web add …` installs into `web`; booting `dsh tui`
will not load it.

**Fix.** Install into the profile you actually run, then check
Settings → Plugins.

---

## Node is too old

**Symptom.** Load fails, or the plugin reports an unsupported runtime.

**Cause.** Veyra requires Node `>=22.12.0 <25.0.0`. It uses `node:sqlite`, which
first shipped in 22.5, and `src/cbm-bridge.mjs` loads the Codebase Memory
package with an unflagged `require(esm)`, which starts at 22.12.0.

**Fix.** Upgrade Node, then reinstall the plugin.

---

## "Plugin is incompatible with dsh"

**Symptom.** DSH refuses the plugin or prints a compatibility warning.

**Cause.** The declared range is `>=0.1.2-rc.1 <0.3.0-0`.

**Fix.** Update DSH, or accept the risk with the exact-version exemption DSH
prints.

---

## Automatic recall context is empty

**Symptom.** No recalled-memory block in the agent's context.

**Causes, in order of likelihood.**

1. `recallLimit` is `0`.
2. The records you expect are still `candidate`. Candidates are never
   auto-recalled.
3. You are in a different workspace. Run `/veyra` and compare the room id.
4. No stored record is relevant to the current query. Absence of memory is not
   evidence of anything.

---

## A memory I recorded does not come back

**Symptom.** `veyra_remember` returned a record, but recall never surfaces it.

**Cause.** Most often the write gate accepted it as a `candidate` rather than a
`derived` record, or the record has no grounding and was dropped.

**Fix.** `/veyra inspect <id>` shows the authority and validation. If it is a
candidate, `/veyra promote <id> derived` makes it recall-eligible. Canonical
still requires your explicit instruction.

---

## Code Intelligence reports degraded

**Symptom.** `veyra_code_status` returns an error, or the six `cbm_*` tools are
missing.

**Causes.** Two independent pieces can be missing. The plugin registers the
tools; the native binary answers them.

**Fix.** Install the plugin for the tools and the binary for answers. See
[code intelligence](./code-intelligence.md#installing-it). All memory features
keep working either way.

---

## Stale memories after a refactor

**Symptom.** `/veyra code status` marks records stale, or recall shows a stale
penalty.

**Cause.** Files referenced by those records changed.

**Fix.** Verify the claim against the current code with `/veyra inspect <id>`.
Then re-record it with `veyra_remember`, or `/veyra forget <id>` if it no longer
applies. Staleness is a prompt to check, not a verdict.

---

## The Network Graph page is empty

**Cause.** Either the workspace has no records, or the page resolved a
different workspace.

**Fix.** `/veyra recent` shows what is stored, and `/veyra` prints the workspace
path the graph should be using.

---

## The sidebar tab says "Workspace context unavailable"

**Cause.** The tab maps its own session through the DSH workspaces API, and no
workspace row claims that session. It refuses to guess.

**Fix.** Confirm the session is open inside a workspace. `/veyra` prints the
resolved room id and workspace path. Reload once the workspace list is ready.

---

## Something wrote wrong memory

**Fix.** `/veyra forget <id>` soft-forgets it. The record leaves recall and
stays inspectable, which keeps the mistake auditable. Nothing becomes
`canonical` without `/veyra promote <id> canonical` run by you.

---

## Where is my data, and how do I reset

**Location.** `$DSH_HOME/veyra/`, defaulting to `~/.dsh/veyra/`, or
`$VEYRA_HOME` if set. See [configuration](./configuration.md#storage-layout).

**Reset one workspace.** Delete `rooms/<roomId>/`. Nothing is stored in your
repository.

**Reset everything.** Delete `$DSH_HOME/veyra/`. The pre-rooms `projects/` and
`reusable/` directories are never read and can be removed independently.

---

## The release is not on npm yet

**Symptom.** `npm view @lovedolove/veyra` returns 404 for a version that was
tagged.

**Cause.** Publishing is staged. The workflow uploads the tarball with
provenance and waits for a maintainer's 2FA approval. A staged version is not
visible until it is approved.

**Fix.** A maintainer runs `npm stage approve <stage-id>`. The details are in
[release and packaging](../agent-guides/release-and-packaging.md).
