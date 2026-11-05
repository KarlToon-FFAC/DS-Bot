import assert from 'node:assert/strict'
import { test } from 'node:test'
import { CommunicationQueue } from '../src/host/federation/queue-store.js'
import { CommunicationTransport } from '../src/host/federation/transport.js'

const until = async check => {
  const deadline = Date.now() + 5000
  while (!check()) {
    assert.ok(Date.now() < deadline, 'membership authorization refresh must finish')
    await new Promise(resolve => setTimeout(resolve, 5))
  }
}
for (const type of ['conversation.sync', 'conversation.ack']) {
  for (const code of ['MEMBERSHIP_REVOKED', 'NOT_A_MEMBER', 'CONTACT_REQUIRED']) {
    test(`${type} ${code} refreshes authorization without dropping device connection`, async () => {
      const queue = new CommunicationQueue(':memory:', { instanceId: 'a' }), errors = []
      const human = queue.localPrincipal('human', 'user', 'Synthetic user')
      const membership = { principalId: human.principalId, conversationId: 'changed-dm', membershipEpoch: 'old-epoch', joinSeq: 1, watermark: type === 'conversation.sync' ? 1 : 0, active: true }
      const transport = new CommunicationTransport(queue, { url: 'ws://127.0.0.1:3190/communication', onError: error => errors.push(error.code) })
      let snapshots = 0, changed = 0, disconnected = 0, closed = 0
      const disconnect = queue.disconnected.bind(queue)
      queue.disconnected = () => { disconnected++; disconnect() }
      transport.connected = true
      transport.socket = { readyState: WebSocket.OPEN, close: () => { closed++ } }
      transport.onChange = () => { changed++; assert.equal(queue.authorized, true); assert.deepEqual(queue.memberships(), []) }
      transport.request = async operation => {
        if (operation === 'memberships.list') return { memberships: ++snapshots === 1 ? [membership] : [], invites: [] }
        if (operation === type) throw Object.assign(new Error('Synthetic scope changed'), { code })
        if (operation === 'deliveries.pull') return []
        assert.fail(`Unexpected request: ${operation}`)
      }
      try {
        transport.start({ pollMs: 5 })
        await until(() => Boolean(transport.lastSynchronizedAt))
        assert.deepEqual(errors, [code])
        assert.equal(transport.running, true)
        assert.equal(transport.connected, true)
        assert.equal(disconnected, 1, 'stale snapshot fails closed before next membership read')
        assert.equal(closed, 0, 'a conversation scope denial must not close the device socket')
        assert.ok(snapshots >= 2)
        assert.ok(changed >= 1)
      } finally { transport.stop(); queue.close() }
    })
  }
}

test('an outbox permission denial stays failed and cannot hold unrelated synchronization pending', async () => {
  const queue = new CommunicationQueue(':memory:', { instanceId: 'a' })
  const human = queue.localPrincipal('human', 'user', 'Synthetic user')
  queue.enqueueOperation('group.remove', { operationId: 'denied', principalId: human.principalId, conversationId: 'changed' })
  const transport = new CommunicationTransport(queue, { url: 'ws://127.0.0.1:3190/communication' })
  transport.connected = true
  transport.request = async type => {
    if (type === 'group.remove') throw Object.assign(new Error('Synthetic scope changed'), { code: 'MEMBERSHIP_REVOKED' })
    if (type === 'memberships.list') return { memberships: [], invites: [] }
    if (type === 'deliveries.pull') return []
    assert.fail(`Unexpected request: ${type}`)
  }
  try {
    await transport.synchronize()
    assert.equal(queue.outboxStatus('denied').state, 'failed')
    assert.equal(queue.outboxStatus('denied').error, 'MEMBERSHIP_REVOKED')
    assert.equal(queue.pendingOutbox().length, 0)
    assert.ok(transport.lastSynchronizedAt)
  } finally { queue.close() }
})
