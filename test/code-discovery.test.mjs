import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, symlinkSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  cbmProjectName,
  resolveSafeRepoPath,
  isSensitiveOrSecret,
  isBinaryFile,
  parseGitignoreContent,
  matchesGitignore,
  discoverRepository,
  sanitizeCodeContent,
} from '../src/code/discovery.mjs'

test('cbmProjectName produces correct slug for POSIX and Windows', () => {
  assert.equal(cbmProjectName('/home/user/project'), 'home-user-project')
  assert.equal(cbmProjectName('C:\\Users\\user\\project'), 'C-Users-user-project')
})

test('resolveSafeRepoPath guards against path traversal', (t) => {
  const tmp = mkdtempSync(join(tmpdir(), 'veyra-disc-test-'))
  t.after(() => rmSync(tmp, { recursive: true, force: true }))

  const sub = join(tmp, 'src')
  mkdirSync(sub)
  writeFileSync(join(sub, 'index.js'), 'console.log("hi")')

  // Valid relative path
  assert.equal(resolveSafeRepoPath(tmp, 'src/index.js'), 'src/index.js')
  assert.equal(resolveSafeRepoPath(tmp, join(tmp, 'src/index.js')), 'src/index.js')

  // Path traversal attempts
  assert.equal(resolveSafeRepoPath(tmp, '../etc/passwd'), null)
  assert.equal(resolveSafeRepoPath(tmp, join(tmp, '../../foo')), null)
  assert.equal(resolveSafeRepoPath(tmp, '/etc/shadow'), null)
})

test('resolveSafeRepoPath rejects symlink pointing outside repo', (t) => {
  const tmp = mkdtempSync(join(tmpdir(), 'veyra-sym-test-'))
  const outside = mkdtempSync(join(tmpdir(), 'veyra-outside-test-'))
  t.after(() => {
    rmSync(tmp, { recursive: true, force: true })
    rmSync(outside, { recursive: true, force: true })
  })

  const outsideFile = join(outside, 'secret.txt')
  writeFileSync(outsideFile, 'secret content')

  const symlinkPath = join(tmp, 'evil_link.txt')
  try {
    symlinkSync(outsideFile, symlinkPath)
    // Resolution should fail-closed because real target is outside tmp
    assert.equal(resolveSafeRepoPath(tmp, 'evil_link.txt'), null)
  } catch (err) {
    // On systems where symlinks require privileges, pass gracefully
    if (err.code !== 'EPERM') throw err
  }
})

test('isSensitiveOrSecret flags credentials and keys', () => {
  assert.equal(isSensitiveOrSecret('.env'), true)
  assert.equal(isSensitiveOrSecret('.env.local'), true)
  assert.equal(isSensitiveOrSecret('id_rsa'), true)
  assert.equal(isSensitiveOrSecret('server.key'), true)
  assert.equal(isSensitiveOrSecret('cert.pem'), true)
  assert.equal(isSensitiveOrSecret('main.ts'), false)
  assert.equal(isSensitiveOrSecret('index.js'), false)
})

test('gitignore parser matches negation and directory globs', () => {
  const gitignore = `
# Comment
node_modules/
*.log
!important.log
dist/
`
  const rules = parseGitignoreContent(gitignore)
  assert.equal(matchesGitignore('node_modules', rules, true), true)
  assert.equal(matchesGitignore('test.log', rules, false), true)
  assert.equal(matchesGitignore('important.log', rules, false), false)
  assert.equal(matchesGitignore('src/index.js', rules, false), false)
})

test('discoverRepository discovers source files while ignoring excluded dirs and secrets', (t) => {
  const tmp = mkdtempSync(join(tmpdir(), 'veyra-walk-test-'))
  t.after(() => rmSync(tmp, { recursive: true, force: true }))

  mkdirSync(join(tmp, 'src'))
  mkdirSync(join(tmp, 'node_modules'))
  mkdirSync(join(tmp, '.git'))

  writeFileSync(join(tmp, 'src', 'app.ts'), 'export const a = 1;')
  writeFileSync(join(tmp, 'src', 'util.js'), 'export function b() {}')
  writeFileSync(join(tmp, 'src', '.env'), 'SECRET=12345678')
  writeFileSync(join(tmp, 'node_modules', 'dep.js'), 'module.exports = {};')
  writeFileSync(join(tmp, '.git', 'HEAD'), 'ref: refs/heads/main')

  const files = discoverRepository(tmp)
  const relPaths = files.map((f) => f.relPath).sort()

  assert.deepEqual(relPaths, ['src/app.ts', 'src/util.js'])
  assert.equal(files.find((f) => f.relPath === 'src/app.ts').language, 'typescript')
  assert.equal(files.find((f) => f.relPath === 'src/util.js').language, 'javascript')
})

test('sanitizeCodeContent scrubs sensitive tokens', () => {
  const code = 'const apiKey = "sk-12345678901234567890";'
  const scrubbed = sanitizeCodeContent(code)
  assert.ok(!scrubbed.includes('sk-12345678901234567890'))
  assert.ok(scrubbed.includes('[REDACTED_SECRET]'))
})
