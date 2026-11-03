import assert from 'node:assert/strict'
import { test } from 'node:test'
import { randomUUID, randomBytes } from 'node:crypto'
import { fork, spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname, resolve, basename } from 'node:path'
import { fileURLToPath } from 'node:url'
import { WebSocket } from 'ws'
import { startHub } from '../src/server.js'
import { PROTOCOL, CAPABILITIES } from '../src/protocol.js'
import { CommunicationQueue } from '../../ds-bot/src/host/federation/queue-store.js'
import { CommunicationTransport } from '../../ds-bot/src/host/federation/transport.js'

const credentials={a:randomBytes(32).toString('hex'),b:randomBytes(32).toString('hex')}
const peers=Object.entries(credentials).map(([instanceId,credential])=>({instanceId,credential}))
const op=input=>({operationId:randomUUID(),...input})
const payload=(author,conversationId,membershipEpoch)=>({protocol:PROTOCOL,type:'message.publish',messageId:randomUUID(),conversationId,
  author:{principalId:author,homeInstanceId:'a',kind:'human'},clientCreatedAt:new Date().toISOString(),content:{format:'text',text:'durable network nonce '+randomUUID()},mentions:[],replyToMessageId:null,membershipEpoch})
const makeClient=(id,url,path=':memory:')=>{
  const queue=new CommunicationQueue(path,{instanceId:id})
  const client=new CommunicationTransport(queue,{url,credential:credentials[id],requestTimeout:4000})
  return {queue,client}
}
async function ipc(child,type){
  return new Promise((resolve,reject)=>{
    const timeout=setTimeout(()=>{cleanup();reject(new Error(`Child ${type} timed out`))},15000)
    const onMessage=message=>{if(message.type===type){cleanup();resolve(message)}}
    const onExit=()=>{cleanup();reject(new Error(`Child exited before ${type}`))}
    const cleanup=()=>{clearTimeout(timeout);child.off('message',onMessage);child.off('exit',onExit)}
    child.on('message',onMessage);child.once('exit',onExit)
  })
}
async function childHub(path,drop='',port=0){
  const child=fork(fileURLToPath(new URL('./fixtures/hub-child.mjs',import.meta.url)),[path,String(port)],{
    env:{...process.env,DSBOT_TEST_A:credentials.a,DSBOT_TEST_B:credentials.b,DSBOT_TEST_DROP:drop},
    stdio:['ignore','ignore','ignore','ipc'],windowsHide:true,
  })
  const ready=await ipc(child,'ready')
  return {child,url:ready.url}
}
async function kill(child){
  if(child.exitCode!==null||child.signalCode!==null)return
  const exited=once(child,'exit');child.kill('SIGKILL');await exited
}

test('inbound AI backpressure keeps the connection live so stored work can drain before the next pull',async()=>{
  const hub=await startHub({databasePath:':memory:',port:0,peers})
  const a=makeClient('a',hub.url),queue=new CommunicationQueue(':memory:',{instanceId:'b',maxPending:1})
  const consumed=[],errors=[]
  const client=new CommunicationTransport(queue,{url:hub.url,credential:credentials.b,onError:error=>errors.push(error.code),onChange:async()=>{
    for(const delivery of queue.pendingAi()){
      consumed.push(delivery.deliveryId)
      queue.aiState(delivery.deliveryId,'accepted',{sessionId:'synthetic-sdk-session',messageId:delivery.messageId,seq:delivery.event.conversationSeq})
    }
  }})
  try{
    await Promise.all([a.client.connect(),client.connect()])
    const A=(await a.client.request('principal.register',{localId:'A',kind:'human',displayName:'A'})).principalId
    const K=(await client.request('principal.register',{localId:'K',kind:'bot',displayName:'Chief'})).principalId
    const {conversationId}=await a.client.request('dm.open',op({principalId:A,otherPrincipalId:K}))
    const scope=await a.client.request('conversation.authorize',{principalId:A,conversationId})
    const messages=[payload(A,conversationId,scope.membershipEpoch),payload(A,conversationId,scope.membershipEpoch)]
    for(const message of messages)await a.client.request('message.publish',message)
    await client.pump()
    assert.equal(client.connected,true)
    assert.equal(queue.authorized,true)
    assert.deepEqual(errors,['BACKPRESSURE'])
    assert.equal(consumed.length,1)
    await client.pump();await client.pump()
    assert.equal(consumed.length,2)
    assert.equal(new Set(consumed).size,2)
    assert.equal(hub.store.pending({instanceId:'b',epoch:client.welcome.epoch}).length,0)
    for(const message of messages){
      const status=await a.client.request('message.status',{principalId:A,messageId:message.messageId})
      assert.equal(status.find(item=>item.recipientPrincipalId===K).aiAccepted,1)
    }
  }finally{a.client.stop();client.stop();a.queue.close();queue.close();await hub.close()}
})

test('real independent Hub/client SQLite processes recover publish ACK loss, forced Hub death and stored-receipt ACK loss',async()=>{
  const root=mkdtempSync(join(tmpdir(),'dsbot-hub-network-'))
  const path=join(root,'hub.sqlite'),aPath=join(root,'a.sqlite'),bPath=join(root,'b.sqlite')
  let running, a, b
  try{
    running=await childHub(path,'message.publish')
    a=makeClient('a',running.url,aPath);b=makeClient('b',running.url,bPath)
    await Promise.all([a.client.connect(),b.client.connect()])
    const A=(await a.client.request('principal.register',{localId:'A',kind:'human',displayName:'Person A'})).principalId
    const B=(await b.client.request('principal.register',{localId:'B',kind:'human',displayName:'Person B'})).principalId
    const [opened,reverse]=await Promise.all([
      a.client.request('dm.open',op({principalId:A,otherPrincipalId:B})),
      b.client.request('dm.open',op({principalId:B,otherPrincipalId:A})),
    ])
    assert.equal(opened.conversationId,reverse.conversationId)
    const {conversationId}=opened
    const scope=await a.client.request('conversation.authorize',{principalId:A,conversationId})
    const input=payload(A,conversationId,scope.membershipEpoch)
    a.queue.enqueueMessage(input)
    const committed=ipc(running.child,'committed')
    await assert.rejects(a.client.pump(),{code:'CONNECTION_LOST'})
    const originalAccepted=(await committed).value
    assert.equal(a.queue.outboxStatus(input.messageId).state,'pending')
    const originalDelivery=(await b.client.request('deliveries.pull')).find(d=>d.recipientPrincipalId===B)
    await kill(running.child)
    a.client.stop();b.client.stop();a.queue.close();b.queue.close()
    running=await childHub(path,'delivery.receipt')
    a=makeClient('a',running.url,aPath);b=makeClient('b',running.url,bPath)
    await Promise.all([a.client.connect(),b.client.connect()])
    await a.client.pump()
    assert.deepEqual(a.queue.outboxStatus(input.messageId).result,originalAccepted)
    const receiptCommitted=ipc(running.child,'committed')
    await assert.rejects(b.client.pump(),{code:'CONNECTION_LOST'})
    await receiptCommitted
    assert.equal(b.queue.pendingReceipts().length,1)
    const before=b.queue.db.prepare('SELECT delivery_id FROM inbox').all()
    assert.equal(before.length,1)
    assert.equal(before[0].delivery_id,originalDelivery.deliveryId)
    b.client.stop();b.queue.close();b=makeClient('b',running.url,bPath)
    await b.client.connect();await b.client.pump()
    assert.equal(b.queue.pendingReceipts().length,0)
    const member=b.queue.memberships()[0]
    assert.equal(b.queue.view(conversationId,B,member.membershipEpoch).filter(e=>e.type==='message').length,1)
    const stats=ipc(running.child,'stats');running.child.send({type:'stats'})
    assert.equal((await stats).messages,1)
    const statuses=await a.client.request('message.status',{principalId:A,messageId:input.messageId})
    assert.equal(statuses.find(d=>d.recipientPrincipalId===B).targetStored,1)
  }finally{
    for(const value of [a,b]){value?.client.stop();value?.queue.close()}
    if(running)await kill(running.child)
    assert.equal(dirname(resolve(root)),resolve(tmpdir()));assert.ok(basename(root).startsWith('dsbot-hub-network-'))
    rmSync(root,{recursive:true,force:true})
  }
})

test('automatic reconnect retries an offline durable outbox after the same Hub endpoint returns',async()=>{
  const root=mkdtempSync(join(tmpdir(),'dsbot-hub-network-')),path=join(root,'hub.sqlite')
  let running,a,b
  const until=async check=>{
    const deadline=Date.now()+8000
    while(!check()){
      assert.ok(Date.now()<deadline,'Expected reconnect state was not reached')
      await new Promise(resolve=>setTimeout(resolve,25))
    }
  }
  try{
    running=await childHub(path)
    const port=Number(new URL(running.url).port)
    a=makeClient('a',running.url,join(root,'a.sqlite'));b=makeClient('b',running.url,join(root,'b.sqlite'))
    await Promise.all([a.client.connect(),b.client.connect()])
    const A=(await a.client.request('principal.register',{localId:'A',kind:'human',displayName:'A'})).principalId
    const B=(await b.client.request('principal.register',{localId:'B',kind:'human',displayName:'B'})).principalId
    const {conversationId}=await a.client.request('dm.open',op({principalId:A,otherPrincipalId:B}))
    a.client.start({pollMs:25});b.client.start({pollMs:25})
    await until(()=>b.queue.memberships().length===1)
    const scope=await a.client.request('conversation.authorize',{principalId:A,conversationId})
    await kill(running.child)
    await until(()=>!a.client.connected&&!b.client.connected)
    const input=payload(A,conversationId,scope.membershipEpoch);a.queue.enqueueMessage(input)
    assert.equal(a.queue.outboxStatus(input.messageId).state,'pending')
    running=await childHub(path,'',port)
    await until(()=>a.queue.outboxStatus(input.messageId).state==='accepted'
      &&b.queue.db.prepare('SELECT count(*) count FROM inbox WHERE message_id=?').get(input.messageId).count===1)
    assert.equal(b.queue.pendingAi().length,0,'Human DM must not produce AI work')
  }finally{
    for(const value of [a,b])value?.client.stop()
    await Promise.all([a,b].map(value=>value?.client.pumping?.catch(()=>{})))
    for(const value of [a,b])value?.queue.close()
    if(running)await kill(running.child)
    assert.equal(dirname(resolve(root)),resolve(tmpdir()));assert.ok(basename(root).startsWith('dsbot-hub-network-'))
    rmSync(root,{recursive:true,force:true})
  }
})

test('standalone CLI starts from credential references, reports health and stops on its owned process signal',async()=>{
  const root=mkdtempSync(join(tmpdir(),'dsbot-hub-network-')),configPath=join(root,'config.json')
  writeFileSync(configPath,JSON.stringify({host:'127.0.0.1',port:0,databasePath:'hub.sqlite',peers:[{instanceId:'a',credentialEnv:'DSBOT_CLI_TEST_SECRET'}]}))
  const child=spawn(process.execPath,[fileURLToPath(new URL('../src/cli.js',import.meta.url)),configPath],{
    env:{...process.env,DSBOT_CLI_TEST_SECRET:credentials.a},stdio:['ignore','pipe','pipe'],windowsHide:true,
  })
  let output=''
  try{
    const port=await new Promise((resolve,reject)=>{
      const timeout=setTimeout(()=>reject(new Error('CLI readiness timed out')),8000)
      child.stdout.on('data',chunk=>{
        output+=chunk
        const match=output.match(/listening on 127\.0\.0\.1:(\d+)/)
        if(match){clearTimeout(timeout);resolve(Number(match[1]))}
      })
      child.once('exit',()=>{clearTimeout(timeout);reject(new Error('CLI exited before readiness'))})
    })
    const response=await fetch(`http://127.0.0.1:${port}/health`)
    assert.equal(response.status,200)
    assert.deepEqual(await response.json(),{ok:true,protocol:PROTOCOL})
    assert.ok(!output.includes(credentials.a))
    const exited=once(child,'exit');child.kill('SIGTERM');await exited
  }finally{
    await kill(child)
    assert.equal(dirname(resolve(root)),resolve(tmpdir()));assert.ok(basename(root).startsWith('dsbot-hub-network-'))
    rmSync(root,{recursive:true,force:true})
  }
})

test('authenticated WS handshake enforces protocol/capabilities and a successor connection fences the old epoch',async()=>{
  const hub=await startHub({databasePath:':memory:',port:0,peers})
  const clients=[]
  const raw=async (payload,protocol=PROTOCOL)=>{
    const socket=new WebSocket(hub.url)
    try{
      await once(socket,'open')
      const reply=once(socket,'message')
      socket.send(JSON.stringify({protocol,id:randomUUID(),type:'hello',payload}))
      return JSON.parse((await reply)[0].toString())
    }finally{socket.terminate()}
  }
  try{
    assert.equal((await raw({instanceId:'a',credential:'wrong',capabilities:CAPABILITIES})).error.code,'UNAUTHENTICATED')
    assert.equal((await raw({instanceId:'a',credential:credentials.a,capabilities:CAPABILITIES},'unsupported/9')).error.code,'PROTOCOL_VERSION_UNSUPPORTED')
    assert.equal((await raw({instanceId:'a',credential:credentials.a,capabilities:['text']})).error.code,'UNSUPPORTED_CAPABILITY')
    const first=makeClient('a',hub.url),next=makeClient('a',hub.url);clients.push(first,next)
    await first.client.connect();await next.client.connect()
    await assert.rejects(first.client.request('contacts.list'),{code:'STALE_CONNECTION'})
    await assert.rejects(first.client.connect(),{code:'STALE_CONNECTION'})
    assert.deepEqual(await next.client.request('contacts.list'),[])
    assert.throws(()=>new CommunicationTransport(next.queue,{url:'ws://192.0.2.1:3190/communication',credential:credentials.a}),{code:'TLS_REQUIRED'})
    await assert.rejects(startHub({databasePath:':memory:',host:'0.0.0.0',port:0,peers}),{code:'TLS_REQUIRED'})
  }finally{
    for(const value of clients){value.client.stop();value.queue.close()}
    await hub.close()
  }
})

test('revoked trust stays rejected after ordinary Hub restart until the owner increases the pairing revision',async()=>{
  const root=mkdtempSync(join(tmpdir(),'dsbot-hub-network-')),databasePath=join(root,'hub.sqlite')
  let hub,a,b
  try{
    hub=await startHub({databasePath,port:0,peers})
    a=makeClient('a',hub.url);b=makeClient('b',hub.url)
    await Promise.all([a.client.connect(),b.client.connect()])
    const A=(await a.client.request('principal.register',{localId:'A',kind:'human',displayName:'A'})).principalId
    const B=(await b.client.request('principal.register',{localId:'B',kind:'human',displayName:'B'})).principalId
    const {conversationId}=await a.client.request('dm.open',op({principalId:A,otherPrincipalId:B}))
    const scope=await a.client.request('conversation.authorize',{principalId:A,conversationId})
    const input=payload(A,conversationId,scope.membershipEpoch);await a.client.request('message.publish',input)
    const oldDelivery=(await b.client.request('deliveries.pull'))[0]
    hub.revoke('b')
    a.client.stop();b.client.stop();a.queue.close();b.queue.close();a=null;b=null
    await hub.close();hub=await startHub({databasePath,port:0,peers})
    b=makeClient('b',hub.url)
    await assert.rejects(b.client.connect(),{code:'UNAUTHENTICATED'})
    b.client.stop();b.queue.close();b=null
    await hub.close();hub=await startHub({databasePath,port:0,peers:peers.map(peer=>({...peer,pairingRevision:peer.instanceId==='b'?2:1}))})
    a=makeClient('a',hub.url);b=makeClient('b',hub.url)
    await Promise.all([a.client.connect(),b.client.connect()])
    const reopened=await a.client.request('dm.open',op({principalId:A,otherPrincipalId:B}))
    assert.equal(reopened.conversationId,conversationId)
    assert.ok(!(await b.client.request('deliveries.pull')).some(d=>d.deliveryId===oldDelivery.deliveryId))
    const status=await a.client.request('message.status',{principalId:A,messageId:input.messageId})
    assert.equal(status.find(d=>d.deliveryId===oldDelivery.deliveryId).revoked,1)
  }finally{
    for(const value of [a,b]){value?.client.stop();value?.queue.close()}
    await hub?.close()
    assert.equal(dirname(resolve(root)),resolve(tmpdir()));assert.ok(basename(root).startsWith('dsbot-hub-network-'))
    rmSync(root,{recursive:true,force:true})
  }
})
