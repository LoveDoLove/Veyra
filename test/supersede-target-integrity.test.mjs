import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openProjectStore, openReusableStore, closeAllStores } from '../src/store.mjs'
import { supersede, forget, invalidate } from '../src/lifecycle.mjs'
import { AUTHORITIES, CONFIDENCES, KINDS, RELATIONS, STATUSES, VALIDATIONS } from '../src/types.mjs'

const base = {
  kind: KINDS.MEMORY,
  authority: AUTHORITIES.DERIVED,
  validation: VALIDATIONS.UNVERIFIED,
  confidence: CONFIDENCES.MEDIUM,
  status: STATUSES.CURRENT,
}

function put(store, over = {}) {
  return store.put({ ...base, title: over.title || 't', body: over.body || 'b', ...over }).record
}

function assertUnchanged(store, id, before, res, errMatch) {
  assert.equal(res.ok, false)
  if (errMatch) assert.match(String(res.error), errMatch)
  const after = store.get(id)
  assert.deepEqual(after, before, 'invalid replacement must not partially mutate retired record')
}

test('Task 19 supersede target integrity: rejects unusable replacement targets without mutating retired record', () => {
  const home = mkdtempSync(join(tmpdir(), 'veyra-t19-target-'))
  const store = openProjectStore(home, 'veyra_1a1b546b0bb')
  const reusable = openReusableStore(home)
  try {
    // Current valid replacement remains accepted.
    let from = put(store, { title: 'from-valid' })
    let to = put(store, { title: 'to-valid' })
    let res = supersede(store, from.id, to.id, { why: 'ok' })
    assert.equal(res.ok, true)
    assert.equal(store.get(from.id).status, STATUSES.SUPERSEDED)
    assert.deepEqual(
      (store.get(from.id).relations || []).filter(r => r.type === RELATIONS.SUPERSEDES).map(r => r.targetId),
      [to.id],
    )

    // Forgotten replacement.
    from = put(store, { title: 'from-forgotten' })
    to = put(store, { title: 'to-forgotten' })
    forget(store, to.id, { why: 'gone' })
    let before = store.get(from.id)
    res = supersede(store, from.id, to.id, {})
    assertUnchanged(store, from.id, before, res, /forgotten/)

    // Invalid replacement.
    from = put(store, { title: 'from-invalid' })
    to = put(store, { title: 'to-invalid' })
    invalidate(store, to.id, { why: 'bad' })
    before = store.get(from.id)
    res = supersede(store, from.id, to.id, {})
    assertUnchanged(store, from.id, before, res, /invalid/)

    // Already-superseded replacement.
    from = put(store, { title: 'from-superseded-target' })
    to = put(store, { title: 'to-superseded-target' })
    const finalTarget = put(store, { title: 'final' })
    supersede(store, to.id, finalTarget.id, { why: 'target retired' })
    before = store.get(from.id)
    res = supersede(store, from.id, to.id, {})
    assertUnchanged(store, from.id, before, res, /current/)

    // Stale replacement (validation stale; do not treat as current truth replacement).
    from = put(store, { title: 'from-stale' })
    to = store.put({ ...base, title: 'to-stale', body: 'stale', validation: VALIDATIONS.STALE }).record
    before = store.get(from.id)
    res = supersede(store, from.id, to.id, {})
    assertUnchanged(store, from.id, before, res, /stale/)

    // Missing replacement.
    from = put(store, { title: 'from-missing' })
    before = store.get(from.id)
    res = supersede(store, from.id, 'vey_missing_target', {})
    assertUnchanged(store, from.id, before, res, /replacement not found/)

    // Cross-project/cross-store replacement: caller passes wrong store; target absent from that store.
    from = put(store, { title: 'from-cross-store' })
    const cross = reusable.put({ ...base, scope: 'reusable', projectId: null, title: 'cross', body: 'cross' }).record
    before = store.get(from.id)
    res = supersede(store, from.id, cross.id, {})
    assertUnchanged(store, from.id, before, res, /replacement not found/)

    // Canonical replacement preserves existing authority semantics (canonical can be a target).
    from = put(store, { title: 'from-canonical-target' })
    to = store.put({ ...base, title: 'to-canonical', body: 'canon', authority: AUTHORITIES.CANONICAL, validation: VALIDATIONS.VERIFIED }, { explicitCanonical: true }).record
    res = supersede(store, from.id, to.id, {})
    assert.equal(res.ok, true)
    assert.equal(store.get(to.id).authority, AUTHORITIES.CANONICAL)

    // Same-target idempotency remains intact.
    from = put(store, { title: 'from-idempotent' })
    to = put(store, { title: 'to-idempotent' })
    assert.equal(supersede(store, from.id, to.id, {}).ok, true)
    const again = supersede(store, from.id, to.id, {})
    assert.equal(again.ok, true)
    assert.equal(again.already, true)
    assert.equal(store.get(from.id).status, STATUSES.SUPERSEDED)
    assert.equal((store.get(from.id).relations || []).filter(r => r.type === RELATIONS.SUPERSEDES).length, 1)
  } finally {
    closeAllStores()
    rmSync(home, { recursive: true, force: true })
  }
})
