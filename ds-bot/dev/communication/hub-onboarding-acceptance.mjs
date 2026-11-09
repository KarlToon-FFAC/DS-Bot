// Fresh real DSH profiles enroll through their public Human API and SDK records.
import assert from 'node:assert/strict'
import { randomBytes, randomUUID } from 'node:crypto'
import { fork, spawn } from 'node:child_process'
import { createServer } from 'node:net'
import { existsSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { LocalTopology, until } from './local-topology.mjs'
import { benchClient, repo } from './bench-client.mjs'
import { startHub } from '../../../communication-hub/src/server.js'
import { CommunicationError } from '../../../communication-hub/src/protocol.js'
import { createServer as createHttpServer } from 'node:http'
import { createManagementHttp } from '../../../communication-hub/src/management-http.js'
import { caFixture } from '../../test/fixtures/hub-ca-fixture.mjs'

if(process.argv[2]==='--owned-hub'){
  let denied=null
  const scoped=process.argv.includes('--scoped-ca'),fixture=scoped?caFixture():null,ca=fixture?.ca('native-root'),leaf=ca?fixture.leaf('native-leaf',ca):null
  const hub=await startHub({databasePath:process.argv[3],port:3194,peers:[],...(leaf?{tls:{cert:leaf.cert,key:leaf.key}}:{}),management:{enabled:true,password:process.env.DSBOT_TEST_ADMIN_PASSWORD,url:`${scoped?'wss':'ws'}://127.0.0.1:3194/communication`,...(ca?{pairingCa:ca.pem}:{})},beforeRequest:request=>{
    if(request.type==='message.publish'&&denied?.principalId===request.payload.author?.principalId&&denied.conversationId===request.payload.conversationId)throw new CommunicationError('STORAGE_UNAVAILABLE')
  }})
  let browserAdmin
  if(scoped){
    const handler=createManagementHttp(hub.management,{password:process.env.DSBOT_TEST_ADMIN_PASSWORD,origin:'http://127.0.0.1:3195'})
    browserAdmin=createHttpServer(async(req,res)=>{if(!await handler.handle(req,res)){res.writeHead(404);res.end()}})
    await new Promise(resolve=>browserAdmin.listen(3195,'127.0.0.1',resolve))
  }
  delete process.env.DSBOT_TEST_ADMIN_PASSWORD
  process.on('message',message=>{
    let value
    if(message.command==='deny'){denied=message.value;value={armed:true}}
    else if(message.command==='clear'){denied=null;value={cleared:true}}
    else if(message.command==='stats')value={messages:hub.store.db.prepare('SELECT id,conversation_id,seq,author_id,body FROM messages').all(),deliveries:hub.store.db.prepare('SELECT * FROM deliveries').all(),responses:hub.store.db.prepare('SELECT * FROM responses').all()}
    else return process.send({id:message.id,ok:false})
    process.send({id:message.id,ok:true,value})
  })
  process.once('disconnect',()=>void hub.close().finally(()=>{browserAdmin?.close();fixture?.close();process.exit(0)}))
  process.send({type:'ready'})
  await new Promise(()=>{})
}

const nonce=randomUUID().slice(0,8),topology=new LocalTopology({prefix:`hub-onboard-${nonce}`,webPort:3185,mockPort:8885,hubPort:3194})
const output=join(topology.root,`${topology.prefix}-acceptance.json`),enrollOnly=process.argv.includes('--enroll-only'),liveForBrowser=process.argv.includes('--live-for-browser')
const scopedCa=process.argv.includes('--scoped-ca')
const evidence={status:'RUNNING',scope:enrollOnly?'enrollment minimum':'full onboarding/consent/avatar acceptance',network:'same-machine loopback',model:'local deterministic Mock',prefix:topology.prefix,cases:[],uncovered:['cross-physical-machine/WSS deployment','real model/GUI behavior','reject/expire/admin-revoke-repair/rate-limit/replay/forgery (independent unit suites)'],temporaryKeys:'Fresh isolated DSH SDK records only; owned profiles deleted after stopping processes by default. --keep-profiles retains them privately for diagnosis.'}
const save=()=>writeFileSync(output,JSON.stringify(evidence,null,2))
const record=(id,detail={})=>{evidence.cases.push({id,status:'PASS',...detail});save();console.log(`PASS ${id}`)}
const stage=value=>{evidence.stage=value;save()}
const milestone=value=>{(evidence.minimumMilestones??=[]).push(value);save()}
// Public synthetic password is opt-in and valid only for this isolated GUI fixture.
const adminPassword=liveForBrowser?'mock-only-hub-admin-browser-pass-20261104':randomBytes(24).toString('base64url'),origin=`http://127.0.0.1:${scopedCa?3195:3194}`
let adminCookie,csrf
let browserReadyPath,browserReady
const ownerEnv=process.env.DSBOT_COMMUNICATION_OWNER_PID
process.env.DSBOT_COMMUNICATION_OWNER_PID=String(process.pid)
const bench=topology.bench.bind(topology)
topology.bench=(peer,action,extra={})=>bench(peer,action,{DSBOT_COMMUNICATION_OWNER_PID:String(process.pid),...(process.argv.includes('--play')?{DSBOT_COMMUNICATION_TEST_LIFETIME_MS:String(3.5*60*60*1000)}:{}),DSBOT_COMMUNICATION_ONBOARDING_FIXTURE:'1',DSBOT_COMMUNICATION_CONFIG:'',DSBOT_COMMUNICATION_CREDENTIAL:'',...extra})
const freePort=port=>new Promise((resolve,reject)=>{const server=createServer();server.once('error',()=>reject(new Error(`Required isolated port ${port} occupied`)));server.listen(port,'127.0.0.1',()=>server.close(resolve))})
const deadline=setTimeout(()=>{console.error('Acceptance deadline exceeded');void topology.close().finally(()=>process.exit(1))},12*60*1000)
async function api(peer,endpoint,input={}){
  const response=await fetch(`http://127.0.0.1:${peer.web}/api/communication`,{method:'POST',headers:{'content-type':'application/json',cookie:peer.cookie},body:JSON.stringify({endpoint,...input}),signal:AbortSignal.timeout(60000)})
  const result=await response.json()
  if(!result.ok){evidence.lastApiError={endpoint,code:result.error?.code??'INVALID_LOCAL_RESPONSE'};save();throw Object.assign(new Error(result.error?.code??'INVALID_LOCAL_RESPONSE'),{code:result.error?.code})}
  return result.value
}
async function cli(peer,operation,input){
  const result=await new Promise((resolveResult,reject)=>{
    const child=spawn(process.execPath,[join(import.meta.dirname,'../../bin/dsbot-remote.mjs'),operation,'--json'],{windowsHide:true,stdio:['pipe','pipe','pipe'],env:{...process.env,DSBOT_REMOTE_URL:`http://127.0.0.1:${peer.web}/`,DSBOT_REMOTE_COOKIE:peer.cookie}})
    let stdout='',stderr='';const timer=setTimeout(()=>{child.kill();reject(new Error(`CLI ${operation} timeout`))},25000)
    child.stdout.on('data',data=>stdout+=data);child.stderr.on('data',data=>stderr+=data);child.once('error',reject)
    child.once('exit',code=>{clearTimeout(timer);try{resolveResult({code,body:JSON.parse((code===0?stdout:stderr).trim())})}catch{reject(new Error(`CLI ${operation} invalid response`))}})
    child.stdin.end(JSON.stringify(input))
  })
  assert.equal(result.code,0,`CLI ${operation}: ${result.body.error?.code}`)
  assert.equal(result.body.ok,true)
  evidence.cliOperations??=[]
  evidence.cliOperations.push(operation)
  return result.body.value
}
async function reconnectClient(peer){
  peer.client=await benchClient(peer.name,peer.web)
  const log=readFileSync(join(peer.home,'web.log'),'utf8'),url=log.match(new RegExp(`http://127\\.0\\.0\\.1:${peer.web}/\\?token=[^\\s]+`))?.[0]
  assert.ok(url,'owned profile login URL exists')
  const response=await fetch(url,{redirect:'manual',signal:AbortSignal.timeout(15000)})
  peer.cookie=response.headers.getSetCookie().map(value=>value.split(';')[0]).join('; ')
  assert.ok(peer.cookie)
  peer.api=({endpoint,...input})=>api(peer,endpoint,input)
  await until(async()=>!(await peer.client.request('/api/bot',{endpoint:'state'})).readOnly,'owned fresh team writer lease',75000)
}
async function admin(path,input={}){
  const response=await fetch(origin+path,{method:'POST',headers:{'content-type':'application/json',origin,...(adminCookie?{cookie:adminCookie,'x-csrf-token':csrf}:{})},body:JSON.stringify(input),signal:AbortSignal.timeout(15000)})
  const result=await response.json()
  assert.equal(result.ok,true,`admin: ${result.error?.code??'invalid response'}`)
  if(path.endsWith('/login')){adminCookie=response.headers.getSetCookie().map(item=>item.split(';')[0]).join('; ');csrf=result.csrf;assert.ok(adminCookie&&csrf);return}
  return result.value
}
async function connected(peer){
  let lastCode
  const value=await until(async()=>{
    try{const state=await api(peer,'state');lastCode=state.error;if(state.connected&&state.reconciled)return state}
    catch(error){lastCode=error.message}
    return false
  },`signed enrollment connection (${peer.id})`,30000).catch(()=>{throw new Error(`signed enrollment connection ${peer.id}: ${lastCode??'not connected'}`)})
  peer.instanceId=value.instanceId;peer.human=value.humanPrincipalId
  if(value.localBots.length===1)peer.bot=value.localBots[0].principalId
  return value
}
async function minimum(){
  for(const port of [3185,3186,8885,8886,3194,...(scopedCa?[3195]:[])])await freePort(port)
  for(const peer of topology.peers){peer.home=join(repo,`.dsh-test-${peer.name}`);assert.equal(existsSync(peer.home),false,'fresh unconfigured profile only')}
  const child=fork(import.meta.filename,['--owned-hub',join(topology.root,`${topology.prefix}-hub.sqlite`),...(scopedCa?['--scoped-ca']:[])],{windowsHide:true,stdio:['ignore','ignore','ignore','ipc'],env:{...process.env,DSBOT_TEST_ADMIN_PASSWORD:adminPassword}})
  topology.child=child
  await new Promise((resolveReady,reject)=>{const timer=setTimeout(()=>reject(new Error('Owned management Hub startup timeout')),15000);child.once('message',message=>{clearTimeout(timer);assert.equal(message.type,'ready');resolveReady()});child.once('exit',()=>{clearTimeout(timer);reject(new Error('Owned management Hub exited'))})})
  const info=await (await fetch(origin+'/hub-info',{signal:AbortSignal.timeout(10000)})).json()
  assert.ok(info.hubId&&info.code)
  await admin('/admin/api/login',{password:adminPassword})
  for(const peer of topology.peers){
    stage(`${peer.id}: fresh bench startup`)
    await topology.bench(peer,'start',{DSBOT_WEB_OPEN:'0'});await reconnectClient(peer)
    assert.equal(existsSync(join(peer.home,'bot/communication.sqlite')),false,'no legacy queue before SDK enrollment')
    peer.botId=(await peer.client.request('/api/bot',{endpoint:'state'})).mainBotId
    await peer.client.request('/api/bot',{endpoint:'update-bot',payload:{id:peer.botId,model:'deepseek-official/deepseek-v4-pro'}})
    const feature=await api(peer,'remote-hub-settings');assert.equal(feature.enabled,false)
    await api(peer,'set-remote-hub-enabled',{enabled:true,expectedVersion:feature.version})
    await until(async()=>{const state=await api(peer,'remote-hub-settings');return state.enabled&&!state.reloadRequired},'explicit remote Hub opt-in reload')
    stage(`${peer.id}: decode Hub code`)
    const decoded=await api(peer,'decode-hub-code',{hubCode:info.code})
    assert.equal(decoded.hubId,info.hubId)
    stage(`${peer.id}: SDK join submission`)
    if(scopedCa){assert.equal(decoded.version,2);assert.ok(decoded.trustFingerprint)}
    const pending=await api(peer,'join-hub',{hubCode:info.code,confirmedHubId:decoded.hubId,confirmedUrl:decoded.url,...(decoded.trustFingerprint?{confirmedTrustFingerprint:decoded.trustFingerprint}:{}),displayName:`Enrolled ${peer.id.toUpperCase()} ${nonce}`})
    assert.equal(pending.status,'pending');peer.requestId=pending.requestId
    const pendingStorage=await api(peer,'onboarding-storage',{hubId:info.hubId})
    assert.equal(pendingStorage.configured,true);assert.equal(pendingStorage.storage.kind,'dsh-credential-record')
    milestone(`${peer.id}: signed join submitted and real SDK record configured`)
    const state=await admin('/admin/api/state'),request=state.requests.find(request=>request.requestId===pending.requestId)
    assert.equal(request.status,'pending')
    stage(`${peer.id}: admin HTTP approval`)
    await admin('/admin/api/decide',{requestId:request.requestId,expectedVersion:request.version,action:'approve'})
    milestone(`${peer.id}: administrator HTTP cookie plus CSRF approved request`)
    stage(`${peer.id}: SDK approval status and configEditor reload`)
    const approved=await api(peer,'hub-join-status',{hubId:info.hubId})
    assert.equal(approved.status,'approved')
    const storage=await api(peer,'onboarding-storage',{hubId:info.hubId})
    assert.equal(storage.configured,true);assert.equal(storage.storage.kind,'dsh-credential-record')
    stage(`${peer.id}: signed connection`)
    await connected(peer)
    assert.equal(peer.human,`human:${approved.instanceId}:local-user`)
    for(const name of ['cordis.yml','cordis.patch.yml']){
      const config=readFileSync(join(peer.home,'profiles/communication-test',name),'utf8')
      assert.ok(!/-----BEGIN (?:PRIVATE|ENCRYPTED PRIVATE) KEY-----|\bprivateKey\s*:/.test(config),'public profile configuration contains no signing private key')
    }
    milestone(`${peer.id}: SDK-configured signed connection reconciled; public config has no private key`)
  }
  assert.notEqual(topology.peers[0].instanceId,topology.peers[1].instanceId)
  record('fresh-unconfigured-DSH-SDK-join-admin-cookie-CSRF-approval-configEditor-reload-signed-connect')
}
const stats=()=>topology.hub('stats')
const body=message=>JSON.parse(message.body)
const image='data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX1sAAAAASUVORK5CYII='
async function denied(work,codes){try{await work();assert.fail('Operation unexpectedly allowed')}catch(error){assert.ok(codes.includes(error.code??error.message),`Expected ${codes.join('/')} but got ${error.code??error.message}`)}}
async function grant(peer,id,inputId,text){
  const message=await until(async()=> (await stats()).messages.find(message=>message.conversation_id===id&&message.author_id===peer.bot&&body(message).content.text===text),'canonical Bot reply',60000)
  const inspected=await peer.client.api({operation:'production-state',conversationId:id})
  const inputs=inspected.sessions.flatMap(session=>session.events).filter(event=>event.type==='user/message'&&event.data.source?.kind==='ds-bot-communication'&&event.data.source.messageId===inputId)
  assert.equal(inputs.length,1,'one actual DSH input, not only stored transport delivery')
  assert.equal(body(message).responseToDeliveryId,inputs[0].data.source.deliveryId)
  const value=await stats(),delivery=value.deliveries.find(delivery=>delivery.id===body(message).responseToDeliveryId)
  assert.ok(delivery.ai);assert.equal(delivery.recipient_id,peer.bot)
  assert.equal(value.responses.filter(response=>response.delivery_id===delivery.id&&response.message_id===message.id).length,1)
  return message
}
async function consent(){
  const [a,b]=topology.peers,user=await api(b,'user-code')
  const operationId=randomUUID(),request=await api(a,'request-contact',{userCode:user.userCode,localBotIds:[a.botId],operationId})
  const incoming=await until(async()=> (await api(b,'contact-requests')).find(item=>item.requestId===request.requestId&&item.direction==='incoming'),'explicit consent request visible')
  await api(b,'accept-contact',{requestId:incoming.requestId,expectedVersion:incoming.version,localBotIds:[b.botId],operationId:randomUUID()})
  await until(async()=> (await api(a,'state')).contacts.some(contact=>contact.principalId===b.bot)&&(await api(b,'state')).contacts.some(contact=>contact.principalId===a.bot),'mutual exact scoped directory')
  return (await api(a,'contact-relations')).find(relation=>relation.otherHumanPrincipalId===b.human&&relation.active)
}
async function full(){
  const [a,b]=topology.peers
  stage('publish local Chiefs via configuration editor')
  for(const peer of topology.peers){
    const available=await api(peer,'available-bots'),selected=available.bots.find(bot=>bot.id===peer.botId);assert.ok(selected)
    await api(peer,'publish-bots',{localBotIds:[peer.botId]})
    const published=await until(async()=>{const state=await connected(peer);return state.localBots.length===1&&state},'selected local Bot published')
    assert.equal(published.localBots[0].displayName,selected.name)
    peer.bot=published.localBots[0].principalId
    assert.ok(peer.bot.startsWith(`bot:${peer.instanceId}:`),'opaque global Bot identity belongs to enrolled instance')
    const configured=await api(peer,'available-bots');assert.deepEqual(configured.publishedBotIds,[peer.botId])
  }
  assert.ok(!(await api(a,'state')).contacts.some(contact=>contact.principalId===b.human))
  stage('Human avatar/profile and pre-consent avatar denial')
  const portrait=await cli(a,'profile-human',{operationId:randomUUID(),displayName:`Portrait A ${nonce}`,avatar:{image}})
  assert.ok(portrait.avatar.imageRevision)
  await denied(()=>api(b,'avatar',{principalId:a.human,revision:portrait.avatar.imageRevision}),['FORBIDDEN'])
  await denied(()=>api(a,'profile-human',{operationId:randomUUID(),displayName:'forged',principalId:b.human}),['AUTHOR_MISMATCH'])
  stage('explicit scoped contact request and acceptance')
  const relation=await consent();assert.ok(relation)
  assert.equal((await cli(b,'avatar',{principalId:a.human,revision:portrait.avatar.imageRevision})).image,image)
  record('publish-selected-Bots-explicit-contact-scopes-mutual-directory-and-avatar-consent-denial')

  stage('real signed peer DM and group mention/reply execution')
  const dm=(await topology.operation(a,'dm',{otherPrincipalId:b.bot})).conversationId
  const sent=await topology.send(a,dm,`COMM-ECHO signed-dm-${nonce}`)
  const dmReply=await grant(b,dm,sent.messageId,`Communication reply signed-dm-${nonce}`)
  const group=await topology.group(`Enrolled group ${nonce}`,[a.bot,b.human,b.bot],{allowSpeaking:false})
  const input=await topology.send(a,group,`COMM-ECHO signed-group-${nonce}`,[b.bot])
  const reply=await grant(b,group,input.messageId,`Communication reply signed-group-${nonce}`)
  const implicit=await topology.send(a,group,`COMM-ECHO signed-reply-${nonce}`,[],{replyToMessageId:reply.id})
  await grant(b,group,implicit.messageId,`Communication reply signed-reply-${nonce}`)
  record('signed-enrolled-DM-group-mention-and-no-mention-reply-have-actual-DSH-sources-and-grants',{dmConversationId:dm,groupConversationId:group,dmReplyId:dmReply.id})

  stage('contact revoke fences queued old DM epoch but retains group authority')
  await topology.hub('deny',{principalId:a.human,conversationId:dm})
  milestone('temporary DM publication fault armed')
  const stale=await topology.send(a,dm,`COMM-ECHO must-not-publish-${nonce}`)
  await until(async()=> (await api(a,'state')).outbox.find(item=>item.id===stale.messageId)?.state==='pending','old DM message durably queued')
  milestone('old DM message durably queued under temporary fault')
  await api(a,'revoke-contact',{otherHumanPrincipalId:b.human,expectedVersion:relation.version,operationId:randomUUID()})
  milestone('contact revoke accepted through public API')
  await until(async()=> !(await api(a,'state')).contacts.some(contact=>contact.principalId===b.human),'contact revoked directory hidden')
  const unaffected=await topology.send(a,group,`COMM-ECHO group-while-revoked-${nonce}`,[b.bot])
  await grant(b,group,unaffected.messageId,`Communication reply group-while-revoked-${nonce}`)
  // Clear the temporary publication fault only after re-consent rotates DM epochs.
  await consent()
  await topology.hub('clear')
  const rejected=await until(async()=>{const entry=(await api(a,'state')).outbox.find(item=>item.id===stale.messageId);return ['MEMBERSHIP_REVOKED','CONTACT_REQUIRED','NOT_A_MEMBER'].includes(entry?.error)&&entry},'old consent-epoch queued DM rejected')
  assert.ok(!(await stats()).messages.some(message=>message.id===stale.messageId))
  const ongoing=await topology.send(a,group,`COMM-ECHO group-after-consent-${nonce}`,[b.bot])
  await grant(b,group,ongoing.messageId,`Communication reply group-after-consent-${nonce}`)
  const freshDm=(await topology.operation(a,'dm',{otherPrincipalId:b.bot})).conversationId
  const freshInput=await topology.send(a,freshDm,`COMM-ECHO fresh-consent-${nonce}`)
  await grant(b,freshDm,freshInput.messageId,`Communication reply fresh-consent-${nonce}`)
  record('revoke-reconsent-rejects-old-offline-DM-outbox-and-group-remains-authorized',{rejectedMessageId:stale.messageId,rejectionCode:rejected.error})

  stage('Human profile reset and local Bot appearance synchronizes to remote group')
  const resetName=`Reset A ${nonce}`
  const reset=await cli(a,'profile-human',{operationId:randomUUID(),displayName:resetName,avatar:null})
  assert.equal(reset.avatar.imageRevision,null)
  assert.equal(reset.displayName,resetName)
  await peerLook(a,{name:`LookA${nonce}`,color:'rose',avatar:{shape:'fox',image}})
  const look=await until(async()=>{const member=(await api(b,'members',{conversationId:group})).members.find(member=>member.principalId===a.bot);return member?.displayName===`LookA${nonce}`&&member.avatar?.shape==='fox'&&member.avatar?.color==='rose'&&member.avatar?.imageRevision&&member},'remote canonical member appearance')
  assert.equal((await api(b,'avatar',{principalId:a.bot,revision:look.avatar.imageRevision})).image,image)
  const readOnly=await api(b,'members',{conversationId:group})
  assert.equal(readOnly.members.find(member=>member.principalId===b.human).speakingMode,'readOnly')
  await denied(()=>topology.operation(b,'save-settings',{conversationId:group,expectedVersion:readOnly.membershipVersion,title:'must not change'}),['FORBIDDEN'])
  record('Human-image-reset-rename-Bot-local-look-sync-and-readOnly-member-info-with-write-denial')

  stage('unpublish selected local Bot is genuinely hidden')
  await api(a,'publish-bots',{localBotIds:[]})
  await until(async()=> !(await api(a,'state')).localBots.some(bot=>bot.principalId===a.bot)&&!(await api(b,'state')).contacts.some(contact=>contact.principalId===a.bot),'unpublished Bot absent from local publication and remote directory')
  const member=(await api(b,'members',{conversationId:group})).members.find(member=>member.principalId===a.bot)
  assert.ok(member,'unpublication preserves historical/member identity')
  assert.equal(member.published,false,'member explicitly unpublished')
  const remaining=await topology.send(a,group,`COMM-ECHO after-unpublish-${nonce} @all`)
  await grant(b,group,remaining.messageId,`> Communication reply after-unpublish-${nonce} @all`)
  assert.deepEqual((await stats()).deliveries.filter(delivery=>delivery.message_id===remaining.messageId&&delivery.ai).map(delivery=>delivery.recipient_id),[b.bot])
  record('unpublish-really-hides-directory-Bot-without-replacing-member-identity-or-all-routing',{remainingBotMessageId:remaining.messageId})
}
async function remoteSwitch(){
  const [a,b]=topology.peers
  for(const peer of topology.peers){await api(peer,'publish-bots',{localBotIds:[peer.botId]});await until(async()=>(await connected(peer)).localBots.length===1,'signed Bot publication')}
  await consent()
  await api(a,'disconnect-hub',{hubId:(await api(a,'state')).hubId})
  await until(async()=>!(await api(a,'state')).enabled,'signed enrollment is paused')
  let feature=await api(a,'remote-hub-settings')
  await api(a,'set-remote-hub-enabled',{enabled:false,expectedVersion:feature.version,confirmHideAllBots:true})
  await until(async()=>{const state=await api(a,'remote-hub-settings');return !state.enabled&&!state.withdrawalPending},'paused signed enrollment withdraws through scoped CA')
  await until(async()=>!(await api(b,'state')).contacts.some(contact=>contact.principalId===a.bot),'signed withdrawal removes remote directory Bot')
  await topology.bench(a,'stop');await topology.bench(a,'start');await reconnectClient(a)
  await until(async()=>!(await api(a,'remote-hub-settings')).withdrawalPending,'completion journal reload without normal connection')
  feature=await api(a,'remote-hub-settings');assert.equal(feature.enabled,false)
  await api(a,'set-remote-hub-enabled',{enabled:true,expectedVersion:feature.version})
  await until(async()=>!(await api(a,'remote-hub-settings')).reloadRequired,'re-enable reload')
  const info=await(await fetch(origin+'/hub-info')).json()
  await api(a,'resume-hub',{hubId:info.hubId,confirmedUrl:(await api(a,'decode-hub-code',{hubCode:info.code})).url,confirmResume:true})
  assert.equal((await connected(a)).localBots.length,0,'resume cannot restore withdrawn publications')
  record('remote-switch-paused-signed-SDK-enrollment-scoped-CA-withdrawal-restart-and-empty-publication-resume')
}
async function peerLook(peer,payload){return peer.client.request('/api/bot',{endpoint:'update-bot',payload:{id:peer.botId,...payload}})}
async function holdForBrowser(){
  clearTimeout(deadline)
  // Restart exercises saved SDK-scoped trust with no CA environment variable.
  for(const peer of topology.peers){
    await topology.bench(peer,'stop');await topology.bench(peer,'start',{DSBOT_WEB_OPEN:'1'});await reconnectClient(peer);await connected(peer)
  }
  record('native-process-restart-reloads-saved-Hub-scoped-CA')
  if(scopedCa){
    const info=await(await fetch(origin+'/hub-info')).json(),peer=topology.peers[0],decoded=await api(peer,'decode-hub-code',{hubCode:info.code})
    const updated=await cli(peer,'update-hub-trust',{hubCode:info.code,confirmedHubId:decoded.hubId,confirmedUrl:decoded.url,confirmedTrustFingerprint:decoded.trustFingerprint})
    assert.equal(updated.instanceId,peer.instanceId);await connected(peer)
    record('native-Human-CLI-explicit-trust-update-verifies-real-Hub-and-preserves-instance')
  }
  const reference=await topology.peers[0].client.request('/api/bot',{endpoint:'create-bot',payload:{name:'Reviewer',model:'deepseek-official/deepseek-v4-pro'}})
  const local=await topology.peers[0].client.request('/api/bot',{endpoint:'create-room',payload:{name:'Local layout reference',members:[topology.peers[0].botId,reference.id]}})
  evidence.localReferenceRoom=local.id
  const info=await (await fetch(origin+'/hub-info',{signal:AbortSignal.timeout(10000)})).json()
  const stopFile=join(topology.root,`${topology.prefix}-browser-stop`),expiresAt=Date.now()+(process.argv.includes('--play')?3*60*60*1000:30*60*1000)
  browserReadyPath=join(topology.root,`${topology.prefix}-browser-ready.json`)
  browserReady={status:'READY',expiresAt:new Date(expiresAt).toISOString(),profiles:topology.peers.map(peer=>({url:`http://127.0.0.1:${peer.web}/`,instanceId:peer.instanceId,humanPrincipalId:peer.human,...(peer.bot?{botPrincipalId:peer.bot}:{})})),hub:{origin,hubId:info.hubId,code:info.code},stopFile}
  writeFileSync(browserReadyPath,JSON.stringify(browserReady,null,2))
  evidence.browserReadyFile=browserReadyPath;save()
  console.log(`BROWSER_READY .dsh-test-tools/${topology.prefix}-browser-ready.json`)
  while(!existsSync(stopFile)&&Date.now()<expiresAt)await new Promise(resolvePause=>setTimeout(resolvePause,500))
}
try{
  await minimum()
  if(process.argv.includes('--remote-hub-switch'))await remoteSwitch()
  else if(!enrollOnly)await full()
  evidence.status='PASS'
  if(liveForBrowser)await holdForBrowser()
}catch(error){evidence.status='FAIL';evidence.error=error.message;console.error(error.message);process.exitCode=1}
finally{
  clearTimeout(deadline);await topology.close()
  try{for(const port of [3185,3186,8885,8886,3194])await freePort(port);evidence.cleanedUp=true}catch(error){evidence.status='FAIL';evidence.cleanupError=error.message;process.exitCode=1}
  if(!process.argv.includes('--keep-profiles')){
    for(const peer of topology.peers){if(!peer.home)continue;const target=resolve(peer.home);assert.equal(dirname(target),repo);assert.equal(target,join(repo,`.dsh-test-${peer.name}`));assert.ok(peer.name.startsWith(`hub-onboard-${nonce}`));rmSync(target,{recursive:true,force:true})}
    evidence.temporaryKeysDeleted=true
  }else evidence.temporaryKeysDeleted=false
  if(ownerEnv===undefined)delete process.env.DSBOT_COMMUNICATION_OWNER_PID;else process.env.DSBOT_COMMUNICATION_OWNER_PID=ownerEnv
  if(browserReadyPath)writeFileSync(browserReadyPath,JSON.stringify({...browserReady,status:'STOPPED'},null,2))
  save();console.log(`Evidence: .dsh-test-tools/${topology.prefix}-acceptance.json`)
}
