import assert from 'node:assert/strict'
import { test } from 'node:test'
import { generateKeyPairSync, randomUUID, sign } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import WebSocket from 'ws'
import { startHub } from '../src/server.js'
import { enrollmentTranscript } from '../src/management-store.js'
import { PROTOCOL } from '../src/protocol.js'
import { CommunicationQueue } from '../../ds-bot/src/host/federation/queue-store.js'
import { CommunicationTransport } from '../../ds-bot/src/host/federation/transport.js'

const op = input => ({ operationId: randomUUID(), ...input })
const signature = (pair, challenge) => sign(null, Buffer.from(enrollmentTranscript(challenge)), pair.privateKey).toString('base64url')
const message = (peer, conversationId, membershipEpoch, text) => ({ protocol: PROTOCOL, type: 'message.publish', messageId: randomUUID(), conversationId,
  author: { principalId: peer.human, homeInstanceId: peer.instanceId, kind: 'human' }, membershipEpoch,
  clientCreatedAt: new Date().toISOString(), content: { format: 'text', text }, mentions: [], replyToMessageId: null })

async function pendingSocket(url) {
  const socket = new WebSocket(url)
  await new Promise((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject) })
  return { close: () => socket.terminate(), request: (type, payload) => new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Synthetic enrollment response timeout')), 3000)
    socket.once('message', raw => {
      clearTimeout(timer)
      const result = JSON.parse(raw.toString())
      if (result.ok) resolve(result.value)
      else reject(Object.assign(new Error(result.error.code), { code: result.error.code }))
    })
    socket.send(JSON.stringify({ protocol: PROTOCOL, id: randomUUID(), type, payload }))
  }) }
}

async function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'dsbot-contact-recovery-')), peers = []
  let hub, fault
  const start = async () => { hub = await startHub({ databasePath: join(root, 'hub.sqlite'), port: 0, peers: [],
    management: { enabled: true, password: 'synthetic-contact-recovery-administrator' },
    beforeResponse: ({ type, value, socket }) => {
      if (fault?.type !== type) return
      const current = fault; fault = undefined; current.committed = value
      if (current.mode === 'close') socket.terminate()
      return false
    } }) }
  const connect = async peer => {
    peer.queue = new CommunicationQueue(join(root, peer.instanceId + '.sqlite'), { instanceId: peer.instanceId })
    const human = peer.queue.localPrincipal('human', 'owner', peer.name, 'local-user')
    const bot = peer.queue.localPrincipal('bot', 'main', 'Same Bot name', 'main-bot')
    peer.human = human.principalId; peer.bot = bot.principalId
    peer.transport = new CommunicationTransport(peer.queue, { url: hub.url, requestTimeout: 3000,
      credential: { socketFactory: () => new WebSocket(hub.url), authenticate: async (request, capabilities) => {
        const challenge = await request('enrollment.challenge', { purpose: 'login', instanceId: peer.instanceId })
        return request('enrollment.prove', { challengeId: challenge.challengeId, signature: signature(peer.pair, challenge), capabilities })
      } } })
    await peer.transport.connect()
    for (const principal of [human, bot]) await peer.transport.request('principal.register', { localId: principal.localId, kind: principal.kind, displayName: principal.displayName })
    peer.request = (type, payload = {}) => peer.transport.request(type, payload)
    peer.code = (await peer.request('contact.code', { principalId: peer.human })).userCode
  }
  const disconnect = async () => {
    for (const peer of peers) { peer.transport?.stop(); peer.queue?.close(); peer.transport = undefined; peer.queue = undefined }
    await hub?.close(); hub = undefined
  }
  t.after(async () => { await disconnect(); rmSync(root, { recursive: true, force: true }) })
  await start()
  for (const name of ['Same Human name', 'Same Human name']) {
    const pair = generateKeyPairSync('ed25519'), socket = await pendingSocket(hub.url)
    try {
      const challenge = await socket.request('enrollment.challenge', { purpose: 'join', publicKey: pair.publicKey.export({ type: 'spki', format: 'pem' }) })
      const pending = await socket.request('enrollment.prove', { challengeId: challenge.challengeId, signature: signature(pair, challenge), displayName: name })
      const approved = hub.management.decide({ requestId: pending.requestId, expectedVersion: 1, action: 'approve' })
      const peer = { name, pair, instanceId: approved.instanceId }; peers.push(peer); await connect(peer)
    } finally { socket.close() }
  }
  return { peers, get hub() { return hub },
    arm(type, mode) { const value = { type, mode }; fault = value; return value },
    async restart() { await disconnect(); await start(); for (const peer of peers) await connect(peer) } }
}

const rows = (f, table) => f.hub.store.db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()
const durable = f => Object.fromEntries(['hub_contacts', 'hub_contact_requests', 'hub_management_operations', 'conversations', 'memberships', 'events', 'messages', 'deliveries'].map(table => [table, rows(f, table)]))
const identity = f => ({ instances: f.hub.store.db.prepare('SELECT id,trusted,pairing_revision FROM instances ORDER BY id').all(),
  principals: f.hub.store.db.prepare('SELECT * FROM principals ORDER BY id').all(),
  local: f.peers.map(peer => ({ instanceId: peer.queue.instanceId, principals: peer.queue.db.prepare('SELECT * FROM local_principals ORDER BY kind,local_ref').all() })) })
const scope = (peer, conversationId, principalId = peer.human) => peer.request('conversation.authorize', { principalId, conversationId })
const requestContact = (from, to) => from.request('contact.request', op({ principalId: from.human, userCode: to.code, botPrincipalIds: [from.bot] }))
const acceptContact = (from, requestId) => from.request('contact.accept', op({ principalId: from.human, requestId, expectedVersion: 1, botPrincipalIds: [from.bot] }))
const relation = async peer => (await peer.request('contact.relations', { principalId: peer.human }))[0]
const revoke = async (from, to) => from.request('contact.revoke', op({ principalId: from.human, otherHumanPrincipalId: to.human, expectedVersion: (await relation(from)).version }))

for (const phase of ['request', 'accept', 'revoke']) for (const mode of ['close', 'timeout']) {
  test(`committed contact.${phase} ${mode} response loss is replay-safe across three Hub and queue restarts`, async t => {
    const f = await fixture(t), [a, b] = f.peers
    await acceptContact(b, (await requestContact(a, b)).requestId)
    const { conversationId: group } = await a.request('group.create', op({ principalId: a.human, title: 'Independent shared group' }))
    for (const principalId of [b.human, b.bot]) {
      const own = await scope(a, group)
      const invited = await a.request('group.invite', op({ principalId: a.human, conversationId: group, membershipEpoch: own.membershipEpoch, inviteePrincipalId: principalId }))
      await b.request('group.accept', op({ principalId, inviteId: invited.inviteId }))
    }
    const { conversationId: dm } = await a.request('dm.open', op({ principalId: a.human, otherPrincipalId: b.bot }))
    const oldScope = (await scope(a, dm)).membershipEpoch
    const acceptedMessage = message(a, dm, oldScope, 'Synthetic pending AI delivery')
    const originalAck = await a.request('message.publish', acceptedMessage)
    await Promise.all(f.peers.map(peer => peer.transport.pump()))
    assert.equal(b.queue.pendingAi().length, 1)
    const queued = message(a, dm, oldScope, 'Old consent intent must never publish')
    a.queue.enqueueMessage(queued)
    const identities = identity(f), groupMembers = rows(f, 'memberships').filter(row => row.conversation_id === group)

    let input, actor, type = `contact.${phase}`
    if (phase !== 'revoke') await revoke(a, b)
    if (phase === 'request') { actor = a; input = op({ principalId: a.human, userCode: b.code, botPrincipalIds: [a.bot] }) }
    if (phase === 'accept') { actor = b; input = op({ principalId: b.human, requestId: (await requestContact(a, b)).requestId, expectedVersion: 1, botPrincipalIds: [b.bot] }) }
    if (phase === 'revoke') { actor = a; input = op({ principalId: a.human, otherHumanPrincipalId: b.human, expectedVersion: 1 }) }
    const lost = f.arm(type, mode)
    await assert.rejects(actor.request(type, input), { code: mode === 'close' ? 'CONNECTION_LOST' : 'REQUEST_TIMEOUT' })
    assert.ok(lost.committed, 'fault runs after the operation transaction committed')
    assert.equal(actor.transport.connected, mode === 'timeout', 'timeout fault leaves the connection open')
    const committed = durable(f)
    for (let restart = 0; restart < 2; restart++) {
      await f.restart()
      for (let retry = 0; retry < 3; retry++) assert.deepEqual(await actor.request(type, input), lost.committed)
      assert.deepEqual(durable(f), committed, 'exact operation replay adds no event, epoch, relationship version, request, message or delivery')
      assert.deepEqual(identity(f), identities, 'new connection epochs do not replace enrolled or local identities')
      assert.deepEqual(rows(f, 'memberships').filter(row => row.conversation_id === group), groupMembers)
    }
    await assert.rejects(actor.request(type, { ...input, ...(phase === 'request' ? { botPrincipalIds: [] } : { expectedVersion: 999 }) }), { code: 'OPERATION_ID_CONFLICT' })

    // Advance consent after recovering the old ACK, then replay that ACK again.
    if (phase === 'request') await acceptContact(b, input.operationId)
    if (phase !== 'revoke') await revoke(a, b)
    const newRequest = await requestContact(a, b)
    await acceptContact(b, newRequest.requestId)
    const advanced = durable(f), currentRelation = await relation(a)
    assert.equal(currentRelation.active, true)
    assert.equal(currentRelation.version, phase === 'revoke' ? 3 : 5)
    assert.deepEqual(await actor.request(type, input), lost.committed)
    assert.deepEqual(durable(f), advanced, 'old request/accept/revoke ACK cannot resurrect or revoke later consent')
    assert.deepEqual(await a.request('message.publish', acceptedMessage), originalAck, 'a committed message returns its original ACK after consent changes')
    await assert.rejects(a.request('message.publish', queued), { code: 'MEMBERSHIP_REVOKED' })
    await Promise.all(f.peers.map(peer => peer.transport.pump()))
    assert.deepEqual(a.queue.outboxStatus(queued.messageId), { id: queued.messageId, state: 'failed', result: null, error: 'MEMBERSHIP_REVOKED' })
    assert.equal(f.hub.store.db.prepare('SELECT count(*) n FROM messages WHERE id=?').get(queued.messageId).n, 0)
    assert.equal(b.queue.pendingAi().some(item => item.messageId === acceptedMessage.messageId), false)
    const oldDelivery = rows(f, 'deliveries').find(row => row.message_id === acceptedMessage.messageId && row.recipient_id === b.bot)
    assert.equal(oldDelivery.revoked, 1); assert.equal(oldDelivery.ai_accepted, 0)
    for (const status of ['aiAccepted', 'aiStarted']) await assert.rejects(b.request('delivery.receipt', { deliveryId: oldDelivery.id, principalId: b.bot, membershipEpoch: oldDelivery.membership_epoch, status }), { code: 'MEMBERSHIP_REVOKED' })
    await f.restart()
    await Promise.all(f.peers.map(peer => peer.transport.pump()))
    assert.equal(a.queue.outboxStatus(queued.messageId).state, 'failed', 'terminal queue rejection survives another complete reopen')
    assert.equal(a.queue.outboxStatus(queued.messageId).error, 'MEMBERSHIP_REVOKED')
    assert.equal(f.hub.store.db.prepare('SELECT count(*) n FROM messages WHERE id=?').get(queued.messageId).n, 0)
    assert.deepEqual(identity(f), identities)
    assert.deepEqual(rows(f, 'memberships').filter(row => row.conversation_id === group), groupMembers)
    for (const peer of f.peers) {
      assert.equal(peer.transport.connected, true); assert.equal(peer.queue.authorized, true)
      const localGroup = peer.queue.memberships().filter(row => row.conversationId === group)
      assert.ok(localGroup.length > 0)
      for (const member of localGroup) assert.equal(member.membershipEpoch, groupMembers.find(row => row.principal_id === member.principalId).epoch)
    }
    const valid = message(a, group, (await scope(a, group)).membershipEpoch, 'Independent group still sends')
    await a.request('message.publish', valid)
    await b.transport.pump()
    assert.ok(b.queue.view(group, b.human, groupMembers.find(row => row.principal_id === b.human).epoch).some(event => event.message?.messageId === valid.messageId))
    const events = rows(f, 'events').filter(row => row.conversation_id === dm)
    assert.deepEqual(events.map(row => row.seq), events.map((_, index) => index + 1), 'canonical history stays contiguous and ordered')
    assert.equal(events.filter(row => row.id === acceptedMessage.messageId).length, 1)
    assert.equal(events.filter(row => row.type === 'conversation.contactChanged').length, phase === 'revoke' ? 1 : 2)
  })
}
