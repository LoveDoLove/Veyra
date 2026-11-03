#!/usr/bin/env node
/**
 * Runtime dependency guardrail for the DSH plugin profile install.
 *
 * DSH profiles install plugins with pnpm (`dsh plugin add <spec>`). If a
 * shipped source file imports a bare module that is NOT declared in
 * `package.json` dependencies, the install leaves the profile without that
 * package and DSH crashes at plugin load with ERR_MODULE_NOT_FOUND (the same
 * class of failure `bundledDependencies` caused: pnpm does not fetch
 * "bundled" packages from the registry, and git-source tarballs cannot carry
 * `node_modules/` at all).
 *
 * This check scans every JavaScript file that ships in the published tarball
 * (the `files` field) for bare, non-relative module specifiers — static
 * `import … from`, side-effect `import`, `export … from`, dynamic
 * `import(…)` and CJS `require(…)` — and asserts each one is either:
 *
 *   * a Node builtin (`node:*`), a relative path, or a URL — never a registry
 *     package;
 *   * host-provided by the DSH runtime or client loader (`@deepseek-ai/*`,
 *     `react` inside the client module);
 *   * declared in `package.json` `dependencies` (the parent package of a
 *     subpath import must be declared).
 *
 * Inspired by dsh-web's scripts/runtime-deps-check.mjs (the same guardrail,
 * scanner built in-repo so no new dev dependency is added; semantics are
 * identical for the specifier forms this codebase uses).
 *
 * CLI: `node scripts/runtime-deps-check.mjs` → exits 1 on any violation.
 */
import { readFileSync } from 'node:fs'
import { existsSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const THIS_DIR = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(THIS_DIR, '..')

/** Specifiers the DSH host provides at runtime — never installed from the registry. */
const HOST_PROVIDED_PREFIXES = ['@deepseek-ai/']
/** Single packages the host loader provides (client-side require in client.js). */
const HOST_PROVIDED_PACKAGES = new Set(['react'])

/**
 * Strip `//` and `/* … *\/` comments (string- and template-aware) so specifiers
 * mentioned in docs are not counted as imports.
 */
export function stripComments(source) {
  let out = ''
  let i = 0
  const n = source.length
  let mode = 'code' // code | line | block | sq | dq | tpl
  while (i < n) {
    const c = source[i]
    const c2 = source[i + 1]
    if (mode === 'code') {
      if (c === '/' && c2 === '/') { mode = 'line'; i += 2; continue }
      if (c === '/' && c2 === '*') { mode = 'block'; i += 2; continue }
      if (c === "'") { mode = 'sq'; out += c; i++; continue }
      if (c === '"') { mode = 'dq'; out += c; i++; continue }
      if (c === '`') { mode = 'tpl'; out += c; i++; continue }
      out += c; i++; continue
    }
    if (mode === 'line') {
      if (c === '\n') { mode = 'code'; out += c }
      i++; continue
    }
    if (mode === 'block') {
      if (c === '*' && c2 === '/') { mode = 'code'; i += 2; continue }
      i++; continue
    }
    // string modes: copy verbatim, track escapes
    if (c === '\\') { out += c + (c2 ?? ''); i += 2; continue }
    out += c
    if ((mode === 'sq' && c === "'") || (mode === 'dq' && c === '"') || (mode === 'tpl' && c === '`')) mode = 'code'
    i++
  }
  return out
}

/**
 * Positions of string/template literal spans (delimiters included) in code
 * whose comments have already been removed. String-aware: a `'` inside a
 * `//` line comment does not open a string; a `//` inside a string does not
 * open a comment. Template `${}` interpolations are skipped over as a whole
 * (a dynamic `import(${…})` with an interpolated specifier is undecidable
 * statically and does not occur in this codebase).
 */
export function stringSpans(code) {
  const spans = []
  let i = 0
  const n = code.length
  let mode = 'code' // code | sq | dq | tpl
  let start = 0
  while (i < n) {
    const c = code[i]
    const c2 = code[i + 1]
    if (mode === 'code') {
      if (c === "'") { mode = 'sq'; start = i; i++; continue }
      if (c === '"') { mode = 'dq'; start = i; i++; continue }
      if (c === '`') { mode = 'tpl'; start = i; i++; continue }
      i++
      continue
    }
    if (mode === 'sq' || mode === 'dq') {
      const q = mode === 'sq' ? "'" : '"'
      if (c === '\\') { i += 2; continue }
      if (c === q || c === '\n') { spans.push([start, i]); mode = 'code' }
      i++
      continue
    }
    // template literal
    if (c === '\\') { i += 2; continue }
    if (c === '$' && c2 === '{') {
      let depth = 1
      i += 2
      while (i < n && depth > 0) {
        if (code[i] === '{') depth++
        else if (code[i] === '}') depth--
        i++
      }
      continue
    }
    if (c === '`') { spans.push([start, i]); mode = 'code' }
    i++
  }
  if (mode !== 'code') spans.push([start, n - 1]) // unterminated literal
  return spans
}

/**
 * Extract bare module specifiers from one source text.
 * Returns [{ specifier, pkg, kind }]; `pkg` is the parent package of subpath
 * imports. Only bare specifiers are returned (relative / builtin / URL forms
 * are dropped by the caller's classifier, not by the extractor).
 */
export function extractSpecifiers(source) {
  const code = stripComments(source)
  const spans = stringSpans(code)
  const inString = (pos) => spans.some(([s, e]) => pos >= s && pos <= e)
  const found = []
  const push = (specifier, kind, keywordPos) => {
    if (inString(keywordPos)) return
    if (specifier.startsWith('.') || specifier.startsWith('/')) return
    if (specifier.startsWith('node:')) return
    if (/^[a-z][a-z0-9+.-]*:/.test(specifier)) return // url: protocol forms
    const pkg = specifier.startsWith('@')
      ? specifier.split('/').slice(0, 2).join('/')
      : specifier.split('/')[0]
    found.push({ specifier, pkg, kind })
  }
  // `import x from 's'` / `export { a } from 's'` (any static from-clause)
  for (const m of code.matchAll(/\bfrom\s*(['"])([^'"]+)\1/g)) push(m[2], 'from', m.index)
  // side-effect import 's'
  for (const m of code.matchAll(/\bimport\s*(['"])([^'"]+)\1/g)) push(m[2], 'import', m.index)
  // dynamic import('s')
  for (const m of code.matchAll(/\bimport\s*\(\s*(['"])([^'"]+)\1/g)) push(m[2], 'dynamic', m.index)
  // CJS require('s')
  for (const m of code.matchAll(/\brequire\s*\(\s*(['"])([^'"]+)\1/g)) push(m[2], 'require', m.index)
  // de-dupe, stable order
  const seen = new Map()
  for (const f of found) if (!seen.has(f.specifier)) seen.set(f.specifier, f)
  return [...seen.values()]
}

/**
 * @param deps package.json `dependencies` record (registry-installed)
 * @param fileMap object: shipped-file path (relative to repo root) → source text
 * @param options { hostProvided?: (string[]) } extra host-provided package names
 * @returns { violations: Array<{ file, specifier, pkg }>, checkedFiles, checkedSpecifiers }
 */
export function checkRuntimeImports(deps, fileMap, options = {}) {
  const hostPrefixes = [...HOST_PROVIDED_PREFIXES, ...(options.hostProvidedPrefixes ?? [])]
  const hostPackages = new Set([...HOST_PROVIDED_PACKAGES, ...(options.hostProvided ?? [])])
  const declared = new Set(Object.keys(deps ?? {}))
  const violations = []
  let checkedSpecifiers = 0
  for (const [file, source] of Object.entries(fileMap)) {
    for (const { specifier, pkg } of extractSpecifiers(source)) {
      checkedSpecifiers++
      if (hostPrefixes.some((p) => specifier.startsWith(p))) continue
      if (hostPackages.has(pkg)) continue
      if (!declared.has(pkg)) violations.push({ file, specifier, pkg })
    }
  }
  return { violations, checkedFiles: Object.keys(fileMap).length, checkedSpecifiers }
}

/** Walk `files` entries (manifest-gated JS) into a path→text map. */
export function buildShippedFileMap(manifest) {
  const files = manifest.files ?? []
  const map = {}
  const addFile = (rel) => {
    if (!/\.(mjs|cjs|js)$/.test(rel)) return
    const abs = join(REPO_ROOT, rel)
    if (!existsSync(abs)) return
    map[rel] = readFileSync(abs, 'utf8')
  }
  const walk = (dirRel) => {
    const abs = join(REPO_ROOT, dirRel)
    if (!existsSync(abs)) return
    const st = statSync(abs)
    if (st.isFile()) {
      addFile(dirRel)
      return
    }
    for (const name of readdirSync(abs)) walk(join(dirRel, name))
  }
  for (const entry of files) {
    const abs = join(REPO_ROOT, entry)
    if (existsSync(abs) && statSync(abs).isDirectory()) walk(entry)
    else addFile(entry)
  }
  // the main entry always ships even when omitted from `files`
  if (manifest.main) addFile(manifest.main)
  return map
}

function main() {
  const manifest = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8'))
  const fileMap = buildShippedFileMap(manifest)
  const { violations, checkedFiles, checkedSpecifiers } = checkRuntimeImports(manifest.dependencies ?? {}, fileMap)
  if (violations.length > 0) {
    console.error(`dsh runtime-deps: ${violations.length} undeclared runtime import(s) in ${checkedFiles} shipped file(s):`)
    for (const v of violations) {
      console.error(`  ${v.file} → ${v.specifier} (package ${v.pkg} is not in "dependencies")`)
    }
    console.error('Fix: declare the package in "dependencies" (registry-installed). pnpm-based DSH profile installs do not fetch bundled or dev-only dependencies.')
    process.exit(1)
  }
  console.log(`runtime-deps: ok — ${checkedFiles} shipped file(s), ${checkedSpecifiers} bare import specifier(s), all declared in dependencies.`)
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main()
