/**
 * Veyra Code Intelligence — Repository Ingestion & Discovery.
 *
 * Implements Stage 1 & 2 repository boundaries:
 *   - Path normalization & path-traversal protection (fail-closed)
 *   - Safe symlink resolution (never cross repo boundary)
 *   - Ignored files/directories (.git, node_modules, dist, build, coverage, caches)
 *   - Secret & sensitive files detection (.env, *.pem, *.key, id_rsa, etc.)
 *   - Binary & non-code file exclusion
 *   - Language detection and gitignore pattern matching
 *   - Secret scrubbing integration (scrub from src/redact.mjs)
 */

import { existsSync, lstatSync, realpathSync, readFileSync, readdirSync } from 'node:fs'
import { join, resolve, relative, isAbsolute, extname, basename, sep } from 'node:path'
import { scrub } from '../redact.mjs'

/** Default directory exclusions */
export const DEFAULT_EXCLUDED_DIRS = new Set([
  '.git',
  '.svn',
  '.hg',
  'node_modules',
  'vendor',
  'bower_components',
  '.pnpm',
  '.yarn',
  '.npm',
  'dist',
  'build',
  'out',
  'target',
  'bin',
  'obj',
  '.next',
  '.nuxt',
  '.turbo',
  '.cache',
  '.parcel-cache',
  '.svelte-kit',
  '.pytest_cache',
  '__pycache__',
  '.mypy_cache',
  '.ruff_cache',
  'coverage',
  '.nyc_output',
  'tmp',
  'temp',
])

/** File extensions known to be binary, archive, or non-source */
export const BINARY_EXTENSIONS = new Set([
  '.exe', '.dll', '.so', '.dylib', '.bin', '.obj', '.o', '.a', '.lib',
  '.class', '.jar', '.war', '.ear',
  '.zip', '.tar', '.gz', '.tgz', '.bz2', '.7z', '.rar',
  '.png', '.jpg', '.jpeg', '.gif', '.ico', '.webp', '.bmp', '.tiff', '.svgz',
  '.mp3', '.mp4', '.wav', '.avi', '.mov', '.flv', '.webm',
  '.pdf', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx',
  '.woff', '.woff2', '.ttf', '.eot', '.otf',
  '.wasm', '.pyc', '.pyo', '.pyd',
])

/** Sensitive patterns that should never be indexed */
export const SENSITIVE_PATTERNS = [
  /^\.env(\..+)?$/i,
  /\.pem$/i,
  /\.key$/i,
  /\.p12$/i,
  /\.pfx$/i,
  /\.keystore$/i,
  /^id_rsa(\..+)?$/i,
  /^id_ed25519(\..+)?$/i,
  /credential/i,
  /secret/i,
  /\.npmrc$/i,
  /\.dockercfg$/i,
]

/** Language mapping by extension */
export const EXTENSION_LANGUAGE_MAP = {
  '.js': 'javascript',
  '.mjs': 'javascript',
  '.cjs': 'javascript',
  '.jsx': 'javascript',
  '.ts': 'typescript',
  '.mts': 'typescript',
  '.cts': 'typescript',
  '.tsx': 'typescript',
  '.py': 'python',
  '.pyw': 'python',
  '.rs': 'rust',
  '.go': 'go',
  '.c': 'c',
  '.h': 'c',
  '.cpp': 'cpp',
  '.hpp': 'cpp',
  '.cc': 'cpp',
  '.cxx': 'cpp',
  '.cs': 'csharp',
  '.java': 'java',
  '.rb': 'ruby',
  '.php': 'php',
  '.swift': 'swift',
  '.kt': 'kotlin',
  '.kts': 'kotlin',
  '.scala': 'scala',
  '.sh': 'shell',
  '.bash': 'shell',
  '.zsh': 'shell',
  '.sql': 'sql',
  '.json': 'json',
  '.yaml': 'yaml',
  '.yml': 'yaml',
  '.toml': 'toml',
  '.md': 'markdown',
  '.markdown': 'markdown',
  '.html': 'html',
  '.htm': 'html',
  '.css': 'css',
  '.scss': 'scss',
  '.sass': 'sass',
  '.less': 'less',
  '.vue': 'vue',
  '.svelte': 'svelte',
}

/** Max source file size to index (2 MB) */
export const MAX_FILE_SIZE_BYTES = 2 * 1024 * 1024

/**
 * Derive codebase-memory-mcp compatible project name from repo root path.
 * Matches upstream convention:
 * Windows: C:\path\to\repo -> C-path-to-repo
 * Linux/POSIX: /home/user/repo -> home-user-repo
 */
export function cbmProjectName(repoPath) {
  const norm = String(repoPath || '').replace(/\\/g, '/')
  const isWindows = /^[A-Za-z]:/.test(norm)
  const withoutDrive = norm.replace(/^[A-Za-z]:/, '').replace(/^\/+/, '')
  const slug = withoutDrive.replace(/\//g, '-')
  return isWindows ? `C-${slug}` : (slug || 'root')
}

/**
 * Path traversal safe resolution.
 * Ensures the target path resolves strictly within the repository root.
 * Returns normalized relative path (POSIX style) or null if out of bounds.
 */
export function resolveSafeRepoPath(repoRoot, targetPath) {
  if (!repoRoot || !targetPath) return null
  const absRoot = resolve(repoRoot)
  const absTarget = isAbsolute(targetPath) ? resolve(targetPath) : resolve(absRoot, targetPath)

  // Root boundary check
  const rel = relative(absRoot, absTarget)
  if (rel.startsWith('..') || isAbsolute(rel)) {
    return null // Out of bounds
  }

  // Symlink escape check
  try {
    if (existsSync(absTarget)) {
      const realTarget = realpathSync(absTarget)
      const realRoot = realpathSync(absRoot)
      const realRel = relative(realRoot, realTarget)
      if (realRel.startsWith('..') || isAbsolute(realRel)) {
        return null // Symlink targets outside repository!
      }
    }
  } catch {
    // If realpath cannot resolve (e.g. broken link or unreadable), fail closed
    return null
  }

  return rel.split(sep).join('/')
}

/**
 * Check whether a relative path or file name matches sensitive/ignored rules.
 */
export function isSensitiveOrSecret(relPath) {
  const name = basename(relPath)
  for (const pat of SENSITIVE_PATTERNS) {
    if (pat.test(name)) return true
  }
  return false
}

/**
 * Check if a file is binary by extension or null byte check.
 */
export function isBinaryFile(absPath, ext = extname(absPath).toLowerCase()) {
  if (BINARY_EXTENSIONS.has(ext)) return true
  try {
    const fd = readFileSync(absPath, { flag: 'r' })
    const sampleLength = Math.min(fd.length, 1024)
    for (let i = 0; i < sampleLength; i++) {
      if (fd[i] === 0) return true
    }
  } catch {
    return true
  }
  return false
}

/**
 * Parse a .gitignore file into regex-based line matchers.
 */
export function parseGitignoreContent(content) {
  const rules = []
  if (typeof content !== 'string') return rules

  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line || line.startsWith('#')) continue

    let negated = false
    let pattern = line
    if (pattern.startsWith('!')) {
      negated = true
      pattern = pattern.slice(1)
    }

    const isDirOnly = pattern.endsWith('/')
    if (isDirOnly) pattern = pattern.slice(0, -1)

    // Convert gitignore glob pattern to regex
    let regexStr = pattern
      .replace(/[.+^${}()|[\]\\]/g, '\\$&') // escape regex chars
      .replace(/\*\*/g, '§§')
      .replace(/\*/g, '[^/]*')
      .replace(/§§/g, '.*')
      .replace(/\?/g, '[^/]')

    if (pattern.startsWith('/')) {
      regexStr = '^' + regexStr.slice(1)
    } else {
      regexStr = '(^|/)' + regexStr
    }
    regexStr += isDirOnly ? '(/|$)' : '($|/)'

    try {
      rules.push({ regex: new RegExp(regexStr), negated, isDirOnly })
    } catch {
      // ignore invalid regex
    }
  }
  return rules
}

/**
 * Check if a relative path matches gitignore rules.
 */
export function matchesGitignore(relPath, rules, isDir = false) {
  const normalized = relPath.startsWith('/') ? relPath.slice(1) : relPath
  let ignored = false

  for (const rule of rules) {
    if (rule.isDirOnly && !isDir) continue
    if (rule.regex.test(normalized)) {
      ignored = !rule.negated
    }
  }

  return ignored
}

/**
 * Discover all valid source files in the repository.
 * Returns: Array<{ relPath, absPath, size, mtimeMs, language }>
 */
export function discoverRepository(repoRoot, opts = {}) {
  const absRoot = resolve(repoRoot)
  if (!existsSync(absRoot)) {
    throw new Error(`Repository path does not exist: ${repoRoot}`)
  }

  const gitignoreRules = []
  const gitignorePath = join(absRoot, '.gitignore')
  if (existsSync(gitignorePath)) {
    try {
      gitignoreRules.push(...parseGitignoreContent(readFileSync(gitignorePath, 'utf8')))
    } catch {
      // ignore gitignore read failure
    }
  }

  const results = []
  const maxFiles = opts.maxFiles || 50000

  function walk(currentDir) {
    if (results.length >= maxFiles) return

    let entries = []
    try {
      entries = readdirSync(currentDir, { withFileTypes: true })
    } catch {
      return
    }

    for (const entry of entries) {
      if (results.length >= maxFiles) break

      const entryName = entry.name
      const absPath = join(currentDir, entryName)
      const safeRel = resolveSafeRepoPath(absRoot, absPath)
      if (!safeRel) continue

      if (entry.isDirectory()) {
        if (DEFAULT_EXCLUDED_DIRS.has(entryName)) continue
        if (matchesGitignore(safeRel, gitignoreRules, true)) continue
        walk(absPath)
      } else if (entry.isFile()) {
        if (isSensitiveOrSecret(safeRel)) continue
        if (matchesGitignore(safeRel, gitignoreRules, false)) continue

        const ext = extname(entryName).toLowerCase()
        if (BINARY_EXTENSIONS.has(ext)) continue

        try {
          const st = lstatSync(absPath)
          if (st.isSymbolicLink()) {
            const safe = resolveSafeRepoPath(absRoot, absPath)
            if (!safe) continue
          }
          if (st.size > MAX_FILE_SIZE_BYTES) continue
          if (isBinaryFile(absPath, ext)) continue

          const language = EXTENSION_LANGUAGE_MAP[ext] || 'unknown'
          results.push({
            relPath: safeRel,
            absPath,
            size: st.size,
            mtimeMs: st.mtimeMs,
            language,
          })
        } catch {
          continue
        }
      }
    }
  }

  walk(absRoot)
  return results
}

/**
 * Sanitize and scrub content from code snippets before indexing or exposing.
 */
export function sanitizeCodeContent(content) {
  if (typeof content !== 'string') return ''
  const { scrubbed } = scrub(content)
  return scrubbed
}
