import assert from 'node:assert/strict'
import {randomUUID} from 'node:crypto'
import {mkdirSync,readFileSync} from 'node:fs'
import {join} from 'node:path'
import {LocalTopology,until} from './local-topology.mjs'
const tag=randomUUID().slice(0,8),topology=new LocalTopology({prefix:`own-context-${tag}`,webPort:3491,mockPort:9191,hubPort:3499})
try{
 await topology.initialize()
 const [a,b]=topology.peers,dir=join(topology.root,`own-context-${tag}`)
 mkdirSync(dir,{recursive:true})
 await b.client.request('/api/bot',{endpoint:'update-bot',payload:{id:b.botId,workDir:dir,permission:'danger-full-access'}})
 const teammate=await b.client.request('/api/bot',{endpoint:'create-bot',payload:{name:'Unpublished local reviewer',role:'Reviewer',model:'deepseek-official/deepseek-v4-pro'}})
 await b.client.request('/api/bot',{endpoint:'send',payload:{sessionId:teammate.id,text:`LOCAL-SKILL ${tag}`}})
 await until(()=>{
   const state=JSON.parse(readFileSync(join(b.home,'bot/state.json'),'utf8'))
   const skill=state.capabilities?.items?.[`local-${tag}`]
   if(skill?.createdBy!==teammate.id||!state.bots[teammate.id].capabilities.includes(`local-${tag}`))return false
   try{return readFileSync(join(b.home,'bot/memory/bots',teammate.id,'MEMORY.md'),'utf8').includes(`Local unpublished Skill verified ${tag}`)}catch{return false}
 },'unpublished local Bot saves, reads and attaches a Skill with no duplicate tools',90000)
 console.log('PASS native unpublished local Bot uses the unified Skill and memory tools')
 const group=await topology.group(`Shared Bot context ${tag}`)
 await topology.send(a,group,`COMM-OWN ${tag}`,[b.bot])
 await until(()=>topology.hasText(a,group,`Own context ${tag} PRESENT`),'own memory, Skill and AGENTS changes appear in the next remote request',90000)
 assert.match(readFileSync(join(dir,'AGENTS.md'),'utf8'),new RegExp(`OWN_GUIDANCE_${tag}`))
 const saved=JSON.parse(readFileSync(join(b.home,'bot/state.json'),'utf8'))
 assert.equal(saved.capabilities.items[`own-${tag}`].content,`OWN_SKILL_${tag}`)
 assert.match(readFileSync(join(b.home,'bot/memory/bots',b.botId,'MEMORY.md'),'utf8'),new RegExp(`Own context preference ${tag}`))
 console.log('PASS native shared own memory, Skills and AGENTS reload')
 await b.client.request('/api/bot',{endpoint:'send',payload:{sessionId:b.botId,text:`LOCAL_MESSAGE_${tag}`}})
 const local=await until(async()=>{const value=await b.client.api({operation:'local-message-ids'});return value.messages.find(message=>message.text===`LOCAL_MESSAGE_${tag}`&&message.messageId)},'local canonical message ID')
 await topology.send(a,group,`COMM-LOCAL-READ ${local.messageId} ${tag}`,[b.bot])
 await until(()=>topology.hasText(a,group,`Local message ${tag} FOUND`),'remote Bot inherits local team catalog and reads exact local message ID',90000)
 console.log('PASS native remote local-tool catalog and exact local message read by ID')

 await topology.send(a,group,`COMM-CONSULT ${teammate.id} ${tag}`,[b.bot])
 await until(()=>topology.hasText(a,group,`Consultation ${tag} COMPLETED`),'unpublished local teammate returns answer to the remote worker',90000)
 const after=JSON.parse(readFileSync(join(b.home,'bot/state.json'),'utf8'))
 assert.ok(Object.values(after.localConsultations).some(row=>row.targetBotId===teammate.id&&row.status==='completed'))
 console.log('PASS native bidirectional unpublished local collaboration with explicit public reply')
}finally{await topology.close()}
