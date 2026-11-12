import assert from 'node:assert/strict'
import {test} from 'node:test'
import {communicationModel,communicationModelStates} from '../src/host/federation/model-availability.js'
import {CommunicationQueue} from '../src/host/federation/queue-store.js'
import {CommunicationRuntime} from '../src/host/federation/runtime.js'
import {deliveryPhase} from '../src/client/communication-model.js'

test('model readiness distinguishes absent selection, unavailable routes and missing credentials without leaking details',async()=>{
 const rt={desiredModel:async bot=>bot.model,missingKeys:async()=>new Set()}
 assert.deepEqual(await communicationModel(rt,{}),{error:'MODEL_NOT_CONFIGURED'})
 assert.deepEqual(await communicationModel({...rt,desiredModel:async()=>undefined},{model:'provider/model'}),{error:'MODEL_UNAVAILABLE'})
 rt.missingKeys=async()=>new Set(['provider'])
 assert.deepEqual(await communicationModel(rt,{model:'provider/model'}),{error:'MODEL_CREDENTIAL_MISSING'})
 assert.deepEqual(await communicationModel({...rt,desiredModel:async()=>{throw new Error('secret provider detail')}},{model:'provider/model'}),{error:'MODEL_UNAVAILABLE'})
 rt.missingKeys=async()=>new Set()
 assert.deepEqual(await communicationModel(rt,{model:'provider/model'}),{ref:'provider/model',error:null})
})
test('preflight refuses an unconfigured Bot before creating/admitting a Session and becomes runnable when configured',async()=>{
 let model
 const runtime={rt:{desiredModel:async()=>model},ctx:{sessionController:{create:()=>assert.fail('No Session may be created without a model')}}}
 await assert.rejects(CommunicationRuntime.prototype.ensureSession.call(runtime,{sessionIds:[]},{}),{code:'MODEL_NOT_CONFIGURED'})
 model='mock/model'
 assert.deepEqual(await communicationModel(runtime.rt,{model}),{ref:model,error:null})
})
test('presence reports bounded unavailable reasons, clears them after local repair, and remains compatible with older Hubs',async()=>{
 let model
 const calls=[],bot={principalId:'bot:a:worker',localRef:'worker'}
 const runtime={rt:{botOf:()=>({model}),desiredModel:async()=>model,missingKeys:async()=>new Set()},bots:new Map([['worker',bot]]),owners:new Map(),ctx:{get:()=>new Map()},transport:{welcome:{capabilities:['bot-presence','bot-model-status']},request:async(type,payload)=>calls.push({type,...payload})}}
 await CommunicationRuntime.prototype.reportPresence.call(runtime)
 assert.deepEqual(calls.at(-1).unavailableBotModels,[{principalId:bot.principalId,reason:'MODEL_NOT_CONFIGURED'}])
 model='mock/model';await CommunicationRuntime.prototype.reportPresence.call(runtime)
 assert.deepEqual(calls.at(-1).unavailableBotModels,[])
 assert.equal(runtime.modelAvailability.get(bot.principalId),null)
 runtime.transport.welcome.capabilities=['bot-presence'];model=undefined
 await CommunicationRuntime.prototype.reportPresence.call(runtime)
 assert.equal(Object.hasOwn(calls.at(-1),'unavailableBotModels'),false)
 assert.equal((await communicationModelStates(runtime)).get(bot.principalId),'MODEL_NOT_CONFIGURED')
})
test('delivery UI reports blocked model readiness without replacing accepted or revoked receipts',()=>{
 assert.equal(deliveryPhase({ai:1,targetStored:1,availabilityError:'MODEL_NOT_CONFIGURED'}),'No model configured')
 assert.equal(deliveryPhase({ai:1,targetStored:1,availabilityError:'MODEL_CREDENTIAL_MISSING'}),'Model credential missing')
 assert.equal(deliveryPhase({ai:1,targetStored:1,aiAccepted:1,availabilityError:'MODEL_NOT_CONFIGURED'}),'Bot admitted')
 assert.equal(deliveryPhase({revoked:1,availabilityError:'MODEL_NOT_CONFIGURED'}),'Revoked')
})


test('the durable pending delivery retries after model configuration and clears its visible local error',async t=>{
 const queue=new CommunicationQueue(':memory:',{instanceId:'a'});t.after(()=>queue.close())
 const principal=queue.localPrincipal('bot','worker','Worker'),bot={id:'worker'}
 queue.applyMemberships({memberships:[{principalId:principal.principalId,conversationId:'group',membershipEpoch:'epoch',active:true,joinSeq:1,watermark:1}]})
 queue.receive({deliveryId:'waiting',messageId:'message',conversationId:'group',recipientPrincipalId:principal.principalId,membershipEpoch:'epoch',routingVersion:1,ai:true,notify:false,event:{type:'message',eventId:'message',conversationId:'group',conversationSeq:1,message:{messageId:'message'}}})
 const binding=queue.binding('group',principal.principalId,'epoch',bot.id),admitted=[]
 const runtime={queue,rt:{readOnly:()=>undefined,desiredModel:async()=>bot.model},errors:new Map(),cancelRevoked:async()=>{},processUpdates:async()=>{},export:async()=>{},recoverInterrupted:async()=>{},consume:async delivery=>{
  const result=await communicationModel(runtime.rt,bot)
  if(result.error)throw Object.assign(new Error(result.error),{code:result.error})
  admitted.push(delivery.deliveryId);queue.aiState(delivery.deliveryId,'accepted',{sessionId:'session',messageId:'input',seq:1})
 }}
 await CommunicationRuntime.prototype.process.call(runtime)
 await CommunicationRuntime.prototype.process.call(runtime)
 assert.equal(runtime.errors.get(binding.id),'MODEL_NOT_CONFIGURED');assert.equal(queue.pendingAi().length,1)
 assert.deepEqual(admitted,[])
 bot.model='mock/model';await CommunicationRuntime.prototype.process.call(runtime)
 assert.deepEqual(admitted,['waiting']);assert.equal(queue.pendingAi().length,0);assert.equal(runtime.errors.has(binding.id),false)
 await CommunicationRuntime.prototype.process.call(runtime);assert.deepEqual(admitted,['waiting'])
})
