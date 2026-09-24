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

function parseJson(value, fallback) {
  if (value == null || value === '') return fallback
  if (typeof value !== 'string') return value
  try {
    return JSON.parse(value)
  } catch {
    return fallback
  }
}

function asJson(value, fallback) {
  try {
    return JSON.stringify(value ?? fallback)
  } catch {
    return JSON.stringify(fallback)
  }
}

function rowToRecord(row) {
  if (!row) return null
  return {
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
    tags: parseJson(row.tags, []),
    evidence: parseJson(row.evidence, []),
    relations: parseJson(row.relations, []),
    source: parseJson(row.source, {}),
    contentHash: row.content_hash,
    forgotten: Boolean(row.forgotten),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastRecalledAt: row.last_recalled_at || null,
    rank: typeof row.rank === 'number' ? row.rank : undefined,
  }
}

function normalizeRecord(input, { existing = null, explicitCanonical = false } = {}) {
  const titleScrub = scrub(String(input.title ?? existing?.title ?? '').trim())
  const bodyScrub = scrub(String(input.body ?? existing?.body ?? '').trim())
  const title = titleScrub.scrubbed.slice(0, 240)
  const body = bodyScrub.scrubbed.slice(0, 16_000)
  if (!title && !body) {
    throw new Error('memory must have a title or a body')
  }

  const authority = normalizeEnum(
    input.authority,
    VALID_AUTHORITIES,
    existing?.authority ?? AUTHORITIES.CANDIDATE,
  )
  if (existing) {
    assertAuthorityTransition(existing.authority, authority, { explicit: explicitCanonical })
  } else if (authority === AUTHORITIES.CANONICAL && !explicitCanonical) {
    throw new Error('Veyra refuses to auto-promote memory to canonical authority')
  }

  const tags = Array.isArray(input.tags)
    ? input.tags.map((t) => String(t).trim()).filter(Boolean).slice(0, 24)
    : (existing?.tags ?? [])
  const evidence = Array.isArray(input.evidence)
    ? input.evidence.slice(0, 32)
    : (existing?.evidence ?? [])
  const relations = Array.isArray(input.relations)
    ? input.relations
      .filter((r) => r && VALID_RELATIONS.includes(r.type) && typeof r.targetId === 'string')
      .slice(0, 32)
    : (existing?.relations ?? [])

  const stamp = nowIso()
  return {
    id: existing?.id ?? input.id ?? newRecordId(),
    kind: normalizeEnum(input.kind, VALID_KINDS, existing?.kind ?? KINDS.MEMORY),
    status: normalizeEnum(input.status, VALID_STATUSES, existing?.status ?? STATUSES.CURRENT),
    validation: normalizeEnum(input.validation, VALID_VALIDATIONS, existing?.validation ?? VALIDATIONS.UNVERIFIED),
    authority,
    confidence: normalizeEnum(input.confidence, VALID_CONFIDENCES, existing?.confidence ?? CONFIDENCES.MEDIUM),
    scope: normalizeEnum(input.scope, VALID_SCOPES, existing?.scope ?? SCOPES.PROJECT),
    projectId: input.projectId ?? existing?.projectId ?? '',
    title,
    body,
    tags,
    evidence,
    relations,
    source: input.source && typeof input.source === 'object' ? input.source : (existing?.source ?? {}),
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
    redacted: !titleScrub.clean || !bodyScrub.clean,
    detectedPatterns: [...new Set([...titleScrub.detectedPatterns, ...bodyScrub.detectedPatterns])],
  }
}

function openDatabase(filePath) {
  mkdirSync(dirname(filePath), { recursive: true })
  const db = new DatabaseSync(filePath)
  db.exec('PRAGMA journal_mode = WAL;')
  db.exec('PRAGMA foreign_keys = ON;')
  db.exec('PRAGMA busy_timeout = 5000;')
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

  put(input, { explicitCanonical = false } = {}) {
    const existing = input.id ? this.get(input.id) : null
    const record = normalizeRecord(
      { ...input, projectId: input.projectId ?? this.projectId, scope: input.scope ?? this.scope },
      { existing, explicitCanonical },
    )

    if (!existing) {
      const dup = rowToRecord(this._byHash.get(record.contentHash))
      if (dup) return { record: dup, created: false, duplicate: true, redacted: record.redacted }
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
   * FTS5 search. Returns matching rows with a `rank` (lower is better).
   * Empty / unsafe queries fall back to a recency listing.
   */
  search(query, { limit = 20, includeForgotten = false, recallOnly = false } = {}) {
    const safeLimit = Math.max(1, Math.min(Number(limit) || 20, 100))
    const ftsQuery = toFtsQuery(query)
    let rows
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
    let records = rows.map(rowToRecord)
    if (recallOnly) records = records.filter(isRecallEligible)
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

export function openProjectStore(veyraHome, projectId) {
  const key = `project:${projectId}`
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
  const key = 'reusable'
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
