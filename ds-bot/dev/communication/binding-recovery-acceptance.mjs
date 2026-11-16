import assert from 'node:assert/strict'
import {randomUUID} from 'node:crypto'
import {existsSync,mkdirSync,readFileSync,symlinkSync,unlinkSync,realpathSync} from 'node:fs'
import {join} from 'node:path'
import {DatabaseSync} from 'node:sqlite'
import {LocalTopology,until} from './local-topology.mjs'
const tag=randomUUID().slice(0,8),topology=new LocalTopology({prefix:`binding-recovery-${tag}`,webPort:3471,mockPort:9171,hubPort:3479})
const baseline=process.argv[2]==='--baseline-plugin'?realpathSync(process.argv[3]):null
if(baseline){
 const metadata=JSON.parse(readFileSync(join(baseline,'package.json'),'utf8'))
 assert.equal(metadata.name,'ds-bot');assert.equal(metadata.version,'0.4.0')
 const bench=topology.bench.bind(topology)
 topology.bench=async(peer,action,extra={})=>{
  if(action==='start'){
   const modules=join(peer.home,'profiles/communication-test/node_modules');mkdirSync(modules,{recursive:true})
   const link=join(modules,'ds-bot');if(existsSync(link))unlinkSync(link)
   symlinkSync(baseline,link,'junction')
  }
  return bench(peer,action,extra)
 }
}
try{
 await topology.initialize()
 const [a,b]=topology.peers,group=await topology.group(`Missing execution Session ${tag}`)
 await until(async()=>{const state=await b.api({endpoint:'state'});return state.conversations.some(row=>row.conversationId===group&&row.info?.members.some(member=>member.principalId===b.bot))},'recipient has synchronized the new Bot membership')
 const fixture=await b.client.api({operation:'production-missing-session',conversationId:group,principalId:b.bot,localBotId:b.botId})
 const missing=await b.client.request('/api/communication-probe',{operation:'identity'})
 assert.ok(missing.botId)
 const sent=await topology.send(a,group,`COMM-ECHO missing-session-${tag}`,[b.bot])
 if(baseline){
  await until(async()=>{
   const state=await b.api({endpoint:'state'})
   if(!state.errors.some(row=>row.conversationId===group&&['EXPORT_UNKNOWN','SESSION_UNAVAILABLE','INJECTION_UNKNOWN'].includes(row.code)))return false
   const db=new DatabaseSync(join(b.home,'bot/communication.sqlite'),{readOnly:true})
   try{return Boolean(db.prepare('SELECT 1 FROM inbox WHERE message_id=? AND ai=1 AND ai_state=? AND applied=0').get(sent.messageId,'pending'))}finally{db.close()}
  },'unfixed 0.4.0 stores the activated input but cannot open its missing Session',15000)
  console.log('PASS negative control: unmodified 0.4.0 leaves the original activated @ pending with no admission')
 }else{
 await until(()=>topology.hasText(a,group,`Communication reply missing-session-${tag}`),'the original @ is admitted and answered after unused missing-Session recovery',60000)
 const state=await b.client.api({operation:'production-state',conversationId:group})
 const binding=state.bindings.find(row=>row.id===fixture.bindingId)
 assert.ok(binding)
 assert.ok(!JSON.parse(binding.sessions).includes(fixture.sessionId))
 assert.equal(JSON.parse(binding.sessions).length,1)
 const inbox=state.inbox.find(row=>row.ai)
 assert.ok(sent.messageId);assert.equal(inbox.ai_state,'accepted')
 assert.equal((await topology.history(a,group)).events.filter(event=>event.message?.content.text===`Communication reply missing-session-${tag}`).length,1)
 console.log('PASS native missing public Session: preserve binding and input, create isolated replacement, admit original @ and reply once')
 await topology.bench(b,'stop');await topology.startPeer(b)
 await topology.send(a,group,`COMM-ECHO repaired-restart-${tag}`,[b.bot])
 await until(()=>topology.hasText(a,group,`Communication reply repaired-restart-${tag}`),'a repaired binding survives native Host restart',60000)
 console.log('PASS repaired binding survives native Host restart and later @ still wakes the Bot')
 }
}finally{await topology.close()}
