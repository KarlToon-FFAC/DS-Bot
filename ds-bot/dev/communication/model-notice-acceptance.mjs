import assert from 'node:assert/strict'
import {randomUUID} from 'node:crypto'
import {writeFileSync} from 'node:fs'
import {join} from 'node:path'
import {LocalTopology,until} from './local-topology.mjs'
const tag=randomUUID().slice(0,8),topology=new LocalTopology({prefix:'model-notice-'+tag,webPort:3505,mockPort:9205,hubPort:3509})
const cases=[],record=name=>{cases.push(name);console.log('PASS',name)}
try{
 await topology.initialize();const[a,b]=topology.peers,group=await topology.group('Model metadata '+tag)
 const inspect=()=>b.client.api({operation:'production-state',conversationId:group})
 await topology.send(a,group,`COMM-ECHO warm-${tag}`,[b.bot])
 await until(()=>topology.hasText(a,group,`Communication reply warm-${tag}`),'initial public answer')
 const original=(await inspect()).sessions.at(-1).sessionId
 const change=async model=>b.client.request('/api/bot',{endpoint:'update-bot',payload:{id:b.botId,model:'deepseek-official/'+model}})
 await change('deepseek-flash')
 await topology.send(a,group,`COMM-ECHO switched-${tag}`,[b.bot])
 await until(()=>topology.hasText(a,group,`Communication reply switched-${tag}`),'answer after an actual SDK model switch')
 let snapshot=await inspect(),session=snapshot.sessions.find(item=>item.sessionId===original)
 assert.ok(session,'model switch keeps the same communication Session')
 const notices=session.events.filter(event=>event.type==='user/message'&&event.data.source?.kind==='model-selection')
 assert.ok(notices.some(event=>event.data.source.form==='notice'))
 record('actual DSH model-selection notice shares the communication turn; the same Session replies successfully')
 const teammate=await b.client.request('/api/bot',{endpoint:'create-bot',payload:{name:'Internal reviewer '+tag,model:'deepseek-official/deepseek-v4-pro'}})
 await change('deepseek-v4-pro')
 await topology.send(a,group,`COMM-CONSULT-LATE ${teammate.id} ${tag}`,[b.bot])
 await until(()=>topology.hasText(a,group,`Late consultation ${tag} COMPLETED`),'unpublished local consultation after another model switch',90000)
 record('model metadata does not block a local consultation, saved result polling or an explicit remote summary')
 await b.client.request('/api/bot',{endpoint:'set-main',payload:{id:teammate.id,main:true}})
 await change('deepseek-flash')
 await topology.send(a,group,`COMM-REPORT-LOCAL ${teammate.id} ${tag}`,[b.bot])
 await until(()=>topology.hasText(a,group,`Local report ${tag} DELIVERED`),'local Chief report after model switch')
 record('local Chief report and explicit reply both succeed after a third model switch')
 snapshot=await inspect();session=snapshot.sessions.find(item=>item.sessionId===original)
 assert.ok(session.events.filter(event=>event.type==='user/message'&&event.data.source?.kind==='model-selection').length>=3)
 const seq=session.events.at(-1).seq
 await b.client.api({operation:'production-foreign-input',sessionId:original})
 const failure=await until(async()=>{const state=await inspect();return state.sessions.find(item=>item.sessionId===original)?.events.find(event=>event.seq>seq&&event.type==='turn/end'&&event.data.reason.kind==='error')},'unverified source fails closed with a typed journal outcome')
 assert.ok(['UNKNOWN','COMMUNICATION_INPUT_SOURCE_UNKNOWN'].includes(failure.data.reason.error.code))
 assert.match(failure.data.reason.error.message,/\[COMMUNICATION_INPUT_SOURCE_UNKNOWN\]/)
 const activity=await b.api({endpoint:'state'})
 assert.ok(activity.errors.some(error=>error.code==='COMMUNICATION_INPUT_SOURCE_UNKNOWN'&&error.conversationId===group))
 record('genuine unknown input remains blocked; local activity retains COMMUNICATION_INPUT_SOURCE_UNKNOWN (raw SDK terminal code: '+failure.data.reason.error.code+')')
 await topology.send(a,group,`COMM-ECHO resumed-${tag}`,[b.bot])
 await until(()=>topology.hasText(a,group,`Communication reply resumed-${tag}`),'new verified input resumes the same Session')
 assert.equal((await b.api({endpoint:'state'})).errors.some(error=>error.code==='COMMUNICATION_INPUT_SOURCE_UNKNOWN'&&error.conversationId===group),false)
 record('a later verified input succeeds and clears stale source errors without resetting or replaying the failed turn')
 writeFileSync(join(topology.root,topology.prefix+'-acceptance.json'),JSON.stringify({status:'PASS',model:'Mock',cases},null,2))
}finally{await topology.close()}
