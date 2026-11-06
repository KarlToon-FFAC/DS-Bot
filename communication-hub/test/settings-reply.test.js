import assert from 'node:assert/strict'
import { test } from 'node:test'
import { randomUUID } from 'node:crypto'
import { HubStore } from '../src/store.js'
import { CAPABILITIES, PROTOCOL, hash } from '../src/protocol.js'

function fixture(t, limits = {}) {
  const store = new HubStore(':memory:', { limits }); t.after(() => store.close())
  const a = store.connect('a', 'A', CAPABILITIES), b = store.connect('b', 'B', CAPABILITIES)
  const op = value => ({ operationId: randomUUID(), ...value })
  const add = (auth, localId, kind) => store.register(auth, { localId, kind, displayName: localId }).principalId
  const H = add(a, 'H', 'human'), R = add(b, 'R', 'human'), A = add(a, 'A', 'bot'), B = add(b, 'B', 'bot'), G = add(b, 'G', 'bot')
  const group = store.createGroup(a, op({ principalId: H, title: 'Before' })).conversationId
  const auth = id => id.split(':')[1] === 'a' ? a : b
  const member = (id, conversationId = group) => store.memberships(auth(id)).memberships.find(row => row.principalId === id && row.conversationId === conversationId && row.active)
  const scope = (id = H) => ({ principalId: id, conversationId: group, membershipEpoch: member(id).membershipEpoch, expectedVersion: member(id).membershipVersion })
  const join = id => {
    const invite = store.invite(a, op({ ...scope(), inviteePrincipalId: id }))
    store.accept(auth(id), op({ principalId: id, inviteId: invite.inviteId }))
  }
  const policy = (id, values) => store.policy(a, op({ ...scope(), targetPrincipalId: id, ...values }))
  for (const id of [R, A, B]) join(id)
  const input = (id, values = {}) => ({ protocol: PROTOCOL, type: 'message.publish', messageId: randomUUID(), conversationId: group,
    author: { principalId: id, homeInstanceId: id.split(':')[1], kind: id.split(':')[0] }, clientCreatedAt: new Date().toISOString(),
    content: { format: 'text', text: 'Reply text without a mention' }, mentions: [], replyToMessageId: null, membershipEpoch: member(id).membershipEpoch, ...values, ...(id.startsWith('bot:') ? { activationTargets: values.activationTargets ?? values.mentions ?? [] } : {}) })
  const send = (id, values) => store.publish(auth(id), input(id, values))
  const ai = message => store.db.prepare('SELECT recipient_id FROM deliveries WHERE message_id=? AND ai=1 ORDER BY recipient_id').all(message.messageId).map(row => row.recipient_id)
  const grant = (message, id) => {
    const delivery = store.db.prepare('SELECT * FROM deliveries WHERE message_id=? AND recipient_id=?').get(message.messageId, id)
    assert.equal(delivery.ai, 1)
    store.receipt(auth(id), { deliveryId: delivery.id, principalId: id, membershipEpoch: delivery.membership_epoch, status: 'targetStored' })
    return delivery.id
  }
  return { store, a, b, H, R, A, B, G, group, op, auth, member, scope, join, policy, input, send, ai, grant }
}

test('one settings save atomically updates title, receiving rule and policies with one version and idempotent event', t => {
  const f = fixture(t), before = f.scope()
  const input = f.op({ ...before, title: ' After ', routing: { mode: 'admin', adminBotPrincipalId: f.B },
    policies: [{ targetPrincipalId: f.A, speakingMode: 'active' }, { targetPrincipalId: f.R, role: 'admin', speakingMode: 'speak' }] })
  const result = f.store.settings(f.a, input)
  assert.deepEqual(result, { conversationId: f.group, updated: true, membershipVersion: before.expectedVersion + 1 })
  assert.deepEqual(f.store.settings(f.a, input), result)
  const info = f.store.members(f.a, before)
  assert.equal(info.title, 'After'); assert.equal(info.routingMode, 'admin'); assert.equal(info.adminBotPrincipalId, f.B)
  assert.equal(info.membershipVersion, before.expectedVersion + 1)
  assert.equal(info.members.find(row => row.principalId === f.A).speakingMode, 'active')
  assert.equal(info.members.find(row => row.principalId === f.R).role, 'admin')
  assert.equal(f.member(f.H).membershipEpoch, before.membershipEpoch)
  assert.equal(f.store.db.prepare("SELECT count(*) n FROM events WHERE type='group.settings.changed'").get().n, 1)
  assert.throws(() => f.store.settings(f.a, { ...input, title: 'Changed same ID' }), { code: 'OPERATION_ID_CONFLICT' })
  assert.throws(() => f.store.settings(f.a, { ...input, operationId: randomUUID() }), { code: 'GROUP_VERSION_CONFLICT' })
})

test('all settings fields validate before mutation; late policy failures and storage failures roll back every field', t => {
  const f = fixture(t)
  const state = () => ({ info: f.store.members(f.a, f.scope()), seq: f.member(f.H).watermark })
  const before = state()
  const invalid = [
    { policies: [{ targetPrincipalId: f.A, speakingMode: 'active' }, { targetPrincipalId: f.G, speakingMode: 'active' }] },
    { routing: { mode: 'admin', adminBotPrincipalId: f.G } },
    { routing: { mode: 'admin' } },
    { policies: [{ targetPrincipalId: f.H, role: 'member' }] },
    { policies: [{ targetPrincipalId: f.A, speakingMode: 'speak' }] },
    { policies: [{ targetPrincipalId: f.A, speakingMode: 'active' }, { targetPrincipalId: f.A, speakingMode: 'passive' }] },
    { policies: [{ targetPrincipalId: f.A }] },
    { routing: { mode: 'mentionsOnly', principalId: f.H } },
    { policies: [{ targetPrincipalId: f.A, speakingMode: 'active', principalId: f.H }] },
  ]
  for (const values of invalid) {
    assert.throws(() => f.store.settings(f.a, f.op({ ...f.scope(), title: 'Must roll back', ...values })))
    assert.deepEqual(state(), before)
  }
  assert.throws(() => f.store.settings(f.a, f.op({ ...f.scope(), policies: [] })), { code: 'INVALID_REQUEST' })
  f.store.beforeCommit = () => { throw new Error('synthetic transaction failure') }
  assert.throws(() => f.store.settings(f.a, f.op({ ...f.scope(), title: 'Uncommitted', routing: { mode: 'admin', adminBotPrincipalId: f.B },
    policies: [{ targetPrincipalId: f.A, speakingMode: 'active' }] })), /synthetic transaction failure/)
  assert.deepEqual(state(), before)
})

test('settings preserve owner/admin restrictions, current epoch checks and admin invitation revocation', t => {
  const f = fixture(t)
  assert.throws(() => f.store.settings(f.b, f.op({ ...f.scope(f.R), title: 'Forbidden' })), { code: 'FORBIDDEN' })
  f.policy(f.R, { role: 'admin' })
  f.store.settings(f.b, f.op({ ...f.scope(f.R), title: 'Admin title', policies: [{ targetPrincipalId: f.A, speakingMode: 'active' }] }))
  const version = f.member(f.H).membershipVersion
  for (const policy of [{ targetPrincipalId: f.A, role: 'admin' }, { targetPrincipalId: f.H, speakingMode: 'readOnly' }, { targetPrincipalId: f.R, speakingMode: 'speak' }]) {
    assert.throws(() => f.store.settings(f.b, f.op({ ...f.scope(f.R), title: 'Forbidden', policies: [policy] })), { code: 'FORBIDDEN' })
    assert.equal(f.member(f.H).membershipVersion, version)
  }
  assert.throws(() => f.store.settings(f.a, f.op({ ...f.scope(), membershipEpoch: 'old', title: 'Stale' })), { code: 'MEMBERSHIP_REVOKED' })
  const target = f.store.register(f.a, {localId:'pending-remote',kind:'bot',displayName:'Pending remote'}).principalId
  const invite={inviteId:randomUUID()}
  f.store.db.prepare('INSERT INTO invites(id,conversation_id,principal_id,inviter_id) VALUES (?,?,?,?)').run(invite.inviteId,f.group,target,f.R)
  f.store.settings(f.a, f.op({ ...f.scope(), policies: [{ targetPrincipalId: f.R, role: 'member' }] }))
  assert.throws(() => f.store.accept(f.a, f.op({ principalId: target, inviteId: invite.inviteId })), { code: 'INVITE_REVOKED' })
})

test('Human and active Bot explicit replies route to the exact current Bot without mutating payload mentions or hash', t => {
  const f = fixture(t)
  f.policy(f.A, { speakingMode: 'active' }); f.policy(f.B, { speakingMode: 'active' })
  const original = f.send(f.A)
  const humanInput = f.input(f.H, { replyToMessageId: original.messageId })
  const human = f.store.publish(f.a, humanInput)
  assert.deepEqual(f.ai(human), [f.A]); assert.deepEqual(human.payloadHash, hash(humanInput))
  assert.deepEqual(JSON.parse(f.store.db.prepare('SELECT body FROM messages WHERE id=?').get(human.messageId).body).mentions, [])
  const target = f.send(f.B)
  const active = f.send(f.A, { replyToMessageId: target.messageId, activationTargets: [{ principalId: f.B }], causationDeliveryId: f.grant(human, f.A) })
  assert.deepEqual(f.ai(active), [f.B]); assert.equal(active.causality.rootMessageId, human.messageId)
  assert.deepEqual(f.store.publish(f.a, humanInput), human)
  const explicit = f.send(f.H, { replyToMessageId: original.messageId, mentions: [{ principalId: f.B }] })
  assert.deepEqual(f.ai(explicit), [f.B])
  const humanMention = f.send(f.H, { replyToMessageId: original.messageId, mentions: [{ principalId: f.R }] })
  assert.deepEqual(f.ai(humanMention), [f.A])
  const self = f.send(f.A, { replyToMessageId: original.messageId })
  assert.deepEqual(f.ai(self), [])
})

test('automatic final reply references stay silent, passive replies still need one grant and causal bounds apply', t => {
  const f = fixture(t, { maxCausalDepth: 2 })
  f.policy(f.A, { speakingMode: 'active' })
  const source = f.send(f.A, { mentions: [{ principalId: f.B }] }), grant = f.grant(source, f.B)
  const final = f.send(f.B, { responseToDeliveryId: grant, replyToMessageId: source.messageId })
  assert.deepEqual(f.ai(final), [])
  assert.throws(() => f.send(f.B, { replyToMessageId: source.messageId }), { code: 'PASSIVE_REPLY_REQUIRED' })
  assert.throws(() => f.send(f.B, { responseToDeliveryId: grant, replyToMessageId: source.messageId }), { code: 'RESPONSE_ALREADY_SENT' })
  const human = f.send(f.H, { replyToMessageId: source.messageId })
  const a = f.send(f.A, { replyToMessageId: final.messageId, activationTargets: [{ principalId: f.B }], causationDeliveryId: f.grant(human, f.A) })
  assert.deepEqual(f.ai(a), [f.B])
  const b = f.send(f.B, { responseToDeliveryId: f.grant(a, f.B), replyToMessageId: a.messageId, mentions: [{ principalId: f.A }] })
  assert.equal(b.dispatchSuppressed, 'CAUSAL_LIMIT'); assert.deepEqual(f.ai(b), [])
})

test('removed and rejoined reply authors, stale sender history and foreign conversations fail closed', t => {
  const f = fixture(t)
  f.policy(f.A, { speakingMode: 'active' })
  const original = f.send(f.A)
  f.store.remove(f.a, f.op({ ...f.scope(), targetPrincipalId: f.A }))
  assert.throws(() => f.send(f.H, { replyToMessageId: original.messageId }), { code: 'INVALID_REPLY_TARGET' })
  f.join(f.A); f.policy(f.A, { speakingMode: 'active' })
  assert.throws(() => f.send(f.H, { replyToMessageId: original.messageId }), { code: 'INVALID_REPLY_TARGET' })
  f.store.remove(f.a, f.op({ ...f.scope(), targetPrincipalId: f.R })); f.join(f.R); f.policy(f.R, { speakingMode: 'speak' })
  assert.throws(() => f.send(f.R, { replyToMessageId: original.messageId }), { code: 'INVALID_REPLY_TARGET' })
  const dm = f.store.createDm(f.a, f.op({ principalId: f.H, otherPrincipalId: f.A })).conversationId
  assert.throws(() => f.send(f.H, { conversationId: dm, membershipEpoch: f.member(f.H, dm).membershipEpoch, replyToMessageId: original.messageId }), { code: 'INVALID_REPLY_TARGET' })
})
