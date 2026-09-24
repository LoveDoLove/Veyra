/**
 * Veyra — secret redaction.
 *
 * Adapted from Project-Memory-Agent `src/policy/isolation.mjs`
 * (`scrubExportPatterns`) and OpenViking's credential placeholderization.
 * Every write path runs through this before persistence. Untrusted
 * remembered content is never stored as a raw secret.
 */

const PATTERNS = [
  {
    name: 'bearer_jwt_token',
    regex: /Bearer\s+[A-Za-z0-9\-_=]+\.[A-Za-z0-9\-_=]+\.?[A-Za-z0-9\-_=]*/g,
    replace: 'Bearer [REDACTED_TOKEN]',
  },
  {
    name: 'secret_key_assignment',
    regex: /(api[_-]?key|secret|password|passwd|token|auth[_-]?token|access[_-]?key|private[_-]?key)\s*[:=]\s*["']([^"']{8,})["']/gi,
    replace: '$1: "[REDACTED_SECRET]"',
  },
  {
    name: 'prefixed_api_token',
    regex: /\b(ghp_[A-Za-z0-9]{36}|gho_[A-Za-z0-9]{36}|ghu_[A-Za-z0-9]{36}|github_pat_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{16}|xox[baprs]-[A-Za-z0-9-]{10,})\b/g,
    replace: '[REDACTED_KEY]',
  },
  {
    name: 'pem_private_key',
    regex: /-----BEGIN [A-Z\s]+ PRIVATE KEY-----[\s\S]*?-----END [A-Z\s]+ PRIVATE KEY-----/g,
    replace: '[REDACTED_PRIVATE_KEY]',
  },
  {
    name: 'env_assignment',
    regex: /\b([A-Z][A-Z0-9_]*(?:SECRET|TOKEN|PASSWORD|PASSWD|API_KEY|ACCESS_KEY)[A-Z0-9_]*)\s*=\s*["']?([^\s"']{8,})["']?/g,
    replace: '$1=[REDACTED_ENV]',
  },
]

/**
 * Scrub secrets from a string. Always returns a result object so callers
 * can decide whether to refuse persistence when redactions occurred.
 *
 * @param {unknown} content
 * @returns {{ clean: boolean, scrubbed: string, redactionsCount: number, detectedPatterns: string[] }}
 */
export function scrub(content) {
  if (typeof content !== 'string') {
    return { clean: true, scrubbed: '', redactionsCount: 0, detectedPatterns: [] }
  }

  let scrubbed = content
  let redactionsCount = 0
  const detectedPatterns = []

  for (const pattern of PATTERNS) {
    pattern.regex.lastIndex = 0
    if (pattern.regex.test(scrubbed)) {
      detectedPatterns.push(pattern.name)
      pattern.regex.lastIndex = 0
      const before = scrubbed
      scrubbed = scrubbed.replace(pattern.regex, pattern.replace)
      if (scrubbed !== before) redactionsCount++
    }
  }

  return {
    clean: redactionsCount === 0,
    scrubbed,
    redactionsCount,
    detectedPatterns,
  }
}

/** Convenience: return only the scrubbed string. */
export function redact(content) {
  return scrub(content).scrubbed
}
