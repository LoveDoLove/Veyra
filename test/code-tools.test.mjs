import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildToolDefinitions, toRawOutputSchema } from '../src/tools.mjs'
import { CodeIntelligenceEngine } from '../src/code/engine.mjs'
import { openProjectStore, closeAllStores } from '../src/store.mjs'
import { projectIdFor } from '../src/ids.mjs'
import { AUTHORITIES, CONFIDENCES, KINDS, VALIDATIONS } from '../src/types.mjs'

test('buildToolDefinitions includes all 7 code intelligence tools with valid schemas', () => {
  const runtime = {
    veyraHome: '/tmp/test-home',
    fallbackCwd: process.cwd(),
    codeEngine: new CodeIntelligenceEngine({ exePath: '/nonexistent/bin' }),
  }
  const tools = buildToolDefinitions(runtime)
  const toolNames = tools.map((t) => t.name)

  assert.ok(toolNames.includes('cbm_projects'))
  assert.ok(toolNames.includes('cbm_search'))
  assert.ok(toolNames.includes('cbm_snippet'))
  assert.ok(toolNames.includes('cbm_trace'))
  assert.ok(toolNames.includes('cbm_arch'))
  assert.ok(toolNames.includes('cbm_search_code'))
  assert.ok(toolNames.includes('veyra_code_status'))

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

test('code intelligence tools return graceful degraded status when engine is offline', async () => {
  const runtime = {
    veyraHome: '/tmp/test-home',
    fallbackCwd: process.cwd(),
    codeEngine: new CodeIntelligenceEngine({ exePath: '/nonexistent/bin' }),
  }
  const tools = new Map(buildToolDefinitions(runtime).map((t) => [t.name, t]))

  const projectsTool = tools.get('cbm_projects')
  const projectsRes = await projectsTool.execute({ reason: 'testing' }, {})
  assert.equal(projectsRes.ok, false)
  assert.equal(projectsRes.degraded, true)
  const renderedProjects = projectsTool.output.render({}, projectsRes)
  assert.match(renderedProjects[0].text, /Code Intelligence Degraded/)

  const searchTool = tools.get('cbm_search')
  const searchRes = await searchTool.execute({ name_pattern: 'auth' }, {})
  assert.equal(searchRes.ok, false)
  assert.equal(searchRes.degraded, true)

  const snippetTool = tools.get('cbm_snippet')
  const snippetRes = await snippetTool.execute({ qualified_name: 'foo.bar' }, {})
  assert.equal(snippetRes.ok, false)
  assert.equal(snippetRes.degraded, true)

  const traceTool = tools.get('cbm_trace')
  const traceRes = await traceTool.execute({ symbol: 'login' }, {})
  assert.equal(traceRes.ok, false)
  assert.equal(traceRes.degraded, true)

  const archTool = tools.get('cbm_arch')
  const archRes = await archTool.execute({ directory: 'src' }, {})
  assert.equal(archRes.ok, false)
  assert.equal(archRes.degraded, true)

  const searchCodeTool = tools.get('cbm_search_code')
  const searchCodeRes = await searchCodeTool.execute({ query: 'function' }, {})
  assert.equal(searchCodeRes.ok, false)
  assert.equal(searchCodeRes.degraded, true)
})

test('veyra_code_status inspects memory freshness against repository workspace', async () => {
  const tmpHome = mkdtempSync(join(tmpdir(), 'veyra-status-home-'))
  const tmpRepo = mkdtempSync(join(tmpdir(), 'veyra-status-repo-'))

  try {
    writeFileSync(join(tmpRepo, 'index.js'), 'export function hello() { return "world"; }\n')
    const projectId = projectIdFor(tmpRepo)
    const store = openProjectStore(tmpHome, projectId)

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

    const runtime = {
      veyraHome: tmpHome,
      fallbackCwd: tmpRepo,
      codeEngine: new CodeIntelligenceEngine({ exePath: '/nonexistent/bin' }),
    }
    const tools = new Map(buildToolDefinitions(runtime).map((t) => [t.name, t]))
    const statusTool = tools.get('veyra_code_status')
    const result = await statusTool.execute({ repo: tmpRepo }, { agent: { session: { workspace: tmpRepo } } })

    assert.equal(result.ok, true)
    assert.equal(result.freshMemories, 1)
    assert.equal(result.staleMemories, 0)
    assert.equal(result.invalidMemories, 1)

    const rendered = statusTool.output.render({}, result)
    assert.match(rendered[0].text, /1 fresh/)
    assert.match(rendered[0].text, /1 invalid/)
  } finally {
    closeAllStores()
    rmSync(tmpHome, { recursive: true, force: true })
    rmSync(tmpRepo, { recursive: true, force: true })
  }
})

test('veyra_code_status message is never null when engine returns no message field', async () => {
  const tmpHome = mkdtempSync(join(tmpdir(), 'veyra-status-nullmsg-'))
  const tmpRepo = mkdtempSync(join(tmpdir(), 'veyra-status-nullmsg-repo-'))
  try {
    // Simulate NOT_INDEXED path: engine returns object with no `message` field
    const engine = new CodeIntelligenceEngine({ exePath: '/nonexistent/bin' })
    engine.getStatus = async () => ({ status: 'not_indexed', degraded: false, ok: false })

    const runtime = { veyraHome: tmpHome, fallbackCwd: tmpRepo, codeEngine: engine }
    const tools = new Map(buildToolDefinitions(runtime).map((t) => [t.name, t]))
    const statusTool = tools.get('veyra_code_status')
    const result = await statusTool.execute({ repo: tmpRepo }, {})

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
    rmSync(tmpHome, { recursive: true, force: true })
    rmSync(tmpRepo, { recursive: true, force: true })
  }
})

test('cbm_projects render uses value.raw text, not value.projects array', async () => {
  const tmpHome = mkdtempSync(join(tmpdir(), 'veyra-cbm-projects-'))
  try {
    // Simulate upstream MCP returning project-list text in raw field
    const engine = new CodeIntelligenceEngine({ exePath: '/nonexistent/bin' })
    engine.listProjects = async () => ({ ok: true, raw: 'projects:\n  - home-user-myrepo\n  - home-user-another' })

    const runtime = { veyraHome: tmpHome, fallbackCwd: process.cwd(), codeEngine: engine }
    const tools = new Map(buildToolDefinitions(runtime).map((t) => [t.name, t]))
    const projectsTool = tools.get('cbm_projects')
    const result = await projectsTool.execute({ reason: 'test' }, {})

    assert.equal(result.ok, true)
    assert.ok(result.raw)
    const rendered = projectsTool.output.render({}, result)
    assert.match(rendered[0].text, /home-user-myrepo/, 'render should surface the raw project list text')
    assert.match(rendered[0].text, /home-user-another/)
  } finally {
    closeAllStores()
    rmSync(tmpHome, { recursive: true, force: true })
  }
})

test('cbm_arch render uses value.overview, not value.raw', async () => {
  const tmpHome = mkdtempSync(join(tmpdir(), 'veyra-cbm-arch-'))
  const tmpRepo = mkdtempSync(join(tmpdir(), 'veyra-cbm-arch-repo-'))
  try {
    // Simulate engine returning overview field (the real engine behavior)
    const engine = new CodeIntelligenceEngine({ exePath: '/nonexistent/bin' })
    engine.getArchitecture = async () => ({ ok: true, overview: 'Key components:\n- src/main.js: entry point\n- src/lib/: shared utilities' })

    const runtime = { veyraHome: tmpHome, fallbackCwd: tmpRepo, codeEngine: engine }
    const tools = new Map(buildToolDefinitions(runtime).map((t) => [t.name, t]))
    const archTool = tools.get('cbm_arch')
    const result = await archTool.execute({ repo: tmpRepo }, {})

    assert.equal(result.ok, true)
    assert.ok(result.overview)
    const rendered = archTool.output.render({}, result)
    assert.match(rendered[0].text, /Key components/, 'render should surface the overview field')
    assert.match(rendered[0].text, /src\/main\.js/)
  } finally {
    closeAllStores()
    rmSync(tmpHome, { recursive: true, force: true })
    rmSync(tmpRepo, { recursive: true, force: true })
  }
})
