// Same-machine real DSH A/B + Hub, with local deterministic Mock models only.
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { fork } from 'node:child_process'
import { createServer } from 'node:net'
import { existsSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { LocalTopology, until } from './local-topology.mjs'
import { startHub } from '../../../communication-hub/src/server.js'

if(process.argv[2]==='--owned-hub'){
  let duplicateId=null,duplicateInjected=0
  const hub=await startHub({databasePath:process.argv[3],port:3198,peers:JSON.parse(process.env.DSBOT_TEST_PEERS),beforeResponse:({type,value})=>{
    if(type!=='deliveries.pull'||!duplicateId||!Array.isArray(value))return
    const delivery=value.find(d=>d.messageId===duplicateId&&d.ai)
    if(delivery){value.push(structuredClone(delivery));duplicateId=null;duplicateInjected++}
  }})
  delete process.env.DSBOT_TEST_PEERS
  process.on('message',message=>{
    let value
    if(message.command==='duplicate'){duplicateId=message.value.messageId;value={armed:true}}
    else if(message.command==='stats')value={messages:hub.store.db.prepare('SELECT id,conversation_id,seq,author_id,body FROM messages').all(),deliveries:hub.store.db.prepare('SELECT * FROM deliveries').all(),responses:hub.store.db.prepare('SELECT * FROM responses').all(),events:hub.store.db.prepare("SELECT body FROM events WHERE type='message'").all().map(row=>JSON.parse(row.body)),duplicateInjected}
    else return process.send({id:message.id,ok:false})
    process.send({id:message.id,ok:true,value})
  })
  process.once('disconnect',()=>void hub.close().finally(()=>process.exit(0)))
  process.send({type:'ready'})
  await new Promise(()=>{})
}

const nonce=randomUUID().slice(0,8),topology=new LocalTopology({prefix:`bot-collab-${nonce}`,webPort:3181,mockPort:8881,hubPort:3198})
const evidence={status:'RUNNING',network:'same-machine loopback',model:'local deterministic Mock',prefix:topology.prefix,cases:[],uncovered:['cross-physical-machine networking','real model behavior','GUI behavior','private DSH internals']}
const output=join(topology.root,`${topology.prefix}-acceptance.json`)
const save=()=>writeFileSync(output,JSON.stringify(evidence,null,2))
const record=(id,detail={})=>{evidence.cases.push({id,status:'PASS',...detail});save();console.log(`PASS ${id}`)}
const ownerEnv=process.env.DSBOT_COMMUNICATION_OWNER_PID
process.env.DSBOT_COMMUNICATION_OWNER_PID=String(process.pid)
const bench=topology.bench.bind(topology)
topology.bench=(peer,action,extra={})=>bench(peer,action,{DSBOT_COMMUNICATION_OWNER_PID:String(process.pid),...extra})
const startPeer=topology.startPeer.bind(topology)
topology.startPeer=(peer,extra={},options={})=>startPeer(peer,{...(peer.published?{DSBOT_COMMUNICATION_CONFIG:JSON.stringify({enabled:true,url:topology.url,instanceId:peer.instanceId,publishedBotIds:peer.published,humanDisplayName:`Person ${peer.id.toUpperCase()}`,pollMs:150})}:{}),...extra},options)
topology.startHub=async()=>{
  const child=fork(import.meta.filename,['--owned-hub',join(topology.root,`${topology.prefix}-hub.sqlite`)],{windowsHide:true,stdio:['ignore','ignore','ignore','ipc'],env:{...process.env,DSBOT_TEST_PEERS:JSON.stringify(topology.peers.map(peer=>({instanceId:peer.instanceId,instanceLabel:`Instance ${peer.id.toUpperCase()}`,credential:peer.credential})))}})
  topology.child=child
  await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error('Owned Hub startup timeout')),15000);child.once('message',message=>{clearTimeout(timer);assert.equal(message.type,'ready');resolve()});child.once('exit',()=>{clearTimeout(timer);reject(new Error('Owned Hub exited during startup'))})})
}
const deadline=setTimeout(()=>{console.error('Acceptance hard deadline exceeded');void topology.close().finally(()=>process.exit(1))},12*60*1000)
const freePort=port=>new Promise((resolve,reject)=>{const server=createServer();server.once('error',()=>reject(new Error(`Required isolated port ${port} occupied`)));server.listen(port,'127.0.0.1',()=>server.close(resolve))})
const stats=()=>topology.hub('stats')
const body=message=>JSON.parse(message.body)
const eventFor=(value,id)=>value.events.find(event=>event.message?.messageId===id)
const groupMessages=(value,id)=>value.messages.filter(message=>message.conversation_id===id).sort((a,b)=>a.seq-b.seq)
const inspect=(peer,id)=>peer.client.api({operation:'production-state',conversationId:id})
const inputs=value=>value.sessions.flatMap(session=>session.events).filter(event=>event.type==='user/message'&&event.data.source?.kind==='ds-bot-communication')
const native=(peer,text)=>peer.client.request('/api/bot',{endpoint:'send',payload:{sessionId:peer.botId,text}})
const rootMessages=(value,root)=>value.messages.filter(message=>eventFor(value,message.id)?.causality?.rootMessageId===root)
async function policy(peer,group,target,mode){const members=await peer.api({endpoint:'members',conversationId:group});return topology.operation(peer,'policy',{conversationId:group,targetPrincipalId:target,expectedVersion:members.membershipVersion,speakingMode:mode})}
async function chain(peer,group,tag,remaining=2){const sent=await topology.send(peer,group,`COMM-COLLAB FINAL ${remaining} ${tag} CollabB CollabA`,[topology.peers[0].bot]);return sent}
async function completed(group,tag){await until(()=>topology.hasText(topology.peers[0],group,`COMM-COLLAB DONE ${tag}`),'final collaboration chain completes',60000)}
function verifyChain(value,group,root,tag){
  const [a,b]=topology.peers,rows=groupMessages(value,group),out=rows.filter(message=>message.author_id.startsWith('bot:'))
  assert.equal(out.length,3,'A -> B -> A has exactly three final outputs')
  assert.deepEqual(out.map(message=>message.author_id),[a.bot,b.bot,a.bot])
  assert.equal(body(out.at(-1)).content.text,`COMM-COLLAB DONE ${tag}`)
  let parent=root
  for(const [index,message] of out.entries()){
    const payload=body(message),event=eventFor(value,message.id)
    assert.ok(payload.responseToDeliveryId,'passive final uses a one-use reply grant')
    assert.equal(payload.replyToMessageId,parent)
    assert.equal(event.causality.rootMessageId,root)
    assert.equal(event.causality.parentMessageId,parent)
    assert.equal(event.causality.depth,index+1)
    assert.equal(value.responses.filter(response=>response.delivery_id===payload.responseToDeliveryId&&response.message_id===message.id).length,1)
    parent=message.id
  }
  return out
}
try{
  for(const port of [3181,3182,8881,8882,3198])await freePort(port)
  for(const peer of topology.peers)assert.equal(existsSync(join(topology.root,'..',`.dsh-test-${peer.name}`)),false,'fresh profiles only')
  await topology.initialize();const [a,b]=topology.peers
  for(const [peer,name] of [[a,'CollabA'],[b,'CollabB']]){
    await peer.client.request('/api/bot',{endpoint:'update-bot',payload:{id:peer.botId,name}})
    peer.published=[peer.botId]
    await topology.bench(peer,'stop');await topology.startPeer(peer)
  }
  await until(async()=> (await a.api({endpoint:'state'})).contacts.find(contact=>contact.principalId===b.bot)?.displayName==='CollabB','exact distinct Bot names published')
  const group=await topology.group(`Passive collaboration ${nonce}`,[a.bot,b.human,b.bot],{allowSpeaking:false})
  const root=await chain(a,group,`passive-${nonce}`)
  await completed(group,`passive-${nonce}`)
  const passive=verifyChain(await stats(),group,root.messageId,`passive-${nonce}`)
  record('human-to-passive-A-to-passive-B-to-A-final-mentions-and-causality',{conversationId:group,rootMessageId:root.messageId,messageIds:passive.map(message=>message.id)})
  const before=(await b.client.api({operation:'metrics'})).chiefWatermark
  await native(b,`COMM-POST ${group} - unsolicited-${nonce}`)
  await until(async()=> (await b.client.api({operation:'native-tools',afterSeq:before})).passiveSendDenied,'unsolicited passive tool denied')
  assert.ok(!(await stats()).messages.some(message=>body(message).content.text===`unsolicited-${nonce}`))
  record('passive-unsolicited-tool-send-denied')

  for (const kind of ['single','all','quote']) {
    const echoGroup=await topology.group('Restatement '+kind+' '+nonce,[a.bot,b.bot],{allowSpeaking:false})
    await topology.send(a,echoGroup,'COMM-RESTATE '+kind+' '+nonce,[a.bot])
    const value=await until(async()=>{const s=await stats();return groupMessages(s,echoGroup).some(row=>row.author_id===a.bot)&&s},'restatement final is exported')
    const final=groupMessages(value,echoGroup).find(row=>row.author_id===a.bot)
    assert.deepEqual(body(final).activationTargets,[])
    assert.equal(value.deliveries.filter(row=>row.message_id===final.id&&row.ai).length,0)
    record('final-'+kind+'-mention-is-display-only',{messageId:final.id})
  }
  const active=await topology.group(`Active collaboration ${nonce}`,[a.bot,b.bot],{allowSpeaking:false})
  await policy(a,active,a.bot,'active')
  const activeRoot=await topology.send(a,active,`COMM-POST ${active} ${b.bot} COMM-COLLAB DONE active-${nonce} @CollabB`,[a.bot])
  await until(()=>topology.hasText(a,active,`Collaboration done active-${nonce}`),'active text-mention tool reaches B')
  const activeStats=await stats(),toolMessage=groupMessages(activeStats,active).find(message=>message.author_id===a.bot&&body(message).content.text===`COMM-COLLAB DONE active-${nonce} @CollabB`)
  assert.ok(toolMessage)
  assert.ok(body(toolMessage).causationDeliveryId,'active tool inherits validated input delivery')
  assert.deepEqual(body(toolMessage).mentions,[{principalId:b.bot}])
  assert.equal(eventFor(activeStats,toolMessage.id).causality.parentMessageId,activeRoot.messageId)
  assert.equal(eventFor(activeStats,toolMessage.id).causality.rootMessageId,activeRoot.messageId)
  assert.equal(activeStats.deliveries.filter(d=>d.message_id===toolMessage.id&&d.ai&&d.recipient_id===b.bot).length,1)
  record('active-tool-text-peer-mention-with-input-causation',{rootMessageId:activeRoot.messageId,toolMessageId:toolMessage.id})

  const outside=await a.client.request('/api/bot',{endpoint:'create-bot',payload:{name:`Outside${nonce}`,role:'outside',model:'deepseek-official/deepseek-v4-pro'}})
  a.published.push(outside.id);await topology.bench(a,'stop');await topology.startPeer(a)
  const outsideContact=await until(async()=> (await b.api({endpoint:'state'})).contacts.find(contact=>contact.displayName===`Outside${nonce}`),'nonmember Bot published')
  const allGroup=await topology.group(`Bot all ${nonce}`,[a.bot,b.human,b.bot],{allowSpeaking:false})
  const allRoot=await topology.send(a,allGroup,`COMM-COLLAB ALL all-${nonce}`,[a.bot])
  await until(()=>topology.hasText(a,allGroup,`Collaboration done all-${nonce}`),'Bot final all reaches other current Bot')
  const allStats=await stats(),allMessage=groupMessages(allStats,allGroup).find(message=>message.author_id===a.bot&&body(message).content.text===`COMM-COLLAB DONE all-${nonce} @all`)
  assert.ok(allMessage)
  assert.deepEqual(allStats.deliveries.filter(d=>d.message_id===allMessage.id&&d.ai).map(d=>d.recipient_id),[b.bot])
  assert.ok(!allStats.deliveries.some(d=>d.message_id===allMessage.id&&d.ai&&[a.human,b.human,outsideContact.principalId,a.bot].includes(d.recipient_id)))
  record('Bot-final-all-only-current-other-Bots-no-Human-self-or-published-nonmember',{rootMessageId:allRoot.messageId,messageId:allMessage.id})

  const loopGroup=await topology.group(`Bounded loop ${nonce}`,[a.bot,b.bot],{allowSpeaking:false})
  const loopRoot=await chain(a,loopGroup,`loop-${nonce}`,100)
  const loop=await until(async()=>{const s=await stats();return rootMessages(s,loopRoot.messageId).some(message=>eventFor(s,message.id).dispatchSuppressed==='CAUSAL_LIMIT')&&s},'server stops explicit mention loop at causal depth',90000)
  const loopRows=rootMessages(loop,loopRoot.messageId),last=loopRows.find(message=>eventFor(loop,message.id).dispatchSuppressed==='CAUSAL_LIMIT')
  assert.equal(eventFor(loop,last.id).causality.depth,8)
  assert.equal(loop.deliveries.filter(d=>d.message_id===last.id&&d.ai).length,0)
  assert.equal(loopRows.filter(message=>message.author_id.startsWith('bot:')).length,8)
  record('server-causal-depth-eight-accepts-visible-message-stops-AI',{rootMessageId:loopRoot.messageId,suppressedMessageId:last.id})

  const burstGroup=await topology.group(`Bounded root ${nonce}`,[a.bot,b.bot],{allowSpeaking:false})
  await policy(a,burstGroup,a.bot,'active')
  const burstRoot=await topology.send(a,burstGroup,`COMM-COLLAB BURST ${burstGroup} ${b.bot} 35 burst-${nonce}`,[a.bot])
  const burst=await until(async()=>{const s=await stats();return rootMessages(s,burstRoot.messageId).filter(message=>message.author_id===a.bot).length===35&&s},'all bounded burst tool messages accepted',120000)
  const burstRows=rootMessages(burst,burstRoot.messageId),rootIds=new Set(burstRows.map(message=>message.id)),aiCount=burst.deliveries.filter(d=>rootIds.has(d.message_id)&&d.ai).length
  assert.equal(aiCount,2)
  const suppressed=burstRows.filter(message=>eventFor(burst,message.id).dispatchSuppressed==='DUPLICATE_HANDOFF')
  assert.equal(suppressed.length,34)
  assert.ok(suppressed.every(message=>!burst.deliveries.some(d=>d.message_id===message.id&&d.ai)))
  assert.ok(burstRows.every(message=>eventFor(burst,message.id).causality.depth<8))
  record('same-input-same-target-burst-deduplicates-thirty-four-repeats',{rootMessageId:burstRoot.messageId,toolMessages:35,aiDeliveries:aiCount,suppressedMessages:suppressed.length})

  const recoveryGroup=await topology.group(`Recovery correlation ${nonce}`,[a.bot,b.bot],{allowSpeaking:false})
  await a.client.api({operation:'production-hold',point:'after-export',conversationId:recoveryGroup})
  const recoveryRoot=await chain(a,recoveryGroup,`recovery-${nonce}`)
  const held=await until(async()=>{const s=await inspect(a,recoveryGroup);return s.checkpoints.some(c=>c.point==='after-export')&&s.exports.length===1&&s},'first final durably exported before crash')
  const stable=held.exports[0].message_id
  await topology.hub('duplicate',{messageId:stable})
  await topology.bench(a,'stop');await topology.startPeer(a)
  await completed(recoveryGroup,`recovery-${nonce}`)
  const recovered=await stats(),recovery=verifyChain(recovered,recoveryGroup,recoveryRoot.messageId,`recovery-${nonce}`)
  assert.equal(recovery[0].id,stable)
  assert.equal(recovered.duplicateInjected,1,'same authenticated Hub delivery actually sent twice')
  const bInputs=inputs(await inspect(b,recoveryGroup))
  assert.equal(bInputs.filter(event=>event.data.source?.messageId===stable).length,1,'duplicate socket delivery admits one logical DSH input')
  const after=await inspect(a,recoveryGroup)
  assert.equal(after.exports.filter(entry=>entry.message_id===stable).length,1)
  assert.equal(inputs(after).filter(event=>event.data.source?.messageId===recoveryRoot.messageId).length,1)
  record('after-export-crash-recovery-and-duplicate-delivery-preserve-root-parent-grant-source',{rootMessageId:recoveryRoot.messageId,stableMessageId:stable,duplicateDeliveriesInjected:1})
  evidence.status='PASS'
}catch(error){evidence.status='FAIL';evidence.error=error.message;console.error(error.message);process.exitCode=1}
finally{
  clearTimeout(deadline);await topology.close()
  try{for(const port of [3181,3182,8881,8882,3198])await freePort(port);evidence.cleanedUp=true}catch(error){evidence.status='FAIL';evidence.cleanupError=error.message;process.exitCode=1}
  if(ownerEnv===undefined)delete process.env.DSBOT_COMMUNICATION_OWNER_PID;else process.env.DSBOT_COMMUNICATION_OWNER_PID=ownerEnv
  save();console.log(`Evidence: .dsh-test-tools/${topology.prefix}-acceptance.json`)
}
