import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { RepositoryWatcher } from '../src/code/watcher.mjs'

test('RepositoryWatcher ignores excluded directories and sensitive files', (t) => {
  const tmp = mkdtempSync(join(tmpdir(), 'veyra-watch-test-'))
  t.after(() => rmSync(tmp, { recursive: true, force: true }))

  const watcher = new RepositoryWatcher(tmp, { debounceMs: 50 })
  t.after(() => watcher.stop())

  watcher.handleRawFsEvent('change', 'node_modules/foo/index.js')
  watcher.handleRawFsEvent('change', '.git/HEAD')
  watcher.handleRawFsEvent('change', '.env')

  assert.equal(watcher.pendingEvents.size, 0)
})

test('RepositoryWatcher debounces bursts and emits changes', async (t) => {
  const tmp = mkdtempSync(join(tmpdir(), 'veyra-burst-test-'))
  t.after(() => rmSync(tmp, { recursive: true, force: true }))

  mkdirSync(join(tmp, 'src'))
  const file1 = join(tmp, 'src', 'a.js')
  writeFileSync(file1, 'console.log("a");\n')

  const watcher = new RepositoryWatcher(tmp, { debounceMs: 100 })
  watcher.start()
  t.after(() => watcher.stop())

  const received = []
  watcher.on('change', (changeset) => {
    received.push(changeset)
  })

  // Modify file multiple times in quick succession (burst)
  writeFileSync(file1, 'console.log("a1");\n')
  writeFileSync(file1, 'console.log("a2");\n')
  writeFileSync(file1, 'console.log("a3");\n')

  // Wait for debounce timer to fire
  await new Promise((resolve) => setTimeout(resolve, 300))

  assert.ok(received.length >= 1)
  const last = received[received.length - 1]
  assert.ok(last.modified.includes('src/a.js'))
})
