// Real, isolated DSH A/B integration. Only loopback Mock; no user accounts or keys.
import assert from 'node:assert/strict'
import { randomBytes, randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { startHub } from '../../../communication-hub/src/server.js'
import { CommunicationQueue } from '../../src/host/federation/queue-store.js'
import { benchClient, modelCalls, repo } from './bench-client.mjs'

const peers = ['a','b'].map((id, index) => ({ id, name: `communication-${id}`, web: 3101 + index, mock: 8801 + index,
  instanceId: `adapter-${id}`, credential: randomBytes(32).toString('hex') }))
const tools = join(repo, '.dsh-test-tools')
mkdirSync(tools, { recursive: true })
const evidence = { status: 'RUNNING', startedAt: new Date().toISOString(), transport: 'loopback WS', model: 'local deterministic Mock', cases: [] }
let hub
const settingsOf = peer => ({ enabled: true, url: hub.url, instanceId: peer.instanceId,
  publishedBotIds: [peer.botId], humanDisplayName: `Person ${peer.id.toUpperCase()}`, pollMs: 100, rotateTokens: 1 })
async function startPeer(peer) {
  await bench(peer, 'start', { DSBOT_COMMUNICATION_CONFIG: JSON.stringify(settingsOf(peer)),
    DSBOT_COMMUNICATION_CREDENTIAL: peer.credential, MOCK_LOG_TOOLS: '1', MOCK_WATCH: `private-canary-${nonce}` })
  peer.client = await benchClient(peer.name, peer.web)
  peer.api = body => peer.client.request('/api/communication', body)
}
async function bench(peer, action, extra = {}) {
  await new Promise((resolve, reject) => {
    const child = spawn('powershell.exe', ['-NoProfile','-File',join(import.meta.dirname,'bench.ps1'),'-Action',action,'-Name',peer.name,
      '-WebPort',String(peer.web),'-MockPort',String(peer.mock)], { windowsHide: true, stdio: ['ignore','pipe','pipe'],
      env: { ...process.env, ...extra } })
    let error = ''
    child.stdout.on('data', () => {})
    child.stderr.on('data', value => { error += value })
    child.once('error', reject)
    child.once('exit', code => code === 0 ? resolve() : reject(new Error(`Owned ${peer.name} ${action} failed: ${error.slice(0,1500)}`)))
  })
}
const until = async (check, label, timeout = 30000) => {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    const value = await check()
    if (value) return value
    await new Promise(resolve => setTimeout(resolve, 150))
  }
  throw new Error(`Timeout: ${label}`)
}
const record = name => { evidence.cases.push({ name, status: 'PASS' }); console.log(`PASS ${name}`) }
const dbOf = peer => new DatabaseSync(join(repo, `.dsh-test-${peer.name}`, 'bot/communication.sqlite'), { readOnly: true })
const nonce = randomUUID()
try {
  for (const peer of peers) {
    await bench(peer, 'stop')
    peer.botId = JSON.parse(readFileSync(join(repo, `.dsh-test-${peer.name}`, 'bot/state.json'), 'utf8')).mainBotIds[0]
    const queue = new CommunicationQueue(join(repo, `.dsh-test-${peer.name}`, 'bot/communication.sqlite'), { instanceId: peer.instanceId })
    peer.human = queue.localPrincipal('human', 'local-user', `Person ${peer.id.toUpperCase()}`).principalId
    peer.bot = queue.localPrincipal('bot', peer.botId, 'Chief').principalId
    queue.close()
    assert.ok(!peer.bot.includes(peer.botId), 'network identity must not contain a DSH Session ID')
  }
  hub = await startHub({ databasePath: join(tools, 'adapter-hub.sqlite'), port: 3191,
    peers: peers.map(peer => ({ ...peer, instanceLabel: `Instance ${peer.id.toUpperCase()}` })) })
  for (const peer of peers) {
    await startPeer(peer)
    await peer.client.request('/api/bot', { endpoint: 'update-bot', payload: { id: peer.botId, model: 'deepseek-official/deepseek-v4-pro' } })
  }
  const [a,b] = peers
  await until(async () => (await a.api({ endpoint:'state' })).contacts.length === 4 && (await b.api({ endpoint:'state' })).contacts.length === 4, 'four independently published contacts')
  const stateA = await a.api({ endpoint:'state' }), stateB = await b.api({ endpoint:'state' })
  assert.notEqual(stateA.localBots[0].principalId,stateB.localBots[0].principalId)
  assert.equal(stateA.localBots[0].displayName,stateB.localBots[0].displayName)
  record('same-name Chiefs retain distinct opaque instance-scoped identities')
  const dm = async (peer, contact) => (await peer.api({ endpoint:'dm', otherPrincipalId:contact, operationId:randomUUID() })).conversationId
  const send = async (peer, conversationId, text) => {
    const message = { endpoint:'send', conversationId, text, messageId:randomUUID(), clientCreatedAt:new Date().toISOString() }
    await peer.api(message)
    return message
  }
  const history = (peer, conversationId) => peer.api({ endpoint:'history', conversationId, limit:100 })
  const hasText = async (peer, conversationId, text) => (await history(peer,conversationId)).events.some(event => event.message?.content.text === text)
  const hh = await dm(a,b.human)
  assert.equal(await dm(b,a.human),hh)
  const before = peers.map(peer => modelCalls(peer.name))
  const humanMessage = await send(a,hh,`Human only ${nonce}`)
  await until(() => hasText(b,hh,humanMessage.text),'Human A to Human B')
  await b.api({ endpoint:'read', conversationId:hh, seq:(await history(b,hh)).watermark })
  await new Promise(resolve => setTimeout(resolve,500))
  assert.deepEqual(peers.map(peer => modelCalls(peer.name)),before)
  record('Human DM canonical reverse open, persisted display/read, no Chief model call')
  const hk = await dm(a,b.bot)
  await send(a,hk,`COMM-ECHO human-to-bot-${nonce}`)
  await until(() => hasText(a,hk,`Communication reply human-to-bot-${nonce}`),'Human to remote Bot and final export')
  record('Human to remote Bot uses real DSH admission and exact-conversation final export')
  await a.api(humanMessage)
  await until(async () => (await a.api({ endpoint:'state' })).outbox.find(item => item.id===humanMessage.messageId)?.state==='accepted','same message retry')
  assert.equal((await history(b,hh)).events.filter(event => event.message?.messageId===humanMessage.messageId).length,1)
  record('same-ID HTTP retry keeps original canonical message without a second display or model delivery')
  await a.client.request('/api/bot',{endpoint:'send',payload:{sessionId:a.botId,text:`COMM-SEND ${b.human} bot-to-human-${nonce}`}})
  const jh = await until(async () => (await b.api({ endpoint:'state' })).conversations.find(item=>item.kind==='dm'&&item.info?.members.some(member=>member.principalId===a.bot))?.conversationId,'Bot to Human DM creation')
  await until(()=>hasText(b,jh,`COMM-ECHO bot-to-human-${nonce}`),'Bot to Human real tool output')
  const bBefore=modelCalls(b.name)
  await new Promise(resolve=>setTimeout(resolve,500))
  assert.equal(modelCalls(b.name),bBefore)
  await send(b,jh,`COMM-ECHO human-reply-${nonce}`)
  await until(()=>hasText(b,jh,`Communication reply human-reply-${nonce}`),'Human replies to source Bot')
  record('real Bot tool to Human displays without local Chief wake; Human reply returns to source Bot')
  await a.client.request('/api/bot',{endpoint:'send',payload:{sessionId:a.botId,text:`COMM-SEND ${b.bot} bot-to-bot-${nonce}`}})
  await until(async()=>hub.store.db.prepare("SELECT count(*) n FROM messages WHERE json_extract(body,'$.content.text')=?").get(`Communication reply bot-to-bot-${nonce}`).n===1,'Bot to Bot actual model/tool/final round trip')
  record('Bot to Bot uses actual model tool calls and remote DSH finals without reflexive endless replies')
  await until(async()=>{
    for(const peer of peers){const db=dbOf(peer);try{
      if(db.prepare('SELECT count(*) n FROM bindings').get().n<2 || db.prepare("SELECT count(*) n FROM inbox WHERE ai=1 AND ai_state!='accepted' AND revoked=0").get().n)return false
    }finally{db.close()}}
    return true
  },'all destination bindings and durable admission receipts')
  for(const peer of peers){
    const db=dbOf(peer)
    try{
      const bindings=db.prepare('SELECT * FROM bindings').all()
      assert.ok(bindings.length>=2)
      const sessions=bindings.flatMap(binding=>JSON.parse(binding.sessions))
      assert.equal(sessions.length,new Set(sessions).size)
      assert.ok(sessions.every(id=>id!==peer.botId))
      const accepted=db.prepare("SELECT mapping FROM inbox WHERE ai_state='accepted'").all()
      assert.ok(accepted.every(row=>JSON.parse(row.mapping).seq>0))
    }finally{db.close()}
  }
  record('each conversation/recipient/epoch has separate retained DSH Sessions and exact durable admission mappings')
  for (const point of ['before-admission','after-output']) {
    await b.client.api({ operation:'production-hold', point, conversationId:hk })
    const crashNonce=`crash-${point}-${nonce}`
    const input=await send(a,hk,`COMM-ECHO ${crashNonce}`)
    await until(async()=> (await b.client.api({operation:'production-state',conversationId:hk})).sessions.some(session=>session.checkpoint?.point===point),`${point} durable checkpoint`)
    const beforeCrash=await b.client.api({operation:'production-state',conversationId:hk})
    const calls=modelCalls(b.name)
    await bench(b,'stop')
    await startPeer(b)
    await until(()=>hasText(a,hk,`Communication reply ${crashNonce}`),`${point} restart final reconciliation`)
    await until(async()=>{
      const state=await b.client.api({operation:'production-state',conversationId:hk})
      return state.sessions.flatMap(session=>session.events).filter(event=>event.type==='user/message'&&event.data.source?.messageId===input.messageId).length===1
        &&state.inbox.filter(item=>item.ai).every(item=>item.ai_state==='accepted')
    },`${point} exactly one admission`)
    assert.equal(modelCalls(b.name)-calls,point==='after-output'?0:1)
    assert.equal((await history(a,hk)).events.filter(event=>event.message?.content.text===`Communication reply ${crashNonce}`).length,1)
    if(point==='after-output')assert.ok(beforeCrash.sessions.some(session=>session.events.some(event=>event.type==='assistant/message'&&event.data.message.content.some(part=>part.text===`Communication reply ${crashNonce}`))))
    record(`production adapter ${point} forced host restart reconciles exactly once with original delivery/source identity`)
  }
  for (const peer of peers) {
    await peer.client.request('/api/bot', { endpoint:'send', payload:{sessionId:peer.botId,text:`private-canary-${nonce}`} })
  }
  await until(async()=>peers.every(peer=>readFileSync(join(repo,`.dsh-test-${peer.name}`,'mock.jsonl'),'utf8').split('\n').filter(Boolean).map(JSON.parse).some(row=>row.watchHit)),'private canaries actually reached original local chats')
  await send(a,hk,`COMM-ECHO isolated-${nonce}`)
  await until(()=>hasText(a,hk,`Communication reply isolated-${nonce}`),'isolated post-canary response')
  assert.equal(hub.store.db.prepare('SELECT count(*) n FROM messages WHERE body LIKE ?').get(`%private-canary-${nonce}%`).n,0)
  for (const peer of peers) {
    const state=await peer.client.api({operation:'production-state',conversationId:peer===b?hk:jh})
    const ids=new Set(state.sessions.map(session=>session.sessionId))
    const calls=readFileSync(join(repo,`.dsh-test-${peer.name}`,'mock.jsonl'),'utf8').split('\n').filter(Boolean).map(JSON.parse).filter(row=>ids.has(row.session)&&row.t>=evidence.startedAt)
    assert.ok(calls.every(row=>!row.watchHit))
    assert.ok(calls.every(row=>!(row.toolNames??[]).some(name=>['list_bots','create_bot','update_bot','recall','read_own_chat','session_search','subagent','workflow'].includes(name))))
  }
  const segmented=await b.client.api({operation:'production-state',conversationId:hk})
  assert.ok(segmented.bindings.some(binding=>JSON.parse(binding.sessions).length>=2))
  record('automatic retained Session rotation preserves conversation scope; private chat canaries and local team powers never enter communication prompts or Hub history')
  await bench(b,'stop')
  const offline=await send(a,hk,`COMM-ECHO offline-${nonce}`)
  await until(async()=>hub.store.db.prepare('SELECT id FROM messages WHERE id=?').get(offline.messageId),'offline target message accepted durably')
  const pending=hub.store.db.prepare('SELECT stored,ai_accepted FROM deliveries WHERE message_id=? AND recipient_id=?').get(offline.messageId,b.bot)
  assert.deepEqual({...pending},{stored:0,ai_accepted:0})
  await startPeer(b)
  await until(()=>hasText(a,hk,`Communication reply offline-${nonce}`),'offline Bot delivery after restart')
  assert.equal((await history(a,hk)).events.filter(event=>event.message?.content.text===`Communication reply offline-${nonce}`).length,1)
  record('target Bot process offline retains unconsumed delivery and generates one reply after normal restart')
  evidence.status='PASS'
}catch(error){ evidence.status='FAIL';evidence.error=error.message;console.error(error.stack);process.exitCode=1 }
finally{
  for(const peer of peers)await bench(peer,'stop').catch(()=>{})
  await hub?.close()
  writeFileSync(join(tools,'p2-adapter.json'),JSON.stringify(evidence,null,2))
}
