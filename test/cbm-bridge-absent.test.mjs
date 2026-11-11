import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

// The absent-bridge behaviour itself is unit-tested in
// test/cbm-bridge.test.mjs via resolveRepoPath's injectable namespace. What
// these tests pin is that the three call sites actually route through it,
// because a direct `resolveSafeRepoPath` import would silently restore the
// hard dependency the whole change exists to remove.
test('the capture and trust path resolve anchors through the bridge', () => {
  for (const file of ['../src/understand.mjs', '../src/trust.mjs', '../src/code/linking.mjs']) {
    const src = readFileSync(new URL(file, import.meta.url), 'utf8')
    assert.ok(!src.includes('resolveSafeRepoPath'),
      `${file} must not call resolveSafeRepoPath directly`)
    assert.ok(src.includes('resolveRepoPath') || src.includes('repoRelativeAnchor'),
      `${file} must resolve paths through the bridge`)
  }
})

test('createCodeAnchor still refuses an out-of-repo path', async () => {
  const { createCodeAnchor } = await import('../src/code/linking.mjs')
  assert.throws(
    () => createCodeAnchor({ repoRoot: '/tmp/repo-a', path: '/tmp/outside/b.mjs' }),
    /escapes repository boundary/,
  )
})
