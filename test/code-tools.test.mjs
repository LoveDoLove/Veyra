import { test } from 'node:test'
import assert from 'node:assert/strict'
import { rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { buildToolDefinitions, toRawOutputSchema } from '../src/tools.mjs'
import { CodeIntelligenceEngine } from '@lovedolove/dsh-codebase-memory-mcp'
import { closeAllStores } from '../src/store.mjs'
import { AUTHORITIES, CONFIDENCES, KINDS, VALIDATIONS } from '../src/types.mjs'
import { agentFor, roomIdFor, roomStore, testHome, testRuntime } from './helpers/room.mjs'

test('buildToolDefinitions includes veyra_code_status with a valid schema', (t) => {
  const runtime = testRuntime(testHome(t, 'veyra-tools-home-'), process.cwd(), {
    codeEngine: new CodeIntelligenceEngine({ exePath: '/nonexistent/bin' }),
  })
  const tools = buildToolDefinitions(runtime)

  assert.equal(tools.length, 11)
  assert.deepEqual(tools.filter((d) => d.name.startsWith('cbm_')), [])
  assert.ok(tools.some((d) => d.name === 'veyra_code_status'))

  for (const tool of tools) {
    assert.ok(tool.name, 'tool has name')
    assert.ok(tool.description, 'tool has description')
    assert.ok(typeof tool.execute === 'function', 'tool has execute fn')
    assert.ok(typeof tool.presentCall === 'function', 'tool has presentCall fn')
    if (tool.output?.schema) {
      const raw = toRawOutputSchema(tool.output.schema)
      assert.equal(typeof raw, 'object')
      assert.equal(raw.type, 'object')
    }
  }
})

test('veyra_code_status inspects memory freshness against repository workspace', async (t) => {
  // `args.repo` is resolved as a workspace, so the repo must be a REGISTERED
  // workspace and its memories must live in that workspace's room.
  const tmpHome = testHome(t, 'veyra-status-home-')
  const tmpRepo = testHome(t, 'veyra-status-repo-')

  try {
    writeFileSync(join(tmpRepo, 'index.js'), 'export function hello() { return "world"; }\n')
    const projectId = roomIdFor(tmpRepo)
    const store = roomStore(tmpHome, tmpRepo)
    // The seed store must be the very room the runtime resolves for tmpRepo;
    // a mismatch would make every seeded record silently invisible.
    assert.equal(store.projectId, projectId)

    store.put({
      id: 'mem_fresh_1',
      title: 'Fresh memory',
      body: 'Verified against index.js',
      kind: KINDS.MEMORY,
      scope: 'project',
      authority: AUTHORITIES.DERIVED,
      confidence: CONFIDENCES.HIGH,
      validation: VALIDATIONS.VERIFIED,
      evidence: [
        { path: 'index.js', note: 'sym:hello' },
      ],
    })

    store.put({
      id: 'mem_invalid_1',
      title: 'Invalid memory',
      body: 'References deleted file',
      kind: KINDS.MEMORY,
      scope: 'project',
      authority: AUTHORITIES.DERIVED,
      confidence: CONFIDENCES.HIGH,
      validation: VALIDATIONS.VERIFIED,
      evidence: [
        { path: 'deleted_file.js', note: 'sym:gone' },
      ],
    })

    const runtime = testRuntime(tmpHome, tmpRepo, {
      codeEngine: new CodeIntelligenceEngine({ exePath: '/nonexistent/bin' }),
    })
    const tools = new Map(buildToolDefinitions(runtime).map((t) => [t.name, t]))
    const statusTool = tools.get('veyra_code_status')
    const result = await statusTool.execute({ repo: tmpRepo }, { agent: agentFor(tmpRepo) })

    assert.equal(result.ok, true)
    assert.equal(result.freshMemories, 1)
    assert.equal(result.staleMemories, 0)
    assert.equal(result.invalidMemories, 1)

    const rendered = statusTool.output.render({}, result)
    assert.match(rendered[0].text, /1 fresh/)
    assert.match(rendered[0].text, /1 invalid/)
  } finally {
    closeAllStores()
    rmSync(tmpRepo, { recursive: true, force: true })
  }
})

test('veyra_code_status message is never null when engine returns no message field', async (t) => {
  const tmpHome = testHome(t, 'veyra-status-nullmsg-')
  const tmpRepo = testHome(t, 'veyra-status-nullmsg-repo-')
  try {
    // Simulate NOT_INDEXED path: engine returns object with no `message` field
    const engine = new CodeIntelligenceEngine({ exePath: '/nonexistent/bin' })
    engine.getStatus = async () => ({ status: 'not_indexed', degraded: false, ok: false })

    const runtime = testRuntime(tmpHome, tmpRepo, { codeEngine: engine })
    const tools = new Map(buildToolDefinitions(runtime).map((t) => [t.name, t]))
    const statusTool = tools.get('veyra_code_status')
    const result = await statusTool.execute({ repo: tmpRepo }, { agent: agentFor(tmpRepo) })

    assert.equal(result.ok, true)
    // DSH validates the JSON-serialised output against the schema. null serialises as null
    // (fails type:string); undefined serialises as absent (passes). Verify via the wire value.
    const wire = JSON.parse(JSON.stringify(result))
    assert.notEqual(wire.message, null, 'message must not be null in JSON output (DSH schema: type string)')
    if ('message' in wire) {
      assert.equal(typeof wire.message, 'string', 'message must be string when present in JSON output')
    }
  } finally {
    closeAllStores()
    rmSync(tmpRepo, { recursive: true, force: true })
  }
})

test('veyra_code_status raw output is lossless JSON when engine has no message field', async (t) => {
  // Regression: execute() used `message: status?.message || undefined`, creating an own
  // key with value `undefined` on the live not_indexed path. DSH snapshots the RAW value
  // (dsh-util-values snapshotJsonValue) before render/JSON round-trip, rejects it, and
  // fails with: tool "veyra_code_status" returned invalid output: value is not lossless JSON
  const tmpHome = testHome(t, 'veyra-status-lossless-')
  const tmpRepo = testHome(t, 'veyra-status-lossless-repo-')
  try {
    const engine = new CodeIntelligenceEngine({ exePath: '/nonexistent/bin' })
    // Actual getStatus() payload for a non-degraded, unindexed repo — no `message` key.
    engine.getStatus = async () => ({ status: 'not_indexed', degraded: false, lastIndexedAt: null, filesCount: 0 })

    const runtime = testRuntime(tmpHome, tmpRepo, { codeEngine: engine })
    const tools = new Map(buildToolDefinitions(runtime).map((t) => [t.name, t]))
    const statusTool = tools.get('veyra_code_status')
    const raw = await statusTool.execute({ repo: tmpRepo }, { agent: agentFor(tmpRepo) })

    // The exact offending type: own enumerable key holding `undefined`.
    assert.equal(Object.hasOwn(raw, 'message'), false, 'message key must be absent, not undefined')
    // Full-output losslessness, checked the way DSH does: no JSON round-trip first.
    assert.deepEqual(JSON.parse(JSON.stringify(raw)), raw, 'raw tool value must be lossless JSON')

    // Degraded path still carries its string message.
    engine.getStatus = async () => ({ status: 'degraded', degraded: true, message: 'Code intelligence binary unavailable; running in degraded mode' })
    const degraded = await statusTool.execute({ repo: tmpRepo }, { agent: agentFor(tmpRepo) })
    assert.equal(degraded.message, 'Code intelligence binary unavailable; running in degraded mode')
    assert.deepEqual(JSON.parse(JSON.stringify(degraded)), degraded, 'degraded raw value must be lossless JSON')

    // Render still works for both shapes.
    assert.ok(statusTool.output.render({}, raw)[0].text.includes('not_indexed'))
    assert.ok(statusTool.output.render({}, degraded)[0].text.includes('degraded'))
  } finally {
    closeAllStores()
    rmSync(tmpRepo, { recursive: true, force: true })
  }
})
