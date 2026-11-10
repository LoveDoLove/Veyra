/**
 * Real DSH integration: two DSH workspaces that live under one git repository
 * must receive two separate Veyra Memory Rooms.
 *
 * This test composes the actual `@deepseek-ai/dsh-workspace` registry (JSON
 * storage, JSONL session persistence) instead of a stub, so the WorkspaceId
 * evidence comes from the same implementation the running Host uses. It skips
 * when DSH is not installed globally; `npm test` in this checkout runs it.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { existsSync, mkdirSync, mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { createMemoryServer } from '../src/memory-server.mjs'
import { MEMORY_OPERATIONS } from '../src/memory-router.mjs'
import { closeAllStores } from '../src/store.mjs'
import { roomIdForWorkspaceId } from '../src/rooms.mjs'

function dshPackageRoot() {
  try {
    const globalRoot = execFileSync('npm', ['root', '-g'], { encoding: 'utf8' }).trim()
    const candidate = join(globalRoot, '@deepseek-ai', 'dsh')
    return existsSync(join(candidate, 'package.json')) ? candidate : null
  } catch {
    return null
  }
}

const dshRoot = dshPackageRoot()
const skip = dshRoot ? false : 'global @deepseek-ai/dsh install not found'

function loader(root) {
  const require = createRequire(join(root, 'noop.cjs'))
  return async (name) => {
    const resolved = require.resolve(name)
    return import(pathToFileURL(resolved).href)
  }
}

test('real WorkspaceRegistry isolates two workspaces on one repository', { skip }, async () => {
  const load = loader(dshRoot)
  const { Context } = await load('@deepseek-ai/cordis')
  const storage = await load('@deepseek-ai/dsh-storage')
  const storageJson = await load('@deepseek-ai/dsh-storage-json')
  const storageDomain = await load('@deepseek-ai/dsh-storage-domain')
  const session = await load('@deepseek-ai/dsh-session')
  const persistence = await load('@deepseek-ai/dsh-session-persistence-jsonl')
  const workspace = await load('@deepseek-ai/dsh-workspace')

  const root = mkdtempSync(join(tmpdir(), 'veyra-dsh-registry-'))
  const repo = join(root, 'repo')
  mkdirSync(join(repo, '.git'), { recursive: true })
  const a = join(repo, 'a')
  const b = join(repo, 'b')
  mkdirSync(a, { recursive: true })
  mkdirSync(b, { recursive: true })

  const ctx = new Context()
  await ctx.plugin(storage.Storage, {})
  await ctx.plugin(storageJson, { root: join(root, 'storage') })
  await ctx.plugin(storageDomain, { backend: 'json' })
  await ctx.plugin(session.default, {})
  await ctx.plugin(persistence, { root: join(root, 'sessions') })
  await ctx.plugin(workspace.default, {})

  try {
    const wsA = await ctx.workspaceRegistry.create(a, 'Workspace A')
    const wsB = await ctx.workspaceRegistry.create(b, 'Workspace B')
    assert.notEqual(wsA.id, wsB.id, 'DSH assigns a distinct WorkspaceId per workspace')
    assert.equal(wsA.path, a)
    assert.equal(wsB.path, b)

    const home = join(root, 'veyra')
    const server = createMemoryServer({
      ctx,
      runtime: { veyraHome: home, fallbackCwd: a },
    })

    const resolvedA = server.resolvePath(a)
    const resolvedB = server.resolvePath(b)
    assert.equal(resolvedA.ok, true)
    assert.equal(resolvedB.ok, true)
    assert.equal(resolvedA.binding.workspaceId, wsA.id)
    assert.equal(resolvedB.binding.workspaceId, wsB.id)
    assert.equal(resolvedA.binding.source, 'path')
    assert.equal(resolvedA.binding.roomId, roomIdForWorkspaceId(wsA.id))
    assert.equal(resolvedB.binding.roomId, roomIdForWorkspaceId(wsB.id))

    const storesA = server.storesForPath(a, MEMORY_OPERATIONS.WRITE_MANUAL)
    const storesB = server.storesForPath(b, MEMORY_OPERATIONS.WRITE_MANUAL)
    assert.equal(storesA.ok, true)
    assert.equal(storesB.ok, true)

    const written = storesA.projectStore.put({
      kind: 'knowledge',
      status: 'current',
      validation: 'reviewed',
      authority: 'derived',
      confidence: 'medium',
      scope: 'project',
      title: 'Workspace A only',
      body: 'This record must never appear in Workspace B.',
      tags: [],
      evidence: [{ note: 'real registry integration test' }],
      source: { workspace: a },
    })
    assert.ok(storesA.projectStore.get(written.record.id))
    assert.equal(storesB.projectStore.get(written.record.id), null)
    assert.equal(storesB.projectStore.count(), 0)
  } finally {
    closeAllStores()
    try {
      await ctx.dispose?.()
    } catch {}
  }
})
