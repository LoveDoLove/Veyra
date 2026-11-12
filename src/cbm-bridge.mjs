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

// The package name is exported rather than re-spelled at call sites: this file
// is the only one allowed to name the specifier (a test enforces it), so a
// caller that must mention the package to the operator imports it from here.
export const CBM_PACKAGE_NAME = SPECIFIER

const DEGRADED_MESSAGE = 'Code intelligence degraded'

// Synthetic code for a load failure that carried none of its own. It must never
// equal a module-resolution code: those are the ones the caller treats as
// "not installed", and a broken install has to be told apart from that.
const LOAD_FAILED_CODE = 'CBM_LOAD_FAILED'

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

/**
 * Why the last load attempt failed, or `null` when it returned a namespace.
 *
 * Only the main `require` counts: a package published without `./discovery`
 * still yields a usable bridge, so its failure must never be reported as a
 * broken install. This exists because the degrade path is silent by design —
 * without it a corrupt install is indistinguishable from an absent one, and
 * §13 asks for one operator-visible warning in the corrupt case.
 *
 * A live binding, so a caller that reloads the bridge (tests; never production)
 * observes the failure of that attempt.
 */
export let cbmLoadFailure = null

const recordFailure = (err, message) => {
  // A thrown `Error` usually carries no `code`, and a load failure with no code
  // at all would be indistinguishable from "nothing was recorded". The synthetic
  // code keeps `code` a string for every failure; a real code from the runtime
  // (a module-resolution error) is preferred because it is what an operator
  // greps for.
  const code = err && typeof err === 'object' && typeof err.code === 'string'
    ? err.code
    : LOAD_FAILED_CODE
  cbmLoadFailure = {
    code,
    message: err instanceof Error ? err.message : String(err ?? message),
  }
}

export function loadCbmBridge({ requireFrom = import.meta.url } = {}) {
  // Each entry gets its own try/catch: a package published without
  // `./discovery` must still yield the main entry rather than collapse the
  // whole bridge into the stub.
  let api
  try {
    api = createRequire(requireFrom)(SPECIFIER)
  } catch (err) {
    recordFailure(err)
    return unavailable()
  }
  let discovery
  try {
    discovery = createRequire(requireFrom)(DISCOVERY_SPECIFIER)
  } catch {
    discovery = {}
  }
  if (!api || typeof api !== 'object') {
    recordFailure(null, 'the main entry did not export an object')
    return unavailable()
  }
  if (!discovery || typeof discovery !== 'object') discovery = {}
  // The spread reads every enumerable property, so a throwing getter on either
  // export object would escape here — and `cbm` is built at module evaluation,
  // where that throw becomes a failed `import` that kills plugin load. Failing
  // to an object is a degraded engine; failing to import is no plugin at all.
  try {
    const loaded = Object.freeze({ ...api, ...discovery, available: true })
    cbmLoadFailure = null
    return loaded
  } catch (err) {
    recordFailure(err)
    return unavailable()
  }
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
  // Frozen for the same reason `unavailable()` is: `isDegraded` is a plain
  // property, so a mutable engine would let any caller flip it to `false` and
  // make src/plugin.mjs advertise a tool surface nothing registered.
  return Object.freeze({
    isDegraded: true,
    client: { isAvailable: false },
    indexRepository: async () => ({ ok: false, degraded: true, message: DEGRADED_MESSAGE }),
    searchSymbols: async () => ({ ok: false, degraded: true, symbols: [], message: DEGRADED_MESSAGE }),
    searchCodeText: async () => ({ ok: false, degraded: true, message: DEGRADED_MESSAGE }),
    traceCallPath: async () => ({ ok: false, degraded: true, message: DEGRADED_MESSAGE }),
    getStatus: async () => ({ status: 'degraded', degraded: true, message: DEGRADED_MESSAGE }),
    dispose: () => {},
  })
}

/**
 * Whether the namespace can resolve a repository path at all.
 *
 * One definition, because every caller that asks "is Code Intelligence usable"
 * must get the same answer: `available` alone records that the package loaded,
 * which is not the same thing as exposing the boundary authority callers need.
 * `resolveSafeRepoPath` is the one member that decides it.
 */
export function isCodeIntelligenceAvailable(ns = cbm) {
  return Boolean(ns && ns.available && typeof ns.resolveSafeRepoPath === 'function')
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
  if (!isCodeIntelligenceAvailable(ns)) return null
  try { return ns.resolveSafeRepoPath(repoRoot, targetPath) } catch { return null }
}
