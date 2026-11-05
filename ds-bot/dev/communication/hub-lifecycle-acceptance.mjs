import assert from 'node:assert/strict'
import {randomUUID,randomBytes,createHash} from 'node:crypto'
import {existsSync,readFileSync,writeFileSync,rmSync} from 'node:fs'
import {join,resolve,dirname} from 'node:path'
import {createServer} from 'node:net'
import {createRequire} from 'node:module'
import {LocalTopology,until} from './local-topology.mjs'
import {benchClient,repo} from './bench-client.mjs'
import {caFixture} from '../../test/fixtures/hub-ca-fixture.mjs'
import {startHub} from '../../../communication-hub/src/server.js'
import {execute as adminExecute,prepare as adminPrepare} from '../../../communication-hub/src/admin-cli.js'
import {execute as cliExecute,prepare as cliPrepare} from '../../bin/dsbot-remote.mjs'

const nonce=randomUUID().slice(0,8),topology=new LocalTopology({prefix:`hub-onboard-${nonce}-lifecycle`,webPort:3225,mockPort:8895,hubPort:3227})
const fixture=caFixture(),profiles=[],output=join(topology.root,`${topology.prefix}-acceptance.json`)
const evidence={status:'RUNNING',network:'two independent real WSS Hubs and two DSH instances on loopback',model:'local Mock only',cases:[],uncovered:['physical cross-machine networking','production/unknown legacy queue adoption']}
const save=()=>writeFileSync(output,JSON.stringify(evidence,null,2)),stage=value=>{evidence.stage=value;save()},record=value=>{evidence.cases.push({id:value,status:'PASS'});save();console.log('PASS '+value)}
const bench=topology.bench.bind(topology)
topology.bench=(peer,action,extra={})=>bench(peer,action,{DSBOT_COMMUNICATION_OWNER_PID:String(process.pid),DSBOT_COMMUNICATION_ONBOARDING_FIXTURE:'1',DSBOT_COMMUNICATION_CONFIG:'',DSBOT_COMMUNICATION_CREDENTIAL:'',DSBOT_WEB_OPEN:'0',...extra})
const free=port=>new Promise((done,reject)=>{const s=createServer();s.once('error',reject);s.listen(port,'127.0.0.1',()=>s.close(done))})
const browser=process.argv.includes('--browser'),browserStop=join(topology.root,`${topology.prefix}-browser-stop`)
const deadline=setTimeout(()=>{console.error('Lifecycle acceptance deadline exceeded');process.exit(1)},(browser?20:8)*60*1000)
async function start(profile){profile.hub=await startHub({databasePath:profile.database,port:profile.port,tls:{cert:profile.leaf.cert,key:profile.leaf.key},peers:[],management:{enabled:true,password:profile.password,pairingCa:profile.root.pem,url:`wss://127.0.0.1:${profile.port}/communication`}})}
async function admin(profile,operation,input={}){return adminExecute(adminPrepare(operation,input),{url:`https://127.0.0.1:${profile.port}/admin/`,password:profile.password,caFile:profile.root.cert})}
async function api(peer,operation,input={}){try{const result=await cliExecute(cliPrepare(operation,input),{url:`http://127.0.0.1:${peer.web}/`,cookie:peer.cookie});return result.value}catch(error){error.testOperation=operation;throw error}}
async function connected(peer,hubId){return until(async()=>{try{const s=await api(peer,'state');return s.connected&&s.reconciled&&s.hubId===hubId&&s}catch{return false}},'selected scoped Hub connected',45000)}
async function enroll(peer,profile){
 const info=profile.hub.management.info(),decoded=await api(peer,'decode-hub-code',{hubCode:info.code})
 const pending=await api(peer,'join-hub',{hubCode:info.code,displayName:`Lifecycle ${peer.id.toUpperCase()}`,confirmedHubId:decoded.hubId,confirmedUrl:decoded.url,confirmedTrustFingerprint:decoded.trustFingerprint})
 assert.equal(pending.status,'pending')
 const request=(await admin(profile,'state')).requests.find(item=>item.requestId===pending.requestId);assert.ok(request)
 await admin(profile,'approve',{requestId:request.requestId,expectedVersion:request.version})
 await api(peer,'hub-join-status',{hubId:info.hubId})
 const state=await connected(peer,info.hubId)
 peer.instanceId=state.instanceId;peer.human=state.humanPrincipalId
 return state
}
async function publish(peer){await api(peer,'publish-bots',{localBotIds:[peer.botId]});const s=await until(async()=>{const v=await api(peer,'state');if(!v.connected||!v.reconciled||v.localBots?.length!==1)return false;try{await api(peer,'user-code');return v}catch(error){if(error.code==='COMMUNICATION_UNAVAILABLE')return false;throw error}},'explicit publication after plugin reactivation');peer.bot=s.localBots[0].principalId}
async function select(peer,profile,previous,fromSaved=false){
 const info=profile.hub?.management.info()??profile.info
 const reviewed=await api(peer,'decode-hub-code',{hubCode:info.code})
 return api(peer,'switch-hub',{...(fromSaved?{hubId:info.hubId}:{hubCode:info.code,displayName:'Lifecycle switched device'}),expectedCurrentHubId:previous,confirmedHubId:info.hubId,confirmedUrl:reviewed.url,confirmedTrustFingerprint:reviewed.trustFingerprint})
}
try{
 for(const port of [3225,3226,3227,3228,8895,8896])await free(port)
 for(const [index,name] of ['A','B'].entries()){
  const root=fixture.ca('hub-'+name),leaf=fixture.leaf('leaf-'+name,root),profile={root,leaf,password:randomBytes(24).toString('base64url'),port:3227+index,database:join(topology.root,`${topology.prefix}-hub-${name}.sqlite`)}
  profiles.push(profile);await start(profile);profile.info=profile.hub.management.info()
 }
 const [hubA,hubB]=profiles,[a,b]=topology.peers
 for(const peer of topology.peers){
  peer.home=join(repo,`.dsh-test-${peer.name}`);assert.equal(existsSync(peer.home),false)
  stage(peer.id+': fresh public SDK enrollment')
  await topology.bench(peer,'start');peer.client=await until(async()=>{try{return await benchClient(peer.name,peer.web)}catch{return false}},'fresh public SDK API ready',45000)
  const log=readFileSync(join(peer.home,'web.log'),'utf8'),login=log.match(new RegExp(`http://127\\.0\\.0\\.1:${peer.web}/\\?token=[^\\s]+`))?.[0];assert.ok(login)
  const response=await fetch(login,{redirect:'manual'});peer.cookie=response.headers.getSetCookie().map(value=>value.split(';')[0]).join('; ')
  peer.api=({endpoint,...input})=>api(peer,endpoint,input)
  peer.botId=(await until(async()=>{try{return (await peer.client.request('/api/bot',{endpoint:'state'})).mainBotId}catch{return false}},'fresh public Bot API ready',45000))
  await peer.client.request('/api/bot',{endpoint:'update-bot',payload:{id:peer.botId,name:peer.id==='a'?'阿尔法':'贝塔',model:'deepseek-official/deepseek-v4-pro'}})
  await enroll(peer,hubA);await publish(peer)
 }
 stage('retained A contact and group data')
 const code=await api(b,'user-code'),request=await api(a,'request-contact',{userCode:code.userCode,localBotIds:[a.botId],operationId:randomUUID()})
 const incoming=await until(async()=>(await api(b,'contact-requests')).find(item=>item.requestId===request.requestId),'contact consent request')
 await api(b,'accept-contact',{requestId:incoming.requestId,expectedVersion:incoming.version,localBotIds:[b.botId],operationId:randomUUID()})
 await until(async()=>(await api(a,'state')).contacts.some(item=>item.principalId===b.bot),'mutual contact directory')
 const group=await topology.group('Retained Hub A group',[a.bot,b.human,b.bot],{allowSpeaking:false})
 const initial=await topology.send(a,group,`COMM-ECHO before-switch-${nonce}`,[b.bot])
 await until(()=>topology.hasText(a,group,`Communication reply before-switch-${nonce}`),'actual Mock reply before switch',60000)
 const png=await createRequire(join(repo,'ds-bot/dev/harness/package.json'))('sharp')({create:{width:1,height:1,channels:4,background:{r:20,g:100,b:200,alpha:1}}}).png().toBuffer()
 const attachment=(bytes,name,mime)=>({name,mime,size:bytes.length,data:bytes.toString('base64'),sha256:createHash('sha256').update(bytes).digest('hex')})
 const attachments=[attachment(png,'synthetic-pixel.png','image/png'),attachment(Buffer.from('Synthetic file; no private content.'),'synthetic-note.txt','text/plain')]
 const media=await topology.send(a,group,`COMM-ECHO attachments-${nonce}`,[b.bot],{attachments})
 await until(()=>topology.hasText(a,group,`Communication reply attachments-${nonce}`),'actual Mock image and file reply',60000)
 const received=(await api(b,'history',{conversationId:group,limit:100})).events.find(event=>event.message?.messageId===media.messageId)
 assert.deepEqual(received.message.attachments,attachments)
 await assert.rejects(api(b,'send',{conversationId:group,text:'',attachments,messageId:randomUUID(),clientCreatedAt:new Date().toISOString()}),{code:'SPEAKING_FORBIDDEN'})
 record('image-and-file-bytes-arrive-through-real-WSS-DSH-AttachmentStore-and-Mock-with-readonly-denial')
 const initialIdentity={instanceId:a.instanceId,human:a.human,userCode:(await api(a,'user-code')).userCode}
 record('real-signed-enrollment-admin-CLI-TLS-approval-contact-consent-and-DSH-group-reply')
 stage('offline local pause fences retained outbox')
 await hubA.hub.close();hubA.hub=null
 const retained=await topology.send(a,group,`COMM-ECHO retained-only-A-${nonce}`,[b.bot])
 await until(async()=>(await api(a,'state')).outbox.some(item=>item.id===retained.messageId&&item.state==='pending'),'durable original queued message')
 await api(a,'disconnect-hub',{hubId:hubA.info.hubId})
 const paused=await api(a,'onboarding-storage',{hubId:hubA.info.hubId});assert.equal(paused.paused,true)
 record('offline-disconnect-retains-identity-history-and-original-pending-message')
 stage('select B, separate approval and namespace')
 const selected=await select(a,hubB,hubA.info.hubId);assert.equal(selected.paused,true)
 assert.equal((await admin(hubB,'state')).requests.length,0,'selection alone does not submit a join')
 await enroll(a,hubB)
 const fresh=await api(a,'state')
 assert.equal(fresh.localBots.length,0);assert.equal(fresh.conversations.length,0);assert.equal(fresh.outbox.length,0)
 assert.notEqual(fresh.queueScope,'legacy');assert.notEqual(fresh.instanceId,initialIdentity.instanceId)
 assert.notEqual((await api(a,'user-code')).userCode,initialIdentity.userCode)
 await assert.rejects(api(a,'history',{conversationId:group}),error=>['NOT_MEMBER','NOT_A_MEMBER','MEMBERSHIP_REVOKED','FORBIDDEN','MEMBERSHIP_EPOCH_REQUIRED'].includes(error.code))
 assert.equal(hubB.hub.store.db.prepare('SELECT count(*) n FROM messages').get().n,0)
 record('new-Hub-requires-approval-has-new-user-code-no-old-history-publication-or-outbox')
 stage('offline switch back, no automatic activation')
 await select(a,hubA,hubB.info.hubId,true)
 await assert.rejects(api(a,'resume-hub',{hubId:hubA.info.hubId,confirmedUrl:hubA.info.url,confirmResume:true}),error=>['HUB_CONNECTION_REFUSED','HUB_UNREACHABLE','HUB_CONNECTION_TIMEOUT'].includes(error.code))
 assert.equal((await api(a,'onboarding-storage',{hubId:hubA.info.hubId})).paused,true)
 await start(hubA)
 const originalRequestCount=(await admin(hubA,'state')).requests.length
 await api(a,'hub-join-status',{hubId:hubA.info.hubId})
 assert.equal((await api(a,'onboarding-storage',{hubId:hubA.info.hubId})).paused,true,'approval refresh cannot reconnect a paused queue')
 await api(a,'resume-hub',{hubId:hubA.info.hubId,confirmedUrl:hubA.info.url,confirmResume:true})
 const restored=await connected(a,hubA.info.hubId)
 assert.equal(restored.instanceId,initialIdentity.instanceId);assert.equal(restored.humanPrincipalId,initialIdentity.human)
 assert.equal((await api(a,'user-code')).userCode,initialIdentity.userCode)
 assert.ok(restored.localBots.some(item=>item.principalId===a.bot));assert.ok(restored.contacts.some(item=>item.principalId===b.bot))
 await until(()=>topology.hasText(a,group,`Communication reply retained-only-A-${nonce}`),'retained message resumes only on A',60000)
 assert.equal(hubA.hub.store.db.prepare('SELECT count(*) n FROM messages WHERE id=?').get(retained.messageId).n,1)
 assert.equal(hubA.hub.store.db.prepare('SELECT count(*) n FROM messages WHERE id=?').get(initial.messageId).n,1)
 assert.equal(hubB.hub.store.db.prepare('SELECT count(*) n FROM messages').get().n,0)
 assert.equal((await admin(hubA,'state')).requests.length,originalRequestCount,'no duplicate enrollment on return')
 record('A-B-A-restores-same-identity-code-contacts-groups-original-outbox-and-DSH-reply-once')
 if(browser){
  stage('browser review of isolated A/B attachment and lifecycle UI')
  writeFileSync(join(topology.root,`${topology.prefix}-browser-ready.json`),JSON.stringify({prefix:topology.prefix,urls:topology.peers.map(peer=>`http://127.0.0.1:${peer.web}/`),stopFile:browserStop}))
  console.log('BROWSER_READY '+topology.prefix)
  const end=Date.now()+12*60*1000
  while(!existsSync(browserStop)&&Date.now()<end)await new Promise(resolve=>setTimeout(resolve,500))
 }
 stage('revocation remains authoritative')
 await admin(hubA,'revoke',{instanceId:initialIdentity.instanceId})
 await until(async()=>{const state=await api(a,'state');return !state.connected&&['UNAUTHENTICATED','INSTANCE_REVOKED'].includes(state.error)},'live administrator revocation reaches the existing host')
 assert.equal((await api(b,'state')).connected,true)
 const disconnected=await api(a,'disconnect-hub',{hubId:hubA.info.hubId})
 assert.equal(disconnected.paused,true);assert.equal(disconnected.localOnly,true)
 await assert.rejects(api(a,'resume-hub',{hubId:hubA.info.hubId,confirmedUrl:hubA.info.url,confirmResume:true}),error=>['UNAUTHENTICATED','INSTANCE_REVOKED'].includes(error.code))
 assert.equal((await api(a,'onboarding-storage',{hubId:hubA.info.hubId})).paused,true)
 record('live-device-revocation-updates-host-local-disconnect-still-works-and-resume-stays-denied')
 const revoked=await api(a,'hub-leave-status',{hubId:hubA.info.hubId,confirmedUrl:hubA.info.url})
 assert.equal(revoked.left,true)
 assert.equal((await api(a,'onboarding-storage',{hubId:hubA.info.hubId})).departed,true)
 const reviewedRevoked=await api(a,'decode-hub-code',{hubCode:hubA.info.code})
 await assert.rejects(api(a,'join-hub',{hubCode:hubA.info.code,displayName:'Preserve original identity',confirmedHubId:hubA.info.hubId,confirmedUrl:hubA.info.url,confirmedTrustFingerprint:reviewedRevoked.trustFingerprint}),{code:'HUB_LEFT'})
 const removed=(await admin(hubA,'state')).instances.find(item=>item.instanceId===initialIdentity.instanceId)
 await admin(hubA,'repair',{instanceId:removed.instanceId,expectedRevision:removed.revision})
 const repaired=await api(a,'hub-leave-status',{hubId:hubA.info.hubId,confirmedUrl:hubA.info.url})
 assert.equal(repaired.left,false)
 const stillPaused=await api(a,'onboarding-storage',{hubId:hubA.info.hubId})
 assert.equal(stillPaused.departed,false);assert.equal(stillPaused.paused,true)
 await api(a,'resume-hub',{hubId:hubA.info.hubId,confirmedUrl:hubA.info.url,confirmResume:true})
 const final=await connected(a,hubA.info.hubId)
 assert.equal(final.instanceId,initialIdentity.instanceId);assert.equal(final.humanPrincipalId,initialIdentity.human)
 assert.equal(final.conversations.some(item=>item.conversationId===group),false,'explicit repair does not restore removed group memberships')
 record('signed-revoked-status-and-explicit-admin-repair-reuse-the-exact-key-without-restoring-memberships')
 evidence.status='PASS'
}catch(error){evidence.status='FAIL';evidence.error=error.code??error.message;evidence.operation=error.testOperation;if(error.code==='ERR_ASSERTION')evidence.assertion=String(error.message).slice(0,800);console.error(evidence.error);process.exitCode=1}
finally{
 if(evidence.status==='FAIL'){
  evidence.diagnostics={}
  for(const peer of topology.peers??[])try{const s=await api(peer,'state');evidence.diagnostics[peer.id]={connected:s.connected,reconciled:s.reconciled,error:s.error,errors:s.errors?.map(e=>e.code),outbox:s.outbox?.map(o=>({state:o.state,error:o.error}))}}catch{}
  if(profiles[0]?.hub)evidence.diagnostics.hubA=profiles[0].hub.store.db.prepare('SELECT ai,stored,ai_accepted,revoked,count(*) n FROM deliveries GROUP BY ai,stored,ai_accepted,revoked').all()
 }
 clearTimeout(deadline)
 await topology.close()
 for(const profile of profiles)await profile.hub?.close()
 fixture.close()
 for(const peer of topology.peers){if(!peer.home)continue;const target=resolve(peer.home);assert.equal(dirname(target),repo);assert.ok(peer.name.startsWith(`hub-onboard-${nonce}-lifecycle`));rmSync(target,{recursive:true,force:true})}
 evidence.cleanedUp=true;save();console.log(`Evidence .dsh-test-tools/${topology.prefix}-acceptance.json`)
}
