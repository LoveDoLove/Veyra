/**
 * Tests for Coding Agent Intelligence enhancements:
 * 1. Understand: run_code observation & distillation support.
 * 2. Remember: codeAnchorAffinity, anchor_affinity fusion channel, ranking bonus, candidate pooling.
 * 3. Learn: directional replacement phrases, sharesSubject normalized path matching.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { codeAnchorAffinity, rankRecords, hybridRetrieve } from '../src/retrieve.mjs'
import { hasReplacementLanguage, REPLACEMENT_PHRASES } from '../src/text.mjs'
import { sharesSubject } from '../src/diff.mjs'
import { newBuffer, observeEvent, candidateFromBuffer } from '../src/observe.mjs'
import { distillBuffer } from '../src/understand.mjs'
import { openEphemeralStore } from '../src/store.mjs'
import { AUTHORITIES, KINDS, SCOPES } from '../src/types.mjs'

test('codeAnchorAffinity matches exact, normalized line-anchored, and basename paths', () => {
  const recExact = {
    evidence: [{ path: 'src/retrieve.mjs' }],
  }
  assert.equal(codeAnchorAffinity(recExact, ['src/retrieve.mjs']), 1)
  assert.equal(codeAnchorAffinity(recExact, ['./src/retrieve.mjs']), 1)
  assert.equal(codeAnchorAffinity(recExact, ['src\\retrieve.mjs']), 1)

  const recLine = {
    evidence: [{ path: './src/retrieve.mjs:12-40' }],
  }
  assert.equal(codeAnchorAffinity(recLine, ['src/retrieve.mjs']), 1)
  assert.equal(codeAnchorAffinity(recLine, ['src/retrieve.mjs:100']), 1)

  const recBasename = {
    evidence: [{ path: 'packages/core/engine.mjs' }],
  }
  assert.equal(codeAnchorAffinity(recBasename, ['src/engine.mjs']), 0.5)

  const recSourceFiles = {
    source: { files: ['src/observe.mjs'] },
  }
  assert.equal(codeAnchorAffinity(recSourceFiles, ['src/observe.mjs']), 1)

  const recNoMatch = {
    evidence: [{ path: 'src/other.mjs' }],
  }
  assert.equal(codeAnchorAffinity(recNoMatch, ['src/retrieve.mjs']), 0)
  assert.equal(codeAnchorAffinity(recNoMatch, []), 0)
  assert.equal(codeAnchorAffinity(recNoMatch, null), 0)
})

test('rankRecords applies anchor bonus and exposes anchor_affinity score', () => {
  const records = [
    {
      id: 'rec1',
      title: 'Database connection retry policy',
      body: 'Always retry with exponential backoff.',
      evidence: [{ path: 'src/db.mjs' }],
      scope: SCOPES.PROJECT,
      authority: AUTHORITIES.DERIVED,
      validation: 'reviewed',
      confidence: 'high',
      createdAt: new Date().toISOString(),
    },
    {
      id: 'rec2',
      title: 'UI styling and layout',
      body: 'Use standard tailwind spacing classes.',
      evidence: [{ path: 'src/ui.mjs' }],
      scope: SCOPES.PROJECT,
      authority: AUTHORITIES.DERIVED,
      validation: 'reviewed',
      confidence: 'high',
      createdAt: new Date().toISOString(),
    },
  ]

  const rankedWithoutChanged = rankRecords(records, { query: 'retry policy' })
  assert.equal(rankedWithoutChanged[0].scores.anchor_affinity, 0)

  const rankedWithChanged = rankRecords(records, { query: 'retry policy', changedFiles: ['src/db.mjs'] })
  assert.equal(rankedWithChanged[0].scores.anchor_affinity, 1)
  assert.ok(rankedWithChanged[0].scores.composite > rankedWithoutChanged[0].scores.composite)
  assert.equal(rankedWithChanged[1].scores.anchor_affinity, 0)
})

test('hybridRetrieve pools candidate records anchored to changedFiles even when outside recent pool', () => {
  const store = openEphemeralStore()
  // Insert the target record first (oldest)
  store.put({
    id: 'rec_code_arch',
    title: 'SQLite schema architecture',
    body: 'Tables are initialized with WAL mode and synchronous normal.',
    evidence: [{ path: 'src/storage/schema.sql' }],
    scope: SCOPES.PROJECT,
    authority: AUTHORITIES.DERIVED,
    validation: 'reviewed',
    confidence: 'high',
  })

  // Insert 15 filler records so rec_code_arch falls outside the perStore recent pool (perStore = 12 for limit=1)
  for (let i = 1; i <= 15; i++) {
    store.put({
      id: `rec_filler_${i}`,
      title: `Filler record ${i}`,
      body: `Some generic filler content ${i}`,
      evidence: [{ path: `src/filler${i}.mjs` }],
      scope: SCOPES.PROJECT,
      authority: AUTHORITIES.DERIVED,
      validation: 'reviewed',
      confidence: 'medium',
    })
  }

  // Without changedFiles, query does not match rec_code_arch and it is beyond recent pool
  const withoutChanged = hybridRetrieve({
    projectStore: store,
    query: 'filler generic',
    limit: 1,
  })
  assert.ok(withoutChanged.length > 0)
  assert.notEqual(withoutChanged[0].id, 'rec_code_arch')

  // With changedFiles, candidate pooling pulls rec_code_arch from the full pool and gives anchor bonus
  const withChanged = hybridRetrieve({
    projectStore: store,
    query: 'filler generic',
    changedFiles: ['src/storage/schema.sql'],
    limit: 5,
  })
  const pulled = withChanged.find((r) => r.id === 'rec_code_arch')
  assert.ok(pulled, 'rec_code_arch should be pooled when its anchored file is in changedFiles')
  assert.equal(pulled.scores.anchor_affinity, 1)
})

test('directional replacement keywords cover English and Chinese terms', () => {
  const phrases = [
    'migrated from',
    'upgraded from',
    'supersedes',
    'superseded by',
    'now using',
    'now uses',
    'switched to',
    'refactored from',
    '迁移自',
    '升级为',
    '现在使用',
    '重构为',
  ]

  for (const phrase of phrases) {
    assert.ok(
      REPLACEMENT_PHRASES.some((p) => p.toLowerCase() === phrase.toLowerCase()),
      `REPLACEMENT_PHRASES should include "${phrase}"`
    )
    assert.equal(
      hasReplacementLanguage(`This component was ${phrase} the legacy implementation.`),
      true
    )
  }
})

test('sharesSubject normalizes line numbers, prefixes, and backslashes', () => {
  const a = {
    evidence: [{ path: './src/foo/bar.ts:15-30' }],
  }
  const b = {
    evidence: [{ path: 'src/foo/bar.ts' }],
  }
  const c = {
    evidence: [{ path: 'src\\foo\\bar.ts:80' }],
  }
  const d = {
    evidence: [{ path: 'src/other.ts' }],
  }

  assert.equal(sharesSubject(a, b), true)
  assert.equal(sharesSubject(b, c), true)
  assert.equal(sharesSubject(a, c), true)
  assert.equal(sharesSubject(a, d), false)
})

test('observeEvent and distillBuffer support run_code with file extraction, descriptions, and tags', () => {
  const buffer = newBuffer()
  observeEvent(buffer, {}, { type: 'turn/start', data: { turn: 1 } })
  observeEvent(buffer, {}, {
    type: 'user/message',
    data: { content: [{ type: 'text', text: 'Refactor the caching layer in src/cache.ts to avoid key collisions.' }] },
  })

  // tool call for run_code
  observeEvent(buffer, {}, {
    type: 'tool/call',
    data: {
      callId: 'call_1',
      name: 'run_code',
      arguments: {
        description: 'Edit cache implementation',
        code: 'await tools.edit({ file_path: "src/cache.ts", old_string: "a", new_string: "b" });',
      },
    },
  })

  // tool result for run_code
  observeEvent(buffer, {}, {
    type: 'tool/result',
    data: {
      callId: 'call_1',
      name: 'run_code',
      output: 'pass 42 tests passed, 0 failed',
    },
  })

  assert.ok(buffer.files.has('src/cache.ts'), 'buffer.files should contain src/cache.ts')
  assert.equal(buffer.tools.length, 2)
  assert.equal(buffer.tools[0].name, 'run_code')
  assert.equal(buffer.tools[0].args.description, 'Edit cache implementation')
  assert.ok(buffer.tools[0].args.code.includes('tools.edit'))
  assert.equal(buffer.tools[1].name, 'run_code:result')

  const candidate = candidateFromBuffer(buffer, { projectId: 'p_test', sessionId: 's1' })
  assert.ok(candidate, 'Candidate should be produced from run_code tool turn')
  assert.equal(candidate.authority, AUTHORITIES.CANDIDATE)
  assert.equal(candidate.kind, KINDS.OBSERVATION)
  assert.ok(candidate.tags.includes('edited'), 'Tags should include edited')
})
