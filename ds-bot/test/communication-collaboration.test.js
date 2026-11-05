import assert from 'node:assert/strict'
import { test } from 'node:test'
import { CommunicationRuntime } from '../src/host/federation/runtime.js'
import { CommunicationQueue } from '../src/host/federation/queue-store.js'
import { CommunicationTransport } from '../src/host/federation/transport.js'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const binding = { id:'binding', conversationId: 'group', recipientPrincipalId: 'bot:a:one', membershipEpoch: 'epoch' }
const source = { kind: 'ds-bot-communication', ...binding, deliveryId: 'delivery', messageId: 'parent' }
const input = { ...binding, deliveryId: 'delivery', messageId: 'parent', ai: true }
const tool = { seq: 4, type: 'assistant/message', data: { turn: 2, message: { id: 'tool-message', content: [{ type: 'tool-call', id: 'call' }] } } }

test('active communication tool causation comes from its exclusive durable input, including recovery', async () => {
  let events = [{ seq: 1, type: 'turn/start', data: { turn: 1 } },
    { seq: 2, type: 'turn/start', data: { turn: 2 } }, { seq: 3, type: 'user/message', data: { source } }, tool]
  const runtime = { owners: new Map([['session', binding]]), queue: { db: { prepare: () => ({ get: id => id === 'delivery' ? { body: JSON.stringify(input), revoked: 0 } : null }) } },
    ctx: { sessions: { flush: async () => {} }, sessionController: { inspect: async () => ({ events }) } } }
  const exec = { callId: 'call', agent: { id: 'session', session: {} } }
  const read = () => CommunicationRuntime.prototype.toolProvenance.call(runtime, exec)
  const result = await read()
  assert.equal(result.causationDeliveryId, 'delivery')
  assert.equal(result.replyToMessageId, 'parent')
  assert.equal(result.sourceKey, JSON.stringify(['tool', 'session', 4, 'tool-message', 'call']))
  events[2].data.source = { kind: 'ds-bot-communication-recovery', conversationId: 'group', forDeliveryId: 'delivery', forMessageId: 'parent' }
  assert.equal((await read()).causationDeliveryId, 'delivery')
  events[2].data.source = { ...source, deliveryId: 'forged' }
  await assert.rejects(read(), { code: 'COMMUNICATION_INPUT_SOURCE_UNKNOWN' })
  events[2].data.source = source
  events.splice(3, 0, { seq: 3.5, type: 'user/message', data: { source: { kind: 'user' } } })
  await assert.rejects(read(), { code: 'COMMUNICATION_INPUT_SOURCE_UNKNOWN' })
  events = [{ seq: 1, type: 'turn/start', data: { turn: 1 } }, { seq: 2, type: 'user/message', data: { source } },
    { seq: 3, type: 'turn/start', data: { turn: 2 } }, tool]
  await assert.rejects(read(), { code: 'COMMUNICATION_INPUT_SOURCE_UNKNOWN' })
})

test('active tool exports retain parent and causal delivery on journal retry', async () => {
  const queue = new CommunicationQueue(':memory:', { instanceId: 'a' })
  try {
    const principalId = queue.localPrincipal('bot', 'one', 'One').principalId
    const runtime = { queue, member: () => ({ kind: 'group', speakingMode: 'active', membershipEpoch: 'epoch' }),
      contacts: [{ principalId: 'bot:b:two', displayName: 'Two', kind: 'bot' }] }
    runtime.message = (...args) => CommunicationRuntime.prototype.message.call(runtime, ...args)
    const exec = { callId: 'call', agent: { id: 'session' }, communicationSource: 'durable-tool-source', communicationBinding: binding,
      communicationCausation: { causationDeliveryId: 'delivery', replyToMessageId: 'parent' } }
    const send = () => CommunicationRuntime.prototype.sendBot.call(runtime, { principalId }, { conversationId: 'group', text: '@Two review', mentions: ['bot:b:two'] }, exec)
    const first = await send(), second = await send()
    assert.equal(first.messageId, second.messageId)
    assert.equal(queue.intent(first.messageId).payload.causationDeliveryId, 'delivery')
    assert.equal(queue.intent(first.messageId).payload.replyToMessageId, 'parent')
    assert.equal(queue.intent(first.messageId).payload.responseToDeliveryId, 'delivery')
    delete exec.communicationCausation
    await assert.rejects(send(), { code: 'COMMUNICATION_INPUT_SOURCE_UNKNOWN' })
  } finally { queue.close() }
})

test('a new client refuses an old unbounded Hub before registration or outbox publication', async t => {
  const original = globalThis.WebSocket
  const frames = []
  class OldHubSocket extends EventTarget {
    static OPEN = 1
    readyState = 1
    constructor() { super(); queueMicrotask(() => this.dispatchEvent(new Event('open'))) }
    close() { this.readyState = 3; this.dispatchEvent(new Event('close')) }
    send(raw) {
      const frame = JSON.parse(raw); frames.push(frame.type)
      assert.equal(frame.type, 'hello')
      assert.ok(frame.payload.capabilities.includes('bounded-bot-collaboration'))
      queueMicrotask(() => this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ id: frame.id, ok: true,
        value: { protocol: 'dsbot-communication/1', instanceId: 'test', capabilities: frame.payload.capabilities.filter(value => value !== 'bounded-bot-collaboration') } }) })))
    }
  }
  globalThis.WebSocket = OldHubSocket
  t.after(() => { globalThis.WebSocket = original })
  let registered = false, changed = false
  const retained = { messageId: 'original-id', state: 'pending' }
  const queue = { instanceId: 'test', disconnected: () => {}, setLimits: () => { changed = true }, retained }
  const transport = new CommunicationTransport(queue, { url: 'ws://127.0.0.1:3190/communication', credential: 'synthetic',
    onConnect: () => { registered = true } })
  await assert.rejects(transport.connect(), { code: 'BOUNDED_COLLABORATION_REQUIRED' })
  assert.equal(registered, false)
  assert.equal(changed, false)
  assert.deepEqual(frames, ['hello'])
  assert.equal(transport.connected, false)
  assert.equal(transport.socket.readyState, 3)
  assert.deepEqual(queue.retained, { messageId: 'original-id', state: 'pending' })
})

test('Bot automatic text is display-only even for all mentions and unknown names', () => {
  const runtime = { queue: { instanceId: 'a' }, contacts: [{principalId:'bot:b:two',kind:'bot',displayName:'Two'}], member: () => ({membershipEpoch:'epoch'}) }
  for (const text of ['Summary @Two', '@all', '> @Two', 'Unknown @Somebody']) {
    const message = CommunicationRuntime.prototype.message.call(runtime,'bot:a:one','group',{text})
    assert.deepEqual(message.activationTargets, [])
  }
  const message = CommunicationRuntime.prototype.message.call(runtime,'human:a:user','group',{text:'@Two'})
  assert.deepEqual(message.mentions,[{principalId:'bot:b:two'}]); assert.equal(message.activationTargets,undefined)
})

test('reply handoff intent is durable, single-valued and cannot modify an already exported response', () => {
  const queue = new CommunicationQueue(':memory:', { instanceId: 'a' })
  try {
    queue.stageReplyTargets('binding','delivery',['bot:b:two'],'source')
    queue.stageReplyTargets('binding','delivery',['bot:b:two'],'retry-source')
    assert.deepEqual(queue.replyTargets('binding','delivery'),['bot:b:two'])
    assert.throws(()=>queue.stageReplyTargets('binding','delivery',[],'other'),{code:'HANDOFF_ALREADY_SET'})
    assert.throws(()=>queue.replyTargets('foreign','delivery'),{code:'CONVERSATION_SCOPE_MISMATCH'})
    assert.deepEqual(queue.replyTargets('binding','other-delivery'),[])
  } finally {queue.close()}
})

test('passive handoff stages only its current authorized group input and never permits proactive send', async () => {
  const queue = new CommunicationQueue(':memory:',{instanceId:'a'})
  const actor={principalId:'bot:a:one'}
  const current={id:'binding',conversationId:'group',membershipEpoch:'epoch'}
  const runtime=Object.assign(Object.create(CommunicationRuntime.prototype),{queue,contacts:[{principalId:'bot:b:two',kind:'bot'}],member:()=>({kind:'group',speakingMode:'passive',membershipEpoch:'epoch'})})
  const exec={agent:{id:'session'},callId:'call',communicationSource:'tool-source',communicationBinding:current,communicationCausation:{causationDeliveryId:'input',replyToMessageId:'parent'}}
  try {
    assert.deepEqual(runtime.stageHandoff(actor,{replyToMessageId:'parent',activationTargets:['bot:b:two']},exec),{status:'staged',activationTargets:['bot:b:two'],sendsMessage:false})
    assert.equal(queue.pendingOutbox().length,0)
    await assert.rejects(runtime.sendBot(actor,{conversationId:'group',text:'unsolicited'},exec),{code:'PASSIVE_REPLY_ONLY'})
    assert.throws(()=>runtime.stageHandoff(actor,{allBots:true},{...exec,communicationBinding:null}),{code:'COMMUNICATION_INPUT_SOURCE_UNKNOWN'})
    runtime.member=()=>({kind:'group',speakingMode:'readOnly'})
    assert.throws(()=>runtime.stageHandoff(actor,{replyToMessageId:'parent',activationTargets:[]},exec),{code:'SPEAKING_FORBIDDEN'})
  } finally {queue.close()}
})


test('new client rejects a Hub missing explicit activation before any outbox publication', async t => {
  const original=globalThis.WebSocket, frames=[]
  class LegacySocket extends EventTarget {
    static OPEN=1
    readyState=1
    constructor(){super();queueMicrotask(()=>this.dispatchEvent(new Event('open')))}
    close(){this.readyState=3;this.dispatchEvent(new Event('close'))}
    send(raw){const frame=JSON.parse(raw);frames.push(frame.type);queueMicrotask(()=>this.dispatchEvent(new MessageEvent('message',{data:JSON.stringify({id:frame.id,ok:true,value:{protocol:'dsbot-communication/1',instanceId:'test',capabilities:frame.payload.capabilities.filter(value=>value!=='explicit-bot-activation')}})})))}
  }
  globalThis.WebSocket=LegacySocket;t.after(()=>{globalThis.WebSocket=original})
  let changed=false
  const transport=new CommunicationTransport({instanceId:'test',disconnected(){},setLimits(){changed=true}},{url:'ws://127.0.0.1:3190/communication',credential:'synthetic'})
  await assert.rejects(transport.connect(),{code:'EXPLICIT_ACTIVATION_REQUIRED'})
  assert.deepEqual(frames,['hello']);assert.equal(changed,false);assert.equal(transport.connected,false)
})

test('all-Bot tool retry keeps its original target expansion after the roster changes', async()=>{
  const queue=new CommunicationQueue(':memory:',{instanceId:'a'})
  const actor=queue.localPrincipal('bot','one','One')
  const members=[{principalId:actor.principalId,kind:'bot'},{principalId:'bot:b:two',kind:'bot'}]
  const info={membershipVersion:1,members}
  const runtime=Object.assign(Object.create(CommunicationRuntime.prototype),{queue,contacts:members,conversations:new Map([['group',info]]),member:()=>({kind:'group',speakingMode:'active',membershipEpoch:'epoch',membershipVersion:info.membershipVersion})})
  const exec={callId:'call',agent:{id:'session'},communicationSource:'source',communicationBinding:{...binding,id:'binding'},communicationCausation:{causationDeliveryId:'delivery',replyToMessageId:'parent'}}
  try{
    const first=await runtime.sendBot(actor,{conversationId:'group',text:'Delegate to this batch',allBots:true},exec)
    members.push({principalId:'bot:b:three',kind:'bot'});info.membershipVersion=2
    const retry=await runtime.sendBot(actor,{conversationId:'group',text:'Delegate to this batch',allBots:true},exec)
    assert.equal(retry.messageId,first.messageId)
    assert.deepEqual(queue.intent(first.messageId).payload.activationTargets,[{principalId:'bot:b:two'}])
  }finally{queue.close()}
})

test('an immediate group answer completes only its exact input; the later receipt final is journaled without a second send',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'dsbot-tool-final-')),path=join(dir,'queue.sqlite')
 let queue=new CommunicationQueue(path,{instanceId:'a'})
 const actor=queue.localPrincipal('bot','one','One'),members=[{principalId:actor.principalId,kind:'bot'},{principalId:'bot:b:two',kind:'bot'}]
 const current={...binding,id:'binding'}
 const runtime=Object.assign(Object.create(CommunicationRuntime.prototype),{queue,contacts:members,conversations:new Map([['group',{members,membershipVersion:1}]]),member:()=>({kind:'group',speakingMode:'active',membershipEpoch:'epoch',membershipVersion:1})})
 const exec={callId:'call',agent:{id:'session'},communicationSource:'immediate-answer',communicationBinding:current,communicationCausation:{causationDeliveryId:'input-A',replyToMessageId:'human-input'}}
 try{
  const sent=await runtime.sendBot(actor,{conversationId:'group',text:'@Two Please confirm once.',activationTargets:['bot:b:two']},exec)
  assert.equal(sent.completesCurrentReply,false)
  assert.equal(queue.intent(sent.messageId).payload.responseToDeliveryId,'input-A')
  queue.close();queue=new CommunicationQueue(path,{instanceId:'a'});runtime.queue=queue
  assert.equal(queue.completedToolReply('binding','input-A'),sent.messageId)
  assert.equal(queue.completedToolReply('binding','different-input'),undefined)
  assert.throws(()=>queue.completedToolReply('other-binding','input-A'),{code:'CONVERSATION_SCOPE_MISMATCH'})
  const final={sourceKey:'receipt-final',sessionId:'session',seq:8,parts:[{part:0,text:'Sent @Two, status pending.'}]}
  assert.throws(()=>queue.completeFinalExport('binding','input-A',final),{code:'RESPONSE_NOT_ACCEPTED'})
  queue.accepted(sent.messageId,{messageId:sent.messageId})
  queue.completeFinalExport('binding','input-A',final)
  queue.completeFinalExport('binding','input-A',final)
  assert.equal(queue.pendingOutbox().length,0)
  assert.equal(queue.db.prepare('SELECT count(*) n FROM exports').get().n,2)
  assert.equal((await runtime.sendBot(actor,{conversationId:'group',text:'@Two Please confirm once.',activationTargets:['bot:b:two']},exec)).messageId,sent.messageId)
  await assert.rejects(runtime.sendBot(actor,{conversationId:'group',text:'Repeat @Two',activationTargets:['bot:b:two']},{...exec,communicationSource:'second-call'}),{code:'RESPONSE_ALREADY_SENT'})
  const progress=await runtime.sendBot(actor,{conversationId:'group',text:'I am checking the result.',continueReply:true},{...exec,communicationSource:'progress',communicationCausation:{causationDeliveryId:'input-B',replyToMessageId:'other-input'}})
  assert.equal(progress.completesCurrentReply,false)
  assert.equal(queue.completedToolReply('binding','input-B'),undefined)
  assert.equal(queue.pendingOutbox().length,1)
 }finally{queue.close();rmSync(dir,{recursive:true,force:true})}
})

test('staged reply targets survive process queue reopen and remain bound to the original input',()=>{
  const dir=mkdtempSync(join(tmpdir(),'dsbot-staged-handoff-')),path=join(dir,'queue.sqlite')
  let queue=new CommunicationQueue(path,{instanceId:'a'})
  try{
    queue.stageReplyTargets('binding','delivery',['bot:b:two'],'tool-source')
    queue.db.exec('PRAGMA user_version=2')
    queue.close();queue=new CommunicationQueue(path,{instanceId:'a'})
    assert.deepEqual(queue.replyTargets('binding','delivery'),['bot:b:two'])
    assert.equal(queue.db.prepare('PRAGMA user_version').get().user_version,5)
    assert.deepEqual(queue.replyTargets('binding','new-input'),[])
    assert.throws(()=>queue.replyTargets('new-binding','delivery'),{code:'CONVERSATION_SCOPE_MISMATCH'})
  }finally{queue.close();rmSync(dir,{recursive:true,force:true})}
})
