/**
 * Veyra — understand / distill a turn.
 *
 * Observe ≠ Store. The session buffer is a lossy activity log. This
 * module turns that log into a structured engineering claim (or null
 * when the turn is noise). Adapted in spirit from PMA `distill.mjs`
 * (file/symbol/hunk evidence, fix-vs-feature titles) without spawning
 * git or writing into the user repo.
 */

import {
  AUTHORITIES,
  CONFIDENCES,
  KINDS,
  MIN_OBSERVATION_CHARS,
  PROVENANCE_ORIGINS,
  SCOPES,
  STATUSES,
  VALIDATIONS,
} from './types.mjs'
import { scrub } from './redact.mjs'
import { tokenize } from './text.mjs'
import { provenanceDimensions } from './ids.mjs'
import { isAbsolute } from 'node:path'
import { resolveSafeRepoPath } from '@lovedolove/dsh-codebase-memory-mcp'

const CLAIM_HINTS = [
  /\b(decided|decision|always|never|must not|must\b|should not|root cause|workaround|fix was|the cause|lesson|constraint|regression)\b/i,
  /\b(architecture|race|deadlock|migration|serialize|lock the|do not|remedy|solution|resolved by|caused by|symptom)\b/i,
]

// A sentence that opens with an operator is an INSTRUCTION, not a claim about
// the system. Instructions tell the agent what to do; claims assert how the
// system is. Only claims are user knowledge, so this distinction is what keeps
// "Do not weaken the tests." from turning an ordinary task prompt into a
// user-authored engineering claim (m00188).
const IMPERATIVE_START = /^\s*(?:please\s+|you\s+(?:should|must|need\s+to)\s+)?(?:(?:do\s+not|don'?t|never|always|must|must\s+not|should|should\s+not|make\s+sure|ensure|be\s+sure|remember\s+to|note\s+that|keep|avoid|consider|prefer|stick\s+to|go\s+ahead|proceed|start|stop|use|run|add|remove|update|fix|change|investigate|diagnose|debug|find|locate|check|verify|confirm|test|write|read|open|close|install|commit|push|merge|revert|refactor|implement|create|delete|drop|move|rename|return|handle|treat|analyze|analyse|review|explain|describe|tell|show|give|help|let|try)\b)(?!\s+(?:was|is|are|were|has|had|will|would)\b)/i

// A markdown list marker in front of a sentence. Its presence or absence says
// nothing about whether the sentence is an instruction or a claim — it is
// typesetting, not meaning — but `IMPERATIVE_START` anchors on `^`, so "- Do not
// weaken the tests" missed the imperative branch while "Do not weaken the tests"
// hit it. The same task then got a different governance outcome purely because
// it was written as a list: `userAssertsClaim` returned true, the turn counted
// as user-authored knowledge, and the provenance gate deferred everything it had
// learned (m00191, first seen as A5 in m00190 where a bulleted prompt made
// auto-learn store nothing).
//
// Normalising here, rather than relaxing `IMPERATIVE_START`, keeps the rule
// itself strict: only the incidental prefix is removed, and every sentence is
// then judged by exactly the same test regardless of how it was laid out.
//
// The optional task-list checkbox (`- [ ] …`, `- [x] …`, `- [X] …`) is the same
// kind of incidental prefix: markdown task syntax, not meaning. Leaving it in
// place reproduced the original defect one level down — `- Do not weaken the
// tests.` normalised cleanly but `- [ ] Do not weaken the tests.` did not, so the
// checked-off form of an instruction was still read as a claim (m00191 addendum).
//
// The checkbox is stripped as its own step rather than as an optional tail on
// `LIST_MARKER`, because the sentence splitter breaks after `1.` — by the time a
// numbered task item is judged, the list marker has already been consumed and the
// sentence starts at `[ ]`. Requiring a marker in front of the checkbox would
// leave exactly one layout unfixed.
const LIST_MARKER = /^(?:[-*+]|\d{1,3}[.)])\s+/
const TASK_BOX = /^(?:\[[ xX]\]\s*)+/

const FIX_HINTS = /\b(fix|bug|error|issue|patch|fail|race|deadlock|corrupt|flake|regress|remedy|workaround)\b/i
const DECISION_HINTS = /\b(decided|decision|always|never|must|should not|do not|constraint)\b/i
const CAUSE_HINTS = /\b(root cause|the cause|caused by|because of|why|reason)\b/i

const SYMBOL_RE = /(?:export\s+)?(?:async\s+)?(?:function\*?|class|const|let|var)\s+([A-Za-z_$][\w$]{2,})/g
const PATH_RE = /(?:^|[\s`'"(])((?:src|test|tests|lib|app|packages|skills)\/[\w./-]+\.[A-Za-z]{1,8})/g

// m00188: a code span is OPAQUE. Its punctuation is code, not prose, so every
// boundary rule must not run inside one. "The bug: loop `attempt = 0; attempt
// <= maxAttempts` runs maxAttempts+1 times" was cut at the semicolon INSIDE the
// ticks — by the extraction regex itself, before any cleanup — leaving "loop
// `attempt = 0", which the gate then rejected and the whole record fell back to
// "Engineering observation". Masking must therefore happen before MATCHING, not
// after capture: ticks become indexed sentinels that carry no '.' ';' or
// newline, the rules run on the masked text, and the spans are restored after
// cleaning (ticks are formatting, so they are not restored themselves).
function maskCodeSpans(str) {
  const spans = []
  const text = String(str ?? '').replace(/`([^`]*)`/g, (_, body) => `\u0000${spans.push(body) - 1}\u0000`)
  return { text, spans }
}

function restoreCodeSpans(str, spans) {
  if (!str || !spans.length) return str
  return str.replace(/\u0000(\d+)\u0000/g, (_, i) => spans[Number(i)] ?? '')
}

function cleanFacetText(str, inheritedSpans = null) {
  if (typeof str !== 'string') return null
  let s = str.trim()
  // m00188: a code span is OPAQUE — see maskCodeSpans. When the caller matched
  // on masked text it passes the span table in, so the capture still carries
  // sentinels; otherwise the ticks are masked here. Either way the boundary cut
  // below runs on masked text and the spans are restored afterwards, so a ';'
  // inside code never ends the facet.
  const spans = inheritedSpans ? [...inheritedSpans] : []
  s = s.replace(/`([^`]*)`/g, (_, body) => `\u0000${spans.push(body) - 1}\u0000`)
  // m00188: cut at a sentence boundary rather than at the first period. The
  // extraction regexes used to stop at `[^\n.;]`, which truncated any facet
  // that mentioned a qualified path — "… exported from schema.mjs" became
  // "… exported from schema". A period only ends a sentence when whitespace
  // follows (or it is trailing), so `schema.mjs`, `v1.2` and `e.g` survive.
  const stop = s.search(/\.(?=\s)|;|\n/)
  if (stop !== -1) s = s.slice(0, stop)
  s = restoreCodeSpans(s, spans)
  s = s.replace(/^[:\-—`'"*#\s]+/, '').replace(/[.:\-—`'"*#\s]+$/, '')
  s = s.replace(/^(?:to|that|is|was|in)\s+/i, '')
  if (s.length < 5) return null
  return s.slice(0, 200)
}

// ── M12 C2: Distillation Quality Gate ──────────────────────────────────────
//
// Deterministic structural validation of a single extracted text facet.
// Drops malformed facets (regex artifacts, truncated captures, punctuation
// fragments) WITHOUT ever rewriting or fabricating content. Returns the
// original string when structurally sound, `null` when it must be dropped.
//
// Rules (in order):
//   R1 non-string / empty
//   R2 shorter than the extraction floor
//   R3 must START with an ASCII letter (kills leading punctuation artifacts)
//   R4 first word must be >=2 chars and not a bare suffix fragment
//   R6 bracket/quote delimiters must be balanced (kills truncation artifacts)
//   R7 last word must not be a truncated stub (>=3 chars, or a stop word)
const VERIFIED_OUTCOMES = new Set(['test-passed', 'test-failed', 'tests-touched'])

// Bare suffix fragments that never begin an English word — a leading token in
// this set means the capture started mid-word.
const SUFFIX_FRAGMENTS = new Set([
  'ing', 'tion', 'sion', 'ness', 'ful', 'less', 'able', 'ible', 'ous',
  'ive', 'ally', 'ation', 'izing', 'ement',
])

// Complete short words that may legitimately end a facet.
const SHORT_END_WORDS = new Set([
  'a', 'an', 'to', 'in', 'is', 'it', 'of', 'on', 'or', 'up', 'no', 'so',
  'be', 'we', 'he', 'do', 'if', 'as', 'at', 'by', 'for', 'the', 'via',
  'per', 'and', 'but', 'not', 'with', 'from', 'into', 'out', 'off',
])

export function qualityGateFacet(value) {
  if (typeof value !== 'string') return null
  const s = value.trim()
  if (s.length < 5) return null

  // R3: must start with a letter.
  if (!/^[A-Za-z]/.test(s)) return null

  const words = s.split(/\s+/)

  // R4: first word must be >=2 chars and not a bare suffix fragment.
  const first = words[0].replace(/[^A-Za-z0-9]/g, '')
  if (first.length < 2) return null
  if (SUFFIX_FRAGMENTS.has(first.toLowerCase())) return null

  // R6: balanced brackets and even double-quote count.
  const openParens = (s.match(/\(/g) || []).length
  const closeParens = (s.match(/\)/g) || []).length
  const openBrackets = (s.match(/\[/g) || []).length
  const closeBrackets = (s.match(/\]/g) || []).length
  const doubleQuotes = (s.match(/"/g) || []).length
  if (openParens !== closeParens) return null
  if (openBrackets !== closeBrackets) return null
  if (doubleQuotes % 2 !== 0) return null

  // R7: last word must not be a truncated stub.
  const last = words[words.length - 1].replace(/^[^A-Za-z0-9]+|[^A-Za-z0-9]+$/g, '')
  // m00188: a trailing NUMBER is a complete value, never a cut-off word —
  // "the loop ran 4 times instead of 3" ends on the finding itself, and
  // rejecting it blanked a real diagnosis on a memory arm.
  const lastIsNumber = /^\d+(?:\.\d+)*$/.test(last)
  if (!lastIsNumber && last.length < 3 && !SHORT_END_WORDS.has(last.toLowerCase())) return null

  // P0-2: concreteness gate. A causal facet must carry technical content —
  // code, a command, a file path, an identifier, a version, or domain
  // jargon. Pure session narration ("complete and all tests pass",
  // "fixture freshness") is activity, not engineering knowledge.
  if (!hasTechnicalSubject(s)) return null

  return s
}

// Facets whose OPENING token is a sentence-boundary artifact — a capture
// that started mid-sentence or a label coloned onto narration. These are
// regex slice debris, not engineering facts, even if they contain technical
// words ("test: assert button disabled" is a session check, not knowledge).
const GARBAGE_LEAD = /^(?:s\/|\(|\w+\/(?:\w+:|engineering)|continue\b|complete and\b|for (?:durable|the\b)|it and\b|it (?:was|is) I?\b.*I?\b|ture\b|this (?:turn|was)\b|you are\b|the user\b|the agent\b|the session\b|fixture\b|newline\+?|test:|expect:|then run\b|when (?:the|a)\b|while (?:the|a)\b)/

// Domain vocabulary a facet is allowed to rely on instead of code tokens.
// Prefix matching: 'deadlock' also admits 'deadlocking', 'lock' admits
// 'locked', 'write' admits 'writers'/'writes'.
const TECH_SUBJECTS = new Set([
  'sqlite', 'mutex', 'lock', 'race', 'deadlock', 'index', 'cache', 'schema',
  'migration', 'wal', 'fts', 'fts5', 'worker', 'writers', 'writer', 'flush',
  'hash', 'server', 'client', 'plugin', 'config', 'flag', 'pragma', 'timeout',
  'retry', 'version', 'api', 'cli', 'daemon', 'socket', 'pipeline', 'node',
  'npm', 'npx', 'git', 'buffer', 'store', 'queue', 'event', 'handler',
  'callback', 'async', 'logger', 'watcher', 'snapshot', 'diff', 'oops',
  'checkpoint', 'serialize', 'benchmark', 'gate', 'recall', 'facet',
  'leak', 'oom', 'heap', 'tsc', 'rg', 'grep', 'concurrent', 'write',
  'jitter', 'mutex',
])

// Non-technical facet check: does the facet name anything concrete?
// A facet subjects a technical thing if it carries a code-structural token
// (path, extension, flag, call syntax, snake_case, camelCase, quoted
// string, ALL-CAPS acronym, digit-bearing token) or a domain vocabulary
// word. Pure session narration has none of these.
function hasTechnicalSubject(s) {
  // 1. Leading artifact: capture started mid-sentence — junk outright.
  if (GARBAGE_LEAD.test(s)) return false

  // 2. Code-structural token anywhere qualifies. Quoted/backtick strings
  // often span several tokens ("use strict"), so test s as a whole first.
  if (/["'`].+["'`]/.test(s)) return true
  const tokens = s.split(/\s+/)
  for (const raw of tokens) {
    const t = raw.replace(/^[^A-Za-z0-9_.@/`'"-]+|[^A-Za-z0-9_.@/`'"-]+$/g, '')
    if (!t) continue
    if (/\/|\.[A-Za-z][A-Za-z0-9]{1,7}$/.test(t)) return true // path or filename.ext
    if (/^--?-?[\w-]{2,}/.test(t)) return true                // --flag
    if (/_/.test(t)) return true                              // snake_case
    if (/\(\)/.test(raw) || /\([A-Za-z_]/.test(raw)) return true // call syntax
    if (/^[A-Z0-9_-]{3,}$/.test(t) && /[A-Z]/.test(t)) return true // SQLITE_BUSY
    if (/[a-z][A-Z]/.test(t) || /^[A-Z].*[A-Z][a-z]/.test(t)) return true // camelCase or PascalCase
    if (/\d/.test(t) && (/[a-z]/.test(t) || /\d.*\d/.test(t) || t.length > 3)) return true // numbers
  }
  // 3. Domain vocabulary fallback (prefix match) plus plural stems:
  // 'deletes'→'delete', 'queryDies'… strip 'ies'/'es'/'s' when the stem is
  // itself a technical word and the token stays a real word (>=3 chars).
  for (const raw of tokens) {
    const lower = raw.replace(/[^A-Za-z0-9-]/g, '').toLowerCase()
    if (!lower) continue
    if (TECH_SUBJECTS.has(lower)) return true
    for (const t of TECH_SUBJECTS) {
      if (lower.startsWith(t) && lower.length > t.length) return true
    }
    for (const suf of ['ies', 'es', 's']) {
      if (lower.endsWith(suf) && lower.length >= suf.length + 3) {
        if (TECH_SUBJECTS.has(lower.slice(0, -suf.length))) return true
      }
    }
  }
  // 4. Plain prose with no code token and no domain word: junk.
  return false
}

/**
 * Apply the quality gate to a full facet set. Drops invalid text facets
 * (sets them to null). Never fabricates or rewrites. `verifiedOutcome` is
 * validated against the closed enum rather than free text.
 *
 * @returns {{ facets: object, dropped: string[] }}
 */
function qualityGateFacets(raw) {
  const dropped = []
  const out = {}
  for (const key of ['symptom', 'rootCause', 'remedy']) {
    const val = raw?.[key] ?? null
    const gated = qualityGateFacet(val)
    if (val != null && gated === null) dropped.push(key)
    out[key] = gated
  }
  const outcome = raw?.verifiedOutcome ?? null
  if (outcome != null && !VERIFIED_OUTCOMES.has(outcome)) {
    dropped.push('verifiedOutcome')
    out.verifiedOutcome = null
  } else {
    out.verifiedOutcome = outcome
  }
  return { facets: out, dropped }
}


/**
 * Deterministically extract structured causal facets:
 *   symptom → rootCause → remedy → verifiedOutcome
 *
 * Grounding rules:
 *   - rootCause requires explicit causal attribution in text (never inferred from edits alone).
 *   - remedy requires explicit fix/action claim or intent (never inferred from edit tools alone).
 *   - temporal adjacency (test fail → edit → test pass) alone NEVER creates a causal record.
 *   - simultaneous edits do not arbitrarily choose a root cause.
 */
export function extractCausalFacets({ user = '', assistant = '', tools = [], files = [], symbols = [] } = {}) {
  // m00188: mask code spans BEFORE matching — see maskCodeSpans. A regex run on
  // the raw text has already cut at a ';' inside ticks by the time cleanup
  // could have helped.
  const rawCombined = `${user}\n${assistant}`.trim()
  const { text: combined, spans } = maskCodeSpans(rawCombined)
  if (!rawCombined && tools.length === 0) return { facets: null, toolSymptom: false }

  // 1. Root Cause extraction (requires explicit causal attribution)
  let rootCause = null
  // Try each attribution in priority order until one yields a gated facet. The
  // FIRST regex match is not necessarily a usable one: an agent's prose can
  // contain an incidental "the cause was …" phrase that refers to something
  // else, and a single unusable match used to blank the whole facet even when a
  // clean "The bug: <real cause>" followed it. Gating here (not only later)
  // keeps the strongest usable attribution instead of the first textual one.
  for (const re of [
    /\b(?:root\s+cause(?:\s+(?:is|was|:))?|the\s+cause\s+(?:is|was))\s*[:\-—]?\s*([^\n;]+)/i,
    /\b(?:caused\s+by|the\s+reason\s+(?:is|was))\s*[:\-—]?\s*([^\n;]+)/i,
    /\b(?:due\s+to|because\s+of)\s+([^\n;]+)/i,
    /\b(?:the\s+)?(?:bug|defect|culprit)\s+(?:is|was)\s+that\s+([^\n;]+)/i,
    /\b(?:the\s+)?(?:bug|defect|culprit)\s*:\s*([^\n;]+)/i,
    // m00188: "The bug is in retry.mjs: <explanation>" is the other common
    // shape, where the attribution is a location followed by the reason.
    // Requiring text after the colon (`[^\n;]+`) keeps the passive "the bug was
    // fixed" from being read as a cause.
    /\b(?:the\s+)?(?:bug|defect|culprit)\s+(?:is|was)\s+(?:in\s+|that\s+)?[^:\n]{3,}:\s*([^\n;]+)/i,
    // m00188: "loop `<=` causes 4 attempts" is the plainest causal attribution
    // an engineer writes, and the only one whose cause is the SUBJECT rather
    // than the text after a marker — so it captures group 1. Kept last because
    // it is the least specific; the bound stops it swallowing a whole sentence
    // or crossing into the next one. The bare subject is tried first because it
    // is the tighter answer; the whole clause is the fallback for a subject too
    // short to stand alone ("loop <="), which the quality gate rejects.
    // "the root cause IS fields.push" contains the word "cause" but is NOT an
    // "X causes Y" attribution: the verb is "is", not "causes". Without this
    // guard the subject became "The root" and the pattern produced a garbage
    // cause on real agent prose. "cause" must actually be used as a verb here.
    // The subject may contain a PERIOD — real subjects are qualified files
    // ("the stale counter in retry.mjs"). Excluding '.' from the class made
    // "retry.mjs causes …" capture only "mjs". The sentence end is decided by
    // cleanFacetText's boundary rule (a period followed by space), not here.
    // The subject may contain a period (qualified files: "the stale counter in
    // retry.mjs") but must not CROSS a sentence boundary ("A. B causes C" must
    // capture "B", not "A. B"). `(?!\.\s)` is the sentence break; a bare '.'
    // inside a filename is followed by a letter, so it stays in.
    /\b((?:(?!\.\s)[^\n;]){3,80}?)\s+causes\s+(?:[^\n;]+)/i,
    /\b((?:(?!\.\s)[^\n;]){3,80}?\s+causes\s+[^\n;]+)/i,
  ]) {
    const candidate = cleanFacetText(combined.match(re)?.[1], spans)
    // m00188: naming a symbol is not explaining a cause. "The root cause is
    // fields.push." is a pointer, not a diagnosis — it passed the structural
    // gate on length alone and became the stored cause on a real arm, while the
    // agent's actual explanation ("migrateRow mutates module-level fields array
    // by pushing 'email'") sat one pattern further down. A bare single-token
    // reference is skipped so the loop keeps looking.
    // Count WORDS, not characters: "fields.push" is one reference, while
    // "fields.push widens the projection" is an explanation. Punctuation-only
    // differences must not change the verdict, so the token count is what is
    // measured.
    const bareReference = (candidate ?? '').split(/\s+/).filter(Boolean).length === 1
    if (candidate && !bareReference && qualityGateFacet(candidate) !== null) {
      rootCause = candidate
      break
    }
  }

  // 2. Remedy extraction (requires explicit remedy/fix action or statement)
  let remedy = null
  const remedyMatch = combined.match(/\b(?:the\s+)?(?:remedy|solution|workaround)(?:\s+(?:is|was|by))?\s*[:\-—]?\s*([^\n;]+)/i)
    || combined.match(/\b(?:fix(?:ed)?(?:\s+(?:was|is|by))?|resolved\s+by)\s*[:\-—]?\s*([^\n;]+)/i)
    || combined.match(/\b(?:the\s+)?decision\s+is\s+to\s+([^\n;]+)/i)
    || combined.match(/\b(?:always\s+serialize|lock\s+the|serialize\s+the|wrap\s+with)\s+([^\n;]+)/i)

  if (remedyMatch) {
    remedy = cleanFacetText(remedyMatch[1], spans)
  }

  // 3. Symptom extraction
  // `toolSymptom` is internal return metadata: true only when the symptom
  // text itself came from a tool result preview (not from user/assistant
  // text). It lets distillBuffer record the `tool` provenance origin without
  // parsing the rendered body or persisting an extra field.
  let symptom = null
  let toolSymptom = false
  const symptomMatch = combined.match(/\b(?:the\s+)?(?:symptom|issue|problem|bug|error|failure)(?:\s+(?:is|was|:))?\s*[:\-—]?\s*([^\n;]+)/i)
    || combined.match(/\b(?:failing\s+with|failed\s+with|crashed\s+with|flaking\s+on)\s*[:\-—]?\s*([^\n;]+)/i)
    || combined.match(/\b((?:flaky|failing)\s+tests?|sqlite\s+writer\s+race|deadlock|concurrency\s+race|data\s+corruption|memory\s+leak)\b/i)

  if (symptomMatch) {
    symptom = cleanFacetText(symptomMatch[1], spans)
    // m00188: "The bug: X" now feeds BOTH the symptom pattern (its `bug` word)
    // and the root-cause pattern (the attribution). Repeating one sentence as
    // the symptom AND the cause would inflate `facetCount`, which is the
    // invariant's evidence that a turn explained a relationship rather than
    // restating one line. Deduped, a turn still needs an independent facet
    // (`test-passed`, a real remedy) to qualify.
    if (symptom && rootCause && symptom === rootCause) symptom = null
  } else {
    for (const t of tools) {
      if (t.name?.includes(':result')) {
        const prev = String(t.preview || t.output || '')
        const failLine = prev.split('\n').find((l) => /(?:FAIL|npm ERR!|Error:)\s+(.+)/i.test(l))
        if (failLine) {
          symptom = cleanFacetText(failLine, spans)
          toolSymptom = Boolean(symptom)
          break
        }
      }
    }
  }

  // 4. Verified Outcome extraction
  let verifiedOutcome = null
  const outcome = testOutcomeFrom(tools, files)
  if (outcome === 'test-passed') {
    verifiedOutcome = 'test-passed'
  } else if (outcome === 'test-failed') {
    verifiedOutcome = 'test-failed'
  }

  // 5. M12 C2 — Distillation Quality Gate
  // Drop malformed facets at the capture boundary. Structural validation only:
  // never rewrite, never fabricate. Raw evidence (evidence[], source.*) is
  // preserved unchanged by distillBuffer; only the derived causal lines shrink.
  const { facets: gated } = qualityGateFacets({ symptom, rootCause, remedy, verifiedOutcome })
  // If the symptom facet was dropped, a tool-preview symptom no longer contributes.
  const gatedToolSymptom = gated.symptom == null ? false : toolSymptom

  // 6. Invariant & Boundedness Check (evaluated on GATED facets)
  // Invariant: Temporal adjacency alone is NOT causality.
  // An established causal link requires at least one core explanation (rootCause OR remedy)
  // paired with another facet (symptom, rootCause, remedy, verifiedOutcome).
  const hasCoreExplanation = Boolean(gated.rootCause || gated.remedy)
  const facetCount = [gated.rootCause, gated.remedy, gated.symptom, gated.verifiedOutcome].filter(Boolean).length

  if (!hasCoreExplanation || facetCount < 2) {
    return { facets: null, toolSymptom: gatedToolSymptom }
  }

  return { facets: gated, toolSymptom: gatedToolSymptom }
}

export function looksLikeClaim(text) {
  if (typeof text !== 'string' || text.length < 40) return false
  return CLAIM_HINTS.some((re) => re.test(text))
}

/**
 * Does the user's own text assert something about the system, or is it only
 * directing the agent?
 *
 * `looksLikeClaim` is deliberately broad: it answers "does this text CONTAIN a
 * claim hint", which is the right question for titling. It is the wrong
 * question for provenance, because a claim hint inside an instruction ("do not
 * weaken the tests", "never touch the lock file") is a CONSTRAINT on the work,
 * not a user assertion about how the system behaves. Treating those as user
 * claims is what made ordinary task prompts unlearnable (m00188).
 *
 * So this is stricter in one exact way: a sentence only counts as a claim when
 * it is declarative. An imperative sentence never counts, no matter which
 * claim hints it contains. Everything else about the turn — whether the
 * assistant made claims, whether tools ran, whether tests passed — is decided
 * by the caller.
 */
export function userAssertsClaim(text) {
  if (typeof text !== 'string') return false
  const sentences = text
    .split(/(?<=[.!?;])\s+|\n+/)
    .map((s) => s.trim())
    .filter(Boolean)
  for (const sentence of sentences) {
    // Strip the list marker and any task checkbox before classifying, so a
    // bulleted (or checked-off) instruction and the same instruction as prose
    // reach the identical decision. Nothing else about the sentence changes, and
    // the claim hints are still required below.
    const bare = sentence.replace(LIST_MARKER, '').replace(TASK_BOX, '')
    if (bare.length < 12) continue
    if (IMPERATIVE_START.test(bare)) continue
    if (!CLAIM_HINTS.some((re) => re.test(bare))) continue
    return true
  }
  return false
}

export function extractSymbols(text) {
  if (typeof text !== 'string') return []
  const found = []
  SYMBOL_RE.lastIndex = 0
  let match
  while ((match = SYMBOL_RE.exec(text))) found.push(match[1])
  return [...new Set(found)].slice(0, 8)
}

export function extractMentionedPaths(text) {
  if (typeof text !== 'string') return []
  const found = []
  PATH_RE.lastIndex = 0
  let match
  while ((match = PATH_RE.exec(text))) {
    // `..` inside a candidate means PATH_RE greedily ran across a boundary —
    // the real output contained "src/.migrate.mjs...tmpdir", which is two
    // separate tokens glued together. A repository-relative path never needs
    // a `..` segment (and one would be a traversal), so drop the artifact
    // rather than store a path that cannot resolve.
    if (match[1].includes('..')) continue
    found.push(match[1])
  }
  return [...new Set(found)].slice(0, 12)
}

/**
 * Clip text to `max` characters without leaving a half-finished sentence or a
 * half-finished identifier.
 *
 * A blind slice(0, max) is what produced a stored body ending in
 * "compiledVersion = SCHEMA_" — the most misleading thing a memory can do is
 * trail off inside the sentence that carries its own conclusion. Prefer the
 * last sentence boundary before `max`; tolerate a word boundary when the text
 * has no sentence break at all, and only fall back to a hard cut when even
 * that would throw away most of the budget.
 */
function clipAtSentence(text, max) {
  const s = String(text ?? '')
  if (s.length <= max) return s
  const window = s.slice(0, max)
  // A sentence ends at punctuation FOLLOWED BY whitespace; `mjs.`, `v1.2` and
  // `e.g.` have no whitespace after the period, so they never count.
  const sentenceEnd = Math.max(
    window.lastIndexOf('. '), window.lastIndexOf('.\n'),
    window.lastIndexOf('? '), window.lastIndexOf('! '),
  )
  if (sentenceEnd >= max * 0.4) return window.slice(0, sentenceEnd + 1).trimEnd()
  const wordEnd = Math.max(window.lastIndexOf(' '), window.lastIndexOf('\n'))
  if (wordEnd >= max * 0.4) return window.slice(0, wordEnd).trimEnd()
  return window
}

function classifySignal(text, causal = null) {
  if (causal?.rootCause || CAUSE_HINTS.test(text)) return 'root-cause'
  if (causal?.remedy || FIX_HINTS.test(text)) return 'fix'
  if (DECISION_HINTS.test(text)) return 'decision'
  return 'observation'
}

export function deriveTitle(user, files, tools, signal, causal = null) {
  // A user line is a title only when the user is ASSERTING something. An
  // instruction ("investigate why, fix it, do not weaken the tests") merely
  // contains claim hints, and echoing it made every task prompt into the
  // observation's name (m00188). Declarative user claims still win, because a
  // user's own words are the most traceable title there is.
  const firstLine = String(user || '').split('\n').map((s) => s.trim()).find(Boolean)
  if (firstLine && firstLine.length >= 12 && userAssertsClaim(firstLine)) return firstLine.slice(0, 160)
  
  // Genuine causal claims from text — the only reliable engineering titles.
  // P0-2: only when the facet itself survives the concreteness gate, otherwise
  // every "fix is for X" regex artifact became a "Fix: <garbage>" title.
  if (causal?.remedy && qualityGateFacet(causal.remedy)) return `Fix: ${causal.remedy.slice(0, 120)}`
  if (causal?.rootCause && qualityGateFacet(causal.rootCause)) {
    // m00188: a facet may carry its own short label ("Two bugs: loop <= causes
    // 4 attempts"). Prefixing that verbatim produced a double colon title,
    // "Cause: Two bugs: …". The label adds nothing once the title already says
    // "Cause:", so it is dropped from the TITLE only — the stored facet keeps
    // the author's full sentence. The label must be BARE WORDS: allowing dots
    // and slashes made "src/migrate.mjs:5: migrateRow …" read as a label and
    // cut the title down to "5: migrateRow …".
    const labelled = causal.rootCause.match(/^([A-Za-z][A-Za-z'-]*(?:\s+[A-Za-z][A-Za-z'-]*){0,3}):\s+(\S.+)$/)
    const body = (labelled ? labelled[2] : causal.rootCause).slice(0, 120)
    return `Cause: ${body}`
  }
  
  // Bugfix with actual files modified: use the user's bug description as the title.
  // Traceable (the user said it), not fabricated — files confirm actual code changes.
  if (signal === 'fix' && files?.length > 0 && firstLine && firstLine.length >= 12 && userAssertsClaim(firstLine)) {
    return firstLine.slice(0, 160)
  }

  // No reliable claim found → neutral, non-misleading fallback
  // Never generate "Fix: work on X", "Worked on X", "Used X" — those are activity descriptions, not engineering claims
  return 'Engineering observation'
}

function basename(path) {
  const parts = String(path).split(/[\\/]/)
  return parts[parts.length - 1] || path
}

function isCorrectiveToolCall(t) {
  const n = String(t?.name || '').split(':')[0]
  if (n === 'edit' || n === 'write' || n === 'str_replace_editor') return true
  // run_code can mutate files but we only have structured args/description;
  // treat it as corrective only when it explicitly signals an edit/write.
  if (n === 'run_code') {
    const args = t?.args && typeof t.args === 'object' ? t.args : {}
    return /(?:edit|write)/i.test(String(args.description || '')) || /(?:tools\.edit|tools\.write)/.test(String(args.code || ''))
  }
  return false
}

/**
 * Read one test-run preview and decide whether it reports failure or success.
 *
 * Found by driving a real agent (m00188). Node's own reporter was misread:
 *
 *  - Node puts the COUNT AFTER THE WORD — `ℹ fail 1`, `ℹ pass 2` — while the
 *    other shapes Veyra already supported put it before (`1 failed`,
 *    `0 failed`). The old regex only knew the leading form, so a genuinely
 *    failing suite (`✔ …` / `✖ …` / `ℹ pass 1` / `ℹ fail 1`) scored as a PASS
 *    and the record was stamped `verified-test`. A failed run must never look
 *    verified.
 *  - `node --test` emits no `[exit code: N]` line at all, so the exit-code
 *    signal the old code leaned on is absent there.
 *
 * Errors fail closed: any failure marker wins over any success marker.
 */
function readTestResult(preview) {
  const text = String(preview || '')

  const failed = /\b[1-9]\d*\s+fail(?:ed|ures?)?\b/i.test(text)
    || /(?:^|[\s\u2139#])fail(?:ed|ures?)?\s*[:=]?\s*[1-9]\d*\b/im.test(text)
    || /\bFAIL\b/.test(text)
    || /failing tests:/.test(text)
    || /[\u2716\u2717]/.test(text)
    || /(?<!\b0\s)exit code:\s*[1-9]/i.test(text)
    || /npm[\s\S]{0,20}ERR!/i.test(text)
  if (failed) return { failed: true, passed: false }

  const zeroFailed = /\b0\s+fail(?:ed|ures?)?\b/i.test(text)
    || /(?:^|[\s\u2139#])fail(?:ed|ures?)?\s*[:=]?\s*0\b/im.test(text)
  const passed = zeroFailed
    || /(?:[\u2714\u2713]|\bpass(?:ed)?\b|\bok\b|All tests passed)/i.test(text)
  return { failed: false, passed }
}

function testOutcomeAnalysis(tools, files) {
  let hasTestTool = false
  let sawFailure = false
  let sawPass = false
  let correctiveAfterFailure = false
  let recoveredPass = false
  let failureSeen = false

  for (const t of tools || []) {
    const name = String(t.name || '')
    const cmd = String(t.args?.command || '')
    const desc = String(t.args?.description || '')
    const isTestCall = /test/i.test(name) || /test|spec/i.test(cmd) || /test|spec/i.test(desc)
    if (isTestCall) hasTestTool = true

    if (!name.includes(':result') && isCorrectiveToolCall(t) && failureSeen) {
      correctiveAfterFailure = true
    }

    if (name.includes(':result')) {
      const prev = String(t.preview || '')
      const { failed, passed } = readTestResult(prev)
      if (failed) {
        sawFailure = true
        failureSeen = true
        correctiveAfterFailure = false
        recoveredPass = false
      }
      if (passed) {
        sawPass = true
        if (failureSeen && correctiveAfterFailure) recoveredPass = true
      }
    }
  }

  // Preserve failure history. A later pass may represent final verification only
  // when existing ordered events show a failure, an identifiable corrective
  // action (edit/write/str_replace_editor/run_code), and then a passing result.
  // Failure without that evidence remains a failed attempt (no inferred recovery).
  let outcome = null
  if (sawFailure && !(recoveredPass && correctiveAfterFailure)) outcome = 'test-failed'
  else if (sawPass || recoveredPass) outcome = 'test-passed'
  else if (hasTestTool || (files || []).some((f) => /test|spec/i.test(f))) outcome = 'tests-touched'

  return { outcome, hadFailure: sawFailure, recovered: sawFailure && recoveredPass && correctiveAfterFailure }
}

function testOutcomeFrom(tools, files) {
  return testOutcomeAnalysis(tools, files).outcome
}

// Evidence anchors carry repository-code weight: trust validation resolves them
// against the workspace. Paths outside the workspace must stay in source
// provenance (source.files) but never become {path} anchors.
//
// Anchors are stored REPOSITORY-RELATIVE. An absolute anchor bakes the
// capture-time checkout into the record, so the moment the record is reused
// from another repository — which is exactly what Central Memories are for —
// the anchor resolves to nothing and the knowledge reads as invalid. The
// relative form is verifiable in the origin checkout AND re-verifiable
// elsewhere, which is the only shape that can be re-checked rather than
// trusted on faith.
function repoRelativeAnchor(workspace, path) {
  if (!workspace || !isAbsolute(path)) return path
  try {
    return resolveSafeRepoPath(workspace, path) || null
  } catch {
    return null
  }
}

function evidenceFrom(files, symbols, tools, workspace = null) {
  const items = []
  for (const path of files.slice(0, 12)) {
    const anchor = repoRelativeAnchor(workspace, path)
    // null = the path escaped the workspace: it stays in source.files
    // provenance and never becomes a code anchor.
    if (!anchor) continue
    items.push({ path: anchor })
  }
  for (const symbol of symbols.slice(0, 8)) {
    items.push({ note: `sym:${symbol}` })
  }
  const { outcome, hadFailure, recovered } = testOutcomeAnalysis(tools, files)
  // Preserve historical failure evidence. A later pass may represent final
  // verification only when supported by ordered failure -> corrective action
  // -> pass evidence; the earlier failure must never be silently discarded.
  if (hadFailure) items.push({ note: 'test-failed' })
  if (outcome === 'test-passed' || recovered) items.push({ note: 'test-passed' })
  else if (outcome === 'tests-touched' && !hadFailure) items.push({ note: 'tests-touched' })
  return items
}

function tagsFor(signal, files, tools, causal = null) {
  const tags = ['observation', 'auto', signal]
  if (causal) {
    tags.push('causal')
    if (causal.rootCause) tags.push('has-root-cause')
    if (causal.remedy) tags.push('has-remedy')
    if (causal.symptom) tags.push('has-symptom')
  }
  if (files.some((p) => /test|spec/i.test(p))) tags.push('tested')
  const outcome = testOutcomeFrom(tools, files)
  if (outcome === 'test-passed') tags.push('verified-test')
  const names = new Set(tools.map((t) => String(t.name).split(':')[0]))
  const hasEdit = names.has('edit') || names.has('write') || names.has('str_replace_editor')
    || tools.some((t) => String(t.name).split(':')[0] === 'run_code' && (
      /(?:edit|write)/i.test(t.args?.description || '') || /(?:tools\.edit|tools\.write)/.test(t.args?.code || '')
    ))
  if (hasEdit) tags.push('edited')
  return [...new Set(tags)].slice(0, 16)
}

/**
 * Distill a buffered turn into a candidate observation payload.
 * Returns null when the turn has no engineering signal.
 *
 * Never assigns derived/canonical authority.
 */
export function distillBuffer(buffer, { projectId, sessionId, cwd, agent } = {}) {
  if (!buffer) return null
  const user = (buffer.user || []).join('\n').trim()
  const assistant = (buffer.assistant || []).join('\n').trim()
  // Modification evidence, and nothing else. `buffer.files` is fed only by tool
  // calls that can actually write (see `mutatesFiles` in observe.mjs). Prose
  // paths used to be merged in here, which made a sentence like "the bug is in
  // src/codec.mjs" read as an edited file: the record then claimed it changed
  // files that were only read or merely named (m00191, found as A7 in m00190).
  // A path said in passing is a reference, not evidence of a change.
  const files = [...new Set(buffer.files || [])].slice(0, 12)
  // Analysis sees EVERY tool event. The old `slice(0, 16)` was meant to bound
  // the stored metadata, but it silently cut the evidence out of the analysis:
  // a real 26-event session kept its two `npm test` runs at indices 19 and 23,
  // so the distiller never saw the pass/fail outcome and a fix could not be
  // recognized as test-verified. The stored name list keeps its own cap below.
  const tools = (buffer.tools || []).slice()
  const storedTools = tools.slice(0, 16)
  const symbols = extractSymbols(`${user}\n${assistant}`)
  const combined = `${user}\n${assistant}`.trim()
  const meaningfulTools = tools.filter((t) => {
    const name = String(t.name).split(':')[0]
    return name === 'bash' || name === 'edit' || name === 'write' || name === 'read'
      || name === 'grep' || name === 'glob' || name === 'str_replace_editor' || name === 'run_code'
  })

  const hasClaim = looksLikeClaim(combined)
  if (meaningfulTools.length < 1 && user.length < 80 && !hasClaim) return null
  if (!hasClaim && meaningfulTools.length < 2 && user.length < 80) return null

  const { facets: causal, toolSymptom } = extractCausalFacets({ user, assistant, tools, files, symbols })
  const signal = classifySignal(combined, causal)
  const title = deriveTitle(user, files, tools, signal, causal)
  const bodyParts = []
  if (user) bodyParts.push(clipAtSentence(user, 1200))
  // Include assistant text when it describes an actual fix (fix signal + files modified),
  // even without independent claim hints — the fix description is traceable engineering content.
  //
  // m00188: `root-cause` belongs here too. A prompt like "investigate why the
  // suite fails" trips CAUSE_HINTS on the word "why", so the signal is
  // `root-cause` while `looksLikeClaim(assistant)` stays false for a terse
  // "Two bugs: the loop is off by one" analysis. The `fix`-only branch then
  // dropped every word the agent wrote, and the stored record was the task
  // prompt plus a file list — an "engineering memory" that teaches nothing.
  // Modified files are still required, so pure chatter is never captured.
  const describesWork = (signal === 'fix' || signal === 'root-cause') && files.length > 0
  if (assistant && (looksLikeClaim(assistant) || describesWork)) {
    bodyParts.push(`Agent: ${clipAtSentence(assistant, 600)}`)
  }
  if (causal) {
    const causalLines = []
    if (causal.symptom) causalLines.push(`Symptom: ${causal.symptom}`)
    if (causal.rootCause) causalLines.push(`Root cause: ${causal.rootCause}`)
    if (causal.remedy) causalLines.push(`Remedy: ${causal.remedy}`)
    if (causal.verifiedOutcome) causalLines.push(`Verified outcome: ${causal.verifiedOutcome}`)
    if (causalLines.length) {
      bodyParts.push(causalLines.join('\n'))
    }
  }
  if (files.length) bodyParts.push(`Files touched: ${files.join(', ')}`)
  if (symbols.length) bodyParts.push(`Symbols: ${symbols.join(', ')}`)
  if (storedTools.length) {
    // The body's tool line summarizes stored metadata, so it keeps the stored
    // cap — widening the analysis above must not rewrite historical bodies.
    const names = [...new Set(storedTools.map((t) => t.name))].slice(0, 8)
    bodyParts.push(`Tools: ${names.join(', ')}`)
  }
  const body = scrub(bodyParts.join('\n\n')).scrubbed
  if (body.length < MIN_OBSERVATION_CHARS) return null

  const tokens = [...tokenize(`${title}\n${body}`)].slice(0, 24)

  // M8 capture provenance: which source streams materially contributed
  // text/content to this record. `user`/`assistant` follow stream
  // non-emptiness (everything each stream contributed went through the
  // distillation above). `tool` is set only when tool-originated CONTENT is
  // in the record: a preview-sourced causal symptom line, or an
  // activity-only record with both role streams empty (body synthesized
  // from tool activity). Tool/file/symbol names in derived metadata never
  // add `tool`. Canonical order comes from PROVENANCE_ORIGINS.
  const toolContent = (!user && !assistant) || (Boolean(causal) && toolSymptom)
  const origins = PROVENANCE_ORIGINS.filter((origin) => (
    origin === 'user' ? Boolean(user)
      : origin === 'assistant' ? Boolean(assistant)
        : toolContent
  ))

  // User context-only: user provided task background but made no engineering
  // claims; assistant produced claims/causal with evidence (tools/files).
  // This allows safe auto-learning from normal coding turns while keeping
  // pure user statements blocked. Flag is on source (not inside provenance)
  // to preserve m8 provenance shape assertions.
  //
  // m00188: `userAssertsClaim`, not `looksLikeClaim`. An instruction that
  // happens to contain a claim hint ("do not weaken the tests") is a
  // constraint on the work, not a user assertion about the system — treating
  // it as one made every task prompt that carries a guardrail unlearnable.
  const userClaimBearing = Boolean(user) && userAssertsClaim(user)
  const userContextOnly = Boolean(user) && !userClaimBearing && Boolean(assistant) && (hasClaim || Boolean(causal) || meaningfulTools.length > 0)

  return {
    kind: KINDS.OBSERVATION,
    status: STATUSES.CURRENT,
    validation: VALIDATIONS.UNVERIFIED,
    authority: AUTHORITIES.CANDIDATE,
    confidence: hasClaim ? CONFIDENCES.MEDIUM : CONFIDENCES.LOW,
    scope: SCOPES.PROJECT,
    projectId,
    title,
    body,
    tags: tagsFor(signal, files, tools, causal),
    evidence: evidenceFrom(files, symbols, tools, cwd || null),
    source: {
      sessionId: sessionId || null,
      turn: buffer.turn,
      // §15 — origins stay the canonical capture-stream bag; workspace/
      // repository/agent dimensions stamp only when a cwd was supplied,
      // so legacy call sites stay byte-identical (unknown stays unknown).
      provenance: { origins, ...(cwd ? provenanceDimensions(cwd, agent) : {}) },
      tools: storedTools.map((t) => t.name),
      files,
      symbols,
      signal,
      tokens,
      automatic: true,
      causal: causal || null,
      ...(userContextOnly ? { userContextOnly: true } : {}),
    },
  }
}
