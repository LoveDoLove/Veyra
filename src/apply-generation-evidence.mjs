/**
 * P1 Stage A — Veyra-local generation evidence (metadata-only, bounded).
 *
 * Records recall context generation completion as:
 *   generated | generated_empty | generation_error
 *
 * Stage A truth labels:
 *   delivery.status = DELIVERED only for a tool dispatch that returned a payload;
 *                     NOT_VERIFIED everywhere else, including the context provider
 *   used.status     = NOT_VERIFIED (no supported attribution evidence)
 *
 * No prompt interception, no raw query/content/secrets, no invented Host APIs.
 * Telemetry is best-effort and must never change recall/feedback behavior.
 */
export const APPLY_GENERATION_KEY = 'veyra_apply_generation_v1'
export const APPLY_OUTCOME_LINK_KEY = 'veyra_apply_outcome_link_v1'
export const APPLY_AUTO_OUTCOME_KEY = 'veyra_apply_auto_outcome_v1'

// A turn's own test evidence can only *correlate* a delivered record with a
// pass. `test-passed` is a local observation of runner output, not proof that a
// model received or applied the memory, so nothing here may strengthen a
// record's confidence, validation, or authority.
export const AUTO_OUTCOME = Object.freeze({
  CONTRADICTED: 'CONTRADICTED',
  PLAUSIBLE: 'PLAUSIBLE_CORRELATION',
})
// AUTO_OUTCOME is keyed CONTRADICTED / PLAUSIBLE but the stored value is
// PLAUSIBLE_CORRELATION, so membership must test the VALUES, not the keys.
const AUTO_OUTCOME_VALUES = new Set(Object.values(AUTO_OUTCOME))
const AUTO_OUTCOME_ENTRY_LIMIT = 64

export const DELIVERY = Object.freeze({ DELIVERED: 'DELIVERED', NOT_VERIFIED: 'NOT_VERIFIED' })
// Only the tool dispatch can prove a returned payload: `visible` is handed back
// to the model-facing call. The context provider has no such surface, so it is
// deliberately NOT in this set — its entries stay NOT_VERIFIED forever.
const DELIVERABLE_SOURCES = new Set(['tool'])

const ENTRY_LIMIT = 64
const ENTRY_HARD_LIMIT = 128
const SERIALIZED_MAX_BYTES = 32 * 1024
const RECORD_REFS_MAX = 16

function nowIso(at) {
  return typeof at === 'string' ? at : new Date().toISOString()
}

function boundedText(v, max) {
  return typeof v === 'string' && v ? v.slice(0, max) : undefined
}

function normalizeQueryClass(value) {
  const allowed = new Set(['claimed_prompt', 'task_intent', 'change_signal', 'explicit_query', 'empty', 'unknown'])
  return allowed.has(value) ? value : 'unknown'
}

function notVerified(stage) {
  return {
    status: 'NOT_VERIFIED',
    source: 'stage-a-local',
    detail: stage === 'delivery'
      ? 'no supported DSH admission evidence'
      : 'no supported attribution evidence',
  }
}

function emptyLog() {
  return { v: 1, updatedAt: null, nextSeq: 1, entries: [] }
}

function normalizeEntry(e) {
  if (!e || typeof e !== 'object' || typeof e.status !== 'string') return null
  const status = e.status
  if (!['generated', 'generated_empty', 'generation_error'].includes(status)) return null
  const out = {
    eventId: boundedText(e.eventId, 64),
    at: boundedText(e.at, 40),
    kind: 'veyra.apply.generation',
    source: boundedText(e.source, 96) || 'veyra.context.createContextProvider',
    scope: ['project', 'reusable', 'mixed', 'unknown'].includes(e.scope) ? e.scope : 'unknown',
    status,
    queryClass: normalizeQueryClass(e.queryClass),
    resultCount: Number.isFinite(e.resultCount) && e.resultCount >= 0 ? Math.trunc(e.resultCount) : 0,
    recordRefs: Array.isArray(e.recordRefs) ? e.recordRefs.filter((x) => typeof x === 'string' && x).slice(0, RECORD_REFS_MAX) : [],
    recordRefsTruncated: e.recordRefsTruncated === true,
    renderedChars: Number.isFinite(e.renderedChars) && e.renderedChars >= 0 ? Math.trunc(e.renderedChars) : 0,
    delivery: e.delivery?.status === DELIVERY.DELIVERED
      ? {
        status: DELIVERY.DELIVERED,
        source: boundedText(e.delivery.source, 48) || 'tool-dispatch',
        detail: boundedText(e.delivery.detail, 96) || '',
      }
      : notVerified('delivery'),
    used: notVerified('used'),
  }
  if (Number.isFinite(e.charBudget) && e.charBudget >= 0) out.charBudget = Math.trunc(e.charBudget)
  if (status === 'generation_error') out.errorClass = boundedText(e.errorClass, 48) || 'unknown'
  return out.eventId && out.at ? out : null
}

function normalizeLog(value) {
  const log = emptyLog()
  if (!value || typeof value !== 'object') return log
  log.updatedAt = boundedText(value.updatedAt, 40)
  log.nextSeq = Number.isFinite(value.nextSeq) && value.nextSeq >= 1 ? Math.trunc(value.nextSeq) : 1
  if (Array.isArray(value.entries)) {
    for (const e of value.entries.slice(-ENTRY_HARD_LIMIT)) {
      const n = normalizeEntry(e)
      if (n) log.entries.push(n)
    }
  }
  return log
}

function capAndStore(store, key, log) {
  while (log.entries.length > ENTRY_LIMIT) log.entries.shift()
  let json = JSON.stringify(log)
  while (log.entries.length > 0 && Buffer.byteLength(json, 'utf8') > SERIALIZED_MAX_BYTES) {
    log.entries.shift()
    json = JSON.stringify(log)
  }
  store.setMeta(key, json)
  return log
}

function readLog(store, key, normalizer) {
  if (!store || typeof store.getMeta !== 'function') return null
  try {
    const raw = store.getMeta(key)
    if (!raw) return null
    const log = normalizer(JSON.parse(raw))
    return log.entries.length > 0 ? log : null
  } catch {
    return null
  }
}

function appendEntry(store, key, makeEntry) {
  if (!store || typeof store.getMeta !== 'function' || typeof store.setMeta !== 'function') return null
  try {
    let log
    try {
      const raw = store.getMeta(key)
      log = raw ? normalizeLog(JSON.parse(raw)) : emptyLog()
    } catch {
      log = emptyLog()
    }
    const seq = log.nextSeq
    log.nextSeq = seq + 1
    const prefix = store.scope === 'reusable' ? 'r' : 'p'
    const entry = makeEntry({ seq, prefix })
    if (!entry) return null
    log.entries.push(entry)
    log.updatedAt = entry.at
    return capAndStore(store, key, log)
  } catch {
    return null
  }
}

export function recordGenerationEvidence(store, {
  status, queryClass = 'unknown', resultCount = 0, recordRefs = [],
  renderedChars = 0, charBudget, errorClass, at, scope, source, delivery,
} = {}) {
  const normalizedStatus = ['generated', 'generated_empty', 'generation_error'].includes(status) ? status : 'generation_error'
  const resolvedDelivery = delivery && delivery.status === DELIVERY.DELIVERED && DELIVERABLE_SOURCES.has(source)
    ? { status: DELIVERY.DELIVERED, source: delivery.source || source, detail: 'returned to the model-facing dispatch; model receipt not provable' }
    : notVerified('delivery')
  return appendEntry(store, APPLY_GENERATION_KEY, ({ seq, prefix }) => {
    const when = nowIso(at)
    const refs = Array.isArray(recordRefs) ? recordRefs.filter((x) => typeof x === 'string' && x) : []
    const entry = {
      eventId: `vge_${prefix}_${seq.toString(36).padStart(6, '0')}`,
      at: when,
      kind: 'veyra.apply.generation',
      source: boundedText(source, 96) || 'veyra.context.createContextProvider',
      scope: ['project', 'reusable', 'mixed', 'unknown'].includes(scope) ? scope : (store?.scope === 'reusable' ? 'reusable' : 'project'),
      status: normalizedStatus,
      queryClass: normalizeQueryClass(queryClass),
      resultCount: Number.isFinite(resultCount) && resultCount >= 0 ? Math.trunc(resultCount) : refs.length,
      recordRefs: refs.slice(0, RECORD_REFS_MAX),
      recordRefsTruncated: refs.length > RECORD_REFS_MAX,
      renderedChars: Number.isFinite(renderedChars) && renderedChars >= 0 ? Math.trunc(renderedChars) : 0,
      delivery: resolvedDelivery,
      used: notVerified('used'),
    }
    if (Number.isFinite(charBudget) && charBudget >= 0) entry.charBudget = Math.trunc(charBudget)
    if (normalizedStatus === 'generation_error') entry.errorClass = boundedText(errorClass, 48) || 'unknown'
    // queryHash omitted by default in Stage A
    return entry
  })
}

export function readGenerationEvidence(store) {
  return readLog(store, APPLY_GENERATION_KEY, normalizeLog)
}

export function summarizeGenerationEvidence(log) {
  if (!log || !Array.isArray(log.entries) || log.entries.length === 0) return null
  const byStatus = { generated: 0, generated_empty: 0, generation_error: 0 }
  for (const e of log.entries) if (byStatus[e.status] !== undefined) byStatus[e.status]++
  const delivered = log.entries.filter((e) => e.delivery?.status === DELIVERY.DELIVERED)
  return {
    available: true,
    count: log.entries.length,
    updatedAt: log.updatedAt || null,
    byStatus,
    // An aggregate label may only claim delivery when a retained entry proves one.
    delivery: delivered.length
      ? { status: DELIVERY.DELIVERED, source: delivered[0].delivery.source || 'tool-dispatch', count: delivered.length }
      : notVerified('delivery'),
    used: notVerified('used'),
    recent: log.entries.slice(-5).map((e) => ({
      eventId: e.eventId, at: e.at, status: e.status, queryClass: e.queryClass,
      resultCount: e.resultCount, renderedChars: e.renderedChars,
    })),
  }
}

function normalizeLinkEntry(e) {
  if (!e || typeof e !== 'object' || typeof e.recordId !== 'string') return null
  const outcome = e.outcome === 'success' || e.outcome === 'failure' ? e.outcome : null
  if (!outcome) return null
  return {
    linkId: boundedText(e.linkId, 64),
    at: boundedText(e.at, 40),
    kind: 'veyra.apply.outcome_link',
    recordId: e.recordId.slice(0, 128),
    outcome,
    generationEventId: boundedText(e.generationEventId, 64),
    attribution: 'explicit_linked',
  }
}

function normalizeLinkLog(value) {
  const log = emptyLog()
  if (!value || typeof value !== 'object') return log
  log.updatedAt = boundedText(value.updatedAt, 40)
  log.nextSeq = Number.isFinite(value.nextSeq) && value.nextSeq >= 1 ? Math.trunc(value.nextSeq) : 1
  if (Array.isArray(value.entries)) {
    for (const e of value.entries.slice(-ENTRY_HARD_LIMIT)) {
      const n = normalizeLinkEntry(e)
      if (n?.linkId && n?.at) log.entries.push(n)
    }
  }
  return log
}

export function recordExplicitOutcomeLink(store, { recordId, outcome, generationEventId, at } = {}) {
  if (typeof generationEventId !== 'string' || !generationEventId.trim()) return null
  if (!store || typeof store.getMeta !== 'function' || typeof store.setMeta !== 'function') return null
  if (typeof recordId !== 'string' || !recordId) return null
  if (outcome !== 'success' && outcome !== 'failure') return null
  // Validate explicit reference exists in retained generation evidence when possible.
  const gen = readGenerationEvidence(store)
  if (gen && Array.isArray(gen.entries) && !gen.entries.some((e) => e.eventId === generationEventId)) return null
  try {
    let log
    try {
      const raw = store.getMeta(APPLY_OUTCOME_LINK_KEY)
      log = raw ? normalizeLinkLog(JSON.parse(raw)) : emptyLog()
    } catch {
      log = emptyLog()
    }
    const seq = log.nextSeq
    log.nextSeq = seq + 1
    const prefix = store.scope === 'reusable' ? 'r' : 'p'
    const when = nowIso(at)
    log.entries.push({
      linkId: `vol_${prefix}_${seq.toString(36).padStart(6, '0')}`,
      at: when,
      kind: 'veyra.apply.outcome_link',
      recordId: recordId.slice(0, 128),
      outcome,
      generationEventId: generationEventId.slice(0, 64),
      attribution: 'explicit_linked',
    })
    log.updatedAt = when
    while (log.entries.length > ENTRY_LIMIT) log.entries.shift()
    let json = JSON.stringify(log)
    while (log.entries.length > 0 && Buffer.byteLength(json, 'utf8') > SERIALIZED_MAX_BYTES) {
      log.entries.shift()
      json = JSON.stringify(log)
    }
    store.setMeta(APPLY_OUTCOME_LINK_KEY, json)
    return log
  } catch {
    return null
  }
}

export function readExplicitOutcomeLinks(store) {
  return readLog(store, APPLY_OUTCOME_LINK_KEY, normalizeLinkLog)
}

function normalizeAutoOutcomeEntry(e) {
  if (!e || typeof e !== 'object') return null
  if (!AUTO_OUTCOME_VALUES.has(e.signal)) return null
  const recordId = boundedText(e.recordId, 128)
  const eventId = boundedText(e.eventId, 64)
  const at = boundedText(e.at, 40)
  if (!recordId || !eventId || !at) return null
  return {
    eventId,
    at,
    kind: 'veyra.apply.auto_outcome',
    recordId,
    signal: e.signal,
    generationEventId: boundedText(e.generationEventId, 64),
    attribution: 'turn_test_evidence',
  }
}

function normalizeAutoOutcomeLog(value) {
  const log = emptyLog()
  if (!value || typeof value !== 'object') return log
  log.updatedAt = boundedText(value.updatedAt, 40)
  log.nextSeq = Number.isFinite(value.nextSeq) && value.nextSeq >= 1 ? Math.trunc(value.nextSeq) : 1
  if (Array.isArray(value.entries)) {
    for (const e of value.entries.slice(-ENTRY_HARD_LIMIT)) {
      const n = normalizeAutoOutcomeEntry(e)
      if (n) log.entries.push(n)
    }
  }
  return log
}

/**
 * Record that a turn's test evidence correlated with a delivered recall.
 *
 * Non-causal by construction: it writes its own log and never calls
 * `recordFeedback`, `strengthenMemory`, or `promote`. An unknown signal is
 * refused rather than coerced.
 */
export function recordAutoOutcomeSignal(store, { recordId, generationEventId, signal, at } = {}) {
  if (!AUTO_OUTCOME_VALUES.has(signal)) return null
  if (!store || typeof store.getMeta !== 'function' || typeof store.setMeta !== 'function') return null
  if (typeof recordId !== 'string' || !recordId) return null
  try {
    let log
    try {
      const raw = store.getMeta(APPLY_AUTO_OUTCOME_KEY)
      log = raw ? normalizeAutoOutcomeLog(JSON.parse(raw)) : emptyLog()
    } catch {
      log = emptyLog()
    }
    const seq = log.nextSeq
    log.nextSeq = seq + 1
    const prefix = store.scope === 'reusable' ? 'r' : 'p'
    const when = nowIso(at)
    log.entries.push({
      eventId: `vao_${prefix}_${seq.toString(36).padStart(6, '0')}`,
      at: when,
      kind: 'veyra.apply.auto_outcome',
      recordId: recordId.slice(0, 128),
      signal,
      generationEventId: boundedText(generationEventId, 64),
      attribution: 'turn_test_evidence',
    })
    log.updatedAt = when
    while (log.entries.length > AUTO_OUTCOME_ENTRY_LIMIT) log.entries.shift()
    let json = JSON.stringify(log)
    while (log.entries.length > 0 && Buffer.byteLength(json, 'utf8') > SERIALIZED_MAX_BYTES) {
      log.entries.shift()
      json = JSON.stringify(log)
    }
    store.setMeta(APPLY_AUTO_OUTCOME_KEY, json)
    return log
  } catch {
    return null
  }
}

export function readAutoOutcomeSignals(store) {
  const log = readLog(store, APPLY_AUTO_OUTCOME_KEY, normalizeAutoOutcomeLog)
  return { available: Boolean(log), count: log?.entries.length ?? 0, entries: log?.entries ?? [] }
}
