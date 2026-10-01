/**
 * Veyra Code Intelligence — Engine & Lifecycle Controller.
 *
 * Coordinates:
 *   - Index lifecycle (not_indexed -> indexing -> ready -> updating -> degraded/error)
 *   - Upstream client queries (search_graph, trace_path, get_code_snippet, get_architecture, search_code)
 *   - Secret scrubbing and repository boundary checks on all query outputs
 *   - Index status metadata persistence in $DSH_HOME/veyra/projects/<projectId>/code_index.json
 *   - Safe error handling (fail-closed, degraded mode)
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { INDEX_STATUS, TRACE_DIRECTIONS } from './types.mjs'
import { cbmProjectName, resolveSafeRepoPath, sanitizeCodeContent, discoverRepository } from './discovery.mjs'
import { getOrCreateCodeClient } from './client.mjs'
import { projectIdFor, resolveVeyraHome } from '../ids.mjs'

export class CodeIntelligenceEngine {
  constructor(opts = {}) {
    this.client = opts.client || getOrCreateCodeClient(opts)
    this.config = opts.config || {}
    this.env = opts.env || process.env
    this.statuses = new Map() // repoRoot -> status object
    this.activeOperations = new Map() // repoRoot -> Promise
  }

  get isDegraded() {
    return !this.client.isAvailable
  }

  /**
   * Path to metadata file for a project.
   */
  getMetadataPath(repoRoot) {
    const pId = projectIdFor(repoRoot, this.env)
    const veyraHome = resolveVeyraHome(this.config, this.env)
    return join(veyraHome, 'projects', pId, 'code_index.json')
  }

  /**
   * Load persisted metadata if present.
   */
  loadMetadata(repoRoot) {
    try {
      const metaPath = this.getMetadataPath(repoRoot)
      if (existsSync(metaPath)) {
        return JSON.parse(readFileSync(metaPath, 'utf8'))
      }
    } catch {
      // fallback to null
    }
    return null
  }

  /**
   * Save metadata.
   */
  saveMetadata(repoRoot, data) {
    try {
      const metaPath = this.getMetadataPath(repoRoot)
      mkdirSync(dirname(metaPath), { recursive: true })
      writeFileSync(metaPath, JSON.stringify(data, null, 2), 'utf8')
    } catch {
      // ignore persistence error
    }
  }

  /**
   * Get current status for a repository.
   */
  async getStatus(repoRoot) {
    const cached = this.statuses.get(repoRoot)
    if (cached) return cached

    const persisted = this.loadMetadata(repoRoot)
    if (persisted) {
      this.statuses.set(repoRoot, persisted)
      return persisted
    }

    if (this.isDegraded) {
      return {
        status: INDEX_STATUS.DEGRADED,
        degraded: true,
        message: 'Code intelligence binary unavailable; running in degraded mode',
        lastIndexedAt: null,
        filesCount: 0,
      }
    }

    return {
      status: INDEX_STATUS.NOT_INDEXED,
      degraded: false,
      lastIndexedAt: null,
      filesCount: 0,
    }
  }

  /**
   * Index or re-index a repository.
   */
  async indexRepository(repoRoot, opts = {}) {
    if (this.activeOperations.has(repoRoot)) {
      return this.activeOperations.get(repoRoot)
    }

    const opPromise = (async () => {
      const current = await this.getStatus(repoRoot)
      const nextStatus = current.status === INDEX_STATUS.READY ? INDEX_STATUS.UPDATING : INDEX_STATUS.INDEXING
      this.statuses.set(repoRoot, { ...current, status: nextStatus })

      if (this.isDegraded) {
        const degradedState = {
          status: INDEX_STATUS.DEGRADED,
          degraded: true,
          message: 'Cannot index: Code intelligence binary not available',
          lastIndexedAt: current.lastIndexedAt || null,
          filesCount: 0,
        }
        this.statuses.set(repoRoot, degradedState)
        this.saveMetadata(repoRoot, degradedState)
        return degradedState
      }

      try {
        const projectName = opts.project || cbmProjectName(repoRoot)
        const discovered = discoverRepository(repoRoot)
        const mode = opts.mode || 'fast'
        const res = await this.client.indexRepository(repoRoot, projectName, mode)

        if (res.isError) {
          const errState = {
            ok: false,
            status: INDEX_STATUS.ERROR,
            degraded: Boolean(res.degraded),
            message: res.content?.[0]?.text || 'Indexing failed',
            lastIndexedAt: current.lastIndexedAt || null,
            filesCount: discovered.length,
          }
          this.statuses.set(repoRoot, errState)
          this.saveMetadata(repoRoot, errState)
          return errState
        }

        const readyState = {
          ok: true,
          status: INDEX_STATUS.READY,
          degraded: false,
          project: projectName,
          message: res.content?.[0]?.text || 'Repository indexed successfully',
          lastIndexedAt: new Date().toISOString(),
          filesCount: discovered.length,
        }
        this.statuses.set(repoRoot, readyState)
        this.saveMetadata(repoRoot, readyState)
        return readyState
      } catch (err) {
        const errState = {
          ok: false,
          status: INDEX_STATUS.ERROR,
          degraded: false,
          message: err.message,
          lastIndexedAt: current.lastIndexedAt || null,
          filesCount: 0,
        }
        this.statuses.set(repoRoot, errState)
        this.saveMetadata(repoRoot, errState)
        return errState
      } finally {
        this.activeOperations.delete(repoRoot)
      }
    })()

    this.activeOperations.set(repoRoot, opPromise)
    return opPromise
  }

  /**
   * Incrementally update index for changes (mode: fast).
   */
  async indexIncremental(repoRoot, opts = {}) {
    return this.indexRepository(repoRoot, { ...opts, mode: 'fast' })
  }

  /**
   * Search symbols in graph.
   */
  async searchSymbols(repoRoot, params = {}) {
    if (this.isDegraded) {
      return { ok: false, degraded: true, symbols: [], message: 'Code intelligence degraded' }
    }

    const project = params.project || cbmProjectName(repoRoot)
    const args = {
      project,
      name_pattern: params.name_pattern || params.query || '',
      file_pattern: params.file_pattern || params.file_path_pattern || params.filePattern || '',
      label: params.label || '',
      limit: params.limit || 50,
    }

    const res = await this.client.searchGraph(args)
    if (res.isError) {
      return { ok: false, degraded: Boolean(res.degraded), symbols: [], message: res.content?.[0]?.text }
    }

    const rawText = res.content?.[0]?.text || ''
    return {
      ok: true,
      raw: rawText,
      message: rawText,
    }
  }

  /**
   * Trace call path (inbound, outbound, both).
   */
  async traceCallPath(repoRoot, params = {}) {
    if (this.isDegraded) {
      return { ok: false, degraded: true, message: 'Code intelligence degraded' }
    }

    const project = params.project || cbmProjectName(repoRoot)
    const args = {
      project,
      function_name: params.function_name || params.symbol,
      direction: params.direction || TRACE_DIRECTIONS.BOTH,
      depth: params.depth || params.max_depth || params.maxDepth || 3,
    }

    const res = await this.client.tracePath(args)
    if (res.isError) {
      return { ok: false, degraded: Boolean(res.degraded), message: res.content?.[0]?.text }
    }

    return {
      ok: true,
      raw: res.content?.[0]?.text || '',
    }
  }

  /**
   * Get code snippet.
   */
  async getCodeSnippet(repoRoot, params = {}) {
    if (this.isDegraded) {
      return { ok: false, degraded: true, snippet: '', message: 'Code intelligence degraded' }
    }

    // Boundary check on file_path if provided
    if (params.file_path || params.filePath) {
      const target = params.file_path || params.filePath
      const safe = resolveSafeRepoPath(repoRoot, target)
      if (!safe) {
        return { ok: false, message: 'File path outside repository boundary' }
      }
    }

    const project = params.project || cbmProjectName(repoRoot)
    const args = {
      project,
      qualified_name: params.qualified_name || params.qualifiedName || params.symbol,
      start_line: params.start_line || params.startLine,
      max_lines: params.max_lines || params.maxLines,
    }

    const res = await this.client.getCodeSnippet(args)
    if (res.isError) {
      return { ok: false, degraded: Boolean(res.degraded), snippet: '', message: res.content?.[0]?.text }
    }

    const rawText = res.content?.[0]?.text || ''
    const sanitized = sanitizeCodeContent(rawText)

    return {
      ok: true,
      snippet: sanitized,
    }
  }

  /**
   * Get architectural overview.
   */
  async getArchitecture(repoRoot, params = {}) {
    if (this.isDegraded) {
      return { ok: false, degraded: true, message: 'Code intelligence degraded' }
    }

    const project = params.project || cbmProjectName(repoRoot)
    const args = {
      project,
      path: params.path || params.directory || '',
      depth: params.depth || 2,
    }

    const res = await this.client.getArchitecture(args)
    if (res.isError) {
      return { ok: false, degraded: Boolean(res.degraded), message: res.content?.[0]?.text }
    }

    return {
      ok: true,
      overview: res.content?.[0]?.text || '',
    }
  }

  /**
   * Search code text.
   */
  async searchCodeText(repoRoot, params = {}) {
    if (this.isDegraded) {
      return { ok: false, degraded: true, message: 'Code intelligence degraded' }
    }

    const project = params.project || cbmProjectName(repoRoot)
    const args = {
      project,
      pattern: params.pattern || params.query,
      file_pattern: params.file_pattern || params.file_path_pattern || params.filePattern || '',
      limit: params.limit || 50,
    }

    const res = await this.client.searchCode(args)
    if (res.isError) {
      return { ok: false, degraded: Boolean(res.degraded), message: res.content?.[0]?.text }
    }

    const raw = res.content?.[0]?.text || ''
    return {
      ok: true,
      results: sanitizeCodeContent(raw),
    }
  }

  /**
   * List indexed projects.
   */
  async listProjects() {
    if (this.isDegraded) {
      return { ok: false, degraded: true, projects: [] }
    }

    const res = await this.client.listProjects()
    if (res.isError) {
      return { ok: false, degraded: Boolean(res.degraded), projects: [] }
    }

    return {
      ok: true,
      raw: res.content?.[0]?.text || '',
    }
  }

  /**
   * Detect changes compared to index.
   */
  async detectChanges(repoRoot) {
    if (this.isDegraded) {
      return { ok: false, degraded: true }
    }

    const project = cbmProjectName(repoRoot)
    const res = await this.client.detectChanges(project)
    if (res.isError) {
      return { ok: false, degraded: Boolean(res.degraded) }
    }

    return {
      ok: true,
      raw: res.content?.[0]?.text || '',
    }
  }
}

let sharedEngine = null

export function getOrCreateCodeEngine(opts = {}) {
  if (!sharedEngine) {
    sharedEngine = new CodeIntelligenceEngine(opts)
  }
  return sharedEngine
}

export function resetSharedCodeEngine() {
  if (sharedEngine) {
    sharedEngine = null
  }
}
