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
  'you need a targeted search beyond the automatic context.',
].join('\n')

export function queryFromAssemble(assembleContext) {
  const agent = assembleContext?.agent
  const session = agent?.session
  if (!session) return ''
  // Prefer the latest user-authored text from the runtime context helper
  // if the host attached one; otherwise walk recent surface messages.
  try {
    const messages = session.surface?.messages
    if (Array.isArray(messages)) {
      for (let i = messages.length - 1; i >= 0; i--) {
        const msg = messages[i]
        if (msg?.role === 'user') {
          const text = extractText(msg.content)
          if (text && !text.startsWith('Veyra recalled') && !text.startsWith('These items are remembered')) {
            return text.slice(0, 800)
          }
        }
      }
    }
  } catch {
    // surface shape is host-defined; fall through
  }
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
