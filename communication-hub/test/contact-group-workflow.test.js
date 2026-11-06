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
test('only a local Human owner directly adds its own Bot; remote invitations retain source details and require consent',t=>{
  const {store,a,b,A,B,one,two}=fixture(t)
  store.observeAddress(a,'192.0.2.10')
  const group=store.createGroup(a,op({principalId:A,title:'Review'})).conversationId
  const local=store.invite(a,op({principalId:A,conversationId:group,inviteePrincipalId:one}))
  assert.equal(local.joined,true)
  assert.equal(store.memberships(a).invites.length,0)
  assert.ok(store.memberships(a).memberships.some(item=>item.principalId===one&&item.active))
  const intent=op({principalId:A,conversationId:group,inviteePrincipalId:two})
  const remote=store.invite(a,intent)
  assert.deepEqual(store.invite(a,intent),remote)
  assert.ok(!store.memberships(b).memberships.some(item=>item.principalId===two&&item.active))
  const pending=store.memberships(b).invites.find(item=>item.inviteId===remote.inviteId)
  assert.equal(pending.inviterPrincipalId,A);assert.equal(pending.inviterName,'Alice');assert.equal(pending.inviterIpAddress,'192.0.2.10')
  assert.equal(pending.principalName,'Two')
  assert.throws(()=>store.accept(a,op({principalId:one,inviteId:remote.inviteId})),{code:'FORBIDDEN'})
  store.accept(b,op({principalId:two,inviteId:remote.inviteId}))
  assert.ok(store.memberships(b).memberships.some(item=>item.principalId===two&&item.active))
  assert.equal(store.ownerOfPrincipal(two),B)
})
