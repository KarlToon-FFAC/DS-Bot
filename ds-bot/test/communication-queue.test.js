import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CommunicationQueue } from '../src/host/federation/queue-store.js'
import { CommunicationRuntime } from '../src/host/federation/runtime.js'

test('communication adapter imports against the pinned public DSH packages', () => {
  assert.equal(typeof CommunicationRuntime, 'function')
})

test('enrolled Human uses its Hub-assigned local identity without overwriting a legacy identity', () => {
  const fresh = new CommunicationQueue(':memory:', { instanceId: 'enrolled' })
  const legacy = new CommunicationQueue(':memory:', { instanceId: 'legacy' })
  try {
    const assigned = fresh.localPrincipal('human', 'local-user', 'Alice', 'local-user')
    assert.equal(assigned.principalId, 'human:enrolled:local-user')
    assert.equal(fresh.localPrincipal('human', 'local-user', 'Renamed', 'local-user').principalId, assigned.principalId)
    const original = legacy.localPrincipal('human', 'local-user', 'Legacy')
    assert.throws(() => legacy.localPrincipal('human', 'local-user', 'Unsafe replacement', 'local-user'), { code: 'PRINCIPAL_ID_MISMATCH' })
    assert.equal(legacy.localPrincipal('human', 'local-user', 'Legacy').principalId, original.principalId)
  } finally { fresh.close(); legacy.close() }
})

test('reply previews stay within the Human membership epoch even when its Bot cached older history', () => {
  const queue = new CommunicationQueue(':memory:', { instanceId: 'reference-test' })
  try {
    const human = queue.localPrincipal('human', 'owner', 'Person').principalId
    const bot = queue.localPrincipal('bot', 'chief', 'Chief').principalId
    const membership = (principalId, membershipEpoch, joinSeq) => ({ conversationId: 'group', principalId, membershipEpoch, joinSeq, active: true })
    queue.applyMemberships({ memberships: [membership(bot, 'bot-epoch', 1), membership(human, 'human-epoch', 3)] })
    const event = seq => ({ conversationId: 'group', conversationSeq: seq, eventId: `event-${seq}`, type: 'message', message: { messageId: `message-${seq}` } })
    queue.applySync({ conversationId: 'group', principalId: bot, membershipEpoch: 'bot-epoch', joinSeq: 1, events: [event(1), event(2), event(3)] })
    queue.applySync({ conversationId: 'group', principalId: human, membershipEpoch: 'human-epoch', joinSeq: 3, events: [event(3), event(5)] })
    assert.equal(queue.reference('group', human, 'human-epoch', 'message-3').conversationSeq, 3)
    assert.throws(() => queue.reference('group', human, 'human-epoch', 'message-1'), { code: 'REFERENCE_NOT_AVAILABLE' })
    assert.throws(() => queue.reference('group', human, 'human-epoch', 'message-5'), { code: 'REFERENCE_NOT_AVAILABLE' })
    queue.applySync({ conversationId: 'group', principalId: human, membershipEpoch: 'human-epoch', joinSeq: 3, events: [event(4)] })
    assert.equal(queue.reference('group', human, 'human-epoch', 'message-5').conversationSeq, 5)
    queue.applyMemberships({ memberships: [membership(bot, 'bot-epoch', 1), membership(human, 'human-rejoin', 6)] })
    assert.throws(() => queue.reference('group', human, 'human-rejoin', 'message-3'), { code: 'REFERENCE_NOT_AVAILABLE' })
    assert.throws(() => queue.reference('group', human, 'human-epoch', 'message-3'), { code: 'MEMBERSHIP_REVOKED' })
    assert.throws(() => queue.reference('other-group', human, 'human-rejoin', 'message-3'), { code: 'MEMBERSHIP_REVOKED' })
  } finally { queue.close() }
})

test('tool send identity includes its durable assistant event when a provider reuses call IDs', async () => {
  let events = [{ seq: 3, type: 'assistant/message', data: { message: { id: 'assistant-one', content: [{ type: 'tool-call', id: 'reused' }] } } }]
  let flushed = 0
  const runtime = { ctx: { sessions: { flush: async () => { flushed += 1 } }, sessionController: { inspect: async () => ({ events }) } } }
  const exec = { callId: 'reused', agent: { id: 'local-session', session: {} } }
  const first = await CommunicationRuntime.prototype.toolSource.call(runtime, exec)
  assert.equal(await CommunicationRuntime.prototype.toolSource.call(runtime, exec), first)
  events = [...events, { seq: 8, type: 'assistant/message', data: { message: { id: 'assistant-two', content: [{ type: 'tool-call', id: 'reused' }] } } }]
  assert.notEqual(await CommunicationRuntime.prototype.toolSource.call(runtime, exec), first)
  assert.equal(flushed, 3)
  await assert.rejects(CommunicationRuntime.prototype.toolSource.call(runtime, { ...exec, callId: 'absent' }), { code: 'TOOL_SOURCE_UNKNOWN' })
})

test('v1 queue migration retains pending operations; opaque local identities and epoch bindings survive reopen', () => {
  const root = mkdtempSync(join(tmpdir(), 'dsbot-communication-queue-'))
  let queue
  try {
    const path = join(root, 'queue.sqlite')
    queue = new CommunicationQueue(path, { instanceId: 'instance-a' })
    queue.enqueueOperation('dm.open', { principalId: 'human:instance-a:old', operationId: 'pending-v1', otherPrincipalId: 'bot:b:k' })
    queue.db.exec('DROP TABLE local_principals; DROP TABLE bindings; DROP TABLE view_watermarks; ALTER TABLE inbox DROP COLUMN revocation_result; PRAGMA user_version=1')
    queue.close()
    queue = new CommunicationQueue(path)
    assert.equal(queue.instanceId, 'instance-a')
    assert.equal(queue.pendingOutbox()[0].id, 'pending-v1')
    const bot = queue.localPrincipal('bot', 'private-dsh-session-id', 'Chief')
    assert.ok(!bot.principalId.includes('private-dsh-session-id'))
    const member = epoch => ({ conversationId: 'group', principalId: bot.principalId, membershipEpoch: epoch, joinSeq: 1, active: true })
    queue.applyMemberships({ memberships: [member('first')] })
    const first = queue.binding('group', bot.principalId, 'first', 'private-dsh-session-id')
    queue.addBindingSession(first.id, 'segment-one')
    queue.addBindingSession(first.id, 'segment-two')
    queue.close()
    queue = new CommunicationQueue(path)
    assert.deepEqual(queue.localPrincipal('bot', 'private-dsh-session-id', 'Chief renamed').principalId, bot.principalId)
    assert.deepEqual(queue.bindings()[0].sessionIds, ['segment-one', 'segment-two'])
    queue.applyMemberships({ memberships: [member('second')] })
    const second = queue.binding('group', bot.principalId, 'second', 'private-dsh-session-id')
    assert.notEqual(first.id, second.id)
    assert.deepEqual(second.sessionIds, [])
    assert.throws(() => queue.member('group', bot.principalId, 'first'), { code: 'MEMBERSHIP_REVOKED' })
  } finally { queue?.close(); rmSync(root, { recursive: true, force: true }) }
})
