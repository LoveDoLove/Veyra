/**
 * Veyra — persistent memory store.
 *
 * Uses Node's built-in `node:sqlite` (Node 22.5+) with FTS5. No native
 * addons, so `dsh plugin add` never needs a build approval.
 *
 * Storage layout (outside the user's repo):
 *   $DSH_HOME/veyra/projects/<projectId>/memory.db
 *   $DSH_HOME/veyra/reusable/memory.db
 *
 * Schema adapted from PMA `src/index/db.mjs` (EKU table + FTS5 + triggers),
 * simplified for Veyra's memory model. SQLite is the source of truth here
 * (unlike PMA, Veyra is an agent memory, not a documentation system).
 */

import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import {
  AUTHORITIES,
  CONFIDENCES,
  KINDS,
  SCHEMA_VERSION,
  SCOPES,
  STATUSES,
  VALIDATIONS,
  assertAuthorityTransition,
  isRecallEligible,
  normalizeEnum,
  VALID_AUTHORITIES,
  VALID_CONFIDENCES,
  VALID_KINDS,
  VALID_RELATIONS,
  VALID_SCOPES,
  VALID_STATUSES,
  VALID_VALIDATIONS,
} from './types.mjs'
import { contentHash, newRecordId, projectDbPath, reusableDbPath } from './ids.mjs'
import { scrub } from './redact.mjs'
import { closeAllWatchers } from './code/watcher.mjs'

const SCHEMA_DDL = `
CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY NOT NULL,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS memory (
  id              TEXT PRIMARY KEY NOT NULL,
  kind            TEXT NOT NULL,
  status          TEXT NOT NULL,
  validation      TEXT NOT NULL,
  authority       TEXT NOT NULL,
  confidence      TEXT NOT NULL,
  scope           TEXT NOT NULL,
  project_id      TEXT NOT NULL,
  title           TEXT NOT NULL DEFAULT '',
  body            TEXT NOT NULL DEFAULT '',
  tags            TEXT NOT NULL DEFAULT '[]',
  evidence        TEXT NOT NULL DEFAULT '[]',
  relations       TEXT NOT NULL DEFAULT '[]',
  source          TEXT NOT NULL DEFAULT '{}',
  content_hash    TEXT NOT NULL DEFAULT '',
  forgotten       INTEGER NOT NULL DEFAULT 0,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL,
  last_recalled_at TEXT
);

CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts USING fts5(
  id UNINDEXED,
  title,
  body,
  tags,
  content='memory',
  content_rowid='rowid',
  tokenize='porter unicode61'
);

CREATE TRIGGER IF NOT EXISTS memory_fts_insert AFTER INSERT ON memory BEGIN
  INSERT INTO memory_fts(rowid, id, title, body, tags)
    VALUES (new.rowid, new.id, new.title, new.body, new.tags);
END;

CREATE TRIGGER IF NOT EXISTS memory_fts_delete BEFORE DELETE ON memory BEGIN
  INSERT INTO memory_fts(memory_fts, rowid, id, title, body, tags)
    VALUES ('delete', old.rowid, old.id, old.title, old.body, old.tags);
END;

CREATE TRIGGER IF NOT EXISTS memory_fts_update AFTER UPDATE ON memory BEGIN
  INSERT INTO memory_fts(memory_fts, rowid, id, title, body, tags)
    VALUES ('delete', old.rowid, old.id, old.title, old.body, old.tags);
  INSERT INTO memory_fts(rowid, id, title, body, tags)
    VALUES (new.rowid, new.id, new.title, new.body, new.tags);
END;

CREATE INDEX IF NOT EXISTS idx_memory_project ON memory(project_id);
CREATE INDEX IF NOT EXISTS idx_memory_status ON memory(status);
CREATE INDEX IF NOT EXISTS idx_memory_authority ON memory(authority);
CREATE INDEX IF NOT EXISTS idx_memory_kind ON memory(kind);
CREATE INDEX IF NOT EXISTS idx_memory_forgotten ON memory(forgotten);
CREATE INDEX IF NOT EXISTS idx_memory_hash ON memory(content_hash);
`

function nowIso() {
  return new Date().toISOString()
}

function isIsoDate(value) {
  return typeof value === 'string' && Number.isFinite(Date.parse(value))
}

function asJson(value, fallback) {
  try {
    return JSON.stringify(value ?? fallback)
  } catch {
    return JSON.stringify(fallback)
  }
}

/**
 * §25 corruption detection — strict JSON column parse.
 *
 * dsh-memory `test_n198_tokens_corrupt_failclosed`: a corrupt column that
 * silently degrades to a fallback lets a read-modify-write cycle wipe the
 * original bytes. Here a parse failure (or wrong parsed type) records the
 * field in `corrupt` instead of pretending the record is intact.
 *
 * @param {unknown} value       raw column value
 * @param {unknown} fallback    array/object fallback used for readability
 * @param {string} label        field name pushed to `corrupt`
 * @param {string[]} corrupt    accumulator of broken field names
 * @returns parsed value, or fallback when unreadable
 */
function parseJsonStrict(value, fallback, label, corrupt) {
  if (value == null || value === '') return fallback
  let parsed = value
  if (typeof value === 'string') {
    try {
      parsed = JSON.parse(value)
    } catch {
      corrupt.push(label)
      return fallback
    }
  }
  const wantArray = Array.isArray(fallback)
  const typeOk = wantArray
    ? Array.isArray(parsed)
    : Boolean(parsed) && typeof parsed === 'object' && !Array.isArray(parsed)
  if (!typeOk) {
    corrupt.push(label)
    return fallback
  }
  return parsed
}

/**
 * §24/§25 structural check shared by read (rowToRecord) and the repair
 * verification in put(): every field a record must have, in valid form.
 * Pure — returns the list of invalid field names (empty = intact).
 *
 * @param {object} record
 * @returns {string[]}
 */
function recordStructuralFields(record) {
  const bad = []
  if (!Array.isArray(record.tags)) bad.push('tags')
  if (!Array.isArray(record.evidence)) bad.push('evidence')
  if (!Array.isArray(record.relations)) bad.push('relations')
  if (!record.source || typeof record.source !== 'object' || Array.isArray(record.source)) bad.push('source')
  if (!VALID_KINDS.includes(record.kind)) bad.push('kind')
  if (!VALID_STATUSES.includes(record.status)) bad.push('status')
  if (!VALID_VALIDATIONS.includes(record.validation)) bad.push('validation')
  if (!VALID_AUTHORITIES.includes(record.authority)) bad.push('authority')
  if (!VALID_CONFIDENCES.includes(record.confidence)) bad.push('confidence')
  if (!VALID_SCOPES.includes(record.scope)) bad.push('scope')
  return bad
}

function rowToRecord(row) {
  if (!row) return null
  const corrupt = []
  const record = {
    id: row.id,
    kind: row.kind,
    status: row.status,
    validation: row.validation,
    authority: row.authority,
    confidence: row.confidence,
    scope: row.scope,
    projectId: row.project_id,
    title: row.title,
    body: row.body,
    tags: parseJsonStrict(row.tags, [], 'tags', corrupt),
    evidence: parseJsonStrict(row.evidence, [], 'evidence', corrupt),
    relations: parseJsonStrict(row.relations, [], 'relations', corrupt),
    source: parseJsonStrict(row.source, {}, 'source', corrupt),
    contentHash: row.content_hash,
    forgotten: Boolean(row.forgotten),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastRecalledAt: row.last_recalled_at || null,
    rank: typeof row.rank === 'number' ? row.rank : undefined,
  }
  // §25 fail-closed: a structurally invalid row carries `corrupt` so recall
  // gates exclude it (types.mjs isLifecycleEligible) and put() refuses to
  // overwrite its bytes (recovery only via explicit repair: true).
  for (const field of recordStructuralFields(record)) {
    if (!corrupt.includes(field)) corrupt.push(field)
  }
  if (corrupt.length) record.corrupt = corrupt
  return record
}

/** Enum passthrough with a SANITIZED fallback (§25: garbage never inherits). */
function validEnum(value, allowed, fallback) {
  return typeof value === 'string' && allowed.includes(value) ? value : fallback
}

/** §24 scrub accumulator shared by the tag/evidence/source scrub passes. */
function newScrubBag() {
  return { dirty: false, patterns: [] }
}

function scrubString(value, bag) {
  const result = scrub(value)
  if (!result.clean) bag.dirty = true
  for (const name of result.detectedPatterns) {
    if (!bag.patterns.includes(name)) bag.patterns.push(name)
  }
  return result.scrubbed
}

/**
 * §24 — scrub secrets inside nested JSON values (evidence entries, the
 * source provenance bag). Depth-capped; ordinary text is byte-identical
 * after scrub, so clean records round-trip unchanged.
 */
function scrubDeep(value, depth, bag) {
  if (typeof value === 'string') return scrubString(value, bag)
  if (Array.isArray(value)) {
    if (depth <= 0) return value
    return value.map((entry) => scrubDeep(entry, depth - 1, bag))
  }
  if (value && typeof value === 'object') {
    if (depth <= 0) return value
    const out = {}
    for (const [key, entry] of Object.entries(value)) {
      if (
        typeof entry === 'string'
        && /^(api[_-]?key|secret|password|passwd|token|auth[_-]?token|access[_-]?key|private[_-]?key)$/i.test(key)
      ) {
        bag.dirty = true
        if (!bag.patterns.includes('sensitive_key_value')) bag.patterns.push('sensitive_key_value')
        out[key] = '[REDACTED_SECRET]'
      } else {
        out[key] = scrubDeep(entry, depth - 1, bag)
      }
    }
    return out
  }
  return value
}

function normalizeRecord(input, { existing = null, explicitCanonical = false } = {}) {
  const titleScrub = scrub(String(input.title ?? existing?.title ?? '').trim())
  const bodyScrub = scrub(String(input.body ?? existing?.body ?? '').trim())
  const title = titleScrub.scrubbed.slice(0, 240)
  const body = bodyScrub.scrubbed.slice(0, 16_000)
  if (!title && !body) {
    throw new Error('memory must have a title or a body')
  }

  const bag = newScrubBag()
  const existingAuthority = validEnum(existing?.authority, VALID_AUTHORITIES, AUTHORITIES.CANDIDATE)
  const authority = normalizeEnum(
    input.authority,
    VALID_AUTHORITIES,
    existingAuthority,
  )
  if (existing) {
    assertAuthorityTransition(existingAuthority, authority, { explicit: explicitCanonical })
  } else if (authority === AUTHORITIES.CANONICAL && !explicitCanonical) {
    throw new Error('Veyra refuses to auto-promote memory to canonical authority')
  }

  const rawTags = Array.isArray(input.tags)
    ? input.tags.map((t) => String(t).trim()).filter(Boolean).slice(0, 24)
    : (input.tags !== undefined ? input.tags : (existing?.tags ?? []))
  // §24 — tags/evidence/source carry agent-authored strings too: scrub them
  // on the write path, not just title/body (secrets protected).
  const tags = Array.isArray(rawTags)
    ? rawTags.map((t) => (typeof t === 'string' ? scrubString(t, bag) : t))
    : rawTags

  const rawEvidence = Array.isArray(input.evidence)
    ? input.evidence.slice(0, 32)
    : (input.evidence !== undefined ? input.evidence : (existing?.evidence ?? []))
  const evidence = Array.isArray(rawEvidence)
    ? rawEvidence.map((entry) => scrubDeep(entry, 6, bag))
    : rawEvidence

  const rawRelations = Array.isArray(input.relations)
    ? input.relations
      .filter((r) => r && VALID_RELATIONS.includes(r.type) && typeof r.targetId === 'string')
      .slice(0, 32)
    : (input.relations !== undefined ? input.relations : (existing?.relations ?? []))
  const relations = rawRelations

  const rawSource = input.source !== undefined
    ? input.source
    : (existing?.source && typeof existing.source === 'object' && !Array.isArray(existing.source)
      ? existing.source
      : {})
  const source = rawSource && typeof rawSource === 'object' && !Array.isArray(rawSource)
    ? scrubDeep(rawSource, 6, bag)
    : rawSource

  const stamp = nowIso()
  return {
    id: existing?.id ?? input.id ?? newRecordId(),
    kind: normalizeEnum(input.kind, VALID_KINDS, validEnum(existing?.kind, VALID_KINDS, KINDS.MEMORY)),
    status: normalizeEnum(input.status, VALID_STATUSES, validEnum(existing?.status, VALID_STATUSES, STATUSES.CURRENT)),
    validation: normalizeEnum(input.validation, VALID_VALIDATIONS, validEnum(existing?.validation, VALID_VALIDATIONS, VALIDATIONS.UNVERIFIED)),
    authority,
    confidence: normalizeEnum(input.confidence, VALID_CONFIDENCES, validEnum(existing?.confidence, VALID_CONFIDENCES, CONFIDENCES.MEDIUM)),
    scope: normalizeEnum(input.scope, VALID_SCOPES, validEnum(existing?.scope, VALID_SCOPES, SCOPES.PROJECT)),
    projectId: input.projectId ?? existing?.projectId ?? '',
    title,
    body,
    tags,
    evidence,
    relations,
    source,
    contentHash: contentHash(title, body),
    forgotten: Boolean(input.forgotten ?? existing?.forgotten ?? false),
    createdAt: existing?.createdAt ?? input.createdAt ?? stamp,
    // Always restamp unless the caller explicitly backdates updatedAt
    // (tests / lifecycle). Spreading an existing record must not freeze
    // freshness — that path keeps the previous updatedAt by accident.
    updatedAt: isIsoDate(input.updatedAt) && input.updatedAt !== existing?.updatedAt
      ? input.updatedAt
      : stamp,
    lastRecalledAt: Object.hasOwn(input, 'lastRecalledAt') && (input.lastRecalledAt == null || isIsoDate(input.lastRecalledAt))
      ? input.lastRecalledAt
      : (existing?.lastRecalledAt ?? null),
    redacted: !titleScrub.clean || !bodyScrub.clean || bag.dirty,
    detectedPatterns: [...new Set([...titleScrub.detectedPatterns, ...bodyScrub.detectedPatterns, ...bag.patterns])],
  }
}

function openDatabase(filePath) {
  mkdirSync(dirname(filePath), { recursive: true })
  const db = new DatabaseSync(filePath)
  try {
    db.exec('PRAGMA journal_mode = WAL;')
    db.exec('PRAGMA foreign_keys = ON;')
    db.exec('PRAGMA busy_timeout = 5000;')
  } catch (err) {
    throw new Error(`Veyra refuses to open corrupted store: ${filePath} (${err.message})`, { cause: err })
  }
  // §25 fail-closed: refuse to operate on a physically corrupt store
  // (dsh-memory corruption hardening — unreadable bytes never silently
  // become empty/authoritative state).
  let integrity
  try {
    integrity = db.prepare('PRAGMA quick_check').get()
  } catch (err) {
    throw new Error(`Veyra refuses to open corrupted store: ${filePath} (${err.message})`, { cause: err })
  }
  if (!integrity || integrity.quick_check !== 'ok') {
    throw new Error(`Veyra refuses to open corrupted store: ${filePath} (${integrity?.quick_check ?? 'quick_check failed'})`)
  }
  db.exec(SCHEMA_DDL)
  const version = db.prepare('SELECT value FROM meta WHERE key = ?').get('schema_version')
  if (!version) {
    db.prepare('INSERT INTO meta(key, value) VALUES (?, ?)').run('schema_version', String(SCHEMA_VERSION))
  } else if (Number(version.value) !== SCHEMA_VERSION) {
    // Forward-only: unknown future versions fail closed rather than silently
    // corrupting data. Older versions can be migrated here later.
    throw new Error(`unsupported Veyra schema version ${version.value} (expected ${SCHEMA_VERSION})`)
  }
  return db
}

export class MemoryStore {
  /**
   * @param {string} filePath
   * @param {{ scope: string, projectId: string }} identity
   */
  constructor(filePath, identity) {
    this.filePath = filePath
    this.scope = identity.scope
    this.projectId = identity.projectId
    this.db = openDatabase(filePath)
    this._insert = this.db.prepare(`
      INSERT INTO memory (
        id, kind, status, validation, authority, confidence, scope, project_id,
        title, body, tags, evidence, relations, source, content_hash, forgotten,
        created_at, updated_at, last_recalled_at
      ) VALUES (
        @id, @kind, @status, @validation, @authority, @confidence, @scope, @projectId,
        @title, @body, @tags, @evidence, @relations, @source, @contentHash, @forgotten,
        @createdAt, @updatedAt, @lastRecalledAt
      )
    `)
    this._update = this.db.prepare(`
      UPDATE memory SET
        kind = @kind, status = @status, validation = @validation, authority = @authority,
        confidence = @confidence, scope = @scope, project_id = @projectId,
        title = @title, body = @body, tags = @tags, evidence = @evidence,
        relations = @relations, source = @source, content_hash = @contentHash,
        forgotten = @forgotten, updated_at = @updatedAt, last_recalled_at = @lastRecalledAt
      WHERE id = @id
    `)
    this._get = this.db.prepare('SELECT * FROM memory WHERE id = ?')
    this._byHash = this.db.prepare('SELECT * FROM memory WHERE content_hash = ? AND forgotten = 0 LIMIT 1')
    this._forget = this.db.prepare('UPDATE memory SET forgotten = 1, updated_at = ? WHERE id = ?')
    this._touch = this.db.prepare('UPDATE memory SET last_recalled_at = ? WHERE id = ?')
    this._count = this.db.prepare('SELECT COUNT(*) AS n FROM memory WHERE forgotten = 0')
  }

  close() {
    try { this.db.close() } catch { /* already closed */ }
  }

  get(id) {
    return rowToRecord(this._get.get(id))
  }

  count() {
    return Number(this._count.get()?.n ?? 0)
  }

  put(input, { explicitCanonical = false, repair = false } = {}) {
    const existing = input.id ? this.get(input.id) : null
    // §25 fail-closed (dsh-memory n198_corrupt_failclosed): a read-modify-
    // write over a corrupt row would silently replace its bytes with degraded
    // state. Refuse by default — on-disk bytes are preserved; recovery is the
    // explicit `repair: true` path (§25 recovery), never automatic.
    if (existing?.corrupt?.length && !repair) {
      throw new Error(
        `Veyra refuses to overwrite corrupted record ${existing.id} `
        + `(${existing.corrupt.join(', ')}) — bytes preserved; pass repair: true to rewrite`,
      )
    }
    const record = normalizeRecord(
      { ...input, projectId: input.projectId ?? this.projectId, scope: input.scope ?? this.scope },
      { existing, explicitCanonical },
    )
    // Repair verification: the rewritten record must actually clear every
    // broken field before any byte on disk changes (§25 recovery is verified,
    // not hopeful).
    if (existing?.corrupt?.length) {
      const still = recordStructuralFields(record)
      if (still.length) {
        throw new Error(`repair failed for ${existing.id}: still invalid — ${still.join(', ')}`)
      }
    }

    if (!existing) {
      const dup = rowToRecord(this._byHash.get(record.contentHash))
      // A corrupt content-twin is NOT a duplicate: returning it would hand
      // degraded state to the caller as if it were authoritative. A fresh
      // intact row is written instead; the corrupt bytes stay untouched.
      if (dup && !dup.corrupt?.length) return { record: dup, created: false, duplicate: true, redacted: record.redacted }
    }

    // node:sqlite rejects named-parameter objects that contain keys the
    // statement does not bind, so insert and update get distinct payloads.
    const shared = {
      id: record.id,
      kind: record.kind,
      status: record.status,
      validation: record.validation,
      authority: record.authority,
      confidence: record.confidence,
      scope: record.scope,
      projectId: record.projectId,
      title: record.title,
      body: record.body,
      tags: asJson(record.tags, []),
      evidence: asJson(record.evidence, []),
      relations: asJson(record.relations, []),
      source: asJson(record.source, {}),
      contentHash: record.contentHash,
      forgotten: record.forgotten ? 1 : 0,
      updatedAt: record.updatedAt,
      lastRecalledAt: record.lastRecalledAt,
    }
    if (existing) this._update.run(shared)
    else this._insert.run({ ...shared, createdAt: record.createdAt })
    return { record: this.get(record.id), created: !existing, duplicate: false, redacted: record.redacted }
  }

  forget(id) {
    const existing = this.get(id)
    if (!existing) return null
    this._forget.run(nowIso(), id)
    return this.get(id)
  }

  touch(ids) {
    if (!ids?.length) return
    const stamp = nowIso()
    for (const id of ids) this._touch.run(stamp, id)
  }

  /**
   * List records. By default excludes forgotten items. Does not apply the
   * recall authority gate — callers that want recall-safe results must
   * filter with `isRecallEligible`.
   */
  list({ includeForgotten = false, limit = 50, kind = null } = {}) {
    const clauses = []
    const params = []
    if (!includeForgotten) clauses.push('forgotten = 0')
    if (kind) {
      clauses.push('kind = ?')
      params.push(kind)
    }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''
    const sql = `SELECT * FROM memory ${where} ORDER BY updated_at DESC LIMIT ?`
    params.push(Math.max(1, Math.min(Number(limit) || 50, 200)))
    return this.db.prepare(sql).all(...params).map(rowToRecord)
  }

  /**
   * FTS5 search. Returns matching rows with a `rank` (lower is better) and,
   * for rows that came from FTS, their zero-based `ftsPosition` in that
   * ordered result set.
   *
   * `ftsPosition` is the position SQLite's own `ORDER BY f.rank` produced, so
   * it is independent of the raw bm25 magnitude, which is corpus-dependent and
   * collapses toward zero for common terms in a small store. Rows from the
   * recency fallback have no FTS position and must not be given one.
   *
   * Empty / unsafe queries fall back to a recency listing.
   */
  search(query, { limit = 20, includeForgotten = false, recallOnly = false } = {}) {
    const safeLimit = Math.max(1, Math.min(Number(limit) || 20, 100))
    const ftsQuery = toFtsQuery(query)
    let rows
    let fromFts = false
    if (ftsQuery) {
      const forgottenClause = includeForgotten ? '' : 'AND m.forgotten = 0'
      const sql = `
        SELECT m.*, f.rank AS rank
        FROM memory_fts f
        JOIN memory m ON m.id = f.id
        WHERE memory_fts MATCH ? ${forgottenClause}
        ORDER BY f.rank
        LIMIT ?
      `
      try {
        rows = this.db.prepare(sql).all(ftsQuery, safeLimit)
        fromFts = rows.length > 0
      } catch {
        rows = []
      }
    } else {
      rows = []
    }
    if (rows.length === 0) {
      rows = this.db.prepare(
        `SELECT * FROM memory ${includeForgotten ? '' : 'WHERE forgotten = 0 '}ORDER BY updated_at DESC LIMIT ?`,
      ).all(safeLimit)
    }
    // Position is assigned from the ordered result set BEFORE recallOnly
    // filtering, so it reflects where FTS actually placed the row.
    const records = rows.map((row, i) => ({
      ...rowToRecord(row),
      ftsPosition: fromFts ? i : undefined,
    }))
    if (recallOnly) return records.filter(isRecallEligible)
    return records
  }
}

const FTS_TOKEN = /[A-Za-z0-9_]{2,}/g

/**
 * Convert free text into a safe FTS5 OR-query. Returns '' when the
 * query has no usable tokens (so callers can fall back to recency).
 */
export function toFtsQuery(query) {
  if (typeof query !== 'string') return ''
  const tokens = query.match(FTS_TOKEN)
  if (!tokens || tokens.length === 0) return ''
  const unique = [...new Set(tokens.map((t) => t.toLowerCase()))].slice(0, 12)
  return unique.map((t) => `"${t}"`).join(' OR ')
}

const storeCache = new Map()

// The cache key is the resolved DB path, so it carries veyraHome: the same
// projectId under two different Veyra homes must never share one store.
export function openProjectStore(veyraHome, projectId) {
  const key = `project:${projectDbPath(veyraHome, projectId)}`
  let store = storeCache.get(key)
  if (!store) {
    store = new MemoryStore(projectDbPath(veyraHome, projectId), {
      scope: SCOPES.PROJECT,
      projectId,
    })
    storeCache.set(key, store)
  }
  return store
}

export function openReusableStore(veyraHome) {
  const key = `reusable:${reusableDbPath(veyraHome)}`
  let store = storeCache.get(key)
  if (!store) {
    store = new MemoryStore(reusableDbPath(veyraHome), {
      scope: SCOPES.REUSABLE,
      projectId: 'reusable',
    })
    storeCache.set(key, store)
  }
  return store
}

export function closeAllStores() {
  for (const store of storeCache.values()) store.close()
  storeCache.clear()
  closeAllWatchers()
}

/** Test helper: open an isolated in-memory / temp store that is not cached. */
export function openEphemeralStore(filePath = ':memory:', identity = { scope: SCOPES.PROJECT, projectId: 'test' }) {
  if (filePath === ':memory:') {
    // node:sqlite memory DBs are fine; skip mkdir.
    const db = new DatabaseSync(':memory:')
    db.exec('PRAGMA foreign_keys = ON;')
    db.exec('PRAGMA busy_timeout = 5000;')
    db.exec(SCHEMA_DDL)
    db.prepare('INSERT INTO meta(key, value) VALUES (?, ?)').run('schema_version', String(SCHEMA_VERSION))
    const store = Object.create(MemoryStore.prototype)
    store.filePath = ':memory:'
    store.scope = identity.scope
    store.projectId = identity.projectId
    store.db = db
    store._insert = db.prepare(storeInsertSql())
    store._update = db.prepare(storeUpdateSql())
    store._get = db.prepare('SELECT * FROM memory WHERE id = ?')
    store._byHash = db.prepare('SELECT * FROM memory WHERE content_hash = ? AND forgotten = 0 LIMIT 1')
    store._forget = db.prepare('UPDATE memory SET forgotten = 1, updated_at = ? WHERE id = ?')
    store._touch = db.prepare('UPDATE memory SET last_recalled_at = ? WHERE id = ?')
    store._count = db.prepare('SELECT COUNT(*) AS n FROM memory WHERE forgotten = 0')
    return store
  }
  return new MemoryStore(filePath, identity)
}

function storeInsertSql() {
  return `
    INSERT INTO memory (
      id, kind, status, validation, authority, confidence, scope, project_id,
      title, body, tags, evidence, relations, source, content_hash, forgotten,
      created_at, updated_at, last_recalled_at
    ) VALUES (
      @id, @kind, @status, @validation, @authority, @confidence, @scope, @projectId,
      @title, @body, @tags, @evidence, @relations, @source, @contentHash, @forgotten,
      @createdAt, @updatedAt, @lastRecalledAt
    )
  `
}

function storeUpdateSql() {
  return `
    UPDATE memory SET
      kind = @kind, status = @status, validation = @validation, authority = @authority,
      confidence = @confidence, scope = @scope, project_id = @projectId,
      title = @title, body = @body, tags = @tags, evidence = @evidence,
      relations = @relations, source = @source, content_hash = @contentHash,
      forgotten = @forgotten, updated_at = @updatedAt, last_recalled_at = @lastRecalledAt
    WHERE id = @id
  `
}
