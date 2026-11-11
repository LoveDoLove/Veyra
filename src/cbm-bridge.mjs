/**
 * The only module that names the Codebase Memory package.
 *
 * Code Intelligence is an optional Codebase Memory plugin, not Veyra code. This
 * bridge loads it synchronously (createRequire resolves the ESM package without
 * a top-level await, so plugin `apply` stays synchronous) and degrades to a
 * frozen stub when it is absent. It copies no bridge internals: it re-exports
 * what the package exports and nothing more.
 *
 * The package specifiers appear exactly once, here. Later tasks point every
 * `src/` importer — including the former `/discovery` import — at this module,
 * so the dependency graph has a single seam to degrade at.
 *
 * Loaded once, at module evaluation. No retry, no timer, no watcher.
 */
import { createRequire } from 'node:module'
import { CODE_FRESHNESS } from './types.mjs'

const SPECIFIER = '@lovedolove/dsh-codebase-memory-mcp'
const DISCOVERY_SPECIFIER = '@lovedolove/dsh-codebase-memory-mcp/discovery'

const DEGRADED_MESSAGE = 'Code intelligence degraded'

/**
 * The absent-package contract. `FRESHNESS_STATUS` still points at Veyra's own
 * `CODE_FRESHNESS`: freshness is a wire contract Veyra owns, so a host without
 * the package keeps producing and reading the same three literals.
 */
const unavailable = () => Object.freeze({
  available: false,
  CodeIntelligenceEngine: null,
  RepositoryWatcher: null,
  FRESHNESS_STATUS: CODE_FRESHNESS,
  resolveSafeRepoPath: null,
  sanitizeCodeContent: null,
  closeAllWatchers: () => {},
  autoStartCodebaseMemory: null,
  findExe: null,
  getOrCreateClient: null,
  createClient: null,
  cbmApply: null,
})

export function loadCbmBridge({ requireFrom = import.meta.url } = {}) {
  // Each entry gets its own try/catch: a package published without
  // `./discovery` must still yield the main entry rather than collapse the
  // whole bridge into the stub.
  let api
  try {
    api = createRequire(requireFrom)(SPECIFIER)
  } catch {
    return unavailable()
  }
  let discovery
  try {
    discovery = createRequire(requireFrom)(DISCOVERY_SPECIFIER)
  } catch {
    discovery = {}
  }
  if (!api || typeof api !== 'object') return unavailable()
  if (!discovery || typeof discovery !== 'object') discovery = {}
  return Object.freeze({ ...api, ...discovery, available: true })
}

/** Frozen at module evaluation; never reloaded, never retried. */
export const cbm = loadCbmBridge()

/**
 * Null-object satisfying exactly the members `src/` reads from `codeEngine`
 * (6 methods + `isDegraded` + `client`).
 *
 * `isDegraded` is a plain boolean property, not a method, because that is what
 * the real engine is: an accessor on `CodeIntelligenceEngine.prototype`, which
 * every consumer reads as `engine.isDegraded`.
 *
 * Being safe is the requirement; being useful is not — every consumer already
 * branches on `isDegraded` before calling the async members.
 */
export function createDegradedEngine() {
  return {
    isDegraded: true,
    client: { isAvailable: false },
    indexRepository: async () => ({ ok: false, degraded: true, message: DEGRADED_MESSAGE }),
    searchSymbols: async () => ({ ok: false, degraded: true, symbols: [], message: DEGRADED_MESSAGE }),
    searchCodeText: async () => ({ ok: false, degraded: true, message: DEGRADED_MESSAGE }),
    traceCallPath: async () => ({ ok: false, degraded: true, message: DEGRADED_MESSAGE }),
    getStatus: async () => ({ status: 'degraded', degraded: true, message: DEGRADED_MESSAGE }),
    dispose: () => {},
  }
}

/**
 * Repo-relative resolution, or `null` when the bridge supplies no path-boundary
 * authority.
 *
 * Fail closed: without the bridge there is no boundary authority, so nothing
 * resolves. Callers already treat null as "no verifiable anchor" — they skip
 * the anchor and keep the path in provenance — so an absent bridge costs a
 * code anchor, never a record and never a false claim.
 *
 * `ns` exists only so the absent case is testable without module mocking;
 * production callers omit it.
 */
export function resolveRepoPath(repoRoot, targetPath, ns = cbm) {
  if (!ns.available || typeof ns.resolveSafeRepoPath !== 'function') return null
  try { return ns.resolveSafeRepoPath(repoRoot, targetPath) } catch { return null }
}
