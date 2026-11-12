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
  'run_code',
])

const INTERESTING_TOOLS = new Set([
  ...TOOL_SIGNAL,
  'veyra_remember',
  'veyra_forget',
  'veyra_promote',
])

// Only these tools can change a file. `read`, `grep`, `glob` and `bash` observe
// the repository; treating their path arguments as modifications made the
// distilled record claim files were touched when nothing was written (m00191).
// The distinction already existed in `buffer.tools` (which records every tool by
// name), so modification evidence only had to stop reading the wrong stream.
const MUTATING_TOOLS = new Set(['edit', 'write', 'str_replace_editor'])

/**
 * Does this tool call reliably imply a file modification?
 *
 * Fails closed: a tool that is not known to mutate, and whose arguments carry no
 * explicit edit/write signal, is treated as non-mutating. `run_code` is the only
 * ambiguous one — it mutates only when its own description or code says it does,
 * mirroring the corrective-action rule in understand.mjs so tagging and evidence
 * cannot disagree about the same call.
 */
// A write performed through bash leaves no file evidence today: `sed -i` and
// `>` both change the repo while `mutatesFiles` sees only `run_code`.
// A single regex cannot do this — `sed -i 's/a/b/' f.mjs` would capture the
// script, not the file — so the command is tokenized instead.
const REDIRECT_TARGET = />>?\s*([^\s;|&>]+)/g
const SED_IN_PLACE = /\bsed\s+-i\S*\s+(.*)$/g
const TEE_TARGET = /\btee(?:\s+-a)?\s+(.*)$/g
const NON_EVIDENCE_PATH = /^(?:\/dev\/null|\/dev\/stdout|\/dev\/stderr|\/tmp\/|\.git\/)/

function commandWritePaths(command) {
  const out = []
  if (typeof command !== 'string' || !command) return out
  let m
  // A redirect operator inside quotes is part of an argument, not a redirect.
  // `grep -rn "foo>bar" src/` would otherwise record a file named `bar"`, and a
  // bogus path in `source.files` grounds a record just like a real one.
  const unquoted = command.replace(/(?:'[^']*'|"[^"]*")/g, ' ')
  REDIRECT_TARGET.lastIndex = 0
  while ((m = REDIRECT_TARGET.exec(unquoted))) out.push(m[1])
  // Multi-file `sed -i … a b c` records only the LAST path; earlier targets are
  // dropped. Under-claims evidence (safe direction). Do not treat one recorded
  // path as the complete write set.
  SED_IN_PLACE.lastIndex = 0
  while ((m = SED_IN_PLACE.exec(command))) {
    // Drop the quoted script and flags; what remains ends with the file.
    const tokens = m[1].replace(/(?:'[^']*'|"[^"]*")/g, ' ').trim().split(/\s+/).filter(Boolean)
    const files = tokens.filter((t) => !t.startsWith('-') && !/^s[/|#]/.test(t))
    if (files.length) out.push(files[files.length - 1])
  }
  TEE_TARGET.lastIndex = 0
  while ((m = TEE_TARGET.exec(command))) {
    const files = m[1].split(/\s+/).filter(Boolean).filter((t) => !t.startsWith('-'))
    if (files.length) out.push(files[0])
  }
  return out.filter((p) => !NON_EVIDENCE_PATH.test(p))
}

function mutatesFiles(name, args) {
  if (MUTATING_TOOLS.has(name)) return true
  if (name === 'bash' && typeof args?.command === 'string' && commandWritePaths(args.command).length > 0) {
    return true
  }
  if (name !== 'run_code') return false
  const description = typeof args?.description === 'string' ? args.description : ''
  const code = typeof args?.code === 'string' ? args.code : ''
  return /(?:edit|write)/i.test(description) || /(?:tools\.edit|tools\.write)/.test(code)
}

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
      // Modification evidence only. A read/search call keeps its name in
      // `buffer.tools` — where it belongs — but never reaches `buffer.files`.
      if (mutatesFiles(name, args)) collectFiles(buffer.files, args)
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
  for (const key of ['command', 'path', 'file_path', 'pattern', 'glob', 'old_string', 'new_string', 'description']) {
    if (typeof args[key] === 'string') out[key] = args[key].slice(0, 240)
  }
  if (typeof args.code === 'string') {
    out.code = args.code.slice(0, 240)
  }
  return out
}

function collectFiles(files, args) {
  for (const key of ['path', 'file_path']) {
    if (typeof args?.[key] === 'string' && args[key].trim()) files.add(args[key].trim())
  }
  if (typeof args?.code === 'string') {
    const re = /(?:file_path|path)\s*:\s*["']([^"'\r\n]+)["']/g
    let match
    while ((match = re.exec(args.code)) !== null) {
      if (match[1] && match[1].trim()) files.add(match[1].trim())
    }
  }
  if (typeof args?.command === 'string') {
    for (const target of commandWritePaths(args.command)) files.add(target)
  }
}

/**
 * Decide whether the buffered turn produced a durable-looking observation.
 * Distills the turn (understand) instead of dumping raw text. Returns a
 * candidate record payload, or null when the turn is noise.
 *
 * Never returns derived/canonical authority.
 */
export function candidateFromBuffer(buffer, { projectId, sessionId, cwd, agent } = {}) {
  const distilled = distillBuffer(buffer, { projectId, sessionId, cwd, agent })
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
