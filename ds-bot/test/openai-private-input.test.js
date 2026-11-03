import assert from 'node:assert/strict'
import { test } from 'node:test'
import { randomBytes } from 'node:crypto'
import { consumePrivateInput, rehearsePrivateInput } from '../dev/communication/openai-private-input.mjs'

test('private input is consumed once, removed before use and never appears in rehearsal output', () => {
  const secret = randomBytes(32).toString('hex'), environment = { DSBOT_COMMUNICATION_OPENAI_INPUT: secret }
  const result = rehearsePrivateInput(environment)
  assert.deepEqual(environment, {})
  assert.equal(JSON.stringify(result).includes(secret), false)
  assert.equal(result.networkCalls, 0); assert.equal(result.credentialDiscarded, true)
  assert.throws(() => consumePrivateInput(environment), { code: 'INPUT_INVALID' })
})

test('invalid input is removed even when validation fails, with a fixed nonsecret error', () => {
  for (const value of [undefined, '', 'short', 'synthetic-value-with whitespace']) {
    const environment = { DSBOT_COMMUNICATION_OPENAI_INPUT: value }
    assert.throws(() => consumePrivateInput(environment), error => error.code === 'INPUT_INVALID' && error.message === 'INPUT_INVALID')
    assert.deepEqual(environment, {})
  }
})
