/**
 * Veyra — project identity and record ids.
 *
 * Project isolation is a hard boundary (GOAL.md). The project id is a
 * stable hash of the resolved workspace path plus the git remote, so two
 * checkouts of the same remote share a project while unrelated folders
 * never collide. Memory itself lives under $DSH_HOME/veyra/, never inside
 * the user's repository.
 */

import { createHash, randomBytes } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { homedir } from 'node:os'

export const DSH_HOME_DIR_NAME = '.dsh'
export const VEYRA_DIR_NAME = 'veyra'

export function defaultDshHome(env = process.env) {
  const fromEnv = env.DSH_HOME
  if (typeof fromEnv === 'string' && fromEnv.trim()) {
    return resolve(expandHome(fromEnv.trim()))
  }
  return join(homedir(), DSH_HOME_DIR_NAME)
}

export function expandHome(path) {
  if (path === '~') return homedir()
  if (path.startsWith('~/') || path.startsWith('~\\')) return join(homedir(), path.slice(2))
  return path
}

export function resolveVeyraHome(config = {}, env = process.env) {
  if (typeof config.home === 'string' && config.home.trim()) {
    return resolve(expandHome(config.home.trim()))
  }
  if (typeof env.VEYRA_HOME === 'string' && env.VEYRA_HOME.trim()) {
    return resolve(expandHome(env.VEYRA_HOME.trim()))
  }
  return join(defaultDshHome(env), VEYRA_DIR_NAME)
}

export function sha256Hex(value) {
  return createHash('sha256').update(String(value)).digest('hex')
}

export function newRecordId() {
  const stamp = Date.now().toString(16)
  return `vey_${stamp}_${randomBytes(6).toString('hex')}`
}

export function contentHash(title, body) {
  return sha256Hex(`${String(title || '').trim()}\n${String(body || '').trim()}`)
}

/**
 * Walk up from `start` looking for a `.git` directory (file or folder).
 * Returns the directory that contains `.git`, or null.
 */
export function findGitRoot(start) {
  if (typeof start !== 'string' || !start.trim()) return null
  let dir = resolve(start.trim())
  for (let i = 0; i < 12; i++) {
    if (existsSync(join(dir, '.git'))) return dir
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return null
}

/**
 * Best-effort git remote URL. Reads `.git/config` directly so we never
 * spawn a process or depend on git being on PATH.
 */
export function readGitRemote(gitRoot) {
  if (!gitRoot) return ''
  const gitPath = join(gitRoot, '.git')
  let configPath = join(gitPath, 'config')
  try {
    // `.git` may be a file pointing at a worktree / gitdir.
    if (!existsSync(configPath)) {
      const raw = readFileSync(gitPath, 'utf8').trim()
      const match = raw.match(/^gitdir:\s*(.+)$/m)
      if (match) configPath = join(match[1].trim(), 'config')
    }
    const config = readFileSync(configPath, 'utf8')
    const origin = config.match(/\[remote "origin"\][\s\S]*?url\s*=\s*(.+)/)
    if (origin) return origin[1].trim()
    const any = config.match(/\[remote "[^"]+"\][\s\S]*?url\s*=\s*(.+)/)
    return any ? any[1].trim() : ''
  } catch {
    return ''
  }
}

/**
 * Stable project id: sha256(resolvedCwd | gitRemote) truncated.
 * Two workspaces with the same path+remote always share an id.
 */
export function projectIdFor(cwd) {
  const resolved = typeof cwd === 'string' && cwd.trim() ? resolve(cwd.trim()) : process.cwd()
  const gitRoot = findGitRoot(resolved)
  const remote = readGitRemote(gitRoot)
  const key = `${gitRoot || resolved}|${remote}`
  return `p_${sha256Hex(key).slice(0, 16)}`
}

export function projectDbPath(veyraHome, projectId) {
  return join(veyraHome, 'projects', projectId, 'memory.db')
}

export function reusableDbPath(veyraHome) {
  return join(veyraHome, 'reusable', 'memory.db')
}

/**
 * Resolve the workspace cwd from a DSH payload / agent / session.
 * Prefers the session header (authoritative), then common fallbacks.
 */
export function resolveWorkspace(source) {
  const candidates = [
    source?.session?.header?.cwd,
    source?.agent?.session?.header?.cwd,
    source?.header?.cwd,
    source?.cwd,
    source?.agent?.cwd,
    source?.session?.cwd,
  ]
  for (const c of candidates) {
    if (typeof c === 'string' && c.trim()) return resolve(c.trim())
  }
  return process.cwd()
}

export function extractText(content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .map((block) => {
      if (!block || typeof block !== 'object') return ''
      if (typeof block.text === 'string') return block.text
      if (typeof block.content === 'string') return block.content
      return ''
    })
    .filter(Boolean)
    .join('\n')
    .trim()
}
