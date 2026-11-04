import assert from 'node:assert/strict'
import { test } from 'node:test'
import { CommunicationQueue } from '../src/host/federation/queue-store.js'
import { CommunicationRuntime } from '../src/host/federation/runtime.js'

function fixture(t) {
  const queue = new CommunicationQueue(':memory:', { instanceId: 'thread-test' }); t.after(() => queue.close())
  const human = queue.localPrincipal('human', 'user', 'Person'), bot = queue.localPrincipal('bot', 'worker', 'Worker')
  const member = (id = 'group', principalId = human.principalId, epoch = 'current', joinSeq = 1, watermark = 10) => ({ conversationId: id, principalId, membershipEpoch: epoch, joinSeq, watermark, active: true, kind: 'group', speakingMode: 'readOnly' })
  const event = (seq, id, parent = null, conversationId = 'group') => ({ type: 'message', eventId: `${conversationId}-${seq}`, conversationId, conversationSeq: seq, serverAcceptedAt: '2026-11-04T01:00:00Z',
    message: { messageId: id, replyToMessageId: parent, author: { principalId: human.principalId }, content: { text: id, format: 'markdown' } } })
  const sync = (membership, events) => queue.applySync({ ...membership, events })
  return { queue, human, bot, member, event, sync }
}

test('reply threads collect visible ancestors, deep replies and siblings without joining independent roots or Bot causal roots', t => {
  const f = fixture(t), membership = f.member('group', f.human.principalId, 'current', 1, 6)
  f.queue.applyMemberships({ memberships: [membership], invites: [] })
  f.sync(membership, [f.event(1, 'root'), f.event(2, 'child', 'root'), f.event(3, 'other'), f.event(4, 'deep', 'child'), f.event(5, 'sibling', 'root'), { ...f.event(6, 'causal-only'), causality: { rootMessageId: 'root' } }])
  const page = f.queue.thread('group', f.human.principalId, 'current', 'deep')
  assert.equal(page.rootMessageId, 'root')
  assert.deepEqual(page.events.map(item => item.message.messageId), ['root', 'child', 'deep', 'sibling'])
  assert.equal(page.earlierUnavailable, false)
  assert.equal(page.hasMore, false)
  const runtime = { member: (id, conversation, epoch) => { assert.equal(id, f.human.principalId); assert.equal(conversation, 'group'); assert.equal(epoch, 'current'); return membership }, queue: f.queue }
  assert.deepEqual(CommunicationRuntime.prototype.thread.call(runtime, f.human.principalId, { conversationId: 'group', membershipEpoch: 'current', messageId: 'deep' }), page)
})

test('thread pages use a stable watermark, bounded limits and monotonic cursors despite later replies', t => {
  const f = fixture(t), membership = f.member('group', f.human.principalId, 'current', 1, 5)
  f.queue.applyMemberships({ memberships: [membership], invites: [] })
  f.sync(membership, Array.from({ length: 5 }, (_, i) => f.event(i + 1, `m${i}`, i ? 'm0' : null)))
  const one = f.queue.thread('group', f.human.principalId, 'current', 'm2', { limit: 2 })
  assert.equal(one.nextAfter, 2); assert.equal(one.hasMore, true)
  f.sync({ ...membership, watermark: 6 }, [f.event(6, 'new', 'm0')])
  const two = f.queue.thread('group', f.human.principalId, 'current', 'm2', { after: one.nextAfter, watermark: one.watermark, limit: 2 })
  const three = f.queue.thread('group', f.human.principalId, 'current', 'm2', { after: two.nextAfter, watermark: one.watermark, limit: 2 })
  assert.deepEqual([...one.events, ...two.events, ...three.events].map(item => item.message.messageId), ['m0', 'm1', 'm2', 'm3', 'm4'])
  assert.equal(three.hasMore, false)
  for (const options of [{ limit: 101 }, { after: -1 }, { watermark: 100 }, { watermark: -1 }]) assert.throws(() => f.queue.thread('group', f.human.principalId, 'current', 'm2', options), /INVALID_CURSOR/)
})

test('thread reads cannot expose other conversations, Bot-only history, old epochs, unsynchronized events or revoked membership', t => {
  const f = fixture(t), current = f.member('group', f.human.principalId, 'current', 3, 6), other = f.member('other'), privateMember = f.member('group', f.bot.principalId, 'bot', 1, 6)
  f.queue.applyMemberships({ memberships: [current, other, privateMember], invites: [] })
  f.sync(privateMember, Array.from({ length: 6 }, (_, i) => f.event(i + 1, i === 0 ? 'secret' : `bot-${i}`, i ? 'secret' : null)))
  f.sync(other, [f.event(1, 'secret', null, 'other')])
  f.sync(current, [f.event(3, 'visible', 'secret'), f.event(4, 'reply', 'visible'), f.event(6, 'gap', 'visible')])
  const page = f.queue.thread('group', f.human.principalId, 'current', 'reply')
  assert.equal(page.rootMessageId, 'visible'); assert.equal(page.earlierUnavailable, true)
  assert.deepEqual(page.events.map(item => item.message.messageId), ['visible', 'reply'])
  for (const id of ['secret', 'gap']) assert.throws(() => f.queue.thread('group', f.human.principalId, 'current', id), /REFERENCE_NOT_AVAILABLE/)
  assert.throws(() => f.queue.thread('group', f.human.principalId, 'old', 'reply'), /MEMBERSHIP/)
  f.queue.applyMemberships({ memberships: [other, privateMember], invites: [] })
  assert.throws(() => f.queue.thread('group', f.human.principalId, 'current', 'reply'), /MEMBERSHIP/)
})

test('malformed cyclic reply edges terminate and return canonical messages only once', t => {
  const f = fixture(t), membership = f.member('group', f.human.principalId, 'current', 1, 3)
  f.queue.applyMemberships({ memberships: [membership], invites: [] })
  f.sync(membership, [f.event(1, 'a', 'b'), f.event(2, 'b', 'a'), f.event(3, 'c', 'b')])
  const page = f.queue.thread('group', f.human.principalId, 'current', 'c')
  assert.deepEqual(page.events.map(item => item.message.messageId), ['a', 'b', 'c'])
})
