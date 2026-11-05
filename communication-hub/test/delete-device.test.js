import assert from 'node:assert/strict'
import { test } from 'node:test'
import { generateKeyPairSync, randomUUID, sign } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import WebSocket from 'ws'
import { HubStore } from '../src/store.js'
import { HubManagement, enrollmentTranscript } from '../src/management-store.js'
import { startHub } from '../src/server.js'
import { CAPABILITIES, PROTOCOL } from '../src/protocol.js'
import { execute, prepare } from '../src/admin-cli.js'

function enroll(m, key = generateKeyPairSync('ed25519')) {
  const socket = {}, challenge = m.challenge(socket, { purpose: 'join', publicKey: key.publicKey.export({ type: 'spki', format: 'pem' }).toString() })
  const request = m.prove(socket, { challengeId: challenge.challengeId, signature: sign(null, Buffer.from(enrollmentTranscript(challenge)), key.privateKey).toString('base64url'), displayName: 'Synthetic delete fixture' })
  const result = m.decide({ requestId: request.requestId, expectedVersion: 1, action: 'approve' })
  return { key, auth: m.store.connect(result.instanceId, 'Synthetic device', CAPABILITIES), principalId: `human:${result.instanceId}:local-user`, requestId: request.requestId }
}
function fixture(t) {
  const store = new HubStore(':memory:'), m = new HubManagement(store)
  t.after(() => store.close())
  const a = enroll(m), b = enroll(m), c = enroll(m)
  return { store, m, a, b, c }
}
const op = input => ({ operationId: randomUUID(), ...input })
const deletion = (m, person) => { const row = m.instances().find(i => i.instanceId === person.auth.instanceId); return { instanceId: row.instanceId, expectedPairingRevision: row.pairingRevision, expectedNameVersion: row.nameVersion, ownedSharedGroups: row.ownedSharedGroups.map(({conversationId,version})=>({conversationId,version})), confirmDelete: true } }
const member = (store, person, conversationId) => store.memberships(person.auth).memberships.find(m => m.conversationId === conversationId && m.principalId === person.principalId)
function add(store, owner, target, conversationId) {
  const invitation = store.invite(owner.auth, op({ principalId: owner.principalId, conversationId, membershipEpoch: member(store, owner, conversationId).membershipEpoch, inviteePrincipalId: target.principalId }))
  store.accept(target.auth, op({ principalId: target.principalId, inviteId: invitation.inviteId }))
}
function message(store, person, conversationId, text = 'Synthetic content') {
  const input = { protocol: PROTOCOL, type: 'message.publish', messageId: randomUUID(), conversationId,
    author: { principalId: person.principalId, homeInstanceId: person.auth.instanceId, kind: 'human' },
    membershipEpoch: member(store, person, conversationId).membershipEpoch, clientCreatedAt: '2026-11-05T00:00:00Z', content: { format: 'text', text }, mentions: [], replyToMessageId: null }
  store.publish(person.auth, input)
  return input
}
function consent(m, a, b) {
  const request = m.requestContact(a.auth, op({ principalId: a.principalId, userCode: m.code(b.auth, { principalId: b.principalId }).userCode, botPrincipalIds: [] }))
  m.respondContact(b.auth, op({ principalId: b.principalId, requestId: request.requestId, expectedVersion: 1, botPrincipalIds: [] }), 'accept')
}

test('permanent device deletion removes identities, private history, contact state, FK children, operation results and audit subjects', t => {
  const { store, m, a, b, c } = fixture(t), { db } = store
  const bot = store.register(a.auth, { localId: 'bot', kind: 'bot', displayName: 'Synthetic Bot' }).principalId
  const privateGroup = store.createGroup(a.auth, op({ principalId: a.principalId, title: 'Device-only group' })).conversationId
  const privateMessage = message(store, a, privateGroup)
  consent(m, a, b)
  const dm = store.createDm(a.auth, op({ principalId: a.principalId, otherPrincipalId: b.principalId })).conversationId
  const dmMessage = message(store, a, dm)
  const dmDelivery = db.prepare('SELECT * FROM deliveries WHERE message_id=? AND recipient_id=?').get(dmMessage.messageId, b.principalId)
  db.prepare('INSERT INTO responses VALUES (?,?)').run(dmDelivery.id, dmMessage.messageId)
  db.prepare('INSERT INTO input_updates VALUES (?,?,?,?,0)').run(dmMessage.messageId, dmDelivery.id, b.principalId, dmDelivery.membership_epoch)
  const root = db.prepare('SELECT root_id FROM message_causality WHERE message_id=?').get(dmMessage.messageId).root_id
  db.prepare('INSERT INTO bot_dispatches VALUES (?,?,?)').run(root, b.principalId, c.principalId)
  store.observeAddress(a.auth, '192.0.2.9')
  m.rename({ instanceId: a.auth.instanceId, label: 'Deletion fixture', expectedNameVersion: 0 })
  store.renameHuman(a.auth, { principalId: a.principalId, displayName: 'Fixture human' })
  db.prepare('INSERT INTO principal_avatar VALUES (?,?,?,?)').run(bot, '{}', null, null)
  db.prepare('INSERT INTO avatar_uploads VALUES (?,?,?,?,?)').run(bot, 'synthetic-upload', 'a'.repeat(64), 1, 'x')
  db.prepare('INSERT INTO cursors VALUES (?,?,?,?)').run(privateGroup, a.principalId, member(store, a, privateGroup).membershipEpoch, 1)
  const untouched = store.createGroup(c.auth, op({ principalId: c.principalId, title: 'Other device group' })).conversationId
  const untouchedMessage = message(store, c, untouched, 'Do not delete me')
  store.invite(c.auth, op({ principalId: c.principalId, conversationId: untouched, membershipEpoch: member(store, c, untouched).membershipEpoch, inviteePrincipalId: a.principalId }))
  const priorOtherMessage = db.prepare('SELECT * FROM messages WHERE id=?').get(untouchedMessage.messageId)
  const authChallenge = m.challenge({}, { purpose: 'login', instanceId: a.auth.instanceId })
  const statusChallenge = m.challenge({}, { purpose: 'status', requestId: a.requestId })
  const input = deletion(m, a), result = m.delete(input)
  assert.equal(result.deleted, true); assert.equal(result.principalsDeleted, 2); assert.equal(result.conversationsDeleted, 2)
  assert.equal(m.instances().length, 2); assert.equal(m.joins().some(r => r.requestId === a.requestId), false)
  assert.equal(m.challenges.has(authChallenge.challengeId), false)
  assert.equal(m.challenges.has(statusChallenge.challengeId), false)
  for (const table of ['instances', 'principals', 'hub_enrolled_peers', 'instance_features', 'instance_addresses', 'hub_instance_names', 'principal_preferences', 'principal_profiles', 'principal_publication', 'principal_avatar', 'avatar_uploads', 'hub_user_codes', 'hub_contacts', 'hub_contact_requests', 'memberships', 'cursors', 'invites', 'messages', 'events', 'deliveries', 'responses', 'input_updates', 'message_causality', 'causal_roots', 'bot_dispatches', 'operations', 'hub_management_operations', 'hub_admin_audit']) {
    const rows = JSON.stringify(db.prepare(`SELECT * FROM ${table}`).all())
    for (const id of [a.auth.instanceId, a.principalId, bot, privateGroup, dm, privateMessage.messageId, dmMessage.messageId, dmDelivery.id]) assert.equal(rows.includes(id), false, `${table} retained ${id}`)
  }
  assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), [])
  assert.deepEqual(db.prepare('SELECT * FROM messages WHERE id=?').get(untouchedMessage.messageId), priorOtherMessage)
  assert.deepEqual(m.relations(b.auth, { principalId: b.principalId }), [])
  assert.throws(() => store.check(a.auth), { code: 'UNAUTHENTICATED' })
  assert.throws(() => m.repair({ instanceId: a.auth.instanceId, expectedRevision: 1 }), { code: 'PAIRING_REVISION_CONFLICT' })
  assert.deepEqual(m.delete(input), { instanceId: input.instanceId, deleted: true, alreadyDeleted: true })
  const fresh = enroll(m, a.key)
  assert.notEqual(fresh.auth.instanceId, a.auth.instanceId)
  assert.notEqual(m.code(fresh.auth, { principalId: fresh.principalId }).userCode, undefined)
  assert.deepEqual(store.memberships(fresh.auth).memberships, [])
})

test('shared groups retain others and shared history, remove membership/routing and never grant new ownership', t => {
  const { store, m, a, b, c } = fixture(t), { db } = store
  const bot = store.register(a.auth, { localId: 'bot', kind: 'bot', displayName: 'Shared routing bot' }).principalId
  const group = store.createGroup(b.auth, op({ principalId: b.principalId, title: 'Shared group' })).conversationId
  add(store, b, a, group); add(store, b, c, group)
  const original = message(store, b, group)
  const personA = db.prepare('SELECT * FROM memberships WHERE conversation_id=? AND principal_id=?').get(group, a.principalId)
  db.prepare("UPDATE memberships SET speaking_mode='speak' WHERE conversation_id=? AND principal_id=?").run(group, a.principalId)
  const historical = message(store, a, group)
  db.prepare("UPDATE conversations SET admin_bot=?,routing_mode='admin' WHERE id=?").run(bot, group)
  const otherMemberships = db.prepare('SELECT * FROM memberships WHERE conversation_id=? AND principal_id<>? ORDER BY principal_id').all(group, a.principalId)
  const savedEvents = db.prepare('SELECT * FROM events WHERE conversation_id=? ORDER BY seq').all(group)
  const input = deletion(m, a), result = m.delete(input)
  assert.equal(result.sharedGroupsRetained, 1)
  assert.deepEqual(db.prepare('SELECT * FROM memberships WHERE conversation_id=? ORDER BY principal_id').all(group), otherMemberships)
  const retained = db.prepare('SELECT * FROM conversations WHERE id=?').get(group)
  assert.equal(retained.owner_id, b.principalId); assert.equal(retained.admin_bot, null); assert.equal(retained.routing_mode, 'mentionsOnly')
  assert.deepEqual(db.prepare('SELECT * FROM events WHERE conversation_id=? AND seq<=? ORDER BY seq').all(group, savedEvents.at(-1).seq), savedEvents)
  assert.ok(db.prepare('SELECT 1 FROM messages WHERE id=?').get(original.messageId))
  assert.ok(db.prepare('SELECT 1 FROM messages WHERE id=?').get(historical.messageId))
  assert.equal(db.prepare('SELECT 1 FROM principals WHERE id=?').get(a.principalId), undefined)
  assert.equal(db.prepare('SELECT 1 FROM deliveries WHERE recipient_id=?').get(a.principalId), undefined)
  assert.equal(db.prepare("SELECT json_extract(body,'$.reason') reason FROM events WHERE conversation_id=? AND type='membership.removed' ORDER BY seq DESC LIMIT 1").get(group).reason, 'deviceDeleted')
  assert.ok(personA); assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), [])
})

test('deletion is confirmed, versioned and atomic; owned shared groups close only after exact impact confirmation', t => {
  const { store, m, a, b } = fixture(t), { db } = store
  const input = deletion(m, a), login = m.challenge({}, { purpose: 'login', instanceId: a.auth.instanceId })
  assert.throws(() => m.delete({ ...input, confirmDelete: false }), { code: 'DEVICE_DELETE_CONFIRMATION_REQUIRED' })
  assert.throws(() => m.delete({ ...input, expectedPairingRevision: 2 }), { code: 'DEVICE_DELETE_VERSION_CONFLICT' })
  assert.throws(() => m.delete({ ...input, expectedNameVersion: 1 }), { code: 'DEVICE_DELETE_VERSION_CONFLICT' })
  assert.throws(() => m.delete({ ...input, extra: true }), { code: 'INVALID_REQUEST' })
  m.isConfiguredPeer = () => true
  assert.throws(() => m.delete(input), { code: 'STATIC_PEER_REMOVAL_REQUIRED' })
  m.isConfiguredPeer = undefined
  store.beforeCommit = () => { throw Error('Synthetic deletion commit failure') }
  assert.throws(() => m.delete(input), /Synthetic deletion commit failure/)
  store.beforeCommit = undefined
  assert.ok(m.peer(a.auth.instanceId)); assert.ok(m.challenges.has(login.challengeId)); store.check(a.auth)
  const group = store.createGroup(a.auth, op({ principalId: a.principalId, title: 'Owned shared group' })).conversationId
  add(store, a, b, group)
  assert.throws(() => m.delete(input), { code: 'DEVICE_DELETE_GROUPS_CHANGED' })
  assert.ok(m.peer(a.auth.instanceId)); assert.equal(db.prepare('SELECT owner_id FROM conversations WHERE id=?').get(group).owner_id, a.principalId)
  const freshInput = deletion(m, a)
  m.revoke(a.auth.instanceId)
  assert.throws(() => m.delete(freshInput), { code: 'DEVICE_DELETE_GROUPS_CHANGED' })
  const result = m.delete(deletion(m, a))
  assert.equal(result.deleted, true); assert.equal(result.sharedGroupsClosed, 1)
  const closed = db.prepare('SELECT owner_id,closed,admin_bot FROM conversations WHERE id=?').get(group)
  assert.equal(closed.owner_id, null); assert.equal(closed.closed, 1); assert.equal(closed.admin_bot, null)
  assert.equal(db.prepare('SELECT active,role FROM memberships WHERE conversation_id=? AND principal_id=?').get(group,b.principalId).active, 0)
  assert.equal(db.prepare('SELECT active,role FROM memberships WHERE conversation_id=? AND principal_id=?').get(group,b.principalId).role, 'member')
})

test('deleted identity stays absent after reopen and closed shared groups have no recovery owner', t => {
  const dir = mkdtempSync(join(tmpdir(), 'dsbot-delete-device-')), path = join(dir, 'hub.sqlite')
  let store = new HubStore(path), m = new HubManagement(store)
  t.after(() => { store.close(); rmSync(dir, { recursive: true, force: true }) })
  const a = enroll(m), b = enroll(m), group = store.createGroup(a.auth, op({ principalId: a.principalId, title: 'Closed shared group' })).conversationId
  add(store, a, b, group)
  store.dissolve(a.auth, op({ principalId: a.principalId, conversationId: group, membershipEpoch: member(store, a, group).membershipEpoch }))
  m.delete(deletion(m, a)); store.close()
  store = new HubStore(path); m = new HubManagement(store)
  assert.equal(m.instances().some(i => i.instanceId === a.auth.instanceId), false)
  assert.equal(store.db.prepare('SELECT owner_id FROM conversations WHERE id=?').get(group).owner_id, null)
  assert.throws(() => m.challenge({}, { purpose: 'login', instanceId: a.auth.instanceId }), { code: 'UNAUTHENTICATED' })
  assert.deepEqual(store.db.prepare('PRAGMA foreign_key_check').all(), [])
})

test('actual administrator CLI/HTTP deletion requires admin and closes live signed sockets, with no static-config resurrection', async t => {
  const password = 'synthetic-delete-device-admin-password', hub = await startHub({ databasePath: ':memory:', port: 0, management: { enabled: true, password } })
  t.after(() => hub.close())
  const a = enroll(hub.management), input = deletion(hub.management, a), origin = `http://127.0.0.1:${hub.port}`
  const socket = new WebSocket(hub.url); t.after(() => socket.terminate())
  await new Promise(resolve => socket.once('open', resolve))
  const request = (type, payload) => new Promise((resolve, reject) => {
    socket.once('message', bytes => { const response = JSON.parse(bytes); response.ok ? resolve(response.value) : reject(Object.assign(Error(response.error.code), { code: response.error.code })) })
    socket.send(JSON.stringify({ protocol: PROTOCOL, id: randomUUID(), type, payload }))
  })
  const challenge = await request('enrollment.challenge', { purpose: 'login', instanceId: a.auth.instanceId })
  await request('enrollment.prove', { challengeId: challenge.challengeId, signature: sign(null, Buffer.from(enrollmentTranscript(challenge)), a.key.privateKey).toString('base64url'), capabilities: CAPABILITIES })
  await assert.rejects(request('delete', input), { code: 'UNKNOWN_OPERATION' })
  const unauthorized = await fetch(origin + '/admin/api/delete', { method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify(input) })
  assert.equal(unauthorized.status, 401); assert.ok(hub.management.peer(a.auth.instanceId))
  const closed = new Promise(resolve => socket.once('close', resolve))
  assert.equal((await execute(prepare('delete', input), { url: origin, password })).deleted, true)
  await closed
  const state = await execute(prepare('state'), { url: origin, password })
  assert.equal(state.instances.length, 0); assert.equal(state.requests.length, 0)
  const staticHub = await startHub({ databasePath: ':memory:', port: 0, peers: [{ instanceId: 'static-delete-fixture', credential: 'synthetic-static-credential-at-least-32-characters' }], management: { enabled: true, password } })
  t.after(() => staticHub.close())
  staticHub.revoke('static-delete-fixture')
  await assert.rejects(execute(prepare('delete', { instanceId: 'static-delete-fixture', expectedPairingRevision: 1, expectedNameVersion: 0, ownedSharedGroups: [], confirmDelete: true }), { url: `http://127.0.0.1:${staticHub.port}`, password }), { code: 'STATIC_PEER_REMOVAL_REQUIRED' })
})
