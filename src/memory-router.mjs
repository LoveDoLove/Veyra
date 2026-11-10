/**
 * Veyra — memory routing and authorization.
 *
 * The router is the single place that decides which storage targets an
 * operation may touch. It sits below prompt text and below model-tool
 * handlers, so a tool cannot widen its own access by passing a `cwd`,
 * `projectId`, `workspaceId`, or room path.
 *
 * Invariants enforced here:
 *   - an operation always needs a resolved workspace binding;
 *   - a request may never name a room or workspace other than the resolved
 *     one (no cross-workspace reads or writes, ever);
 *   - automatic learning writes only the resolved workspace room;
 *   - Central Memories is written only by the promotion workflow;
 *   - unknown operations and unknown targets fail closed.
 */

export const MEMORY_OPERATIONS = Object.freeze({
  RECALL_AUTO: 'recall.auto',
  RECALL_MANUAL: 'recall.manual',
  SEARCH: 'search',
  INSPECT: 'inspect',
  LEARN_AUTO: 'learn.auto',
  WRITE_MANUAL: 'write.manual',
  UPDATE: 'update',
  FORGET: 'forget',
  PROMOTE: 'promote',
  HEALTH: 'health',
})

export const MEMORY_TARGETS = Object.freeze({
  WORKSPACE: 'workspace',
  CENTRAL: 'central',
})

export const ROUTER_DENIALS = Object.freeze({
  MISSING_BINDING: 'missing-workspace-binding',
  CROSS_WORKSPACE: 'cross-workspace-denied',
  UNKNOWN_OPERATION: 'unknown-operation',
  UNKNOWN_TARGET: 'unknown-target',
  WORKSPACE_WRITE_DENIED: 'workspace-write-denied',
  CENTRAL_WRITE_DENIED: 'central-write-denied',
  CENTRAL_READ_DENIED: 'central-read-denied',
})

// access: 'read' | 'write' | 'none'. Central writes are restricted to the
// promotion workflow: `WRITE_MANUAL` may carry a central target, but the only
// code that actually writes Central Memories is `promoteRecord()`, which runs
// the admission checks. Automatic learning is workspace-only by construction,
// so nothing ambient can leak a workspace record into the shared space.
const RULES = Object.freeze({
  [MEMORY_OPERATIONS.RECALL_AUTO]: { workspace: 'read', central: 'read' },
  [MEMORY_OPERATIONS.RECALL_MANUAL]: { workspace: 'read', central: 'read' },
  [MEMORY_OPERATIONS.SEARCH]: { workspace: 'read', central: 'read' },
  [MEMORY_OPERATIONS.INSPECT]: { workspace: 'read', central: 'read' },
  [MEMORY_OPERATIONS.LEARN_AUTO]: { workspace: 'write', central: 'none' },
  [MEMORY_OPERATIONS.WRITE_MANUAL]: { workspace: 'write', central: 'write' },
  [MEMORY_OPERATIONS.UPDATE]: { workspace: 'write', central: 'none' },
  [MEMORY_OPERATIONS.FORGET]: { workspace: 'write', central: 'none' },
  [MEMORY_OPERATIONS.PROMOTE]: { workspace: 'read', central: 'write' },
  [MEMORY_OPERATIONS.HEALTH]: { workspace: 'read', central: 'read' },
})

function deny(reason, detail = {}) {
  return { ok: false, reason, ...detail }
}

function workspaceTarget(binding, access) {
  return {
    kind: MEMORY_TARGETS.WORKSPACE,
    access,
    roomId: binding.roomId,
    workspaceId: binding.workspaceId ?? null,
    mode: binding.mode ?? null,
  }
}

function centralTarget(access) {
  return { kind: MEMORY_TARGETS.CENTRAL, access }
}

export function ruleFor(operation) {
  return RULES[operation] || null
}

export function createMemoryRouter() {
  /**
   * @param {string} operation one of MEMORY_OPERATIONS
   * @param {object} binding a resolver binding
   * @param {{roomId?: string, workspaceId?: string, target?: 'workspace'|'central'}} [request]
   */
  function decide(operation, binding, request = {}) {
    if (!binding || typeof binding !== 'object' || !binding.roomId) {
      return deny(ROUTER_DENIALS.MISSING_BINDING)
    }
    const rule = ruleFor(operation)
    if (!rule) return deny(ROUTER_DENIALS.UNKNOWN_OPERATION, { operation })

    // A caller may repeat the resolved identity, but may never replace it.
    if (request.roomId && request.roomId !== binding.roomId) {
      return deny(ROUTER_DENIALS.CROSS_WORKSPACE, {
        requestedRoomId: request.roomId,
        resolvedRoomId: binding.roomId,
      })
    }
    if (request.workspaceId && binding.workspaceId && request.workspaceId !== binding.workspaceId) {
      return deny(ROUTER_DENIALS.CROSS_WORKSPACE, {
        requestedWorkspaceId: request.workspaceId,
        resolvedWorkspaceId: binding.workspaceId,
      })
    }

    const targets = []
    if (request.target === MEMORY_TARGETS.WORKSPACE || request.target === undefined) {
      if (rule.workspace === 'none') return deny(ROUTER_DENIALS.WORKSPACE_WRITE_DENIED, { operation })
      targets.push(workspaceTarget(binding, rule.workspace))
    }
    if (request.target === MEMORY_TARGETS.CENTRAL || request.target === undefined) {
      if (rule.central === 'none') {
        if (request.target === MEMORY_TARGETS.CENTRAL) {
          return deny(ROUTER_DENIALS.CENTRAL_WRITE_DENIED, { operation })
        }
      } else if (rule.central === 'read' && request.access === 'write') {
        return deny(ROUTER_DENIALS.CENTRAL_WRITE_DENIED, { operation })
      } else {
        targets.push(centralTarget(rule.central))
      }
    }
    if (request.target && request.target !== MEMORY_TARGETS.WORKSPACE && request.target !== MEMORY_TARGETS.CENTRAL) {
      return deny(ROUTER_DENIALS.UNKNOWN_TARGET, { target: request.target })
    }

    return { ok: true, operation, binding, targets }
  }

  /**
   * Convenience predicate used by store selection: may this operation write
   * the resolved workspace room?
   */
  function canWriteWorkspace(operation, binding) {
    const decision = decide(operation, binding)
    if (!decision.ok) return false
    return decision.targets.some((target) => target.kind === MEMORY_TARGETS.WORKSPACE && target.access === 'write')
  }

  function canReadCentral(operation, binding) {
    const decision = decide(operation, binding)
    if (!decision.ok) return false
    return decision.targets.some((target) => target.kind === MEMORY_TARGETS.CENTRAL && target.access === 'read')
  }

  return { decide, canWriteWorkspace, canReadCentral }
}

/**
 * Every binding a caller can obtain has already been resolved from the
 * registry, so Central Memories is always structurally available to it. The
 * question this answers is no longer "which storage model" (there is one) but
 * "did I get a real binding" — a refusal carries no room and therefore no
 * route to Central either.
 */
export function centralAvailable(binding) {
  return Boolean(binding && binding.roomId)
}
