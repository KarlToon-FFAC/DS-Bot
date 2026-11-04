import assert from 'node:assert/strict'
import { test } from 'node:test'
import { CommunicationRuntime } from '../src/host/federation/runtime.js'
import { CommunicationQueue } from '../src/host/federation/queue-store.js'
import { CommunicationTransport } from '../src/host/federation/transport.js'

const binding = { conversationId: 'group', recipientPrincipalId: 'bot:a:one', membershipEpoch: 'epoch' }
const source = { kind: 'ds-bot-communication', ...binding, deliveryId: 'delivery', messageId: 'parent' }
const input = { ...binding, deliveryId: 'delivery', messageId: 'parent', ai: true }
const tool = { seq: 4, type: 'assistant/message', data: { turn: 2, message: { id: 'tool-message', content: [{ type: 'tool-call', id: 'call' }] } } }

test('active communication tool causation comes from its exclusive durable input, including recovery', async () => {
  let events = [{ seq: 1, type: 'turn/start', data: { turn: 1 } },
    { seq: 2, type: 'turn/start', data: { turn: 2 } }, { seq: 3, type: 'user/message', data: { source } }, tool]
  const runtime = { owners: new Map([['session', binding]]), queue: { db: { prepare: () => ({ get: id => id === 'delivery' ? { body: JSON.stringify(input), revoked: 0 } : null }) } },
    ctx: { sessions: { flush: async () => {} }, sessionController: { inspect: async () => ({ events }) } } }
  const exec = { callId: 'call', agent: { id: 'session', session: {} } }
  const read = () => CommunicationRuntime.prototype.toolProvenance.call(runtime, exec)
  const result = await read()
  assert.equal(result.causationDeliveryId, 'delivery')
  assert.equal(result.replyToMessageId, 'parent')
  assert.equal(result.sourceKey, JSON.stringify(['tool', 'session', 4, 'tool-message', 'call']))
  events[2].data.source = { kind: 'ds-bot-communication-recovery', conversationId: 'group', forDeliveryId: 'delivery', forMessageId: 'parent' }
  assert.equal((await read()).causationDeliveryId, 'delivery')
  events[2].data.source = { ...source, deliveryId: 'forged' }
  await assert.rejects(read(), { code: 'COMMUNICATION_INPUT_SOURCE_UNKNOWN' })
  events[2].data.source = source
  events.splice(3, 0, { seq: 3.5, type: 'user/message', data: { source: { kind: 'user' } } })
  await assert.rejects(read(), { code: 'COMMUNICATION_INPUT_SOURCE_UNKNOWN' })
  events = [{ seq: 1, type: 'turn/start', data: { turn: 1 } }, { seq: 2, type: 'user/message', data: { source } },
    { seq: 3, type: 'turn/start', data: { turn: 2 } }, tool]
  await assert.rejects(read(), { code: 'COMMUNICATION_INPUT_SOURCE_UNKNOWN' })
})

test('active tool exports retain parent and causal delivery on journal retry', async () => {
  const queue = new CommunicationQueue(':memory:', { instanceId: 'a' })
  try {
    const principalId = queue.localPrincipal('bot', 'one', 'One').principalId
    const runtime = { queue, member: () => ({ kind: 'group', speakingMode: 'active', membershipEpoch: 'epoch' }),
      contacts: [{ principalId: 'bot:b:two', displayName: 'Two', kind: 'bot' }] }
    runtime.message = (...args) => CommunicationRuntime.prototype.message.call(runtime, ...args)
    const exec = { callId: 'call', agent: { id: 'session' }, communicationSource: 'durable-tool-source', communicationBinding: binding,
      communicationCausation: { causationDeliveryId: 'delivery', replyToMessageId: 'parent' } }
    const send = () => CommunicationRuntime.prototype.sendBot.call(runtime, { principalId }, { conversationId: 'group', text: '@Two review', mentions: ['bot:b:two'] }, exec)
    const first = await send(), second = await send()
    assert.equal(first.messageId, second.messageId)
    assert.equal(queue.intent(first.messageId).payload.causationDeliveryId, 'delivery')
    assert.equal(queue.intent(first.messageId).payload.replyToMessageId, 'parent')
    assert.equal(queue.intent(first.messageId).payload.responseToDeliveryId, undefined)
    delete exec.communicationCausation
    await assert.rejects(send(), { code: 'COMMUNICATION_INPUT_SOURCE_UNKNOWN' })
  } finally { queue.close() }
})

test('a new client refuses an old unbounded Hub before registration or outbox publication', async t => {
  const original = globalThis.WebSocket
  const frames = []
  class OldHubSocket extends EventTarget {
    static OPEN = 1
    readyState = 1
    constructor() { super(); queueMicrotask(() => this.dispatchEvent(new Event('open'))) }
    close() { this.readyState = 3; this.dispatchEvent(new Event('close')) }
    send(raw) {
      const frame = JSON.parse(raw); frames.push(frame.type)
      assert.equal(frame.type, 'hello')
      assert.ok(frame.payload.capabilities.includes('bounded-bot-collaboration'))
      queueMicrotask(() => this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ id: frame.id, ok: true,
        value: { protocol: 'dsbot-communication/1', instanceId: 'test', capabilities: frame.payload.capabilities.filter(value => value !== 'bounded-bot-collaboration') } }) })))
    }
  }
  globalThis.WebSocket = OldHubSocket
  t.after(() => { globalThis.WebSocket = original })
  let registered = false, changed = false
  const retained = { messageId: 'original-id', state: 'pending' }
  const queue = { instanceId: 'test', disconnected: () => {}, setLimits: () => { changed = true }, retained }
  const transport = new CommunicationTransport(queue, { url: 'ws://127.0.0.1:3190/communication', credential: 'synthetic',
    onConnect: () => { registered = true } })
  await assert.rejects(transport.connect(), { code: 'BOUNDED_COLLABORATION_REQUIRED' })
  assert.equal(registered, false)
  assert.equal(changed, false)
  assert.deepEqual(frames, ['hello'])
  assert.equal(transport.connected, false)
  assert.equal(transport.socket.readyState, 3)
  assert.deepEqual(queue.retained, { messageId: 'original-id', state: 'pending' })
})
