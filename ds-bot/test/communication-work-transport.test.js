import assert from 'node:assert/strict'
import {test} from 'node:test'
import {Context} from '@deepseek-ai/cordis'
import {createScope} from '@deepseek-ai/dsh-scope'
import ToolRuntime,{defineTool} from '@deepseek-ai/dsh-tools'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import {output} from '../src/host/tools.js'
import {CommunicationRuntime} from '../src/host/federation/runtime.js'
import {syncWorkTools,workToolWarnings} from '../src/host/federation/work-tools.js'

test('real DSH PTC owner transport is not registered as a remote work capability',async t=>{
 const ctx=new Context();t.after(async()=>ctx.fiber.dispose())
 await ctx.plugin(SystemPrompt);await ctx.plugin(ToolRuntime)
 let checked=false
 await ctx.plugin({inject:['tools','systemPrompt'],async apply(inner){
  const local={id:'local',session:{id:'local'}},remote={id:'remote',session:{id:'remote'}},bot={id:'bot'}
  const localScope=createScope(inner,local),remoteScope=createScope(inner,remote)
  local.ctx=localScope.ctx;remote.ctx=remoteScope.ctx
  t.after(async()=>{await remoteScope.dispose();await localScope.dispose()})
  local.ctx.tools.presentAs('ptc')
  const capability=defineTool({name:'read_probe',description:'Owned test capability',parameters:{},output,execute:async()=> 'owned'})
  local.ctx.tools.register(capability)
  assert.ok(inner.tools.schemas(local).some(row=>row.name==='run_code'))
  const runtime={ctx:inner,rt:{chatOf:()=>local.id,resolveAgent:async()=>local},disposers:[],owners:new Map([[remote.id,{id:'binding',localBotRef:bot.id,conversationId:'group'}]]),tools:[]}
  t.after(()=>{for(const dispose of runtime.disposers)dispose()})
  assert.deepEqual(await syncWorkTools(runtime,remote,bot),['read_probe'])
  assert.equal(inner.tools.get('run_code',remote),undefined,'native remote does not borrow the owner transport')
  assert.equal(inner.tools.get('read_probe',remote).description,'Owned test capability')
  await syncWorkTools(runtime,remote,bot)
  remote.ctx.tools.presentAs('ptc')
  assert.ok(inner.tools.get('run_code',remote),'DSH provides the remote transport itself')
  assert.deepEqual(await syncWorkTools(runtime,remote,bot),['read_probe'])
  checked=true
 }})
 assert.equal(checked,true)
})

test('normal mode distinguishes a foreign scoped capability conflict and retries after its owner releases it',async t=>{
 const ctx=new Context();t.after(async()=>ctx.fiber.dispose())
 await ctx.plugin(SystemPrompt);await ctx.plugin(ToolRuntime)
 let checked=false
 await ctx.plugin({inject:['tools','systemPrompt'],async apply(inner){
  const local={id:'local',session:{id:'local'}},remote={id:'remote',session:{id:'remote'}},bot={id:'bot'}
  const localScope=createScope(inner,local),remoteScope=createScope(inner,remote)
  local.ctx=localScope.ctx;remote.ctx=remoteScope.ctx
  t.after(async()=>{await remoteScope.dispose();await localScope.dispose()})
  const capability=defineTool({name:'read_probe',description:'Owned test capability',parameters:{},output,execute:async()=> 'owned'})
  local.ctx.tools.register(capability)
  let foreignExecutions=0
  const foreign={...capability,description:'Another plugin owns this scope',execute:async()=>{foreignExecutions++;return 'must not run'}}
  const release=remote.ctx.tools.register(foreign)
  assert.equal(inner.tools.modeFor(local),'native');assert.equal(inner.tools.modeFor(remote),'native')
  const runtime={ctx:inner,rt:{chatOf:()=>local.id,resolveAgent:async()=>local},disposers:[],owners:new Map([[remote.id,{id:'binding',localBotRef:bot.id,conversationId:'group'}]]),tools:[]}
  t.after(()=>{for(const dispose of runtime.disposers)dispose()})
  assert.deepEqual(await syncWorkTools(runtime,remote,bot),[])
  assert.equal(workToolWarnings(runtime)[0].toolName,'read_probe')
  assert.equal(workToolWarnings(runtime)[0].registrationFailure,'scope-conflict')
  assert.equal(inner.tools.get('read_probe',remote),foreign,'never remove an unowned registration')
  runtime.rt.botOf=()=>bot
  Object.assign(runtime,{scoped:new WeakSet(),syncWorkContext:()=>syncWorkTools(runtime,remote,bot)})
  CommunicationRuntime.prototype.scope.call(runtime,remote)
  const assembled=await inner.systemPrompt.assemble({scope:remote,agent:remote})
  assert.equal(assembled.tools.some(tool=>tool.name==='read_probe'),false,'conflicting capabilities are not advertised')
  const denied=await inner.tools.execute({name:'read_probe',arguments:{},agent:remote,callId:'conflict',signal:AbortSignal.timeout(5000)})
  assert.equal(denied.isError,true);assert.equal(foreignExecutions,0,'the execution guard cannot fall through to the foreign definition')
  release()
  await Promise.all(Array.from({length:20},()=>syncWorkTools(runtime,remote,bot)))
  assert.equal(inner.tools.get('read_probe',remote).description,capability.description)
  assert.deepEqual(workToolWarnings(runtime),[])
  checked=true
 }})
 assert.equal(checked,true)
})
