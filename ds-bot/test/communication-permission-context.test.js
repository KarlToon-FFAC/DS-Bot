import assert from 'node:assert/strict'
import { test } from 'node:test'
import { randomUUID } from 'node:crypto'
import { HubStore } from '../../communication-hub/src/store.js'
import { CAPABILITIES, PROTOCOL } from '../../communication-hub/src/protocol.js'
import { CommunicationQueue } from '../src/host/federation/queue-store.js'
import { CommunicationRuntime } from '../src/host/federation/runtime.js'

test('ordinary owner/admin/member and DM operations retain their actual actors and distinguish policy, version and epoch denials', async () => {
  const store = new HubStore(':memory:'), queue = new CommunicationQueue(':memory:', { instanceId: 'a' })
  try {
    const a = store.connect('a', 'A', CAPABILITIES), b = store.connect('b', 'B', CAPABILITIES), op = value => ({ operationId: randomUUID(), ...value })
    const human = queue.localPrincipal('human', 'user', 'Human'), bot = queue.localPrincipal('bot', 'worker', 'Worker')
    for (const principal of [human, bot]) store.register(a, { localId: principal.localId, kind: principal.kind, displayName: principal.displayName })
    const admin = store.register(b, { localId: 'admin', kind: 'human', displayName: 'Admin' }).principalId
    const passive = store.register(b, { localId: 'passive', kind: 'bot', displayName: 'Passive' }).principalId
    const group = store.createGroup(a, op({ principalId: human.principalId, title: 'Human-owned' })).conversationId
    const other = store.createGroup(a, op({ principalId: bot.principalId, title: 'Bot-owned' })).conversationId
    const member = (principalId, conversationId = group) => store.memberships(principalId.split(':')[1] === 'a' ? a : b).memberships.find(m => m.principalId === principalId && m.conversationId === conversationId && m.active)
    const scope = (principalId = human.principalId, conversationId = group) => ({ principalId, conversationId, membershipEpoch: member(principalId, conversationId).membershipEpoch, expectedVersion: member(principalId, conversationId).membershipVersion })
    const join = (owner, id, conversationId) => {
      const invite = store.invite(a, op({ ...scope(owner, conversationId), inviteePrincipalId: id }))
      store.accept(id.split(':')[1] === 'a' ? a : b, op({ principalId: id, inviteId: invite.inviteId }))
    }
    for (const id of [bot.principalId, admin, passive]) join(human.principalId, id, group)
    join(bot.principalId, human.principalId, other)
    store.policy(a, op({ ...scope(), targetPrincipalId: admin, role: 'admin', speakingMode: 'speak' }))
    store.policy(a, op({ ...scope(), targetPrincipalId: bot.principalId, speakingMode: 'active' }))
    const runtime = Object.assign(Object.create(CommunicationRuntime.prototype), { queue, human, everReconciled: true,
      bots: new Map([['worker', bot]]), contacts: store.contacts(a), conversations: new Map(), settings: { url: 'ws://127.0.0.1:3190/communication' },
      deliveryStates: new Map(), errors: new Map(), rt: { botOf: () => ({ name: 'Worker' }) } })
    const calls = []
    runtime.transport = { connected: true, request: async (type, input) => {
      calls.push({ type, input })
      if (type === 'group.settings') return store.settings(a, input)
      if (type === 'memberships.list') return store.memberships(a)
      if (type === 'conversation.members') return store.members(a, input)
      assert.fail(`Unexpected request: ${type}`)
    } }
    queue.applyMemberships(store.memberships(a))
    await runtime.operation(human.principalId, 'group.settings', { conversationId: group, expectedVersion: scope().expectedVersion, title: 'Owner save works' }, 'owner-save')
    assert.equal(calls.find(call => call.type === 'group.settings').input.principalId, human.principalId)
    assert.equal(queue.outboxStatus('owner-save').state, 'accepted')
    store.settings(b, op({ ...scope(admin), title: 'Admin save works', policies: [{ targetPrincipalId: bot.principalId, speakingMode: 'passive' }] }))
    assert.equal(store.members(b, scope(admin)).title, 'Admin save works')
    queue.applyMemberships(store.memberships(a))
    assert.equal((await runtime.members(human.principalId, { conversationId: other })).members.length, 2)
    await assert.rejects(runtime.operation(human.principalId, 'group.settings', { conversationId: other, expectedVersion: scope(human.principalId, other).expectedVersion, title: 'Cannot inherit Bot ownership' }, 'member-denied'), { code: 'FORBIDDEN' })
    assert.equal(queue.outboxStatus('member-denied').state, 'failed')
    await runtime.operation(human.principalId, 'group.settings', { conversationId: group, expectedVersion: scope().expectedVersion, title: 'Other group still usable' }, 'owner-after-denial')
    assert.equal(runtime.snapshot().error, null)
    assert.equal(runtime.snapshot().outbox.find(item => item.id === 'member-denied').conversationId, other)
    assert.ok(!runtime.snapshot().outbox.filter(item => item.conversationId === group).some(item => item.error === 'FORBIDDEN'))
    const message = (principalId, values = {}) => ({ protocol: PROTOCOL, type: 'message.publish', messageId: randomUUID(), conversationId: group,
      author: { principalId, homeInstanceId: principalId.split(':')[1], kind: principalId.startsWith('bot:') ? 'bot' : 'human' },
      clientCreatedAt: new Date().toISOString(), content: { format: 'text', text: 'Authorized message' }, mentions: [], ...(principalId.startsWith('bot:') ? { activationTargets: [] } : {}), replyToMessageId: null,
      membershipEpoch: member(principalId).membershipEpoch, ...values })
    assert.throws(() => store.publish(a, message(bot.principalId)), { code: 'PASSIVE_REPLY_REQUIRED' })
    store.settings(a, op({ ...scope(), policies: [{ targetPrincipalId: bot.principalId, speakingMode: 'active' }] }))
    store.publish(a, message(bot.principalId))
    const ask = store.publish(a, message(human.principalId, { mentions: [{ principalId: passive }] }))
    const delivery = store.pending(b).find(row => row.messageId === ask.messageId && row.recipientPrincipalId === passive)
    store.receipt(b, { deliveryId: delivery.deliveryId, principalId: passive, membershipEpoch: delivery.membershipEpoch, status: 'targetStored' })
    store.publish(b, message(passive, { responseToDeliveryId: delivery.deliveryId, replyToMessageId: ask.messageId }))
    assert.throws(() => store.publish(b, message(passive)), { code: 'PASSIVE_REPLY_REQUIRED' })
    store.settings(a, op({ ...scope(), policies: [{ targetPrincipalId: human.principalId, speakingMode: 'readOnly' }] }))
    assert.throws(() => store.publish(a, message(human.principalId)), { code: 'SPEAKING_FORBIDDEN' })
    store.settings(a, op({ ...scope(), title: 'Read-only owner can manage' }))
    const dm = store.createDm(a, op({ principalId: human.principalId, otherPrincipalId: admin })).conversationId
    store.publish(a, message(human.principalId, { conversationId: dm, membershipEpoch: member(human.principalId, dm).membershipEpoch }))
    queue.applyMemberships(store.memberships(a))
    await assert.rejects(runtime.operation(human.principalId, 'group.settings', { conversationId: group, expectedVersion: scope().expectedVersion - 1, title: 'Stale' }, 'stale-denied'), { code: 'GROUP_VERSION_CONFLICT' })
    const oldAdmin = scope(admin)
    store.remove(a, op({ ...scope(), targetPrincipalId: admin })); join(human.principalId, admin, group)
    assert.throws(() => store.settings(b, op({ ...scope(admin), membershipEpoch: oldAdmin.membershipEpoch, title: 'Old epoch' })), { code: 'MEMBERSHIP_REVOKED' })
    assert.ok(!queue.pendingOutbox().some(item => ['member-denied', 'stale-denied'].includes(item.id)))
  } finally { queue.close(); store.close() }
})
