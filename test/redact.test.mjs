import { test } from 'node:test'
import assert from 'node:assert/strict'
import { redact, scrub } from '../src/redact.mjs'

test('scrubs bearer JWTs', () => {
  const result = scrub('Authorization: Bearer aaa.bbb.ccc leftover')
  assert.equal(result.clean, false)
  assert.ok(result.detectedPatterns.includes('bearer_jwt_token'))
  assert.equal(result.scrubbed.includes('aaa.bbb.ccc'), false)
  assert.ok(result.scrubbed.includes('[REDACTED_TOKEN]'))
})

test('scrubs secret assignments', () => {
  const result = scrub('api_key = "supersecretvalue"')
  assert.equal(result.clean, false)
  assert.ok(result.scrubbed.includes('[REDACTED_SECRET]'))
  assert.equal(result.scrubbed.includes('supersecretvalue'), false)
})

test('scrubs GitHub and AWS prefixes', () => {
  const ghp = `ghp_${'a'.repeat(36)}`
  const akia = 'AKIAIOSFODNN7EXAMPLE'
  const result = scrub(`token ${ghp} and ${akia}`)
  assert.equal(result.clean, false)
  assert.equal(result.scrubbed.includes(ghp), false)
  assert.equal(result.scrubbed.includes(akia), false)
})

test('scrubs PEM private keys', () => {
  const pem = '-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA\n-----END RSA PRIVATE KEY-----'
  const result = scrub(pem)
  assert.equal(result.clean, false)
  assert.ok(result.scrubbed.includes('[REDACTED_PRIVATE_KEY]'))
  assert.equal(result.scrubbed.includes('MIIEowIBAAKCAQEA'), false)
})

test('leaves ordinary engineering text alone', () => {
  const text = 'The race was in the sqlite writer. Fix: serialize puts behind a mutex.'
  const result = scrub(text)
  assert.equal(result.clean, true)
  assert.equal(result.scrubbed, text)
  assert.equal(redact(text), text)
})

test('non-string input is treated as empty and clean', () => {
  assert.deepEqual(scrub(null), { clean: true, scrubbed: '', redactionsCount: 0, detectedPatterns: [] })
})
