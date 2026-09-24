/**
 * Veyra — ambient prompt guidance and per-turn recall context.
 *
 * Two DSH injection points:
 *   - systemPrompt.section  — static rules (memory ≠ truth)
 *   - systemPrompt.context  — dynamic recall snapshot each assemble
 *
 * Recalled items are always framed as non-authoritative experience.
 */

import { DEFAULT_RECALL_LIMIT } from './types.mjs'
import { extractText, projectIdFor, resolveWorkspace } from './ids.mjs'
import { openProjectStore, openReusableStore } from './store.mjs'
import { recall, summarizeForPrompt } from './retrieve.mjs'

export const GUIDANCE_TEXT = [
  'Veyra is the engineering brain for this DSH session.',
  '',
  'It observes work, remembers durable engineering experience, and recalls',
  'relevant memory automatically. Use it as an assistant, not as truth.',
  '',
  'Rules you must keep:',
  '- Observe ≠ Store. Not every event is worth remembering.',
  '- Candidate ≠ Truth. Automatic captures are unverified candidates.',
  '- Similarity ≠ Authority. A recalled match is not proof.',
  '- Memory ≠ Knowledge. Remembered experience is not the repository.',
  '- Knowledge without evidence is not authoritative.',
  '- Repository truth remains authoritative. When memory conflicts with',
  '  the current codebase, tests, or git history, believe the repository.',
  '- Automatic behavior never creates canonical truth. Only an explicit',
  '  veyra_promote (canonical) call, triggered by the user, can do that.',
  '- Project isolation is preserved. Do not treat reusable experience as',
  '  this project\'s architecture.',
  '- Memory assists engineering; it does not replace verification.',
  '',
  'When you discover a durable decision, root cause, constraint, or fix',
  'pattern, call veyra_remember. When memory is wrong, call veyra_forget',
  'or veyra_promote to correct its standing. Use veyra_recall only when',
  'you need a targeted search beyond the automatic context. If two',
  'recalled items contradict each other, surface both and believe the',
  'repository — do not pick a winner from similarity.',
].join('\n')

// Claimed inbox text is gone from inbox and not yet on deriveMessages()
// when systemPrompt.assemble runs (preStep claims, then assembles).
const claimedByAgent = new WeakMap()

const SKIP_QUERY_PREFIXES = [
  'veyra recalled',
  'these items are remembered',
]

export function isHumanUserMessage(message) {
  if (!message || typeof message !== 'object') return false
  if (message.role && message.role !== 'user') return false
  const kind = message.source?.kind
  return !kind || kind === 'user'
}

export function queryTextFromMessage(message) {
  const text = extractText(message?.content ?? message).trim()
  if (!text) return ''
  const lower = text.toLowerCase()
  if (SKIP_QUERY_PREFIXES.some((p) => lower.startsWith(p))) return ''
  return text.slice(0, 800)
}

export function rememberClaimedPrompt(agent, message) {
  if (!agent || !isHumanUserMessage(message)) return
  const text = queryTextFromMessage(message)
  if (text) claimedByAgent.set(agent, text)
}

function latestHumanQuery(messages) {
  if (!Array.isArray(messages)) return ''
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i]
    if (!isHumanUserMessage(msg)) continue
    const text = queryTextFromMessage(msg)
    if (text) return text
  }
  return ''
}

export function queryFromAssemble(assembleContext) {
  const agent = assembleContext?.agent
  if (!agent) return ''
  const claimed = claimedByAgent.get(agent)
  if (claimed) return claimed

  const session = agent.session
  try {
    if (typeof session?.deriveMessages === 'function') {
      const fromHistory = latestHumanQuery(session.deriveMessages())
      if (fromHistory) return fromHistory
    }
  } catch {
    // deriveMessages is host-defined; fall through
  }

  // Rare: assemble without a prior claim still seeing queued human text.
  const fromInbox = latestHumanQuery(agent.inbox?.nextStep) || latestHumanQuery(agent.inbox?.nextTurn)
  if (fromInbox) return fromInbox
  return ''
}

export function buildRecallContext({ veyraHome, cwd, query = '', limit = DEFAULT_RECALL_LIMIT, includeReusable = true }) {
  const workspace = cwd || process.cwd()
  const projectId = projectIdFor(workspace)
  const projectStore = openProjectStore(veyraHome, projectId)
  const reusableStore = includeReusable ? openReusableStore(veyraHome) : null
  const records = recall({
    projectStore,
    reusableStore,
    query,
    limit,
    includeReusable,
  })
  if (records.length === 0) return ''
  projectStore.touch(records.filter((r) => r.scope !== 'reusable').map((r) => r.id))
  if (reusableStore) reusableStore.touch(records.filter((r) => r.scope === 'reusable').map((r) => r.id))
  return summarizeForPrompt(records)
}

export function createContextProvider(runtime) {
  return (assembleContext) => {
    try {
      const agent = assembleContext?.agent
      const cwd = resolveWorkspace(agent) || runtime.fallbackCwd
      const query = queryFromAssemble(assembleContext)
      return buildRecallContext({
        veyraHome: runtime.veyraHome,
        cwd,
        query,
        limit: runtime.recallLimit,
        includeReusable: runtime.includeReusable,
      })
    } catch (err) {
      runtime.log?.warn?.(`[veyra] recall context failed: ${err instanceof Error ? err.message : String(err)}`)
      return ''
    }
  }
}
