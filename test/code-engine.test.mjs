import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { CodeIntelligenceEngine } from '../src/code/engine.mjs'
import { CodebaseMemoryClient } from '../src/code/client.mjs'
import { INDEX_STATUS } from '../src/code/types.mjs'

test('engine returns degraded status when client is unavailable', async () => {
  const mockClient = new CodebaseMemoryClient({ exePath: '/nonexistent' })
  const engine = new CodeIntelligenceEngine({ client: mockClient })

  const status = await engine.getStatus('/any/repo')
  assert.equal(status.status, INDEX_STATUS.DEGRADED)
  assert.equal(status.degraded, true)

  const sym = await engine.searchSymbols('/any/repo', { query: 'test' })
  assert.equal(sym.ok, false)
  assert.equal(sym.degraded, true)
})

test('engine rejects getCodeSnippet targeting path outside repository boundary', async () => {
  const engine = new CodeIntelligenceEngine({ client: { isAvailable: true } })
  const res = await engine.getCodeSnippet('/repo/root', { file_path: '../../etc/passwd' })
  assert.equal(res.ok, false)
  assert.ok(res.message.includes('outside repository boundary'))
})

test('engine indexes repository and retrieves symbols when binary is available', async (t) => {
  const engine = new CodeIntelligenceEngine()
  if (engine.isDegraded) {
    t.skip('binary not available')
    return
  }

  t.after(() => engine.client.stop())

  const tmp = mkdtempSync(join(tmpdir(), 'veyra-cbm-test-'))
  t.after(() => rmSync(tmp, { recursive: true, force: true }))

  mkdirSync(join(tmp, 'src'))
  writeFileSync(join(tmp, 'src', 'math.js'), 'export function addNumbers(a, b) { return a + b; }\n')

  const res = await engine.indexRepository(tmp)
  assert.equal(res.status, INDEX_STATUS.READY)
  assert.equal(res.degraded, false)

  const symRes = await engine.searchSymbols(tmp, { query: 'addNumbers' })
  assert.equal(symRes.ok, true)
  assert.ok(symRes.message.includes('addNumbers'))

  const snipRes = await engine.getCodeSnippet(tmp, { qualified_name: 'addNumbers' })
  assert.equal(snipRes.ok, true)
  assert.ok(snipRes.snippet.includes('addNumbers'))
})

test('engine incremental update indexes new file with real binary', async (t) => {
  const engine = new CodeIntelligenceEngine()
  if (engine.isDegraded) {
    t.skip('binary not available')
    return
  }
  t.after(() => engine.client.stop())

  const tmp = mkdtempSync(join(tmpdir(), 'veyra-cbm-inc-'))
  t.after(() => rmSync(tmp, { recursive: true, force: true }))

  mkdirSync(join(tmp, 'src'))
  writeFileSync(join(tmp, 'src', 'first.js'), 'export function originalFn() { return 1; }\n')

  await engine.indexRepository(tmp)

  // Add a new file incrementally
  writeFileSync(join(tmp, 'src', 'second.js'), 'export function incrementalFn() { return 2; }\n')

  const incRes = await engine.indexIncremental(tmp, { added: ['src/second.js'] })
  assert.equal(incRes.ok, true)

  const sym = await engine.searchSymbols(tmp, { query: 'incrementalFn' })
  assert.equal(sym.ok, true)
  assert.ok(sym.message.includes('incrementalFn'))
})

test('engine recovers transparently when background process is terminated', async (t) => {
  const engine = new CodeIntelligenceEngine()
  if (engine.isDegraded) {
    t.skip('binary not available')
    return
  }
  t.after(() => engine.client.stop())

  const tmp = mkdtempSync(join(tmpdir(), 'veyra-cbm-recover-'))
  t.after(() => rmSync(tmp, { recursive: true, force: true }))

  mkdirSync(join(tmp, 'src'))
  writeFileSync(join(tmp, 'src', 'code.js'), 'export function aliveCheck() { return true; }\n')

  await engine.indexRepository(tmp)

  // Verify alive
  const beforeSym = await engine.searchSymbols(tmp, { query: 'aliveCheck' })
  assert.equal(beforeSym.ok, true)

  // Force-kill the child process
  if (engine.client.child) {
    engine.client.child.kill('SIGKILL')
  }

  // Small delay for OS process cleanup
  await new Promise((r) => setTimeout(r, 100))

  // Next query must respawn and succeed
  const afterSym = await engine.searchSymbols(tmp, { query: 'aliveCheck' })
  assert.equal(afterSym.ok, true)
  assert.ok(afterSym.message.includes('aliveCheck'))
})

test('engine preserves project isolation across separate repositories', async (t) => {
  const engine = new CodeIntelligenceEngine()
  if (engine.isDegraded) {
    t.skip('binary not available')
    return
  }
  t.after(() => engine.client.stop())

  const repoA = mkdtempSync(join(tmpdir(), 'veyra-cbm-repoA-'))
  const repoB = mkdtempSync(join(tmpdir(), 'veyra-cbm-repoB-'))
  t.after(() => {
    rmSync(repoA, { recursive: true, force: true })
    rmSync(repoB, { recursive: true, force: true })
  })

  mkdirSync(join(repoA, 'src'))
  mkdirSync(join(repoB, 'src'))
  writeFileSync(join(repoA, 'src', 'apple.js'), 'export function appleFruit() { return "apple"; }\n')
  writeFileSync(join(repoB, 'src', 'banana.js'), 'export function bananaFruit() { return "banana"; }\n')

  await engine.indexRepository(repoA)
  await engine.indexRepository(repoB)

  // repoA should have appleFruit and not bananaFruit
  const resA = await engine.searchSymbols(repoA, { query: 'bananaFruit' })
  assert.equal(resA.ok, true)
  assert.ok(!resA.message.includes('bananaFruit'), 'repoA must not contain bananaFruit')

  // repoB should have bananaFruit
  const resB = await engine.searchSymbols(repoB, { query: 'bananaFruit' })
  assert.equal(resB.ok, true)
  assert.ok(resB.message.includes('bananaFruit'), 'repoB must contain bananaFruit')
})
