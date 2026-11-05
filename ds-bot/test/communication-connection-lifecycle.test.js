import assert from 'node:assert/strict'
import { test } from 'node:test'
import { CommunicationTransport, communicationCapabilities } from '../src/host/federation/transport.js'

const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done }); return { promise, resolve } }
const wait = ms => new Promise(resolve => setTimeout(resolve, ms))
const until = async predicate => { for (let i = 0; i < 200; i++) { if (predicate()) return; await wait(5) } assert.fail('Condition timed out') }
class Socket extends EventTarget {
  readyState = 1
  sent = []
  send(data) {
    const frame = JSON.parse(data); this.sent.push(frame)
    if (frame.type === 'hello') queueMicrotask(() => this.reply(frame.id, { protocol: 'dsbot-communication/1', instanceId: 'a', capabilities: communicationCapabilities(), limits: { maxEnvelopeBytes: 100000 } }))
  }
  reply(id, value) { this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ id, ok: true, value }) })) }
  hint() { this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ protocol: 'dsbot-communication/1', type: 'state.invalidate' }) })) }
  close() { if (this.readyState === 3) return; this.readyState = 3; this.dispatchEvent(new Event('close')) }
}
const fixture = options => {
  const socket = new Socket(), queue = { instanceId: 'a', authorized: false, setLimits() {}, disconnected() { this.authorized = false } }
  return { socket, queue, client: new CommunicationTransport(queue, { url: 'ws://127.0.0.1/communication', credential: { socketFactory: async () => socket }, requestTimeout: 200, ...options }) }
}

test('stop during credential loading cannot open a socket or resurrect authentication', async () => {
  const gate = deferred(); let factories = 0
  const { client } = fixture({ credential: () => gate.promise })
  const opened = client.connect()
  client.stop()
  gate.resolve({ socketFactory: async () => { factories++; return new Socket() } })
  await assert.rejects(opened, { code: 'CONNECTION_LOST' })
  assert.equal(factories, 0); assert.equal(client.connected, false); assert.equal(client.state, 'stopped')
})

test('a late socket factory is closed and cannot replace a newer connection', async () => {
  const gate = deferred(), late = new Socket(), current = new Socket()
  const { client } = fixture({ credential: { socketFactory: () => gate.promise } })
  const old = client.connect()
  client.stop()
  client.credential = { socketFactory: async () => current }
  await client.connect()
  gate.resolve(late)
  await assert.rejects(old, { code: 'CONNECTION_LOST' })
  assert.equal(late.readyState, 3); assert.equal(client.socket, current); assert.equal(client.connected, true)
  client.stop()
})

test('stop rejects pending RPC immediately and ignores late replies and hints', async () => {
  const { client, socket } = fixture()
  await client.connect()
  const pending = client.request('contacts.list')
  const id = socket.sent.at(-1).id
  client.stop()
  await assert.rejects(pending, { code: 'CONNECTION_LOST' })
  socket.reply(id, [{ principalId: 'not-accepted' }]); socket.hint()
  assert.equal(client.requests.size, 0); assert.equal(client.hints, 0); assert.equal(client.state, 'stopped')
})

test('an old authentication callback cannot send into the replacement connection', async () => {
  const gate = deferred(), sockets = [new Socket(), new Socket()]; let connects = 0
  const { client } = fixture({ credential: { socketFactory: async () => sockets[connects++] }, onConnect: async () => {
    if (connects === 1) { await gate.promise; await client.request('principal.register', { localId: 'stale' }) }
  } })
  const old = client.connect()
  await until(() => connects === 1 && client.connected)
  client.stop()
  await client.connect()
  gate.resolve()
  await assert.rejects(old, { code: 'CONNECTION_LOST' })
  assert.equal(sockets[1].sent.some(frame => frame.type === 'principal.register'), false)
  assert.equal(client.connected, true)
  client.stop()
})

test('hints coalesce during reconciliation and trigger exactly one follow-up without concurrent pumps', async () => {
  const gate = deferred(); let passes = 0, active = 0, peak = 0
  const { client, socket } = fixture()
  client.synchronize = async () => { passes++; active++; peak = Math.max(peak, active); if (passes === 1) await gate.promise; active-- }
  client.start({ pollMs: 60000 })
  await until(() => passes === 1)
  for (let i = 0; i < 100; i++) socket.hint()
  gate.resolve()
  await until(() => passes === 2)
  await wait(20)
  assert.equal(passes, 2); assert.equal(peak, 1); assert.equal(client.hints, 100)
  client.stop()
})

test('an old failed loop cannot close or schedule retries for a new run', async () => {
  const gate = deferred(), sockets = [new Socket(), new Socket()]; let connections = 0, passes = 0
  const { client } = fixture({ credential: { socketFactory: async () => sockets[connections++] } })
  client.synchronize = async () => { passes++; if (passes === 1) { await gate.promise; throw Object.assign(new Error('old'), { code: 'UNAUTHENTICATED' }) } }
  client.start({ pollMs: 60000 })
  await until(() => passes === 1)
  client.stop(); client.start({ pollMs: 60000 })
  await until(() => passes === 2)
  gate.resolve(); await wait(20)
  assert.equal(client.connected, true); assert.equal(client.running, true); assert.equal(client.socket, sockets[1])
  client.stop()
})

test('a response resolved just before stop cannot escape the generation check in the RPC continuation', async () => {
  const { client, socket } = fixture()
  await client.connect()
  const pending = client.request('contacts.list')
  socket.reply(socket.sent.at(-1).id, [{ principalId: 'stale-snapshot' }])
  client.stop()
  await assert.rejects(pending, { code: 'CONNECTION_LOST' })
})

test('lifecycle diagnostics are bounded and exclude credentials and payloads', async () => {
  const { client } = fixture()
  await client.connect()
  for (let n = 0; n < 100; n++) client.record('failure', 'CONNECTION_LOST')
  const diagnostics = client.diagnostics()
  assert.equal(diagnostics.recentEvents.length, 32)
  assert.equal(diagnostics.pendingRequests, 0)
  assert.deepEqual(Object.keys(diagnostics.recentEvents[0]).sort(), ['at', 'code', 'event', 'generation'])
  diagnostics.recentEvents[0].code = 'MODIFIED'
  assert.equal(client.diagnostics().recentEvents[0].code, 'CONNECTION_LOST')
  client.stop()
})

test('a delivery paused before storage cannot cross stop into a new pump or clear its owner', async () => {
  const oldGate = deferred(), newGate = deferred(); let before = false, freshChanging = false, pulls = 0, stored = 0
  const { client, queue } = fixture({ beforeReceive: async () => { before = true; await oldGate.promise },
    onChange: async () => { freshChanging = true; await newGate.promise } })
  Object.assign(queue, { pendingReceipts: () => [], pendingOutbox: () => [], applyMemberships() {}, memberships: () => [], receive() { stored++ } })
  client.request = async type => type === 'deliveries.pull' ? (++pulls === 1 ? [{ deliveryId: 'old-delivery' }] : []) : {}
  await client.connect()
  const old = client.pump()
  await until(() => before)
  client.stop()
  client.credential = { socketFactory: async () => new Socket() }
  await client.connect()
  const fresh = client.pump()
  await until(() => freshChanging)
  oldGate.resolve()
  await assert.rejects(old, { code: 'CONNECTION_LOST' })
  assert.equal(stored, 0)
  assert.equal(client.pumping, fresh)
  newGate.resolve(); await fresh
  assert.equal(client.state, 'ready')
  client.stop()
})
