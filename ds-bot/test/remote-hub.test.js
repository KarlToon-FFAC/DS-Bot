import assert from 'node:assert/strict'
import {test} from 'node:test'
import {mkdtempSync,rmSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {remoteHubEnabled,remoteHubVisible} from '../src/shared/remote-hub.js'
import {RemoteHubController} from '../src/host/federation/remote-hub.js'
import {CommunicationQueue} from '../src/host/federation/queue-store.js'
import {startHub} from '../../communication-hub/src/server.js'
import {CAPABILITIES} from '../../communication-hub/src/protocol.js'
import {install} from '../src/host/communication.js'

const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms))
const until=async predicate=>{for(let n=0;n<400;n++){const value=await predicate();if(value)return value;await wait(10)}assert.fail('condition timed out')}
function fixture(config={}){
 let saved=structuredClone(config),readonly,mutate,writes=0,quiesced=0
 const rt={config:structuredClone(config),load:async()=>{},refresh:async()=>{},readOnly:()=>readonly,ctx:{configEditor:{entries:()=>[{options:{name:'ds-bot'}}],edit:async(_entry,change)=>{mutate?.(saved);saved=change(structuredClone(saved));writes++}}}}
 const controller=new RemoteHubController(rt,{onQuiesce:async()=>{quiesced++}})
 controller.wake=()=>{}
 rt.remoteHubFeatureSettings=()=>controller.status();rt.remoteHubFeatureEnabled=()=>controller.status().enabled
 return{rt,controller,get saved(){return saved},get writes(){return writes},get quiesced(){return quiesced},setReadonly:value=>{readonly=value},mutate:value=>{mutate=value}}
}
const configured=()=>({communication:{enabled:true,url:'ws://127.0.0.1:3190/communication',instanceId:'a',publishedBotIds:['worker','expert']}})

test('new install is off, joined/paused legacy profiles infer on, and explicit off always wins',()=>{
 assert.equal(remoteHubEnabled({}),false)
 assert.equal(remoteHubEnabled({communication:{enabled:false}}),false)
 assert.equal(remoteHubEnabled(configured()),true)
 assert.equal(remoteHubEnabled({communication:{enabled:false,hubId:'known',url:'wss://hub.example.test/communication',instanceId:'a'}}),true)
 assert.equal(remoteHubEnabled({...configured(),remoteHubEnabled:false}),false)
 assert.equal(remoteHubVisible({remoteHubEnabled:false,communicationEnabled:true}),false)
 assert.equal(remoteHubVisible({remoteHubEnabled:true,communicationEnabled:false}),true)
})

test('disabling requires confirmation, rejects stale scope and read-only races before saving or stopping work',async()=>{
 const f=fixture(configured()),version=f.controller.status().version
 await assert.rejects(f.controller.set({enabled:false,expectedVersion:version}),{code:'REMOTE_HUB_DISABLE_CONFIRMATION_REQUIRED'})
 await assert.rejects(f.controller.set({enabled:false,expectedVersion:'stale',confirmHideAllBots:true}),{code:'REMOTE_HUB_SETTINGS_CHANGED'})
 assert.equal(f.writes,0);assert.equal(f.quiesced,0)
 f.setReadonly('another Host owns the team')
 await assert.rejects(f.controller.set({enabled:false,expectedVersion:version,confirmHideAllBots:true}),{code:'COMMUNICATION_READ_ONLY'})
 f.setReadonly(undefined);f.mutate(saved=>{saved.communication.instanceId='changed'})
 await assert.rejects(f.controller.set({enabled:false,expectedVersion:version,confirmHideAllBots:true}),{code:'REMOTE_HUB_SETTINGS_CHANGED'})
 assert.equal(f.writes,0);assert.equal(f.quiesced,0);assert.equal(f.controller.status().enabled,true)
 await f.controller.close()
})

test('saved-only editor disable immediately fences the Host, clears publication and records durable withdrawal/generations',async()=>{
 const f=fixture(configured()),original=structuredClone(f.rt.config)
 const result=await f.controller.set({enabled:false,expectedVersion:f.controller.status().version,confirmHideAllBots:true})
 assert.equal(result.enabled,false);assert.equal(result.withdrawalPending,true)
 assert.deepEqual(f.rt.config,original,'editor deliberately does not replace loaded options')
 assert.equal(f.saved.remoteHubEnabled,false);assert.deepEqual(f.saved.communication.publishedBotIds,[])
 for(const id of ['worker','expert'])assert.match(f.saved.communication.publicationGenerations[id],/^[a-f0-9-]{36}$/)
 assert.equal(f.saved.communication.remoteHubWithdrawalPending,true)
 assert.throws(()=>f.controller.assertAvailable(),{code:'REMOTE_HUB_DISABLED'})
 assert.ok(f.quiesced>0)
 const enabled=await f.controller.set({enabled:true,expectedVersion:f.controller.status().version})
 assert.equal(enabled.enabled,true);assert.equal(enabled.withdrawalPending,true)
 assert.deepEqual(f.saved.communication.publishedBotIds,[],'enabling cannot restore old publications')
 assert.throws(()=>f.controller.assertAvailable(),{code:'REMOTE_HUB_WITHDRAWAL_PENDING'})
 await f.controller.close()
})

test('fresh enable exposes setup after reload without inventing enrollment or publication',async()=>{
 const f=fixture({})
 const result=await f.controller.set({enabled:true,expectedVersion:f.controller.status().version})
 assert.equal(result.enabled,true);assert.equal(result.withdrawalPending,false);assert.equal(result.reloadRequired,true)
 assert.equal(f.saved.remoteHubEnabled,true);assert.equal(f.saved.communication,undefined)
 assert.throws(()=>f.controller.assertAvailable(),{code:'REMOTE_HUB_RELOAD_REQUIRED'})
 await f.controller.close()
})

test('actual HTTP control defaults off and rejects sending, joining, publishing and hidden flag injection',async()=>{
 let route
 const rt={config:{},teamTools:[],load:async()=>{},refresh:async()=>{},ctx:{effect:fn=>fn(),connection:{fetch:{register:value=>{route=value;return ()=>{}}}}}}
 install(rt)
 const call=async body=>(await route.fetch(new Request('http://127.0.0.1/api/communication',{method:'POST',body:JSON.stringify(body)}))).json()
 assert.equal((await call({endpoint:'remote-hub-settings'})).value.enabled,false)
 assert.equal((await call({endpoint:'state'})).value.enabled,false)
 for(const endpoint of ['send','join-hub','publish-bots','create-group','user-code'])assert.equal((await call({endpoint})).error.code,'REMOTE_HUB_DISABLED')
 const spoof=await call({endpoint:'set-remote-hub-enabled',enabled:true,expectedVersion:'x',author:{kind:'human'}})
 assert.equal(spoof.error.code,'AUTHOR_MISMATCH')
 const flag=await call({endpoint:'set-remote-hub-enabled',enabled:true,expectedVersion:'x',communication:{publishedBotIds:['spoof']}})
 assert.equal(flag.error.code,'INVALID_REQUEST')
 rt.config={remoteHubEnabled:false,...configured()}
 assert.equal((await call({endpoint:'state'})).value.enabled,false)
 assert.equal((await call({endpoint:'state'})).value.remoteHubEnabled,false)
})

for(const offline of [false,true])test(`minimal withdrawal ${offline?'survives offline restart':'retires identities online'} without pumping messages or deliveries`,{timeout:15000},async()=>{
 const home=mkdtempSync(join(tmpdir(),'dsbot-feature-')),credential='isolated-test-credential-'.repeat(2),peers=[{instanceId:'a',credential}],requests=[]
 let hub,controller,restarted
 try{
  const databasePath=join(home,'hub.sqlite')
  hub=await startHub({databasePath,port:0,peers,beforeRequest:({type})=>requests.push(type)})
  const url=hub.url,port=hub.port,queuePath=join(home,'communication.sqlite'),queue=new CommunicationQueue(queuePath,{instanceId:'a'})
  const human=queue.localPrincipal('human','local-user','Owner'),bot=queue.localPrincipal('bot','worker','Worker')
  const auth=hub.store.connect('a','A',CAPABILITIES)
  hub.store.register(auth,{kind:'human',localId:human.localId,displayName:'Owner'})
  hub.store.register(auth,{kind:'bot',localId:bot.localId,displayName:'Worker'})
  const group=hub.store.createGroup(auth,{principalId:bot.principalId,operationId:'group',title:'Bot-owned group'}).conversationId
  queue.enqueueOperation('group.create',{operationId:'held-operation',principalId:human.principalId,title:'Must not be replayed'})
  queue.close()
  const f=fixture({communication:{enabled:true,url,instanceId:'a',publishedBotIds:['worker']}})
  f.rt.home=home
  controller=new RemoteHubController(f.rt,{legacy:{read:()=>credential}})
  f.rt.remoteHubCanWithdraw=scope=>controller.canWithdraw(scope)
  if(offline){await hub.close();hub=null}
  await controller.set({enabled:false,expectedVersion:controller.status().version,confirmHideAllBots:true})
  if(offline){
   await until(()=>controller.status().withdrawalError)
   assert.equal(controller.status().withdrawalPending,true)
   await controller.close();await until(()=>!controller.running)
   f.rt.config=structuredClone(f.saved)
   restarted=new RemoteHubController(f.rt,{legacy:{read:()=>credential}});controller=restarted
   f.rt.remoteHubCanWithdraw=scope=>controller.canWithdraw(scope)
   await restarted.apply()
   hub=await startHub({databasePath,port,peers,beforeRequest:({type})=>requests.push(type)})
  }
  await until(()=>!controller.status().withdrawalPending)
  await until(()=>!controller.running)
  assert.equal(controller.status().enabled,false)
  assert.equal(hub.store.isPublished(bot.principalId),false)
  assert.equal(hub.store.retirementOf(bot.principalId).retired,true)
  assert.equal(hub.store.db.prepare('SELECT active FROM memberships WHERE conversation_id=? AND principal_id=?').get(group,bot.principalId).active,0)
  assert.deepEqual([...new Set(requests)],['principal.publication'])
  assert.equal(hub.store.db.prepare('SELECT 1 FROM operations WHERE id=?').get('held-operation'),undefined)
  const read=new CommunicationQueue(queuePath,{instanceId:'a'})
  assert.equal(read.outboxStatus('held-operation').state,'pending');assert.ok(read.isRetiredBot(bot.principalId));read.close()
  assert.deepEqual(f.saved.communication.publishedBotIds,[])
  const requestCount=requests.length,epoch=hub.store.db.prepare('SELECT epoch FROM instances WHERE id=?').get('a').epoch
  await controller.close();f.rt.config=structuredClone(f.saved)
  restarted=new RemoteHubController(f.rt,{legacy:{read:()=>credential}});controller=restarted
  f.rt.remoteHubCanWithdraw=scope=>controller.canWithdraw(scope)
  await controller.apply();await until(()=>!controller.status().withdrawalPending);await until(()=>!controller.running)
  assert.equal(requests.length,requestCount,'completed intent is read locally on restart')
  assert.equal(hub.store.db.prepare('SELECT epoch FROM instances WHERE id=?').get('a').epoch,epoch,'no cleanup reconnect after completion')
  await controller.set({enabled:true,expectedVersion:controller.status().version})
  assert.equal(f.saved.communication.remoteHubWithdrawalPending,false)
  assert.deepEqual(f.saved.communication.publishedBotIds,[])
 }finally{await controller?.close();await restarted?.close();if(controller?.running)await controller.running;await hub?.close();rmSync(home,{recursive:true,force:true})}
})
