/**
 * m00188 — Governed Automatic Activation
 *
 * The defects these tests pin, all found by driving a real coding turn through
 * the live pipeline (not by reading the gates):
 *
 *  1. PROVENANCE: `looksLikeClaim` is deliberately broad — it answers "does
 *     this text contain a claim hint". Used as the provenance discriminator it
 *     also matched INSTRUCTIONS ("do not weaken the tests"), so an ordinary
 *     task prompt was classified as a user engineering claim and every such
 *     turn was DEFERred as `provenance-gated`. Net effect: the automatic
 *     learner accepted nothing at all.
 *
 *  2. TITLE: `deriveTitle` returned the raw first line whenever it "looked
 *     like a claim", so the observation was titled with the user's whole task
 *     prompt.
 *
 *  3. TRUNCATION: the facet regexes stopped at `[^\n.;]`, cutting any facet
 *     that mentioned a qualified path — `src/schema.mjs` became `src/schema`.
 *
 * The fix keeps every governance invariant: instructions become learnable,
 * declarations do not, test evidence is still required for user-context turns,
 * and nothing is ever created as canonical or as verified.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  deriveTitle,
  distillBuffer,
  extractCausalFacets,
  extractMentionedPaths,
  looksLikeClaim,
  qualityGateFacet,
  userAssertsClaim,
} from '../src/understand.mjs'
import { candidateFromBuffer, newBuffer, observeEvent } from '../src/observe.mjs'
import { openEphemeralStore } from '../src/store.mjs'
import { maybeLearn, readWriteGateLedger, writeGate } from '../src/learn.mjs'
import { hybridRetrieve } from '../src/retrieve.mjs'
import { checkAnchorFreshness } from '../src/code/linking.mjs'
import { FRESHNESS_STATUS } from '@lovedolove/dsh-codebase-memory-mcp'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { AUTHORITIES, KINDS, VALIDATIONS, isRecallEligible } from '../src/types.mjs'

// A task prompt of the shape a real user writes: a symptom, an instruction,
// and a guardrail. It contains claim hints, but asserts nothing.
const TASK_PROMPT =
  'The test suite in this repository is failing. Investigate why, fix the underlying problem, ' +
  'and confirm the suite passes. Do not weaken the tests.'

const ASSISTANT_CLAIM =
  'The root cause is that migrateRow mutates the shared fields array in src/schema.mjs, so the ' +
  'cached compiled projection keeps the injected email field. The remedy is to copy the field ' +
  'list in migrateRow instead of pushing into it.'

/**
 * Build a complete diagnose → fail → edit → pass turn.
 * `lastTestPasses` controls the final test outcome.
 */
function codingTurn({
  user = TASK_PROMPT,
  assistant = ASSISTANT_CLAIM,
  file = 'src/migrate.mjs',
  failFirst = true,
  lastTestPasses = true,
  testOutput = null,
  extraEvents = [],
} = {}) {
  const buffer = newBuffer()
  observeEvent(buffer, {}, { type: 'turn/start', data: { turn: 1 } })
  if (user) {
    observeEvent(buffer, {}, { type: 'user/message', data: { content: [{ type: 'text', text: user }] } })
  }
  if (assistant) {
    observeEvent(buffer, {}, {
      type: 'assistant/message',
      data: { message: { content: [{ type: 'text', text: assistant }] } },
    })
  }
  // `extraEvents` models a long tool-heavy turn: they are emitted before the
  // test runs, so the important evidence sits late in the buffer.
  for (const event of extraEvents) observeEvent(buffer, {}, event)
  if (failFirst) {
    observeEvent(buffer, {}, { type: 'tool/call', data: { callId: 'c1', name: 'bash', arguments: { command: 'npm test' } } })
    observeEvent(buffer, {}, {
      type: 'tool/result',
      data: {
        callId: 'c1', name: 'bash',
        message: { content: [{ type: 'tool-result', toolCallId: 'c1', content: [{ type: 'text', text: '✖ 1 test failed\n[exit code: 1]' }] }] },
      },
    })
  }
  observeEvent(buffer, {}, { type: 'tool/call', data: { name: 'edit', arguments: { file_path: file } } })
  observeEvent(buffer, {}, { type: 'tool/call', data: { callId: 'c2', name: 'bash', arguments: { command: 'npm test' } } })
  observeEvent(buffer, {}, {
    type: 'tool/result',
    data: {
      callId: 'c2', name: 'bash',
      message: {
        content: [{
          type: 'tool-result', toolCallId: 'c2',
          content: [{ type: 'text', text: testOutput ?? (lastTestPasses ? '✔ 12 tests passed\n[exit code: 0]' : '✖ 1 test failed\n[exit code: 1]') }],
        }],
      },
    },
  })
  return buffer
}

function distill(buffer, projectId = 'p_m188') {
  return distillBuffer(buffer, { projectId, sessionId: 's1', cwd: process.cwd(), agent: 'test' })
}

function activate(store, buffer, projectId = 'p_m188') {
  const persisted = store.put(candidateFromBuffer(buffer, { projectId, sessionId: 's1' }))
  return writeGate(store, { ...persisted.record }, { workspace: process.cwd() })
}

// ══════════════════════════════════════════════════════ 1. provenance

test('m188: an instruction is not a user claim', () => {
  // Instructions, even when they contain claim hints, assert nothing.
  assert.equal(userAssertsClaim(TASK_PROMPT), false)
  assert.equal(userAssertsClaim('Do not weaken the tests.'), false)
  assert.equal(userAssertsClaim('Never touch the lock file; add a migration instead.'), false)
  assert.equal(userAssertsClaim('Investigate the cli fixture failure. The test suite is failing.'), false)
  assert.equal(userAssertsClaim('Why did projectRow return an extra field? Find out and fix it.'), false)
  // `looksLikeClaim` is unchanged and still broad — this is why the two exist.
  assert.equal(looksLikeClaim(TASK_PROMPT), true)
})

test('m188: a declaration is still a user claim', () => {
  assert.equal(userAssertsClaim('The root cause is the mutex was missing. The fix is to add it.'), true)
  assert.equal(userAssertsClaim('We decided to always serialize writes through a single mutex.'), true)
  assert.equal(userAssertsClaim('The architecture is wrong because the writer path has a race.'), true)
  assert.equal(userAssertsClaim('Fix was to add a mutex around the handle.'), true)
  assert.equal(userAssertsClaim('The cause is that migrateRow mutates the shared schema.'), true)
})

test('m188: a task prompt now becomes userContextOnly', () => {
  const record = distill(codingTurn())
  assert.equal(record.source.userContextOnly, true, 'an instruction-only prompt is user context, not a user claim')
  assert.deepEqual(record.source.provenance.origins, ['user', 'assistant'])
})

test('m188: a user-authored claim still blocks learning (governance preserved)', () => {
  const store = openEphemeralStore(':memory:', { scope: 'project', projectId: 'p_m188_claim' })
  try {
    const record = distill(codingTurn({
      user: 'The root cause is that migrateRow mutates the shared schema array.',
      assistant: ASSISTANT_CLAIM,
    }), 'p_m188_claim')
    assert.equal(record.source.userContextOnly, undefined, 'a claim-bearing user turn is not userContextOnly')

    const verdict = activate(store, codingTurn({
      user: 'The root cause is that migrateRow mutates the shared schema array.',
      assistant: ASSISTANT_CLAIM,
    }), 'p_m188_claim')
    assert.equal(verdict.decision, 'DEFER')
    assert.equal(verdict.reason, 'provenance-gated')
    assert.equal(verdict.record, null, 'the automatic path is stopped by the provenance gate')
  } finally {
    store.close()
  }
})

test('m188: user context without test evidence still defers', () => {
  const store = openEphemeralStore(':memory:', { scope: 'project', projectId: 'p_m188_noev' })
  try {
    // The turn edits code but never runs a test: no evidence chain.
    const buffer = newBuffer()
    observeEvent(buffer, {}, { type: 'turn/start', data: { turn: 1 } })
    observeEvent(buffer, {}, { type: 'user/message', data: { content: [{ type: 'text', text: TASK_PROMPT }] } })
    observeEvent(buffer, {}, {
      type: 'assistant/message',
      data: { message: { content: [{ type: 'text', text: ASSISTANT_CLAIM }] } },
    })
    observeEvent(buffer, {}, { type: 'tool/call', data: { name: 'edit', arguments: { file_path: 'src/migrate.mjs' } } })

    const verdict = activate(store, buffer, 'p_m188_noev')
    assert.equal(verdict.decision, 'DEFER')
    assert.equal(verdict.reason, 'context-provenance-no-test-evidence')
    assert.equal(verdict.record, null)
  } finally {
    store.close()
  }
})

// ══════════════════════════════════════════════════════ 2. activation

test('m188: a grounded coding turn activates into derived memory', () => {
  const store = openEphemeralStore(':memory:', { scope: 'project', projectId: 'p_m188_ok' })
  try {
    const verdict = activate(store, codingTurn(), 'p_m188_ok')
    assert.equal(verdict.decision, 'ACCEPT')
    assert.equal(verdict.reason, 'new-derived-knowledge')
    assert.ok(verdict.record, 'a record is written')

    // Activation is NOT authority escalation and NOT verification.
    assert.equal(verdict.record.kind, KINDS.MEMORY)
    assert.equal(verdict.record.authority, AUTHORITIES.DERIVED)
    assert.equal(verdict.record.validation, VALIDATIONS.REVIEWED)
    assert.notEqual(verdict.record.authority, AUTHORITIES.CANONICAL)
    assert.notEqual(verdict.record.validation, VALIDATIONS.VERIFIED)

    const ledger = readWriteGateLedger(store)
    assert.equal(ledger.decisions.accept, 1, 'the verdict is accounted for')
  } finally {
    store.close()
  }
})

test('m188: the activated record is recall-eligible and surfaces', () => {
  const store = openEphemeralStore(':memory:', { scope: 'project', projectId: 'p_m188_recall' })
  try {
    const verdict = activate(store, codingTurn(), 'p_m188_recall')
    assert.equal(isRecallEligible(verdict.record), true)

    const hits = hybridRetrieve({
      projectStore: store,
      query: 'migrateRow shared fields schema compiled projection',
      limit: 5,
    })
    assert.ok(hits.length >= 1, 'the learned memory is found by recall')
  } finally {
    store.close()
  }
})

test('m188: repeated identical turns do not accumulate duplicate records', () => {
  const store = openEphemeralStore(':memory:', { scope: 'project', projectId: 'p_m188_idem' })
  try {
    for (let i = 0; i < 3; i++) activate(store, codingTurn(), 'p_m188_idem')
    assert.equal(store.list({ limit: 50 }).length, 1, 'three identical turns collapse to one memory')
  } finally {
    store.close()
  }
})

test('m188: a paraphrased turn merges instead of duplicating', () => {
  const store = openEphemeralStore(':memory:', { scope: 'project', projectId: 'p_m188_merge' })
  try {
    activate(store, codingTurn(), 'p_m188_merge')
    // A one-clause paraphrase (same claim, different connective) is the case
    // the near-duplicate path is for. A wholesale rewrite is new knowledge and
    // is expected to ADD instead — that boundary is intentional.
    const second = activate(store, codingTurn({
      assistant: ASSISTANT_CLAIM.replace('instead of', 'rather than'),
    }), 'p_m188_merge')
    assert.equal(second.decision, 'MERGE')
    assert.equal(second.reason, 'near-duplicate-strengthened')
    assert.equal(second.record, null, 'a merge writes no second memory record')
    // The merge strengthens the existing memory; the second turn's observation
    // candidate is still captured, so the store holds one memory + one candidate.
    const memories = store.list({ limit: 50 }).filter((r) => r.kind === KINDS.MEMORY)
    assert.equal(memories.length, 1, 'the paraphrase did not create a second memory record')
  } finally {
    store.close()
  }
})

test('m188: a failing final test never verifies the record', () => {
  const store = openEphemeralStore(':memory:', { scope: 'project', projectId: 'p_m188_fail' })
  try {
    const verdict = activate(store, codingTurn({ lastTestPasses: false }), 'p_m188_fail')
    // Whatever the verdict, nothing may become verified or canonical.
    if (verdict.record) {
      assert.notEqual(verdict.record.validation, VALIDATIONS.VERIFIED)
      assert.notEqual(verdict.record.authority, AUTHORITIES.CANONICAL)
    }
  } finally {
    store.close()
  }
})

// ══════════════════════════════════════════════════════ 3. title

test('m188: the title is never the raw task prompt', () => {
  const record = distill(codingTurn())
  assert.notEqual(record.title, TASK_PROMPT)
  assert.ok(!record.title.includes('Investigate why'), 'an instruction is not a title')
  assert.ok(!record.title.includes('Do not weaken'), 'a guardrail is not a title')

  // A declarative user claim is still the best title there is.
  const claimed = deriveTitle('The root cause is concurrent writes corrupting FTS.', [], [], 'root-cause', null)
  assert.equal(claimed, 'The root cause is concurrent writes corrupting FTS.')

  // An instruction falls through to the neutral fallback.
  assert.equal(deriveTitle('Investigate why the tests are failing and fix it.', [], [], 'fix', null), 'Engineering observation')
})

// ══════════════════════════════════════════════════════ 4. truncation

test('m188: a facet keeps the file suffix it mentions', () => {
  const { facets } = extractCausalFacets({ user: ASSISTANT_CLAIM, assistant: '', tools: [], files: [] })
  assert.ok(facets, 'the claim survives the concreteness gate')
  assert.ok(facets.rootCause.includes('src/schema.mjs'), `rootCause kept its path: ${facets.rootCause}`)
  assert.ok(!facets.rootCause.endsWith('src/schema'), 'the suffix was not cut at the period')
})

test('m188: a period inside a path or version does not end the facet', () => {
  const cases = [
    // Both facets must clear the concreteness gate before `extractCausalFacets`
    // returns anything at all (it needs two survivors), so each remedy names a
    // real anchor the way a genuine claim does.
    ['The root cause is the bad compare in src/reader.mjs that drops rows. The remedy is to compare the resolved path in src/reader.mjs', 'src/reader.mjs'],
    ['The root cause is the bad compare in pkg/v1.2/handler.mjs that drops rows. The remedy is to compare the resolved path in pkg/v1.2/handler.mjs', 'pkg/v1.2/handler.mjs'],
  ]
  for (const [text, expected] of cases) {
    const { facets } = extractCausalFacets({ user: text, assistant: '', tools: [], files: [] })
    assert.ok(facets?.rootCause, `facets present for: ${text}`)
    assert.ok(facets.rootCause.includes(expected), `expected ${expected} in "${facets.rootCause}"`)
  }
})

test('m188: a real sentence boundary still ends the facet', () => {
  const { facets } = extractCausalFacets({
    user: 'The root cause is concurrent write contention. The remedy is to add a busy timeout pragma on open',
    assistant: '', tools: [], files: [],
  })
  assert.ok(facets)
  assert.equal(facets.rootCause, 'concurrent write contention', 'the sentence stopped where it should')
  assert.ok(!facets.rootCause.includes('remedy'), 'no bleed into rootCause')
})

// ══════════════════════════════════ 5. central reusability (repo-relative anchors)

test('m188: evidence anchors are repository-relative, not absolute', () => {
  const absolute = `${process.cwd()}/src/store.mjs`
  const record = distillBuffer(codingTurn({ file: absolute }), {
    projectId: 'p_m188_anchor', sessionId: 's1', cwd: process.cwd(), agent: 'test',
  })
  const anchors = record.evidence.filter((e) => e.path)
  assert.ok(anchors.length > 0, 'a real file edit yields an anchor')
  for (const anchor of anchors) {
    assert.ok(!anchor.path.startsWith('/'), `anchor is not absolute: ${anchor.path}`)
  }
  assert.ok(anchors.some((a) => a.path === 'src/store.mjs'), 'the anchor is repo-relative')

  // Provenance still records what was actually touched, absolute and all.
  assert.ok(record.source.files.includes(absolute), 'source.files keeps the original path')
})

test('m188: a relative anchor re-verifies in another repository', () => {
  const record = distillBuffer(codingTurn({ file: `${process.cwd()}/src/store.mjs` }), {
    projectId: 'p_m188_xrepo', sessionId: 's1', cwd: process.cwd(), agent: 'test',
  })
  const anchor = record.evidence.find((e) => e.path === 'src/store.mjs')
  assert.ok(anchor, 'the anchor exists')

  // Origin repo: the file is really there.
  const atOrigin = checkAnchorFreshness(anchor, process.cwd())
  assert.equal(atOrigin.status, FRESHNESS_STATUS.FRESH)

  // A different repository that happens to contain the same relative path can
  // re-verify the evidence instead of inheriting the origin's checkout path.
  const otherRepo = mkdtempSync(join(tmpdir(), 'veyra-xrepo-'))
  try {
    mkdirSync(join(otherRepo, 'src'), { recursive: true })
    writeFileSync(join(otherRepo, 'src/store.mjs'), 'export const rows = []\n')
    const elsewhere = checkAnchorFreshness(anchor, otherRepo)
    assert.equal(elsewhere.status, FRESHNESS_STATUS.FRESH,
      'a repo-relative anchor is verifiable outside the origin checkout')
  } finally {
    rmSync(otherRepo, { recursive: true, force: true })
  }
})

test('m188: an anchor outside the workspace never becomes code evidence', () => {
  const record = distillBuffer(codingTurn({ file: '/etc/hostname' }), {
    projectId: 'p_m188_escape', sessionId: 's1', cwd: process.cwd(), agent: 'test',
  })
  assert.ok(!record.evidence.some((e) => e.path === '/etc/hostname'), 'outside path is not an anchor')
  assert.ok(!record.evidence.some((e) => e.path === '../hostname'), 'no escape-like anchor either')
})

// ══════════════════════════════════ 6. security

test('m188: secrets never reach the store through the learning flow', () => {
  const OPENAI_STYLE = 'sk-live-' + 'abcdef0123456789'.repeat(2)
  const GITHUB_STYLE = 'ghp_' + 'a'.repeat(36)

  // The secret has to travel on a path the distiller actually copies into the
  // record. Tool RESULT text is not part of the distilled body (the buffer
  // records tool names only), so putting it there would make this test vacuous:
  // it would pass even with redaction completely disabled. The assistant's own
  // prose DOES become the body, so the tokens are planted there.
  const leakyClaim =
    `The root cause is the bad compare in src/store.mjs that drops rows, because the key ${OPENAI_STYLE} ` +
    `short-circuited the guard. The remedy is to compare the resolved path in src/store.mjs and to stop ` +
    `echoing the token ${GITHUB_STYLE} into the artifact.`

  const buffer = codingTurn({ assistant: leakyClaim })

  // Premise check: the secret really is on the pre-redaction write path. If
  // this fails, the assertions below prove nothing.
  const rawCandidate = JSON.stringify(candidateFromBuffer(buffer, { projectId: 'p_m188_sec', sessionId: 's1' }))
  assert.ok(rawCandidate.includes(OPENAI_STYLE), 'the secret reaches the candidate — otherwise this test is vacuous')
  assert.ok(rawCandidate.includes(GITHUB_STYLE), 'the second secret reaches the candidate too')

  const store = openEphemeralStore(':memory:', { scope: 'project', projectId: 'p_m188_sec' })
  try {
    const verdict = activate(store, buffer, 'p_m188_sec')
    assert.equal(verdict.decision, 'ACCEPT', 'the turn still activates; redaction scrubs, it does not block')
    const persisted = JSON.stringify(store.list({ limit: 50 }))
    assert.ok(!persisted.includes(OPENAI_STYLE), 'the OpenAI-style key was redacted before persistence')
    assert.ok(!persisted.includes(GITHUB_STYLE), 'the GitHub token was redacted before persistence')
    assert.ok(persisted.includes('[REDACTED'), 'the secret was replaced, not merely dropped')
  } finally {
    store.close()
  }
})

test('m188: a contradicted memory does not overwrite the earlier one', () => {
  const store = openEphemeralStore(':memory:', { scope: 'project', projectId: 'p_m188_contra' })
  try {
    const first = activate(store, codingTurn({
      assistant: 'The root cause is the bad compare in src/store.mjs that drops rows. The remedy is to compare the resolved path in src/store.mjs.',
    }), 'p_m188_contra')
    const second = activate(store, codingTurn({
      assistant: 'The root cause is the bad compare in src/store.mjs that keeps rows. The remedy is to keep the resolved path in src/store.mjs.',
    }), 'p_m188_contra')

    // Both conclusions remain visible: contradiction is surfaced, never resolved
    // by silently discarding the earlier memory.
    const memories = store.list({ limit: 50 }).filter((r) => r.kind === KINDS.MEMORY)
    if (second.decision === 'ACCEPT') {
      assert.ok(memories.length >= 1)
      const firstId = first.record?.id
      if (firstId) assert.ok(store.get(firstId), 'the earlier record still exists')
    }
    // Nothing became canonical or verified along the way.
    for (const m of memories) {
      assert.notEqual(m.authority, AUTHORITIES.CANONICAL)
      assert.notEqual(m.validation, VALIDATIONS.VERIFIED)
    }
  } finally {
    store.close()
  }
})

test('m188: activation never writes outside its own project store', () => {
  const storeA = openEphemeralStore(':memory:', { scope: 'project', projectId: 'p_m188_iso_a' })
  const storeB = openEphemeralStore(':memory:', { scope: 'project', projectId: 'p_m188_iso_b' })
  try {
    activate(storeA, codingTurn(), 'p_m188_iso_a')
    assert.ok(storeA.list({ limit: 50 }).length >= 1, 'the learning project has the memory')
    assert.equal(storeB.list({ limit: 50 }).length, 0, 'a different workspace sees nothing')
  } finally {
    storeA.close()
    storeB.close()
  }
})

test('m188: activation cannot reach Central without explicit promotion', () => {
  const projectStore = openEphemeralStore(':memory:', { scope: 'project', projectId: 'p_m188_central' })
  const centralStore = openEphemeralStore(':memory:', { scope: 'reusable', projectId: 'reusable' })
  try {
    const verdict = activate(projectStore, codingTurn(), 'p_m188_central')
    assert.equal(verdict.decision, 'ACCEPT')
    assert.equal(centralStore.list({ limit: 50 }).length, 0,
      'automatic activation never writes Central — only governed promotion does')
  } finally {
    projectStore.close()
    centralStore.close()
  }
})

// ══════════════════════════════════════════════════════ 6. the second wall

test('m188: a candidate observation is never recall-eligible', () => {
  // `isLifecycleEligible` already stops a candidate-authority observation, so
  // this holds twice over. Both walls are asserted here because the second one
  // (`kind === OBSERVATION`) is what makes the guarantee survive a future
  // change to the lifecycle rules — mutating it must fail this test.
  const store = openEphemeralStore(':memory:', { scope: 'project', projectId: 'p_m188_obs' })
  try {
    const persisted = store.put(candidateFromBuffer(codingTurn(), { projectId: 'p_m188_obs', sessionId: 's1' }))
    const observation = store.list({ limit: 50 }).find((r) => r.id === persisted.record.id) ?? persisted.record

    assert.equal(observation.kind, KINDS.OBSERVATION, 'the capture itself is an observation')
    assert.equal(isRecallEligible(observation), false, 'an observation never enters recall')

    // Force the lifecycle wall out of the way: even as a perfectly healthy,
    // current, derived record, an observation must still be refused.
    const wouldPassLifecycle = {
      ...observation,
      corrupt: [],
      status: 'current',
      validation: VALIDATIONS.REVIEWED,
      authority: AUTHORITIES.DERIVED,
    }
    assert.equal(isRecallEligible(wouldPassLifecycle), false,
      'the OBSERVATION check is an independent wall, not an accident of authority')

    const hits = hybridRetrieve({ projectStore: store, query: 'migrateRow shared fields schema', limit: 5 })
    assert.equal(hits.length, 0, 'recall finds nothing until the record is promoted to memory')
  } finally {
    store.close()
  }
})

// ══════════════════════════════════════════════════════ 7. body integrity

test('m188: a long assistant body is clipped at a sentence, never mid-token', () => {
  // Found by driving a real agent: a blind 600-char slice ended a stored body
  // with `compiledVersion = SCHEMA_` — a fragment that reads as a corrupted
  // file rather than as engineering knowledge.
  const sentence = 'The cached projection keeps the injected field because migrateRow mutates the shared array. '
  const longClaim = sentence.repeat(12) + 'The remedy is to copy the field list instead of pushing into it.'

  const record = distill(codingTurn({ assistant: longClaim }))
  assert.ok(record, 'the turn still distills')
  assert.ok(!/[A-Za-z0-9_]=$/.test(record.body), 'the body does not end inside an assignment')
  assert.ok(!record.body.endsWith('='), 'the body does not end on a dangling equals')
  // The clip happened, and it happened at a boundary.
  assert.ok(record.body.length <= 2400, 'the body stayed within its budget')
  const agentLine = record.body.split('\n\n').find((p) => p.startsWith('Agent: '))
  assert.ok(agentLine, 'the agent prose is present')
  assert.ok(/[.!?]$/.test(agentLine.trim()), `the agent line ends a sentence: ${JSON.stringify(agentLine.slice(-24))}`)
})

test('m188: a long user prompt is clipped at a sentence, never mid-token', () => {
  // The user half has its own budget (1200 chars). Before this test a blind
  // `user.slice(0, 1200)` was a SURVIVING MUTATION: no test drove a prompt past
  // the limit, so the coverage was indistinguishable from no clipping at all.
  const line = 'Sentence N explains one distinct part of the failing behaviour in this repository and must be investigated carefully. '
  // 12 full sentences (~1520 chars) then a long unbroken final clause whose
  // start sits past the 1200-char mark.
  const longPrompt = Array.from({ length: 12 }, (_, i) => line.replace('N', String(i + 1))).join('') +
    'TheFinalDiagnosticConclusionIsThatTheSharedFieldArrayIsMutatedByMigrateRowAndMustBeCopiedInstead'

  assert.ok(longPrompt.length > 1200, `the prompt is past the budget: ${longPrompt.length}`)

  const record = distill(codingTurn({ user: longPrompt }))
  const userBlock = record.body.split('\n')[0]
  assert.ok(userBlock.length <= 1200, `the user half respected its budget: ${userBlock.length}`)
  assert.ok(/[.!?]$/.test(userBlock.trim()),
    `the user half ends a sentence, not mid-token: ${JSON.stringify(userBlock.slice(-40))}`)

  // Contrast: a blind slice would have landed inside the final clause.
  const blind = longPrompt.slice(0, 1200)
  assert.ok(!/[.!?]$/.test(blind.trim()), 'premise: the blind slice really does end mid-token')
})

test('m188: clipping keeps dotted filenames and versions intact', () => {
  // A period only ends a sentence when whitespace follows it, so a path or a
  // version number survives the clip.
  const record = distill(codingTurn({
    assistant: 'The root cause is the bad compare in src/schema.mjs that drops rows in pkg/v1.2/handler.mjs. ' +
      'The remedy is to compare the resolved path in src/schema.mjs instead.',
  }))
  assert.ok(record.body.includes('src/schema.mjs') || record.evidence.some((e) => e.path === 'src/schema.mjs'),
    'the dotted filename survived')
})

test('m188: a path candidate that spans a token boundary is rejected', () => {
  // `PATH_RE` can run across a space and glue `.` + `..` into the match. A
  // repo-relative path never contains `..`; keeping one would also be a
  // traversal-shaped anchor.
  //
  // Assertion layer matters: the FACET text is prose and legitimately echoes
  // whatever the user typed. Only the extracted ANCHORS are a filtered
  // artifact, so only they are asserted clean here.
  const polluted = 'The root cause is the bad edit src/.migrate.mjs...tmpdir and src/migrate.mjs that drops rows. ' +
    'The remedy is to compare the resolved path in src/migrate.mjs instead.'

  const paths = extractMentionedPaths(polluted)
  assert.ok(paths.includes('src/migrate.mjs'), 'the real path is still extracted')
  assert.ok(!paths.some((p) => p.includes('..')), `no glued artifact survives: ${JSON.stringify(paths)}`)

  // The same filter holds on the record the pipeline actually writes.
  const record = distill(codingTurn({ assistant: polluted }))
  for (const entry of record.evidence ?? []) {
    if (typeof entry.path === 'string') {
      assert.ok(!entry.path.includes('..'), `evidence anchor is clean: ${entry.path}`)
    }
  }
})

// ══════════════════════════════════ 8. test-outcome reading (found via live agent)

test('m188: a failing Node suite is never scored as a pass', () => {
  // Found by driving a real agent. `node --test` puts the count AFTER the word
  // (`ℹ fail 1`), while the old reading only knew `1 failed`. A genuinely
  // failing suite was therefore scored as a PASS and the record was stamped
  // `verified-test` — an automatic VERIFICATION of work that had failed.
  const failing = [
    '✔ projects exactly the declared fields (1.401985ms)',
    '✖ migrating a row does not widen the projection (1.034094ms)',
    'ℹ tests 2',
    'ℹ suites 0',
    'ℹ pass 1',
    'ℹ fail 1',
    'ℹ cancelled 0',
    '',
    '✖ failing tests:',
    '',
    "test at test/reader.test.mjs:10:1",
    '✖ migrating a row does not widen the projection (1.034094ms)',
    '  AssertionError [ERR_ASSERTION]: Expected values to be strictly deep-equal',
  ].join('\n')

  const record = distill(codingTurn({ lastTestPasses: false, testOutput: failing }))
  assert.ok(record, 'the turn still distills')
  const notes = (record.evidence ?? []).filter((e) => e.note).map((e) => e.note)
  assert.ok(notes.includes('test-failed'), `the failure is recorded: ${JSON.stringify(notes)}`)
  assert.ok(!notes.includes('test-passed'), 'a failed run is never recorded as a pass')
  assert.ok(!(record.tags ?? []).includes('verified-test'), 'a failed run never earns verified-test')
})

test('m188: a passing Node suite is still scored as a pass', () => {
  const passing = [
    '✔ projects exactly the declared fields (0.934822ms)',
    '✔ migrating a row does not widen the projection (0.122664ms)',
    'ℹ tests 2',
    'ℹ suites 0',
    'ℹ pass 2',
    'ℹ fail 0',
    'ℹ cancelled 0',
  ].join('\n')

  const record = distill(codingTurn({ testOutput: passing }))
  const notes = (record.evidence ?? []).filter((e) => e.note).map((e) => e.note)
  assert.ok(notes.includes('test-passed'), `the pass is recorded: ${JSON.stringify(notes)}`)
  assert.ok((record.tags ?? []).includes('verified-test'), 'a passing run earns verified-test')
})

test('m188: the exit-code shapes Veyra already supported still work', () => {
  // Regression guard for the reading above: the historical shapes must not be
  // lost while adding Node's own summary form.
  const okShape = distill(codingTurn({ testOutput: '✔ 58 tests passed (110ms)\n[exit code: 0]' }))
  assert.ok((okShape.tags ?? []).includes('verified-test'), 'exit code 0 is still a pass')

  const failShape = distill(codingTurn({ lastTestPasses: false, testOutput: 'FAIL src/store.test.mjs\n1 failed\n[exit code: 1]' }))
  assert.ok(!(failShape.tags ?? []).includes('verified-test'), 'exit code 1 is still a failure')
})

test('m188: test evidence survives a long tool-heavy turn', () => {
  // The analysis used to receive `buffer.tools.slice(0, 16)`. A real 26-event
  // session kept its two `npm test` runs at indices 19 and 23, so the evidence
  // was cut off before it could be read: a verified fix was stored as
  // `tests-touched`, and the gate then DEFERred the whole turn.
  const noise = Array.from({ length: 10 }, (_, i) => [
    { type: 'tool/call', data: { callId: `n${i}`, name: 'read', arguments: { file_path: `${process.cwd()}/src/f${i}.mjs` } } },
    { type: 'tool/result', data: { callId: `n${i}`, name: 'read', output: `contents of module ${i}` } },
  ]).flat()

  const record = distill(codingTurn({ extraEvents: noise }))
  assert.ok(record, 'the turn still distills')
  const notes = (record.evidence ?? []).filter((e) => e.note).map((e) => e.note)
  assert.ok(notes.includes('test-passed'), `evidence is found past index 16: ${JSON.stringify(notes)}`)
  assert.ok((record.tags ?? []).includes('verified-test'), 'the late passing test still counts')
})

test('m188: agent analysis reaches the body when the prompt supplies the cause word', () => {
  // Found by driving a real agent (family B): the task prompt said
  // "investigate why", whose `why` trips CAUSE_HINTS, so `classifySignal`
  // returned `root-cause` — but the agent's terse analysis ("two bugs: the loop
  // is off by one") is not a CLAIM, so `looksLikeClaim(assistant)` was false and
  // the body branch only accepted `signal === 'fix'`. Every word the agent wrote
  // was dropped and the stored record was the task prompt plus a file list: an
  // "engineering memory" that teaches nothing.
  const record = distill(codingTurn({
    user: 'The test suite is failing. Investigate why and fix it without changing the tests.',
    assistant: 'Two bugs in withRetry: the loop allows one attempt too many and it returns the last error instead of throwing.',
    file: 'src/retry.mjs',
  }))
  assert.ok(record, 'the turn distills')
  assert.ok(record.body.includes('one attempt too many'), `the analysis survived: ${JSON.stringify(record.body)}`)
  assert.ok(record.body.split('\n\n').some((p) => p.startsWith('Agent: ')), 'the analysis is an Agent block')
})

test('m188: a cause-word prompt with no modified file still teaches nothing falsely', () => {
  // The widened branch must stay gated on modified files: chatter about a
  // problem the agent only READ about is not a stored engineering lesson.
  //
  // The assistant line must NOT itself be a claim, or the pre-existing
  // `looksLikeClaim(assistant)` path legitimately records it and this test
  // would pass for the wrong reason (it did, before m00188 review).
  const assistant = 'Two bugs: the loop allows one attempt too many and it returns the last error instead of throwing.'
  assert.equal(looksLikeClaim(assistant), false, 'premise: this analysis is not a claim')
  const record = distill(codingTurn({
    user: 'The suite is failing. Investigate why.',
    assistant,
    file: null,
  }))
  assert.deepEqual(record?.source?.files ?? [], [], 'premise: no file was modified')
  assert.ok(
    !String(record?.body ?? '').includes('one attempt too many'),
    `no file edited, so the analysis was not stored: ${JSON.stringify(record?.body ?? null)}`,
  )
})

test('m188: markdown emphasis and code ticks never survive into a facet', () => {
  // Same run: the agent wrote "**Root cause:** `src/retry.mjs` had two
  // off-by-one bugs". The capture kept the closing backtick, so the stored
  // TITLE read `Cause: src/retry.mjs` had two off-by-one bugs`.
  const record = distill(codingTurn({
    user: 'The suite is failing. Fix it.',
    assistant: 'All tests pass. **Root cause:** `src/retry.mjs` had two off-by-one bugs.',
    file: 'src/retry.mjs',
  }))
  const causal = record.source?.causal ?? {}
  for (const value of [causal.rootCause, causal.symptom, causal.remedy, record.title]) {
    if (typeof value !== 'string') continue
    assert.ok(!value.includes('`'), `no stray backtick in ${JSON.stringify(value)}`)
    assert.ok(!value.includes('**'), `no stray emphasis in ${JSON.stringify(value)}`)
  }
  assert.ok(String(causal.rootCause ?? '').startsWith('src/retry.mjs'), `the path survived: ${JSON.stringify(causal.rootCause)}`)
})

test('m188: an engineer saying "the bug" is a cause attribution, not just a symptom', () => {
  // Real arm finding (mem-a-1..2): the agent wrote "The bug: migrateRow mutates
  // the shared fields array by pushing email" — a textbook cause attribution.
  // Only the SYMPTOM pattern matched it, and the invariant needs rootCause or
  // remedy plus a second facet, so every such turn stored the empty fallback
  // title "Engineering observation" while its body held the real diagnosis.
  const user = 'The test suite in this repository is failing. Investigate why.'
  const assistant = 'The bug: migrateRow mutates the shared fields array by pushing email, which widens the projection.'
  const record = distill(codingTurn({ user, assistant, file: 'src/migrate.mjs' }))
  assert.ok(record, 'the turn was recorded')
  assert.equal(
    record.source.causal.rootCause,
    'migrateRow mutates the shared fields array by pushing email, which widens the projection',
  )
  assert.ok(record.title.startsWith('Cause: '), `title names the cause: ${JSON.stringify(record.title)}`)
  assert.ok(!record.title.includes('Engineering observation'), 'the fallback title is gone')
})

test('m188: a one-line "the bug" restatement is still not enough on its own', () => {
  // Deduping symptom against rootCause must not let a single sentence qualify:
  // the invariant still needs an independent facet, so no test evidence and no
  // real remedy means no causal record.
  const assistant = 'The bug: migrateRow mutates the shared fields array by pushing email, which widens the projection.'
  const { facets } = extractCausalFacets({
    user: 'The suite is failing.',
    assistant,
    tools: [],
    files: ['src/migrate.mjs'],
  })
  assert.equal(facets, null, 'a lone restated line is not a causal record')
})

test('m188: the two other root-cause shapes engineers actually write', () => {
  // Real arm logs (mem-b-1/b-3) said "Two bugs: loop <= causes 4 attempts" and
  // "The bug is in retry.mjs: <reason>". Both are attributions; neither matched
  // the original patterns, and both stored "Engineering observation".
  const evidence = [{ name: 'bash:result', preview: 'ℹ pass 4\n[exit code: 0]' }]
  const a = extractCausalFacets({
    user: 'The suite is failing.',
    assistant: 'Two bugs: loop `<=` causes maxAttempts+1 attempts, and `return lastError` instead of throwing.',
    tools: evidence,
    files: ['src/retry.mjs'],
  })
  assert.ok(a.facets?.rootCause, 'the "X causes Y" shape yields a cause')

  const b = extractCausalFacets({
    user: 'The suite is failing.',
    assistant: 'The bug is in retry.mjs: the loop ran maxAttempts+1 times.',
    tools: evidence,
    files: ['src/retry.mjs'],
  })
  assert.equal(b.facets?.rootCause, 'the loop ran maxAttempts+1 times')
})

test('m188: a trailing number is a value, not a truncated word', () => {
  // R7 rejected any facet ending in a <3-char token, so "… instead of 3" — a
  // complete sentence — was dropped as if cut mid-word. Asserted directly on the
  // gate because a bare number cannot pass the concreteness rule on its own.
  assert.ok(qualityGateFacet('the retry.mjs loop ran 4 attempts instead of 3'), 'a trailing number survives R7')
  assert.equal(qualityGateFacet('the retry.mjs loop ran 4 attempts instead o'), null, 'a 1-char letter stub still fails')
})

test('m188: a "Cause:" title does not repeat the facet own label or cut a path', () => {
  // A double label ("Cause: Two bugs: …") and a path chopped to "5:" were both
  // seen in the arm logs.
  assert.equal(
    deriveTitle('fix it', ['src/migrate.mjs'], [], 'fix', { rootCause: 'Two bugs: loop <= causes maxAttempts+1 attempts' }),
    'Cause: loop <= causes maxAttempts+1 attempts',
  )
  assert.equal(
    deriveTitle('fix it', ['src/migrate.mjs'], [], 'fix', { rootCause: 'src/migrate.mjs:5: migrateRow mutates the shared fields' }),
    'Cause: src/migrate.mjs:5: migrateRow mutates the shared fields',
  )
})

test('m188: a code span is opaque to the sentence-boundary cut', () => {
  // The extraction regexes stop at `;`. A semicolon INSIDE backticks is code, so
  // "The bug: loop `attempt = 0; attempt <= maxAttempts` runs …" was captured as
  // "loop `attempt = 0" and then rejected — the record fell back to the generic
  // title on a real arm.
  const evidence = [{ name: 'bash:result', preview: 'ℹ pass 3\n[exit code: 0]' }]
  const { facets } = extractCausalFacets({
    user: 'The suite is failing.',
    assistant: 'The bug: loop `attempt = 0; attempt <= maxAttempts` runs maxAttempts+1 times (4), and returns lastError instead of throwing.',
    tools: evidence,
    files: ['src/retry.mjs'],
  })
  assert.match(facets?.rootCause ?? '', /attempt = 0; attempt <= maxAttempts runs maxAttempts\+1 times/)
})

test('m188: naming a symbol is not explaining a cause', () => {
  // "The root cause is fields.push." is a pointer, not a diagnosis, and it
  // became the stored cause on a real arm. The word "cause" followed by "is" is
  // also not the verb "causes" — that shape once produced "The root" as a cause.
  const evidence = [{ name: 'bash:result', preview: 'ℹ pass 3\n[exit code: 0]' }]
  const bare = extractCausalFacets({
    user: 'The suite is failing.',
    assistant: 'The root cause is fields.push. Fix migrate.mjs.',
    tools: evidence,
    files: ['src/migrate.mjs'],
  })
  assert.equal(bare.facets?.rootCause ?? null, null, 'a bare symbol is not a cause')

  const explained = extractCausalFacets({
    user: 'The suite is failing.',
    assistant: 'The root cause is that fields.push widens the projection.',
    tools: evidence,
    files: ['src/migrate.mjs'],
  })
  assert.equal(explained.facets?.rootCause, 'fields.push widens the projection')
})

test('m188: "cause" as a noun is not the verb "causes"', () => {
  // "The migration cause is a missing index." contains the word "cause" but
  // asserts nothing about causation via the verb. A loose `causes?` pattern took
  // "The migration" as the subject and produced it as the root cause; the
  // concreteness gate ACCEPTS "The migration" on its own, so only the verb-form
  // requirement keeps the junk out.
  const evidence = [{ name: 'bash:result', preview: 'ℹ pass 3\n[exit code: 0]' }]
  const { facets } = extractCausalFacets({
    user: 'The suite is failing.',
    assistant: 'The migration cause is a missing index.',
    tools: evidence,
    files: ['src/migrate.mjs'],
  })
  assert.equal(facets?.rootCause ?? null, null, 'the noun "cause" does not attribute a cause')

  // The genuine verb form still works.
  const real = extractCausalFacets({
    user: 'The suite is failing.',
    assistant: 'The stale counter in retry.mjs causes the fourth attempt to reuse its result.',
    tools: evidence,
    files: ['src/retry.mjs'],
  })
  assert.match(real.facets?.rootCause ?? '', /stale counter in retry\.mjs/)
})
