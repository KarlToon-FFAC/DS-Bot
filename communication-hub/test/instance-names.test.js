import assert from 'node:assert/strict'
import { test } from 'node:test'
import { randomUUID } from 'node:crypto'
import { Readable } from 'node:stream'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { HubStore } from '../src/store.js'
import { HubManagement } from '../src/management-store.js'
import { createManagementHttp } from '../src/management-http.js'
import { adminCommand } from '../src/admin-cli.mjs'
import { CAPABILITIES, PROTOCOL } from '../src/protocol.js'

test('administrator instance override survives legacy reconnect, pairing revision and SQLite restart without rewriting identities or history', t => {
  const dir = mkdtempSync(join(tmpdir(), 'dsbot-instance-name-')), path = join(dir, 'hub.sqlite')
  let store = new HubStore(path), management = new HubManagement(store)
  t.after(() => { store.close(); rmSync(dir, { recursive: true, force: true }) })
  const a = store.connect('a', 'Original A', CAPABILITIES), b = store.connect('b', 'Original B', CAPABILITIES)
  const A = store.register(a, { localId: 'user', kind: 'human', displayName: 'Person A' }).principalId
  const B = store.register(b, { localId: 'user', kind: 'human', displayName: 'Person B' }).principalId
  const dm = store.createDm(a, { operationId: randomUUID(), principalId: A, otherPrincipalId: B })
  store.publish(a, { protocol: PROTOCOL, type: 'message.publish', messageId: randomUUID(), conversationId: dm.conversationId,
    author: { principalId: A, homeInstanceId: 'a', kind: 'human' }, membershipEpoch: store.member(a, dm.conversationId, A).epoch,
    content: { format: 'text', text: 'Synthetic unchanged history' }, mentions: [], replyToMessageId: null, clientCreatedAt: new Date().toISOString() })
  const unchanged = () => JSON.stringify(['principals', 'memberships', 'messages', 'conversations'].map(table => store.db.prepare(`SELECT * FROM ${table}`).all()))
  const before = unchanged(), instance = store.db.prepare('SELECT epoch,trusted,pairing_revision FROM instances WHERE id=?').get('a')
  assert.deepEqual(management.rename({ instanceId: 'a', label: '  Renamed device A  ', expectedNameVersion: 0 }), { instanceId: 'a', label: 'Renamed device A', nameVersion: 1 })
  assert.equal(unchanged(), before)
  assert.deepEqual(store.db.prepare('SELECT epoch,trusted,pairing_revision FROM instances WHERE id=?').get('a'), instance)
  store.check(a)
  assert.ok(store.contacts(b).filter(person => person.homeInstanceId === 'a').every(person => person.instanceLabel === 'Renamed device A'))
  store.connect('a', 'Stale static config', CAPABILITIES)
  store.close(); store = new HubStore(path); management = new HubManagement(store)
  store.configurePeer('a', 'Stale static config', 2)
  store.connect('a', 'Stale static config', CAPABILITIES)
  assert.equal(management.instances().find(item => item.instanceId === 'a').label, 'Renamed device A')
  assert.equal(management.instances().find(item => item.instanceId === 'a').nameVersion, 1)
  assert.equal(unchanged(), before)
  assert.equal(management.instances().find(item => item.instanceId === 'b').nameVersion, 0)
})

test('instance rename validates exact shape/name/version, rejects competing edits, and cannot restore a revoked instance', t => {
  const store = new HubStore(':memory:'); t.after(() => store.close())
  store.connect('a', 'Original', CAPABILITIES)
  const management = new HubManagement(store), valid = { instanceId: 'a', label: 'Device A', expectedNameVersion: 0 }
  for (const input of [null, [], {}, { ...valid, label: '' }, { ...valid, label: '   ' }, { ...valid, label: 'a'.repeat(101) }, { ...valid, label: 'bad\nname' }, { ...valid, expectedNameVersion: -1 }, { ...valid, expectedNameVersion: 1.5 }, { ...valid, trusted: true }]) {
    assert.throws(() => management.rename(input), { code: 'INVALID_REQUEST' })
  }
  assert.throws(() => management.rename({ ...valid, instanceId: 'missing' }), { code: 'INSTANCE_NOT_FOUND' })
  management.rename(valid)
  assert.throws(() => management.rename({ ...valid, label: 'Competing edit' }), { code: 'INSTANCE_NAME_VERSION_CONFLICT' })
  assert.equal(store.db.prepare('SELECT count(*) n FROM hub_admin_audit').get().n, 1)
  store.revokeInstance('a')
  management.rename({ ...valid, label: '<b>Untrusted label</b>', expectedNameVersion: 1 })
  assert.equal(management.instances()[0].trusted, 0)
  assert.throws(() => store.connect('a', 'Old', CAPABILITIES), { code: 'UNAUTHENTICATED' })
})

async function call(portal, path, payload, headers = {}) {
  const req = Readable.from([Buffer.from(JSON.stringify(payload))])
  Object.assign(req, { url: path, method: 'POST', socket: { remoteAddress: '127.0.0.1' }, headers: { host: '127.0.0.1:3190', 'content-type': 'application/json', ...headers } })
  let status, responseHeaders, result
  await portal.handle(req, { writeHead(value, values) { status = value; responseHeaders = values }, end(value) { result = JSON.parse(value) } })
  return { status, headers: responseHeaders, result }
}

test('only an authenticated Hub administrator can rename through session/CSRF or admin CLI; instance credentials cannot', async t => {
  const store = new HubStore(':memory:'); t.after(() => store.close())
  store.connect('a', 'Original', CAPABILITIES)
  const management = new HubManagement(store), password = 'synthetic-test-name-admin-password', origin = 'http://127.0.0.1:3190'
  const portal = createManagementHttp(management, { origin, password }); t.after(() => portal.close())
  const input = { instanceId: 'a', label: 'Approved name', expectedNameVersion: 0 }
  assert.equal((await call(portal, '/admin/api/rename', input)).status, 401)
  assert.equal((await call(portal, '/admin/api/rename', input, { authorization: 'Bearer synthetic-test-instance-credential' })).status, 401)
  const login = await call(portal, '/admin/api/login', { password }, { origin })
  const cookie = login.headers['set-cookie'].split(';')[0], auth = { origin, cookie, 'x-csrf-token': login.result.csrf }
  assert.equal((await call(portal, '/admin/api/rename', input, { origin, cookie })).status, 401)
  assert.equal((await call(portal, '/admin/api/rename', input, { ...auth, origin: 'https://untrusted.example.test' })).status, 400)
  assert.equal(management.instances()[0].label, 'Original')
  const saved = await call(portal, '/admin/api/rename', input, auth)
  assert.equal(saved.status, 200); assert.equal(saved.result.value.nameVersion, 1)
  assert.equal((await call(portal, '/admin/api/rename', input, auth)).result.error.code, 'INSTANCE_NAME_VERSION_CONFLICT')
  await adminCommand([origin, 'rename'], { password, fetcher: async (url, options) => {
    assert.equal(url.pathname, '/admin/api/rename'); assert.equal(options.redirect, 'error')
    return { ok: true, json: async () => ({ ok: true, value: { command: 'rename' } }) }
  } })
  await call(portal, '/admin/api/logout', {}, auth)
  assert.equal((await call(portal, '/admin/api/rename', { ...input, expectedNameVersion: 1 }, auth)).status, 401)
})
