/**
 * P0.2: deterministic regression proving secret-like values are redacted
 * before persistence in the automatic observation/learning path.
 *
 * Exercises the actual plugin runtime path through apply() handlers:
 *   session/event → observation buffer → candidate distillation →
 *   agent/turn-stopping → store persistence (candidate put + maybeLearn).
 *
 * No network, model, or eval harness. Test-only; no production changes.
 * Uses deterministic fake secret values — never real credentials.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { apply, _resetMaintenanceCounter } from '../src/plugin.mjs'
import { closeAllStores } from '../src/store.mjs'
import { fakeRegistry, roomStore } from './helpers/room.mjs'
import { AUTHORITIES } from '../src/types.mjs'

const FAKE_TOOL_KEY = 'FAKE_TOOL_KEY_ABCDEF1234567890'
const FAKE_USER_TOKEN = 'FAKE_USER_TOKEN_ZYXWVUT987654321'
const FAKE_ASSIST_SECRET = 'FAKE_ASSIST_SECRET_QWERTY654321098'
const ALL_FAKE_SECRETS = [FAKE_TOOL_KEY, FAKE_USER_TOKEN, FAKE_ASSIST_SECRET]

function mockCtx(paths = []) {
  const listeners = {}
  return {
    tools: { register: () => {} },
    commands: { register: () => {} },
    skills: { register: () => {}, registerProvider: () => () => {} },
    systemPrompt: { section: () => {}, context: () => {} },
    webServer: null,
    // The plugin builds its Memory Server from ctx, so the registry must be here
    // for the observed session's room to resolve at all.
    workspaceRegistry: fakeRegistry(paths),
    on: (event, fn) => {
      listeners[event] = listeners[event] || []
      listeners[event].push(fn)
      return () => {
        listeners[event] = (listeners[event] || []).filter((x) => x !== fn)
      }
    },
    effect: (factory) => factory(),
    _listeners: listeners,
  }
}

function emit(ctx, event, ...args) {
  for (const fn of ctx._listeners[event] || []) fn(...args)
}

function prepareWorkspace(dir, paths = ['src/store.mjs']) {
  for (const p of paths) {
    const abs = join(dir, p)
    mkdirSync(dirname(abs), { recursive: true })
    writeFileSync(abs, '// test fixture\nexport function store() {}\n')
  }
}

function secretEvents() {
  // Distinct fake secrets in each observation stream captured by observeEvent:
  // user/assistant via data.text, tool output via tool/result eventText preview.
  return [
    { type: 'turn/start', data: { turn: 1 } },
    {
      type: 'user/message',
      data: {
        text: `The flaky sqlite writer in src/store.mjs times out during CI. Debug showed DATABASE_PASSWORD="${FAKE_USER_TOKEN}" in the env, but the real issue is a race in concurrent writes.`,
      },
    },
    {
      type: 'assistant/message',
      data: {
        text: `Root cause: sqlite writer race corrupts concurrent writes in src/store.mjs. Fix: serialize DatabaseSync writes through a single connection lock. Note token: "${FAKE_ASSIST_SECRET}" appeared in logs but is unrelated. Tests pass after the lock.`,
      },
    },
    {
      type: 'tool/call',
      data: { callId: 'c1', name: 'edit', arguments: JSON.stringify({ file_path: 'src/store.mjs' }) },
    },
    {
      type: 'tool/result',
      data: {
        message: {
          source: { kind: 'tool', callId: 'c1' },
          content: [{ type: 'tool-result', toolCallId: 'c1', content: [{ type: 'text', text: 'updated src/store.mjs' }] }],
        },
      },
    },
    {
      type: 'tool/call',
      data: { callId: 'c2', name: 'bash', arguments: JSON.stringify({ command: 'npm test -- store' }) },
    },
    {
      type: 'tool/result',
      data: {
        message: {
          source: { kind: 'tool', callId: 'c2' },
          content: [{
            type: 'tool-result',
            toolCallId: 'c2',
            content: [{ type: 'text', text: `1 test passed, 0 failed; debug: api_key = "${FAKE_TOOL_KEY}"` }],
          }],
        },
      },
    },
  ]
}

function persistedStrings(record) {
  // Deep string scan of the full persisted record (title/body/evidence/source/tags/relations/etc).
  const out = []
  const seen = new Set()
  function walk(v) {
    if (typeof v === 'string') {
      if (!seen.has(v)) { seen.add(v); out.push(v) }
      return
    }
    if (!v || typeof v !== 'object') return
    if (Array.isArray(v)) { for (const x of v) walk(x); return }
    for (const x of Object.values(v)) walk(x)
  }
  walk(record)
  return out
}

test('P0.2 turn-stopping persistence redacts secrets from tool/user/assistant streams', async (t) => {
  _resetMaintenanceCounter()
  const dir = mkdtempSync(join(tmpdir(), 'veyra-p02-redact-'))
  prepareWorkspace(dir, ['src/store.mjs'])
  const ctx = mockCtx([dir])
  // learn:true so the handler persists candidate and also runs maybeLearn on the
  // created candidate (derived learning path), exercising both persisted forms.
  apply(ctx, { home: dir, observe: true, learn: true })

  const session = { id: 's-redact', header: {} }
  const agent = { session, cwd: dir, sessionId: session.id }
  for (const ev of secretEvents()) emit(ctx, 'session/event', session, ev)
  await Promise.resolve()
  emit(ctx, 'agent/turn-stopping', { agent })
  await Promise.resolve()

  const store = roomStore(dir, dir)
  t.after(() => { try { store.close() } catch {} closeAllStores() })
  const all = store.list({ includeForgotten: true, limit: 50 })

  assert.ok(all.length >= 1, `expected persisted records via actual handler; got ${all.length}`)
  const hasCandidate = all.some((r) => r.authority === AUTHORITIES.CANDIDATE)
  const hasDerived = all.some((r) => r.authority === AUTHORITIES.DERIVED)
  assert.ok(hasCandidate || hasDerived, `expected candidate and/or derived record; got ${JSON.stringify(all.map((r) => r.authority))}`)

  // 1-3: original secret values must not appear anywhere in any persisted record
  // (title/body/tags/evidence/source/relations and all nested fields).
  for (const record of all) {
    const hay = JSON.stringify(record)
    for (const secret of ALL_FAKE_SECRETS) {
      assert.equal(hay.includes(secret), false,
        `persisted ${record.authority}/${record.kind} ${record.id} leaked fake secret "${secret}" from tool/user/assistant input`)
    }
  }

  // 4: legitimate surrounding engineering information and evidence survive.
  const combined = all.map((r) => JSON.stringify(r)).join('\n')
  assert.match(combined, /src\/store\.mjs/, 'file evidence/path should survive redaction')
  assert.match(combined, /serialize|lock|race|sqlite|concurrent|writer/i,
    'engineering meaning should survive redaction')
  // test outcome evidence is a legitimate signal carried by distill/learning.
  assert.match(combined, /test-passed|passed|0 failed/i,
    'test outcome / legitimate result context should survive redaction')

  // Redaction should be visible (placeholders) in at least some persisted text
  // when secrets were present in captured streams.
  const strings = all.flatMap(persistedStrings).join('\n')
  assert.match(strings, /REDACTED/, 'redaction placeholder should appear where secrets were scrubbed')
})
