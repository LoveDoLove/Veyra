import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { MemoryStore } from '../src/store.mjs'
import { unifiedRetrieve, formatUnifiedForPrompt } from '../src/code/retrieval.mjs'
import { CodeIntelligenceEngine } from '../src/code/engine.mjs'
import { CodebaseMemoryClient } from '../src/code/client.mjs'
import { KINDS, STATUSES, AUTHORITIES, VALIDATIONS, CONFIDENCES, SCOPES } from '../src/types.mjs'
import { FRESHNESS_STATUS } from '../src/code/types.mjs'

function createTestDb(dir) {
  return new MemoryStore(join(dir, 'memory.db'), { scope: SCOPES.PROJECT, projectId: 'test_project' })
}

test('unifiedRetrieve executes multi-source search and evaluates freshness', async (t) => {
  const tmp = mkdtempSync(join(tmpdir(), 'veyra-unified-test-'))
  t.after(() => rmSync(tmp, { recursive: true, force: true }))

  mkdirSync(join(tmp, 'src'))
  const file = join(tmp, 'src', 'db.js')
  writeFileSync(file, 'export function connectDB() { return true; }\n')

  const store = createTestDb(tmp)
  store.put({
    kind: KINDS.MEMORY,
    status: STATUSES.ACTIVE,
    authority: AUTHORITIES.DERIVED,
    validation: VALIDATIONS.VERIFIED,
    confidence: CONFIDENCES.HIGH,
    scope: SCOPES.PROJECT,
    title: 'Database connection configuration',
    body: 'Use connectDB for pooling connections.',
    evidence: [{ path: 'src/db.js', symbol: 'connectDB' }],
    tags: ['database'],
  })

  const degradedEngine = new CodeIntelligenceEngine({
    client: new CodebaseMemoryClient({ exePath: '/nonexistent' }),
  })

  const res = await unifiedRetrieve({
    query: 'database',
    repoRoot: tmp,
    projectStore: store,
    codeEngine: degradedEngine,
  })

  assert.equal(res.degraded, true)
  assert.equal(res.memories.length, 1)
  assert.equal(res.memories[0].title, 'Database connection configuration')
  assert.equal(res.memories[0].freshness, FRESHNESS_STATUS.FRESH)

  const promptText = formatUnifiedForPrompt(res)
  assert.ok(promptText.includes('CODE INTELLIGENCE DEGRADED'))
  assert.ok(promptText.includes('Veyra Engineering Memory'))
  assert.ok(promptText.includes('Database connection configuration'))
})

test('unifiedRetrieve surfaces invalid code evidence as contradiction', async (t) => {
  const tmp = mkdtempSync(join(tmpdir(), 'veyra-invalid-test-'))
  t.after(() => rmSync(tmp, { recursive: true, force: true }))

  const store = createTestDb(tmp)
  store.put({
    kind: KINDS.MEMORY,
    status: STATUSES.ACTIVE,
    authority: AUTHORITIES.DERIVED,
    validation: VALIDATIONS.VERIFIED,
    confidence: CONFIDENCES.HIGH,
    scope: SCOPES.PROJECT,
    title: 'Legacy auth helper',
    body: 'Old helper in deleted file.',
    evidence: [{ path: 'src/deleted.js' }],
    tags: ['auth'],
  })

  const res = await unifiedRetrieve({
    query: 'auth',
    repoRoot: tmp,
    projectStore: store,
  })

  assert.equal(res.memories.length, 1)
  assert.equal(res.memories[0].freshness, FRESHNESS_STATUS.INVALID)
  assert.equal(res.contradictions.length, 1)
  assert.equal(res.contradictions[0].type, 'invalid_code_evidence')

  const promptText = formatUnifiedForPrompt(res)
  assert.ok(promptText.includes('CODE DISCREPANCY'))
  assert.ok(promptText.includes('Legacy auth helper'))
})
