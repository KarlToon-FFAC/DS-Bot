// Real DSH A/B with a real same-machine loopback Hub; deterministic Mock only.
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { createServer } from 'node:net'
import { DatabaseSync } from 'node:sqlite'
import { existsSync, writeFileSync, rmSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { LocalTopology, until } from './local-topology.mjs'
import { repo } from './bench-client.mjs'

const nonce=randomUUID().slice(0,8),topology=new LocalTopology({prefix:`bot-started-${nonce}`,webPort:3187,mockPort:8887,hubPort:3193})
const ports=[3187,3188,8887,8888,3193],live=process.argv.includes('--live-for-browser')
const output=join(topology.root,`${topology.prefix}-acceptance.json`)
const evidence={status:'RUNNING',prefix:topology.prefix,network:'same-machine loopback',model:'local deterministic Mock',cases:[],uncovered:['cross-physical-machine/WSS deployment','real model behavior','GUI screenshots (separate Cua acceptance)','source-invalid/deferred/rejected pre-step and forged receipt unit matrix']}
const save=()=>writeFileSync(output,JSON.stringify(evidence,null,2))
const stage=value=>{evidence.stage=value;save()}
const record=(id,details={})=>{evidence.cases.push({id,status:'PASS',...details});save();console.log(`PASS ${id}`)}
const ownerEnv=process.env.DSBOT_COMMUNICATION_OWNER_PID
process.env.DSBOT_COMMUNICATION_OWNER_PID=String(process.pid)
const bench=topology.bench.bind(topology)
topology.bench=(peer,action,extra={})=>bench(peer,action,{DSBOT_COMMUNICATION_OWNER_PID:String(process.pid),DSBOT_WEB_OPEN:'0',...extra})
const freePort=port=>new Promise((resolveFree,reject)=>{const server=createServer();server.once('error',()=>reject(new Error(`Required isolated port ${port} occupied`)));server.listen(port,'127.0.0.1',()=>server.close(resolveFree))})
const deadline=setTimeout(()=>{console.error('Acceptance hard deadline exceeded');void topology.close().finally(()=>process.exit(1))},12*60*1000)
let readyPath,ready,ownsFixtures=false
function canonical(){
  const db=new DatabaseSync(join(topology.root,`${topology.prefix}-hub.sqlite`),{readOnly:true})
  try{return {events:db.prepare('SELECT body FROM events ORDER BY conversation_id,seq').all().map(row=>JSON.parse(row.body)),members:db.prepare('SELECT conversation_id,principal_id,epoch,active FROM memberships').all()}}
  finally{db.close()}
}
const starts=(messageId)=>canonical().events.filter(event=>event.type==='bot.work.started'&&event.messageId===messageId)
const logical=value=>value.sessions.flatMap(session=>session.events).filter(event=>event.type==='user/message'&&event.data.source?.kind==='ds-bot-communication')
const inspect=(peer,conversationId)=>peer.client.api({operation:'production-state',conversationId})
async function actualInput(peer,conversationId,messageId){
  const findStep=value=>{
    for(const session of value.sessions){
      let turn,step
      for(const event of session.events){
        if(event.type==='turn/start'){turn=event.data.turn;step=null}
        if(event.type==='turn/end'){turn=undefined;step=null}
        if(event.type==='step/end')step=null
        if(event.type==='step/start'&&event.data.turn===turn)step=event
        if(step&&event.type==='user/message'&&event.data.source?.messageId===messageId&&event.data.source?.kind==='ds-bot-communication'&&(event.data.turn??turn)===step.data.turn)
          return {sessionId:session.sessionId,inputSeq:event.seq,stepSeq:step.seq,turn:step.data.turn}
      }
    }
  }
  const value=await until(async()=>{const state=await inspect(peer,conversationId);return findStep(state)&&state},'actual DSH communication input within a public started step',60000)
  const entries=logical(value).filter(event=>event.data.source.messageId===messageId)
  assert.equal(entries.length,1,'one actual logical DSH input')
  evidence.dshSteps??=[]
  const source=entries[0].data.source
  if(!evidence.dshSteps.some(item=>item.deliveryId===source.deliveryId)){evidence.dshSteps.push({deliveryId:source.deliveryId,messageId,principalId:peer.bot,...findStep(value)});save()}
  return source
}
async function verifyStarted(peer,conversationId,messageId){
  const source=await actualInput(peer,conversationId,messageId)
  const event=await until(()=>starts(messageId).find(event=>event.principalId===peer.bot),'canonical real Bot enter event',60000)
  const current=canonical().members.find(member=>member.conversation_id===conversationId&&member.principal_id===peer.bot)
  const delivery=(await topology.hub('stats')).deliveries.find(delivery=>delivery.id===source.deliveryId)
  assert.ok(current?.active&&delivery?.ai)
  assert.equal(delivery.message_id,messageId)
  assert.equal(delivery.recipient_id,peer.bot)
  assert.equal(event.eventId,`bot-work-started:${source.deliveryId}`)
  assert.equal(event.deliveryId,source.deliveryId)
  assert.equal(event.conversationId,conversationId)
  assert.equal(event.membershipEpoch,source.membershipEpoch)
  assert.equal(event.membershipEpoch,current.epoch)
  assert.equal(event.membershipEpoch,delivery.membership_epoch)
  assert.ok(Number.isSafeInteger(event.conversationSeq))
  assert.ok(Number.isFinite(Date.parse(event.serverStartedAt)),'Hub assigned ISO start time')
  for(const observer of topology.peers){
    const view=await until(async()=> (await topology.history(observer,conversationId)).events.find(item=>item.eventId===event.eventId),'same started event visible to both Humans')
    assert.deepEqual(view,event)
  }
  assert.equal(starts(messageId).filter(item=>item.principalId===peer.bot).length,1)
  return event
}
async function finalReply(peer,conversationId,text){
  return until(async()=> (await topology.hub('stats')).messages.find(message=>message.conversation_id===conversationId&&message.author_id===peer.bot&&JSON.parse(message.body).content.text===text),'canonical Mock final',60000)
}
async function holdForBrowser(conversationId){
  clearTimeout(deadline)
  const stopFile=join(topology.root,`${topology.prefix}-browser-stop`),expiresAt=Date.now()+12*60*1000
  readyPath=join(topology.root,`${topology.prefix}-browser-ready.json`)
  ready={status:'READY',expiresAt:new Date(expiresAt).toISOString(),conversationId,profiles:topology.peers.map(peer=>({url:`http://127.0.0.1:${peer.web}/`,instanceId:peer.instanceId,humanPrincipalId:peer.human,botPrincipalId:peer.bot})),stopFile}
  writeFileSync(readyPath,JSON.stringify(ready,null,2));evidence.browserReadyFile=readyPath;save()
  console.log(`BROWSER_READY .dsh-test-tools/${topology.prefix}-browser-ready.json`)
  while(!existsSync(stopFile)&&Date.now()<expiresAt)await new Promise(resolvePause=>setTimeout(resolvePause,500))
}
try{
  stage('fresh isolated topology preparation')
  for(const port of ports)await freePort(port)
  for(const peer of topology.peers)assert.equal(existsSync(join(repo,`.dsh-test-${peer.name}`)),false,'fresh owned profiles only')
  ownsFixtures=true
  await topology.initialize()
  const [a,b]=topology.peers
  for(const [peer,name] of [[a,'StartedA'],[b,'StartedB']])await peer.client.request('/api/bot',{endpoint:'update-bot',payload:{id:peer.botId,name}})
  await until(async()=> (await a.api({endpoint:'state'})).contacts.find(contact=>contact.principalId===b.bot)?.displayName==='StartedB','distinct current Bot names synchronized')
  const group=await topology.group(`Bot started ${nonce}`,[a.bot,b.human,b.bot],{allowSpeaking:false})
  evidence.conversationId=group;save()

  stage('Human unmentioned and readOnly rejection never imply Bot start')
  const plain=await topology.send(a,group,`Human note ${nonce}`)
  for(const peer of topology.peers)await until(()=>topology.hasText(peer,group,plain.text),'unmentioned Human note visible')
  assert.equal((await topology.hub('stats')).deliveries.filter(delivery=>delivery.message_id===plain.messageId&&delivery.ai).length,0)
  assert.equal(starts(plain.messageId).length,0)
  for(const peer of topology.peers)assert.equal(logical(await inspect(peer,group)).filter(event=>event.data.source.messageId===plain.messageId).length,0)
  const deniedId=randomUUID()
  await assert.rejects(()=>topology.send(b,group,`COMM-ECHO readOnly-${nonce}`,[a.bot],{messageId:deniedId}),/SPEAKING_FORBIDDEN/)
  assert.ok(!(await topology.hub('stats')).messages.some(message=>message.id===deniedId))
  assert.equal(starts(deniedId).length,0)
  record('unmentioned-Human-and-readOnly-send-have-no-start-event',{messageId:plain.messageId,rejectedMessageId:deniedId})

  stage('queued remote delivery is not started until real DSH enter')
  await topology.bench(b,'stop')
  const queued=await topology.send(a,group,`COMM-COLLAB DONE remote-${nonce} @StartedB`,[b.bot])
  await until(async()=> (await topology.hub('stats')).deliveries.find(delivery=>delivery.message_id===queued.messageId&&delivery.recipient_id===b.bot&&delivery.ai),'canonical AI delivery queued while remote DSH offline')
  assert.equal(starts(queued.messageId).length,0,'AI delivery alone cannot announce work started')
  record('offline-queued-AI-delivery-does-not-announce-start',{messageId:queued.messageId})
  await topology.startPeer(b)
  const started=await verifyStarted(b,group,queued.messageId)
  await finalReply(b,group,`Collaboration done remote-${nonce}`)
  record('remote-real-DSH-enter-correlates-delivery-message-recipient-current-epoch-and-shared-history',{eventId:started.eventId,messageId:queued.messageId,deliveryId:started.deliveryId})

  stage('same original send request retry does not duplicate start')
  await a.api(queued)
  const barrier=await topology.send(a,group,`Retry observation barrier ${nonce}`)
  for(const peer of topology.peers)await until(()=>topology.hasText(peer,group,barrier.text),'post-retry history synchronized')
  assert.equal(starts(queued.messageId).length,1)
  assert.equal(logical(await inspect(b,group)).filter(event=>event.data.source.messageId===queued.messageId).length,1)
  assert.equal((await topology.hub('stats')).messages.filter(message=>message.author_id===b.bot&&JSON.parse(message.body).content.text===`Collaboration done remote-${nonce}`).length,1)
  record('same-message-request-retry-has-one-DSH-input-one-start-one-final')

  stage('all current Bots each emit one real start')
  const all=await topology.send(a,group,`COMM-COLLAB DONE all-${nonce} @all`)
  for(const peer of topology.peers){await verifyStarted(peer,group,all.messageId);await finalReply(peer,group,`Collaboration done all-${nonce}`)}
  assert.deepEqual(starts(all.messageId).map(event=>event.principalId).sort(),[a.bot,b.bot].sort())
  record('all-current-Bots-each-start-once-with-no-Human-start',{messageId:all.messageId,eventIds:starts(all.messageId).map(event=>event.eventId)})

  stage('membership revoked before remote enter rejects queued work')
  const revokedGroup=await topology.group(`Revoked queued work ${nonce}`,[b.bot],{allowSpeaking:false})
  await topology.bench(b,'stop')
  const revoked=await topology.send(a,revokedGroup,`COMM-ECHO revoked-${nonce}`,[b.bot])
  await until(async()=> (await topology.hub('stats')).deliveries.find(delivery=>delivery.message_id===revoked.messageId&&delivery.recipient_id===b.bot&&delivery.ai),'queued work before revocation')
  await topology.operation(a,'remove',{conversationId:revokedGroup,targetPrincipalId:b.bot})
  assert.equal((await topology.hub('stats')).deliveries.find(delivery=>delivery.message_id===revoked.messageId&&delivery.recipient_id===b.bot).revoked,1)
  await topology.startPeer(b)
  const recoveryBarrier=await topology.send(a,group,`COMM-ECHO recovered-${nonce}`,[b.bot])
  await verifyStarted(b,group,recoveryBarrier.messageId)
  await finalReply(b,group,`Communication reply recovered-${nonce}`)
  assert.equal(starts(revoked.messageId).length,0)
  assert.equal(logical(await inspect(b,revokedGroup)).filter(event=>event.data.source.messageId===revoked.messageId).length,0)
  assert.equal(starts(queued.messageId).length,1,'reconnection cannot duplicate an earlier start')
  assert.equal(starts(all.messageId).length,2,'reconnection preserves one start per original all target')
  record('removed-member-old-epoch-queued-delivery-never-starts',{messageId:revoked.messageId})
  evidence.status='PASS';save()
  if(live)await holdForBrowser(group)
}catch(error){evidence.status='FAIL';evidence.error=error.message;console.error(error.message);process.exitCode=1}
finally{
  clearTimeout(deadline);if(ownsFixtures)await topology.close()
  try{for(const port of ports)await freePort(port);evidence.cleanedUp=true}catch(error){evidence.status='FAIL';evidence.cleanupError=error.message;process.exitCode=1}
  for(const peer of topology.peers){
    if(!peer.home)continue
    const target=resolve(join(repo,`.dsh-test-${peer.name}`));assert.equal(dirname(target),repo);assert.ok(peer.name.startsWith(`bot-started-${nonce}`))
    rmSync(target,{recursive:true,force:true})
  }
  evidence.temporaryProfilesDeleted=true
  if(ownerEnv===undefined)delete process.env.DSBOT_COMMUNICATION_OWNER_PID;else process.env.DSBOT_COMMUNICATION_OWNER_PID=ownerEnv
  if(readyPath)writeFileSync(readyPath,JSON.stringify({...ready,status:'STOPPED'},null,2))
  save();console.log(`Evidence: .dsh-test-tools/${topology.prefix}-acceptance.json`)
}
