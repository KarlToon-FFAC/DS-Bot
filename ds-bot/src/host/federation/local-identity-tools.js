import {sourceDelivery} from './session-scope.js'
const fail=code=>{throw Object.assign(new Error(code),{code})}
export function localIdentityTools(runtime){
 const names=new Set(['read_own_chat','read_group_chat',...(runtime.settings?.localMemory===false?[]:['recall','remember','forget'])])
 return (runtime.rt?.teamTools??[]).filter(tool=>names.has(tool.name)).map(tool=>({...tool,async execute(args,exec){
  const binding=runtime.owners.get(exec.agent?.id)
  if(!binding)fail('COMMUNICATION_INPUT_SOURCE_UNKNOWN')
  await runtime.authorize(binding)
  let source
  if(['remember','forget'].includes(tool.name)){
   const cause=await runtime.toolProvenance(exec)
   const delivery=sourceDelivery(runtime.queue,binding,{kind:'ds-bot-communication',deliveryId:cause.causationDeliveryId,messageId:cause.replyToMessageId,conversationId:binding.conversationId,recipientPrincipalId:binding.recipientPrincipalId,membershipEpoch:binding.membershipEpoch})
   source={conversationId:binding.conversationId,messageId:delivery.messageId,authorPrincipalId:delivery.event.message.author.principalId}
  }
  return tool.execute(args,{...exec,communicationMemorySource:source})
 }}))
}
