import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { handleVeyraCommand } from '../src/commands.mjs'
import { CodeIntelligenceEngine } from '../src/code/engine.mjs'
import { closeAllStores, openProjectStore } from '../src/store.mjs'
import { projectIdFor } from '../src/ids.mjs'
import { AUTHORITIES, CONFIDENCES, KINDS, VALIDATIONS } from '../src/types.mjs'

test('/veyra code status returns status summary and memory freshness counts', async () => {
  const tmpHome = mkdtempSync(join(tmpdir(), 'veyra-cmd-home-'))
  const tmpRepo = mkdtempSync(join(tmpdir(), 'veyra-cmd-repo-'))

  try {
    writeFileSync(join(tmpRepo, 'service.js'), 'export function run() {}\n')
    const projectId = projectIdFor(tmpRepo)
    const store = openProjectStore(tmpHome, projectId)

    store.put({
      id: 'mem_1',
      title: 'Service runner',
      body: 'Verified run function',
      kind: KINDS.MEMORY,
      scope: 'project',
      authority: AUTHORITIES.DERIVED,
      confidence: CONFIDENCES.HIGH,
      validation: VALIDATIONS.VERIFIED,
      evidence: [
        { path: 'service.js', note: 'sym:run' },
      ],
    })

    const runtime = {
      veyraHome: tmpHome,
      fallbackCwd: tmpRepo,
      codeEngine: new CodeIntelligenceEngine({ exePath: '/nonexistent/bin' }),
    }

    const invocation = {
      rawInput: 'code status',
      agent: { session: { cwd: tmpRepo } },
    }

    const res = await handleVeyraCommand(runtime, invocation)
    assert.equal(res.kind, 'success')
    assert.match(res.text, /Code Intelligence Status/)
    assert.match(res.text, /1 fresh/)
    assert.match(res.text, /0 potentially stale/)
    assert.match(res.text, /0 invalid/)
  } finally {
    closeAllStores()
    rmSync(tmpHome, { recursive: true, force: true })
    rmSync(tmpRepo, { recursive: true, force: true })
  }
})

test('/veyra code trace and impact handle degraded mode gracefully', async () => {
  const tmpHome = mkdtempSync(join(tmpdir(), 'veyra-cmd-home-'))
  const tmpRepo = mkdtempSync(join(tmpdir(), 'veyra-cmd-repo-'))

  try {
    const runtime = {
      veyraHome: tmpHome,
      fallbackCwd: tmpRepo,
      codeEngine: new CodeIntelligenceEngine({ exePath: '/nonexistent/bin' }),
    }

    const traceMissingArg = await handleVeyraCommand(runtime, {
      rawInput: 'code trace',
      agent: { session: { cwd: tmpRepo } },
    })
    assert.equal(traceMissingArg.kind, 'error')
    assert.match(traceMissingArg.text, /Usage: \/veyra code trace <symbol>/)

    const traceDegraded = await handleVeyraCommand(runtime, {
      rawInput: 'code trace myFunc',
      agent: { session: { cwd: tmpRepo } },
    })
    assert.equal(traceDegraded.kind, 'error')
    assert.match(traceDegraded.text, /Code intelligence degraded|Binary not available/i)

    const impactNoArg = await handleVeyraCommand(runtime, {
      rawInput: 'code impact',
      agent: { session: { cwd: tmpRepo } },
    })
    assert.equal(impactNoArg.kind, 'success')
    assert.match(impactNoArg.text, /All memory code anchors are fresh/)

    const impactWithArg = await handleVeyraCommand(runtime, {
      rawInput: 'code impact src/index.js',
      agent: { session: { cwd: tmpRepo } },
    })
    assert.equal(impactWithArg.kind, 'success')
    assert.match(impactWithArg.text, /No memories affected by changes to: src\/index\.js/)

    const unknownSub = await handleVeyraCommand(runtime, {
      rawInput: 'code unknown_command',
      agent: { session: { cwd: tmpRepo } },
    })
    assert.equal(unknownSub.kind, 'error')
    assert.match(unknownSub.text, /Usage: \/veyra code \[status\|index\|trace\|impact\]/)
  } finally {
    closeAllStores()
    rmSync(tmpHome, { recursive: true, force: true })
    rmSync(tmpRepo, { recursive: true, force: true })
  }
})
