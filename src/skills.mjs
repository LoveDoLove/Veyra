/**
 * Veyra — bundled DSH skill.
 *
 * Ships skills/veyra/SKILL.md and registers it as a native bundled provider
 * so the model-facing `skill` tool can load it. Matches the PMA pattern:
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
      'Use Veyra, the engineering-memory brain for this DSH session. Load it when '
      + 'the user refers to earlier work ("like last time", "what did we decide"), '
      + 'asks to remember or forget something, wants a lesson, root cause, constraint, '
      + 'or fix pattern kept, or when the task needs project context this turn does '
      + 'not already have — even if nobody says "memory". Covers when to call '
      + 'veyra_remember / veyra_recall / veyra_inspect / veyra_forget / veyra_promote, '
      + 'how candidate vs derived vs canonical differ, and that repo truth wins.',
    whenToUse:
      'Earlier-session context, remember/forget/promote requests, durable engineering '
      + 'decisions, or when automatic recall is missing or too thin.',
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
export async function registerSkills(ctx, log) {
  const skills = ctx?.skills
  if (!skills) return []

  if (typeof skills.registerProvider === 'function') {
    const provider = createBundledSkillProvider()
    skills.registerProvider(() => provider)
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
