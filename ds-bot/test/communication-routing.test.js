import assert from 'node:assert/strict'
import {test} from 'node:test'
import {CommunicationQueue} from '../src/host/federation/queue-store.js'
import {CommunicationRuntime} from '../src/host/federation/runtime.js'
import {CommunicationTransport} from '../src/host/federation/transport.js'
import {MULTI_BOT_ROUTING_CAPABILITY,groupRoutingPayload} from '../src/shared/communication-routing.js'
import {prepare} from '../bin/dsbot-remote.mjs'
import {operationOutcomeUncertain} from '../src/client/communication-errors.js'

function fixture(t,capabilities=[]){
 const queue=new CommunicationQueue(':memory:',{instanceId:'local'});t.after(()=>queue.close())
 const human=queue.localPrincipal('human','user','Owner')
 queue.applyMemberships({memberships:[{conversationId:'group',principalId:human.principalId,membershipEpoch:'epoch',joinSeq:1,active:true,kind:'group',membershipVersion:1}]})
 const runtime=Object.assign(Object.create(CommunicationRuntime.prototype),{queue,everReconciled:true,conversations:new Map(),transport:{connected:false,welcome:{capabilities}}})
 return{queue,runtime,human}
}
const selection={conversationId:'group',expectedVersion:1,routing:{mode:'admin',defaultBotPrincipalIds:['bot:local:a','bot:remote:b']}}

test('old Hubs retain deterministic legacy singleton/disabled payloads while CLI accepts exact multi-selection',()=>{
 for(const type of ['group.routing','group.settings']){
  const wrap=route=>type==='group.routing'?route:{title:'unchanged',routing:route}
  const unwrap=payload=>type==='group.routing'?payload:payload.routing
  assert.deepEqual(unwrap(groupRoutingPayload(type,wrap({mode:'admin',defaultBotPrincipalIds:['bot:a:a','bot:a:a']}))),{mode:'admin',adminBotPrincipalId:'bot:a:a'})
  assert.deepEqual(unwrap(groupRoutingPayload(type,wrap({mode:'mentionsOnly',defaultBotPrincipalIds:[]}))),{mode:'mentionsOnly',adminBotPrincipalId:null})
 }
 const input={conversationId:'group',mode:'admin',defaultBotPrincipalIds:['bot:local:a','bot:remote:b']}
 assert.deepEqual(prepare('routing',input).request.defaultBotPrincipalIds,input.defaultBotPrincipalIds)
 assert.deepEqual(prepare('save-settings',selection).request.routing,selection.routing)
 assert.throws(()=>prepare('routing',{...input,defaultBotPrincipalIds:[1]}))
 for(const value of [[],['bot:a:a'],[1]])if(!value.length||typeof value[0]!=='string')assert.throws(()=>groupRoutingPayload('group.routing',{mode:'admin',defaultBotPrincipalIds:value}))
})

test('multiple defaults require capability before enqueue; accepted retries retain identity after capabilities change',async t=>{
 const {queue,runtime,human}=fixture(t)
 await assert.rejects(runtime.operation(human.principalId,'group.settings',selection,'multi'),{code:'MULTI_BOT_ROUTING_REQUIRED'})
 assert.equal(queue.pendingOutbox().length,0)
 assert.equal(operationOutcomeUncertain({code:'MULTI_BOT_ROUTING_REQUIRED'}),false)
 await runtime.operation(human.principalId,'group.settings',{...selection,routing:{mode:'admin',defaultBotPrincipalIds:['bot:local:a']}},'one')
 assert.equal(queue.intent('one').payload.routing.adminBotPrincipalId,'bot:local:a')
 runtime.transport.welcome.capabilities=[MULTI_BOT_ROUTING_CAPABILITY]
 await runtime.operation(human.principalId,'group.settings',selection,'multi')
 const accepted={updated:true,membershipVersion:2};queue.accepted('multi',accepted)
 runtime.transport.welcome.capabilities=[]
 assert.deepEqual(await runtime.operation(human.principalId,'group.settings',selection,'multi'),accepted)
 await runtime.operation(human.principalId,'group.settings',{...selection,routing:{mode:'admin',defaultBotPrincipalIds:['bot:local:a']}},'one')
 assert.equal(queue.pendingOutbox().filter(item=>item.id==='one').length,1)
})

test('reconnect to an older Hub blocks a saved multi-receiver operation without sending a downgraded request',async t=>{
 const {queue,human}=fixture(t),id='queued-multi'
 queue.enqueueOperation('group.settings',{...selection,principalId:human.principalId,membershipEpoch:'epoch',operationId:id})
 const transport=new CommunicationTransport(queue,{url:'ws://127.0.0.1:1/communication'}),requests=[]
 transport.connected=true;transport.welcome={capabilities:[]};transport.request=async type=>{requests.push(type);return type==='memberships.list'?{memberships:[]}:type==='deliveries.pull'?[]:{}}
 await transport.synchronize()
 assert.equal(queue.outboxStatus(id).error,'MULTI_BOT_ROUTING_REQUIRED');assert.equal(requests.includes('group.settings'),false)
})
