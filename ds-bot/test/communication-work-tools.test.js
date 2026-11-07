import assert from 'node:assert/strict'
import { test } from 'node:test'
import { syncWorkTools, syncWorkPermission, botWorkDirectory, cancelRevokedWork } from '../src/host/federation/work-tools.js'
import { CommunicationRuntime } from '../src/host/federation/runtime.js'
import { install as installApprovals } from '../src/host/approvals.js'

function fixture() {
  const local = { id: 'local' }, bot = { id: 'worker', permission: 'read-only' }
  const registered = new Map(), native = new Map(), calls = []
  const agent = { id: 'remote', session: {}, ctx: { tools: { register: definition => {
    registered.set(definition.name, definition)
    return () => { if (registered.get(definition.name) === definition) registered.delete(definition.name) }
  } } } }
  const binding = { id: 'binding', localBotRef: bot.id, conversationId: 'group', recipientPrincipalId: 'bot:a:worker', membershipEpoch: 'epoch' }
  const runtime = { rt: { chatOf: () => local.id, resolveAgent: async id => { assert.equal(id, local.id); return local } },
    ctx: { tools: { get: (name, scope) => { assert.equal(scope, local); return native.get(name) } } },
    owners: new Map([[agent.id, binding]]), disposers: [], authorize: async owner => { assert.equal(owner, binding) },
    toolProvenance: async () => ({ replyToMessageId: 'input' }), syncWorkContext: async () => syncWorkTools(runtime, agent, bot) }
  const define = name => { const definition = { name, output: {}, execute: async (args, exec) => { calls.push({ args, agent: exec.agent }); return 'work completed' } }; native.set(name, definition); return definition }
  return { local, bot, agent, binding, runtime, registered, native, calls, define }
}

test('remote file and Shell work reuses only definitions actually visible to its owning Bot, with remote execution identity', async () => {
  const f = fixture()
  for (const name of ['read', 'write', 'bash', 'get_secret', 'create_bot', 'read_own_chat', 'workflow']) f.define(name)
  assert.deepEqual(await syncWorkTools(f.runtime, f.agent, f.bot), ['read', 'write', 'bash'])
  assert.deepEqual([...f.registered.keys()], ['read', 'write', 'bash'])
  assert.equal(await f.registered.get('bash').execute({ command: 'test command' }, { agent: f.agent, callId: 'call' }), 'work completed')
  assert.equal(f.calls[0].agent, f.agent)
  assert.equal(f.runtime.workCalls.size, 0)
  await assert.rejects(f.registered.get('bash').execute({ run_in_background: true }, { agent: f.agent }), { code: 'COMMUNICATION_BACKGROUND_UNAVAILABLE' })
  await assert.rejects(f.registered.get('bash').execute({}, { agent: f.local }), { code: 'COMMUNICATION_TOOL_NOT_ALLOWED' })
})

test('withdrawal, replacement, revoked membership and plugin teardown stop old work registrations before native side effects', async () => {
  const f = fixture(); f.define('write')
  await syncWorkTools(f.runtime, f.agent, f.bot)
  const old = f.registered.get('write')
  f.native.delete('write')
  await assert.rejects(old.execute({}, { agent: f.agent }), { code: 'COMMUNICATION_TOOL_NOT_ALLOWED' })
  assert.equal(f.calls.length, 0)
  f.define('write'); await syncWorkTools(f.runtime, f.agent, f.bot)
  const current = f.registered.get('write')
  f.runtime.toolProvenance = async () => { throw Object.assign(Error('unknown source'), { code: 'COMMUNICATION_INPUT_SOURCE_UNKNOWN' }) }
  await assert.rejects(current.execute({}, { agent: f.agent }), { code: 'COMMUNICATION_INPUT_SOURCE_UNKNOWN' })
  assert.equal(f.calls.length, 0)
  f.runtime.authorize = async () => { throw Object.assign(Error('revoked'), { code: 'MEMBERSHIP_REVOKED' }) }
  await assert.rejects(current.execute({}, { agent: f.agent }), { code: 'MEMBERSHIP_REVOKED' })
  assert.equal(f.calls.length, 0)
  for (const dispose of f.runtime.disposers) dispose()
  await assert.rejects(current.execute({}, { agent: f.agent }), { code: 'COMMUNICATION_TOOL_NOT_ALLOWED' })
})

test('work uses the Bot folder or team fallback and follows its current permission without granting escalation', async () => {
  const f = fixture(); let requested = '/bot', permission = 'danger-full-access'
  const changes = []
  Object.assign(f.runtime.rt, { workDirOf: () => requested, teamFolder: () => '/team', isFolder: async path => path !== '/missing' })
  assert.equal(await botWorkDirectory(f.runtime.rt, f.bot), '/bot')
  requested = '/missing'; assert.equal(await botWorkDirectory(f.runtime.rt, f.bot), '/team')
  f.runtime.ctx.get = () => ({ catalog: () => ({ defaultPreset: 'workspace-write' }), current: () => permission,
    set: (session, name) => { assert.equal(session, f.agent.session); permission = name; changes.push(name) } })
  syncWorkPermission(f.runtime, f.agent, f.bot)
  assert.equal(permission, 'read-only')
  delete f.bot.permission; syncWorkPermission(f.runtime, f.agent, f.bot)
  assert.deepEqual(changes, ['read-only', 'workspace-write'])
})

test('native work approval is held for the local Human with source and command, never answered by remote metadata', async () => {
  const f = fixture(), hooks = new Map()
  const rt = { ctx: { on: (name, fn) => hooks.set(name, fn) }, chatOwners: new Map(), groupOwners: new Map(), communication: f.runtime }
  f.runtime.workCalls = new Map([['remote:call', { code: 'test command', text: 'Test fixture', sourceMessageId: 'input' }]])
  installApprovals(rt)
  let delegated = false
  const result = hooks.get('approval/request')({ agent: f.agent, callId: 'call', toolName: 'bash', reason: 'Permission needed' }, () => { delegated = true })
  const [entry] = rt.approvalsView()
  assert.equal(entry.botId, f.bot.id); assert.equal(entry.answerable, true)
  assert.equal(entry.conversationId, 'group'); assert.equal(entry.detail.code, 'test command')
  assert.equal(delegated, false)
  rt.answerApproval(entry.id, 'reject')
  assert.equal(await result, 'rejected'); assert.deepEqual(rt.approvalsView(), [])
})

test('approval answers reject stale Hub scope or revoked epoch and never target unrelated local approvals', async () => {
  const f = fixture(), answers = []
  Object.assign(f.runtime, { settings: { hubId: 'hub' }, queue: { instanceId: 'a' }, rt: { readOnly: () => undefined, approvalsView: () => [
    { id: 'remote', sessionId: f.agent.id, answerable: true }, { id: 'own', sessionId: 'unrelated', answerable: true }],
    botOf: () => f.bot, answerApproval: (...args) => answers.push(args) }, member: () => { throw Object.assign(Error('old epoch'), { code: 'MEMBERSHIP_REVOKED' }) } })
  f.runtime.workApprovals = () => CommunicationRuntime.prototype.workApprovals.call(f.runtime)
  const scope = JSON.stringify(['hub', 'a', 'legacy'])
  const answer = input => CommunicationRuntime.prototype.answerWorkApproval.call(f.runtime, input)
  await assert.rejects(() => answer({ id: 'remote', choice: 'allow', expectedScope: 'old' }), { code: 'HUB_SELECTION_CHANGED' })
  await assert.rejects(() => answer({ id: 'own', choice: 'allow', expectedScope: scope }), { code: 'COMMUNICATION_APPROVAL_UNAVAILABLE' })
  await assert.rejects(() => answer({ id: 'remote', choice: 'allow', expectedScope: scope }), { code: 'MEMBERSHIP_REVOKED' })
  assert.deepEqual(answers, [])
  await answer({ id: 'remote', choice: 'reject', expectedScope: scope })
  assert.deepEqual(answers, [['remote', 'reject']])
})


test('revoked membership aborts owned native work and withdraws its local permission prompt', async () => {
  const f = fixture(), cancelled = []
  f.binding.sessionIds = [f.agent.id]
  f.runtime.rt.cancelApprovals = id => cancelled.push(id)
  let began
  const started = new Promise(resolve => { began = resolve })
  f.native.set('bash', { name: 'bash', output: {}, execute: async (_args, exec) => {
    began(); await new Promise(resolve => exec.signal.addEventListener('abort', resolve, { once: true }))
    assert.equal(exec.signal.aborted, true)
    return 'cancelled'
  } })
  await syncWorkTools(f.runtime, f.agent, f.bot)
  const running = f.registered.get('bash').execute({ command: 'owned test' }, { agent: f.agent, callId: 'running' })
  await started
  f.runtime.queue = { member: () => { throw Error('revoked') } }
  cancelRevokedWork(f.runtime)
  assert.equal(await running, 'cancelled')
  assert.deepEqual(cancelled, [f.agent.id]); assert.equal(f.runtime.workControllers.size, 0)
})
