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
      + 'Load it for durable engineering decisions, historical lessons, root causes, constraints, '
      + 'fix patterns, project documentation/knowledge retrieved via hybrid search, or cross-session '
      + 'architecture context. Do NOT load for immediate session continuity ("上一轮/刚才做了什么", '
      + '"where did we leave off", current conversation progress) — those belong to conversation '
      + 'history, git status, and task tracking. Covers when to call veyra_remember / veyra_recall / '
      + 'veyra_inspect / veyra_forget / veyra_promote, how candidate vs derived vs canonical differ, '
      + 'causal facets, and that repo truth wins.',
    whenToUse:
      'Cross-session engineering context, durable decisions, project RAG documentation, '
      + 'causal troubleshooting, remember/forget/promote requests, or when automatic recall '
      + 'for durable knowledge is missing or too thin. Never for in-session turn progress or '
      + 'session continuity.',
  },
  {
    name: 'veyra-memory-bootstrap',
    description:
      'Build a project memory baseline in Veyra — the first-time onboarding pass '
      + 'that discovers an unfamiliar, legacy, or not-yet-baselined repository and '
      + 'records 4-8 durable, evidence-anchored facts a future session can recall '
      + 'instead of re-investigating. Load at first entry into an old or foreign '
      + 'codebase, when recall returns nothing or is too thin to answer "what is this '
      + 'project, what are its constraints, what breaks here", when the user asks to '
      + 'onboard or survey a project, when the user explicitly asks to initialize '
      + 'memory (初始化记忆, 建立记忆基线, "init memory"), or before high-risk work on '
      + 'authentication, databases, infrastructure, core APIs, migrations, or '
      + "compatibility shims. Not for capturing this conversation's own findings and "
      + 'not for cleaning up records that already exist — load veyra-memory-curation '
      + 'for both of those.',
    whenToUse:
      'First substantive work in a project whose Veyra memory is empty or too thin '
      + 'to be useful, an explicit onboard or "initialize memory" request, a baseline '
      + 'that has drifted from the code, or a high-risk change to a legacy area. Not '
      + "for recording a session's own findings, and not for health-driven cleanup of "
      + 'records that already exist — those are veyra-memory-curation.',
  },
  {
    name: 'veyra-memory-curation',
    description:
      'Curate engineering memory that already exists or that this conversation just '
      + 'produced. Two modes. Capture mode reviews the current session for durable, '
      + 'evidence-backed findings, checks them against what Veyra already holds, and '
      + 'writes only the genuine gaps. Maintain mode works from a Veyra health report '
      + 'to inspect, verify, and lifecycle stale, invalid, or contradicted records '
      + "through Veyra's existing commands. Load when the user asks whether something "
      + 'was recorded, asks to review or audit memory, asks to clean up memory, '
      + 'reconcile contradictions, or audit Veyra health. Not for building a first '
      + 'project baseline — load veyra-memory-bootstrap for that.',
    whenToUse:
      '"Did we record that", end-of-session memory reviews, session audits, '
      + 'health-driven cleanup, reconciling stale or contradictory records, or any '
      + 'explicit maintenance request about engineering memory. Not for project memory '
      + 'initialization or first-time onboarding (use veyra-memory-bootstrap).',
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
