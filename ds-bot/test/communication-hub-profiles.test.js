import { testHubInput } from './fixtures/v2-hub-code.mjs'
import assert from 'node:assert/strict'
import {test} from 'node:test'
import {mkdtempSync,rmSync,writeFileSync,readFileSync,existsSync,mkdirSync,symlinkSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {dirname,join,resolve,basename} from 'node:path'
import {randomUUID,verify,createHash} from 'node:crypto'
import {CommunicationOnboarding,communicationCredentialKey,communicationQueueSettings,communicationAuthentication,enrollmentSigningText} from '../src/host/federation/onboarding.js'
import {CommunicationQueue} from '../src/host/federation/queue-store.js'

const human={human:true},clone=value=>value===undefined?undefined:structuredClone(value)
const hubs=[{hubId:'hub-A',url:'wss://192.168.10.1:3190/communication'},{hubId:'hub-B',url:'wss://192.168.10.2:3190/communication'}]
const joinInput=hub=>({...testHubInput(hub),displayName:'Synthetic device'})
function fixture(t){
 const home=mkdtempSync(join(tmpdir(),'dsbot-hub-profile-'))
 t.after(()=>{assert.equal(dirname(resolve(home)),resolve(tmpdir()));assert.ok(basename(home).startsWith('dsbot-hub-profile-'));rmSync(home,{recursive:true,force:true})})
 const records=new Map(),writes=[],network=[]
 let failEdit=false,changeSelection=false,stops=0,starts=0,revoked=false
 const credentials={deleteRecord:async key=>{records.delete(key)},readRecord:async key=>clone(records.get(key)),listRecords:async()=>[...records].map(([key,record])=>({key,kind:record.kind})),describeRecord:async key=>({configured:records.has(key),writable:true}),modifyRecord:async(key,mutate)=>{const next=await mutate(clone(records.get(key)));if(next!==undefined)records.set(key,clone(next))}}
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
    if(revoked&&!['join','leave','leave-status'].includes(input.purpose))throw Object.assign(Error('synthetic revoke'),{code:'UNAUTHENTICATED'})
    challenge={hubId:hub.hubId,purpose:input.purpose,challengeId:randomUUID(),nonce:'N'.repeat(32),expiresAt:Date.now()+30000,...(['login','leave','leave-status'].includes(input.purpose)?{instanceId:input.instanceId}:{requestId:input.requestId??randomUUID()})};return challenge
   }
   const record=records.get(communicationCredentialKey(hub.hubId)).payload
   assert.equal(verify(null,Buffer.from(enrollmentSigningText(challenge)),record.publicKey,Buffer.from(input.signature,'base64url')),true)
   if(['leave','leave-status'].includes(challenge.purpose)){if(challenge.purpose==='leave')revoked=true;return {instanceId:challenge.instanceId,left:revoked}}
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
 await assert.rejects(f.api.handle('resume-hub',{hubId:a.hubId,confirmedUrl:a.url,confirmedTrustFingerprint:testHubInput(a).confirmedTrustFingerprint},human),{code:'HUB_RESUME_CONFIRMATION_REQUIRED'})
 f.restart();await f.api.handle('resume-hub',{hubId:a.hubId,confirmedUrl:a.url,confirmedTrustFingerprint:testHubInput(a).confirmedTrustFingerprint,confirmResume:true},human)
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
 await f.api.handle('switch-hub',{hubId:a.hubId,confirmedHubId:a.hubId,confirmedUrl:a.url,confirmedTrustFingerprint:testHubInput(a).confirmedTrustFingerprint,expectedCurrentHubId:b.hubId},human)
 assert.equal(f.rt.config.communication.humanDisplayName,'Name on A');assert.deepEqual(f.rt.config.communication.publishedBotIds,['local-Bot'])
 f.restart();await f.api.handle('resume-hub',{hubId:a.hubId,confirmedUrl:a.url,confirmedTrustFingerprint:testHubInput(a).confirmedTrustFingerprint,confirmResume:true},human)
 const restored=await communicationQueueSettings(f.rt,communicationCredentialKey(a.hubId),f.rt.config.communication)
 assert.equal(restored.dataPath,original.dataPath)
 const retained=new CommunicationQueue(restored.dataPath,{instanceId:first.instanceId});assert.equal(retained.pendingOutbox()[0].id,'retained-operation');retained.close()
 assert.equal(f.network.filter(item=>item.hubId===a.hubId&&item.type==='enrollment.prove').length,6,'A joins once; status and fresh login proofs reconcile the same saved identity')
})

test('storage without Hub ID always lists selected state, so selecting the joined Hub is a local idempotent no-op',async t=>{
 const f=fixture(t),a=hubs[0]
 await f.api.handle('join',joinInput(a),human);f.activate()
 for(const paused of [false,true]){
  if(paused)await f.api.handle('disconnect-hub',{hubId:a.hubId},human)
  f.restart()
  const view=await f.api.handle('storage',{},human)
  assert.equal(view.selectedHub.hubId,a.hubId)
  assert.equal(view.selectedHub.enabled,!paused)
  assert.equal(view.enrollments.length,1)
  assert.equal(view.enrollments[0].paused,paused)
  const before=[f.writes.length,f.network.length],key=f.records.get(communicationCredentialKey(a.hubId)).payload.publicKey
  const result=await f.api.handle('switch-hub',{hubId:a.hubId,expectedCurrentHubId:view.selectedHub.hubId,confirmedHubId:a.hubId,confirmedUrl:a.url,confirmedTrustFingerprint:testHubInput(a).confirmedTrustFingerprint},human)
  assert.equal(result.selected,true)
  assert.deepEqual([f.writes.length,f.network.length],before,'no request, reconnect or config rewrite on same-Hub selection')
  assert.equal(f.records.get(communicationCredentialKey(a.hubId)).payload.publicKey,key)
 }
 delete f.rt.ctx.credentials.listRecords
 const fallback=await f.api.handle('storage',{},human)
 assert.equal(fallback.enrollments.length,1,'older providers can read the selected record without listing')
 assert.equal(fallback.selectedHub.hubId,a.hubId)
 const single=await f.api.handle('storage',{hubId:a.hubId},human)
 assert.equal(single.hubId,a.hubId);assert.equal(single.enrollments,undefined)
 assert.ok(!JSON.stringify(fallback).includes('PRIVATE KEY'))
})

test('missing saved identity and stale UI selection give explicit errors without joining or generating keys',async t=>{
 const f=fixture(t),a=hubs[0]
 await f.api.handle('join',joinInput(a),human)
 await assert.rejects(f.api.handle('switch-hub',{hubId:a.hubId,confirmedHubId:a.hubId,confirmedUrl:a.url,confirmedTrustFingerprint:testHubInput(a).confirmedTrustFingerprint},human),{code:'HUB_SELECTION_CHANGED'})
 f.records.clear()
 const before=[f.writes.length,f.network.length]
 await assert.rejects(f.api.handle('switch-hub',{hubId:a.hubId,confirmedHubId:a.hubId,confirmedUrl:a.url,confirmedTrustFingerprint:testHubInput(a).confirmedTrustFingerprint,expectedCurrentHubId:a.hubId},human),{code:'JOIN_NOT_SUBMITTED'})
 await assert.rejects(f.api.handle('switch-hub',{...joinInput(a),expectedCurrentHubId:a.hubId},human),{code:'JOIN_NOT_SUBMITTED'})
 assert.equal(f.records.size,0)
 assert.deepEqual([f.writes.length,f.network.length],before)
 const view=await f.api.handle('storage',{},human)
 assert.equal(view.selectedHub.hubId,a.hubId);assert.deepEqual(view.enrollments,[])
})

test('edit interruption leaves a durable pause; explicit resume recovers and revocation is not silently repaired',async t=>{
 const f=fixture(t),a=hubs[0];await f.api.handle('join',joinInput(a),human);f.activate();f.failEdit=true
 await assert.rejects(f.api.handle('disconnect-hub',{hubId:a.hubId},human),{code:'STORAGE_UNAVAILABLE'})
 const record=f.records.get(communicationCredentialKey(a.hubId)).payload
 assert.equal(record.paused,true);assert.equal(record.requiresResume,true);assert.ok(f.stops>0)
 let authSent=false
 await assert.rejects(communicationAuthentication(f.rt,communicationCredentialKey(a.hubId),f.rt.config.communication)(async()=>{authSent=true}),{code:'HUB_PAUSED'})
 assert.equal(authSent,false)
 f.failEdit=false;f.restart();await f.api.handle('resume-hub',{hubId:a.hubId,confirmedUrl:a.url,confirmedTrustFingerprint:testHubInput(a).confirmedTrustFingerprint,confirmResume:true},human)
 assert.ok(f.starts>0);assert.equal(f.records.get(communicationCredentialKey(a.hubId)).payload.paused,false)
 await f.api.handle('disconnect-hub',{hubId:a.hubId},human);f.revoked=true
 await assert.rejects(f.api.handle('resume-hub',{hubId:a.hubId,confirmedUrl:a.url,confirmedTrustFingerprint:testHubInput(a).confirmedTrustFingerprint,confirmResume:true},human),{code:'UNAUTHENTICATED'})
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
 await assert.rejects(f.api.handle('resume-hub',{hubId:a.hubId,confirmedUrl:a.url,confirmedTrustFingerprint:testHubInput(a).confirmedTrustFingerprint,confirmResume:true},human),{code:'STORAGE_UNAVAILABLE'})
 assert.equal(f.rt.config.communication.enabled,false)
 assert.equal(f.records.get(communicationCredentialKey(a.hubId)).payload.requiresResume,true)
 f.failEdit=false;f.restart()
 const writes=f.writes.length
 assert.equal((await f.api.handle('status',{hubId:a.hubId},human)).paused,true)
 assert.equal(f.writes.length,writes)
 await f.api.handle('resume-hub',{hubId:a.hubId,confirmedUrl:a.url,confirmedTrustFingerprint:testHubInput(a).confirmedTrustFingerprint,confirmResume:true},human)
 assert.equal(f.records.get(communicationCredentialKey(a.hubId)).payload.requiresResume,false)
 assert.equal(f.rt.config.communication.enabled,true)
})

test('signed leave, revoked-status reconciliation and forgetting separate access from retained history',async t=>{
 const f=fixture(t),a=hubs[0]
 await f.api.handle('join',joinInput(a),human);f.activate()
 const oldKey=f.records.get(communicationCredentialKey(a.hubId)).payload.publicKey
 writeFileSync(join(f.rt.home,'communication.sqlite'),'retained synthetic history')
 await assert.rejects(f.api.handle('leave-hub',{hubId:a.hubId,confirmedUrl:a.url,confirmedTrustFingerprint:testHubInput(a).confirmedTrustFingerprint},human),{code:'HUB_LEAVE_CONFIRMATION_REQUIRED'})
 await assert.rejects(f.api.handle('forget-hub',{hubId:a.hubId,confirmedUrl:a.url,confirmedTrustFingerprint:testHubInput(a).confirmedTrustFingerprint,confirmForget:true,deleteLocalHistory:false},human),{code:'HUB_LEAVE_REQUIRED'})
 const left=await f.api.handle('leave-hub',{hubId:a.hubId,confirmedUrl:a.url,confirmedTrustFingerprint:testHubInput(a).confirmedTrustFingerprint,confirmLeave:true},human)
 assert.equal(left.left,true);assert.equal(f.rt.config.communication.enabled,false)
 assert.equal(f.records.get(communicationCredentialKey(a.hubId)).payload.departed,true)
 f.restart()
 const status=await f.api.handle('hub-leave-status',{hubId:a.hubId,confirmedUrl:a.url,confirmedTrustFingerprint:testHubInput(a).confirmedTrustFingerprint},human)
 assert.equal(status.left,true)
 await assert.rejects(f.api.handle('join',joinInput(a),human),{code:'HUB_LEFT'})
 await assert.rejects(f.api.handle('forget-hub',{hubId:a.hubId,confirmedUrl:a.url,confirmedTrustFingerprint:testHubInput(a).confirmedTrustFingerprint,confirmForget:true,deleteLocalHistory:true},human),{code:'HUB_FORGET_CONFIRMATION_REQUIRED'})
 const forgotten=await f.api.handle('forget-hub',{hubId:a.hubId,confirmedUrl:a.url,confirmedTrustFingerprint:testHubInput(a).confirmedTrustFingerprint,confirmForget:true,deleteLocalHistory:false},human)
 assert.equal(forgotten.historyRetained,true);assert.equal(f.rt.config.communication,undefined)
 assert.equal(f.records.size,0)
 assert.equal(readFileSync(join(f.rt.home,'communication.sqlite'),'utf8'),'retained synthetic history')
 f.revoked=false
 await f.api.handle('join',joinInput(a),human)
 assert.notEqual(f.records.get(communicationCredentialKey(a.hubId)).payload.publicKey,oldKey)
 const settings=await communicationQueueSettings(f.rt,communicationCredentialKey(a.hubId),f.rt.config.communication)
 assert.notEqual(settings.dataPath,join(f.rt.home,'communication.sqlite'),'new identity cannot attach the archived queue')
})

test('forgetting one inactive Hub deletes only its scoped cache and leaves the active Hub and key alone',async t=>{
 const f=fixture(t),[a,b]=hubs
 await f.api.handle('join',joinInput(a),human)
 await f.api.handle('switch-hub',{...joinInput(b),expectedCurrentHubId:a.hubId},human)
 await f.api.handle('join',joinInput(b),human)
 const settings=await communicationQueueSettings(f.rt,communicationCredentialKey(b.hubId),f.rt.config.communication)
 const queue=new CommunicationQueue(settings.dataPath,{instanceId:'shared-instance'});queue.close()
 await f.api.handle('leave-hub',{hubId:b.hubId,confirmedUrl:b.url,confirmLeave:true},human)
 await f.api.handle('switch-hub',{hubId:a.hubId,confirmedHubId:a.hubId,confirmedUrl:a.url,confirmedTrustFingerprint:testHubInput(a).confirmedTrustFingerprint,expectedCurrentHubId:b.hubId},human)
 const config=clone(f.rt.config),key=f.records.get(communicationCredentialKey(a.hubId)).payload.publicKey
 const result=await f.api.handle('forget-hub',{hubId:b.hubId,confirmedUrl:b.url,confirmForget:true,deleteLocalHistory:true,confirmDeleteLocalHistory:true},human)
 assert.equal(result.historyRetained,false);assert.equal(existsSync(settings.dataPath),false)
 assert.deepEqual(f.rt.config,config);assert.equal(f.records.get(communicationCredentialKey(a.hubId)).payload.publicKey,key)
 assert.equal(f.records.has(communicationCredentialKey(b.hubId)),false)
})

test('signed status after explicit administrator repair clears only the departed fence and still requires resume',async t=>{
 const f=fixture(t),a=hubs[0]
 await f.api.handle('join',joinInput(a),human);f.activate()
 await f.api.handle('leave-hub',{hubId:a.hubId,confirmedUrl:a.url,confirmedTrustFingerprint:testHubInput(a).confirmedTrustFingerprint,confirmLeave:true},human)
 const key=f.records.get(communicationCredentialKey(a.hubId)).payload.publicKey
 f.revoked=false;f.restart()
 const before=f.writes.length
 assert.equal((await f.api.handle('hub-leave-status',{hubId:a.hubId,confirmedUrl:a.url,confirmedTrustFingerprint:testHubInput(a).confirmedTrustFingerprint},human)).left,false)
 const record=f.records.get(communicationCredentialKey(a.hubId)).payload
 assert.equal(record.departed,false);assert.equal(record.paused,true);assert.equal(record.requiresResume,true)
 assert.equal(f.writes.length,before,'status cannot activate the paused configuration')
 await assert.rejects(f.api.handle('forget-hub',{hubId:a.hubId,confirmedUrl:a.url,confirmedTrustFingerprint:testHubInput(a).confirmedTrustFingerprint,confirmForget:true,deleteLocalHistory:false},human),{code:'HUB_LEAVE_REQUIRED'})
 await f.api.handle('resume-hub',{hubId:a.hubId,confirmedUrl:a.url,confirmedTrustFingerprint:testHubInput(a).confirmedTrustFingerprint,confirmResume:true},human)
 assert.equal(f.rt.config.communication.enabled,true)
 assert.equal(f.records.get(communicationCredentialKey(a.hubId)).payload.publicKey,key)
})

test('forget rejects a concurrent Hub selection without clearing the other configuration or deleting history',async t=>{
 const f=fixture(t),[a,b]=hubs
 await f.api.handle('join',joinInput(a),human);f.activate()
 f.records.get(communicationCredentialKey(a.hubId)).payload.departed=true
 const original=join(f.rt.home,'communication.sqlite');writeFileSync(original,'keep history')
 f.rt.communication.close=async()=>{f.rt.config.communication={...b,enabled:false,instanceId:'other-instance',credentialKey:communicationCredentialKey(b.hubId)}}
 await assert.rejects(f.api.handle('forget-hub',{hubId:a.hubId,confirmedUrl:a.url,confirmedTrustFingerprint:testHubInput(a).confirmedTrustFingerprint,confirmForget:true,deleteLocalHistory:true,confirmDeleteLocalHistory:true},human),{code:'HUB_SELECTION_CHANGED'})
 assert.equal(f.rt.config.communication.hubId,b.hubId)
 assert.equal(readFileSync(original,'utf8'),'keep history')
 assert.equal(f.records.size,1)
})

test('forget refuses linked cache roots and linked parents without following them or deleting the identity',async t=>{
 for(const linkParent of [false,true]){
  const f=fixture(t),a=hubs[0]
  await f.api.handle('join',joinInput(a),human)
  const record=f.records.get(communicationCredentialKey(a.hubId));record.payload.departed=true
  const scope='hub-'+createHash('sha256').update(a.hubId).digest('hex').slice(0,32)
  record.payload.queueScope=scope
  const outside=mkdtempSync(join(tmpdir(),'dsbot-cache-link-target-'))
  t.after(()=>{assert.equal(dirname(resolve(outside)),resolve(tmpdir()));assert.ok(basename(outside).startsWith('dsbot-cache-link-target-'));rmSync(outside,{recursive:true,force:true})})
  const parent=join(f.rt.home,'communication-hubs'),target=join(outside,scope)
  mkdirSync(target);writeFileSync(join(target,'keep.txt'),'untouched')
  if(linkParent)symlinkSync(outside,parent,'junction')
  else{mkdirSync(parent);symlinkSync(target,join(parent,scope),'junction')}
  await assert.rejects(f.api.handle('forget-hub',{hubId:a.hubId,confirmedUrl:a.url,confirmedTrustFingerprint:testHubInput(a).confirmedTrustFingerprint,confirmForget:true,deleteLocalHistory:true,confirmDeleteLocalHistory:true},human),{code:'COMMUNICATION_CREDENTIAL_MISMATCH'})
  assert.equal(readFileSync(join(target,'keep.txt'),'utf8'),'untouched')
  assert.equal(f.records.size,1)
 }
})

test('forget checks key replacement before deleting files and preserves an interrupted credential deletion for explicit retry',async t=>{
 const f=fixture(t),a=hubs[0]
 await f.api.handle('join',joinInput(a),human);f.activate()
 f.records.get(communicationCredentialKey(a.hubId)).payload.departed=true
 const original=join(f.rt.home,'communication.sqlite');writeFileSync(original,'keep history')
 f.rt.communication.close=async()=>{f.records.get(communicationCredentialKey(a.hubId)).payload.publicKey='synthetic-concurrently-replaced-key'}
 await assert.rejects(f.api.handle('forget-hub',{hubId:a.hubId,confirmedUrl:a.url,confirmedTrustFingerprint:testHubInput(a).confirmedTrustFingerprint,confirmForget:true,deleteLocalHistory:true,confirmDeleteLocalHistory:true},human),{code:'COMMUNICATION_PAIRING_CONFLICT'})
 assert.equal(readFileSync(original,'utf8'),'keep history');assert.equal(f.records.size,1)
 const other=fixture(t)
 await other.api.handle('join',joinInput(a),human)
 other.records.get(communicationCredentialKey(a.hubId)).payload.departed=true
 const remove=other.rt.ctx.credentials.deleteRecord
 other.rt.ctx.credentials.deleteRecord=async()=>{throw Error('synthetic provider failure')}
 const input={hubId:a.hubId,confirmedUrl:a.url,confirmedTrustFingerprint:testHubInput(a).confirmedTrustFingerprint,confirmForget:true,deleteLocalHistory:false}
 await assert.rejects(other.api.handle('forget-hub',input,human),{code:'COMMUNICATION_CREDENTIAL_DELETE_FAILED'})
 assert.equal(other.records.size,1)
 other.rt.ctx.credentials.deleteRecord=remove
 assert.equal((await other.api.handle('forget-hub',input,human)).forgotten,true)
 assert.equal(other.records.size,0)
})

test('forget refuses pending requests, absent deletion support, forged authority and unsafe queue scope',async t=>{
 const f=fixture(t),a=hubs[0];await f.api.handle('join',joinInput(a),human)
 const input={hubId:a.hubId,confirmedUrl:a.url,confirmedTrustFingerprint:testHubInput(a).confirmedTrustFingerprint,confirmForget:true,deleteLocalHistory:true,confirmDeleteLocalHistory:true}
 await assert.rejects(f.api.handle('forget-hub',input,{human:true,agent:{}}),{code:'HUMAN_REQUIRED'})
 const record=f.records.get(communicationCredentialKey(a.hubId));record.payload.status='pending'
 await assert.rejects(f.api.handle('forget-hub',input,human),{code:'HUB_CANCEL_REQUIRED'})
 record.payload.status='approved';record.payload.departed=true;record.payload.queueScope='../../elsewhere'
 await assert.rejects(f.api.handle('forget-hub',input,human),{code:'COMMUNICATION_CREDENTIAL_MISMATCH'})
 delete record.payload.queueScope;delete f.rt.ctx.credentials.deleteRecord
 await assert.rejects(f.api.handle('forget-hub',input,human),{code:'CREDENTIAL_DELETE_UNAVAILABLE'})
 assert.equal(f.records.size,1)
})

test('legacy static pairing can pause/resume its exact address but cannot be guessed into another Hub',async t=>{
 const f=fixture(t),a=hubs[0]
 f.rt.config.communication={enabled:true,url:a.url,instanceId:'legacy',credentialEnv:'PRIVATE_LAUNCH_ONLY'};f.activate()
 await assert.rejects(f.api.handle('disconnect-hub',{confirmedUrl:hubs[1].url},human),{code:'HUB_CONFIRMATION_REQUIRED'})
 await f.api.handle('disconnect-hub',{confirmedUrl:a.url,confirmedTrustFingerprint:testHubInput(a).confirmedTrustFingerprint},human)
 assert.equal(f.rt.config.communication.enabled,false)
 assert.equal(f.records.size,0)
 await assert.rejects(f.api.handle('switch-hub',joinInput(hubs[1]),human),{code:'LEGACY_HUB_SWITCH_REQUIRES_REENROLLMENT'})
 await f.api.handle('resume-hub',{confirmedUrl:a.url,confirmedTrustFingerprint:testHubInput(a).confirmedTrustFingerprint,confirmResume:true},human)
 assert.equal(f.rt.config.communication.enabled,true)
 assert.equal(f.rt.config.communication.credentialEnv,'PRIVATE_LAUNCH_ONLY')
 assert.equal(f.network.length,0,'no identity guessed or new key generated')
})

test('local disconnect works after device revocation; verified repair alone never resumes retained work',async t=>{
 const f=fixture(t),a=hubs[0]
 const enrolled=await f.api.handle('join',joinInput(a),human);f.activate()
 const key=communicationCredentialKey(a.hubId),originalKey=f.records.get(key).payload.publicKey
 f.revoked=true
 const before=f.network.length
 const paused=await f.api.handle('disconnect-hub',{hubId:a.hubId},human)
 assert.equal(paused.paused,true);assert.equal(paused.localOnly,true)
 assert.equal(f.network.length,before,'local pause does not authenticate against a revoked Hub device')
 assert.equal(f.rt.config.communication.enabled,false)
 await assert.rejects(f.api.handle('resume-hub',{hubId:a.hubId,confirmedUrl:a.url,confirmedTrustFingerprint:testHubInput(a).confirmedTrustFingerprint,confirmResume:true},human),{code:'UNAUTHENTICATED'})
 const status=await f.api.handle('hub-leave-status',{hubId:a.hubId,confirmedUrl:a.url,confirmedTrustFingerprint:testHubInput(a).confirmedTrustFingerprint},human)
 assert.equal(status.left,true);assert.equal(f.records.get(key).payload.departed,true)
 await assert.rejects(f.api.handle('join',joinInput(a),human),{code:'HUB_LEFT'})
 f.revoked=false
 const repaired=await f.api.handle('hub-leave-status',{hubId:a.hubId,confirmedUrl:a.url,confirmedTrustFingerprint:testHubInput(a).confirmedTrustFingerprint},human)
 assert.equal(repaired.left,false);assert.equal(f.records.get(key).payload.departed,false)
 assert.equal(f.records.get(key).payload.paused,true)
 assert.equal(f.rt.config.communication.enabled,false,'repair observation is not permission to resume pending work')
 await f.api.handle('resume-hub',{hubId:a.hubId,confirmedUrl:a.url,confirmedTrustFingerprint:testHubInput(a).confirmedTrustFingerprint,confirmResume:true},human)
 assert.equal(f.rt.config.communication.instanceId,enrolled.instanceId)
 assert.equal(f.records.get(key).payload.publicKey,originalKey)
 assert.equal(f.rt.config.communication.enabled,true)
})
