import assert from 'node:assert/strict'
import { test } from 'node:test'
import { install } from '../src/host/communication.js'

test('unconfigured instances expose only authenticated Human setup routes without enrolling or adding Bot tools', async () => {
  let route, loaded = 0
  const rt = { config: {}, teamTools: [], load: async () => { loaded++ }, refresh: async () => {},
    ctx: { effect: fn => fn(), connection: { fetch: { register: value => { route = value; return () => {} } } } } }
  install(rt)
  assert.equal(rt.teamTools.length, 0)
  const call = async body => (await route.fetch(new Request('http://127.0.0.1/api/communication', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }))).json()
  assert.equal((await call({ endpoint: 'state' })).value.enabled, false)
  const url = 'wss://hub.example.test/communication', hubId = 'synthetic-hub'
  const hubCode = 'dsbot-hub:1:' + Buffer.from(JSON.stringify({ hubId, url })).toString('base64url')
  const decoded = await call({ endpoint: 'decode-hub-code', hubCode })
  assert.equal(decoded.ok, true)
  assert.equal(decoded.value.url, url)
  assert.equal(decoded.value.hubId, hubId)
  assert.equal(loaded, 0)
  const forged = await call({ endpoint: 'join-hub', principalId: 'human:other:user', hubCode })
  assert.equal(forged.error.code, 'AUTHOR_MISMATCH')
  const relax = await call({ endpoint: 'decode-hub-code', hubCode, allowLoopback: true })
  assert.equal(relax.error.code, 'AUTHOR_MISMATCH')
  assert.equal(loaded, 0)
})
