import {test} from 'node:test'
import assert from 'node:assert/strict'
import {HubStore} from '../src/store.js'
import {CAPABILITIES,PROTOCOL} from '../src/protocol.js'
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

test('model availability is authenticated, lease-bound and clears without acknowledging pending work',t=>{
 const store=new HubStore(':memory:');t.after(()=>store.close())
 const auth=store.connect('a','A',CAPABILITIES),other=store.connect('b','B',CAPABILITIES)
 const human=store.register(auth,{localId:'human',kind:'human',displayName:'Owner'})
 const bot=store.register(auth,{localId:'bot',kind:'bot',displayName:'Worker'})
 const foreign=store.register(other,{localId:'bot',kind:'bot',displayName:'Foreign'})
 let now=0
 const socket={readyState:1},presence=botPresence(store,new Map([[socket,auth]]),{now:()=>now,ttl:100})
 const report=reason=>({workingBotPrincipalIds:[],unavailableBotModels:reason?[{principalId:bot.principalId,reason}]:[]})
 store.presenceOf=presence.read
 assert.equal(presence.update(socket,auth,report('MODEL_NOT_CONFIGURED')),true)
 assert.equal(presence.update(socket,auth,report('MODEL_NOT_CONFIGURED')),false)
 assert.equal(store.contacts(auth).find(p=>p.principalId===bot.principalId).availabilityError,'MODEL_NOT_CONFIGURED')
 assert.equal(presence.read(human).availabilityError,undefined)
 assert.throws(()=>presence.update(socket,auth,{workingBotPrincipalIds:[],unavailableBotModels:[{principalId:foreign.principalId,reason:'MODEL_NOT_CONFIGURED'}]}),{code:'AUTHOR_MISMATCH'})
 assert.throws(()=>presence.update(socket,auth,report('arbitrary secret reason')),{code:'INVALID_REQUEST'})
 assert.equal(presence.read(bot).availabilityError,'MODEL_NOT_CONFIGURED')
 now=101;assert.equal(presence.read(bot).availabilityError,undefined)
 presence.update(socket,auth,report('MODEL_CREDENTIAL_MISSING'))
 assert.equal(presence.read(bot).availabilityError,'MODEL_CREDENTIAL_MISSING')
 assert.equal(presence.update(socket,auth,report(null)),true)
 assert.equal(presence.read(bot).availabilityError,undefined)
 assert.equal(store.db.prepare('SELECT count(*) n FROM events').get().n,0,'readiness never fakes work/completion events')
})


test('sender sees why a stored AI delivery is waiting, and the same delivery is admitted after recovery',t=>{
 const store=new HubStore(':memory:');t.after(()=>store.close())
 const auth=store.connect('a','A',CAPABILITIES),human=store.register(auth,{localId:'human',kind:'human',displayName:'Owner'}),bot=store.register(auth,{localId:'bot',kind:'bot',displayName:'Worker'})
 const socket={readyState:1},presence=botPresence(store,new Map([[socket,auth]]));store.presenceOf=presence.read
 const group=store.createDm(auth,{principalId:human.principalId,otherPrincipalId:bot.principalId,operationId:'create'})
 const member=store.memberships(auth).memberships.find(m=>m.conversationId===group.conversationId&&m.principalId===human.principalId)
 store.publish(auth,{protocol:PROTOCOL,type:'message.publish',messageId:'work',conversationId:group.conversationId,membershipEpoch:member.membershipEpoch,author:human,clientCreatedAt:new Date().toISOString(),content:{format:'text',text:'Please help'},mentions:[],replyToMessageId:null})
 const status=()=>store.deliveryStatus(auth,{principalId:human.principalId,messageId:'work'}).find(d=>d.recipientPrincipalId===bot.principalId)
 const delivery=status(),receipt={principalId:bot.principalId,deliveryId:delivery.deliveryId,membershipEpoch:delivery.membershipEpoch}
 store.receipt(auth,{...receipt,status:'targetStored'})
 presence.update(socket,auth,{workingBotPrincipalIds:[],unavailableBotModels:[{principalId:bot.principalId,reason:'MODEL_NOT_CONFIGURED'}]})
 assert.equal(status().availabilityError,'MODEL_NOT_CONFIGURED');assert.equal(status().aiAccepted,0)
 presence.update(socket,auth,{workingBotPrincipalIds:[],unavailableBotModels:[]})
 assert.equal(status().availabilityError,undefined);assert.equal(status().deliveryId,delivery.deliveryId)
 store.receipt(auth,{...receipt,status:'aiStarted'})
 assert.equal(status().aiAccepted,1)
 assert.equal(store.db.prepare("SELECT count(*) n FROM events WHERE type='bot.work.started'").get().n,1)
})
