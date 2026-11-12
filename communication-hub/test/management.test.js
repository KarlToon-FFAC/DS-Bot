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
import { CAPABILITIES, hash } from '../src/protocol.js'

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

test('signed self-departure is purpose-bound, owner-safe, repeatable and status remains provable after revocation',t=>{
 const {store,m}=fixture(t),a=enroll(m),b=enroll(m)
 const group=store.createGroup(a.auth,{principalId:a.principalId,title:'Synthetic owned group',operationId:randomUUID()})
 let socket={},challenge=m.challenge(socket,{purpose:'leave',instanceId:a.auth.instanceId})
 assert.throws(()=>m.prove(socket,proof(b.key,challenge)),{code:'UNAUTHENTICATED'})
 socket={};challenge=m.challenge(socket,{purpose:'leave',instanceId:a.auth.instanceId})
 assert.throws(()=>m.prove(socket,proof(a.key,challenge)),{code:'OWNER_TRANSFER_REQUIRED'})
 const membership=store.db.prepare('SELECT epoch FROM memberships WHERE conversation_id=? AND principal_id=?').get(group.conversationId,a.principalId)
 store.dissolve(a.auth,{principalId:a.principalId,conversationId:group.conversationId,membershipEpoch:membership.epoch,operationId:randomUUID()})
 socket={};challenge=m.challenge(socket,{purpose:'leave',instanceId:a.auth.instanceId})
 assert.deepEqual(m.prove(socket,proof(a.key,challenge)),{instanceId:a.auth.instanceId,left:true})
 assert.throws(()=>store.check(a.auth),{code:'UNAUTHENTICATED'})
 assert.throws(()=>m.challenge({}, {purpose:'login',instanceId:a.auth.instanceId}),{code:'UNAUTHENTICATED'})
 for(const purpose of ['leave-status','leave']){
  socket={};challenge=m.challenge(socket,{purpose,instanceId:a.auth.instanceId})
  assert.equal(m.prove(socket,proof(a.key,challenge)).left,true)
 }
 assert.ok(store.db.prepare('SELECT 1 FROM principals WHERE id=?').get(a.principalId),'retain historical identity')
 assert.ok(store.db.prepare('SELECT 1 FROM conversations WHERE id=?').get(group.conversationId),'retain historical group')
})

test('revoked identities release live capacity without deleting history and repair cannot exceed it',t=>{
 const {store,m}=fixture(t);store.limits.maxPrincipals=1
 const a=enroll(m)
 m.revoke(a.auth.instanceId)
 assert.equal(store.activePrincipalCount(),0)
 const b=enroll(m)
 assert.equal(store.activePrincipalCount(),1)
 assert.equal(store.db.prepare('SELECT count(*) n FROM principals').get().n,2)
 assert.throws(()=>m.repair({instanceId:a.auth.instanceId,expectedRevision:1}),{code:'DIRECTORY_FULL'})
 assert.throws(()=>store.configurePeer(a.auth.instanceId,'Original device',2),{code:'DIRECTORY_FULL'})
 m.revoke(b.auth.instanceId)
 m.repair({instanceId:a.auth.instanceId,expectedRevision:1})
 assert.equal(store.activePrincipalCount(),1)
 assert.equal(store.db.prepare('SELECT count(*) n FROM principals').get().n,2)
})

test('approval assigns stable Human, user code and persistent dynamic peer; revoked login cannot reconnect', t => {
  const dir = mkdtempSync(join(tmpdir(), 'dsbot-management-'))
  let store = new HubStore(join(dir, 'hub.sqlite')), m = new HubManagement(store), device = enroll(m)
  t.after(() => { store.close(); rmSync(dir, { recursive: true, force: true }) })
  const code = m.code(device.auth, { principalId: device.principalId }), hubId = m.hubId
  m.rename({ instanceId: device.auth.instanceId, label: 'Renamed enrolled device', expectedNameVersion: 0 })
  store.close(); store = new HubStore(join(dir, 'hub.sqlite')); m = new HubManagement(store)
  assert.equal(m.hubId, hubId); assert.ok(m.peer(device.auth.instanceId))
  const socket = {}, challenge = m.challenge(socket, { purpose: 'login', instanceId: device.auth.instanceId })
  assert.deepEqual(m.prove(socket, proof(device.key, challenge)), { instanceId: device.auth.instanceId, label: 'Renamed enrolled device' })
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

test('invalid codes fail explicitly without exposing target identity; genuine requests still expire and Bot consent is forbidden', t => {
  let now = 100000
  const { store, m } = fixture(t, { now: () => now }), a = enroll(m, 'A'), b = enroll(m, 'B')
  const code = m.code(b.auth, { principalId: b.principalId }).userCode
  const request = userCode => m.requestContact(a.auth, { principalId: a.principalId, operationId: randomUUID(), userCode })
  const valid = request(code)
  assert.throws(() => request('FFFF-FFFF-FFFF-FFFF-FFFF-FFFF'), { code: 'CONTACT_CODE_UNAVAILABLE' })
  const outgoing = m.contactRequests(a.auth, { principalId: a.principalId })
  assert.ok(outgoing.every(row => row.direction === 'outgoing' && row.status === 'pending' && !Object.hasOwn(row, 'targetPrincipalId')))
  m.rotateCode(b.auth, { principalId: b.principalId, operationId: randomUUID() })
  assert.notEqual(m.code(b.auth, { principalId: b.principalId }).userCode, code)
  assert.ok(m.db.prepare('SELECT 1 FROM hub_code_tombstones').get())
  assert.throws(() => request(code), { code: 'CONTACT_CODE_UNAVAILABLE' })
  assert.equal(m.contactRequests(b.auth, { principalId: b.principalId }).length, 1)
  const bot = store.register(a.auth, { localId: 'bot', kind: 'bot', displayName: 'Bot' }).principalId
  assert.throws(() => m.requestContact(a.auth, { principalId: bot, operationId: randomUUID(), userCode: code }), { code: 'HUMAN_REQUIRED' })
  now += 86400001
  assert.ok(m.contactRequests(a.auth, { principalId: a.principalId }).every(row => row.status === 'expired'))
  assert.throws(() => m.respondContact(b.auth, { principalId: b.principalId, operationId: randomUUID(), requestId: valid.requestId, expectedVersion: 1 }, 'accept'), { code: 'CONTACT_VERSION_CONFLICT' })
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

test('accepting one duplicate settles same-direction and crossed requests without replacing its chosen scope', t => {
  const { m, store } = fixture(t), a = enroll(m, 'A'), b = enroll(m, 'B'), c = enroll(m, 'C')
  const bot = store.register(a.auth, { localId: 'shared', kind: 'bot', displayName: 'Shared Bot' }).principalId
  const request = (from, to, bots = []) => m.requestContact(from.auth, { principalId: from.principalId, operationId: randomUUID(), userCode: m.code(to.auth, { principalId: to.principalId }).userCode, botPrincipalIds: bots })
  const first = request(a, b, [bot]), duplicate = request(a, b), crossed = request(b, a), unrelated = request(a, c)
  const input = { principalId: b.principalId, operationId: randomUUID(), requestId: first.requestId, expectedVersion: 1 }
  m.respondContact(b.auth, input, 'accept')
  for (const person of [a, b]) {
    const rows = m.contactRequests(person.auth, { principalId: person.principalId })
    assert.equal(rows.find(row => row.requestId === first.requestId).status, 'accepted')
    for (const item of [duplicate, crossed]) assert.equal(rows.find(row => row.requestId === item.requestId).status, 'cancelled')
  }
  assert.equal(m.contactRequests(a.auth, { principalId: a.principalId }).find(row => row.requestId === unrelated.requestId).status, 'pending')
  const relation = m.relations(a.auth, { principalId: a.principalId })[0]
  assert.deepEqual(relation.botPrincipalIds, [bot]); assert.equal(relation.version, 1)
  m.respondContact(b.auth, input, 'accept')
  assert.deepEqual(m.relations(a.auth, { principalId: a.principalId })[0], relation)
  assert.throws(() => m.respondContact(a.auth, { principalId: a.principalId, operationId: randomUUID(), requestId: crossed.requestId, expectedVersion: 1 }, 'accept'), { code: 'CONTACT_VERSION_CONFLICT' })
})

test('sender cancellation is terminal for valid and privately rejected requests, including a stale pre-rejection view', t => {
  let now = 100000
  const { m } = fixture(t, { now: () => now }), a = enroll(m, 'A'), b = enroll(m, 'B')
  const request = userCode => m.requestContact(a.auth, { principalId: a.principalId, operationId: randomUUID(), userCode })
  const code = m.code(b.auth, { principalId: b.principalId }).userCode
  const pending = request(code), rejected = request(code), unanswered = request(code)
  const before = m.contactRequests(a.auth, { principalId: a.principalId }).find(row => row.requestId === rejected.requestId)
  m.respondContact(b.auth, { principalId: b.principalId, operationId: randomUUID(), requestId: rejected.requestId, expectedVersion: 1 }, 'reject')
  const outgoing = m.contactRequests(a.auth, { principalId: a.principalId })
  const publicState = row => { const { requestId, ...state } = row; return state }
  assert.deepEqual(publicState(outgoing.find(row => row.requestId === rejected.requestId)), publicState(outgoing.find(row => row.requestId === unanswered.requestId)))
  assert.deepEqual(outgoing.find(row => row.requestId === rejected.requestId), before)
  for (const item of [pending, rejected, unanswered]) {
    const input = { principalId: a.principalId, operationId: randomUUID(), requestId: item.requestId, expectedVersion: 1 }
    const result = m.respondContact(a.auth, input, 'cancel')
    assert.equal(result.status, 'cancelled'); assert.deepEqual(m.respondContact(a.auth, input, 'cancel'), result)
    const row = m.contactRequests(a.auth, { principalId: a.principalId }).find(row => row.requestId === item.requestId)
    assert.equal(row.status, 'cancelled'); assert.equal(row.version, 2)
    assert.throws(() => m.respondContact(b.auth, { principalId: b.principalId, operationId: randomUUID(), requestId: item.requestId, expectedVersion: 1 }, 'accept'), { code: 'CONTACT_VERSION_CONFLICT' })
  }
  now += 86400001
  assert.ok(m.contactRequests(a.auth, { principalId: a.principalId }).every(row => row.status === 'cancelled'))
  assert.deepEqual(m.relations(a.auth, { principalId: a.principalId }), [])
})

test('private-rejection cancellation rolls back atomically, rejects changed retry payloads and cannot cancel expired requests', t => {
  let now = 100000
  const { m, store } = fixture(t, { now: () => now }), a = enroll(m, 'A'), b = enroll(m, 'B')
  const request = () => m.requestContact(a.auth, { principalId: a.principalId, operationId: randomUUID(), userCode: m.code(b.auth, { principalId: b.principalId }).userCode })
  const rejected = request(), pending = request(), expiredRejection = request()
  for (const item of [rejected, expiredRejection]) m.respondContact(b.auth, { principalId: b.principalId, operationId: randomUUID(), requestId: item.requestId, expectedVersion: 1 }, 'reject')
  const input = { principalId: a.principalId, operationId: randomUUID(), requestId: rejected.requestId, expectedVersion: 1 }
  store.beforeCommit = () => { throw Error('Synthetic cancellation failure') }
  assert.throws(() => m.respondContact(a.auth, input, 'cancel'), /Synthetic cancellation failure/)
  store.beforeCommit = undefined
  assert.equal(m.db.prepare('SELECT status FROM hub_contact_requests WHERE id=?').get(rejected.requestId).status, 'rejected')
  assert.equal(m.contactRequests(a.auth, { principalId: a.principalId }).find(row => row.requestId === rejected.requestId).status, 'pending')
  m.respondContact(a.auth, input, 'cancel')
  assert.throws(() => m.respondContact(a.auth, { ...input, requestId: pending.requestId }, 'cancel'), { code: 'OPERATION_ID_CONFLICT' })
  now += 86400001
  const rows = m.contactRequests(a.auth, { principalId: a.principalId })
  for (const item of [pending, expiredRejection]) {
    const row = rows.find(row => row.requestId === item.requestId)
    assert.equal(row.status, 'expired'); assert.equal(row.version, 2)
    assert.throws(() => m.respondContact(a.auth, { ...input, operationId: randomUUID(), requestId: item.requestId, expectedVersion: row.version }, 'cancel'), { code: 'CONTACT_VERSION_CONFLICT' })
    assert.throws(() => m.respondContact(b.auth, { principalId: b.principalId, operationId: randomUUID(), requestId: item.requestId, expectedVersion: 1 }, 'accept'), { code: 'CONTACT_VERSION_CONFLICT' })
  }
  assert.equal(rows.find(row => row.requestId === rejected.requestId).status, 'cancelled')
  assert.equal(m.canContact(a.principalId, b.principalId), false)
})

test('sender request quota cannot reveal a private rejection and explicit cancellation releases one slot', t => {
  let now = 100000
  const { m } = fixture(t, { now: () => now }), a = enroll(m, 'A'), b = enroll(m, 'B')
  const code = m.code(b.auth, { principalId: b.principalId }).userCode
  const request = (userCode = code) => m.requestContact(a.auth, { principalId: a.principalId, operationId: randomUUID(), userCode })
  for (let i = 0; i < 19; i++) { if (i === 10) now += 60001; request() }
  const valid = request(code)
  now += 60001
  assert.throws(() => request(), { code: 'CONTACT_LIMIT' })
  m.respondContact(b.auth, { principalId: b.principalId, operationId: randomUUID(), requestId: valid.requestId, expectedVersion: 1 }, 'reject')
  assert.equal(m.contactRequests(a.auth, { principalId: a.principalId }).filter(row => row.status === 'pending').length, 20)
  assert.throws(() => request(), { code: 'CONTACT_LIMIT' })
  m.respondContact(a.auth, { principalId: a.principalId, operationId: randomUUID(), requestId: valid.requestId, expectedVersion: 1 }, 'cancel')
  request()
  assert.throws(() => request(), { code: 'CONTACT_LIMIT' })
})

test('contact decisions and cancellation are ordered, authorized and cannot revive a competing terminal state', async t => {
  for (const first of ['accept', 'reject', 'cancel']) await t.test(first, t => {
    const { m } = fixture(t), a = enroll(m, 'A'), b = enroll(m, 'B'), c = enroll(m, 'C')
    const request = m.requestContact(a.auth, { principalId: a.principalId, operationId: randomUUID(), userCode: m.code(b.auth, { principalId: b.principalId }).userCode })
    const action = (person, kind, version = 1) => m.respondContact(person.auth, { principalId: person.principalId, operationId: randomUUID(), requestId: request.requestId, expectedVersion: version }, kind)
    assert.throws(() => action(c, 'cancel'), { code: 'FORBIDDEN' })
    assert.throws(() => action(b, 'cancel'), { code: 'FORBIDDEN' })
    assert.throws(() => action(a, 'reject'), { code: 'FORBIDDEN' })
    assert.throws(() => action(a, 'cancel', 7), { code: 'CONTACT_VERSION_CONFLICT' })
    action(first === 'cancel' ? a : b, first)
    if (first === 'reject') assert.equal(action(a, 'cancel').status, 'cancelled')
    else assert.throws(() => action(first === 'cancel' ? b : a, first === 'cancel' ? 'accept' : 'cancel'), { code: 'CONTACT_VERSION_CONFLICT' })
    assert.equal(m.contactRequests(a.auth, { principalId: a.principalId })[0].status, first === 'accept' ? 'accepted' : 'cancelled')
    assert.equal(m.canContact(a.principalId, b.principalId), first === 'accept')
  })
})

test('duplicate settlement rolls back with acceptance and revocation, then committed retries preserve later consent', t => {
  const { m, store } = fixture(t), a = enroll(m, 'A'), b = enroll(m, 'B')
  const request = (from, to) => m.requestContact(from.auth, { principalId: from.principalId, operationId: randomUUID(), userCode: m.code(to.auth, { principalId: to.principalId }).userCode })
  const accepted = request(a, b), sibling = request(a, b)
  const input = { principalId: b.principalId, operationId: randomUUID(), requestId: accepted.requestId, expectedVersion: 1 }
  store.beforeCommit = () => { throw Error('Synthetic commit failure') }
  assert.throws(() => m.respondContact(b.auth, input, 'accept'), /Synthetic commit failure/)
  store.beforeCommit = undefined
  assert.ok(m.db.prepare('SELECT * FROM hub_contact_requests').all().every(row => row.status === 'pending' && row.version === 1))
  assert.equal(m.db.prepare('SELECT count(*) n FROM hub_management_operations WHERE id=?').get(input.operationId).n, 0)
  assert.deepEqual(m.relations(a.auth, { principalId: a.principalId }), [])
  m.respondContact(b.auth, input, 'accept')
  const newer = request(a, b), crossed = request(b, a)
  const relation = m.relations(a.auth, { principalId: a.principalId })[0]
  const revoke = { principalId: a.principalId, operationId: randomUUID(), otherHumanPrincipalId: b.principalId, expectedVersion: relation.version }
  store.beforeCommit = () => { throw Error('Synthetic commit failure') }
  assert.throws(() => m.revokeContact(a.auth, revoke), /Synthetic commit failure/)
  store.beforeCommit = undefined
  assert.equal(m.relations(a.auth, { principalId: a.principalId })[0].active, true)
  assert.ok(m.db.prepare("SELECT * FROM hub_contact_requests WHERE id IN (?,?)").all(newer.requestId, crossed.requestId).every(row => row.status === 'pending'))
  m.revokeContact(a.auth, revoke)
  for (const person of [a, b]) assert.ok(m.contactRequests(person.auth, { principalId: person.principalId }).every(row => row.status !== 'pending'))
  m.respondContact(b.auth, input, 'accept')
  assert.equal(m.relations(a.auth, { principalId: a.principalId })[0].active, false)
  assert.throws(() => m.respondContact(b.auth, { ...input, operationId: randomUUID(), requestId: sibling.requestId }, 'accept'), { code: 'CONTACT_VERSION_CONFLICT' })
  const renewed = request(a, b)
  m.respondContact(b.auth, { ...input, operationId: randomUUID(), requestId: renewed.requestId }, 'accept')
  const current = m.relations(a.auth, { principalId: a.principalId })[0]
  m.revokeContact(a.auth, revoke)
  assert.deepEqual(m.relations(a.auth, { principalId: a.principalId })[0], current)
  assert.equal(current.active, true); assert.equal(current.version, 3)
})

test('acceptance and revocation settle visible private rejections without touching expired or unrelated requests', t => {
  let now = 100000
  const { m } = fixture(t, { now: () => now }), a = enroll(m, 'A'), b = enroll(m, 'B'), c = enroll(m, 'C')
  const request = (from, to) => m.requestContact(from.auth, { principalId: from.principalId, operationId: randomUUID(), userCode: m.code(to.auth, { principalId: to.principalId }).userCode })
  const reject = (person, item) => m.respondContact(person.auth, { principalId: person.principalId, operationId: randomUUID(), requestId: item.requestId, expectedVersion: 1 }, 'reject')
  const earlier = request(a, b), unrelated = request(a, c)
  reject(b, earlier); reject(c, unrelated)
  const accepted = request(a, b)
  m.respondContact(b.auth, { principalId: b.principalId, operationId: randomUUID(), requestId: accepted.requestId, expectedVersion: 1 }, 'accept')
  assert.equal(m.contactRequests(a.auth, { principalId: a.principalId }).find(row => row.requestId === earlier.requestId).status, 'cancelled')
  const expired = request(a, b), expiredRejection = request(b, a)
  reject(a, expiredRejection)
  now += 86400001
  const recent = request(a, b), crossed = request(b, a)
  reject(b, recent); reject(a, crossed)
  const relation = m.relations(a.auth, { principalId: a.principalId })[0]
  m.revokeContact(a.auth, { principalId: a.principalId, operationId: randomUUID(), otherHumanPrincipalId: b.principalId, expectedVersion: relation.version })
  const rows = m.contactRequests(a.auth, { principalId: a.principalId })
  for (const item of [earlier, recent, crossed]) assert.equal(rows.find(row => row.requestId === item.requestId).status, 'cancelled')
  for (const item of [expired, unrelated]) assert.equal(rows.find(row => row.requestId === item.requestId).status, 'expired')
  assert.equal(rows.find(row => row.requestId === expiredRejection.requestId).status, 'rejected')
  assert.equal(m.contactRequests(b.auth, { principalId: b.principalId }).find(row => row.requestId === expiredRejection.requestId).status, 'expired')
  assert.equal(m.db.prepare('SELECT status FROM hub_contact_requests WHERE id=?').get(unrelated.requestId).status, 'rejected')
  assert.equal(m.canContact(a.principalId, b.principalId), false)
})

test('legacy cancelled and rejected records recover on restart without restoring contact authority', t => {
  let now = 100000
  const dir = mkdtempSync(join(tmpdir(), 'dsbot-contact-restart-')), path = join(dir, 'hub.sqlite')
  let store = new HubStore(path), m = new HubManagement(store, { now: () => now })
  t.after(() => { store.close(); rmSync(dir, { recursive: true, force: true }) })
  const a = enroll(m, 'A'), b = enroll(m, 'B')
  const request = () => m.requestContact(a.auth, { principalId: a.principalId, operationId: randomUUID(), userCode: m.code(b.auth, { principalId: b.principalId }).userCode })
  const accepted = request(), duplicate = request(), rejected = request()
  // These are the persisted terminal states written by the old implementation.
  store.db.prepare("UPDATE hub_contact_requests SET status='accepted',version=3 WHERE id=?").run(accepted.requestId)
  store.db.prepare("UPDATE hub_contact_requests SET status='cancelled',version=2 WHERE id=?").run(duplicate.requestId)
  store.db.prepare("UPDATE hub_contact_requests SET status='rejected',version=2 WHERE id=?").run(rejected.requestId)
  store.close(); store = new HubStore(path); m = new HubManagement(store, { now: () => now })
  const rows = m.contactRequests(a.auth, { principalId: a.principalId })
  assert.equal(rows.find(row => row.requestId === duplicate.requestId).status, 'cancelled')
  assert.equal(rows.find(row => row.requestId === rejected.requestId).version, 1)
  m.respondContact(a.auth, { principalId: a.principalId, operationId: randomUUID(), requestId: rejected.requestId, expectedVersion: 1 }, 'cancel')
  assert.deepEqual(m.relations(a.auth, { principalId: a.principalId }), [])
  assert.equal(m.canContact(a.principalId, b.principalId), false)
  now += 86400001
  assert.equal(m.contactRequests(a.auth, { principalId: a.principalId }).find(row => row.requestId === duplicate.requestId).status, 'cancelled')
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


test('self-departure removes devices, profiles, join rows and live contact relations while preserving signed status and history',t=>{
 const {store,m}=fixture(t),a=enroll(m,'Leaving'),b=enroll(m,'Remaining')
 const local=store.register(a.auth,{localId:'bot',kind:'bot',displayName:'Leaving Bot'}).principalId
 const remote=store.register(b.auth,{localId:'bot',kind:'bot',displayName:'Remaining Bot'}).principalId
 consent(m,a,b,[local],[remote])
 const dm=store.createDm(a.auth,{principalId:local,otherPrincipalId:remote,operationId:randomUUID()}).conversationId
 const oldEpoch=store.authorize(b.auth,{principalId:remote,conversationId:dm}).membershipEpoch
 const pending=m.requestContact(a.auth,{principalId:a.principalId,operationId:randomUUID(),userCode:m.code(b.auth,{principalId:b.principalId}).userCode,botPrincipalIds:[local]})
 const socket={},challenge=m.challenge(socket,{purpose:'leave',instanceId:a.auth.instanceId})
 store.beforeCommit=()=>{throw Error('Synthetic leave failure')}
 assert.throws(()=>m.prove(socket,proof(a.key,challenge)),/Synthetic leave failure/)
 assert.equal(store.db.prepare('SELECT trusted FROM instances WHERE id=?').get(a.auth.instanceId).trusted,1)
 assert.ok(m.instances().some(row=>row.instanceId===a.auth.instanceId))
 assert.equal(m.relations(b.auth,{principalId:b.principalId})[0].active,true)
 store.beforeCommit=undefined
 const leave={};m.prove(leave,proof(a.key,m.challenge(leave,{purpose:'leave',instanceId:a.auth.instanceId})))
 assert.ok(!m.instances().some(row=>row.instanceId===a.auth.instanceId))
 assert.ok(!m.participants().some(row=>row.homeInstanceId===a.auth.instanceId))
 assert.ok(!m.joins().some(row=>row.instanceId===a.auth.instanceId))
 assert.equal(m.relations(b.auth,{principalId:b.principalId})[0].active,false)
 assert.equal(store.db.prepare('SELECT status FROM hub_contact_requests WHERE id=?').get(pending.requestId).status,'cancelled')
 assert.notEqual(store.authorize(b.auth,{principalId:remote,conversationId:dm}).membershipEpoch,oldEpoch)
 assert.ok(store.db.prepare('SELECT 1 FROM conversations WHERE id=?').get(dm))
 const status={};assert.equal(m.prove(status,proof(a.key,m.challenge(status,{purpose:'leave-status',instanceId:a.auth.instanceId}))).left,true)
 m.repair({instanceId:a.auth.instanceId,expectedRevision:1})
 assert.ok(m.instances().some(row=>row.instanceId===a.auth.instanceId))
 assert.equal(m.relations(b.auth,{principalId:b.principalId})[0].active,false,'repair cannot silently restore contact consent')
})

test('legacy completed self-departures disappear after restart, while administrator revocations remain reviewable',t=>{
 const root=mkdtempSync(join(tmpdir(),'dsbot-departures-')),path=join(root,'hub.sqlite')
 let store=new HubStore(path),m=new HubManagement(store)
 t.after(()=>{store.close();rmSync(root,{recursive:true,force:true})})
 const a=enroll(m,'Legacy leaving'),b=enroll(m,'Admin revoked')
 store.revokeInstance(a.auth.instanceId);m.audit('instance.leave',a.auth.instanceId)
 m.revoke(b.auth.instanceId)
 store.close();store=new HubStore(path);m=new HubManagement(store)
 assert.ok(!m.instances().some(row=>row.instanceId===a.auth.instanceId))
 assert.ok(m.instances().some(row=>row.instanceId===b.auth.instanceId))
 const status={};assert.equal(m.prove(status,proof(a.key,m.challenge(status,{purpose:'leave-status',instanceId:a.auth.instanceId}))).left,true)
 store.close();store=new HubStore(path);m=new HubManagement(store)
 assert.equal(store.db.prepare('SELECT count(*) n FROM hub_instance_departures').get().n,1)
})


test('invalid or rotated contact codes fail before creating unreachable pending requests', t => {
  const { m } = fixture(t), a = enroll(m, 'Sender'), b = enroll(m, 'Recipient')
  const code = m.code(b.auth, { principalId: b.principalId }).userCode
  m.rotateCode(b.auth, { principalId: b.principalId, operationId: randomUUID() })
  for (const userCode of [code, 'FFFF-FFFF-FFFF-FFFF-FFFF-FFFF']) {
    assert.throws(() => m.requestContact(a.auth, { principalId: a.principalId, operationId: randomUUID(), userCode, sharePublishedBots: true }), { code: 'CONTACT_CODE_UNAVAILABLE' })
  }
  const current = m.code(b.auth, { principalId: b.principalId }).userCode
  for (let n = 0; n < 30; n++) m.rate(`contact-target:${b.principalId}`, 30, 86400000)
  assert.throws(() => m.requestContact(a.auth, { principalId: a.principalId, operationId: randomUUID(), userCode: current, sharePublishedBots: true }), { code: 'RATE_LIMITED' })
  assert.equal(m.db.prepare('SELECT count(*) n FROM hub_contact_requests').get().n, 0)
  assert.deepEqual(m.contactRequests(b.auth, { principalId: b.principalId }), [])
})


test('invalid-code failures consume rate limits without inserting contact requests or successful receipts', t => {
  const { m } = fixture(t), a = enroll(m)
  for (let n = 0; n < 10; n++) assert.throws(() => m.requestContact(a.auth, { principalId: a.principalId, operationId: randomUUID(), userCode: 'FFFF-FFFF-FFFF-FFFF-FFFF-FFFF' }), { code: 'CONTACT_CODE_UNAVAILABLE' })
  assert.throws(() => m.requestContact(a.auth, { principalId: a.principalId, operationId: randomUUID(), userCode: 'FFFF-FFFF-FFFF-FFFF-FFFF-FFFF' }), { code: 'RATE_LIMITED' })
  assert.equal(m.db.prepare('SELECT count(*) n FROM hub_contact_requests').get().n, 0)
  assert.equal(m.db.prepare('SELECT count(*) n FROM hub_management_operations').get().n, 0)
})

test('legacy target-null requests become unavailable and their old pending receipts cannot replay false success', t => {
  const { store, m } = fixture(t, { now: () => 100000 }), a = enroll(m)
  const input = { principalId: a.principalId, operationId: 'legacy-unreachable', userCode: 'FFFF-FFFF-FFFF-FFFF-FFFF-FFFF' }
  m.db.prepare("INSERT INTO hub_contact_requests(id,sender,target,scope,status,expires_at) VALUES (?,?,NULL,'[]','pending',200000)").run(input.operationId, input.principalId)
  m.db.prepare('INSERT INTO hub_management_operations VALUES (?,?,?,?)').run(input.operationId, input.principalId, hash(input), JSON.stringify({ requestId: input.operationId, status: 'pending' }))
  const upgraded = new HubManagement(store, { now: () => 100000 })
  const [row] = upgraded.contactRequests(a.auth, { principalId: a.principalId })
  assert.equal(row.status, 'unavailable'); assert.equal(row.errorCode, 'CONTACT_CODE_UNAVAILABLE')
  assert.throws(() => upgraded.requestContact(a.auth, input), { code: 'CONTACT_CODE_UNAVAILABLE' })
  assert.equal(m.db.prepare("SELECT count(*) n FROM hub_contact_requests WHERE status='pending'").get().n, 0)
})

test('genuine request retries survive code rotation while new requests need the current code', t => {
  const { m } = fixture(t), a = enroll(m), b = enroll(m)
  const code = m.code(b.auth, { principalId: b.principalId }).userCode
  const input = { principalId: a.principalId, operationId: randomUUID(), userCode: code, sharePublishedBots: true }
  const accepted = m.requestContact(a.auth, input)
  m.rotateCode(b.auth, { principalId: b.principalId, operationId: randomUUID() })
  assert.deepEqual(m.requestContact(a.auth, input), accepted)
  assert.throws(() => m.requestContact(a.auth, { ...input, operationId: randomUUID() }), { code: 'CONTACT_CODE_UNAVAILABLE' })
  const current = m.code(b.auth, { principalId: b.principalId }).userCode
  m.requestContact(a.auth, { ...input, operationId: randomUUID(), userCode: current })
  m.requestContact(a.auth, { ...input, operationId: randomUUID(), userCode: current })
  assert.equal(m.contactRequests(b.auth, { principalId: b.principalId }).length, 3)
})

test('legacy empty scopes are visible and can be repaired only by their owner without widening the other side', t => {
  const { store, m } = fixture(t), a = enroll(m), b = enroll(m)
  const botA = store.register(a.auth, { localId: 'shared', kind: 'bot', displayName: 'Shared A' }).principalId
  const hiddenA = store.register(a.auth, { localId: 'unshared', kind: 'bot', displayName: 'Unshared A' }).principalId
  const botB = store.register(b.auth, { localId: 'expert', kind: 'bot', displayName: 'Expert B' }).principalId
  consent(m, a, b, [botA], [])
  const before = m.relations(b.auth, { principalId: b.principalId })[0]
  assert.equal(before.botSharing, 'none'); assert.equal(before.otherBotSharing, 'selected')
  assert.equal(m.canContact(botA, botB), false)
  const dm = store.createDm(a.auth, { principalId: a.principalId, otherPrincipalId: b.principalId, operationId: randomUUID() }).conversationId
  const oldEpoch = store.member(a.auth, dm, a.principalId).epoch
  const input = { principalId: b.principalId, otherHumanPrincipalId: a.principalId, expectedVersion: before.version, operationId: randomUUID() }
  assert.throws(() => m.usePublishedBots(a.auth, input), { code: 'AUTHOR_MISMATCH' })
  store.beforeCommit = () => { throw Error('Synthetic repair rollback') }
  assert.throws(() => m.usePublishedBots(b.auth, input), /Synthetic repair rollback/)
  assert.equal(m.canContact(botA, botB), false); assert.equal(store.member(a.auth, dm, a.principalId).epoch, oldEpoch)
  store.beforeCommit = undefined
  const result = m.usePublishedBots(b.auth, input)
  assert.deepEqual(m.usePublishedBots(b.auth, input), result)
  assert.equal(m.canContact(botA, botB), true); assert.equal(m.canContact(hiddenA, botB), false)
  assert.notEqual(store.member(a.auth, dm, a.principalId).epoch, oldEpoch)
  assert.equal(m.relations(b.auth, { principalId: b.principalId })[0].botSharing, 'published')
  assert.equal(m.relations(a.auth, { principalId: a.principalId })[0].botSharing, 'selected')
  assert.throws(() => m.usePublishedBots(b.auth, { ...input, operationId: randomUUID() }), { code: 'CONTACT_VERSION_CONFLICT' })
  assert.throws(() => m.usePublishedBots(b.auth, { ...input, principalId: botB, operationId: randomUUID() }), { code: 'HUMAN_REQUIRED' })
})

test('optional automatic admission persists, verifies device proof and never changes existing pending/revoked devices', t => {
  const {store,m} = fixture(t)
  const submit = manager => {
    const key = keys(), socket = {}, challenge = manager.challenge(socket, {purpose:'join',publicKey:key.publicKey})
    return {key, ...manager.prove(socket, proof(key, challenge, {displayName:'Auto admission probe'}))}
  }
  assert.deepEqual(m.enrollmentPolicy(), {autoApprove:false,version:1})
  const pending = submit(m)
  assert.equal(pending.status, 'pending')
  assert.deepEqual(m.setEnrollmentPolicy({autoApprove:true,expectedVersion:1}), {autoApprove:true,version:2})
  assert.equal(m.joins().find(row=>row.requestId===pending.requestId).status, 'pending')
  assert.throws(()=>m.setEnrollmentPolicy({autoApprove:false,expectedVersion:1}), {code:'ENROLLMENT_POLICY_VERSION_CONFLICT'})
  assert.throws(()=>m.setEnrollmentPolicy({autoApprove:'true',expectedVersion:2}), {code:'INVALID_REQUEST'})
  const restarted = new HubManagement(store)
  assert.deepEqual(restarted.enrollmentPolicy(), {autoApprove:true,version:2})
  const socket = {}, key = keys(), forged = restarted.challenge(socket, {purpose:'join',publicKey:key.publicKey})
  assert.throws(()=>restarted.prove(socket, proof(keys(),forged,{displayName:'Invalid proof'})),{code:'UNAUTHENTICATED'})
  const approved = submit(restarted)
  assert.equal(approved.status,'approved')
  assert.equal(store.db.prepare('SELECT trusted FROM instances WHERE id=?').get(approved.instanceId).trusted,1)
  const login = restarted.challenge(socket,{purpose:'login',instanceId:approved.instanceId})
  assert.equal(restarted.prove(socket,proof(approved.key,login)).instanceId,approved.instanceId)
  assert.ok(store.db.prepare("SELECT 1 FROM hub_admin_audit WHERE action='join.auto-approve' AND subject=?").get(approved.instanceId))
  restarted.revoke(approved.instanceId)
  assert.throws(()=>restarted.challenge(socket,{purpose:'login',instanceId:approved.instanceId}),{code:'UNAUTHENTICATED'})
  assert.throws(()=>restarted.challenge(socket,{purpose:'join',publicKey:approved.key.publicKey}),{code:'ALREADY_ENROLLED'})
  restarted.setEnrollmentPolicy({autoApprove:false,expectedVersion:2})
  assert.equal(submit(restarted).status,'pending')
})

test('administrator deletes orphan applications independently and missing proofs return a domain error',t=>{
 const {m}=fixture(t),key=keys(),socket={}
 const challenge=m.challenge(socket,{purpose:'join',publicKey:key.publicKey})
 const request=m.prove(socket,proof(key,challenge,{displayName:'Orphan'}))
 const status=m.challenge(socket,{purpose:'status',requestId:request.requestId})
 const input={requestId:request.requestId,expectedVersion:1,confirmDelete:true}
 assert.throws(()=>m.deleteJoin({...input,confirmDelete:false}),{code:'JOIN_DELETE_CONFIRMATION_REQUIRED'})
 assert.equal(m.deleteJoin(input).deleted,true)
 assert.equal(m.deleteJoin(input).alreadyDeleted,true)
 assert.throws(()=>m.prove(socket,proof(key,status)),{code:'JOIN_NOT_FOUND'})
 assert.throws(()=>m.challenge(socket,{purpose:'cancel',requestId:request.requestId}),{code:'JOIN_NOT_FOUND'})
 const active=enroll(m),row=m.joins().find(r=>r.requestId===active.requestId)
 assert.throws(()=>m.deleteJoin({requestId:row.requestId,expectedVersion:row.version,confirmDelete:true}),{code:'JOIN_HAS_DEVICE'})
 assert.throws(()=>m.challenge(socket,{purpose:'leave-status',instanceId:'missing-device'}),{code:'INSTANCE_NOT_FOUND'})
})

test('profile names replace enrollment labels across devices, directories, members and approved requests', t => {
  const {store,m}=fixture(t),a=enroll(m,'Original enrollment name')
  store.register(a.auth,{localId:'local-user',kind:'human',displayName:'Original enrollment name'})
  const bot=store.register(a.auth,{localId:'helper',kind:'bot',displayName:'Helper'})
  const group=store.createGroup(a.auth,{principalId:a.principalId,title:'Name regression',operationId:randomUUID()})
  const epoch=store.db.prepare('SELECT epoch FROM memberships WHERE conversation_id=? AND principal_id=?').get(group.conversationId,a.principalId).epoch
  const profile=displayName=>store.profile(a.auth,{principalId:a.principalId,displayName,operationId:randomUUID()})
  const check=(name,label)=>{
    assert.equal(m.instances()[0].label,label)
    for(const people of [m.participants(),store.contacts(a.auth),store.members(a.auth,{principalId:a.principalId,conversationId:group.conversationId,membershipEpoch:epoch}).members]){
      assert.equal(people.find(p=>p.principalId===a.principalId).displayName,name)
      assert.ok(people.every(p=>p.instanceLabel===label))
    }
    assert.equal(m.participants().find(p=>p.principalId===bot.principalId).instanceLabel,label)
    const request=m.joins().find(row=>row.requestId===a.requestId)
    assert.equal(request.label,name);assert.equal(request.enrollmentLabel,'Original enrollment name')
    const socket={},challenge=m.challenge(socket,{purpose:'login',instanceId:a.auth.instanceId})
    assert.equal(m.prove(socket,proof(a.key,challenge)).label,label)
  }
  profile('Current profile');check('Current profile','Current profile')
  // Old databases keep the enrollment label; no migration or reconnect is needed.
  assert.equal(store.db.prepare('SELECT label FROM instances WHERE id=?').get(a.auth.instanceId).label,'Original enrollment name')
  store.register(a.auth,{localId:'local-user',kind:'human',displayName:'Original enrollment name'})
  check('Current profile','Current profile')
  profile(null);check('Original enrollment name','Original enrollment name')
  m.rename({instanceId:a.auth.instanceId,label:'Admin device alias',expectedNameVersion:0})
  profile('Second profile');check('Second profile','Admin device alias')
  store.renameHuman(a.auth,{principalId:a.principalId,displayName:'Third profile'})
  check('Third profile','Admin device alias')
})

test('device versions are optional authenticated metadata, survive disconnect and never gate compatible releases', t => {
 const {store,m}=fixture(t)
 const auth=store.connect('version-client','Version client',CAPABILITIES,'0.3.6')
 assert.equal(m.instances().find(i=>i.instanceId===auth.instanceId).clientVersion,'0.3.6')
 assert.equal(m.instances()[0].connected,false)
 store.connect('version-client','Version client',CAPABILITIES,'9.2.1-T2')
 assert.equal(m.instances()[0].clientVersion,'9.2.1-T2')
 store.connect('version-client','Version client',CAPABILITIES)
 assert.equal(m.instances()[0].clientVersion,null,'a legacy reconnect clears an obsolete version claim')
 store.connect('version-client','Version client',CAPABILITIES,'<script>')
 assert.equal(m.instances()[0].clientVersion,null)
})
