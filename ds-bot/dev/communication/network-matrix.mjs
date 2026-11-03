import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFileSync,writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { LocalTopology,until } from './local-topology.mjs'
import { modelCalls } from './bench-client.mjs'

const topology=new LocalTopology({prefix:'p4net',webPort:3105,mockPort:8805,hubPort:3193})
const evidence={status:'RUNNING',model:'local deterministic Mock',network:'loopback WS; independent persistent Hub process',cases:[]},nonce=randomUUID()
const record=(id,detail={})=>{evidence.cases.push({id,status:'PASS',...detail});console.log(`PASS ${id}`);writeFileSync(join(topology.root,'p4-network.json'),JSON.stringify(evidence,null,2))}
const readOutbox=(peer,id)=>{const db=topology.db(peer);try{return db.prepare('SELECT * FROM outbox WHERE id=?').get(id)}finally{db.close()}}
try{
  await topology.initialize();const [a,b]=topology.peers
  const {conversationId}=await topology.operation(a,'dm',{otherPrincipalId:b.human})
  await until(async()=> (await b.api({endpoint:'state'})).conversations.some(item=>item.conversationId===conversationId),'target sees canonical DM membership')
  for(const point of ['before-commit-crash','after-commit-crash']){
    await topology.hub('arm',{point})
    const sent=await topology.send(a,conversationId,`${point} ${nonce}`)
    await until(()=>topology.child.exitCode!==null||topology.child.signalCode!==null,`${point} actual Hub death`)
    const marker=JSON.parse(readFileSync(join(topology.root,`${topology.prefix}-hub-checkpoint.json`),'utf8'));assert.equal(marker.messageId,sent.messageId)
    const db=new DatabaseSync(join(topology.root,`${topology.prefix}-hub.sqlite`),{readOnly:true})
    try{assert.equal(db.prepare('SELECT count(*) n FROM messages WHERE id=?').get(sent.messageId).n,point==='before-commit-crash'?0:1)}finally{db.close()}
    assert.equal(readOutbox(a,sent.messageId).state,'pending')
    await topology.startHub()
    await until(()=>topology.hasText(b,conversationId,sent.text),`${point} exact retry delivered`)
    await until(()=>readOutbox(a,sent.messageId).state==='accepted',`${point} sender converged`)
    const stats=await topology.hub('stats'),committed=stats.messages.filter(item=>item.id===sent.messageId)
    assert.equal(committed.length,1)
    if(point==='after-commit-crash')assert.equal(committed[0].seq,marker.conversationSeq)
    record(point,{messageId:sent.messageId,conversationId,canonicalMessages:1,conversationSeq:committed[0].seq})
  }
  await topology.hub('arm',{point:'drop-ack'})
  const dropped=await topology.send(a,conversationId,`ACK lost with socket open ${nonce}`)
  const marker=await until(()=>{try{const value=JSON.parse(readFileSync(join(topology.root,`${topology.prefix}-hub-checkpoint.json`),'utf8'));return value.messageId===dropped.messageId?value:false}catch{return false}},'committed ACK dropped')
  assert.equal(marker.socketOpen,true);assert.equal(readOutbox(a,dropped.messageId).state,'pending')
  await until(()=>readOutbox(a,dropped.messageId).state==='accepted','timeout retry uses original commit',45000)
  assert.equal((await topology.hub('stats')).messages.filter(item=>item.id===dropped.messageId).length,1)
  record('ACK-loss-on-open-socket',{messageId:dropped.messageId,conversationSeq:marker.conversationSeq})
  await topology.stopHub()
  await until(async()=>!(await a.api({endpoint:'state'})).connected,'sender offline')
  const offline=await topology.send(a,conversationId,`Offline before Hub ${nonce}`),original=readOutbox(a,offline.messageId)
  assert.equal(original.state,'pending')
  await topology.bench(a,'stop');await topology.startPeer(a,{}, {allowOffline:true})
  assert.equal(readOutbox(a,offline.messageId).hash,original.hash)
  await topology.startHub()
  await until(()=>topology.hasText(b,conversationId,offline.text),'durable sender outbox after host restart')
  record('offline-sender-host-restart',{messageId:offline.messageId,payloadHashPreserved:true})
  const duplicate=await topology.send(a,conversationId,`Duplicate original ID ${nonce}`)
  for(let index=0;index<3;index++)await a.api(duplicate)
  await new Promise(resolve=>setTimeout(resolve,300));await a.api(duplicate)
  await until(()=>topology.hasText(b,conversationId,duplicate.text),'duplicate delivered')
  assert.equal((await topology.history(b,conversationId)).events.filter(event=>event.message?.messageId===duplicate.messageId).length,1)
  const duplicateStats=await topology.hub('stats')
  assert.equal(duplicateStats.deliveries.filter(item=>item.message_id===duplicate.messageId&&item.recipient_id===b.human).length,1)
  record('triple-plus-delayed-retransmit',{messageId:duplicate.messageId,canonicalMessages:1,recipientDeliveries:1})
  const calls=topology.peers.map(peer=>modelCalls(peer.name))
  for(let index=0;index<3;index++){
    const old=(await topology.hub('stats')).instances.find(item=>item.id===b.instanceId).epoch
    await topology.hub('disconnect',{instanceId:b.instanceId})
    await until(async()=> (await topology.hub('stats')).instances.find(item=>item.id===b.instanceId).epoch>old,'fresh authorized reconnect epoch')
  }
  assert.deepEqual(topology.peers.map(peer=>modelCalls(peer.name)),calls)
  assert.equal((await topology.history(b,conversationId)).events.filter(event=>event.message?.messageId===duplicate.messageId).length,1)
  record('repeated-reconnect',{reconnects:3,newModelCalls:0,duplicateMessages:0})
  const group=await topology.group(`Gap ${nonce.slice(0,8)}`,[b.human,b.bot])
  await topology.bench(b,'stop')
  const gapFirst={endpoint:'send',conversationId:group,text:`COMM-ECHO gap-first-${nonce}`,mentions:[b.bot],messageId:randomUUID(),clientCreatedAt:new Date().toISOString()}
  await topology.hub('arm',{point:'history-gap',conversationId:group,principalId:b.bot,messageId:gapFirst.messageId})
  await a.api(gapFirst)
  const gapSecond=await topology.send(a,group,`COMM-ECHO gap-second-${nonce}`,[b.bot])
  await until(async()=> (await topology.hub('stats')).messages.some(item=>item.id===gapSecond.messageId),'both gap messages committed')
  const beforeGap=modelCalls(b.name)
  await topology.startPeer(b)
  await until(async()=> (await b.api({endpoint:'state'})).error==='HISTORY_GAP','gap diagnostic visible')
  const db=topology.db(b)
  try{
    const member=db.prepare('SELECT epoch FROM memberships WHERE conversation_id=? AND principal_id=?').get(group,b.bot)
    const cursor=db.prepare('SELECT seq FROM cursors WHERE conversation_id=? AND principal_id=? AND epoch=?').get(group,b.bot,member.epoch).seq
    const later=db.prepare("SELECT seq FROM events WHERE conversation_id=? AND principal_id=? AND epoch=? AND json_extract(body,'$.message.messageId')=?").get(group,b.bot,member.epoch,gapSecond.messageId)
    assert.ok(later.seq>cursor)
  }finally{db.close()}
  assert.equal(modelCalls(b.name),beforeGap)
  await topology.hub('clear')
  await until(()=>topology.hasText(a,group,`Communication reply gap-first-${nonce}`),'missing event recovered')
  await until(()=>topology.hasText(a,group,`Communication reply gap-second-${nonce}`),'buffered later event consumed')
  assert.equal(modelCalls(b.name)-beforeGap,2)
  record('reordered-permanent-gap-then-incremental-repair',{conversationId:group,messageIds:[gapFirst.messageId,gapSecond.messageId],modelCallsWhileGap:0,modelCallsAfterRepair:2})
  await topology.stopHub()
  await until(async()=>!(await a.api({endpoint:'state'})).connected&&!(await b.api({endpoint:'state'})).connected,'both hosts offline')
  const pendingA=await topology.send(a,conversationId,`A backlog ${nonce}`),pendingB=await topology.send(b,conversationId,`B backlog ${nonce}`)
  for(const peer of topology.peers)await topology.bench(peer,'stop')
  await topology.startHub();for(const peer of topology.peers)await topology.startPeer(peer)
  await until(()=>topology.hasText(b,conversationId,pendingA.text),'A backlog restored')
  await until(()=>topology.hasText(a,conversationId,pendingB.text),'B backlog restored')
  assert.equal((await topology.operation(b,'dm',{otherPrincipalId:a.human})).conversationId,conversationId)
  record('A-B-Hub-backlog-restarts',{conversationId,messageIds:[pendingA.messageId,pendingB.messageId],canonicalDmPreserved:true})
  evidence.status='PASS'
}catch(error){evidence.status='FAIL';evidence.error=error.stack;console.error(error.stack);process.exitCode=1}
finally{await topology.close();writeFileSync(join(topology.root,'p4-network.json'),JSON.stringify(evidence,null,2))}
