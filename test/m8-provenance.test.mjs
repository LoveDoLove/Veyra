/**
 * M8 — Capture Provenance Architecture.
 *
 * `distillBuffer` persists `source.provenance = { origins }`, a canonical
 * sorted subset of ["user", "assistant", "tool"] describing which capture
 * streams materially contributed text/content to the persisted record:
 *
 *   user      ⇐ trimmed buffer.user join is non-empty
 *   assistant ⇐ trimmed buffer.assistant join is non-empty
 *   tool      ⇐ (activity-only: both streams empty)
 *               OR (persisted causal facets whose symptom came from a
 *                   tool `:result` preview — internal toolSymptom flag)
 *
 * Never inferred from: signal, tags, title, files, tool names in metadata,
 * lexical content, similarity, or session/turn context. Canonical order is
 * fixed (user, assistant, tool); there is no "mixed" value. Deliberate
 * `veyra_remember` records carry no provenance. Legacy records read as
 * unknown (`provenanceOrigins(...) === null`), never backfilled.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  AUTHORITIES,
  PROVENANCE_ORIGINS,
  STATUSES,
  VALIDATIONS,
  provenanceOrigins,
} from '../src/types.mjs'
import { openEphemeralStore, closeAllStores } from '../src/store.mjs'
import { distillBuffer, extractCausalFacets } from '../src/understand.mjs'
import { newBuffer, observeEvent, candidateFromBuffer } from '../src/observe.mjs'
import { maybeLearn, strengthenMemory } from '../src/learn.mjs'
import { sweepStale, evolveAgainst } from '../src/evolve.mjs'
import { buildToolDefinitions } from '../src/tools.mjs'

// ---------------------------------------------------------------- fixtures

// Has a text-level symptom ("sqlite writer race") + claim hint ("race"), no
// root-cause/fix phrasing required — used where NO tool origin is expected.
const USER_TEXT = 'The sqlite writer race is fixed by wrapping DatabaseSync writes in a mutex around the critical section.'

// Deliberately symptom-free text: rootCause + remedy only, so any persisted
// symptom must have come from the tool preview fallback (toolSymptom=true).
const USER_CAUSAL = 'The root cause is concurrent DatabaseSync writes corrupting FTS triggers. The fix is to serialize every write through a mutex.'

// Symptom-free assistant claim (claim hints: "root cause", "remedy").
const ASSISTANT_CLAIM = 'The root cause is concurrent migration writes racing the lock table. The remedy is to wrap lock acquisition with a timeout so nothing hangs forever.'

const FAIL_TOOLS = [{ name: 'bash:result', preview: 'FAIL test/store.test.mjs: database is locked\n[exit code: 1]' }]
const PASS_TOOLS = [{ name: 'bash:result', preview: '✔ 58 tests pass\n[exit code: 0]' }]
const EDIT_TOOL = { name: 'edit', args: { file_path: 'src/store.mjs' } }

const makeBuffer = ({ user = [], assistant = [], tools = [], files = [], turn = 1 } = {}) => ({
  turn, user, assistant, tools, files: new Set(files),
})
const ctx = { projectId: 'p_m8', sessionId: 's_m8' }
const daysAgo = (d) => new Date(Date.now() - d * 86400000).toISOString()

// ------------------------------------------------- 1. user-only capture

test('M8: user-only capture persists origins ["user"]', () => {
  const record = distillBuffer(makeBuffer({ user: [USER_TEXT] }), ctx)
  assert.ok(record, 'record is distilled')
  assert.deepEqual(record.source.provenance.origins, ['user'])
})

// --------------------------------------------- 2. assistant-only capture

test('M8: assistant-only capture persists origins ["assistant"]', () => {
  const record = distillBuffer(makeBuffer({ assistant: [ASSISTANT_CLAIM], tools: PASS_TOOLS }), ctx)
  assert.ok(record, 'record is distilled')
  // PASS preview has no FAIL line → no tool symptom → no "tool" origin.
  assert.deepEqual(record.source.provenance.origins, ['assistant'])
})

// ---------------------------------------------- 3. user + assistant both

test('M8: user + assistant capture persists origins ["user", "assistant"]', () => {
  const record = distillBuffer(makeBuffer({ user: [USER_TEXT], assistant: [ASSISTANT_CLAIM], tools: PASS_TOOLS }), ctx)
  assert.ok(record, 'record is distilled')
  assert.deepEqual(record.source.provenance.origins, ['user', 'assistant'])
})

// ---------------------------------- 4. internal toolSymptom flag (unit)

test('M8: tool symptom flag — preview FAIL sets toolSymptom, text symptom does not', () => {
  // (a) causal explanation in user text, symptom only in tool preview.
  const fromPreview = extractCausalFacets({
    user: USER_CAUSAL, assistant: '', tools: FAIL_TOOLS, files: new Set(), symbols: [],
  })
  assert.ok(fromPreview.facets, 'facets persisted')
  assert.ok(fromPreview.facets.symptom.includes('database is locked'), 'symptom sourced from preview')
  assert.equal(fromPreview.toolSymptom, true)

  // (b) symptom present in TEXT (claim must be explained — root cause + fix).
  const fromText = extractCausalFacets({
    user: USER_TEXT, assistant: '', tools: FAIL_TOOLS, files: new Set(), symbols: [],
  })
  assert.ok(fromText.facets, 'facets persisted')
  assert.equal(fromText.toolSymptom, false, 'preview fallback never runs once text has the symptom')

  // (c) preview symptom exists but no core explanation → facets rejected;
  // the internal flag is still carried (never persisted — see test 6/18).
  const rejected = extractCausalFacets({
    user: 'Ran the whole suite twice and then ran it once more to be sure.',
    assistant: '', tools: FAIL_TOOLS, files: new Set(), symbols: [],
  })
  assert.equal(rejected.facets, null)
  assert.equal(rejected.toolSymptom, true, 'internal flag carried even when facets are rejected')
  // The flag lives ONLY on the internal return object — never inside facets,
  // which are what distillBuffer persists as source.causal.
  assert.ok(!('toolSymptom' in fromPreview.facets), 'facets object never carries the internal flag')
  assert.deepEqual(
    Object.keys(fromPreview.facets).sort(),
    ['remedy', 'rootCause', 'symptom', 'verifiedOutcome'],
    'persisted causal vocabulary unchanged',
  )
})

// ---------------------------------------------------- 5. activity-only

test('M8: activity-only turn persists origins ["tool"] with gates unchanged', () => {
  const buffer = newBuffer()
  observeEvent(buffer, {}, { type: 'turn/start', data: { turn: 1 } })
  observeEvent(buffer, {}, { type: 'tool/call', data: { callId: 'a1', name: 'edit', arguments: JSON.stringify({ file_path: 'src/store.mjs' }) } })
  observeEvent(buffer, {}, { type: 'tool/call', data: { callId: 'a2', name: 'bash', arguments: JSON.stringify({ command: 'npm test' }) } })
  observeEvent(buffer, {}, { type: 'tool/result', data: { callId: 'a2', name: 'bash', output: '✔ 2 tests pass\n[exit code: 0]' } })
  // user and assistant streams are both empty → tool-only content.
  assert.equal(buffer.user.length, 0)
  assert.equal(buffer.assistant.length, 0)
  const record = candidateFromBuffer(buffer, ctx)
  assert.ok(record, 'eligibility gates unchanged — activity-only record is still captured')
  assert.equal(record.authority, AUTHORITIES.CANDIDATE)
  assert.deepEqual(record.source.provenance.origins, ['tool'])
})

// --------------------------------------------------------- 6. user + tool

test('M8: user + preview-sourced symptom persists origins ["user", "tool"]', () => {
  const record = distillBuffer(makeBuffer({ user: [USER_CAUSAL], tools: FAIL_TOOLS }), ctx)
  assert.ok(record, 'record is distilled')
  assert.deepEqual(record.source.provenance.origins, ['user', 'tool'])
  assert.ok(record.source.causal?.symptom, 'symptom persisted (facets non-null is the tool-origin precondition)')
  assert.ok(!('toolSymptom' in (record.source.causal || {})), 'internal flag never persisted')
  assert.ok(record.body.includes('Symptom:'), 'preview-derived symptom entered the body')
})

// -------------------------------------------------- 7. assistant + tool

test('M8: assistant + preview-sourced symptom persists origins ["assistant", "tool"]', () => {
  const record = distillBuffer(makeBuffer({ assistant: [ASSISTANT_CLAIM], tools: FAIL_TOOLS }), ctx)
  assert.ok(record, 'record is distilled')
  assert.deepEqual(record.source.provenance.origins, ['assistant', 'tool'])
})

// ------------------------------------------------- 8. all three streams

test('M8: all three contributing streams persist origins ["user", "assistant", "tool"]', () => {
  const record = distillBuffer(makeBuffer({
    user: [USER_CAUSAL], assistant: [ASSISTANT_CLAIM], tools: [EDIT_TOOL, ...FAIL_TOOLS], files: ['src/store.mjs'],
  }), ctx)
  assert.ok(record, 'record is distilled')
  assert.deepEqual(record.source.provenance.origins, ['user', 'assistant', 'tool'])
})

// ------------------------------------------- 9. canonical ordering locks

test('M8: origins are canonically ordered, frozen vocabulary, never "mixed"', () => {
  assert.deepEqual(PROVENANCE_ORIGINS, ['user', 'assistant', 'tool'])
  assert.ok(Object.isFrozen(PROVENANCE_ORIGINS), 'vocabulary is frozen')

  const combos = [
    { buffer: { user: [USER_TEXT] }, expected: ['user'] },
    { buffer: { assistant: [ASSISTANT_CLAIM], tools: PASS_TOOLS }, expected: ['assistant'] },
    { buffer: { user: [USER_TEXT], assistant: [ASSISTANT_CLAIM], tools: PASS_TOOLS }, expected: ['user', 'assistant'] },
    { buffer: { user: [USER_CAUSAL], tools: FAIL_TOOLS }, expected: ['user', 'tool'] },
    { buffer: { assistant: [ASSISTANT_CLAIM], tools: FAIL_TOOLS }, expected: ['assistant', 'tool'] },
    { buffer: { user: [USER_CAUSAL], assistant: [ASSISTANT_CLAIM], tools: FAIL_TOOLS }, expected: ['user', 'assistant', 'tool'] },
    { buffer: { tools: [EDIT_TOOL, ...FAIL_TOOLS], files: ['src/store.mjs'] }, expected: ['tool'] },
  ]
  for (const { buffer, expected } of combos) {
    const record = distillBuffer(makeBuffer(buffer), ctx)
    assert.ok(record, `record distilled for ${expected.join('+')}`)
    const origins = record.source.provenance.origins
    // Exact canonical order = canonical vocabulary filtered to what's present.
    assert.deepEqual(origins, PROVENANCE_ORIGINS.filter((o) => expected.includes(o)))
    assert.deepEqual(origins, expected, 'never reordered')
    assert.ok(!origins.includes('mixed'), 'no "mixed" sentinel value')
    assert.ok(origins.length >= 1, 'a distilled record always has at least one origin')
  }
})

// --------------------------------------- 10. deliberate veyra_remember

test('M8: deliberate veyra_remember records carry no provenance', async () => {
  const home = mkdtempSync(join(tmpdir(), 'veyra-m8-'))
  try {
    const defs = buildToolDefinitions({ veyraHome: home, fallbackCwd: home })
    const rememberDef = defs.find((d) => d.name === 'veyra_remember')
    assert.ok(rememberDef, 'veyra_remember tool definition exists')
    const res = await rememberDef.execute(
      { title: 'Deliberate M8 note', body: 'A deliberately remembered note proving the deliberate write path never fabricates capture provenance.', scope: 'project' },
      { agent: { session: { id: 's_deliberate', header: { cwd: home } } } },
    )
    assert.ok(res?.record, `deliberate write succeeded: ${JSON.stringify(res).slice(0, 200)}`)
    assert.equal(res.record.source.automatic, false)
    assert.equal(res.record.source.tool, 'veyra_remember')
    assert.equal('provenance' in res.record.source, false, 'deliberate records get NO provenance')
    assert.equal(provenanceOrigins(res.record.source), null)
  } finally {
    closeAllStores()
    rmSync(home, { recursive: true, force: true })
  }
})

// ------------------------------------- 11. legacy records = unknown

test('M8: legacy records without provenance read as unknown — no backfill, no inference', () => {
  const store = openEphemeralStore()
  try {
    // Full legacy source shape: every metadata field that must NOT imply an origin.
    const legacy = store.put({
      title: 'Legacy capture from before M8',
      body: 'Always serialize DatabaseSync writes to avoid FTS corruption, because concurrent writers race on the shared handle under WAL.',
      evidence: [{ path: 'src/store.mjs' }],
      authority: AUTHORITIES.DERIVED,
      source: {
        sessionId: 's_legacy',
        turn: 7,
        tools: ['edit', 'bash'],
        files: ['src/store.mjs'],
        symbols: ['applyMutex'],
        signal: 'root-cause',
        tokens: 412,
        automatic: true,
        causal: { symptom: 'deadlock under WAL', rootCause: 'concurrent writers', remedy: 'serialize writes', verifiedOutcome: 'test-passed' },
      },
    }).record
    assert.equal(legacy.source.provenance, undefined, 'legacy source round-trips without a provenance key')
    assert.equal(provenanceOrigins(legacy.source), null, 'missing provenance = unknown')
    // None of the metadata above inferred an origin.
    assert.equal(legacy.source.tools.length > 0 && provenanceOrigins(legacy.source), null)
  } finally {
    store.close()
  }
})

// ----------------------------------------- 12. malformed origins = unknown

test('M8: malformed origins ([] / non-array) read as unknown and round-trip untouched', () => {
  assert.equal(provenanceOrigins(undefined), null)
  assert.equal(provenanceOrigins({}), null)
  assert.equal(provenanceOrigins({ provenance: { origins: [] } }), null, 'empty array = malformed/unknown')
  assert.equal(provenanceOrigins({ provenance: { origins: 'user' } }), null)
  assert.equal(provenanceOrigins({ provenance: {} }), null)
  assert.deepEqual(provenanceOrigins({ provenance: { origins: ['user', 'tool'] } }), ['user', 'tool'])

  const store = openEphemeralStore()
  try {
    const malformed = store.put({
      title: 'Malformed provenance record',
      body: 'Always serialize DatabaseSync writes to avoid FTS corruption, because concurrent writers race on the shared handle under WAL.',
      evidence: [{ path: 'src/store.mjs' }],
      authority: AUTHORITIES.DERIVED,
      source: { automatic: true, provenance: { origins: [] } },
    }).record
    const reread = store.get(malformed.id)
    assert.deepEqual(reread.source.provenance, { origins: [] }, 'storage is a pure passthrough — no repair, no backfill')
    assert.equal(provenanceOrigins(reread.source), null, 'reader treats it as unknown')
  } finally {
    store.close()
  }
})

// --------------------------------------------- 13. store round-trip

test('M8: provenance survives a real store.put/get JSON round-trip', () => {
  const record = distillBuffer(makeBuffer({
    user: [USER_CAUSAL], assistant: [ASSISTANT_CLAIM], tools: [EDIT_TOOL, ...FAIL_TOOLS], files: ['src/store.mjs'],
  }), ctx)
  assert.deepEqual(record.source.provenance.origins, ['user', 'assistant', 'tool'])
  const store = openEphemeralStore()
  try {
    const written = store.put(record).record
    const reread = store.get(written.id)
    assert.deepEqual(reread.source.provenance, { origins: ['user', 'assistant', 'tool'] })
    assert.deepEqual(Object.keys(reread.source.provenance), ['origins'], 'exactly one persisted field — no toolSymptom, no channel')
    assert.equal(record.source.provenance.origins.length > 0, true, 'distilled records never persist empty origins')
  } finally {
    store.close()
  }
})

// ---------------------------------------------- 14. maybeLearn preservation

test('M8: maybeLearn does not modify provenance on the derived write', () => {
  const store = openEphemeralStore()
  try {
    const candidate = distillBuffer(makeBuffer({
      assistant: [ASSISTANT_CLAIM],
      tools: PASS_TOOLS,
      files: ['src/store.mjs'],
    }), ctx)
    assert.deepEqual(candidate.source.provenance.origins, ['assistant'])
    const written = store.put(candidate)
    assert.ok(written.record)

    const learned = maybeLearn(store, { ...written.record })
    assert.ok(learned, 'candidate passes learning guards')
    assert.equal(learned.authority, AUTHORITIES.DERIVED)
    assert.deepEqual(learned.source.provenance, { origins: ['assistant'] }, 'derived write preserves provenance verbatim')
    const reread = store.get(learned.id)
    assert.deepEqual(reread.source.provenance, { origins: ['assistant'] })
  } finally {
    store.close()
  }
})

// ------------------------------------- 15. strengthenMemory preservation

test('M8: strengthenMemory keeps the neighbor provenance — never merges the candidate origins', () => {
  const neighbor = {
    id: 'n_m8',
    authority: AUTHORITIES.DERIVED,
    validation: VALIDATIONS.UNVERIFIED,
    confidence: 'medium',
    title: 'Serialize DatabaseSync writes',
    body: 'Always serialize DatabaseSync writes to avoid FTS corruption, because concurrent writers race on the shared handle under WAL.',
    tags: ['sqlite'],
    evidence: [{ path: 'src/store.mjs' }],
    source: {
      automatic: true,
      observations: 1,
      causal: { symptom: 'WAL corruption', rootCause: 'concurrent writers', remedy: 'serialize writes', verifiedOutcome: null },
      provenance: { origins: ['user', 'assistant'] },
    },
  }
  const candidate = {
    id: 'c_m8',
    authority: AUTHORITIES.DERIVED,
    title: 'Serialize DatabaseSync writes',
    body: 'Repeat observation confirming serialized DatabaseSync writes stop FTS corruption in the shared WAL handle.',
    evidence: [{ path: 'src/store.mjs' }],
    source: {
      automatic: true,
      causal: { symptom: 'WAL corruption', rootCause: 'concurrent writers', remedy: 'serialize writes', verifiedOutcome: 'test-passed' },
      provenance: { origins: ['user'] },
    },
  }
  const strengthened = strengthenMemory(neighbor, candidate)
  assert.ok(strengthened, 'strengthening happened')
  assert.equal(strengthened.source.observations, 2, 'regression: not a no-op')
  assert.ok(strengthened.source.causal, 'causal merge still runs')
  assert.deepEqual(strengthened.source.provenance, { origins: ['user', 'assistant'] }, 'neighbor provenance preserved, candidate origins NOT merged')
})

// ---------------------------------- 16. duplicate strengthening preservation

test('M8: duplicate-content strengthening preserves the ORIGINAL provenance', () => {
  const store = openEphemeralStore()
  try {
    const title = 'Serialize DatabaseSync writes'
    const body = 'Always serialize DatabaseSync writes to avoid FTS corruption, because concurrent writers race on the shared handle under WAL.'
    // Existing derived record (provenance: user+assistant).
    const neighbor = store.put({
      title, body,
      evidence: [{ path: 'src/store.mjs' }],
      authority: AUTHORITIES.DERIVED,
      source: { automatic: true, provenance: { origins: ['user', 'assistant'] } },
    }).record

    // Plugin duplicate path: same title/body, different (single-stream) provenance.
    const incoming = {
      title, body,
      evidence: [{ path: 'src/store.mjs' }],
      authority: AUTHORITIES.DERIVED,
      source: { automatic: true, provenance: { origins: ['user'] } },
    }
    const written = store.put(incoming)
    assert.equal(written.duplicate, true, 'hash duplicate short-circuits before any write')
    assert.equal(written.record.id, neighbor.id)
    assert.deepEqual(written.record.source.provenance.origins, ['user', 'assistant'], 'duplicate returns the original record untouched')

    // Mirror the plugin: strengthenMemory on the duplicate, then persist.
    const strengthened = strengthenMemory(written.record, incoming)
    store.put(strengthened)
    const final = store.get(neighbor.id)
    assert.equal(final.source.observations, 2, 'regression: strengthening actually persisted')
    assert.deepEqual(final.source.provenance, { origins: ['user', 'assistant'] }, 'original provenance wins; candidate origins never overwrite it')
  } finally {
    store.close()
  }
})

// ------------------------------------------- 17a. stale preservation

test('M8: sweepStale lifecycle write preserves provenance', () => {
  const store = openEphemeralStore()
  try {
    const rec = store.put({
      title: 'Old claim that will go stale',
      body: 'Always serialize DatabaseSync writes to avoid FTS corruption, because concurrent writers race on the shared handle under WAL.',
      evidence: [{ path: 'src/x.mjs' }],
      authority: AUTHORITIES.DERIVED,
      validation: VALIDATIONS.UNVERIFIED,
      createdAt: daysAgo(300),
      updatedAt: daysAgo(300),
      source: { automatic: true, provenance: { origins: ['user', 'tool'] } },
    }).record
    sweepStale(store, {})
    const after = store.get(rec.id)
    assert.equal(after.validation, VALIDATIONS.STALE, 'fixture really is stale')
    assert.deepEqual(after.source.provenance, { origins: ['user', 'tool'] }, 'stale write preserves provenance')
  } finally {
    store.close()
  }
})

// ----------------------------------------- 17b. superseded preservation

test('M8: supersession lifecycle writes preserve provenance on both records', () => {
  const store = openEphemeralStore()
  try {
    const oldRec = store.put({
      title: 'Deploy uses rsync for artifact sync',
      body: 'The deploy pipeline always syncs build artifacts to the release host with rsync over ssh.',
      evidence: [{ path: 'scripts/deploy.sh' }],
      authority: AUTHORITIES.DERIVED,
      source: { automatic: true, provenance: { origins: ['user'] } },
    }).record
    const newRec = store.put({
      title: 'Deploy switched from rsync to zstd for artifact sync',
      body: 'The deploy pipeline now compresses build artifacts with zstd before shipping them to the release host.',
      evidence: [{ path: 'scripts/deploy.sh' }],
      authority: AUTHORITIES.DERIVED,
      source: { automatic: true, provenance: { origins: ['user', 'assistant'] } },
    }).record

    const evolved = evolveAgainst(store, newRec, [oldRec])
    assert.equal(evolved.action, 'supersede', `supersede triggered: ${evolved.action}`)
    store.put(evolved.record)

    const retired = store.get(oldRec.id)
    assert.equal(retired.status, STATUSES.SUPERSEDED, 'old record really is superseded')
    assert.deepEqual(retired.source.provenance, { origins: ['user'] }, 'retired record keeps its original provenance')

    const replacement = store.get(newRec.id)
    assert.deepEqual(replacement.source.provenance, { origins: ['user', 'assistant'] }, 'replacement keeps its own provenance')
  } finally {
    store.close()
  }
})

// ----------------------------- 18. metadata must NOT imply a tool origin

test('M8: tools/files/symbols in source never auto-add the "tool" origin', () => {
  // Populated derived metadata + tool-derived evidence notes, but no persisted
  // tool-sourced symptom and both streams non-empty → origins stay stream-based.
  const record = distillBuffer(makeBuffer({
    user: [USER_TEXT + ' Keep const applyMutex exported.'],
    assistant: [ASSISTANT_CLAIM],
    tools: [EDIT_TOOL, ...PASS_TOOLS],
    files: ['src/store.mjs'],
  }), ctx)
  assert.ok(record, 'record is distilled')
  assert.ok(record.source.tools.length > 0, 'tools metadata present')
  assert.ok(record.source.files.length > 0, 'files metadata present')
  assert.ok(record.source.symbols.length > 0, 'symbols metadata present')
  assert.ok(record.body.includes('Tools:'), 'tool names rendered into the body — still not an origin')
  assert.deepEqual(record.source.provenance.origins, ['user', 'assistant'], '"tool" NOT added by metadata')

  // A tool preview whose symptom is REJECTED by the causal gate must not
  // contribute a "tool" origin either: no persisted facets, no origin.
  const symptomRejected = distillBuffer(makeBuffer({
    user: ['Ran the whole suite twice, updated store.mjs, then ran it once more to be sure.'],
    tools: [EDIT_TOOL, ...FAIL_TOOLS],
    files: ['src/store.mjs'],
  }), ctx)
  assert.ok(symptomRejected, 'record is distilled (2 meaningful tools, body >= 40 chars)')
  assert.ok(!symptomRejected.source.causal, 'facets rejected — symptom never persisted')
  assert.deepEqual(symptomRejected.source.provenance.origins, ['user'], 'tool preview without persisted facets adds no "tool" origin')
})
