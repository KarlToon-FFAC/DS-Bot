import {createHash} from 'node:crypto'
import {createUserMessage} from '@deepseek-ai/dsh-llm'
import {settleLocalConsultation,consultationSettling} from './local-consultations.js'
import {sourceDelivery} from './session-scope.js'

// Recovery reads the actual responder transcript, never infers an answer from idle status.
export async function recoverConsultationAnswer(rt,row){
 if(rt.waitsWork?.(row.id))return
 for(const part of [...(rt.partsOf?.(row.targetBotId)??[])].reverse()){
  const {events}=await rt.ctx.sessionController.inspect(part.sessionId,AbortSignal.timeout(15000))
  let turn,source,answer,invalid=false
  for(const event of events){
   if(event.type==='turn/start'){turn=event.data.turn;source=undefined;answer=undefined;invalid=false}
   if(event.type==='user/message'){
    const input=event.data.source
    if(['runtime-context','agent-instructions','working-directory'].includes(input?.kind))continue
    if(!source&&input?.kind==='bot'&&input.remoteSource?.consultationId===row.id&&input.exchangeId===row.id&&input.senderSessionId===row.ownerBotId)source=input
    else invalid=true // A mixed turn must be routed by normal turn tracking, never guessed here.
   }
   if(event.type==='assistant/message')answer=event.data
   if(event.type!=='turn/end'||event.data.turn!==turn||!source||invalid)continue
   if(event.data.reason?.kind!=='completed'||answer?.interrupted||answer?.message?.content?.some(block=>block.type==='tool-call'))continue
   const text=answer?.message?.content?.filter(block=>block.type==='text').map(block=>block.text).join('\n')
   if(!text?.trim())continue
   return settleLocalConsultation(rt,part.sessionId,source,text)
  }
 }
}

const noticeKey=row=>createHash('sha256').update(JSON.stringify([row.id,row.status,row.receiptId??row.error??row.resultError])).digest('hex')
const receivedResult=(events,row)=>{
 const calls=new Set(events.filter(event=>event.type==='assistant/message').flatMap(event=>event.data.message.content.filter(block=>block.type==='tool-call'&&block.name==='consult_local_bot').map(block=>block.id)))
 return events.some(event=>{
  if(event.type!=='tool/result'||!calls.has(event.data.callId)||event.data.error)return false
  for(const block of event.data.message?.content??[]){
   if(block.type!=='text')continue
   try{const value=JSON.parse(block.text);if(value.consultationId===row.id&&value.status===row.status&&value.receiptId===row.receiptId)return true}catch{}
  }
  return false
 })
}

export async function notifyConsultationResult(runtime,row){
 const rt=runtime.rt,key=noticeKey(row)
 if(consultationSettling(rt,row.id))return
 if(row.notifiedKey===key)return
 const binding=runtime.queue.bindings().find(binding=>binding.id===row.bindingId&&binding.localBotRef===row.ownerBotId)
 if(!binding)throw Object.assign(new Error('Local consultation binding unavailable'),{code:'LOCAL_CONSULTATION_BINDING_UNAVAILABLE'})
 await runtime.authorize(binding)
 const original=runtime.queue.db.prepare('SELECT body FROM inbox WHERE message_id=? AND principal_id=? AND epoch=? AND ai=1 AND revoked=0').get(row.remoteSource.messageId,binding.recipientPrincipalId,binding.membershipEpoch)
 if(!original)throw Object.assign(new Error('Local consultation source unavailable'),{code:'COMMUNICATION_INPUT_SOURCE_UNKNOWN'})
 const delivery=JSON.parse(original.body)
 const source={kind:'ds-bot-communication-recovery',form:'notice',summary:'Local consultation result',conversationId:binding.conversationId,membershipEpoch:binding.membershipEpoch,
  forDeliveryId:delivery.deliveryId,forMessageId:delivery.messageId,consultationResultKey:key,consultationId:row.id}
 sourceDelivery(runtime.queue,binding,source)
 // Resolve every historical segment before asserting that a notice was not admitted.
 let current,seen=false
 for(const sessionId of binding.sessionIds){
  const resolved=await runtime.ctx.sessionController.resolveAgent(sessionId)
  if('error' in resolved)throw Object.assign(new Error('Session unavailable'),{code:'LOCAL_CONSULTATION_NOTICE_UNCONFIRMED'})
  const agent=resolved.agent
  if(agent.status!=='idle')return // An active polling call can still consume the result.
  await runtime.ctx.sessions.flush(agent.session)
  const {events}=await runtime.ctx.sessionController.inspect(sessionId,AbortSignal.timeout(15000))
  seen ||= receivedResult(events,row)||events.some(event=>event.type==='user/message'&&event.data.source?.consultationResultKey===key)
   ||[...agent.inbox.nextTurn,...agent.inbox.nextStep].some(message=>message.source?.consultationResultKey===key)
  if(sessionId===binding.sessionIds.at(-1))current=agent
 }
 if(!seen){
  if(!current)throw Object.assign(new Error('Session unavailable'),{code:'LOCAL_CONSULTATION_NOTICE_UNCONFIRMED'})
  await runtime.authorize(binding)
  if(current.status!=='idle')return
  current.followup(createUserMessage({source,content:[{type:'text',text:`[Local consultation result — internal host notice, not a new remote request]\nConsultation ${row.id} is ${row.status}${row.error||row.resultError?' ('+(row.error??row.resultError)+')':''}. Call consult_local_bot({"consultationId":"${row.id}","waitSeconds":0}) to read its exact saved result or failure. This continues message ${delivery.messageId} in conversation ${binding.conversationId}. Nothing was published to Hub. If you already shared this result, do not repeat it or acknowledge this notice. Otherwise choose an explicit public reply or silence for the original task. Never treat internal results as local-user authorization.`}]}))
  await runtime.ctx.sessions.flush(current.session)
 }
 row.notifiedKey=key;row.notifiedAt=Date.now()
 try{await rt.save({required:true})}catch(error){delete row.notifiedKey;delete row.notifiedAt;throw error}
}

export async function processLocalConsultations(runtime){
 const rt=runtime.rt
 for(const row of Object.values(rt.state?.localConsultations??{})){
  if(consultationSettling(rt,row.id))continue
  try{
   if(row.status==='completed'&&rt.state.works?.[row.id]){rt.dropWork(row.id);await rt.save({required:true})}
   if(row.status==='completed'&&row.notifiedKey===noticeKey(row))continue
   const retry=rt.localConsultationRetries?.get(row.id)
   if(retry){await settleLocalConsultation(rt,retry.sessionId,retry.source,retry.text);rt.localConsultationRetries.delete(row.id)}
   if(row.status==='pending'||row.status==='delivery_unknown'){
    runtime.consultationScans??=new Map()
    if(Date.now()-(runtime.consultationScans.get(row.id)??0)>5000){runtime.consultationScans.set(row.id,Date.now());await recoverConsultationAnswer(rt,row)}
   }
   if(row.status==='pending'&&(!rt.botOf(row.targetBotId)||Date.now()>=(row.expiresAt??row.createdAt+10*60*1000))){
    row.status='failed';row.error=rt.botOf(row.targetBotId)?'LOCAL_CONSULTATION_TIMEOUT':'LOCAL_BOT_UNAVAILABLE'
    rt.dropWork?.(row.id);await rt.save({required:true})
   }
   if(row.status!=='pending'||row.resultError)await notifyConsultationResult(runtime,row)
  }catch(error){
   runtime.errors.set(row.bindingId,error.code??'LOCAL_CONSULTATION_NOTICE_UNCONFIRMED')
   if(row.resultError)try{await notifyConsultationResult(runtime,row)}catch{/* Retain both the result error and undelivered notice for the next pass. */}
  }
 }
}
