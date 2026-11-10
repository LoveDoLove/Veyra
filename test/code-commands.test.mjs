import { test } from 'node:test'
import assert from 'node:assert/strict'
import { rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { handleVeyraCommand } from '../src/commands.mjs'
import { CodeIntelligenceEngine } from '@lovedolove/dsh-codebase-memory-mcp'
import { closeAllStores } from '../src/store.mjs'
import { AUTHORITIES, CONFIDENCES, KINDS, VALIDATIONS } from '../src/types.mjs'
import { agentFor, roomIdFor, roomStore, testHome, testRuntime } from './helpers/room.mjs'

test('/veyra code status returns status summary and memory freshness counts', async (t) => {
  // Commands fail closed without a Memory Server, and memory is keyed by
  // workspace room: the seed store must be the room the runtime resolves.
  const tmpHome = testHome(t, 'veyra-cmd-home-')
  const tmpRepo = testHome(t, 'veyra-cmd-repo-')

  try {
    writeFileSync(join(tmpRepo, 'service.js'), 'export function run() {}\n')
    const projectId = roomIdFor(tmpRepo)
    const store = roomStore(tmpHome, tmpRepo)
    // The seed store must be the very room the runtime resolves for tmpRepo;
    // a mismatch would make the seeded record silently invisible.
    assert.equal(store.projectId, projectId)

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

    const runtime = testRuntime(tmpHome, tmpRepo, {
      codeEngine: new CodeIntelligenceEngine({ exePath: '/nonexistent/bin' }),
    })

    const invocation = {
      rawInput: 'code status',
      agent: agentFor(tmpRepo),
    }

    const res = await handleVeyraCommand(runtime, invocation)
    assert.equal(res.kind, 'success')
    assert.match(res.text, /Code Intelligence Status/)
    assert.match(res.text, /1 fresh/)
    assert.match(res.text, /0 potentially stale/)
    assert.match(res.text, /0 invalid/)
  } finally {
    closeAllStores()
    rmSync(tmpRepo, { recursive: true, force: true })
  }
})

test('/veyra code trace and impact handle degraded mode gracefully', async (t) => {
  // Degraded *engine* is the subject here, not a missing Memory Server: the
  // runtime still carries a real server so command dispatch is exercised for
  // the reason under test.
  const tmpHome = testHome(t, 'veyra-cmd-home-')
  const tmpRepo = testHome(t, 'veyra-cmd-repo-')

  try {
    const runtime = testRuntime(tmpHome, tmpRepo, {
      codeEngine: new CodeIntelligenceEngine({ exePath: '/nonexistent/bin' }),
    })

    const traceMissingArg = await handleVeyraCommand(runtime, {
      rawInput: 'code trace',
      agent: agentFor(tmpRepo),
    })
    assert.equal(traceMissingArg.kind, 'error')
    assert.match(traceMissingArg.text, /Usage: \/veyra code trace <symbol>/)

    const traceDegraded = await handleVeyraCommand(runtime, {
      rawInput: 'code trace myFunc',
      agent: agentFor(tmpRepo),
    })
    assert.equal(traceDegraded.kind, 'error')
    assert.match(traceDegraded.text, /Code intelligence degraded|Binary not available/i)

    const impactNoArg = await handleVeyraCommand(runtime, {
      rawInput: 'code impact',
      agent: agentFor(tmpRepo),
    })
    assert.equal(impactNoArg.kind, 'success')
    assert.match(impactNoArg.text, /All memory code anchors are fresh/)

    const impactWithArg = await handleVeyraCommand(runtime, {
      rawInput: 'code impact src/index.js',
      agent: agentFor(tmpRepo),
    })
    assert.equal(impactWithArg.kind, 'success')
    assert.match(impactWithArg.text, /No memories affected by changes to: src\/index\.js/)

    const unknownSub = await handleVeyraCommand(runtime, {
      rawInput: 'code unknown_command',
      agent: agentFor(tmpRepo),
    })
    assert.equal(unknownSub.kind, 'error')
    assert.match(unknownSub.text, /Usage: \/veyra code \[status\|index\|trace\|impact\]/)
  } finally {
    closeAllStores()
    rmSync(tmpRepo, { recursive: true, force: true })
  }
})
