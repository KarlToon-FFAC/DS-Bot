import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { ScopedStore as HubStore } from './fixtures/scoped-store.mjs'
import { HubManagement } from '../src/management-store.js'
import { CAPABILITIES } from '../src/protocol.js'

const op = input => ({operationId:randomUUID(),...input})
function fixture(t) {
  const store=new HubStore(':memory:');t.after(()=>store.close())
  const a=store.connect('a','Local team',CAPABILITIES),b=store.connect('b','Remote team',CAPABILITIES)
  const add=(auth,localId,kind)=>store.register(auth,{localId,kind,displayName:localId}).principalId
  const A=add(a,'Alice','human'),B=add(b,'Buddy','human'),one=add(a,'One','bot'),two=add(b,'Two','bot')
  return {store,a,b,A,B,one,two,add}
}
test('contact consent follows current published Bots, includes later publications and fences withdrawn Bot DMs on revocation',t=>{
  const {store,a,b,A,B,one,two,add}=fixture(t),m=new HubManagement(store)
  store.directoryFilter=(auth,rows,id)=>m.filterDirectory(auth,rows,id)
  store.contactPolicy=(auth,actor,target)=>m.assertContact(auth,actor,target)
  store.dmPolicy=id=>m.assertDm(id)
  const request=m.requestContact(a,op({principalId:A,userCode:m.code(b,{principalId:B}).userCode,sharePublishedBots:true}))
  m.respondContact(b,op({principalId:B,requestId:request.requestId,expectedVersion:1,sharePublishedBots:true}),'accept')
  assert.equal(m.canContact(one,two),true)
  const later=add(a,'Later','bot')
  assert.ok(store.contacts(b,{principalId:B}).some(person=>person.principalId===later))
  const dm=store.createDm(b,op({principalId:B,otherPrincipalId:one})).conversationId
  const oldEpoch=store.db.prepare('SELECT epoch FROM memberships WHERE conversation_id=? AND principal_id=?').get(dm,one).epoch
  store.syncPublication(a,{principalIds:[later]})
  assert.equal(m.canContact(B,one),false)
  assert.ok(!store.contacts(b,{principalId:B}).some(person=>person.principalId===one))
  assert.deepEqual(m.relations(a,{principalId:A})[0].botPrincipalIds,[later])
  assert.throws(()=>m.requestContact(a,op({principalId:A,userCode:'ignored',sharePublishedBots:true,botPrincipalIds:[two]})),{code:'INVALID_REQUEST'})
  m.revokeContact(a,op({principalId:A,otherHumanPrincipalId:B,expectedVersion:1}))
  assert.equal(m.canContact(B,later),false)
  assert.notEqual(store.db.prepare('SELECT epoch FROM memberships WHERE conversation_id=? AND principal_id=?').get(dm,one).epoch,oldEpoch)
  assert.throws(()=>m.assertDm(dm),{code:'CONTACT_REQUIRED'})
})
test('local and remote group additions join immediately with the canonical Human owner and preserve replay safety',t=>{
  const {store,a,b,A,B,one,two}=fixture(t)
  const group=store.createGroup(a,op({principalId:A,title:'Review'})).conversationId
  assert.equal(store.invite(a,op({principalId:A,conversationId:group,inviteePrincipalId:one})).joined,true)
  const input=op({principalId:A,conversationId:group,inviteePrincipalId:two}),result=store.invite(a,input)
  assert.deepEqual(store.invite(a,input),result)
  assert.equal(result.joined,true)
  assert.ok(store.memberships(b).memberships.some(item=>item.principalId===two&&item.active))
  assert.ok(store.memberships(b).memberships.some(item=>item.principalId===B&&item.active))
  assert.equal(store.memberships(b).invites.length,0)
  assert.throws(()=>store.accept(a,op({principalId:one,inviteId:result.inviteId})),{code:'FORBIDDEN'})
  assert.equal(store.accept(b,op({principalId:two,inviteId:result.inviteId})).membershipEpoch,result.membershipEpoch)
})

test('Bot-created groups include the Human owner and CLI-style Bot-only additions cannot omit the remote owner',t=>{
 const {store,a,b,A,B,one,two}=fixture(t)
 const group=store.createGroup(a,op({principalId:one,title:'Agent-created'})).conversationId
 const own=store.memberships(a).memberships.filter(row=>row.conversationId===group)
 assert.equal(own.find(row=>row.principalId===one).role,'owner')
 assert.equal(own.find(row=>row.principalId===A).role,'member')
 store.invite(a,op({principalId:one,conversationId:group,inviteePrincipalId:two}))
 assert.ok(store.memberships(b).memberships.some(row=>row.conversationId===group&&row.principalId===B))
 assert.ok(store.memberships(b).memberships.some(row=>row.conversationId===group&&row.principalId===two))
 assert.throws(()=>store.remove(a,op({principalId:A,conversationId:group,targetPrincipalId:A})),{code:'OWNER_TRANSFER_REQUIRED'})
})
test('a full group rejects owner and Bot additions atomically instead of creating a Bot-only membership',t=>{
 const {store,a,b,A,B,two}=fixture(t)
 store.limits.maxMembers=2
 const group=store.createGroup(a,op({principalId:A,title:'Full'})).conversationId
 assert.throws(()=>store.invite(a,op({principalId:A,conversationId:group,inviteePrincipalId:two})),{code:'MEMBER_LIMIT'})
 assert.equal(store.memberships(b).memberships.filter(row=>row.conversationId===group).length,0)
 assert.equal(store.db.prepare('SELECT count(*) n FROM invites WHERE conversation_id=?').get(group).n,0)
 assert.ok(!store.db.prepare('SELECT 1 FROM memberships WHERE conversation_id=? AND principal_id=?').get(group,B))
})
test('startup repair restores never-joined owners of legacy Bot groups, is idempotent and preserves an explicit departure',t=>{
 const {store,a,b,A,B,two}=fixture(t)
 const group=store.createGroup(a,op({principalId:A,title:'Legacy missing owner'})).conversationId
 store.transaction(()=>store.joinInvitedPrincipal(store.groupInviteRecord(two,group,A),two))
 assert.ok(!store.memberships(b).memberships.some(row=>row.principalId===B))
 store.repairGroupJoins()
 assert.ok(store.memberships(b).memberships.some(row=>row.principalId===B&&row.conversationId===group))
 const epoch=store.db.prepare('SELECT epoch FROM memberships WHERE conversation_id=? AND principal_id=?').get(group,B).epoch
 store.repairGroupJoins()
 assert.equal(store.db.prepare('SELECT epoch FROM memberships WHERE conversation_id=? AND principal_id=?').get(group,B).epoch,epoch)
 store.remove(a,op({principalId:A,conversationId:group,targetPrincipalId:B}))
 assert.ok(!store.memberships(b).memberships.some(row=>row.conversationId===group&&row.active))
 store.repairGroupJoins()
 assert.ok(!store.memberships(b).memberships.some(row=>row.conversationId===group&&row.active))
})

test('a real Hub restart repairs legacy missing Human membership before serving clients and keeps the repaired epoch stable',async t=>{
 const {mkdtempSync,rmSync}=await import('node:fs'),{tmpdir}=await import('node:os'),{join}=await import('node:path')
 const {startHub}=await import('../src/server.js')
 const root=mkdtempSync(join(tmpdir(),'dsbot-group-repair-')),databasePath=join(root,'hub.sqlite')
 const options={databasePath,port:0,peers:[{instanceId:'a',credential:'synthetic-test-credential-local-a-12345'},{instanceId:'b',credential:'synthetic-test-credential-local-b-12345'}]}
 let hub=await startHub(options)
 t.after(async()=>{await hub?.close();rmSync(root,{recursive:true,force:true})})
 const a=hub.store.connect('a','A',CAPABILITIES),b=hub.store.connect('b','B',CAPABILITIES)
 const A=hub.store.register(a,{localId:'owner',kind:'human',displayName:'Alice'}).principalId
 const B=hub.store.register(b,{localId:'owner',kind:'human',displayName:'Buddy'}).principalId
 const bot=hub.store.register(b,{localId:'worker',kind:'bot',displayName:'Worker'}).principalId
 const group=hub.store.createGroup(a,op({principalId:A,title:'Legacy hidden group'})).conversationId
 hub.store.transaction(()=>hub.store.joinInvitedPrincipal(hub.store.groupInviteRecord(bot,group,A),bot))
 assert.ok(!hub.store.db.prepare('SELECT 1 FROM memberships WHERE conversation_id=? AND principal_id=?').get(group,B))
 await hub.close();hub=await startHub(options)
 const repaired=hub.store.db.prepare('SELECT * FROM memberships WHERE conversation_id=? AND principal_id=?').get(group,B)
 assert.equal(repaired.active,1)
 await hub.close();hub=await startHub(options)
 assert.equal(hub.store.db.prepare('SELECT epoch FROM memberships WHERE conversation_id=? AND principal_id=?').get(group,B).epoch,repaired.epoch)
})

test('a legacy active Bot still brings in its canonical Human when the original inviter has left',t=>{
 const {store,a,b,A,B,two}=fixture(t)
 const c=store.connect('c','C',CAPABILITIES),C=store.register(c,{localId:'owner',kind:'human',displayName:'New owner'}).principalId
 const group=store.createGroup(a,op({principalId:A,title:'Older transferred group'})).conversationId
 store.invite(a,op({principalId:A,conversationId:group,inviteePrincipalId:C}))
 store.transaction(()=>store.joinInvitedPrincipal(store.groupInviteRecord(two,group,A),two))
 let row=store.memberships(a).memberships.find(m=>m.conversationId===group&&m.principalId===A)
 store.transfer(a,op({principalId:A,conversationId:group,membershipEpoch:row.membershipEpoch,expectedVersion:row.membershipVersion,targetPrincipalId:C}))
 store.remove(c,op({principalId:C,conversationId:group,targetPrincipalId:A}))
 store.repairGroupJoins()
 const parent=store.memberships(b).memberships.find(m=>m.conversationId===group&&m.principalId===B)
 assert.equal(parent.active,true);assert.equal(parent.role,'member');assert.equal(parent.ownerPrincipalId,C)
})

test('retired private history remains contact-scoped and cannot stall active reconciliation after contact revocation',t=>{
  const {store,a,b,A,B,one,two}=fixture(t),m=new HubManagement(store)
  store.contactPolicy=(auth,actor,target)=>m.assertContact(auth,actor,target)
  store.dmPolicy=id=>m.assertDm(id)
  const request=m.requestContact(a,op({principalId:A,userCode:m.code(b,{principalId:B}).userCode,sharePublishedBots:true}))
  m.respondContact(b,op({principalId:B,requestId:request.requestId,expectedVersion:1,sharePublishedBots:true}),'accept')
  const dm=store.createDm(a,op({principalId:one,otherPrincipalId:two})).conversationId
  const old=store.memberships(a).memberships.find(member=>member.conversationId===dm)
  store.syncPublication(a,{principalIds:[]})
  assert.equal(store.members(a,{principalId:one,conversationId:dm,membershipEpoch:old.membershipEpoch}).members.find(person=>person.principalId===one).retired,true)
  assert.ok(store.sync(a,{principalId:one,conversationId:dm,membershipEpoch:old.membershipEpoch,after:0}).events.length>0)
  m.revokeContact(a,op({principalId:A,otherHumanPrincipalId:B,expectedVersion:1}))
  assert.ok(!store.memberships(a).memberships.find(member=>member.conversationId===dm).active)
  assert.throws(()=>store.sync(a,{principalId:one,conversationId:dm,membershipEpoch:old.membershipEpoch,after:0}))
  assert.throws(()=>store.members(b,{principalId:two,conversationId:dm,membershipEpoch:store.memberships(b).memberships.find(member=>member.conversationId===dm).membershipEpoch}))
})
