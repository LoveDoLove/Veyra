/**
 * Integration #4 — validated PII redaction (redaction depth).
 *
 * Veyra's redactor catches credentials of known shape (bearer tokens,
 * prefixed API keys, PEM blocks, quoted secret assignments, env assignments)
 * but nothing that is only identifiable by a CHECKSUM or a STRUCTURAL RULE.
 * Measured before this change: a Luhn-valid payment card, a valid ISO-13616
 * IBAN and a structurally valid US SSN all passed `scrub()` unchanged with
 * `clean: true` — they were persisted verbatim into engineering memory.
 *
 * Reference: mnemon `internal/safety/mask.go` (Apache-2.0) — "patterns,
 * checksums, no model". Adopted: the detection idea and the validators
 * (Luhn checksum, IBAN ISO-13616 mod-97 checksum, SSN structural rules —
 * the SSN has no checksum; it is validated by its section rules instead).
 * Rejected from that reference: its "ending in NNNN" replacement style, which
 * echoes real digits into persisted memory. Veyra keeps its fixed
 * `[REDACTED_*]` placeholders and never echoes any part of the value.
 * Rejected too: its email/phone/account/passport/license rules — measured
 * against this repository, the email rule alone would rewrite the ordinary
 * engineering string `git@github.com`, and none of those kinds carry the
 * precision a checksum gives.
 *
 * Precision is part of the contract, not an afterthought: redaction that
 * mangles ordinary engineering text destroys the memory it is meant to
 * protect. A bare run of 13-19 digits is therefore only treated as a card
 * when it carries card grouping or sits next to a payment context word;
 * otherwise a 19-digit snowflake id that happens to pass Luhn would be
 * silently destroyed.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { scrub } from '../src/redact.mjs'
import { openEphemeralStore } from '../src/store.mjs'
import { AUTHORITIES } from '../src/types.mjs'

const CARD_VISA = '4111 1111 1111 1111'
const CARD_COMPACT = '4111111111111111'
const CARD_AMEX = '378282246310005'
const CARD_MC = '5555555555554444'
const IBAN_DE = 'DE89370400440532013000'
const SSN = '123-45-6789'

test('a Luhn-valid payment card is redacted, whatever its grouping', () => {
  for (const card of [CARD_VISA, CARD_COMPACT, CARD_AMEX, CARD_MC]) {
    const text = `The refund fixture charged ${card} against the sandbox ledger.`
    const result = scrub(text)
    assert.equal(result.clean, false, `card was not detected: ${card}`)
    assert.ok(result.detectedPatterns.includes('payment_card'), `kind not reported for ${card}`)
    assert.equal(result.scrubbed.includes(card.replace(/[ -]/g, '')), false, `card digits survived: ${card}`)
    assert.equal(result.scrubbed.includes('4111'), false)
    assert.ok(result.scrubbed.includes('[REDACTED_CARD]'), `placeholder missing for ${card}`)
    assert.ok(result.scrubbed.includes('sandbox ledger'), 'surrounding text must survive')
  }
})

test('a bare card-shaped digit run needs payment context to count', () => {
  const withContext = scrub('The card 4111111111111111 was declined by the processor.')
  assert.equal(withContext.clean, false)
  assert.ok(withContext.scrubbed.includes('[REDACTED_CARD]'))

  // A 19-digit snowflake id that happens to satisfy Luhn is an identifier,
  // not a card: no grouping, no payment word.
  const snowflake = '1730599999999999999'
  const withoutContext = scrub(`Snowflake id ${snowflake} was written by the event bus.`)
  assert.equal(withoutContext.clean, true, 'an unanchored digit run must not be redacted')
  assert.ok(withoutContext.scrubbed.includes(snowflake))

  // Grouping alone is not enough either: this table row is grouped 4-4-4-4 and
  // passes Luhn, but no card IIN starts with 1. Measured before this rule.
  const tableRow = scrub('table row 1000 2000 3000 4000 col')
  assert.equal(tableRow.clean, true, 'a grouped non-card identifier must not be redacted')
  assert.ok(tableRow.scrubbed.includes('1000 2000 3000 4000'))

  // Explicit payment wording stays decisive, whatever the grouping.
  const contextual = scrub('charge 1730599999999999999 for the order')
  assert.equal(contextual.clean, false)
  assert.ok(contextual.scrubbed.includes('[REDACTED_CARD]'))
})

// CARD_CONTEXT must key on whole payment words. Measured before the word
// boundary fix: every one of these strings redacted its Luhn-valid number
// because a payment word was a substring of the ordinary word ("card" in
// "discard", "paid" in "unpaid", "charge" in "discharge", ...).
test('card context is whole words, not substrings', () => {
  for (const input of [
    'discard 4111111111111111 from the fixture list',
    'unpaid balance 4111111111111111 in the ledger',
    'cardboard 4111111111111111 on the shelf',
    'discharge curve 4111111111111111 of the cell',
    'recharge job 4111111111111111 in the queue',
    'accredit 4111111111111111 to the account',
    'wildcard 4111111111111111 in the allowlist',
    'charging the battery id 4111111111111111',
    'discover the 4111111111111111 record',
  ]) {
    const result = scrub(input)
    assert.equal(result.redactionsCount, 0, input)
    assert.equal(result.clean, true, input)
    assert.equal(result.scrubbed, input, input)
  }
})

test('whole payment words still provide card context', () => {
  for (const input of [
    'the card 4111111111111111 was declined',
    'credit card 4111111111111111 on file',
    'American Express 378282246310005 for the payout',
    'billing 5555555555554444 was reviewed',
    'the transactions 4111111111111111 settled',
    'refunded 4111111111111111 to the buyer',
    'PAN 4111111111111111 in the report',
    'cc_num 5555555555554444 in the fixture',
  ]) {
    const result = scrub(input)
    assert.equal(result.clean, false, input)
    assert.ok(result.scrubbed.includes('[REDACTED_CARD]'), input)
  }
})

test('a card-shaped number that fails Luhn is left alone', () => {
  const text = 'The invoice id 4111111111111112 belongs to the billing batch.'
  const result = scrub(text)
  assert.equal(result.clean, true)
  assert.equal(result.scrubbed, text)
})

test('a valid IBAN is redacted and a broken check digit is not', () => {
  const good = scrub(`The payout fixture used ${IBAN_DE} for the transfer.`)
  assert.equal(good.clean, false)
  assert.ok(good.detectedPatterns.includes('iban'))
  assert.equal(good.scrubbed.includes('DE89370400440532013000'), false)
  assert.ok(good.scrubbed.includes('[REDACTED_IBAN]'))

  const broken = scrub('The payout fixture used DE89370400440532013001 for the transfer.')
  assert.equal(broken.clean, true)
  assert.ok(broken.scrubbed.includes('DE89370400440532013001'))
})

test('a structurally valid US SSN is redacted and an impossible one is not', () => {
  const good = scrub(`The trace payload leaked ${SSN} into the log line.`)
  assert.equal(good.clean, false)
  assert.ok(good.detectedPatterns.includes('ssn'))
  assert.equal(good.scrubbed.includes(SSN), false)
  assert.ok(good.scrubbed.includes('[REDACTED_SSN]'))

  for (const impossible of ['000-12-3456', '666-12-3456', '900-12-3456', '123-00-6789', '123-45-0000']) {
    const result = scrub(`Ticket ${impossible} was rejected by validation.`)
    assert.equal(result.clean, true, `impossible SSN was redacted: ${impossible}`)
  }
})

test('ordinary engineering text survives untouched', () => {
  const samples = [
    'The race was in the sqlite writer. Fix: serialize puts behind a mutex.',
    'sha 3f786850e387550fdab836ed7e6dc881de23001b on branch main',
    'version 0.1.68 to 0.1.69 keeps the schema stable',
    'uuid 123e4567-e89b-12d3-a456-426614174000 was reused across runs',
    'duration 2026-11-03T23:22:51+08:00 with timeout 30000 ms',
    'HTTP 429 from port 3080 after 5 retries',
    'epoch 1759912345678901234 and build 20261103232251',
    'git@github.com is the remote and ops@example.com is the contact',
  ]
  for (const text of samples) {
    const result = scrub(text)
    assert.equal(result.clean, true, `ordinary engineering text was redacted: ${text}`)
    assert.equal(result.scrubbed, text)
    assert.deepEqual(result.detectedPatterns, [])
  }
})

test('redaction reaches persistence through the store write path', () => {
  const store = openEphemeralStore()
  try {
    const inputBody = `The sandbox charged ${CARD_VISA} and the payout used ${IBAN_DE}; the operator SSN is ${SSN}.`
    const written = store.put({
      title: 'Refund fixture used a live card',
      body: inputBody,
      authority: AUTHORITIES.DERIVED,
    })
    const row = written.record
    const persisted = [row.title, row.body, JSON.stringify(row.evidence), JSON.stringify(row.source)].join('\n')
    assert.equal(persisted.includes('4111 1111 1111 1111'), false, 'card survived persistence')
    assert.equal(persisted.includes('4111111111111111'), false, 'card digits survived persistence')
    assert.equal(persisted.includes(IBAN_DE), false, 'IBAN survived persistence')
    assert.equal(persisted.includes(SSN), false, 'SSN survived persistence')
    assert.equal(written.redacted, true)

    // The kinds are reported by scrub() on the input text. Note that
    // store.put() also computes record.detectedPatterns, but the memory table
    // has no column for it, so it is write-time metadata that does not survive
    // read-back — a pre-existing property of the store, not something this
    // change touches.
    const kinds = scrub(inputBody).detectedPatterns
    for (const kind of ['payment_card', 'iban', 'ssn']) {
      assert.ok(kinds.includes(kind), `kind not reported: ${kind}`)
    }
  } finally {
    store.close()
  }
})
