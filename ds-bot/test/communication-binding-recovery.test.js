import assert from 'node:assert/strict'
import {test} from 'node:test'
import {CommunicationQueue} from '../src/host/federation/queue-store.js'
import {CommunicationRuntime} from '../src/host/federation/runtime.js'
import {recoverUnusedBinding,resolveBindingAgent,safeBindingFailure} from '../src/host/federation/binding-recovery.js'

function fixture(t){
 const queue=new CommunicationQueue(':memory:',{instanceId:'a'});t.after(()=>queue.close())
 const principal=queue.localPrincipal('bot','worker','Worker')
 queue.applyMemberships({memberships:[{principalId:principal.principalId,conversationId:'group',membershipEpoch:'epoch',active:true,joinSeq:1,watermark:1}]})
 queue.receive({deliveryId:'task',messageId:'message',conversationId:'group',recipientPrincipalId:principal.principalId,membershipEpoch:'epoch',routingVersion:1,ai:true,notify:false,event:{type:'message',eventId:'message',conversationId:'group',conversationSeq:1,message:{messageId:'message'}}})
 const binding=queue.binding('group',principal.principalId,'epoch','worker');queue.addBindingSession(binding.id,'missing');binding.sessionIds.push('missing')
 const owners=new Map([['missing',binding]])
 const runtime={queue,owners,ctx:{sessionController:{resolveAgent:async()=>({error:{code:'session/not-found',message:'PRIVATE_ERROR_TEXT'}})}}}
 return {queue,binding,runtime,principal}
}
test('exactly missing and provably unused binding repairs only Session references and retains original task identity',async t=>{
 const {queue,binding,runtime}=fixture(t)
 await recoverUnusedBinding(runtime,binding)
 assert.deepEqual(binding.sessionIds,[])
 assert.deepEqual(queue.bindings()[0].sessionIds,[])
 assert.equal(queue.bindings()[0].id,binding.id)
 assert.equal(queue.pendingAi()[0].deliveryId,'task')
 assert.equal(queue.pendingAi()[0].state,'pending')
 assert.equal(runtime.owners.has('missing'),false)
 assert.match(queue.db.prepare('SELECT value FROM metadata WHERE key=?').get(`binding-repair:${binding.id}`).value,/unused-binding-session-not-found/)
})
test('injecting, accepted and mapped inputs never grant automatic missing-Session recreation',async t=>{
 for(const state of ['injecting','injection_unknown','accepted']){
  const {queue,binding,runtime}=fixture(t)
  queue.aiState('task',state,state==='accepted'?{sessionId:'missing',messageId:'input',seq:1}:undefined)
  await assert.rejects(recoverUnusedBinding(runtime,binding),{code:'COMMUNICATION_SESSION_HISTORY_UNAVAILABLE'})
  assert.deepEqual(queue.bindings()[0].sessionIds,['missing'])
 }
})
test('a context cursor or old export forbids recreating an apparently pending binding',async t=>{
 for(const evidence of ['context','export']){
  const {queue,binding,runtime}=fixture(t)
  if(evidence==='context')queue.db.prepare('UPDATE bindings SET context_seq=1 WHERE id=?').run(binding.id)
  else queue.db.prepare('INSERT INTO exports VALUES (?,?,?,?)').run('old',binding.id,'hash','reply')
  await assert.rejects(recoverUnusedBinding(runtime,binding),{code:'COMMUNICATION_SESSION_HISTORY_UNAVAILABLE'})
 }
})
test('non-missing Session errors and generic exceptions cannot authorize recreation or expose raw exception text',async t=>{
 const {queue,binding,runtime}=fixture(t)
 runtime.ctx.sessionController.resolveAgent=async()=>({error:{code:'session/ownership-unavailable',message:'PRIVATE_ERROR_TEXT'}})
 await assert.rejects(recoverUnusedBinding(runtime,binding),error=>{
  assert.equal(error.code,'COMMUNICATION_SESSION_UNAVAILABLE')
  assert.equal(error.hostCode,'session/ownership-unavailable')
  assert.doesNotMatch(JSON.stringify(safeBindingFailure(error,'injection')),/PRIVATE_ERROR_TEXT/)
  return true
 })
 runtime.ctx.sessionController.resolveAgent=async()=>{throw new TypeError('PRIVATE_EXCEPTION_BODY')}
 await assert.rejects(resolveBindingAgent(runtime,'missing','export-resolve'),error=>{
  assert.equal(safeBindingFailure(error,'export').errorClass,'TypeError')
  assert.doesNotMatch(JSON.stringify(safeBindingFailure(error,'export')),/PRIVATE_EXCEPTION_BODY/)
  return true
 })
 assert.deepEqual(queue.bindings()[0].sessionIds,['missing'])
})
test('a surviving busy or already used Session prevents discarding a missing reference',async t=>{
 for(const status of ['running','idle']){
  const {queue,binding,runtime}=fixture(t)
  queue.addBindingSession(binding.id,'alive');binding.sessionIds.push('alive')
  runtime.ctx.sessions={flush:async()=>{}}
  runtime.ctx.sessionController={resolveAgent:async id=>id==='missing'?{error:{code:'session/not-found'}}:{agent:{id,status,session:{id}}},inspect:async()=>({events:[{type:'turn/start'}]})}
  await assert.rejects(recoverUnusedBinding(runtime,binding))
  assert.deepEqual(queue.bindings()[0].sessionIds,['missing','alive'])
 }
})
test('durable binding proof is checked again if input admission races public Session inspection',async t=>{
 const {queue,binding,runtime}=fixture(t)
 queue.addBindingSession(binding.id,'alive');binding.sessionIds.push('alive')
 runtime.ctx.sessions={flush:async()=>{}}
 runtime.ctx.sessionController={resolveAgent:async id=>id==='missing'?{error:{code:'session/not-found'}}:{agent:{id,status:'idle',session:{id}}},inspect:async()=>{queue.aiState('task','injecting');return {events:[]}}}
 await assert.rejects(recoverUnusedBinding(runtime,binding),{code:'COMMUNICATION_BINDING_REPAIR_UNSAFE'})
 assert.deepEqual(queue.bindings()[0].sessionIds,['missing','alive'])
})
test('one broken binding does not prevent another binding from admitting its task and diagnostics remain scoped',async t=>{
 const {queue,binding,runtime,principal}=fixture(t)
 const member={principalId:principal.principalId,conversationId:'healthy',membershipEpoch:'epoch',active:true,joinSeq:1,watermark:1}
 queue.applyMemberships({memberships:[...queue.memberships(),member]})
 queue.receive({deliveryId:'healthy-task',messageId:'healthy-message',conversationId:'healthy',recipientPrincipalId:principal.principalId,membershipEpoch:'epoch',routingVersion:1,ai:true,notify:false,event:{type:'message',eventId:'healthy-message',conversationId:'healthy',conversationSeq:1,message:{messageId:'healthy-message'}}})
 const good=queue.binding('healthy',principal.principalId,'epoch','worker'),seen=[]
 Object.assign(runtime,{rt:{readOnly:()=>undefined},errors:new Map(),cancelRevoked:async()=>{},processUpdates:async()=>{},recoverInterrupted:async()=>{},export:async b=>{if(b.id===binding.id)await resolveBindingAgent(runtime,'missing','export-resolve')},consume:async delivery=>{
  if(delivery.conversationId==='group')throw Object.assign(new TypeError('PRIVATE_FAILURE'),{code:'COMMUNICATION_SESSION_UNAVAILABLE'})
  seen.push(delivery.deliveryId);queue.aiState(delivery.deliveryId,'accepted',{sessionId:'healthy-session',messageId:'input',seq:1})
 },recordBindingFailure:CommunicationRuntime.prototype.recordBindingFailure})
 await CommunicationRuntime.prototype.process.call(runtime)
 assert.deepEqual(seen,['healthy-task']);assert.equal(runtime.errors.has(good.id),false)
 assert.equal(runtime.errors.get(binding.id),'COMMUNICATION_SESSION_UNAVAILABLE')
 assert.equal(runtime.bindingDiagnostics.get(binding.id).stage,'export-resolve')
 assert.equal(queue.pendingAi()[0].deliveryId,'task')
})


test('a surviving Session that starts work during inspection prevents repair',async t=>{
 const {queue,binding,runtime}=fixture(t)
 queue.addBindingSession(binding.id,'alive');binding.sessionIds.push('alive')
 const agent={id:'alive',status:'idle',session:{id:'alive'}}
 runtime.ctx.sessions={flush:async()=>{}}
 runtime.ctx.sessionController={resolveAgent:async id=>id==='missing'?{error:{code:'session/not-found'}}:{agent},inspect:async()=>{agent.status='running';return {events:[]}}}
 await assert.rejects(recoverUnusedBinding(runtime,binding),{code:'COMMUNICATION_SESSION_UNAVAILABLE'})
 assert.deepEqual(queue.bindings()[0].sessionIds,['missing','alive'])
})
