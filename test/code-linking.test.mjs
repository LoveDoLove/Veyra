import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  createCodeAnchor,
  extractAnchorsFromRecord,
  checkAnchorFreshness,
  checkRecordFreshness,
  findAffectedMemories,
  buildStaleReviewCandidate,
} from '../src/code/linking.mjs'
import { FRESHNESS_STATUS } from '../src/code/types.mjs'
import { KINDS, STATUSES, AUTHORITIES, VALIDATIONS } from '../src/types.mjs'

test('createCodeAnchor enforces repo boundary and captures hash', (t) => {
  const tmp = mkdtempSync(join(tmpdir(), 'veyra-anchor-test-'))
  t.after(() => rmSync(tmp, { recursive: true, force: true }))

  mkdirSync(join(tmp, 'src'))
  writeFileSync(join(tmp, 'src', 'index.js'), 'export const x = 42;\n')

  const anchor = createCodeAnchor({ repoRoot: tmp, path: 'src/index.js', symbol: 'x' })
  assert.equal(anchor.path, 'src/index.js')
  assert.equal(anchor.symbol, 'x')
  assert.ok(typeof anchor.content_hash === 'string' && anchor.content_hash.length === 64)

  assert.throws(() => {
    createCodeAnchor({ repoRoot: tmp, path: '../outside.js' })
  }, /escapes repository boundary/)
})

test('extractAnchorsFromRecord extracts paths and symbols from various formats', () => {
  const recordWithString = {
    evidence: JSON.stringify(['path=src/foo.js', 'sym:bar']),
  }
  const anchors1 = extractAnchorsFromRecord(recordWithString)
  assert.deepEqual(anchors1, [{ path: 'src/foo.js' }, { symbol: 'bar' }])

  const recordWithObject = {
    evidence: [{ path: 'src/baz.ts', symbol: 'MyClass', content_hash: '1234' }],
  }
  const anchors2 = extractAnchorsFromRecord(recordWithObject)
  assert.equal(anchors2[0].path, 'src/baz.ts')
  assert.equal(anchors2[0].symbol, 'MyClass')
})

test('checkAnchorFreshness detects fresh, potentially_stale, and invalid states', (t) => {
  const tmp = mkdtempSync(join(tmpdir(), 'veyra-fresh-test-'))
  t.after(() => rmSync(tmp, { recursive: true, force: true }))

  const file = join(tmp, 'code.js')
  writeFileSync(file, 'function run() { return 1; }\n')

  const anchor = createCodeAnchor({ repoRoot: tmp, path: 'code.js', symbol: 'run' })

  // Fresh
  const f1 = checkAnchorFreshness(anchor, tmp)
  assert.equal(f1.status, FRESHNESS_STATUS.FRESH)

  // Modified content -> potentially stale
  writeFileSync(file, 'function run() { return 2; }\n')
  const f2 = checkAnchorFreshness(anchor, tmp)
  assert.equal(f2.status, FRESHNESS_STATUS.POTENTIALLY_STALE)

  // Removed symbol -> potentially stale
  writeFileSync(file, 'function other() { return 2; }\n')
  const f3 = checkAnchorFreshness(anchor, tmp)
  assert.equal(f3.status, FRESHNESS_STATUS.POTENTIALLY_STALE)

  // Deleted file -> invalid
  unlinkSync(file)
  const f4 = checkAnchorFreshness(anchor, tmp)
  assert.equal(f4.status, FRESHNESS_STATUS.INVALID)
})

test('findAffectedMemories identifies memories referencing changed files', (t) => {
  const tmp = mkdtempSync(join(tmpdir(), 'veyra-affected-test-'))
  t.after(() => rmSync(tmp, { recursive: true, force: true }))

  mkdirSync(join(tmp, 'src'))
  writeFileSync(join(tmp, 'src', 'auth.js'), 'export function login() {}\n')
  writeFileSync(join(tmp, 'src', 'db.js'), 'export function connect() {}\n')

  const memories = [
    {
      id: 'mem_1',
      title: 'Auth login pattern',
      authority: AUTHORITIES.CANONICAL,
      validation: VALIDATIONS.VERIFIED,
      status: STATUSES.ACTIVE,
      evidence: [{ path: 'src/auth.js', symbol: 'login' }],
    },
    {
      id: 'mem_2',
      title: 'Database connection config',
      authority: AUTHORITIES.DERIVED,
      validation: VALIDATIONS.VERIFIED,
      status: STATUSES.ACTIVE,
      evidence: [{ path: 'src/db.js', symbol: 'connect' }],
    },
  ]

  // If auth.js changed
  const affected = findAffectedMemories(tmp, ['src/auth.js'], memories)
  assert.equal(affected.length, 1)
  assert.equal(affected[0].memoryId, 'mem_1')

  // Candidate generation invariant: Candidate != Truth
  const candidate = buildStaleReviewCandidate(affected[0], 'src/auth.js', 'file modified')
  assert.equal(candidate.kind, KINDS.OBSERVATION)
  assert.equal(candidate.authority, AUTHORITIES.UNVERIFIED)
  assert.equal(candidate.status, STATUSES.CANDIDATE)
  // Memory itself remains untouched!
  assert.equal(memories[0].authority, AUTHORITIES.CANONICAL)
})
