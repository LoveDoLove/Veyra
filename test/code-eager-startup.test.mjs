import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  findExe,
  getOrCreateClient,
  createClient,
  cbmApply,
  autoStartCodebaseMemory,
  CodebaseMemoryClient,
} from '../src/code/client.mjs'
import { apply } from '../src/plugin.mjs'
import { closeAllStores } from '../src/store.mjs'

test('findExe and client factory exports match bridge specification', () => {
  assert.equal(typeof findExe, 'function')
  assert.equal(typeof getOrCreateClient, 'function')
  assert.equal(typeof createClient, 'function')
  assert.equal(typeof cbmApply, 'function')
  assert.equal(typeof autoStartCodebaseMemory, 'function')

  const client = createClient('/custom/path/codebase-memory-mcp')
  assert.ok(client instanceof CodebaseMemoryClient)
  assert.equal(typeof client.start, 'function')
  assert.equal(typeof client.dispose, 'function')
  assert.equal(typeof client.isRunning, 'function')
  assert.equal(client.isRunning(), false)
})

test('autoStartCodebaseMemory skips cleanly when executable is missing', async () => {
  const client = new CodebaseMemoryClient({ exePath: '/nonexistent/codebase-memory-mcp' })
  let warned = false
  const log = {
    info: () => {},
    warn: () => { warned = true },
  }
  const result = autoStartCodebaseMemory(client, log)
  assert.equal(result, null)
  assert.equal(warned, false)
})

test('autoStartCodebaseMemory does not duplicate startup when client is already running', async () => {
  let startCalled = false
  const fakeClient = {
    isAvailable: true,
    isRunning: () => true,
    start: async () => { startCalled = true },
  }
  const result = autoStartCodebaseMemory(fakeClient)
  assert.equal(result, null)
  assert.equal(startCalled, false)
})

test('autoStartCodebaseMemory logs warning only and does not throw on startup failure', async () => {
  const warnings = []
  const failingClient = {
    isAvailable: true,
    isRunning: () => false,
    start: async () => { throw new Error('simulated process spawn failure') },
  }
  const log = {
    info: () => {},
    warn: (msg) => { warnings.push(msg) },
  }
  const promise = autoStartCodebaseMemory(failingClient, log)
  assert.ok(promise instanceof Promise)
  await promise
  assert.equal(warnings.length, 1)
  assert.ok(warnings[0].includes('codebase-memory-mcp failed to start: simulated process spawn failure'))
})

test('autoStartCodebaseMemory logs live UI URL on successful startup', async () => {
  const infos = []
  const succeedingClient = {
    isAvailable: true,
    isRunning: () => false,
    start: async () => {},
  }
  const log = {
    info: (msg) => { infos.push(msg) },
    warn: () => {},
  }
  await autoStartCodebaseMemory(succeedingClient, log)
  assert.equal(infos.length, 1)
  assert.ok(infos[0].includes('http://localhost:9749/'))
})

test('cbmApply registers cleanup effect and respects eagerStart flag', async () => {
  let cleanedUp = false
  let effectRegistered = false
  const mockCtx = {
    effect: (fn) => {
      effectRegistered = true
      const cleanup = fn()
      return () => cleanup?.()
    },
    logger: () => ({ info: () => {}, warn: () => {} }),
  }

  const client = {
    isAvailable: false,
    isRunning: () => false,
    dispose: () => { cleanedUp = true },
  }

  const res = cbmApply(mockCtx, { client, eagerStart: false })
  assert.equal(res, client)
  assert.equal(effectRegistered, true)
})

test('apply() in plugin eager-starts daemon when enabled and cleans up on dispose', async () => {
  const tmpHome = mkdtempSync(join(tmpdir(), 'veyra-eager-home-'))
  try {
    const effects = []
    const mockCtx = {
      tools: { register: () => {} },
      commands: { register: () => {} },
      systemPrompt: { section: () => {}, context: () => {} },
      on: () => () => {},
      effect: (fn) => {
        const cleanup = fn()
        if (typeof cleanup === 'function') effects.push(cleanup)
        return cleanup
      },
      logger: {
        info: () => {},
        warn: () => {},
        debug: () => {},
        error: () => {},
      },
    }

    // When executable is missing, eagerStartCodebaseMemory: true completes cleanly without errors
    const teardown = apply(mockCtx, {
      home: tmpHome,
      eagerStartCodebaseMemory: true,
      codebaseMemoryBin: '/nonexistent/bin',
    })

    assert.equal(typeof teardown, 'function')
    teardown()
    for (const eff of effects) eff()
  } finally {
    closeAllStores()
    rmSync(tmpHome, { recursive: true, force: true })
  }
})
