import assert from 'node:assert/strict'
import { test } from 'node:test'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname, resolve, basename } from 'node:path'
import { ScopedStore as HubStore } from './fixtures/scoped-store.mjs'
import { DatabaseSync } from 'node:sqlite'
import { CAPABILITIES, PROTOCOL } from '../src/protocol.js'
import { CommunicationQueue } from '../../ds-bot/src/host/federation/queue-store.js'

const auth = (store,id) => store.connect(id,id,CAPABILITIES)
const register = (store,owner,localId,kind='human') => store.register(owner,{localId,kind,displayName:kind==='bot'?'Chief':localId}).principalId
const message = (principalId,conversationId,text='hello',extra={}) => ({protocol:PROTOCOL,type:'message.publish',messageId:randomUUID(),conversationId,
  author:{principalId,homeInstanceId:principalId.split(':')[1],kind:principalId.split(':')[0]},clientCreatedAt:'2026-11-03T00:00:00.000Z',
  content:{format:'markdown',text},mentions:[],replyToMessageId:null,...extra,...(principalId.startsWith('bot:')?{activationTargets:extra.activationTargets??extra.mentions??[]}: {})})
const operation = input => ({operationId:randomUUID(),...input})
function fixture(t,options={}){
  const store=new HubStore(':memory:',options);t.after(()=>store.close())
  const a=auth(store,'a'),b=auth(store,'b')
  const A=register(store,a,'A'),J=register(store,a,'J','bot'),B=register(store,b,'B'),K=register(store,b,'K','bot')
  return {store,a,b,A,J,B,K}
}
function joinGroup(f,conversationId,principalId){
  const invite=f.store.invite(f.a,operation({conversationId,principalId:f.A,inviteePrincipalId:principalId}))
  const accepted=f.store.accept(principalId.split(':')[1]==='a'?f.a:f.b,operation({principalId,inviteId:invite.inviteId}))
  const version=f.store.memberships(f.a).memberships.find(member=>member.conversationId===conversationId&&member.principalId===f.A).membershipVersion
  f.store.policy(f.a,operation({conversationId,principalId:f.A,targetPrincipalId:principalId,expectedVersion:version,speakingMode:principalId.startsWith('bot:')?'active':'speak'}))
  return accepted
}
const directory=()=>mkdtempSync(join(tmpdir(),'dsbot-hub-'))
function cleanDirectory(path){assert.equal(dirname(resolve(path)),resolve(tmpdir()));assert.ok(basename(path).startsWith('dsbot-hub-'));rmSync(path,{recursive:true,force:true})}

test('reverse DM creation and duplicate publish retain canonical identity across a real SQLite reopen',t=>{
  const root=directory(),path=join(root,'hub.sqlite')
  let store=new HubStore(path)
  t.after(()=>{store.close();cleanDirectory(root)})
  const a=auth(store,'a'),b=auth(store,'b'),A=register(store,a,'A'),B=register(store,b,'B')
  const first=store.createDm(a,operation({principalId:A,otherPrincipalId:B}))
  assert.equal(store.createDm(b,operation({principalId:B,otherPrincipalId:A})).conversationId,first.conversationId)
  const input=message(A,first.conversationId),accepted=store.publish(a,input)
  const delivery=store.pending(b)[0]
  assert.deepEqual(store.publish(a,{...input}),accepted)
  assert.equal(store.db.prepare('SELECT count(*) count FROM messages').get().count,1)
  store.close();store=new HubStore(path)
  const a2=auth(store,'a'),b2=auth(store,'b')
  assert.throws(()=>store.publish(a,input),{code:'STALE_CONNECTION'})
  assert.deepEqual(store.publish(a2,input),accepted)
  assert.equal(store.pending(b2)[0].deliveryId,delivery.deliveryId)
  assert.equal(store.createDm(b2,operation({principalId:B,otherPrincipalId:A})).conversationId,first.conversationId)
  assert.throws(()=>store.publish(b2,input),{code:'AUTHOR_MISMATCH'})
  assert.throws(()=>store.publish(a2,{...input,content:{format:'text',text:'changed'}}),{code:'MESSAGE_ID_CONFLICT'})
})

test('an injected failure rolls back event, sequence and every recipient delivery before acceptance',t=>{
  let fault=false
  const f=fixture(t,{beforeCommit:()=>{if(fault)throw new Error('injected storage fault')}})
  const conversationId=f.store.createDm(f.a,operation({principalId:f.A,otherPrincipalId:f.B})).conversationId
  const input=message(f.A,conversationId)
  fault=true
  assert.throws(()=>f.store.publish(f.a,input),/injected storage fault/)
  assert.equal(f.store.db.prepare('SELECT seq FROM conversations WHERE id=?').get(conversationId).seq,1)
  assert.equal(f.store.db.prepare('SELECT count(*) count FROM messages').get().count,0)
  assert.equal(f.store.pending(f.b).length,0)
  fault=false
  assert.equal(f.store.publish(f.a,input).conversationSeq,2)
  assert.equal(f.store.pending(f.b).length,1)
})

test('adapter authorization and member metadata remain scoped to the exact principal and current membership epoch',t=>{
  const f=fixture(t),{store,a,b,A,B,K}=f
  const conversationId=store.createDm(a,operation({principalId:A,otherPrincipalId:K})).conversationId
  const member=store.memberships(b).memberships.find(item=>item.principalId===K)
  const input={conversationId,principalId:K,membershipEpoch:member.membershipEpoch}
  assert.equal(store.authorize(b,input).principalId,K)
  assert.deepEqual(new Set(store.members(b,input).members.map(item=>item.principalId)),new Set([A,K]))
  assert.throws(()=>store.authorize(b,{...input,principalId:B}),{code:'NOT_A_MEMBER'})
  assert.throws(()=>store.members(b,{...input,principalId:B}),{code:'NOT_A_MEMBER'})
  assert.throws(()=>store.authorize(a,input),{code:'AUTHOR_MISMATCH'})
  assert.throws(()=>store.authorize(b,{...input,membershipEpoch:'old-epoch'}),{code:'MEMBERSHIP_REVOKED'})
})

test('ending a group revokes every unfinished delivery and invitation atomically while preserving already admitted work',t=>{
  const f=fixture(t),{store,a,b,A,B,K}=f
  const conversationId=store.createGroup(a,operation({principalId:A,title:'Disposable group'})).conversationId
  joinGroup(f,conversationId,K)
  const invite=store.invite(a,operation({principalId:A,conversationId,inviteePrincipalId:B}))
  const inputs=[message(A,conversationId,'already admitted',{mentions:[{principalId:K}]}),message(A,conversationId,'pending',{mentions:[{principalId:K}]})]
  for(const input of inputs)store.publish(a,input)
  const first=store.pending(b).find(item=>item.messageId===inputs[0].messageId)
  store.receipt(b,{deliveryId:first.deliveryId,principalId:K,membershipEpoch:first.membershipEpoch,status:'targetStored'})
  store.receipt(b,{deliveryId:first.deliveryId,principalId:K,membershipEpoch:first.membershipEpoch,status:'aiAccepted'})
  assert.throws(()=>store.dissolve(b,operation({principalId:K,conversationId})),{code:'FORBIDDEN'})
  const input=operation({principalId:A,conversationId}),result=store.dissolve(a,input)
  assert.deepEqual(store.dissolve(a,input),result)
  assert.equal(store.pending(b).length,0)
  assert.ok(store.memberships(b).memberships.every(member=>!member.active))
  assert.equal(store.memberships(b).invites.length,0)
  assert.throws(()=>store.accept(b,operation({principalId:B,inviteId:invite.inviteId})))
  const rows=store.db.prepare('SELECT ai_accepted,revoked FROM deliveries WHERE recipient_id=? ORDER BY rowid').all(K)
  assert.deepEqual(rows.map(row=>({...row})),[{ai_accepted:1,revoked:0},{ai_accepted:0,revoked:1}])
  assert.equal(store.db.prepare("SELECT count(*) n FROM events WHERE type='conversation.dissolved'").get().n,1)
})

test('a Human view read before delayed delivery arrival retains correct unread and distinct stored/display/read receipts',t=>{
  const {store,a,b,A,B}=fixture(t)
  const conversationId=store.createDm(a,operation({principalId:A,otherPrincipalId:B})).conversationId
  const input=message(A,conversationId);store.publish(a,input)
  const snapshot=store.memberships(b),member=snapshot.memberships.find(item=>item.principalId===B)
  const queue=new CommunicationQueue(':memory:',{instanceId:'b'});t.after(()=>queue.close())
  queue.applyMemberships(snapshot)
  queue.applySync(store.sync(b,{conversationId,principalId:B,membershipEpoch:member.membershipEpoch,after:0,limit:100}))
  queue.markView(conversationId,B,member.membershipEpoch,member.watermark,{humanRead:true})
  assert.equal(queue.unread(conversationId,B,member.membershipEpoch),0)
  queue.receive(store.pending(b)[0])
  assert.deepEqual(queue.pendingReceipts().map(item=>item.payload.status),['targetStored','uiApplied','humanRead'])
  assert.equal(queue.pendingAi().length,0)
})

test('bounded local AI inbox refuses storage acknowledgement until admitted work frees capacity',t=>{
  const {store,a,b,A,K}=fixture(t)
  const conversationId=store.createDm(a,operation({principalId:A,otherPrincipalId:K})).conversationId
  store.publish(a,message(A,conversationId,'one'));store.publish(a,message(A,conversationId,'two'))
  const queue=new CommunicationQueue(':memory:',{instanceId:'b',maxPending:1});t.after(()=>queue.close())
  queue.applyMemberships(store.memberships(b))
  const deliveries=store.pending(b)
  queue.receive(deliveries[0])
  assert.throws(()=>queue.receive(deliveries[1]),{code:'BACKPRESSURE'})
  assert.equal(queue.db.prepare('SELECT count(*) n FROM inbox').get().n,1)
  assert.equal(queue.pendingReceipts().filter(item=>item.payload.deliveryId===deliveries[1].deliveryId).length,0)
  queue.aiState(deliveries[0].deliveryId,'accepted',{sessionId:'local',messageId:'exact-input',seq:1})
  queue.receive(deliveries[1])
  assert.equal(queue.db.prepare('SELECT count(*) n FROM inbox').get().n,2)
})

test('group routing uses exact identities and never treats a Human mention or ordinary Bot reply as an AI broadcast',t=>{
  const f=fixture(t),{store,a,b,A,J,B,K}=f
  const conversationId=store.createGroup(a,operation({principalId:A,title:'Shared group'})).conversationId
  for(const principal of [B,J,K])joinGroup(f,conversationId,principal)
  assert.equal(store.contacts(a).filter(p=>p.displayName==='Chief').length,2)
  store.routing(a,operation({conversationId,principalId:A,mode:'admin',adminBotPrincipalId:J}))
  const publish=(author,text,mentions=[])=>{const input=message(author,conversationId,text,{mentions:mentions.map(principalId=>({principalId}))});store.publish(author.split(':')[1]==='a'?a:b,input);return store.db.prepare('SELECT recipient_id,ai,notify FROM deliveries WHERE message_id=?').all(input.messageId)}
  assert.deepEqual(publish(A,'default').filter(d=>d.ai).map(d=>d.recipient_id),[J])
  assert.deepEqual(publish(A,'exact bot',[K]).filter(d=>d.ai).map(d=>d.recipient_id),[K])
  assert.deepEqual(publish(A,'human only',[B]).filter(d=>d.ai),[])
  assert.deepEqual(publish(J,'ordinary Bot reply').filter(d=>d.ai),[])
  assert.throws(()=>publish(A,'unknown',['bot:b:missing']),{code:'UNKNOWN_MENTION'})
  assert.throws(()=>store.routing(b,operation({conversationId,principalId:B,mode:'admin',adminBotPrincipalId:K})),{code:'FORBIDDEN'})
  store.remove(a,operation({conversationId,principalId:A,targetPrincipalId:J}))
  const routed=store.db.prepare('SELECT routing_mode,admin_bot FROM conversations WHERE id=?').get(conversationId)
  assert.equal(routed.routing_mode,'mentionsOnly')
  assert.equal(routed.admin_bot,null)
  const leave=operation({conversationId,principalId:B,targetPrincipalId:B})
  assert.deepEqual(store.remove(b,leave),{revoked:true})
  assert.deepEqual(store.remove(b,leave),{revoked:true})
})

test('unaccepted invitations, per-principal join boundaries and rejoin epochs cannot expose old events or revive revoked deliveries',t=>{
  const f=fixture(t),{store,a,b,A,B,K}=f
  const conversationId=store.createGroup(a,operation({principalId:A,title:'Shared group'})).conversationId
  joinGroup(f,conversationId,B)
  const old=message(A,conversationId,'before K joins');store.publish(a,old)
  const invite=store.invite(a,operation({conversationId,principalId:A,inviteePrincipalId:K}))
  assert.throws(()=>store.sync(b,{conversationId,principalId:K,after:0}),{code:'NOT_A_MEMBER'})
  const membership=store.accept(b,operation({principalId:K,inviteId:invite.inviteId}))
  const history=store.sync(b,{conversationId,principalId:K,membershipEpoch:membership.membershipEpoch,after:0})
  assert.equal(history.events[0].conversationSeq,membership.joinSeq)
  assert.ok(history.events.every(e=>e.message?.messageId!==old.messageId))
  const input=message(A,conversationId,'pending K',{mentions:[{principalId:K}]});store.publish(a,input)
  const pending=store.pending(b).find(d=>d.recipientPrincipalId===K)
  store.receipt(b,{deliveryId:pending.deliveryId,principalId:K,membershipEpoch:pending.membershipEpoch,status:'targetStored'})
  assert.throws(()=>store.receipt(b,{deliveryId:pending.deliveryId,principalId:K,status:'aiAccepted'}),{code:'MEMBERSHIP_REVOKED'})
  store.remove(a,operation({conversationId,principalId:A,targetPrincipalId:K}))
  assert.throws(()=>store.receipt(b,{deliveryId:pending.deliveryId,principalId:K,membershipEpoch:pending.membershipEpoch,status:'aiAccepted'}),{code:'MEMBERSHIP_REVOKED'})
  const again=joinGroup(f,conversationId,K)
  assert.notEqual(again.membershipEpoch,membership.membershipEpoch)
  assert.ok(again.joinSeq>pending.event.conversationSeq)
  assert.ok(!store.pending(b).some(d=>d.deliveryId===pending.deliveryId))
  const row=store.db.prepare('SELECT revoked FROM deliveries WHERE id=?').get(pending.deliveryId)
  assert.equal(row.revoked,1)
  const reply=message(K,conversationId,'cannot reference old cache',{replyToMessageId:old.messageId})
  assert.throws(()=>store.publish(b,reply),{code:'INVALID_REPLY_TARGET'})
})

test('payload limits count UTF-8 bytes; attachments, cross-conversation references and forged authors fail explicitly',t=>{
  const f=fixture(t,{limits:{maxTextBytes:8}}),{store,a,b,A,B,J}=f
  const conversationId=store.createDm(a,operation({principalId:A,otherPrincipalId:B})).conversationId
  assert.throws(()=>store.publish(a,message(A,conversationId,'中文啊')),{code:'PAYLOAD_TOO_LARGE'})
  const first=message(A,conversationId,'中文');store.publish(a,first)
  assert.throws(()=>store.publish(a,message(A,conversationId,'x',{attachments:[{}]})),{code:'INVALID_ATTACHMENT'})
  assert.throws(()=>store.publish(b,first),{code:'AUTHOR_MISMATCH'})
  const second=store.createDm(a,operation({principalId:A,otherPrincipalId:J})).conversationId
  assert.throws(()=>store.publish(a,message(A,second,'x',{replyToMessageId:first.messageId})),{code:'INVALID_REPLY_TARGET'})
  assert.throws(()=>store.register(a,{localId:'forged:id',kind:'human',displayName:'bad'}),{code:'INVALID_REQUEST'})
})

test('client gap buffering is durable and cannot advance projection or AI consumption over a missing sequence',t=>{
  const root=directory(),path=join(root,'client.sqlite')
  let queue=new CommunicationQueue(path,{instanceId:'b'})
  t.after(()=>{queue.close();cleanDirectory(root)})
  const member={conversationId:'c',principalId:'bot:b:K',membershipEpoch:'epoch-1',joinSeq:3,active:true}
  queue.applyMemberships({memberships:[member]})
  const event=seq=>({conversationId:'c',conversationSeq:seq,eventId:`event-${seq}`,type:'message',message:{messageId:`m-${seq}`}})
  const delivery={deliveryId:'delivery-5',messageId:'m-5',conversationId:'c',recipientPrincipalId:member.principalId,membershipEpoch:member.membershipEpoch,ai:true,notify:false,event:event(5)}
  queue.applySync({...member,events:[event(3)]})
  queue.receive(delivery)
  assert.equal(queue.cursor('c',member.principalId,member.membershipEpoch),3)
  assert.equal(queue.view('c',member.principalId,member.membershipEpoch).length,1)
  assert.equal(queue.pendingAi().length,0)
  assert.throws(()=>queue.applied(delivery.deliveryId),{code:'HISTORY_GAP'})
  queue.close();queue=new CommunicationQueue(path,{instanceId:'b'})
  assert.equal(queue.pendingAi().length,0,'restart requires fresh membership reconciliation')
  queue.applyMemberships({memberships:[member]})
  queue.applySync({...member,events:[event(4)]})
  assert.equal(queue.cursor('c',member.principalId,member.membershipEpoch),5)
  assert.equal(queue.pendingAi().length,1)
  queue.aiState(delivery.deliveryId,'injecting')
  queue.aiState(delivery.deliveryId,'injection_unknown')
  assert.equal(queue.pendingAi()[0].state,'injection_unknown')
  queue.aiState(delivery.deliveryId,'accepted',{sessionId:'s',messageId:'dsh-input',seq:10})
  assert.equal(queue.pendingAi().length,0)
  assert.ok(queue.pendingReceipts().some(r=>r.payload.status==='aiAccepted'))
  queue.applyMemberships({memberships:[{...member,membershipEpoch:'epoch-2',joinSeq:6}]})
  assert.throws(()=>queue.view('c',member.principalId,'epoch-1'),{code:'MEMBERSHIP_REVOKED'})
  assert.equal(queue.view('c',member.principalId,'epoch-2').length,0)
})

test('export source mapping, complete outbox and cursor commit together and reuse source identity after replay',t=>{
  let fault=false
  const queue=new CommunicationQueue(':memory:',{instanceId:'a',beforeCommit:()=>{if(fault)throw new Error('injected export fault')}})
  t.after(()=>queue.close())
  const output={sourceKey:'[binding,s,7,message]',parts:[{part:0,text:'final'}]}
  const make=()=>message('bot:a:J','c','final')
  fault=true
  assert.throws(()=>queue.commitExports('binding',[output],[{sessionId:'s',seq:7}],make),/injected export fault/)
  assert.equal(queue.pendingOutbox().length,0)
  assert.equal(queue.db.prepare('SELECT count(*) count FROM exports').get().count,0)
  assert.equal(queue.db.prepare('SELECT count(*) count FROM export_cursors').get().count,0)
  fault=false
  const ids=queue.commitExports('binding',[output],[{sessionId:'s',seq:7}],make)
  assert.deepEqual(queue.commitExports('binding',[output],[{sessionId:'s',seq:7}],()=>{throw new Error('must reuse')}),ids)
  assert.equal(queue.pendingOutbox().length,1)
  assert.throws(()=>queue.commitExports('binding',[{...output,parts:[{part:0,text:'changed'}]}],[],make),{code:'EXPORT_SOURCE_CONFLICT'})
})

test('future database schema versions are refused before migration and existing records remain intact',()=>{
  const root=directory()
  try{
    for(const [name,version,load] of [['hub',6,path=>new HubStore(path)],['client',6,path=>new CommunicationQueue(path,{instanceId:'a'})]]){
      const path=join(root,`${name}-future.sqlite`),future=new DatabaseSync(path)
      future.exec(`PRAGMA user_version=${version}; CREATE TABLE marker(value TEXT); INSERT INTO marker VALUES ('keep');`)
      future.close()
      assert.throws(()=>load(path),{code:'SCHEMA_VERSION_UNSUPPORTED'})
      const checked=new DatabaseSync(path)
      try{
        assert.equal(checked.prepare('SELECT value FROM marker').get().value,'keep')
        assert.equal(checked.prepare('PRAGMA user_version').get().user_version,version)
      }finally{checked.close()}
    }
  }finally{cleanDirectory(root)}
})

test('instance trust revocation is durable and old deliveries stay revoked after explicit re-pair and canonical DM reopen',t=>{
  const root=directory(),path=join(root,'hub.sqlite')
  let store=new HubStore(path)
  t.after(()=>{store.close();cleanDirectory(root)})
  const a=auth(store,'a'),b=auth(store,'b'),A=register(store,a,'A'),B=register(store,b,'B')
  const {conversationId}=store.createDm(a,operation({principalId:A,otherPrincipalId:B}))
  const input=message(A,conversationId);store.publish(a,input)
  const original=store.pending(b)[0]
  store.revokeInstance('b')
  assert.throws(()=>store.contacts(b),{code:'UNAUTHENTICATED'})
  assert.ok(!store.contacts(a).some(p=>p.homeInstanceId==='b'))
  store.close();store=new HubStore(path)
  assert.equal(store.db.prepare('SELECT trusted FROM instances WHERE id=?').get('b').trusted,0)
  assert.throws(()=>auth(store,'b'),{code:'UNAUTHENTICATED'})
  store.configurePeer('b','b',2)
  const a2=auth(store,'a'),b2=auth(store,'b')
  assert.equal(store.createDm(a2,operation({principalId:A,otherPrincipalId:B})).conversationId,conversationId)
  assert.ok(!store.pending(b2).some(d=>d.deliveryId===original.deliveryId))
  const now=store.memberships(b2).memberships[0]
  assert.notEqual(now.membershipEpoch,original.membershipEpoch)
  assert.ok(now.joinSeq>original.event.conversationSeq)
  assert.equal(store.db.prepare('SELECT revoked FROM deliveries WHERE id=?').get(original.deliveryId).revoked,1)
})

test('client validates negotiated UTF-8/content limits and reports durable outbox backpressure without optimistic success',t=>{
  const queue=new CommunicationQueue(':memory:',{instanceId:'a',maxPending:1})
  t.after(()=>queue.close())
  queue.setLimits({maxTextBytes:8,maxEnvelopeBytes:131072})
  assert.throws(()=>queue.enqueueMessage(message('human:a:A','c','中文啊')),{code:'PAYLOAD_TOO_LARGE'})
  assert.throws(()=>queue.enqueueMessage(message('human:a:A','c','x',{content:{format:'text',text:'x',image:{}}})),{code:'UNSUPPORTED_CONTENT'})
  assert.equal(queue.pendingOutbox().length,0)
  const first=message('human:a:A','c','中文');queue.enqueueMessage(first)
  assert.equal(queue.enqueueMessage({...first}),first.messageId)
  assert.throws(()=>queue.enqueueMessage(message('human:a:A','c','next')),{code:'OUTBOX_FULL'})
  queue.rejected(first.messageId,'MEMBERSHIP_REVOKED')
  assert.equal(queue.outboxStatus(first.messageId).state,'failed')
  assert.equal(queue.outboxStatus(first.messageId).error,'MEMBERSHIP_REVOKED')
  assert.equal(queue.pendingOutbox().length,0)
})

test('bounded sync and delivery pages preserve whole messages and continue from the original sequence',t=>{
  const {store,a,b,A,B}=fixture(t,{limits:{maxTextBytes:2000,maxEnvelopeBytes:4096}})
  const {conversationId}=store.createDm(a,operation({principalId:A,otherPrincipalId:B}))
  for(let index=0;index<3;index+=1)store.publish(a,message(A,conversationId,String(index).repeat(1500)))
  let after=0
  const messages=[]
  while(after<4){
    const page=store.sync(b,{conversationId,principalId:B,after,limit:100})
    assert.ok(Buffer.byteLength(JSON.stringify(page))<=4096)
    assert.ok(page.events.length>0)
    messages.push(...page.events.filter(e=>e.type==='message').map(e=>e.message))
    after=page.events.at(-1).conversationSeq
  }
  assert.deepEqual(messages.map(m=>m.content.text.length),[1500,1500,1500])
  const delivered=[]
  while(true){
    const pending=store.pending(b)
    if(!pending.length)break
    assert.ok(Buffer.byteLength(JSON.stringify(pending))<=4096)
    for(const delivery of pending){
      delivered.push(delivery.messageId)
      store.receipt(b,{deliveryId:delivery.deliveryId,principalId:B,membershipEpoch:delivery.membershipEpoch,status:'targetStored'})
    }
  }
  assert.equal(new Set(delivered).size,3)
})
