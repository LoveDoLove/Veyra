/**
 * Veyra — understand / distill a turn.
 *
 * Observe ≠ Store. The session buffer is a lossy activity log. This
 * module turns that log into a structured engineering claim (or null
 * when the turn is noise). Adapted in spirit from PMA `distill.mjs`
 * (file/symbol/hunk evidence, fix-vs-feature titles) without spawning
 * git or writing into the user repo.
 */

import {
  AUTHORITIES,
  CONFIDENCES,
  KINDS,
  MIN_OBSERVATION_CHARS,
  SCOPES,
  STATUSES,
  VALIDATIONS,
} from './types.mjs'
import { scrub } from './redact.mjs'
import { tokenize } from './text.mjs'

const CLAIM_HINTS = [
  /\b(decided|decision|always|never|must not|must\b|should not|root cause|workaround|fix was|the cause|lesson|constraint|regression)\b/i,
  /\b(architecture|race|deadlock|migration|serialize|lock the|do not|remedy|solution|resolved by|caused by|symptom)\b/i,
]

const FIX_HINTS = /\b(fix|bug|error|issue|patch|fail|race|deadlock|corrupt|flake|regress|remedy|workaround)\b/i
const DECISION_HINTS = /\b(decided|decision|always|never|must|should not|do not|constraint)\b/i
const CAUSE_HINTS = /\b(root cause|the cause|caused by|because of|why|reason)\b/i

const SYMBOL_RE = /(?:export\s+)?(?:async\s+)?(?:function\*?|class|const|let|var)\s+([A-Za-z_$][\w$]{2,})/g
const PATH_RE = /(?:^|[\s`'"(])((?:src|test|tests|lib|app|packages|skills)\/[\w./-]+\.[A-Za-z]{1,8})/g

function cleanFacetText(str) {
  if (typeof str !== 'string') return null
  let s = str.trim()
  s = s.replace(/^[:\-—`'"*#\s]+/, '').replace(/[:\-—`'"*#\s]+$/, '')
  s = s.replace(/^(?:to|that|is|was|in)\s+/i, '')
  if (s.length < 5) return null
  return s.slice(0, 200)
}

/**
 * Deterministically extract structured causal facets:
 *   symptom → rootCause → remedy → verifiedOutcome
 *
 * Grounding rules:
 *   - rootCause requires explicit causal attribution in text (never inferred from edits alone).
 *   - remedy requires explicit fix/action claim or intent (never inferred from edit tools alone).
 *   - temporal adjacency (test fail → edit → test pass) alone NEVER creates a causal record.
 *   - simultaneous edits do not arbitrarily choose a root cause.
 */
export function extractCausalFacets({ user = '', assistant = '', tools = [], files = [], symbols = [] } = {}) {
  const combined = `${user}\n${assistant}`.trim()
  if (!combined && tools.length === 0) return null

  // 1. Root Cause extraction (requires explicit causal attribution)
  let rootCause = null
  const rootCauseMatch = combined.match(/\b(?:root\s+cause(?:\s+(?:is|was|:))?|the\s+cause\s+(?:is|was))\s*[:\-—]?\s*([^\n.;]+)/i)
    || combined.match(/\b(?:caused\s+by|the\s+reason\s+(?:is|was))\s*[:\-—]?\s*([^\n.;]+)/i)
    || combined.match(/\b(?:due\s+to|because\s+of)\s+([^\n.;]+)/i)

  if (rootCauseMatch) {
    rootCause = cleanFacetText(rootCauseMatch[1])
  }

  // 2. Remedy extraction (requires explicit remedy/fix action or statement)
  let remedy = null
  const remedyMatch = combined.match(/\b(?:the\s+)?(?:remedy|solution|workaround)(?:\s+(?:is|was|by))?\s*[:\-—]?\s*([^\n.;]+)/i)
    || combined.match(/\b(?:fix(?:ed)?(?:\s+(?:was|is|by))?|resolved\s+by)\s*[:\-—]?\s*([^\n.;]+)/i)
    || combined.match(/\b(?:the\s+)?decision\s+is\s+to\s+([^\n.;]+)/i)
    || combined.match(/\b(?:always\s+serialize|lock\s+the|serialize\s+the|wrap\s+with)\s+([^\n.;]+)/i)

  if (remedyMatch) {
    remedy = cleanFacetText(remedyMatch[1])
  }

  // 3. Symptom extraction
  let symptom = null
  const symptomMatch = combined.match(/\b(?:the\s+)?(?:symptom|issue|problem|bug|error|failure)(?:\s+(?:is|was|:))?\s*[:\-—]?\s*([^\n.;]+)/i)
    || combined.match(/\b(?:failing\s+with|failed\s+with|crashed\s+with|flaking\s+on)\s*[:\-—]?\s*([^\n.;]+)/i)
    || combined.match(/\b((?:flaky|failing)\s+tests?|sqlite\s+writer\s+race|deadlock|concurrency\s+race|data\s+corruption|memory\s+leak)\b/i)

  if (symptomMatch) {
    symptom = cleanFacetText(symptomMatch[1])
  } else {
    for (const t of tools) {
      if (t.name?.includes(':result')) {
        const prev = String(t.preview || t.output || '')
        const failLine = prev.split('\n').find((l) => /(?:FAIL|npm ERR!|Error:)\s+(.+)/i.test(l))
        if (failLine) {
          symptom = cleanFacetText(failLine)
          break
        }
      }
    }
  }

  // 4. Verified Outcome extraction
  let verifiedOutcome = null
  const outcome = testOutcomeFrom(tools, files)
  if (outcome === 'test-passed') {
    verifiedOutcome = 'test-passed'
  } else if (outcome === 'test-failed') {
    verifiedOutcome = 'test-failed'
  }

  // 5. Invariant & Boundedness Check
  // Invariant: Temporal adjacency alone is NOT causality.
  // An established causal link requires at least one core explanation (rootCause OR remedy)
  // paired with another facet (symptom, rootCause, remedy, verifiedOutcome).
  const hasCoreExplanation = Boolean(rootCause || remedy)
  const facetCount = [rootCause, remedy, symptom, verifiedOutcome].filter(Boolean).length

  if (!hasCoreExplanation || facetCount < 2) {
    return null
  }

  return {
    symptom: symptom || null,
    rootCause: rootCause || null,
    remedy: remedy || null,
    verifiedOutcome: verifiedOutcome || null,
  }
}

export function looksLikeClaim(text) {
  if (typeof text !== 'string' || text.length < 40) return false
  return CLAIM_HINTS.some((re) => re.test(text))
}

export function extractSymbols(text) {
  if (typeof text !== 'string') return []
  const found = []
  SYMBOL_RE.lastIndex = 0
  let match
  while ((match = SYMBOL_RE.exec(text))) found.push(match[1])
  return [...new Set(found)].slice(0, 8)
}

export function extractMentionedPaths(text) {
  if (typeof text !== 'string') return []
  const found = []
  PATH_RE.lastIndex = 0
  let match
  while ((match = PATH_RE.exec(text))) found.push(match[1])
  return [...new Set(found)].slice(0, 12)
}

function classifySignal(text, causal = null) {
  if (causal?.rootCause || CAUSE_HINTS.test(text)) return 'root-cause'
  if (causal?.remedy || FIX_HINTS.test(text)) return 'fix'
  if (DECISION_HINTS.test(text)) return 'decision'
  return 'observation'
}

function deriveTitle(user, files, tools, signal, causal = null) {
  const firstLine = String(user || '').split('\n').map((s) => s.trim()).find(Boolean)
  if (firstLine && firstLine.length >= 12) return firstLine.slice(0, 160)
  if (causal?.remedy) return `Fix: ${causal.remedy.slice(0, 120)}`
  if (causal?.rootCause) return `Cause: ${causal.rootCause.slice(0, 120)}`
  const primary = files[0] ? basename(files[0]) : ''
  if (signal === 'fix' && primary) return `Fix: work on ${primary}`
  if (files.length) return `Worked on ${files[0]}`
  if (tools.length) return `Used ${tools[0].name}`
  return 'Engineering observation'
}

function basename(path) {
  const parts = String(path).split(/[\\/]/)
  return parts[parts.length - 1] || path
}

function testOutcomeFrom(tools, files) {
  let hasTestTool = false
  let lastResult = null

  for (const t of tools || []) {
    const name = String(t.name || '')
    const cmd = String(t.args?.command || '')
    const isTestCall = /test/i.test(name) || /test|spec/i.test(cmd)
    if (isTestCall) hasTestTool = true

    if (name.includes(':result')) {
      const prev = String(t.preview || '')
      if (/(?:exit code:\s*[1-9]|npm ERR!|FAIL|\bfail(?:ed|s)?\b|\b[1-9]\d*\s+failed)/i.test(prev)) {
        lastResult = 'test-failed'
      } else if (/(?:✔|✓|\bpass(?:ed)?\b|\bok\b|tests?\s+\d+.*pass|\b0 failed\b)/i.test(prev)) {
        lastResult = 'test-passed'
      }
    }
  }

  if (lastResult) return lastResult
  const fileTest = files && files.some((p) => /test|spec|fixture/i.test(p))
  if (hasTestTool || fileTest) return 'tests-touched'
  return null
}

function evidenceFrom(files, symbols, tools) {
  const items = []
  for (const path of files.slice(0, 12)) {
    items.push({ path })
  }
  for (const symbol of symbols.slice(0, 8)) {
    items.push({ note: `sym:${symbol}` })
  }
  const outcome = testOutcomeFrom(tools, files)
  if (outcome) items.push({ note: outcome })
  return items
}

function tagsFor(signal, files, tools, causal = null) {
  const tags = ['observation', 'auto', signal]
  if (causal) {
    tags.push('causal')
    if (causal.rootCause) tags.push('has-root-cause')
    if (causal.remedy) tags.push('has-remedy')
    if (causal.symptom) tags.push('has-symptom')
  }
  if (files.some((p) => /test|spec/i.test(p))) tags.push('tested')
  const outcome = testOutcomeFrom(tools, files)
  if (outcome === 'test-passed') tags.push('verified-test')
  const names = new Set(tools.map((t) => String(t.name).split(':')[0]))
  if (names.has('edit') || names.has('write') || names.has('str_replace_editor')) tags.push('edited')
  return [...new Set(tags)].slice(0, 16)
}

/**
 * Distill a buffered turn into a candidate observation payload.
 * Returns null when the turn has no engineering signal.
 *
 * Never assigns derived/canonical authority.
 */
export function distillBuffer(buffer, { projectId, sessionId } = {}) {
  if (!buffer) return null
  const user = (buffer.user || []).join('\n').trim()
  const assistant = (buffer.assistant || []).join('\n').trim()
  const files = [...new Set([
    ...(buffer.files || []),
    ...extractMentionedPaths(`${user}\n${assistant}`),
  ])].slice(0, 12)
  const tools = (buffer.tools || []).slice(0, 16)
  const symbols = extractSymbols(`${user}\n${assistant}`)
  const combined = `${user}\n${assistant}`.trim()
  const meaningfulTools = tools.filter((t) => {
    const name = String(t.name).split(':')[0]
    return name === 'bash' || name === 'edit' || name === 'write' || name === 'read'
      || name === 'grep' || name === 'glob' || name === 'str_replace_editor'
  })

  const hasClaim = looksLikeClaim(combined)
  if (meaningfulTools.length < 1 && user.length < 80 && !hasClaim) return null
  if (!hasClaim && meaningfulTools.length < 2 && user.length < 80) return null

  const causal = extractCausalFacets({ user, assistant, tools, files, symbols })
  const signal = classifySignal(combined, causal)
  const title = deriveTitle(user, files, tools, signal, causal)
  const bodyParts = []
  if (user) bodyParts.push(user.slice(0, 1200))
  if (assistant && looksLikeClaim(assistant)) {
    bodyParts.push(`Agent: ${assistant.slice(0, 600)}`)
  }
  if (causal) {
    const causalLines = []
    if (causal.symptom) causalLines.push(`Symptom: ${causal.symptom}`)
    if (causal.rootCause) causalLines.push(`Root cause: ${causal.rootCause}`)
    if (causal.remedy) causalLines.push(`Remedy: ${causal.remedy}`)
    if (causal.verifiedOutcome) causalLines.push(`Verified outcome: ${causal.verifiedOutcome}`)
    if (causalLines.length) {
      bodyParts.push(causalLines.join('\n'))
    }
  }
  if (files.length) bodyParts.push(`Files touched: ${files.join(', ')}`)
  if (symbols.length) bodyParts.push(`Symbols: ${symbols.join(', ')}`)
  if (tools.length) {
    const names = [...new Set(tools.map((t) => t.name))].slice(0, 8)
    bodyParts.push(`Tools: ${names.join(', ')}`)
  }
  const body = scrub(bodyParts.join('\n\n')).scrubbed
  if (body.length < MIN_OBSERVATION_CHARS) return null

  const tokens = [...tokenize(`${title}\n${body}`)].slice(0, 24)
  return {
    kind: KINDS.OBSERVATION,
    status: STATUSES.CURRENT,
    validation: VALIDATIONS.UNVERIFIED,
    authority: AUTHORITIES.CANDIDATE,
    confidence: hasClaim ? CONFIDENCES.MEDIUM : CONFIDENCES.LOW,
    scope: SCOPES.PROJECT,
    projectId,
    title,
    body,
    tags: tagsFor(signal, files, tools, causal),
    evidence: evidenceFrom(files, symbols, tools),
    source: {
      sessionId: sessionId || null,
      turn: buffer.turn,
      tools: tools.map((t) => t.name),
      files,
      symbols,
      signal,
      tokens,
      automatic: true,
      causal: causal || null,
    },
  }
}
