// Real DSH A/B + real Hub, deterministic local Mock only. No external services.
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { spawn, fork } from 'node:child_process'
import { createServer } from 'node:net'
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { LocalTopology, until } from './local-topology.mjs'
import { HubStore } from '../../../communication-hub/src/store.js'
import { startHub } from '../../../communication-hub/src/server.js'

if(process.argv[2]==='--repaired-hub'){
  const hub=await startHub({databasePath:process.argv[3],port:3197,peers:JSON.parse(process.env.DSBOT_TEST_PEERS)})
  delete process.env.DSBOT_TEST_PEERS
  process.on('message',message=>{
    if(message.command==='stats')process.send({id:message.id,ok:true,value:{messages:hub.store.db.prepare('SELECT id,conversation_id,seq,author_id,body FROM messages').all(),deliveries:hub.store.db.prepare('SELECT * FROM deliveries').all(),responses:hub.store.db.prepare('SELECT * FROM responses').all()}})
  })
  process.once('disconnect',()=>void hub.close().finally(()=>process.exit(0)))
  process.send({type:'ready'})
  await new Promise(()=>{})
}

const nonce=randomUUID().slice(0,8),prefix=`remote-im-${nonce}`
const topology=new LocalTopology({prefix,webPort:3151,mockPort:8851,hubPort:3197})
const output=join(topology.root,`${topology.prefix}-acceptance.json`)
const evidence={status:'RUNNING',network:'same-machine loopback',model:'local deterministic Mock',prefix:topology.prefix,cases:[],operations:{},uncovered:['physical-machine/network acceptance','new Human uniqueness and legacy migration (Hub unit suite)','recovery fault matrix (separate suite)']}
const save=()=>writeFileSync(output,JSON.stringify(evidence,null,2))
const record=(id,detail={})=>{evidence.cases.push({id,status:'PASS',...detail});save();console.log(`PASS ${id}`)}
const ownerEnv=process.env.DSBOT_COMMUNICATION_OWNER_PID
process.env.DSBOT_COMMUNICATION_OWNER_PID=String(process.pid)
let deadline=setTimeout(()=>{console.error('Acceptance hard deadline exceeded');void topology.close().finally(()=>process.exit(1))},12*60*1000)
const bench=topology.bench.bind(topology)
topology.bench=(peer,action,extra={})=>bench(peer,action,{DSBOT_COMMUNICATION_OWNER_PID:String(process.pid),...extra})
async function freePort(port){await new Promise((resolve,reject)=>{const server=createServer();server.once('error',()=>reject(new Error(`Required isolated port ${port} is occupied`)));server.listen(port,'127.0.0.1',()=>server.close(resolve))})}
async function login(peer){
  const log=readFileSync(join(peer.home,'web.log'),'utf8')
  const url=log.match(new RegExp(`http://127\\.0\\.0\\.1:${peer.web}/\\?token=[^\\s]+`))?.[0]
  assert.ok(url,'isolated profile login URL exists')
  const response=await fetch(url,{redirect:'manual',signal:AbortSignal.timeout(15000)})
  peer.cookie=response.headers.getSetCookie().map(value=>value.split(';')[0]).join('; ')
  assert.ok(peer.cookie,'isolated profile returns session cookie')
}
async function cli(peer,operation,input={},expected){
  const result=await new Promise((resolve,reject)=>{
    const child=spawn(process.execPath,[join(import.meta.dirname,'../../bin/dsbot-remote.mjs'),operation,'--json'],{windowsHide:true,stdio:['pipe','pipe','pipe'],env:{...process.env,DSBOT_REMOTE_URL:`http://127.0.0.1:${peer.web}/`,DSBOT_REMOTE_COOKIE:peer.cookie}})
    let stdout='',stderr='';const timer=setTimeout(()=>{child.kill();reject(new Error(`CLI ${operation} timed out`))},25000)
    child.stdout.on('data',data=>stdout+=data);child.stderr.on('data',data=>stderr+=data);child.once('error',reject)
    child.once('exit',code=>{clearTimeout(timer);try{resolve({code,stdout:stdout.trim(),stderr:stderr.trim(),body:JSON.parse((code===0?stdout:stderr).trim())})}catch{reject(new Error(`CLI ${operation} invalid JSON (exit ${code})`))}})
    child.stdin.end(JSON.stringify(input))
  })
  evidence.operations[operation]=(evidence.operations[operation]??0)+1
  if(expected){assert.equal(result.code,4,`${operation}: expected API rejection; got ${result.body.error?.code}`);assert.equal(result.stdout,'');assert.equal(result.body.ok,false);assert.ok(expected.includes(result.body.error.code),`${operation}: unexpected ${result.body.error.code}`)}
  else {assert.equal(result.code,0,`${operation}: ${result.body.error?.code}`);assert.equal(result.stderr,'');assert.equal(result.body.ok,true);assert.ok(result.body.request)}
  return result.body
}
const value=async(...args)=>(await cli(...args)).value
const state=peer=>value(peer,'state')
const current=async(peer,conversationId)=>until(async()=>{const c=(await state(peer)).conversations.find(c=>c.conversationId===conversationId);return c?.info?.membershipVersion===c?.membershipVersion&&c},'current membership projection')
const version=async(peer,conversationId)=>(await value(peer,'members',{conversationId})).membershipVersion
async function invite(owner,peer,conversationId,principalId){
  const invitation=await value(owner,'invite',{conversationId,inviteePrincipalId:principalId})
  await value(peer,'accept',{inviteId:invitation.inviteId,recipientPrincipalId:principalId})
  await until(async()=> (await current(owner,conversationId)).info.members.some(member=>member.principalId===principalId),'accepted membership')
}
async function policy(owner,conversationId,targetPrincipalId,fields){return value(owner,'policy',{conversationId,targetPrincipalId,expectedVersion:await version(owner,conversationId),...fields})}
const native=(peer,text)=>peer.client.request('/api/bot',{endpoint:'send',payload:{sessionId:peer.botId,text}})
const messages=async()=> (await topology.hub('stats')).messages
const body=message=>JSON.parse(message.body)
const nativeCalls=peer=>{
  const team=JSON.parse(readFileSync(join(peer.home,'bot/state.json'),'utf8')),bot=team.bots[peer.botId]
  const session=bot.sessionId??bot.id
  try{return readFileSync(join(peer.home,'mock.jsonl'),'utf8').split('\n').filter(Boolean).map(JSON.parse).filter(call=>call.session===session).length}catch(error){if(error.code==='ENOENT')return 0;throw error}
}
const published=async(id)=>until(async()=>{
  const message=(await messages()).find(message=>message.id===id)
  if(message)return message
  for(const peer of topology.peers){
    const entry=(await peer.api({endpoint:'state'})).outbox.find(item=>item.id===id)
    if(entry?.error)throw new Error(`Message rejected: ${entry.error}`)
  }
  return false
},'message published')
try {
  for(const port of [3151,3152,8851,8852,3197])await freePort(port)
  for(const peer of topology.peers)assert.equal(existsSync(join(topology.root,'..',`.dsh-test-${peer.name}`)),false,'fresh profiles only')
  record('isolated-ports-and-fresh-profiles')
  await topology.initialize();const [a,b]=topology.peers
  await login(a);await login(b)
  const initial=await state(a)
  assert.notEqual(a.instanceId,b.instanceId);assert.notEqual(a.human,b.human)
  assert.equal(initial.contacts.length,4)
  for(const projection of ['contacts','conversations','invites','outbox'])assert.ok(Array.isArray(await value(a,projection)))
  const renamed=`Remote Person ${nonce}`
  assert.equal((await value(a,'rename-human',{displayName:renamed})).displayName,renamed)
  await topology.bench(a,'stop');await topology.startPeer(a);await login(a)
  await until(async()=> (await state(b)).contacts.find(c=>c.principalId===a.human)?.displayName===renamed,'persistent Human rename after reconnect')
  assert.equal((await state(a)).humanPrincipalId,a.human)
  record('CLI-state-projections-same-IP-isolation-and-rename-restart')
  const dmResult=await cli(a,'dm',{otherPrincipalId:b.human}),dm=dmResult.value.conversationId
  assert.equal((await cli(a,'retry',dmResult.request)).value.conversationId,dm)
  const sent=await cli(a,'send',{conversationId:dm,text:`CLI DM ${nonce}`})
  await published(sent.request.messageId);await cli(a,'retry',sent.request)
  await until(()=>topology.hasText(b,dm,sent.request.text),'DM reaches exact B Human')
  const history=await value(b,'history',{conversationId:dm,limit:100})
  assert.equal(history.events.filter(e=>e.message?.messageId===sent.request.messageId).length,1)
  assert.ok(await value(b,'reference',{conversationId:dm,messageId:sent.request.messageId}))
  const event=history.events.find(e=>e.message?.messageId===sent.request.messageId)
  await value(b,'read',{conversationId:dm,seq:event.conversationSeq??event.seq??1})
  record('CLI-DM-history-reference-read-and-same-ID-retry',{messageId:sent.request.messageId})
  const created=await cli(a,'create-group',{title:`Remote IM ${nonce}`}),group=created.value.conversationId
  assert.equal((await cli(a,'retry',created.request)).value.conversationId,group)
  assert.equal((await value(a,'members',{conversationId:group})).ownerPrincipalId,a.human)
  await assert.rejects(a.api({endpoint:'create-group',title:'forged owner',operationId:randomUUID(),principalId:b.human}),/AUTHOR_MISMATCH/)
  await assert.rejects(a.api({endpoint:'send',conversationId:dm,text:'forged sender',messageId:randomUUID(),clientCreatedAt:new Date().toISOString(),senderId:b.human}),/AUTHOR_MISMATCH/)
  for(const [peer,id] of [[a,a.bot],[b,b.human],[b,b.bot]])await invite(a,peer,group,id)
  const members=await value(a,'members',{conversationId:group});assert.ok(members)
  await cli(b,'configure-group',{conversationId:group,title:'unauthorized',expectedVersion:await version(b,group)},['FORBIDDEN'])
  await cli(b,'invite',{conversationId:group,inviteePrincipalId:a.human},['FORBIDDEN'])
  await cli(b,'policy',{conversationId:group,targetPrincipalId:b.human,role:'admin',expectedVersion:await version(b,group)},['FORBIDDEN'])
  await cli(b,'send',{conversationId:group,text:`COMM-ECHO denied-${nonce} @all`},['SPEAKING_FORBIDDEN'])
  await cli(b,'accept',{inviteId:'unknown',recipientPrincipalId:a.human},['AUTHOR_MISMATCH'])
  const oldVersion=await version(a,group)
  await value(a,'configure-group',{conversationId:group,title:`Renamed ${nonce}`,expectedVersion:oldVersion})
  await cli(a,'configure-group',{conversationId:group,title:'stale',expectedVersion:oldVersion},['GROUP_VERSION_CONFLICT'])
  await policy(a,group,b.human,{role:'admin'})
  await cli(b,'send',{conversationId:group,text:'admin remains readOnly'},['SPEAKING_FORBIDDEN'])
  await value(b,'configure-group',{conversationId:group,title:`Admin renamed ${nonce}`,expectedVersion:await version(b,group)})
  await policy(a,group,b.human,{role:'member',speakingMode:'speak'})
  await value(a,'routing',{conversationId:group,mode:'admin',adminBotPrincipalId:a.bot})
  await value(a,'routing',{conversationId:group,mode:'mentionsOnly'})
  record('CLI-members-invites-roles-speech-title-routing-and-permission-failures',{conversationId:group})
  // Publish a third local Bot, but deliberately never join it to this group.
  const extra=await a.client.request('/api/bot',{endpoint:'create-bot',payload:{name:`Outside ${nonce}`,role:'outside',model:'deepseek-official/deepseek-v4-pro'}})
  assert.ok(extra.id)
  await topology.bench(a,'stop')
  await topology.startPeer(a,{DSBOT_COMMUNICATION_CONFIG:JSON.stringify({enabled:true,url:topology.url,instanceId:a.instanceId,publishedBotIds:[a.botId,extra.id],humanDisplayName:'ignored reconnect default',pollMs:150})});await login(a)
  const outside=await until(async()=> (await state(b)).contacts.find(c=>c.localRef===extra.id||c.displayName===`Outside ${nonce}`),'outside Bot explicitly published')
  const chiefBefore=topology.peers.map(nativeCalls)
  const tag=`all-${nonce}`,all=await cli(a,'send',{conversationId:group,text:`COMM-ECHO ${tag} @all`})
  await until(async()=> (await messages()).filter(m=>m.conversation_id===group&&body(m).content.text===`Communication reply ${tag} @all`).length===2,'both passive Bots each reply to @all')
  const stats=await topology.hub('stats'),input=stats.messages.find(m=>m.id===all.request.messageId)
  const ai=stats.deliveries.filter(d=>d.message_id===input.id&&d.ai)
  assert.deepEqual(ai.map(d=>d.recipient_id??d.principal_id).sort(),[a.bot,b.bot].sort())
  const replies=stats.messages.filter(m=>m.conversation_id===group&&body(m).content.text===`Communication reply ${tag} @all`)
  assert.deepEqual(replies.map(m=>m.author_id).sort(),[a.bot,b.bot].sort())
  for(const reply of replies){assert.ok(body(reply).responseToDeliveryId);assert.equal(body(reply).replyToMessageId,input.id)}
  assert.ok(!ai.some(d=>JSON.stringify(d).includes(outside.principalId)))
  assert.deepEqual(topology.peers.map(nativeCalls),chiefBefore,'Human @all does not invoke either nativeChief model')
  record('all-only-current-Bots-two-passive-granted-replies-no-Human-no-outside-no-nativeChief',{messageId:input.id,botAuthors:replies.map(m=>m.author_id)})
  const before=(await b.client.api({operation:'metrics'})).chiefWatermark
  await native(b,`COMM-POST ${group} - denied-passive-${nonce}`)
  await until(async()=> (await b.client.api({operation:'native-tools',afterSeq:before})).passiveSendDenied,'native passive proactive send denied')
  assert.ok(!(await messages()).some(m=>body(m).content.text===`denied-passive-${nonce}`))
  await value(a,'remove',{conversationId:group,targetPrincipalId:b.bot})
  const removed=await cli(a,'send',{conversationId:group,text:`COMM-ECHO removed-${nonce} @all`});await published(removed.request.messageId)
  await until(async()=> (await messages()).some(m=>body(m).content.text===`Communication reply removed-${nonce} @all`),'remaining Bot replies')
  const after=await topology.hub('stats')
  assert.deepEqual(after.deliveries.filter(d=>d.message_id===removed.request.messageId&&d.ai).map(d=>d.recipient_id??d.principal_id),[a.bot])
  await value(a,'rename-human',{displayName:`Retry rename ${nonce}`})
  await until(async()=> (await state(b)).conversations.find(c=>c.conversationId===group)?.info?.members.find(m=>m.principalId===a.human)?.displayName===`Retry rename ${nonce}`,'member display name refreshes without membership change')
  await cli(a,'retry',all.request)
  await cli(a,'retry',{...all.request,text:`changed raw text ${nonce}`},['MESSAGE_ID_CONFLICT','IDEMPOTENCY_CONFLICT'])
  const retried=await topology.hub('stats')
  assert.equal(retried.messages.filter(m=>m.id===all.request.messageId).length,1)
  assert.equal(retried.messages.filter(m=>m.conversation_id===group&&body(m).content.text===`Communication reply ${tag} @all`).length,2)
  record('all-original-request-retry-after-rename-and-member-removal-raw-conflict')
  record('passive-proactive-send-denied-and-removed-member-not-routed')
  await value(a,'transfer',{conversationId:group,targetPrincipalId:b.human,expectedVersion:await version(a,group)})
  await until(async()=> (await current(b,group)).role==='owner','B becomes owner')
  await cli(a,'dissolve',{conversationId:group},['FORBIDDEN'])
  await cli(b,'leave',{conversationId:group},['OWNER_TRANSFER_REQUIRED'])
  await value(a,'leave',{conversationId:group})
  await cli(a,'reclaim',{conversationId:group,expectedVersion:await version(b,group)},['FORBIDDEN'])
  // Exercise public Hub trust revocation with all owned processes stopped, then
  // explicitly re-pair B at revision 2. Never edit rows to manufacture membership.
  for(const peer of topology.peers)await topology.bench(peer,'stop')
  await topology.stopHub()
  const hubPath=join(topology.root,`${topology.prefix}-hub.sqlite`),store=new HubStore(hubPath)
  try{store.revokeInstance(b.instanceId)}finally{store.close()}
  topology.child=fork(import.meta.filename,['--repaired-hub',hubPath],{windowsHide:true,stdio:['ignore','ignore','ignore','ipc'],env:{...process.env,DSBOT_TEST_PEERS:JSON.stringify(topology.peers.map(peer=>({instanceId:peer.instanceId,instanceLabel:`Instance ${peer.id.toUpperCase()}`,credential:peer.credential,pairingRevision:peer===b?2:1})))}})
  await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error('Repaired Hub startup timeout')),15000);topology.child.once('message',message=>{clearTimeout(timer);assert.equal(message.type,'ready');resolve()});topology.child.once('exit',()=>{clearTimeout(timer);reject(new Error('Repaired Hub startup failed'))})})
  for(const peer of topology.peers){await topology.startPeer(peer);await login(peer)}
  await until(async()=> (await state(b)).recoverableOwnership.some(c=>c.conversationId===group),'current owner recovery slot')
  const recovery=(await state(b)).recoverableOwnership.find(c=>c.conversationId===group)
  await value(b,'reclaim',{conversationId:group,expectedVersion:recovery.membershipVersion})
  await until(async()=> (await current(b,group)).role==='owner','current owner reclaims')
  await value(b,'dissolve',{conversationId:group})
  await cli(b,'send',{conversationId:group,text:'after dissolve'},['NOT_A_MEMBER','CONVERSATION_ENDED','GROUP_DISSOLVED','CONVERSATION_DISSOLVED'])
  await cli(b,'reference',{conversationId:group,messageId:input.id},['NOT_A_MEMBER','CONVERSATION_ENDED','GROUP_DISSOLVED','CONVERSATION_DISSOLVED'])
  record('CLI-transfer-leave-reserved-owner-reclaim-dissolve')
  evidence.status='PASS'
}catch(error){evidence.status='FAIL';evidence.error=error.message;console.error(error.message);process.exitCode=1}
finally {
  clearTimeout(deadline)
  await topology.close()
  try{for(const port of [3151,3152,8851,8852,3197])await freePort(port);evidence.cleanedUp=true}
  catch(error){evidence.status='FAIL';evidence.cleanupError=error.message;process.exitCode=1}
  if(ownerEnv===undefined)delete process.env.DSBOT_COMMUNICATION_OWNER_PID;else process.env.DSBOT_COMMUNICATION_OWNER_PID=ownerEnv
  save();console.log(`Evidence: .dsh-test-tools/${topology.prefix}-acceptance.json`)
}
