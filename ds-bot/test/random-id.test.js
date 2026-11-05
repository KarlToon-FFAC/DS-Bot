import assert from 'node:assert/strict'
import { test } from 'node:test'
import { randomId } from '../src/client/random-id.js'

test('LAN HTTP identifiers use secure random values and RFC 4122 v4 bits', () => {
  let calls = 0
  const source = { getRandomValues(bytes) { calls++; return globalThis.crypto.getRandomValues(bytes) } }
  const ids = Array.from({length:1000}, () => randomId(source))
  assert.equal(calls,1000)
  assert.equal(new Set(ids).size,1000)
  for(const id of ids) assert.match(id,/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/)
})
test('native secure UUID is used; unavailable or failing randomness fails closed', () => {
  assert.equal(randomId({randomUUID:()=> 'native-id'}),'native-id')
  for(const source of [null,{}, {getRandomValues(){throw Error('private failure')}}]) {
    assert.throws(()=>randomId(source),{code:'SECURE_RANDOM_UNAVAILABLE',message:'Secure random identifiers are unavailable.'})
  }
})
