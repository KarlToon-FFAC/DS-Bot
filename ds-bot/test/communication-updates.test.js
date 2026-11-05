import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CommunicationQueue } from '../src/host/federation/queue-store.js'
import { CommunicationRuntime } from '../src/host/federation/runtime.js'
import { COMMUNICATION_PRESET, sourceDelivery } from '../src/host/federation/session-scope.js'
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

test('pending tool reply retains the substantive final; rejection exports it once, acceptance suppresses it',async t=>{
  for(const outcome of ['accepted','failed']){
    const {q,binding,runtime}=fixture(t)
    q.commitExports('tool',[{sourceKey:'tool',parts:[{text:'attempt',part:0}]}],[],()=>runtime.message(binding.recipientPrincipalId,'group',{text:'attempt',messageId:'tool-message',responseToDeliveryId:'task',replyToMessageId:'task'}),{bindingId:binding.id,deliveryId:'task'})
    await runtime.export(binding)
    assert.equal(q.db.prepare('SELECT count(*) n FROM exports').get().n,1,'uncertain send must not consume the final')
    if(outcome==='accepted')q.accepted('tool-message',{messageId:'tool-message'})
    else q.rejected('tool-message','TARGET_NOT_RECEIVING')
    await runtime.export(binding);await runtime.export(binding)
    const messages=q.db.prepare('SELECT payload FROM outbox').all().map(row=>JSON.parse(row.payload))
    assert.equal(messages.length,outcome==='accepted'?1:2)
    if(outcome==='failed')assert.equal(messages[1].content.text,'Substantive final result')
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
  assert.equal(reopened.pendingOutbox().length,1)
  assert.equal(reopened.pendingOutbox()[0].payload.content.text,'Substantive final result')
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
