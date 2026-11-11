import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { loadCbmBridge, createDegradedEngine, resolveRepoPath, cbm } from '../src/cbm-bridge.mjs'
import { CODE_FRESHNESS } from '../src/types.mjs'

test('bridge exposes the full namespace when the package is installed', () => {
  const loaded = loadCbmBridge()
  assert.equal(loaded.available, true)
  for (const name of ['CodeIntelligenceEngine', 'RepositoryWatcher',
    'autoStartCodebaseMemory', 'findExe', 'getOrCreateClient', 'createClient',
    'cbmApply', 'closeAllWatchers', 'resolveSafeRepoPath', 'sanitizeCodeContent']) {
    assert.equal(typeof loaded[name], 'function', `${name} must be a function`)
  }
  assert.ok(Object.isFrozen(loaded))
})

test('bridge degrades to a frozen unavailable stub when the package cannot resolve', () => {
  const dir = mkdtempSync(join(tmpdir(), 'veyra-no-cbm-'))
  try {
    const loaded = loadCbmBridge({ requireFrom: join(dir, 'noop.mjs') })
    assert.equal(loaded.available, false)
    assert.equal(loaded.CodeIntelligenceEngine, null)
    assert.equal(loaded.RepositoryWatcher, null)
    assert.equal(loaded.resolveSafeRepoPath, null)
    assert.equal(loaded.sanitizeCodeContent, null)
    assert.equal(typeof loaded.closeAllWatchers, 'function')
    assert.deepEqual(loaded.FRESHNESS_STATUS, CODE_FRESHNESS)
    assert.ok(Object.isFrozen(loaded))
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('bridge never throws for a corrupt require base', () => {
  for (const base of ['', '\0bad\0path', '/nonexistent/深入/path.mjs']) {
    assert.doesNotThrow(() => loadCbmBridge({ requireFrom: base }))
    assert.equal(loadCbmBridge({ requireFrom: base }).available, false)
  }
})

test('upstream FRESHNESS_STATUS agrees with CODE_FRESHNESS', () => {
  if (!cbm.available) return // parity is only checkable when the package exists
  assert.deepEqual(cbm.FRESHNESS_STATUS, CODE_FRESHNESS)
})

test('degraded engine satisfies the complete codeEngine surface', async () => {
  const engine = createDegradedEngine()
  assert.equal(engine.isDegraded, true)
  assert.equal(engine.client.isAvailable, false)
  const s = await engine.getStatus('/tmp')
  assert.equal(s.status, 'degraded')
  assert.equal(s.degraded, true)
  for (const r of [await engine.searchSymbols('/tmp', {}), await engine.searchCodeText('/tmp', {}),
    await engine.traceCallPath('/tmp', {}), await engine.indexRepository('/tmp', {})]) {
    assert.equal(r.ok, false)
    assert.equal(r.degraded, true)
  }
  assert.doesNotThrow(() => engine.dispose())
})

test('resolveRepoPath returns null when no boundary authority exists', () => {
  const noBridge = { available: false, resolveSafeRepoPath: null }
  assert.equal(resolveRepoPath('/repo', '/repo/a.mjs', noBridge), null)
  const throwing = { available: true, resolveSafeRepoPath: () => { throw new Error('boom') } }
  assert.equal(resolveRepoPath('/repo', '/repo/a.mjs', throwing), null)
  const working = { available: true, resolveSafeRepoPath: () => 'a.mjs' }
  assert.equal(resolveRepoPath('/repo', '/repo/a.mjs', working), 'a.mjs')
})

test('bridge degrades instead of throwing when an export getter throws', () => {
  // A package whose main entry exposes a throwing enumerable getter must not
  // be able to kill plugin load: the export spread runs at module evaluation,
  // so an escape here would surface as a failed `import`, not a degraded engine.
  const dir = mkdtempSync(join(tmpdir(), 'veyra-malformed-cbm-'))
  try {
    const pkg = join(dir, 'node_modules', '@lovedolove', 'dsh-codebase-memory-mcp')
    mkdirSync(pkg, { recursive: true })
    writeFileSync(join(pkg, 'package.json'), JSON.stringify({
      name: '@lovedolove/dsh-codebase-memory-mcp',
      version: '9.9.9',
      main: 'index.cjs',
      exports: { '.': './index.cjs', './discovery': './discovery.cjs' },
    }))
    writeFileSync(join(pkg, 'index.cjs'), [
      "const api = { findExe: () => 'x' }",
      "Object.defineProperty(api, 'resolveSafeRepoPath', {",
      "  enumerable: true,",
      "  get() { throw new Error('malformed export') },",
      '})',
      'module.exports = api',
    ].join('\n'))
    writeFileSync(join(pkg, 'discovery.cjs'), "module.exports = { resolveSafeRepoPath: () => 'ok' }\n")

    let loaded
    assert.doesNotThrow(() => { loaded = loadCbmBridge({ requireFrom: join(dir, 'entry.mjs') }) })
    assert.equal(loaded.available, false)
    assert.equal(loaded.resolveSafeRepoPath, null)
    assert.ok(Object.isFrozen(loaded))
    assert.deepEqual(loaded.FRESHNESS_STATUS, CODE_FRESHNESS)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
