import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { LocalTopology,until } from './local-topology.mjs'
import { modelCalls } from './bench-client.mjs'

const topology=new LocalTopology(),evidence={status:'RUNNING',platform:process.platform,model:'local deterministic Mock',cases:[]}
const nonce=randomUUID()
const record=(id,detail)=>{evidence.cases.push({id,status:'PASS',...detail});console.log(`PASS ${id}`);writeFileSync(join(topology.root,'p4-recovery.json'),JSON.stringify(evidence,null,2))}
try{
  await topology.initialize()
  const [a,b]=topology.peers
  for(const point of ['before-receive','after-receive','before-injection','before-admission','after-injection','before-export','after-export']){
    const conversationId=await topology.group(`Recovery ${point} ${nonce.slice(0,8)}`)
    await b.client.api({operation:'production-hold',point,conversationId})
    const calls=modelCalls(b.name),tag=`${point}-${nonce}`,text=point==='after-injection'?`COMM-DELAY-ECHO 5000 ${tag}`:`COMM-ECHO ${tag}`
    const sent=await topology.send(a,conversationId,text,[b.bot])
    const inspect=()=>b.client.api({operation:'production-state',conversationId})
    const held=await until(async()=>{const state=await inspect();return state.checkpoints.some(item=>item.point===point)||state.sessions.some(item=>item.checkpoint?.point===point)?state:false},`${point} reached`)
    const logicalInputs=state=>state.sessions.flatMap(session=>session.events).filter(event=>event.type==='user/message'&&event.data.source?.messageId===sent.messageId&&event.data.source.kind==='ds-bot-communication')
    if(point==='before-receive')assert.equal(held.inbox.length,0)
    if(['after-receive','before-injection'].includes(point)){assert.equal(held.inbox.filter(item=>item.ai).length,1);assert.equal(logicalInputs(held).length,0)}
    if(point==='after-injection'){
      await until(async()=>logicalInputs(await inspect()).length===1&&modelCalls(b.name)>calls,'DSH admitted and model request in flight')
      const active=await inspect();assert.ok(active.inbox.some(item=>item.ai_state==='injecting'))
      assert.equal(active.sessions.flatMap(session=>session.events).filter(event=>event.type==='assistant/message'&&event.data.message.content.some(part=>part.text===`Communication reply ${tag}`)).length,0)
    }
    if(point==='before-export')assert.equal(held.exports.length,0)
    const exportedBefore=held.exports.map(item=>item.message_id)
    if(point==='after-export')assert.equal(exportedBefore.length,1)
    await topology.bench(b,'stop')
    await topology.startPeer(b)
    await until(()=>topology.hasText(a,conversationId,`Communication reply ${tag}`),`${point} final response recovered`)
    const restored=await until(async()=>{const state=await inspect();return state.inbox.filter(item=>item.ai).every(item=>item.ai_state==='accepted')?state:false},`${point} admission mapping repaired`)
    assert.equal(logicalInputs(restored).length,1)
    assert.equal((await topology.history(a,conversationId)).events.filter(event=>event.message?.content.text===`Communication reply ${tag}`).length,1)
    assert.equal(restored.exports.length,1)
    if(point==='after-export')assert.deepEqual(restored.exports.map(item=>item.message_id),exportedBefore)
    const generated=modelCalls(b.name)-calls
    if(['before-export','after-export'].includes(point))assert.equal(generated,1,'persisted final must not be regenerated')
    if(point==='after-injection')assert.equal(generated,2,'one lost model attempt plus one truthful host-resumption attempt')
    record(point,{conversationId,messageId:sent.messageId,deliveryId:restored.inbox.find(item=>item.ai).delivery_id,
      logicalInputs:1,finalMessages:1,modelCalls:generated,exportedMessageId:restored.exports[0].message_id})
    const after=modelCalls(b.name)
    await topology.bench(b,'stop');await topology.startPeer(b)
    await until(async()=> (await b.api({endpoint:'state'})).connected,'second restart connection')
    await new Promise(resolve=>setTimeout(resolve,500))
    assert.equal(modelCalls(b.name),after,'repeated recovery must not generate another response')
  }
  evidence.status='PASS'
}catch(error){evidence.status='FAIL';evidence.error=error.stack;console.error(error.stack);process.exitCode=1}
finally{await topology.close();writeFileSync(join(topology.root,'p4-recovery.json'),JSON.stringify(evidence,null,2))}
