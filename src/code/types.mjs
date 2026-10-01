/**
 * Veyra Code Intelligence — Types & Constants.
 */

export const INDEX_STATUS = Object.freeze({
  NOT_INDEXED: 'not_indexed',
  INDEXING: 'indexing',
  READY: 'ready',
  UPDATING: 'updating',
  DEGRADED: 'degraded',
  ERROR: 'error',
})

export const FRESHNESS_STATUS = Object.freeze({
  FRESH: 'fresh',
  POTENTIALLY_STALE: 'potentially_stale',
  INVALID: 'invalid',
})

export const CODE_ENTITY_TYPES = Object.freeze({
  FILE: 'File',
  MODULE: 'Module',
  FUNCTION: 'Function',
  CLASS: 'Class',
  INTERFACE: 'Interface',
  METHOD: 'Method',
  TYPE: 'Type',
  VARIABLE: 'Variable',
})

export const CODE_RELATIONS = Object.freeze({
  DEFINES: 'DEFINES',
  CALLS: 'CALLS',
  IMPORTS: 'IMPORTS',
  REFERENCES: 'REFERENCES',
  IMPLEMENTS: 'IMPLEMENTS',
  EXTENDS: 'EXTENDS',
  DEPENDS_ON: 'DEPENDS_ON',
})

export const TRACE_DIRECTIONS = Object.freeze({
  INBOUND: 'inbound',
  OUTBOUND: 'outbound',
  BOTH: 'both',
})

export const DEFAULT_UI_PORT = 9749
