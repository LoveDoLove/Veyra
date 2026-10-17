/**
 * Phase 6 — Recall intake character budget.
 *
 * `recallLimit` bounds the record COUNT, not the SIZE. An extreme limit with
 * long bodies could otherwise expand the injected context without bound.
 * This file locks the budget contract on the same intake surface the
 * reference implementation guards (MemoryCore auto-recall applyRecallBudget):
 * the rendered recall block is capped to a fixed character budget, including
 * memories, evidence, banners, trust lines and the truncation notice.
 *
 * Every test uses a temporary store. No live database is touched.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MemoryStore } from '../src/store.mjs'
import { recall } from '../src/retrieve.mjs'
import { composeAgentContext, renderAgentContext, DEFAULT_RECALL_CHARS, normalizeRecallChars } from '../src/context.mjs'
import { AUTHORITIES, KINDS, STATUSES, VALIDATIONS } from '../src/types.mjs'

const NOW = new Date().toISOString()
const BASE = {
  kind: 'memory', status: STATUSES.CURRENT, validation: VALIDATIONS.VERIFIED,
  authority: AUTHORITIES.DERIVED, confidence: 'high', scope: 'project', projectId: 'p_budget',
  tags: [], evidence: [], relations: [], source: {},
  createdAt: NOW, updatedAt: NOW, lastRecalledAt: null, forgotten: false,
}

function mk() {
  const dir = mkdtempSync(join(tmpdir(), 'veyra-budget-'))
  return new MemoryStore(join(dir, 'memory.db'), { scope: 'project', projectId: 'p_budget' })
}

/** Compose + render exactly the way buildRecallContext does. */
function context(store, query, limit = 5, budget = DEFAULT_RECALL_CHARS) {
  const records = recall({ projectStore: store, query, limit })
  return renderAgentContext(composeAgentContext(records, { stores: [store] }), { budget })
}

test('normalizeRecallChars: invalid/negative/small → default', () => {
  assert.equal(normalizeRecallChars(undefined), DEFAULT_RECALL_CHARS)
  assert.equal(normalizeRecallChars(null), DEFAULT_RECALL_CHARS)
  assert.equal(normalizeRecallChars(''), DEFAULT_RECALL_CHARS)
  assert.equal(normalizeRecallChars(NaN), DEFAULT_RECALL_CHARS)
  assert.equal(normalizeRecallChars(-100), DEFAULT_RECALL_CHARS)
  assert.equal(normalizeRecallChars(0), DEFAULT_RECALL_CHARS)
  assert.equal(normalizeRecallChars(100), 200) // floor of 200
  assert.equal(normalizeRecallChars(200), 200)
  assert.equal(normalizeRecallChars(1.9), 200) // floored then clamped to the 200 floor
  assert.equal(normalizeRecallChars(6000), 6000)
})

test('no records → empty string (budget does not apply)', () => {
  const s = mk()
  assert.equal(context(s, 'nothing here'), '')
  s.close()
})

test('small recall stays under the default budget', () => {
  const s = mk()
  s.put({ ...BASE, id: 'B1', title: 'a small claim', body: 'the store keeps memory rows in sqlite' })
  const out = context(s, 'store memory rows sqlite')
  assert.ok(out.length > 0)
  assert.ok(out.length <= DEFAULT_RECALL_CHARS, `expected ${out.length} <= ${DEFAULT_RECALL_CHARS}`)
  s.close()
})

test('extreme recallLimit with long bodies is capped at the budget', () => {
  const s = mk()
  const longBody = 'x'.repeat(5000)
  for (let i = 0; i < 50; i++) {
    s.put({ ...BASE, id: `B${i}`, title: `long claim ${i}`, body: longBody })
  }
  const out = context(s, 'long claim', 1000)
  assert.ok(out.length > 0)
  assert.ok(out.length <= DEFAULT_RECALL_CHARS,
    `expected ${out.length} <= ${DEFAULT_RECALL_CHARS}`)
  // The cut is stated explicitly and the heading survives.
  assert.ok(out.startsWith('Veyra recalled engineering memory'))
  assert.ok(out.includes('recalled context truncated at the character budget'))
  s.close()
})

test('custom budget is honoured', () => {
  const s = mk()
  const longBody = 'x'.repeat(5000)
  for (let i = 0; i < 50; i++) {
    s.put({ ...BASE, id: `C${i}`, title: `long claim ${i}`, body: longBody })
  }
  const out = context(s, 'long claim', 1000, 1200)
  assert.ok(out.length <= 1200, `expected ${out.length} <= 1200`)
  assert.ok(out.includes('recalled context truncated at the character budget'))
  s.close()
})

test('budget never drops the trust framing', () => {
  const s = mk()
  const longBody = 'x'.repeat(5000)
  for (let i = 0; i < 50; i++) {
    s.put({ ...BASE, id: `D${i}`, title: `long claim ${i}`, body: longBody })
  }
  // 500 chars keeps the heading + the full trust framing (6 lines, ~260 chars)
  // plus at least one complete record line before the cut.
  const out = context(s, 'long claim', 1000, 500)
  assert.ok(out.startsWith('Veyra recalled engineering memory'))
  assert.ok(out.includes('These items are remembered engineering experience, not repository truth.'))
  assert.ok(out.includes('Similarity is not authority.'))
  assert.ok(out.includes('recalled context truncated at the character budget'))
  s.close()
})

test('budget cut drops partial lines whole', () => {
  const s = mk()
  const longBody = 'x'.repeat(5000)
  for (let i = 0; i < 50; i++) {
    s.put({ ...BASE, id: `E${i}`, title: `long claim ${i}`, body: longBody })
  }
  const out = context(s, 'long claim', 1000, 400)
  const lines = out.split('\n')
  const noticeIdx = lines.findIndex((l) => l.includes('recalled context truncated'))
  assert.ok(noticeIdx > 0)
  // The line immediately before the notice is a complete record header —
  // never a half-rendered body line. Empty separator lines are legitimate.
  const prev = lines[noticeIdx - 1]
  assert.ok(prev.startsWith('- [E'), `expected a record header before the notice, got: ${JSON.stringify(prev)}`)
  // No body line (the "  xxxx" indented body) survives the cut.
  for (let i = 0; i < noticeIdx; i++) {
    assert.ok(!lines[i].match(/^  x{100,}$/), `partial body line survived: ${lines[i].slice(0, 40)}…`)
  }
  s.close()
})