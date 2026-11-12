import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execSync } from 'node:child_process'
import { runAutonomyCycle } from './eval-autonomy-cycle.mjs'
import { testHome } from './helpers/room.mjs'

function fixtureRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'veyra-cycle-'))
  execSync('git init -q', { cwd: dir })
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true })
  fs.writeFileSync(path.join(dir, 'src', 'lock.mjs'), 'export function lockWriter() {}\n')
  execSync('git add -A && git -c user.name=veyra-eval -c user.email=veyra-eval@example.invalid commit -qm init', { cwd: dir })
  return dir
}

test('the cycle reports every headline metric', async (t) => {
  const home = testHome(t)
  const cwd = fixtureRepo()
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }))
  const r = await runAutonomyCycle({ home, cwd, turns: 3 })
  for (const k of ['tokensPerTurn', 'distinctSets', 'deliveryCoverage', 'mergeRate', 'proseSymbolLeaks']) {
    assert.equal(typeof r[k], 'number', `${k} missing`)
  }
  assert.ok(r.deliveryCoverage > 0, 'a veyra_recall dispatch must count as delivered')
  assert.equal(r.proseSymbolLeaks, 0, 'prose must not produce symbol evidence')
  assert.ok(r.mergeRate >= 0 && r.mergeRate <= 1, 'mergeRate must be a ratio')
})

test('a fresh room reports zero rather than throwing', async (t) => {
  const home = testHome(t)
  const cwd = fixtureRepo()
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }))
  const r = await runAutonomyCycle({ home, cwd, turns: 0, seed: false })
  assert.equal(r.tokensPerTurn, 0)
  assert.equal(r.distinctSets, 0)
  assert.equal(r.deliveryCoverage, 0)
  assert.equal(r.mergeRate, 0)
  assert.equal(r.ledger, null)
  assert.equal(r.generationSummary, null)
})
