import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { buildToolDefinitions, toRawOutputSchema } from '../src/tools.mjs'
import { findDshRoot, loadDshPackage, resolveDshPackage } from './helpers/dsh.mjs'

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
const DSH_RANGE = pkg.engines?.dsh
const PEER_RANGE = pkg.peerDependencies?.['@deepseek-ai/dsh-tools']

// --- DSH's own evaluation rule (dsh-app-boot evaluatePluginCompatibility):
// semver.satisfies(runtimeVersion, range, { includePrerelease: true }) for every
// peer whose key is `@deepseek-ai/dsh` or starts with `@deepseek-ai/dsh-`.
// This helper mirrors that rule for the `>=A <B` line ranges this repo declares,
// so the always-on tests below fail loudly if a range stops admitting a release.

function compareIdentifiers (a, b) {
  const an = /^\d+$/.test(a)
  const bn = /^\d+$/.test(b)
  if (an && bn) return Math.sign(Number(a) - Number(b))
  if (an !== bn) return an ? -1 : 1 // numeric identifiers rank below alphanumeric ones
  return a < b ? -1 : a > b ? 1 : 0
}

function compareVersions (a, b) {
  const parse = (v) => {
    const [core, pre = ''] = String(v).split('-')
    const [maj, min, pat] = core.split('.').map((n) => Number(n))
    assert.ok([maj, min, pat].every(Number.isFinite), `not a version: ${v}`)
    return { core: [maj, min, pat], pre }
  }
  const av = parse(a)
  const bv = parse(b)
  for (let i = 0; i < 3; i++) {
    if (av.core[i] !== bv.core[i]) return Math.sign(av.core[i] - bv.core[i])
  }
  if (av.pre === bv.pre) return 0
  if (av.pre === '') return 1 // no prerelease outranks any prerelease of the same core
  if (bv.pre === '') return -1
  const at = av.pre.split('.')
  const bt = bv.pre.split('.')
  for (let i = 0; i < Math.max(at.length, bt.length); i++) {
    if (at[i] === undefined) return -1 // shorter prerelease list sorts first
    if (bt[i] === undefined) return 1
    const c = compareIdentifiers(at[i], bt[i])
    if (c !== 0) return c
  }
  return 0
}

function satisfiesIncludePrerelease (version, range) {
  assert.equal(typeof range, 'string', 'declared range must be a string')
  const comparators = range.trim().split(/\s+/).filter(Boolean)
  assert.ok(comparators.length >= 1, `unsupported range shape: ${range}`)
  for (const comparator of comparators) {
    const m = /^(>=|<=|>|<|=)\s*(.+)$/.exec(comparator)
    assert.ok(m, `unsupported comparator in range: ${comparator} (range: ${range})`)
    const [, op, target] = m
    const c = compareVersions(version, target)
    const ok = {
      '>=': c >= 0,
      '<=': c <= 0,
      '>': c > 0,
      '<': c < 0,
      '=': c === 0,
    }[op]
    if (!ok) return false
  }
  return true
}

// --- Locate an installed DSH (shared helper); null => gated tests skip.

const dsh = findDshRoot()

// --- Always-on: the declared compatibility contract must admit DSH 0.2.0-rc.2.

test('declared ranges admit 0.2.0-rc.2 under DSH\'s prerelease evaluation rule', () => {
  assert.equal(typeof PEER_RANGE, 'string', 'peerDependencies["@deepseek-ai/dsh-tools"] must exist')
  assert.equal(typeof DSH_RANGE, 'string', 'engines.dsh must declare the supported DSH range')
  for (const [label, range] of [['peer @deepseek-ai/dsh-tools', PEER_RANGE], ['engines.dsh', DSH_RANGE]]) {
    for (const admitted of ['0.2.0-rc.2', '0.2.0-rc.1', '0.2.0', '0.1.7-rc.2', '0.1.2-rc.1']) {
      assert.ok(satisfiesIncludePrerelease(admitted, range), `${label} ${range} must admit ${admitted}`)
    }
    for (const rejected of ['0.1.1', '0.3.0-0', '0.3.0-alpha.1']) {
      assert.ok(!satisfiesIncludePrerelease(rejected, range), `${label} ${range} must reject ${rejected}`)
    }
  }
})

test('manifest declares no unsupported compatibility fields', () => {
  // DSH reads `engines.dsh`, or peerDependencies when that is absent; it never
  // reads `dsh.compatibility` (no consumer exists in the harness or the runtime).
  // Declaring it created a compatibility matrix that silently never gated anything.
  assert.equal(pkg.dsh.compatibility, undefined, 'dsh.compatibility has no DSH consumer')
  assert.match(pkg.engines.node, /^>=\d/)
})

// --- Real gate: DSH's own evaluatePluginCompatibility against an installed DSH.

const gateSkip = dsh ? false : 'no DSH install found (set DSH_INSTALL to run)'

test('real DSH compatibility gate accepts the Veyra manifest', { skip: gateSkip }, async () => {
  const boot = await loadDshPackage('@deepseek-ai/dsh-app-boot')
  assert.ok(boot, '@deepseek-ai/dsh-app-boot could not be imported')
  assert.equal(typeof boot.evaluatePluginCompatibility, 'function')
  const runtime = boot.getDshRuntimeVersion()
  assert.equal(runtime, dsh.version, 'resolved runtime version must match the installed dsh package')
  assert.ok(satisfiesIncludePrerelease(runtime, DSH_RANGE), `declared engines.dsh must cover the runtime ${runtime}`)

  const issue = boot.evaluatePluginCompatibility(pkg, {}, runtime)
  assert.equal(issue, undefined, issue ? boot.pluginCompatibilityWarning(issue) : 'gate accepted the manifest')

  // Negative controls: prove the gate can fail rather than passing vacuously.
  // `engines.dsh` decides ALONE when present, so both controls must target it.
  const staleEngines = { ...pkg, engines: { ...pkg.engines, dsh: '>=0.1.2-rc.1 <0.2.0-0' } }
  const denied = boot.evaluatePluginCompatibility(staleEngines, {}, runtime)
  assert.ok(denied, 'the old <0.2.0-0 range must still be denied by engines.dsh')
  assert.deepEqual(denied.requirements, { 'engines.dsh': '>=0.1.2-rc.1 <0.2.0-0' })
  assert.equal(denied.exempted, false)
  assert.equal(denied.runtimeVersion, runtime)

  // Peer fallback only applies when engines.dsh is absent.
  const peerOnly = { ...pkg, engines: { node: pkg.engines.node } }
  const stalePeer = {
    ...peerOnly,
    peerDependencies: { ...pkg.peerDependencies, '@deepseek-ai/dsh-tools': '>=0.1.2-rc.1 <0.2.0-0' },
  }
  const peerDenied = boot.evaluatePluginCompatibility(stalePeer, {}, runtime)
  assert.ok(peerDenied, 'the old <0.2.0-0 peer range must be denied when engines.dsh is absent')
  assert.deepEqual(peerDenied.requirements, { '@deepseek-ai/dsh-tools': '>=0.1.2-rc.1 <0.2.0-0' })
})

// --- Tool seam: every declared tool must compile under the real defineTool.

const defineToolSkip = resolveDshPackage('@deepseek-ai/dsh-tools') ? false : 'no DSH install found (set DSH_INSTALL to run)'

test('all tool definitions compile under the real defineTool', { skip: defineToolSkip }, async () => {
  const tools = await loadDshPackage('@deepseek-ai/dsh-tools')
  assert.ok(tools && typeof tools.defineTool === 'function', '@deepseek-ai/dsh-tools did not export defineTool')
  const defs = buildToolDefinitions({ veyraHome: '/tmp/veyra-compat-test-home', fallbackCwd: '/tmp' })
  assert.equal(defs.length, 11) // 10 veyra_* + veyra_code_status
  for (const def of defs) {
    const compiled = tools.defineTool(def)
    assert.ok(compiled, `defineTool rejected ${def.name}`)
    assert.ok(compiled.output?.schema, `${def.name} lost its output schema`)
    // Fallback parity: the raw-output projection must also compile.
    const projected = tools.defineTool({ ...def, output: { ...def.output, schema: toRawOutputSchema(def.output.schema) } })
    assert.ok(projected, `defineTool rejected the projected output schema for ${def.name}`)
  }
})
