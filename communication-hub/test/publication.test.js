import assert from 'node:assert/strict'
import { test } from 'node:test'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { HubStore } from '../src/store.js'
import { CAPABILITIES, HUB_CAPABILITIES, PROTOCOL } from '../src/protocol.js'

function fixture(t, disk = false) {
  const dir = disk && mkdtempSync(join(tmpdir(), 'dsbot-publication-'))
  const f = { path: dir ? join(dir, 'hub.sqlite') : ':memory:' }
  f.store = new HubStore(f.path)
  t.after(() => { f.store.close(); if (dir) rmSync(dir, { recursive: true, force: true }) })
  f.a = f.store.connect('a', 'A', CAPABILITIES); f.b = f.store.connect('b', 'B', CAPABILITIES)
  const add = (auth, localId, kind) => f.store.register(auth, { localId, kind, displayName: localId }).principalId
  f.H = add(f.a, 'H', 'human'); f.R = add(f.b, 'R', 'human'); f.A = add(f.a, 'A', 'bot'); f.B = add(f.b, 'B', 'bot')
  f.op = input => ({ operationId: randomUUID(), ...input })
  f.group = f.store.createGroup(f.a, f.op({ principalId: f.H, title: 'Retained group' })).conversationId
  f.member = id => f.store.memberships(id === f.B || id === f.R ? f.b : f.a).memberships.find(row => row.principalId === id && row.conversationId === f.group)
  f.scope = () => ({ principalId: f.H, conversationId: f.group, membershipEpoch: f.member(f.H).membershipEpoch, expectedVersion: f.member(f.H).membershipVersion })
  for (const [id, auth] of [[f.A, f.a], [f.B, f.b]]) {
    const invite = f.store.invite(f.a, f.op({ ...f.scope(), inviteePrincipalId: id }))
    f.store.accept(auth, f.op({ principalId: id, inviteId: invite.inviteId }))
    f.store.policy(f.a, f.op({ ...f.scope(), targetPrincipalId: id, speakingMode: 'active' }))
  }
  f.input = (id, mentions = []) => ({ protocol: PROTOCOL, type: 'message.publish', messageId: randomUUID(), conversationId: f.group,
    author: { principalId: id, homeInstanceId: id.split(':')[1], kind: id.split(':')[0] }, clientCreatedAt: new Date().toISOString(),
    content: { format: 'text', text: 'Published Bot message' }, mentions: mentions.map(principalId => ({ principalId })), replyToMessageId: null, membershipEpoch: f.member(id).membershipEpoch, ...(id.startsWith('bot:') ? { activationTargets: mentions.map(principalId => ({principalId})) } : {}) })
  return f
}

test('explicit publication sync hides only owned Bots, retains Human and group identities, and never revives cancelled AI deliveries', t => {
  const f = fixture(t)
  assert.ok(HUB_CAPABILITIES.includes('principal-publication'))
  assert.ok(!CAPABILITIES.includes('principal-publication'))
  const botInput = f.input(f.B), botAck = f.store.publish(f.b, botInput)
  const initial = f.input(f.H, [f.B]), message = f.store.publish(f.a, initial)
  const old = f.store.pending(f.b).find(row => row.messageId === message.messageId && row.recipientPrincipalId === f.B)
  assert.equal(old.ai, true)
  const membership = f.member(f.B)
  assert.deepEqual(f.store.syncPublication(f.b, { principalIds: [] }), { principalIds: [] })
  assert.ok(!f.store.contacts(f.a).some(row => row.principalId === f.B))
  for (const id of [f.H, f.R, f.A]) assert.ok(f.store.contacts(f.a).some(row => row.principalId === id))
  assert.deepEqual(f.member(f.B), membership)
  const info = f.store.members(f.a, f.scope())
  assert.equal(info.members.find(row => row.principalId === f.B).published, false)
  assert.equal(info.members.find(row => row.principalId === f.A).published, true)
  assert.equal(f.store.pending(f.b).filter(row => row.ai).length, 0)
  assert.throws(() => f.store.publish(f.b, f.input(f.B)), { code: 'BOT_NOT_PUBLISHED' })
  assert.deepEqual(f.store.publish(f.b, botInput), botAck)
  assert.throws(() => f.store.invite(f.a, f.op({ ...f.scope(), inviteePrincipalId: f.B })), { code: 'BOT_NOT_PUBLISHED' })
  const during = f.store.publish(f.a, f.input(f.H, [f.B]))
  assert.equal(f.store.db.prepare('SELECT ai FROM deliveries WHERE message_id=? AND recipient_id=?').get(during.messageId, f.B).ai, 0)
  f.store.syncPublication(f.b, { principalIds: [f.B] })
  assert.equal(f.store.db.prepare('SELECT revoked FROM deliveries WHERE id=?').get(old.deliveryId).revoked, 1)
  assert.equal(f.store.db.prepare('SELECT ai FROM deliveries WHERE message_id=? AND recipient_id=?').get(during.messageId, f.B).ai, 0)
  const after = f.store.publish(f.a, f.input(f.H, [f.B]))
  assert.equal(f.store.pending(f.b).find(row => row.messageId === after.messageId && row.recipientPrincipalId === f.B).ai, true)
  assert.equal(f.store.sync(f.b, { conversationId: f.group, principalId: f.B, membershipEpoch: membership.membershipEpoch, after: membership.joinSeq - 1 }).events.filter(event => event.type === 'message').length, 4)
})

test('publication cancellation removes the default reply assignment once and cannot be reselected until explicitly republished', t => {
  const f = fixture(t)
  f.store.routing(f.a, f.op({ ...f.scope(), mode: 'admin', adminBotPrincipalId: f.B }))
  const version = f.member(f.H).membershipVersion
  f.store.syncPublication(f.b, { principalIds: [] })
  const info = f.store.members(f.a, f.scope())
  assert.equal(info.routingMode, 'mentionsOnly'); assert.equal(info.adminBotPrincipalId, null)
  assert.equal(info.membershipVersion, version + 1)
  f.store.syncPublication(f.b, { principalIds: [] })
  assert.equal(f.member(f.H).membershipVersion, version + 1)
  assert.throws(() => f.store.routing(f.a, f.op({ ...f.scope(), mode: 'admin', adminBotPrincipalId: f.B })), { code: 'INVALID_ADMIN' })
  assert.throws(() => f.store.settings(f.a, f.op({ ...f.scope(), title: 'Must not change', routing: { mode: 'admin', adminBotPrincipalId: f.B } })), { code: 'INVALID_ADMIN' })
  assert.equal(f.store.members(f.a, f.scope()).title, 'Retained group')
  f.store.syncPublication(f.b, { principalIds: [f.B] })
  assert.equal(f.store.members(f.a, f.scope()).adminBotPrincipalId, null)
  f.store.routing(f.a, f.op({ ...f.scope(), mode: 'admin', adminBotPrincipalId: f.B }))
})

test('complete publication lists require registered Bot ownership, reject stale auth and roll back every change on failure', t => {
  const f = fixture(t)
  assert.throws(() => f.store.syncPublication(f.a, { principalIds: [f.B] }), { code: 'AUTHOR_MISMATCH' })
  assert.throws(() => f.store.syncPublication(f.a, { principalIds: [f.H] }), { code: 'INVALID_REQUEST' })
  assert.throws(() => f.store.syncPublication(f.a, { principalIds: ['bot:a:unknown'] }), { code: 'AUTHOR_MISMATCH' })
  assert.throws(() => f.store.syncPublication({ instanceId: 'a', epoch: 0 }, { principalIds: [] }), { code: 'STALE_CONNECTION' })
  assert.equal(f.store.isPublished(f.A), true)
  f.store.beforeCommit = () => { throw new Error('synthetic publication failure') }
  assert.throws(() => f.store.syncPublication(f.a, { principalIds: [] }), /synthetic publication failure/)
  assert.equal(f.store.isPublished(f.A), true)
  assert.equal(f.store.isPublished(f.B), true)
})

test('legacy publication defaults and explicit unpublished state survive restart; offline instances do not auto-unpublish', t => {
  const f = fixture(t, true)
  f.store.db.prepare('DELETE FROM principal_publication WHERE principal_id=?').run(f.A)
  assert.equal(f.store.isPublished(f.A), true)
  f.store.syncPublication(f.b, { principalIds: [] })
  f.store.close(); f.store = new HubStore(f.path)
  assert.equal(f.store.isPublished(f.A), true)
  assert.equal(f.store.isPublished(f.B), false)
  f.a = f.store.connect('a', 'A reconnected', CAPABILITIES)
  assert.ok(f.store.contacts(f.a).some(row => row.principalId === f.A))
  assert.ok(!f.store.contacts(f.a).some(row => row.principalId === f.B))
  f.b = f.store.connect('b', 'B reconnected', CAPABILITIES)
  assert.equal(f.store.isPublished(f.B), false)
  f.store.register(f.b, { localId: 'B', kind: 'bot', displayName: 'B desired again' })
  assert.equal(f.store.isPublished(f.B), true)
})

test('hidden Bot IDs cannot open a DM or receive new DM publishes; already accepted ACKs remain stable', t => {
  const f = fixture(t)
  const open = f.op({ principalId: f.H, otherPrincipalId: f.B })
  const dm = f.store.createDm(f.a, open)
  const scope = f.store.memberships(f.a).memberships.find(row => row.conversationId === dm.conversationId)
  const original = { ...f.input(f.H), conversationId: dm.conversationId, membershipEpoch: scope.membershipEpoch }
  const accepted = f.store.publish(f.a, original)
  f.store.syncPublication(f.b, { principalIds: [] })
  assert.deepEqual(f.store.createDm(f.a, open), dm)
  assert.deepEqual(f.store.publish(f.a, original), accepted)
  assert.throws(() => f.store.createDm(f.a, f.op({ principalId: f.H, otherPrincipalId: f.B })), { code: 'BOT_NOT_PUBLISHED' })
  assert.throws(() => f.store.publish(f.a, { ...original, messageId: randomUUID() }), { code: 'BOT_NOT_PUBLISHED' })
  f.store.syncPublication(f.b, { principalIds: [f.B] })
  const next = f.store.publish(f.a, { ...original, messageId: randomUUID() })
  assert.equal(f.store.pending(f.b).find(row => row.messageId === next.messageId).ai, true)
})
