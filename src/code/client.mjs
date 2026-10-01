/**
 * Veyra Code Intelligence — Upstream MCP IPC Client & Degraded Adapter.
 *
 * Communicates with the native codebase-memory-mcp executable via stdio JSON-RPC 2.0.
 * Implements:
 *   - Executable discovery (PATH, ~/.local/bin, env vars, WSL)
 *   - Child process lifecycle and MCP initialization handshake
 *   - Line-delimited JSON-RPC framing with timeouts
 *   - Automatic restart on unexpected process termination
 *   - Degraded mode fallback when binary is missing or fails (Memory stays active)
 *   - Safe disposal and process shutdown
 */

import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { delimiter, join } from 'node:path'
import { DEFAULT_UI_PORT } from './types.mjs'

/**
 * Locate the codebase-memory-mcp executable.
 */
export function findCodebaseMemoryExe(env = process.env) {
  if (env.CBM_EXE && existsSync(env.CBM_EXE)) {
    return env.CBM_EXE
  }
  if (env.CODEBASE_MEMORY_EXE && existsSync(env.CODEBASE_MEMORY_EXE)) {
    return env.CODEBASE_MEMORY_EXE
  }

  const isWin = process.platform === 'win32'
  const exeName = isWin ? 'codebase-memory-mcp.exe' : 'codebase-memory-mcp'
  const home = homedir()

  const candidates = isWin
    ? [
        join(home, 'AppData', 'Local', 'Programs', 'codebase-memory-mcp', exeName),
        join(process.cwd(), exeName),
      ]
    : [
        join(home, '.local', 'bin', exeName),
        join('/usr/local/bin', exeName),
        join('/usr/bin', exeName),
        join(process.cwd(), exeName),
      ]

  for (const c of candidates) {
    if (existsSync(c)) return c
  }

  // Search PATH
  const pathEnv = (env.PATH || '').split(delimiter)
  for (const dir of pathEnv) {
    if (!dir) continue
    const target = join(dir, exeName)
    if (existsSync(target)) return target
  }

  // Cross-WSL check: if running inside Linux/WSL, check if Windows executable is reachable
  if (!isWin && existsSync('/proc/sys/fs/binfmt_misc/WSLInterop')) {
    const winExeName = 'codebase-memory-mcp.exe'
    for (const dir of pathEnv) {
      if (!dir) continue
      const target = join(dir, winExeName)
      if (existsSync(target)) return target
    }
  }

  return null
}

export class CodebaseMemoryClient {
  constructor(opts = {}) {
    this.exePath = opts.exePath || findCodebaseMemoryExe(opts.env)
    this.uiEnabled = opts.uiEnabled ?? true
    this.port = opts.port || DEFAULT_UI_PORT
    this.logger = opts.logger || console
    this.child = null
    this.nextId = 1
    this.pending = new Map()
    this.buffer = ''
    this.startPromise = null
    this.serverInfo = null
    this.isDisposed = false
  }

  get isAvailable() {
    return Boolean(this.exePath && existsSync(this.exePath))
  }

  async ensureStarted() {
    if (this.isDisposed) {
      throw new Error('CodebaseMemoryClient is disposed')
    }
    if (!this.isAvailable) {
      throw new Error('codebase-memory-mcp executable not found')
    }
    if (this.child && !this.child.killed && this.child.exitCode === null) return
    if (this.startPromise) return this.startPromise

    this.startPromise = (async () => {
      const args = []
      if (this.uiEnabled) {
        args.push('--ui=true', `--port=${this.port}`)
      } else {
        args.push('--ui=false')
      }

      this.child = spawn(this.exePath, args, {
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
      })

      this.child.stdout.on('data', (chunk) => {
        this.buffer += chunk.toString('utf8')
        this.flushBuffer()
      })

      this.child.stderr.on('data', (chunk) => {
        const text = chunk.toString('utf8').trim()
        if (text && !text.includes('warning:')) {
          this.logger.debug?.(`[cbm-stderr] ${text}`)
        }
      })

      this.child.on('error', (err) => {
        this.logger.warn?.(`[cbm-proc] error: ${err.message}`)
        this.rejectAllPending(err)
      })

      this.child.on('close', (code) => {
        this.rejectAllPending(new Error(`codebase-memory-mcp process closed (code: ${code})`))
        this.child = null
        this.startPromise = null
      })

      // MCP initialize handshake
      const initId = this.nextId++
      const initPromise = new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          this.pending.delete(initId)
          reject(new Error('codebase-memory-mcp initialize timeout (30s)'))
        }, 30_000)
        this.pending.set(initId, { resolve, reject, timer })
      })

      this.child.stdin.write(
        JSON.stringify({
          jsonrpc: '2.0',
          id: initId,
          method: 'initialize',
          params: {
            protocolVersion: '2025-03-26',
            capabilities: {},
            clientInfo: { name: 'veyra-code-intelligence', version: '0.1.0' },
          },
        }) + '\n'
      )

      const initResult = await initPromise
      if (initResult?.serverInfo) {
        this.serverInfo = initResult.serverInfo
      }

      // Complete initialization notification
      this.child.stdin.write(
        JSON.stringify({
          jsonrpc: '2.0',
          method: 'notifications/initialized',
          params: {},
        }) + '\n'
      )

      this.startPromise = null
    })().catch((err) => {
      this.startPromise = null
      this.stop()
      throw err
    })

    return this.startPromise
  }

  flushBuffer() {
    let newlineIdx
    while ((newlineIdx = this.buffer.indexOf('\n')) !== -1) {
      const line = this.buffer.slice(0, newlineIdx).trim()
      this.buffer = this.buffer.slice(newlineIdx + 1)
      if (!line) continue

      try {
        const msg = JSON.parse(line)
        if (msg.id != null && this.pending.has(msg.id)) {
          const { resolve, reject, timer } = this.pending.get(msg.id)
          clearTimeout(timer)
          this.pending.delete(msg.id)

          if (msg.error) {
            reject(new Error(msg.error.message || `JSON-RPC error ${msg.error.code}`))
          } else {
            resolve(msg.result)
          }
        }
      } catch {
        // Discard malformed JSON lines
      }
    }
  }

  rejectAllPending(err) {
    for (const [id, { reject, timer }] of this.pending.entries()) {
      clearTimeout(timer)
      reject(err)
    }
    this.pending.clear()
  }

  async rpc(method, params = {}, timeoutMs = 60_000) {
    await this.ensureStarted()
    const id = this.nextId++

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`codebase-memory-mcp rpc timeout: ${method}`))
      }, timeoutMs)

      this.pending.set(id, { resolve, reject, timer })

      try {
        this.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n')
      } catch (err) {
        clearTimeout(timer)
        this.pending.delete(id)
        reject(err)
      }
    })
  }

  async callTool(toolName, args = {}) {
    if (!this.isAvailable) {
      return {
        isError: true,
        degraded: true,
        content: [{ type: 'text', text: `Code Intelligence unavailable: codebase-memory-mcp binary not found. Install via 'curl -fsSL https://raw.githubusercontent.com/DeusData/codebase-memory-mcp/main/install.sh | bash' or set CBM_EXE. Veyra Memory remains fully functional.` }],
      }
    }

    try {
      const result = await this.rpc('tools/call', {
        name: toolName,
        arguments: args,
      })
      return result
    } catch (err) {
      this.logger.warn?.(`[cbm-client] tool ${toolName} failed: ${err.message}`)
      return {
        isError: true,
        degraded: true,
        content: [{ type: 'text', text: `Code Intelligence degraded: ${err.message}` }],
      }
    }
  }

  async indexRepository(repoPath, project, mode = 'fast') {
    const args = { repo_path: repoPath, mode }
    if (project) args.name = project
    return this.callTool('index_repository', args)
  }

  async searchGraph(args = {}) {
    return this.callTool('search_graph', args)
  }

  async tracePath(args = {}) {
    const payload = {
      project: args.project,
      function_name: args.function_name || args.symbol || '',
      direction: args.direction || 'both',
      depth: args.depth || args.max_depth || args.maxDepth || 3,
    }
    return this.callTool('trace_path', payload)
  }

  async getCodeSnippet(args = {}) {
    const payload = {
      project: args.project,
      qualified_name: args.qualified_name || args.qualifiedName || args.symbol || '',
    }
    if (args.start_line || args.startLine) payload.start_line = args.start_line || args.startLine
    if (args.max_lines || args.maxLines) payload.max_lines = args.max_lines || args.maxLines
    return this.callTool('get_code_snippet', payload)
  }

  async getArchitecture(args = {}) {
    const payload = {
      project: args.project,
      path: args.path || args.directory || '',
    }
    if (args.aspects) payload.aspects = args.aspects
    return this.callTool('get_architecture', payload)
  }

  async searchCode(args = {}) {
    const payload = {
      project: args.project,
      pattern: args.pattern || args.query || '',
    }
    if (args.file_pattern || args.filePattern) payload.file_pattern = args.file_pattern || args.filePattern
    if (args.limit) payload.limit = args.limit
    return this.callTool('search_code', payload)
  }

  async listProjects() {
    return this.callTool('list_projects', {})
  }

  async indexStatus(project) {
    return this.callTool('index_status', { project })
  }

  async detectChanges(project) {
    return this.callTool('detect_changes', { project })
  }

  async checkIndexCoverage(project) {
    return this.callTool('check_index_coverage', { project })
  }

  stop() {
    this.isDisposed = true
    if (this.child) {
      try {
        this.child.kill('SIGTERM')
      } catch {
        // ignore
      }
      this.child = null
    }
    this.rejectAllPending(new Error('CodebaseMemoryClient stopped'))
  }
}

let sharedClient = null

export function getOrCreateCodeClient(opts = {}) {
  if (!sharedClient || sharedClient.isDisposed) {
    sharedClient = new CodebaseMemoryClient(opts)
  }
  return sharedClient
}

export function resetSharedCodeClient() {
  if (sharedClient) {
    sharedClient.stop()
    sharedClient = null
  }
}
