/**
 * Veyra runtime Settings schema.
 *
 * Hand-written Standard Schema + a copied schemastery toJSON() envelope
 * so DSH Settings can render volatile fields without a schemastery dep.
 * Live plugin remount applies changes; we do not fake Volatile wrappers.
 */

import { DEFAULT_RECALL_LIMIT } from './types.mjs'

const RECALL_LIMIT_META = Object.freeze({
  step: 1,
  min: 0,
  default: DEFAULT_RECALL_LIMIT,
  description: 'Maximum recalled records per turn. 0 disables automatic recall context.',
  volatile: true,
})

const INCLUDE_REUSABLE_META = Object.freeze({
  default: true,
  description: 'Include cross-project reusable experience in recall.',
  volatile: true,
})

/** Coerce a recall limit: undefined/invalid/negative → 5, explicit 0 stays 0. */
export function normalizeRecallLimit(value) {
  if (value === undefined || value === null || value === '') return DEFAULT_RECALL_LIMIT
  if (typeof value !== 'number' && typeof value !== 'string') return DEFAULT_RECALL_LIMIT
  const n = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(n) || n < 0) return DEFAULT_RECALL_LIMIT
  return Math.trunc(n)
}

function fieldNode(type, meta, uid) {
  return {
    type,
    meta,
    toJSON() {
      return { uid, refs: { [uid]: { type, meta: { ...meta } } } }
    },
  }
}

function issue(message, path) {
  return { issues: [{ message, path }] }
}

export const Config = {
  type: 'object',
  meta: { default: {} },
  dict: {
    recallLimit: fieldNode('number', RECALL_LIMIT_META, 5),
    includeReusable: fieldNode('boolean', INCLUDE_REUSABLE_META, 9),
  },
  toJSON() {
    return {
      uid: 10,
      refs: {
        5: { type: 'number', meta: { ...RECALL_LIMIT_META } },
        9: { type: 'boolean', meta: { ...INCLUDE_REUSABLE_META } },
        10: {
          type: 'object',
          meta: { default: {} },
          dict: { recallLimit: 5, includeReusable: 9 },
        },
      },
    }
  },
  '~standard': {
    version: 1,
    vendor: 'veyra',
    validate(input) {
      const raw = input == null ? {} : input
      if (typeof raw !== 'object' || Array.isArray(raw)) {
        return issue('expected object', [])
      }
      const value = { ...raw }
      if (!Object.hasOwn(raw, 'recallLimit') || raw.recallLimit === undefined) {
        value.recallLimit = DEFAULT_RECALL_LIMIT
      } else {
        const n = typeof raw.recallLimit === 'number' ? raw.recallLimit : Number(raw.recallLimit)
        if (typeof raw.recallLimit !== 'number' || !Number.isFinite(n)) {
          return issue(`$.recallLimit expected number but got ${raw.recallLimit}`, ['recallLimit'])
        }
        if (n < 0) return issue(`$.recallLimit expected number >= 0 but got ${n}`, ['recallLimit'])
        if (!Number.isInteger(n)) {
          return issue(`$.recallLimit expected number multiple of 1 but got ${n}`, ['recallLimit'])
        }
        value.recallLimit = n
      }
      if (!Object.hasOwn(raw, 'includeReusable') || raw.includeReusable === undefined) {
        value.includeReusable = true
      } else if (typeof raw.includeReusable !== 'boolean') {
        return issue(`$.includeReusable expected boolean but got ${raw.includeReusable}`, ['includeReusable'])
      } else {
        value.includeReusable = raw.includeReusable
      }
      return { value }
    },
  },
}
