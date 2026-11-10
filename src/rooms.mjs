/**
 * Veyra — Memory Room and Central Memories filesystem layout.
 *
 * A Memory Room is the private storage partition of one DSH workspace. Its
 * identity is the DSH `WorkspaceId` (a generated UUID), never a filesystem
 * path: two workspaces that point at the same repository still get different
 * rooms. This is the only layout Veyra writes.
 *
 * The old `projects/<projectId>` and `reusable/` directories are deliberately
 * absent from this module. They may still exist on disk; nothing here names
 * them, so no code reached through this module can read, write, or migrate
 * them.
 *
 * Everything here is path arithmetic plus small atomic JSON helpers. It does
 * not open SQLite and does not import the store module, so it is safe to use
 * from the resolver, the promotion path, and tests alike.
 */

import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve, sep } from 'node:path'

export const ROOMS_DIR = 'rooms'
export const CENTRAL_DIR = 'central'
export const ROOM_ID_PREFIX = 'w_'

// Room ids become path segments, so only a conservative alphabet is allowed.
// DSH WorkspaceId values are UUIDs, but the resolver never trusts that blindly.
const SAFE_ROOM_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/

export function canonicalPath(value) {
  if (typeof value !== 'string' || !value.trim()) return ''
  const absolute = resolve(value.trim())
  try {
    return realpathSync.native(absolute)
  } catch {
    // Missing directories still have a meaningful canonical form for matching;
    // DSH keeps the create-time canonical path even when the directory later
    // disappears, and Veyra must not guess a different one.
    return absolute
  }
}

export function isSafeRoomId(roomId) {
  return typeof roomId === 'string' && SAFE_ROOM_ID.test(roomId) && !roomId.includes('..')
}

export function assertSafeRoomId(roomId) {
  if (!isSafeRoomId(roomId)) {
    throw new Error(`Veyra refuses unsafe memory room id: ${JSON.stringify(roomId)}`)
  }
  return roomId
}

export function roomIdForWorkspaceId(workspaceId) {
  const id = typeof workspaceId === 'string' ? workspaceId.trim() : ''
  if (!id) return ''
  if (isSafeRoomId(id)) return `${ROOM_ID_PREFIX}${id}`
  const digest = createHash('sha256').update(id).digest('hex').slice(0, 32)
  return `${ROOM_ID_PREFIX}${digest}`
}

export function roomsRoot(home) {
  return join(home, ROOMS_DIR)
}

export function roomDir(home, roomId) {
  return join(home, ROOMS_DIR, assertSafeRoomId(roomId))
}

export function roomDbPath(home, roomId) {
  return join(roomDir(home, roomId), 'memory.db')
}

export function roomBindingPath(home, roomId) {
  return join(roomDir(home, roomId), 'binding.json')
}

export function centralDbPath(home) {
  return join(home, CENTRAL_DIR, 'memory.db')
}

export function readRoomBinding(home, roomId) {
  try {
    const raw = readFileSync(roomBindingPath(home, roomId), 'utf8')
    const parsed = JSON.parse(raw)
    return parsed && typeof parsed === 'object' ? parsed : null
  } catch {
    return null
  }
}

export function writeRoomBinding(home, binding) {
  if (!binding?.roomId) throw new Error('room binding requires a roomId')
  const payload = {
    version: 1,
    roomId: binding.roomId,
    workspaceId: binding.workspaceId ?? null,
    workspacePath: binding.workspacePath ?? null,
    title: binding.title ?? '',
    mode: binding.mode ?? null,
    source: binding.source ?? null,
    updatedAt: new Date().toISOString(),
  }
  writeJsonAtomic(roomBindingPath(home, binding.roomId), payload)
  return payload
}

export function writeJsonAtomic(filePath, value) {
  mkdirSync(dirname(filePath), { recursive: true })
  const temp = `${filePath}.${process.pid}.${Date.now()}.tmp`
  writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
  renameSync(temp, filePath)
}

/**
 * True when `child` is `parent` or lives underneath it. Used only as a
 * secondary workspace match; exact canonical equality is always tried first.
 */
export function pathContains(parent, child) {
  const p = canonicalPath(parent)
  const c = canonicalPath(child)
  if (!p || !c) return false
  if (p === c) return true
  return c.startsWith(p.endsWith(sep) ? p : `${p}${sep}`)
}

export function pathExists(filePath) {
  try {
    return existsSync(filePath)
  } catch {
    return false
  }
}
