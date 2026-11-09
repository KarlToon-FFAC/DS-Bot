import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { LocalTopology, until } from './local-topology.mjs'
import { createRequire } from 'node:module'
import { benchClient, repo } from './bench-client.mjs'

const nonce = randomUUID().slice(0, 8)
const topology = new LocalTopology({ prefix: `hub-onboard-${nonce}-field-f4-f6`, webPort: 3385, mockPort: 9085, hubPort: 3389 })
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
const bench=topology.bench.bind(topology)
topology.bench=(peer,action,extra={})=>bench(peer,action,{DSBOT_COMMUNICATION_OWNER_PID:String(process.pid),DSBOT_COMMUNICATION_ONBOARDING_FIXTURE:'1',DSBOT_COMMUNICATION_CONFIG:'',...extra})
topology.startPeer=async peer=>{
 if(!peer.configured){
  const path=join(peer.home,'profiles/communication-test/cordis.patch.yml'),entries=parse(existsSync(path)?readFileSync(path,'utf8'):'')??[]
  const entry=entries.find(item=>item.id==='bot');assert.ok(entry)
  entry.config={...entry.config,communication:{enabled:true,url:topology.url,instanceId:peer.instanceId,publishedBotIds:[peer.botId],humanDisplayName:`Person ${peer.id.toUpperCase()}`,pollMs:150}}
  writeFileSync(path,stringify(entries));peer.configured=true
 }
 await topology.bench(peer,'start',{DSBOT_COMMUNICATION_CREDENTIAL:peer.credential})
 peer.client=await benchClient(peer.name,peer.web);peer.api=body=>peer.client.request('/api/communication',body)
 await until(async()=>{const state=await peer.api({endpoint:'state'});return state.connected&&state.reconciled&&!state.reloadRequired},'native configuration loaded and reconciled',60000)
}
async function current(peer,conversationId){return until(async()=>{const row=(await peer.api({endpoint:'state'})).conversations.find(item=>item.conversationId===conversationId);return row?.info?.membershipVersion===row?.membershipVersion&&row},'current conversation projection')}
async function published(peer){return until(async()=>{const state=await peer.api({endpoint:'state'});return state.connected&&state.reconciled&&!state.reloadRequired&&state},'publication reload takes effect',60000)}
async function successful(peer,operation,input){const result=await cli(peer,operation,input);assert.equal(result.code,0,result.body.error?.code);return result.body.value}
try{
 await topology.initialize();const [a,b]=topology.peers;await Promise.all(topology.peers.map(login))
 const request=await topology.operation(a,'request-contact',{userCode:(await b.api({endpoint:'user-code'})).userCode})
 const incoming=await until(async()=>(await b.api({endpoint:'contact-requests'})).find(row=>row.requestId===request.requestId),'contact request')
 await topology.operation(b,'accept-contact',{requestId:incoming.requestId,expectedVersion:incoming.version,localBotIds:[b.botId]})
 const {conversationId:dm}=await successful(a,'dm',{otherPrincipalId:b.bot})
 await topology.send(a,dm,`COMM-ECHO publication-${nonce}`)
 await until(()=>topology.hasText(a,dm,`Communication reply publication-${nonce}`),'initial Bot reply',60000)
 const groupBot=await b.client.request('/api/bot',{endpoint:'create-bot',payload:{name:'GroupOnly',model:'deepseek-official/deepseek-v4-pro'}})
 const outsideBot=await b.client.request('/api/bot',{endpoint:'create-bot',payload:{name:'OutsideGroup',model:'deepseek-official/deepseek-v4-pro'}})
 const publication=await successful(b,'publish-bots',{localBotIds:[b.botId,groupBot.id,outsideBot.id]})
 assert.equal(publication.reloadReason,'publication');assert.equal(publication.publicationStatus,'saved-pending-reload');assert.equal(publication.reloadRequired,true)
 record('real-CLI-publication-save-has-explicit-pending-publication-receipt')
 const maybePending=await cli(b,'relationship-memory',{localBotId:groupBot.id,conversationId:'not-joined',membershipEpoch:'not-joined'})
 assert.ok(['PUBLICATION_RELOAD_REQUIRED','NOT_A_MEMBER','AUTHORIZATION_PENDING'].includes(maybePending.body.error?.code),maybePending.body.error?.code)
 const state=await published(b),target=state.localBots.find(bot=>bot.displayName==='GroupOnly').principalId,outsider=state.localBots.find(bot=>bot.displayName==='OutsideGroup').principalId
 assert.equal((await a.api({endpoint:'state'})).contacts.some(person=>person.principalId===target),false)
 record('pending-Bot-scope-is-distinguished-from-unpublished-and-native-ConfigEditor-reload-completes')
 const group=await topology.group(`Scoped group ${nonce}`)
 let row=await current(a,group)
 await topology.operation(a,'policy',{conversationId:group,membershipEpoch:row.membershipEpoch,expectedVersion:row.membershipVersion,targetPrincipalId:b.human,role:'admin'})
 await until(async()=>(await current(b,group)).info.members.some(person=>person.principalId===b.human&&person.role==='admin'),'remote Human becomes manager')
 await successful(b,'invite',{conversationId:group,inviteePrincipalId:target})
 row=await until(async()=>{const row=await current(a,group);return row.info.members.some(person=>person.principalId===target)&&row},'unshared Bot joins group')
 await topology.operation(a,'policy',{conversationId:group,membershipEpoch:row.membershipEpoch,expectedVersion:row.membershipVersion,targetPrincipalId:target,speakingMode:'active'})
 assert.equal((await a.api({endpoint:'state'})).contacts.some(person=>person.principalId===target),false)
 const send=await successful(a,'send',{conversationId:group,text:`COMM-ECHO group-only-${nonce}`,mentions:[target]})
 assert.equal(send.status,'pending')
 await until(()=>topology.hasText(a,group,`Communication reply group-only-${nonce}`),'actual unshared group Bot reply',60000)
 record('real-CLI-mentions-a-current-group-Bot-never-present-in-the-senders-contact-directory')
 const denied=await cli(a,'send',{conversationId:group,text:'probe',mentions:[outsider]})
 assert.equal(denied.body.error.code,'UNKNOWN_MENTION');assert.equal(denied.body.error.mentionValidation.source,'hub')
 record('live-unshared-outsider-is-denied-by-Hub-membership-with-safe-CLI-origin-details')
 const bRow=await until(async()=>{const info=(await b.api({endpoint:'state'})).botConversations.find(item=>item.conversationId===dm);return info},'private record after reload')
 const history=await successful(b,'bot-dm-history',{conversationId:dm,localBotId:b.botId,membershipEpoch:bRow.membershipEpoch})
 assert.ok(history.events.some(event=>event.message?.content.text===`Communication reply publication-${nonce}`))
 const memory=await successful(b,'relationship-memory',{localBotId:groupBot.id})
 assert.ok(memory)
 const preference=(await b.api({endpoint:'state'})).conversationPreferencesScope
 for(const archived of [true,false])await successful(b,'set-conversation-archived',{conversationId:dm,localBotId:b.botId,membershipEpoch:bRow.membershipEpoch,archived,expectedScope:preference})
 record('Bot-scoped-private-history-archiving-and-relationship-memory-work-after-native-publication-reload')
 await topology.bench(b,'stop');await topology.startPeer(b);await login(b)
 assert.equal((await a.api({endpoint:'state'})).contacts.some(person=>person.principalId===target),false)
 await successful(a,'send',{conversationId:group,text:`COMM-ECHO restarted-${nonce}`,mentions:[target]})
 await until(()=>topology.hasText(a,group,`Communication reply restarted-${nonce}`),'unshared member replies after Host restart',60000)
 record('group-only-mention-authorization-and-published-configuration-survive-native-Host-restart')
 await successful(b,'publish-bots',{localBotIds:[b.botId]});await published(b)
 await until(async()=>(await current(a,group)).info.formerMembers?.some(person=>person.principalId===target&&person.retired),'retired member is visible as former')
 for(const principalId of [target,outsider]){
  const retired=await cli(a,'send',{conversationId:group,text:'probe',mentions:[principalId]})
  assert.equal(retired.body.error.code,'BOT_RETIRED')
 }
 record('retired-member-and-retired-never-member-retain-BOT_RETIRED-after-partial-scope-publication')
 evidence.status='PASSED'
}catch(error){evidence.status='FAILED';evidence.error=error.code??error.message;throw error}
finally{await topology.close();if(previousOwner===undefined)delete process.env.DSBOT_COMMUNICATION_OWNER_PID;else process.env.DSBOT_COMMUNICATION_OWNER_PID=previousOwner;writeFileSync(join(topology.root,`${topology.prefix}-evidence.json`),JSON.stringify(evidence,null,2))}
