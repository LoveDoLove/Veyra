/**
 * Regenerate examples/command-output.md from the REAL Veyra code.
 *
 *   node examples/make-demo-output.mjs
 *
 * It seeds a throwaway demo store in a temp directory (never your real
 * $DSH_HOME/veyra), runs the actual /veyra command handler against it, and
 * writes the captured output to examples/command-output.md. Record ids and
 * timestamps are pinned so reruns are stable; only the file header date
 * changes. Absolute temp paths are normalized to `~/.dsh/veyra` and
 * `/path/to/your/project` so the example reads like a real session.
 *
 * The demo records below are clearly-labeled sample content, not real
 * project knowledge.
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { handleVeyraCommand } from '../src/commands.mjs'
import { closeAllStores, openProjectStore } from '../src/store.mjs'
import { projectIdFor } from '../src/ids.mjs'
import { AUTHORITIES, CONFIDENCES, KINDS, RELATIONS, SCOPES, VALIDATIONS } from '../src/types.mjs'

const demoHome = mkdtempSync(join(tmpdir(), 'veyra-demo-'))
const workspace = join(demoHome, 'demo-project')
const projectId = projectIdFor(workspace)
const runtime = {
  veyraHome: demoHome,
  fallbackCwd: workspace,
  recallLimit: 5,
  includeReusable: true,
}
const invocation = { agent: { session: { header: { cwd: workspace } } } }

const store = openProjectStore(demoHome, projectId)

const root = store.put({
  id: 'vey_19a60f100000_5e0a11c0ffee',
  projectId,
  scope: SCOPES.PROJECT,
  kind: KINDS.MEMORY,
  authority: AUTHORITIES.DERIVED,
  validation: VALIDATIONS.VERIFIED,
  confidence: CONFIDENCES.HIGH,
  title: 'Serialize SQLite writes behind a mutex',
  body: 'Concurrent DatabaseSync writes deadlock in WAL mode. Queue every write through a single async mutex in src/store.mjs; reads stay concurrent.',
  tags: ['sqlite', 'wal', 'mutex'],
  evidence: [{ path: 'src/store.mjs' }, { note: 'npm test → 110 pass' }],
  source: {
    causal: {
      symptom: 'SQLITE_BUSY errors under parallel tool calls',
      rootCause: 'two DatabaseSync writers in the same process',
      remedy: 'serialize all writes behind one async mutex',
      verifiedOutcome: 'npm test → 110 pass',
    },
  },
  createdAt: '2026-09-24T09:10:00.000Z',
  updatedAt: '2026-09-25T08:00:00.000Z',
}).record

const child = store.put({
  id: 'vey_19a60f200000_0badc0de1234',
  projectId,
  scope: SCOPES.PROJECT,
  kind: KINDS.MEMORY,
  authority: AUTHORITIES.DERIVED,
  validation: VALIDATIONS.REVIEWED,
  confidence: CONFIDENCES.MEDIUM,
  title: 'Set busy_timeout on every connection',
  body: 'Each opened connection sets PRAGMA busy_timeout = 5000 so a read never fails fast while a write is queued.',
  tags: ['sqlite', 'busy_timeout'],
  evidence: [{ path: 'src/store.mjs#openDatabase' }],
  relations: [{ type: RELATIONS.EXTENDS, targetId: root.id }],
  createdAt: '2026-09-24T09:12:00.000Z',
  updatedAt: '2026-09-24T09:12:00.000Z',
}).record

const knowledge = store.put({
  id: 'vey_19a60f300000_42cafe000001',
  projectId,
  scope: SCOPES.PROJECT,
  kind: KINDS.KNOWLEDGE,
  authority: AUTHORITIES.DERIVED,
  validation: VALIDATIONS.UNVERIFIED,
  confidence: CONFIDENCES.MEDIUM,
  title: 'Demo project test command',
  body: 'The demo project runs its suite with `npm test` (node --test). CI runs the same command on Node 22 and 24.',
  tags: ['testing', 'ci'],
  evidence: [{ path: '.github/workflows/ci.yml' }],
  createdAt: '2026-09-25T07:30:00.000Z',
  updatedAt: '2026-09-25T07:30:00.000Z',
}).record

store.put({
  id: 'vey_19a60f400000_c0011de00001',
  projectId,
  scope: SCOPES.PROJECT,
  kind: KINDS.OBSERVATION,
  authority: AUTHORITIES.CANDIDATE,
  validation: VALIDATIONS.UNVERIFIED,
  confidence: CONFIDENCES.LOW,
  title: 'Candidate: flaky test observed in webui suite',
  body: 'Auto-captured observation: one run of the webui suite needed a retry. Not learned yet — candidates are never auto-recalled.',
  tags: ['flaky'],
  evidence: [],
  createdAt: '2026-09-26T06:00:00.000Z',
  updatedAt: '2026-09-26T06:00:00.000Z',
})

const inv = (rawInput) => ({ ...invocation, rawInput })
const run = (rawInput) => {
  const res = handleVeyraCommand(runtime, inv(rawInput))
  if (res.kind === 'error') throw new Error(`${rawInput}: ${res.text}`)
  return res.text
}

const sections = [
  { cmd: '/veyra', out: run('') },
  { cmd: '/veyra observatory overview', out: run('observatory overview') },
  { cmd: '/veyra observatory search sqlite mutex wal', out: run('observatory search sqlite mutex wal') },
  { cmd: `/veyra observatory record ${root.id}`, out: run(`observatory record ${root.id}`) },
  { cmd: `/veyra observatory local ${root.id}`, out: run(`observatory local ${root.id}`) },
  { cmd: '/veyra recent', out: run('recent') },
  { cmd: '/veyra recall sqlite write lock', out: run('recall sqlite write lock') },
]

const normalize = (text) => text
  .split(encodeURIComponent(workspace)).join('%2Fpath%2Fto%2Fyour%2Fproject')
  .split(workspace).join('/path/to/your/project')
  .split(demoHome).join('~/.dsh/veyra')
  .split(projectId).join('p_0000000000000000')

const today = new Date().toISOString().slice(0, 10)
const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))

const body = sections
  .map((s) => `### \`${s.cmd}\`\n\n\`\`\`\n${normalize(s.out)}\n\`\`\`\n`)
  .join('\n')

const md = `# Veyra command output — demo store

Captured on ${today} from \`@lovedolove/veyra@${pkg.version}\` by running the real
\`handleVeyraCommand\` handler against a throwaway demo store.

- The four records below are **demo content**, clearly labeled as such — they are not real project knowledge.
- Absolute temp paths are normalized to \`~/.dsh/veyra\` and \`/path/to/your/project\`; the project id is masked.
- Regenerate with \`node examples/make-demo-output.mjs\` (ids and timestamps are pinned; score breakdowns may shift
  slightly as freshness tiers age).
`

writeFileSync(new URL('./command-output.md', import.meta.url), `${md}\n${body}`)

closeAllStores()
rmSync(demoHome, { recursive: true, force: true })
console.log('wrote examples/command-output.md')
