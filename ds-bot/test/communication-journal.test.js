import assert from 'node:assert/strict'
import { test } from 'node:test'
import { completedOutputs, inspectBinding, interruptedInputs, reconcileInput, recoverBinding, resumePendingInput, resumeInterruptedInput, retryablePromptAttempt, RECOVERY_SOURCE_KIND, SOURCE_KIND } from '../src/host/federation/session-journal.js'

const source = { kind: SOURCE_KIND, deliveryId: 'delivery-1', messageId: 'message-1', conversationId: 'dm-a-k', recipientPrincipalId: 'bot:b:k' }
const message = { id: 'input-1', source, role: 'user', content: [{ type: 'text', text: 'same text' }] }
const splice = (seq, start, removedCount, inserted, extra = {}) => ({ seq, type: 'agent/inbox/spliced', data: { target: 'next-turn', start, removedCount, inserted, ...extra } })
const withInputs = events => events.flatMap(event => event.type === 'assistant/message' && !events.some(e => e.type === 'user/message' && e.data.turn === event.data.turn)
  ? [{ seq: event.seq - 0.1, type: 'user/message', data: { ...message, turn: event.data.turn } }, event] : [event])
const session = events => [{ sessionId: 'session-1', events: withInputs(events) }]

test('a repaired interrupted admitted input resumes with distinct host metadata without re-admitting the original input', async () => {
  const binding = { id: 'binding', conversationId: source.conversationId, recipientPrincipalId: source.recipientPrincipalId, sessionIds: ['session-1'] }
  const events = [{ seq: 0, type: 'turn/start', data: { turn: 1 } }, { seq: 1, type: 'user/message', data: message },
    { seq: 2, type: 'turn/end', data: { turn: 1, reason: { kind: 'interrupted' } } }]
  const notices = [], attempted = new Set()
  const agent = { id: 'session-1', status: 'idle', session: {}, steer: notice => notices.push(notice) }
  const services = { sessions: { flush: async () => {} }, sessionController: { resolveAgent: async () => ({ agent }), inspect: async () => ({ events }) } }
  const result = await resumeInterruptedInput(services, binding, source, value => ({ ...value, id: 'host-notice' }), attempted)
  assert.equal(result.resumed, true)
  assert.equal(notices.length, 1)
  assert.equal(notices[0].source.kind, RECOVERY_SOURCE_KIND)
  assert.equal(notices[0].source.forMessageId, source.messageId)
  assert.notEqual(notices[0].id, message.id)
  assert.equal((await resumeInterruptedInput(services, binding, source, () => { throw new Error('must not duplicate') }, attempted)).resumed, false)
  assert.equal(events.filter(event => event.type === 'user/message' && event.data.source.kind === SOURCE_KIND).length, 1)
  events.push({ seq: 3, type: 'turn/start', data: { turn: 2 } }, { seq: 4, type: 'user/message', data: notices[0] },
    { seq: 5, type: 'turn/end', data: { turn: 2, reason: { kind: 'completed' } } })
  assert.deepEqual(interruptedInputs(session(events), binding), [])
})

test('completed, deliberately aborted, blocked and failed turns never become host-restart input retries', () => {
  const binding = { conversationId: source.conversationId, recipientPrincipalId: source.recipientPrincipalId }
  for (const kind of ['completed', 'aborted', 'blocked', 'failed']) {
    const events = [{ seq: 0, type: 'turn/start', data: { turn: 1 } }, { seq: 1, type: 'user/message', data: message },
      { seq: 2, type: 'turn/end', data: { turn: 1, reason: { kind } } }]
    assert.deepEqual(interruptedInputs(session(events), binding), [])
  }
})

test('reconcile pending, admitted and explicitly canceled durable input', () => {
  const queued = [splice(0, 0, 0, [message])]
  assert.equal(reconcileInput(session(queued), source).status, 'queued')
  const claimed = [...queued, splice(1, 0, 1, [])]
  assert.deepEqual(reconcileInput(session(claimed), source), { status: 'injection_unknown', reason: 'claimed_without_admission' })
  const admitted = [...claimed, { seq: 2, type: 'user/message', data: message }]
  assert.deepEqual(reconcileInput(session(admitted), source), { status: 'admitted', sessionId: 'session-1', seq: 2, messageId: 'input-1' })
  assert.equal(reconcileInput(session([...queued, splice(1, 0, 1, [], { outcome: 'canceled' })]), source).status, 'canceled')
})

test('identical text from a different conversation, recipient or source is not a receipt', () => {
  for (const changed of [{ conversationId: 'group-g' }, { recipientPrincipalId: 'bot:b:j' }, { messageId: 'other' }, { kind: 'user' }]) {
    const other = { ...message, source: { ...source, ...changed } }
    assert.equal(reconcileInput(session([{ seq: 0, type: 'user/message', data: other }]), source).status, 'absent')
  }
})

test('duplicate admissions and corrupt inbox history do not report success', () => {
  const events = [0, 1].map(seq => ({ seq, type: 'user/message', data: message }))
  assert.equal(reconcileInput(session(events), source).reason, 'duplicate_input')
  assert.throws(() => reconcileInput(session([splice(0, 1, 0, [message])]), source), /Invalid durable/)
})

test('public inspection includes archived binding segments and propagates failures', async () => {
  const ids = []
  const controller = { inspect: async id => { ids.push(id); return { events: [] } } }
  await inspectBinding(controller, { sessionIds: ['old', 'current'] })
  assert.deepEqual(ids, ['old', 'current'])
  await assert.rejects(inspectBinding({ inspect: async () => null }, { sessionIds: ['missing'] }), /unavailable/)
  const abort = AbortSignal.abort(new Error('stop'))
  await assert.rejects(inspectBinding(controller, { sessionIds: ['old'] }, abort), /stop/)
})

const assistant = (seq, turn, content, extra = {}) => ({ seq, type: 'assistant/message', data: { turn, step: 1, message: { id: `output-${seq}`, content }, ...extra } })
const end = turn => ({ type: 'turn/end', data: { turn, reason: { kind: 'completed' } } })
const binding = { id: 'binding-k', conversationId: 'dm-a-k', recipientPrincipalId: 'bot:b:k' }
test('export only completed final text and retain stable identities across rescans and segments', () => {
  const text = [{ type: 'text', text: 'reply' }]
  const events = [assistant(1, 1, [{ type: 'reasoning', text: 'private' }, ...text]), end(1),
    assistant(3, 2, [...text, { type: 'tool-call', id: 'call', name: 'read_file' }]), end(2),
    assistant(5, 3, text, { interrupted: true }), end(3), assistant(6, 4, text),
    assistant(7, 5, text), assistant(8, 5, [{ type: 'text', text: 'final' }]), end(5)]
  const sessions = [{ sessionId: 'old', events: withInputs(events) }, { sessionId: 'new', events: withInputs([assistant(1, 1, text), end(1)]) }]
  const outputs = completedOutputs(sessions, binding)
  assert.equal(outputs.length, 3)
  assert.deepEqual(outputs[0].parts, [{ part: 1, text: 'reply' }])
  assert.deepEqual(outputs[1].parts, [{ part: 0, text: 'final' }])
  assert.equal(new Set(outputs.map(output => output.sourceKey)).size, 3)
  assert.deepEqual(completedOutputs(sessions, binding), outputs)
  assert.ok(outputs.every(output => output.conversationId === 'dm-a-k'))
  assert.ok(!JSON.stringify(outputs).includes('private'))
})

test('a final output with an attachment cannot silently become a text-only reply', () => {
  assert.throws(() => completedOutputs(session([
    assistant(1, 1, [{ type: 'text', text: 'see attached' }, { type: 'image' }]), end(1),
  ]), binding), { code: 'UNSUPPORTED_CONTENT' })
})

test('claimed input may only be replayed after acquiring an idle writer and a repaired closed log', async () => {
  const events = [{ type: 'turn/start', data: { turn: 1 } }, splice(1, 0, 0, [message]), splice(2, 0, 1, []),
    { type: 'turn/end', data: { turn: 1, reason: { kind: 'interrupted' } } }]
  const owner = { status: 'idle', session: {} }
  const services = { sessionController: { resolveAgent: async () => ({ agent: owner }), inspect: async () => ({ events }) }, sessions: { flush: async () => {} } }
  const bound = { ...binding, sessionIds: ['session-1'] }
  assert.equal((await recoverBinding(services, bound, source)).input.status, 'not_admitted')
  owner.status = 'running'
  assert.equal((await recoverBinding(services, bound, source)).input.reason, 'input_in_flight')
  owner.status = 'idle'
  events.pop()
  assert.equal((await recoverBinding(services, bound, source)).input.status, 'injection_unknown')
  services.sessionController.resolveAgent = async () => ({ error: { code: 'session/writer-held' } })
  assert.equal((await recoverBinding(services, bound, source)).input.reason, 'writer_unavailable')
})

test('an absent input intent is only proven unadmitted by an exclusive idle writer with a closed log', async () => {
  const owner = { status: 'idle', session: {} }, events = []
  const services = { sessionController: { resolveAgent: async () => ({ agent: owner }), inspect: async () => ({ events }) }, sessions: { flush: async () => {} } }
  const bound = { ...binding, sessionIds: ['session-1'] }
  assert.equal((await recoverBinding(services, bound, source)).input.status, 'not_admitted')
  events.push({ type: 'turn/start', data: { turn: 1 } })
  assert.equal((await recoverBinding(services, bound, source)).input.status, 'absent')
  owner.status = 'running'
  assert.equal((await recoverBinding(services, bound, source)).input.status, 'injection_unknown')
})

test('recover a settled final reply whose turn end was lost; exclude cutoff and reasoning-only output', () => {
  const final = assistant(5, 1, [{ type: 'reasoning', text: 'private' }, { type: 'text', text: 'durable final' }], {
    stream: [{ type: 'chunk', chunk: { type: 'finish', reason: { kind: 'stop' } } }],
  })
  const events = [final, { type: 'turn/end', data: { turn: 1, reason: { kind: 'interrupted' } } }]
  assert.equal(completedOutputs(session(events), binding).length, 0)
  const recovered = completedOutputs(session(events), binding, { recoverSettled: true })
  assert.equal(recovered.length, 1)
  assert.deepEqual(recovered[0].parts, [{ part: 1, text: 'durable final' }])
  assert.equal(completedOutputs(session([{ ...final, data: { ...final.data, interrupted: true } }, events[1]]), binding, { recoverSettled: true }).length, 0)
  final.data.stream[0].chunk.reason.kind = 'max-tokens'
  assert.equal(completedOutputs(session(events), binding, { recoverSettled: true }).length, 0)
})

test('a later started step prevents exporting an earlier stop response as the recovered final reply', () => {
  const final = assistant(5, 1, [{ type: 'text', text: 'earlier response' }], {
    stream: [{ type: 'chunk', chunk: { type: 'finish', reason: { kind: 'stop' } } }],
  })
  const events = [final, { seq: 6, type: 'step/start', data: { turn: 1, step: 2 } },
    { seq: 7, type: 'turn/end', data: { turn: 1, reason: { kind: 'interrupted' } } }]
  assert.equal(completedOutputs(session(events), binding, { recoverSettled: true }).length, 0)
  const laterTurn = [final, events[2], { seq: 8, type: 'step/start', data: { turn: 2, step: 1 } },
    splice(9, 0, 0, [message], { target: 'next-step' })]
  assert.equal(completedOutputs(session(laterTurn), binding, { recoverSettled: true }).length, 1)
})

test('pending recovery preserves the original input and sends a distinct host notice through public steer', async () => {
  const events = [splice(0, 0, 0, [message])]
  const notices = []
  const agent = { status: 'idle', session: {}, inbox: { nextTurn: [message], nextStep: [] },
    steer: notice => { notices.push(notice); events.push(splice(1, 0, 1, []), { seq: 2, type: 'user/message', data: message }) } }
  const services = { sessionController: { resolveAgent: async () => ({ agent }), inspect: async () => ({ events }) }, sessions: { flush: async () => {} } }
  const bound = { ...binding, sessionIds: ['session-1'] }
  const result = await resumePendingInput(services, bound, source, value => ({ ...value, id: 'host-notice', role: 'user' }))
  assert.equal(result.resumed, true)
  assert.equal(result.input.messageId, message.id)
  assert.equal(notices[0].source.kind, RECOVERY_SOURCE_KIND)
  assert.equal(notices[0].source.forDeliveryId, source.deliveryId)
  assert.equal(notices[0].source.deliveryId, undefined)
  assert.equal(notices[0].source.authorPrincipalId, undefined)
  assert.deepEqual(agent.inbox.nextTurn, [message])
  assert.equal((await resumePendingInput(services, bound, source, () => { throw new Error('must not repeat') })).resumed, false)
})

test('pending recovery refuses a factory that disguises a lifecycle notice as a human message', async () => {
  const events = [splice(0, 0, 0, [message])]
  let steered = false
  const agent = { status: 'idle', session: {}, inbox: { nextTurn: [message], nextStep: [] }, steer: () => { steered = true } }
  const services = { sessionController: { resolveAgent: async () => ({ agent }), inspect: async () => ({ events }) }, sessions: { flush: async () => {} } }
  await assert.rejects(resumePendingInput(services, { ...binding, sessionIds: ['session-1'] }, source,
    value => ({ ...value, id: 'forged', source: { kind: 'user' } })), /host origin/)
  assert.equal(steered, false)
})

for (const reason of ['aborted', 'error', 'completed', 'interrupted']) {
  test(`claimed recovery notice without admission retains ${reason} ownership after restart`, () => {
    const binding = { conversationId: source.conversationId, recipientPrincipalId: source.recipientPrincipalId }
    const notice = { id: 'notice', source: { kind: RECOVERY_SOURCE_KIND, form: 'notice', conversationId: source.conversationId, forDeliveryId: source.deliveryId, forMessageId: source.messageId } }
    const events = [{ seq: 1, type: 'turn/start', data: { turn: 1 } }, { seq: 2, type: 'user/message', data: message },
      { seq: 3, type: 'turn/end', data: { turn: 1, reason: { kind: 'interrupted' } } }, splice(4, 0, 0, [notice]),
      { seq: 5, type: 'turn/start', data: { turn: 2 } }, splice(6, 0, 1, []),
      { seq: 7, type: 'turn/end', data: { turn: 2, reason: { kind: reason } } }]
    const candidates = interruptedInputs([{ sessionId: 'session-1', events }], binding)
    assert.equal(candidates.length, reason === 'interrupted' ? 1 : 0)
    if (candidates.length) assert.equal(candidates[0].turn, 2)
  })
}

for (const mutation of ['none', 'no-owned-proof', 'wrong-notice', 'wrong-delivery', 'canceled-signal', 'no-claim', 'canceled-claim', 'request/header', 'step/start', 'tool/result', 'user/message', 'unknown/event', 'second-turn']) {
  test(`prompt retry journal gate rejects ${mutation} unless exact owned pre-model failure`, () => {
    const control = new AbortController(), binding = { conversationId: source.conversationId }
    const notice = { id: 'notice', source: { kind: RECOVERY_SOURCE_KIND, form: 'notice', conversationId: source.conversationId, forDeliveryId: source.deliveryId, forMessageId: source.messageId } }
    const attempt = { guardFailed: true, signal: control.signal, sessionId: 'session-1', noticeId: 'notice', source, binding, afterSeq: 3 }
    const events = [splice(4, 0, 0, [notice]), { seq: 5, type: 'turn/start', data: { turn: 2 } }, splice(6, 0, 1, []),
      { seq: 7, type: 'model/selection', data: {} }, { seq: 8, type: 'turn/end', data: { turn: 2, reason: { kind: 'error' } } }]
    if (mutation === 'no-owned-proof') attempt.guardFailed = false
    if (mutation === 'wrong-notice') attempt.noticeId = 'other'
    if (mutation === 'wrong-delivery') notice.source.forDeliveryId = 'other'
    if (mutation === 'canceled-signal') control.abort()
    if (mutation === 'no-claim') events.splice(2, 1)
    if (mutation === 'canceled-claim') events[2].data.outcome = 'canceled'
    if (mutation === 'second-turn') events.push({ seq: 9, type: 'turn/start', data: { turn: 3 } })
    if (mutation.includes('/')) events.splice(3, 0, { seq: 6.5, type: mutation, data: {} })
    assert.equal(retryablePromptAttempt(attempt, [{ sessionId: 'session-1', events }]), mutation === 'none')
  })
}
