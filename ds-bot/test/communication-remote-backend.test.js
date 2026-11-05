import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CommunicationRuntime } from '../src/host/federation/runtime.js'
import { CommunicationQueue } from '../src/host/federation/queue-store.js'
import { CommunicationTransport } from '../src/host/federation/transport.js'
import { assertConversationToolScope } from '../src/host/federation/tool-scope.js'
import { install } from '../src/host/communication.js'
import { HubStore } from '../../communication-hub/src/store.js'
import { CAPABILITIES } from '../../communication-hub/src/protocol.js'
import { randomUUID } from 'node:crypto'

test('member reads use the actual Bot identity and current epoch and refuse stale local grants', async () => {
  const calls = [], runtime = { member: (principalId, conversationId, epoch) => {
    assert.equal(principalId, 'bot:a:one'); assert.equal(conversationId, 'group')
    if (epoch !== 'current') throw Object.assign(new Error(), { code: 'MEMBERSHIP_REVOKED' })
    return { membershipEpoch: 'current' }
  }, transport: { request: async (type, payload) => { calls.push({ type, payload }); return { members: [] } } } }
  await CommunicationRuntime.prototype.members.call(runtime, 'bot:a:one', { conversationId: 'group', membershipEpoch: 'current' })
  assert.deepEqual(calls, [{ type: 'conversation.members', payload: { conversationId: 'group', principalId: 'bot:a:one', membershipEpoch: 'current' } }])
  await assert.rejects(CommunicationRuntime.prototype.members.call(runtime, 'bot:a:one', { conversationId: 'group', membershipEpoch: 'old' }), { code: 'MEMBERSHIP_REVOKED' })
  assert.equal(calls.length, 1)
})

test('Bot-only conversation @all expands its exact members and never another conversation or Human', () => {
  const runtime = { queue: { instanceId: 'a' }, contacts: [
    { principalId: 'bot:a:one', kind: 'bot', displayName: 'One' }, { principalId: 'bot:b:two', kind: 'bot', displayName: 'Two' },
    { principalId: 'bot:c:other', kind: 'bot', displayName: 'Other' }, { principalId: 'human:b:user', kind: 'human', displayName: 'Human' }],
  member: () => ({ membershipVersion: 1 }),
  conversations: new Map([['bot-only', { membershipVersion: 1, members: [{ principalId: 'bot:a:one' }, { principalId: 'bot:b:two' }, { principalId: 'human:b:user' }] }]]) }
  const message = text => CommunicationRuntime.prototype.message.call(runtime, 'bot:a:one', 'bot-only', { text, membershipEpoch: 'epoch' })
  assert.deepEqual(message('@all review').mentions, [{ principalId: 'bot:a:one' }, { principalId: 'bot:b:two' }])
  assert.deepEqual(message('`@all`\n> @all').mentions, [])
  runtime.conversations.clear()
  assert.deepEqual(message('@all').activationTargets, [], 'display-only final mentions never require dispatch expansion')
  assert.deepEqual(message('`@all`\n> @all').mentions, [])
})

test('reconciliation loads Bot-only participants without exposing that conversation in the Human snapshot', async () => {
  const start = CommunicationTransport.prototype.start
  CommunicationTransport.prototype.start = () => {}
  let runtime
  try {
    runtime = new CommunicationRuntime({ home: tmpdir(), botOf: () => ({ name: 'One' }),
      ctx: { on: () => () => {}, systemPrompt: { section: () => () => {} } } },
    { url: 'ws://127.0.0.1:3190/communication', instanceId: 'a', dataPath: ':memory:', publishedBotIds: ['one'] }, 'synthetic', [])
    const principalId = runtime.bots.get('one').principalId
    runtime.queue.applyMemberships({ memberships: [{ principalId, conversationId: 'bot-only', membershipEpoch: 'epoch', membershipVersion: 1, joinSeq: 1, watermark: 1, active: 1 }], invites: [] })
    const calls = []
    let displayName = 'One', instanceLabel = 'Original device'
    runtime.transport.request = async (type, payload) => {
      calls.push({ type, payload })
      if (type === 'contacts.list') return [{ principalId, kind: 'bot', displayName, instanceLabel }]
      if (type === 'conversation.members') return { membershipVersion: 1, members: [{ principalId }] }
      assert.fail(`Unexpected request: ${type}`)
    }
    runtime.process = async () => {}
    runtime.transport.connected = true
    await runtime.transport.onChange()
    assert.deepEqual(calls[1], { type: 'conversation.members', payload: { conversationId: 'bot-only', principalId, membershipEpoch: 'epoch' } })
    assert.equal(runtime.conversations.get('bot-only').members[0].principalId, principalId)
    assert.deepEqual(runtime.snapshot().conversations, [])
    displayName = 'Renamed'; instanceLabel = 'Renamed device'
    await runtime.transport.onChange()
    assert.equal(runtime.conversations.get('bot-only').members[0].displayName, 'Renamed')
    assert.equal(runtime.contacts[0].instanceLabel, 'Renamed device')
    assert.equal(runtime.conversations.get('bot-only').members[0].instanceLabel, 'Renamed device')
    assert.equal(calls.filter(call => call.type === 'conversation.members').length, 1)
  } finally { CommunicationTransport.prototype.start = start; await runtime?.close() }
})

test('new member, reference and group configuration tools remain in the existing public tool collection and conversation scope', () => {
  const rt = { config: { communication: { enabled: true } }, teamTools: [], ctx: { effect: () => {} } }
  install(rt)
  for (const name of ['read_communication_members', 'read_communication_reference', 'read_communication_thread', 'configure_communication_group', 'save_communication_group_settings']) {
    assert.ok(rt.teamTools.some(tool => tool.name === name))
    assertConversationToolScope({ conversationId: 'current' }, name, { conversationId: 'current' })
    assert.throws(() => assertConversationToolScope({ conversationId: 'current' }, name, { conversationId: 'private' }), { code: 'CONVERSATION_SCOPE_MISMATCH' })
  }
  const settings = rt.teamTools.find(tool => tool.name === 'save_communication_group_settings').parameters
  assert.deepEqual(settings.properties.routing.required, ['mode'])
  assert.equal(settings.properties.routing.additionalProperties, false)
  assert.deepEqual(settings.properties.policies.items.required, ['targetPrincipalId'])
  assert.equal(settings.properties.policies.items.additionalProperties, false)
})

test('queued group configuration survives restart and replays its original operation, identity, epoch and version', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsbot-configure-replay-')), path = join(dir, 'queue.sqlite')
  let queue = new CommunicationQueue(path, { instanceId: 'a' })
  try {
    const input = { operationId: 'rename-op', conversationId: 'group', principalId: 'bot:a:one', membershipEpoch: 'original', expectedVersion: 7, title: 'Retained' }
    queue.enqueueOperation('group.configure', input)
    queue.close(); queue = new CommunicationQueue(path, { instanceId: 'a' })
    const requests = [], transport = { connected: true, queue, request: async (type, payload) => {
      requests.push({ type, payload })
      if (type === 'group.configure') return { updated: true, conversationId: 'group', title: 'Retained' }
      if (type === 'memberships.list') return { memberships: [], invites: [], recoverableOwnership: [] }
      if (type === 'deliveries.pull') return []
      assert.fail(`Unexpected request: ${type}`)
    } }
    await CommunicationTransport.prototype.synchronize.call(transport)
    assert.deepEqual(requests[0], { type: 'group.configure', payload: input })
    assert.equal(queue.outboxStatus('rename-op').state, 'accepted')
    await CommunicationTransport.prototype.synchronize.call(transport)
    assert.equal(requests.filter(call => call.type === 'group.configure').length, 1)
  } finally { queue.close(); rmSync(dir, { recursive: true, force: true }) }
})

test('uncertain Human sends retain their raw intent and exact recipients across restart, renames and membership changes', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsbot-human-retry-')), path = join(dir, 'queue.sqlite')
  let queue = new CommunicationQueue(path, { instanceId: 'a' })
  try {
    const human = queue.localPrincipal('human', 'user', 'User')
    const runtime = { queue, human, contacts: [{ principalId: 'bot:b:worker', kind: 'bot', displayName: 'Worker' }],
      conversations: new Map([['group', { membershipVersion: 1, members: [{ principalId: 'bot:b:worker' }] }]]), member: () => ({ kind: 'group', speakingMode: 'speak', membershipEpoch: 'original', membershipVersion: 1 }) }
    runtime.message = CommunicationRuntime.prototype.message.bind(runtime)
    const inputs = ['@all review', '@Worker review'].map((text, index) => ({ messageId: `retry-${index}`, conversationId: 'group', text, clientCreatedAt: '2026-11-04T00:00:00Z', mentions: [] }))
    for (const input of inputs) CommunicationRuntime.prototype.sendHuman.call(runtime, input)
    const original = inputs.map(input => queue.intent(input.messageId))
    queue.close(); queue = new CommunicationQueue(path, { instanceId: 'a' }); runtime.queue = queue
    runtime.contacts = [{ principalId: 'bot:c:new', kind: 'bot', displayName: 'Renamed' }]
    runtime.conversations.clear(); runtime.member = () => assert.fail('retry cannot borrow a newer membership')
    for (const [index, input] of inputs.entries()) {
      assert.equal(CommunicationRuntime.prototype.sendHuman.call(runtime, input).status, 'pending')
      assert.deepEqual(queue.intent(input.messageId), original[index])
      for (const changed of [{ text: 'changed' }, { mentions: ['bot:c:new'] }, { conversationId: 'other' }, { membershipEpoch: 'new' }, { replyToMessageId: 'different' }]) {
        assert.throws(() => CommunicationRuntime.prototype.sendHuman.call(runtime, { ...input, ...changed }), { code: 'MESSAGE_ID_CONFLICT' })
      }
    }
  } finally { queue.close(); rmSync(dir, { recursive: true, force: true }) }
})

test('legacy mentioned Human intents require reconciliation instead of resolving through a changed directory', () => {
  const queue = new CommunicationQueue(':memory:', { instanceId: 'a' })
  try {
    const human = queue.localPrincipal('human', 'user', 'User')
    const runtime = { queue, human }
    const input = { messageId: 'legacy', conversationId: 'group', text: '@Worker review', clientCreatedAt: '2026-11-04T00:00:00Z' }
    queue.enqueueMessage({ protocol: 'dsbot-communication/1', type: 'message.publish', messageId: input.messageId, conversationId: input.conversationId,
      author: { principalId: human.principalId, homeInstanceId: 'a', kind: 'human' }, clientCreatedAt: input.clientCreatedAt, content: { format: 'markdown', text: input.text },
      mentions: [{ principalId: 'bot:b:worker' }], replyToMessageId: null, membershipEpoch: 'old' })
    assert.throws(() => CommunicationRuntime.prototype.sendHuman.call(runtime, input), { code: 'LEGACY_RECONCILIATION_REQUIRED' })
    assert.equal(queue.pendingOutbox().length, 1)
  } finally { queue.close() }
})

test('Human raw intent and canonical outbox roll back together when the journal commit fails', () => {
  const queue = new CommunicationQueue(':memory:', { instanceId: 'a' })
  try {
    const human = queue.localPrincipal('human', 'user', 'User')
    const runtime = { queue, human, contacts: [], conversations: new Map(), member: () => ({ kind: 'group', speakingMode: 'speak', membershipEpoch: 'original' }) }
    runtime.message = CommunicationRuntime.prototype.message.bind(runtime)
    queue.beforeCommit = () => { throw new Error('synthetic journal failure') }
    assert.throws(() => CommunicationRuntime.prototype.sendHuman.call(runtime, { messageId: 'failed-commit', conversationId: 'group', text: 'Review', clientCreatedAt: '2026-11-04T00:00:00Z' }), /synthetic journal failure/)
    assert.equal(queue.intent('failed-commit'), null)
    assert.equal(queue.humanIntent('failed-commit'), undefined)
  } finally { queue.close() }
})

test('remove then immediately @all uses refreshed members, and refresh failure preserves the committed ACK', async () => {
  const store = new HubStore(':memory:'), queue = new CommunicationQueue(':memory:', { instanceId: 'a' })
  try {
    const a = store.connect('a', 'A', CAPABILITIES), b = store.connect('b', 'B', CAPABILITIES)
    const human = queue.localPrincipal('human', 'user', 'User'), bot = queue.localPrincipal('bot', 'one', 'One')
    for (const principal of [human, bot]) store.register(a, { localId: principal.localId, kind: principal.kind, displayName: principal.displayName })
    const remote = store.register(b, { localId: 'two', kind: 'bot', displayName: 'Two' }).principalId
    const op = value => ({ operationId: randomUUID(), ...value })
    const conversationId = store.createGroup(a, op({ principalId: human.principalId, title: 'Group' })).conversationId
    const owner = () => store.memberships(a).memberships.find(member => member.principalId === human.principalId)
    for (const [auth, principalId] of [[a, bot.principalId], [b, remote]]) {
      const invite = store.invite(a, op({ conversationId, principalId: human.principalId, membershipEpoch: owner().membershipEpoch, inviteePrincipalId: principalId }))
      store.accept(auth, op({ inviteId: invite.inviteId, principalId }))
    }
    queue.applyMemberships(store.memberships(a))
    const runtime = { queue, human, everReconciled: true, contacts: store.contacts(a), conversations: new Map([[conversationId, store.members(a, { conversationId, principalId: human.principalId })]]) }
    for (const method of ['member', 'refreshConversation', 'message']) runtime[method] = CommunicationRuntime.prototype[method].bind(runtime)
    let failRefresh = false
    runtime.transport = { connected: true, request: async (type, input) => {
      if (type === 'group.remove') return store.remove(a, input)
      if (type === 'memberships.list') return store.memberships(a)
      if (type === 'conversation.members') {
        if (failRefresh) throw Object.assign(new Error(), { code: 'REQUEST_TIMEOUT' })
        return store.members(a, input)
      }
      assert.fail(`Unexpected request: ${type}`)
    } }
    await CommunicationRuntime.prototype.operation.call(runtime, human.principalId, 'group.remove', { conversationId, targetPrincipalId: remote })
    const send = { conversationId, messageId: 'immediate-send', clientCreatedAt: '2026-11-04T00:00:00Z', text: '@all review' }
    CommunicationRuntime.prototype.sendHuman.call(runtime, send)
    const message = queue.intent(send.messageId).payload
    assert.deepEqual(message.mentions, [{ principalId: bot.principalId }])
    assert.equal(store.publish(a, message).messageId, send.messageId)
    assert.equal(store.pending(b).length, 0)
    const scope = runtime.member(human.principalId, conversationId)
    runtime.conversations.get(conversationId).membershipVersion = scope.membershipVersion - 1
    assert.throws(() => runtime.message(human.principalId, conversationId, { text: '@all' }), { code: 'AUTHORIZATION_PENDING' })
    failRefresh = true
    const result = await CommunicationRuntime.prototype.operation.call(runtime, human.principalId, 'group.remove', { conversationId, targetPrincipalId: bot.principalId }, 'remove-local')
    assert.ok(result)
    assert.equal(queue.outboxStatus('remove-local').state, 'accepted')
    assert.equal(runtime.conversations.has(conversationId), false)
    assert.throws(() => runtime.message(human.principalId, conversationId, { text: '@all' }), { code: 'AUTHORIZATION_PENDING' })
    failRefresh = false
    await runtime.refreshConversation(conversationId)
    assert.deepEqual(runtime.message(human.principalId, conversationId, { text: '@all' }).mentions, [])
  } finally { queue.close(); store.close() }
})
