import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { LocalTopology, until } from './local-topology.mjs'
import { createRequire } from 'node:module'
import { benchClient, repo } from './bench-client.mjs'

const nonce = randomUUID().slice(0, 8)
const topology = new LocalTopology({ prefix: `hub-onboard-${nonce}-remote-hub-switch`, webPort: 3405, mockPort: 9105, hubPort: 3409 })
const evidence = { status: 'RUNNING', model: 'deterministic Mock', cases: [] }
const record = name => { evidence.cases.push(name); console.log('PASS', name) }
async function login(peer) {
  const log = readFileSync(join(peer.home, 'web.log'), 'utf8')
  const url = log.match(new RegExp(`http://127\\.0\\.0\\.1:${peer.web}/\\?token=[^\\s]+`))?.[0]
  assert.ok(url, 'Owned test profile has a login URL')
  const result = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(15000) })
  peer.cookie = result.headers.getSetCookie().map(value => value.split(';')[0]).join('; ')
}
async function cli(peer, command, input = {}) {
  return new Promise((resolve, reject) => {
    const environment = Object.fromEntries(Object.entries(process.env).filter(([key]) => ['PATH', 'HOME', 'USER', 'LANG', 'TMPDIR', 'TMP', 'TEMP', 'SystemRoot'].includes(key)))
    const child = spawn(process.execPath, [join(repo, 'ds-bot/bin/dsbot-remote.mjs'), command], {
      stdio: ['pipe', 'pipe', 'pipe'], env: { ...environment, DSBOT_REMOTE_URL: `http://127.0.0.1:${peer.web}`, DSBOT_REMOTE_COOKIE: peer.cookie },
    })
    let stdout = '', stderr = ''
    const timer = setTimeout(() => { child.kill(); reject(Error('CLI_TIMEOUT')) }, 60000)
    child.stdout.on('data', chunk => { stdout += chunk }); child.stderr.on('data', chunk => { stderr += chunk })
    child.once('error', error => { clearTimeout(timer); reject(error) })
    child.once('exit', code => {
      clearTimeout(timer)
      try { resolve({ code, body: JSON.parse((code === 0 ? stdout : stderr).trim().split('\n').findLast(line => line.startsWith('{'))) }) }
      catch { reject(Error('CLI_INVALID_JSON')) }
    })
    child.stdin.end(JSON.stringify(input))
  })
}

const previousOwner=process.env.DSBOT_COMMUNICATION_OWNER_PID
process.env.DSBOT_COMMUNICATION_OWNER_PID=String(process.pid)
const {parse,stringify}=createRequire(new URL('../harness/package.json',import.meta.url))('yaml')
const originalBench=topology.bench.bind(topology)
topology.bench=async(peer,action,extra={})=>{
 await originalBench(peer,action,{DSBOT_COMMUNICATION_OWNER_PID:String(process.pid),DSBOT_COMMUNICATION_ONBOARDING_FIXTURE:'1',DSBOT_COMMUNICATION_CONFIG:'',...extra})
 if(action==='start'&&!peer.configured&&!peer.freshChecked){
  peer.freshChecked=true
  const client=await benchClient(peer.name,peer.web),api=body=>client.request('/api/communication',body)
  const preview=await api({endpoint:'remote-hub-settings'})
  assert.equal(preview.enabled,false)
  assert.equal((await client.request('/api/bot',{endpoint:'state'})).remoteHubEnabled,false)
  await assert.rejects(api({endpoint:'send',conversationId:'not-joined',text:'must not send'}),{code:'REMOTE_HUB_DISABLED'})
  if(peer.id==='a'){
   await api({endpoint:'set-remote-hub-enabled',enabled:true,expectedVersion:preview.version})
   await until(async()=>(await api({endpoint:'remote-hub-settings'})).enabled,'explicit fresh opt-in')
  }
 }
}
topology.startPeer=async peer=>{
 if(!peer.configured){
  const path=join(peer.home,'profiles/communication-test/cordis.patch.yml'),entries=parse(readFileSync(path,'utf8'))
  const entry=entries.find(item=>item.id==='bot');assert.ok(entry)
  entry.config={...entry.config,communication:{enabled:true,url:topology.url,instanceId:peer.instanceId,publishedBotIds:[peer.botId],humanDisplayName:`Person ${peer.id.toUpperCase()}`,pollMs:150}}
  writeFileSync(path,stringify(entries));peer.configured=true
 }
 await topology.bench(peer,'start',{DSBOT_COMMUNICATION_CREDENTIAL:peer.credential})
 peer.client=await benchClient(peer.name,peer.web);peer.api=body=>peer.client.request('/api/communication',body)
 await until(async()=>{
  const feature=await peer.api({endpoint:'remote-hub-settings'})
  if(!feature.enabled)return true
  const state=await peer.api({endpoint:'state'});return state.connected&&state.reconciled&&!state.reloadRequired
 },'configured Host ready or deliberately disabled',60000)
}
async function successful(peer,operation,input={}){const result=await cli(peer,operation,input);assert.equal(result.code,0,result.body.error?.code);return result.body.value}
const feature=peer=>peer.api({endpoint:'remote-hub-settings'})
const settled=peer=>until(async()=>{const state=await peer.api({endpoint:'state'});return state.connected&&state.reconciled&&!state.reloadRequired&&state},'normal communication reconciled',60000)
async function toggle(peer,enabled){return successful(peer,'set-remote-hub-enabled',{enabled,expectedVersion:(await feature(peer)).version,...(!enabled?{confirmHideAllBots:true}:{})})}
async function membership(peer,group){return until(async()=>{const row=(await peer.api({endpoint:'state'})).conversations.find(item=>item.conversationId===group);return row?.info?.membershipVersion===row?.membershipVersion&&row},'current group roster')}
try{
 await topology.initialize();const[a,b]=topology.peers;await Promise.all(topology.peers.map(login))
 assert.equal((await feature(a)).enabled,true)
 assert.equal((await feature(b)).enabled,true);assert.equal((await feature(b)).inferredFromExistingHub,true)
 record('fresh-install-default-off-explicit-opt-in-and-existing-Hub-migration-on')
 const group=await topology.group(`Switch ${nonce}`,[a.bot,b.human,b.bot])
 const dm=(await successful(b,'dm',{otherPrincipalId:a.bot})).conversationId
 await successful(b,'send',{conversationId:dm,text:`COMM-ECHO initial-${nonce}`})
 await until(()=>topology.hasText(b,dm,`Communication reply initial-${nonce}`),'initial actual remote Bot reply',60000)
 const denied=await cli(a,'set-remote-hub-enabled',{enabled:false,expectedVersion:(await feature(a)).version})
 assert.equal(denied.body.error.code,'REMOTE_HUB_DISABLE_CONFIRMATION_REQUIRED')
 assert.equal((await feature(a)).enabled,true)
 record('server-refuses-disable-without-confirmation-and-preserves-publication')
 await toggle(a,false)
 let lastWithdrawal
 await until(async()=>{const value=await feature(a);const safe={enabled:value.enabled,pending:value.withdrawalPending,error:value.withdrawalError,reload:value.reloadRequired};if(JSON.stringify(safe)!==lastWithdrawal){lastWithdrawal=JSON.stringify(safe);console.log('withdrawal-state',lastWithdrawal);evidence.withdrawalStates??=[];evidence.withdrawalStates.push(safe)}return !value.enabled&&!value.withdrawalPending},'online withdrawal acknowledged and saved',60000)
 await until(async()=>!(await b.api({endpoint:'state'})).contacts.some(person=>person.principalId===a.bot),'remote Bot disappears')
 await until(async()=>(await membership(b,group)).info.formerMembers?.some(person=>person.principalId===a.bot&&person.retired),'group marks old Bot retired')
 for(const endpoint of ['send','publish-bots','user-code'])await assert.rejects(a.api({endpoint,conversationId:group,text:'blocked',localBotIds:[a.botId]}),{code:'REMOTE_HUB_DISABLED'})
 await a.client.request('/api/bot',{endpoint:'update-bot',payload:{id:a.botId,role:'Local work remains available'}})
 assert.ok((await a.client.request('/api/bot',{endpoint:'state'})).bots.some(bot=>bot.id===a.botId))
 record('online-off-hides-all-Bots-retires-group-membership-and-keeps-local-team-usable')
 const epoch=(await topology.hub('stats')).instances.find(item=>item.id===a.instanceId).epoch
 await topology.bench(a,'stop');await topology.startPeer(a);await login(a)
 assert.equal((await feature(a)).enabled,false);assert.equal((await a.client.request('/api/bot',{endpoint:'state'})).remoteHubEnabled,false)
 assert.equal((await topology.hub('stats')).instances.find(item=>item.id===a.instanceId).epoch,epoch)
 record('explicit-off-survives-restart-without-reconnecting-or-restoring-the-entry')
 await toggle(a,true);let state=await settled(a)
 assert.equal(state.localBots.length,0)
 assert.equal((await b.api({endpoint:'state'})).contacts.some(person=>person.principalId===a.bot),false)
 await successful(a,'publish-bots',{localBotIds:[a.botId]});state=await settled(a)
 const fresh=await until(async()=>(await a.api({endpoint:'state'})).localBots[0]?.principalId,'explicit re-publication')
 assert.notEqual(fresh,a.bot)
 assert.equal((await membership(a,group)).info.members.some(person=>person.principalId===fresh),false)
 await successful(a,'invite',{conversationId:group,inviteePrincipalId:fresh})
 let row=await membership(a,group)
 await topology.operation(a,'policy',{conversationId:group,membershipEpoch:row.membershipEpoch,expectedVersion:row.membershipVersion,targetPrincipalId:fresh,speakingMode:'active'})
 await successful(b,'send',{conversationId:group,text:`COMM-ECHO fresh-${nonce}`,mentions:[fresh]})
 await until(()=>topology.hasText(b,group,`Communication reply fresh-${nonce}`),'new identity responds after explicit group join',60000)
 record('re-enable-publishes-no-Bots-and-explicit-publication-creates-new-identity-without-old-membership')
 await topology.stopHub()
 await toggle(a,false)
 await until(async()=>{const value=await feature(a);return !value.enabled&&value.withdrawalPending},'offline withdrawal is explicitly pending')
 await topology.bench(a,'stop');await topology.startPeer(a);await login(a)
 assert.equal((await feature(a)).withdrawalPending,true);assert.equal((await feature(a)).enabled,false)
 await topology.startHub()
 await until(async()=>!(await feature(a)).withdrawalPending,'offline withdrawal completes after Host and Hub restart',60000)
 await until(async()=>!(await b.api({endpoint:'state'})).contacts.some(person=>person.principalId===fresh),'offline published identity becomes hidden')
 assert.equal((await feature(a)).enabled,false)
 record('offline-disable-persists-through-Host-restart-and-withdraws-after-Hub-recovery-without-enabling')
 evidence.status='PASSED'
}catch(error){evidence.status='FAILED';evidence.error=error.code??error.message;throw error}
finally{await topology.close();if(previousOwner===undefined)delete process.env.DSBOT_COMMUNICATION_OWNER_PID;else process.env.DSBOT_COMMUNICATION_OWNER_PID=previousOwner;writeFileSync(join(topology.root,`${topology.prefix}-evidence.json`),JSON.stringify(evidence,null,2))}
