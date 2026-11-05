import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Readable } from 'node:stream'
import { EventEmitter } from 'node:events'
import { HubStore } from '../src/store.js'
import { HubManagement } from '../src/management-store.js'
import { createManagementHttp } from '../src/management-http.js'
import { CAPABILITIES } from '../src/protocol.js'

const origin = 'http://127.0.0.1:3190', password = 'test-synthetic-live-admin-password'
async function call(portal, action, payload = {}, headers = {}, response) {
  const req = Readable.from([Buffer.from(JSON.stringify(payload))])
  Object.assign(req, { url: '/admin/api/' + action, method: 'POST', socket: { remoteAddress: '127.0.0.1' }, headers: { host: '127.0.0.1:3190', 'content-type': 'application/json', ...headers } })
  const res = response ?? new EventEmitter()
  let status, result, out
  res.writeHead = (s, h) => { status = s; out = h }; res.end = value => { result = JSON.parse(value) }
  await portal.handle(req, res)
  return { status, result, headers: out }
}
async function fixture(t, options = {}) {
  const store = new HubStore(':memory:'); t.after(() => store.close())
  store.connect('synthetic', 'Original', CAPABILITIES)
  const management = new HubManagement(store), portal = createManagementHttp(management, { origin, password, ...options })
  t.after(() => portal.close())
  const login = await call(portal, 'login', { password }, { origin })
  const auth = { origin, cookie: login.headers['set-cookie'].split(';')[0], 'x-csrf-token': login.result.csrf }
  return { portal, store, management, auth }
}
const drain = () => new Promise(resolve => setImmediate(resolve))

test('admin change hints require same-origin session and CSRF, carry no directory data and wake on committed mutations', async t => {
  let hints = 0
  const { portal, auth } = await fixture(t, { onChange: () => { hints++ } })
  const state = await call(portal, 'state', {}, auth), revision = state.result.revision
  assert.equal((await call(portal, 'changes', { revision })).status, 401)
  assert.equal((await call(portal, 'changes', { revision }, { ...auth, 'x-csrf-token': '' })).status, 401)
  assert.equal((await call(portal, 'changes', { revision }, { ...auth, origin: 'https://foreign.invalid' })).status, 400)
  let settled = false
  const wait = call(portal, 'changes', { revision }, auth).then(result => { settled = true; return result })
  await drain(); assert.equal(settled, false)
  const renamed = await call(portal, 'rename', { instanceId: 'synthetic', label: 'Renamed', expectedNameVersion: 0 }, auth)
  const hint = await wait
  assert.equal(renamed.status, 200); assert.equal(hints, 1)
  assert.deepEqual(Object.keys(hint.result).sort(), ['ok', 'revision'])
  assert.notEqual(hint.result.revision, revision)
  assert.equal((await call(portal, 'state', {}, auth)).result.value.instances[0].label, 'Renamed')
  const immediate = await call(portal, 'changes', { revision }, auth)
  assert.equal(immediate.result.revision, hint.result.revision)
})

test('admin long polls recheck logout, global revocation and expiry before responding', async t => {
  for (const action of ['logout', 'sessions/revoke', 'expiry']) {
    await t.test(action, async t => {
      const { portal, auth, management } = await fixture(t)
      const revision = portal.currentRevision(), wait = call(portal, 'changes', { revision }, auth)
      await drain()
      if (action === 'expiry') { management.now = () => Date.now() + 901000; portal.changed() }
      else await call(portal, action, {}, auth)
      assert.equal((await wait).status, 401)
    })
  }
})

test('admin waits are bounded per session, release on disconnect and revision generations survive restart', async t => {
  const { portal, auth, management } = await fixture(t)
  const revision = portal.currentRevision(), responses = Array.from({ length: 4 }, () => new EventEmitter())
  const waits = responses.map(res => call(portal, 'changes', { revision }, auth, res))
  await drain()
  assert.equal((await call(portal, 'changes', { revision }, auth)).status, 429)
  responses[0].destroyed = true; responses[0].emit('close'); await waits[0]
  const replacement = call(portal, 'changes', { revision }, auth)
  await drain(); portal.changed(); await Promise.all([...waits.slice(1), replacement])
  const other = createManagementHttp(management, { origin, password }); t.after(() => other.close())
  assert.notEqual(other.currentRevision(), revision)
})
