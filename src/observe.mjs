/**
 * Veyra — session observation.
 *
 * Observe ≠ Store. Session events are inspected for potentially useful
 * engineering signal. Anything kept automatically is stored as a
 * `candidate` observation (never derived, never canonical). The learn
 * stage later decides whether a candidate is worth promoting to derived
 * memory. Candidates never enter ambient recall.
 */

import { MIN_OBSERVATION_CHARS } from './types.mjs'
import { extractText } from './ids.mjs'
import { distillBuffer } from './understand.mjs'

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
 * Distills the turn (understand) instead of dumping raw text. Returns a
 * candidate record payload, or null when the turn is noise.
 *
 * Never returns derived/canonical authority.
 */
export function candidateFromBuffer(buffer, { projectId, sessionId } = {}) {
  const distilled = distillBuffer(buffer, { projectId, sessionId })
  if (!distilled) return null
  const user = (buffer.user || []).join('\n').trim()
  const signal = distilled.source?.signal
  const claimed = signal && signal !== 'observation'
  if (isNoiseText(user) && (distilled.source?.tools || []).length < 2 && !claimed) {
    return null
  }
  return distilled
}

// Re-export so tests and callers can keep a single observe import.
export { distillBuffer }
