import {createHash} from 'node:crypto'
import {setTimeout as delay} from 'node:timers/promises'
import {sourceDelivery} from './session-scope.js'
const fail=code=>{throw Object.assign(new Error(code),{code})}
const serial = new WeakMap()
export function validateConsultationInput(input) {
 const seconds=input.waitSeconds??30
 if(!Number.isInteger(seconds)||seconds<0||seconds>30)fail('INVALID_REQUEST')
 if(input.consultationId!==undefined){
  if(typeof input.consultationId!=='string'||!input.consultationId.trim()||input.consultationId.length>200||['text','botId','requestId'].some(key=>input[key]!==undefined))fail('INVALID_REQUEST')
 }else if(typeof input.botId!=='string'||!input.botId||typeof input.text!=='string'||!input.text.trim()||input.text.length>16000
  ||input.requestId!==undefined&&(typeof input.requestId!=='string'||!input.requestId.trim()||input.requestId.length>200))fail('INVALID_REQUEST')
}
const receipt=row=>({consultationId:row.id,status:row.status,botId:row.targetBotId,...(row.status==='completed'?{text:row.text,truncated:row.truncated,receiptId:row.receiptId,resultState:'durably_saved'}:{}),...(row.error||row.resultError?{error:{code:row.error??row.resultError}}:{}),source:row.remoteSource,audience:'internal',automaticRemoteReply:false})

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
 validateConsultationInput(input)
 const binding=consultationBinding(runtime,exec),rt=runtime.rt
 const seconds=input.waitSeconds??30
 let id=input.consultationId
 if(id!==undefined){const row=rt.state.localConsultations?.[id];if(!row||row.ownerBotId!==binding.localBotRef||row.bindingId!==binding.id)fail('LOCAL_CONSULTATION_NOT_FOUND')}
 await runtime.authorize(binding)
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
  const remoteSource={consultationId:id,deliveryId:delivery.deliveryId,conversationId:binding.conversationId,messageId:delivery.messageId,authorPrincipalId:delivery.event.message.author.principalId,reporterPrincipalId:binding.recipientPrincipalId}
  const request=rt.requestIdentity({caller:binding.localBotRef,context:'remote-consultation:'+binding.id,name:id,payload:{botId:target.id,text:input.text}})
  const result=await rt.admitRequest(request,async()=>{
   await runtime.authorize(binding)
   if(!localTeammates(runtime,exec).some(bot=>bot.id===target.id))fail('LOCAL_BOT_UNAVAILABLE')
   const records=rt.state.localConsultations??={}
   if(Object.values(records).filter(row=>row.ownerBotId===binding.localBotRef&&row.status==='pending').length>=8)fail('LOCAL_CONSULTATION_LIMIT')
   records[id]={id,ownerBotId:binding.localBotRef,targetBotId:target.id,bindingId:binding.id,remoteSource,status:'pending',createdAt:Date.now(),expiresAt:Date.now()+10*60*1000}
   try {
    await rt.save({required:true})
    rt.openWork(id,{from:binding.localBotRef,to:target.id,remoteSource})
    await rt.deliver({fromId:binding.localBotRef,toId:target.id,text:input.text,role:'request',remoteSource,exchangeId:id,steer:true})
   } catch(error) {
    Object.assign(records[id],{status:'delivery_unknown',error:'LOCAL_CONSULTATION_DELIVERY_UNCONFIRMED'})
    rt.dropWork?.(id)
    await rt.save({required:true}).catch(()=>{})
    throw Object.assign(error,{code:'LOCAL_CONSULTATION_DELIVERY_UNCONFIRMED',consultationId:id})
   }
   return {consultationId:id,status:'pending'}
  })
  if(!['sent','replay'].includes(result.status))fail(result.status==='conflict'?'OPERATION_ID_CONFLICT':'LOCAL_CONSULTATION_UNCONFIRMED')
 }else if(typeof id!=='string'||input.text!==undefined||input.botId!==undefined||input.requestId!==undefined)fail('INVALID_REQUEST')
 const deadline=Date.now()+seconds*1000
 while(true){
  await runtime.authorize(binding)
  const settling=serial.get(rt)?.get(id)
  if(settling){try{await settling}catch{};await runtime.authorize(binding)}
  const row=rt.state.localConsultations?.[id]
  if(!row||row.ownerBotId!==binding.localBotRef||row.bindingId!==binding.id)fail('LOCAL_CONSULTATION_NOT_FOUND')
  if(row.status!=='pending')return receipt(row)
  if(row.resultError)return {...receipt(row),status:'result_unconfirmed',error:{code:row.resultError}}
  if(!rt.botOf(row.targetBotId))return {...receipt(row),status:'unavailable',error:{code:'LOCAL_BOT_UNAVAILABLE'}}
  if(Date.now()>=deadline)return {consultationId:id,status:'pending',botId:row.targetBotId,next:'Call consult_local_bot with this consultationId to wait again, or end this turn while waiting. The host will notify this remote Session when a result or failure is available. Do not decline the original task just because the wait timed out; pending is not sent or completed.'}
  await delay(Math.min(250,deadline-Date.now()),undefined,{signal:exec.signal})
 }
}

export async function settleLocalConsultation(rt,sessionId,source,text,{explicit=false}={}){
 const id=source.remoteSource?.consultationId
 let running=serial.get(rt);if(!running){running=new Map();serial.set(rt,running)}
 const prior=running.get(id)??Promise.resolve()
 const operation=prior.catch(()=>{}).then(async()=>{
  const row=rt.state.localConsultations?.[id]
  if(!row||row.targetBotId!==rt.selfOf(sessionId)||row.ownerBotId!==source.senderSessionId||id!==source.exchangeId)fail('LOCAL_CONSULTATION_NOT_FOUND')
  if(row.status==='completed'&&!explicit){rt.dropWork?.(id);return receipt(row)}
  const safe=rt.redactSecrets?.(text)??text
  if(typeof safe!=='string'||!safe.trim())fail('LOCAL_CONSULTATION_EMPTY_RESULT')
  if(safe.length>128000)fail('LOCAL_CONSULTATION_RESULT_TOO_LARGE')
  const receiptId=createHash('sha256').update(JSON.stringify([id,safe])).digest('hex')
  if(row.status==='completed'){
   if(explicit&&row.receiptId!==receiptId)fail('LOCAL_CONSULTATION_RESULT_CONFLICT')
   rt.dropWork?.(id)
   return receipt(row)
  }
  const saved={...row}
  Object.assign(row,{status:'completed',text:safe,truncated:false,receiptId,completedAt:Date.now()})
  delete row.resultError;delete row.error
  try{await rt.save({required:true})}catch(error){
   for(const key of Object.keys(row))delete row[key]
   Object.assign(row,saved,{resultError:'LOCAL_CONSULTATION_RESULT_NOT_SAVED'})
   throw Object.assign(error,{code:'LOCAL_CONSULTATION_RESULT_NOT_SAVED'})
  }
  rt.closeWork?.(id,rt.botOf(row.targetBotId)?.name??row.targetBotId,safe)
  // The result is already durable; cleanup failure must not turn it into a failed answer.
  await rt.save({required:true}).catch(error=>rt.warn('ds-bot: consultation work cleanup pending: %s',error))
  return receipt(row)
 })
 running.set(id,operation)
 try{return await operation}finally{if(running.get(id)===operation)running.delete(id)}
}

// Available to an unpublished local responder; this never enters Hub actor selection.
export async function replyToLocalConsultation(rt,input,exec){
 await rt.load()
 if(rt.communication?.owners?.has(exec.agent?.id))fail('LOCAL_CONSULTATION_LOCAL_RESPONDER_REQUIRED')
 const row=rt.state.localConsultations?.[input.consultationId]
 if(!row||row.targetBotId!==rt.selfOf(exec.agent?.id))fail('LOCAL_CONSULTATION_NOT_FOUND')
 return settleLocalConsultation(rt,exec.agent.id,{remoteSource:row.remoteSource,exchangeId:row.id,senderSessionId:row.ownerBotId},input.text,{explicit:true})
}

export async function automaticConsultationReply(rt,sessionId,source,text){
 try{return await settleLocalConsultation(rt,sessionId,source,text)}catch(error){
  const id=source.remoteSource?.consultationId,row=rt.state.localConsultations?.[id]
  rt.warn('ds-bot: local consultation result %s not confirmed: %s',id,error.code??'UNKNOWN')
  const retryable=error.code==='LOCAL_CONSULTATION_RESULT_NOT_SAVED'
  if(row){
   row.resultError=error.code??'LOCAL_CONSULTATION_RESULT_NOT_SAVED'
   if(!retryable){row.status='failed';row.error=row.resultError;rt.dropWork?.(id)}
   await rt.save({required:true}).catch(()=>{})
  }
  // Only storage failures can retry unchanged text. Invalid/empty answers need a new explicit submission.
  if(row&&retryable){rt.localConsultationRetries??=new Map();rt.localConsultationRetries.set(id,{sessionId,source,text})}
  if(row?.failureNotified)return
  try{
   await rt.deliver({fromId:source.senderSessionId,toId:rt.selfOf(sessionId),role:'federation-report',exchangeId:'consultation-failed-'+id,remoteSource:source.remoteSource,
    text:`[Local consultation result NOT confirmed: ${error.code??'UNKNOWN'}] Consultation ${id}. Your final text is not a delivery receipt. Keep the answer and call reply_to_local_consultation({"consultationId":"${id}","text":"your answer"}) to retry. Do not publish it to Hub. A saved receipt confirms internal storage only.`})
   if(row){row.failureNotified=true;await rt.save({required:true}).catch(()=>{})}
  }catch(noticeError){rt.warn('ds-bot: consultation failure notice pending: %s',noticeError.code??'UNKNOWN')}
 }
}

export function readLocalConsultation(rt,id,sessionId){
 const row=rt.state.localConsultations?.[id]
 if(!row||row.ownerBotId!==rt.selfOf(sessionId))fail('LOCAL_CONSULTATION_NOT_FOUND')
 return consultationSettling(rt,id)?{consultationId:id,status:'pending',audience:'internal',automaticRemoteReply:false}:receipt(row)
}

export const consultationSettling=(rt,id)=>serial.get(rt)?.has(id)===true

export function awaitingLocalConsultation(runtime,binding,delivery){
 return Object.values(runtime.rt?.state?.localConsultations??{}).some(row=>row.bindingId===binding.id&&row.ownerBotId===binding.localBotRef
  &&row.remoteSource?.messageId===delivery.messageId&&(row.status==='pending'&&!row.resultError||consultationSettling(runtime.rt,row.id)))
}
