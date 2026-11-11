import assert from 'node:assert/strict'
import {randomUUID} from 'node:crypto'
import {writeFileSync} from 'node:fs'
import {join} from 'node:path'
import {LocalTopology,until} from './local-topology.mjs'

const nonce=randomUUID().slice(0,8),topology=new LocalTopology({prefix:'multiple-receivers-'+nonce,webPort:3481,mockPort:9181,hubPort:3489})
const previousOwner=process.env.DSBOT_COMMUNICATION_OWNER_PID
process.env.DSBOT_COMMUNICATION_OWNER_PID=String(process.pid)
const evidence={status:'RUNNING',model:'deterministic Mock',cases:[]}
const record=name=>{evidence.cases.push(name);console.log('PASS',name)}
const deadline=setTimeout(()=>{console.error('Multiple receivers acceptance timed out');void topology.close().finally(()=>process.exit(1))},180000)
try{
 await topology.initialize();const[a,b]=topology.peers
 const group=await topology.group('Multiple receivers '+nonce,[a.bot,b.bot],{allowSpeaking:false})
 const current=(await a.api({endpoint:'state'})).conversations.find(c=>c.conversationId===group)
 const configured=await topology.operation(a,'save-settings',{conversationId:group,membershipEpoch:current.membershipEpoch,expectedVersion:current.membershipVersion,routing:{mode:'admin',defaultBotPrincipalIds:[a.bot,b.bot]}})
 assert.equal(configured.updated,true)
 await until(async()=>{const state=await a.api({endpoint:'state'});return state.multipleDefaultBotsAvailable&&state.conversations.find(c=>c.conversationId===group)?.defaultBotPrincipalIds?.length===2},'both defaults reflected in live state')
 const plain=await topology.send(a,group,'COMM-ECHO plain-'+nonce)
 const replies=await until(async()=>{const stats=await topology.hub('stats');const rows=stats.messages.filter(m=>JSON.parse(m.body).replyToMessageId===plain.messageId);return rows.length===2&&rows},'both passive Bots explicitly answer the same unmentioned input')
 assert.deepEqual(replies.map(m=>m.author_id).sort(),[a.bot,b.bot].sort())
 let stats=await topology.hub('stats')
 assert.equal(stats.messages.filter(m=>m.conversation_id===group).length,3)
 assert.deepEqual(stats.deliveries.filter(d=>d.message_id===plain.messageId&&d.ai).map(d=>d.recipient_id).sort(),[a.bot,b.bot].sort())
 assert.equal(stats.deliveries.filter(d=>replies.some(m=>m.id===d.message_id)&&d.ai).length,0)
 assert.equal(JSON.stringify(stats.messages).includes('LOCAL_CLOSING_CANARY'),false)
 record('one unmentioned Human input activates both passive Bots; each explicitly answers once without waking peers')
 for(const [tag,target,extra]of [['mention',b.bot,{}],['direct-reply',a.bot,{replyToMessageId:replies.find(m=>m.author_id===a.bot).id}]]){
  const sent=await topology.send(a,group,'COMM-ECHO '+tag+'-'+nonce,tag==='mention'?[target]:[],extra)
  await until(()=>topology.hasText(a,group,'Communication reply '+tag+'-'+nonce),'targeted reply '+tag)
  stats=await topology.hub('stats')
  assert.deepEqual(stats.deliveries.filter(d=>d.message_id===sent.messageId&&d.ai).map(d=>d.recipient_id),[target])
  assert.equal(stats.messages.filter(m=>JSON.parse(m.body).replyToMessageId===sent.messageId).length,1)
  record(tag+' targets exactly one Bot despite multiple defaults')
 }
 await topology.operation(a,'remove',{conversationId:group,targetPrincipalId:b.bot})
 await until(async()=>{const c=(await a.api({endpoint:'state'})).conversations.find(c=>c.conversationId===group);return c.defaultBotPrincipalIds?.length===1&&c.defaultBotPrincipalIds[0]===a.bot},'removal prunes only the departed default')
 const after=await topology.send(a,group,'COMM-ECHO pruned-'+nonce)
 await until(()=>topology.hasText(a,group,'Communication reply pruned-'+nonce),'remaining default replies')
 stats=await topology.hub('stats');assert.deepEqual(stats.deliveries.filter(d=>d.message_id===after.messageId&&d.ai).map(d=>d.recipient_id),[a.bot])
 record('removing a selected Bot preserves the other receiver and live routing without refresh or reset')
 evidence.status='PASS'
}catch(error){evidence.status='FAIL';evidence.error=error.message;throw error}
finally{
 clearTimeout(deadline);await topology.close()
 if(previousOwner===undefined)delete process.env.DSBOT_COMMUNICATION_OWNER_PID;else process.env.DSBOT_COMMUNICATION_OWNER_PID=previousOwner
 writeFileSync(join(topology.root,topology.prefix+'-acceptance.json'),JSON.stringify(evidence,null,2))
}
