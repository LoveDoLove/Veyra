import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { resolveEvalOutput, publishEvalResult } from './helpers/eval-output.mjs'

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'veyra-eval-output-'))
}

test('VEYRA_EVAL_WRITE_TRACKED=0 prevents tracked/default artifact write', () => {
  const dir = tmpDir()
  const trackedPath = path.join(dir, 'tracked', 'results.json')
  const runPath = path.join(dir, 'run', 'results.json')
  fs.mkdirSync(path.dirname(trackedPath), { recursive: true })
  fs.writeFileSync(trackedPath, '{"existing":true}\n')
  const plan = resolveEvalOutput({
    trackedPath,
    runPath,
    argv: ['node', 'harness.mjs'],
    env: { VEYRA_EVAL_WRITE_TRACKED: '0' },
    cwd: dir,
  })
  assert.equal(plan.tracked.action, 'skip')
  assert.match(plan.tracked.reason, /VEYRA_EVAL_WRITE_TRACKED=0/)
  assert.deepEqual(plan.destinations.map((d) => d.kind), ['run'])
  assert.equal(plan.explicitPath, null)
})

test('explicit isolated output path is used and tracked artifact is not overwritten', () => {
  const dir = tmpDir()
  const trackedPath = path.join(dir, 'test', 'eval-v0169-results.json')
  const runPath = path.join(dir, 'run', 'results.json')
  const explicit = path.join(dir, 'tmp-out', 'results.json')
  fs.mkdirSync(path.dirname(trackedPath), { recursive: true })
  fs.writeFileSync(trackedPath, '{"tracked":"before"}\n')
  const logs = []
  const out = publishEvalResult({ ok: true, n: 1 }, {
    trackedPath,
    runPath,
    argv: ['node', 'harness.mjs', '--output', explicit],
    env: {},
    cwd: dir,
    logger: (m) => logs.push(m),
  })
  assert.equal(out.tracked.action, 'skip')
  assert.match(out.tracked.reason, /explicit --output/)
  assert.deepEqual(out.destinations.map((d) => d.kind), ['run', 'explicit'])
  assert.ok(fs.existsSync(runPath))
  assert.ok(fs.existsSync(explicit))
  assert.equal(fs.readFileSync(trackedPath, 'utf8'), '{"tracked":"before"}\n')
  assert.deepEqual(JSON.parse(fs.readFileSync(explicit, 'utf8')), { ok: true, n: 1 })
  assert.ok(logs.some((l) => l.includes('explicit output: ' + explicit)))
  assert.ok(logs.some((l) => l.includes('tracked artifact skipped:')))
})

test('default does not silently overwrite an existing tracked evaluation artifact', () => {
  const dir = tmpDir()
  const trackedPath = path.join(dir, 'test', 'eval-v0169-results.json')
  const runPath = path.join(dir, 'run', 'results.json')
  fs.mkdirSync(path.dirname(trackedPath), { recursive: true })
  fs.writeFileSync(trackedPath, '{"tracked":"keep"}\n')
  const out = publishEvalResult({ ok: false }, {
    trackedPath,
    runPath,
    argv: ['node', 'harness.mjs'],
    env: {},
    cwd: dir,
    logger: () => {},
  })
  assert.equal(out.tracked.action, 'skip')
  assert.match(out.tracked.reason, /tracked artifact exists/)
  assert.match(out.tracked.reason, /VEYRA_EVAL_WRITE_TRACKED=1/)
  assert.ok(fs.existsSync(runPath))
  assert.equal(fs.readFileSync(trackedPath, 'utf8'), '{"tracked":"keep"}\n')
  assert.deepEqual(out.written.map((d) => d.kind), ['run'])
})

test('VEYRA_EVAL_WRITE_TRACKED=1 authorizes tracked artifact write', () => {
  const dir = tmpDir()
  const trackedPath = path.join(dir, 'test', 'eval-v0169-results.json')
  const runPath = path.join(dir, 'run', 'results.json')
  fs.mkdirSync(path.dirname(trackedPath), { recursive: true })
  fs.writeFileSync(trackedPath, '{"tracked":"old"}\n')
  const out = publishEvalResult({ ok: 'new' }, {
    trackedPath,
    runPath,
    argv: ['node', 'harness.mjs'],
    env: { VEYRA_EVAL_WRITE_TRACKED: '1' },
    cwd: dir,
    logger: () => {},
  })
  assert.equal(out.tracked.action, 'write')
  assert.deepEqual(out.written.map((d) => d.kind).sort(), ['run', 'tracked'])
  assert.deepEqual(JSON.parse(fs.readFileSync(trackedPath, 'utf8')), { ok: 'new' })
})

test('VEYRA_EVAL_OUTPUT provides an explicit isolated output path', () => {
  const dir = tmpDir()
  const trackedPath = path.join(dir, 'tracked.json')
  const runPath = path.join(dir, 'run.json')
  const explicit = path.join(dir, 'isolated.json')
  fs.writeFileSync(trackedPath, '{"tracked":1}\n')
  const plan = resolveEvalOutput({
    trackedPath,
    runPath,
    argv: ['node', 'harness.mjs'],
    env: { VEYRA_EVAL_OUTPUT: explicit },
    cwd: dir,
  })
  assert.equal(plan.explicitPath, explicit)
  assert.equal(plan.tracked.action, 'skip')
  assert.deepEqual(plan.destinations.map((d) => d.kind), ['run', 'explicit'])
})

test('missing tracked artifact can be created without overwrite risk', () => {
  const dir = tmpDir()
  const trackedPath = path.join(dir, 'new-results.json')
  const runPath = path.join(dir, 'run.json')
  const plan = resolveEvalOutput({
    trackedPath,
    runPath,
    argv: ['node', 'harness.mjs'],
    env: {},
    cwd: dir,
  })
  assert.equal(plan.tracked.action, 'write')
  assert.match(plan.tracked.reason, /missing/)
})

test('eval-v0169 tracked artifact path is never written when VEYRA_EVAL_WRITE_TRACKED=0 (harness output contract)', () => {
  const dir = tmpDir()
  const trackedPath = path.join(dir, 'test', 'eval-v0169-results.json')
  const runPath = path.join(os.tmpdir(), 'veyra-eval-v0169-fake-eval-v0169-results.json')
  fs.mkdirSync(path.dirname(trackedPath), { recursive: true })
  fs.writeFileSync(trackedPath, '{"preexisting":"snapshot"}\n')
  const logs = []
  const out = publishEvalResult({ harness: 'eval-v0169-ab', tasks: [] }, {
    trackedPath,
    runPath,
    argv: ['node', 'test/eval-v0169-ab.mjs'],
    env: { VEYRA_EVAL_WRITE_TRACKED: '0' },
    cwd: dir,
    logger: (m) => logs.push(m),
  })
  assert.equal(out.tracked.action, 'skip')
  assert.match(out.tracked.reason, /VEYRA_EVAL_WRITE_TRACKED=0/)
  assert.equal(fs.readFileSync(trackedPath, 'utf8'), '{"preexisting":"snapshot"}\n')
  assert.ok(logs.some((l) => l.includes('tracked artifact skipped:') && l.includes('eval-v0169-results.json')))
  try { fs.rmSync(runPath, { force: true }) } catch {}
})

test('eval-v0169 explicit isolated output writes only run+explicit, not tracked artifact', () => {
  const dir = tmpDir()
  const trackedPath = path.join(dir, 'test', 'eval-v0169-results.json')
  const runPath = path.join(dir, 'run', 'eval-v0169-results.json')
  const explicit = '/tmp/veyra-eval-v0169-isolated-test-output.json'
  fs.mkdirSync(path.dirname(trackedPath), { recursive: true })
  fs.writeFileSync(trackedPath, '{"keep":true}\n')
  const out = publishEvalResult({ harness: 'eval-v0169-ab' }, {
    trackedPath,
    runPath,
    argv: ['node', 'test/eval-v0169-ab.mjs', '--output', explicit],
    env: {},
    cwd: dir,
    logger: () => {},
  })
  assert.deepEqual(out.written.map((d) => d.kind), ['run', 'explicit'])
  assert.equal(fs.readFileSync(trackedPath, 'utf8'), '{"keep":true}\n')
  assert.equal(fs.readFileSync(explicit, 'utf8').includes('"eval-v0169-ab"'), true)
  try { fs.rmSync(explicit, { force: true }) } catch {}
})

test('explicit output resolving to protected tracked artifact is refused (cannot bypass tracked protection)', () => {
  const dir = tmpDir()
  const trackedPath = path.join(dir, 'test', 'eval-v0169-results.json')
  fs.mkdirSync(path.dirname(trackedPath), { recursive: true })
  fs.writeFileSync(trackedPath, '{"keep":true}\n')
  assert.throws(() => resolveEvalOutput({
    trackedPath,
    runPath: path.join(dir, 'run.json'),
    argv: ['node', 'harness', '--output', trackedPath],
    env: {},
    cwd: dir,
  }), /resolves to protected tracked artifact/)
  assert.equal(fs.readFileSync(trackedPath, 'utf8'), '{"keep":true}\n')
})

test('VEYRA_EVAL_WRITE_TRACKED=0 refuses runPath collision with protected tracked artifact', () => {
  const dir = tmpDir()
  const trackedPath = path.join(dir, 'test', 'eval-v0169-results.json')
  fs.mkdirSync(path.dirname(trackedPath), { recursive: true })
  fs.writeFileSync(trackedPath, '{"keep":true}\n')
  assert.throws(() => resolveEvalOutput({
    trackedPath,
    runPath: trackedPath,
    argv: [],
    env: { VEYRA_EVAL_WRITE_TRACKED: '0' },
    cwd: dir,
  }), /run artifact path resolves to protected tracked artifact/)
  assert.equal(fs.readFileSync(trackedPath, 'utf8'), '{"keep":true}\n')
})

test('explicit isolated outputs never resolve to protected tracked artifact in normal case', () => {
  const dir = tmpDir()
  const trackedPath = path.join(dir, 'tracked.json')
  const runPath = path.join(dir, 'run.json')
  const explicit = path.join(dir, 'explicit.json')
  const plan = resolveEvalOutput({
    trackedPath,
    runPath,
    argv: ['node', 'h', '--output', explicit],
    env: {},
    cwd: dir,
  })
  assert.equal(plan.tracked.action, 'skip')
  for (const d of plan.destinations) assert.notEqual(path.resolve(d.path), path.resolve(trackedPath))
  assert.deepEqual(plan.destinations.map((d) => d.kind), ['run', 'explicit'])
})

test('runPath and explicit output resolving to the same file is refused', () => {
  const dir = tmpDir()
  const trackedPath = path.join(dir, 'tracked.json')
  const same = path.join(dir, 'same-output.json')
  assert.throws(() => resolveEvalOutput({
    trackedPath,
    runPath: same,
    argv: ['node', 'harness', '--output', same],
    env: {},
    cwd: dir,
  }), /run artifact path and --output\/VEYRA_EVAL_OUTPUT resolve to the same file/)
})
