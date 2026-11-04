/**
 * Recall budget allocation — one oversized record must not starve the rest.
 *
 * The character budget is enforced by `joinWithBudget` (`src/context.mjs`),
 * which walks the ranked record blocks and keeps the longest prefix that fits.
 * It used to STOP at the first block that did not fit, so a single oversized
 * record at the head of the ranking emptied recall completely: the agent got
 * framing plus the truncation notice and not one attributable record, even
 * though the smaller records behind it would have fitted many times over.
 *
 * Measured on the fixture below (one causal record of ~2.4k rendered chars,
 * followed by 8 records of ~190 chars each): budgets 400..2500 returned ZERO
 * record headers. A recall that returns nothing because rank 1 was verbose is
 * a silent retrieval failure — the agent cannot tell "nothing matched" from
 * "the budget was spent on one item".
 *
 * The contract locked here, adapted from dsh-engram's `fitWithinBudget`
 * (`src/retrieve/budget.ts`: an item that does not fit is skipped and the
 * scan continues): the allocator may skip a block that does not fit and keep
 * considering shorter later blocks. Selection stays greedy in rank order, so
 * a skipped block never outranks a kept one.
 *
 * A block has two tiers (see `joinWithBudget`): attribution (header, trust,
 * evidence) is never dropped, while detail (body line, causal facets) is
 * expendable and recoverable through `veyra_recall`. An oversized record
 * therefore keeps its place at attribution size instead of being dropped
 * whole, and it never costs a peer its own place.
 *
 * Every test uses hand-built composed entries. No store, no live database.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { renderAgentContext, DEFAULT_RECALL_CHARS } from '../src/context.mjs'

const NOTICE = 'recalled context truncated at the character budget'

/** One composed entry shaped exactly like composeAgentContext output. */
function entry(i, { causal = null } = {}) {
  return {
    record: {
      id: `R${i}`,
      title: `claim ${i}`,
      body: 'b'.repeat(200),
      kind: 'memory',
      authority: 'derived',
      scope: 'project',
      validation: 'verified',
      confidence: 'high',
      relations: [],
      evidence: [{ path: 'src/store.mjs', note: 'rows live in sqlite' }],
      ...(causal ? { source: { causal } } : {}),
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

/** A record whose rendered block is far larger than a small record's whole block. */
const OVERSIZED = {
  symptom: 'S'.repeat(600),
  rootCause: 'C'.repeat(600),
  remedy: 'M'.repeat(600),
  verifiedOutcome: 'O'.repeat(600),
}

const SMALL = [1, 2, 3, 4, 5, 6, 7, 8].map((i) => entry(i))

/** Header ids present in the rendered context, in order. */
function idsOf(out) {
  return [...out.matchAll(/^- \[([A-Za-z0-9_]+)\]/gm)].map((m) => m[1])
}

/** Split rendered output into record blocks, keyed by header id. */
function blocksOf(out) {
  const blocks = []
  let current = null
  for (const line of out.split('\n')) {
    if (line.startsWith('- [')) {
      current = { header: line, lines: [line] }
      blocks.push(current)
    } else if (current) {
      current.lines.push(line)
    }
  }
  return blocks
}

test('an oversized rank-1 record does not starve the records behind it', () => {
  const composed = [entry(0, { causal: OVERSIZED }), ...SMALL]
  const out = renderAgentContext(composed, { budget: 1200 })
  const ids = idsOf(out)
  assert.ok(out.length <= 1200, `output exceeded the budget: ${out.length}`)
  assert.ok(
    ids.length >= 3,
    `budget 1200 kept ${ids.length} record(s); one oversized head emptied recall: ${JSON.stringify(ids)}`,
  )
  // R0 may appear now that detail is expendable, but only stripped of its
  // causal facets: its attribution is ~170 chars, its facets are ~2.4k.
  const r0 = blocksOf(out).find((b) => b.header.startsWith('- [R0]'))
  if (r0) {
    assert.ok(!r0.lines.some((l) => l.startsWith('  • Symptom:')), 'oversized detail was half-rendered')
  }
  assert.ok(ids.includes('R1'), `the record behind the oversized head was starved: ${JSON.stringify(ids)}`)
})

test('starvation does not depend on where the oversized record ranks', () => {
  const composed = [entry(1), entry(2), entry(0, { causal: OVERSIZED }), entry(3), entry(4)]
  const out = renderAgentContext(composed, { budget: 1200 })
  const ids = idsOf(out)
  // At 1200 chars the framing (262), the notice (84) and five attributions do
  // not all fit, so the LAST record may still fall off the end — that is
  // budget exhaustion, not starvation. What must not happen is that the
  // oversized block empties the recall behind it.
  assert.ok(
    ids.includes('R3'),
    `records ranked after the oversized block were starved: ${JSON.stringify(ids)}`,
  )
  // Greedy in rank order: a skipped block never displaces a higher-ranked one.
  assert.deepEqual(ids.slice(0, 2), ['R1', 'R2'])
  const r0 = blocksOf(out).find((b) => b.header.startsWith('- [R0]'))
  if (r0) {
    assert.ok(!r0.lines.some((l) => l.startsWith('  • Symptom:')), 'oversized detail was half-rendered')
  }
})

test('every emitted block still carries its trust line', () => {
  const composed = [entry(0, { causal: OVERSIZED }), ...SMALL]
  for (let budget = 400; budget <= 4000; budget += 100) {
    const out = renderAgentContext(composed, { budget })
    assert.ok(out.length <= budget, `budget ${budget}: output ${out.length} exceeded it`)
    for (const block of blocksOf(out)) {
      assert.ok(
        block.lines.some((l) => l.includes('trust:')),
        `budget ${budget}: header lost its trust line: ${JSON.stringify(block.header)}`,
      )
    }
  }
})

test('a dropped record is dropped whole, never a header before the notice', () => {
  const composed = [entry(0, { causal: OVERSIZED }), ...SMALL]
  for (let budget = 400; budget <= 4000; budget += 100) {
    const out = renderAgentContext(composed, { budget })
    const lines = out.split('\n')
    const noticeIdx = lines.findIndex((l) => l.includes(NOTICE))
    if (noticeIdx < 0) continue
    const before = lines.slice(0, noticeIdx)
    for (let i = 0; i < before.length; i += 1) {
      if (!before[i].startsWith('- [')) continue
      const rest = before.slice(i + 1)
      const nextHeader = rest.findIndex((l) => l.startsWith('- ['))
      const blockLines = nextHeader < 0 ? rest : rest.slice(0, nextHeader)
      assert.ok(
        blockLines.some((l) => l.includes('trust:')),
        `budget ${budget}: header at line ${i} lost its trust line to the cut`,
      )
    }
  }
})

test('nothing is dropped when the whole recall fits', () => {
  const composed = SMALL
  const out = renderAgentContext(composed, { budget: DEFAULT_RECALL_CHARS })
  assert.equal(idsOf(out).length, SMALL.length)
  assert.ok(!out.includes(NOTICE), 'a fitting recall must not claim truncation')
})

test('a cut recall always says so', () => {
  const composed = [entry(0, { causal: OVERSIZED }), ...SMALL]
  for (const budget of [400, 800, 1200, 2000]) {
    const out = renderAgentContext(composed, { budget })
    assert.ok(idsOf(out).length < composed.length)
    assert.ok(out.includes(NOTICE), `budget ${budget}: silent drop`)
  }
})

/** A causal record whose detail lines alone exceed the whole budget. */
const HUGE_DETAIL = {
  symptom: 'S'.repeat(1500),
  rootCause: 'C'.repeat(1500),
  remedy: 'M'.repeat(1500),
  verifiedOutcome: 'O'.repeat(1500),
}

test('a record too big to fit whole is still emitted with its attribution', () => {
  // Measured before the fix: this record's block renders ~6.2k chars, so at the
  // DEFAULT budget it was dropped entirely and recall returned framing plus the
  // notice — zero attributable records — even though its header, trust line and
  // evidence are ~170 chars. The causal facets are detail: expendable, and
  // recoverable through veyra_recall. The attribution is not.
  const composed = [entry(0, { causal: HUGE_DETAIL })]
  const out = renderAgentContext(composed, { budget: DEFAULT_RECALL_CHARS })
  assert.ok(out.length <= DEFAULT_RECALL_CHARS, `output ${out.length} exceeded the default budget`)
  assert.deepEqual(idsOf(out), ['R0'], 'the only record in the recall was dropped instead of trimmed')
  const block = blocksOf(out)[0]
  assert.ok(block.lines.some((l) => l.includes('trust:')), 'kept block lost its trust line')
  assert.ok(block.lines.some((l) => l.includes('evidence:')), 'kept block lost its evidence')
  assert.ok(
    !block.lines.some((l) => l.startsWith('  • Symptom:')),
    'detail that does not fit must be dropped, not half-rendered',
  )
})

test('detail is expendable, so it never costs a peer its place', () => {
  const composed = [entry(0, { causal: HUGE_DETAIL }), entry(1), entry(2)]
  const out = renderAgentContext(composed, { budget: DEFAULT_RECALL_CHARS })
  assert.deepEqual(idsOf(out), ['R0', 'R1', 'R2'])
  for (const block of blocksOf(out)) {
    assert.ok(block.lines.some((l) => l.includes('trust:')), 'a kept block lost its trust line')
  }
})

test('a record that fits keeps its causal detail in full', () => {
  const causal = { symptom: 'cache misses', rootCause: 'stale key', remedy: 'bump the key', verifiedOutcome: 'fixed' }
  const out = renderAgentContext([entry(0, { causal })], { budget: DEFAULT_RECALL_CHARS })
  const block = blocksOf(out)[0]
  for (const label of ['Symptom:', 'Root cause:', 'Remedy:', 'Outcome:']) {
    assert.ok(block.lines.some((l) => l.includes(label)), `fitting record lost ${label}`)
  }
})

test('spare budget restores detail to the highest-ranked records', () => {
  // Maximising attributable records must not throw the rest of the budget away.
  // Measured before this contract: 1 oversized record + 8 small ones at the
  // default budget emitted all 9 headers in 2201 chars with ZERO detail lines,
  // leaving ~3.8k of budget unused. The trimmed pass decides WHICH records
  // survive; whatever room is left then restores detail, highest rank first.
  const composed = [entry(0, { causal: OVERSIZED }), ...SMALL]
  const out = renderAgentContext(composed, { budget: DEFAULT_RECALL_CHARS })
  const ids = idsOf(out)
  assert.equal(ids.length, 9, `trimming cost a record its place: ${JSON.stringify(ids)}`)
  assert.ok(out.length <= DEFAULT_RECALL_CHARS, `output ${out.length} exceeded the default budget`)
  assert.ok(
    out.length > 3000,
    `only ${out.length} of ${DEFAULT_RECALL_CHARS} chars were used; detail was left out`,
  )
  assert.ok(out.includes('  • Symptom:'), 'no detail line survived although budget was left over')
  // Rank order: the restored detail belongs to the first record, not a later one.
  const first = blocksOf(out)[0]
  assert.ok(
    first.lines.some((l) => l.startsWith('  • Symptom:')),
    'detail was restored out of rank order',
  )
})

test('restoring detail never costs a record its place', () => {
  const composed = [entry(0, { causal: OVERSIZED }), ...SMALL]
  for (let budget = 400; budget <= 6000; budget += 200) {
    const out = renderAgentContext(composed, { budget })
    const blocks = blocksOf(out)
    assert.equal(
      blocks.filter((b) => b.lines.some((l) => l.includes('trust:'))).length,
      blocks.length,
      `budget ${budget}: a restored block lost its trust line`,
    )
  }
})
