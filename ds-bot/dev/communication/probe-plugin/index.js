// Test-only bundle: never included in the published DS-Bot plugin.
import { randomUUID } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { completedOutputs, inspectBinding, reconcileInput, recoverBinding, resumePendingInput, SOURCE_KIND } from '../../../src/host/federation/session-journal.js'

export const name = 'ds-bot-communication-probe'
export const inject = ['connection', 'sessions', 'sessionController']

export function apply(ctx) {
  const root = process.env.DSH_HOME
  if (!root || !process.env.DSBOT_COMMUNICATION_PROBE) throw new Error('Probe requires an isolated bench')
  const stateFile = join(root, 'communication-probe.json')
  const holds = new Map()
  const checkpoints = new Map()
  let productionHold
  let runtimeHold
  const runtimeCheckpoints = new Map()
  ctx.on('ds-bot/communication-checkpoint', async detail => {
    if (runtimeHold?.point !== detail.point || runtimeHold.conversationId !== detail.conversationId) return
    runtimeHold = null
    const key = detail.bindingId ?? detail.deliveryId
    runtimeCheckpoints.set(key, detail)
    await new Promise(resolve => { holds.set(`runtime:${key}`, { release: resolve }) })
  })
  const holdAt = async (agent, point) => {
    if (productionHold?.point === point) {
      const db = new DatabaseSync(join(root, 'bot/communication.sqlite'), { readOnly: true })
      try {
        const binding = db.prepare('SELECT conversation_id,sessions FROM bindings').all().find(row =>
          row.conversation_id === productionHold.conversationId && JSON.parse(row.sessions).includes(agent.id))
        if (binding) { holds.set(agent.id, { point }); productionHold = null }
      } finally { db.close() }
    }
    const hold = holds.get(agent.id)
    if (!hold || hold.point !== point) return
    await ctx.sessions.flush(agent.session)
    checkpoints.set(agent.id, { point, flushed: true })
    await new Promise((resolve, reject) => {
      hold.release = resolve
      hold.reject = reject
    })
  }
  ctx.on('agent/pre-step', async ({ agent }, next) => {
    await holdAt(agent, 'before-admission')
    return next()
  })
  ctx.on('agent/turn-stopping', async ({ agent }) => {
    await holdAt(agent, 'after-output')
  })
  ctx.on('dispose', () => {
    for (const hold of holds.values()) hold.release?.()
    holds.clear()
  })
  let chain = Promise.resolve()
  const serial = work => {
    const result = chain.then(work)
    chain = result.catch(() => {})
    return result
  }
  async function state() {
    const team = JSON.parse(await readFile(join(root, 'bot', 'state.json'), 'utf8'))
    const botId = team.mainBotIds[0]
    if (!team.bots[botId]) throw new Error('The isolated DS-Bot Chief is not ready')
    try {
      const value = JSON.parse(await readFile(stateFile, 'utf8'))
      // Upgrade only this synthetic probe fixture, never a real team identity.
      if (value.botId !== botId) { value.botId = botId; await save(value) }
      return value
    } catch (error) {
      if (error.code !== 'ENOENT') throw error
      const value = { instanceId: randomUUID(), humanId: randomUUID(), botId, bindings: {}, views: {} }
      await writeFile(stateFile, JSON.stringify(value))
      return value
    }
  }
  const save = value => writeFile(stateFile, JSON.stringify(value))
  const agentOf = async id => {
    const result = await ctx.sessionController.resolveAgent(id)
    if ('error' in result) throw new Error('Probe Session unavailable')
    return result.agent
  }
  async function handle(body) {
    const value = await state()
    if (body.operation === 'production-hold') {
      if (['before-admission', 'after-output'].includes(body.point)) productionHold = { point: body.point, conversationId: body.conversationId }
      else if (['before-receive', 'after-receive', 'before-injection', 'after-injection', 'before-export', 'after-export'].includes(body.point)) runtimeHold = { point: body.point, conversationId: body.conversationId }
      else throw new Error('Unknown checkpoint')
      return { armed: true }
    }
    if (body.operation === 'production-state') {
      const db = new DatabaseSync(join(root, 'bot/communication.sqlite'), { readOnly: true })
      try {
        const bindings = db.prepare('SELECT * FROM bindings WHERE conversation_id=?').all(body.conversationId)
        const sessions = []
        for (const binding of bindings) for (const sessionId of JSON.parse(binding.sessions)) {
          const resolved = await ctx.sessionController.resolveAgent(sessionId)
          const presets = ctx.get('agentPresets')
          sessions.push({ sessionId, checkpoint: checkpoints.get(sessionId) ?? null,
            preset: 'error' in resolved ? null : { id: presets?.composedPreset(resolved.agent.ctx), composition: presets?.inspectCompositions(resolved.agent.ctx) },
            ...await ctx.sessionController.inspect(sessionId, AbortSignal.timeout(15000)) })
        }
        return { bindings, sessions, checkpoints: [...runtimeCheckpoints.values()].filter(item => item.conversationId === body.conversationId),
          inbox: db.prepare('SELECT delivery_id,ai,ai_state,mapping,revoked,revocation_result FROM inbox WHERE conversation_id=?').all(body.conversationId),
          exports: db.prepare('SELECT source_key,message_id FROM exports WHERE binding_id IN (SELECT id FROM bindings WHERE conversation_id=?)').all(body.conversationId) }
      } finally { db.close() }
    }
    if (body.operation === 'production-foreign-input') {
      const resolved = await ctx.sessionController.resolveAgent(body.sessionId)
      if ('error' in resolved) throw new Error('Owned test Session unavailable')
      resolved.agent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'Synthetic local input without communication provenance; must never use an earlier communication response grant.' }] }))
      await ctx.sessions.flush(resolved.agent.session)
      return { queued: true }
    }
    if (body.operation === 'production-release') {
      const db = new DatabaseSync(join(root, 'bot/communication.sqlite'), { readOnly: true })
      let released = 0
      try {
        for (const binding of db.prepare('SELECT id,sessions FROM bindings WHERE conversation_id=?').all(body.conversationId)) {
          for (const key of [`runtime:${binding.id}`, ...JSON.parse(binding.sessions)]) {
            const hold = holds.get(key)
            if (hold?.release) { hold.release(); holds.delete(key); checkpoints.delete(key); released += 1 }
          }
        }
      } finally { db.close() }
      return { released }
    }
    if (body.operation === 'identity') return { instanceId: value.instanceId, humanId: value.humanId, botId: value.botId, displayName: 'Chief' }
    if (body.operation === 'view') return { identity: { instanceId: value.instanceId, humanId: value.humanId }, views: value.views ?? {} }
    if (['metrics','native-tools'].includes(body.operation)) {
      const team = JSON.parse(await readFile(join(root, 'bot', 'state.json'), 'utf8'))
      const chief = team.bots[value.botId]
      const inspection = await ctx.sessionController.inspect(chief.sessionId ?? chief.id, AbortSignal.timeout(15000))
      if(body.operation==='native-tools'){
        if(!Number.isSafeInteger(body.afterSeq)||body.afterSeq<0)throw new Error('Invalid watermark')
        return { passiveSendDenied: inspection.events.some(event=>event.seq>body.afterSeq&&JSON.stringify(event.data).includes('PASSIVE_REPLY_ONLY')) }
      }
      const chiefAgent=await ctx.sessionController.resolveAgent(chief.sessionId ?? chief.id)
      return { chiefEvents: inspection.events.length, chiefWatermark: inspection.events.at(-1)?.seq??0,
        chiefStatus:'error' in chiefAgent ? 'unavailable' : chiefAgent.agent.status,
        chiefPending:'error' in chiefAgent ? -1 : chiefAgent.agent.inbox.nextTurn.length + chiefAgent.agent.inbox.nextStep.length,
        humanPrincipalId: `human:${value.instanceId}:${value.humanId}` }
    }
    if (body.operation === 'project') {
      const views = value.views ??= {}
      const view = views[body.conversationId] ??= { title: body.conversationId === 'p0-group' ? 'Shared group' : 'Private message', messages: [], unread: 0 }
      if (!view.messages.some(message => message.messageId === body.messageId)) {
        view.messages.push({ messageId: body.messageId, author: `${body.author?.displayName ?? 'Chief'} · ${body.author?.instanceLabel ?? 'Remote instance'} · Bot`,
          authorPrincipalId: body.author?.principalId ?? 'bot:p0-remote:chief', recipientPrincipalId: `human:${value.instanceId}:${value.humanId}`, text: body.text })
        view.unread += 1
        await save(value)
      }
      return view
    }
    if (body.operation === 'view-send') {
      const views = value.views ??= {}
      const view = views[body.conversationId] ??= { title: body.conversationId === 'p0-group' ? 'Shared group' : 'Private message', messages: [], unread: 0 }
      view.messages.push({ messageId: randomUUID(), author: 'You · Human', text: body.text })
      await save(value)
      return view
    }
    if (body.operation === 'view-read') {
      if (value.views?.[body.conversationId]) value.views[body.conversationId].unread = 0
      await save(value)
      return { read: true }
    }
    if (body.operation === 'bind') {
      let binding = value.bindings[body.conversationId]
      if (!binding) {
        const { sessionId } = await ctx.sessionController.create({ cwd: process.cwd(), agentPreset: 'standard' })
        await ctx.sessionController.selectModel({ sessionId, provider: 'deepseek-official', model: 'deepseek-v4-pro' })
        binding = { id: randomUUID(), conversationId: body.conversationId, localBotRef: value.botId,
          recipientPrincipalId: `bot:${value.instanceId}:${value.botId}`, sessionIds: [sessionId] }
        value.bindings[body.conversationId] = binding
        await save(value)
      }
      return binding
    }
    const binding = value.bindings[body.conversationId]
    if (!binding) throw new Error('Unknown probe conversation')
    if (body.operation === 'segment') {
      const { sessionId } = await ctx.sessionController.create({ cwd: process.cwd(), agentPreset: 'standard' })
      await ctx.sessionController.selectModel({ sessionId, provider: 'deepseek-official', model: 'deepseek-v4-pro' })
      binding.sessionIds.push(sessionId)
      await save(value)
      return binding
    }
    const snapshot = () => inspectBinding(ctx.sessionController, binding, AbortSignal.timeout(15000))
    const source = { kind: SOURCE_KIND, form: 'relay', conversationId: binding.conversationId,
      recipientPrincipalId: binding.recipientPrincipalId, deliveryId: body.deliveryId, messageId: body.messageId }
    if (body.operation === 'recover') {
      const recovered = await recoverBinding(ctx, binding, source, AbortSignal.timeout(15000))
      return { input: recovered.input, outputs: recovered.sessions ? completedOutputs(recovered.sessions, binding, { recoverSettled: true }) : [] }
    }
    if (body.operation === 'queue-wake-probe') {
      const agent = await agentOf(binding.sessionIds.at(-1))
      const pending = [...agent.inbox.nextTurn, ...agent.inbox.nextStep].find(message => message.source?.deliveryId === body.deliveryId)
      if (!pending || agent.status !== 'idle') throw new Error('Probe requires one cold restored idle pending input')
      let followup
      let steer
      try { agent.followup(pending); followup = 'accepted' } catch { followup = 'duplicate_pending_rejected' }
      try {
        await ctx.sessionController.updateQueue({ sessionId: agent.id, itemId: pending.id, action: { kind: 'steer' } })
        steer = 'accepted'
      } catch (error) { steer = error.code ?? 'rejected' }
      await ctx.sessions.flush(agent.session)
      return { followup, steer, agentStatus: agent.status, input: reconcileInput(await snapshot(), source) }
    }
    if (body.operation === 'resume-pending') {
      return resumePendingInput(ctx, binding, source, createUserMessage, AbortSignal.timeout(15000))
    }
    if (body.operation === 'inspect') {
      const sessions = await snapshot()
      return { input: reconcileInput(sessions, source), outputs: completedOutputs(sessions, binding),
        ...(body.diagnostics ? { diagnostics: sessions.map(({ sessionId, events }) => ({ sessionId,
          events: events.map(event => ({ seq: event.seq, type: event.type,
            ...(event.type === 'assistant/message' ? { stream: event.data.stream.map(record => ({ keys: Object.keys(record), type: record.type, chunkType: record.chunk?.type, reason: record.chunk?.reason })) } : {}),
            ...(event.type === 'turn/end' ? { reason: event.data.reason } : {}) })) })) } : {}) }
    }
    if (body.operation === 'arm') {
      holds.set(binding.sessionIds.at(-1), { point: body.point })
      return { armed: true }
    }
    if (body.operation === 'checkpoint') return checkpoints.get(binding.sessionIds.at(-1)) ?? { point: null }
    if (body.operation === 'release') {
      holds.get(binding.sessionIds.at(-1))?.release?.()
      holds.delete(binding.sessionIds.at(-1))
      return { released: true }
    }
    if (body.operation === 'send') {
      let existing = reconcileInput(await snapshot(), source)
      if (body.recovery) existing = (await recoverBinding(ctx, binding, source, AbortSignal.timeout(15000))).input
      if (existing.status !== 'absent' && existing.status !== 'not_admitted') return existing
      const agent = await agentOf(binding.sessionIds.at(-1))
      const message = createUserMessage({ source, content: [{ type: 'text', text: body.text }] })
      if (body.mode === 'queue') agent.inbox.append('next-turn', message)
      else if (body.mode === 'steer') agent.steer(message)
      else agent.followup(message)
      await ctx.sessions.flush(agent.session)
      return reconcileInput(await snapshot(), source)
    }
    if (body.operation === 'wait') {
      const agent = await agentOf(binding.sessionIds.at(-1))
      await agent.whenIdle()
      await ctx.sessions.flush(agent.session)
      return { idle: true }
    }
    throw new Error('Unknown probe operation')
  }
  ctx.effect(() => ctx.connection.fetch.register({
    path: '/api/communication-probe', methods: ['POST'], requestBody: 'buffered',
    fetch: async request => {
      try {
        const body = await request.json()
        const result = await serial(() => handle(body))
        return Response.json({ ok: true, value: result })
      } catch {
        return Response.json({ ok: false, error: 'Probe operation failed; inspect isolated bench logs' }, { status: 400 })
      }
    },
  }), 'communication-probe: test route')
}
