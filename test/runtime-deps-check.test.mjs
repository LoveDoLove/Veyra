import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  stripComments,
  stringSpans,
  extractSpecifiers,
  checkRuntimeImports,
  buildShippedFileMap,
} from '../scripts/runtime-deps-check.mjs'

test('stripComments: removes line and block comments without breaking strings', () => {
  const code = `
    // this is a line comment
    const a = 'hello // not a comment'
    /* this is a
       block comment */
    const b = "/* not a comment */"
  `
  const stripped = stripComments(code)
  assert.ok(!stripped.includes('this is a line comment'))
  assert.ok(!stripped.includes('this is a\n       block comment'))
  assert.ok(stripped.includes("'hello // not a comment'"))
  assert.ok(stripped.includes('"/* not a comment */"'))
})

test('stringSpans: accurately marks string boundaries', () => {
  const code = "const a = 'first'; const b = \"second\"; const c = `third`;"
  const spans = stringSpans(code)
  assert.equal(spans.length, 3)
  assert.equal(code.slice(spans[0][0], spans[0][1] + 1), "'first'")
  assert.equal(code.slice(spans[1][0], spans[1][1] + 1), '"second"')
  assert.equal(code.slice(spans[2][0], spans[2][1] + 1), '`third`')
})

test('extractSpecifiers: extracts bare imports and ignores data strings and relative/builtins', () => {
  const sample = `
    import { a } from 'node:fs'
    import b from './local.mjs'
    import c from '../parent.mjs'
    import { d } from '@scope/pkg'
    import { e } from 'unscoped-pkg/subpath'
    const words = ['from', 'import', 'require']
    const dynamic = await import('@dyn/pkg')
    const req = require('cjs-pkg')
    // import 'commented-pkg'
  `
  const specs = extractSpecifiers(sample)
  const pkgs = specs.map((s) => s.pkg).sort()
  assert.deepEqual(pkgs, ['@dyn/pkg', '@scope/pkg', 'cjs-pkg', 'unscoped-pkg'])
})

test('checkRuntimeImports: detects undeclared dependencies and allows host-provided', () => {
  const fileMap = {
    'shipped.mjs': `
      import { x } from '@lovedolove/dsh-codebase-memory-mcp'
      import { dsh } from '@deepseek-ai/dsh-tools'
      const React = require('react')
      import { bad } from 'undeclared-dep'
    `,
  }
  const deps = {
    '@lovedolove/dsh-codebase-memory-mcp': '^0.1.5',
  }
  const { violations } = checkRuntimeImports(deps, fileMap)
  assert.equal(violations.length, 1)
  assert.equal(violations[0].pkg, 'undeclared-dep')
  assert.equal(violations[0].file, 'shipped.mjs')
})

test('packaging regression: Veyra package.json uses DSH-supported packaging', () => {
  const pkgJsonPath = join(import.meta.dirname, '..', 'package.json')
  const pkg = JSON.parse(readFileSync(pkgJsonPath, 'utf8'))

  // 1. Must NOT use bundledDependencies (causes pnpm to skip registry resolution and fail with ERR_MODULE_NOT_FOUND)
  assert.equal(
    pkg.bundledDependencies,
    undefined,
    'Veyra must not use bundledDependencies: pnpm profile installs require registry dependencies'
  )
  assert.equal(
    pkg.bundleDependencies,
    undefined,
    'Veyra must not use bundleDependencies'
  )

  // 2. Must declare CBM in dependencies
  assert.ok(
    pkg.dependencies?.['@lovedolove/dsh-codebase-memory-mcp'],
    '@lovedolove/dsh-codebase-memory-mcp must be declared in dependencies'
  )

  // 3. Shipped files must have zero undeclared runtime imports
  const fileMap = buildShippedFileMap(pkg)
  assert.ok(Object.keys(fileMap).length > 25, 'Expected >25 shipped files')
  const { violations } = checkRuntimeImports(pkg.dependencies ?? {}, fileMap)
  assert.deepEqual(
    violations,
    [],
    `Found undeclared runtime imports in shipped files: ${JSON.stringify(violations)}`
  )
})
