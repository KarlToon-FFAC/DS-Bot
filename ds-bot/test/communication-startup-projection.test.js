import assert from 'node:assert/strict'
import { test } from 'node:test'
import { tmpdir } from 'node:os'
import { CommunicationRuntime } from '../src/host/federation/runtime.js'
import { CommunicationTransport } from '../src/host/federation/transport.js'
import { COMMUNICATION_PRESET } from '../src/host/federation/session-scope.js'

const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done }); return { promise, resolve } }
const until = async check => { for (let n = 0; n < 200; n++) { if (check()) return; await new Promise(resolve => setTimeout(resolve, 5)) } assert.fail('Condition timed out') }
function fixture(t, reason = 'interrupted', guarded = false) {
  let runtime, prompt = Promise.resolve(), steers = 0, modelSteps = 0
  const hooks = new Map(), control = new AbortController()
  const append = (type, data) => events.push({ seq: events.length + 1, type, data })
  const agent = { id: 'recovered-session', status: 'idle', session: {}, inbox: { nextTurn: [], nextStep: [] }, ctx: { preset: COMMUNICATION_PRESET, tools: { register: () => () => {} }, on: (name, fn) => { hooks.set(name, fn); return () => {} } },
    steer: notice => {
      steers++
      if (!guarded) assert.equal(runtime.everReconciled, false, 'the first recovered prompt precedes complete synchronization')
      if (guarded) {
        agent.status = 'running'
        append('agent/inbox/spliced', { target: 'next-step', start: 0, inserted: [notice] })
        append('turn/start', { turn: steers + 1 })
        append('agent/inbox/spliced', { target: 'next-step', start: 0, removedCount: 1, inserted: [] })
        append('model/selection', { provider: 'mock' })
        prompt = hooks.get('system-prompt/assemble')({}, { signal: control.signal }, async () => ({ tools: [], sections: [] }))
          .then(() => { modelSteps++; append('step/start', { turn: steers + 1 }); append('turn/end', { turn: steers + 1, reason: { kind: 'completed' } }) })
          .catch(error => append('turn/end', { turn: steers + 1, reason: { kind: control.signal.aborted ? 'aborted' : 'error', error: { message: error.message, code: 'UNKNOWN' } } }))
          .finally(() => { agent.status = 'idle' })
        return
      }
      // This is the actual relationship-context gate used during prompt assembly.
      prompt = runtime.relationshipContext(binding.recipientPrincipalId, { conversationId: binding.conversationId, membershipEpoch: binding.membershipEpoch })
        .then(() => { modelSteps++ })
    } }
  const ctx = { on: () => () => {}, systemPrompt: { section: () => () => {} },
    get: name => name === 'agentPresets' ? { composedPreset: value => value.preset, inspectCompositions: value => [{ id: value.preset, modules: [{ moduleName: '@deepseek-ai/dsh-persona' }], leakedServices: [] }] } : undefined,
    sessions: { flush: async () => { await prompt } }, sessionController: { resolveAgent: async () => ({ agent }), inspect: async () => ({ events }) } }
  const start = CommunicationTransport.prototype.start
  CommunicationTransport.prototype.start = () => {}
  try { runtime = new CommunicationRuntime({ home: tmpdir(), ctx, botOf: () => ({ name: 'Worker' }), readOnly: () => undefined },
    { url: 'ws://127.0.0.1:3190/communication', instanceId: 'a', dataPath: ':memory:', publishedBotIds: ['worker'] }, 'synthetic', []) }
  finally { CommunicationTransport.prototype.start = start }
  t.after(() => runtime.close())
  const bot = runtime.bots.get('worker')
  const membership = { conversationId: 'group', principalId: bot.principalId, membershipEpoch: 'original', membershipVersion: 1, kind: 'group', speakingMode: 'active', joinSeq: 1, watermark: 1, active: true }
  runtime.queue.applyMemberships({ memberships: [membership], invites: [] })
  let binding = runtime.queue.binding('group', bot.principalId, 'original', 'worker')
  runtime.queue.addBindingSession(binding.id, agent.id); binding = runtime.queue.bindings()[0]
  runtime.owners.set(agent.id, binding)
  const source = { kind: 'ds-bot-communication', conversationId: 'group', recipientPrincipalId: bot.principalId, membershipEpoch: 'original', deliveryId: 'delivery', messageId: 'original-message' }
  const message = { messageId: source.messageId, author: { principalId: 'human:b:remote', kind: 'human' }, content: { text: 'Already admitted work' }, mentions: [] }
  runtime.queue.receive({ ...source, ai: true, notify: false, event: { type: 'message', eventId: source.messageId, conversationId: 'group', conversationSeq: 1, message } })
  runtime.queue.aiState('delivery', 'accepted', { sessionId: agent.id, messageId: 'local-input', seq: 2 })
  const events = [{ seq: 1, type: 'turn/start', data: { turn: 1 } }, { seq: 2, type: 'user/message', data: { id: 'local-input', turn: 1, source, content: [{ type: 'text', text: 'Already admitted work' }] } },
    { seq: 3, type: 'turn/end', data: { turn: 1, reason: { kind: reason } } }]
  runtime.transport.connected = true
  runtime.transport.socket = { close() {} }
  const requests = []
  runtime.transport.request = async (type, payload) => {
    requests.push(type)
    if (type === 'contacts.list') return [bot]
    if (type === 'conversation.members') {
      assert.equal(payload.principalId, bot.principalId); assert.equal(payload.membershipEpoch, 'original')
      return { conversationId: 'group', kind: 'group', membershipVersion: 1, members: [{ ...bot, speakingMode: 'active' }] }
    }
    if (type === 'conversation.authorize') return { authorized: true }
    assert.fail(`Unexpected request ${type}`)
  }
  if (!guarded) runtime.scope = () => {}; runtime.syncWorkContext = async () => {}
  runtime.process = async () => { await runtime.recoverInterrupted(binding); await prompt }
  return { runtime, membership, binding, requests, events, control, agent, counts: () => ({ steers, modelSteps }) }
}

test('first canonical projection permits actual interrupted-input recovery before complete synchronization', async t => {
  const f = fixture(t)
  assert.throws(() => f.runtime.member(f.binding.recipientPrincipalId, 'group', 'original'), { code: 'AUTHORIZATION_PENDING' })
  await f.runtime.transport.onChange()
  assert.deepEqual(f.counts(), { steers: 1, modelSteps: 1 })
  assert.equal(f.runtime.everReconciled, true)
  assert.equal(f.runtime.resumedTurns.size, 1)
  await f.runtime.transport.onChange()
  assert.deepEqual(f.counts(), { steers: 1, modelSteps: 1 })
  assert.equal(f.runtime.queue.db.prepare('SELECT count(*) n FROM inbox').get().n, 1)
  assert.equal(f.runtime.queue.db.prepare('SELECT ai_state FROM inbox').get().ai_state, 'accepted')
})

for (const type of ['contacts.list', 'conversation.members']) {
  test(`failure of initial ${type} cannot grant startup scope or consume the interrupted recovery attempt`, async t => {
    const f = fixture(t), request = f.runtime.transport.request
    f.runtime.transport.request = async (operation, payload) => { if (operation === type) throw Object.assign(new Error('Synthetic read failure'), { code: 'REQUEST_TIMEOUT' }); return request(operation, payload) }
    await assert.rejects(f.runtime.transport.onChange(), { code: 'REQUEST_TIMEOUT' })
    assert.equal(f.runtime.everReconciled, false)
    assert.equal(f.runtime.hasAuthorizedProjection(), false)
    assert.equal(f.runtime.snapshot().listState, 'not-synchronized')
    assert.equal(f.runtime.resumedTurns.size, 0)
    assert.deepEqual(f.counts(), { steers: 0, modelSteps: 0 })
    f.runtime.transport.request = request
    await f.runtime.transport.onChange()
    assert.deepEqual(f.counts(), { steers: 1, modelSteps: 1 })
  })
}

for (const reason of ['aborted', 'cancelled', 'error', 'failed', 'completed']) {
  test(`startup projection readiness does not resume an explicitly ${reason} turn`, async t => {
    const f = fixture(t, reason)
    await f.runtime.transport.onChange()
    assert.deepEqual(f.counts(), { steers: 0, modelSteps: 0 })
    assert.equal(f.runtime.resumedTurns.size, 0)
  })
}

for (const change of ['stop', 'generation', 'socket', 'authorization']) {
  test(`initial projected scope cannot survive ${change} while recovery waits for prior processing`, async t => {
    const f = fixture(t), gate = deferred()
    f.runtime.processing = gate.promise
    f.runtime.process = async () => { f.runtime.member(f.binding.recipientPrincipalId, 'group', 'original') }
    const syncing = f.runtime.transport.onChange()
    await until(() => f.runtime.hasAuthorizedProjection())
    assert.equal(f.runtime.everReconciled, false)
    if (change === 'stop') f.runtime.transport.stop()
    if (change === 'generation') f.runtime.transport.generation++
    if (change === 'socket') f.runtime.transport.socket = { close() {} }
    if (change === 'authorization') f.runtime.queue.disconnected()
    gate.resolve()
    await assert.rejects(syncing, { code: 'CONNECTION_LOST' })
    assert.equal(f.runtime.everReconciled, false)
    assert.deepEqual(f.counts(), { steers: 0, modelSteps: 0 })
    assert.equal(f.runtime.resumedTurns.size, 0)
  })
}


test('disconnect during first processing cannot publish a completed synchronization marker', async t => {
  const f = fixture(t), gate = deferred(); let started = false
  f.runtime.process = async () => { started = true; await gate.promise }
  const syncing = f.runtime.transport.onChange()
  await until(() => started)
  assert.equal(f.runtime.hasAuthorizedProjection(), true)
  assert.equal(f.runtime.snapshot().reconciled, false)
  f.runtime.transport.stop(); gate.resolve()
  await assert.rejects(syncing, { code: 'CONNECTION_LOST' })
  assert.equal(f.runtime.everReconciled, false)
  assert.equal(f.runtime.snapshot().listState, 'not-synchronized')
})

for (const fault of ['local-loss', 'repeated-loss', 'forged-error', 'cancel', 'revoked', 'epoch', 'model-boundary']) {
  test(`owned recovery prompt ${fault} retains exact-scope safety and retry liveness`, async t => {
    const f = fixture(t, 'interrupted', true), request = f.runtime.transport.request
    let losses = 0
    f.runtime.transport.request = async (type, payload) => {
      if (losses < (fault === 'repeated-loss' ? 2 : 1) && type === 'conversation.members' && f.agent.status === 'running') {
        losses++
        if (fault === 'cancel') f.control.abort({ kind: 'user' })
        if (fault === 'model-boundary') f.events.push({ seq: f.events.length + 1, type: 'request/header', data: {} })
        if (fault === 'forged-error') throw Object.assign(new Error('CONNECTION_LOST'), { code: 'CONNECTION_LOST' })
        return CommunicationTransport.prototype.request.call({ context: { getStore: () => undefined }, connected: false }, type, payload)
      }
      return request(type, payload)
    }
    await f.runtime.transport.onChange()
    assert.deepEqual(f.counts(), { steers: 1, modelSteps: 0 })
    assert.equal(f.runtime.resumedTurns.size, 1)
    if (fault === 'revoked') f.runtime.queue.applyMemberships({ memberships: [], invites: [] })
    if (fault === 'epoch') f.runtime.queue.applyMemberships({ memberships: [{ ...f.membership, membershipEpoch: 'new-epoch' }], invites: [] })
    await f.runtime.transport.onChange()
    if (fault === 'repeated-loss') {
      assert.deepEqual(f.counts(), { steers: 2, modelSteps: 0 })
      await f.runtime.transport.onChange()
    }
    assert.deepEqual(f.counts(), fault === 'repeated-loss' ? { steers: 3, modelSteps: 1 } : fault === 'local-loss' ? { steers: 2, modelSteps: 1 } : { steers: 1, modelSteps: 0 })
    assert.equal(f.runtime.resumedTurns.size, 1, 'never clear the old turn claim')
    await f.runtime.transport.onChange()
    assert.equal(f.counts().steers, fault === 'repeated-loss' ? 3 : fault === 'local-loss' ? 2 : 1, 'no extra attempt')
    assert.equal(f.runtime.queue.db.prepare('SELECT count(*) n FROM inbox').get().n, 1)
  })
}
