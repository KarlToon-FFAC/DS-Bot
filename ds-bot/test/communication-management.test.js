import assert from 'node:assert/strict'
import {test} from 'node:test'
import {mkdtempSync,rmSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {CommunicationQueue} from '../src/host/federation/queue-store.js'
import {CommunicationRuntime} from '../src/host/federation/runtime.js'
import {CommunicationTransport} from '../src/host/federation/transport.js'

function fixture(t) {
 const start=CommunicationTransport.prototype.start
 CommunicationTransport.prototype.start=()=>{}
 let runtime
 try{runtime=new CommunicationRuntime({home:tmpdir(),botOf:id=>id==='worker'?{id}:null,readOnly:()=>undefined,ctx:{on:()=>()=>{},systemPrompt:{section:()=>()=>{}}}},
 {url:'ws://127.0.0.1:3190/communication',hubId:'management-test',instanceId:'a',dataPath:':memory:',publishedBotIds:[]},'synthetic',[])}finally{CommunicationTransport.prototype.start=start}
 t.after(()=>runtime.close())
 runtime.transport.request=async()=>assert.fail('local list management must not contact the Hub')
 runtime.everReconciled=true
 const bot=runtime.queue.localPrincipal('bot','worker','Worker');runtime.bots.set('worker',bot)
 const human={conversationId:'group',kind:'group',principalId:runtime.human.principalId,membershipEpoch:'epoch',joinSeq:1,watermark:0,active:true}
 const dm={...human,conversationId:'bot-dm',principalId:bot.principalId,kind:'dm'}
 runtime.queue.applyMemberships({memberships:[human,dm],invites:[]})
 runtime.conversations.set('group',{kind:'group',members:[runtime.human]})
 runtime.conversations.set('bot-dm',{kind:'dm',members:[{...bot,kind:'bot'},{principalId:'bot:b:peer',kind:'bot',displayName:'Peer'}]})
 const input={conversationId:'group',membershipEpoch:'epoch',expectedScope:runtime.conversationPreferencesScope()}
 const message=(member,seq,text,parent)=>runtime.queue.applySync({...member,events:[{type:'message',eventId:`${member.conversationId}:${seq}`,conversationId:member.conversationId,conversationSeq:seq,
 message:{messageId:`${member.conversationId}:${seq}`,author:{principalId:'bot:b:peer',kind:'bot',displayName:'Peer'},replyToMessageId:parent,content:{text}}}]})
 return {runtime,human,dm,input,message}
}

test('hidden groups and pins are independent, persistent, and migrate existing archives without touching history',t=>{
 const root=mkdtempSync(join(tmpdir(),'dsbot-list-prefs-'));t.after(()=>rmSync(root,{recursive:true,force:true}))
 const path=join(root,'queue.sqlite');let queue=new CommunicationQueue(path,{instanceId:'a'})
 queue.setConversationArchived('old-dm',true)
 queue.setConversationHidden('group',true);queue.setConversationPinned('group',true)
 assert.deepEqual(queue.conversationPreferences(),{hiddenConversationIds:['group','old-dm'],pinnedConversationIds:['group']})
 queue.close();queue=new CommunicationQueue(path);t.after(()=>queue.close())
 assert.equal(queue.conversationPreferences().pinnedConversationIds[0],'group')
 queue.setConversationHidden('group',false)
 assert.deepEqual(queue.conversationPreferences(),{hiddenConversationIds:['old-dm'],pinnedConversationIds:['group']})
 assert.throws(()=>queue.setConversationPinned('group','true'),{code:'INVALID_REQUEST'})
 assert.equal(queue.pendingOutbox().length,0)
})

test('deletion hides owner history, references, search and reply ancestry but preserves synchronization and later arrivals',t=>{
 const {runtime:r,human,input,message}=fixture(t)
 message(human,1,'old secret')
 r.manageConversation({...input,hidden:true},'hidden');r.manageConversation({...input,pinned:true},'pinned')
 const cursor=r.queue.cursor('group',human.principalId,'epoch'),receipts=r.queue.pendingReceipts()
 message(human,2,'arrived while confirming','group:1')
 assert.equal(r.manageConversation({...input,through:1,confirmed:true},'delete').status,'deleted')
 assert.equal(r.queue.cursor('group',human.principalId,'epoch'),cursor+1)
 assert.deepEqual(r.queue.pendingReceipts(),receipts)
 assert.deepEqual(r.history(human.principalId,input).events.map(event=>event.conversationSeq),[2])
 assert.equal(r.history(human.principalId,input).hasEarlier,false)
 assert.throws(()=>r.visibleReference(human.principalId,{...input,messageId:'group:1'}),{code:'REFERENCE_NOT_AVAILABLE'})
 assert.throws(()=>r.thread(human.principalId,{...input,messageId:'group:1'}),{code:'REFERENCE_NOT_AVAILABLE'})
 const thread=r.thread(human.principalId,{...input,messageId:'group:2'})
 assert.equal(thread.earlierUnavailable,true);assert.equal(thread.events.length,1)
 assert.equal(r.searchHistory({query:'old secret'}).results.length,0)
 assert.equal(r.searchHistory({query:'confirming'}).results.length,1)
 assert.equal(r.snapshot().conversations[0].lastMessage.summary,'arrived while confirming')
 assert.equal(r.unreadCount(),1)
 assert.equal(r.queue.view('group',human.principalId,'epoch').length,2,'canonical protocol evidence is not corrupted')
 r.manageConversation({...input,pinned:true},'pinned')
 r.manageConversation({...input,through:1,confirmed:true},'delete')
 assert.deepEqual(r.queue.conversationPreferences().pinnedConversationIds,['group'],'a lost deletion response retry cannot undo a later pin')
 r.manageConversation({...input,through:2,confirmed:true},'delete')
 assert.equal(r.snapshot().conversations.length,0);assert.equal(r.unreadCount(),0)
 r.manageConversation({...input,hidden:false},'hidden')
 assert.equal(r.snapshot().conversations[0].lastMessage,null,'explicitly reopening never restores deleted content')
 assert.equal(r.history(human.principalId,input).events.length,0)
 message(human,3,'new message')
 assert.equal(r.snapshot().conversations.length,1)
 assert.deepEqual(r.history(human.principalId,input).events.map(event=>event.conversationSeq),[3])
 assert.equal(r.unreadCount(),1)
})

test('Bot DM owner deletion does not erase the executing Bot history or authorization',t=>{
 const {runtime:r,dm,message,input}=fixture(t)
 message(dm,1,'Bot execution context')
 const body={...input,conversationId:'bot-dm',localBotId:'worker'}
 r.manageConversation({...body,through:1,confirmed:true},'delete')
 assert.equal(r.snapshot().botConversations.length,0)
 assert.equal(r.history(dm.principalId,body,true).events.length,0)
 assert.equal(r.history(dm.principalId,body).events.length,1,'the Bot keeps its actual work context')
 message(dm,2,'New Bot result')
 assert.equal(r.snapshot().botConversations[0].unread,1)
 assert.equal(r.history(dm.principalId,body,true).events.length,1)
 assert.equal(r.queue.member('bot-dm',dm.principalId,'epoch').active,1)
})

test('management refuses stale scopes, epochs, foreign owners, missing confirmations and invalid deletion bounds',t=>{
 const {runtime:r,input}=fixture(t)
 for(const [body,action,code] of [
  [{...input,hidden:true,expectedScope:'old-hub'},'hidden','HUB_SELECTION_CHANGED'],
  [{...input,pinned:true,membershipEpoch:'old'},'pinned','MEMBERSHIP_REVOKED'],
  [{...input,pinned:true,membershipEpoch:undefined},'pinned','MEMBERSHIP_EPOCH_REQUIRED'],
  [{...input,localBotId:'foreign'},'hidden','BOT_NOT_PUBLISHED'],
  [{...input,through:0},'delete','CONVERSATION_DELETE_CONFIRMATION_REQUIRED'],
  [{...input,through:1,confirmed:true},'delete','INVALID_CURSOR'],
  [{...input,through:-1,confirmed:true},'delete','INVALID_CURSOR']
 ])assert.throws(()=>r.manageConversation(body,action),{code})
 r.rt.readOnly=()=>true
 assert.throws(()=>r.manageConversation({...input,hidden:true},'hidden'),{code:'COMMUNICATION_READ_ONLY'})
 assert.equal(r.queue.deletedThrough('group'),null)
 assert.equal(r.queue.pendingOutbox().length,0)
})

test('a deletion boundary survives restart, never moves backward and is isolated to one Hub queue',t=>{
 const root=mkdtempSync(join(tmpdir(),'dsbot-delete-view-'));t.after(()=>rmSync(root,{recursive:true,force:true}))
 const path=join(root,'queue.sqlite');let q=new CommunicationQueue(path,{instanceId:'a'})
 q.deleteConversationHistory('group',10);q.close();q=new CommunicationQueue(path);t.after(()=>q.close())
 assert.equal(q.deletedThrough('group'),10)
 q.deleteConversationHistory('group',5);assert.equal(q.deletedThrough('group'),10)
 const other=new CommunicationQueue(':memory:',{instanceId:'a'});t.after(()=>other.close())
 assert.equal(other.deletedThrough('group'),null)
})
