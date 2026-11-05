import assert from 'node:assert/strict'
import { test } from 'node:test'
import { benchResponseValue } from '../dev/communication/bench-client.mjs'

test('bench client returns successful API values unchanged', () => {
  const value = { contacts: [] }
  assert.equal(benchResponseValue({ ok: true, value }), value)
})

test('bench client preserves structured denial codes independently of public message wording', () => {
  assert.throws(() => benchResponseValue({ ok: false, error: { code: 'SPEAKING_FORBIDDEN', message: 'You have read-only access to this group.' } }), error => {
    assert.equal(error.code, 'SPEAKING_FORBIDDEN')
    assert.equal(error.message, 'SPEAKING_FORBIDDEN')
    return true
  })
})

test('bench client does not expose unknown exception codes or messages', () => {
  for (const data of [undefined, {}, { ok: false, error: { code: 'PRIVATE_EXCEPTION_CODE', message: 'PRIVATE_EXCEPTION_MESSAGE' } }]) {
    assert.throws(() => benchResponseValue(data), error => {
      assert.equal(error.code, 'COMMUNICATION_UNAVAILABLE')
      assert.doesNotMatch(String(error), /PRIVATE_EXCEPTION/)
      return true
    })
  }
})
