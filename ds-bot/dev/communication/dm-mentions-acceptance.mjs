import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { LocalTopology, until } from './local-topology.mjs'
import { repo } from './bench-client.mjs'

const nonce = randomUUID().slice(0, 8)
const topology = new LocalTopology({ prefix: `dm-mentions-${nonce}`, webPort: 3355, mockPort: 9055, hubPort: 3359 })
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

try {
  await topology.initialize()
  const [a,b]=topology.peers
  await Promise.all(topology.peers.map(login))
  const request=await topology.operation(a,'request-contact',{userCode:(await b.api({endpoint:'user-code'})).userCode})
  const incoming=await until(async()=>(await b.api({endpoint:'contact-requests'})).find(row=>row.requestId===request.requestId),'incoming contact')
  await topology.operation(b,'accept-contact',{requestId:incoming.requestId,expectedVersion:incoming.version})
  const created=await cli(a,'dm',{otherPrincipalId:b.bot,operationId:randomUUID()})
  assert.equal(created.code,0,created.body.error?.code)
  const conversationId=created.body.value.conversationId, tag=`human-dm-${nonce}`
  const sent=await cli(a,'send',{conversationId,text:`COMM-ECHO ${tag}`,mentions:[],messageId:randomUUID(),clientCreatedAt:new Date().toISOString()})
  assert.equal(sent.code,0,sent.body.error?.code)
  await until(()=>topology.hasText(a,conversationId,`Communication reply ${tag}`),'remote Bot Mock reply',60000)
  let recordB=await until(async()=>(await b.api({endpoint:'state'})).botConversations.find(item=>item.conversationId===conversationId),'receiving owner private record')
  assert.equal(recordB.info.members.length,2)
  assert.deepEqual(recordB.info.members.map(person=>person.principalId).sort(),[a.human,b.bot].sort())
  assert.equal((await b.api({endpoint:'state'})).conversations.some(item=>item.conversationId===conversationId),false)
  async function checkHistory(){
    const history=await cli(b,'bot-dm-history',{conversationId,localBotId:b.botId,membershipEpoch:recordB.membershipEpoch})
    assert.equal(history.code,0,history.body.error?.code)
    assert.ok(history.body.value.events.some(event=>event.message?.content.text===`COMM-ECHO ${tag}`))
    assert.ok(history.body.value.events.some(event=>event.message?.content.text===`Communication reply ${tag}`))
    const human=await cli(b,'history',{conversationId})
    assert.equal(human.body.error.code,'NOT_A_MEMBER')
  }
  await checkHistory()
  record('real-CLI-Human-to-remote-Bot-DM-is-visible-to-receiving-owner-without-Human-membership')
  await topology.bench(b,'stop');await topology.startPeer(b);await login(b)
  recordB=await until(async()=>(await b.api({endpoint:'state'})).botConversations.find(item=>item.conversationId===conversationId),'record after restart')
  await checkHistory()
  record('receiving-owner-record-and-both-message-directions-survive-Host-restart')
  const disposable=await b.client.request('/api/bot',{endpoint:'create-bot',payload:{name:'NeverJoined',model:'deepseek-official/deepseek-v4-pro'}})
  const config=ids=>({DSBOT_COMMUNICATION_CONFIG:JSON.stringify({enabled:true,url:topology.url,instanceId:b.instanceId,publishedBotIds:ids,humanDisplayName:'Person B',pollMs:150})})
  await topology.bench(b,'stop');await topology.startPeer(b,config([b.botId,disposable.id]));await login(b)
  const neverJoined=await until(async()=>(await b.api({endpoint:'state'})).localBots.find(bot=>bot.displayName==='NeverJoined')?.principalId,'disposable publication')
  const group=await topology.group(`Member scope ${nonce}`)
  const relation=await until(async()=>(await a.api({endpoint:'contact-relations'})).find(row=>row.otherHumanPrincipalId===b.human&&row.active),'active relation')
  await topology.operation(a,'revoke-contact',{otherHumanPrincipalId:b.human,expectedVersion:relation.version})
  await until(async()=>!(await a.api({endpoint:'state'})).contacts.some(person=>person.principalId===b.bot),'contact disappears while group persists')
  const groupSend=await cli(a,'send',{conversationId:group,text:`COMM-ECHO group-${nonce}`,mentions:[b.bot],messageId:randomUUID(),clientCreatedAt:new Date().toISOString()})
  assert.equal(groupSend.code,0,groupSend.body.error?.code)
  await until(()=>topology.hasText(a,group,`Communication reply group-${nonce}`),'noncontact group member reply',60000)
  record('real-CLI-can-mention-current-group-member-outside-contact-directory')
  const sendId=id=>cli(a,'send',{conversationId:group,text:'Scope check',mentions:[id],messageId:randomUUID(),clientCreatedAt:new Date().toISOString()})
  const outsider=await sendId(neverJoined);assert.equal(outsider.body.error.code,'UNKNOWN_MENTION')
  record('live-published-Bot-outside-group-remains-UNKNOWN_MENTION')
  await topology.bench(b,'stop');await topology.startPeer(b,config([]),{allowOffline:true});await login(b)
  let lastError
  await until(async()=>{const state=await b.api({endpoint:'state'});if(state.error!==lastError){lastError=state.error;console.log('retirement-state',JSON.stringify({error:state.error,reconciled:state.reconciled,connected:state.connected}))}return state.reconciled},'retired publication reconciles')
  await until(async()=>(await a.api({endpoint:'state'})).conversations.find(item=>item.conversationId===group)?.info.formerMembers?.some(person=>person.principalId===b.bot&&person.retired),'retired group member metadata')
  const oldMember=await sendId(b.bot);assert.equal(oldMember.body.error.code,'BOT_RETIRED')
  const unknownRetired=await sendId(neverJoined);assert.equal(unknownRetired.body.error.code,'BOT_RETIRED')
  record('real-CLI-distinguishes-retired-group-member-and-retired-never-member-from-unknown-mention')
  evidence.status='PASSED'
} catch(error){evidence.status='FAILED';evidence.error=error.code ?? error.message;throw error}
finally{await topology.close();writeFileSync(join(topology.root,`${topology.prefix}-evidence.json`),JSON.stringify(evidence,null,2))}
