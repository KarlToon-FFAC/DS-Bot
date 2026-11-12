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
  assert.equal(await f.registered.get('bash').execute({ run_in_background: true }, { agent: f.agent }), 'work completed')
  assert.equal(f.calls.at(-1).args.run_in_background, true)
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

test('explicit remote confirmation asks before native effects, preserves exact arguments and distinguishes owner rejection',async()=>{
 const f=fixture();f.runtime.settings={remoteWorkApproval:'ask'}
 f.define('write');f.define('read');f.define('bash')
 let answer,ask=0
 f.runtime.ctx.get=name=>name==='approval'?{request:async request=>{ask++;assert.equal(request.agent,f.agent);assert.equal(request.toolName,'write');assert.equal(f.runtime.workCalls.get('remote:call').sourceMessageId,'input');return new Promise(resolve=>{answer=resolve})}}:undefined
 await syncWorkTools(f.runtime,f.agent,f.bot)
 const args={path:'approved.txt',content:'approved'}
 const pending=f.registered.get('write').execute(args,{agent:f.agent,callId:'call'})
 for(let n=0;n<10&&!answer;n++)await new Promise(resolve=>setTimeout(resolve,0))
 assert.equal(ask,1);assert.equal(f.calls.length,0)
 args.path='unapproved.txt';answer('allowed-once')
 assert.equal(await pending,'work completed');assert.equal(f.calls[0].args.path,'approved.txt')
 f.runtime.ctx.get=()=>({request:async()=> 'rejected'})
 await assert.rejects(f.registered.get('write').execute({path:'no.txt'},{agent:f.agent,callId:'next'}),{code:'WORK_APPROVAL_REJECTED'})
 assert.equal(f.calls.length,1)
 await f.registered.get('read').execute({path:'read.txt'},{agent:f.agent,callId:'read'})
 assert.equal(f.calls.length,2)
 f.runtime.ctx.get=()=>undefined
 await assert.rejects(f.registered.get('bash').execute({command:'echo denied'},{agent:f.agent,callId:'shell'}),{code:'WORK_APPROVAL_UNAVAILABLE'})
 assert.equal(f.calls.length,2)
})

test('a one-shot confirmation cannot survive a membership revocation while the owner is deciding',async()=>{
 const f=fixture();f.runtime.settings={remoteWorkApproval:'ask'};f.define('write')
 let decide
 f.runtime.ctx.get=()=>({request:()=>new Promise(resolve=>{decide=resolve})})
 await syncWorkTools(f.runtime,f.agent,f.bot)
 const result=f.registered.get('write').execute({file_path:'not-created.txt',content:'no'},{agent:f.agent,callId:'call'})
 for(let n=0;n<10&&!decide;n++)await new Promise(resolve=>setTimeout(resolve,0))
 f.runtime.authorize=async()=>{throw Object.assign(Error('revoked'),{code:'MEMBERSHIP_REVOKED'})}
 decide('allowed-once')
 await assert.rejects(result,{code:'MEMBERSHIP_REVOKED'});assert.equal(f.calls.length,0)
 assert.equal(f.runtime.workCalls.size,0)
})

test('explicit confirmation exposes the full redacted command instead of approving a silently truncated script',async()=>{
 const f=fixture();f.runtime.settings={remoteWorkApproval:'ask'};f.define('bash')
 const command='echo '+ 'x'.repeat(2500) + '; echo visible-tail'
 f.runtime.ctx.get=()=>({request:async()=>{
  assert.equal(f.runtime.workCalls.get('remote:long').code,command)
  return 'rejected'
 }})
 await syncWorkTools(f.runtime,f.agent,f.bot)
 await assert.rejects(f.registered.get('bash').execute({command},{agent:f.agent,callId:'long'}),{code:'WORK_APPROVAL_REJECTED'})
 assert.equal(f.calls.length,0)
})


test('remote scopes inherit the owning Bot native and MCP catalog, including exact history reads, and lose withdrawn tools',async()=>{
 const f=fixture()
 for(const name of ['read','session_event_read','session_search','mcp_project_lookup','write','workflow','create_goal','ask_user_question','create_bot'])f.define(name)
 f.runtime.rt.teamTools=[{name:'create_bot'}]
 f.runtime.ctx.tools.schemas=scope=>{assert.equal(scope,f.local);return [...f.native.values()].map(({name})=>({name}))}
 const names=await syncWorkTools(f.runtime,f.agent,f.bot)
 assert.deepEqual(names,['read','session_event_read','session_search','mcp_project_lookup','write'])
 await f.registered.get('session_event_read').execute({session_id:'local',seq:42},{agent:f.agent,callId:'history'})
 assert.deepEqual(f.calls[0].args,{session_id:'local',seq:42})
 assert.equal(f.calls[0].agent,f.agent,'native policy sees the actual remote Session')
 const stale=f.registered.get('mcp_project_lookup');f.native.delete('mcp_project_lookup')
 await syncWorkTools(f.runtime,f.agent,f.bot)
 assert.equal(f.registered.has('mcp_project_lookup'),false)
 await assert.rejects(stale.execute({}, {agent:f.agent,callId:'stale'}),{code:'COMMUNICATION_TOOL_NOT_ALLOWED'})
})


test('inherited schedule tools target the owning local Bot so future tasks never impersonate Hub inputs',async()=>{
 const f=fixture();f.define('schedule_create');f.define('schedule_list')
 f.runtime.ctx.tools.schemas=()=>[...f.native.values()].map(({name})=>({name}))
 await syncWorkTools(f.runtime,f.agent,f.bot)
 await f.registered.get('schedule_create').execute({prompt:'Synthetic scheduled task'}, {agent:f.agent,callId:'schedule'})
 assert.equal(f.calls[0].agent,f.local)
 assert.equal(f.calls[0].args.prompt,'Synthetic scheduled task')
 assert.match(f.registered.get('schedule_list').description,/own local chat/)
})
