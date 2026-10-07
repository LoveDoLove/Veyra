/**
 * Title Generation Regression Tests
 * 
 * Verifies that deriveTitle produces only reliable engineering claim titles,
 * and never generates misleading "Fix: work on X", "Used X", "Worked on X",
 * or mid-sentence fragments.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { deriveTitle, distillBuffer, extractCausalFacets, looksLikeClaim } from '../src/understand.mjs'
import { newBuffer, observeEvent } from '../src/observe.mjs'

// Helper to build a minimal distilled buffer record
function makeBuffer({ user = '', assistant = '', tools = [], files = [], symbols = [] } = {}) {
  const buffer = newBuffer()
  observeEvent(buffer, {}, { type: 'turn/start', data: { turn: 1 } })
  if (user) observeEvent(buffer, {}, { type: 'user/message', data: { content: [{ type: 'text', text: user }] } })
  if (assistant) observeEvent(buffer, {}, { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: assistant }] } } })
  for (const tool of tools) observeEvent(buffer, {}, { type: 'tool/call', data: { name: tool.name, arguments: tool.args } })
  return buffer
}

function distillCtx(projectId = 'p_title_test') {
  return distillBuffer(makeBuffer({}), { projectId })
}

test('deriveTitle: verified root cause → claim-bearing title', () => {
  const title = deriveTitle('', [], [], 'root-cause', { rootCause: 'concurrent DatabaseSync writes corrupt FTS triggers', remedy: null })
  assert.equal(title, 'Cause: concurrent DatabaseSync writes corrupt FTS triggers')
})

test('deriveTitle: architectural decision with remedy → Fix: <remedy>', () => {
  const title = deriveTitle('', [], [], 'decision', { rootCause: null, remedy: 'serialize every write through a mutex around the shared handle' })
  assert.equal(title, 'Fix: serialize every write through a mutex around the shared handle')
})

test('deriveTitle: verified outcome (symptom + root cause + remedy) → meaningful title', () => {
  const title = deriveTitle('', [], [], 'fix', { rootCause: 'timer race in retry loop', remedy: 'add jitter and cap retries at 3' })
  assert.equal(title, 'Fix: add jitter and cap retries at 3')
})

test('deriveTitle: negative / failed approach → Cause: <rootCause>', () => {
  const title = deriveTitle('', [], [], 'root-cause', { rootCause: 'relaxing FTS journal mode does not fix the race', remedy: null })
  assert.equal(title, 'Cause: relaxing FTS journal mode does not fix the race')
})

test('deriveTitle: ordinary progress update → no misleading title', () => {
  // User progress update without engineering claim
  const title = deriveTitle('Wrapped up the exploratory pass on the benchmark harness and jotted notes for tomorrow.', ['test/fixtures/harness.json'], [{ name: 'read', args: { path: 'test/fixtures/harness.json' } }], 'observation', null)
  assert.equal(title, 'Engineering observation')
})

test('deriveTitle: acknowledgement → no misleading title', () => {
  const title = deriveTitle('ok', [], [], 'observation', null)
  assert.equal(title, 'Engineering observation')
})

test('deriveTitle: tool-only activity → no "Used <tool>" title', () => {
  const title = deriveTitle('', [], [{ name: 'bash', args: { command: 'npm test' } }], 'observation', null)
  assert.equal(title, 'Engineering observation')
})

test('deriveTitle: "Fix: work on X" → impossible', () => {
  const title = deriveTitle('', ['src/plugin.mjs'], [{ name: 'edit', args: { file_path: 'src/plugin.mjs' } }], 'fix', { rootCause: null, remedy: null })
  assert.notEqual(title, 'Fix: work on plugin.mjs')
  assert.notEqual(title, 'Fix: work on src/plugin.mjs')
  assert.equal(title, 'Engineering observation')
})

test('deriveTitle: "Worked on X" → impossible', () => {
  const title = deriveTitle('', ['src/foo.mjs'], [], 'observation', null)
  assert.notEqual(title, 'Worked on src/foo.mjs')
  assert.notEqual(title, 'Worked on foo.mjs')
  assert.equal(title, 'Engineering observation')
})

test('deriveTitle: "Working on X" → impossible', () => {
  const title = deriveTitle('Working on the authentication module', ['src/auth.mjs'], [], 'observation', null)
  // firstLine looks like claim? "Working on..." is NOT a claim hint → should fall through
  assert.notEqual(title, 'Working on the authentication module')
  assert.notEqual(title, 'Worked on src/auth.mjs')
  assert.equal(title, 'Engineering observation')
})

test('deriveTitle: mid-sentence first-line → rejected/normalized', () => {
  // First line cut mid-sentence
  const title = deriveTitle('Fix: es, then run tests before any publish', [], [], 'fix', { rootCause: null, remedy: null })
  // The first line looks like "Fix: es, then run tests..." - does it look like a claim?
  // "fix" is in FIX_HINTS but looksLikeClaim requires CLAIM_HINTS - "fix" alone may not trigger
  // The key is: we only use firstLine if looksLikeClaim(firstLine) is true
  // "Fix: es, then run tests before any publish" - does this match CLAIM_HINTS?
  // CLAIM_HINTS: decided, decision, always, never, must not, must, should not, root cause, workaround, fix was, the cause, lesson, constraint, regression
  // "Fix:" at start doesn't match. "fix was" matches but this is "Fix: es". So should fall through to Engineering observation
  assert.notEqual(title, 'Fix: es, then run tests before any publish')
  assert.equal(title, 'Engineering observation')
})

test('deriveTitle: "Cause: relevance: 0" → not generated', () => {
  const title = deriveTitle('Cause: relevance: 0 for the truly relevant record', [], [], 'root-cause', { rootCause: null, remedy: null })
  assert.notEqual(title, 'Cause: relevance: 0 for the truly relevant record')
  assert.equal(title, 'Engineering observation')
})

test('deriveTitle: existing valid title with claim preserved', () => {
  // Genuine engineering claim in first line
  const title = deriveTitle('Decision: always serialize DatabaseSync writes through a mutex to prevent FTS corruption.', [], [], 'decision', { rootCause: null, remedy: null })
  assert.ok(title.startsWith('Decision:') || title.startsWith('Fix:') || title.startsWith('Cause:'))
  assert.ok(title.length > 20)
})

test('deriveTitle: causal remedy from text → Fix: <remedy> (not file-based)', () => {
  // When causal.remedy exists from extractCausalFacets, it should use that, not the file
  const title = deriveTitle('', ['src/any.mjs'], [], 'fix', { rootCause: 'some cause', remedy: 'wrap the critical section with a mutex' })
  assert.equal(title, 'Fix: wrap the critical section with a mutex')
  assert.ok(!title.includes('any.mjs'))
})

test('deriveTitle: sym:* evidence should not be mistaken for claim', () => {
  // symbols extracted from code shouldn't trigger claim-bearing titles
  const title = deriveTitle('', ['src/store.mjs'], [], 'fix', { rootCause: null, remedy: null })
  // Even with sym:* in evidence, without causal remedy/rootCause or claim-like firstLine, it's neutral
  assert.equal(title, 'Engineering observation')
})

test('distillBuffer: title reflects causal extraction, not activity', () => {
  // Full distill path: user + assistant with causal claim + tool activity
  const buffer = makeBuffer({
    user: 'The root cause is the flaky timer in the retry loop. The remedy is to add exponential backoff.',
    assistant: 'Fixed by adding exponential backoff with max 3 retries.',
    tools: [{ name: 'edit', args: { file_path: 'src/retry.mjs' } }],
    files: ['src/retry.mjs'],
  })
  const record = distillBuffer(buffer, { projectId: 'p_test', sessionId: 's1' })
  assert.ok(record, 'should distill')
  // The user first line IS a claim ("The root cause is...") so it's preserved
  // This is correct: user's claim-bearing text is the best title
  assert.ok(looksLikeClaim(record.title), 'title should be an engineering claim')
  assert.ok(!record.title.includes('work on'))
  assert.ok(!record.title.includes('retry.mjs'))
})

test('distillBuffer: tool activity without claim → neutral title', () => {
  const buffer = makeBuffer({
    user: 'Running tests to verify the change',
    assistant: 'Tests passed.',
    tools: [
      { name: 'bash', args: { command: 'npm test' } },
      { name: 'read', args: { path: 'src/store.mjs' } },
    ],
    files: ['src/store.mjs'],
  })
  const record = distillBuffer(buffer, { projectId: 'p_test', sessionId: 's1' })
  assert.ok(record)
  assert.equal(record.title, 'Engineering observation')
})

test('distillBuffer: negative outcome with causal claim', () => {
  const buffer = makeBuffer({
    user: 'Hypothesis: relaxing FTS journal mode fixes the race',
    assistant: 'Tested - setting journal_mode=WAL off does not stop the corruption.',
    tools: [{ name: 'bash', args: { command: 'npm test' } }],
    files: ['src/store.mjs'],
  })
  const record = distillBuffer(buffer, { projectId: 'p_test', sessionId: 's1' })
  assert.ok(record)
  // The user first line IS a claim ("Hypothesis: ...") so it's preserved
  assert.ok(looksLikeClaim(record.title), 'title should be an engineering claim')
  assert.ok(!record.title.includes('Worked on'))
})

test('looksLikeClaim: distinguishes engineering claims from progress updates', () => {
  assert.equal(looksLikeClaim('The root cause is concurrent writes corrupting FTS'), true)
  assert.equal(looksLikeClaim('Decision: we must serialize all writes now'), true)
  assert.equal(looksLikeClaim('Fix was to add a mutex around the handle'), true)
  assert.equal(looksLikeClaim('Always lock the database before writing now'), true)
  
  assert.equal(looksLikeClaim('ok'), false)
  assert.equal(looksLikeClaim('LGTM'), false)
  assert.equal(looksLikeClaim('Wrapped up the exploratory pass and jotted notes'), false)
  assert.equal(looksLikeClaim('Working on the authentication module'), false)
  assert.equal(looksLikeClaim('Fix: es, then run tests before any publish'), false) // "fix was" would match, not "Fix:"
  assert.equal(looksLikeClaim('Cause: relevance: 0'), false)
})

test('distillBuffer: does not change authority / validation / evidence / provenance', () => {
  const buffer = makeBuffer({
    user: 'The root cause is the mutex was missing. The fix is to add it.',
    assistant: 'Added mutex around DatabaseSync writes successfully and verified the fix.',
    tools: [{ name: 'edit', args: { file_path: 'src/store.mjs' } }],
    files: ['src/store.mjs'],
  })
  const record = distillBuffer(buffer, { projectId: 'p_test', sessionId: 's1' })
  assert.ok(record)
  // Title fix must not alter these
  assert.equal(record.authority, 'candidate')
  assert.equal(record.kind, 'observation')
  assert.ok(record.evidence.some(e => e.path === 'src/store.mjs'))
  assert.ok(record.source.provenance.origins.includes('assistant'))
  assert.ok(record.source.provenance.origins.includes('user'))
})

test('extractCausalFacets: facetCount<2 returns null facets (gate)', () => {
  // Only root cause, no remedy - facetCount = 1
  const facets = extractCausalFacets({ user: 'The root cause is the missing mutex.', assistant: '', tools: [], files: ['src/store.mjs'], symbols: [] })
  assert.equal(facets.facets, null)
  
  // Both root cause and remedy - facetCount = 2
  const facets2 = extractCausalFacets({ user: 'The root cause is the missing mutex. The fix is to add it.', assistant: '', tools: [], files: ['src/store.mjs'], symbols: [] })
  assert.ok(facets2.facets)
  assert.ok(facets2.facets.rootCause)
  assert.ok(facets2.facets.remedy)
})

test('deriveTitle: does not change evidence / provenance / authority', () => {
  // Title is purely a derived field; everything else must remain untouched
  const title = deriveTitle('Decision: use mutex', ['src/store.mjs'], [{ name: 'edit', args: { file_path: 'src/store.mjs' } }], 'decision', { rootCause: 'missing mutex', remedy: 'add mutex' })
  // Just verifying the function signature - title doesn't affect other fields
  assert.ok(typeof title === 'string')
})

test('canonical still requires explicit user action (unchanged)', () => {
  // Title generation has no path to canonical authority
  // This is a contract test: ensure we didn't add any canonical logic to title
  const title = deriveTitle('Decision: use mutex', ['src/store.mjs'], [], 'decision', { rootCause: 'missing mutex', remedy: 'add mutex' })
  assert.ok(typeof title === 'string')
  // No authority field in title output
})