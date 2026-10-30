/**
 * Compaction Continuity & Engineering Memory Recall Test
 *
 * Verifies that engineering memory recall remains active and accurate across
 * DSH conversation compactions, handling compact-checkpoint messages,
 * session/event compaction/end notifications, trivial follow-up prompts
 * ("continue", "ok", "好的"), session cache isolation, and project boundaries.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply } from '../src/plugin.mjs'
import {
  extractCheckpointTaskIntent,
  isTrivialPrompt,
  queryFromAssemble,
  rememberClaimedPrompt,
  rememberCompactedCheckpoint,
  createContextProvider,
  taskIntentCache,
} from '../src/context.mjs'
import { openProjectStore, closeAllStores } from '../src/store.mjs'
import { projectIdFor } from '../src/ids.mjs'
import { AUTHORITIES, VALIDATIONS, STATUSES } from '../src/types.mjs'

test('1. extractCheckpointTaskIntent extracts structured sections correctly', () => {
  const sampleCheckpoint = `This session is being compacted. Below is a structured summary of the conversation history.

<compacted-summary>
## Primary Request and Intent
Refactor SQLite persistence layer to support WAL mode and automatic checkpoint recovery during unexpected process exit.

## Key Technical Concepts
- SQLite WAL mode (PRAGMA journal_mode=WAL)
- node:sqlite DatabaseSync and statement finalization
- Crash recovery and transaction rollbacks

## Current Work
Implemented wal checkpoint hook in store.mjs, pending regression tests.

## Next Step
Run test suite and verify crash recovery behavior.
</compacted-summary>`

  const intent = extractCheckpointTaskIntent(sampleCheckpoint)
  assert.ok(intent.includes('Refactor SQLite persistence layer'))
  assert.ok(intent.includes('SQLite WAL mode'))
  assert.ok(!intent.includes('This session is being compacted'))
  assert.ok(!intent.includes('<compacted-summary>'))
})

test('2. extractCheckpointTaskIntent fallback logic when primary section missing', () => {
  const noPrimary = `## Current Work
Fix broken auth middleware token verification in src/auth.mjs

## Next Step
Add unit tests for expired jwt tokens.`

  const intent = extractCheckpointTaskIntent(noPrimary)
  assert.ok(intent.includes('Fix broken auth middleware'))
})

test('3. isTrivialPrompt correctly distinguishes continuation tokens from task intent', () => {
  // Continuation tokens
  assert.equal(isTrivialPrompt('continue'), true)
  assert.equal(isTrivialPrompt('Continue!'), true)
  assert.equal(isTrivialPrompt('ok'), true)
  assert.equal(isTrivialPrompt('OK...'), true)
  assert.equal(isTrivialPrompt('好的'), true)
  assert.equal(isTrivialPrompt('好'), true)
  assert.equal(isTrivialPrompt('继续'), true)
  assert.equal(isTrivialPrompt('继续吧！'), true)
  assert.equal(isTrivialPrompt('proceed'), true)
  assert.equal(isTrivialPrompt('yes'), true)
  assert.equal(isTrivialPrompt('go on'), true)
  assert.equal(isTrivialPrompt(''), true)
  assert.equal(isTrivialPrompt('   '), true)
  assert.equal(isTrivialPrompt('y'), true)

  // Real substantive engineering task prompts
  assert.equal(isTrivialPrompt('continue fixing SQLite persistence bug'), false)
  assert.equal(isTrivialPrompt('ok please run the tests now'), false)
  assert.equal(isTrivialPrompt('继续重构 context.mjs 中的缓存逻辑'), false)
  assert.equal(isTrivialPrompt('fix auth middleware'), false)
})

test('4. queryFromAssemble preserves intent across compaction with trivial user prompt', () => {
  const session = {
    header: { cwd: '/home/user/myproject' },
    deriveMessages: () => [
      {
        role: 'user',
        source: { kind: 'compact-checkpoint' },
        content: `## Primary Request and Intent
Fix memory leak in node:sqlite connection pool

## Key Technical Concepts
Connection pooling, FinalizationRegistry`
      },
      {
        role: 'user',
        source: { kind: 'user' },
        content: 'continue'
      }
    ]
  }

  const agent = {
    session,
    workspace: '/home/user/myproject',
  }

  // Trivial prompt "continue" is claimed
  rememberClaimedPrompt(agent, { role: 'user', content: 'continue', source: { kind: 'user' } })

  const query = queryFromAssemble({ agent })
  assert.ok(query.includes('Fix memory leak in node:sqlite connection pool'))
  assert.ok(!query.includes('continue'))
})

test('5. queryFromAssemble falls back to session taskIntentCache when deriveMessages unavailable', () => {
  const session = {
    header: { cwd: '/home/user/myproject' },
  }

  const agent = {
    session,
    workspace: '/home/user/myproject',
  }

  // Session has cached intent from prior compaction/end
  rememberCompactedCheckpoint(session, {
    checkpoint: `## Primary Request and Intent
Optimize FTS5 BM25 relevance scoring rank calibration`
  })

  // User enters trivial prompt "ok"
  rememberClaimedPrompt(agent, { role: 'user', content: 'ok', source: { kind: 'user' } })

  const query = queryFromAssemble({ agent })
  assert.ok(query.includes('Optimize FTS5 BM25 relevance scoring rank calibration'))
})

test('6. new substantive user prompt overrides previous compaction intent', () => {
  const session = {
    header: { cwd: '/home/user/myproject' },
    deriveMessages: () => [
      {
        role: 'user',
        source: { kind: 'compact-checkpoint' },
        content: '## Primary Request and Intent\nOld task: Fix memory leak'
      }
    ]
  }

  const agent = {
    session,
    workspace: '/home/user/myproject',
  }

  // New substantive task arrives
  const newPrompt = { role: 'user', content: 'New task: migrate to TypeScript', source: { kind: 'user' } }
  rememberClaimedPrompt(agent, newPrompt)

  const query = queryFromAssemble({ agent })
  assert.equal(query, 'New task: migrate to TypeScript')
})

test('7. cross-session and cross-project isolation in taskIntentCache', () => {
  const sessionA = { header: { cwd: '/workspace/project-alpha' } }
  const sessionB = { header: { cwd: '/workspace/project-beta' } }

  rememberCompactedCheckpoint(sessionA, {
    checkpoint: '## Primary Request and Intent\nAlpha task: secure redis credentials'
  })

  const agentB = {
    session: sessionB,
    workspace: '/workspace/project-beta',
  }

  // Agent B asks a trivial question without prior intent
  rememberClaimedPrompt(agentB, { role: 'user', content: 'continue', source: { kind: 'user' } })
  const queryB = queryFromAssemble({ agentB })

  // Session B must NOT inherit session A's intent
  assert.ok(!queryB.includes('Alpha task'))
})

test('8. compaction/end event with error does not update taskIntentCache', () => {
  const session = { header: { cwd: '/workspace/project' } }
  const priorIntent = 'Existing verified intent'
  taskIntentCache.set(session, {
    intent: priorIntent,
    projectId: projectIdFor('/workspace/project'),
    updatedAt: Date.now()
  })

  // Compaction failed with error
  rememberCompactedCheckpoint(session, {
    data: {
      error: new Error('Compaction timeout'),
      checkpoint: '## Primary Request and Intent\nCorrupted or incomplete intent'
    }
  })

  const cached = taskIntentCache.get(session)
  assert.equal(cached.intent, priorIntent)
})

test('9. full context provider recalls engineering memory after compaction', async () => {
  const home = mkdtempSync(join(tmpdir(), 'veyra-compaction-test-'))
  const workspace = join(home, 'myproject')
  const projectId = projectIdFor(workspace)

  // Seed project store with durable engineering memory
  const store = openProjectStore(home, projectId)
  store.put({
    id: 'vey_wal_recovery',
    title: 'SQLite WAL checkpoint crash recovery',
    body: 'Always issue PRAGMA wal_checkpoint(TRUNCATE) before graceful shutdown to prevent stale WAL files on process restart.',
    scope: 'project',
    kind: 'memory',
    authority: AUTHORITIES.DERIVED,
    validation: VALIDATIONS.VERIFIED,
    status: STATUSES.ACTIVE,
  })

  // Create plugin context provider
  const provider = createContextProvider({
    veyraHome: home,
    fallbackCwd: workspace,
  })

  // Simulated session after compaction
  const session = {
    header: { cwd: workspace },
    deriveMessages: () => [
      {
        role: 'user',
        source: { kind: 'compact-checkpoint' },
        content: `## Primary Request and Intent
Investigate SQLite WAL checkpoint crash recovery behavior on sudden termination.`
      },
      {
        role: 'user',
        source: { kind: 'user' },
        content: 'continue'
      }
    ]
  }

  const agent = {
    session,
    workspace,
  }

  rememberClaimedPrompt(agent, { role: 'user', content: 'continue', source: { kind: 'user' } })

  const assembleContext = { agent, projectId }
  const result = await provider(assembleContext)

  assert.ok(result, 'Context provider produced a snapshot')
  assert.equal(typeof result, 'string')
  assert.ok(result.includes('SQLite WAL checkpoint crash recovery'), 'Recalled relevant engineering memory after compaction')
  assert.ok(result.includes('PRAGMA wal_checkpoint'), 'Includes memory body')

  store.close()
  closeAllStores()
  rmSync(home, { recursive: true, force: true })
})

test('10. plugin lifecycle integrates session/event compaction/end correctly', () => {
  const listeners = {}
  const effects = []
  const mockPluginCtx = {
    systemPrompt: {
      section: () => {},
      context: () => {},
    },
    on: (evt, fn) => {
      listeners[evt] = listeners[evt] || []
      listeners[evt].push(fn)
      return () => {
        const idx = listeners[evt].indexOf(fn)
        if (idx !== -1) listeners[evt].splice(idx, 1)
      }
    },
    effect: (fn) => {
      effects.push(fn)
    },
    tools: { register: () => {} },
    commands: { register: () => {} },
    skills: { register: () => {}, registerProvider: () => () => {} },
  }

  const runtime = {
    veyraHome: mkdtempSync(join(tmpdir(), 'veyra-lifecycle-test-')),
    fallbackCwd: '/test/workspace',
    observe: false, // Compaction continuity must work even if observe is false!
    log: { info: () => {}, warn: () => {}, error: () => {} }
  }

  apply(mockPluginCtx, runtime)

  assert.ok(listeners['session/event']?.length > 0, 'session/event listener is registered')

  const session = {
    header: { cwd: '/test/workspace' },
    deriveMessages: () => [
      {
        role: 'user',
        source: { kind: 'compact-checkpoint' },
        content: '## Primary Request and Intent\nFix critical auth race condition'
      }
    ]
  }

  // Fire compaction/end event
  const sessionEventHandler = listeners['session/event'][0]
  sessionEventHandler(session, {
    type: 'compaction/end',
    data: { compactionId: 'cmp_123', turn: 5 } // error is undefined
  })

  // Verify taskIntentCache is populated
  const cached = taskIntentCache.get(session)
  assert.ok(cached, 'Cache is populated on compaction/end')
  assert.ok(cached.intent.includes('Fix critical auth race condition'))

  // Verify cleanup via effects
  effects.forEach(eff => {
    try {
      const cleanup = eff()
      if (typeof cleanup === 'function') cleanup()
    } catch {}
  })

  rmSync(runtime.veyraHome, { recursive: true, force: true })
})
