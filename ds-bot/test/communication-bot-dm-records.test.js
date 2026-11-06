import test from 'node:test'
import assert from 'node:assert/strict'
import { CommunicationRuntime } from '../src/host/federation/runtime.js'
import { CommunicationQueue } from '../src/host/federation/queue-store.js'
import { botDmRecords,botDmContext,participantProfile } from '../src/host/federation/bot-dm-records.js'

function fixture(t) {
 const queue=new CommunicationQueue(':memory:',{instanceId:'a'});t.after(()=>queue.close())
 const human=queue.localPrincipal('human','user','Owner'),bot=queue.localPrincipal('bot','worker','Worker')
 const membership={conversationId:'bot-dm',principalId:bot.principalId,membershipEpoch:'bot-epoch',joinSeq:1,watermark:1,kind:'dm',active:true}
 queue.applyMemberships({memberships:[membership],invites:[]})
 const info={kind:'dm',members:[{principalId:bot.principalId,kind:'bot',displayName:'Worker'},{principalId:'bot:b:expert',kind:'bot',displayName:'Expert'}]}
 const runtime={queue,human,bots:new Map([['worker',bot]]),everReconciled:true,conversations:new Map([['bot-dm',info]]),rt:{botOf:id=>id==='worker'?{id}:null}}
 runtime.member=CommunicationRuntime.prototype.member.bind(runtime)
 runtime.history=CommunicationRuntime.prototype.history.bind(runtime)
 queue.applySync({...membership,events:[{type:'message',eventId:'one',conversationId:'bot-dm',conversationSeq:1,message:{messageId:'one',author:info.members[1],content:{text:'Expert experience recorded'}}}]})
 return {runtime,queue,bot,human,membership,info}
}
test('Bot-to-Bot DMs have a dedicated local-owner record with exact Bot epoch and no Human membership',t=>{
 const f=fixture(t),records=botDmRecords(f.runtime)
 assert.equal(records.length,1);assert.equal(records[0].archive,true);assert.equal(records[0].viewerBotId,'worker')
 assert.equal(records[0].lastMessage.summary,'Expert experience recorded')
 assert.ok(!f.queue.memberships().some(member=>member.principalId===f.human.principalId))
 const input={conversationId:'bot-dm',localBotId:'worker',membershipEpoch:'bot-epoch'}
 const context=botDmContext(f.runtime,input)
 assert.equal(f.runtime.history(context.principalId,input).events[0].message.content.text,'Expert experience recorded')
 assert.throws(()=>botDmContext(f.runtime,{...input,localBotId:'other'}),{code:'BOT_NOT_PUBLISHED'})
 assert.throws(()=>botDmContext(f.runtime,{...input,membershipEpoch:'stale'}),{code:'MEMBERSHIP_REVOKED'})
 f.info.kind='group';assert.throws(()=>botDmContext(f.runtime,input),{code:'FORBIDDEN'})
 assert.deepEqual(botDmRecords(f.runtime),[])
})
test('Bot DM records cannot include Human DMs, foreign Bots, or a Bot removed from the local roster',t=>{
 const f=fixture(t)
 f.info.members[1].kind='human';assert.deepEqual(botDmRecords(f.runtime),[])
 f.info.members[1].kind='bot';f.runtime.bots=new Map();assert.deepEqual(botDmRecords(f.runtime),[])
 f.runtime.bots=new Map([['worker',f.bot]]);f.runtime.rt.botOf=()=>null;assert.deepEqual(botDmRecords(f.runtime),[])
})
test('full member profile reads use the scoped actor and refuse targets outside the current conversation',async t=>{
 const f=fixture(t),calls=[]
 f.runtime.members=async actor=>{calls.push(actor);return f.info}
 f.runtime.transport={request:async(type,input)=>{calls.push({type,input});return {principalId:input.targetPrincipalId,publicProfile:{headline:'Testing expert',summary:'Public testing experience',expertise:['Testing'],version:1}}}}
 const input={conversationId:'bot-dm',localBotId:'worker',membershipEpoch:'bot-epoch',targetPrincipalId:'bot:b:expert'}
 const result=await participantProfile(f.runtime,input)
 assert.equal(result.publicProfile.headline,'Testing expert');assert.equal(calls[0],f.bot.principalId)
 assert.equal(calls[1].input.principalId,f.bot.principalId)
 await assert.rejects(participantProfile(f.runtime,{...input,targetPrincipalId:'bot:c:hidden'}),{code:'NOT_A_MEMBER'})
})
