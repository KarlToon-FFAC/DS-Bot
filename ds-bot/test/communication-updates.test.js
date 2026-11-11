import assert from 'node:assert/strict'
import {checkCommunicationCompletion,communicationDraft} from '../src/host/federation/turn-completion.js'
import { test } from 'node:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CommunicationQueue } from '../src/host/federation/queue-store.js'
import { CommunicationRuntime } from '../src/host/federation/runtime.js'
import { COMMUNICATION_PRESET, sourceDelivery, legacySessionSettled } from '../src/host/federation/session-scope.js'
import { CommunicationTransport } from '../src/host/federation/transport.js'

test('recovery sends stored before read receipts and final; lost storage ACK retains both for retry',async()=>{
  for(const loseAck of [false,true]){
    const pending=[{id:'read',payload:{deliveryId:'update',status:'updateRead'}},{id:'stored',payload:{deliveryId:'update',status:'targetStored'}}]
    let stored=false,read=false,attempt=0
    const published=[]
    const q={pendingReceipts:()=>pending,receiptAccepted:id=>pending.splice(pending.findIndex(r=>r.id===id),1),receiptRejected:()=>assert.fail('valid receipts must remain recoverable'),
      pendingOutbox:()=>published.length?[]:[{id:'final',type:'message.publish',payload:{}}],validateMessage(){},accepted:id=>published.push(id),rejected:()=>assert.fail('final must not be rejected'),applyMemberships(){},memberships:()=>[]}
    const transport=new CommunicationTransport(q,{url:'ws://127.0.0.1:1/communication'})
    transport.connected=true
    transport.request=async(type,payload)=>{
      if(type==='delivery.receipt'){
        if(payload.status==='targetStored'){stored=true;if(loseAck&&attempt++===0)throw Object.assign(Error(),{code:'CONNECTION_LOST'})}
        else {assert.equal(stored,true);read=true}
      }
      if(type==='message.publish'){assert.equal(read,true);return{}}
      if(type==='deliveries.pull')return[]
      return{}
    }
    if(loseAck){await assert.rejects(transport.synchronize(),{code:'CONNECTION_LOST'});assert.equal(pending.length,2);assert.equal(published.length,0)}
    await transport.synchronize()
    assert.deepEqual(published,['final']);assert.equal(pending.length,0)
  }
})

function fixture(t, path=':memory:') {
  const q=new CommunicationQueue(path,{instanceId:'b'})
  t.after(()=>{if(q.db.isOpen)q.close()})
  const principal=q.localPrincipal('bot','worker','B','k')
  const binding={id:'binding',conversationId:'group',recipientPrincipalId:principal.principalId,membershipEpoch:'epoch',localBotRef:'worker',sessionIds:['session']}
  q.applyMemberships({memberships:[{conversationId:'group',principalId:principal.principalId,membershipEpoch:'epoch',joinSeq:1,active:true}]})
  q.authorized=true
  const receive=(id,seq,extra={},ai=true)=>{
    const message={messageId:id,author:{principalId:'bot:a:k'},content:{text:id},...extra}
    const delivery={deliveryId:id,conversationId:'group',messageId:id,recipientPrincipalId:principal.principalId,membershipEpoch:'epoch',ai,notify:false,event:{type:'message',eventId:id,conversationId:'group',conversationSeq:seq,message}}
    q.receive(delivery);q.advance(q.member('group',principal.principalId,'epoch'));return delivery
  }
  const original=receive('task',1),source={kind:'ds-bot-communication',conversationId:'group',recipientPrincipalId:principal.principalId,membershipEpoch:'epoch',deliveryId:'task',messageId:'task'}
  const events=[{seq:1,type:'turn/start',data:{turn:1}},{seq:2,type:'user/message',data:{source}},{seq:3,type:'assistant/message',data:{turn:1,message:{id:'final',content:[{type:'text',text:'Substantive final result'}]}}},{seq:4,type:'turn/end',data:{turn:1,reason:{kind:'completed'}}}]
  const registry={composedPreset:()=>COMMUNICATION_PRESET,inspectCompositions:()=>[{id:COMMUNICATION_PRESET,modules:[{moduleName:'@deepseek-ai/dsh-persona'}],leakedServices:[]}]}
  const runtime=Object.assign(Object.create(CommunicationRuntime.prototype),{queue:q,bots:new Map([['worker',principal]]),contacts:[],scope:()=>{},errors:new Map(),ctx:{get:()=>registry,sessionController:{resolveAgent:async()=>({agent:{ctx:{},session:{}}}),inspect:async()=>({events})},sessions:{flush:async()=>{}},parallel:async()=>{}},member:()=>({membershipEpoch:'epoch'})})
  return {q,binding,source,original,events,runtime,receive}
}

test('completion check reminds up to three times and preserves the original plain-text draft',async t=>{
 const {q,binding,runtime,events}=fixture(t)
 events.splice(events.findIndex(e=>e.type==='turn/end'),1)
 events.find(e=>e.type==='assistant/message').data.message.content.unshift({type:'reasoning',text:'PRIVATE_REASONING'})
 runtime.owners=new Map([['session',binding]]);runtime.authorize=async()=>{}
 const notices=[],agent={id:'session',session:{},steer:notice=>notices.push(notice)}
 await checkCommunicationCompletion(runtime,{agent,turn:1})
 assert.equal(notices.length,1)
 const notice=notices[0].content.map(part=>part.text).join('')
 assert.match(notice,/reply_to_communication/);assert.match(notice,/decline_communication_reply/)
 assert.equal(notice.includes('PRIVATE_REASONING'),false)
 const row=q.db.prepare('SELECT * FROM completion_checks').get()
 const exec={agent,communicationBinding:binding,communicationCausation:{causationDeliveryId:'task'}}
 assert.equal(await communicationDraft(runtime,row.draft_id,exec),'Substantive final result')
 await assert.rejects(communicationDraft(runtime,row.draft_id,{...exec,communicationCausation:{causationDeliveryId:'another'}}),{code:'COMMUNICATION_DRAFT_UNAVAILABLE'})
 await checkCommunicationCompletion(runtime,{agent,turn:1})
 assert.equal(notices.length,1);assert.equal(runtime.errors.has(binding.id),false,'same stop boundary is not another attempt')
 for(let attempt=2;attempt<=4;attempt++){
  events.push({seq:3+attempt,type:'assistant/message',data:{turn:1,message:{id:'correction-'+attempt,content:[{type:'text',text:'Still only prose'}]}}})
  await checkCommunicationCompletion(runtime,{agent,turn:1})
  assert.equal(notices.length,Math.min(attempt,3))
 }
 assert.equal(runtime.errors.get(binding.id),'REPLY_DECISION_REQUIRED')
 assert.equal(q.db.prepare('SELECT attempts FROM completion_reminders').get().attempts,3)
 assert.equal(await communicationDraft(runtime,row.draft_id,exec),'Substantive final result','reminders do not overwrite the original draft')
 assert.equal(q.pendingOutbox().length,0);assert.equal(q.replyDeclined('task'),false)
 assert.equal(q.pendingReceipts().some(row=>row.payload.status==='noReply'),false)
 events.find(e=>e.type==='assistant/message').data.message.content.push({type:'text',text:'changed'})
 await assert.rejects(communicationDraft(runtime,row.draft_id,exec),{code:'COMMUNICATION_DRAFT_UNAVAILABLE'})
})

test('reasoning-only completion has no draft and explicit silence skips correction',async t=>{
 for(const declined of [false,true]){
  const {q,binding,runtime,events}=fixture(t)
  events.splice(events.findIndex(e=>e.type==='turn/end'),1)
  events.find(e=>e.type==='assistant/message').data.message.content=[{type:'reasoning',text:'PRIVATE_REASONING'}]
  runtime.owners=new Map([['session',binding]]);runtime.authorize=async()=>{}
  if(declined)q.recordDecision(binding,{deliveryId:'task'},'declined','no_reply')
  const notices=[],agent={id:'session',session:{},steer:notice=>notices.push(notice)}
  await checkCommunicationCompletion(runtime,{agent,turn:1})
  assert.equal(notices.length,declined?0:1)
  if(!declined){assert.equal(q.db.prepare('SELECT draft_id FROM completion_checks').get().draft_id,null);assert.equal(JSON.stringify(notices).includes('PRIVATE_REASONING'),false)}
 }
})

test('collection rechecks existing request without sending and returns bounded partial status',async()=>{
 const calls=[],runtime=Object.assign(Object.create(CommunicationRuntime.prototype),{
  transport:{welcome:{capabilities:['group-progress-collection']},request:async(type,input)=>{calls.push({type,input});return{complete:false,reports:[{principalId:'bot:b:k',status:'pending'}]}}},
  member:()=>({kind:'group',membershipEpoch:'epoch'}),queue:{intent:()=>null},sendBot:()=>assert.fail('status query must not resend')})
 const actor={principalId:'bot:a:k'},exec={communicationBinding:{conversationId:'group',membershipEpoch:'epoch'}}
 const result=await runtime.collectProgress(actor,{requestMessageId:'request',waitSeconds:0},exec)
 assert.equal(result.timedOut,true);assert.equal(result.requestMessageId,'request');assert.equal(calls.length,1)
 assert.equal(calls[0].input.principalId,actor.principalId)
 await assert.rejects(runtime.collectProgress(actor,{requestMessageId:'request',text:'new',waitSeconds:0},exec),{code:'INVALID_REQUEST'})
 runtime.transport.welcome.capabilities=[]
 await assert.rejects(runtime.collectProgress(actor,{requestMessageId:'request',waitSeconds:0},exec),{code:'UNSUPPORTED_CAPABILITY'})
})

test('pending or rejected explicit reply never publishes subsequent private final text',async t=>{
  for(const outcome of ['accepted','failed']){
    const {q,binding,runtime}=fixture(t)
    q.commitExports('tool',[{sourceKey:'tool',parts:[{text:'attempt',part:0}]}],[],()=>runtime.message(binding.recipientPrincipalId,'group',{text:'attempt',messageId:'tool-message',responseToDeliveryId:'task',replyToMessageId:'task'}),{bindingId:binding.id,deliveryId:'task'})
    await runtime.export(binding)
    assert.equal(q.db.prepare('SELECT count(*) n FROM exports').get().n,1,'final text has no network intent')
    if(outcome==='accepted')q.accepted('tool-message',{messageId:'tool-message'})
    else q.rejected('tool-message','TARGET_NOT_RECEIVING')
    await runtime.export(binding);await runtime.export(binding)
    const messages=q.db.prepare('SELECT payload FROM outbox').all().map(row=>JSON.parse(row.payload))
    assert.equal(messages.length,1)
    assert.equal(messages.some(m=>m.content.text==='Substantive final result'),false)
  }
})

test('a supplement maps only to its original authorized input and cannot export an older result',async t=>{
  const {q,binding,source,runtime,receive}=fixture(t)
  const update=receive('update',2,{updateForMessageId:'task',updateRecipientPrincipalId:binding.recipientPrincipalId},false)
  const updateSource={...source,kind:'ds-bot-communication-update',deliveryId:'update',messageId:'update'}
  assert.equal(sourceDelivery(q,binding,updateSource).deliveryId,'task')
  assert.throws(()=>sourceDelivery(q,binding,{...updateSource,membershipEpoch:'old'}),{code:'COMMUNICATION_INPUT_SOURCE_UNKNOWN'})
  await runtime.export(binding)
  assert.equal(q.pendingOutbox().length,0)
  q.updateState(update,'accepted',{sessionId:'session',messageId:'local-update',seq:5})
  await runtime.export(binding)
  assert.equal(q.pendingOutbox().length,0,'an earlier generated final did not read the supplement')
  assert.equal(q.pendingReceipts().filter(r=>r.payload.status==='updateRead').length,1)
  q.updateState(update,'accepted',{sessionId:'session',messageId:'local-update',seq:5})
  assert.equal(q.pendingReceipts().filter(r=>r.payload.status==='updateRead').length,1)
})


test('pending final survives reopen without duplicate publication',async t=>{
  const directory=mkdtempSync(join(tmpdir(),'dsbot-update-'))
  const path=join(directory,'queue.sqlite')
  const {q,binding,runtime}=fixture(t,path)
  q.commitExports('tool',[{sourceKey:'tool',parts:[{text:'attempt',part:0}]}],[],()=>runtime.message(binding.recipientPrincipalId,'group',{text:'attempt',messageId:'tool-message',responseToDeliveryId:'task',replyToMessageId:'task'}),{bindingId:binding.id,deliveryId:'task'})
  await runtime.export(binding)
  q.close()
  const reopened=new CommunicationQueue(path,{instanceId:'b'})
  t.after(()=>{reopened.close();rmSync(directory,{recursive:true,force:true})})
  reopened.authorized=true;runtime.queue=reopened
  await runtime.export(binding)
  assert.equal(reopened.pendingOutbox().length,1)
  reopened.rejected('tool-message','TARGET_NOT_RECEIVING')
  await runtime.export(binding);await runtime.export(binding)
  assert.equal(reopened.pendingOutbox().length,0)
})

test('read receipt requires a targeted update and stable model input mapping',t=>{
  const {q,binding,original,receive}=fixture(t)
  assert.throws(()=>q.updateState(original,'accepted',{sessionId:'s',messageId:'m',seq:1}))
  const update=receive('update',2,{updateForMessageId:'task',updateRecipientPrincipalId:binding.recipientPrincipalId},false)
  assert.throws(()=>q.updateState(update,'accepted',{}),{code:'INVALID_AI_MAPPING'})
  q.updateState(update,'accepted',{sessionId:'s',messageId:'m',seq:1})
  assert.throws(()=>q.updateState(update,'accepted',{sessionId:'other',messageId:'m',seq:1}),{code:'AI_MAPPING_CONFLICT'})
})


test('accepted update and pending read receipt survive restart and replay',t=>{
  const directory=mkdtempSync(join(tmpdir(),'dsbot-update-read-')),path=join(directory,'queue.sqlite')
  const {q,binding,receive}=fixture(t,path)
  const update=receive('update',2,{updateForMessageId:'task',updateRecipientPrincipalId:binding.recipientPrincipalId},false)
  const mapping={sessionId:'session',messageId:'local-update',seq:5}
  q.updateState(update,'injecting');q.updateState(update,'accepted',mapping);q.close()
  const reopened=new CommunicationQueue(path,{instanceId:'b'})
  t.after(()=>{reopened.close();rmSync(directory,{recursive:true,force:true})})
  reopened.authorized=true
  reopened.updateState(update,'accepted',mapping)
  assert.equal(reopened.inputUpdates(binding)[0].state,'accepted')
  assert.deepEqual(reopened.inputUpdates(binding)[0].mapping,mapping)
  assert.equal(reopened.pendingReceipts().filter(r=>r.payload.status==='updateRead').length,1)
})


test('restart waits for a pending reply and does not regenerate a Hub-accepted reply',async t=>{
  const {q,binding,runtime,events}=fixture(t)
  events.splice(2,2,{seq:3,type:'turn/end',data:{turn:1,reason:{kind:'interrupted'}}})
  q.commitExports('tool',[{sourceKey:'tool',parts:[{text:'result',part:0}]}],[],()=>runtime.message(binding.recipientPrincipalId,'group',{text:'result',messageId:'tool-message',responseToDeliveryId:'task',replyToMessageId:'task'}),{bindingId:binding.id,deliveryId:'task'})
  runtime.authorize=()=>assert.fail('accepted reply must not resume the model')
  await runtime.recoverInterrupted(binding)
  q.accepted('tool-message',{messageId:'tool-message'})
  await runtime.recoverInterrupted(binding)
})

test('a private final creates a missing-decision audit without a decline receipt, never a message',async t=>{
 const {q,binding,runtime,events}=fixture(t)
 const agent={id:'session',status:'idle',inbox:{nextTurn:[],nextStep:[]}}
 assert.equal(legacySessionSettled(q,binding,agent,events),false)
 await runtime.export(binding);await runtime.export(binding)
 assert.equal(q.pendingOutbox().length,0)
 const decisions=q.db.prepare('SELECT * FROM outbound_decisions').all()
 assert.equal(decisions.length,1);assert.equal(decisions[0].outcome,'decision_missing')
 assert.equal(JSON.stringify(decisions).includes('Substantive final result'),false)
 const audit=q.routingAudit(1)
 assert.equal(audit.decisions.length,1);assert.equal(audit.decisions[0].sourceDeliveryId,'task')
 assert.ok(audit.decisions[0].createdAt);assert.equal(audit.decisions[0].audience,'local')
 assert.equal(JSON.stringify(audit).includes('Substantive final result'),false)
 for(const limit of [0,-1,201,1.1,'50'])assert.throws(()=>q.routingAudit(limit),{code:'INVALID_REQUEST'})
 assert.equal(q.pendingReceipts().filter(r=>r.payload.status==='noReply').length,0)
 assert.equal(legacySessionSettled(q,binding,agent,events),false,'private finals with durable decisions do not prevent workspace/segment rotation')
 events.at(-1).data.reason.kind='interrupted'
 assert.equal(legacySessionSettled(q,binding,agent,events),false,'a crash after a durable terminal decision must not strand the next workspace')
 q.db.prepare("UPDATE outbound_decisions SET outcome='pending'").run()
 assert.equal(legacySessionSettled(q,binding,agent,events),false,'uncertain explicit sends cannot authorize segment migration')
})

test('explicit reply accepts only its current host epoch and cannot select a different conversation or sender',async()=>{
 const binding={id:'binding',conversationId:'group',membershipEpoch:'epoch'},causal={causationDeliveryId:'delivery',replyToMessageId:'source'}
 const runtime=Object.assign(Object.create(CommunicationRuntime.prototype),{sendBot:async(actor,input,exec)=>({actor,input,explicit:exec.explicitReply})})
 const actor={principalId:'bot:local:one'},exec={communicationBinding:binding,communicationCausation:causal}
 const result=await runtime.replyBot(actor,{text:'public',membershipEpoch:'epoch'},exec)
 assert.equal(result.input.conversationId,'group');assert.equal(result.input.replyToMessageId,'source');assert.equal(result.explicit,true)
 for(const extra of [{conversationId:'other'},{author:'forged'},{membershipEpoch:'old'}])await assert.rejects(()=>runtime.replyBot(actor,{text:'public',...extra},exec))
 await assert.rejects(()=>runtime.replyBot(actor,{text:'public'},{}),{code:'COMMUNICATION_INPUT_SOURCE_UNKNOWN'})
})

test('explicit decline validates its exact source and is terminal locally without sending a goodbye',async t=>{
 const {q,binding,runtime}=fixture(t);runtime.authorize=async()=>{}
 const actor={principalId:binding.recipientPrincipalId},exec={communicationBinding:binding,communicationCausation:{causationDeliveryId:'task',replyToMessageId:'task'}}
 await runtime.declineReply(actor,exec);await runtime.declineReply(actor,exec)
 assert.equal(q.replyDeclined('task'),true);assert.equal(q.pendingOutbox().length,0)
 assert.equal(q.pendingReceipts().filter(r=>r.payload.status==='noReply').length,1)
 await assert.rejects(runtime.sendBot(actor,{conversationId:'group',text:'late progress',continueReply:true},{...exec,callId:'late-call',agent:{id:'session'},communicationSource:'late-source'}),{code:'RESPONSE_ALREADY_SENT'})
 await assert.rejects(runtime.declineReply(actor,{...exec,communicationCausation:{causationDeliveryId:'forged',replyToMessageId:'task'}}),{code:'COMMUNICATION_INPUT_SOURCE_UNKNOWN'})
})

test('a completed empty final requires an explicit decision',async t=>{
 const {q,runtime,binding,events}=fixture(t)
 events[2].data.message.content=[]
 await runtime.export(binding)
 assert.equal(q.pendingOutbox().length,0)
 assert.equal(q.routingAudit().decisions[0].outcome,'decision_missing')
 assert.equal(q.routingAudit().decisions[0].bytes,0)
 assert.equal(q.pendingReceipts().filter(r=>r.payload.status==='noReply').length,0)
})

test('upgrade quarantines an uncommitted legacy automatic final but retains explicit tool sends',async t=>{
 const directory=mkdtempSync(join(tmpdir(),'dsbot-output-policy-')),path=join(directory,'queue.sqlite')
 const {q,binding,runtime}=fixture(t,path),persisted=q.binding('group',binding.recipientPrincipalId,'epoch','worker')
 for(const [id,owner]of [['auto',persisted.id],['explicit','tool:session']])q.commitExports(owner,[{sourceKey:id,parts:[{part:0,text:id}]}],[],()=>runtime.message(binding.recipientPrincipalId,'group',{text:id,messageId:id}))
 q.enqueueMessage(runtime.message(binding.recipientPrincipalId,'group',{text:'explicit supplement',messageId:'input-update-explicit',updateForMessageId:'handoff',updateRecipientPrincipalId:'bot:a:other'}))
 q.db.prepare("DELETE FROM metadata WHERE key='explicit-output-v1'").run();q.close()
 const opened=new CommunicationQueue(path,{instanceId:'b'})
 try{assert.equal(opened.outboxStatus('auto').error,'LEGACY_AUTO_EXPORT_QUARANTINED');assert.equal(opened.outboxStatus('explicit').state,'pending');assert.equal(opened.outboxStatus('input-update-explicit').state,'pending')}
 finally{opened.close();rmSync(directory,{recursive:true,force:true})}
})

test('an old Hub cannot receive updated Bot sends or no-reply receipts under legacy semantics',async t=>{
 for(const decision of ['send','no_reply']){
  const {q,binding,runtime}=fixture(t)
  if(decision==='send')q.enqueueMessage(runtime.message(binding.recipientPrincipalId,'group',{text:'public',messageId:'explicit',replyToMessageId:'task',responseToDeliveryId:'task'}))
  else q.recordDecision(binding,{deliveryId:'task'},'decline:task','no_reply')
  const requests=[],transport=new CommunicationTransport(q,{url:'ws://127.0.0.1:1/communication'})
  transport.connected=true;transport.welcome={capabilities:['proactive-bot-roots']}
  transport.request=async(type,payload)=>{
   requests.push({type,payload})
   if(type==='memberships.list')return{memberships:[]}
   if(type==='deliveries.pull')return[]
   return{}
  }
  await transport.synchronize()
  assert.equal(requests.some(r=>r.type==='message.publish'||r.payload?.status==='noReply'),false)
  if(decision==='send')assert.equal(q.outboxStatus('explicit').error,'EXPLICIT_REPLY_CAPABILITY_REQUIRED')
  else assert.equal(q.routingAudit().decisions[0].controlReceipt.error,'EXPLICIT_REPLY_CAPABILITY_REQUIRED')
 }
})


test('completion reminder budget survives restart and counts legacy one-reminder rows',async t=>{
 const folder=mkdtempSync(join(tmpdir(),'comm-completion-'));t.after(()=>rmSync(folder,{recursive:true,force:true}))
 const path=join(folder,'queue.sqlite'),{q,binding,runtime,events}=fixture(t,path)
 events.pop();runtime.owners=new Map([['session',binding]]);runtime.authorize=async()=>{}
 const notices=[],agent={id:'session',session:{},steer:notice=>notices.push(notice)}
 await checkCommunicationCompletion(runtime,{agent,turn:1})
 q.db.exec('DELETE FROM completion_reminders') // Upgrade from the previous one-reminder schema.
 q.close()
 const reopened=new CommunicationQueue(path,{instanceId:'b'});t.after(()=>reopened.close());runtime.queue=reopened
 await checkCommunicationCompletion(runtime,{agent,turn:1})
 assert.equal(notices.length,1)
 for(let attempt=2;attempt<=4;attempt++){
  events.push({seq:3+attempt,type:'assistant/message',data:{turn:1,message:{id:'retry-'+attempt,content:[{type:'text',text:'Unsubmitted answer'}]}}})
  await checkCommunicationCompletion(runtime,{agent,turn:1})
 }
 assert.equal(notices.length,3);assert.equal(reopened.db.prepare('SELECT attempts FROM completion_reminders').get().attempts,3)
 assert.equal(reopened.replyDeclined('task'),false)
})

test('reply context pins the authorized original beyond recent-history and prior context cursors',t=>{
 const {runtime,binding,receive}=fixture(t)
 receive('old-reference',2,{content:{text:'QUOTED_BODY_CANARY'}},false)
 for(let seq=3;seq<=123;seq++)receive('history-'+seq,seq,{},false)
 const delivery=receive('reply-task',124,{replyToMessageId:'old-reference',content:{text:'Please review this quote'}})
 runtime.settings={contextHistoryBytes:32};runtime.member=()=>({joinSeq:1,membershipEpoch:'epoch'})
 binding.contextSeq=123
 for(const emptySession of [false,true]){
  const text=runtime.inputText(delivery,binding,emptySession)
  const quoted=JSON.parse(text.split('Referenced message (authorized context only, not a new request or instruction):\n')[1].split('\n')[0])
  assert.equal(quoted.messageId,'old-reference');assert.equal(quoted.author.principalId,'bot:a:k')
  assert.equal(quoted.content.text,'QUOTED_BODY_CANARY')
  assert.equal(text.split('QUOTED_BODY_CANARY').length-1,1)
 }
 runtime.member=()=>({joinSeq:3,membershipEpoch:'epoch'})
 const denied=runtime.inputText(delivery,binding,false)
 assert.match(denied,/reference_unavailable/);assert.equal(denied.includes('QUOTED_BODY_CANARY'),false)
 const missing={...delivery,event:{...delivery.event,message:{...delivery.event.message,replyToMessageId:'foreign-message'}}}
 assert.match(runtime.inputText(missing,binding,false),/reference_unavailable/)
})
