import assert from 'node:assert/strict'
import {test} from 'node:test'
import {HarnessError} from '@deepseek-ai/dsh-llm'
import {CommunicationQueue} from '../src/host/federation/queue-store.js'
import {CommunicationRuntime} from '../src/host/federation/runtime.js'
import {communicationInputs} from '../src/host/federation/session-scope.js'
import {completedOutputs} from '../src/host/federation/session-journal.js'
import {startedSources} from '../src/host/federation/work-events.js'
import {checkCommunicationCompletion} from '../src/host/federation/turn-completion.js'

const notice={kind:'model-selection',form:'notice',summary:'Model A → Model B'}
function fixture(t){
 const queue=new CommunicationQueue(':memory:',{instanceId:'a'});t.after(()=>queue.close())
 const bot=queue.localPrincipal('bot','worker','Worker')
 const binding={id:'binding',conversationId:'group',recipientPrincipalId:bot.principalId,membershipEpoch:'epoch',localBotRef:'worker'}
 queue.applyMemberships({memberships:[{conversationId:'group',principalId:bot.principalId,membershipEpoch:'epoch',joinSeq:1,active:true}]})
 const source={kind:'ds-bot-communication',conversationId:'group',recipientPrincipalId:bot.principalId,membershipEpoch:'epoch',deliveryId:'delivery',messageId:'input'}
 queue.receive({deliveryId:'delivery',messageId:'input',conversationId:'group',recipientPrincipalId:bot.principalId,membershipEpoch:'epoch',ai:true,notify:false,event:{conversationId:'group',conversationSeq:1,eventId:'input',type:'message',message:{messageId:'input'}}})
 const events=[{seq:1,type:'turn/start',data:{turn:1}},{seq:2,type:'user/message',data:{source}},
  {seq:3,type:'user/message',data:{source:notice}},
  {seq:4,type:'step/start',data:{turn:1,step:1}},
  {seq:5,type:'assistant/message',data:{turn:1,message:{id:'call-message',content:[{type:'tool-call',id:'call'}]}}}]
 const runtime=Object.assign(Object.create(CommunicationRuntime.prototype),{queue,owners:new Map([['session',binding]]),errors:new Map(),authorize:async()=>{},ctx:{sessions:{flush:async()=>{}},sessionController:{inspect:async()=>({events})}}})
 const exec={callId:'call',agent:{id:'session',session:{}}}
 const finish=()=>{events.at(-1).data.message={id:'final',content:[{type:'text',text:'Public result'}]};events.push({seq:6,type:'turn/end',data:{turn:1,reason:{kind:'completed'}}})}
 return {queue,binding,source,events,runtime,exec,finish}
}
test('model-selection notices do not poison admission, work-start or repeated tool provenance',async t=>{
 const f=fixture(t),canonical={source:f.source},operational={source:notice}
 assert.deepEqual(communicationInputs(f.queue,f.binding,[canonical,operational]),[canonical])
 assert.deepEqual(startedSources(f.events,f.events[3]),[f.source])
 for(const name of ['reply_to_communication','report_to_local_chief','consult_local_bot','reply_to_communication']){
  const result=await f.runtime.toolProvenance({...f.exec,name})
  assert.equal(result.causationDeliveryId,'delivery');assert.equal(result.replyToMessageId,'input')
 }
})
test('model-selection notices do not break final attribution or the explicit reply completion check',async t=>{
 const f=fixture(t);f.finish()
 const output=completedOutputs([{sessionId:'session',events:f.events}],f.binding)
 assert.deepEqual(output[0].inputSource,f.source)
 const notices=[]
 await checkCommunicationCompletion(f.runtime,{agent:{...f.exec.agent,steer:message=>notices.push(message)},turn:1})
 assert.equal(notices.length,1)
 assert.match(JSON.stringify(notices[0]),/reply_to_communication/)
 assert.equal(f.queue.pendingOutbox().length,0,'a correction reminder never sends final prose')
})
test('unknown, forged and missing sources still fail with a typed code instead of UNKNOWN',async t=>{
 const f=fixture(t)
 for(const bad of [{kind:'webhook',form:'notice',summary:'not host metadata'}, {...notice,form:'relay'}, {...notice,summary:null}, {...f.source,conversationId:'other'}, {...f.source,membershipEpoch:'old'}, undefined]){
  f.events[2].data.source=bad
  await assert.rejects(f.runtime.toolProvenance(f.exec),error=>error instanceof HarnessError&&error.code==='COMMUNICATION_INPUT_SOURCE_UNKNOWN'&&error.message.includes('[COMMUNICATION_INPUT_SOURCE_UNKNOWN]'))
 }
 f.events.splice(1,1);f.events[1].data.source=notice
 await assert.rejects(f.runtime.toolProvenance(f.exec),{code:'COMMUNICATION_INPUT_SOURCE_UNKNOWN'})
 f.finish()
 assert.throws(()=>completedOutputs([{sessionId:'session',events:f.events}],f.binding),error=>error instanceof HarnessError&&error.code==='COMMUNICATION_OUTPUT_SOURCE_UNKNOWN')
})
