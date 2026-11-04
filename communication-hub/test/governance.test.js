import assert from 'node:assert/strict'
import { test } from 'node:test'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ScopedStore as HubStore } from './fixtures/scoped-store.mjs'
import { CAPABILITIES, PROTOCOL } from '../src/protocol.js'

const op=values=>({operationId:randomUUID(),...values})
function fixture(t,path=':memory:'){
  const store=new HubStore(path);t.after(()=>store.close())
  const a=store.connect('a','A',CAPABILITIES),b=store.connect('b','B',CAPABILITIES)
  const add=(auth,id,kind)=>store.register(auth,{localId:id,kind,displayName:'Chief'}).principalId
  const A=add(a,'A','human'),B=add(b,'B','human'),J=add(a,'J','bot'),K=add(b,'K','bot')
  const group=store.createGroup(a,op({principalId:A,title:'Governance group'})).conversationId
  const accept=(id,auth)=>{
    const invite=store.invite(a,op({conversationId:group,principalId:A,inviteePrincipalId:id}))
    return store.accept(auth,op({principalId:id,inviteId:invite.inviteId}))
  }
  accept(B,b);accept(J,a);accept(K,b)
  const version=()=>store.memberships(a).memberships.find(member=>member.conversationId===group).membershipVersion
  const policy=(target,values={},auth=a,actor=A)=>store.policy(auth,op({conversationId:group,principalId:actor,targetPrincipalId:target,expectedVersion:version(),...values}))
  const publish=(auth,id,text,extra={})=>store.publish(auth,{protocol:PROTOCOL,type:'message.publish',messageId:randomUUID(),conversationId:group,
    author:{principalId:id,kind:id.split(':')[0],homeInstanceId:id.split(':')[1]},clientCreatedAt:new Date().toISOString(),content:{format:'text',text},mentions:[],replyToMessageId:null,...extra})
  return {store,a,b,A,B,J,K,group,version,policy,publish}
}

test('owner/admin/member matrix, default-denied speech and concurrent policy updates are authoritative',t=>{
  const f=fixture(t),{store,a,b,A,B,J,K,group,policy,publish}=f
  assert.equal(store.memberships(b).memberships.find(m=>m.principalId===B).speakingMode,'readOnly')
  assert.equal(store.memberships(b).memberships.find(m=>m.principalId===K).speakingMode,'passive')
  assert.throws(()=>publish(b,B,'forged UI send'),{code:'SPEAKING_FORBIDDEN'})
  assert.throws(()=>policy(B,{role:'admin'},b,B),{code:'FORBIDDEN'})
  policy(B,{role:'admin'})
  assert.throws(()=>publish(b,B,'admin is still read only'),{code:'SPEAKING_FORBIDDEN'})
  assert.throws(()=>policy(B,{role:'owner'},b,B),{code:'FORBIDDEN'})
  assert.throws(()=>policy(A,{speakingMode:'readOnly'},b,B),{code:'FORBIDDEN'})
  assert.throws(()=>policy(J,{role:'admin'},b,B),{code:'FORBIDDEN'})
  policy(J,{speakingMode:'active'},b,B)
  publish(a,J,'explicitly allowed Bot')
  policy(K,{role:'admin'})
  assert.throws(()=>policy(K,{speakingMode:'active'},b,B),{code:'FORBIDDEN'})
  assert.throws(()=>store.remove(b,op({principalId:B,conversationId:group,targetPrincipalId:K})),{code:'FORBIDDEN'})
  assert.throws(()=>store.remove(b,op({principalId:B,conversationId:group,targetPrincipalId:A})),{code:'OWNER_TRANSFER_REQUIRED'})
  assert.throws(()=>store.dissolve(b,op({principalId:B,conversationId:group})),{code:'FORBIDDEN'})
  const version=f.version(),first=op({principalId:A,conversationId:group,targetPrincipalId:B,expectedVersion:version,speakingMode:'speak'})
  const result=store.policy(a,first)
  assert.deepEqual(store.policy(a,first),result)
  assert.throws(()=>store.policy(a,{...first,operationId:randomUUID(),expectedVersion:version,speakingMode:'readOnly'}),{code:'GROUP_VERSION_CONFLICT'})
  const accepted=publish(b,B,'accepted before downgrade')
  policy(B,{speakingMode:'readOnly'})
  assert.throws(()=>publish(b,B,'offline outbox reaches Hub after downgrade'),{code:'SPEAKING_FORBIDDEN'})
  const saved=JSON.parse(store.db.prepare('SELECT body FROM messages WHERE id=?').get(accepted.messageId).body)
  assert.deepEqual(store.publish(b,saved),accepted)
  assert.throws(()=>policy(J,{speakingMode:'speak'}),{code:'INVALID_SPEAKING_MODE'})
})

test('passive replies require one real stored AI delivery and may explicitly delegate without replay',t=>{
  const {store,a,b,A,B,J,K,group,policy,publish}=fixture(t)
  const first=publish(a,A,'ask passive K',{mentions:[{principalId:K}]})
  const delivery=store.pending(b).find(d=>d.messageId===first.messageId&&d.recipientPrincipalId===K)
  assert.throws(()=>publish(b,K,'pretend reply',{replyToMessageId:first.messageId}),{code:'PASSIVE_REPLY_REQUIRED'})
  assert.throws(()=>publish(b,K,'forged grant',{replyToMessageId:first.messageId,responseToDeliveryId:randomUUID()}),{code:'INVALID_RESPONSE_GRANT'})
  const values={replyToMessageId:first.messageId,responseToDeliveryId:delivery.deliveryId,mentions:[{principalId:J}]}
  assert.throws(()=>publish(b,K,'not stored yet',values),{code:'INVALID_RESPONSE_GRANT'})
  store.receipt(b,{deliveryId:delivery.deliveryId,principalId:K,membershipEpoch:delivery.membershipEpoch,status:'targetStored'})
  store.beforeCommit=()=>{throw new Error('simulated storage loss')}
  assert.throws(()=>publish(b,K,'rolled back response',values),/simulated storage loss/)
  store.beforeCommit=undefined
  assert.equal(store.db.prepare('SELECT count(*) n FROM responses WHERE delivery_id=?').get(delivery.deliveryId).n,0)
  const reply=publish(b,K,'one final response',values)
  assert.equal(store.db.prepare('SELECT sum(ai) n FROM deliveries WHERE message_id=?').get(reply.messageId).n,1)
  assert.throws(()=>publish(b,K,'second final response',values),{code:'RESPONSE_ALREADY_SENT'})
  assert.equal(store.publish(b,JSON.parse(store.db.prepare('SELECT body FROM messages WHERE id=?').get(reply.messageId).body)).messageId,reply.messageId)
  const other=store.createGroup(b,op({principalId:B,title:'Other group'})).conversationId
  const otherInvite=store.invite(b,op({principalId:B,conversationId:other,inviteePrincipalId:K}))
  store.accept(b,op({principalId:K,inviteId:otherInvite.inviteId}))
  assert.throws(()=>publish(b,K,'wrong conversation',{...values,conversationId:other}),{code:'INVALID_RESPONSE_GRANT'})
  const unrelated=publish(a,A,'display only')
  const nonAi=store.pending(b).find(d=>d.messageId===unrelated.messageId&&d.recipientPrincipalId===K)
  store.receipt(b,{deliveryId:nonAi.deliveryId,principalId:K,membershipEpoch:nonAi.membershipEpoch,status:'targetStored'})
  assert.throws(()=>publish(b,K,'display is not activation',{replyToMessageId:unrelated.messageId,responseToDeliveryId:nonAi.deliveryId}),{code:'INVALID_RESPONSE_GRANT'})
  const second=publish(a,A,'second real ask',{mentions:[{principalId:K}]})
  const old=store.pending(b).find(d=>d.messageId===second.messageId&&d.recipientPrincipalId===K)
  store.receipt(b,{deliveryId:old.deliveryId,principalId:K,membershipEpoch:old.membershipEpoch,status:'targetStored'})
  store.remove(a,op({principalId:A,conversationId:group,targetPrincipalId:K}))
  const invitation=store.invite(a,op({principalId:A,conversationId:group,inviteePrincipalId:K}))
  store.accept(b,op({principalId:K,inviteId:invitation.inviteId}))
  assert.throws(()=>publish(b,K,'old epoch grant',{replyToMessageId:second.messageId,responseToDeliveryId:old.deliveryId}),{code:'INVALID_RESPONSE_GRANT'})
  policy(K,{speakingMode:'active'})
  publish(b,K,'now explicitly active')
  policy(K,{speakingMode:'passive'})
  assert.throws(()=>publish(b,K,'queued active send arrives after downgrade'),{code:'PASSIVE_REPLY_REQUIRED'})
})

test('ownership transfer, trust loss and exact-owner reclaim never permit takeover or resurrection',t=>{
  const {store,a,b,A,B,group,version,policy}=fixture(t)
  policy(B,{role:'admin'})
  assert.throws(()=>store.remove(a,op({principalId:A,conversationId:group,targetPrincipalId:A})),{code:'OWNER_TRANSFER_REQUIRED'})
  const transfer=op({principalId:A,conversationId:group,targetPrincipalId:B,expectedVersion:version()})
  const result=store.transfer(a,transfer)
  assert.deepEqual(store.transfer(a,transfer),result)
  assert.equal(store.db.prepare("SELECT count(*) n FROM memberships WHERE conversation_id=? AND role='owner'").get(group).n,1)
  assert.throws(()=>store.transfer(a,{...transfer,operationId:randomUUID(),expectedVersion:version()}),{code:'FORBIDDEN'})
  const before=store.memberships(b).memberships.find(m=>m.principalId===B&&m.conversationId===group)
  store.revokeInstance('b')
  assert.throws(()=>store.transfer(a,op({principalId:A,conversationId:group,targetPrincipalId:A,expectedVersion:version()})),{code:'FORBIDDEN'})
  assert.throws(()=>store.reclaim(a,op({principalId:A,conversationId:group,expectedVersion:version()})),{code:'FORBIDDEN'})
  store.configurePeer('b','B',2)
  const restored=store.connect('b','B',CAPABILITIES)
  const reclaim=store.reclaim(restored,op({principalId:B,conversationId:group,expectedVersion:version()}))
  assert.notEqual(reclaim.membershipEpoch,before.membershipEpoch)
  assert.ok(reclaim.joinSeq>before.joinSeq)
  store.dissolve(restored,op({principalId:B,conversationId:group}))
  assert.throws(()=>store.reclaim(restored,op({principalId:B,conversationId:group,expectedVersion:version()})),{code:'FORBIDDEN'})
})

test('Bot-created ownership is explicit and neither its Human nor another Chief inherits it',t=>{
  const {store,a,b,A,J,K}=fixture(t)
  const group=store.createGroup(a,op({principalId:J,title:'Bot-created group'})).conversationId
  assert.throws(()=>store.invite(a,op({principalId:A,conversationId:group,inviteePrincipalId:K})),{code:'NOT_A_MEMBER'})
  assert.throws(()=>store.invite(b,op({principalId:K,conversationId:group,inviteePrincipalId:A})),{code:'NOT_A_MEMBER'})
  const invite=store.invite(a,op({principalId:J,conversationId:group,inviteePrincipalId:A}))
  store.accept(a,op({principalId:A,inviteId:invite.inviteId}))
  const members=store.memberships(a).memberships.filter(m=>m.conversationId===group)
  assert.equal(members.find(m=>m.principalId===J).role,'owner')
  assert.equal(members.find(m=>m.principalId===A).role,'member')
  assert.throws(()=>store.policy(a,op({principalId:A,conversationId:group,targetPrincipalId:A,expectedVersion:members[0].membershipVersion,role:'admin'})),{code:'FORBIDDEN'})
  store.transfer(a,op({principalId:J,conversationId:group,targetPrincipalId:A,expectedVersion:members[0].membershipVersion}))
  assert.equal(store.memberships(a).memberships.find(m=>m.conversationId===group&&m.principalId===A).role,'owner')
})

test('v1 migration retains legacy speakers, deterministically selects owner and survives reopen',t=>{
  const root=mkdtempSync(join(tmpdir(),'dsbot-governance-')),path=join(root,'hub.sqlite')
  t.after(()=>rmSync(root,{recursive:true,force:true}))
  let store=new HubStore(path)
  try{
    const a=store.connect('a','A',CAPABILITIES),b=store.connect('b','B',CAPABILITIES)
    const A=store.register(a,{localId:'A',kind:'human',displayName:'A'}).principalId
    const K=store.register(b,{localId:'K',kind:'bot',displayName:'K'}).principalId
    const group=store.createGroup(a,op({principalId:A,title:'Legacy'})).conversationId
    const invite=store.invite(a,op({principalId:A,conversationId:group,inviteePrincipalId:K}))
    store.accept(b,op({principalId:K,inviteId:invite.inviteId}))
    store.db.prepare('UPDATE memberships SET manager=1 WHERE conversation_id=? AND principal_id=?').run(group,K)
    store.db.exec('DROP TABLE responses; ALTER TABLE memberships DROP COLUMN role; ALTER TABLE memberships DROP COLUMN speaking_mode; ALTER TABLE conversations DROP COLUMN owner_id; ALTER TABLE conversations DROP COLUMN closed; DELETE FROM schema_version WHERE version=2; PRAGMA user_version=1')
    store.close();store=new HubStore(path)
    const members=store.memberships(a).memberships
    assert.equal(members[0].role,'owner');assert.equal(members[0].ownerPrincipalId,A);assert.equal(members[0].speakingMode,'speak')
    assert.equal(store.memberships(b).memberships[0].speakingMode,'active')
    assert.equal(store.memberships(b).memberships[0].role,'admin')
    const id=members[0].conversationId
    store.close();store=new HubStore(path)
    assert.equal(store.memberships(a).memberships[0].conversationId,id)
    assert.equal(store.db.prepare('PRAGMA user_version').get().user_version,2)
  }finally{store.close()}
})
