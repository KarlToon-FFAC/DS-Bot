import assert from 'node:assert/strict'
import { test } from 'node:test'
import { randomUUID } from 'node:crypto'
import { HubStore } from '../src/store.js'
import { CAPABILITIES, PROTOCOL, identifier, responseBytes } from '../src/protocol.js'

function fixture(t, options) {
  const store = new HubStore(':memory:', options); t.after(() => store.close())
  const a = store.connect('a', 'A', CAPABILITIES), b = store.connect('b', 'B', CAPABILITIES)
  const add = (auth, id) => store.register(auth, { localId: id, kind: 'human', displayName: id }).principalId
  const A = add(a, 'A'), B = add(b, 'B')
  const group = store.createGroup(a, { operationId: randomUUID(), principalId: A, title: 'Security' }).conversationId
  const scoped = (principalId, values = {}) => ({ operationId: randomUUID(), principalId, conversationId: group,
    membershipEpoch: store.db.prepare('SELECT epoch FROM memberships WHERE conversation_id=? AND principal_id=?').get(group, principalId)?.epoch, ...values })
  const invite = () => store.invite(a, scoped(A, { inviteePrincipalId: B }))
  const accept = invitation => store.accept(b, { operationId: randomUUID(), principalId: B, inviteId: invitation.inviteId })
  const publish = (principalId, values = {}) => ({ protocol: PROTOCOL, type: 'message.publish', messageId: randomUUID(), conversationId: group,
    author: { principalId, homeInstanceId: principalId.split(':')[1], kind: 'human' }, clientCreatedAt: new Date().toISOString(),
    content: { format: 'text', text: 'synthetic' }, mentions: [], replyToMessageId: null, membershipEpoch: scoped(principalId).membershipEpoch, ...values })
  return { store, a, b, A, B, group, scoped, invite, accept, publish }
}

test('missing and stale actor epochs cannot publish or mutate after rejoin; a committed retry returns only its original ACK', t => {
  const { store, a, b, A, B, group, scoped, invite, accept, publish } = fixture(t)
  accept(invite())
  const grant = () => store.policy(a, scoped(A, { targetPrincipalId: B, speakingMode: 'speak', expectedVersion: store.memberships(a).memberships[0].membershipVersion }))
  grant()
  const committed = publish(B), ack = store.publish(b, committed), stale = publish(B)
  const oldRemove = scoped(B, { targetPrincipalId: B })
  store.remove(a, scoped(A, { targetPrincipalId: B })); accept(invite()); grant()
  assert.throws(() => store.publish(b, stale), { code: 'MEMBERSHIP_REVOKED' })
  assert.throws(() => store.remove(b, oldRemove), { code: 'MEMBERSHIP_REVOKED' })
  const missing = publish(B); delete missing.membershipEpoch
  assert.throws(() => store.publish(b, missing), { code: 'MEMBERSHIP_EPOCH_REQUIRED' })
  const mutation = scoped(A, { targetPrincipalId: B }); delete mutation.membershipEpoch
  assert.throws(() => store.remove(a, mutation), { code: 'MEMBERSHIP_EPOCH_REQUIRED' })
  assert.deepEqual(store.publish(b, committed), ack)
  assert.equal(store.db.prepare('SELECT count(*) n FROM messages').get().n, 1)
  assert.equal(store.authorize(b, { principalId: B, conversationId: group }).principalId, B)
})

test('removing a pending or previously removed invitee revokes the invitation before acceptance', t => {
  const { store, a, A, B, scoped, invite, accept } = fixture(t)
  for (let cycle = 0; cycle < 2; cycle++) {
    const invitation = invite()
    store.remove(a, scoped(A, { targetPrincipalId: B }))
    assert.throws(() => accept(invitation), { code: 'INVITE_REVOKED' })
    if (cycle === 0) { accept(invite()); store.remove(a, scoped(A, { targetPrincipalId: B })) }
  }
})

test('accepted publishes fit complete sync and delivery envelopes; malformed identifiers/dates and event-ID collisions fail before commit', t => {
  const { store, a, b, A, B, group, invite, accept, publish } = fixture(t, { limits: { maxEnvelopeBytes: 4096 } })
  accept(invite())
  store.publish(a, publish(A, { content: { format: 'text', text: 'x'.repeat(1600) } }))
  const member = store.authorize(b, { conversationId: group, principalId: B })
  const sync = store.sync(b, { conversationId: group, principalId: B, membershipEpoch: member.membershipEpoch, after: member.joinSeq - 1 })
  assert.ok(responseBytes(sync) <= store.limits.maxEnvelopeBytes)
  assert.ok(responseBytes(store.pending(b)) <= store.limits.maxEnvelopeBytes)
  const count = store.db.prepare('SELECT count(*) n FROM messages').get().n
  assert.throws(() => store.publish(a, publish(A, { clientCreatedAt: ' '.repeat(4000) + new Date().toISOString() })), { code: 'INVALID_REQUEST' })
  assert.throws(() => store.publish(a, publish(A, { content: { format: 'text', text: 'x'.repeat(3600) } })), { code: 'PAYLOAD_TOO_LARGE' })
  const eventId = store.db.prepare('SELECT id FROM events WHERE type!=? LIMIT 1').get('message').id
  assert.throws(() => store.publish(a, publish(A, { messageId: eventId })), { code: 'MESSAGE_ID_CONFLICT' })
  assert.throws(() => identifier('bad-\ud800'), { code: 'INVALID_REQUEST' })
  assert.equal(store.db.prepare('SELECT count(*) n FROM messages').get().n, count)
})

test('an absent owner retains a reserved group slot and can reclaim without exceeding the limit', t => {
  const { store, a, b, A, B, group, scoped, invite, accept } = fixture(t, { limits: { maxMembers: 2 } })
  accept(invite())
  store.policy(a, scoped(A, { targetPrincipalId: B, role: 'admin', expectedVersion: store.members(a, scoped(A)).membershipVersion }))
  const C = store.register(b, { localId: 'C', kind: 'bot', displayName: 'C' }).principalId
  const invitation = store.invite(b, scoped(B, { inviteePrincipalId: C }))
  store.revokeInstance('a'); store.configurePeer('a', 'A', 2)
  const next = store.connect('a', 'A', CAPABILITIES)
  const version = store.members(b, { conversationId: group, principalId: B }).membershipVersion
  assert.throws(() => store.accept(b, { operationId: randomUUID(), principalId: C, inviteId: invitation.inviteId }), { code: 'MEMBER_LIMIT' })
  store.reclaim(next, { operationId: randomUUID(), principalId: A, conversationId: group, expectedVersion: version })
  assert.equal(store.db.prepare('SELECT count(*) n FROM memberships WHERE conversation_id=? AND active=1').get(group).n, 2)
})

test('an exactly full accepted envelope remains pullable and readable as later watermarks gain digits', t => {
  const { store, a, A, group, invite, accept, publish } = fixture(t)
  accept(invite())
  const original = publish(A, { content: { format: 'text', text: 'x'.repeat(500) } })
  const first = store.publish(a, original), delivery = store.pending(a)[0]
  const member = store.member(a, group, A)
  const syncBytes = responseBytes(store.syncValue(member, Number.MAX_SAFE_INTEGER, [delivery.event]))
  store.limits.maxEnvelopeBytes = Math.max(syncBytes, responseBytes([delivery]))
  const second = store.publish(a, publish(A, { content: { format: 'text', text: 'x'.repeat(500) } }))
  const page = store.pending(a)
  assert.equal(page.length, 1)
  assert.equal(responseBytes(page), store.limits.maxEnvelopeBytes)
  assert.equal(page[0].messageId, original.messageId)
  for (let i = 0; i < 12; i++) store.publish(a, publish(A, { content: { format: 'text', text: 'short' } }))
  const history = store.sync(a, { conversationId: group, principalId: A, membershipEpoch: member.epoch, after: first.conversationSeq - 1 })
  assert.ok(history.watermark >= 10)
  assert.equal(history.events[0].message.messageId, original.messageId)
  assert.ok(responseBytes(history) <= store.limits.maxEnvelopeBytes)
  assert.equal(store.publish(a, original).conversationSeq, first.conversationSeq)
  assert.equal(second.conversationSeq, first.conversationSeq + 1)
})
