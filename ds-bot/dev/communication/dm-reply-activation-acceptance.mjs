import assert from 'node:assert/strict'
import {randomUUID} from 'node:crypto'
import {writeFileSync} from 'node:fs'
import {join} from 'node:path'
import {LocalTopology,until} from './local-topology.mjs'
import {PROTOCOL} from '../../../communication-hub/src/protocol.js'
const nonce=randomUUID().slice(0,8),topology=new LocalTopology({prefix:'dm-reply-'+nonce,webPort:3475,mockPort:9175,hubPort:3479})
const cases=[],record=name=>{cases.push(name);console.log('PASS',name)}
try{
 await topology.initialize();const[a,b]=topology.peers
 const send=(peer,text,extra={})=>topology.hub('publish-scoped-dm',{instanceId:peer.instanceId,...extra,payload:{protocol:PROTOCOL,type:'message.publish',messageId:randomUUID(),author:{principalId:peer.bot,homeInstanceId:peer.instanceId,kind:'bot'},clientCreatedAt:new Date().toISOString(),content:{format:'text',text},mentions:[],activationTargets:[],replyToMessageId:null,...extra.payload}})
 const first=await send(a,'COMM-NOREPLY',{otherPrincipalId:b.bot}),dm=first.conversationId
 const completion=async messageId=>{
  const state=await a.api({endpoint:'state'}),member=state.botConversations.find(item=>item.conversationId===dm)
  if(!member)return false
  const history=await a.api({endpoint:'bot-dm-history',localBotId:a.botId,conversationId:dm,membershipEpoch:member.membershipEpoch,limit:100})
  return history.events.find(event=>event.type==='bot.work.completed'&&event.messageId===messageId)
 }
 // Wait for the initial no-reply receipt before sending a new deliberate question.
 await until(()=>completion(first.messageId),'initial no-reply control receipt')
 let quoted=first.messageId
 for(let round=1;round<=2;round++){
  const tag=`${nonce}-${round}`,input=await send(b,`COMM-ECHO ${tag}`,{payload:{conversationId:dm,replyToMessageId:quoted}})
  assert.deepEqual(input.activatedBotPrincipalIds,[a.bot])
  const reply=await until(async()=>{const stats=await topology.hub('stats');return stats.messages.find(row=>row.conversation_id===dm&&row.author_id===a.bot&&JSON.parse(row.body).content.text===`Communication reply ${tag}`)},'quoted DM starts a real model turn and publishes answer')
  const stats=await topology.hub('stats'),delivery=stats.deliveries.find(row=>row.message_id===input.messageId&&row.recipient_id===a.bot)
  assert.equal(delivery.ai,1);assert.equal(delivery.stored,1);assert.equal(delivery.ai_accepted,1)
  await until(()=>completion(reply.id),'peer explicitly declines the answer without chat acknowledgement')
  quoted=reply.id
  record(`round ${round}: plain DM reply with empty mentions/activationTargets starts receiver work and produces exactly one public answer`)
 }
 await until(async()=>{const stats=await topology.hub('stats');return stats.deliveries.filter(row=>row.recipient_id===b.bot&&row.ai).every(row=>row.ai_accepted)},'all responder inputs accepted')
 const stats=await topology.hub('stats'),messages=stats.messages.filter(row=>row.conversation_id===dm)
 assert.equal(messages.length,5)
 assert.equal(JSON.stringify(messages).includes('LOCAL_CLOSING_CANARY'),false)
 record('two substantive replies yield five total messages; private finals stay local and no acknowledgement messages are manufactured')
 writeFileSync(join(topology.root,topology.prefix+'-acceptance.json'),JSON.stringify({status:'PASS',model:'Mock',cases},null,2))
}finally{await topology.close()}
