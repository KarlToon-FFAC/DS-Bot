import assert from 'node:assert/strict'
import { test } from 'node:test'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { HubStore } from '../src/store.js'
import { CAPABILITIES, PROTOCOL, hash } from '../src/protocol.js'

function fixture(t, limits = {}, disk = false) {
  const dir = disk && mkdtempSync(join(tmpdir(), 'dsbot-causal-chain-'))
  const f = { path: dir ? join(dir, 'hub.sqlite') : ':memory:', limits }
  f.store = new HubStore(f.path, { limits })
  t.after(() => { f.store.close(); if (dir) rmSync(dir, { recursive: true, force: true }) })
  f.a = f.store.connect('a', 'A', CAPABILITIES); f.b = f.store.connect('b', 'B', CAPABILITIES)
  f.store.register(f.b, {localId:'owner',kind:'human',displayName:'Remote owner'})
  const add = (auth, localId, kind) => f.store.register(auth, { localId, kind, displayName: localId }).principalId
  f.H = add(f.a, 'H', 'human'); f.A = add(f.a, 'A', 'bot'); f.B = add(f.b, 'B', 'bot'); f.C = add(f.a, 'C', 'bot')
  f.auth = id => id.split(':')[1] === 'a' ? f.a : f.b
  f.member = (id, group = f.group) => f.store.memberships(f.auth(id)).memberships.find(m => m.principalId === id && m.conversationId === group && m.active)
  f.op = value => ({ operationId: randomUUID(), ...value })
  f.group = f.store.createGroup(f.a, f.op({ principalId: f.H, title: 'Causal group' })).conversationId
  f.join = id => {
    const invite = f.store.invite(f.a, f.op({ principalId: f.H, conversationId: f.group, membershipEpoch: f.member(f.H).membershipEpoch, inviteePrincipalId: id }))
    f.store.accept(f.auth(id), f.op({ principalId: id, inviteId: invite.inviteId }))
  }
  f.policy = (id, speakingMode) => f.store.policy(f.a, f.op({ principalId: f.H, conversationId: f.group,
    membershipEpoch: f.member(f.H).membershipEpoch, expectedVersion: f.member(f.H).membershipVersion, targetPrincipalId: id, speakingMode }))
  for (const id of [f.A, f.B, f.C]) { f.join(id); f.policy(id, 'active') }
  f.input = (id, extra = {}) => ({ protocol: PROTOCOL, type: 'message.publish', messageId: randomUUID(), conversationId: f.group,
    author: { principalId: id, homeInstanceId: id.split(':')[1], kind: id.split(':')[0] }, clientCreatedAt: new Date().toISOString(),
    content: { format: 'text', text: 'Causal collaboration' }, mentions: [], replyToMessageId: null, membershipEpoch: f.member(id).membershipEpoch, ...extra, ...(id.startsWith('bot:') ? { activationTargets: extra.activationTargets ?? extra.mentions ?? [] } : {}) })
  f.send = (id, extra = {}) => f.store.publish(f.auth(id), f.input(id, extra))
  f.grant = (message, id, stored = true) => {
    const row = f.store.db.prepare('SELECT * FROM deliveries WHERE message_id=? AND recipient_id=?').get(message.messageId, id)
    assert.equal(row.ai, 1)
    if (stored) f.store.receipt(f.auth(id), { deliveryId: row.id, principalId: id, membershipEpoch: row.membership_epoch, status: 'targetStored' })
    return row.id
  }
  f.ai = message => f.store.db.prepare('SELECT recipient_id FROM deliveries WHERE message_id=? AND ai=1 ORDER BY recipient_id').all(message.messageId).map(row => row.recipient_id)
  return f
}

test('Human to local A to remote B back to A preserves causal identity; passive final delegates once', t => {
  const f = fixture(t)
  f.policy(f.A, 'passive'); f.policy(f.B, 'passive')
  const human = f.send(f.H, { mentions: [{ principalId: f.A }] })
  const aGrant = f.grant(human, f.A)
  const a = f.send(f.A, { responseToDeliveryId: aGrant, causationDeliveryId: aGrant, replyToMessageId: human.messageId, mentions: [{ principalId: f.B }] })
  assert.deepEqual(f.ai(a), [f.B])
  const bGrant = f.grant(a, f.B)
  const b = f.send(f.B, { responseToDeliveryId: bGrant, replyToMessageId: a.messageId, mentions: [{ principalId: f.A }] })
  assert.deepEqual(f.ai(b), [f.A])
  assert.deepEqual(b.causality, { rootMessageId: human.messageId, parentMessageId: a.messageId, depth: 2 })
  assert.throws(() => f.send(f.A, { causationDeliveryId: aGrant, mentions: [{ principalId: f.B }] }), { code: 'PASSIVE_REPLY_REQUIRED' })
  assert.throws(() => f.send(f.A, { responseToDeliveryId: aGrant, replyToMessageId: human.messageId }), { code: 'RESPONSE_ALREADY_SENT' })
})

test('active tool branches and all-Bot expansion exclude the author and share a durable total root budget', t => {
  const f = fixture(t, { maxCausalDepth: 100, maxAiDeliveriesPerRoot: 3 }, true)
  const human = f.send(f.H, { mentions: [{ principalId: f.A }] }), grant = f.grant(human, f.A)
  const branch = f.send(f.A, { causationDeliveryId: grant, mentions: [f.A, f.B, f.C].map(principalId => ({ principalId })) })
  assert.deepEqual(f.ai(branch), [f.C, f.B].sort())
  const suppressedInput = f.input(f.A, { causationDeliveryId: grant, mentions: [{ principalId: f.B }] })
  const suppressed = f.store.publish(f.a, suppressedInput)
  assert.equal(suppressed.dispatchSuppressed, 'DUPLICATE_HANDOFF'); assert.deepEqual(f.ai(suppressed), [])
  assert.equal(suppressed.causality.rootMessageId, human.messageId)
  f.store.close(); f.store = new HubStore(f.path, { limits: f.limits })
  assert.deepEqual(f.store.publish(f.a, suppressedInput), suppressed)
  const fresh = f.send(f.A, { mentions: [{ principalId: f.B }] })
  assert.equal(fresh.dispatchSuppressed, undefined)
  assert.equal(fresh.causality.rootMessageId, fresh.messageId)
  assert.equal(f.store.db.prepare('SELECT ai_deliveries n FROM causal_roots WHERE id=?').get(`message:${human.messageId}`).n, 3)
  const final = f.send(f.A, { responseToDeliveryId: grant, replyToMessageId: human.messageId })
  assert.deepEqual(f.ai(final), [])
  const nextHuman = f.send(f.H, { mentions: [{ principalId: f.B }] })
  assert.deepEqual(f.ai(nextHuman), [f.B]); assert.equal(nextHuman.causality.rootMessageId, nextHuman.messageId)
})

test('depth limit accepts the final visible message without continuing the loop or spending duplicate budget', t => {
  const f = fixture(t, { maxCausalDepth: 3 })
  const human = f.send(f.H, { mentions: [{ principalId: f.A }] })
  let parent = human, lastInput, last
  for (const [index, actor] of [f.A, f.B, f.A].entries()) {
    const target = actor === f.A ? f.B : f.A
    lastInput = f.input(actor, { responseToDeliveryId: f.grant(parent, actor), replyToMessageId: parent.messageId, mentions: [{ principalId: target }] })
    last = f.store.publish(f.auth(actor), lastInput)
    assert.equal(last.causality.depth, index + 1)
    assert.equal(last.causality.rootMessageId, human.messageId)
    if (index < 2) assert.deepEqual(f.ai(last), [target])
    parent = last
  }
  assert.equal(last.dispatchSuppressed, 'CAUSAL_LIMIT'); assert.deepEqual(f.ai(last), [])
  assert.deepEqual(f.store.publish(f.a, lastInput), last)
  assert.equal(f.store.db.prepare('SELECT sum(ai_deliveries) n FROM causal_roots').get().n, 3)
})

test('a Bot DM stops one automatic chain but a genuinely new proactive message starts a separate task', t => {
  const f = fixture(t, { maxCausalDepth: 3, maxAiDeliveriesPerRoot: 4 })
  const dm = f.store.createDm(f.a, f.op({ principalId: f.A, otherPrincipalId: f.B })).conversationId
  let parent, root
  for (const actor of [f.A, f.B, f.A, f.B]) {
    const member = f.member(actor, dm)
    const extra = parent ? { responseToDeliveryId: f.grant(parent, actor), replyToMessageId: parent.messageId } : {}
    parent = f.send(actor, { conversationId: dm, membershipEpoch: member.membershipEpoch, ...extra })
    root ??= parent.causality.rootMessageId
  }
  assert.equal(parent.dispatchSuppressed, 'CAUSAL_LIMIT')
  const continuation = f.send(f.A, { conversationId: dm, membershipEpoch: f.member(f.A, dm).membershipEpoch, replyToMessageId: parent.messageId })
  assert.equal(continuation.causality.rootMessageId, root)
  assert.equal(continuation.dispatchSuppressed, 'CAUSAL_LIMIT')
  const fresh = f.send(f.A, { conversationId: dm, membershipEpoch: f.member(f.A, dm).membershipEpoch })
  assert.deepEqual(fresh.causality, { rootMessageId: fresh.messageId, parentMessageId: null, depth: 0 })
  assert.equal(fresh.dispatchSuppressed, undefined);assert.deepEqual(f.ai(fresh), [f.B])
})

test('causal grants require stored AI delivery, exact author, current epoch and conversation; root/depth cannot be supplied', t => {
  const f = fixture(t)
  const human = f.send(f.H, { mentions: [{ principalId: f.A }] }), grant = f.grant(human, f.A, false)
  assert.throws(() => f.send(f.A, { causationDeliveryId: grant, mentions: [{ principalId: f.B }] }), { code: 'INVALID_CAUSATION_GRANT' })
  f.grant(human, f.A)
  assert.throws(() => f.send(f.B, { causationDeliveryId: grant, mentions: [{ principalId: f.A }] }), { code: 'INVALID_CAUSATION_GRANT' })
  assert.throws(() => f.send(f.H, { causationDeliveryId: grant }), { code: 'INVALID_CAUSATION_GRANT' })
  const dm = f.store.createDm(f.a, f.op({ principalId: f.A, otherPrincipalId: f.B })).conversationId
  assert.throws(() => f.send(f.A, { conversationId: dm, membershipEpoch: f.member(f.A, dm).membershipEpoch, causationDeliveryId: grant }), { code: 'INVALID_CAUSATION_GRANT' })
  assert.throws(() => f.send(f.A, { causationDeliveryId: grant, responseToDeliveryId: randomUUID() }), { code: 'INVALID_CAUSATION_GRANT' })
  for (const fields of [{ causality: { depth: 0 } }, { rootMessageId: human.messageId }, { parentMessageId: null }, { depth: 0 }, { dispatchSuppressed: null }]) {
    assert.throws(() => f.send(f.A, fields), { code: 'INVALID_CAUSALITY' })
  }
  const input = f.input(f.A, { causationDeliveryId: grant, mentions: [{ principalId: f.B }] })
  const accepted = f.store.publish(f.a, input)
  assert.throws(() => f.store.publish(f.a, { ...input, causationDeliveryId: randomUUID() }), { code: 'MESSAGE_ID_CONFLICT' })
  f.store.remove(f.a, f.op({ principalId: f.H, conversationId: f.group, membershipEpoch: f.member(f.H).membershipEpoch, targetPrincipalId: f.A }))
  f.join(f.A); f.policy(f.A, 'active')
  assert.throws(() => f.send(f.A, { causationDeliveryId: grant }), { code: 'INVALID_CAUSATION_GRANT' })
  assert.deepEqual(f.store.publish(f.a, input), accepted)
})

test('budget and ancestry roll back with failed publish, and additive migration retains original message hashes', t => {
  const f = fixture(t, {}, true)
  const human = f.send(f.H, { mentions: [{ principalId: f.A }] }), grant = f.grant(human, f.A)
  const input = f.input(f.A, { causationDeliveryId: grant, mentions: [{ principalId: f.B }] })
  f.store.beforeCommit = () => { throw new Error('synthetic commit failure') }
  assert.throws(() => f.store.publish(f.a, input), /synthetic commit failure/)
  assert.equal(f.store.db.prepare('SELECT count(*) n FROM message_causality').get().n, 1)
  assert.equal(f.store.db.prepare('SELECT sum(ai_deliveries) n FROM causal_roots').get().n, 1)
  f.store.beforeCommit = undefined
  const accepted = f.store.publish(f.a, input), digest = accepted.payloadHash
  f.store.db.exec('DROP TABLE message_causality; DROP TABLE causal_roots; DELETE FROM causal_schema;')
  f.store.close(); f.store = new HubStore(f.path)
  assert.deepEqual(f.store.publish(f.a, input), accepted)
  assert.equal(f.store.db.prepare('SELECT hash FROM messages WHERE id=?').get(input.messageId).hash, digest)
  assert.equal(f.store.db.prepare('SELECT sum(ai_deliveries) n FROM causal_roots').get().n, 2)
})

test('pre-causality journals retain original ACKs and hashes while historical AI deliveries spend the migrated root budget', t => {
  const f = fixture(t, { maxAiDeliveriesPerRoot: 2 }, true)
  const human = f.send(f.H, { mentions: [{ principalId: f.A }] }), grant = f.grant(human, f.A)
  const input = f.input(f.A, { responseToDeliveryId: grant, replyToMessageId: human.messageId, mentions: [{ principalId: f.B }] })
  f.store.publish(f.a, input)
  for (const row of f.store.db.prepare("SELECT id,body FROM events WHERE type='message'").all()) {
    const body = JSON.parse(row.body); delete body.causality; delete body.dispatchSuppressed
    f.store.db.prepare('UPDATE events SET body=? WHERE id=?').run(JSON.stringify(body), row.id)
  }
  const originalAck = f.store.accepted(f.store.db.prepare('SELECT * FROM messages WHERE id=?').get(input.messageId))
  const originalHash = originalAck.payloadHash
  f.store.db.exec('DROP TABLE message_causality; DROP TABLE causal_roots; DELETE FROM causal_schema;')
  f.store.close(); f.store = new HubStore(f.path, { limits: f.limits })
  assert.deepEqual(f.store.publish(f.a, input), originalAck)
  assert.equal(originalAck.payloadHash, originalHash)
  const next = f.send(f.B, { causationDeliveryId: f.grant(originalAck, f.B), mentions: [{ principalId: f.A }] })
  assert.equal(next.causality.rootMessageId, human.messageId)
  assert.equal(next.dispatchSuppressed, 'CAUSAL_LIMIT')
  assert.deepEqual(f.ai(next), [])
})

test('display mentions, all-Bot restatement and quotes never activate without structured intent', t => {
  const f = fixture(t)
  const human = f.send(f.H, { mentions: [{ principalId: f.A }] }), grant = f.grant(human, f.A)
  for (const text of ['@B done', '@all finished', '> @B quoted', 'Summary @A @B']) {
    const result = f.send(f.A, { causationDeliveryId: grant, content: { format: 'markdown', text }, mentions: [{ principalId: f.B }], activationTargets: [] })
    assert.deepEqual(f.ai(result), [])
    assert.equal(result.dispatchSuppressed, undefined)
  }
  const delegated = f.send(f.A, { causationDeliveryId: grant, mentions: [], activationTargets: [{ principalId: f.B }] })
  assert.deepEqual(f.ai(delegated), [f.B], 'structured targeting does not depend on visible @ text')
})

test('same-input duplicate handoffs survive restart; a fresh result permits A to B to A', t => {
  const f = fixture(t, {}, true)
  const human = f.send(f.H, { mentions: [{ principalId: f.A }] }), grant = f.grant(human, f.A)
  const first = f.send(f.A, { causationDeliveryId: grant, activationTargets: [{ principalId: f.B }] })
  const duplicate = f.input(f.A, { causationDeliveryId: grant, activationTargets: [{ principalId: f.B }] })
  assert.equal(f.store.publish(f.a, duplicate).dispatchSuppressed, 'DUPLICATE_HANDOFF')
  f.store.close(); f.store = new HubStore(f.path)
  const retry = f.store.publish(f.a, duplicate)
  assert.equal(retry.dispatchSuppressed, 'DUPLICATE_HANDOFF'); assert.deepEqual(f.ai(retry), [])
  const result = f.send(f.B, { responseToDeliveryId: f.grant(first, f.B), replyToMessageId: first.messageId, activationTargets: [{ principalId: f.A }] })
  assert.deepEqual(f.ai(result), [f.A])
  const continuation = f.send(f.A, { responseToDeliveryId: f.grant(result, f.A), replyToMessageId: result.messageId, activationTargets: [{ principalId: f.B }] })
  assert.deepEqual(f.ai(continuation), [f.B])
})

test('legacy peers and legacy new Bot intents fail explicitly; structured targets cannot forge humans or outsiders', t => {
  const f = fixture(t)
  assert.throws(() => f.store.connect('legacy', 'Legacy', CAPABILITIES.filter(value => value !== 'explicit-bot-activation')), { code: 'EXPLICIT_ACTIVATION_REQUIRED' })
  const legacy = f.input(f.A); delete legacy.activationTargets
  assert.throws(() => f.store.publish(f.a, legacy), { code: 'EXPLICIT_ACTIVATION_REQUIRED' })
  assert.throws(() => f.send(f.A, { activationTargets: [{ principalId: f.H }] }), { code: 'UNKNOWN_ACTIVATION_TARGET' })
  assert.throws(() => f.send(f.A, { activationTargets: [{ principalId: 'bot:other:outsider' }] }), { code: 'UNKNOWN_ACTIVATION_TARGET' })
  assert.throws(() => f.send(f.H, { activationTargets: [{ principalId: f.B }] }), { code: 'EXPLICIT_ACTIVATION_REQUIRED' })
  assert.throws(() => f.send(f.A, { activationTargets: [{ principalId: f.B }], content: { format: 'text', text: '  ' } }), { code: 'EMPTY_HANDOFF' })
})

test('distinct authorized input branches still enforce the aggregate root budget', t => {
  const f = fixture(t, { maxAiDeliveriesPerRoot: 3 })
  const human = f.send(f.H, { mentions: [{ principalId: f.A }] })
  const first = f.send(f.A, { causationDeliveryId: f.grant(human, f.A), activationTargets: [f.B,f.C].map(principalId => ({principalId})) })
  assert.deepEqual(f.ai(first), [f.B,f.C].sort())
  const next = f.send(f.B, { causationDeliveryId: f.grant(first, f.B), activationTargets: [{principalId:f.A}] })
  assert.equal(next.dispatchSuppressed, 'CAUSAL_LIMIT'); assert.deepEqual(f.ai(next), [])
})


test('accepted legacy history retry returns its original ACK without recalculating any delivery', t=>{
  const f=fixture(t,{},true)
  const modern=f.input(f.A), accepted=f.store.publish(f.a,modern)
  const legacy={...modern};delete legacy.activationTargets
  const digest=hash(legacy)
  f.store.db.prepare('UPDATE messages SET hash=?,body=? WHERE id=?').run(digest,JSON.stringify(legacy),legacy.messageId)
  const event=JSON.parse(f.store.db.prepare('SELECT body FROM events WHERE id=?').get(legacy.messageId).body)
  event.message=legacy;event.payloadHash=digest
  f.store.db.prepare('UPDATE events SET body=? WHERE id=?').run(JSON.stringify(event),legacy.messageId)
  const before=f.store.db.prepare('SELECT count(*) n FROM deliveries').get().n
  f.store.db.exec('PRAGMA user_version=2; DELETE FROM schema_version WHERE version=3; DROP TABLE bot_dispatches')
  f.store.close();f.store=new HubStore(f.path)
  assert.equal(f.store.db.prepare('PRAGMA user_version').get().user_version,6)
  const retry=f.store.publish(f.a,legacy)
  assert.equal(retry.messageId,accepted.messageId);assert.equal(retry.payloadHash,digest)
  assert.equal(f.store.db.prepare('SELECT count(*) n FROM deliveries').get().n,before)
})

test('explicit targets respect receiving policy changes before actual publication', t=>{
  const f=fixture(t)
  const input=f.input(f.A,{activationTargets:[{principalId:f.B}]})
  f.store.syncPublication(f.b,{principalIds:[]})
  assert.throws(()=>f.store.publish(f.a,input),{code:'BOT_RETIRED'})
  assert.equal(f.store.db.prepare('SELECT 1 FROM messages WHERE id=?').get(input.messageId),undefined)
})


test('supplements preserve one activation, require the original author, and gate stale finals on actual read-in', t => {
  const f=fixture(t)
  const task=f.send(f.A,{activationTargets:[{principalId:f.B}]}), grant=f.grant(task,f.B)
  const update=f.input(f.A,{replyToMessageId:task.messageId,updateForMessageId:task.messageId,updateRecipientPrincipalId:f.B})
  const accepted=f.store.publish(f.a,update)
  assert.deepEqual(f.ai(accepted),[])
  assert.equal(f.store.publish(f.a,update).messageId,accepted.messageId)
  assert.throws(()=>f.send(f.C,{replyToMessageId:task.messageId,updateForMessageId:task.messageId,updateRecipientPrincipalId:f.B}),{code:'INVALID_INPUT_UPDATE'})
  const final={responseToDeliveryId:grant,replyToMessageId:task.messageId}
  assert.throws(()=>f.send(f.B,final),{code:'INPUT_UPDATES_PENDING'})
  const row=f.store.db.prepare('SELECT * FROM deliveries WHERE message_id=? AND recipient_id=?').get(accepted.messageId,f.B)
  const receipt={deliveryId:row.id,principalId:f.B,membershipEpoch:row.membership_epoch}
  f.store.receipt(f.b,{...receipt,status:'targetStored'})
  assert.throws(()=>f.send(f.B,{...final,inputUpdateIds:[accepted.messageId]}),{code:'INPUT_UPDATES_PENDING'})
  f.store.receipt(f.b,{...receipt,status:'updateRead'});f.store.receipt(f.b,{...receipt,status:'updateRead'})
  assert.equal(f.store.db.prepare("SELECT count(*) n FROM events WHERE type='bot.input.read'").get().n,1)
  assert.throws(()=>f.send(f.B,final),{code:'INPUT_UPDATES_PENDING'})
  f.send(f.B,{...final,inputUpdateIds:[accepted.messageId]})
  assert.throws(()=>f.store.publish(f.a,{...update,messageId:randomUUID()}),{code:'HANDOFF_ALREADY_COMPLETED'})
})

test('distinct verified local user intents start fresh Bot DM roots while same-intent retries share duplicate suppression', t => {
  const f = fixture(t, {}, true)
  const remoteHuman = f.store.register(f.b, { localId: 'owner', kind: 'human', displayName: 'B owner' }).principalId
  const dm = f.store.createDm(f.a, f.op({ principalId: f.A, otherPrincipalId: f.B })).conversationId
  const send = (id, intent, extra = {}) => f.send(id, { conversationId: dm, membershipEpoch: f.member(id, dm).membershipEpoch,
    localUserIntent: intent, ...extra })
  const first = send(f.A, { principalId: f.H, intentId: 'user-input-a-1' })
  assert.deepEqual(f.ai(first), [f.B])
  const reply = send(f.B, undefined, { responseToDeliveryId: f.grant(first, f.B), replyToMessageId: first.messageId })
  assert.deepEqual(f.ai(reply), [f.A])
  const reverseIntent = { principalId: remoteHuman, intentId: 'user-input-b-1' }
  const reverse = send(f.B, reverseIntent)
  assert.deepEqual(f.ai(reverse), [f.A])
  assert.notEqual(reverse.causality.rootMessageId, first.causality.rootMessageId)
  assert.equal(reverse.causality.parentMessageId, null)
  assert.equal(reverse.causality.depth, 0)
  const duplicate = send(f.B, reverseIntent)
  assert.equal(duplicate.dispatchSuppressed, 'DUPLICATE_HANDOFF')
  assert.deepEqual(f.ai(duplicate), [])
  f.store.close(); f.store = new HubStore(f.path)
  const restarted = send(f.B, reverseIntent)
  assert.equal(restarted.dispatchSuppressed, 'DUPLICATE_HANDOFF')
  const fresh = send(f.B, { ...reverseIntent, intentId: 'user-input-b-2' })
  assert.deepEqual(f.ai(fresh), [f.A])
  const retry = f.input(f.B, { conversationId: dm, membershipEpoch: f.member(f.B, dm).membershipEpoch, localUserIntent: { ...reverseIntent, intentId: 'user-input-b-3' } })
  const accepted = f.store.publish(f.b, retry)
  assert.deepEqual(f.store.publish(f.b, retry), accepted)
  assert.throws(() => f.store.publish(f.b, { ...retry, localUserIntent: { ...reverseIntent, intentId: 'changed' } }), { code: 'MESSAGE_ID_CONFLICT' })
})

test('a local-user root cannot borrow another device, a Bot identity or a remote delivery grant', t => {
  const f = fixture(t)
  const human = f.send(f.H, { mentions: [{ principalId: f.A }] }), grant = f.grant(human, f.A)
  assert.throws(() => f.send(f.B, { localUserIntent: { principalId: f.H, intentId: 'wrong-device' } }), { code: 'AUTHOR_MISMATCH' })
  assert.throws(() => f.send(f.A, { localUserIntent: { principalId: f.A, intentId: 'bot-not-human' } }), { code: 'INVALID_CAUSATION_GRANT' })
  assert.throws(() => f.send(f.A, { localUserIntent: { principalId: f.H, intentId: 'mixed' }, causationDeliveryId: grant }), { code: 'INVALID_CAUSATION_GRANT' })
  assert.throws(() => f.send(f.H, { localUserIntent: { principalId: f.H, intentId: 'human-is-already-a-root' } }), { code: 'INVALID_CAUSATION_GRANT' })
})


test('new active group tasks do not reuse an old Human input or an earlier outbound handoff key',t=>{
 const f=fixture(t,{},true),human=f.send(f.H,{mentions:[{principalId:f.A}]})
 const old=f.send(f.A,{causationDeliveryId:f.grant(human,f.A),activationTargets:[{principalId:f.B}]})
 const inputs=[f.input(f.A,{activationTargets:[{principalId:f.B}]}),f.input(f.A,{activationTargets:[{principalId:f.B}]})]
 const messages=inputs.map(input=>f.store.publish(f.a,input))
 for(const result of messages){assert.deepEqual(f.ai(result),[f.B]);assert.equal(result.dispatchSuppressed,undefined);assert.deepEqual(result.causality,{rootMessageId:result.messageId,parentMessageId:null,depth:0})}
 assert.notEqual(messages[0].causality.rootMessageId,messages[1].causality.rootMessageId)
 const reply=f.send(f.A,{replyToMessageId:human.messageId,activationTargets:[{principalId:f.B}]})
 assert.equal(reply.dispatchSuppressed,'DUPLICATE_HANDOFF','an actual reply to the same input retains deduplication')
 const deliveries=f.store.db.prepare('SELECT count(*) n FROM deliveries').get().n
 f.store.close();f.store=new HubStore(f.path)
 assert.deepEqual(f.store.publish(f.a,inputs[1]),messages[1])
 assert.equal(f.store.db.prepare('SELECT count(*) n FROM deliveries').get().n,deliveries)
 assert.equal(f.store.accepted(f.store.db.prepare('SELECT * FROM messages WHERE id=?').get(old.messageId)).causality.rootMessageId,human.messageId)
})

test('long Bot-only DMs have independent proactive tasks beyond 32 deliveries while per-input duplicate handoffs remain bounded',t=>{
 const f=fixture(t),dm=f.store.createDm(f.a,f.op({principalId:f.A,otherPrincipalId:f.B})).conversationId
 f.store.db.prepare('INSERT INTO causal_roots(id,conversation_id,ai_deliveries) VALUES (?,?,?)').run(`genesis:${dm}`,dm,32)
 const sent=[]
 for(let index=0;index<40;index++){
  const actor=index%2?f.B:f.A,target=actor===f.A?f.B:f.A
  const result=f.send(actor,{conversationId:dm,membershipEpoch:f.member(actor,dm).membershipEpoch})
  assert.deepEqual(f.ai(result),[target]);assert.equal(result.dispatchSuppressed,undefined)
  assert.deepEqual(result.causality,{rootMessageId:result.messageId,parentMessageId:null,depth:0});sent.push(result)
 }
 assert.equal(new Set(sent.map(result=>result.causality.rootMessageId)).size,40)
 assert.equal(f.store.db.prepare('SELECT ai_deliveries FROM causal_roots WHERE id=?').get(`genesis:${dm}`).ai_deliveries,32)
 const parent=sent.at(-1),grant=f.grant(parent,f.A)
 const result=f.send(f.A,{conversationId:dm,membershipEpoch:f.member(f.A,dm).membershipEpoch,causationDeliveryId:grant})
 assert.deepEqual(f.ai(result),[f.B]);assert.equal(result.causality.depth,1)
 const duplicate=f.send(f.A,{conversationId:dm,membershipEpoch:f.member(f.A,dm).membershipEpoch,causationDeliveryId:grant})
 assert.equal(duplicate.dispatchSuppressed,'DUPLICATE_HANDOFF');assert.deepEqual(f.ai(duplicate),[])
 assert.equal(duplicate.causality.rootMessageId,parent.causality.rootMessageId)
})
