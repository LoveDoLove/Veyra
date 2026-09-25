import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Config, normalizeRecallLimit } from '../src/config.mjs'
import { DEFAULT_RECALL_LIMIT } from '../src/types.mjs'

function resolve(input) {
  const result = Config['~standard'].validate(input)
  if (result.issues) {
    const err = new Error(result.issues.map((i) => i.message).join('; '))
    err.issues = result.issues
    throw err
  }
  return result.value
}

test('normalizeRecallLimit: undefined/invalid/negative → 5; 0 stays 0', () => {
  assert.equal(normalizeRecallLimit(undefined), DEFAULT_RECALL_LIMIT)
  assert.equal(normalizeRecallLimit(null), DEFAULT_RECALL_LIMIT)
  assert.equal(normalizeRecallLimit(''), DEFAULT_RECALL_LIMIT)
  assert.equal(normalizeRecallLimit('x'), DEFAULT_RECALL_LIMIT)
  assert.equal(normalizeRecallLimit(-1), DEFAULT_RECALL_LIMIT)
  assert.equal(normalizeRecallLimit(-0.5), DEFAULT_RECALL_LIMIT)
  assert.equal(normalizeRecallLimit(NaN), DEFAULT_RECALL_LIMIT)
  assert.equal(normalizeRecallLimit({}), DEFAULT_RECALL_LIMIT)
  assert.equal(normalizeRecallLimit(0), 0)
  assert.equal(normalizeRecallLimit('0'), 0)
  assert.equal(normalizeRecallLimit(1), 1)
  assert.equal(normalizeRecallLimit(5), 5)
  assert.equal(normalizeRecallLimit(1.9), 1)
})

test('Config schema: defaults, 0 survives, negatives rejected, extras passthrough', () => {
  assert.deepEqual(resolve(undefined), { recallLimit: 5, includeReusable: true })
  assert.deepEqual(resolve({}), { recallLimit: 5, includeReusable: true })
  assert.deepEqual(resolve({ recallLimit: 0 }), { recallLimit: 0, includeReusable: true })
  assert.deepEqual(resolve({ recallLimit: 1 }), { recallLimit: 1, includeReusable: true })
  assert.deepEqual(resolve({ recallLimit: 5 }), { recallLimit: 5, includeReusable: true })
  assert.deepEqual(resolve({ includeReusable: false }), { recallLimit: 5, includeReusable: false })
  const extra = resolve({ recallLimit: 0, home: '/tmp/veyra', observe: false })
  assert.equal(extra.recallLimit, 0)
  assert.equal(extra.home, '/tmp/veyra')
  assert.equal(extra.observe, false)

  assert.throws(() => resolve({ recallLimit: -1 }), />= 0/)
  assert.throws(() => resolve({ recallLimit: 1.5 }), /multiple of 1/)
  assert.throws(() => resolve({ recallLimit: 'x' }), /expected number/)
  assert.throws(() => resolve({ includeReusable: 'yes' }), /expected boolean/)
})

test('Config toJSON envelope rehydrates as a volatile Settings form when schemastery is available', () => {
  let Schema
  const candidates = [
    '@deepseek-ai/schemastery',
    '/home/lovedolove/.local/share/mise/installs/node/24.21.0/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/schemastery/lib/index.mjs',
  ]
  return (async () => {
    for (const spec of candidates) {
      try {
        Schema = (await import(spec)).default
        break
      } catch { /* try next */ }
    }
    if (!Schema) return
    const form = new Schema(Config.toJSON())
    assert.equal(form.type, 'object')
    assert.equal(form.dict.recallLimit.meta.volatile, true)
    assert.equal(form.dict.includeReusable.meta.volatile, true)
    assert.equal(form.dict.recallLimit.meta.min, 0)
    assert.equal(form.dict.recallLimit.meta.default, 5)
    const validated = form({ recallLimit: 0 })
    const plain = typeof validated.recallLimit?.get === 'function' ? validated.recallLimit.get() : validated.recallLimit
    assert.equal(plain, 0)
  })()
})
