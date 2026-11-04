import assert from 'node:assert/strict'
import { test } from 'node:test'
import { generateKeyPairSync, randomUUID, sign } from 'node:crypto'
import { Readable } from 'node:stream'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { HubStore } from '../src/store.js'
import { HubManagement, enrollmentTranscript, hubCode } from '../src/management-store.js'
import { createManagementHttp } from '../src/management-http.js'
import { adminCommand } from '../src/admin-cli.mjs'
import { CAPABILITIES } from '../src/protocol.js'

const keys = () => { const pair = generateKeyPairSync('ed25519'); return { privateKey: pair.privateKey, publicKey: pair.publicKey.export({ type: 'spki', format: 'pem' }).toString() } }
const proof = (key, challenge, extra = {}) => ({ challengeId: challenge.challengeId, signature: sign(null, Buffer.from(enrollmentTranscript(challenge)), key.privateKey).toString('base64url'), ...extra })
function fixture(t, options = {}) {
  const store = new HubStore(':memory:'); t.after(() => store.close())
  const m = new HubManagement(store, { url: 'ws://127.0.0.1:3190/communication', ...options })
  return { store, m }
}
function enroll(m, label = 'Synthetic device') {
  const key = keys(), socket = {}, c = m.challenge(socket, { purpose: 'join', publicKey: key.publicKey })
  const request = m.prove(socket, proof(key, c, { displayName: label }))
  const decision = m.decide({ requestId: request.requestId, action: 'approve', expectedVersion: 1 })
  const auth = m.store.connect(decision.instanceId, label, CAPABILITIES), principalId = `human:${auth.instanceId}:local-user`
  return { key, auth, principalId, requestId: request.requestId }
}
function consent(m, a, b, botsA = [], botsB = []) {
  const request = m.requestContact(a.auth, { principalId: a.principalId, operationId: randomUUID(), userCode: m.code(b.auth, { principalId: b.principalId }).userCode, botPrincipalIds: botsA })
  m.respondContact(b.auth, { principalId: b.principalId, operationId: randomUUID(), requestId: request.requestId, expectedVersion: 1, botPrincipalIds: botsB }, 'accept')
  return request
}

test('enrollment proves possession, binds purpose/socket, consumes challenges and explicitly expires', t => {
  let now = 100000
  const { m } = fixture(t, { now: () => now }), key = keys(), socket = {}
  const challenge = m.challenge(socket, { purpose: 'join', publicKey: key.publicKey })
  assert.throws(() => m.prove({}, proof(key, challenge, { displayName: 'Impostor' })), { code: 'UNAUTHENTICATED' })
  const wrong = proof(key, { ...challenge, purpose: 'login' }, { displayName: 'Impostor' })
  assert.throws(() => m.prove(socket, wrong), { code: 'UNAUTHENTICATED' })
  assert.throws(() => m.prove(socket, proof(key, challenge, { displayName: 'Retry' })), { code: 'UNAUTHENTICATED' })
  const expired = m.challenge(socket, { purpose: 'join', publicKey: key.publicKey }); now += 60001
  assert.throws(() => m.prove(socket, proof(key, expired)), { code: 'CHALLENGE_EXPIRED' })
  const request = m.prove(socket, proof(key, m.challenge(socket, { purpose: 'join', publicKey: key.publicKey }), { displayName: '<untrusted>' }))
  assert.equal(request.status, 'pending'); now += 86400001
  assert.throws(() => m.decide({ requestId: request.requestId, action: 'approve', expectedVersion: 1 }), { code: 'JOIN_VERSION_CONFLICT' })
  assert.equal(m.joins()[0].status, 'expired')
})

test('approval assigns stable Human, user code and persistent dynamic peer; revoked login cannot reconnect', t => {
  const dir = mkdtempSync(join(tmpdir(), 'dsbot-management-'))
  let store = new HubStore(join(dir, 'hub.sqlite')), m = new HubManagement(store), device = enroll(m)
  t.after(() => { store.close(); rmSync(dir, { recursive: true, force: true }) })
  const code = m.code(device.auth, { principalId: device.principalId }), hubId = m.hubId
  store.close(); store = new HubStore(join(dir, 'hub.sqlite')); m = new HubManagement(store)
  assert.equal(m.hubId, hubId); assert.ok(m.peer(device.auth.instanceId))
  const socket = {}, challenge = m.challenge(socket, { purpose: 'login', instanceId: device.auth.instanceId })
  assert.equal(m.prove(socket, proof(device.key, challenge)).instanceId, device.auth.instanceId)
  assert.equal(m.code(device.auth, { principalId: device.principalId }).userCode, code.userCode)
  m.revoke(device.auth.instanceId)
  assert.throws(() => m.challenge(socket, { purpose: 'login', instanceId: device.auth.instanceId }), { code: 'UNAUTHENTICATED' })
  assert.equal(store.db.prepare('SELECT count(*) n FROM principals').get().n, 1)
})

test('unproved request has explicit not-found, cancellation prevents approval and duplicate decision has no side effects', t => {
  const { m } = fixture(t), socket = {}, key = keys()
  const first = m.challenge(socket, { purpose: 'join', publicKey: key.publicKey })
  assert.throws(() => m.challenge(socket, { purpose: 'status', requestId: first.requestId }), { code: 'JOIN_NOT_FOUND' })
  m.prove(socket, proof(key, first, { displayName: 'Pending' }))
  const cancel = m.challenge(socket, { purpose: 'cancel', requestId: first.requestId })
  assert.equal(m.prove(socket, proof(key, cancel)).status, 'cancelled')
  assert.throws(() => m.decide({ requestId: first.requestId, expectedVersion: 2, action: 'approve' }), { code: 'JOIN_VERSION_CONFLICT' })
  const device = enroll(m)
  assert.throws(() => m.decide({ requestId: device.requestId, expectedVersion: 1, action: 'approve' }), { code: 'JOIN_VERSION_CONFLICT' })
  assert.equal(m.instances().length, 1)
})

test('explicit repair retains original key, Human/code and inactive memberships; stale and competing repair roll back', t => {
  const { m, store } = fixture(t), device = enroll(m), code = m.code(device.auth, { principalId: device.principalId }).userCode
  const group = store.createGroup(device.auth, { principalId: device.principalId, operationId: randomUUID(), title: 'Retained ownership' })
  m.revoke(device.auth.instanceId)
  const input = { instanceId: device.auth.instanceId, expectedRevision: 1 }, publicKey = m.peer(device.auth.instanceId).public_key
  assert.throws(() => m.repair({ ...input, publicKey: keys().publicKey }), { code: 'INVALID_REQUEST' })
  store.beforeCommit = () => { throw Error('Synthetic commit failure') }
  assert.throws(() => m.repair(input), /Synthetic commit failure/)
  store.beforeCommit = undefined
  assert.equal(m.instances()[0].trusted, 0); assert.equal(m.peer(device.auth.instanceId).revision, 1)
  assert.equal(m.repair(input).pairingRevision, 2)
  assert.throws(() => m.repair(input), { code: 'PAIRING_REVISION_CONFLICT' })
  assert.equal(m.peer(device.auth.instanceId).public_key, publicKey)
  assert.equal(store.db.prepare('SELECT active FROM memberships WHERE conversation_id=?').get(group.conversationId).active, 0)
  const socket = {}, challenge = m.challenge(socket, { purpose: 'login', instanceId: device.auth.instanceId })
  assert.equal(m.prove(socket, proof(device.key, challenge)).instanceId, device.auth.instanceId)
  const auth = store.connect(device.auth.instanceId, 'Repaired', CAPABILITIES)
  assert.equal(m.code(auth, { principalId: device.principalId }).userCode, code)
  assert.equal(store.db.prepare('SELECT count(*) n FROM principals').get().n, 1)
  assert.throws(() => m.code(device.auth, { principalId: device.principalId }), { code: 'STALE_CONNECTION' })
})

test('a signed login challenge issued before revocation cannot revive after same-key repair', t => {
  const { m } = fixture(t), device = enroll(m), socket = {}
  const oldChallenge = m.challenge(socket, { purpose: 'login', instanceId: device.auth.instanceId })
  const oldProof = proof(device.key, oldChallenge)
  m.revoke(device.auth.instanceId)
  m.repair({ instanceId: device.auth.instanceId, expectedRevision: 1 })
  assert.throws(() => m.prove(socket, oldProof), { code: 'UNAUTHENTICATED' })
  const freshChallenge = m.challenge(socket, { purpose: 'login', instanceId: device.auth.instanceId })
  assert.equal(m.prove(socket, proof(device.key, freshChallenge)).instanceId, device.auth.instanceId)
})

test('contact confirmation hides directory/IP, rejects forgery, scopes Bots explicitly, and revocation denies DMs but preserves groups/history', t => {
  const { store, m } = fixture(t), a = enroll(m, 'A'), b = enroll(m, 'B')
  const botA = store.register(a.auth, { localId: 'bot', kind: 'bot', displayName: 'Bot A' }).principalId
  const privateBot = store.register(a.auth, { localId: 'private-bot', kind: 'bot', displayName: 'Private Bot' }).principalId
  const botB = store.register(b.auth, { localId: 'bot', kind: 'bot', displayName: 'Bot B' }).principalId
  const rows = [{ principalId: b.principalId, ipAddress: '192.0.2.1' }, { principalId: botB }]
  assert.deepEqual(m.filterDirectory(a.auth, rows), [])
  const request = m.requestContact(a.auth, { principalId: a.principalId, operationId: randomUUID(), userCode: m.code(b.auth, { principalId: b.principalId }).userCode, botPrincipalIds: [botA] })
  const input = { principalId: b.principalId, operationId: randomUUID(), requestId: request.requestId, expectedVersion: 1, botPrincipalIds: [] }
  assert.throws(() => m.respondContact(a.auth, input, 'accept'), { code: 'AUTHOR_MISMATCH' })
  m.respondContact(b.auth, input, 'accept')
  assert.deepEqual(m.filterDirectory(a.auth, rows), [rows[0]])
  assert.deepEqual(m.filterDirectory(a.auth, rows, privateBot), [])
  assert.deepEqual(m.filterDirectory(a.auth, rows, botA), [rows[0]])
  assert.throws(() => m.filterDirectory(a.auth, rows, b.principalId), { code: 'AUTHOR_MISMATCH' })
  assert.equal(m.canContact(botA, b.principalId), true); assert.equal(m.canContact(a.principalId, botB), false)
  const dm = store.createDm(a.auth, { principalId: a.principalId, otherPrincipalId: b.principalId, operationId: randomUUID() })
  const group = store.createGroup(a.auth, { principalId: a.principalId, operationId: randomUUID(), title: 'Independent group' })
  const groupEpoch = store.member(a.auth, group.conversationId, a.principalId).epoch
  const relation = m.relations(a.auth, { principalId: a.principalId })[0]
  m.revokeContact(a.auth, { principalId: a.principalId, otherHumanPrincipalId: b.principalId, expectedVersion: relation.version, operationId: randomUUID() })
  assert.throws(() => m.assertDm(dm.conversationId), { code: 'CONTACT_REQUIRED' })
  assert.deepEqual(m.filterDirectory(a.auth, rows), [])
  assert.equal(store.db.prepare('SELECT count(*) n FROM conversations WHERE id=?').get(dm.conversationId).n, 1)
  assert.equal(store.member(a.auth, group.conversationId, a.principalId).epoch, groupEpoch)
  assert.doesNotThrow(() => m.assertDm(group.conversationId))
})

test('invalid codes have indistinguishable outgoing requests, expiry and rotated-code tombstones; bots cannot manage consent', t => {
  let now = 100000
  const { store, m } = fixture(t, { now: () => now }), a = enroll(m, 'A'), b = enroll(m, 'B')
  const code = m.code(b.auth, { principalId: b.principalId }).userCode
  const request = userCode => m.requestContact(a.auth, { principalId: a.principalId, operationId: randomUUID(), userCode })
  const valid = request(code), invalid = request('FFFF-FFFF-FFFF-FFFF-FFFF-FFFF')
  const outgoing = m.contactRequests(a.auth, { principalId: a.principalId })
  assert.ok(outgoing.every(row => row.direction === 'outgoing' && row.status === 'pending' && !Object.hasOwn(row, 'targetPrincipalId')))
  m.rotateCode(b.auth, { principalId: b.principalId, operationId: randomUUID() })
  assert.notEqual(m.code(b.auth, { principalId: b.principalId }).userCode, code)
  assert.ok(m.db.prepare('SELECT 1 FROM hub_code_tombstones').get())
  request(code)
  assert.equal(m.contactRequests(b.auth, { principalId: b.principalId }).length, 1)
  const bot = store.register(a.auth, { localId: 'bot', kind: 'bot', displayName: 'Bot' }).principalId
  assert.throws(() => m.requestContact(a.auth, { principalId: bot, operationId: randomUUID(), userCode: code }), { code: 'HUMAN_REQUIRED' })
  now += 86400001
  assert.ok(m.contactRequests(a.auth, { principalId: a.principalId }).every(row => row.status === 'expired'))
  assert.throws(() => m.respondContact(b.auth, { principalId: b.principalId, operationId: randomUUID(), requestId: valid.requestId, expectedVersion: 1 }, 'accept'), { code: 'CONTACT_VERSION_CONFLICT' })
  assert.ok(invalid.requestId)
})

test('concurrent contact requests and exact retry cannot overwrite a newer scope', t => {
  const { m, store } = fixture(t), a = enroll(m), b = enroll(m)
  const bot = store.register(a.auth, { localId: 'bot', kind: 'bot', displayName: 'Bot' }).principalId
  const code = m.code(b.auth, { principalId: b.principalId }).userCode
  const make = ids => m.requestContact(a.auth, { principalId: a.principalId, operationId: randomUUID(), userCode: code, botPrincipalIds: ids })
  const old = make([bot]), latest = make([])
  const accept = { principalId: b.principalId, operationId: randomUUID(), requestId: latest.requestId, expectedVersion: 1 }
  assert.equal(m.respondContact(b.auth, accept, 'accept').status, 'accepted')
  assert.equal(m.respondContact(b.auth, accept, 'accept').status, 'accepted')
  assert.throws(() => m.respondContact(b.auth, { ...accept, operationId: randomUUID(), requestId: old.requestId }, 'accept'), { code: 'CONTACT_VERSION_CONFLICT' })
  assert.equal(m.canContact(bot, b.principalId), false)
})

test('legacy static peers remain visible while enrolled peers require consent', t => {
  const { store, m } = fixture(t), dynamic = enroll(m)
  const a = store.connect('legacy-a', 'A', CAPABILITIES), b = store.connect('legacy-b', 'B', CAPABILITIES)
  const A = store.register(a, { localId: 'human', kind: 'human', displayName: 'A' }).principalId, B = store.register(b, { localId: 'human', kind: 'human', displayName: 'B' }).principalId
  assert.equal(m.canContact(A, B), true); assert.equal(m.canContact(A, dynamic.principalId), false)
})

test('legacy multiple Humans retain separate codes/consent and revocation does not cancel another Human DM', t => {
  const { store, m } = fixture(t), auth = store.connect('legacy', 'Legacy', CAPABILITIES), b = enroll(m)
  const first = store.register(auth, { localId: 'a', kind: 'human', displayName: 'A' }).principalId
  // Simulate a legacy database that predates the one-Human registration limit.
  const second = 'human:legacy:z'; store.db.prepare('INSERT INTO principals VALUES (?,?,?,?,?)').run(second, 'legacy', 'human', 'z', 'Z')
  const a = { auth, principalId: first }, z = { auth, principalId: second }
  consent(m, a, b); consent(m, z, b)
  assert.equal(m.canContact(first, b.principalId), true); assert.equal(m.canContact(second, b.principalId), true)
  assert.notEqual(m.code(auth, { principalId: first }).userCode, m.code(auth, { principalId: second }).userCode)
  const send = principalId => {
    const dm = store.createDm(auth, { principalId, otherPrincipalId: b.principalId, operationId: randomUUID() })
    const messageId = randomUUID(), member = store.member(auth, dm.conversationId, principalId)
    store.publish(auth, { protocol: 'dsbot-communication/1', type: 'message.publish', messageId, conversationId: dm.conversationId,
      author: { principalId, homeInstanceId: 'legacy', kind: 'human' }, clientCreatedAt: new Date().toISOString(),
      content: { format: 'text', text: 'Synthetic separate Human intent' }, mentions: [], replyToMessageId: null, membershipEpoch: member.epoch })
    return messageId
  }
  const firstMessage = send(first), secondMessage = send(second)
  const relation = m.relations(auth, { principalId: first })[0]
  m.revokeContact(auth, { principalId: first, otherHumanPrincipalId: b.principalId, expectedVersion: relation.version, operationId: randomUUID() })
  assert.equal(m.canContact(first, b.principalId), false); assert.equal(m.canContact(second, b.principalId), true)
  const pending = store.pending(b.auth)
  assert.equal(pending.some(d => d.messageId === firstMessage), false)
  assert.equal(pending.some(d => d.messageId === secondMessage), true)
})

test('rate windows of different duration do not reset each other and expired challenges release capacity', t => {
  let now = 200000000
  const { m } = fixture(t, { now: () => now })
  m.rate('daily', 1, 86400000); m.rate('minute', 20)
  assert.throws(() => m.rate('daily', 1, 86400000), { code: 'RATE_LIMITED' })
  now += 60001; m.rate('minute', 1)
  assert.throws(() => m.rate('daily', 1, 86400000), { code: 'RATE_LIMITED' })
  const socket = {}, key = keys(); m.challenge(socket, { purpose: 'join', publicKey: key.publicKey }); m.forget(socket)
  assert.equal(m.challenges.size, 0)
})

test('contact revocation revokes unfinished DM AI delivery and does not restore it after renewed consent', t => {
  const { store, m } = fixture(t), a = enroll(m), b = enroll(m)
  const bot = store.register(b.auth, { localId: 'bot', kind: 'bot', displayName: 'Bot' }).principalId
  consent(m, a, b, [], [bot])
  const dm = store.createDm(a.auth, { principalId: a.principalId, otherPrincipalId: bot, operationId: randomUUID() })
  const sender = store.member(a.auth, dm.conversationId, a.principalId)
  const message = { protocol: 'dsbot-communication/1', type: 'message.publish', messageId: randomUUID(), conversationId: dm.conversationId,
    author: { principalId: a.principalId, homeInstanceId: a.auth.instanceId, kind: 'human' }, clientCreatedAt: new Date().toISOString(),
    content: { format: 'text', text: 'Synthetic pending input' }, mentions: [], replyToMessageId: null, membershipEpoch: sender.epoch }
  store.publish(a.auth, message)
  const queued = { ...message, messageId: randomUUID() }
  assert.equal(store.pending(b.auth).filter(d => d.ai).length, 1)
  const relation = m.relations(a.auth, { principalId: a.principalId })[0]
  m.revokeContact(a.auth, { principalId: a.principalId, otherHumanPrincipalId: b.principalId, expectedVersion: relation.version, operationId: randomUUID() })
  assert.equal(store.pending(b.auth).length, 0)
  consent(m, a, b, [], [bot])
  assert.equal(store.pending(b.auth).length, 0)
  assert.equal(store.db.prepare('SELECT count(*) n FROM messages').get().n, 1)
  assert.throws(() => store.publish(a.auth, queued), { code: 'MEMBERSHIP_REVOKED' })
  assert.equal(store.publish(a.auth, message).messageId, message.messageId)
  assert.equal(store.member(a.auth, dm.conversationId, a.principalId).join_seq, sender.join_seq)
  const fresh = { ...queued, messageId: randomUUID(), membershipEpoch: store.member(a.auth, dm.conversationId, a.principalId).epoch }
  assert.equal(store.publish(a.auth, fresh).messageId, fresh.messageId)
  const nextQueued = { ...fresh, messageId: randomUUID() }
  consent(m, a, b, [], [])
  assert.equal(m.canContact(a.principalId, bot), false)
  consent(m, a, b, [], [bot])
  assert.equal(store.pending(b.auth).length, 0)
  assert.throws(() => store.publish(a.auth, nextQueued), { code: 'MEMBERSHIP_REVOKED' })
})

async function httpCall(handler, path, payload = {}, headers = {}) {
  const req = Readable.from([Buffer.from(JSON.stringify(payload))]); req.url = path; req.method = 'POST'; req.socket = { remoteAddress: '127.0.0.1' }; req.headers = { host: '127.0.0.1:3190', 'content-type': 'application/json', ...headers }
  let status, result, responseHeaders
  const res = { writeHead(s, h) { status = s; responseHeaders = h }, end(value) { result = JSON.parse(value) } }
  await handler(req, res); return { status, result, headers: responseHeaders }
}
test('admin is disabled by default; login uses Origin, session HttpOnly cookie and CSRF; bearer CLI refuses redirects', async t => {
  const { m } = fixture(t), origin = 'http://127.0.0.1:3190', password = 'synthetic-test-admin-password'
  const off = createManagementHttp(m, { origin }); assert.equal((await httpCall(off.handle, '/admin/api/state')).status, 404)
  const portal = createManagementHttp(m, { origin, password }); t.after(() => portal.close())
  assert.equal((await httpCall(portal.handle, '/admin/api/login', { password }, { origin: 'https://evil.invalid' })).status, 400)
  const login = await httpCall(portal.handle, '/admin/api/login', { password }, { origin })
  assert.equal(login.status, 200); assert.match(login.headers['set-cookie'], /HttpOnly; SameSite=Strict/)
  const cookie = login.headers['set-cookie'].split(';')[0]
  assert.equal((await httpCall(portal.handle, '/admin/api/state', {}, { cookie, origin })).status, 401)
  const auth = { cookie, origin, 'x-csrf-token': login.result.csrf }
  assert.equal((await httpCall(portal.handle, '/admin/api/state', {}, auth)).status, 200)
  const device = enroll(m)
  m.revoke(device.auth.instanceId)
  const repair = await httpCall(portal.handle, '/admin/api/repair', { instanceId: device.auth.instanceId, expectedRevision: 1 }, auth)
  assert.equal(repair.status, 200); assert.equal(repair.result.value.pairingRevision, 2)
  const competing = await httpCall(portal.handle, '/admin/api/repair', { instanceId: device.auth.instanceId, expectedRevision: 1 }, auth)
  assert.equal(competing.result.error.code, 'PAIRING_REVISION_CONFLICT')
  assert.equal((await httpCall(portal.handle, '/admin/api/logout', {}, auth)).status, 200)
  assert.equal((await httpCall(portal.handle, '/admin/api/state', {}, auth)).status, 401)
  const value = await adminCommand([origin, 'state'], { password, fetcher: async (_url, options) => { assert.equal(options.redirect, 'error'); assert.equal(options.headers.authorization, 'Bearer ' + password); return { ok: true, json: async () => ({ ok: true, value: { synthetic: true } }) } } })
  assert.deepEqual(value, { synthetic: true })
  await adminCommand([origin, 'repair'], { password, fetcher: async (url, options) => { assert.equal(url.pathname, '/admin/api/repair'); assert.equal(options.redirect, 'error'); return { ok: true, json: async () => ({ ok: true, value: { repaired: true } }) } } })
  assert.throws(() => hubCode('id', 'ws://192.0.2.1/communication'), { code: 'TLS_REQUIRED' })
})
