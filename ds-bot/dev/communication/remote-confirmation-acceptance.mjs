import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { LocalTopology } from './local-topology.mjs'
const nonce=randomUUID().slice(0,8)
const topology=new LocalTopology({prefix:`confirm-work-${nonce}`,webPort:3325,mockPort:9025,hubPort:3329})
const evidence={status:'RUNNING',model:'deterministic Mock',cases:[]}
const record=name=>{evidence.cases.push(name);console.log('PASS',name)}
try{
 await topology.initialize()
 const [a,b]=topology.peers,folder=join(topology.root,`confirm-work-${nonce}-workspace`)
 mkdirSync(folder,{recursive:true})
 await b.client.request('/api/bot',{endpoint:'update-bot',payload:{id:b.botId,workDir:folder,permission:'danger-full-access'}})
 await topology.bench(b,'stop')
 await topology.startPeer(b,{DSBOT_COMMUNICATION_CONFIG:JSON.stringify({enabled:true,url:topology.url,instanceId:b.instanceId,publishedBotIds:[b.botId],pollMs:100,remoteWorkApproval:'ask'})})
 const conversation=await topology.group(`Confirm work ${nonce}`)
 for(const choice of ['reject','allow']){
  const tag=`${choice}-${nonce}`
  await topology.send(a,conversation,`COMM-WORK ${tag}`,[b.bot])
  let count=0
  const deadline=Date.now()+90000
  for(;;){
   if(Date.now()>deadline)throw new Error('REMOTE_CONFIRMATION_TIMEOUT')
   const state=await b.api({endpoint:'state'}),pending=state.workApprovals[0]
   if(pending){
    assert.equal(pending.sourceAuthorPrincipalId,a.human)
    assert.equal(pending.detail.workDirectory,folder)
    if(count===0)assert.equal(existsSync(join(folder,`native-work-${tag}.txt`)),false)
    await b.api({endpoint:'answer-work-approval',id:pending.id,choice,expectedScope:state.conversationPreferencesScope})
    count++
   }
   const messages=(await topology.history(a,conversation)).events
   if(messages.some(event=>event.message?.content.text===`Remote work ${choice==='allow'?'completed':'failed'} ${tag}`))break
   if(count>10)throw new Error('UNEXPECTED_APPROVAL_LOOP')
   await new Promise(resolve=>setTimeout(resolve,100))
  }
  if(choice==='reject'){assert.equal(count,1);assert.equal(existsSync(join(folder,`native-work-${tag}.txt`)),false)}
  else{
   assert.ok(count>=3,'write, edit and Shell each need a separate approval')
   assert.equal(readFileSync(join(folder,`native-work-${tag}.txt`),'utf8'),`after:${tag}`)
   assert.equal(readFileSync(join(folder,`native-shell-${tag}.txt`),'utf8').trim(),`shell:${tag}`)
  }
  const localState=await b.client.request('/api/bot',{endpoint:'state'})
  assert.equal(localState.bots.find(bot=>bot.id===b.botId).permission,'danger-full-access')
  record(`danger-full-access-remote-${choice}-before-native-effects-without-changing-local-Bot-permission`)
 }
 evidence.status='PASSED'
} catch(error){evidence.status='FAILED';evidence.error=error.code??error.message;throw error}
finally{await topology.close();writeFileSync(join(topology.root,`${topology.prefix}-evidence.json`),JSON.stringify(evidence,null,2))}
