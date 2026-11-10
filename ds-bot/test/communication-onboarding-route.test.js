import { testHubCode, testHubInput } from './fixtures/v2-hub-code.mjs'
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { install } from '../src/host/communication.js'

test('v1 pairing fails as unmigrated before credentials, network or config can be touched', async () => {
  const {CommunicationOnboarding,decodeHubCode}=await import('../src/host/federation/onboarding.js')
  const code='dsbot-hub:1:'+Buffer.from(JSON.stringify({hubId:'old-test-hub',url:'wss://127.0.0.1:3190/communication'})).toString('base64url')
  for (const options of [{},{allowLoopback:true}]) assert.throws(()=>decodeHubCode(code,options),{code:'HUB_V2_MIGRATION_REQUIRED'})
  const onboarding=new CommunicationOnboarding({config:{},ctx:{}},{connect:()=>{throw Error('network must not be used')}})
  await assert.rejects(onboarding.handle('join',{hubCode:code},{human:true}),{code:'HUB_V2_MIGRATION_REQUIRED'})
})

test('unconfigured instances expose only authenticated Human setup routes without enrolling or adding communication send tools', async () => {
  let route, loaded = 0
  const rt = { config: {}, teamTools: [], load: async () => { loaded++ }, refresh: async () => {},
    ctx: { effect: fn => fn(), connection: { fetch: { register: value => { route = value; return () => {} } } } } }
  install(rt)
  assert.deepEqual(rt.teamTools.map(tool => tool.name), ['communication_diagnose'])
  const call = async body => (await route.fetch(new Request('http://127.0.0.1/api/communication', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }))).json()
  assert.equal((await call({ endpoint: 'state' })).value.enabled, false)
  const url = 'wss://hub.example.test/communication', hubId = 'synthetic-hub'
  const hubCode = testHubCode({hubId,url})
  const decoded = await call({ endpoint: 'decode-hub-code', hubCode })
  assert.equal(decoded.ok, true)
  assert.equal(decoded.value.url, url)
  assert.equal(decoded.value.hubId, hubId)
  assert.equal(loaded, 1, 'state loads persisted local opt-in; decoding itself does not load or enroll')
  const forged = await call({ endpoint: 'join-hub', principalId: 'human:other:user', hubCode })
  assert.equal(forged.error.code, 'AUTHOR_MISMATCH')
  const relax = await call({ endpoint: 'decode-hub-code', hubCode, allowLoopback: true })
  assert.equal(relax.error.code, 'AUTHOR_MISMATCH')
  assert.equal(loaded, 1)
})

test('enrollment HTTP diagnostics expose only safe failure phase and never an underlying service message', async () => {
  let route
  const rt = { config: {remoteHubEnabled:true}, teamTools: [], load: async () => {}, refresh: async () => {}, ctx: {
    credentials: { readRecord: async () => { throw Error('DO_NOT_DISPLAY_SERVICE_DETAILS') }, modifyRecord: async () => {}, describeRecord: async () => ({ writable: true }) },
    effect: fn => fn(), connection: { fetch: { register: value => { route = value; return () => {} } } },
  } }
  install(rt)
  const hub = { hubId: 'diagnostic-test', url: 'wss://hub.example.test/communication' }
  const response = await route.fetch(new Request('http://127.0.0.1/api/communication', { method: 'POST', body: JSON.stringify({ endpoint: 'join-hub', ...testHubInput(hub), displayName: 'Synthetic device' }) }))
  const body = await response.json()
  assert.equal(body.error.code, 'COMMUNICATION_CREDENTIAL_READ_FAILED')
  assert.equal(body.error.phase, 'COMMUNICATION_CREDENTIAL_READ_FAILED')
  assert.ok(!JSON.stringify(body).includes('DO_NOT_DISPLAY'))
})

test('contact HTTP failures retain exact conflict codes for UI refresh without exposing unknown exception details', async () => {
  let route, code
  const rt = { config: {remoteHubEnabled:true}, teamTools: [], load: async () => { throw Object.assign(new Error('PRIVATE_EXCEPTION_MESSAGE'), { code }) }, refresh: async () => {},
    ctx: { effect: fn => fn(), connection: { fetch: { register: value => { route = value; return () => {} } } } } }
  install(rt)
  for (const expected of ['CONTACT_VERSION_CONFLICT', 'OPERATION_ID_CONFLICT', 'COMMUNICATION_UNAVAILABLE']) {
    code = expected === 'COMMUNICATION_UNAVAILABLE' ? 'PRIVATE_EXCEPTION_CODE' : expected
    const response = await route.fetch(new Request('http://127.0.0.1/api/communication', { method: 'POST', body: JSON.stringify({ endpoint: 'cancel-contact', requestId: 'synthetic-request', expectedVersion: 1, operationId: 'same-operation' }) }))
    const body = await response.json()
    assert.equal(body.ok, false)
    assert.equal(body.error.code, expected)
    assert.doesNotMatch(JSON.stringify(body), /PRIVATE_EXCEPTION/)
  }
})

test('legacy ownership recovery API is rejected without starting runtime or touching data', async () => {
  let route
  const rt = { config: {}, teamTools: [], load: async () => assert.fail('removed operation must not load data'),
    ctx: { effect: fn => fn(), connection: { fetch: { register: value => { route = value; return () => {} } } } } }
  install(rt)
  const response = await route.fetch(new Request('http://127.0.0.1/api/communication', { method: 'POST', body: JSON.stringify({ endpoint: 'reclaim', conversationId: 'old-group', operationId: 'old-reclaim', expectedVersion: 2 }) }))
  assert.deepEqual((await response.json()).error.code, 'UNKNOWN_OPERATION')
})

test('pending complete reset blocks setup and stale browser epochs cannot submit old requests', async t => {
  const { mkdtemp, writeFile, rm } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const home = await mkdtemp(join(tmpdir(), 'dsbot-reset-route-'))
  t.after(() => rm(home, { recursive: true, force: true }))
  let route
  const rt = { home, config: {}, teamTools: [], load: async () => {}, refresh: async () => {}, ctx: { effect: fn => fn(), connection: { fetch: { register: value => { route = value; return () => {} } } } } }
  install(rt)
  const call = async (body, headers = {}) => (await route.fetch(new Request('http://127.0.0.1/api/communication', { method: 'POST', headers, body: JSON.stringify(body) }))).json()
  await writeFile(join(home, 'communication-reset.pending.json'), '{}')
  assert.equal((await call({ endpoint: 'state' })).error.code, 'COMMUNICATION_RESET_INCOMPLETE')
  assert.equal((await call({ endpoint: 'reset-status' })).value.pending, true)
  await rm(join(home, 'communication-reset.pending.json'))
  const epoch = '00000000-0000-4000-8000-000000000001'
  await writeFile(join(home, 'communication-browser-epoch'), epoch)
  assert.equal((await call({ endpoint: 'state' }, { origin: 'http://127.0.0.1' })).error.code, 'COMMUNICATION_BROWSER_RESET_REQUIRED')
  assert.equal((await call({ endpoint: 'state' }, { origin: 'http://127.0.0.1', 'x-dsbot-browser-epoch': epoch })).value.enabled, false)
})
