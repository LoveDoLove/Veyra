import fs from 'node:fs'
import path from 'node:path'

/**
 * Resolve evaluation artifact output destinations with write-safety policy.
 *
 * @param {object} opts
 * @param {string} opts.trackedPath - Default tracked artifact path (absolute or repo-relative).
 * @param {string} opts.runPath - Isolated run-directory artifact path (always safe to write).
 * @param {string[]} [opts.argv] - Process argv for --output <path>.
 * @param {NodeJS.ProcessEnv} [opts.env] - Environment.
 * @param {string} [opts.cwd] - CWD for resolving relative paths.
 * @param {(p:string)=>boolean} [opts.existsSync] - Injectable existence check (tests).
 * @returns {{ runPath:string, explicitPath:string|null, trackedPath:string, tracked:{action:'write'|'skip', reason:string}, destinations:{path:string, kind:string}[] }}
 */
export function resolveEvalOutput({
  trackedPath,
  runPath,
  argv = process.argv,
  env = process.env,
  cwd = process.cwd(),
  existsSync = fs.existsSync,
} = {}) {
  if (!trackedPath) throw new TypeError('trackedPath is required')
  if (!runPath) throw new TypeError('runPath is required')
  const resolve = (p) => path.resolve(cwd, p)

  const outIdx = argv.indexOf('--output')
  const explicitRaw = outIdx >= 0 ? argv[outIdx + 1] : (env.VEYRA_EVAL_OUTPUT || null)
  if (outIdx >= 0 && !explicitRaw) throw new TypeError('--output requires a path')
  const explicitPath = explicitRaw ? resolve(explicitRaw) : null
  const trackedAbs = resolve(trackedPath)
  const runAbs = resolve(runPath)

  const writeTrackedEnv = env.VEYRA_EVAL_WRITE_TRACKED
  const trackedExists = existsSync(trackedAbs)
  let tracked
  const destinations = []
  const runCollides = path.resolve(runAbs) === trackedAbs
  const explicitCollides = explicitPath ? path.resolve(explicitPath) === trackedAbs : false
  const runExplicitCollides = explicitPath ? path.resolve(runAbs) === path.resolve(explicitPath) : false

  if (explicitPath) {
    if (runCollides) throw new Error(`run artifact path resolves to protected tracked artifact (${trackedAbs}); choose an isolated runPath`)
    if (explicitCollides) throw new Error(`--output/VEYRA_EVAL_OUTPUT resolves to protected tracked artifact (${trackedAbs}); use VEYRA_EVAL_WRITE_TRACKED=1 to authorize tracked writes, or choose an isolated output path`)
    if (runExplicitCollides) throw new Error(`run artifact path and --output/VEYRA_EVAL_OUTPUT resolve to the same file (${runAbs}); choose distinct output paths`)
    destinations.push({ path: runAbs, kind: 'run' })
    destinations.push({ path: explicitPath, kind: 'explicit' })
    tracked = { action: 'skip', reason: 'explicit --output/VEYRA_EVAL_OUTPUT selected; tracked/default artifact not overwritten' }
  } else if (writeTrackedEnv === '0') {
    if (runCollides) throw new Error(`run artifact path resolves to protected tracked artifact (${trackedAbs}) while VEYRA_EVAL_WRITE_TRACKED=0; choose an isolated runPath`)
    destinations.push({ path: runAbs, kind: 'run' })
    tracked = { action: 'skip', reason: 'VEYRA_EVAL_WRITE_TRACKED=0' }
  } else if (writeTrackedEnv === '1' || writeTrackedEnv === 'true') {
    if (!runCollides) destinations.push({ path: runAbs, kind: 'run' })
    destinations.push({ path: trackedAbs, kind: 'tracked' })
    tracked = { action: 'write', reason: runCollides ? 'VEYRA_EVAL_WRITE_TRACKED=1 (runPath aliases tracked; tracked write authorized)' : 'VEYRA_EVAL_WRITE_TRACKED=1' }
  } else if (trackedExists) {
    if (runCollides) throw new Error(`run artifact path resolves to protected tracked artifact (${trackedAbs}); existing tracked artifact cannot be overwritten without VEYRA_EVAL_WRITE_TRACKED=1`)
    destinations.push({ path: runAbs, kind: 'run' })
    tracked = {
      action: 'skip',
      reason: 'tracked artifact exists; set VEYRA_EVAL_WRITE_TRACKED=1 to authorize overwrite, or pass --output <path>',
    }
  } else {
    if (!runCollides) destinations.push({ path: runAbs, kind: 'run' })
    destinations.push({ path: trackedAbs, kind: 'tracked' })
    tracked = { action: 'write', reason: runCollides ? 'tracked artifact missing and runPath aliases tracked; creating (no overwrite risk)' : 'tracked artifact missing; creating (no overwrite risk)' }
  }

  return { runPath: runAbs, explicitPath, trackedPath: trackedAbs, tracked, destinations }
}

/**
 * Write a JSON-serializable result to resolved destinations and report.
 * Always writes to runPath; writes explicit/tracked only when resolved.
 */
export function publishEvalResult(result, opts = {}) {
  const plan = resolveEvalOutput(opts)
  const json = JSON.stringify(result, null, 2) + '\n'
  const written = []
  for (const d of plan.destinations) {
    fs.mkdirSync(path.dirname(d.path), { recursive: true })
    fs.writeFileSync(d.path, json)
    written.push(d)
  }
  const logger = opts.logger || console.log
  logger('[eval-output] run artifact: ' + plan.runPath)
  if (plan.explicitPath) logger('[eval-output] explicit output: ' + plan.explicitPath)
  if (plan.tracked.action === 'write') {
    logger('[eval-output] tracked artifact written: ' + plan.trackedPath + ' (' + plan.tracked.reason + ')')
  } else {
    logger('[eval-output] tracked artifact skipped: ' + plan.trackedPath + ' (' + plan.tracked.reason + ')')
  }
  return { ...plan, written }
}
