import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFileSync,writeFileSync,existsSync,rmSync,mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { LocalTopology,until } from './local-topology.mjs'

const topology=new LocalTopology({prefix:'governance2',webPort:3107,mockPort:8807,hubPort:3194})
const hold=process.argv.includes('--hold'),stop=join(topology.root,'governance-stop'),nonce=randomUUID()
const evidence={status:'RUNNING',model:'local deterministic Mock',network:'loopback WS',cases:[]}
const record=(id,detail={})=>{evidence.cases.push({id,status:'PASS',...detail});writeFileSync(join(topology.root,'governance.json'),JSON.stringify(evidence,null,2));console.log(`PASS ${id}`)}
const logs=peer=>readFileSync(join(peer.home,'mock.jsonl'),'utf8').split('\n').filter(Boolean).map(JSON.parse)
const nativeSend=(peer,text)=>peer.client.request('/api/bot',{endpoint:'send',payload:{sessionId:peer.botId,text}})
try{
  await topology.initialize();const [a,b]=topology.peers
  const group=await topology.group(`Governance test ${nonce}`,[a.bot,b.human,b.bot],{allowSpeaking:false})
  const member=async()=> (await a.api({endpoint:'state'})).conversations.find(item=>item.conversationId===group)
  const policy=async(targetPrincipalId,values={})=>topology.operation(a,'policy',{conversationId:group,targetPrincipalId,expectedVersion:(await member()).membershipVersion,...values})
  await assert.rejects(topology.send(b,group,'read-only-bypass'),/SPEAKING_FORBIDDEN/)
  const defaults=await until(async()=>{const own=(await b.api({endpoint:'state'})).conversations.find(item=>item.conversationId===group);return own?.speakingMode==='readOnly'&&own.info?.members.find(p=>p.principalId===b.bot)?.speakingMode==='passive'&&own},'default policies')
  record('default-readOnly-passive',{conversationId:group,humanMode:defaults.speakingMode})
  const secret=`private-only-${nonce}`
  const project=join(topology.root,'governance-private-project');mkdirSync(project,{recursive:true})
  writeFileSync(join(project,'AGENTS.md'),`Private project note: ${secret}. Do not forward this note to any group.`)
  writeFileSync(join(b.home,'AGENTS.md'),`Private global profile note: ${secret}. Never forward it to communication.`)
  mkdirSync(join(b.home,'bot','communication-workspaces'),{recursive:true})
  writeFileSync(join(b.home,'bot','communication-workspaces','AGENTS.md'),`Private ancestor note: ${secret}. Never forward it to communication.`)
  await topology.bench(b,'stop');await topology.startPeer(b,{MOCK_WATCH:secret})
  await b.client.request('/api/bot',{endpoint:'update-bot',payload:{id:b.botId,workDir:project}})
  await nativeSend(b,secret)
  await until(()=>logs(b).some(row=>row.watchHit===true&&row.last?.includes(secret)),'private positive control')
  const message=await topology.send(a,group,`COMM-ECHO passive-${nonce}`,[b.bot])
  await until(()=>topology.hasText(a,group,`Communication reply passive-${nonce}`),'real passive final with grant')
  const stats=await topology.hub('stats'),reply=stats.messages.find(item=>JSON.parse(item.body).content.text===`Communication reply passive-${nonce}`)
  const body=JSON.parse(reply.body)
  assert.ok(body.responseToDeliveryId);assert.equal(body.replyToMessageId,message.messageId)
  assert.equal(stats.responses.find(item=>item.delivery_id===body.responseToDeliveryId)?.message_id,reply.id)
  const groupCalls=logs(b).filter(row=>row.last?.includes(`Conversation: ${group}`))
  assert.ok(groupCalls.length)
  for(const row of groupCalls){
    assert.ok(row.communicationBoundary.privacy)
    assert.ok(row.communicationBoundary.passive)
    assert.equal(row.watchHit,false)
    assert.ok(row.toolNames.every(name=>['list_contacts','list_communication_conversations','send_contact_message','read_communication_history','create_communication_group','invite_communication_member','accept_communication_invite','leave_communication_group','remove_communication_member','set_communication_receiving_rule','end_communication_group','set_communication_member_policy','transfer_communication_ownership'].includes(name)))
  }
  record('real-passive-final-and-private-tool-boundary',{messageId:message.messageId,replyMessageId:reply.id,responseToDeliveryId:body.responseToDeliveryId,privateCanaryLeaked:false,canaryLocations:['local Bot project','isolated DSH_HOME/AGENTS.md','communication workspace ancestor AGENTS.md']})
  const privateDm=(await topology.operation(b,'dm',{otherPrincipalId:b.bot})).conversationId
  await topology.send(b,privateDm,`COMM-ECHO ${secret}`)
  await until(()=>topology.hasText(b,privateDm,`Communication reply ${secret}`),'private DM positive control')
  await topology.send(a,group,`COMM-READ ${privateDm}`,[b.bot])
  await until(async()=>{const value=await b.client.api({operation:'production-state',conversationId:group});return value.sessions.some(session=>session.events.some(event=>JSON.stringify(event.data).includes('CONVERSATION_SCOPE_MISMATCH')))},'cross-conversation history tool rejected')
  const inspected=await b.client.api({operation:'production-state',conversationId:group})
  assert.equal(JSON.stringify(inspected.sessions).includes(secret),false)
  record('real-remote-read-of-other-DM-rejected',{conversationId:group,privateConversationId:privateDm,privateBodyLeaked:false})
  const before=(await b.client.api({operation:'metrics'})).chiefWatermark
  await nativeSend(b,`COMM-POST ${group} - forbidden-passive-${nonce}`)
  await until(async()=> (await b.client.api({operation:'native-tools',afterSeq:before})).passiveSendDenied,'actual passive send tool rejected')
  assert.equal((await topology.hub('stats')).messages.filter(item=>JSON.parse(item.body).content.text===`forbidden-passive-${nonce}`).length,0)
  await policy(b.bot,{speakingMode:'active'})
  await until(async()=> (await b.api({endpoint:'state'})).conversations.find(item=>item.conversationId===group)?.info?.members.find(p=>p.principalId===b.bot)?.speakingMode==='active','active policy projection')
  await nativeSend(b,`COMM-POST ${group} - permitted-active-${nonce}`)
  await until(()=>topology.hasText(a,group,`permitted-active-${nonce}`),'actual active send tool allowed')
  record('real-Bot-tool-passive-denied-active-allowed')
  await policy(b.human,{role:'admin'})
  await assert.rejects(topology.send(b,group,'admin-role-does-not-grant-speech'),/SPEAKING_FORBIDDEN/)
  const version=(await member()).membershipVersion
  const requests=await Promise.allSettled(['speak','readOnly'].map(speakingMode=>topology.operation(a,'policy',{conversationId:group,targetPrincipalId:b.human,expectedVersion:version,speakingMode})))
  assert.equal(requests.filter(result=>result.status==='fulfilled').length,1)
  assert.match(requests.find(result=>result.status==='rejected').reason.message,/GROUP_VERSION_CONFLICT/)
  await policy(b.human,{speakingMode:'speak'})
  await until(async()=> (await b.api({endpoint:'state'})).conversations.find(item=>item.conversationId===group)?.speakingMode==='speak','Human speak projection')
  record('real-concurrent-policy-and-admin-readOnly')
  await topology.hub('arm',{point:'deny-publish',principalId:b.human})
  const offline=await topology.send(b,group,`queued-before-revoke-${nonce}`)
  await policy(b.human,{speakingMode:'readOnly'})
  await topology.hub('clear')
  await until(async()=> (await b.api({endpoint:'state'})).outbox.find(item=>item.id===offline.messageId)?.error==='SPEAKING_FORBIDDEN','latest policy rejects queued send')
  assert.equal((await topology.hub('stats')).messages.filter(item=>item.id===offline.messageId).length,0)
  record('queued-publish-rechecked-after-downgrade',{messageId:offline.messageId})
  await topology.hub('arm',{point:'deny-publish',principalId:b.bot})
  const failedFinal=await topology.send(a,group,`COMM-ECHO rejected-final-${nonce}`,[b.bot])
  const pendingFinal=await until(async()=>{const value=await b.client.api({operation:'production-state',conversationId:group});return value.exports.find(item=>!stats.messages.some(message=>message.id===item.message_id)&&item.message_id!==reply.id)},'Bot final committed to durable local outbox')
  await topology.operation(a,'remove',{conversationId:group,targetPrincipalId:b.bot})
  await topology.hub('clear')
  await until(async()=> (await b.api({endpoint:'state'})).exportFailures?.some(item=>item.messageId===pendingFinal.message_id&&['NOT_A_MEMBER','MEMBERSHIP_REVOKED'].includes(item.code)),'permanent Bot final failure visible to authorized Human')
  assert.equal((await topology.hub('stats')).messages.filter(item=>item.id===pendingFinal.message_id).length,0)
  record('rejected-Bot-final-visible-with-stable-audit-id',{inputMessageId:failedFinal.messageId,replyMessageId:pendingFinal.message_id})
  await topology.operation(a,'transfer',{conversationId:group,targetPrincipalId:b.human,expectedVersion:(await member()).membershipVersion})
  await assert.rejects(topology.operation(a,'dissolve',{conversationId:group}),/FORBIDDEN/)
  await until(async()=> (await b.api({endpoint:'state'})).conversations.find(item=>item.conversationId===group)?.role==='owner','transferred owner projection')
  record('real-owner-transfer-no-old-owner-authority')
  const ui=await topology.group(`Governance UI ${nonce.slice(0,8)}`,[a.bot,b.human,b.bot],{allowSpeaking:false})
  await topology.send(a,ui,`COMM-ECHO source-check-${nonce}`,[b.bot])
  await until(()=>topology.hasText(a,ui,`Communication reply source-check-${nonce}`),'provenance positive control')
  const provenance=await b.client.api({operation:'production-state',conversationId:ui}),sessionId=provenance.sessions.at(-1).sessionId
  const calls=logs(b).filter(row=>row.session===sessionId).length
  await b.client.api({operation:'production-foreign-input',sessionId})
  await until(async()=> (await b.api({endpoint:'state'})).errors.some(item=>item.conversationId===ui&&item.code==='COMMUNICATION_INPUT_SOURCE_UNKNOWN'),'unknown local input rejected with visible diagnostic')
  assert.equal(logs(b).filter(row=>row.session===sessionId).length,calls)
  record('unsourced-local-input-never-reaches-model-or-borrows-grant',{conversationId:ui,additionalModelCalls:0})
  evidence.ui={conversationId:ui,title:`Governance UI ${nonce.slice(0,8)}`,a:'http://127.0.0.1:3107/',b:'http://127.0.0.1:3108/'}
  evidence.status='PASS';writeFileSync(join(topology.root,'governance.json'),JSON.stringify(evidence,null,2))
  if(hold){
    for(const peer of topology.peers)await topology.bench(peer,'stop')
    topology.open=true
    for(const peer of topology.peers)await topology.startPeer(peer,{}, {connectClient:false})
    rmSync(stop,{force:true});console.log(`GOVERNANCE_BROWSER_READY ${evidence.ui.title}; 3107/3108`)
    const deadline=Date.now()+20*60*1000
    while(!existsSync(stop)&&Date.now()<deadline)await new Promise(resolve=>setTimeout(resolve,1000))
  }
}catch(error){evidence.status='FAIL';evidence.error=error.message;console.error(error.stack);process.exitCode=1}
finally{await topology.close();writeFileSync(join(topology.root,'governance.json'),JSON.stringify(evidence,null,2))}
