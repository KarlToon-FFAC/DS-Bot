import assert from 'node:assert/strict'
import { test } from 'node:test'
import { CommunicationQueue } from '../src/host/federation/queue-store.js'
import { CommunicationTransport } from '../src/host/federation/transport.js'

const error = code => Object.assign(new Error(code), { code })

for (const capacityCode of ['STORAGE_UNAVAILABLE', 'BACKPRESSURE']) {
  test(`a pending DM ${capacityCode} cannot starve revoked-contact projection, group delivery or other outbox items`, async () => {
    const queue = new CommunicationQueue(':memory:', { instanceId: 'a' })
    try {
      const human = queue.localPrincipal('human', 'user', 'User'), bot = queue.localPrincipal('bot', 'worker', 'Worker')
      const message = (messageId, conversationId) => ({ protocol: 'dsbot-communication/1', type: 'message.publish', messageId, conversationId,
        author: { principalId: human.principalId, homeInstanceId: 'a', kind: 'human' }, clientCreatedAt: '2026-11-04T00:00:00Z',
        content: { format: 'text', text: 'Original durable intent' }, mentions: [], replyToMessageId: null, membershipEpoch: `${conversationId}-epoch` })
      const held = message('held-dm', 'dm'), other = message('other-group', 'group')
      queue.enqueueMessage(held)
      queue.enqueueOperation('group.invite', { operationId: 'permanently-denied', principalId: human.principalId, conversationId: 'group', inviteePrincipalId: 'bot:b:other' })
      queue.enqueueMessage(other)
      const originalHash = queue.db.prepare('SELECT hash FROM outbox WHERE id=?').get(held.messageId).hash
      queue.applyMemberships({ memberships: [{ principalId: human.principalId, conversationId: 'dm', membershipEpoch: 'dm-epoch', joinSeq: 1, watermark: 0, active: true }], invites: [] })
      const membership = { principalId: bot.principalId, conversationId: 'group', membershipEpoch: 'group-epoch', joinSeq: 1, watermark: 1, active: true }
      const event = { type: 'message', conversationId: 'group', conversationSeq: 1, eventId: 'incoming', message: {
        messageId: 'incoming', author: { principalId: 'human:b:peer', homeInstanceId: 'b', kind: 'human' }, content: { format: 'text', text: 'Authorized group work after contact revocation' }, mentions: [{ principalId: bot.principalId }], replyToMessageId: null } }
      const delivery = { deliveryId: 'group-delivery', messageId: 'incoming', conversationId: 'group', recipientPrincipalId: bot.principalId,
        membershipEpoch: 'group-epoch', routingVersion: 1, ai: true, notify: false, event }
      const requests = [], projections = []
      let hold = true, transport
      transport = new CommunicationTransport(queue, { url: 'ws://127.0.0.1:3190/communication', credential: 'synthetic',
        onChange: async () => {
          const contacts = await transport.request('contacts.list')
          projections.push({ contacts, conversations: queue.memberships().map(member => member.conversationId), ai: queue.pendingAi().map(item => item.messageId) })
        } })
      transport.connected = true
      transport.request = async (type, payload) => {
        requests.push({ type, payload: structuredClone(payload) })
        if (type === 'message.publish') {
          if (payload.messageId === held.messageId && hold) throw error(capacityCode)
          return { messageId: payload.messageId, conversationId: payload.conversationId, status: 'hubAccepted' }
        }
        if (type === 'group.invite') throw error('FORBIDDEN')
        if (type === 'memberships.list') return { memberships: [membership], invites: [] }
        if (type === 'conversation.sync') return { ...membership, events: [event] }
        if (type === 'deliveries.pull') return [delivery]
        if (type === 'conversation.ack') return { seq: payload.seq }
        if (type === 'delivery.receipt') return { deliveryId: payload.deliveryId, status: payload.status }
        if (type === 'contacts.list') return [{ principalId: bot.principalId, displayName: 'Worker' }]
        assert.fail(`Unexpected request: ${type}`)
      }
      await assert.rejects(transport.synchronize(), { code: capacityCode })
      assert.equal(queue.outboxStatus(held.messageId).state, 'pending')
      assert.deepEqual(queue.intent(held.messageId).payload, held)
      assert.equal(queue.db.prepare('SELECT hash FROM outbox WHERE id=?').get(held.messageId).hash, originalHash)
      assert.equal(queue.outboxStatus('permanently-denied').state, 'failed')
      assert.equal(queue.outboxStatus('permanently-denied').error, 'FORBIDDEN')
      assert.equal(queue.outboxStatus(other.messageId).state, 'accepted')
      assert.deepEqual(projections, [{ contacts: [{ principalId: bot.principalId, displayName: 'Worker' }], conversations: ['group'], ai: ['incoming'] }])
      assert.equal(queue.pendingReceipts().length, 0)
      assert.ok(requests.findIndex(request => request.type === 'delivery.receipt') < requests.findIndex(request => request.type === 'contacts.list'))
      hold = false
      await transport.synchronize()
      assert.equal(queue.outboxStatus(held.messageId).state, 'accepted')
      assert.deepEqual(requests.filter(request => request.type === 'message.publish' && request.payload.messageId === held.messageId).map(request => request.payload), [held, held])
      assert.equal(requests.filter(request => request.type === 'group.invite').length, 1)
      assert.equal(queue.db.prepare('SELECT count(*) n FROM outbox').get().n, 3)
    } finally { queue.close() }
  })
}

test('network and connection-epoch failures still abort immediately without false ACK or advancing inbound projections', async () => {
  for (const code of ['CONNECTION_LOST', 'STALE_CONNECTION', 'REQUEST_TIMEOUT']) {
    const queue = new CommunicationQueue(':memory:', { instanceId: 'a' })
    try {
      queue.enqueueOperation('group.create', { operationId: 'original-operation', principalId: 'bot:a:one', title: 'Original' })
      let projected = false
      const transport = new CommunicationTransport(queue, { url: 'ws://127.0.0.1:3190/communication', credential: 'synthetic', onChange: async () => { projected = true } })
      transport.connected = true
      transport.request = async type => { assert.equal(type, 'group.create'); throw error(code) }
      await assert.rejects(transport.synchronize(), { code })
      assert.equal(projected, false)
      assert.equal(queue.outboxStatus('original-operation').state, 'pending')
    } finally { queue.close() }
  }
})
