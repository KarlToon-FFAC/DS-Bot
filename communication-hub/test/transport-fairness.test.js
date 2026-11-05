// Real Hub lifecycle tests live with the Hub dependencies; the plugin suite
// deliberately runs without installing communication-hub/node_modules.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { EventEmitter, once } from 'node:events'
import { setTimeout as delay } from 'node:timers/promises'
import { randomUUID } from 'node:crypto'
import { CommunicationQueue } from '../../ds-bot/src/host/federation/queue-store.js'
import { CommunicationTransport } from '../../ds-bot/src/host/federation/transport.js'
import { startHub } from '../src/server.js'
import { CAPABILITIES, CommunicationError, PROTOCOL } from '../src/protocol.js'

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
