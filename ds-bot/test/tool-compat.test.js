import assert from 'node:assert/strict'
import {test} from 'node:test'
import {Context} from '@deepseek-ai/cordis'
import {createScope} from '@deepseek-ai/dsh-scope'
import Tools,{defineTool} from '@deepseek-ai/dsh-tools'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import {admittedSubset,batchTools,install} from '../src/host/tool-compat.js'
import {output} from '../src/host/tools.js'
import {executeOne,mountToolExecutor} from './tool-sdk-fixture.js'

test('an admitted subset never widens a frozen, expired or foreign step',()=>{
 const agent={},other={},definition={name:'read'},registry={definitions:()=>[definition],executable:()=>undefined}
 const empty={view:()=>new Map()}
 assert.equal(admittedSubset(registry,agent,empty,()=>true).view(agent).size,0)
 assert.equal(admittedSubset(registry,agent,undefined,()=>true).view(agent).size,0,'conditional registrations require actual admission')
 const original={view:()=>new Map([['read',definition]])}
 const subset=admittedSubset(registry,agent,original,()=>true)
 assert.equal(subset.view(other).size,0)
 assert.equal(subset.view(agent).get('read'),definition)
 subset.dispose()
 assert.equal(subset.view(agent).size,0)
 assert.equal(admittedSubset(registry,agent,original,()=>false).view(agent).size,0)
})

for(const mode of ['native','ptc'])test(`DSH batch ${mode} presentation preserves scope admission and denies forbidden execution`,async t=>{
 const ctx=new Context()
 t.after(()=>ctx.fiber.dispose())
 await ctx.plugin(SystemPrompt)
 await ctx.plugin(Tools)
 if(!batchTools(ctx.tools)){t.skip('0.2.1 keeps its existing scoped executor');return}
 if(mode==='native')await mountToolExecutor(ctx)
 else {ctx.provide('ptcRuntime',{language:'typescript'});await ctx.plugin(await import('@deepseek-ai/dsh-tool-executor-ptc'))}
 await ctx.plugin({inject:['tools','systemPrompt'],async apply(inner){
  const agent={id:'owned',session:{id:'owned'}},scope=createScope(inner,agent)
  agent.ctx=scope.ctx
  t.after(()=>scope.dispose())
  let executed=0
  const definition=name=>defineTool({name,description:name,parameters:{},output,execute:async()=>{executed++;return {type:'text',text:name}}})
  inner.tools.register(definition('allowed'))
  inner.tools.register(definition('forbidden'))
  inner.tools.register(definition('conditional'),{when:()=>false})
  const rt={ctx:inner,isBotSession:id=>id===agent.id,botToolAllowed:name=>name!=='forbidden'}
  install(rt)
  let release,entered
  const gate=new Promise(resolve=>{release=resolve}),arrived=new Promise(resolve=>{entered=resolve})
  const unhook=inner.on('system-prompt/assemble',async(_value,_context,next)=>{entered();await gate;return next()})
  const first=rt.ensureBotToolExecutor(agent)
  await arrived
  let ready=false
  const second=rt.ensureBotToolExecutor(agent).then(()=>{ready=true})
  await Promise.resolve();assert.equal(ready,false,'concurrent input must wait for the scoped executor')
  release();await Promise.all([first,second]);unhook()
  const assembly=await inner.systemPrompt.assemble({scope:agent,agent})
  if(mode==='native'){
   assert.ok(assembly.tools.some(tool=>tool.name==='allowed'))
   assert.ok(!assembly.tools.some(tool=>tool.name==='forbidden'))
  }else{
   assert.ok(assembly.tools.some(tool=>tool.name==='run_code'))
   assert.ok(assembly.sections.some(section=>section.text.includes('allowed')))
   assert.ok(!assembly.sections.some(section=>section.text.includes('forbidden')))
  }
  const signal=new AbortController().signal
  const admitted=await inner.tools.resolve({agent,signal})
  try{
   const selected=admittedSubset(inner.tools,agent,admitted,rt.botToolAllowed)
   assert.equal(selected.view(agent).has('conditional'),false)
   if(mode==='native'){
    const denied=await executeOne(inner.tools,{name:'forbidden',arguments:{},agent,signal,callId:'denied',toolSet:admitted})
    assert.ok(JSON.stringify(denied).includes('UNKNOWN_TOOL'))
    assert.equal(executed,0)
    await executeOne(inner.tools,{name:'allowed',arguments:{},agent,signal,callId:'ok',toolSet:admitted})
    assert.equal(executed,1)
   }
   const remove=inner.tools.register(definition('removed'))
   const refreshed=await inner.tools.resolve({agent,signal})
   const frozen=admittedSubset(inner.tools,agent,refreshed,rt.botToolAllowed)
   remove()
   assert.equal(frozen.view(agent).has('removed'),false,'removed registrations cannot be revived')
   refreshed.dispose();frozen.dispose()
   const replacement=inner.tools.register(definition('later'))
   assert.equal(selected.view(agent).has('later'),false,'new registration cannot enter an earlier step')
   replacement()
   selected.dispose()
  }finally{admitted.dispose()}
 }})
})

test('a conflicting Session executor is not overwritten and a fresh scope can recover',async t=>{
 const ctx=new Context();t.after(()=>ctx.fiber.dispose())
 await ctx.plugin(SystemPrompt);await ctx.plugin(Tools)
 if(!batchTools(ctx.tools)){t.skip('0.2.2 executor API');return}
 await mountToolExecutor(ctx)
 await ctx.plugin({inject:['tools','systemPrompt'],async apply(inner){
  const agent={id:'conflict',session:{id:'conflict'}},scope=createScope(inner,agent)
  agent.ctx=scope.ctx;t.after(()=>scope.dispose())
  const {NativeToolExecutor}=await import('@deepseek-ai/dsh-tool-executor-native')
  const release=scope.ctx.tools.setExecutor(new NativeToolExecutor(scope.ctx))
  const rt={ctx:inner,isBotSession:()=>true,botToolAllowed:()=>true}
  install(rt)
  await assert.rejects(rt.ensureBotToolExecutor(agent),{code:'BOT_TOOL_EXECUTOR_CONFLICT'})
  assert.ok(Array.isArray((await inner.systemPrompt.assemble({scope:agent,agent})).tools),'the existing provider survives rejection')
  release()
  const fresh={id:'fresh',session:{id:'fresh'}},freshScope=createScope(inner,fresh)
  fresh.ctx=freshScope.ctx;t.after(()=>freshScope.dispose())
  await rt.ensureBotToolExecutor(fresh)
  assert.ok(Array.isArray((await inner.systemPrompt.assemble({scope:fresh,agent:fresh})).tools))
 }})
})
