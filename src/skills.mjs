/**
 * Veyra — bundled DSH skills.
 *
 * Ships skills/<name>/SKILL.md for each entry in BUNDLED_SKILL_DEFINITIONS
 * and registers them as a native bundled provider so the model-facing
 * `skill` tool can load them. Matches the PMA pattern:
 * ctx.skills.registerProvider at rank 600, source "bundled".
 *
 * Also exposes registerRuntimeSkill() for hosts that only have
 * ctx.skills.register (no provider API).
 */

import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const PLUGIN_ROOT = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = join(PLUGIN_ROOT, '..')

export const BUNDLED_SKILL_RANK = 600
export const SKILL_PROVIDER_NAME = 'veyra'
export const SKILL_INVOCATION = Object.freeze({
  modelInvocable: true,
  userInvocable: true,
})

export const BUNDLED_SKILL_DEFINITIONS = Object.freeze([
  {
    name: 'veyra',
    description:
      'Use Veyra, the engineering-memory and RAG intelligence brain for this DSH session. '
      + 'Load it when the user refers to earlier work ("like last time", "what did we decide"), '
      + 'asks to remember or forget something, wants a lesson, root cause, constraint, or fix '
      + 'pattern kept, needs project documentation/knowledge retrieved via hybrid search, or '
      + 'when the task needs project context this turn does not already have — even if nobody '
      + 'says "memory". Covers when to call veyra_remember / veyra_recall / veyra_inspect / '
      + 'veyra_forget / veyra_promote, how candidate vs derived vs canonical differ, causal facets, '
      + 'and that repo truth wins.',
    whenToUse:
      'Earlier-session context, remember/forget/promote requests, durable engineering '
      + 'decisions, project RAG documentation, causal troubleshooting, or when automatic '
      + 'recall is missing or too thin.',
  },
  {
    name: 'codebase-memory',
    description:
      'Use Codebase Memory for structural code intelligence, AST-level navigation, call-graph tracing, '
      + 'and knowledge-graph code search. Prefer cbm_trace for caller/callee analysis, cbm_search for '
      + 'symbol discovery, cbm_snippet for exact definitions, and cbm_arch for component dependency overview. '
      + 'Provides precise structural graph vs noisy text search.',
    whenToUse:
      'Understanding repository structure, finding symbol definitions, tracing call hierarchies, '
      + 'analyzing blast radius / impact of code changes, or directory component architecture.',
  },
  {
    name: 'legacy-onboarding',
    description:
      'Onboard an unfamiliar, legacy, or not-yet-baselined project into Veyra. '
      + 'Assesses the existing memory baseline, discovers the repository, chooses a '
      + 'progressive investigation depth, extracts only durable engineering knowledge '
      + 'grounded in verifiable evidence, and builds a Project Memory Baseline that '
      + 'future agents can recall instead of re-investigating. Load it the first time '
      + 'you work in an old or foreign codebase, when asked "what is this project / '
      + 'how does this work" with no baseline available, before high-risk legacy '
      + 'changes (auth, data, infrastructure, migrations), or when existing Veyra '
      + 'memory looks stale. Skip it for trivial tasks in projects that already have '
      + 'a good baseline.',
    whenToUse:
      'First entry into a new, legacy, or unfamiliar project; a missing or stale '
      + 'Veyra baseline; high-risk changes to old systems; or an explicit request to '
      + 'understand or onboard an unfamiliar repository.',
  },
  {
    name: 'memory-review',
    description:
      'Review the current conversation for durable engineering memory worth keeping and '
      + 'check whether Veyra already recorded it. Extracts a small set of evidence-backed '
      + 'engineering facts from this session, recalls the existing memory, classifies each '
      + 'fact as already recorded, missing, or stale/conflicting, updates only '
      + 'evidence-backed gaps through existing Veyra tools, and ends with a short review '
      + 'report. Load when the user asks to review memory, audit what this session '
      + 'stored, check whether something from this conversation was recorded, or '
      + 'reconcile conversation findings with Veyra.',
    whenToUse:
      'End-of-session or mid-session memory audits, "did we record that" questions, '
      + "and reconciling this conversation's findings against existing Veyra memory.",
  },
  {
    name: 'memory-maintenance',
    description:
      'Agent-executable memory maintenance workflow using Veyra\'s existing health '
      + 'reports and lifecycle commands. Runs health findings, inspects records, '
      + 'verifies against repository truth, applies lifecycle actions (KEEP / '
      + 'SUPERSEDE / INVALIDATE / FORGET / TOMBSTONE / REVALIDATE / DEFER), and '
      + 'reports before/after health changes. Use when the user asks to clean up '
      + 'memory, maintain engineering knowledge, reconcile stale or contradictory '
      + 'records, or audit Veyra health.',
    whenToUse:
      'Explicit memory maintenance requests: when the user asks to clean up memory, '
      + 'maintain engineering knowledge, reconcile stale or contradictory records, or '
      + 'audit Veyra health.',
  },
])

export const BUNDLED_SKILLS_DIR = existsSync(join(REPO_ROOT, 'skills'))
  ? join(REPO_ROOT, 'skills')
  : join(PLUGIN_ROOT, 'skills')

export function skillFileFor(name) {
  return join(BUNDLED_SKILLS_DIR, name, 'SKILL.md')
}

export function stripSkillFrontmatter(value) {
  const match = String(value ?? '').match(/^---\s*\r?\n([\s\S]*?)\r?\n---\s*(?:\r?\n|$)/)
  return match ? value.slice(match[0].length).trim() : String(value ?? '').trim()
}

function unquote(val) {
  if (
    (val.startsWith('"') && val.endsWith('"'))
    || (val.startsWith("'") && val.endsWith("'"))
  ) {
    return val.slice(1, -1)
  }
  return val
}

/**
 * Tiny YAML subset used by SKILL.md frontmatter: `key: value`, quoted
 * scalars, and `>` / `|` block scalars. Good enough for DSH skill files.
 */
export function parseFrontmatter(block) {
  const out = {}
  const lines = String(block ?? '').split('\n')
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    const idx = line.indexOf(':')
    if (idx <= 0 || /^\s/.test(line)) continue
    const key = line.slice(0, idx).trim()
    let val = line.slice(idx + 1).trim()
    if (val === '>' || val === '|' || val === '>-' || val === '|-') {
      const folded = val.startsWith('>')
      const collected = []
      while (i + 1 < lines.length && (/^\s+\S/.test(lines[i + 1]) || lines[i + 1].trim() === '')) {
        i += 1
        collected.push(lines[i].replace(/^\s+/, ''))
      }
      val = folded
        ? collected.join(' ').replace(/\s+/g, ' ').trim()
        : collected.join('\n').trim()
    } else {
      val = unquote(val)
    }
    out[key] = val
  }
  return out
}

/**
 * Parse a SKILL.md into the fields ctx.skills.register() accepts.
 * Used by tests and the runtime-register fallback.
 */
export function parseSkillMarkdown(raw, fallbackName = 'veyra') {
  const text = String(raw ?? '')
  const fmMatch = text.match(/^---\s*\r?\n([\s\S]*?)\r?\n---\s*(?:\r?\n|$)/)
  const meta = fmMatch ? parseFrontmatter(fmMatch[1]) : {}
  return {
    name: meta.name || fallbackName,
    description: (meta.description || '').replace(/\s+/g, ' ').trim(),
    whenToUse: (meta.whenToUse || '').replace(/\s+/g, ' ').trim() || undefined,
    content: stripSkillFrontmatter(text),
    source: 'bundled',
    path: skillFileFor(meta.name || fallbackName),
  }
}

export function createBundledSkillProvider() {
  const candidates = BUNDLED_SKILL_DEFINITIONS.map((def) => {
    const dir = join(BUNDLED_SKILLS_DIR, def.name)
    const file = join(dir, 'SKILL.md')
    return {
      name: def.name,
      description: def.description,
      whenToUse: def.whenToUse,
      invocation: SKILL_INVOCATION,
      provider: SKILL_PROVIDER_NAME,
      source: 'bundled',
      resourceBase: { kind: 'directory', path: dir },
      rank: BUNDLED_SKILL_RANK,
      locator: pathToFileURL(file),
      path: file,
    }
  })

  return {
    name: SKILL_PROVIDER_NAME,
    list: () => Promise.resolve(candidates),
    async get(candidate) {
      let filePath
      if (candidate.locator instanceof URL) {
        filePath = fileURLToPath(candidate.locator)
      } else if (typeof candidate.locator === 'string') {
        filePath = candidate.locator.startsWith('file:')
          ? fileURLToPath(candidate.locator)
          : candidate.locator
      } else {
        filePath = skillFileFor(candidate.name)
      }
      const raw = await readFile(filePath, 'utf8')
      return {
        name: candidate.name,
        description: candidate.description,
        whenToUse: candidate.whenToUse,
        invocation: candidate.invocation,
        provider: candidate.provider,
        source: candidate.source,
        ...(candidate.resourceBase ? { resourceBase: candidate.resourceBase } : {}),
        path: filePath,
        content: stripSkillFrontmatter(raw),
      }
    },
  }
}

/**
 * Register the bundled Veyra skill on a DSH skills service.
 * Prefers registerProvider (catalog + on-demand load). Falls back to
 * register() with the body already loaded. Returns the registered names.
 */
export async function registerSkills(ctx, log, scope) {
  const skills = ctx?.skills
  if (!skills) return []

  if (typeof skills.registerProvider === 'function') {
    const provider = createBundledSkillProvider()
    const effect = scope && typeof scope.effect === 'function' ? scope.effect.bind(scope) : null
    const register = () => skills.registerProvider(() => provider)
    if (effect) effect(register)
    else register()
    return provider.list().then((candidates) => candidates.map((c) => c.name))
  }

  if (typeof skills.register === 'function') {
    const names = []
    for (const def of BUNDLED_SKILL_DEFINITIONS) {
      const file = skillFileFor(def.name)
      const raw = await readFile(file, 'utf8')
      const parsed = parseSkillMarkdown(raw, def.name)
      skills.register({
        name: parsed.name,
        description: parsed.description || def.description,
        whenToUse: parsed.whenToUse || def.whenToUse,
        content: parsed.content,
        source: 'bundled',
        path: file,
        invocation: SKILL_INVOCATION,
        provider: SKILL_PROVIDER_NAME,
      })
      names.push(parsed.name)
    }
    return names
  }

  log?.debug?.('[veyra] skills service has no register/registerProvider')
  return []
}
