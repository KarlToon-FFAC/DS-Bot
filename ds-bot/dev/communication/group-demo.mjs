// Production adapter + shared group, followed optionally by a real browser demo.
import assert from 'node:assert/strict'
import { randomUUID, randomBytes } from 'node:crypto'
import { spawn } from 'node:child_process'
import { readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { startHub } from '../../../communication-hub/src/server.js'
import { CommunicationQueue } from '../../src/host/federation/queue-store.js'
import { benchClient, repo } from './bench-client.mjs'

const hold = process.argv.includes('--hold'), root = join(repo,'.dsh-test-tools'), stop = join(root,'p3-stop'), offline = join(root,'p3-hub-offline')
const evidence = { status:'RUNNING',model:'local deterministic Mock',network:'loopback WS',cases:[] }
const peers=['a','b'].map((id,index)=>({id,name:`communication-${id}`,web:3101+index,mock:8801+index,credential:randomBytes(32).toString('hex')}))
let hub
const until=async(check,label)=>{const end=Date.now()+30000;while(Date.now()<end){const result=await check();if(result)return result;await new Promise(resolve=>setTimeout(resolve,150))}throw new Error(`Timeout: ${label}`)}
const record=name=>{evidence.cases.push({name,status:'PASS'});console.log(`PASS ${name}`)}
async function bench(peer,action,env={}){
  await new Promise((resolve,reject)=>{
    const child=spawn('powershell.exe',['-NoProfile','-File',join(import.meta.dirname,'bench.ps1'),'-Action',action,'-Name',peer.name,'-WebPort',String(peer.web),'-MockPort',String(peer.mock)],{windowsHide:true,stdio:['ignore','pipe','pipe'],env:{...process.env,...env}})
    let error='';child.stdout.on('data',()=>{});child.stderr.on('data',data=>{error+=data});child.once('error',reject)
    child.once('exit',code=>code===0?resolve():reject(new Error(`${peer.name} ${action}: ${error.slice(0,1000)}`)))
  })
}
try{
  for(const peer of peers){
    await bench(peer,'stop')
    peer.botId=JSON.parse(readFileSync(join(repo,`.dsh-test-${peer.name}`,'bot/state.json'),'utf8')).mainBotIds[0]
    const queue=new CommunicationQueue(join(repo,`.dsh-test-${peer.name}`,'bot/communication.sqlite'))
    peer.instanceId=queue.instanceId
    peer.human=queue.localPrincipal('human','local-user',`Person ${peer.id.toUpperCase()}`).principalId
    peer.bot=queue.localPrincipal('bot',peer.botId,'Chief').principalId;queue.close()
  }
  const hubSettings={databasePath:join(root,'adapter-hub.sqlite'),port:3191,peers:peers.map(peer=>({...peer,instanceLabel:`Instance ${peer.id.toUpperCase()}`}))}
  hub=await startHub(hubSettings)
  for(const peer of peers){
    await bench(peer,'start',{DSBOT_COMMUNICATION_CONFIG:JSON.stringify({enabled:true,url:hub.url,instanceId:peer.instanceId,publishedBotIds:[peer.botId],humanDisplayName:`Person ${peer.id.toUpperCase()}`,pollMs:100}),DSBOT_COMMUNICATION_CREDENTIAL:peer.credential,MOCK_LOG_TOOLS:'1',DSBOT_WEB_OPEN:'0'})
    peer.client=await benchClient(peer.name,peer.web);peer.api=body=>peer.client.request('/api/communication',body)
  }
  const [a,b]=peers,nonce=randomUUID()
  await until(async()=> (await a.api({endpoint:'state'})).connected&&(await b.api({endpoint:'state'})).connected,'paired hosts')
  const operation=(peer,endpoint,input)=>peer.api({endpoint,operationId:randomUUID(),...input})
  const group=(await operation(a,'create-group',{title:`Shared communication ${nonce.slice(0,8)}`})).conversationId
  for(const [peer,principal] of [[a,a.bot],[b,b.human],[b,b.bot]]){
    const invitation=await operation(a,'invite',{conversationId:group,inviteePrincipalId:principal})
    await operation(peer,'accept',{inviteId:invitation.inviteId,recipientPrincipalId:principal})
    const member=await until(async()=>{const value=(await a.api({endpoint:'state'})).conversations.find(item=>item.conversationId===group);return value?.info?.members.some(person=>person.principalId===principal)&&value.info.membershipVersion===value.membershipVersion&&value},'owner sees accepted member')
    await operation(a,'policy',{conversationId:group,targetPrincipalId:principal,expectedVersion:member.membershipVersion,speakingMode:principal.startsWith('bot:')?'active':'speak'})
  }
  await until(async()=> (await a.api({endpoint:'state'})).conversations.find(item=>item.conversationId===group)?.info?.members.length===4&&(await b.api({endpoint:'state'})).conversations.find(item=>item.conversationId===group)?.info?.members.length===4,'A/J/B/K membership')
  record('A/J/B/K mixed membership and explicit per-owner invitation acceptance')
  const send=async(peer,text,mentions=[],extra={})=>{
    const message={endpoint:'send',conversationId:group,text,mentions,messageId:randomUUID(),clientCreatedAt:new Date().toISOString(),...extra}
    await peer.api(message);return message
  }
  const history=peer=>peer.api({endpoint:'history',conversationId:group,limit:100})
  const has=(peer,text)=>history(peer).then(value=>value.events.some(event=>event.message?.content.text===text))
  const routes=id=>hub.store.db.prepare('SELECT recipient_id,ai,notify,revoked FROM deliveries WHERE message_id=?').all(id)
  const directed=await send(a,`COMM-ECHO group-k-${nonce}`,[b.bot])
  await until(()=>has(a,`Communication reply group-k-${nonce}`),'exact remote Bot mention')
  assert.deepEqual(routes(directed.messageId).filter(item=>item.ai).map(item=>item.recipient_id),[b.bot])
  const botReply=hub.store.db.prepare("SELECT id FROM messages WHERE json_extract(body,'$.content.text')=?").get(`Communication reply group-k-${nonce}`)
  assert.equal(routes(botReply.id).filter(item=>item.ai).length,0)
  record('exact structured same-name Bot mention invokes only K; ordinary Bot reply invokes no other Bot')
  const human=await send(a,`Human notification ${nonce}`,[b.human])
  await until(()=>has(b,human.text),'Human mention display')
  assert.equal(routes(human.messageId).filter(item=>item.ai).length,0)
  assert.equal(routes(human.messageId).find(item=>item.recipient_id===b.human).notify,1)
  await operation(a,'routing',{conversationId:group,mode:'admin',adminBotPrincipalId:a.bot})
  const plain=await send(b,`COMM-ECHO default-j-${nonce}`)
  await until(()=>has(b,`Communication reply default-j-${nonce}`),'default reply Bot')
  assert.deepEqual(routes(plain.messageId).filter(item=>item.ai).map(item=>item.recipient_id),[a.bot])
  const humanInAdmin=await send(b,`Only Human ${nonce}`,[a.human])
  await until(()=>has(a,humanInAdmin.text),'Human mention in admin mode')
  assert.equal(routes(humanInAdmin.messageId).filter(item=>item.ai).length,0)
  record('versioned admin routing and Human mentions remain distinct from Bot dispatch')
  await assert.rejects(send(a,'@Chief ambiguous same-name mention'),/AMBIGUOUS_MENTION/)
  await assert.rejects(operation(b,'remove',{conversationId:group,targetPrincipalId:a.human}),/FORBIDDEN/)
  const reply=await send(b,`Same conversation reply ${nonce}`,[],{replyToMessageId:human.messageId})
  await until(async()=> (await history(a)).events.some(event=>event.message?.messageId===reply.messageId&&event.message.replyToMessageId===human.messageId),'same conversation reply metadata')
  record('ambiguous names and unauthorized group management fail; same-conversation reply retains exact target ID')
  await until(async()=> (await history(a)).watermark===(await history(b)).watermark,'same canonical watermark')
  const [ha,hb]=await Promise.all([history(a),history(b)])
  const sharedBoundary=Math.max(ha.joinSeq,hb.joinSeq)
  assert.deepEqual(ha.events.filter(event=>event.conversationSeq>=sharedBoundary),hb.events.filter(event=>event.conversationSeq>=sharedBoundary))
  await b.api({endpoint:'read',conversationId:group,seq:hb.watermark})
  record('both Human views converge to identical canonical IDs, order, complete text and reply metadata')
  evidence.status='PASS';evidence.conversationId=group;evidence.title=`Shared communication ${nonce.slice(0,8)}`
  writeFileSync(join(root,'p3-group.json'),JSON.stringify(evidence,null,2))
  if(hold){
    // Browser acceptance starts on normal fresh startup cookies after API-driver
    // checks finish. No authentication material crosses into the UI driver.
    for(const peer of peers)await bench(peer,'stop')
    for(const peer of peers)await bench(peer,'start',{DSBOT_COMMUNICATION_CONFIG:JSON.stringify({enabled:true,url:hub.url,instanceId:peer.instanceId,publishedBotIds:[peer.botId],humanDisplayName:`Person ${peer.id.toUpperCase()}`,pollMs:100}),DSBOT_COMMUNICATION_CREDENTIAL:peer.credential,MOCK_LOG_TOOLS:'1',DSBOT_WEB_OPEN:'1'})
    rmSync(stop,{force:true});rmSync(offline,{force:true})
    console.log(`BROWSER_READY ${evidence.title}; http://127.0.0.1:3101/ and http://127.0.0.1:3102/; normal DSH startup opened authenticated browser tabs`)
    console.log('Stop: create .dsh-test-tools/p3-stop in this repository. Maximum hold: 30 minutes.')
    const end=Date.now()+30*60*1000
    while(!existsSync(stop)&&Date.now()<end){
      if(existsSync(offline)&&hub){await hub.close();hub=null;console.log('BROWSER_HUB_OFFLINE')}
      else if(!existsSync(offline)&&!hub){hub=await startHub(hubSettings);console.log('BROWSER_HUB_RECONNECTED')}
      await new Promise(resolve=>setTimeout(resolve,1000))
    }
  }
}catch(error){evidence.status='FAIL';evidence.error=error.message;console.error(error.stack);process.exitCode=1}
finally{
  for(const peer of peers)await bench(peer,'stop').catch(()=>{})
  await hub?.close();writeFileSync(join(root,'p3-group.json'),JSON.stringify(evidence,null,2))
}
