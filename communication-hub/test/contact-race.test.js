import assert from 'node:assert/strict'
import { test } from 'node:test'
import { randomUUID, randomBytes } from 'node:crypto'
import { startHub } from '../src/server.js'
import { CommunicationQueue } from '../../ds-bot/src/host/federation/queue-store.js'
import { CommunicationTransport } from '../../ds-bot/src/host/federation/transport.js'

const op = input => ({ operationId: randomUUID(), ...input })
const until = async check => {
  const deadline = Date.now() + 5000
  while (!await check()) {
    assert.ok(Date.now() < deadline, 'socket membership refresh must finish')
    await new Promise(resolve => setTimeout(resolve, 5))
  }
}
for (const phase of ['sync', 'ack']) {
  test(`real contact revocation racing conversation ${phase} cannot revoke device connectivity`, async () => {
    let armed = false, held
    const errors = [], peers = ['a', 'b'].map(instanceId => ({ instanceId, credential: randomBytes(32).toString('hex') }))
    const hub = await startHub({ databasePath: ':memory:', port: 0, peers,
      beforeResponse: ({ type, value, socket }) => {
        if (!armed || type !== 'memberships.list' || !value.memberships.some(member => member.principalId.startsWith('human:a:'))) return
        armed = false
        const send = socket.send
        socket.send = function (...args) { socket.send = send; held = () => send.apply(socket, args) }
      } })
    const clients = peers.map(peer => {
      const queue = new CommunicationQueue(':memory:', { instanceId: peer.instanceId })
      const transport = new CommunicationTransport(queue, { url: hub.url, credential: peer.credential, onError: error => errors.push(error.code) })
      return { queue, transport }
    })
    const [a, b] = clients
    try {
      for (const client of clients) {
        await client.transport.connect()
        const human = client.queue.localPrincipal('human', 'user', 'Synthetic person')
        client.human = human.principalId
        await client.transport.request('principal.register', { localId: human.localId, kind: 'human', displayName: 'Synthetic person' })
      }
      const { userCode } = await b.transport.request('contact.code', { principalId: b.human })
      const request = await a.transport.request('contact.request', op({ principalId: a.human, userCode, botPrincipalIds: [] }))
      await b.transport.request('contact.accept', op({ principalId: b.human, requestId: request.requestId, expectedVersion: 1, botPrincipalIds: [] }))
      const { conversationId } = await a.transport.request('dm.open', op({ principalId: a.human, otherPrincipalId: b.human }))
      await a.transport.request('group.create', op({ principalId: a.human, title: 'Unrelated group remains available' }))
      await a.transport.pump()
      if (phase === 'sync') {
        const scope = await b.transport.request('conversation.authorize', { principalId: b.human, conversationId })
        await b.transport.request('message.publish', { protocol: 'dsbot-communication/1', type: 'message.publish', messageId: randomUUID(), conversationId,
          author: { principalId: b.human, homeInstanceId: 'b', kind: 'human' }, membershipEpoch: scope.membershipEpoch,
          clientCreatedAt: new Date().toISOString(), content: { format: 'text', text: 'Synthetic pending sync event' }, mentions: [], replyToMessageId: null })
      }
      const trust = () => hub.store.db.prepare('SELECT id,trusted,epoch FROM instances ORDER BY id').all()
      const beforeTrust = trust(), connectedEpoch = a.transport.welcome.epoch
      a.transport.lastSynchronizedAt = null
      a.transport.onChange = async () => { a.contacts = await a.transport.request('contacts.list') }
      armed = true
      a.transport.start({ pollMs: 10 })
      await until(() => held)
      await b.transport.request('contact.revoke', op({ principalId: b.human, otherHumanPrincipalId: a.human, expectedVersion: 1 }))
      held(); held = null
      await until(() => a.transport.lastSynchronizedAt)
      assert.deepEqual(errors, ['MEMBERSHIP_REVOKED'])
      assert.equal(a.transport.connected, true)
      assert.equal(a.transport.running, true)
      assert.equal(a.transport.welcome.epoch, connectedEpoch, 'refresh does not create another device connection epoch')
      assert.equal(a.queue.authorized, true)
      assert.equal(a.queue.memberships().some(member => member.kind === 'group'), true)
      assert.equal(a.contacts.some(person => person.principalId === b.human), false)
      assert.deepEqual(trust(), beforeTrust)
      assert.equal(b.transport.connected, true)
    } finally {
      held?.()
      for (const { transport, queue } of clients) { transport.stop(); await transport.pumping?.catch(() => {}); queue.close() }
      await hub.close()
    }
  })
}
