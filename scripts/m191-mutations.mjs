// m00191 mutation gate — every mutation must be CAUGHT, and caught by the test
// that reads the TEXT, not by a different gate that happens to reject the same
// input. That distinction is the whole point: m06745 requires proof that the
// fix works through correct text processing, so each mutation is run against a
// NARROWED test pattern that contains only the text-layer assertions.
//
//   A7 mutations -> only `A7:` tests   (all of them read buffer.files / body)
//   A5 mutations -> only the A5 text tests, excluding every `gateFor` test
//
// Run: node scripts/m191-mutations.mjs   (restores both sources when done)
import { readFileSync, writeFileSync } from 'node:fs'
import { execSync } from 'node:child_process'

const ROOT = new URL('..', import.meta.url).pathname
const OBSERVE = `${ROOT}src/observe.mjs`
const UNDERSTAND = `${ROOT}src/understand.mjs`
const originals = { [OBSERVE]: readFileSync(OBSERVE, 'utf8'), [UNDERSTAND]: readFileSync(UNDERSTAND, 'utf8') }

const A7_TESTS = 'A7:'
const A5_TEXT_TESTS = 'A5: (instructions|declarative|identical|normalisation|mixed)'
// The checkbox mutations are narrowed to the checkbox tests specifically, so a
// plain-bullet test cannot be the one that catches a checkbox regression.
const A5_CHECKBOX_TESTS = 'A5: (task checkboxes|a numbered task checkbox|checkbox normalisation|every checkbox format|only real checkbox)'

const muts = [
  // ---- A7: modification evidence must come only from a mutating call ----
  ['A7-1: record every tool path as a modification (the original defect)',
    OBSERVE,
    '      if (mutatesFiles(name, args)) collectFiles(buffer.files, args)',
    '      collectFiles(buffer.files, args)',
    A7_TESTS],
  ['A7-2: never treat a known mutator as mutating',
    OBSERVE,
    '  if (MUTATING_TOOLS.has(name)) return true',
    '  if (MUTATING_TOOLS.has(name)) return false',
    A7_TESTS],
  ['A7-3: mutating-tool set emptied',
    OBSERVE,
    "const MUTATING_TOOLS = new Set(['edit', 'write', 'str_replace_editor'])",
    'const MUTATING_TOOLS = new Set([])',
    A7_TESTS],
  ['A7-4: unknown tools count as mutations (read becomes an edit)',
    OBSERVE,
    "  if (name !== 'run_code') return false",
    "  if (name !== 'run_code') return true",
    A7_TESTS],
  ['A7-5: run_code always counts as a mutation',
    OBSERVE,
    "  if (name !== 'run_code') return false",
    "  if (name !== 'run_code') return false\n  return true",
    A7_TESTS],
  ['A7-6: prose-mentioned paths merged back into modification evidence',
    UNDERSTAND,
    '  const files = [...new Set(buffer.files || [])].slice(0, 12)',
    '  const files = [...new Set([...(buffer.files || []), ...extractMentionedPaths(`${user}\\n${assistant}`)])].slice(0, 12)',
    A7_TESTS],

  // ---- A5: the list marker must not change the verdict ----
  ['A5-1: list markers not normalised at all',
    UNDERSTAND,
    "    const bare = sentence.replace(LIST_MARKER, '').replace(TASK_BOX, '')",
    '    const bare = sentence',
    A5_TEXT_TESTS],
  ['A5-2: imperative guard reads the un-normalised sentence',
    UNDERSTAND,
    '    if (IMPERATIVE_START.test(bare)) continue',
    '    if (IMPERATIVE_START.test(sentence)) continue',
    A5_TEXT_TESTS],
  ['A5-3: marker regex can never match a sentence that has content',
    UNDERSTAND,
    'const LIST_MARKER = /^(?:[-*+]|\\d{1,3}[.)])\\s+/',
    'const LIST_MARKER = /^(?:[-*+]|\\d{1,3}[.)])\\s+$/',
    A5_TEXT_TESTS],
  ['A5-4: over-normalisation — every sentence counts as a claim (gate loosened)',
    UNDERSTAND,
    '  for (const sentence of sentences) {',
    '  for (const sentence of sentences) {\n    return true',
    A5_TEXT_TESTS],

  // ---- A5 addendum: the task checkbox must not change the verdict either ----
  // These are the mutations that prove the checkbox fix is load-bearing. Each is
  // run against the checkbox tests ONLY, so the plain-bullet tests cannot be the
  // ones that catch a checkbox regression.
  ['A5-5: task checkbox not stripped (the addendum defect)',
    UNDERSTAND,
    "const TASK_BOX = /^(?:\\[[ xX]\\]\\s*)+/",
    'const TASK_BOX = /^(?:$^)/',
    A5_CHECKBOX_TESTS],
  ['A5-6: checkbox stripped only when a list marker precedes it',
    UNDERSTAND,
    "    const bare = sentence.replace(LIST_MARKER, '').replace(TASK_BOX, '')",
    "    const bare = sentence.replace(/^(?:[-*+]|\\d{1,3}[.)])\\s+(?:\\[[ xX]\\]\\s*)?/, '')",
    A5_CHECKBOX_TESTS],
  ['A5-7: checkbox regex cannot match a sentence with content after it',
    UNDERSTAND,
    "const TASK_BOX = /^(?:\\[[ xX]\\]\\s*)+/",
    "const TASK_BOX = /^(?:\\[[ xX]\\]\\s*)+$/",
    A5_CHECKBOX_TESTS],
  ['A5-8: checkbox strip loosened into a blanket prefix wipe',
    UNDERSTAND,
    "    const bare = sentence.replace(LIST_MARKER, '').replace(TASK_BOX, '')",
    "    const bare = sentence.replace(/^[^A-Za-z0-9]*/, '')",
    A5_CHECKBOX_TESTS],
]

const failNames = (out) => out
  .split('\n')
  .filter((l) => /^\s*✖/.test(l))
  .map((l) => l.replace(/^\s*✖\s*/, '').replace(/\s*\(\d[\d.]*ms\)\s*$/, '').trim())

let caught = 0
const rows = []
try {
  for (const [name, file, from, to, pattern] of muts) {
    const orig = originals[file]
    if (!orig.includes(from)) {
      rows.push([name, 'PATTERN NOT FOUND', ''])
      console.log('PATTERN NOT FOUND', name)
      continue
    }
    if (orig.includes(to) && from !== to && orig.split(from).length > 2) {
      rows.push([name, 'AMBIGUOUS', ''])
      console.log('AMBIGUOUS', name)
      continue
    }
    writeFileSync(file, orig.replace(from, to))
    let caughtBy = []
    let failed = false
    try {
      execSync(`node --test --test-name-pattern='${pattern}' test/m191-evidence-integrity.test.mjs`, {
        cwd: ROOT,
        stdio: 'pipe',
        encoding: 'utf8',
      })
    } catch (error) {
      failed = true
      caughtBy = failNames(String(error.stdout || '') + String(error.stderr || ''))
    }
    // Restore immediately so a crash can never leave a mutated tree behind.
    writeFileSync(file, orig)
    if (failed) caught++
    rows.push([name, failed ? 'CAUGHT' : 'SURVIVED', caughtBy.join('; ')])
    console.log(failed ? 'CAUGHT  ' : 'SURVIVED', name, caughtBy.length ? `-> ${caughtBy[0]}` : '')
  }
} finally {
  // Hard restore + prove it, regardless of how the loop exited.
  for (const [file, text] of Object.entries(originals)) writeFileSync(file, text)
}

let restored = true
for (const [file, text] of Object.entries(originals)) {
  if (readFileSync(file, 'utf8') !== text) restored = false
}
console.log(`\nSource restored byte-for-byte: ${restored ? 'YES' : 'NO'}`)
console.log(`\n${caught}/${muts.length} caught`)
if (rows.length) {
  console.log('\n| mutation | result | caught by |\n| --- | --- | --- |')
  for (const [name, result, by] of rows) console.log(`| ${name} | ${result} | ${by || '—'} |`)
}
process.exit(caught === muts.length && restored ? 0 : 1)
