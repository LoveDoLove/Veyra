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
  /\b(architecture|race|deadlock|migration|serialize|lock the|do not)\b/i,
]

const FIX_HINTS = /\b(fix|bug|error|issue|patch|fail|race|deadlock|corrupt|flake|regress)\b/i
const DECISION_HINTS = /\b(decided|decision|always|never|must|should not|do not|constraint)\b/i
const CAUSE_HINTS = /\b(root cause|the cause|because|why)\b/i

const SYMBOL_RE = /(?:export\s+)?(?:async\s+)?(?:function\*?|class|const|let|var)\s+([A-Za-z_$][\w$]{2,})/g
const PATH_RE = /(?:^|[\s`'"(])((?:src|test|tests|lib|app|packages|skills)\/[\w./-]+\.[A-Za-z]{1,8})/g

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

function classifySignal(text) {
  if (CAUSE_HINTS.test(text)) return 'root-cause'
  if (DECISION_HINTS.test(text)) return 'decision'
  if (FIX_HINTS.test(text)) return 'fix'
  return 'observation'
}

function deriveTitle(user, files, tools, signal) {
  const firstLine = String(user || '').split('\n').map((s) => s.trim()).find(Boolean)
  if (firstLine && firstLine.length >= 12) return firstLine.slice(0, 160)
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

function evidenceFrom(files, symbols, tools) {
  const items = []
  for (const path of files.slice(0, 12)) {
    items.push({ path })
  }
  for (const symbol of symbols.slice(0, 8)) {
    items.push({ note: `sym:${symbol}` })
  }
  const testTouched = files.some((p) => /test|spec|fixture/i.test(p))
    || tools.some((t) => /test/i.test(String(t.name || '')))
  if (testTouched) items.push({ note: 'tests-touched' })
  return items
}

function tagsFor(signal, files, tools) {
  const tags = ['observation', 'auto', signal]
  if (files.some((p) => /test|spec/i.test(p))) tags.push('tested')
  const names = new Set(tools.map((t) => String(t.name).split(':')[0]))
  if (names.has('edit') || names.has('write') || names.has('str_replace_editor')) tags.push('edited')
  return [...new Set(tags)].slice(0, 12)
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

  const signal = classifySignal(combined)
  const title = deriveTitle(user, files, tools, signal)
  const bodyParts = []
  if (user) bodyParts.push(user.slice(0, 1200))
  if (assistant && looksLikeClaim(assistant)) {
    bodyParts.push(`Agent: ${assistant.slice(0, 600)}`)
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
    tags: tagsFor(signal, files, tools),
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
    },
  }
}
