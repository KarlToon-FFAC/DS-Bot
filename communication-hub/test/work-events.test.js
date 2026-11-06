import assert from 'node:assert/strict'
import { test } from 'node:test'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { HubStore } from '../src/store.js'
import { CAPABILITIES, PROTOCOL } from '../src/protocol.js'

function fixture(t, disk = false) {
  const dir = disk && mkdtempSync(join(tmpdir(), 'dsbot-started-'))
  const f = { path: dir ? join(dir, 'hub.sqlite') : ':memory:' }
  f.store = new HubStore(f.path)
  t.after(() => { f.store.close(); if (dir) rmSync(dir, { recursive: true, force: true }) })
  f.a = f.store.connect('a', 'A', CAPABILITIES); f.b = f.store.connect('b', 'B', CAPABILITIES)
  f.store.register(f.b, {localId:'owner',kind:'human',displayName:'Remote owner'})
  f.H = f.store.register(f.a, { localId: 'human', kind: 'human', displayName: 'Human' }).principalId
  f.K = f.store.register(f.b, { localId: 'worker', kind: 'bot', displayName: 'Worker' }).principalId
  f.op = value => ({ operationId: randomUUID(), ...value })
  f.group = f.store.createGroup(f.a, f.op({ principalId: f.H, title: 'Started work' })).conversationId
  f.scope = () => f.store.memberships(f.a).memberships.find(m => m.conversationId === f.group)
  f.join = () => {
    const invite = f.store.invite(f.a, f.op({ conversationId: f.group, principalId: f.H, membershipEpoch: f.scope().membershipEpoch, inviteePrincipalId: f.K }))
    f.store.accept(f.b, f.op({ principalId: f.K, inviteId: invite.inviteId }))
  }
  f.join()
  f.send = (ai = true) => f.store.publish(f.a, { protocol: PROTOCOL, type: 'message.publish', messageId: randomUUID(), conversationId: f.group,
    author: { principalId: f.H, homeInstanceId: 'a', kind: 'human' }, clientCreatedAt: new Date().toISOString(), content: { format: 'text', text: 'Please work' },
    mentions: ai ? [{ principalId: f.K }] : [], replyToMessageId: null, membershipEpoch: f.scope().membershipEpoch })
  f.delivery = message => f.store.pending(f.b).find(d => d.messageId === message.messageId)
  f.receipt = (delivery, status) => f.store.receipt(f.b, { deliveryId: delivery.deliveryId, principalId: f.K, membershipEpoch: delivery.membershipEpoch, status })
  f.events = () => f.store.sync(f.a, { conversationId: f.group, principalId: f.H, membershipEpoch: f.scope().membershipEpoch, after: 0 }).events.filter(e => e.type === 'bot.work.started')
  return f
}

test('started is canonical, timestamped by the Hub and idempotent through restart; stored and admitted alone do not start work', t => {
  const f = fixture(t, true), message = f.send(), delivery = f.delivery(message)
  f.receipt(delivery, 'targetStored'); assert.deepEqual(f.events(), [])
  f.receipt(delivery, 'aiAccepted'); assert.deepEqual(f.events(), [])
  const ack = f.receipt(delivery, 'aiStarted')
  assert.equal(ack.eventId, `bot-work-started:${delivery.deliveryId}`)
  const event = f.events()[0]
  assert.equal(event.principalId, f.K); assert.equal(event.messageId, message.messageId)
  assert.equal(event.deliveryId, delivery.deliveryId); assert.equal(event.membershipEpoch, delivery.membershipEpoch)
  assert.ok(Number.isFinite(Date.parse(event.serverStartedAt)))
  assert.deepEqual(f.receipt(delivery, 'aiStarted'), ack)
  const late = f.store.register(f.a, { localId: 'late', kind: 'bot', displayName: 'Late member' }).principalId
  const invite = f.store.invite(f.a, f.op({ conversationId: f.group, principalId: f.H, membershipEpoch: f.scope().membershipEpoch, inviteePrincipalId: late }))
  const joined = f.store.accept(f.a, f.op({ principalId: late, inviteId: invite.inviteId }))
  assert.ok(!f.store.sync(f.a, { conversationId: f.group, principalId: late, membershipEpoch: joined.membershipEpoch, after: 0 }).events.some(e => e.type === 'bot.work.started'))
  f.store.close(); f.store = new HubStore(f.path)
  assert.deepEqual(f.receipt(delivery, 'aiStarted'), ack)
  assert.equal(f.events().length, 1)
})

test('started validates exact current Bot owner, AI delivery and stored receipt, including start before admission ACK', t => {
  const f = fixture(t), delivery = f.delivery(f.send())
  assert.throws(() => f.receipt(delivery, 'aiStarted'), { code: 'RECEIPT_OUT_OF_ORDER' })
  f.receipt(delivery, 'targetStored')
  assert.throws(() => f.store.receipt(f.a, { deliveryId: delivery.deliveryId, principalId: f.K, membershipEpoch: delivery.membershipEpoch, status: 'aiStarted' }), { code: 'FORBIDDEN' })
  assert.throws(() => f.store.receipt(f.b, { deliveryId: delivery.deliveryId, principalId: f.K, membershipEpoch: 'old', status: 'aiStarted' }), { code: 'MEMBERSHIP_REVOKED' })
  const passive = f.delivery(f.send(false)); f.receipt(passive, 'targetStored')
  assert.throws(() => f.receipt(passive, 'aiStarted'), { code: 'INVALID_RECEIPT' })
  const human = f.store.pending(f.a).find(row => row.recipientPrincipalId === f.H)
  const humanReceipt = { deliveryId: human.deliveryId, principalId: f.H, membershipEpoch: human.membershipEpoch }
  f.store.receipt(f.a, { ...humanReceipt, status: 'targetStored' })
  assert.throws(() => f.store.receipt(f.a, { ...humanReceipt, status: 'aiStarted' }), { code: 'INVALID_RECEIPT' })
  assert.deepEqual(f.events(), [])
  f.receipt(delivery, 'aiStarted')
  assert.equal(f.store.db.prepare('SELECT ai_accepted FROM deliveries WHERE id=?').get(delivery.deliveryId).ai_accepted, 1)
  const reserved = `bot-work-started:${randomUUID()}`
  assert.throws(() => f.store.publish(f.a, { protocol: PROTOCOL, type: 'message.publish', messageId: reserved, conversationId: f.group,
    author: { principalId: f.H, homeInstanceId: 'a', kind: 'human' }, clientCreatedAt: new Date().toISOString(), content: { format: 'text', text: 'Cannot reserve event IDs' },
    mentions: [], replyToMessageId: null, membershipEpoch: f.scope().membershipEpoch }), { code: 'MESSAGE_ID_CONFLICT' })
})

test('revoked or unpublished recipients cannot fabricate starts, and event creation rolls back with the receipt', t => {
  const f = fixture(t), delivery = f.delivery(f.send())
  f.receipt(delivery, 'targetStored')
  f.store.beforeCommit = () => { throw new Error('synthetic work event failure') }
  assert.throws(() => f.receipt(delivery, 'aiStarted'), /synthetic work event failure/)
  assert.deepEqual(f.events(), [])
  assert.equal(f.store.db.prepare('SELECT ai_accepted FROM deliveries WHERE id=?').get(delivery.deliveryId).ai_accepted, 0)
  f.store.beforeCommit = undefined
  f.store.dmPolicy = () => { throw Object.assign(new Error('Contact revoked'), { code: 'CONTACT_REQUIRED' }) }
  assert.throws(() => f.receipt(delivery, 'aiStarted'), { code: 'CONTACT_REQUIRED' }); assert.deepEqual(f.events(), [])
  f.store.dmPolicy = undefined
  f.receipt(delivery, 'aiAccepted'); f.store.syncPublication(f.b, { principalIds: [] })
  assert.throws(() => f.receipt(delivery, 'aiStarted'), { code: 'BOT_NOT_PUBLISHED' })
  f.store.syncPublication(f.b, { principalIds: [f.K] })
  f.store.remove(f.a, f.op({ conversationId: f.group, principalId: f.H, membershipEpoch: f.scope().membershipEpoch, targetPrincipalId: f.K }))
  f.join()
  assert.throws(() => f.receipt(delivery, 'aiStarted'), { code: 'MEMBERSHIP_REVOKED' })
  assert.deepEqual(f.events(), [])
})
