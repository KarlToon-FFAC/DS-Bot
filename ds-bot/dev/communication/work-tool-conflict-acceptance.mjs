import assert from 'node:assert/strict'
import {randomUUID} from 'node:crypto'
import {existsSync,mkdirSync,realpathSync,symlinkSync,unlinkSync} from 'node:fs'
import {join} from 'node:path'
import {LocalTopology,until} from './local-topology.mjs'
const tag=randomUUID().slice(0,8),topology=new LocalTopology({prefix:`work-conflict-${tag}`,webPort:3531,mockPort:9231,hubPort:3539})
const baseline=process.argv[2]==='--baseline-plugin'?realpathSync(process.argv[3]):null
if(baseline){
 const bench=topology.bench.bind(topology)
 topology.bench=async(peer,action,extra={})=>{
  if(action==='start'){
   const modules=join(peer.home,'profiles/communication-test/node_modules');mkdirSync(modules,{recursive:true})
   const link=join(modules,'ds-bot');if(existsSync(link))unlinkSync(link);symlinkSync(baseline,link,'junction')
  }
  return bench(peer,action,extra)
 }
}
try{
 await topology.initialize()
 const [a,b]=topology.peers,directory=join(topology.root,`work-conflict-${tag}-workspace`)
 mkdirSync(directory,{recursive:true})
 await b.client.request('/api/bot',{endpoint:'update-bot',payload:{id:b.botId,workDir:directory}})
 const group=await topology.group(`Native work conflict ${tag}`)
 await until(async()=>(await b.api({endpoint:'state'})).conversations.some(row=>row.conversationId===group&&row.info?.members.some(member=>member.principalId===b.bot)),'recipient sees its Bot membership')
 const fixture=await b.client.api({operation:'production-work-tool-conflict',conversationId:group,principalId:b.bot,localBotId:b.botId})
 assert.equal(fixture.localMode,'native');assert.equal(fixture.remoteMode,'native')
 await topology.send(a,group,`COMM-ECHO conflict-${tag}`,[b.bot])
 if(baseline){
  await until(async()=>(await b.api({endpoint:'state'})).errors.some(row=>row.code==='COMMUNICATION_SESSION_UNAVAILABLE'&&row.stage==='work-context'&&row.location==='work-tools.js:82:37'),'unfixed native registration conflict matches reported source location',15000)
  const state=await b.client.api({operation:'production-state',conversationId:group})
  assert.ok(state.inbox.some(row=>row.ai&&row.ai_state==='pending'))
  assert.equal(await topology.hasText(a,group,`Communication reply conflict-${tag}`),false)
  console.log('PASS negative native-mode control: work-tools.js:82:37 blocks the original activated message before model admission')
 }else{
  await until(()=>topology.hasText(a,group,`Communication reply conflict-${tag}`),'original @ still enters a turn and replies despite one optional work conflict',60000)
  const state=await b.api({endpoint:'state'})
  assert.ok(state.workToolWarnings.some(row=>row.bindingId===fixture.bindingId&&row.toolName==='read'&&row.registrationFailure==='scope-conflict'))
  assert.equal(state.errors.some(row=>row.bindingId===fixture.bindingId),false)
  const delivered=await b.client.api({operation:'production-state',conversationId:group})
  assert.ok(delivered.inbox.some(row=>row.ai&&row.ai_state==='accepted'))
  assert.equal((await topology.history(a,group)).events.filter(event=>event.message?.content.text===`Communication reply conflict-${tag}`).length,1)
  const released=await b.client.api({operation:'production-work-tool-conflict',clear:true})
  assert.equal(released.executions,0)
  await topology.send(a,group,`COMM-ECHO released-${tag}`,[b.bot])
  await until(()=>topology.hasText(a,group,`Communication reply released-${tag}`),'later @ succeeds after foreign registration release')
  await until(async()=>!(await b.api({endpoint:'state'})).workToolWarnings.some(row=>row.bindingId===fixture.bindingId),'warning clears after successful scope reconciliation')
  console.log('PASS native mode: original input admitted and replied once; conflicting foreign capability stays unavailable with an explicit warning')
  console.log('PASS native mode: owner release repairs the capability on the same binding; later @ works without clearing Hub or local data')
 }
}catch(error){
 const peer=topology.peers[1]
 if(peer?.api){const state=await peer.api({endpoint:'state'}).catch(()=>null);console.error(JSON.stringify({errors:state?.errors,workToolWarnings:state?.workToolWarnings,transportState:state?.transport?.state}))}
 throw error
}finally{await topology.close()}
