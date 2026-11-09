import assert from 'node:assert/strict'
import {test} from 'node:test'
import {CommunicationQueue} from '../src/host/federation/queue-store.js'
import {CommunicationRuntime} from '../src/host/federation/runtime.js'
function fixture(t){
 const queue=new CommunicationQueue(':memory:',{instanceId:'a'});t.after(()=>queue.close())
 const human=queue.localPrincipal('human','owner','Owner'),bot=queue.localPrincipal('bot','worker','Worker'),other=queue.localPrincipal('bot','unpublished','Other')
 const peer={principalId:'human:b:peer',kind:'human',displayName:'Peer'}
 const membership=(id,principal,epoch,joinSeq=1,kind='group')=>({conversationId:id,principalId:principal,membershipEpoch:epoch,joinSeq,kind,active:true,watermark:300})
 const humanGroup=membership('group',human.principalId,'human-epoch',20),botGroup=membership('group',bot.principalId,'bot-epoch'),dm=membership('owned-dm',bot.principalId,'dm-epoch',1,'dm'),hidden=membership('hidden-dm',other.principalId,'hidden-epoch',1,'dm')
 queue.applyMemberships({memberships:[humanGroup,botGroup,dm,hidden]})
 const event=(id,seq,text)=>({type:'message',conversationId:id,conversationSeq:seq,eventId:`${id}-${seq}`,serverAcceptedAt:new Date(Date.UTC(2026,10,9,0,0,seq)).toISOString(),message:{messageId:`${id}-message-${seq}`,author:peer,content:{text,format:'markdown'}}})
 const text=seq=>seq===4?'prejoin secret':seq%7===0?'Needle 中文 '+seq:seq===25?'literal %_ characters':'Ordinary '+seq
 for(const member of [humanGroup,botGroup])queue.applySync({...member,events:Array.from({length:301-member.joinSeq},(_,i)=>event('group',i+member.joinSeq,text(i+member.joinSeq)))})
 queue.applySync({...dm,events:[event('owned-dm',1,'Needle owned Bot private help')]})
 queue.applySync({...hidden,events:[event('hidden-dm',1,'Needle must stay hidden')]})
 const runtime={queue,human,bots:new Map([['worker',bot]]),rt:{botOf:id=>id==='worker'?{id}:null},everReconciled:true,conversations:new Map([['group',{kind:'group',members:[human,bot,peer]}],['owned-dm',{kind:'dm',members:[bot,peer]}],['hidden-dm',{kind:'dm',members:[other,peer]}]])}
 for(const name of ['member','history','searchHistory'])runtime[name]=CommunicationRuntime.prototype[name].bind(runtime)
 return {queue,runtime,event,humanGroup,dm}
}
test('history starts with a bounded recent page and reports accurate earlier/later edges',t=>{
 const {runtime}=fixture(t),input={conversationId:'group',membershipEpoch:'human-epoch',limit:50}
 const first=runtime.history(runtime.human.principalId,input)
 assert.equal(first.events.length,50);assert.equal(first.events[0].conversationSeq,251);assert.equal(first.hasEarlier,true);assert.equal(first.hasLater,false)
 const earlier=runtime.history(runtime.human.principalId,{...input,before:first.nextBefore})
 assert.equal(earlier.events[0].conversationSeq,201);assert.equal(earlier.events.at(-1).conversationSeq,250);assert.equal(earlier.hasLater,true)
 const next=runtime.history(runtime.human.principalId,{...input,after:250,latest:false})
 assert.deepEqual(next.events,first.events)
})
test('literal history search covers old messages and owned Bot DMs without borrowing another scope',t=>{
 const {runtime,queue}=fixture(t),before=queue.pendingReceipts()
 let page=runtime.searchHistory({query:'NEEDLE 中文',limit:5}),results=[...page.results]
 while(page.hasMore){page=runtime.searchHistory({query:'NEEDLE 中文',limit:5,cursor:page.nextCursor});results.push(...page.results)}
 assert.equal(results.length,40);assert.equal(new Set(results.map(item=>item.messageId)).size,40)
 assert.equal(results.at(-1).conversationSeq,21)
 assert.deepEqual(runtime.searchHistory({query:'prejoin secret'}).results,[])
 assert.equal(runtime.searchHistory({query:'literal %_'}).results[0].conversationSeq,25)
 const privateHit=runtime.searchHistory({query:'owned Bot private'}).results[0]
 assert.equal(privateHit.conversationId,'owned-dm');assert.equal(privateHit.localBotId,'worker')
 assert.equal(runtime.searchHistory({query:'must stay hidden'}).results.length,0)
 assert.deepEqual(queue.pendingReceipts(),before,'search cannot mark history read or accept AI input')
 assert.throws(()=>runtime.searchHistory({query:'Needle',conversationId:'hidden-dm'}),{code:'NOT_A_MEMBER'})
 assert.throws(()=>runtime.searchHistory({query:'Needle',conversationId:'owned-dm',membershipEpoch:'stale'}),{code:'MEMBERSHIP_REVOKED'})
})
test('search pages reject changed scopes/cursors and cannot see beyond a contiguous cursor',t=>{
 const {runtime,queue,event,humanGroup}=fixture(t),first=runtime.searchHistory({query:'Needle',limit:3})
 assert.throws(()=>runtime.searchHistory({query:'another query',cursor:first.nextCursor}),{code:'HISTORY_SEARCH_CHANGED'})
 assert.throws(()=>runtime.searchHistory({query:'Needle',cursor:'invalid'}),{code:'INVALID_CURSOR'})
 queue.applySync({...humanGroup,events:[event('group',302,'Future needle beyond missing seq 301')]})
 assert.equal(runtime.searchHistory({query:'Future needle'}).results.length,0)
 queue.applyMemberships({memberships:[{...humanGroup,active:false}]})
 assert.throws(()=>runtime.searchHistory({query:'Needle',cursor:first.nextCursor}),{code:'HISTORY_SEARCH_CHANGED'})
 for(const query of ['', '   ', 'a'.repeat(201)])assert.throws(()=>runtime.searchHistory({query}),{code:'INVALID_REQUEST'})
})
