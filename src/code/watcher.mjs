/**
 * Veyra Code Intelligence — Repository Watcher & Incremental Ingestion.
 *
 * Implements Stage 4:
 *   - File system watching with recursive fs.watch
 *   - Exclusion filtering (.git, node_modules, dist, secrets, etc.)
 *   - Burst debouncing & change coalescing
 *   - Incremental change categorization (added, modified, deleted)
 *   - Non-blocking execution
 *   - Safe error handling & graceful cleanup
 */

import { watch, existsSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { EventEmitter } from 'node:events'
import { resolveSafeRepoPath, isSensitiveOrSecret, DEFAULT_EXCLUDED_DIRS, BINARY_EXTENSIONS } from './discovery.mjs'

const activeWatchers = new Set()

export function closeAllWatchers() {
  for (const w of activeWatchers) {
    try {
      w.stop()
    } catch {
      // ignore
    }
  }
  activeWatchers.clear()
}

export class RepositoryWatcher extends EventEmitter {
  constructor(repoRoot, opts = {}) {
    super()
    this.repoRoot = repoRoot
    this.debounceMs = opts.debounceMs || 500
    this.engine = opts.engine || null
    this.logger = opts.logger || console
    this.fsWatcher = null
    this.debounceTimer = null
    this.pendingEvents = new Map() // relPath -> eventType
    this.isWatching = false
    this.isProcessing = false
  }

  start() {
    if (this.isWatching) return
    try {
      this.fsWatcher = watch(this.repoRoot, { recursive: true }, (eventType, filename) => {
        if (!filename) return
        this.handleRawFsEvent(eventType, filename)
      })
      if (typeof this.fsWatcher.unref === 'function') {
        this.fsWatcher.unref()
      }

      this.fsWatcher.on('error', (err) => {
        this.logger.warn?.(`[cbm-watcher] fs.watch error on ${this.repoRoot}: ${err.message}`)
        this.emit('error', err)
      })

      this.isWatching = true
      activeWatchers.add(this)
      this.emit('started', { repoRoot: this.repoRoot })
    } catch (err) {
      this.logger.warn?.(`[cbm-watcher] Failed to start watcher on ${this.repoRoot}: ${err.message}`)
      this.isWatching = false
      this.emit('error', err)
    }
  }

  handleRawFsEvent(eventType, filename) {
    // Standardize path separator
    const rawPath = String(filename).replace(/\\/g, '/')

    // Quick exclusion check on top-level segments
    const firstSegment = rawPath.split('/')[0]
    if (DEFAULT_EXCLUDED_DIRS.has(firstSegment)) return

    // Safe path resolution within repo
    const safeRel = resolveSafeRepoPath(this.repoRoot, rawPath)
    if (!safeRel) return

    // Check sensitive or binary exclusions
    if (isSensitiveOrSecret(safeRel)) return
    const dotIdx = safeRel.lastIndexOf('.')
    if (dotIdx !== -1) {
      const ext = safeRel.slice(dotIdx).toLowerCase()
      if (BINARY_EXTENSIONS.has(ext)) return
    }

    this.pendingEvents.set(safeRel, eventType)

    // Reset debounce timer
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer)
    }

    this.debounceTimer = setTimeout(() => {
      this.flushPending()
    }, this.debounceMs)
    if (typeof this.debounceTimer.unref === 'function') {
      this.debounceTimer.unref()
    }
  }

  async flushPending() {
    if (this.pendingEvents.size === 0 || this.isProcessing) return
    this.isProcessing = true

    const eventsToProcess = new Map(this.pendingEvents)
    this.pendingEvents.clear()

    const added = []
    const modified = []
    const deleted = []

    for (const [relPath] of eventsToProcess.entries()) {
      const absPath = join(this.repoRoot, relPath)
      try {
        if (!existsSync(absPath)) {
          deleted.push(relPath)
        } else {
          const st = statSync(absPath)
          if (st.isDirectory()) continue
          // If recently created or modified
          modified.push(relPath)
        }
      } catch {
        // File may have been removed concurrently
        deleted.push(relPath)
      }
    }

    const changeset = {
      added,
      modified,
      deleted,
      timestamp: Date.now(),
      repoRoot: this.repoRoot,
    }

    if (added.length > 0 || modified.length > 0 || deleted.length > 0) {
      this.emit('change', changeset)

      if (this.engine && !this.engine.isDegraded) {
        try {
          await this.engine.indexRepository(this.repoRoot, { mode: 'fast' })
        } catch (err) {
          this.logger.warn?.(`[cbm-watcher] Auto-reindex failed: ${err.message}`)
        }
      }
    }

    this.isProcessing = false
  }

  close() {
    this.stop()
  }

  stop() {
    activeWatchers.delete(this)
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer)
      this.debounceTimer = null
    }

    if (this.fsWatcher) {
      try {
        this.fsWatcher.close()
      } catch {
        // ignore
      }
      this.fsWatcher = null
    }

    this.isWatching = false
    this.pendingEvents.clear()
    this.emit('stopped', { repoRoot: this.repoRoot })
  }
}
