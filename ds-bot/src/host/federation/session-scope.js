export const COMMUNICATION_PRESET = 'ds-bot-communication'
export const communicationPreset = { id: COMMUNICATION_PRESET, name: 'Federated communication', plugins: [
  { name: '@deepseek-ai/dsh-persona', config: { prefix: 'You are a Bot in an isolated federated communication Session.', suffix: '', complete: false, includeRuntimeContext: false } },
] }
export const isCommunicationContext = source => source?.kind === 'runtime-context' && source.form === 'snapshot'
  && Array.isArray(source.sections) && source.sections.every(section => section.name === 'working-directory:current')

const fail = code => { throw Object.assign(new Error(code), { code }) }

export function hasCommunicationPreset(registry, agent) {
  if (registry?.composedPreset(agent.ctx) !== COMMUNICATION_PRESET) return false
  const revisions = registry.inspectCompositions(agent.ctx)
  return revisions.length === 1 && revisions[0].id === COMMUNICATION_PRESET && !revisions[0].leakedServices.length
    && revisions[0].modules.length === 1 && revisions[0].modules[0].moduleName === '@deepseek-ai/dsh-persona'
}

export function sourceDelivery(queue, binding, source) {
  if (!source || source.conversationId !== binding.conversationId) fail('COMMUNICATION_INPUT_SOURCE_UNKNOWN')
  const recovery = source.kind === 'ds-bot-communication-recovery'
  if (!recovery && source.kind !== 'ds-bot-communication') fail('COMMUNICATION_INPUT_SOURCE_UNKNOWN')
  const id = recovery ? source.forDeliveryId : source.deliveryId
  const row = queue.db.prepare('SELECT body,revoked FROM inbox WHERE delivery_id=?').get(id ?? '')
  if (!row || row.revoked) fail('COMMUNICATION_INPUT_SOURCE_UNKNOWN')
  const delivery = JSON.parse(row.body)
  if (delivery.conversationId !== binding.conversationId || delivery.recipientPrincipalId !== binding.recipientPrincipalId
    || delivery.membershipEpoch !== binding.membershipEpoch || !delivery.ai
    || delivery.messageId !== (recovery ? source.forMessageId : source.messageId)
    || !recovery && source.recipientPrincipalId !== binding.recipientPrincipalId
    || source.membershipEpoch !== undefined && source.membershipEpoch !== binding.membershipEpoch) fail('COMMUNICATION_INPUT_SOURCE_UNKNOWN')
  return delivery
}

export function communicationInputs(queue, binding, messages) {
  return messages.filter(message => {
    // Host filesystem notices must never become federated model context.
    if (['agent-instructions', 'working-directory'].includes(message.source?.kind) || isCommunicationContext(message.source)) return false
    sourceDelivery(queue, binding, message.source)
    return true
  })
}

export function legacySessionSettled(queue, binding, agent, events) {
  if (agent.status !== 'idle' || agent.inbox.nextTurn.length || agent.inbox.nextStep.length) return false
  const ends = new Map(events.filter(e => e.type === 'turn/end').map(e => [e.data.turn, e.data.reason?.kind]))
  if (events.some(e => e.type === 'turn/start' && ends.get(e.data.turn) !== 'completed')) return false
  const last = new Map(events.filter(e => e.type === 'assistant/message').map(e => [e.data.turn, e]))
  for (const event of last.values()) {
    const message = event.data.message
    if (!message.content.some(part => part.type === 'text' && part.text.trim()) || message.content.some(part => part.type === 'tool-call')) continue
    const key = JSON.stringify([binding.id, agent.id, event.seq, message.id])
    if (!queue.db.prepare('SELECT 1 FROM exports WHERE source_key=?').get(key)) return false
  }
  return true
}
