import assert from 'node:assert/strict'
import {randomUUID} from 'node:crypto'
import {readFileSync} from 'node:fs'
import {join} from 'node:path'
import {LocalTopology,until} from './local-topology.mjs'
const tag=randomUUID().slice(0,8),topology=new LocalTopology({prefix:`consult-recovery-${tag}`,webPort:3491,mockPort:9191,hubPort:3499})
try{
 await topology.initialize()
 const [a,b]=topology.peers,group=await topology.group(`Consultation recovery ${tag}`)
 const teammate=await b.client.request('/api/bot',{endpoint:'create-bot',payload:{name:'Unpublished reviewer',role:'Reviewer',model:'deepseek-official/deepseek-v4-pro'}})
 await topology.send(a,group,`COMM-CONSULT-LATE ${teammate.id} ${tag}`,[b.bot])
 await until(()=>topology.hasText(a,group,`Late consultation ${tag} COMPLETED`),'late internal result resumes original remote Session and can be explicitly published',90000)
 const saved=JSON.parse(readFileSync(join(b.home,'bot/state.json'),'utf8'))
 const row=Object.values(saved.localConsultations).find(row=>row.targetBotId===teammate.id)
 assert.equal(row.status,'completed');assert.ok(row.receiptId);assert.ok(row.notifiedKey);assert.ok(row.text.length>2500)
 assert.match(row.text,new RegExp(`CONSULT_SAVED_${tag}`));assert.doesNotMatch(row.text,/LOCAL_CONSULT_CLOSING/)
 assert.equal(saved.works[row.id],undefined)
 console.log('PASS native unpublished responder: invalid placeholder rejected, message_bot saves a long internal answer with receipt')
 console.log('PASS native late result: pending is not silence, original remote Session resumes, final publication remains explicit')
}finally{await topology.close()}
