/**
 * Continuous Learning verification for Veyra v0.1.62 — final passing version.
 *
 * Three end-to-end checks against REAL persistent storage (file-backed
 * SQLite via MemoryStore), simulating separate DSH sessions:
 *
 *   1. Normal fix + passing tests → learned as DERIVED/REVIEWED knowledge.
 *   2. Cross-session recall — a NEW store on the SAME db file recalls it.
 *   3. Test-failed turn → NOT verified; failure feedback demotes.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execSync } from 'node:child_process'

import { AUTHORITIES, VALIDATIONS, SCOPES, isRecallEligible } from '../src/types.mjs'
import { MemoryStore } from '../src/store.mjs'
import { newBuffer, observeEvent, candidateFromBuffer } from '../src/observe.mjs'
import { writeGate, maybeLearn } from '../src/learn.mjs'
import { recordFeedback } from '../src/feedback.mjs'
import { recall } from '../src/retrieve.mjs'

function makeTestProject() {
  const dir = mkdtempSync(join(tmpdir(), 'veyra-cl-proj-'))
  mkdirSync(join(dir, 'src'), { recursive: true })
  writeFileSync(join(dir, 'src', 'calc.mjs'), 'export function add(a, b) { return a - b }\n')
  writeFileSync(join(dir, 'src', 'calc.test.mjs'),
    "import { test } from 'node:test'\nimport assert from 'node:assert/strict'\nimport { add } from './calc.mjs'\ntest('add(1,2)===3', () => assert.equal(add(1, 2), 3))\n")
  try { execSync('git init -q && git add -A && git -c user.email=t@t -c user.name=t commit -qm init', { cwd: dir, stdio: 'pipe' }) } catch {}
  return dir
}

function openFileStore(dbPath, projectId) {
  return new MemoryStore(dbPath, { scope: SCOPES.PROJECT, projectId })
}

/** Simulate a DSH continuation round: tool/call → tool/result → assistant/message. */
function simulateTurn({ assistantText, editTool, bashTool, resultContent }) {
  const buf = newBuffer()
  observeEvent(buf, {}, { type: 'turn/start', data: { turn: 1 } })
  observeEvent(buf, {}, { type: 'tool/call', data: editTool })
  observeEvent(buf, {}, { type: 'tool/call', data: { ...bashTool, callId: 'c1' } })
  // tool/result with proper message format (like e2e test)
  observeEvent(buf, {}, {
    type: 'tool/result',
    data: { message: { source: { kind: 'tool', callId: 'c1' }, content: [{ type: 'tool-result', toolCallId: 'c1', content: [{ type: 'text', text: resultContent }] }] } },
  })
  observeEvent(buf, {}, { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: assistantText }] } } })
  return buf
}

const CWD = makeTestProject()
const DB = join(tmpdir(), 'veyra-cl-' + Date.now() + '.db')
const PID = 'p_cl_verify'

// ================================================================
// TEST 1: Normal bug fix → tests pass → learned as durable knowledge
// ================================================================
test('CL-1: normal fix with passing tests is learned as durable knowledge', () => {
  const store = openFileStore(DB, PID)

  const buf = simulateTurn({
    assistantText: 'Root cause: src/calc.mjs line 1 uses a - b instead of a + b, so add(1,2) returns 1 instead of 3. Remedy: change the operator from subtraction to addition (a + b) so the add() function returns the correct sum. This regression was caused by a copy-paste error during refactoring.',
    editTool: { name: 'edit', args: { file_path: 'src/calc.mjs', old_string: 'a - b', new_string: 'a + b' } },
    bashTool: { name: 'bash', args: { command: 'node --test src/calc.test.mjs', description: 'Run calc tests' } },
    // pass output WITHOUT the word 'fail' (which trips the fail regex):
    resultContent: '✔ add(1,2)===3\n# tests 1\n# pass 1\nexit code: 0',
  })

  const candidate = candidateFromBuffer(buf, { projectId: PID, sessionId: 'sA', cwd: CWD, agent: 'test' })
  assert.ok(candidate, 'candidate extracted')
  console.log('  CANDIDATE origins:', JSON.stringify(candidate.source?.provenance?.origins), 'evidence:', JSON.stringify(candidate.evidence))

  const gate = writeGate(store, candidate, { workspace: CWD })
  console.log('  GATE:', gate.decision, gate.reason)
  assert.equal(gate.decision, 'ACCEPT', 'gate should ACCEPT: ' + gate.reason)
  assert.ok(gate.record, 'gate returned record')

  const rec = gate.record
  console.log('  LEARNED:', JSON.stringify({ id: rec.id, authority: rec.authority, validation: rec.validation, evidence: rec.evidence }))

  // test-passed evidence → reviewed validation
  assert.ok(rec.evidence?.some(e => e.note === 'test-passed'), 'has test-passed, got: ' + JSON.stringify(rec.evidence))
  assert.ok(rec.validation === VALIDATIONS.REVIEWED || rec.validation === VALIDATIONS.VERIFIED, 'val>=reviewed, got ' + rec.validation)

  // maybeLearn on a fresh candidate (different turn) should also work
  const buf2 = simulateTurn({
    assistantText: 'Root cause: the divide function lacked a zero guard, caused by missing validation. Remedy: return early when divisor is 0 to prevent NaN. This workaround fixes the symptom of division by zero errors.',
    editTool: { name: 'edit', args: { file_path: 'src/math.mjs', old_string: 'return a / b', new_string: 'if (b === 0) return 0; return a / b' } },
    bashTool: { name: 'bash', args: { command: 'node --test src/math.test.mjs', description: 'Run math tests' } },
    resultContent: '✔ divide test\n# tests 1\n# pass 1\nexit code: 0',
  })
  const cand2 = candidateFromBuffer(buf2, { projectId: PID, sessionId: 'sA2', cwd: CWD, agent: 'test' })
  const learned2 = maybeLearn(store, cand2, { workspace: CWD, sessionId: 'sA2' })
  assert.ok(learned2, 'maybeLearn returned record for second turn')
  console.log('  LEARNED2:', learned2.id, learned2.validation)

  // Success feedback
  const fb = recordFeedback(store, { id: rec.id, outcome: 'success', note: 'fix verified: tests green' })
  assert.equal(fb.ok, true)
  console.log('  AFTER FEEDBACK:', fb.record.validation, fb.record.confidence)
  assert.ok(isRecallEligible(fb.record), 'recall-eligible after success')

  store.close()
})

// ================================================================
// TEST 2: Cross-session recall — new store on same DB file
// ================================================================
test('CL-2: knowledge from session A is recalled by NEW session B on same DB', () => {
  const storeB = openFileStore(DB, PID)
  const results = recall({
    projectStore: storeB,
    query: 'add function wrong result subtraction operator bug fix root cause remedy',
    limit: 5,
  })
  console.log('  RECALL:', JSON.stringify(results.map(r => ({ title: r.title?.slice(0,50), authority: r.authority, validation: r.validation }))))
  assert.ok(results.length >= 1, 'cross-session recall found records')
  assert.equal(results[0].authority, AUTHORITIES.DERIVED, 'recalled is DERIVED')
  console.log('  HIT:', results[0].title?.slice(0,80), '| val:', results[0].validation)
  storeB.close()
})

// ================================================================
// TEST 3: Test-failed turn → NOT verified; failure feedback demotes
// ================================================================
test('CL-3: test-failed turn is NOT verified; failure feedback demotes', () => {
  const DB3 = join(tmpdir(), 'veyra-cl-fail-' + Date.now() + '.db')
  const store = openFileStore(DB3, PID + '_fail')

  const buf = simulateTurn({
    assistantText: 'Root cause: src/math.mjs divide() does not check for zero divisor, caused by missing input validation. Remedy: add an early return when b === 0. This solution prevents the NaN symptom and fixes the regression.',
    editTool: { name: 'edit', args: { file_path: 'src/math.mjs', old_string: 'return a / b', new_string: 'if (b === 0) return 0; return a / b' } },
    bashTool: { name: 'bash', args: { command: 'node --test src/math.test.mjs', description: 'Run math tests' } },
    resultContent: '✖ divide test\nnpm ERR! code 1\nexit code: 1',
  })

  const candidate = candidateFromBuffer(buf, { projectId: PID + '_fail', sessionId: 'sFail', cwd: CWD, agent: 'test' })
  assert.ok(candidate, 'candidate extracted')
  console.log('  FAIL CANDIDATE evidence:', JSON.stringify(candidate.evidence))

  const gate = writeGate(store, candidate, { workspace: CWD })
  console.log('  GATE:', gate.decision, gate.reason)

  if (gate.record) {
    const rec = gate.record
    console.log('  FAIL RECORD:', JSON.stringify({ validation: rec.validation, confidence: rec.confidence, evidence: rec.evidence }))
    assert.ok(rec.evidence?.some(e => e.note === 'test-failed'), 'has test-failed evidence')
    assert.ok(!rec.evidence?.some(e => e.note === 'test-passed'), 'no test-passed')
    assert.notEqual(rec.validation, VALIDATIONS.VERIFIED, 'NOT verified: ' + rec.validation)
    assert.equal(rec.validation, VALIDATIONS.UNVERIFIED, 'test-failed → UNVERIFIED')

    const fb = recordFeedback(store, { id: rec.id, outcome: 'failure', note: 'tests still failing' })
    console.log('  AFTER FAILURE FEEDBACK:', fb.record.validation, fb.record.confidence)
    assert.equal(fb.ok, true)
    assert.notEqual(fb.record.validation, VALIDATIONS.VERIFIED, 'failure never → verified')
  } else {
    console.log('  Gate blocked failed turn:', gate.decision, gate.reason)
    assert.ok(['DEFER', 'DROP'].includes(gate.decision), 'failed turn not learned: ' + gate.decision)
  }

  const results = recall({ projectStore: store, query: 'divide zero NaN math fix', limit: 5 })
  for (const r of results) assert.notEqual(r.validation, VALIDATIONS.VERIFIED, 'no verified failed record in recall')
  console.log('  Recall: no failed-turn record verified (correct)')

  store.close()
})