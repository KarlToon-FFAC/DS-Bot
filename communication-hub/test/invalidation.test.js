import assert from 'node:assert/strict'
import { test } from 'node:test'
import { generateKeyPairSync, randomUUID, sign } from 'node:crypto'
import { once } from 'node:events'
import { WebSocket } from 'ws'
import { startHub } from '../src/server.js'
import { enrollmentTranscript } from '../src/management-store.js'
import { PROTOCOL, CAPABILITIES } from '../src/protocol.js'
import { CommunicationQueue } from '../../ds-bot/src/host/federation/queue-store.js'
import { CommunicationTransport } from '../../ds-bot/src/host/federation/transport.js'

const wait = ms => new Promise(resolve => setTimeout(resolve, ms))
const until = async predicate => { for (let n = 0; n < 200; n++) { if (predicate()) return; await wait(10) } assert.fail('Timed out waiting for state') }
const peers = ['a', 'b', 'old'].map(instanceId => ({ instanceId, credential: `synthetic-${instanceId}-credential-`.padEnd(48, 'x') }))
const make = (hub, id, options = {}) => {
  const queue = new CommunicationQueue(':memory:', { instanceId: id })
  const client = new CommunicationTransport(queue, { url: hub.url, credential: peers.find(peer => peer.instanceId === id).credential, ...options })
  return { client, queue, close() { client.stop(); queue.close() } }
}

test('authenticated optional hints wake reconciliation without waiting for the fallback poll', async () => {
  const hub = await startHub({ databasePath: ':memory:', peers, port: 0 })
  let directory = [], reconciled = 0
  const a = make(hub, 'a', { onChange: async () => { directory = await a.client.request('contacts.list'); reconciled++ } })
  const b = make(hub, 'b')
  try {
    a.client.start({ pollMs: 60000 })
    await until(() => reconciled > 0)
    await b.client.connect()
    const registered = await b.client.request('principal.register', { kind: 'human', localId: 'person', displayName: 'Original synthetic name' })
    await pair(a, b, registered.principalId)
    await until(() => directory.some(item => item.principalId === registered.principalId))
    await b.client.request('principal.register', { kind: 'human', localId: 'person', displayName: 'Changed synthetic name' })
    await until(() => directory.some(item => item.displayName === 'Changed synthetic name'))
    assert.equal(a.client.connected, true)
    assert.ok(a.client.hints >= 1)
    assert.equal(a.client.reconnects, 1)
  } finally { a.close(); b.close(); await hub.close() }
})

test('old and unauthenticated clients receive no unsolicited events; opted-in events contain no data', async () => {
  const hub = await startHub({ databasePath: ':memory:', peers, port: 0 })
  const legacy = new WebSocket(hub.url), unauthenticated = new WebSocket(hub.url), frames = [], unauthenticatedFrames = []
  const a = make(hub, 'a')
  try {
    await Promise.all([once(legacy, 'open'), once(unauthenticated, 'open')])
    legacy.on('message', data => frames.push(JSON.parse(String(data))))
    unauthenticated.on('message', data => unauthenticatedFrames.push(JSON.parse(String(data))))
    legacy.send(JSON.stringify({ protocol: PROTOCOL, id: 'legacy-hello', type: 'hello', payload: { instanceId: 'old', credential: peers[2].credential, capabilities: [...CAPABILITIES, 'bounded-bot-collaboration'] } }))
    await until(() => frames.length === 1)
    await a.client.connect()
    const hints = []
    a.client.socket.addEventListener('message', event => { const frame = JSON.parse(event.data); if (frame.type) hints.push(frame) })
    await a.client.request('principal.register', { kind: 'human', localId: 'private', displayName: 'Unrelated private name' })
    await until(() => hints.length > 0)
    assert.deepEqual(hints, [{ protocol: PROTOCOL, type: 'state.invalidate', scope: 'directory' }])
    assert.deepEqual(unauthenticatedFrames, [])
    assert.equal(frames.length, 1)
  } finally { legacy.close(); unauthenticated.close(); a.close(); await hub.close() }
})

test('missed hints are compensated by polling and reconnect always pulls a fresh authorized snapshot', async () => {
  const hub = await startHub({ databasePath: ':memory:', peers, port: 0 })
  let directory = [], reconciled = 0
  const a = make(hub, 'a', { onChange: async () => { directory = await a.client.request('contacts.list'); reconciled++ } })
  const b = make(hub, 'b')
  try {
    a.client.start({ pollMs: 30 })
    await until(() => reconciled > 0)
    // Ignore every hint, representing a dropped notification without dropping RPC.
    a.client.wake = () => {}
    await b.client.connect()
    const registered = await b.client.request('principal.register', { kind: 'human', localId: 'person', displayName: 'Visible through fallback' })
    await pair(a, b, registered.principalId)
    await until(() => directory.some(item => item.displayName === 'Visible through fallback'))
    a.client.stop()
    await b.client.request('principal.register', { kind: 'human', localId: 'person', displayName: 'Changed while disconnected' })
    a.client.start({ pollMs: 60000 })
    await until(() => directory.some(item => item.displayName === 'Changed while disconnected'))
    assert.equal(a.client.reconnects, 2)
    assert.equal(a.queue.authorized, true)
  } finally { a.close(); b.close(); await hub.close() }
})

async function pair(a, b, target) {
  const human = await a.client.request('principal.register', { kind: 'human', localId: 'person', displayName: 'Requester' })
  const { userCode } = await b.client.request('contact.code', { principalId: target })
  const request = await a.client.request('contact.request', { operationId: randomUUID(), principalId: human.principalId, userCode, botPrincipalIds: [] })
  await b.client.request('contact.accept', { operationId: randomUUID(), principalId: target, requestId: request.requestId, expectedVersion: 1, botPrincipalIds: [] })
}

test('presence reflects the active authenticated epoch and removes a half-open peer after heartbeat expiry', async () => {
  let connectedAtAuthentication
  const hub = await startHub({ databasePath: ':memory:', peers, port: 0, heartbeatMs: 100,
    beforeResponse: ({ type }) => { if (type === 'hello') connectedAtAuthentication = hub.management.instances().find(item => item.instanceId === 'a').connected } })
  const socket = new WebSocket(hub.url, { autoPong: false })
  try {
    await once(socket, 'open')
    const response = once(socket, 'message'), closed = once(socket, 'close')
    socket.send(JSON.stringify({ protocol: PROTOCOL, id: 'half-open', type: 'hello', payload: { instanceId: 'a', credential: peers[0].credential, capabilities: [...CAPABILITIES, 'bounded-bot-collaboration'] } }))
    await response
    assert.equal(connectedAtAuthentication, true)
    await closed
    await until(() => hub.management.instances().find(item => item.instanceId === 'a').connected === false)
    assert.equal(hub.management.instances().find(item => item.instanceId === 'a').trusted, 1)
  } finally { socket.close(); await hub.close() }
})

test('a stale epoch or revoked identity cannot be shown online just because its socket remains open', async () => {
  const hub = await startHub({ databasePath: ':memory:', peers, port: 0 })
  const old = make(hub, 'a'), current = make(hub, 'a')
  try {
    await old.client.connect(); await current.client.connect()
    assert.equal(hub.management.instances().find(item => item.instanceId === 'a').connected, true)
    current.client.stop()
    await until(() => hub.management.instances().find(item => item.instanceId === 'a').connected === false)
    assert.equal(old.client.socket.readyState, 1)
    await assert.rejects(old.client.request('contacts.list'), { code: 'STALE_CONNECTION' })
    assert.equal(old.client.fenced, true)
  } finally { old.close(); current.close(); await hub.close() }
})

test('message activity wakes the durable pump without invalidating contact-management state', async () => {
  const hub = await startHub({ databasePath: ':memory:', peers, port: 0 })
  const scopes = [], a = make(hub, 'a', { onInvalidate: scope => scopes.push(scope) })
  try {
    await a.client.connect()
    const human = await a.client.request('principal.register', { kind: 'human', localId: 'person', displayName: 'Synthetic' })
    const { conversationId } = await a.client.request('group.create', { operationId: randomUUID(), principalId: human.principalId, title: 'Synthetic group' })
    const { membershipEpoch } = await a.client.request('conversation.authorize', { conversationId, principalId: human.principalId })
    await until(() => scopes.includes('directory'))
    scopes.length = 0
    await a.client.request('message.publish', { protocol: PROTOCOL, type: 'message.publish', messageId: randomUUID(), conversationId,
      author: { principalId: human.principalId, homeInstanceId: 'a', kind: 'human' }, membershipEpoch,
      clientCreatedAt: new Date().toISOString(), content: { format: 'text', text: 'Only a dirty signal leaves this scope' }, mentions: [], replyToMessageId: null })
    await until(() => scopes.length > 0)
    assert.deepEqual(scopes, ['messages'])
  } finally { a.close(); await hub.close() }
})

test('authenticated admin HTTP changes invalidate live WebSocket directory snapshots', async () => {
  const password = 'synthetic-administrator-password'
  const hub = await startHub({ databasePath: ':memory:', peers, port: 0, management: { enabled: true, password } })
  const scopes = [], a = make(hub, 'a', { onInvalidate: scope => scopes.push(scope) })
  try {
    await a.client.connect()
    await until(() => scopes.length > 0)
    scopes.length = 0
    const result = await fetch(new URL('/admin/api/rename', hub.managementUrl), { method: 'POST',
      headers: { authorization: `Bearer ${password}`, 'content-type': 'application/json' },
      body: JSON.stringify({ instanceId: 'a', label: 'Renamed through administrator UI', expectedNameVersion: 0 }) })
    assert.equal(result.status, 200)
    await until(() => scopes.includes('directory'))
    assert.equal(hub.management.instances().find(instance => instance.instanceId === 'a').label, 'Renamed through administrator UI')
  } finally { a.close(); await hub.close() }
})

test('delayed close of an old socket cannot mark its current replacement offline', async () => {
  const hub = await startHub({ databasePath: ':memory:', peers, port: 0 })
  const old = make(hub, 'a'), current = make(hub, 'a')
  try {
    await old.client.connect(); await current.client.connect()
    assert.equal(hub.management.instances().find(item => item.instanceId === 'a').connected, true)
    old.client.stop()
    await wait(80)
    assert.equal(hub.management.instances().find(item => item.instanceId === 'a').connected, true)
    assert.equal(current.client.connected, true)
    await current.client.request('contacts.list')
  } finally { old.close(); current.close(); await hub.close() }
})

test('a new enrollment invalidates management but repeated signed status reads do not', async () => {
  const hub = await startHub({ databasePath: ':memory:', peers, port: 0, management: { enabled: true, password: 'synthetic-admin-status-password' } })
  const scopes = [], a = make(hub, 'a', { onInvalidate: scope => scopes.push(scope) }), socket = new WebSocket(hub.url)
  const pair = generateKeyPairSync('ed25519')
  const rpc = async (type, payload) => {
    const response = once(socket, 'message')
    socket.send(JSON.stringify({ protocol: PROTOCOL, id: randomUUID(), type, payload }))
    const frame = JSON.parse(String((await response)[0]))
    assert.equal(frame.ok, true)
    return frame.value
  }
  const proof = async (purpose, input) => {
    const challenge = await rpc('enrollment.challenge', { purpose, ...input })
    return rpc('enrollment.prove', { challengeId: challenge.challengeId,
      signature: sign(null, Buffer.from(enrollmentTranscript(challenge)), pair.privateKey).toString('base64url'), displayName: 'Synthetic pending device' })
  }
  try {
    await once(socket, 'open'); await a.client.connect()
    await until(() => scopes.length > 0); scopes.length = 0
    const requested = await proof('join', { publicKey: pair.publicKey.export({ type: 'spki', format: 'pem' }) })
    await until(() => scopes.includes('directory')); scopes.length = 0
    for (let n = 0; n < 3; n++) assert.equal((await proof('status', { requestId: requested.requestId })).status, 'pending')
    await wait(100)
    assert.deepEqual(scopes, [])
  } finally { socket.close(); a.close(); await hub.close() }
})
