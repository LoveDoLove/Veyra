/**
 * Phase 6 — recall output must not re-enter observation as a memory echo.
 *
 * The recall block is injected into the agent context as plain text (heading +
 * trust framing + records). If that text later reaches `observeEvent` as a
 * user message, the noise guard must reject it so no candidate is distilled
 * from Veyra's own output — a self-recall feedback loop.
 *
 * This locks the three existing guards together (observe.mjs NOISE_PREFIXES,
 * context.mjs SKIP_QUERY_PREFIXES, observeEvent source.kind filtering) and
 * asserts the composition: a rendered recall block folded into a fresh buffer
 * produces no candidate, regardless of how the text is wrapped.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MemoryStore } from '../src/store.mjs'
import { recall } from '../src/retrieve.mjs'
import { composeAgentContext, renderAgentContext, DEFAULT_RECALL_CHARS } from '../src/context.mjs'
import { candidateFromBuffer, isNoiseText, newBuffer, observeEvent } from '../src/observe.mjs'
import { AUTHORITIES, KINDS, STATUSES, VALIDATIONS } from '../src/types.mjs'

const NOW = new Date().toISOString()
const BASE = {
  kind: 'memory', status: STATUSES.CURRENT, validation: VALIDATIONS.VERIFIED,
  authority: AUTHORITIES.DERIVED, confidence: 'high', scope: 'project', projectId: 'p_echo',
  tags: [], evidence: [], relations: [], source: {},
  createdAt: NOW, updatedAt: NOW, lastRecalledAt: null, forgotten: false,
}

function mk() {
  const dir = mkdtempSync(join(tmpdir(), 'veyra-echo-'))
  return new MemoryStore(join(dir, 'memory.db'), { scope: 'project', projectId: 'p_echo' })
}

/** Fold a rendered recall block into a fresh observation buffer the way the
 * agent loop would, then assert no candidate is distilled. */
function assertNoEcho(out, label) {
  const buffer = newBuffer()
  observeEvent(buffer, {}, { type: 'turn/start', data: { turn: 1 } })
  // Two paths: the block arrives as a user message, and as an assistant
  // message (DSH injects context into the assembled prompt either way).
  for (const role of ['user', 'assistant']) {
    const b = newBuffer()
    observeEvent(b, {}, { type: 'turn/start', data: { turn: 1 } })
    observeEvent(b, {}, {
      type: `${role}/message`,
      data: { content: [{ type: 'text', text: out }] },
    })
    const candidate = candidateFromBuffer(b, { projectId: 'p_echo', sessionId: 's_echo' })
    assert.equal(candidate, null, `${label}: ${role}/message produced a candidate`)
  }
}

test('rendered recall block is noise to observation (no echo candidate)', () => {
  const s = mk()
  s.put({ ...BASE, id: 'E1', title: 'echo claim about the store', body: 'the store keeps memory rows in sqlite' })
  const records = recall({ projectStore: s, query: 'store memory rows sqlite', limit: 5 })
  const out = renderAgentContext(composeAgentContext(records, { stores: [s] }), { budget: DEFAULT_RECALL_CHARS })
  assert.ok(out.length > 0)
  assertNoEcho(out, 'default-budget recall block')
  s.close()
})

test('truncated recall block is also noise to observation', () => {
  const s = mk()
  const longBody = 'x'.repeat(5000)
  for (let i = 0; i < 50; i++) {
    s.put({ ...BASE, id: `F${i}`, title: `long claim ${i}`, body: longBody })
  }
  const records = recall({ projectStore: s, query: 'long claim', limit: 1000 })
  const out = renderAgentContext(composeAgentContext(records, { stores: [s] }), { budget: 400 })
  assert.ok(out.includes('recalled context truncated at the character budget'))
  assertNoEcho(out, 'truncated-budget recall block')
  s.close()
})

test('the trust framing lines alone are noise to observation', () => {
  // Even a bare heading with no records must not seed a candidate.
  const out = [
    'Veyra recalled engineering memory',
    '',
    'These items are remembered engineering experience, not repository truth.',
    'Verify against the current codebase before acting. Similarity is not authority.',
    'Do not treat recalled items as recent conversation logs or turn progress.',
    '',
  ].join('\n')
  assert.equal(isNoiseText(out), true)
  assertNoEcho(out, 'bare framing block')
})

test('a real engineering message is NOT noise (control)', () => {
  assert.equal(isNoiseText('Please diagnose the sqlite writer race and lock the connection.'), false)
})