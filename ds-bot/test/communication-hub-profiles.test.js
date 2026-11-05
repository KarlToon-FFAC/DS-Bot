import assert from 'node:assert/strict'
import {test} from 'node:test'
import {mkdtempSync,rmSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {dirname,join,resolve,basename} from 'node:path'
import {randomUUID,verify} from 'node:crypto'
import {CommunicationOnboarding,communicationCredentialKey,communicationQueueSettings,communicationAuthentication,enrollmentSigningText} from '../src/host/federation/onboarding.js'
import {CommunicationQueue} from '../src/host/federation/queue-store.js'

const human={human:true},clone=value=>value===undefined?undefined:structuredClone(value)
const hubs=[{hubId:'hub-A',url:'wss://192.168.10.1:3190/communication'},{hubId:'hub-B',url:'wss://192.168.10.2:3190/communication'}]
const code=hub=>'dsbot-hub:1:'+Buffer.from(JSON.stringify(hub)).toString('base64url')
const joinInput=hub=>({hubCode:code(hub),displayName:'Synthetic device',confirmedHubId:hub.hubId,confirmedUrl:hub.url})
function fixture(t){
 const home=mkdtempSync(join(tmpdir(),'dsbot-hub-profile-'))
 t.after(()=>{assert.equal(dirname(resolve(home)),resolve(tmpdir()));assert.ok(basename(home).startsWith('dsbot-hub-profile-'));rmSync(home,{recursive:true,force:true})})
 const records=new Map(),writes=[],network=[]
 let failEdit=false,changeSelection=false,stops=0,starts=0,revoked=false
 const credentials={readRecord:async key=>clone(records.get(key)),listRecords:async()=>[...records].map(([key,record])=>({key,kind:record.kind})),describeRecord:async key=>({configured:records.has(key),writable:true}),modifyRecord:async(key,mutate)=>{const next=await mutate(clone(records.get(key)));if(next!==undefined)records.set(key,clone(next))}}
 const rt={home,config:{},botOf:()=>({}),ctx:{credentials,configEditor:{entries:()=>[{options:{name:'ds-bot'}}],edit:async(_entry,mutate)=>{
  if(failEdit)throw Object.assign(Error('synthetic edit failure'),{code:'STORAGE_UNAVAILABLE'})
  if(changeSelection)rt.config.communication={...rt.config.communication,hubId:'concurrent-Hub'}
  rt.config=mutate(clone(rt.config));writes.push(clone(rt.config))
 }}}}
 const activate=()=>{rt.communication={settings:clone(rt.config.communication),transport:{running:true,stop(){stops++;this.running=false},start(){starts++;this.running=true}}}}
 const connect=async url=>{
  const hub=hubs.find(item=>item.url===url);assert.ok(hub);let challenge
  return {close(){},request:async(type,input)=>{
   network.push({hubId:hub.hubId,type})
   if(type==='enrollment.challenge'){
    if(revoked&&input.purpose!=='join')throw Object.assign(Error('synthetic revoke'),{code:'UNAUTHENTICATED'})
    challenge={hubId:hub.hubId,purpose:input.purpose,challengeId:randomUUID(),nonce:'N'.repeat(32),expiresAt:Date.now()+30000,...(input.purpose==='login'?{instanceId:input.instanceId}:{requestId:input.requestId??randomUUID()})};return challenge
   }
   const record=records.get(communicationCredentialKey(hub.hubId)).payload
   assert.equal(verify(null,Buffer.from(enrollmentSigningText(challenge)),record.publicKey,Buffer.from(input.signature,'base64url')),true)
   return {hubId:hub.hubId,requestId:challenge.requestId,status:'approved',instanceId:'shared-instance'}
  }}
 }
 let onboarding=new CommunicationOnboarding(rt,{connect})
 return {rt,records,writes,network,activate,get api(){return onboarding},restart(){onboarding=new CommunicationOnboarding(rt,{connect})},set failEdit(value){failEdit=value},set changeSelection(value){changeSelection=value},set revoked(value){revoked=value},get stops(){return stops},get starts(){return starts}}
}

test('one active Hub retains distinct queues, keys and outbox across same-Hub rejoin and A/B/A selection',async t=>{
 const f=fixture(t),[a,b]=hubs
 const first=await f.api.handle('join',joinInput(a),human);f.activate()
 f.rt.config.communication.publishedBotIds=['local-Bot'];f.rt.config.communication.humanDisplayName='Name on A'
 const original=await communicationQueueSettings(f.rt,communicationCredentialKey(a.hubId),f.rt.config.communication)
 assert.equal(original.queueScope,'legacy')
 const queue=new CommunicationQueue(original.dataPath,{instanceId:first.instanceId});queue.enqueueOperation('group.create',{operationId:'retained-operation',title:'Queued on A'});queue.close()
 const keyA=f.records.get(communicationCredentialKey(a.hubId)).payload.publicKey
 const paused=await f.api.handle('disconnect-hub',{hubId:a.hubId},human)
 assert.equal(paused.localOnly,true);assert.equal(f.rt.config.communication.enabled,false)
 const writes=f.writes.length
 const status=await f.api.handle('status',{hubId:a.hubId},human)
 assert.equal(status.paused,true);assert.equal(f.writes.length,writes,'read-only approval status cannot reactivate a paused queue')
 await assert.rejects(f.api.handle('resume-hub',{hubId:a.hubId,confirmedUrl:a.url},human),{code:'HUB_RESUME_CONFIRMATION_REQUIRED'})
 f.restart();await f.api.handle('resume-hub',{hubId:a.hubId,confirmedUrl:a.url,confirmResume:true},human)
 assert.equal(f.rt.config.communication.enabled,true)
 assert.equal(f.records.get(communicationCredentialKey(a.hubId)).payload.publicKey===keyA,true)
 await f.api.handle('switch-hub',{...joinInput(b),expectedCurrentHubId:a.hubId},human)
 assert.equal(f.rt.config.communication.enabled,false);assert.equal(f.rt.config.communication.hubId,b.hubId)
 assert.deepEqual(f.rt.config.communication.publishedBotIds,[],'new Hub inherits no publication grants')
 assert.equal(f.rt.config.communication.credentialEnv,undefined)
 assert.equal(f.network.some(item=>item.hubId===b.hubId),false,'selection does not join or send')
 const second=await f.api.handle('join',joinInput(b),human)
 const other=await communicationQueueSettings(f.rt,communicationCredentialKey(b.hubId),f.rt.config.communication)
 assert.notEqual(original.dataPath,other.dataPath,'even identical instance IDs at different Hubs get distinct databases')
 assert.equal(f.records.get(communicationCredentialKey(b.hubId)).payload.publicKey===keyA,false)
 const newQueue=new CommunicationQueue(other.dataPath,{instanceId:second.instanceId});assert.equal(newQueue.pendingOutbox().length,0);newQueue.close()
 await f.api.handle('switch-hub',{hubId:a.hubId,confirmedHubId:a.hubId,confirmedUrl:a.url,expectedCurrentHubId:b.hubId},human)
 assert.equal(f.rt.config.communication.humanDisplayName,'Name on A');assert.deepEqual(f.rt.config.communication.publishedBotIds,['local-Bot'])
 f.restart();await f.api.handle('resume-hub',{hubId:a.hubId,confirmedUrl:a.url,confirmResume:true},human)
 const restored=await communicationQueueSettings(f.rt,communicationCredentialKey(a.hubId),f.rt.config.communication)
 assert.equal(restored.dataPath,original.dataPath)
 const retained=new CommunicationQueue(restored.dataPath,{instanceId:first.instanceId});assert.equal(retained.pendingOutbox()[0].id,'retained-operation');retained.close()
 assert.equal(f.network.filter(item=>item.hubId===a.hubId&&item.type==='enrollment.prove').length,6,'A joins once; status and fresh login proofs reconcile the same saved identity')
})

test('edit interruption leaves a durable pause; explicit resume recovers and revocation is not silently repaired',async t=>{
 const f=fixture(t),a=hubs[0];await f.api.handle('join',joinInput(a),human);f.activate();f.failEdit=true
 await assert.rejects(f.api.handle('disconnect-hub',{hubId:a.hubId},human),{code:'STORAGE_UNAVAILABLE'})
 const record=f.records.get(communicationCredentialKey(a.hubId)).payload
 assert.equal(record.paused,true);assert.equal(record.requiresResume,true);assert.ok(f.stops>0)
 let authSent=false
 await assert.rejects(communicationAuthentication(f.rt,communicationCredentialKey(a.hubId),f.rt.config.communication)(async()=>{authSent=true}),{code:'HUB_PAUSED'})
 assert.equal(authSent,false)
 f.failEdit=false;f.restart();await f.api.handle('resume-hub',{hubId:a.hubId,confirmedUrl:a.url,confirmResume:true},human)
 assert.ok(f.starts>0);assert.equal(f.records.get(communicationCredentialKey(a.hubId)).payload.paused,false)
 await f.api.handle('disconnect-hub',{hubId:a.hubId},human);f.revoked=true
 await assert.rejects(f.api.handle('resume-hub',{hubId:a.hubId,confirmedUrl:a.url,confirmResume:true},human),{code:'UNAUTHENTICATED'})
 assert.equal(f.rt.config.communication.enabled,false);assert.equal(f.records.get(communicationCredentialKey(a.hubId)).payload.paused,true)
})

test('stale selectors, non-Humans and tampered/unbound queue namespaces cannot switch identities or touch another database',async t=>{
 const f=fixture(t),[a,b]=hubs;await f.api.handle('join',joinInput(a),human);f.activate()
 for(const action of ['disconnect-hub','switch-hub','resume-hub'])await assert.rejects(f.api.handle(action,{}, {human:true,agent:{}}),{code:'HUMAN_REQUIRED'})
 await assert.rejects(f.api.handle('switch-hub',{...joinInput(b),expectedCurrentHubId:'stale'},human),{code:'HUB_SELECTION_CHANGED'})
 f.changeSelection=true
 await assert.rejects(f.api.handle('switch-hub',{...joinInput(b),expectedCurrentHubId:a.hubId},human),{code:'HUB_SELECTION_CHANGED'})
 assert.equal(f.rt.config.communication.hubId,'concurrent-Hub')
 const key=communicationCredentialKey(a.hubId),record=f.records.get(key)
 record.payload.queueScope='../../another-Hub'
 await assert.rejects(communicationQueueSettings(f.rt,key,{...a,instanceId:'shared-instance'}),{code:'COMMUNICATION_CREDENTIAL_MISMATCH'})
})

test('interrupted resume requires explicit reconciliation and status cannot finish activation',async t=>{
 const f=fixture(t),a=hubs[0]
 await f.api.handle('join',joinInput(a),human);f.activate()
 await f.api.handle('disconnect-hub',{hubId:a.hubId},human)
 f.failEdit=true
 await assert.rejects(f.api.handle('resume-hub',{hubId:a.hubId,confirmedUrl:a.url,confirmResume:true},human),{code:'STORAGE_UNAVAILABLE'})
 assert.equal(f.rt.config.communication.enabled,false)
 assert.equal(f.records.get(communicationCredentialKey(a.hubId)).payload.requiresResume,true)
 f.failEdit=false;f.restart()
 const writes=f.writes.length
 assert.equal((await f.api.handle('status',{hubId:a.hubId},human)).paused,true)
 assert.equal(f.writes.length,writes)
 await f.api.handle('resume-hub',{hubId:a.hubId,confirmedUrl:a.url,confirmResume:true},human)
 assert.equal(f.records.get(communicationCredentialKey(a.hubId)).payload.requiresResume,false)
 assert.equal(f.rt.config.communication.enabled,true)
})

test('legacy static pairing can pause/resume its exact address but cannot be guessed into another Hub',async t=>{
 const f=fixture(t),a=hubs[0]
 f.rt.config.communication={enabled:true,url:a.url,instanceId:'legacy',credentialEnv:'PRIVATE_LAUNCH_ONLY'};f.activate()
 await assert.rejects(f.api.handle('disconnect-hub',{confirmedUrl:hubs[1].url},human),{code:'HUB_CONFIRMATION_REQUIRED'})
 await f.api.handle('disconnect-hub',{confirmedUrl:a.url},human)
 assert.equal(f.rt.config.communication.enabled,false)
 assert.equal(f.records.size,0)
 await assert.rejects(f.api.handle('switch-hub',joinInput(hubs[1]),human),{code:'LEGACY_HUB_SWITCH_REQUIRES_REENROLLMENT'})
 await f.api.handle('resume-hub',{confirmedUrl:a.url,confirmResume:true},human)
 assert.equal(f.rt.config.communication.enabled,true)
 assert.equal(f.rt.config.communication.credentialEnv,'PRIVATE_LAUNCH_ONLY')
 assert.equal(f.network.length,0,'no identity guessed or new key generated')
})
