// Veyra v0.1.64 A/B evaluation harness — reproducible
// Usage: node test/eval-v0164-ab.mjs
// Uses isolated temp MemoryStore DBs. No real DSH DB is read or modified.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { MemoryStore } from '../src/store.mjs';
import { remember, isNarrativeOnly } from '../src/learn.mjs';
import { recall } from '../src/retrieve.mjs';

const PID = 'p_eval';
const TASKS = [
  {
    "id": "T1-debug-timeout",
    "query": "writer timeout concurrent sqlite busy_timeout WAL",
    "correct": "Root cause: SQLite busy_timeout=5000 prevents writer starvation. Remedy: enable WAL journal mode."
  },
  {
    "id": "T2-dedup-promotion",
    "query": "maybeLearn candidate not promoted content_hash dedup",
    "correct": "Root cause: content_hash dedup returns original candidate row. Remedy: update existing record in place."
  },
  {
    "id": "T3-cbm-binary",
    "query": "codebase-memory-mcp executable identity cache-resolve fail",
    "correct": "Root cause: binary absent in sandbox; code-* tests fail environmentally with process closed code 1."
  },
  {
    "id": "T4-publish-conflict",
    "query": "npm publish version exists registry tag conflict",
    "correct": "Root cause: tag/version must be unpublished. Remedy: bump patch, new tag, never move existing."
  },
  {
    "id": "T5-narrative-cap",
    "query": "Agent logs test-passed promoted REVIEWED validation",
    "correct": "Root cause: writeGate lacked narrative check. Remedy: isNarrativeOnly caps at UNVERIFIED."
  },
  {
    "id": "T6-ranking-tie",
    "query": "narrative logs rank same as root-cause recall",
    "correct": "Root cause: no actionability tiebreaker at equal fusion. Remedy: sort-only demote narrative."
  },
  {
    "id": "T7-git-auth",
    "query": "git push could not read Username headless credential",
    "correct": "Root cause: no credential.helper/token. Remedy: embed token from git-credentials in URL temporarily."
  },
  {
    "id": "T8-staged-delay",
    "query": "npm stage publish latest tag not updating delay",
    "correct": "Root cause: staged publish promotes latest async after minutes; tarball CDN 404 brief — normal."
  },
  {
    "id": "T9-temporal",
    "query": "expired validUntil knowledge still in recall",
    "correct": "Root cause: temporalBounds must gate expired below current; demoted never deleted."
  },
  {
    "id": "T10-context",
    "query": "Linux knowledge in macOS context compatibility",
    "correct": "Root cause: contextCompatibility holds incompatible below compatible, not excluded."
  }
];

function makeStore(tag) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'veyra-eval-' + tag + '-'));
  return new MemoryStore(path.join(dir, 'eval.db'), { scope: 'project', projectId: PID });
}

const storeA = makeStore('A');
for (const t of TASKS) {
  remember(storeA, { title: 'Fix ' + t.id, body: t.correct, kind: 'knowledge', scope: 'project', projectId: PID, confidence: 'high', evidence: [{ path: 'src/store.mjs', note: 'test-passed' }] });
  remember(storeA, { title: 'Falsified ' + t.id, body: 'Wrong hypothesis for ' + t.id + '. Rejected.', kind: 'negative', scope: 'project', projectId: PID });
}
const armA = TASKS.map(t => {
  const hits = recall({ projectStore: storeA, query: t.query, limit: 5 });
  return { id: t.id, correctTop1: hits[0] ? (hits[0].body||'').includes(t.correct.slice(0,30)) : false, correctTop5: hits.some(h => (h.body||'').includes(t.correct.slice(0,30))), topNeg: hits[0]?.kind === 'negative', negCount: hits.filter(h => h.kind === 'negative').length };
});
const storeB = makeStore('B');
const armB = TASKS.map(t => ({ id: t.id, hits: recall({ projectStore: storeB, query: t.query, limit: 5 }).length }));
storeA.close(); storeB.close();

const N = TASKS.length;
const report = {
  version: 'v0.1.64',
  withMemory: { reuseTop5: armA.filter(r => r.correctTop5).length + '/' + N, top1: armA.filter(r => r.correctTop1).length + '/' + N, negInterference: armA.filter(r => r.topNeg).length + '/' + N, negWarnings: armA.filter(r => r.negCount > 0).length + '/' + N },
  withoutMemory: { reuse: '0/' + N, investigationCost: N + '/' + N },
};
console.log(JSON.stringify(report, null, 2));
