/**
 * Governed promotion refusals.
 *
 * Central Memories are the one store no room may write directly. Every path in
 * is `promoteRecord`, and every refusal reason it can return is a boundary:
 * a record that is absent, damaged, forgotten, retired, the wrong kind, still a
 * candidate, aimed at an unknown authority, missing proof, or written by a
 * DIFFERENT workspace must be rejected before anything reaches Central.
 *
 * The existing promotion tests cover the two most common refusals (candidate,
 * insufficient evidence) and the canonical gate. This file pins the remaining
 * reasons by name, because a guard that silently changes which reason it
 * returns is a guard that stopped guarding — `cross-workspace-source` in
 * particular has no other assertion anywhere in the suite.
 */

import { afterEach, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { AUTHORITIES, STATUSES } from '../src/types.mjs'
import { promoteRecord, PROMOTION_FAILURES } from '../src/promotion.mjs'
import { closeAllStores, openCentralStore, openRoomStore } from '../src/store.mjs'

const HOMES = []

afterEach(() => {
  closeAllStores()
  HOMES.length = 0
})

function makeHome() {
  const home = mkdtempSync(join(tmpdir(), 'veyra-promotion-home-'))
  HOMES.push(home)
  return home
}

const binding = {
  roomId: 'w_room-a',
  workspaceId: '11111111-1111-4111-8111-111111111111',
  workspacePath: '/repo/a',
  mode: 'registry',
}

function record(overrides = {}) {
  return {
    kind: 'knowledge',
    status: 'current',
    validation: 'reviewed',
    authority: 'derived',
    confidence: 'medium',
    scope: 'project',
    title: 'Writer timeout',
    body: 'The writer retries with exponential backoff; tests fail if the queue is closed.',
    tags: ['writer'],
    evidence: [{ note: 'observed in test/writer.test.mjs' }],
    source: {},
    ...overrides,
  }
}

function fixture() {
  const home = makeHome()
  return { home, room: openRoomStore(home, binding.roomId), central: openCentralStore(home) }
}

function promote(room, central, id, extra = {}) {
  return promoteRecord({ workspaceStore: room, centralStore: central, binding, id, ...extra })
}

describe('governed promotion refuses ineligible records', () => {
  test('a record that does not exist is not-found, not a silent success', () => {
    const { room, central } = fixture()
    const result = promote(room, central, 'vey_does_not_exist')
    assert.equal(result.ok, false)
    assert.equal(result.reason, PROMOTION_FAILURES.NOT_FOUND)
    assert.equal(central.list({ limit: 50 }).length, 0, 'nothing may reach Central')
  })

  test('a forgotten record is refused, and forgetting is not undone by promotion', () => {
    const { room, central } = fixture()
    const written = room.put(record({ title: 'Forgotten knowledge' }))
    room.forget(written.record.id, { reason: 'superseded' })

    const result = promote(room, central, written.record.id)
    assert.equal(result.ok, false)
    assert.equal(result.reason, PROMOTION_FAILURES.FORGOTTEN)
    assert.equal(central.list({ limit: 50 }).length, 0)
    assert.equal(room.get(written.record.id).forgotten, true, 'the record stays forgotten')
  })

  test('a non-current record is refused as retired', () => {
    const { room, central } = fixture()
    const written = room.put(record({ title: 'Old knowledge', status: STATUSES.SUPERSEDED }))

    const result = promote(room, central, written.record.id)
    assert.equal(result.ok, false)
    assert.equal(result.reason, PROMOTION_FAILURES.RETIRED)
    assert.equal(central.list({ limit: 50 }).length, 0)
  })

  test('a kind that cannot be promoted is refused by kind, not by evidence', () => {
    const { room, central } = fixture()
    // An observation is real memory, but it is not promotable: only memory,
    // knowledge and evidence cross into Central.
    const written = room.put(record({ kind: 'observation', title: 'An observation' }))

    const result = promote(room, central, written.record.id)
    assert.equal(result.ok, false)
    assert.equal(result.reason, PROMOTION_FAILURES.INELIGIBLE_KIND)
    assert.equal(central.list({ limit: 50 }).length, 0)
  })

  test('an unknown target authority is refused before anything is copied', () => {
    const { room, central } = fixture()
    const written = room.put(record({ title: 'Legitimate knowledge' }))

    const result = promote(room, central, written.record.id, { to: 'sovereign' })
    assert.equal(result.ok, false)
    assert.equal(result.reason, PROMOTION_FAILURES.INVALID_TARGET)
    assert.equal(central.list({ limit: 50 }).length, 0)
  })
})

describe('governed promotion refuses another workspace\'s record', () => {
  test('a record whose provenance names a different workspace never reaches Central', () => {
    const { room, central } = fixture()
    // Written by a DIFFERENT workspace (b) but sitting in room a's store — the
    // shape a copy or a bad import would take. The binding's workspacePath is
    // /repo/a, so provenance /repo/b must not promote.
    const written = room.put(record({
      title: 'Another workspace private knowledge',
      source: { workspace: '/repo/b' },
    }))

    const result = promote(room, central, written.record.id)
    assert.equal(result.ok, false)
    assert.equal(result.reason, PROMOTION_FAILURES.CROSS_WORKSPACE_SOURCE)
    assert.equal(central.list({ limit: 50 }).length, 0, 'cross-workspace memory must never reach Central')
  })

  test('nested provenance is checked too, not only the flat field', () => {
    const { room, central } = fixture()
    // `source.context.workspace` is the other provenance shape; a guard that
    // only reads `source.workspace` would let this one through.
    const written = room.put(record({
      title: 'Nested provenance knowledge',
      source: { context: { workspace: '/repo/b' } },
    }))

    const result = promote(room, central, written.record.id)
    assert.equal(result.ok, false)
    assert.equal(result.reason, PROMOTION_FAILURES.CROSS_WORKSPACE_SOURCE)
    assert.equal(central.list({ limit: 50 }).length, 0)
  })

  test('a binding with no room is refused rather than promoting unattributed', () => {
    const { room, central } = fixture()
    const written = room.put(record({ title: 'Unattributed knowledge' }))

    const result = promoteRecord({
      workspaceStore: room,
      centralStore: central,
      binding: { workspacePath: '/repo/a', mode: 'registry' },
      id: written.record.id,
    })
    assert.equal(result.ok, false)
    assert.equal(result.reason, PROMOTION_FAILURES.CROSS_WORKSPACE_SOURCE)
    assert.equal(central.list({ limit: 50 }).length, 0)
  })

  test('the same record from its OWN workspace does promote — the guard is not blanket', () => {
    const { room, central } = fixture()
    // Positive control: without this, a guard that refused everything would
    // still pass every test above.
    const written = room.put(record({
      title: 'Its own workspace knowledge',
      source: { workspace: '/repo/a' },
    }))

    const result = promote(room, central, written.record.id)
    assert.equal(result.ok, true, result.reason)
    assert.equal(result.action, 'created')
    assert.equal(central.list({ limit: 50 }).length, 1)
  })

  test('an unattributed record still promotes through its bound room', () => {
    const { room, central } = fixture()
    // Records written before provenance was recorded carry no `source.workspace`.
    // They were written through a bound room, so they belong to that room.
    const written = room.put(record({ title: 'Unattributed but room-bound' }))

    const result = promote(room, central, written.record.id)
    assert.equal(result.ok, true, result.reason)
    assert.equal(central.list({ limit: 50 }).length, 1)
  })
})

describe('governed promotion authority transitions', () => {
  test('derived is the default target and canonical is not reachable without explicit intent', () => {
    const { room, central } = fixture()
    const written = room.put(record({ title: 'Knowledge for the default target' }))

    const implicit = promote(room, central, written.record.id, { to: AUTHORITIES.CANONICAL })
    assert.equal(implicit.ok, false)
    assert.equal(implicit.reason, PROMOTION_FAILURES.CANONICAL_REQUIRES_EXPLICIT)

    const explicit = promote(room, central, written.record.id, { to: AUTHORITIES.CANONICAL, explicit: true })
    assert.equal(explicit.ok, true, explicit.reason)
    assert.equal(explicit.authority, AUTHORITIES.CANONICAL)
  })
})
