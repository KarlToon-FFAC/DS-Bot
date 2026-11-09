import assert from 'node:assert/strict'
import {randomUUID} from 'node:crypto'
import {writeFileSync} from 'node:fs'
import {join} from 'node:path'
import {LocalTopology,until} from './local-topology.mjs'
const nonce=randomUUID().slice(0,8),topology=new LocalTopology({prefix:`history-${nonce}`,webPort:3455,mockPort:9155,hubPort:3459})
const evidence={status:'RUNNING',model:'deterministic Mock',cases:[]},pass=name=>{evidence.cases.push(name);console.log('PASS',name)}
try{
 await topology.initialize();const [a,b]=topology.peers,group=await topology.group('History '+nonce,[b.human]),ids=[]
 await until(async()=>(await b.api({endpoint:'state'})).conversations.some(item=>item.conversationId===group&&item.speakingMode==='speak'),'sender has synchronized its own Human group membership')
 for(let i=0;i<180;i++){const text=`History message ${i} ${i%30===0?'needle native '+nonce:''}`;ids.push(await topology.send(b,group,text))}
 await until(async()=>{const state=await a.api({endpoint:'state'});return state.conversations.find(item=>item.conversationId===group)?.unread===180},'180 canonical remote Human messages synchronized',90000)
 let page=await a.api({endpoint:'history',conversationId:group,limit:50})
 assert.equal(page.events.length,50);assert.equal(page.hasEarlier,true);assert.equal(page.hasLater,false)
 const recent=page.events.at(-1).message.messageId
 const older=await a.api({endpoint:'history',conversationId:group,limit:50,before:page.nextBefore})
 assert.equal(older.events.length,50);assert.equal(older.hasLater,true);assert.ok(older.events.at(-1).conversationSeq<page.events[0].conversationSeq)
 pass('real synchronized history exposes bounded recent and earlier pages')
 let found=await a.api({endpoint:'search-history',query:'needle native '+nonce,conversationId:group,limit:2}),results=[...found.results]
 while(found.hasMore){found=await a.api({endpoint:'search-history',query:'needle native '+nonce,conversationId:group,limit:2,cursor:found.nextCursor});results.push(...found.results)}
 assert.equal(results.length,6);assert.equal(new Set(results.map(item=>item.messageId)).size,6)
 assert.equal(results.some(item=>item.messageId===ids[0].messageId),true)
 assert.equal((await a.api({endpoint:'state'})).conversations.find(item=>item.conversationId===group).unread,180)
 const reference=await a.api({endpoint:'reference',conversationId:group,messageId:results.at(-1).messageId})
 page=await a.api({endpoint:'history',conversationId:group,membershipEpoch:results.at(-1).membershipEpoch,limit:50,before:reference.conversationSeq+25})
 assert.ok(page.events.some(event=>event.message?.messageId===reference.message.messageId));assert.ok(page.events.length<=50)
 pass('old canonical text is searchable in pages and an exact bounded jump never acknowledges unread')
 await topology.bench(a,'stop');await topology.startPeer(a)
 assert.equal((await a.api({endpoint:'history',conversationId:group,limit:50})).events.at(-1).message.messageId,recent)
 assert.equal((await a.api({endpoint:'search-history',query:'needle native '+nonce,conversationId:group,limit:50})).results.length,6)
 pass('recent pagination and old-message search survive native Host restart')
 const dm=(await topology.operation(b,'dm',{otherPrincipalId:a.bot})).conversationId
 await topology.send(b,dm,'COMM-ECHO search-private-'+nonce)
 await until(()=>topology.hasText(b,dm,'Communication reply search-private-'+nonce),'actual remote Bot private reply')
 const record=await until(async()=>(await a.api({endpoint:'state'})).botConversations.find(item=>item.conversationId===dm),'owned private history projection')
 await a.api({endpoint:'set-conversation-archived',conversationId:dm,localBotId:a.botId,membershipEpoch:record.membershipEpoch,archived:true,expectedScope:(await a.api({endpoint:'state'})).conversationPreferencesScope})
 found=await a.api({endpoint:'search-history',query:'search-private-'+nonce})
 assert.equal(found.results.length,2);assert.ok(found.results.every(item=>item.conversationId===dm&&item.localBotId===a.botId))
 await assert.rejects(a.api({endpoint:'search-history',query:'search-private-'+nonce,conversationId:dm,membershipEpoch:'stale'}),{code:'MEMBERSHIP_REVOKED'})
 pass('archived owned Bot DM search uses its exact Bot epoch without adding the Human')
 evidence.status='PASS'
}catch(error){evidence.status='FAIL';evidence.error=error.code??error.message;throw error}
finally{await topology.close();writeFileSync(join(topology.root,`${topology.prefix}-acceptance.json`),JSON.stringify(evidence,null,2))}
