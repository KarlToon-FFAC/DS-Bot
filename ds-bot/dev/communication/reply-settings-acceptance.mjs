// Real DSH A/B and real Hub on same-machine loopback; local Mock models only.
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import { createServer } from 'node:net'
import { DatabaseSync } from 'node:sqlite'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { LocalTopology, until } from './local-topology.mjs'

const nonce=randomUUID().slice(0,8),topology=new LocalTopology({prefix:`reply-settings-${nonce}`,webPort:3183,mockPort:8883,hubPort:3199})
const output=join(topology.root,`${topology.prefix}-acceptance.json`)
const evidence={status:'RUNNING',network:'same-machine loopback',model:'local deterministic Mock',prefix:topology.prefix,cases:[],uncovered:['cross-physical-machine networking','real model behavior','GUI (separate acceptance)']}
const save=()=>writeFileSync(output,JSON.stringify(evidence,null,2))
const record=(id,detail={})=>{evidence.cases.push({id,status:'PASS',...detail});save();console.log(`PASS ${id}`)}
const ownerEnv=process.env.DSBOT_COMMUNICATION_OWNER_PID
process.env.DSBOT_COMMUNICATION_OWNER_PID=String(process.pid)
const bench=topology.bench.bind(topology)
topology.bench=(peer,action,extra={})=>bench(peer,action,{DSBOT_COMMUNICATION_OWNER_PID:String(process.pid),...extra})
const deadline=setTimeout(()=>{console.error('Acceptance hard deadline exceeded');void topology.close().finally(()=>process.exit(1))},12*60*1000)
const freePort=port=>new Promise((resolve,reject)=>{const server=createServer();server.once('error',()=>reject(new Error(`Required isolated port ${port} occupied`)));server.listen(port,'127.0.0.1',()=>server.close(resolve))})
const body=message=>JSON.parse(message.body)
const stats=()=>topology.hub('stats')
const rows=(value,id)=>value.messages.filter(message=>message.conversation_id===id).sort((a,b)=>a.seq-b.seq)
const inspect=(peer,id)=>peer.client.api({operation:'production-state',conversationId:id})
const logical=value=>value.sessions.flatMap(session=>session.events).filter(event=>event.type==='user/message'&&event.data.source?.kind==='ds-bot-communication')
const members=(peer,id)=>peer.api({endpoint:'members',conversationId:id})
async function actualInput(peer,id,messageId){
  const state=await until(async()=>{const value=await inspect(peer,id);return logical(value).some(event=>event.data.source.messageId===messageId)&&value},'actual DSH communication input',60000)
  const entries=logical(state).filter(event=>event.data.source.messageId===messageId)
  assert.equal(entries.length,1,'one actual logical DSH input')
  const source=entries[0].data.source,value=await stats(),delivery=value.deliveries.find(item=>item.id===source.deliveryId)
  assert.ok(delivery?.ai,'DSH input correlates to canonical AI delivery')
  assert.equal(delivery.message_id,messageId)
  assert.equal(delivery.recipient_id,peer.bot)
  return {source,delivery}
}
async function reply(peer,id,text){
  return until(async()=> (await stats()).messages.find(message=>message.conversation_id===id&&message.author_id===peer.bot&&body(message).content.text===text),'canonical Bot final response',60000)
}
async function verifyGrant(peer,id,input,output){
  const {source}=await actualInput(peer,id,input),payload=body(output),value=await stats()
  assert.equal(payload.responseToDeliveryId,source.deliveryId)
  assert.equal(payload.replyToMessageId,input)
  assert.equal(value.responses.filter(row=>row.delivery_id===source.deliveryId&&row.message_id===output.id).length,1)
}
async function noAi(id,messageId){
  const value=await stats(),message=value.messages.find(message=>message.id===messageId)
  assert.ok(message,'message durably visible')
  assert.equal(value.deliveries.filter(delivery=>delivery.message_id===messageId&&delivery.ai).length,0)
  await until(()=>topology.hasText(topology.peers[0],id,body(message).content.text),'message visible in authorized Human history')
  for(const peer of topology.peers)assert.equal(logical(await inspect(peer,id)).filter(event=>event.data.source.messageId===messageId).length,0)
}
async function rejectedReply(peer,id,replyToMessageId,tag){
  const messageId=randomUUID()
  try{await topology.send(peer,id,`COMM-ECHO ${tag}`,[],{messageId,replyToMessageId})}
  catch(error){assert.match(error.message,/INVALID_REPLY_TARGET/);return messageId}
  await until(async()=> (await peer.api({endpoint:'state'})).outbox.find(item=>item.id===messageId)?.error==='INVALID_REPLY_TARGET','invalid reply fails closed')
  const value=await stats()
  assert.ok(!value.messages.some(message=>message.id===messageId))
  assert.ok(!value.deliveries.some(delivery=>delivery.message_id===messageId))
  return messageId
}
async function policy(peer,id,target,mode){return topology.operation(peer,'policy',{conversationId:id,targetPrincipalId:target,expectedVersion:(await members(peer,id)).membershipVersion,speakingMode:mode})}
function events(){const db=new DatabaseSync(join(topology.root,`${topology.prefix}-hub.sqlite`),{readOnly:true});try{return db.prepare("SELECT body FROM events WHERE type='message'").all().map(row=>JSON.parse(row.body))}finally{db.close()}}
async function login(peer){
  const log=readFileSync(join(peer.home,'web.log'),'utf8'),url=log.match(new RegExp(`http://127\\.0\\.0\\.1:${peer.web}/\\?token=[^\\s]+`))?.[0]
  assert.ok(url,'isolated profile login URL exists')
  const response=await fetch(url,{redirect:'manual',signal:AbortSignal.timeout(15000)})
  peer.cookie=response.headers.getSetCookie().map(item=>item.split(';')[0]).join('; ')
  assert.ok(peer.cookie,'isolated profile has a session cookie')
}
async function cli(peer,operation,input,errors){
  const result=await new Promise((resolve,reject)=>{
    const child=spawn(process.execPath,[join(import.meta.dirname,'../../bin/dsbot-remote.mjs'),operation,'--json'],{windowsHide:true,stdio:['pipe','pipe','pipe'],env:{...process.env,DSBOT_REMOTE_URL:`http://127.0.0.1:${peer.web}/`,DSBOT_REMOTE_COOKIE:peer.cookie}})
    let stdout='',stderr='';const timer=setTimeout(()=>{child.kill();reject(new Error(`CLI ${operation} timeout`))},25000)
    child.stdout.on('data',data=>stdout+=data);child.stderr.on('data',data=>stderr+=data);child.once('error',reject)
    child.once('exit',code=>{clearTimeout(timer);try{resolve({code,stdout:stdout.trim(),stderr:stderr.trim(),body:JSON.parse((code===0?stdout:stderr).trim())})}catch{reject(new Error(`CLI ${operation} invalid JSON (${code})`))}})
    child.stdin.end(JSON.stringify(input))
  })
  if(errors){assert.equal(result.code,4,`${operation}: ${result.body.error?.code}`);assert.equal(result.stdout,'');assert.ok(errors.includes(result.body.error?.code),`${operation}: ${result.body.error?.code}`)}
  else{assert.equal(result.code,0,`${operation}: ${result.body.error?.code}`);assert.equal(result.stderr,'');assert.equal(result.body.ok,true);assert.ok(result.body.request)}
  return result.body
}
const settings=value=>({title:value.title,routingMode:value.routingMode,adminBotPrincipalId:value.adminBotPrincipalId,membershipVersion:value.membershipVersion,members:value.members.map(member=>({principalId:member.principalId,role:member.role,speakingMode:member.speakingMode})).sort((a,b)=>a.principalId.localeCompare(b.principalId))})

try{
  for(const port of [3183,3184,8883,8884,3199])await freePort(port)
  for(const peer of topology.peers)assert.equal(existsSync(join(topology.root,'..',`.dsh-test-${peer.name}`)),false,'fresh profiles only')
  await topology.initialize();const [a,b]=topology.peers
  for(const [peer,name] of [[a,'ReplyA'],[b,'ReplyB']]){
    await peer.client.request('/api/bot',{endpoint:'update-bot',payload:{id:peer.botId,name}})
    await topology.bench(peer,'stop');await topology.startPeer(peer);await login(peer)
  }
  const group=await topology.group(`Reply routing ${nonce}`,[a.bot,b.human,b.bot],{allowSpeaking:false})
  const seedInput=await topology.send(a,group,`COMM-ECHO seed-${nonce}`,[b.bot])
  const seed=await reply(b,group,`Communication reply seed-${nonce}`)
  await verifyGrant(b,group,seedInput.messageId,seed)
  const humanReply=await topology.send(a,group,`COMM-ECHO human-reply-${nonce}`,[],{replyToMessageId:seed.id})
  const humanReplyOutput=await reply(b,group,`Communication reply human-reply-${nonce}`)
  await verifyGrant(b,group,humanReply.messageId,humanReplyOutput)
  const firstStats=await stats()
  assert.deepEqual(body(firstStats.messages.find(message=>message.id===humanReply.messageId)).mentions,[])
  assert.deepEqual(firstStats.deliveries.filter(delivery=>delivery.message_id===humanReply.messageId&&delivery.ai).map(delivery=>delivery.recipient_id),[b.bot])
  await noAi(group,humanReplyOutput.id)
  record('Human-reply-without-mention-activates-original-Bot-with-real-DSH-grant',{conversationId:group,replyMessageId:humanReply.messageId,botFinalId:humanReplyOutput.id})

  const override=await topology.send(a,group,`COMM-ECHO override-${nonce}`,[a.bot],{replyToMessageId:seed.id})
  const overrideOutput=await reply(a,group,`Communication reply override-${nonce}`)
  await verifyGrant(a,group,override.messageId,overrideOutput)
  assert.deepEqual((await stats()).deliveries.filter(delivery=>delivery.message_id===override.messageId&&delivery.ai).map(delivery=>delivery.recipient_id),[a.bot])
  const humanTarget=await topology.send(a,group,`Human-only reply ${nonce}`,[],{replyToMessageId:seedInput.messageId})
  await until(()=>topology.hasText(a,group,humanTarget.text),'Human target reply visible')
  await noAi(group,humanTarget.messageId)
  record('explicit-Bot-mention-overrides-reply-author-and-Human-target-never-AI')

  await policy(a,group,a.bot,'active')
  const toolRoot=await topology.send(a,group,`COMM-COLLAB REPLY ${group} ${seed.id} active-reply-${nonce}`,[a.bot])
  const tool=await until(async()=> (await stats()).messages.find(message=>message.conversation_id===group&&message.author_id===a.bot&&body(message).content.text===`COMM-ECHO active-reply-${nonce}`),'active explicit reply tool message')
  const final=await reply(b,group,`Communication reply active-reply-${nonce}`)
  await verifyGrant(b,group,tool.id,final)
  const toolSource=await actualInput(a,group,toolRoot.messageId)
  assert.equal(body(tool).causationDeliveryId,toolSource.source.deliveryId)
  assert.equal(body(tool).replyToMessageId,seed.id)
  assert.deepEqual(body(tool).mentions,[])
  assert.deepEqual((await stats()).deliveries.filter(delivery=>delivery.message_id===tool.id&&delivery.ai).map(delivery=>delivery.recipient_id),[b.bot])
  await noAi(group,final.id)
  record('active-explicit-reply-without-mention-A-to-B-final-back-to-A-display-only',{rootMessageId:toolRoot.messageId,toolMessageId:tool.id,finalMessageId:final.id})

  await topology.operation(a,'remove',{conversationId:group,targetPrincipalId:b.bot})
  const removed=await rejectedReply(a,group,seed.id,`removed-${nonce}`)
  const invitation=await topology.operation(a,'invite',{conversationId:group,inviteePrincipalId:b.bot})
  await topology.operation(b,'accept',{inviteId:invitation.inviteId,recipientPrincipalId:b.bot})
  await until(async()=> (await members(a,group)).members.some(member=>member.principalId===b.bot),'Bot rejoined')
  const oldEpoch=await rejectedReply(a,group,seed.id,`old-epoch-${nonce}`)
  const fresh=await topology.send(a,group,`COMM-ECHO fresh-${nonce}`,[b.bot])
  await verifyGrant(b,group,fresh.messageId,await reply(b,group,`Communication reply fresh-${nonce}`))
  record('removed-author-and-rejoined-author-old-epoch-references-denied-no-AI',{removedMessageId:removed,oldEpochMessageId:oldEpoch})

  const atomic=await topology.group(`Atomic settings ${nonce}`,[a.bot,b.human,b.bot],{allowSpeaking:false})
  const before=await members(a,atomic)
  await cli(b,'save-settings',{conversationId:atomic,expectedVersion:before.membershipVersion,title:'forbidden partial'},['FORBIDDEN'])
  assert.deepEqual(settings(await members(a,atomic)),settings(before))
  const request={conversationId:atomic,expectedVersion:before.membershipVersion,operationId:randomUUID(),title:`Saved atomically ${nonce}`,routing:{mode:'admin',adminBotPrincipalId:a.bot},policies:[{targetPrincipalId:a.bot,speakingMode:'active'},{targetPrincipalId:b.human,role:'admin',speakingMode:'speak'},{targetPrincipalId:b.bot,speakingMode:'active'}]}
  const saved=await cli(a,'save-settings',request)
  const after=await members(a,atomic)
  assert.equal(saved.value.membershipVersion,before.membershipVersion+1)
  assert.equal(after.membershipVersion,before.membershipVersion+1)
  assert.equal(after.title,request.title);assert.equal(after.routingMode,'admin');assert.equal(after.adminBotPrincipalId,a.bot)
  for(const policy of request.policies){const member=after.members.find(member=>member.principalId===policy.targetPrincipalId);if(policy.role)assert.equal(member.role,policy.role);assert.equal(member.speakingMode,policy.speakingMode)}
  const replay=await cli(a,'retry',saved.request)
  assert.deepEqual(replay.value,saved.value)
  assert.deepEqual(settings(await members(a,atomic)),settings(after))
  await cli(a,'retry',{...saved.request,title:'same ID changed payload'},['MESSAGE_ID_CONFLICT','OPERATION_ID_CONFLICT'])
  assert.deepEqual(settings(await members(a,atomic)),settings(after))
  record('real-CLI-atomic-multisave-one-version-and-exact-request-idempotency',{conversationId:atomic,membershipVersion:after.membershipVersion})

  await cli(a,'save-settings',{conversationId:atomic,expectedVersion:after.membershipVersion,title:'must roll back invalid policy',routing:{mode:'mentionsOnly'},policies:[{targetPrincipalId:b.human,speakingMode:'readOnly'},{targetPrincipalId:b.bot,speakingMode:'speak'}]},['INVALID_SPEAKING_MODE'])
  assert.deepEqual(settings(await members(a,atomic)),settings(after))
  await cli(a,'save-settings',{conversationId:atomic,expectedVersion:before.membershipVersion,title:'must roll back stale version',routing:{mode:'mentionsOnly'},policies:[{targetPrincipalId:b.human,speakingMode:'readOnly'}]},['GROUP_VERSION_CONFLICT'])
  assert.deepEqual(settings(await members(a,atomic)),settings(after))
  record('invalid-policy-and-stale-version-save-have-no-partial-title-routing-role-or-speech-changes')

  const allGroup=await topology.group(`Unchanged all ${nonce}`,[a.bot,b.bot],{allowSpeaking:false})
  const all=await topology.send(a,allGroup,`COMM-ECHO all-${nonce} @all`)
  for(const peer of topology.peers)await verifyGrant(peer,allGroup,all.messageId,await reply(peer,allGroup,`> Communication reply all-${nonce} @all`))
  const allStats=await stats()
  assert.deepEqual(allStats.deliveries.filter(delivery=>delivery.message_id===all.messageId&&delivery.ai).map(delivery=>delivery.recipient_id).sort(),[a.bot,b.bot].sort())
  assert.equal(rows(allStats,allGroup).filter(message=>message.author_id.startsWith('bot:')).length,2)
  for(const message of rows(allStats,allGroup).filter(message=>message.author_id.startsWith('bot:')))await noAi(allGroup,message.id)
  record('all-current-Bots-still-reply-once-and-quoted-echo-does-not-cascade')

  const loopGroup=await topology.group(`Unchanged depth ${nonce}`,[a.bot,b.bot],{allowSpeaking:false})
  const loop=await topology.send(a,loopGroup,`COMM-COLLAB FINAL 100 loop-${nonce} ReplyB ReplyA`,[a.bot])
  const bounded=await until(async()=>{const found=events().find(event=>event.causality?.rootMessageId===loop.messageId&&event.dispatchSuppressed==='CAUSAL_LIMIT');return found},'depth-eight limit retained',90000)
  assert.equal(bounded.causality.depth,8)
  await noAi(loopGroup,bounded.message.messageId)
  const burstGroup=await topology.group(`Unchanged root budget ${nonce}`,[a.bot,b.bot],{allowSpeaking:false})
  await policy(a,burstGroup,a.bot,'active')
  const burst=await topology.send(a,burstGroup,`COMM-COLLAB BURST ${burstGroup} ${b.bot} 35 budget-${nonce}`,[a.bot])
  await until(async()=>{const rootEvents=events().filter(event=>event.causality?.rootMessageId===burst.messageId);return rootEvents.filter(event=>event.message.author.principalId===a.bot).length===35},'35 active tool messages accepted under one root',120000)
  const rootEvents=events().filter(event=>event.causality?.rootMessageId===burst.messageId),ids=new Set(rootEvents.map(event=>event.message.messageId)),burstStats=await stats()
  assert.equal(burstStats.deliveries.filter(delivery=>ids.has(delivery.message_id)&&delivery.ai).length,32)
  assert.equal(rootEvents.filter(event=>event.message.author.principalId===a.bot&&event.dispatchSuppressed==='CAUSAL_LIMIT').length,4)
  record('causal-depth-eight-and-per-root-AI-thirty-two-budgets-unchanged',{depth:8,rootAiBudget:32})
  evidence.status='PASS'
}catch(error){evidence.status='FAIL';evidence.error=error.message;console.error(error.message);process.exitCode=1}
finally{
  clearTimeout(deadline);await topology.close()
  try{for(const port of [3183,3184,8883,8884,3199])await freePort(port);evidence.cleanedUp=true}catch(error){evidence.status='FAIL';evidence.cleanupError=error.message;process.exitCode=1}
  if(ownerEnv===undefined)delete process.env.DSBOT_COMMUNICATION_OWNER_PID;else process.env.DSBOT_COMMUNICATION_OWNER_PID=ownerEnv
  save();console.log(`Evidence: .dsh-test-tools/${topology.prefix}-acceptance.json`)
}
