import {test} from 'node:test'
import assert from 'node:assert/strict'
import {HubStore} from '../src/store.js'
import {CAPABILITIES} from '../src/protocol.js'
import {botPresence} from '../src/presence.js'

test('presence is scoped to authenticated sockets, expires, and is shared with authorized member and contact views',t=>{
  const store=new HubStore(':memory:');t.after(()=>store.close())
  const a=store.connect('a','A',CAPABILITIES),b=store.connect('b','B',CAPABILITIES)
  const human=store.register(a,{localId:'human',kind:'human',displayName:'Owner'})
  const bot=store.register(a,{localId:'bot',kind:'bot',displayName:'Worker'})
  const remote=store.register(b,{localId:'remote',kind:'bot',displayName:'Other'})
  const socket={readyState:1},peers=new Map([[socket,a]])
  let now=0
  const presence=botPresence(store,peers,{now:()=>now,ttl:100})
  store.presenceOf=presence.read
  assert.deepEqual(presence.read(bot),{connected:true,working:null})
  assert.deepEqual(presence.read(remote),{connected:false,working:false})
  assert.equal(presence.update(socket,a,{workingBotPrincipalIds:[bot.principalId]}),true)
  assert.equal(presence.update(socket,a,{workingBotPrincipalIds:[bot.principalId]}),false)
  assert.deepEqual(presence.read(bot),{connected:true,working:true})
  assert.throws(()=>presence.update(socket,a,{workingBotPrincipalIds:[remote.principalId]}),{code:'AUTHOR_MISMATCH'})
  assert.throws(()=>presence.update(socket,a,{workingBotPrincipalIds:[human.principalId]}),{code:'BOT_NOT_PUBLISHED'})
  const group=store.createGroup(a,{operationId:'create',principalId:human.principalId,title:'Presence'})
  const owner=store.memberships(a).memberships.find(m=>m.conversationId===group.conversationId)
  const invite=store.invite(a,{operationId:'invite',principalId:human.principalId,conversationId:group.conversationId,membershipEpoch:owner.membershipEpoch,inviteePrincipalId:bot.principalId})
  store.accept(a,{operationId:'accept',principalId:bot.principalId,inviteId:invite.inviteId})
  const member=()=>store.members(a,{conversationId:group.conversationId,principalId:human.principalId,membershipEpoch:owner.membershipEpoch}).members.find(p=>p.principalId===bot.principalId)
  assert.equal(member().working,true)
  assert.equal(store.contacts(a).find(p=>p.principalId===bot.principalId).working,true)
  now=101;assert.equal(member().working,null)
  assert.equal(presence.update(socket,a,{workingBotPrincipalIds:[]}),true)
  assert.equal(member().working,false)
  socket.readyState=3;assert.equal(member().connected,false)
  const replacement={readyState:1};peers.delete(socket);peers.set(replacement,a)
  assert.equal(member().working,null,'a new socket cannot inherit old red status')
  store.revokeInstance('a');assert.equal(presence.read(bot).connected,false)
})
