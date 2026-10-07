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
  PROVENANCE_ORIGINS,
  SCOPES,
  STATUSES,
  VALIDATIONS,
} from './types.mjs'
import { scrub } from './redact.mjs'
import { tokenize } from './text.mjs'
import { provenanceDimensions } from './ids.mjs'

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

// ── M12 C2: Distillation Quality Gate ──────────────────────────────────────
//
// Deterministic structural validation of a single extracted text facet.
// Drops malformed facets (regex artifacts, truncated captures, punctuation
// fragments) WITHOUT ever rewriting or fabricating content. Returns the
// original string when structurally sound, `null` when it must be dropped.
//
// Rules (in order):
//   R1 non-string / empty
//   R2 shorter than the extraction floor
//   R3 must START with an ASCII letter (kills leading punctuation artifacts)
//   R4 first word must be >=2 chars and not a bare suffix fragment
//   R6 bracket/quote delimiters must be balanced (kills truncation artifacts)
//   R7 last word must not be a truncated stub (>=3 chars, or a stop word)
const VERIFIED_OUTCOMES = new Set(['test-passed', 'test-failed', 'tests-touched'])

// Bare suffix fragments that never begin an English word — a leading token in
// this set means the capture started mid-word.
const SUFFIX_FRAGMENTS = new Set([
  'ing', 'tion', 'sion', 'ness', 'ful', 'less', 'able', 'ible', 'ous',
  'ive', 'ally', 'ation', 'izing', 'ement',
])

// Complete short words that may legitimately end a facet.
const SHORT_END_WORDS = new Set([
  'a', 'an', 'to', 'in', 'is', 'it', 'of', 'on', 'or', 'up', 'no', 'so',
  'be', 'we', 'he', 'do', 'if', 'as', 'at', 'by', 'for', 'the', 'via',
  'per', 'and', 'but', 'not', 'with', 'from', 'into', 'out', 'off',
])

export function qualityGateFacet(value) {
  if (typeof value !== 'string') return null
  const s = value.trim()
  if (s.length < 5) return null

  // R3: must start with a letter.
  if (!/^[A-Za-z]/.test(s)) return null

  const words = s.split(/\s+/)

  // R4: first word must be >=2 chars and not a bare suffix fragment.
  const first = words[0].replace(/[^A-Za-z0-9]/g, '')
  if (first.length < 2) return null
  if (SUFFIX_FRAGMENTS.has(first.toLowerCase())) return null

  // R6: balanced brackets and even double-quote count.
  const openParens = (s.match(/\(/g) || []).length
  const closeParens = (s.match(/\)/g) || []).length
  const openBrackets = (s.match(/\[/g) || []).length
  const closeBrackets = (s.match(/\]/g) || []).length
  const doubleQuotes = (s.match(/"/g) || []).length
  if (openParens !== closeParens) return null
  if (openBrackets !== closeBrackets) return null
  if (doubleQuotes % 2 !== 0) return null

  // R7: last word must not be a truncated stub.
  const last = words[words.length - 1].replace(/^[^A-Za-z0-9]+|[^A-Za-z0-9]+$/g, '')
  if (last.length < 3 && !SHORT_END_WORDS.has(last.toLowerCase())) return null

  return s
}

/**
 * Apply the quality gate to a full facet set. Drops invalid text facets
 * (sets them to null). Never fabricates or rewrites. `verifiedOutcome` is
 * validated against the closed enum rather than free text.
 *
 * @returns {{ facets: object, dropped: string[] }}
 */
function qualityGateFacets(raw) {
  const dropped = []
  const out = {}
  for (const key of ['symptom', 'rootCause', 'remedy']) {
    const val = raw?.[key] ?? null
    const gated = qualityGateFacet(val)
    if (val != null && gated === null) dropped.push(key)
    out[key] = gated
  }
  const outcome = raw?.verifiedOutcome ?? null
  if (outcome != null && !VERIFIED_OUTCOMES.has(outcome)) {
    dropped.push('verifiedOutcome')
    out.verifiedOutcome = null
  } else {
    out.verifiedOutcome = outcome
  }
  return { facets: out, dropped }
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
  if (!combined && tools.length === 0) return { facets: null, toolSymptom: false }

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
  // `toolSymptom` is internal return metadata: true only when the symptom
  // text itself came from a tool result preview (not from user/assistant
  // text). It lets distillBuffer record the `tool` provenance origin without
  // parsing the rendered body or persisting an extra field.
  let symptom = null
  let toolSymptom = false
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
          toolSymptom = Boolean(symptom)
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

  // 5. M12 C2 — Distillation Quality Gate
  // Drop malformed facets at the capture boundary. Structural validation only:
  // never rewrite, never fabricate. Raw evidence (evidence[], source.*) is
  // preserved unchanged by distillBuffer; only the derived causal lines shrink.
  const { facets: gated } = qualityGateFacets({ symptom, rootCause, remedy, verifiedOutcome })
  // If the symptom facet was dropped, a tool-preview symptom no longer contributes.
  const gatedToolSymptom = gated.symptom == null ? false : toolSymptom

  // 6. Invariant & Boundedness Check (evaluated on GATED facets)
  // Invariant: Temporal adjacency alone is NOT causality.
  // An established causal link requires at least one core explanation (rootCause OR remedy)
  // paired with another facet (symptom, rootCause, remedy, verifiedOutcome).
  const hasCoreExplanation = Boolean(gated.rootCause || gated.remedy)
  const facetCount = [gated.rootCause, gated.remedy, gated.symptom, gated.verifiedOutcome].filter(Boolean).length

  if (!hasCoreExplanation || facetCount < 2) {
    return { facets: null, toolSymptom: gatedToolSymptom }
  }

  return { facets: gated, toolSymptom: gatedToolSymptom }
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

export function deriveTitle(user, files, tools, signal, causal = null) {
  // Only use first user line if it looks like an engineering claim (not a progress update)
  const firstLine = String(user || '').split('\n').map((s) => s.trim()).find(Boolean)
  if (firstLine && firstLine.length >= 12 && looksLikeClaim(firstLine)) return firstLine.slice(0, 160)
  
  // Genuine causal claims from text — the only reliable engineering titles
  if (causal?.remedy) return `Fix: ${causal.remedy.slice(0, 120)}`
  if (causal?.rootCause) return `Cause: ${causal.rootCause.slice(0, 120)}`
  
  // No reliable claim found → neutral, non-misleading fallback
  // Never generate "Fix: work on X", "Worked on X", "Used X" — those are activity descriptions, not engineering claims
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
export function distillBuffer(buffer, { projectId, sessionId, cwd, agent } = {}) {
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

  const { facets: causal, toolSymptom } = extractCausalFacets({ user, assistant, tools, files, symbols })
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

  // M8 capture provenance: which source streams materially contributed
  // text/content to this record. `user`/`assistant` follow stream
  // non-emptiness (everything each stream contributed went through the
  // distillation above). `tool` is set only when tool-originated CONTENT is
  // in the record: a preview-sourced causal symptom line, or an
  // activity-only record with both role streams empty (body synthesized
  // from tool activity). Tool/file/symbol names in derived metadata never
  // add `tool`. Canonical order comes from PROVENANCE_ORIGINS.
  const toolContent = (!user && !assistant) || (Boolean(causal) && toolSymptom)
  const origins = PROVENANCE_ORIGINS.filter((origin) => (
    origin === 'user' ? Boolean(user)
      : origin === 'assistant' ? Boolean(assistant)
        : toolContent
  ))

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
      // §15 — origins stay the canonical capture-stream bag; workspace/
      // repository/agent dimensions stamp only when a cwd was supplied,
      // so legacy call sites stay byte-identical (unknown stays unknown).
      provenance: { origins, ...(cwd ? provenanceDimensions(cwd, agent) : {}) },
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
