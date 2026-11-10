import assert from 'node:assert/strict'
import {randomUUID} from 'node:crypto'
import {readFileSync,writeFileSync} from 'node:fs'
import {join} from 'node:path'
import {createRequire} from 'node:module'
import {LocalTopology,until} from './local-topology.mjs'
import {benchClient} from './bench-client.mjs'
const nonce=randomUUID().slice(0,8),topology=new LocalTopology({prefix:`hub-onboard-${nonce}-runtime-context`,webPort:3485,mockPort:9185,hubPort:3489})
const {parse,stringify}=createRequire(new URL('../harness/package.json',import.meta.url))('yaml')
const previousOwner=process.env.DSBOT_COMMUNICATION_OWNER_PID;process.env.DSBOT_COMMUNICATION_OWNER_PID=String(process.pid)
const bench=topology.bench.bind(topology)
topology.bench=(peer,action,extra={})=>bench(peer,action,{DSBOT_COMMUNICATION_OWNER_PID:String(process.pid),DSBOT_COMMUNICATION_ONBOARDING_FIXTURE:'1',DSBOT_COMMUNICATION_CONFIG:'',MOCK_WATCH:'NATIVE_CONTEXT_CANARY_',MOCK_LOG_TOOLS:'1',...extra})
topology.startPeer=async peer=>{
 if(!peer.configured){const path=join(peer.home,'profiles/communication-test/cordis.patch.yml'),entries=parse(readFileSync(path,'utf8')),entry=entries.find(item=>item.id==='bot');entry.config={...entry.config,communication:{enabled:true,url:topology.url,instanceId:peer.instanceId,publishedBotIds:[peer.botId],humanDisplayName:`Person ${peer.id}`,pollMs:150}};writeFileSync(path,stringify(entries));peer.configured=true}
 await topology.bench(peer,'start',{DSBOT_COMMUNICATION_CREDENTIAL:peer.credential});peer.client=await benchClient(peer.name,peer.web);peer.api=body=>peer.client.request('/api/communication',body)
 await until(async()=>{const value=await peer.api({endpoint:'state'});return value.connected&&value.reconciled&&!value.reloadRequired},'native Host ready',60000)
}
const evidence={status:'RUNNING',model:'deterministic Mock',cases:[]},record=name=>{evidence.cases.push(name);console.log('PASS',name)}
try{
 await topology.initialize();const [a,b]=topology.peers
 await b.client.api({operation:'production-runtime-context',legacyGateOnce:true})
 const fresh=await b.client.request('/api/bot',{endpoint:'create-bot',payload:{name:'Fresh federation '+nonce,model:'deepseek-official/deepseek-v4-pro'}})
 await b.api({endpoint:'publish-bots',localBotIds:[b.botId,fresh.id]})
 const bot=await until(async()=>{const state=await b.api({endpoint:'state'});return state.connected&&state.reconciled&&!state.reloadRequired&&state.localBots.find(bot=>bot.displayName==='Fresh federation '+nonce)?.principalId},'new Bot published with an opaque identity')
 const group=await topology.group('Required runtime context '+nonce,[])
 await topology.operation(a,'invite',{conversationId:group,inviteePrincipalId:bot})
 await until(async()=>{const state=await b.api({endpoint:'state'}),row=state.conversations.find(item=>item.conversationId===group);return row?.info?.members.some(person=>person.principalId===bot&&person.speakingMode==='passive')},'new Bot is passive in the group')
 const sent=await topology.send(a,group,'COMM-ECHO multi-context-'+nonce,[bot])
 await until(()=>topology.hasText(a,group,'Communication reply multi-context-'+nonce),'original quarantined @ receives one real model reply',60000).catch(async error=>{const fixture=await b.client.api({operation:'production-runtime-context'}),state=await b.api({endpoint:'state'}),raw=await b.client.api({operation:'production-state',conversationId:group});console.log('SAFE_CONTEXT_DIAGNOSTIC',JSON.stringify({fixture,errors:state.errors.map(item=>item.code),inbox:raw.inbox.map(item=>({state:item.ai_state,reason:JSON.parse(item.mapping??'null')?.reason}))}));throw error})
 let inspected=await b.client.api({operation:'production-state',conversationId:group})
 const row=inspected.inbox.find(row=>JSON.parse(row.mapping??'null')?.messageId&&row.ai_state==='accepted')
 assert.ok(row,'actual client admission creates aiAccepted mapping')
 const fixture=await b.client.api({operation:'production-runtime-context'})
 assert.ok(fixture.observedNames.length>=6);assert.equal(fixture.legacyThrown,true);assert.equal(fixture.quarantineSeen,true)
 record('new published passive Bot with required mixed SDK context recovers a legacy quarantine and replies to the original @')
 const logs=()=>readFileSync(join(b.home,'mock.jsonl'),'utf8').trim().split('\n').filter(Boolean).map(line=>JSON.parse(line)).filter(row=>row.communicationBoundary?.isolated)
 assert.ok(logs().length>0);assert.ok(logs().every(row=>row.watchHit===false),'optional private host context is excluded from actual remote model requests')
 assert.equal((await topology.history(a,group)).events.filter(event=>event.message?.content.text==='Communication reply multi-context-'+nonce).length,1)
 record('actual remote model requests exclude optional private-context canaries and automatic recovery publishes exactly one reply')
 await topology.bench(b,'stop');await topology.startPeer(b)
 await b.client.api({operation:'production-runtime-context'})
 await topology.send(a,group,'COMM-ECHO restart-context-'+nonce,[bot])
 await until(()=>topology.hasText(a,group,'Communication reply restart-context-'+nonce),'same published Bot replies after native Host restart',60000)
 inspected=await b.client.api({operation:'production-state',conversationId:group})
 assert.equal(inspected.inbox.filter(row=>row.ai&&row.ai_state==='accepted').length,2)
 assert.ok(logs().every(row=>row.watchHit===false));assert.ok(sent.messageId)
 record('mixed required context and normal later @ delivery remain functional after Host restart')
 evidence.status='PASS'
}catch(error){evidence.status='FAIL';evidence.error=error.code??error.message;throw error}
finally{await topology.close();if(previousOwner===undefined)delete process.env.DSBOT_COMMUNICATION_OWNER_PID;else process.env.DSBOT_COMMUNICATION_OWNER_PID=previousOwner;writeFileSync(join(topology.root,`${topology.prefix}-acceptance.json`),JSON.stringify(evidence,null,2))}
