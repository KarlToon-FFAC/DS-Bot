import {randomUUID,createHash} from 'node:crypto'
import {createUserMessage} from '@deepseek-ai/dsh-llm'
import {completedOutputs} from './session-journal.js'
import {sourceDelivery} from './session-scope.js'

const fail = code => { throw Object.assign(new Error(code),{code}) }
const digest = text => createHash('sha256').update(text).digest('hex')

// Runs only at the SDK's normal stop boundary; never starts another task or
// exports assistant prose. The durable delivery key bounds correction to once.
export async function checkCommunicationCompletion(runtime,{agent,turn,signal}) {
  const binding = runtime.owners.get(agent.id)
  if (!binding || signal?.aborted) return
  await runtime.authorize(binding)
  await runtime.ctx.sessions.flush(agent.session)
  const {events} = await runtime.ctx.sessionController.inspect(agent.id,signal)
  const current = events.filter(event=>event.type !== 'turn/end' || event.data.turn !== turn)
  const closing = {type:'turn/end',seq:Infinity,data:{turn,reason:{kind:'completed'}}}
  const output = completedOutputs([{sessionId:agent.id,events:[...current,closing]}],binding,{includeEmpty:true})
    .findLast(item=>events.find(event=>event.seq===item.seq)?.data.turn===turn)
  if (!output) return
  const delivery = sourceDelivery(runtime.queue,binding,output.inputSource)
  const messageId = runtime.queue.completedToolReply(binding.id,delivery.deliveryId)
  if (messageId || runtime.queue.replyDeclined(delivery.deliveryId)) return
  const text = output.parts.map(part=>part.text).join('\n')
  const draftId = text.trim() ? randomUUID() : null
  const inserted = runtime.queue.db.prepare('INSERT OR IGNORE INTO completion_checks VALUES (?,?,?,?,?,?,?,?)')
    .run(delivery.deliveryId,binding.id,agent.id,turn,draftId,output.seq,output.messageId,digest(text)).changes
  if (!inserted) {
    runtime.errors.set(binding.id,'REPLY_DECISION_REQUIRED')
    return
  }
  signal?.throwIfAborted()
  agent.steer(createUserMessage({source:{kind:'ds-bot-communication-recovery',form:'notice',summary:'Explicit reply decision required',
    conversationId:binding.conversationId,membershipEpoch:binding.membershipEpoch,forDeliveryId:delivery.deliveryId,forMessageId:delivery.messageId},
    content:[{type:'text',text:`[Local completion check — not a new remote request]\nNo reply decision was submitted for ${delivery.messageId}. Your assistant prose is private and has NOT been sent. Do not repeat work or regenerate an existing answer. Call exactly one of the following tools now:\n${draftId ? `reply_to_communication({"draftId":"${draftId}"}) to explicitly publish your last plain-text draft unchanged (reasoning is excluded); inspect it first and do not publish internal notes.\n` : ''}reply_to_communication({"text":"public reply"}) to write a different public answer; or decline_communication_reply({}) to explicitly choose silence. Ordinary text or a tool name written in text is not a submission. Omit activationTargets for an answer. Do not acknowledge acknowledgements. This is the only automatic reminder; an unresolved decision will be reported as an error, never as no_reply.`}]}))
}

export async function communicationDraft(runtime,draftId,exec) {
  const binding=exec.communicationBinding,cause=exec.communicationCausation
  const row=runtime.queue.db.prepare('SELECT * FROM completion_checks WHERE draft_id=?').get(draftId)
  if (!row || row.binding_id!==binding.id || row.delivery_id!==cause.causationDeliveryId || row.session_id!==exec.agent.id) fail('COMMUNICATION_DRAFT_UNAVAILABLE')
  const {events}=await runtime.ctx.sessionController.inspect(row.session_id,AbortSignal.timeout(15000))
  const event=events.find(item=>item.seq===row.seq && item.type==='assistant/message' && item.data.message.id===row.message_id && item.data.turn===row.turn)
  const blocks=event?.data.message.content
  if (!blocks || event.data.interrupted || blocks.some(part=>!['text','reasoning'].includes(part.type))) fail('COMMUNICATION_DRAFT_UNAVAILABLE')
  const text=blocks.filter(part=>part.type==='text').map(part=>part.text).join('\n')
  if (!text.trim() || digest(text)!==row.hash) fail('COMMUNICATION_DRAFT_UNAVAILABLE')
  return text
}
