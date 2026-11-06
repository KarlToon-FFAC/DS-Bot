import assert from 'node:assert/strict'
import { test } from 'node:test'
import { CommunicationQueue } from '../src/host/federation/queue-store.js'
import { CommunicationRuntime } from '../src/host/federation/runtime.js'
import { conversationSummary, safeManagementUrl } from '../src/host/federation/conversation-summary.js'
import { CommunicationTransport } from '../src/host/federation/transport.js'
import { tmpdir } from 'node:os'

function fixture(t) {
  const queue = new CommunicationQueue(':memory:', { instanceId: 'a' }); t.after(() => queue.close())
  const human = queue.localPrincipal('human', 'user', 'Human'), bot = queue.localPrincipal('bot', 'worker', 'Worker')
  const runtime = { queue, human, bots: new Map(), everReconciled: true, transport: { connected: true }, settings: { url: 'ws://127.0.0.1:3190/communication' },
    contacts: [{ principalId: 'bot:b:peer', kind: 'bot', displayName: 'Current sender' }], conversations: new Map(), deliveryStates: new Map(), errors: new Map(), rt: { botOf: () => null } }
  const member = (principalId, conversationId, membershipEpoch, joinSeq, watermark) => ({ principalId, conversationId, membershipEpoch, joinSeq, watermark, active: true, kind: conversationId.includes('dm') ? 'dm' : 'group' })
  const message = (conversationId, seq, text, author = 'bot:b:peer') => ({ type: 'message', eventId: `${conversationId}-${seq}`, conversationId, conversationSeq: seq, serverAcceptedAt: '2026-11-04T01:00:00.000Z',
    message: { messageId: `${conversationId}-${seq}`, author: { principalId: author, kind: author.startsWith('bot:') ? 'bot' : 'human' }, content: { format: 'markdown', text } } })
  const sync = (membership, events) => queue.applySync({ ...membership, events })
  return { queue, human, bot, runtime, member, message, sync }
}

test('snapshot summaries use only the current Human epoch, join boundary and contiguous cursor, excluding Bot-private history and work events', t => {
  const f = fixture(t), group = f.member(f.human.principalId, 'group', 'human-new', 3, 7), dm = f.member(f.human.principalId, 'human-dm', 'dm', 1, 2)
  const botGroup = f.member(f.bot.principalId, 'group', 'bot-old', 1, 10), privateDm = f.member(f.bot.principalId, 'bot-private-dm', 'private', 1, 1)
  f.queue.applyMemberships({ memberships: [group, dm, botGroup, privateDm], invites: [] })
  f.sync(botGroup, Array.from({ length: 10 }, (_, index) => f.message('group', index + 1, `Bot-only canary ${index}`)))
  f.sync(privateDm, [f.message('bot-private-dm', 1, 'Private Bot DM canary')])
  f.sync(group, [f.message('group', 3, 'Visible first'), f.message('group', 4, 'Visible latest'),
    { type: 'bot.work.started', eventId: 'started', conversationId: 'group', conversationSeq: 5, principalId: f.bot.principalId },
    f.message('group', 7, 'Gap canary must stay hidden')])
  f.sync(dm, [f.message('human-dm', 1, 'DM preview', 'human:b:remote'), { type: 'routing.changed', eventId: 'dm-policy', conversationId: 'human-dm', conversationSeq: 2 }])
  const snapshot = CommunicationRuntime.prototype.snapshot.call(f.runtime)
  assert.deepEqual(snapshot.conversations.map(item => item.conversationId), ['group', 'human-dm'])
  assert.equal(snapshot.conversations[0].lastMessage.summary, 'Visible latest')
  assert.equal(snapshot.conversations[0].lastMessage.author.displayName, 'Current sender')
  assert.equal(snapshot.conversations[0].lastMessage.serverAcceptedAt, '2026-11-04T01:00:00.000Z')
  assert.equal(snapshot.conversations[1].lastMessage.summary, 'DM preview')
  assert.ok(!JSON.stringify(snapshot.conversations).includes('canary'))
  const rejoined = { ...group, membershipEpoch: 'human-rejoined', joinSeq: 8, watermark: 8 }
  f.queue.applyMemberships({ memberships: [rejoined, dm, botGroup, privateDm], invites: [] })
  assert.equal(CommunicationRuntime.prototype.snapshot.call(f.runtime).conversations.find(item => item.conversationId === 'group').lastMessage, null)
  f.queue.applyMemberships({ memberships: [dm, botGroup, privateDm], invites: [] })
  assert.ok(!CommunicationRuntime.prototype.snapshot.call(f.runtime).conversations.some(item => item.conversationId === 'group'))
  f.runtime.everReconciled = false
  assert.deepEqual(CommunicationRuntime.prototype.snapshot.call(f.runtime).conversations, [])
})

test('summary finds the last actual message beyond hundreds of non-message events and bounds Unicode text and sender names', t => {
  const f = fixture(t), membership = f.member(f.human.principalId, 'group', 'epoch', 1, 602)
  f.queue.applyMemberships({ memberships: [membership], invites: [] })
  f.sync(membership, [f.message('group', 1, '\n Hello\t\u0000 ' + '😀'.repeat(300)), ...Array.from({ length: 601 }, (_, index) => ({
    type: 'bot.work.started', eventId: `work-${index}`, conversationId: 'group', conversationSeq: index + 2 }))])
  f.runtime.contacts[0].displayName = '人'.repeat(200)
  const summary = CommunicationRuntime.prototype.snapshot.call(f.runtime).conversations[0].lastMessage
  assert.equal([...summary.summary].length, 160); assert.ok(summary.summary.endsWith('…'))
  assert.equal([...summary.author.displayName].length, 80)
  assert.ok(!/[\u0000-\u001f\u007f]/.test(summary.summary))
  assert.equal(conversationSummary({ type: 'bot.work.started' }, []), null)
})

test('operation audit retains exact actor and conversation ownership without making old failures a current state error', t => {
  const f = fixture(t), member = f.member(f.human.principalId, 'current', 'current-epoch', 1, 0)
  f.queue.applyMemberships({ memberships: [member], invites: [] })
  f.queue.enqueueOperation('group.settings', { operationId: 'old-failed', principalId: f.human.principalId, conversationId: 'other', membershipEpoch: 'old-epoch', title: 'Old denied change' })
  f.queue.rejected('old-failed', 'FORBIDDEN')
  f.queue.enqueueOperation('group.settings', { operationId: 'bot-failed', principalId: f.bot.principalId, conversationId: 'current', membershipEpoch: 'bot-epoch', title: 'Private Bot denied change' })
  f.queue.rejected('bot-failed', 'FORBIDDEN')
  f.queue.enqueueOperation('group.create', { operationId: 'created', principalId: f.human.principalId, title: 'New group' })
  f.queue.accepted('created', { conversationId: 'new-group' })
  const snapshot = CommunicationRuntime.prototype.snapshot.call(f.runtime)
  assert.equal(snapshot.error, null)
  assert.equal(snapshot.outbox.find(item => item.id === 'old-failed').principalId, f.human.principalId)
  assert.equal(snapshot.outbox.find(item => item.id === 'old-failed').conversationId, 'other')
  assert.equal(snapshot.outbox.find(item => item.id === 'old-failed').membershipEpoch, 'old-epoch')
  assert.equal(snapshot.outbox.find(item => item.id === 'created').conversationId, 'new-group')
  assert.ok(!snapshot.outbox.some(item => item.id === 'bot-failed'))
  assert.deepEqual(snapshot.outbox.filter(item => item.conversationId === 'current' && item.state === 'failed'), [])
  assert.equal(f.queue.db.prepare("SELECT count(*) n FROM outbox WHERE state='failed'").get().n, 2)
  assert.equal(f.queue.pendingOutbox().length, 0)
})

test('automatic invitation rejection is audited once and does not stop unrelated Bot invitations or retry on later polls', async t => {
  const f = fixture(t)
  f.runtime.bots = new Map([['worker', { principalId: f.bot.principalId }]])
  f.queue.db.prepare('INSERT INTO metadata VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run('invites', JSON.stringify([
    { inviteId: 'denied', principalId: f.bot.principalId }, { inviteId: 'valid', principalId: f.bot.principalId }]))
  const calls = []
  f.runtime.operation = async (principalId, type, payload, operationId) => {
    if (f.queue.outboxStatus(operationId)?.state === 'accepted') return
    calls.push(payload.inviteId)
    f.queue.enqueueOperation(type, { ...payload, principalId, operationId })
    if (payload.inviteId === 'denied') {
      f.queue.rejected(operationId, 'FORBIDDEN')
      throw Object.assign(new Error('FORBIDDEN'), { code: 'FORBIDDEN' })
    }
    f.queue.accepted(operationId, { conversationId: 'authorized-group' })
  }
  await CommunicationRuntime.prototype.acceptBotInvites.call(f.runtime)
  await CommunicationRuntime.prototype.acceptBotInvites.call(f.runtime)
  assert.deepEqual(calls, ['denied', 'valid'])
  assert.equal(f.queue.db.prepare("SELECT count(*) n FROM outbox WHERE state='failed' AND error='FORBIDDEN'").get().n, 1)
  f.runtime.operation = async () => { throw Object.assign(new Error('CONNECTION_LOST'), { code: 'CONNECTION_LOST' }) }
  await assert.rejects(CommunicationRuntime.prototype.acceptBotInvites.call(f.runtime), { code: 'CONNECTION_LOST' })
})

test('management link availability uses only a safe advertised management URL, never a guessed communication address', t => {
  const f = fixture(t)
  for (const value of ['https://console.example.test/admin/', 'http://127.0.0.1:3190/admin/', 'http://[::1]:3190/admin/']) assert.equal(safeManagementUrl(value), value)
  for (const value of [undefined, 'javascript:alert(1)', 'https://user:pass@console.example.test/admin/', 'https://console.example.test/admin/?token=hidden', 'https://console.example.test/admin/#secret', 'http://example.test/admin/', 'http://localhost/admin/']) assert.equal(safeManagementUrl(value), null)
  assert.equal(CommunicationRuntime.prototype.snapshot.call(f.runtime).managementAvailable, false)
  f.runtime.transport.welcome = { managementUrl: 'https://console.example.test/admin/' }
  const snapshot = CommunicationRuntime.prototype.snapshot.call(f.runtime)
  assert.equal(snapshot.managementAvailable, true); assert.equal(snapshot.managementUrl, 'https://console.example.test/admin/')
})

test('successful synchronization clears recovered transport errors while preserving actual processing diagnostics', async () => {
  const start = CommunicationTransport.prototype.start
  CommunicationTransport.prototype.start = () => {}
  let runtime
  try {
    runtime = new CommunicationRuntime({ home: tmpdir(), botOf: () => null,
      ctx: { on: () => () => {}, systemPrompt: { section: () => () => {} } } },
    { url: 'ws://127.0.0.1:3190/communication', instanceId: 'a', dataPath: ':memory:', publishedBotIds: [] }, 'synthetic', [])
    runtime.process = async () => {}
    runtime.transport.connected = true
    runtime.queue.applyMemberships({ memberships: [], invites: [] })
    runtime.transport.request = async type => {
      if (type === 'contacts.list') return []
      assert.fail(`Unexpected request: ${type}`)
    }
    runtime.lastError = 'RECOVERY_UNKNOWN'
    runtime.transport.onError({ code: 'BACKPRESSURE' })
    assert.equal(runtime.snapshot().error, 'BACKPRESSURE')
    await runtime.transport.onChange()
    assert.equal(runtime.snapshot().error, 'RECOVERY_UNKNOWN')
    runtime.lastError = null
    runtime.transport.onError({ code: 'STORAGE_UNAVAILABLE' })
    await runtime.transport.onChange()
    assert.equal(runtime.snapshot().error, null)
    runtime.transport.onError({ code: 'BACKPRESSURE' })
    assert.equal(runtime.snapshot().error, 'BACKPRESSURE')
  } finally { CommunicationTransport.prototype.start = start; await runtime?.close() }
})


test('legacy local-owner Bot invitations reconcile automatically while remote and unknown sources await consent',async t=>{
  const f=fixture(t),calls=[]
  f.runtime.bots=new Map([['worker',f.bot]])
  f.queue.db.prepare('INSERT INTO metadata VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run('invites',JSON.stringify(['local','remote','unknown'].map(inviteId=>({inviteId,principalId:f.bot.principalId,...(inviteId==='unknown'?{}:{inviterPrincipalId:inviteId==='local'?f.human.principalId:'human:b:other'})}))))
  f.runtime.operation=async(_actor,_type,payload)=>calls.push(payload.inviteId)
  await CommunicationRuntime.prototype.acceptBotInvites.call(f.runtime,{localOnly:true})
  assert.deepEqual(calls,['local'])
})
