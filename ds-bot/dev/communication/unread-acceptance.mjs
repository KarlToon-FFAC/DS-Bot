import assert from 'node:assert/strict'
import {randomUUID} from 'node:crypto'
import {writeFileSync} from 'node:fs'
import {join} from 'node:path'
import {LocalTopology,until} from './local-topology.mjs'
const nonce=randomUUID().slice(0,8),topology=new LocalTopology({prefix:`unread-${nonce}`,webPort:3435,mockPort:9135,hubPort:3439})
const evidence={status:'RUNNING',model:'deterministic Mock',cases:[]}
const pass=name=>{evidence.cases.push(name);console.log('PASS',name)}
try{
 await topology.initialize();const [a,b]=topology.peers
 const group=await topology.group('Unread group '+nonce,[b.human])
 await topology.send(b,group,'Ordinary unread '+nonce)
 await until(async()=>(await a.api({endpoint:'state'})).conversations.find(item=>item.conversationId===group)?.unread===1,'remote Human message stays unread without opening the GUI')
 assert.equal((await a.client.request('/api/bot',{endpoint:'state'})).remoteUnreadCount,1)
 pass('group unread appears in local sidebar metadata without opening remote communication')
 let page=await a.api({endpoint:'history',conversationId:group})
 await a.api({endpoint:'read',conversationId:group,membershipEpoch:page.membershipEpoch,seq:page.watermark})
 assert.equal((await a.api({endpoint:'state'})).conversations.find(item=>item.conversationId===group).unread,0)
 assert.equal((await a.client.request('/api/bot',{endpoint:'state'})).remoteUnreadCount,0)
 pass('exact visible group watermark clears the conversation and local entry counts')
 const dm=(await topology.operation(b,'dm',{otherPrincipalId:a.bot})).conversationId
 await topology.send(b,dm,'COMM-ECHO owner-unread-'+nonce)
 await until(()=>topology.hasText(b,dm,'Communication reply owner-unread-'+nonce),'actual remote Bot reply')
 let record=await until(async()=>{const row=(await a.api({endpoint:'state'})).botConversations.find(item=>item.conversationId===dm);return row?.unread>=2&&row},'Bot DM owner has unread incoming message and reply')
 const unread=record.unread;assert.equal(record.info.members.some(person=>person.principalId===a.human),false)
 await topology.bench(a,'stop');await topology.startPeer(a)
 record=await until(async()=>{const row=(await a.api({endpoint:'state'})).botConversations.find(item=>item.conversationId===dm);return row?.unread===unread&&row},'Bot DM unread survives native Host restart')
 assert.equal((await a.client.request('/api/bot',{endpoint:'state'})).remoteUnreadCount,unread)
 pass('owned Bot DM unread is durable across Host restart without inventing Human membership')
 await a.api({endpoint:'set-conversation-archived',conversationId:dm,localBotId:a.botId,membershipEpoch:record.membershipEpoch,archived:true,expectedScope:(await a.api({endpoint:'state'})).conversationPreferencesScope})
 assert.equal((await a.client.request('/api/bot',{endpoint:'state'})).remoteUnreadCount,0)
 assert.equal((await a.api({endpoint:'state'})).botConversations.find(item=>item.conversationId===dm).unread,unread)
 pass('archived private rows retain unread while the main entry count excludes them')
 page=await a.api({endpoint:'bot-dm-history',conversationId:dm,localBotId:a.botId,membershipEpoch:record.membershipEpoch})
 await assert.rejects(a.api({endpoint:'bot-dm-read',conversationId:dm,localBotId:a.botId,membershipEpoch:'stale',seq:page.watermark}),{code:'MEMBERSHIP_REVOKED'})
 await a.api({endpoint:'bot-dm-read',conversationId:dm,localBotId:a.botId,membershipEpoch:record.membershipEpoch,seq:page.watermark})
 assert.equal((await a.api({endpoint:'state'})).botConversations.find(item=>item.conversationId===dm).unread,0)
 await topology.bench(a,'stop');await topology.startPeer(a)
 await until(async()=>(await a.api({endpoint:'state'})).botConversations.find(item=>item.conversationId===dm)?.unread===0,'owner inspection survives another Host restart')
 pass('owner-local inspection clears exact Bot DM epoch and stays cleared after restart')
 evidence.status='PASS'
}catch(error){evidence.status='FAIL';evidence.error=error.code??error.message;throw error}
finally{await topology.close();writeFileSync(join(topology.root,`${topology.prefix}-acceptance.json`),JSON.stringify(evidence,null,2))}
