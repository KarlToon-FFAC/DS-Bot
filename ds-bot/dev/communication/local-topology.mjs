import assert from 'node:assert/strict'
import { randomUUID,randomBytes } from 'node:crypto'
import { spawn,fork } from 'node:child_process'
import { once } from 'node:events'
import { readFileSync,existsSync,mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { CommunicationQueue } from '../../src/host/federation/queue-store.js'
import { benchClient,repo } from './bench-client.mjs'

export const until=async(check,label,timeout=45000)=>{const deadline=Date.now()+timeout;while(Date.now()<deadline){const value=await check();if(value)return value;await new Promise(resolve=>setTimeout(resolve,100))}throw new Error(`Timeout: ${label}`)}
export class LocalTopology {
  constructor({prefix='p4',webPort=3103,mockPort=8803,hubPort=3192,open=false}={}){
    const runId=process.env.DSBOT_TEST_RUN_ID
    if(runId){assert.match(runId,/^[a-z0-9-]{1,32}$/);prefix=`${prefix}-${runId}`}
    this.prefix=prefix;this.hubPort=hubPort;this.open=open;this.root=join(repo,'.dsh-test-tools');mkdirSync(this.root,{recursive:true})
    this.peers=['a','b'].map((id,index)=>({id,name:`${prefix}-${id}`,web:webPort+index,mock:mockPort+index,credential:randomBytes(32).toString('hex')}))
    this.url=`ws://127.0.0.1:${hubPort}/communication`;this.child=null;this.sequence=0
  }
  async bench(peer,action,extra={}){
    await new Promise((resolve,reject)=>{
      const child=spawn(process.execPath,[join(import.meta.dirname,'bench.mjs'),action,peer.name,String(peer.web),String(peer.mock)],{windowsHide:true,stdio:['ignore','pipe','pipe'],env:{...process.env,...extra}})
      let error='';child.stdout.on('data',()=>{});child.stderr.on('data',data=>{error+=data});child.once('error',reject)
      child.once('exit',code=>code===0?resolve():reject(new Error(`${peer.name} ${action}: ${error.slice(0,1000)}`)))
    })
  }
  async initialize(){
    for(const peer of this.peers){
      peer.home=join(repo,`.dsh-test-${peer.name}`)
      await this.bench(peer,'stop')
      if(!existsSync(join(peer.home,'bot/state.json'))){
        await this.bench(peer,'start',{DSBOT_WEB_OPEN:'0'});await benchClient(peer.name,peer.web);await this.bench(peer,'stop')
      }
      peer.botId=JSON.parse(readFileSync(join(peer.home,'bot/state.json'),'utf8')).mainBotIds[0]
      const queue=new CommunicationQueue(join(peer.home,'bot/communication.sqlite'))
      peer.instanceId=queue.instanceId
      peer.human=queue.localPrincipal('human','local-user',`Person ${peer.id.toUpperCase()}`).principalId
      peer.bot=queue.localPrincipal('bot',peer.botId,'Chief').principalId;queue.close()
    }
    await this.startHub()
    for(const peer of this.peers){
      await this.startPeer(peer)
      await peer.client.request('/api/bot',{endpoint:'update-bot',payload:{id:peer.botId,model:'deepseek-official/deepseek-v4-pro'}})
    }
    await until(async()=> (await this.peers[0].api({endpoint:'state'})).contacts.length===4&&(await this.peers[1].api({endpoint:'state'})).contacts.length===4,'four paired contacts')
  }
  async startHub(){
    const child=fork(join(import.meta.dirname,'hub-fixture.mjs'),[join(this.root,`${this.prefix}-hub.sqlite`),String(this.hubPort),join(this.root,`${this.prefix}-hub-checkpoint.json`)],{
      windowsHide:true,stdio:['ignore','ignore','ignore','ipc'],env:{...process.env,DSBOT_TEST_PEERS:JSON.stringify(this.peers.map(peer=>({instanceId:peer.instanceId,instanceLabel:`Instance ${peer.id.toUpperCase()}`,credential:peer.credential})))}})
    this.child=child
    await new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>{cleanup();reject(new Error('Owned Hub startup timed out'))},15000)
      const message=value=>{if(value.type==='ready'){cleanup();resolve()}}
      const exit=()=>{cleanup();reject(new Error('Owned Hub exited before readiness'))}
      const cleanup=()=>{clearTimeout(timer);child.off('message',message);child.off('exit',exit)}
      child.on('message',message);child.once('exit',exit)
    })
  }
  async stopHub(){if(!this.child||this.child.exitCode!==null||this.child.signalCode!==null)return;const done=once(this.child,'exit');this.child.kill('SIGKILL');await done}
  async hub(command,value){
    const id=String(++this.sequence),child=this.child
    return new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>{cleanup();reject(new Error(`Hub ${command} timed out`))},10000)
      const listener=message=>{if(message.id!==id)return;cleanup();if(message.ok)resolve(message.value);else reject(new Error('Hub fixture rejected operation'))}
      const cleanup=()=>{clearTimeout(timer);child.off('message',listener)}
      child.on('message',listener);child.send({id,command,value})
    })
  }
  async startPeer(peer,extra={},{connectClient=true,allowOffline=false}={}){
    await this.bench(peer,'start',{DSBOT_COMMUNICATION_CONFIG:JSON.stringify({enabled:true,url:this.url,instanceId:peer.instanceId,publishedBotIds:[peer.botId],humanDisplayName:`Person ${peer.id.toUpperCase()}`,pollMs:150}),
      DSBOT_COMMUNICATION_CREDENTIAL:peer.credential,DSBOT_WEB_OPEN:this.open?'1':'0',MOCK_LOG_TOOLS:'1',...extra})
    if(!connectClient)return
    peer.client=await benchClient(peer.name,peer.web);peer.api=body=>peer.client.request('/api/communication',body)
    await until(async()=>!(await peer.client.request('/api/bot',{endpoint:'state'})).readOnly,'test team writer lease available',75000)
    if(!allowOffline)await until(async()=>{const state=await peer.api({endpoint:'state'});return state.reconciled||state.error==='HISTORY_GAP'},'communication initial reconciliation or explicit gap diagnostic')
  }
  db(peer){return new DatabaseSync(join(peer.home,'bot/communication.sqlite'),{readOnly:true})}
  async operation(peer,endpoint,input){return peer.api({endpoint,operationId:randomUUID(),...input})}
  async group(title,members=[this.peers[1].bot],{allowSpeaking=true}={}){
    const [a]=this.peers,{conversationId}=await this.operation(a,'create-group',{title})
    for(const principalId of members){
      const owner=this.peers.find(peer=>[peer.human,peer.bot].includes(principalId));assert.ok(owner)
      const invite=await this.operation(a,'invite',{conversationId,inviteePrincipalId:principalId})
      if(!invite.joined)await this.operation(owner,'accept',{inviteId:invite.inviteId,recipientPrincipalId:principalId})
      const member=await until(async()=>{const value=(await a.api({endpoint:'state'})).conversations.find(item=>item.conversationId===conversationId);return value?.info?.members.some(person=>person.principalId===principalId)&&value.info.membershipVersion===value.membershipVersion&&value},'owner sees accepted membership before next mutation')
      if(allowSpeaking){
        await this.operation(a,'policy',{conversationId,targetPrincipalId:principalId,expectedVersion:member.membershipVersion,speakingMode:principalId.startsWith('bot:')?'active':'speak'})
      }
    }
    return conversationId
  }
  history(peer,conversationId){return peer.api({endpoint:'history',conversationId,limit:100})}
  async hasText(peer,conversationId,text){
    try{return (await this.history(peer,conversationId)).events.some(event=>event.message?.content.text===text)}
    catch(error){if(error.message.includes('AUTHORIZATION_PENDING'))return false;throw error}
  }
  async send(peer,conversationId,text,mentions=[],extra={}){const message={endpoint:'send',conversationId,text,mentions,messageId:randomUUID(),clientCreatedAt:new Date().toISOString(),...extra};await peer.api(message);return message}
  async close(){for(const peer of this.peers)await this.bench(peer,'stop').catch(()=>{});await this.stopHub()}
}
