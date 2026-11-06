import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CommunicationQueue } from '../src/host/federation/queue-store.js'
import { CommunicationRuntime } from '../src/host/federation/runtime.js'
import { CommunicationTransport } from '../src/host/federation/transport.js'

test('private chat archive survives reopening, stays local to one Hub, and preserves messages, unread state and delivery', t => {
  const root = mkdtempSync(join(tmpdir(), 'dsbot-archive-')), path = join(root, 'one.sqlite')
  let queue = new CommunicationQueue(path, { instanceId: 'a' }), other
  t.after(() => { queue?.close(); other?.close(); rmSync(root, { recursive: true, force: true }) })
  const person = queue.localPrincipal('human', 'owner', 'Owner')
  const member = { conversationId: 'private', principalId: person.principalId, membershipEpoch: 'epoch', joinSeq: 1, watermark: 1, kind: 'dm', active: true }
  queue.applyMemberships({ memberships: [member], invites: [] })
  queue.applySync({ ...member, events: [{ type: 'message', eventId: 'one', conversationId: 'private', conversationSeq: 1,
    message: { messageId: 'one', author: { principalId: 'human:b:owner' }, content: { text: 'Retained history' } } }] })
  const history = queue.view('private', person.principalId, 'epoch'), unread = queue.unread('private', person.principalId, 'epoch')
  assert.deepEqual(queue.setConversationArchived('private', true).archivedConversationIds, ['private'])
  queue.db.exec("CREATE TABLE local_address_notes(address TEXT PRIMARY KEY,note TEXT NOT NULL); INSERT INTO local_address_notes VALUES ('192.0.2.1','retired note')")
  queue.close(); queue = new CommunicationQueue(path)
  assert.equal(queue.db.prepare("SELECT 1 FROM sqlite_master WHERE name='local_address_notes'").get(),undefined)
  assert.deepEqual(queue.archivedConversations(), ['private'])
  assert.deepEqual(queue.view('private', person.principalId, 'epoch'), history)
  assert.equal(queue.unread('private', person.principalId, 'epoch'), unread)
  assert.equal(JSON.parse(queue.member('private', person.principalId, 'epoch').body).kind, 'dm')
  other = new CommunicationQueue(join(root, 'two.sqlite'), { instanceId: 'a' })
  assert.deepEqual(other.archivedConversations(), [])
  assert.deepEqual(queue.pendingOutbox(), [])
  assert.deepEqual(queue.setConversationArchived('private', false).archivedConversationIds, [])
  assert.throws(() => queue.setConversationArchived('private', 'true'), { code: 'INVALID_REQUEST' })
})

test('archiving requires the exact local Human or owned Bot DM epoch and Hub scope, and cannot change groups or Hub membership', async () => {
  const start = CommunicationTransport.prototype.start
  CommunicationTransport.prototype.start = () => {}
  let runtime, readOnly
  try {
    runtime = new CommunicationRuntime({ home: tmpdir(), botOf: id => id === 'worker' ? { id } : null, readOnly: () => readOnly,
      ctx: { on: () => () => {}, systemPrompt: { section: () => () => {} } } },
    { url: 'ws://127.0.0.1:3190/communication', hubId: 'archive-test', instanceId: 'a', dataPath: ':memory:', publishedBotIds: [] }, 'synthetic', [])
    runtime.transport.request = async () => assert.fail('Archive preferences never contact the Hub')
    runtime.everReconciled = true
    const bot = runtime.queue.localPrincipal('bot', 'worker', 'Worker')
    runtime.bots.set('worker', bot)
    const own = { principalId: runtime.human.principalId, membershipEpoch: 'epoch', joinSeq: 1, watermark: 0, active: true }
    runtime.queue.applyMemberships({ memberships: [
      { ...own, conversationId: 'private', kind: 'dm' }, { ...own, conversationId: 'group', kind: 'group' },
      { ...own, principalId: bot.principalId, conversationId: 'bot-private', kind: 'dm' }], invites: [] })
    runtime.conversations.set('bot-private', { kind: 'dm', members: [{ ...bot, kind: 'bot' }, { principalId: 'bot:b:expert', kind: 'bot' }] })
    const input = { conversationId: 'private', membershipEpoch: 'epoch', archived: true, expectedScope: runtime.conversationPreferencesScope() }
    runtime.setConversationArchived(input)
    runtime.setConversationArchived({ ...input, conversationId: 'bot-private', localBotId: 'worker' })
    assert.deepEqual(runtime.snapshot().archivedConversationIds, ['bot-private', 'private'])
    assert.throws(() => runtime.setConversationArchived({ ...input, membershipEpoch: 'old' }), { code: 'MEMBERSHIP_REVOKED' })
    assert.throws(() => runtime.setConversationArchived({ ...input, membershipEpoch: undefined }), { code: 'MEMBERSHIP_EPOCH_REQUIRED' })
    assert.throws(() => runtime.setConversationArchived({ ...input, conversationId: 'group' }), { code: 'INVALID_REQUEST' })
    assert.throws(() => runtime.setConversationArchived({ ...input, expectedScope: 'old-hub' }), { code: 'HUB_SELECTION_CHANGED' })
    assert.throws(() => runtime.setConversationArchived({ ...input, conversationId: 'bot-private', localBotId: 'foreign' }), { code: 'BOT_NOT_PUBLISHED' })
    readOnly = 'locked'
    assert.throws(() => runtime.setConversationArchived({ ...input, archived: false }), { code: 'COMMUNICATION_READ_ONLY' })
    assert.deepEqual(runtime.queue.pendingOutbox(), [])
  } finally { await runtime?.close(); CommunicationTransport.prototype.start = start }
})
