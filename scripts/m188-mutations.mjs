// m00188 mutation gate — every mutation must be CAUGHT by the m188 suite.
// Run: node scripts/m188-mutations.mjs   (restores src/understand.mjs when done)
import { readFileSync, writeFileSync } from 'node:fs'
import { execSync } from 'node:child_process'
const ROOT = new URL('..', import.meta.url).pathname
const P = `${ROOT}src/understand.mjs`
const orig = readFileSync(P, 'utf8')
const muts = [
  ['K: no pre-match masking', '  const { text: combined, spans } = maskCodeSpans(rawCombined)', '  const { text: combined, spans } = { text: rawCombined, spans: [] }'],
  ['L: allow bare symbol', '    const bareReference = (candidate ?? \'\').split(/\\s+/).filter(Boolean).length === 1\n', '    const bareReference = false\n'],
  ['M: allow "cause is"', '\\s+causes\\s+(?:', '\\s+causes?\\s+'],
  ['N: restore code spans never', '  s = restoreCodeSpans(s, spans)', '  s = s'],
]
let caught = 0
try {
  for (const [name, from, to] of muts) {
    if (!orig.includes(from)) { console.log(name, '-> PATTERN NOT FOUND'); continue }
    writeFileSync(P, orig.replace(from, to))
    let failed = false
    try { execSync('node --test test/m188-governed-activation.test.mjs', { cwd: ROOT, stdio: 'pipe' }) }
    catch { failed = true }
    if (failed) caught++
    console.log(failed ? 'CAUGHT  ' : 'SURVIVED', name)
  }
} finally { writeFileSync(P, orig) }
console.log(`\n${caught}/${muts.length} caught`)
process.exit(caught === muts.length ? 0 : 1)
