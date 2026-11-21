/**
 * Phase 2: Function-level evidence anchor tests
 *
 * Validates:
 * 1. Schema validation (symbol/startLine/endLine fields)
 * 2. Evidence strength scoring (0.8/0.7/0.6/0.1)
 * 3. Round-trip persistence
 * 4. Backward compatibility with file-level evidence
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { remember } from '../src/learn.mjs'
import { evidenceStrength } from '../src/retrieve.mjs'
import { openEphemeralStore } from '../src/store.mjs'
import { tmpdir } from 'node:os'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'

test('Phase 2: Function-level evidence validation', async (t) => {
  await t.test('rejects partial function-level fields', () => {
    const tmpHome = mkdtempSync(join(tmpdir(), 'veyra-test-'))
    const store = openEphemeralStore(':memory:', { scope: 'project', projectId: 'test-workspace' })

    try {
      // Only symbol, missing startLine/endLine
      assert.throws(() => {
        remember(store, {
          title: 'Test memory',
          body: 'Test body',
          evidence: [{ path: 'src/test.mjs', symbol: 'testFn' }]
        })
      }, /Function-level evidence requires symbol, startLine, and endLine/)

      // Only startLine, missing symbol/endLine
      assert.throws(() => {
        remember(store, {
          title: 'Test memory',
          body: 'Test body',
          evidence: [{ path: 'src/test.mjs', startLine: 10 }]
        })
      }, /Function-level evidence requires symbol, startLine, and endLine/)

      // symbol + startLine, missing endLine
      assert.throws(() => {
        remember(store, {
          title: 'Test memory',
          body: 'Test body',
          evidence: [{ path: 'src/test.mjs', symbol: 'testFn', startLine: 10 }]
        })
      }, /Function-level evidence requires symbol, startLine, and endLine/)
    } finally {
      store.close()
      rmSync(tmpHome, { recursive: true, force: true })
    }
  })

  await t.test('rejects function-level fields without path', () => {
    const tmpHome = mkdtempSync(join(tmpdir(), 'veyra-test-'))
    const store = openEphemeralStore(':memory:', { scope: 'project', projectId: 'test-workspace' })

    try {
      assert.throws(() => {
        remember(store, {
          title: 'Test memory',
          body: 'Test body',
          evidence: [{ symbol: 'testFn', startLine: 10, endLine: 20 }]
        })
      }, /Function-level evidence requires path field/)
    } finally {
      store.close()
      rmSync(tmpHome, { recursive: true, force: true })
    }
  })

  await t.test('rejects empty symbol', () => {
    const tmpHome = mkdtempSync(join(tmpdir(), 'veyra-test-'))
    const store = openEphemeralStore(':memory:', { scope: 'project', projectId: 'test-workspace' })

    try {
      assert.throws(() => {
        remember(store, {
          title: 'Test memory',
          body: 'Test body',
          evidence: [{ path: 'src/test.mjs', symbol: '', startLine: 10, endLine: 20 }]
        })
      }, /symbol must be a non-empty string/)

      assert.throws(() => {
        remember(store, {
          title: 'Test memory',
          body: 'Test body',
          evidence: [{ path: 'src/test.mjs', symbol: '   ', startLine: 10, endLine: 20 }]
        })
      }, /symbol must be a non-empty string/)
    } finally {
      store.close()
      rmSync(tmpHome, { recursive: true, force: true })
    }
  })

  await t.test('rejects non-integer line numbers', () => {
    const tmpHome = mkdtempSync(join(tmpdir(), 'veyra-test-'))
    const store = openEphemeralStore(':memory:', { scope: 'project', projectId: 'test-workspace' })

    try {
      assert.throws(() => {
        remember(store, {
          title: 'Test memory',
          body: 'Test body',
          evidence: [{ path: 'src/test.mjs', symbol: 'testFn', startLine: '10', endLine: 20 }]
        })
      }, /startLine must be a positive integer/)

      assert.throws(() => {
        remember(store, {
          title: 'Test memory',
          body: 'Test body',
          evidence: [{ path: 'src/test.mjs', symbol: 'testFn', startLine: 10, endLine: 20.5 }]
        })
      }, /endLine must be a positive integer/)
    } finally {
      store.close()
      rmSync(tmpHome, { recursive: true, force: true })
    }
  })

  await t.test('rejects non-positive line numbers', () => {
    const tmpHome = mkdtempSync(join(tmpdir(), 'veyra-test-'))
    const store = openEphemeralStore(':memory:', { scope: 'project', projectId: 'test-workspace' })

    try {
      assert.throws(() => {
        remember(store, {
          title: 'Test memory',
          body: 'Test body',
          evidence: [{ path: 'src/test.mjs', symbol: 'testFn', startLine: 0, endLine: 20 }]
        })
      }, /startLine must be a positive integer/)

      assert.throws(() => {
        remember(store, {
          title: 'Test memory',
          body: 'Test body',
          evidence: [{ path: 'src/test.mjs', symbol: 'testFn', startLine: 10, endLine: -5 }]
        })
      }, /endLine must be a positive integer/)
    } finally {
      store.close()
      rmSync(tmpHome, { recursive: true, force: true })
    }
  })

  await t.test('rejects startLine > endLine', () => {
    const tmpHome = mkdtempSync(join(tmpdir(), 'veyra-test-'))
    const store = openEphemeralStore(':memory:', { scope: 'project', projectId: 'test-workspace' })

    try {
      assert.throws(() => {
        remember(store, {
          title: 'Test memory',
          body: 'Test body',
          evidence: [{ path: 'src/test.mjs', symbol: 'testFn', startLine: 20, endLine: 10 }]
        })
      }, /startLine.*must be <= endLine/)
    } finally {
      store.close()
      rmSync(tmpHome, { recursive: true, force: true })
    }
  })

  await t.test('accepts valid function-level evidence', () => {
    const tmpHome = mkdtempSync(join(tmpdir(), 'veyra-test-'))
    const store = openEphemeralStore(':memory:', { scope: 'project', projectId: 'test-workspace' })

    try {
      const result = remember(store, {
        title: 'Test memory',
        body: 'Test body',
        evidence: [{
          path: 'src/test.mjs',
          symbol: 'testFn',
          startLine: 10,
          endLine: 20,
          note: 'Test note'
        }]
      })

      assert.ok(result.record, 'remember() should return {record}')
      assert.ok(result.record)
      assert.equal(result.record.evidence.length, 1)
      assert.equal(result.record.evidence[0].path, 'src/test.mjs')
      assert.equal(result.record.evidence[0].symbol, 'testFn')
      assert.equal(result.record.evidence[0].startLine, 10)
      assert.equal(result.record.evidence[0].endLine, 20)
      assert.equal(result.record.evidence[0].note, 'Test note')
    } finally {
      store.close()
      rmSync(tmpHome, { recursive: true, force: true })
    }
  })

  await t.test('accepts single-line function (startLine === endLine)', () => {
    const tmpHome = mkdtempSync(join(tmpdir(), 'veyra-test-'))
    const store = openEphemeralStore(':memory:', { scope: 'project', projectId: 'test-workspace' })

    try {
      const result = remember(store, {
        title: 'Test memory',
        body: 'Test body',
        evidence: [{
          path: 'src/test.mjs',
          symbol: 'arrowFn',
          startLine: 15,
          endLine: 15
        }]
      })

      assert.ok(result.record, 'remember() should return {record}')
      assert.equal(result.record.evidence[0].startLine, 15)
      assert.equal(result.record.evidence[0].endLine, 15)
    } finally {
      store.close()
      rmSync(tmpHome, { recursive: true, force: true })
    }
  })
})

test('Phase 2: Evidence strength scoring', async (t) => {
  await t.test('scores 0.8 for file + test-passed on same item', () => {
    const evidence = [
      { path: 'src/test.mjs', note: 'test-passed' }
    ]
    assert.equal(evidenceStrength(evidence), 0.8)
  })

  await t.test('scores 0.7 for function-level anchor (untested)', () => {
    const evidence = [
      { path: 'src/test.mjs', symbol: 'testFn', startLine: 10, endLine: 20 }
    ]
    assert.equal(evidenceStrength(evidence), 0.7)
  })

  await t.test('scores 0.8 for function-level + test-passed on same item', () => {
    const evidence = [
      { path: 'src/test.mjs', symbol: 'testFn', startLine: 10, endLine: 20, note: 'test-passed' }
    ]
    assert.equal(evidenceStrength(evidence), 0.8)
  })

  await t.test('scores 0.6 for file-level anchor only', () => {
    const evidence = [
      { path: 'src/test.mjs' }
    ]
    assert.equal(evidenceStrength(evidence), 0.6)
  })

  await t.test('scores 0.6 for file-level with note (not test-passed)', () => {
    const evidence = [
      { path: 'src/test.mjs', note: 'Observed behavior' }
    ]
    assert.equal(evidenceStrength(evidence), 0.6)
  })

  await t.test('scores 0.1 for URI-only anchor', () => {
    const evidence = [
      { uri: 'https://example.com/doc', note: 'External reference' }
    ]
    assert.equal(evidenceStrength(evidence), 0.1)
  })

  await t.test('does NOT cross-aggregate test-passed from separate items', () => {
    // [{path}, {uri, note:test-passed}] → 0.6, not 0.8
    const evidence = [
      { path: 'src/test.mjs' },
      { uri: 'https://example.com/test-report', note: 'test-passed' }
    ]
    assert.equal(evidenceStrength(evidence), 0.6)
  })

  await t.test('takes max score across items', () => {
    const evidence = [
      { uri: 'https://example.com' },  // 0.1
      { path: 'src/test.mjs' },        // 0.6
      { path: 'src/other.mjs', symbol: 'fn', startLine: 5, endLine: 10 }  // 0.7
    ]
    assert.equal(evidenceStrength(evidence), 0.7)
  })

  await t.test('scores 0.1 for empty evidence', () => {
    assert.equal(evidenceStrength([]), 0.1)
    assert.equal(evidenceStrength(null), 0.1)
    assert.equal(evidenceStrength(undefined), 0.1)
  })
})

test('Phase 2: Backward compatibility', async (t) => {
  await t.test('file-level evidence continues working', () => {
    const tmpHome = mkdtempSync(join(tmpdir(), 'veyra-test-'))
    const store = openEphemeralStore(':memory:', { scope: 'project', projectId: 'test-workspace' })

    try {
      const result = remember(store, {
        title: 'Old style memory',
        body: 'File-level evidence',
        evidence: [{ path: 'src/old.mjs', note: 'Still works' }]
      })

      assert.ok(result.record, 'remember() should return {record}')
      assert.equal(result.record.evidence[0].path, 'src/old.mjs')
      assert.equal(result.record.evidence[0].note, 'Still works')
      // No symbol/startLine/endLine
      assert.equal(result.record.evidence[0].symbol, undefined)
      assert.equal(result.record.evidence[0].startLine, undefined)
      assert.equal(result.record.evidence[0].endLine, undefined)
    } finally {
      store.close()
      rmSync(tmpHome, { recursive: true, force: true })
    }
  })

  await t.test('URI-only evidence continues working', () => {
    const tmpHome = mkdtempSync(join(tmpdir(), 'veyra-test-'))
    const store = openEphemeralStore(':memory:', { scope: 'project', projectId: 'test-workspace' })

    try {
      const result = remember(store, {
        title: 'URI memory',
        body: 'External reference',
        evidence: [{ uri: 'https://example.com/docs', note: 'Official docs' }]
      })

      assert.ok(result.record, 'remember() should return {record}')
      assert.equal(result.record.evidence[0].uri, 'https://example.com/docs')
      assert.equal(result.record.evidence[0].note, 'Official docs')
    } finally {
      store.close()
      rmSync(tmpHome, { recursive: true, force: true })
    }
  })

  await t.test('mixed evidence types coexist', () => {
    const tmpHome = mkdtempSync(join(tmpdir(), 'veyra-test-'))
    const store = openEphemeralStore(':memory:', { scope: 'project', projectId: 'test-workspace' })

    try {
      const result = remember(store, {
        title: 'Mixed evidence',
        body: 'All three types',
        evidence: [
          { uri: 'https://example.com/spec' },
          { path: 'src/impl.mjs' },
          { path: 'src/core.mjs', symbol: 'coreLogic', startLine: 42, endLine: 68 }
        ]
      })

      assert.ok(result.record, 'remember() should return {record}')
      assert.equal(result.record.evidence.length, 3)

      // URI-only
      assert.equal(result.record.evidence[0].uri, 'https://example.com/spec')

      // File-level
      assert.equal(result.record.evidence[1].path, 'src/impl.mjs')
      assert.equal(result.record.evidence[1].symbol, undefined)

      // Function-level
      assert.equal(result.record.evidence[2].path, 'src/core.mjs')
      assert.equal(result.record.evidence[2].symbol, 'coreLogic')
      assert.equal(result.record.evidence[2].startLine, 42)
      assert.equal(result.record.evidence[2].endLine, 68)
    } finally {
      store.close()
      rmSync(tmpHome, { recursive: true, force: true })
    }
  })
})
