// Veyra autonomy-cycle evaluation - mechanics only, never a model-effect claim.
// Usage: node test/eval-autonomy-cycle.mjs [--output /tmp/eval-autonomy.json]
//
// Every metric here describes what the loop *did*, not what a model gained.
// `deliveryCoverage` counts a tool dispatch that returned records; it cannot
// prove the model received them. `tokensPerTurn` is `renderedChars / 4`, an
// estimate - the graded token metric stays docs/research/m00190-preregistration.md M3.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { createToolHarness } from '../src/tools.mjs'
import { maybeLearn, readWriteGateLedger } from '../src/learn.mjs'
import { readAutoOutcomeSignals, readGenerationEvidence, summarizeGenerationEvidence } from '../src/apply-generation-evidence.mjs'
import { extractSymbols } from '../src/understand.mjs'
import { agentFor, roomStore, testRuntime } from './helpers/room.mjs'
import { publishEvalResult } from './helpers/eval-output.mjs'

// Prose that mentions code-shaped words. After the code-shape guard these must
// yield no symbols at all; the absolute count is the check, because a ratio
// against a code fixture would have a zero numerator by construction.
export const PROSE_FIXTURES = [
  'I need to check the body signature and the args that the function receives. The const value is undefined here.',
  'Looking at this, the `const body` line matters.',
  'Cause: of low quality? Let me verify quickly the actual reason: looksDurable = logic',
]

const CHARS_PER_TOKEN = 4

function ratio(numerator, denominator) {
  return denominator > 0 ? numerator / denominator : 0
}

export async function runAutonomyCycle({ home, cwd, turns = 3, seed = true } = {}) {
  const runtime = testRuntime(home, cwd)
  const store = roomStore(home, cwd)
  const agent = agentFor(cwd)
  const tools = createToolHarness(runtime)

  // Seed real, recall-eligible records through the tool surface so recall has
  // something to deliver; `{ agent }` is required or store resolution fails.
  const seeded = []
  if (seed) {
    for (let i = 0; i < 5; i++) {
      const res = await tools.call('veyra_remember', {
        title: `Lesson ${i}: writer lock ordering`,
        body: `Root cause: the writer lock ordering is inverted. ${'Detail sentence. '.repeat(20)}`,
        kind: 'memory',
      }, { agent })
      if (res?.ok && res.record?.id) seeded.push(res.record.id)
    }
  }

  for (let turn = 0; turn < turns; turn++) {
    await tools.call('veyra_recall', { query: 'writer lock ordering', limit: 5 }, { agent })
  }

  // mergeRate needs the write gate, and only maybeLearn writes its ledger.
  // Gated on `seed` so the empty-room case really starts empty.
  if (seed) {
    for (let i = 0; i < 2; i++) {
      maybeLearn(store, {
        title: `Stock drift after restart ${i}`,
        body: 'Root cause: the event bus redelivers in-flight events after restart.\nFiles touched: src/lock.mjs',
        kind: 'memory',
        authority: 'derived',
        source: { automatic: false, tool: 'eval-autonomy-cycle' },
        evidence: [{ path: 'src/lock.mjs', note: 'test-passed' }],
      }, { workspace: cwd })
    }
  }

  const log = readGenerationEvidence(store)
  const entries = log?.entries ?? []
  const summary = summarizeGenerationEvidence(log)
  const ledger = readWriteGateLedger(store)

  const withResults = entries.filter((e) => e.resultCount > 0)
  const delivered = withResults.filter((e) => e.delivery?.status === 'DELIVERED')
  const sets = new Set(entries.map((e) => [...(e.recordRefs || [])].sort().join(',')))
  const totalChars = entries.reduce((sum, e) => sum + (e.renderedChars || 0), 0)

  return {
    tokensPerTurn: entries.length ? (totalChars / CHARS_PER_TOKEN) / entries.length : 0,
    distinctSets: sets.size,
    deliveryCoverage: ratio(delivered.length, withResults.length),
    mergeRate: ledger ? ratio(ledger.decisions.merge, ledger.decisions.accept + ledger.decisions.merge) : 0,
    proseSymbolLeaks: PROSE_FIXTURES.reduce((n, text) => n + extractSymbols(text).length, 0),
    seeded,
    generationCount: entries.length,
    generationSummary: summary,
    autoOutcomeSignals: readAutoOutcomeSignals(store),
    ledger,
    constraints: {
      deliveryClaim: 'tool dispatch returned records; model receipt not provable',
      tokensPerTurn: 'renderedChars / 4, an estimate; graded metric is m00190 M3',
      mergeRate: 'write-gate decisions from maybeLearn, not from veyra_remember',
    },
  }
}

async function main() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'veyra-cycle-home-'))
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'veyra-cycle-repo-'))
  const report = await runAutonomyCycle({ home, cwd, turns: 3 })
  publishEvalResult(report, {
    trackedPath: path.resolve('test/eval-autonomy-cycle-results.json'),
    runPath: path.join(os.tmpdir(), 'eval-autonomy-cycle-results.json'),
    argv: process.argv,
    env: process.env,
    cwd: process.cwd(),
  })
  fs.rmSync(home, { recursive: true, force: true })
  fs.rmSync(cwd, { recursive: true, force: true })
  console.log('--- autonomy cycle ---')
  for (const k of ['tokensPerTurn', 'distinctSets', 'deliveryCoverage', 'mergeRate', 'proseSymbolLeaks']) {
    console.log(`${k}: ${report[k]}`)
  }
}

// The test imports this module, so only run the CLI when invoked directly.
const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href
if (invokedDirectly) main().catch((error) => { console.error('EVAL FAILED:', error); process.exit(1) })
