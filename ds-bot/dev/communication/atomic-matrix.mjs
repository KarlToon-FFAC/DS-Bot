import assert from 'node:assert/strict'
import { fork } from 'node:child_process'
import { once } from 'node:events'
import { randomUUID } from 'node:crypto'
import { existsSync,writeFileSync,mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { CommunicationQueue } from '../../src/host/federation/queue-store.js'
import { repo } from './bench-client.mjs'
import { until } from './local-topology.mjs'

const root=join(repo,'.dsh-test-tools'),evidence={status:'RUNNING',level:'independent native process, real production CommunicationQueue and SQLite WAL',cases:[]}
mkdirSync(root,{recursive:true})
try{
  for(const point of ['before-commit','after-commit']){
    const id=randomUUID(),path=join(root,`atomic-${id}.sqlite`),marker=join(root,`atomic-${id}.json`),messageId=`message-${id}`
    const child=fork(join(import.meta.dirname,'atomic-fixture.mjs'),[path,marker,point,messageId],{windowsHide:true,stdio:'ignore'})
    try{
      await until(()=>existsSync(marker),`${point} transaction checkpoint`)
      const exited=once(child,'exit');child.kill('SIGKILL');await exited
      const queue=new CommunicationQueue(path,{instanceId:'atomic'})
      try{
        const counts=()=>['exports','outbox','export_cursors'].map(table=>queue.db.prepare(`SELECT count(*) n FROM ${table}`).get().n)
        assert.deepEqual(counts(),point==='before-commit'?[0,0,0]:[1,1,1])
        let created=0
        const source={sourceKey:'durable-assistant-event',conversationId:'conversation',parts:[{part:0,text:'whole final response'}]}
        const ids=queue.commitExports('binding',[source],[{sessionId:'retained-session',seq:7}],()=>{
          created+=1
          return {protocol:'dsbot-communication/1',type:'message.publish',messageId,conversationId:'conversation',author:{principalId:'bot:atomic:recipient',homeInstanceId:'atomic',kind:'bot'},
            clientCreatedAt:'2026-11-03T00:00:00.000Z',content:{format:'markdown',text:'whole final response'},mentions:[],replyToMessageId:null}
        })
        assert.deepEqual(ids,[messageId]);assert.deepEqual(counts(),[1,1,1]);assert.equal(created,point==='before-commit'?1:0)
        assert.equal(queue.db.prepare('SELECT seq FROM export_cursors').get().seq,7)
        evidence.cases.push({point,status:'PASS',messageId,atomicTuple:counts(),newMessageGeneratedAfterReplay:created===1})
        console.log(`PASS atomic ${point}`)
      }finally{queue.close()}
    }finally{if(child.exitCode===null&&child.signalCode===null){const exited=once(child,'exit');child.kill('SIGKILL');await exited}}
  }
  evidence.status='PASS'
}catch(error){evidence.status='FAIL';evidence.error=error.stack;console.error(error.stack);process.exitCode=1}
finally{writeFileSync(join(root,'p4-atomic.json'),JSON.stringify(evidence,null,2))}
