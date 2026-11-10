/**
 * m00191 — Engineering Evidence Integrity & Learning Gate Reliability
 *
 * Two defects found by m00190, both reproduced here before they were fixed:
 *
 *  A7 — FILES TOUCHED LIED. `observeEvent` pushed `args.path` / `args.file_path`
 *       into `buffer.files` for EVERY interesting tool, and `distillBuffer` then
 *       merged in every path mentioned in prose. A session that only read
 *       `test/importer.test.mjs` produced a record claiming it had modified it.
 *       The record is the evidence a later agent reasons from, so a read must
 *       never be indistinguishable from a write.
 *
 *  A5 — THE GATE READ THE FORMAT INSTEAD OF THE TEXT. `IMPERATIVE_START` anchors
 *       on `^`, so "- Do not weaken the tests" missed the imperative branch while
 *       the same sentence as prose hit it. A bulleted task prompt was therefore
 *       classified as a user claim: `userAssertsClaim` true → `userContextOnly`
 *       never set → `provenanceAllowsLearning` false → the whole turn deferred
 *       and nothing was learned. Identical meaning, opposite governance outcome.
 *
 * These tests assert BOTH the text layer (where the defect lived) and the gate
 * layer (what the text layer is supposed to cause). Asserting only the gate
 * would be vacuous: other rules also defer, and a test that passes for the
 * wrong reason is what m06745 explicitly forbids.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { newBuffer, observeEvent, candidateFromBuffer } from '../src/observe.mjs'
import { distillBuffer, userAssertsClaim } from '../src/understand.mjs'
import { openEphemeralStore } from '../src/store.mjs'
import { writeGate, provenanceAllowsLearning } from '../src/learn.mjs'

// ---------------------------------------------------------------- A7 helpers

const turn = (user, { assistant = null, tools = [] } = {}) => {
  const buffer = newBuffer()
  observeEvent(buffer, {}, { type: 'turn/start', data: { turn: 1 } })
  if (user) {
    observeEvent(buffer, {}, { type: 'user/message', data: { content: [{ type: 'text', text: user }] } })
  }
  if (assistant) {
    observeEvent(buffer, {}, { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: assistant }] } } })
  }
  for (const tool of tools) {
    observeEvent(buffer, {}, { type: 'tool/call', data: { name: tool.name, arguments: tool.args } })
  }
  return buffer
}

const TASK = 'The importer test is failing. Find out why and fix it without changing the tests.'

// ================================================================ A7: evidence

test('A7: read tool leaves no modification evidence', () => {
  const buffer = turn(TASK, {
    tools: [{ name: 'read', args: { path: 'src/codec.mjs' } }],
  })
  assert.deepEqual([...buffer.files], [], 'reading a file is not changing it')
  const record = distillBuffer(buffer, { projectId: 'p_m191', sessionId: 's1' })
  assert.deepEqual(record.source.files, [])
  assert.ok(!record.body.includes('Files touched'), 'a read must not render a Files touched line')
})

test('A7: search tools (grep/glob) leave no modification evidence', () => {
  const buffer = turn(TASK, {
    tools: [
      { name: 'grep', args: { pattern: 'compileDecoder', path: 'src' } },
      { name: 'glob', args: { pattern: 'src/**/*.mjs' } },
    ],
  })
  assert.deepEqual([...buffer.files], [], 'searching a tree is not changing it')
  const record = distillBuffer(buffer, { projectId: 'p_m191', sessionId: 's1' })
  assert.deepEqual(record.source.files, [])
})

test('A7: bash leaves no modification evidence by itself', () => {
  const buffer = turn(TASK, {
    tools: [{ name: 'bash', args: { command: 'npm test' } }],
  })
  assert.deepEqual([...buffer.files], [])
})

test('A7: write tool records the modified file', () => {
  const buffer = turn(TASK, {
    tools: [{ name: 'write', args: { path: 'src/codec.mjs', content: 'x' } }],
  })
  assert.deepEqual([...buffer.files], ['src/codec.mjs'])
  const record = distillBuffer(buffer, { projectId: 'p_m191', sessionId: 's1' })
  assert.ok(record.source.files.includes('src/codec.mjs'))
  assert.ok(record.body.includes('Files touched: src/codec.mjs'))
})

test('A7: edit tool records the modified file, and still names the actual path', () => {
  const buffer = turn(TASK, {
    tools: [{ name: 'edit', args: { file_path: 'src/codec.mjs', old_string: 'a', new_string: 'b' } }],
  })
  assert.deepEqual([...buffer.files], ['src/codec.mjs'])
  const record = distillBuffer(buffer, { projectId: 'p_m191', sessionId: 's1' })
  assert.ok(record.source.files.includes('src/codec.mjs'))
  assert.ok(record.evidence.some((e) => e.path === 'src/codec.mjs'), 'a real change is a real anchor')
})

test('A7: str_replace_editor is a mutation, run_code only when it says it edits', () => {
  const editor = turn(TASK, { tools: [{ name: 'str_replace_editor', args: { path: 'src/a.mjs' } }] })
  assert.deepEqual([...editor.files], ['src/a.mjs'])

  const inspect = turn(TASK, {
    tools: [{ name: 'run_code', args: { description: 'inspect state', code: 'console.log(1)' } }],
  })
  assert.deepEqual([...inspect.files], [], 'opaque code that does not claim to edit is not evidence')

  // A run_code call that names a file but only READS it. The path is extractable,
  // so the only thing that can keep it out of modification evidence is the
  // "does this call mutate?" judgement itself — without this case, a mutation
  // that makes run_code always mutate would go unnoticed because `collectFiles`
  // would simply find no path to add.
  const readOnly = turn(TASK, {
    tools: [{ name: 'run_code', args: { description: 'inspect the cache', code: 'await tools.read({ file_path: "src/cache.ts" })' } }],
  })
  assert.deepEqual([...readOnly.files], [], 'reading through run_code is still reading')

  const mutate = turn(TASK, {
    tools: [{
      name: 'run_code',
      args: { description: 'Edit cache implementation', code: 'await tools.edit({ file_path: "src/cache.ts" })' },
    }],
  })
  assert.deepEqual([...mutate.files], ['src/cache.ts'], 'an explicit edit inside run_code still counts')
})

test('A7: paths mentioned in prose never become modification evidence', () => {
  const buffer = turn(
    'The stale decoder lives in src/codec.mjs and the failing assertion is in test/importer.test.mjs.',
    {
      assistant: 'The root cause is in src/registry.mjs, which calls src/codec.mjs with the wrong key.',
      tools: [{ name: 'read', args: { path: 'src/codec.mjs' } }],
    },
  )
  assert.deepEqual([...buffer.files], [], 'prose paths are references, not writes')
  const record = distillBuffer(buffer, { projectId: 'p_m191', sessionId: 's1' })
  assert.deepEqual(record.source.files, [], 'a named file is not a changed file')
  assert.ok(!record.body.includes('Files touched'), 'no fabricated modification line')
})

test('A7: no tool activity at all leaves source.files empty', () => {
  const buffer = turn(TASK, { assistant: 'The root cause is the shared cache keyed only by codec.' })
  const record = distillBuffer(buffer, { projectId: 'p_m191', sessionId: 's1' })
  assert.deepEqual(record?.source?.files ?? [], [])
})

test('A7: a read-then-edit session reports only the edited file', () => {
  const buffer = turn(TASK, {
    tools: [
      { name: 'read', args: { path: 'test/importer.test.mjs' } },
      { name: 'grep', args: { pattern: 'compileDecoder', path: 'src' } },
      { name: 'edit', args: { file_path: 'src/codec.mjs', old_string: 'a', new_string: 'b' } },
    ],
  })
  assert.deepEqual([...buffer.files], ['src/codec.mjs'], 'the read file must not survive as a change')
  const record = distillBuffer(buffer, { projectId: 'p_m191', sessionId: 's1' })
  assert.deepEqual(record.source.files, ['src/codec.mjs'])
  assert.ok(!record.body.includes('test/importer.test.mjs'), 'the read file is not claimed as touched')
})

test('A7: tools keep their names even when they cannot modify', () => {
  const buffer = turn(TASK, {
    tools: [
      { name: 'read', args: { path: 'src/codec.mjs' } },
      { name: 'bash', args: { command: 'npm test' } },
    ],
  })
  const names = buffer.tools.map((t) => t.name)
  assert.deepEqual(names, ['read', 'bash'], 'observation evidence is preserved, only modification evidence changed')
  const record = distillBuffer(buffer, { projectId: 'p_m191', sessionId: 's1' })
  assert.ok(record.body.includes('Tools:'), 'the tool line still documents what the agent did')
})

// =================================================================== A5: gate

const INSTRUCTIONS = [
  'Do not weaken the tests.',
  'Find out the cause of the failure.',
  'Run the suite and confirm it passes.',
]

const CLAIMS = [
  'The root cause is the missing mutex. The fix is to add it.',
  'We decided to always serialize writes through a single mutex.',
]

const FORMATS = {
  prose: (lines) => lines.join(' '),
  dash: (lines) => lines.map((l) => `- ${l}`).join('\n'),
  star: (lines) => lines.map((l) => `* ${l}`).join('\n'),
  plus: (lines) => lines.map((l) => `+ ${l}`).join('\n'),
  numbered: (lines) => lines.map((l, i) => `${i + 1}. ${l}`).join('\n'),
  numberedParen: (lines) => lines.map((l, i) => `${i + 1}) ${l}`).join('\n'),
  // Markdown task-list checkboxes (m00191 addendum). Task syntax is typesetting
  // exactly like the bullet itself, so all three states must judge identically
  // to the bare bullet and to prose.
  'dash-open': (lines) => lines.map((l) => `- [ ] ${l}`).join('\n'),
  'dash-done': (lines) => lines.map((l) => `- [x] ${l}`).join('\n'),
  'dash-DONE': (lines) => lines.map((l) => `- [X] ${l}`).join('\n'),
  'star-open': (lines) => lines.map((l) => `* [ ] ${l}`).join('\n'),
  'star-done': (lines) => lines.map((l) => `* [x] ${l}`).join('\n'),
  'plus-open': (lines) => lines.map((l) => `+ [ ] ${l}`).join('\n'),
  'numbered-open': (lines) => lines.map((l, i) => `${i + 1}. [ ] ${l}`).join('\n'),
}

/** Only the task-checkbox renderings, for tests that are specifically about them. */
const CHECKBOX_FORMATS = Object.fromEntries(
  Object.entries(FORMATS).filter(([name]) => name.includes('open') || name.includes('done') || name.includes('DONE') || name === 'plus-open'),
)

test('A5: instructions are not user claims in ANY list format', () => {
  for (const [name, render] of Object.entries(FORMATS)) {
    assert.equal(
      userAssertsClaim(render(INSTRUCTIONS)),
      false,
      `${name} formatting must not turn an instruction into a user assertion`,
    )
  }
})

test('A5: declarative claims are user claims in EVERY list format', () => {
  for (const [name, render] of Object.entries(FORMATS)) {
    assert.equal(
      userAssertsClaim(render(CLAIMS)),
      true,
      `${name} formatting must not hide a real user assertion`,
    )
  }
})

test('A5: identical meaning gives an identical verdict across formats', () => {
  // The property, stated once: the verdict is a function of the text, not of
  // how the text was laid out.
  for (const corpus of [INSTRUCTIONS, CLAIMS]) {
    const verdicts = Object.values(FORMATS).map((render) => userAssertsClaim(render(corpus)))
    assert.equal(new Set(verdicts).size, 1, `every format must agree, got ${JSON.stringify(verdicts)}`)
  }
})

test('A5: normalisation does not loosen the gate — claim hints are still required', () => {
  // A bulleted sentence with no claim hint stays a non-claim even though the
  // marker was stripped. This proves the fix is marker-stripping and not a
  // blanket "everything is an instruction" widening.
  assert.equal(userAssertsClaim('- Add a null check to the parser before the loop runs.'), false)
  // And an imperative stays imperative even when it contains a claim word.
  assert.equal(userAssertsClaim('- Do not introduce a race in the writer path.'), false)
  // A genuinely declarative sentence still registers.
  assert.equal(userAssertsClaim('- There is a race in the writer path because the lock is released early.'), true)
})

test('A5: mixed list is judged sentence by sentence, not by its first line', () => {
  const mixed = '- Do not weaken the tests.\n- The root cause is the shared cache keyed only by codec.\n- Run the suite.'
  assert.equal(userAssertsClaim(mixed), true, 'one real declaration in the list is still a declaration')
  const instructionsOnly = '- Do not weaken the tests.\n- Run the suite.\n- Find out the cause of the failure.'
  assert.equal(userAssertsClaim(instructionsOnly), false)
})

// ---------------------------------------- A5: markdown task-list checkboxes
// m00191 addendum. Task syntax (`- [ ]`, `- [x]`, `- [X]`) is typesetting like
// the bullet itself: it must not change how a sentence is governed. The first
// attempt failed exactly here — the bare bullet normalised but the checkbox did
// not, so `- [ ] Do not weaken the tests.` was still read as a claim.

test('A5: task checkboxes do not change how an instruction is judged', () => {
  const text = 'Do not weaken the tests.'
  assert.equal(userAssertsClaim(`- ${text}`), false, 'bare bullet')
  assert.equal(userAssertsClaim(`- [ ] ${text}`), false, 'open checkbox')
  assert.equal(userAssertsClaim(`- [x] ${text}`), false, 'done checkbox')
  assert.equal(userAssertsClaim(`- [X] ${text}`), false, 'done checkbox, capital X')
  assert.equal(userAssertsClaim(`* [ ] ${text}`), false, 'star open checkbox')
  assert.equal(userAssertsClaim(`* [x] ${text}`), false, 'star done checkbox')
  assert.equal(userAssertsClaim(`+ [ ] ${text}`), false, 'plus open checkbox')
  assert.equal(userAssertsClaim(`1. ${text}`), false, 'numbered')
  assert.equal(userAssertsClaim(`1. [ ] ${text}`), false, 'numbered open checkbox')
})

test('A5: a numbered task checkbox is stripped even though the splitter ate the marker', () => {
  // The sentence splitter breaks after `1.`, so a numbered task item reaches the
  // classifier already stripped of its list marker and starting at `[ ]`. That is
  // why the checkbox is removed as its own step rather than as an optional tail
  // on the list marker — otherwise this one layout stays broken.
  const sentences = '1. [ ] Do not weaken the tests.'
  assert.equal(userAssertsClaim(sentences), false, 'numbered task item is an instruction, not a claim')
  // A bare checkbox with no list marker cannot arise from splitting a real list,
  // but it must not become a claim either.
  assert.equal(userAssertsClaim('[ ] Do not weaken the tests.'), false, 'orphaned checkbox')
})

test('A5: task checkboxes do not change how a declarative claim is judged', () => {
  const claim = 'The root cause is the missing mutex. The fix is to add it.'
  for (const [name, render] of Object.entries(CHECKBOX_FORMATS)) {
    assert.equal(userAssertsClaim(render([claim])), true, `${name}: a real claim stays a claim`)
  }
})

test('A5: checkbox normalisation does not loosen the gate', () => {
  // Same non-loosening contract as the bullet form: checking a box must not turn
  // a non-claim into a claim, nor admit content the gate would otherwise refuse.
  assert.equal(userAssertsClaim('- [ ] Add a null check to the parser before the loop runs.'), false)
  assert.equal(userAssertsClaim('- [x] Do not introduce a race in the writer path.'), false)
  assert.equal(userAssertsClaim('- [ ] There is a race in the writer path because the lock is released early.'), true)
})

test('A5: every checkbox format agrees with prose, exactly', () => {
  const proseInstr = userAssertsClaim(INSTRUCTIONS.join(' '))
  const proseClaim = userAssertsClaim(CLAIMS.join(' '))
  for (const [name, render] of Object.entries(CHECKBOX_FORMATS)) {
    assert.equal(userAssertsClaim(render(INSTRUCTIONS)), proseInstr, `${name}: instructions must match prose`)
    assert.equal(userAssertsClaim(render(CLAIMS)), proseClaim, `${name}: claims must match prose`)
  }
})

// ------------------------------------------- A5: the gate follows the text layer

/**
 * Drive a real turn to the write gate. `user` is the only thing that changes
 * between formats, so any decision difference is the format's fault.
 */
const gateFor = (user) => {
  const buffer = turn(user, {
    assistant: 'The root cause is the shared compiled cache keyed only by codec. The fix is to key it on the full options.',
    tools: [
      { name: 'edit', args: { file_path: 'src/codec.mjs' } },
      { name: 'bash', args: { command: 'npm test' } },
    ],
  })
  observeEvent(buffer, {}, {
    type: 'tool/result',
    data: { name: 'bash', output: 'ok 16 tests passed\n[exit code: 0]' },
  })
  const candidate = candidateFromBuffer(buffer, { projectId: 'p_m191', sessionId: 's1' })
  const store = openEphemeralStore()
  try {
    const gate = writeGate(store, { ...candidate }, { workspace: process.cwd() })
    return { candidate, gate }
  } finally {
    store.close()
  }
}

test('A5: a prose instruction prompt is learnable and is ACCEPTed', () => {
  const { candidate, gate } = gateFor(FORMATS.prose(INSTRUCTIONS))
  assert.equal(candidate.source.userContextOnly, true, 'user context only, assistant supplied the knowledge')
  assert.equal(provenanceAllowsLearning(candidate), true)
  assert.equal(gate.decision, 'ACCEPT', `expected ACCEPT, got ${gate.decision}/${gate.reason}`)
})

test('A5: a bulleted instruction prompt reaches the SAME gate decision as prose', () => {
  const prose = gateFor(FORMATS.prose(INSTRUCTIONS))
  const bulleted = gateFor(FORMATS.dash(INSTRUCTIONS))
  assert.equal(bulleted.candidate.source.userContextOnly, true)
  assert.equal(
    bulleted.gate.decision,
    prose.gate.decision,
    'formatting must not change the governance outcome',
  )
  assert.equal(bulleted.gate.decision, 'ACCEPT')
})

test('A5: every list format reaches the same gate decision', () => {
  const decisions = Object.entries(FORMATS).map(([name, render]) => {
    const { gate } = gateFor(render(INSTRUCTIONS))
    return [name, gate.decision]
  })
  const distinct = new Set(decisions.map(([, d]) => d))
  assert.equal(distinct.size, 1, `all formats must agree, got ${JSON.stringify(decisions)}`)
  assert.deepEqual([...distinct], ['ACCEPT'])
})

test('A5: a genuinely claim-bearing prompt is STILL deferred (fix is not a bypass)', () => {
  // The regression direction that would be catastrophic: if normalisation had
  // loosened the gate, a real user-authored technical claim would start being
  // learned as if the agent had verified it. It must stay DEFERred.
  for (const [name, render] of Object.entries(FORMATS)) {
    const { candidate, gate } = gateFor(render(CLAIMS))
    assert.equal(candidate.source.userContextOnly, undefined, `${name}: claim-bearing turns are not user-context-only`)
    assert.equal(provenanceAllowsLearning(candidate), false, `${name}: claim-bearing turns are not learnable`)
    assert.equal(gate.decision, 'DEFER', `${name}: expected DEFER, got ${gate.decision}`)
    assert.equal(gate.reason, 'provenance-gated')
  }
})
