import {sourceDelivery} from './session-scope.js'
import {createHash} from 'node:crypto'
const fail=code=>{throw Object.assign(new Error(code),{code})}
function bindingOf(runtime,exec){
 const binding=exec.communicationBinding
 if(!binding||runtime.owners.get(exec.agent?.id)?.id!==binding.id)fail('COMMUNICATION_INPUT_SOURCE_UNKNOWN')
 return binding
}
export function localChiefs(runtime,exec){
 const binding=bindingOf(runtime,exec)
 return Object.values(runtime.rt.state.bots).filter(bot=>bot.id!==binding.localBotRef&&runtime.rt.isMain(bot.id)&&bot.private!==true)
  .map(bot=>({id:bot.id,name:bot.name,role:bot.role??''}))
}
export async function reportToLocalChief(runtime,input,exec){
 const binding=bindingOf(runtime,exec),rt=runtime.rt,cause=exec.communicationCausation
 if(!cause?.causationDeliveryId||!exec.communicationSource)fail('COMMUNICATION_INPUT_SOURCE_UNKNOWN')
 if(rt.readOnly()!==undefined)fail('COMMUNICATION_READ_ONLY')
 if(typeof input.text!=='string'||!input.text.trim()||input.text.length>16000)fail('INVALID_REQUEST')
 const target=localChiefs(runtime,exec).find(bot=>bot.id===input.chiefId)
 if(!target)fail('LOCAL_CHIEF_UNAVAILABLE')
 await runtime.authorize(binding)
 const delivery=sourceDelivery(runtime.queue,binding,{kind:'ds-bot-communication',deliveryId:cause.causationDeliveryId,messageId:cause.replyToMessageId,conversationId:binding.conversationId,recipientPrincipalId:binding.recipientPrincipalId,membershipEpoch:binding.membershipEpoch})
 const remoteSource={conversationId:binding.conversationId,messageId:delivery.messageId,authorPrincipalId:delivery.event.message.author.principalId,reporterPrincipalId:binding.recipientPrincipalId}
 const name=createHash('sha256').update(JSON.stringify([binding.id,cause.causationDeliveryId,target.id])).digest('hex')
 const request=rt.requestIdentity({caller:binding.localBotRef,context:'federation-report:'+binding.id,name,payload:{chiefId:target.id,text:input.text,remoteSource}})
 const result=await rt.admitRequest(request,async()=>{
  await runtime.authorize(binding)
  if(!localChiefs(runtime,exec).some(bot=>bot.id===target.id))fail('LOCAL_CHIEF_UNAVAILABLE')
  await rt.deliver({fromId:binding.localBotRef,toId:target.id,text:input.text.trim(),role:'federation-report',remoteSource,exchangeId:name,steer:false})
  return {status:'delivered',chiefId:target.id,reportId:name,audience:'internal',automaticRemoteReply:false}
 })
 if(['sent','replay'].includes(result.status))return result.receipt
 if(['conflict','uncertain','readonly'].includes(result.status))fail(result.status==='conflict'?'OPERATION_ID_CONFLICT':result.status==='readonly'?'COMMUNICATION_READ_ONLY':'LOCAL_REPORT_UNCONFIRMED')
 return result
}
