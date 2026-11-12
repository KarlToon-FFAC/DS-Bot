import {createHash} from 'node:crypto'
import {setTimeout as delay} from 'node:timers/promises'
import {sourceDelivery} from './session-scope.js'
const fail=code=>{throw Object.assign(new Error(code),{code})}

export function consultationBinding(runtime,exec){
 const binding=runtime.owners.get(exec.agent?.id)
 if(!binding||binding.id!==exec.communicationBinding?.id)fail('COMMUNICATION_INPUT_SOURCE_UNKNOWN')
 return binding
}
export function localTeammates(runtime,exec){
 const binding=consultationBinding(runtime,exec)
 return Object.values(runtime.rt.state.bots).filter(bot=>bot.id!==binding.localBotRef&&!bot.private)
  .map(bot=>({id:bot.id,name:bot.name,role:bot.role??'',chief:runtime.rt.isMain(bot.id)}))
}
export async function consultLocalBot(runtime,input,exec){
 const binding=consultationBinding(runtime,exec),rt=runtime.rt
 const seconds=input.waitSeconds??30
 if(!Number.isInteger(seconds)||seconds<0||seconds>30)fail('INVALID_REQUEST')
 await runtime.authorize(binding)
 let id=input.consultationId
 if(id===undefined){
  if(rt.readOnly()!==undefined)fail('COMMUNICATION_READ_ONLY')
  if(typeof input.text!=='string'||!input.text.trim()||input.text.length>16000)fail('INVALID_REQUEST')
  const target=localTeammates(runtime,exec).find(bot=>bot.id===input.botId)
  if(!target)fail('LOCAL_BOT_UNAVAILABLE')
  const cause=exec.communicationCausation
  if(!cause?.causationDeliveryId||!exec.communicationSource)fail('COMMUNICATION_INPUT_SOURCE_UNKNOWN')
  const delivery=sourceDelivery(runtime.queue,binding,{kind:'ds-bot-communication',deliveryId:cause.causationDeliveryId,messageId:cause.replyToMessageId,conversationId:binding.conversationId,recipientPrincipalId:binding.recipientPrincipalId,membershipEpoch:binding.membershipEpoch})
  const name=input.requestId??'primary'
  if(typeof name!=='string'||!name.trim()||name.length>200)fail('INVALID_REQUEST')
  id=createHash('sha256').update(JSON.stringify([binding.id,delivery.deliveryId,target.id,name])).digest('hex')
  const remoteSource={consultationId:id,conversationId:binding.conversationId,messageId:delivery.messageId,authorPrincipalId:delivery.event.message.author.principalId,reporterPrincipalId:binding.recipientPrincipalId}
  const request=rt.requestIdentity({caller:binding.localBotRef,context:'remote-consultation:'+binding.id,name:id,payload:{botId:target.id,text:input.text}})
  const result=await rt.admitRequest(request,async()=>{
   await runtime.authorize(binding)
   if(!localTeammates(runtime,exec).some(bot=>bot.id===target.id))fail('LOCAL_BOT_UNAVAILABLE')
   const records=rt.state.localConsultations??={}
   if(Object.values(records).filter(row=>row.ownerBotId===binding.localBotRef&&row.status==='pending').length>=8)fail('LOCAL_CONSULTATION_LIMIT')
   records[id]={id,ownerBotId:binding.localBotRef,targetBotId:target.id,bindingId:binding.id,remoteSource,status:'pending',createdAt:Date.now()}
   await rt.save({required:true})
   rt.openWork(id,{from:binding.localBotRef,to:target.id,remoteSource})
   await rt.deliver({fromId:binding.localBotRef,toId:target.id,text:input.text,role:'request',remoteSource,exchangeId:id,steer:true})
   return {consultationId:id,status:'pending'}
  })
  if(!['sent','replay'].includes(result.status))fail(result.status==='conflict'?'OPERATION_ID_CONFLICT':'LOCAL_CONSULTATION_UNCONFIRMED')
 }else if(typeof id!=='string'||input.text!==undefined||input.botId!==undefined||input.requestId!==undefined)fail('INVALID_REQUEST')
 const deadline=Date.now()+seconds*1000
 while(true){
  await runtime.authorize(binding)
  const row=rt.state.localConsultations?.[id]
  if(!row||row.ownerBotId!==binding.localBotRef||row.bindingId!==binding.id)fail('LOCAL_CONSULTATION_NOT_FOUND')
  if(row.status==='completed')return {consultationId:id,status:'completed',botId:row.targetBotId,text:row.text,truncated:row.truncated,source:row.remoteSource,audience:'internal',automaticRemoteReply:false}
  if(!rt.botOf(row.targetBotId))return {consultationId:id,status:'unavailable',botId:row.targetBotId}
  if(Date.now()>=deadline)return {consultationId:id,status:'pending',botId:row.targetBotId,next:'Call consult_local_bot with this consultationId to wait again; do not resend or claim completion.'}
  await delay(Math.min(250,deadline-Date.now()),undefined,{signal:exec.signal})
 }
}

export async function settleLocalConsultation(rt,sessionId,source,text){
 const id=source.remoteSource?.consultationId,row=rt.state.localConsultations?.[id]
 if(!row||row.status==='completed')return
 if(row.targetBotId!==rt.selfOf(sessionId)||row.ownerBotId!==source.senderSessionId||id!==source.exchangeId)fail('LOCAL_CONSULTATION_NOT_FOUND')
 const safe=rt.redactSecrets?.(text)??text,prior={...row}
 Object.assign(row,{status:'completed',text:safe.slice(0,32000),truncated:safe.length>32000,completedAt:Date.now()})
 try{await rt.save({required:true})}catch(error){Object.assign(row,prior);delete row.text;delete row.truncated;delete row.completedAt;throw error}
 rt.closeWork?.(id,rt.botOf(row.targetBotId)?.name??row.targetBotId,text)
 await rt.save({required:true})
}
