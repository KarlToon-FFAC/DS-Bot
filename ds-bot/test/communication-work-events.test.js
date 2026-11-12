import assert from 'node:assert/strict'
import { test } from 'node:test'
import { CommunicationQueue } from '../src/host/federation/queue-store.js'
import { CommunicationRuntime } from '../src/host/federation/runtime.js'
import { COMMUNICATION_PRESET } from '../src/host/federation/session-scope.js'
import { startedSources } from '../src/host/federation/work-events.js'

function fixture(t, capabilities = ['bot-work-events']) {
  const queue = new CommunicationQueue(':memory:', { instanceId: 'a' }); t.after(() => queue.close())
  const bot = queue.localPrincipal('bot', 'worker', 'Worker')
  const binding = { id: 'binding', localBotRef: 'worker', conversationId: 'group', recipientPrincipalId: bot.principalId, membershipEpoch: 'epoch', sessionIds: ['session'] }
  queue.applyMemberships({ memberships: [{ principalId: bot.principalId, conversationId: 'group', membershipEpoch: 'epoch', active: true, joinSeq: 1, watermark: 1 }] })
  const delivery = { deliveryId: 'delivery', messageId: 'message', conversationId: 'group', recipientPrincipalId: bot.principalId, membershipEpoch: 'epoch', routingVersion: 1, ai: true, notify: false,
    event: { type: 'message', eventId: 'message', conversationId: 'group', conversationSeq: 1, message: { messageId: 'message' } } }
  queue.receive(delivery)
  const source = { kind: 'ds-bot-communication', deliveryId: delivery.deliveryId, messageId: delivery.messageId, conversationId: 'group', recipientPrincipalId: bot.principalId, membershipEpoch: 'epoch' }
  const input = { source, content: [{ type: 'text', text: 'Please work' }] }, agent = { id: 'session', ctx: {}, session: {} }, hooks = new Map()
  const events = [{ seq: 0, type: 'turn/start', data: { turn: 1 } }, { seq: 1, type: 'user/message', data: { turn: 1, source } }]
  const registry = { composedPreset: () => COMMUNICATION_PRESET, inspectCompositions: () => [{ id: COMMUNICATION_PRESET, modules: [{ moduleName: '@deepseek-ai/dsh-persona' }], leakedServices: [] }] }
  const runtime = { queue, owners: new Map([[agent.id, binding]]), errors: new Map(), disposers: [], authorize: async () => {}, transport: { welcome: { capabilities } },
    ctx: { on: (name, handler) => { hooks.set(name, handler); return () => {} }, get: () => registry, systemPrompt: { section: () => () => {} }, sessionController: { inspect: async () => ({ events }) } } }
  CommunicationRuntime.prototype.installHooks.call(runtime)
  const enter = () => hooks.get('agent/pre-step')({ agent, messages: [input] }, async () => ({ kind: 'enter', messages: [input] }))
  const starts = () => queue.pendingReceipts().filter(row => row.payload.status === 'aiStarted')
  const step = async (turn = 1, seq = 2) => {
    const event = { type: 'step/start', seq, data: { turn, step: 1 } }; events.push(event)
    hooks.get('session/event')(agent.session.id ? agent.session : { id: agent.id }, event)
    await runtime.workEvents
  }
  return { queue, binding, source, input, agent, hooks, runtime, events, enter, starts, step }
}

test('pre-step enter and admission do not mean started; only a real same-turn journal step creates one durable receipt', async t => {
  const f = fixture(t)
  f.queue.aiState('delivery', 'accepted', { sessionId: 'session', messageId: 'input', seq: 1 })
  assert.equal(f.starts().length, 0)
  await f.enter(); assert.equal(f.starts().length, 0)
  await f.step(2); assert.equal(f.starts().length, 0)
  f.events.push({ seq: 3, type: 'user/message', data: { turn: 1, source: f.source } })
  await f.enter(); await f.step(1, 4)
  assert.equal(f.starts().length, 1)
  await f.enter(); await f.step(1, 5)
  assert.equal(f.starts().length, 1)
  f.queue.receiptAccepted(f.starts()[0].id)
  await f.enter(); await f.step(1, 6)
  assert.equal(f.starts().length, 0)
})

test('blocked decisions, foreign or absent step evidence, invalid sources and old Hubs never create work receipts', async t => {
  const f = fixture(t)
  await f.hooks.get('agent/pre-step')({ agent: f.agent, messages: [f.input] }, async () => ({ kind: 'blocked' }))
  await f.step(); assert.equal(f.starts().length, 0)
  await assert.rejects(f.hooks.get('agent/pre-step')({ agent: f.agent, messages: [{ source: { kind: 'user' } }] }, async () => assert.fail('invalid input must not enter')), { code: 'COMMUNICATION_INPUT_SOURCE_UNKNOWN' })
  const foreign = fixture(t)
  await foreign.enter()
  foreign.hooks.get('session/event')({ id: 'private-session' }, { type: 'step/start', seq: 3, data: { turn: 1 } })
  await foreign.runtime.workEvents; assert.equal(foreign.starts().length, 0)
  const absent = { type: 'step/start', seq: 99, data: { turn: 1 } }
  assert.deepEqual(startedSources(f.events, absent), [])
  const old = fixture(t, [])
  await old.enter(); await old.step(); assert.equal(old.starts().length, 0)
})

test('journal recovery uses actual same-turn steps rather than text and recording failure cannot prevent real execution', async t => {
  const f = fixture(t)
  assert.deepEqual(startedSources(f.events, { type: 'step/start', seq: 2, data: { turn: 1 } }), [])
  await f.enter()
  f.queue.beforeCommit = () => { throw new Error('synthetic recording failure') }
  await f.step()
  assert.equal(f.starts().length, 0); assert.equal(f.runtime.errors.get('binding'), 'WORK_START_NOT_RECORDED')
  f.queue.beforeCommit = undefined
  const proven = startedSources(f.events, f.events.at(-1))
  assert.deepEqual(proven, [f.source])
  f.runtime.rt = { botOf: () => ({}) }; f.runtime.bots = new Map([['worker', { principalId: f.binding.recipientPrincipalId }]])
  f.runtime.scope = () => {}; f.runtime.ctx.sessions = { flush: async () => {} }
  f.runtime.ctx.sessionController.resolveAgent = async () => ({ agent: f.agent })
  await CommunicationRuntime.prototype.export.call(f.runtime, f.binding)
  assert.equal(f.starts().length, 1)
  f.queue.applyMemberships({ memberships: [{ principalId: f.binding.recipientPrincipalId, conversationId: 'group', membershipEpoch: 'new', active: true, joinSeq: 2, watermark: 1 }] })
  assert.throws(() => f.queue.aiStarted('delivery'), { code: 'MEMBERSHIP_REVOKED' })
})

test('later tool steps and a steered second input in the same turn do not blame earlier canonical inputs', async t => {
  const f = fixture(t)
  await f.enter(); await f.step()
  assert.equal(f.starts().length, 1)
  await f.hooks.get('agent/pre-step')({ agent: f.agent, messages: [] }, async () => ({ kind: 'enter', messages: [] }))
  await f.step(1, 3)
  assert.equal(f.starts().length, 1); assert.equal(f.runtime.errors.has('binding'), false)
  const next = { ...JSON.parse(f.queue.db.prepare('SELECT body FROM inbox WHERE delivery_id=?').get('delivery').body), deliveryId: 'second-delivery', messageId: 'second-message',
    event: { type: 'message', eventId: 'second-message', conversationId: 'group', conversationSeq: 2, message: { messageId: 'second-message' } } }
  f.queue.receive(next)
  const source = { ...f.source, deliveryId: next.deliveryId, messageId: next.messageId }, input = { source, content: [{ type: 'text', text: 'A second request' }] }
  f.events.push({ seq: 4, type: 'user/message', data: { turn: 1, source } })
  await f.hooks.get('agent/pre-step')({ agent: f.agent, messages: [input] }, async () => ({ kind: 'enter', messages: [input] }))
  await f.step(1, 5)
  assert.deepEqual(f.starts().map(row => row.payload.deliveryId), ['delivery', 'second-delivery'])
  assert.equal(f.runtime.errors.has('binding'), false)
  f.events.push({ seq: 6, type: 'user/message', data: { turn: 1, source: { kind: 'user' } } })
  await f.enter(); await f.step(1, 7)
  assert.equal(f.starts().length, 2); assert.equal(f.runtime.errors.get('binding'), 'WORK_START_NOT_RECORDED')
})

test('real DSH order associates inputs recorded after step/start and retries when the source arrives', async t => {
  const f = fixture(t)
  f.events.splice(0, f.events.length, { seq: 5, type: 'turn/start', data: { turn: 1 } })
  const step = { seq: 7, type: 'step/start', data: { turn: 1, step: 1 } }
  f.events.push(step)
  f.hooks.get('session/event')({ id: 'session' }, step)
  await f.runtime.workEvents; assert.equal(f.starts().length, 0)
  const admitted = { seq: 9, type: 'user/message', data: { source: f.source } }
  f.events.push(admitted, { seq: 10, type: 'user/message', data: { source: { kind: 'runtime-context', form: 'snapshot', sections: [{ name: 'working-directory:current', text: 'isolated' }] } } })
  f.hooks.get('session/event')({ id: 'session' }, admitted)
  await f.enter(); await f.runtime.workEvents
  assert.equal(f.starts().length, 1)
  f.events.push({ seq: 16, type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } },
    { seq: 17, type: 'turn/start', data: { turn: 2 } }, { seq: 18, type: 'user/message', data: { source: { kind: 'user' } } })
  assert.deepEqual(startedSources(f.events, step), [f.source])
  f.hooks.get('session/event')({ id: 'session' }, { seq: 16, type: 'turn/end', data: { turn: 1 } })
  assert.equal(f.runtime.workInputs.has('session'), false)
})

test('presence reports actual local and federation turns, clears on end, and skips old Hubs',async t=>{
  const f=fixture(t,['bot-presence'])
  const local={localRef:'local',principalId:'bot:a:local'},remote={localRef:'worker',principalId:f.binding.recipientPrincipalId}
  f.runtime.bots=new Map([[local.localRef,local],[remote.localRef,remote]])
  f.runtime.rt={workView:()=>({local:{since:1}})}
  const calls=[]
  f.runtime.transport.request=async(type,payload)=>{calls.push({type,...payload})}
  const report=()=>CommunicationRuntime.prototype.reportPresence.call(f.runtime)
  await report();assert.deepEqual(calls.at(-1).workingBotPrincipalIds,[local.principalId])
  f.hooks.get('session/event')({id:'session'},{type:'turn/start'})
  await report();assert.deepEqual(calls.at(-1).workingBotPrincipalIds,[local.principalId,remote.principalId].sort())
  f.hooks.get('session/event')({id:'session'},{type:'turn/end'})
  await report();assert.deepEqual(calls.at(-1).workingBotPrincipalIds,[local.principalId])
  f.hooks.get('session/event')({id:'session'},{type:'turn/start'})
  f.hooks.get('agent/status')({agent:{id:'session'},status:'idle'})
  await report();assert.deepEqual(calls.at(-1).workingBotPrincipalIds,[local.principalId],'failed pre-step without turn/end clears working')
  f.runtime.ctx.get=()=>new Map([['session',{status:'running'}]])
  await report();assert.ok(calls.at(-1).workingBotPrincipalIds.includes(remote.principalId),'a live turn survives runtime reload')
  f.runtime.transport.welcome.capabilities=[]
  await report();assert.equal(calls.length,5)
})
