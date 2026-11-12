import {sourceDelivery} from './session-scope.js'
const fail=code=>{throw Object.assign(new Error(code),{code})}
export function localIdentityTools(runtime){
 const excluded=new Set(['group_relay',...(runtime.tools??[]).map(tool=>tool.name),...(runtime.settings?.localMemory===false?['recall','remember','forget']:[])])
 return (runtime.rt?.teamTools??[]).filter(tool=>!excluded.has(tool.name)).map(tool=>({...tool,async execute(args,exec){
  const binding=runtime.owners.get(exec.agent?.id)
  if(!binding||runtime.closed||!runtime.rt.teamTools.includes(tool))fail('COMMUNICATION_INPUT_SOURCE_UNKNOWN')
  await runtime.authorize(binding)
  let source
  if(['remember','forget','message_bot','stop_bot'].includes(tool.name)){
   const cause=await runtime.toolProvenance(exec)
   const delivery=sourceDelivery(runtime.queue,binding,{kind:'ds-bot-communication',deliveryId:cause.causationDeliveryId,messageId:cause.replyToMessageId,conversationId:binding.conversationId,recipientPrincipalId:binding.recipientPrincipalId,membershipEpoch:binding.membershipEpoch})
   source={conversationId:binding.conversationId,messageId:delivery.messageId,authorPrincipalId:delivery.event.message.author.principalId}
  }
  return tool.execute(args,{...exec,communicationMemorySource:source,communicationLocalSource:source})
 }}))
}
