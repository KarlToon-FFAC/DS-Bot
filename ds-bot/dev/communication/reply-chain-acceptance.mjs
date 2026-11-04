// Fresh real DSH A/B, a real loopback Hub and local deterministic Mock models.
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { createServer } from 'node:net'
import { existsSync, writeFileSync, rmSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { LocalTopology, until } from './local-topology.mjs'
import { repo } from './bench-client.mjs'

const nonce=randomUUID().slice(0,8),topology=new LocalTopology({prefix:`reply-chain-${nonce}`,webPort:3211,mockPort:8891,hubPort:3213})
const ports=[3211,3212,8891,8892,3213],output=join(topology.root,`${topology.prefix}-acceptance.json`),live=process.argv.includes('--live-for-browser')
const evidence={status:'RUNNING',prefix:topology.prefix,network:'same-machine loopback',model:'local deterministic Mock',cases:[],uncovered:['cross-physical-machine/WSS deployment','real model behavior','visual list layout/error placement (separate Cua acceptance)','Hub management enrollment (previous independent acceptance)']}
const save=()=>writeFileSync(output,JSON.stringify(evidence,null,2)),stage=value=>{evidence.stage=value;save()},record=(id,detail={})=>{evidence.cases.push({id,status:'PASS',...detail});save();console.log(`PASS ${id}`)}
const ownerEnv=process.env.DSBOT_COMMUNICATION_OWNER_PID
process.env.DSBOT_COMMUNICATION_OWNER_PID=String(process.pid)
const bench=topology.bench.bind(topology)
topology.bench=(peer,action,extra={})=>bench(peer,action,{DSBOT_COMMUNICATION_OWNER_PID:String(process.pid),DSBOT_WEB_OPEN:'0',...extra})
const freePort=port=>new Promise((resolveFree,reject)=>{const server=createServer();server.once('error',()=>reject(new Error(`Required isolated port ${port} occupied`)));server.listen(port,'127.0.0.1',()=>server.close(resolveFree))})
let ownsFixtures=false,readyPath,ready
const deadline=setTimeout(()=>{console.error('Acceptance hard deadline exceeded');void topology.close().finally(()=>process.exit(1))},12*60*1000)
const members=(peer,conversationId)=>peer.api({endpoint:'members',conversationId})
const entry=async(peer,conversationId)=>(await peer.api({endpoint:'state'})).conversations.find(item=>item.conversationId===conversationId)
const stats=()=>topology.hub('stats')
async function denied(work,code){await assert.rejects(work,error=>error.message.includes(code))}
async function summary(peer,conversationId,messageId,text,author){
  const value=await until(async()=>{const row=await entry(peer,conversationId);return row?.lastMessage?.messageId===messageId&&row},'authorized current conversation message summary')
  assert.equal(value.lastMessage.summary,text)
  assert.equal(value.lastMessage.author.principalId,author)
  assert.ok(['human','bot'].includes(value.lastMessage.author.kind))
  assert.ok(value.lastMessage.author.displayName)
  assert.ok(Number.isFinite(Date.parse(value.lastMessage.serverAcceptedAt)))
  assert.ok(value.lastMessage.conversationSeq<=(await topology.history(peer,conversationId)).watermark,'summary never exceeds local cursor')
  return value
}
async function finalReply(peer,conversationId,text){return until(async()=> (await stats()).messages.find(message=>message.conversation_id===conversationId&&message.author_id===peer.bot&&JSON.parse(message.body).content.text===text),'canonical Mock Bot response',60000)}
async function settings(peer,conversationId,changes){return topology.operation(peer,'save-settings',{conversationId,expectedVersion:(await members(peer,conversationId)).membershipVersion,...changes})}
async function holdForBrowser(ids){
  clearTimeout(deadline)
  const stopFile=join(topology.root,`${topology.prefix}-browser-stop`),expiresAt=Date.now()+12*60*1000
  readyPath=join(topology.root,`${topology.prefix}-browser-ready.json`)
  ready={status:'READY',expiresAt:new Date(expiresAt).toISOString(),...ids,profiles:topology.peers.map(peer=>({url:`http://127.0.0.1:${peer.web}/`,instanceId:peer.instanceId,humanPrincipalId:peer.human,botPrincipalId:peer.bot})),stopFile}
  writeFileSync(readyPath,JSON.stringify(ready,null,2));evidence.browserReadyFile=readyPath;save();console.log(`BROWSER_READY .dsh-test-tools/${topology.prefix}-browser-ready.json`)
  while(!existsSync(stopFile)&&Date.now()<expiresAt)await new Promise(resolvePause=>setTimeout(resolvePause,500))
}
try{
  stage('fresh isolated topology preparation')
  for(const port of ports)await freePort(port)
  for(const peer of topology.peers)assert.equal(existsSync(join(repo,`.dsh-test-${peer.name}`)),false,'fresh owned profiles only')
  ownsFixtures=true;await topology.initialize()
  const [a,b]=topology.peers
  for(const [peer,name,color,shape] of [[a,'ListA','blue','whale'],[b,'ListB','rose','star']])await peer.client.request('/api/bot',{endpoint:'update-bot',payload:{id:peer.botId,name,color,avatar:{shape}}})
  await b.api({endpoint:'rename-human',displayName:`Reader B ${nonce}`})
  await until(async()=> (await a.api({endpoint:'state'})).contacts.find(contact=>contact.principalId===b.bot)?.displayName==='ListB','distinct local Bot names synchronized')
  const group=await topology.group(`Shared list ${nonce}`,[a.bot,b.human,b.bot],{allowSpeaking:false})
  const empty=await topology.group(`Empty list ${nonce}`,[b.human],{allowSpeaking:false})
  await until(async()=>{const row=await entry(a,empty);return row&&row.lastMessage===null},'empty group summary is null')

  stage('owner and readOnly member view metadata with strict mutation denial')
  const before=await members(b,group)
  assert.equal(before.members.find(member=>member.principalId===b.human).role,'member')
  assert.equal(before.members.find(member=>member.principalId===b.human).speakingMode,'readOnly')
  const failureId=randomUUID()
  await denied(()=>topology.operation(b,'save-settings',{conversationId:group,expectedVersion:before.membershipVersion,operationId:failureId,title:'Denied readOnly edit'}),'FORBIDDEN')
  assert.equal((await members(a,group)).title,before.title)
  const rejected=await until(async()=> (await b.api({endpoint:'state'})).outbox.find(item=>item.id===failureId&&item.state==='failed'&&item.error==='FORBIDDEN'),'deliberate rejected Human operation remains in audit')
  assert.equal(rejected.conversationId,group)
  const afterFailure=await b.api({endpoint:'state'})
  assert.notEqual(afterFailure.error,'FORBIDDEN','old operation rejection must not become global transport error')
  assert.ok(!afterFailure.errors.some(error=>error.conversationId===empty&&error.code==='FORBIDDEN'))
  assert.equal((await members(b,empty)).title,`Empty list ${nonce}`)
  const ownerSave=await settings(a,group,{title:`Owner saved ${nonce}`});assert.equal(ownerSave.updated,true)
  record('readOnly-roster-readable-mutation-FORBIDDEN-audit-retained-without-other-conversation-pollution',{conversationId:group,deliberateFailureOperationId:failureId,unaffectedConversationId:empty})

  stage('admin readOnly speech permission is independent from group management')
  await settings(a,group,{policies:[{targetPrincipalId:b.human,role:'admin',speakingMode:'readOnly'}]})
  const admin=await members(b,group)
  assert.equal(admin.members.find(member=>member.principalId===b.human).role,'admin')
  assert.equal(admin.members.find(member=>member.principalId===b.human).speakingMode,'readOnly')
  await settings(b,group,{title:`Admin saved ${nonce}`})
  assert.equal((await members(a,group)).title,`Admin saved ${nonce}`)
  await denied(()=>topology.send(b,group,`ReadOnly admin cannot speak ${nonce}`),'SPEAKING_FORBIDDEN')
  await settings(a,group,{policies:[{targetPrincipalId:b.human,role:'member',speakingMode:'readOnly'}]})
  record('owner-and-admin-management-succeed-readOnly-speech-stays-forbidden')

  stage('group summary sender metadata and unread reflect authorized local history')
  const human=await topology.send(a,group,`Human group preview ${nonce}`)
  for(const peer of topology.peers)await summary(peer,group,human.messageId,human.text,a.human)
  await until(async()=>{const row=await entry(b,group);return row?.unread>0&&row},'remote incoming message has unread state')
  await b.api({endpoint:'read',conversationId:group,seq:(await topology.history(b,group)).watermark})
  await until(async()=> (await entry(b,group)).unread===0,'read clears unread without deleting history')
  const targeted=await topology.send(a,group,`COMM-COLLAB DONE preview-${nonce} @ListB`,[b.bot])
  const response=await finalReply(b,group,`Collaboration done preview-${nonce}`)
  for(const peer of topology.peers){const row=await summary(peer,group,response.id,`Collaboration done preview-${nonce}`,b.bot);assert.equal(row.lastMessage.author.displayName,'ListB')}
  const roster=(await members(a,group)).members
  assert.ok(roster.some(member=>member.principalId===b.bot&&member.displayName==='ListB'&&member.avatar?.color==='rose'&&member.avatar?.shape==='star'))
  assert.ok(roster.some(member=>member.principalId===a.bot&&member.displayName==='ListA'))
  record('group-summary-tracks-real-Human-and-Bot-senders-current-metadata-and-unread',{humanMessageId:human.messageId,botInputMessageId:targeted.messageId,botFinalMessageId:response.id})

  stage('DM counterparty and sender updates do not leak Bot-only DM to local Human')
  const humanDm=(await topology.operation(a,'dm',{otherPrincipalId:b.human})).conversationId
  const first=await topology.send(a,humanDm,`Private first preview ${nonce}`)
  for(const peer of topology.peers)await summary(peer,humanDm,first.messageId,first.text,a.human)
  const second=await topology.send(b,humanDm,`Private reply preview ${nonce}`)
  for(const peer of topology.peers){const row=await summary(peer,humanDm,second.messageId,second.text,b.human);assert.equal(row.lastMessage.author.displayName,`Reader B ${nonce}`)}
  const botDm=(await topology.operation(a,'dm',{otherPrincipalId:b.bot})).conversationId
  await topology.send(a,botDm,`COMM-COLLAB DONE private-bot-${nonce}`)
  const botResponse=await finalReply(b,botDm,`Collaboration done private-bot-${nonce}`)
  const botRow=await summary(a,botDm,botResponse.id,`Collaboration done private-bot-${nonce}`,b.bot)
  assert.ok(botRow.info.members.some(member=>member.principalId===b.bot&&member.displayName==='ListB'&&member.avatar?.color==='rose'))
  assert.equal(await entry(b,botDm),undefined)
  await denied(()=>b.api({endpoint:'history',conversationId:botDm,limit:100}),'NOT_A_MEMBER')
  record('DM-preview-updates-sender-and-counterparty-without-local-Human-Bot-DM-history-leak',{humanDmConversationId:humanDm,botDmConversationId:botDm})

  stage('unauthorized group and old-epoch history cannot expose summaries')
  const secret=(await topology.operation(a,'create-group',{title:`Private owner ${nonce}`})).conversationId
  const secretMessage=await topology.send(a,secret,`Owner-only content ${nonce}`)
  await summary(a,secret,secretMessage.messageId,secretMessage.text,a.human)
  assert.equal(await entry(b,secret),undefined)
  await denied(()=>b.api({endpoint:'history',conversationId:secret,limit:100}),'NOT_A_MEMBER')
  await denied(()=>members(b,secret),'NOT_A_MEMBER')
  await topology.operation(a,'remove',{conversationId:empty,targetPrincipalId:b.human})
  await until(async()=>!(await entry(b,empty)),'removed membership is omitted from list')
  await denied(()=>b.api({endpoint:'history',conversationId:empty,limit:100}),'NOT_A_MEMBER')
  record('unjoined-and-revoked-Human-have-no-list-summary-or-history-access')

  stage('queued and retry journals remain usable after a deliberate rejection')
  await topology.hub('arm',{point:'deny-publish',principalId:a.human})
  const queued=await topology.send(a,group,`Queued preview ${nonce}`)
  await until(async()=> (await a.api({endpoint:'state'})).outbox.find(item=>item.id===queued.messageId&&item.state==='pending'),'temporary failure keeps original pending intent')
  assert.notEqual((await entry(a,group)).lastMessage?.messageId,queued.messageId,'queued draft is not canonical summary')
  await topology.hub('clear')
  await summary(a,group,queued.messageId,queued.text,a.human)
  await summary(b,group,queued.messageId,queued.text,a.human)
  await a.api(queued)
  assert.equal((await stats()).messages.filter(message=>message.id===queued.messageId).length,1)
  const audit=(await b.api({endpoint:'state'})).outbox.find(item=>item.id===failureId)
  assert.equal(audit.error,'FORBIDDEN');assert.equal(audit.state,'failed')
  assert.equal((await topology.history(a,group)).events.some(event=>event.type==='message'&&event.message?.content.text==='FORBIDDEN'),false)
  const long=await topology.send(a,secret,'😀'.repeat(161))
  const short=await until(async()=>{const row=await entry(a,secret);return row?.lastMessage?.messageId===long.messageId&&row.lastMessage},'bounded Unicode summary')
  assert.ok(Array.from(short.summary).length<=160)
  assert.ok(!/[\uD800-\uDBFF]$/.test(short.summary),'summary does not split a Unicode code point')
  record('queued-intent-and-same-ID-retry-preserved-rejected-audit-never-becomes-chat',{queuedMessageId:queued.messageId,deliberateFailureOperationId:failureId})
  stage('independent nested reply chains retain authorized context and stable pagination')
  const root=await topology.send(a,group,`Thread root ${nonce}`)
  const unrelated=await topology.send(a,group,`Separate topic ${nonce}`)
  const child=await topology.send(a,group,`Thread child ${nonce}`,[],{replyToMessageId:root.messageId})
  const deep=await topology.send(a,group,`Thread deep ${nonce}`,[],{replyToMessageId:child.messageId})
  const branch=await topology.send(a,group,`Thread branch ${nonce}`,[],{replyToMessageId:root.messageId})
  await until(()=>topology.hasText(b,group,branch.text),'readOnly B receives nested thread')
  const threadInput={endpoint:'thread',conversationId:group,messageId:deep.messageId,limit:2}
  for(const peer of topology.peers){
    const first=await peer.api(threadInput),all=[...first.events]
    assert.equal(first.rootMessageId,root.messageId);assert.equal(first.hasMore,true)
    let page=first
    while(page.hasMore){page=await peer.api({...threadInput,after:page.nextAfter,watermark:first.watermark});all.push(...page.events)}
    assert.deepEqual(all.map(event=>event.message.messageId),[root.messageId,child.messageId,deep.messageId,branch.messageId])
    assert.equal(all.some(event=>event.message.messageId===unrelated.messageId),false)
  }
  await denied(()=>b.api({endpoint:'thread',conversationId:secret,messageId:secretMessage.messageId}),'NOT_A_MEMBER')
  await denied(()=>b.api({endpoint:'thread',conversationId:botDm,messageId:botResponse.id}),'NOT_A_MEMBER')
  await denied(()=>a.api({endpoint:'thread',conversationId:humanDm,messageId:deep.messageId}),'REFERENCE_NOT_AVAILABLE')
  await denied(()=>b.api({endpoint:'thread',conversationId:empty,messageId:deep.messageId}),'NOT_A_MEMBER')
  await denied(()=>b.api({endpoint:'thread',conversationId:group,messageId:deep.messageId,membershipEpoch:'stale-epoch'}),'MEMBERSHIP_REVOKED')
  record('nested-thread-context-pagination-readOnly-readable-independent-topics-and-cross-conversation-epoch-denials',{rootMessageId:root.messageId,deepMessageId:deep.messageId,branchMessageId:branch.messageId})
  evidence.status='PASS';save()
  if(live)await holdForBrowser({groupConversationId:group,humanDmConversationId:humanDm,botDmConversationId:botDm,deliberateFailureOperationId:failureId,threadRootMessageId:root.messageId,threadDeepMessageId:deep.messageId})
}catch(error){evidence.status='FAIL';evidence.error=error.message;console.error(error.message);process.exitCode=1}
finally{
  clearTimeout(deadline);if(ownsFixtures)await topology.close()
  try{for(const port of ports)await freePort(port);evidence.cleanedUp=true}catch(error){evidence.status='FAIL';evidence.cleanupError=error.message;process.exitCode=1}
  for(const peer of topology.peers){if(!peer.home)continue;const target=resolve(peer.home);assert.equal(dirname(target),repo);assert.equal(target,join(repo,`.dsh-test-${peer.name}`));assert.ok(peer.name.startsWith(`reply-chain-${nonce}`));rmSync(target,{recursive:true,force:true})}
  evidence.temporaryProfilesDeleted=true
  if(ownerEnv===undefined)delete process.env.DSBOT_COMMUNICATION_OWNER_PID;else process.env.DSBOT_COMMUNICATION_OWNER_PID=ownerEnv
  if(readyPath)writeFileSync(readyPath,JSON.stringify({...ready,status:'STOPPED'},null,2))
  save();console.log(`Evidence: .dsh-test-tools/${topology.prefix}-acceptance.json`)
}
