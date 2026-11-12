import assert from 'node:assert/strict'
import {test} from 'node:test'
import {install as installChatIndex} from '../src/host/chat-index.js'
import {historyEntry} from '../src/host/parts.js'
import {localIdentityTools} from '../src/host/federation/local-identity-tools.js'

test('exact local message IDs resolve across own parts without revealing reasoning or another Bot history',async()=>{
 const events={old:[{type:'user/message',seq:1,data:{id:'user-id',source:{kind:'user'},content:[{type:'text',text:'Original local request'}]}},{type:'assistant/message',seq:2,data:{message:{id:'answer-id',content:[{type:'reasoning',text:'private reasoning'},{type:'text',text:'Complete answer '+ 'x'.repeat(9000)}]}}}],current:[],other:[{type:'user/message',seq:1,data:{id:'foreign-id',source:{kind:'user'},content:[{type:'text',text:'Foreign secret'}]}}]}
 const seen=[]
 const rt={home:'/unused-synthetic',ctx:{effect:()=>{},sessionController:{page:async({address})=>{seen.push(address.sessionId);return {records:events[address.sessionId].map(event=>({event})),hasMore:false}}}},
  partsOf:id=>{assert.equal(id,'owner');return [{sessionId:'old',number:1},{sessionId:'current',number:2}]},resolveAgent:async id=>({session:{seq:events[id].length+1}}),historyEntry}
 installChatIndex(rt)
 const answer=await rt.ownChatMessage('owner','answer-id')
 assert.equal(answer.text,'Complete answer '+ 'x'.repeat(9000));assert.equal(answer.seq,2);assert.equal(answer.part,1)
 assert.equal(answer.audience,'internal');assert.equal(answer.automaticRemoteReply,false)
 assert.doesNotMatch(JSON.stringify(answer),/private reasoning/)
 assert.equal((await rt.ownChatMessage('owner','user-id')).text,'Original local request')
 assert.equal(await rt.ownChatMessage('owner','foreign-id'),undefined)
 assert.ok(!seen.includes('other'))
})

test('remote local tools keep the real execution identity and reject withdrawn definitions or revoked membership',async()=>{
 const local={name:'create_bot',execute:async(args,exec)=>({actor:exec.agent.id,args})}
 const history={name:'read_own_chat',execute:async args=>args}
 const remote={name:'reply_to_communication'}
 const binding={id:'b',localBotRef:'owner'}
 const runtime={tools:[remote],owners:new Map([['remote',binding]]),rt:{teamTools:[local,history,remote,{name:'group_relay'}]},authorize:async b=>assert.equal(b,binding)}
 const tools=localIdentityTools(runtime)
 assert.deepEqual(tools.map(t=>t.name),['create_bot','read_own_chat'])
 assert.deepEqual(await tools[0].execute({name:'New colleague'},{agent:{id:'remote'}}),{actor:'remote',args:{name:'New colleague'}})
 assert.deepEqual(await tools[1].execute({message_id:'local-id'},{agent:{id:'remote'}}),{message_id:'local-id'})
 runtime.rt.teamTools=[]
 await assert.rejects(tools[0].execute({}, {agent:{id:'remote'}}),{code:'COMMUNICATION_INPUT_SOURCE_UNKNOWN'})
 runtime.rt.teamTools=[local]
 runtime.authorize=async()=>{throw Object.assign(new Error('revoked'),{code:'MEMBERSHIP_REVOKED'})}
 await assert.rejects(tools[0].execute({}, {agent:{id:'remote'}}),{code:'MEMBERSHIP_REVOKED'})
})
