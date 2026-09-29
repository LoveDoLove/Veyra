/**
 * Locate and load an installed DeepSeek Harness (DSH) for tests that verify
 * Veyra against the real runtime instead of doubles.
 *
 * Shared by test/compatibility.test.mjs (compatibility gate + tool seam) and
 * test/dsh-runtime.test.mjs (composed host-service runtime). Not a test file
 * itself — npm test only runs test/*.test.mjs.
 *
 * Returns null / null-safe results when no DSH install is discoverable, so
 * callers can skip with an explicit message rather than fail environments
 * that intentionally have no DSH.
 */

import { createRequire } from 'node:module'
import { existsSync, readFileSync, readdirSync, realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'

function packageRootOf (entry) {
  let dir = dirname(entry)
  while (dir !== dirname(dir)) {
    const manifest = join(dir, 'package.json')
    if (existsSync(manifest)) {
      try {
        const parsed = JSON.parse(readFileSync(manifest, 'utf8'))
        if (parsed.name === '@deepseek-ai/dsh') return { dir, version: parsed.version }
      } catch { /* keep walking */ }
    }
    dir = dirname(dir)
  }
  return null
}

export function findDshRoot () {
  const candidates = []
  if (process.env.DSH_INSTALL) candidates.push(process.env.DSH_INSTALL)
  for (const binDir of (process.env.PATH || '').split(':')) {
    if (binDir) candidates.push(join(binDir, 'dsh'))
  }
  const installs = join(homedir(), '.local/share/mise/installs')
  if (existsSync(installs)) {
    for (const flavor of readdirSync(installs)) candidates.push(join(installs, flavor, 'lib/node_modules/@deepseek-ai/dsh'))
  }
  for (const candidate of candidates) {
    if (!existsSync(candidate)) continue
    let entry = realpathSync(candidate)
    if (!entry.endsWith('.js')) entry = join(entry, 'lib/bin.js')
    if (!existsSync(entry)) continue
    const found = packageRootOf(entry)
    if (found) return found
  }
  return null
}

export function resolveDshPackage (name) {
  const dsh = findDshRoot()
  if (!dsh) return null
  try {
    return createRequire(join(dsh.dir, 'package.json')).resolve(name)
  } catch {
    const nested = join(dsh.dir, 'node_modules', name, 'lib/index.js')
    return existsSync(nested) ? nested : null
  }
}

export async function loadDshPackage (name) {
  const entry = resolveDshPackage(name)
  if (!entry) return null
  try {
    return await import(pathToFileURL(entry).href)
  } catch {
    return null
  }
}
