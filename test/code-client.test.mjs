import test from 'node:test'
import assert from 'node:assert/strict'
import { findCodebaseMemoryExe, CodebaseMemoryClient } from '../src/code/client.mjs'

test('findCodebaseMemoryExe detects binary or returns null', () => {
  const exe = findCodebaseMemoryExe()
  // If installed on system, it returns string; otherwise null
  if (exe) {
    assert.equal(typeof exe, 'string')
    assert.ok(exe.includes('codebase-memory-mcp'))
  }
})

test('CodebaseMemoryClient handles degraded mode when exe is missing', async () => {
  const client = new CodebaseMemoryClient({ exePath: '/non/existent/path/to/binary' })
  assert.equal(client.isAvailable, false)

  const res = await client.callTool('list_projects', {})
  assert.equal(res.isError, true)
  assert.equal(res.degraded, true)
  assert.ok(res.content[0].text.includes('Code Intelligence unavailable'))
})

test('CodebaseMemoryClient connects and queries if binary is present', async (t) => {
  const exe = findCodebaseMemoryExe()
  if (!exe) {
    t.skip('codebase-memory-mcp binary not present in environment')
    return
  }

  const client = new CodebaseMemoryClient({ exePath: exe, uiEnabled: false })
  t.after(() => client.stop())

  const res = await client.listProjects()
  assert.equal(res.isError, false)
  assert.ok(Array.isArray(res.content))
  assert.ok(res.content[0].text.includes('projects:'))
  assert.ok(client.serverInfo, 'serverInfo should be captured on initialize')
  assert.ok(client.serverInfo.name, 'serverInfo should have name')
})
