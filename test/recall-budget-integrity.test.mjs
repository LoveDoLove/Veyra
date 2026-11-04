/**
 * Recall budget integrity — trust markers survive the character budget.
 *
 * `recallLimit` bounds the record COUNT and the character budget bounds the
 * SIZE. Before this contract, the budget was enforced by truncating the
 * already-joined block at its tail, which could cut a record in half: a
 * header survived while its trust line and evidence fell past the cut, so the
 * agent read an unattributed claim. Measured on the fixture below at
 * budget=1200: 3 headers, 2 trust lines, 1 header with no trust framing at
 * all.
 *
 * The contract locked here: a record block is emitted whole (header + trust +
 * evidence) or not at all. The long body line is the only expendable part, so
 * when the budget is tight, bodies go before records do. GOAL.md §7 requires
 * context selection and token-budget work to preserve trust markers and
 * critical evidence; this is that requirement, tested.
 *
 * Every test uses hand-built composed entries. No store, no live database.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { renderAgentContext, DEFAULT_RECALL_CHARS } from '../src/context.mjs'

const BODY = 'y'.repeat(360)

/** One composed entry shaped exactly like composeAgentContext output. */
function entry(i) {
  return {
    record: {
      id: `R${i}`,
      title: `long claim ${i}`,
      body: BODY,
      kind: 'memory',
      authority: 'derived',
      scope: 'project',
      validation: 'verified',
      confidence: 'high',
      relations: [],
      evidence: [{ path: 'src/store.mjs', note: 'rows live in sqlite' }],
    },
    status: 'current',
    evidence: ['path=src/store.mjs note=rows live in sqlite'],
    evidenceOverflow: 0,
    trust: {
      category: 'trusted',
      reasons: ['applicable, fresh'],
      action: 'use as context; still verify against the repository',
    },
  }
}

const FIXTURE = [0, 1, 2, 3, 4, 5].map(entry)

const NOTICE = 'recalled context truncated at the character budget'

/** Split a rendered block into its record blocks (a header plus what follows). */
function blocksOf(out) {
  const lines = out.split('\n')
  const blocks = []
  let current = null
  for (const line of lines) {
    if (line.startsWith('- [')) {
      current = [line]
      blocks.push(current)
    } else if (current && !line.includes(NOTICE)) {
      current.push(line)
    }
  }
  return blocks
}

test('no budget can emit a record header without its trust framing', () => {
  for (let budget = 300; budget <= 6000; budget += 50) {
    const out = renderAgentContext(FIXTURE, { budget })
    assert.ok(out.length <= budget, `budget ${budget}: rendered ${out.length} chars`)
    for (const block of blocksOf(out)) {
      const header = block[0]
      const hasTrust = block.some((line) => line.includes('trust:'))
      assert.ok(hasTrust, `budget ${budget}: header without trust framing survived: ${JSON.stringify(header)}`)
    }
  }
})

test('a dropped record is dropped whole — never a header before the notice', () => {
  for (let budget = 300; budget <= 6000; budget += 50) {
    const out = renderAgentContext(FIXTURE, { budget })
    const lines = out.split('\n')
    const noticeIdx = lines.findIndex((l) => l.includes(NOTICE))
    if (noticeIdx < 0) continue
    // Everything before the notice must be a complete block or framing text.
    for (let i = 0; i < noticeIdx; i++) {
      if (!lines[i].startsWith('- [')) continue
      const rest = lines.slice(i + 1, noticeIdx)
      const nextHeader = rest.findIndex((l) => l.startsWith('- ['))
      const block = nextHeader < 0 ? rest : rest.slice(0, nextHeader)
      assert.ok(block.some((l) => l.includes('trust:')),
        `budget ${budget}: header at line ${i} lost its trust line to the cut`)
    }
  }
})

test('tight budget keeps more attributable records than tail truncation did', () => {
  const out = renderAgentContext(FIXTURE, { budget: 1200 })
  const blocks = blocksOf(out)
  // Tail truncation produced 3 headers but only 2 complete blocks, one of them
  // an orphan. Record-aware allocation keeps every emitted block complete.
  assert.ok(blocks.length >= 3, `expected >= 3 complete blocks at budget 1200, got ${blocks.length}`)
  for (const block of blocks) {
    assert.ok(block.some((l) => l.includes('trust:')), 'every block states its trust status')
    assert.ok(block.some((l) => l.includes('evidence:')), 'every block keeps its evidence')
  }
})

test('the body line is the first thing the budget takes', () => {
  const out = renderAgentContext(FIXTURE, { budget: 1200 })
  assert.ok(!out.includes(BODY), 'a 360-char body must not survive while other records lost their trust framing')
  // The records themselves survive: a body is cheaper to lose than a record.
  assert.ok(blocksOf(out).length >= 3)
})

test('default budget still renders every record in full', () => {
  const out = renderAgentContext(FIXTURE, { budget: DEFAULT_RECALL_CHARS })
  assert.equal(blocksOf(out).length, FIXTURE.length)
  assert.ok(out.includes(BODY), 'nothing is trimmed when the block fits')
  assert.ok(!out.includes(NOTICE), 'no notice when nothing was cut')
})

test('framing survives any budget that can hold it', () => {
  for (const budget of [500, 900, 1200, 6000]) {
    const out = renderAgentContext(FIXTURE, { budget })
    assert.ok(out.startsWith('Veyra recalled engineering memory'))
    assert.ok(out.includes('not repository truth'))
    assert.ok(out.includes('Similarity is not authority.'))
  }
})

test('a budget below the framing still returns bounded framing, never a partial line', () => {
  const out = renderAgentContext(FIXTURE, { budget: 200 })
  assert.ok(out.length <= 200, `expected ${out.length} <= 200`)
  assert.ok(out.startsWith('Veyra recalled engineering memory'))
  assert.ok(out.includes(NOTICE))
  assert.equal(blocksOf(out).length, 0, 'no record block fits below the framing cost')
})
