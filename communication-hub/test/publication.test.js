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

test('withdrawal permanently retires group identity, preserves bounded history and requires explicit new membership', t => {
  const f = fixture(t)
  assert.ok(HUB_CAPABILITIES.includes('bot-publication-generations'))
  const botInput = f.input(f.B), botAck = f.store.publish(f.b, botInput)
  const initial = f.store.publish(f.a, f.input(f.H, [f.B]))
  const old = f.store.pending(f.b).find(row => row.messageId === initial.messageId && row.recipientPrincipalId === f.B)
  const membership = f.member(f.B)
  assert.deepEqual(f.store.syncPublication(f.b, { principalIds: [] }), { principalIds: [] })
  assert.ok(!f.store.contacts(f.a).some(row => row.principalId === f.B))
  for (const id of [f.H, f.R, f.A]) assert.ok(f.store.contacts(f.a).some(row => row.principalId === id))
  const info = f.store.members(f.a, f.scope())
  assert.ok(!info.members.some(row => row.principalId === f.B))
  assert.equal(info.formerMembers.find(row => row.principalId === f.B).retired, true)
  assert.equal(f.store.readPublicProfile(f.a,{principalId:f.H,conversationId:f.group,membershipEpoch:f.member(f.H).membershipEpoch,targetPrincipalId:f.B}).principalId,f.B)
  assert.equal(f.store.pending(f.b).filter(row => row.ai).length, 0)
  assert.throws(() => f.store.publish(f.b, f.input(f.B)), { code: 'BOT_NOT_PUBLISHED' })
  assert.deepEqual(f.store.publish(f.b, botInput), botAck)
  assert.throws(() => f.store.invite(f.a, f.op({ ...f.scope(), inviteePrincipalId: f.B })), { code: 'BOT_NOT_PUBLISHED' })
  assert.throws(() => f.store.publish(f.a, f.input(f.H, [f.B])), { code: 'BOT_RETIRED' })
  assert.throws(() => f.store.syncPublication(f.b, { principalIds: [f.B] }), { code: 'BOT_RETIRED' })
  assert.throws(() => f.store.register(f.b, { localId: 'B', kind: 'bot', displayName: 'B' }), { code: 'BOT_RETIRED' })
  assert.equal(f.store.db.prepare('SELECT revoked FROM deliveries WHERE id=?').get(old.deliveryId).revoked, 1)
  const archived = f.store.sync(f.b, { conversationId: f.group, principalId: f.B, membershipEpoch: membership.membershipEpoch, after: membership.joinSeq - 1 })
  f.store.publish(f.a, f.input(f.H))
  assert.equal(f.store.sync(f.b, { conversationId: f.group, principalId: f.B, membershipEpoch: membership.membershipEpoch, after: archived.watermark }).events.length, 0)
  const fresh=f.store.register(f.b,{localId:'B-new',kind:'bot',displayName:'B'}).principalId
  f.store.syncPublication(f.b,{principalIds:[fresh]})
  assert.ok(!f.store.members(f.a,f.scope()).members.some(row=>row.principalId===fresh))
  assert.throws(()=>f.store.authorize(f.b,{principalId:f.B,conversationId:f.group,membershipEpoch:membership.membershipEpoch}),{code:'BOT_RETIRED'})
  const invite=f.store.invite(f.a,f.op({...f.scope(),inviteePrincipalId:fresh}))
  assert.ok(invite.inviteId)
  assert.equal(f.store.members(f.a,f.scope()).members.find(row=>row.principalId===fresh).role,'member')
})

test('publication cancellation removes the default reply assignment once and cannot re-enable the retired identity', t => {
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
  assert.throws(() => f.store.syncPublication(f.b, { principalIds: [f.B] }), {code:'BOT_RETIRED'})
  assert.equal(f.store.members(f.a, f.scope()).adminBotPrincipalId, null)
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
  assert.equal(f.store.retirementOf(f.A),null)
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
  assert.throws(() => f.store.register(f.b, { localId: 'B', kind: 'bot', displayName: 'B desired again' }), {code:'BOT_RETIRED'})
  assert.equal(f.store.isPublished(f.B), false)
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
  assert.throws(() => f.store.syncPublication(f.b, { principalIds: [f.B] }), {code:'BOT_RETIRED'})
  const info=f.store.members(f.a,{principalId:f.H,conversationId:dm.conversationId,membershipEpoch:scope.membershipEpoch})
  assert.equal(info.members.find(row=>row.principalId===f.B).retired,true)
  assert.throws(()=>f.store.authorize(f.a,{principalId:f.H,conversationId:dm.conversationId,membershipEpoch:scope.membershipEpoch}),{code:'BOT_RETIRED'})
  assert.equal(f.store.memberships(f.a).memberships.find(member=>member.conversationId===dm.conversationId).retiredPeer,true)
  const fresh=f.store.register(f.b,{localId:'B-fresh',kind:'bot',displayName:'B'}).principalId
  const newDm=f.store.createDm(f.a,f.op({principalId:f.H,otherPrincipalId:fresh}))
  assert.notEqual(newDm.conversationId,dm.conversationId)
})

test('schema 5 hidden identities migrate to permanent tombstones without rewriting canonical messages',t=>{
  const f=fixture(t,true)
  const message=f.input(f.B);f.store.publish(f.b,message)
  const before=f.store.db.prepare('SELECT body FROM messages WHERE id=?').get(message.messageId).body
  f.store.db.prepare('UPDATE principal_publication SET published=0 WHERE principal_id=?').run(f.B)
  f.store.db.exec('DROP TABLE retired_memberships; DROP TABLE principal_retirements; DELETE FROM schema_version WHERE version=6; PRAGMA user_version=5')
  f.store.close();f.store=new HubStore(f.path)
  f.a=f.store.connect('a','A',CAPABILITIES);f.b=f.store.connect('b','B',CAPABILITIES)
  assert.equal(f.store.retirementOf(f.B).retired,true)
  assert.equal(f.store.db.prepare('SELECT body FROM messages WHERE id=?').get(message.messageId).body,before)
  assert.ok(!f.store.members(f.a,f.scope()).members.some(person=>person.principalId===f.B))
  assert.equal(f.store.members(f.a,f.scope()).formerMembers.find(person=>person.principalId===f.B).retired,true)
  assert.throws(()=>f.store.register(f.b,{localId:'B',kind:'bot',displayName:'B'}),{code:'BOT_RETIRED'})
})
