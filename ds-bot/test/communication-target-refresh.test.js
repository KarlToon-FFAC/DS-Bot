import assert from 'node:assert/strict'
import { test } from 'node:test'
import { CommunicationQueue } from '../src/host/federation/queue-store.js'
import { CommunicationRuntime } from '../src/host/federation/runtime.js'
import { HubStore } from '../../communication-hub/src/store.js'
import { CAPABILITIES } from '../../communication-hub/src/protocol.js'
import { randomUUID } from 'node:crypto'
import { communicationError } from '../src/shared/communication-diagnostics.js'

function fixture(t, kind = 'human') {
  const queue = new CommunicationQueue(':memory:', { instanceId: 'a' })
  t.after(() => queue.close())
  const actor = queue.localPrincipal(kind, 'actor', 'Actor'), other = { principalId: 'bot:b:joined', kind: 'bot', displayName: 'Joined', speakingMode: 'active' }
  const membership = { conversationId: 'group', principalId: actor.principalId, membershipEpoch: 'original', membershipVersion: 1, joinSeq: 1, watermark: 0, active: true, kind: 'group', speakingMode: kind === 'human' ? 'speak' : 'active' }
  queue.applyMemberships({ memberships: [membership], invites: [] })
  const self = { ...actor, speakingMode: membership.speakingMode }
  const initial = { conversationId: 'group', kind: 'group', membershipVersion: 1, members: [self] }
  const fresh = { ...initial, membershipVersion: 2, members: [self, other] }
  const runtime = Object.create(CommunicationRuntime.prototype)
  Object.assign(runtime, { queue, human: actor, everReconciled: true, contacts: [self, other], conversations: new Map([['group', initial]]),
    rt: {}, transport: { connected: true, generation: 1, socket: {}, request: async (type, payload) => { calls.push({ type, payload }); return fresh } } })
  const calls = [], input = { conversationId: 'group', text: 'Hello', mentions: [other.principalId], messageId: 'same-message', clientCreatedAt: '2026-11-05T00:00:00Z', membershipEpoch: 'original' }
  return { queue, actor, other, membership, initial, fresh, runtime, calls, input }
}

test('immediate Human mention refreshes once with the original actor and epoch, preserving the exact intent and retry ID', async t => {
  const f = fixture(t)
  const result = await f.runtime.sendHumanWithRefresh(f.input)
  assert.equal(result.messageId, 'same-message')
  assert.deepEqual(f.calls, [{ type: 'conversation.members', payload: { conversationId: 'group', principalId: f.actor.principalId, membershipEpoch: 'original', checkPrincipalIds: [f.other.principalId] } }])
  const original = f.queue.intent('same-message').payload
  assert.deepEqual(original.mentions, [{ principalId: f.other.principalId }])
  assert.equal(original.membershipEpoch, 'original')
  f.runtime.conversations.clear(); f.runtime.transport.connected = false
  assert.deepEqual(await f.runtime.sendHumanWithRefresh(f.input), result)
  assert.equal(f.calls.length, 1)
  assert.deepEqual(f.queue.intent('same-message').payload, original)
  assert.equal(f.queue.pendingOutbox().length, 1)
})

test('Bot preflight rollback refreshes its own scope once and never reexports an existing tool source', async t => {
  const f = fixture(t, 'bot'), input = { conversationId: 'group', text: 'Work', activationTargets: [f.other.principalId], messageId: 'bot-original-id' }
  const exec = { callId: 'call', agent: { id: 'own-chat' }, communicationSource: 'one-tool-source' }
  const request = f.runtime.transport.request
  f.runtime.transport.request = (...args) => {
    assert.equal(f.queue.pendingOutbox().length, 0)
    assert.equal(f.queue.db.prepare('SELECT count(*) n FROM exports').get().n, 0)
    return request(...args)
  }
  const first = await f.runtime.sendBot(f.actor, input, exec)
  assert.equal(first.messageId, 'bot-original-id')
  assert.equal(f.calls[0].payload.principalId, f.actor.principalId)
  assert.deepEqual(f.queue.intent(first.messageId).payload.activationTargets, [{ principalId: f.other.principalId }])
  f.runtime.conversations.clear(); f.runtime.transport.connected = false
  const second = await f.runtime.sendBot(f.actor, input, exec)
  assert.equal(second.messageId, first.messageId)
  assert.equal(f.calls.length, 1)
  assert.equal(f.queue.pendingOutbox().length, 1)
})

test('canonical absence stays denied after one read with no queue or export mutation', async t => {
  const f = fixture(t)
  f.runtime.transport.request = async () => { f.calls.push('read'); return f.initial }
  await assert.rejects(f.runtime.sendHumanWithRefresh(f.input), { code: 'UNKNOWN_MENTION' })
  assert.equal(f.calls.length, 1)
  assert.equal(f.queue.pendingOutbox().length, 0)
})

for (const change of ['stop', 'socket', 'generation', 'epoch', 'revoked', 'permission', 'older-version', 'wrong-conversation', 'wrong-kind']) {
  test(`member refresh cannot enqueue or replace the cache after ${change}`, async t => {
    const f = fixture(t)
    f.runtime.transport.request = async () => {
      if (change === 'stop') f.runtime.closed = true
      if (change === 'socket') f.runtime.transport.socket = {}
      if (change === 'generation') f.runtime.transport.generation++
      if (change === 'epoch') f.queue.applyMemberships({ memberships: [{ ...f.membership, membershipEpoch: 'new' }], invites: [] })
      if (change === 'revoked') f.queue.applyMemberships({ memberships: [], invites: [] })
      if (change === 'permission') return { ...f.fresh, members: f.fresh.members.map(person => person.principalId === f.actor.principalId ? { ...person, speakingMode: 'readOnly' } : person) }
      if (change === 'older-version') return { ...f.fresh, membershipVersion: 0 }
      if (change === 'wrong-kind') return { ...f.fresh, kind: 'dm' }
      if (change === 'wrong-conversation') return { ...f.fresh, conversationId: 'private-other' }
      return f.fresh
    }
    await assert.rejects(f.runtime.sendHumanWithRefresh(f.input), { code: { stop: 'CONNECTION_LOST', socket: 'CONNECTION_LOST', generation: 'CONNECTION_LOST', epoch: 'MEMBERSHIP_REVOKED', revoked: 'NOT_A_MEMBER', permission: 'SPEAKING_FORBIDDEN', 'older-version': 'AUTHORIZATION_PENDING', 'wrong-conversation': 'INVALID_RESPONSE', 'wrong-kind': 'INVALID_RESPONSE' }[change] })
    assert.equal(f.queue.pendingOutbox().length, 0)
    assert.equal(f.runtime.conversations.get('group'), f.initial)
  })
}

test('all-member expansion waits for the matching local membership version rather than bypassing synchronization', async t => {
  const f = fixture(t)
  f.runtime.conversations.clear()
  await assert.rejects(f.runtime.sendHumanWithRefresh({ ...f.input, text: '@all', mentions: [] }), { code: 'AUTHORIZATION_PENDING' })
  assert.equal(f.calls.length, 1)
  assert.equal(f.queue.pendingOutbox().length, 0)
})


test('immediate send after actual Hub group acceptance resolves the new member without waiting for the poll', async t => {
  const f = fixture(t), hub = new HubStore(':memory:')
  t.after(() => hub.close())
  const a = hub.connect('a', 'A', CAPABILITIES), b = hub.connect('b', 'B', CAPABILITIES)
  const human = hub.register(a, { localId: f.actor.localId, kind: 'human', displayName: 'Actor' }).principalId
  hub.register(b,{localId:'owner',kind:'human',displayName:'Remote owner'})
  const bot = hub.register(b, { localId: 'joined', kind: 'bot', displayName: 'Joined' }).principalId
  assert.equal(human, f.actor.principalId)
  const op = input => ({ operationId: randomUUID(), ...input })
  const { conversationId } = hub.createGroup(a, op({ principalId: human, title: 'Immediate membership projection' }))
  const snapshot = hub.memberships(a), membership = snapshot.memberships.find(value => value.conversationId === conversationId)
  f.queue.applyMemberships(snapshot)
  f.runtime.conversations = new Map([[conversationId, hub.members(a, { conversationId, principalId: human, membershipEpoch: membership.membershipEpoch })]])
  const invite = hub.invite(a, op({ conversationId, principalId: human, membershipEpoch: membership.membershipEpoch, inviteePrincipalId: bot }))
  hub.accept(b, op({ principalId: bot, inviteId: invite.inviteId }))
  f.runtime.transport.request = async (type, payload) => {
    f.calls.push({ type, payload }); assert.equal(type, 'conversation.members')
    return hub.members(a, payload)
  }
  const input = { ...f.input, conversationId, membershipEpoch: membership.membershipEpoch }
  const result = await f.runtime.sendHumanWithRefresh(input)
  assert.equal(result.messageId, input.messageId)
  const accepted = hub.publish(a, f.queue.intent(result.messageId).payload)
  assert.equal(accepted.messageId, input.messageId)
  assert.equal(hub.db.prepare('SELECT ai FROM deliveries WHERE message_id=? AND recipient_id=?').get(input.messageId, bot).ai, 1)
  assert.equal(f.calls.length, 1)
})


test('pending membership diagnostics describe synchronization rather than requiring reconnection', () => {
  const error = communicationError({ code: 'AUTHORIZATION_PENDING' })
  assert.match(error.message, /Membership is still syncing/)
  assert.match(error.message, /same request/)
  assert.match(error.nextActions.join(' '), /same message or operation ID/)
  assert.doesNotMatch(error.message, /connection to recover/)
})

test('a current group member outside the directory is mentionable, while a contact outside the group is not',async t=>{
 const f=fixture(t)
 f.runtime.contacts=[];f.runtime.conversations.set('group',f.fresh)
 const result=await f.runtime.sendHumanWithRefresh(f.input)
 assert.equal(result.status,'pending');assert.equal(f.calls.length,0)
 assert.deepEqual(f.queue.intent(result.messageId).payload.mentions,[{principalId:f.other.principalId}])
 const outsider={principalId:'bot:c:outside',kind:'bot',displayName:'Outside'}
 f.runtime.contacts.push(outsider)
 await assert.rejects(f.runtime.sendHumanWithRefresh({...f.input,messageId:'outside',mentions:[outsider.principalId]}),{code:'UNKNOWN_MENTION'})
 assert.equal(f.queue.intent('outside'),null)
})

test('retired mention is diagnosed by the real Hub before enqueue even when the local conversation never knew it',async t=>{
 const f=fixture(t),hub=new HubStore(':memory:');t.after(()=>hub.close())
 const a=hub.connect('a','A',CAPABILITIES),b=hub.connect('b','B',CAPABILITIES)
 const human=hub.register(a,{localId:f.actor.localId,kind:'human',displayName:'Actor'}).principalId
 hub.register(b,{localId:'owner',kind:'human',displayName:'Owner'})
 const retired=hub.register(b,{localId:'retired',kind:'bot',displayName:'Retired'}).principalId
 const group=hub.createGroup(a,{operationId:randomUUID(),principalId:human,title:'Scoped check'}).conversationId
 hub.syncPublication(b,{principalIds:[]})
 f.queue.applyMemberships(hub.memberships(a))
 const membership=f.queue.memberships().find(row=>row.conversationId===group)
 const scope={conversationId:group,principalId:human,membershipEpoch:membership.membershipEpoch}
 f.runtime.conversations=new Map([[group,hub.members(a,scope)]])
 f.runtime.contacts=[]
 const before=hub.db.prepare('SELECT seq FROM conversations WHERE id=?').get(group).seq
 f.runtime.transport.request=async(type,payload)=>{f.calls.push({type,payload});assert.equal(type,'conversation.members');return hub.members(a,payload)}
 await assert.rejects(f.runtime.sendHumanWithRefresh({...f.input,conversationId:group,membershipEpoch:membership.membershipEpoch,mentions:[retired]}),{code:'BOT_RETIRED'})
 assert.equal(f.calls.length,1);assert.deepEqual(f.calls[0].payload.checkPrincipalIds,[retired])
 assert.equal(f.queue.pendingOutbox().length,0)
 assert.equal(hub.db.prepare('SELECT seq FROM conversations WHERE id=?').get(group).seq,before)
 assert.throws(()=>hub.members(b,{...scope,principalId:`human:b:owner`,checkPrincipalIds:[retired]}),{code:'NOT_A_MEMBER'})
})
