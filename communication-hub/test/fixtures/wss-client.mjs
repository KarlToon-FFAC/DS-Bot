import {randomUUID} from 'node:crypto'
import {CommunicationQueue} from '../../../ds-bot/src/host/federation/queue-store.js'
import {CommunicationTransport} from '../../../ds-bot/src/host/federation/transport.js'
import {PROTOCOL} from '../../src/protocol.js'
const input=JSON.parse(process.env.DSBOT_WSS_TEST_INPUT)
delete process.env.DSBOT_WSS_TEST_INPUT
const queues=['a','b'].map(instanceId=>new CommunicationQueue(':memory:',{instanceId}))
const clients=queues.map((queue,index)=>new CommunicationTransport(queue,{url:input.url,credential:input.credentials[index],requestTimeout:3000}))
let result
let stage='health'
try{
  if(process.env.NODE_TLS_REJECT_UNAUTHORIZED!==undefined)throw new Error('TLS_OVERRIDE_FORBIDDEN')
  const health=await fetch(input.url.replace('wss:','https:').replace('/communication','/health'),{signal:AbortSignal.timeout(4000)})
  if(!health.ok)throw new Error('HEALTH_FAILED')
  stage='connect'
  await Promise.all(clients.map(client=>client.connect()))
  stage='register'
  const principals=await Promise.all(clients.map((client,index)=>client.request('principal.register',{localId:`person-${index}`,kind:'human',displayName:`Synthetic ${index}`})))
  const principalId=principals[0].principalId,otherPrincipalId=principals[1].principalId
  stage='dm'
  const {conversationId}=await clients[0].request('dm.open',{operationId:randomUUID(),principalId,otherPrincipalId})
  stage='authorize'
  const {membershipEpoch}=await clients[0].request('conversation.authorize',{principalId,conversationId})
  stage='publish'
  const messageId=randomUUID(),text='Synthetic WSS canonical message'
  queues[0].enqueueMessage({protocol:PROTOCOL,type:'message.publish',messageId,conversationId,author:{principalId,homeInstanceId:'a',kind:'human'},
    clientCreatedAt:new Date().toISOString(),content:{format:'text',text},mentions:[],replyToMessageId:null,membershipEpoch})
  await clients[0].pump()
  stage='sync'
  const recipientScope=await clients[1].request('conversation.authorize',{principalId:otherPrincipalId,conversationId})
  const page=await clients[1].request('conversation.sync',{principalId:otherPrincipalId,conversationId,membershipEpoch:recipientScope.membershipEpoch,after:0,limit:100})
  if(page.events.filter(event=>event.message?.messageId===messageId&&event.message.content.text===text).length!==1)throw new Error('MESSAGE_NOT_CANONICAL')
  result={connected:true,canonicalMessages:1,normalTlsValidation:true}
}catch(error){result={connected:false,stage,code:error.code??'TLS_OR_CONNECTION_REJECTED'}}
finally{for(const client of clients)client.stop();for(const queue of queues)queue.close()}
process.send(result,()=>process.disconnect())
