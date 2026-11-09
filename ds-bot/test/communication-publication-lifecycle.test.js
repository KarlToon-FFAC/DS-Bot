import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CommunicationQueue } from '../src/host/federation/queue-store.js'
import { CommunicationTransport } from '../src/host/federation/transport.js'
import { CommunicationRuntime } from '../src/host/federation/runtime.js'
import { botDmRecords, botDmContext } from '../src/host/federation/bot-dm-records.js'
import { cancelRevokedWork } from '../src/host/federation/work-tools.js'

test('publication lifetime survives restart, preserves upgrades and rotates after withdrawal or a coalesced generation change', t => {
  const dir=mkdtempSync(join(tmpdir(),'publication-lifetime-')), path=join(dir,'queue.sqlite')
  let queue=new CommunicationQueue(path,{instanceId:'local'})
  t.after(()=>{queue.close();rmSync(dir,{recursive:true,force:true})})
  const bots=[{id:'worker',name:'Same name'}], legacy=queue.localPrincipal('bot','worker','Same name')
  const first=queue.reconcileBotPublications(bots)[0]
  assert.equal(first.principalId,legacy.principalId)
  queue.close();queue=new CommunicationQueue(path,{instanceId:'local'})
  assert.equal(queue.reconcileBotPublications(bots)[0].principalId,first.principalId)
  queue.reconcileBotPublications([])
  const second=queue.reconcileBotPublications(bots)[0]
  assert.notEqual(second.principalId,first.principalId)
  assert.equal(queue.retiredBots()[0].principalId,first.principalId)
  const third=queue.reconcileBotPublications(bots,{worker:'withdrawal-while-offline'})[0]
  assert.notEqual(third.principalId,second.principalId)
  assert.equal(queue.reconcileBotPublications(bots,{worker:'withdrawal-while-offline'})[0].principalId,third.principalId)
  const restored=queue.reconcileBotPublications(bots)[0]
  assert.notEqual(restored.principalId,first.principalId)
  assert.notEqual(restored.principalId,third.principalId)
})

test('retiring the local Bot revokes pending work and retains the exact original private chat record after deletion', async t => {
  const queue=new CommunicationQueue(':memory:',{instanceId:'local'});t.after(()=>queue.close())
  const [bot]=queue.reconcileBotPublications([{id:'worker',name:'Worker'}])
  const member={conversationId:'private',principalId:bot.principalId,membershipEpoch:'old-epoch',joinSeq:1,watermark:1,kind:'dm',active:true}
  queue.applyMemberships({memberships:[member]})
  const remote={principalId:'bot:remote:expert',kind:'bot',displayName:'Expert'}
  const event={eventId:'event',type:'message',conversationId:'private',conversationSeq:1,message:{messageId:'message',author:remote,content:{text:'Prior answer'}}}
  queue.receive({deliveryId:'delivery',messageId:'message',conversationId:'private',recipientPrincipalId:bot.principalId,membershipEpoch:'old-epoch',ai:true,notify:false,event})
  const binding=queue.binding('private',bot.principalId,'old-epoch','worker'), controller=new AbortController()
  queue.reconcileBotPublications([])
  const runtime={queue,bots:new Map(),human:{principalId:'human:local:owner'},everReconciled:true,rt:{botOf:()=>null},conversations:new Map([['private',{kind:'dm',members:[{...bot,retired:true},remote]}]]),workControllers:new Map([['work',{controller,binding}]])}
  runtime.member=CommunicationRuntime.prototype.member.bind(runtime)
  cancelRevokedWork(runtime)
  assert.equal(controller.signal.aborted,true)
  assert.equal(queue.pendingAi().length,0)
  assert.equal(botDmRecords(runtime)[0].viewerPrincipalId,bot.principalId)
  const input={conversationId:'private',localBotId:'worker',membershipEpoch:'old-epoch'}
  assert.equal(botDmContext(runtime,input).principalId,bot.principalId)
  assert.equal(queue.view('private',bot.principalId,'old-epoch')[0].message.content.text,'Prior answer')
  const [fresh]=queue.reconcileBotPublications([{id:'worker',name:'Worker'}]);runtime.bots.set('worker',fresh);runtime.rt.botOf=()=>({id:'worker'})
  assert.equal(botDmContext(runtime,input).principalId,bot.principalId)
  await assert.rejects(CommunicationRuntime.prototype.authorize.call(runtime,binding),{code:'BOT_RETIRED'})
  runtime.owners=new Map([['old-session',binding]])
  assert.throws(()=>CommunicationRuntime.prototype.actorForSession.call(runtime,'old-session'),{code:'BOT_RETIRED'})
})

test('failed publication reconciliation rolls back retirement and keeps pending state usable', t => {
  const queue=new CommunicationQueue(':memory:',{instanceId:'local'});t.after(()=>queue.close())
  const [bot]=queue.reconcileBotPublications([{id:'worker',name:'Worker'}])
  queue.beforeCommit=()=>{throw new Error('disk commit failed')}
  assert.throws(()=>queue.reconcileBotPublications([]),/disk commit failed/)
  queue.beforeCommit=undefined
  assert.equal(queue.isRetiredBot(bot.principalId),false)
  assert.equal(queue.reconcileBotPublications([{id:'worker',name:'Worker'}])[0].principalId,bot.principalId)
})

test('a Hub without lifetime support is rejected before any identity registration', async t => {
  const start=CommunicationTransport.prototype.start
  CommunicationTransport.prototype.start=()=>{}
  let runtime
  try { runtime=new CommunicationRuntime({home:tmpdir(),ctx:{on:()=>()=>{},systemPrompt:{section:()=>()=>{}}},botOf:()=>null},
    {url:'ws://127.0.0.1:3190/communication',dataPath:':memory:',instanceId:'local'},'synthetic',[]) }
  finally { CommunicationTransport.prototype.start=start }
  t.after(()=>runtime.close())
  let registrations=0;runtime.transport.request=async()=>{registrations++}
  await assert.rejects(runtime.transport.onConnect({capabilities:['principal-publication']}),{code:'BOT_PUBLICATION_MIGRATION_REQUIRED'})
  assert.equal(registrations,0)
})

test('remote DM retirement cancels pending and running native work without removing readable history',t=>{
  const queue=new CommunicationQueue(':memory:',{instanceId:'local'});t.after(()=>queue.close())
  const [bot]=queue.reconcileBotPublications([{id:'worker',name:'Worker'}])
  const member={conversationId:'private',principalId:bot.principalId,membershipEpoch:'epoch',joinSeq:1,watermark:1,kind:'dm',active:true}
  queue.applyMemberships({memberships:[member]})
  const event={eventId:'event',type:'message',conversationId:'private',conversationSeq:1,message:{messageId:'message',author:{principalId:'bot:remote:expert',kind:'bot'},content:{text:'Prior work'}}}
  queue.receive({deliveryId:'delivery',messageId:'message',conversationId:'private',recipientPrincipalId:bot.principalId,membershipEpoch:'epoch',ai:true,notify:false,event})
  const binding=queue.binding('private',bot.principalId,'epoch','worker'),controller=new AbortController()
  queue.applyMemberships({memberships:[{...member,retiredPeer:true}]})
  cancelRevokedWork({queue,workControllers:new Map([['work',{binding,controller}]])})
  assert.equal(controller.signal.aborted,true);assert.equal(queue.pendingAi().length,0)
  assert.equal(queue.view('private',bot.principalId,'epoch')[0].message.content.text,'Prior work')
})

test('a migrated Hub or restored old local backup rotates a principal already retired at the Hub',async t=>{
  const start=CommunicationTransport.prototype.start
  CommunicationTransport.prototype.start=()=>{}
  let runtime
  try { runtime=new CommunicationRuntime({home:tmpdir(),ctx:{on:()=>()=>{},systemPrompt:{section:()=>()=>{}}},botOf:id=>({id,name:'Worker'})},
    {url:'ws://127.0.0.1:3190/communication',dataPath:':memory:',instanceId:'local',publishedBotIds:['worker']},'synthetic',[]) }
  finally { CommunicationTransport.prototype.start=start }
  t.after(()=>runtime.close())
  const original=runtime.bots.get('worker'),registrations=[]
  let published
  runtime.transport.request=async(type,input)=>{
    if(type==='principal.publication'){published=input.principalIds;return input}
    if(type==='principal.register'){
      registrations.push(input)
      if(input.localId===original.localId)throw Object.assign(new Error('retired'),{code:'BOT_RETIRED'})
      return {displayName:input.displayName}
    }
    throw new Error('unexpected request')
  }
  await runtime.transport.onConnect({capabilities:['principal-publication','bot-publication-generations']})
  const fresh=runtime.bots.get('worker')
  assert.notEqual(fresh.principalId,original.principalId)
  assert.ok(runtime.queue.isRetiredBot(original.principalId))
  assert.deepEqual(published,[fresh.principalId]);assert.equal(registrations.filter(value=>value.kind==='bot').length,2)
  assert.equal(runtime.queue.reconcileBotPublications([{id:'worker',name:'Worker'}])[0].principalId,fresh.principalId)
})
