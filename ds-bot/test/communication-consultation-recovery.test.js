import {test} from 'node:test'
import assert from 'node:assert/strict'
import {CommunicationQueue} from '../src/host/federation/queue-store.js'
import {notifyConsultationResult,processLocalConsultations,recoverConsultationAnswer} from '../src/host/federation/consultation-recovery.js'
import {consultLocalBot,awaitingLocalConsultation} from '../src/host/federation/local-consultations.js'
import {install} from '../src/host/communication.js'

function fixture(t){
 const queue=new CommunicationQueue(':memory:',{instanceId:'consult-recovery'});t.after(()=>queue.close())
 const bot=queue.localPrincipal('bot','worker','Worker'),conversationId='group',epoch='epoch'
 queue.applyMemberships({memberships:[{principalId:bot.principalId,conversationId,membershipEpoch:epoch,active:true,joinSeq:1,watermark:1}]})
 const binding=queue.binding(conversationId,bot.principalId,epoch,'worker');queue.addBindingSession(binding.id,'remote');binding.sessionIds=['remote']
 const delivery={deliveryId:'delivery',messageId:'input',conversationId,recipientPrincipalId:bot.principalId,membershipEpoch:epoch,routingVersion:1,ai:true,notify:false,event:{type:'message',eventId:'input',conversationId,conversationSeq:1,message:{messageId:'input',author:{principalId:'human:other:owner'}}}}
 queue.receive(delivery)
 const row={id:'consultation',ownerBotId:'worker',targetBotId:'chief',bindingId:binding.id,remoteSource:{consultationId:'consultation',messageId:'input',conversationId},status:'completed',text:'Internal answer',receiptId:'receipt',createdAt:Date.now()}
 const events=[],calls=[],agent={id:'remote',session:{id:'remote'},status:'idle',inbox:{nextStep:[],nextTurn:[]},followup(message){calls.push(message);this.inbox.nextTurn.push(message)}}
 const rt={state:{localConsultations:{[row.id]:row}},botOf:id=>({id}),selfOf:id=>id,partsOf:()=>[],save:async()=>{},readOnly:()=>undefined,warn:()=>{},dropWork:()=>{},closeWork:()=>{}}
 const runtime={rt,queue,owners:new Map([['remote',binding]]),authorize:async()=>{},errors:new Map(),ctx:{sessionController:{resolveAgent:async()=>({agent}),inspect:async()=>({events})},sessions:{flush:async()=>{}}}}
 rt.ctx=runtime.ctx
 return {runtime,rt,row,binding,delivery,agent,events,calls}
}

test('late consultation results notify only their original remote binding, survive an uncertain save and never duplicate queued notices',async t=>{
 const f=fixture(t);let failure=true
 f.rt.save=async()=>{if(failure){failure=false;throw new Error('synthetic state failure')}}
 await assert.rejects(notifyConsultationResult(f.runtime,f.row))
 assert.equal(f.row.notifiedKey,undefined);assert.equal(f.calls.length,1)
 const source=f.calls[0].source
 assert.equal(source.forDeliveryId,'delivery');assert.equal(source.forMessageId,'input');assert.equal(source.conversationId,'group')
 assert.match(f.calls[0].content[0].text,/Nothing was published to Hub/)
 await notifyConsultationResult(f.runtime,f.row)
 assert.equal(f.calls.length,1);assert.ok(f.row.notifiedKey)
 // Replay after a host crash that lost only the state ACK uses the admitted Session evidence.
 delete f.row.notifiedKey;f.agent.inbox.nextTurn=[]
 f.events.push({type:'user/message',data:{source}})
 await notifyConsultationResult(f.runtime,f.row)
 assert.equal(f.calls.length,1)
})

test('a durable consult tool result suppresses a redundant result turn; an unrelated tool cannot forge receipt',async t=>{
 const f=fixture(t)
 f.events.push({type:'assistant/message',data:{message:{content:[{type:'tool-call',id:'poll',name:'consult_local_bot'}]}}},
  {type:'tool/result',data:{callId:'poll',message:{content:[{type:'text',text:JSON.stringify({consultationId:f.row.id,status:'completed',receiptId:f.row.receiptId})}]}}})
 await notifyConsultationResult(f.runtime,f.row);assert.equal(f.calls.length,0)
 delete f.row.notifiedKey;f.events[0].data.message.content[0].name='read'
 await notifyConsultationResult(f.runtime,f.row);assert.equal(f.calls.length,1)
})

test('revoked membership cannot receive a late consultation notice; pending and timeouts are not success',async t=>{
 const f=fixture(t);f.runtime.authorize=async()=>{throw Object.assign(new Error('revoked'),{code:'MEMBERSHIP_REVOKED'})}
 await processLocalConsultations(f.runtime)
 assert.equal(f.calls.length,0);assert.equal(f.runtime.errors.get(f.binding.id),'MEMBERSHIP_REVOKED');assert.equal(f.row.text,'Internal answer')
 f.runtime.authorize=async()=>{};f.row.status='pending';f.row.expiresAt=Date.now()-1
 assert.equal(awaitingLocalConsultation(f.runtime,f.binding,f.delivery),true)
 await processLocalConsultations(f.runtime)
 assert.equal(f.row.status,'failed');assert.equal(f.row.error,'LOCAL_CONSULTATION_TIMEOUT')
 assert.equal(awaitingLocalConsultation(f.runtime,f.binding,f.delivery),false)
 assert.equal(f.calls.length,1)
})

test('restart recovery reads a completed responder final from canonical history, omits reasoning and rejects mixed turns',async t=>{
 const f=fixture(t);f.row.status='pending';f.rt.partsOf=()=>[{sessionId:'chief'}]
 f.events.push({type:'turn/start',data:{turn:1}},{type:'user/message',data:{source:{kind:'bot',role:'request',senderSessionId:'worker',exchangeId:f.row.id,remoteSource:f.row.remoteSource}}},
 {type:'assistant/message',data:{message:{content:[{type:'reasoning',text:'secret'},{type:'text',text:'Recovered answer'}]}}},{type:'turn/end',data:{turn:1,reason:{kind:'completed'}}})
 await recoverConsultationAnswer(f.rt,f.row);assert.equal(f.row.status,'completed');assert.equal(f.row.text,'Recovered answer')
 f.row.status='pending';f.events.splice(2,0,{type:'user/message',data:{source:{kind:'user'}}})
 assert.equal(await recoverConsultationAnswer(f.rt,f.row),undefined);assert.equal(f.row.status,'pending')
})

test('request dispatch failure releases work and returns an inspectable uncertain result without resending',async t=>{
 const f=fixture(t);f.rt.state.bots={chief:{id:'chief',name:'Chief'}};f.rt.isMain=()=>true
 f.rt.requestIdentity=()=>({});f.rt.admitRequest=async(_request,work)=>({status:'sent',receipt:await work()});f.rt.openWork=()=>{};let dropped=0,calls=0
 f.rt.dropWork=()=>dropped++;f.rt.deliver=async()=>{calls++;throw new Error('synthetic flush failure')}
 const exec={agent:f.agent,communicationBinding:f.binding,communicationSource:'source',communicationCausation:{causationDeliveryId:'delivery',replyToMessageId:'input'}}
 let id
 await assert.rejects(consultLocalBot(f.runtime,{botId:'chief',text:'Question',waitSeconds:0},exec),error=>{id=error.consultationId;return error.code==='LOCAL_CONSULTATION_DELIVERY_UNCONFIRMED'})
 assert.equal(dropped,1)
 const result=await consultLocalBot(f.runtime,{consultationId:id,waitSeconds:0},exec)
 assert.equal(result.status,'delivery_unknown');assert.equal(calls,1)
 await assert.rejects(consultLocalBot(f.runtime,{consultationId:'placeholder',waitSeconds:0},exec),{code:'LOCAL_CONSULTATION_NOT_FOUND'})
 assert.equal(f.rt.state.localConsultations[id].status,'delivery_unknown')
})

test('actual consult tool validates before Hub/publication and an unpublished local requester can read its result',async()=>{
 const row={id:'existing',ownerBotId:'worker',targetBotId:'chief',status:'completed',text:'Saved answer',receiptId:'receipt'}
 const rt={config:{communication:{enabled:true,url:'wss://isolated.example.test/communication',instanceId:'a',publishedBotIds:[]}},teamTools:[],state:{localConsultations:{existing:row}},
  selfOf:id=>id,botOf:id=>({id}),load:async()=>{},ctx:{effect:()=>{},on:()=>()=>{},get:()=>undefined}}
 install(rt)
 const tool=rt.teamTools.find(tool=>tool.name==='consult_local_bot'),exec={name:'consult_local_bot',agent:{id:'chief'}}
 assert.ok(tool)
 assert.equal(JSON.parse(await tool.execute({botId:'worker',text:'Answer',consultationId:'placeholder'},exec)).error.code,'INVALID_REQUEST')
 const wrong=JSON.parse(await tool.execute({botId:'worker',text:'Answer'},exec))
 assert.equal(wrong.error.code,'LOCAL_CONSULTATION_REMOTE_CONTEXT_REQUIRED');assert.match(wrong.error.message,/no Hub publication/)
 assert.equal(JSON.parse(await tool.execute({consultationId:'placeholder'},exec)).error.code,'LOCAL_CONSULTATION_NOT_FOUND')
 assert.equal(JSON.parse(await tool.execute({consultationId:'existing'},{...exec,agent:{id:'worker'}})).text,'Saved answer')
 assert.equal(rt.communication,undefined,'no Hub startup or publication checks')
})

test('a result in an unfinished save cannot be observed as completed or notified',async t=>{
 const {settleLocalConsultation,readLocalConsultation}=await import('../src/host/federation/local-consultations.js')
 const f=fixture(t);f.row.status='pending';let release,entered
 const gate=new Promise(resolve=>entered=resolve)
 f.rt.save=()=>{entered();return new Promise(resolve=>release=resolve)}
 const saving=settleLocalConsultation(f.rt,'chief',{remoteSource:f.row.remoteSource,exchangeId:f.row.id,senderSessionId:'worker'},'Durable only after save')
 await gate
 assert.equal(readLocalConsultation(f.rt,f.row.id,'worker').status,'pending')
 await notifyConsultationResult(f.runtime,f.row);assert.equal(f.calls.length,0)
 f.rt.save=async()=>{};release()
 assert.equal((await saving).status,'completed')
 assert.equal(readLocalConsultation(f.rt,f.row.id,'worker').text,'Durable only after save')
})

test('an empty automatic answer fails explicitly rather than entering an endless result retry',async t=>{
 const {automaticConsultationReply}=await import('../src/host/federation/local-consultations.js')
 const f=fixture(t);f.row.status='pending';const notices=[];f.rt.deliver=async value=>notices.push(value)
 await automaticConsultationReply(f.rt,'chief',{remoteSource:f.row.remoteSource,exchangeId:f.row.id,senderSessionId:'worker'},'')
 assert.equal(f.row.status,'failed');assert.equal(f.row.error,'LOCAL_CONSULTATION_EMPTY_RESULT')
 assert.equal(f.rt.localConsultationRetries?.size??0,0);assert.equal(notices.length,1)
 await processLocalConsultations(f.runtime)
 assert.equal(f.calls.length,1);assert.match(f.calls[0].content[0].text,/LOCAL_CONSULTATION_EMPTY_RESULT/)
})
