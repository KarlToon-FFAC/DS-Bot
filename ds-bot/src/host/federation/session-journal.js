// Public Session inspection is the recovery source; never infer receipt from text.
import { isCommunicationContext } from './session-scope.js'
export const SOURCE_KIND = 'ds-bot-communication'
export const RECOVERY_SOURCE_KIND = 'ds-bot-communication-recovery'

export const RECOVERY_NOTICE = '[Local transport recovery notice]\nThe host restarted. Process the already accepted communication input in this batch. Its original sender and delivery identity are unchanged. This is host metadata, not a new Human or Bot message; do not answer this notice separately.'

export async function inspectBinding(controller, binding, signal) {
  const sessions = []
  for (const sessionId of binding.sessionIds) {
    signal?.throwIfAborted()
    const inspection = await controller.inspect(sessionId, signal)
    if (!Array.isArray(inspection?.events)) throw new Error('Session inspection unavailable')
    sessions.push({ sessionId, events: inspection.events })
  }
  return sessions
}

// resolveAgent acquires DSH's Session writer ownership; an idle owner can inspect
// the complete repaired log without racing a previous host's in-flight admission.
export async function recoverBinding(services, binding, source, signal) {
  const agents = []
  for (const sessionId of binding.sessionIds) {
    signal?.throwIfAborted()
    const resolved = await services.sessionController.resolveAgent(sessionId)
    if ('error' in resolved) return { input: { status: 'injection_unknown', reason: 'writer_unavailable' } }
    agents.push(resolved.agent)
  }
  if (agents.some(agent => agent.status !== 'idle')) return { input: { status: 'injection_unknown', reason: 'input_in_flight' } }
  for (const agent of agents) await services.sessions.flush(agent.session)
  const sessions = await inspectBinding(services.sessionController, binding, signal)
  // An await above could have let new input start; the caller must also serialize
  // its own consumer. Do not issue a replay grant if any owner became active.
  if (agents.some(agent => agent.status !== 'idle')) return { input: { status: 'injection_unknown', reason: 'input_in_flight' } }
  const input = reconcileInput(sessions, source)
  if (input.status === 'absent' || input.status === 'injection_unknown' && input.reason === 'claimed_without_admission') {
    const openTurns = new Set()
    for (const { sessionId, events } of sessions) {
      for (const event of events) {
        const key = JSON.stringify([sessionId, event.data?.turn])
        if (event.type === 'turn/start') openTurns.add(key)
        if (event.type === 'turn/end') openTurns.delete(key)
      }
    }
    if (openTurns.size === 0) return { input: { status: 'not_admitted', proof: 'exclusive_idle_writer' }, sessions }
  }
  return { input, sessions }
}

// Called only by serialized startup recovery, after membership/recipient checks.
// A real lifecycle notice may wake the driver; the accepted input is never removed,
// copied, or re-authored. Notice text and origin stay separate from network messages.
export async function resumePendingInput(services, binding, source, makeMessage, signal) {
  const recovered = await recoverBinding(services, binding, source, signal)
  if (recovered.input.status !== 'queued') return { input: recovered.input, resumed: false }
  const resolved = await services.sessionController.resolveAgent(recovered.input.sessionId)
  if ('error' in resolved) return { input: { status: 'injection_unknown', reason: 'writer_unavailable' }, resumed: false }
  const agent = resolved.agent
  const pending = [...agent.inbox.nextTurn, ...agent.inbox.nextStep].find(message => message.id === recovered.input.messageId)
  if (!pending || agent.status !== 'idle') return { input: { status: 'injection_unknown', reason: 'input_in_flight' }, resumed: false }
  const notice = makeMessage({
    source: { kind: RECOVERY_SOURCE_KIND, form: 'notice', summary: 'Resuming durable communication input after a host restart',
      conversationId: binding.conversationId, forDeliveryId: source.deliveryId, forMessageId: source.messageId },
    content: [{ type: 'text', text: RECOVERY_NOTICE }],
  })
  if (!notice?.id || notice.source?.kind !== RECOVERY_SOURCE_KIND || notice.source?.form !== 'notice'
    || notice.source?.conversationId !== binding.conversationId || notice.source?.forDeliveryId !== source.deliveryId) {
    throw new Error('Recovery notice must retain its host origin and exact conversation')
  }
  signal?.throwIfAborted()
  agent.steer(notice)
  await services.sessions.flush(agent.session)
  const sessions = await inspectBinding(services.sessionController, binding, signal)
  return { input: reconcileInput(sessions, source), resumed: true,
    notice: { id: notice.id, kind: notice.source.kind, form: notice.source.form } }
}

// A repaired interrupted turn proves a host loss, unlike a user abort or model
// failure. Resume its existing input with host metadata; never re-admit it.
export async function resumeInterruptedInput(services, binding, source, makeMessage, attempted, signal, { onAttempt, retryNoticeIds, retryTurnKey, retryProof } = {}) {
  const recovered = await recoverBinding(services, binding, source, signal)
  if (recovered.input.status !== 'admitted') return { resumed: false }
  if (retryProof && !retryablePromptAttempt(retryProof, recovered.sessions)) return { resumed: false }
  const candidate = interruptedInputs(recovered.sessions, binding, { retryNoticeIds }).find(item => item.source.deliveryId === source.deliveryId)
  if (!candidate) return { resumed: false }
  const turnKey = JSON.stringify([candidate.sessionId, candidate.turn])
  if (attempted.has(turnKey) && retryTurnKey !== turnKey) return { resumed: false }
  const result = await services.sessionController.resolveAgent(candidate.sessionId)
  if ('error' in result || result.agent.status !== 'idle') return { resumed: false }
  if (retryProof) {
    await services.sessions.flush(result.agent.session)
    if (!retryablePromptAttempt(retryProof, await inspectBinding(services.sessionController, binding, signal)) || result.agent.status !== 'idle') return { resumed: false }
  }
  const notice = makeMessage({ source: { kind: RECOVERY_SOURCE_KIND, form: 'notice', summary: 'Resuming interrupted communication response after a host restart',
    conversationId: binding.conversationId, forDeliveryId: source.deliveryId, forMessageId: source.messageId },
    content: [{ type: 'text', text: `[Local transport recovery notice]\nThe host restarted during a response. Continue only the already admitted communication input ${source.messageId}. Its original sender and delivery identity are unchanged. This is host metadata, not a new Human or Bot message. Earlier inputs are context, not new requests. Check evidence before repeating any tool side effects that may already have happened. Do not answer this notice separately.` }] })
  if (!notice?.id || notice.source?.kind !== RECOVERY_SOURCE_KIND || notice.source.form !== 'notice' || notice.source.forDeliveryId !== source.deliveryId
    || notice.source.forMessageId !== source.messageId || notice.source.conversationId !== binding.conversationId) throw new Error('Invalid interrupted recovery notice')
  signal?.throwIfAborted()
  onAttempt?.({ turnKey, noticeId: notice.id, sessionId: candidate.sessionId, source, binding, afterSeq: recovered.sessions.find(item => item.sessionId === candidate.sessionId).events.reduce((max, event) => Math.max(max, event.seq), 0) })
  attempted.add(turnKey)
  result.agent.steer(notice)
  await services.sessions.flush(result.agent.session)
  return { resumed: true, turnKey, noticeId: notice.id }
}

export function interruptedInputs(sessions, binding, { retryNoticeIds = [] } = {}) {
  const candidates = []
  for (const session of sessions) {
    const turns = new Map(), inputs = new Map(), inbox = { 'next-turn': [], 'next-step': [] }
    let turn
    for (const event of session.events) {
      if (event.type === 'turn/start') { turn = event.data.turn; turns.set(turn, { start: event.seq }) }
      if (event.type === 'turn/end' && turns.has(event.data.turn)) Object.assign(turns.get(event.data.turn), { end: event.seq, reason: event.data.reason.kind })
      // A pre-step failure can consume the notice without admitting user/message.
      // Its cancelled/error terminal still owns that input across host restarts.
      if (event.type === 'agent/inbox/spliced') {
        const { target, start, removedCount = 0, inserted, outcome } = event.data
        const queue = inbox[target]
        if (!queue || !Array.isArray(inserted) || !Number.isSafeInteger(start) || start < 0 || start > queue.length
          || !Number.isSafeInteger(removedCount) || removedCount < 0 || start + removedCount > queue.length) throw new Error('Invalid durable inbox history')
        for (const notice of queue.splice(start, removedCount, ...inserted)) {
          const source = notice.source, input = inputs.get(source?.forDeliveryId)
          if (!retryNoticeIds.includes(notice.id) && source?.kind === RECOVERY_SOURCE_KIND && source.conversationId === binding.conversationId
            && input?.source.messageId === source.forMessageId) input.turn = outcome === 'canceled' ? undefined : turn
        }
      }
      if (event.type !== 'user/message' || event.data.source?.conversationId !== binding.conversationId) continue
      const source = event.data.source
      if ([SOURCE_KIND,'ds-bot-communication-update'].includes(source.kind) && source.recipientPrincipalId === binding.recipientPrincipalId) inputs.set(source.deliveryId, { source, turn })
      if (source.kind === RECOVERY_SOURCE_KIND && inputs.has(source.forDeliveryId)) inputs.get(source.forDeliveryId).turn = turn
    }
    const outputs = completedOutputs([session], binding, { recoverSettled: true })
    for (const input of inputs.values()) {
      const bounds = turns.get(input.turn)
      if (bounds?.reason !== 'interrupted' || outputs.some(output => output.seq > bounds.start && output.seq < bounds.end)) continue
      candidates.push({ ...input, sessionId: session.sessionId })
    }
  }
  return candidates
}

export function reconcileInput(sessions, source) {
  const admitted = []
  const pending = []
  let claimed = false
  let canceled = false
  const matches = message => message?.source?.kind === source.kind
    && message.source.deliveryId === source.deliveryId
    && message.source.messageId === source.messageId
    && message.source.conversationId === source.conversationId
    && message.source.recipientPrincipalId === source.recipientPrincipalId

  for (const { sessionId, events } of sessions) {
    const inbox = { 'next-turn': [], 'next-step': [] }
    for (const event of events) {
      if (event.type === 'user/message' && matches(event.data)) {
        admitted.push({ sessionId, seq: event.seq, messageId: event.data.id })
      }
      if (event.type !== 'agent/inbox/spliced') continue
      const { target, start, removedCount = 0, inserted, outcome } = event.data
      const queue = inbox[target]
      if (!queue || !Array.isArray(inserted) || !Number.isSafeInteger(start)
        || start < 0 || start > queue.length || !Number.isSafeInteger(removedCount)
        || removedCount < 0 || start + removedCount > queue.length) {
        throw new Error('Invalid durable inbox history')
      }
      const removed = queue.splice(start, removedCount, ...inserted)
      if (removed.some(matches)) {
        if (outcome === 'canceled') canceled = true
        else claimed = true
      }
    }
    for (const queue of Object.values(inbox)) {
      pending.push(...queue.filter(matches).map(message => ({ sessionId, messageId: message.id })))
    }
  }
  if (admitted.length > 1 || pending.length > 1 || (admitted.length && pending.length)) {
    return { status: 'injection_unknown', reason: 'duplicate_input', admitted, pending }
  }
  if (admitted.length) return { status: 'admitted', ...admitted[0] }
  if (pending.length) return { status: 'queued', ...pending[0] }
  if (canceled) return { status: 'canceled' }
  if (claimed) return { status: 'injection_unknown', reason: 'claimed_without_admission' }
  // Absence is an observation, not permission to retry during an in-flight call.
  return { status: 'absent' }
}

export function completedOutputs(sessions, binding, { recoverSettled = false } = {}) {
  const outputs = []
  for (const { sessionId, events } of sessions) {
    const completedTurns = new Set(events.filter(event => event.type === 'turn/end'
      && event.data.reason?.kind === 'completed').map(event => event.data.turn))
    const interruptedTurns = new Set(events.filter(event => event.type === 'turn/end'
      && event.data.reason?.kind === 'interrupted').map(event => event.data.turn))
    const lastByTurn = new Map()
    const inputsByTurn = new Map()
    let currentTurn
    for (const event of events) {
      if (event.type === 'turn/start') currentTurn = event.data.turn
      if (event.type === 'user/message') {
        if (isCommunicationContext(event.data.source)) continue
        const turn = event.data.turn ?? currentTurn
        const inputs = inputsByTurn.get(turn) ?? []
        inputs.push(event.data.source)
        inputsByTurn.set(turn, inputs)
      }
      if (event.type === 'assistant/message') lastByTurn.set(event.data.turn, event)
    }
    for (const [turn, event] of lastByTurn) {
      const { message, interrupted } = event.data
      const settled = event.data.stream?.findLast(record => record.type === 'chunk' && record.chunk.type === 'finish')?.chunk.reason?.kind
      const closingSeq = events.find(end => end.type === 'turn/end' && end.data.turn === turn)?.seq ?? Infinity
      const continued = events.some(later => later.seq > event.seq && later.seq < closingSeq && (
        (later.type === 'step/start' && later.data.turn === turn)
        || (later.type === 'agent/inbox/spliced' && later.data.target === 'next-step' && later.data.inserted.length > 0)))
      const recovered = recoverSettled && interruptedTurns.has(turn) && settled === 'stop' && !continued
      if ((!completedTurns.has(turn) && !recovered) || interrupted || !message?.id
        || message.content.some(block => block.type === 'tool-call')) continue
      if (message.content.some(block => !['text', 'reasoning'].includes(block.type))) {
        throw Object.assign(new Error('Communication output contains unsupported content'), { code: 'UNSUPPORTED_CONTENT' })
      }
      const parts = message.content.flatMap((block, index) => block.type === 'text'
        ? [{ part: index, text: block.text }] : [])
      if (!parts.some(part => part.text.trim())) continue
      const inputs = inputsByTurn.get(turn) ?? []
      if (!inputs.length || inputs.some(source => !source || ![SOURCE_KIND, RECOVERY_SOURCE_KIND, 'ds-bot-communication-update'].includes(source.kind)
        || source.conversationId !== binding.conversationId
        || source.kind === SOURCE_KIND && source.recipientPrincipalId !== binding.recipientPrincipalId
        || source.membershipEpoch !== undefined && source.membershipEpoch !== binding.membershipEpoch)) {
        throw Object.assign(new Error('Output has no exclusive communication input provenance'), { code: 'COMMUNICATION_OUTPUT_SOURCE_UNKNOWN' })
      }
      outputs.push({
        sourceKey: JSON.stringify([binding.id, sessionId, event.seq, message.id]),
        conversationId: binding.conversationId,
        recipientPrincipalId: binding.recipientPrincipalId,
        sessionId, seq: event.seq, messageId: message.id, parts, inputSource: inputs.at(-1),
      })
    }
  }
  return outputs
}

// A runtime-owned failed guard is necessary; journal text alone never grants a retry.
export function retryablePromptAttempt(attempt, sessions) {
  if (!attempt?.guardFailed || !attempt.signal || attempt.signal.aborted) return false
  const events = sessions.find(item => item.sessionId === attempt.sessionId)?.events.filter(event => event.seq > attempt.afterSeq)
  if (!events?.length) return false
  const allowed = new Set(['agent/inbox/spliced', 'turn/start', 'turn/end', 'model/selection'])
  if (events.some(event => !allowed.has(event.type))) return false
  const starts = events.filter(event => event.type === 'turn/start'), ends = events.filter(event => event.type === 'turn/end')
  if (starts.length !== 1 || ends.length !== 1 || ends[0].data.turn !== starts[0].data.turn || ends[0].data.reason?.kind !== 'error') return false
  const inserted = events.filter(event => event.type === 'agent/inbox/spliced').flatMap(event => event.data.inserted ?? [])
  if (inserted.length !== 1) return false
  const notice = inserted[0], source = notice.source
  const inbox = { 'next-turn': [], 'next-step': [] }
  let claimed = false
  for (const event of events) {
    if (event.type !== 'agent/inbox/spliced') continue
    const { target, start, removedCount = 0, inserted, outcome } = event.data, queue = inbox[target]
    if (!queue || !Array.isArray(inserted) || !Number.isSafeInteger(start) || start < 0 || start > queue.length
      || !Number.isSafeInteger(removedCount) || removedCount < 0 || start + removedCount > queue.length) return false
    const removed = queue.splice(start, removedCount, ...inserted)
    if (removed.some(item => item.id === attempt.noticeId)) {
      if (outcome === 'canceled' || event.seq <= starts[0].seq || event.seq >= ends[0].seq) return false
      claimed = true
    }
  }
  return claimed && notice.id === attempt.noticeId && source?.kind === RECOVERY_SOURCE_KIND && source.form === 'notice'
    && source.conversationId === attempt.binding.conversationId && source.forDeliveryId === attempt.source.deliveryId
    && source.forMessageId === attempt.source.messageId
    && events.at(-1) === ends[0]
}
