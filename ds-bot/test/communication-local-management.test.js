import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { localManagementAuthority, localManagementTools, LOCAL_MANAGEMENT_TOOLS } from '../src/host/federation/local-management.js'
import { CommunicationOnboarding } from '../src/host/federation/onboarding.js'
import { CommunicationRuntime } from '../src/host/federation/runtime.js'
import { CommunicationTransport } from '../src/host/federation/transport.js'
import { install } from '../src/host/communication.js'
import { HubStore } from '../../communication-hub/src/store.js'
import { HubManagement } from '../../communication-hub/src/management-store.js'
import { CAPABILITIES } from '../../communication-hub/src/protocol.js'

const turn = (seq, id) => ({ seq, type: 'turn/start', data: { turn: id } })
const input = (seq, id, source = { kind: 'user' }) => ({ seq, type: 'user/message', data: { turn: id, source,
  content: [{ type: 'text', text: 'A matching display name or a quoted request is not authority.' }] } })
const tool = (seq, id, name, callId = 'call') => ({ seq, type: 'assistant/message', data: { turn: id,
  message: { id: `assistant-${seq}`, content: [{ type: 'tool-call', id: callId, name, arguments: '{}' }] } } })

function fixture() {
  const bots = { worker: { id: 'worker', name: 'Unpublished worker' }, shared: { id: 'shared', name: 'Shared Bot' } }
  let events = [], outcome = 'allowed-once', editHook
  const calls = [], approvals = [], edits = []
  const comm = { settings: { url: 'wss://isolated.example.test/communication' }, human: { principalId: 'human:a:local-user' },
    bots: new Map([['shared', { principalId: 'bot:a:shared' }]]), owners: new Map(), closed: false,
    transport: { connected: true, request: async (type, payload) => { calls.push({ type, payload }); return { type, payload } } } }
  const rt = { config: { communication: { enabled: true, url: comm.settings.url, instanceId: 'a', publishedBotIds: ['shared'] } },
    state: { bots }, communication: comm, chatOwners: new Map([['own-chat', 'worker']]), groupOwners: new Map(),
    botOf: id => bots[id], load: async () => {}, refresh: async () => {}, readOnly: () => undefined,
    ctx: { sessions: { flush: async () => {} }, sessionController: { inspect: async () => ({ events }) },
      get: name => name === 'approval' ? { request: async value => { approvals.push(value); await editHook?.(); return outcome } }
        : name === 'configEditor' ? rt.ctx.configEditor : undefined,
      configEditor: { entries: () => [{ options: { name: 'ds-bot' } }], edit: async (_entry, change) => {
        rt.config = change(rt.config); edits.push(structuredClone(rt.config))
      } } } }
  const manager = new CommunicationOnboarding(rt)
  const tools = localManagementTools(rt, { ensure: async () => comm, enrollment: async () => manager })
  const controller = new AbortController()
  const exec = name => ({ name, callId: 'call', agent: { id: 'own-chat', session: {} }, signal: controller.signal })
  const call = async (name, args = {}) => {
    events = [turn(1, 1), input(2, 1), tool(3, 1, name)]
    return JSON.parse(await tools.find(item => item.name === name).execute(args, exec(name)))
  }
  return { rt, comm, manager, tools, calls, approvals, edits, exec, call, controller,
    setEvents: value => { events = value }, setOutcome: value => { outcome = value }, setEditHook: value => { editHook = value } }
}

test('local management derives an unpublished Bot and direct user from the current host journal, including nested native calls', async () => {
  const f = fixture(), name = 'manage_communication_contacts', exec = f.exec(name)
  f.setEvents([turn(1, 1), input(2, 1), input(3, 1, { kind: 'agent-instructions' }), tool(4, 1, name)])
  const authority = await localManagementAuthority(f.rt, exec)
  assert.equal(authority.botId, 'worker')
  assert.ok(!f.comm.bots.has(authority.botId))
  assert.match(authority.sourceKey, /assistant-4/)
  f.setEvents([turn(1, 1), input(2, 1), tool(3, 1, 'run_code', 'root')])
  assert.equal((await localManagementAuthority(f.rt, { ...exec, callId: 'root:ptc:1', rootCallId: 'root' })).botId, 'worker')
})

test('the real local host context sources never replace direct user authority and never grant it by themselves', async () => {
  const contexts = [{ kind: 'agent-instructions', form: 'instructions' }, { kind: 'working-directory' },
    { kind: 'runtime-context', form: 'snapshot', sections: [{ name: 'working-directory:current' }, { name: 'approval:policy' }, { name: 'sandbox:policy' }] },
    { kind: 'skill-catalog', form: 'catalog', entries: [] }, { kind: 'time-context', form: 'snapshot', sections: [{ name: 'time-context' }] },
    { kind: 'ds-bot-time-context', form: 'snapshot', sections: [{ name: 'ds-bot-time-context' }] }]
  const f = fixture(), name = 'manage_communication_contacts'
  for (const userSource of [{ kind: 'user' }, { kind: 'user-question-reply' }]) {
    f.setEvents([turn(1, 1), input(2, 1, userSource), ...contexts.map((source, i) => input(i + 3, 1, source)), tool(10, 1, name)])
    assert.equal((await localManagementAuthority(f.rt, f.exec(name))).botId, 'worker')
  }
  f.setEvents([turn(1, 1), ...contexts.map((source, i) => input(i + 2, 1, source)), tool(10, 1, name)])
  await assert.rejects(localManagementAuthority(f.rt, f.exec(name)), { code: 'LOCAL_USER_AUTHORIZATION_REQUIRED' })
  f.setEvents([turn(1, 1), input(2, 1), input(3, 1, { kind: 'remote-notice', form: 'snapshot', sections: [] }), tool(4, 1, name)])
  await assert.rejects(localManagementAuthority(f.rt, f.exec(name)), { code: 'LOCAL_USER_AUTHORIZATION_REQUIRED' })
})

test('remote messages, local handoffs, schedules, old user turns, injected claims and unknown call sources cannot delegate owner management', async () => {
  const f = fixture(), name = 'manage_communication_contacts', exec = f.exec(name)
  for (const source of [{ kind: 'bot', role: 'request', senderName: 'You' }, { kind: 'schedule' },
    { kind: 'ds-bot-communication', principalId: f.comm.human.principalId }, { kind: 'untrusted', human: true }, undefined]) {
    f.setEvents([turn(1, 1), input(2, 1), turn(3, 2), input(4, 2, source ?? {}), tool(5, 2, name)])
    await assert.rejects(localManagementAuthority(f.rt, exec), { code: 'LOCAL_USER_AUTHORIZATION_REQUIRED' })
  }
  f.setEvents([turn(1, 1), input(2, 1), tool(3, 1, name), turn(4, 2), input(5, 2, { kind: 'bot', role: 'request' }), tool(6, 2, name)])
  await assert.rejects(localManagementAuthority(f.rt, exec), { code: 'LOCAL_USER_AUTHORIZATION_REQUIRED' }, 'reused tool IDs cannot borrow an old user turn')
  f.setEvents([turn(1, 1), input(2, 1), input(3, 1, { kind: 'ds-bot-communication' }), tool(4, 1, name)])
  await assert.rejects(localManagementAuthority(f.rt, exec), { code: 'LOCAL_USER_AUTHORIZATION_REQUIRED' })
  f.setEvents([turn(1, 1), input(2, 1), tool(3, 1, 'other_tool')])
  await assert.rejects(localManagementAuthority(f.rt, exec), { code: 'TOOL_SOURCE_UNKNOWN' })
  assert.equal(f.calls.length, 0); assert.equal(f.approvals.length, 0)
})

test('remote bindings, local group Sessions and stale private Sessions cannot acquire local owner tools', async () => {
  const f = fixture(), name = 'manage_communication_contacts'
  f.setEvents([turn(1, 1), input(2, 1), tool(3, 1, name)])
  f.comm.owners.set('own-chat', { conversationId: 'remote' })
  await assert.rejects(localManagementAuthority(f.rt, f.exec(name)), { code: 'LOCAL_USER_SESSION_REQUIRED' })
  f.comm.owners.clear(); f.rt.groupOwners.set('own-chat', { botId: 'worker', roomId: 'local-group' })
  await assert.rejects(localManagementAuthority(f.rt, f.exec(name)), { code: 'LOCAL_USER_SESSION_REQUIRED' })
  f.rt.groupOwners.clear(); f.rt.chatOwners.clear()
  await assert.rejects(localManagementAuthority(f.rt, f.exec(name)), { code: 'LOCAL_USER_SESSION_REQUIRED' })
})

test('local directory and publication reads need no publication or approval and never choose a caller-provided actor', async () => {
  const f = fixture()
  const directory = await f.call('manage_communication_contacts', { action: 'list' })
  assert.equal(directory.scope, 'local-user')
  assert.deepEqual(f.calls[0], { type: 'contacts.list', payload: { principalId: f.comm.human.principalId } })
  const publication = await f.call('list_communication_bots')
  assert.deepEqual(publication.publishedBotIds, ['shared']); assert.equal(publication.bots.length, 2)
  assert.equal(f.approvals.length, 0)
  for (const field of ['principalId', 'sender', 'author', 'privateKey', 'publicKey', 'credentialKey', 'allowLoopback']) {
    assert.equal((await f.call('manage_communication_contacts', { action: 'list', [field]: 'forged' })).error.code, 'AUTHOR_MISMATCH')
  }
  await assert.rejects(f.call('manage_communication_contacts', { action: 'join-hub' }), { code: 'INVALID_ARGS' })
  assert.equal((await f.call('manage_communication_contacts', { action: 'request', hub: 'forged' })).error.code, 'INVALID_REQUEST')
  assert.equal(f.calls.length, 1)
})

test('a local user input alone never approves contact changes or publication; every native refusal is fail-closed', async () => {
  for (const outcome of ['rejected', 'cancelled', 'unavailable', 'allow', undefined]) {
    const f = fixture(); f.setOutcome(outcome)
    const request = await f.call('manage_communication_contacts', { action: 'request', userCode: 'SYNTHETIC-CODE', localBotIds: ['shared'] })
    assert.equal(request.ok, false)
    const publication = await f.call('publish_communication_bots', { localBotIds: ['worker', 'shared'] })
    assert.equal(publication.ok, false)
    assert.equal(f.calls.length, 0); assert.equal(f.edits.length, 0)
    assert.deepEqual(f.rt.config.communication.publishedBotIds, ['shared'])
  }
  const f = fixture(); f.rt.ctx.get = () => undefined
  assert.equal((await f.call('publish_communication_bots', { localBotIds: [] })).error.code, 'LOCAL_MANAGEMENT_APPROVAL_UNAVAILABLE')
  assert.equal((await f.call('manage_communication_contacts', { action: 'request', userCode: 'SYNTHETIC-CODE' })).error.code, 'LOCAL_MANAGEMENT_APPROVAL_UNAVAILABLE')
  assert.equal(f.calls.length, 0); assert.equal(f.edits.length, 0)
})

test('approved contact operations use exact owner, published Bot scope, version and stable operation ID', async () => {
  const f = fixture()
  for (const [action, expectedType] of [['request', 'contact.request'], ['accept', 'contact.accept'], ['reject', 'contact.reject'],
    ['cancel', 'contact.cancel'], ['revoke', 'contact.revoke'], ['rotate-user-code', 'contact.code.rotate']]) {
    const result = await f.call('manage_communication_contacts', { action, operationId: `stable-${action}`, userCode: 'SYNTHETIC-CODE',
      requestId: 'exact-request', expectedVersion: 7, otherHumanPrincipalId: 'human:b:local-user', localBotIds: ['shared'] })
    assert.equal(result.type, expectedType)
    const payload = f.calls.at(-1).payload
    assert.equal(payload.principalId, f.comm.human.principalId); assert.equal(payload.operationId, `stable-${action}`)
    if (['request', 'accept'].includes(action)) assert.deepEqual(payload.botPrincipalIds, ['bot:a:shared'])
    if (['accept', 'reject', 'cancel', 'revoke'].includes(action)) assert.equal(payload.expectedVersion, 7)
    assert.match(f.approvals.at(-1).reason, /wss:\/\/isolated.example.test\/communication/)
    assert.match(f.approvals.at(-1).reason, new RegExp(`stable-${action}`))
  }
  const unscoped = await f.call('manage_communication_contacts', { action: 'request', userCode: 'SYNTHETIC-CODE' })
  assert.deepEqual(unscoped.payload.botPrincipalIds, [])
  assert.match(unscoped.payload.operationId, /^contact-[a-f0-9]{64}$/)
  const count = f.calls.length
  const invalid = await f.call('manage_communication_contacts', { action: 'request', userCode: 'SYNTHETIC-CODE', localBotIds: ['worker'] })
  assert.equal(invalid.error.code, 'INVALID_BOT_SCOPE'); assert.equal(f.calls.length, count)
})

test('uncertain contact outcomes expose the generated retry ID and never silently retry or replace it', async () => {
  const f = fixture()
  f.comm.transport.request = async (_type, payload) => { f.calls.push(payload); throw Object.assign(new Error('do not expose'), { code: 'REQUEST_TIMEOUT' }) }
  const first = await f.call('manage_communication_contacts', { action: 'request', userCode: 'SYNTHETIC-CODE' })
  assert.equal(first.error.code, 'REQUEST_TIMEOUT'); assert.equal(first.operationId, f.calls[0].operationId)
  assert.equal(f.calls.length, 1)
  await f.call('manage_communication_contacts', { action: 'request', userCode: 'SYNTHETIC-CODE', operationId: first.operationId })
  assert.equal(f.calls[1].operationId, first.operationId)
  assert.doesNotMatch(JSON.stringify(first), /do not expose/)
})

test('publication approval names the exact list, preserves existing Bots, reports reload and rejects concurrent changes', async () => {
  const f = fixture()
  const saved = await f.call('publish_communication_bots', { localBotIds: ['worker', 'shared'] })
  assert.deepEqual(saved, { publishedBotIds: ['worker', 'shared'], reloadRequired: true })
  assert.match(f.approvals[0].reason, /Unpublished worker/); assert.match(f.approvals[0].reason, /Shared Bot/)
  assert.equal(f.calls.length, 0, 'saving local configuration is not proof of Hub publication')
  const withdrawn = await f.call('publish_communication_bots', { localBotIds: [] })
  assert.deepEqual(withdrawn.publishedBotIds, [])
  const concurrent = fixture()
  concurrent.setEditHook(() => { concurrent.rt.config.communication.publishedBotIds = [] })
  assert.equal((await concurrent.call('publish_communication_bots', { localBotIds: ['worker', 'shared'] })).error.code, 'PUBLICATION_CHANGED')
  assert.equal(concurrent.edits.length, 0)
})

test('a pairing replacement or read-only change while approval is pending invalidates the write', async () => {
  const stale = fixture()
  stale.rt.communication = { ...stale.comm, human: { principalId: 'human:b:local-user' } }
  assert.equal((await stale.call('manage_communication_contacts', { action: 'request', userCode: 'SYNTHETIC-CODE' })).error.code, 'COMMUNICATION_PAIRING_CONFLICT')
  assert.equal(stale.approvals.length, 0); assert.equal(stale.calls.length, 0)
  const f = fixture()
  f.setEditHook(() => { f.rt.communication = { ...f.comm, settings: { url: 'wss://other.example.test/communication' } } })
  assert.equal((await f.call('manage_communication_contacts', { action: 'request', userCode: 'SYNTHETIC-CODE' })).error.code, 'COMMUNICATION_PAIRING_CONFLICT')
  assert.equal(f.calls.length, 0)
  const readonly = fixture(); readonly.setEditHook(() => { readonly.rt.readOnly = () => 'locked' })
  assert.equal((await readonly.call('publish_communication_bots', { localBotIds: [] })).error.code, 'COMMUNICATION_READ_ONLY')
  assert.equal(readonly.edits.length, 0)
})

test('queued management retains its approved Hub, owner, cancellation and read-only boundaries through actual dispatch', async () => {
  for (const name of ['manage_communication_contacts', 'publish_communication_bots']) {
    for (const change of ['pairing', 'runtime', 'cancel', 'readonly']) {
      const f = fixture()
      let release
      f.manager.tail = new Promise(resolve => { release = resolve })
      const pending = f.call(name, name === 'publish_communication_bots' ? { localBotIds: ['worker', 'shared'] }
        : { action: 'request', userCode: 'SYNTHETIC-CODE', localBotIds: ['shared'] })
      await new Promise(resolve => setImmediate(resolve))
      assert.equal(f.approvals.length, 1)
      assert.equal(f.calls.length, 0); assert.equal(f.edits.length, 0)
      if (change === 'pairing') f.rt.config.communication = { ...f.rt.config.communication, url: 'wss://other.example.test/communication', instanceId: 'b' }
      if (change === 'runtime') f.rt.communication = { ...f.comm, human: { principalId: 'human:b:local-user' }, bots: new Map([['shared', { principalId: 'bot:b:shared' }]]) }
      if (change === 'cancel') f.controller.abort()
      if (change === 'readonly') f.rt.readOnly = () => 'locked'
      release()
      const result = await pending
      assert.equal(result.error.code, change === 'cancel' ? 'LOCAL_MANAGEMENT_CANCELLED' : change === 'readonly' ? 'COMMUNICATION_READ_ONLY' : 'COMMUNICATION_PAIRING_CONFLICT')
      assert.equal(f.calls.length, 0); assert.equal(f.edits.length, 0)
    }
  }
})

test('publication rechecks approval boundaries inside the asynchronous ConfigEditor mutation callback', async () => {
  for (const change of ['pairing', 'cancel', 'readonly']) {
    const f = fixture(), original = f.rt.ctx.configEditor.edit
    f.rt.ctx.configEditor.edit = async (...args) => {
      await Promise.resolve()
      if (change === 'pairing') f.rt.config.communication = { ...f.rt.config.communication, instanceId: 'b' }
      if (change === 'cancel') f.controller.abort()
      if (change === 'readonly') f.rt.readOnly = () => 'locked'
      return original(...args)
    }
    const result = await f.call('publish_communication_bots', { localBotIds: ['worker', 'shared'] })
    assert.equal(result.error.code, change === 'cancel' ? 'LOCAL_MANAGEMENT_CANCELLED' : change === 'readonly' ? 'COMMUNICATION_READ_ONLY' : 'COMMUNICATION_PAIRING_CONFLICT')
    assert.equal(f.edits.length, 0)
  }
})

test('remote tool assembly and execution reject all local management tools even if accidentally supplied', async () => {
  const hooks = new Map(), registered = [], runtime = { tools: [...LOCAL_MANAGEMENT_TOOLS].map(name => ({ name })).concat({ name: 'read_communication_history' }),
    scoped: new WeakSet(), disposers: [], isolateWorkspace: async () => {} }
  CommunicationRuntime.prototype.scope.call(runtime, { ctx: { tools: { register: tool => { registered.push(tool.name); return () => {} } },
    on: (name, fn) => { hooks.set(name, fn); return () => {} } } })
  assert.deepEqual(registered, ['read_communication_history'])
  for (const name of LOCAL_MANAGEMENT_TOOLS) await assert.rejects(hooks.get('tools/execute')({ name }, () => assert.fail('must not execute')), { code: 'COMMUNICATION_TOOL_NOT_ALLOWED' })
})

test('the actual installed list_contacts accepts an unpublished local Bot without registering it or granting a speaking identity', async () => {
  const home = mkdtempSync(join(tmpdir(), 'dsbot-local-management-')), start = CommunicationTransport.prototype.start
  const request = CommunicationTransport.prototype.request, calls = []
  CommunicationTransport.prototype.start = function () { this.connected = true }
  let rt
  try {
    const bot = { id: 'worker', name: 'Local worker' }, events = [turn(1, 1), input(2, 1), tool(3, 1, 'list_contacts')]
    process.env.DSBOT_COMMUNICATION_LOCAL_MANAGEMENT_TEST = 'synthetic-bootstrap-for-isolated-test-only'
    rt = { home, config: { communication: { enabled: true, url: 'wss://isolated.example.test/communication', instanceId: 'a', dataPath: ':memory:',
      credentialEnv: 'DSBOT_COMMUNICATION_LOCAL_MANAGEMENT_TEST', publishedBotIds: [] } }, teamTools: [], load: async () => {}, refresh: async () => {},
      readOnly: () => undefined, botOf: id => id === bot.id ? bot : undefined, selfOf: id => id === 'own-chat' ? bot.id : undefined,
      chatOwners: new Map([['own-chat', bot.id]]), groupOwners: new Map(), ctx: { effect: () => {}, on: () => () => {},
        systemPrompt: { section: () => () => {} }, sessions: { flush: async () => {} }, sessionController: { inspect: async () => ({ events }) },
        get: name => name === 'agentPresets' ? { list: async () => [], register: async () => () => {} } : undefined } }
    CommunicationTransport.prototype.request = async (type, payload) => { calls.push({ type, payload }); return [{ principalId: 'human:b:local-user', kind: 'human' }] }
    install(rt)
    const contacts = await rt.teamTools.find(item => item.name === 'list_contacts').execute({}, { name: 'list_contacts', callId: 'call', agent: { id: 'own-chat', session: {} } })
    assert.equal(JSON.parse(contacts).scope, 'local-user')
    assert.equal(calls[0].payload.principalId, rt.communication.human.principalId)
    assert.equal(rt.communication.bots.size, 0)
    assert.throws(() => rt.communication.actorForSession('own-chat'), { code: 'BOT_NOT_PUBLISHED' })
    assert.ok([...LOCAL_MANAGEMENT_TOOLS].filter(name => name !== 'communication_diagnose').every(name => rt.teamTools.some(tool => tool.name === name)))
    assert.ok(rt.communication.tools.every(tool => !LOCAL_MANAGEMENT_TOOLS.has(tool.name)))
  } finally {
    CommunicationTransport.prototype.start = start; CommunicationTransport.prototype.request = request
    delete process.env.DSBOT_COMMUNICATION_LOCAL_MANAGEMENT_TEST
    await rt?.communication?.close(); rmSync(home, { recursive: true, force: true })
  }
})

test('approved contact tools reuse real Hub validation and cannot accept for another local or remote owner', async () => {
  const f = fixture(), store = new HubStore(':memory:'), management = new HubManagement(store)
  try {
    const a = store.connect('a', 'Local synthetic device', CAPABILITIES), b = store.connect('b', 'Remote synthetic device', CAPABILITIES)
    for (const [auth, localId, kind, displayName] of [[a, 'local-user', 'human', 'Local'], [a, 'shared', 'bot', 'Shared'], [b, 'local-user', 'human', 'Remote']]) {
      store.register(auth, { localId, kind, displayName })
    }
    const remote = 'human:b:local-user', code = management.code(b, { principalId: remote }).userCode
    f.comm.transport.request = async (type, payload) => {
      f.calls.push({ type, payload })
      if (type === 'contact.request') return management.requestContact(a, payload)
      if (type === 'contact.accept') return management.respondContact(a, payload, 'accept')
      if (type === 'contact.requests') return management.contactRequests(a, payload)
      assert.fail(`unexpected ${type}`)
    }
    const request = await f.call('manage_communication_contacts', { action: 'request', userCode: code, operationId: 'explicit-contact', localBotIds: ['shared'] })
    assert.equal(request.status, 'pending')
    const denied = await f.call('manage_communication_contacts', { action: 'accept', requestId: request.requestId, expectedVersion: 1, operationId: 'cannot-accept-own-request' })
    assert.equal(denied.error.code, 'FORBIDDEN')
    management.respondContact(b, { principalId: remote, operationId: 'remote-consent', requestId: request.requestId, expectedVersion: 1, botPrincipalIds: [] }, 'accept')
    assert.equal((await f.call('manage_communication_contacts', { action: 'requests' }))[0].status, 'accepted')
    assert.deepEqual(management.relations(a, { principalId: f.comm.human.principalId })[0].botPrincipalIds, ['bot:a:shared'])
    assert.equal(f.rt.config.communication.publishedBotIds.includes('worker'), false)
  } finally { store.close() }
})
