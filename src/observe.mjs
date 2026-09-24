/**
 * Veyra — session observation.
 *
 * Observe ≠ Store. Session events are inspected for potentially useful
 * engineering signal. Anything kept automatically is stored as a
 * `candidate` observation (never derived, never canonical). The learn
 * stage later decides whether a candidate is worth promoting to derived
 * memory. Candidates never enter ambient recall.
 */

import { AUTHORITIES, CONFIDENCES, KINDS, MIN_OBSERVATION_CHARS, SCOPES, STATUSES, VALIDATIONS } from './types.mjs'
import { extractText } from './ids.mjs'
import { scrub } from './redact.mjs'

const NOISE_PREFIXES = [
  '/veyra',
  '/goal',
  '/compact',
  'veyra recalled',
  'these items are remembered',
  '[veyra]',
]

const TOOL_SIGNAL = new Set([
  'bash',
  'edit',
  'write',
  'read',
  'grep',
  'glob',
  'str_replace_editor',
])

const INTERESTING_TOOLS = new Set([
  ...TOOL_SIGNAL,
  'veyra_remember',
  'veyra_forget',
  'veyra_promote',
])

export function isNoiseText(text) {
  if (typeof text !== 'string') return true
  const trimmed = text.trim()
  if (trimmed.length < MIN_OBSERVATION_CHARS) return true
  const lower = trimmed.toLowerCase()
  return NOISE_PREFIXES.some((p) => lower.startsWith(p) || lower.includes(p))
}

export function eventText(event) {
  const data = event?.data ?? event
  if (!data || typeof data !== 'object') return ''
  if (typeof data.text === 'string') return data.text
  if (data.message) return extractText(data.message.content ?? data.message)
  if (data.content) return extractText(data.content)
  if (typeof data.output === 'string') return data.output
  if (Array.isArray(data.output)) return extractText(data.output)
  return ''
}

export function parseToolArgs(raw) {
  if (!raw) return {}
  if (typeof raw === 'object' && !Array.isArray(raw)) return raw
  if (typeof raw !== 'string') return {}
  try {
    const parsed = JSON.parse(raw)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
  } catch {
    return {}
  }
}

function eventSourceKind(event) {
  const data = event?.data ?? event
  return data?.source?.kind || data?.message?.source?.kind || ''
}

/**
 * Fold one session event into a per-turn observation buffer.
 * The buffer is cheap and lossy on purpose — it is not memory.
 */
export function observeEvent(buffer, session, event) {
  if (!buffer || !event) return buffer
  const type = event.type
  if (type === 'turn/start') {
    buffer.turn = event.data?.turn ?? (buffer.turn + 1)
    buffer.user = []
    buffer.assistant = []
    buffer.tools = []
    buffer.files = new Set()
    buffer.callNames = new Map()
    return buffer
  }
  if (type === 'user/message') {
    const kind = eventSourceKind(event)
    if (kind && kind !== 'user') return buffer
    const text = eventText(event)
    if (text && !isNoiseText(text)) buffer.user.push(text.slice(0, 2000))
    return buffer
  }
  if (type === 'assistant/message') {
    const text = eventText(event)
    if (text && !isNoiseText(text)) buffer.assistant.push(text.slice(0, 2000))
    return buffer
  }
  if (type === 'tool/call') {
    const name = event.data?.name || event.data?.tool || ''
    const args = parseToolArgs(event.data?.arguments ?? event.data?.args)
    const callId = event.data?.callId
    if (callId && name) buffer.callNames.set(callId, name)
    if (INTERESTING_TOOLS.has(name)) {
      buffer.tools.push({ name, args: summarizeArgs(args) })
      collectFiles(buffer.files, args)
    }
    return buffer
  }
  if (type === 'tool/result') {
    const callId = event.data?.message?.source?.callId
      || event.data?.message?.content?.[0]?.toolCallId
      || event.data?.callId
    const name = event.data?.name || event.data?.tool || (callId ? buffer.callNames.get(callId) : '') || ''
    if (TOOL_SIGNAL.has(name)) {
      const text = eventText(event)
      if (text) buffer.tools.push({ name: `${name}:result`, preview: text.slice(0, 400) })
    }
    return buffer
  }
  return buffer
}

export function newBuffer() {
  return {
    turn: 0,
    user: [],
    assistant: [],
    tools: [],
    files: new Set(),
    callNames: new Map(),
  }
}

function summarizeArgs(args) {
  if (!args || typeof args !== 'object') return {}
  const out = {}
  for (const key of ['command', 'path', 'file_path', 'pattern', 'glob', 'old_string', 'new_string']) {
    if (typeof args[key] === 'string') out[key] = args[key].slice(0, 240)
  }
  return out
}

function collectFiles(files, args) {
  for (const key of ['path', 'file_path']) {
    if (typeof args?.[key] === 'string' && args[key].trim()) files.add(args[key].trim())
  }
}

/**
 * Decide whether the buffered turn produced a durable-looking observation.
 * Returns a candidate record payload, or null when the turn is noise.
 *
 * Never returns derived/canonical authority.
 */
export function candidateFromBuffer(buffer, { projectId, sessionId } = {}) {
  if (!buffer) return null
  const user = buffer.user.join('\n').trim()
  const files = [...(buffer.files || [])].slice(0, 12)
  const tools = (buffer.tools || []).slice(0, 16)
  const meaningfulTools = tools.filter((t) => TOOL_SIGNAL.has(String(t.name).split(':')[0]))
  if (meaningfulTools.length < 1 && user.length < 80) return null
  if (isNoiseText(user) && meaningfulTools.length < 2) return null

  const title = deriveTitle(user, files, tools)
  const bodyParts = []
  if (user) bodyParts.push(user.slice(0, 1200))
  if (files.length) bodyParts.push(`Files touched: ${files.join(', ')}`)
  if (tools.length) {
    const names = [...new Set(tools.map((t) => t.name))].slice(0, 8)
    bodyParts.push(`Tools: ${names.join(', ')}`)
  }
  const body = scrub(bodyParts.join('\n\n')).scrubbed
  if (body.length < MIN_OBSERVATION_CHARS) return null

  return {
    kind: KINDS.OBSERVATION,
    status: STATUSES.CURRENT,
    validation: VALIDATIONS.UNVERIFIED,
    authority: AUTHORITIES.CANDIDATE,
    confidence: CONFIDENCES.LOW,
    scope: SCOPES.PROJECT,
    projectId,
    title,
    body,
    tags: ['observation', 'auto'],
    evidence: files.map((path) => ({ path })),
    source: {
      sessionId: sessionId || null,
      turn: buffer.turn,
      tools: tools.map((t) => t.name),
      files,
      automatic: true,
    },
  }
}

function deriveTitle(user, files, tools) {
  const firstLine = user.split('\n').map((s) => s.trim()).find(Boolean)
  if (firstLine && firstLine.length >= 12) return firstLine.slice(0, 160)
  if (files.length) return `Worked on ${files[0]}`
  if (tools.length) return `Used ${tools[0].name}`
  return 'Engineering observation'
}
