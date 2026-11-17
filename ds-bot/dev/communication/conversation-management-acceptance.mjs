import assert from 'node:assert/strict'
import {randomUUID} from 'node:crypto'
import {LocalTopology,until} from './local-topology.mjs'
const topology=new LocalTopology({prefix:'conversation-management-'+randomUUID().slice(0,6),webPort:3571,mockPort:9271,hubPort:3579})
try{
 await topology.initialize()
 const [a,b]=topology.peers,conversationId=await topology.group('Conversation management',[b.human])
 await until(async()=>(await b.api({endpoint:'state'})).conversations.some(item=>item.conversationId===conversationId&&item.speakingMode==='speak'),'remote Human sees its speaking permission')
 const first=await topology.send(b,conversationId,'Old visible history')
 await until(()=>topology.hasText(a,conversationId,'Old visible history'),'first synchronized history')
 const state=await a.api({endpoint:'state'}),member=state.conversations.find(item=>item.conversationId===conversationId)
 const scope={conversationId,membershipEpoch:member.membershipEpoch,expectedScope:state.conversationPreferencesScope}
 await a.api({endpoint:'set-conversation-hidden',...scope,hidden:true})
 await a.api({endpoint:'set-conversation-pinned',...scope,pinned:true})
 await topology.bench(a,'stop');await topology.startPeer(a)
 const reopened=await a.api({endpoint:'state'})
 assert.ok(reopened.hiddenConversationIds.includes(conversationId));assert.ok(reopened.pinnedConversationIds.includes(conversationId))
 assert.ok(await topology.hasText(a,conversationId,'Old visible history'))
 console.log('PASS hide and pin survive a real Host restart without changing membership or history')
 await a.api({endpoint:'set-conversation-hidden',...scope,hidden:false})
 const through=(await a.api({endpoint:'state'})).conversations.find(item=>item.conversationId===conversationId).cachedWatermark
 await a.api({endpoint:'delete-conversation',...scope,through,confirmed:true})
 assert.equal((await a.api({endpoint:'state'})).conversations.some(item=>item.conversationId===conversationId),false)
 assert.equal((await topology.history(a,conversationId)).events.length,0)
 await assert.rejects(a.api({endpoint:'reference',...scope,messageId:first.messageId}),/REFERENCE_NOT_AVAILABLE/)
 assert.equal((await a.api({endpoint:'search-history',query:'Old visible history'})).results.length,0)
 assert.ok(await topology.hasText(b,conversationId,'Old visible history'),'other participant keeps the record')
 console.log('PASS deletion removes local owner history and references/search while the remote participant retains history')
 await topology.send(b,conversationId,'New message after deletion')
 await until(()=>topology.hasText(a,conversationId,'New message after deletion'),'new messages restore the conversation')
 await a.api({endpoint:'delete-conversation',...scope,through,confirmed:true})
 const events=(await topology.history(a,conversationId)).events.filter(event=>event.type==='message')
 assert.equal(events.length,1);assert.equal(events[0].message.content.text,'New message after deletion')
 await topology.bench(a,'stop');await topology.startPeer(a)
 assert.ok(await topology.hasText(a,conversationId,'New message after deletion'))
 assert.equal(await topology.hasText(a,conversationId,'Old visible history'),false)
 console.log('PASS new arrivals, same-cutoff retries and restart cannot restore deleted history or discard new messages')
}finally{await topology.close()}
