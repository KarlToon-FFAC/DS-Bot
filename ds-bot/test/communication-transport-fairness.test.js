import assert from 'node:assert/strict'
import { test } from 'node:test'
import { CommunicationQueue } from '../src/host/federation/queue-store.js'
import { CommunicationTransport } from '../src/host/federation/transport.js'
import { startHub } from '../../communication-hub/src/server.js'
import { CAPABILITIES, CommunicationError, PROTOCOL } from '../../communication-hub/src/protocol.js'
import { EventEmitter, once } from 'node:events'
import { setTimeout as delay } from 'node:timers/promises'
import { randomUUID } from 'node:crypto'

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

for (const capacityCode of ['STORAGE_UNAVAILABLE', 'BACKPRESSURE']) {
  test(`start keeps its authenticated socket usable after deferred ${capacityCode} and stop cancels retry cleanup`, { timeout: 5000 }, async () => {
    const queue = new CommunicationQueue(':memory:', { instanceId: 'a' }), signals = new EventEmitter()
    const credential = 'synthetic-capacity-test-credential-a', credentialB = 'synthetic-capacity-test-credential-b'
    let held = true, closes = 0, requests = 0, client, hub
    try {
      hub = await startHub({ databasePath: ':memory:', port: 0, peers: [{ instanceId: 'a', credential }, { instanceId: 'b', credential: credentialB }],
        beforeRequest: ({ type, payload }) => {
          requests++
          if (type === 'message.publish' && payload.messageId === 'held-dm' && held) throw new CommunicationError(capacityCode)
        } })
      const a = hub.store.connect('a', 'A', CAPABILITIES), b = hub.store.connect('b', 'B', CAPABILITIES)
      const human = queue.localPrincipal('human', 'user', 'User'), bot = queue.localPrincipal('bot', 'worker', 'Worker')
      for (const principal of [human, bot]) hub.store.register(a, { localId: principal.localId, kind: principal.kind, displayName: principal.displayName })
      const remote = hub.store.register(b, { localId: 'remote', kind: 'human', displayName: 'Remote' }).principalId
      const op = input => ({ operationId: randomUUID(), ...input })
      const dm = hub.store.createDm(a, op({ principalId: human.principalId, otherPrincipalId: remote })).conversationId
      const group = hub.store.createGroup(a, op({ principalId: human.principalId, title: 'Shared group' })).conversationId
      const owner = () => hub.store.memberships(a).memberships.find(m => m.conversationId === group && m.principalId === human.principalId)
      for (const [principalId, auth] of [[bot.principalId, a], [remote, b]]) {
        const invite = hub.store.invite(a, op({ principalId: human.principalId, conversationId: group, membershipEpoch: owner().membershipEpoch, inviteePrincipalId: principalId }))
        hub.store.accept(auth, op({ principalId, inviteId: invite.inviteId }))
      }
      hub.store.policy(a, op({ principalId: human.principalId, conversationId: group, membershipEpoch: owner().membershipEpoch,
        expectedVersion: owner().membershipVersion, targetPrincipalId: remote, speakingMode: 'speak' }))
      const incoming = { protocol: PROTOCOL, type: 'message.publish', messageId: 'incoming-group', conversationId: group,
        author: { principalId: remote, homeInstanceId: 'b', kind: 'human' }, clientCreatedAt: '2026-11-04T00:00:00Z',
        content: { format: 'text', text: 'Group delivery remains authorized' }, mentions: [{ principalId: bot.principalId }], replyToMessageId: null,
        membershipEpoch: hub.store.memberships(b).memberships.find(m => m.conversationId === group).membershipEpoch }
      hub.store.publish(b, incoming)
      const intent = { protocol: PROTOCOL, type: 'message.publish', messageId: 'held-dm', conversationId: dm,
        author: { principalId: human.principalId, homeInstanceId: 'a', kind: 'human' }, clientCreatedAt: '2026-11-04T00:00:00Z',
        content: { format: 'text', text: 'Original DM intent' }, mentions: [], replyToMessageId: null,
        membershipEpoch: hub.store.memberships(a).memberships.find(m => m.conversationId === dm).membershipEpoch }
      queue.enqueueMessage(intent)
      const errors = [], projections = []
      client = new CommunicationTransport(queue, { url: hub.url, credential,
        onConnect: async () => { client.socket.addEventListener('close', () => { closes++ }) },
        onChange: async () => { projections.push(await client.request('contacts.list')) },
        onError: value => { errors.push(value.code); signals.emit('capacity', value) } })
      const pressure = once(signals, 'capacity', { signal: AbortSignal.timeout(2000) })
      client.start({ pollMs: 20 })
      assert.equal((await pressure)[0].code, capacityCode)
      assert.equal(client.connected, true); assert.equal(client.running, true); assert.equal(client.socket.readyState, WebSocket.OPEN)
      assert.equal(queue.authorized, true); assert.equal(closes, 0)
      assert.ok(projections.length > 0)
      assert.equal(queue.outboxStatus(intent.messageId).state, 'pending')
      assert.deepEqual(queue.intent(intent.messageId).payload, intent)
      assert.ok(queue.pendingAi().some(delivery => delivery.messageId === incoming.messageId))
      assert.ok((await client.request('contacts.list')).some(person => person.principalId === remote))
      assert.ok((await client.request('conversation.members', { conversationId: group, principalId: bot.principalId,
        membershipEpoch: queue.memberships().find(m => m.conversationId === group && m.principalId === bot.principalId).membershipEpoch })).members.length > 0)
      if (capacityCode === 'STORAGE_UNAVAILABLE') {
        held = false
        const deadline = Date.now() + 2000
        while (queue.outboxStatus(intent.messageId).state !== 'accepted' && Date.now() < deadline) await delay(10)
        assert.equal(queue.outboxStatus(intent.messageId).state, 'accepted')
      } else assert.equal(queue.outboxStatus(intent.messageId).state, 'pending')
      assert.deepEqual(queue.intent(intent.messageId).payload, intent)
      assert.deepEqual(errors, [capacityCode]); assert.equal(closes, 0)
      const closed = once(client.socket, 'close', { signal: AbortSignal.timeout(2000) })
      client.stop(); await closed
      assert.equal(client.connected, false); assert.equal(client.running, false); assert.equal(queue.authorized, false); assert.equal(closes, 1)
      const stoppedRequests = requests
      await delay(300)
      assert.equal(requests, stoppedRequests)
    } finally {
      client?.stop(); await client?.opening?.catch(() => {}); await client?.pumping?.catch(() => {})
      await hub?.close(); queue.close()
    }
  })
}
