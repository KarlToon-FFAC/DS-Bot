import { join } from 'node:path'
import { mkdir } from 'node:fs/promises'
import { createHash, randomUUID } from 'node:crypto'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { CommunicationQueue } from './queue-store.js'
import { CommunicationTransport, communicationUrl } from './transport.js'
import { completedOutputs, inspectBinding, interruptedInputs, reconcileInput, recoverBinding, resumePendingInput, resumeInterruptedInput, SOURCE_KIND } from './session-journal.js'
import { communicationMentions } from '../../shared/communication-mentions.js'
import { mentionSpans } from '../../shared/mentions.js'
import { syncBotAvatars } from './avatars.js'
import { startedSources } from './work-events.js'
import { conversationSummary, safeManagementUrl } from './conversation-summary.js'
import { splitRef } from '../text.js'
import { communicationPrompt } from './prompt.js'
import { OUTSIDE_CONVERSATION_TOOLS } from './tool-scope.js'
import { COMMUNICATION_PRESET, hasCommunicationPreset, communicationInputs, sourceDelivery, legacySessionSettled, isCommunicationContext } from './session-scope.js'

const PROTOCOL = 'dsbot-communication/1'
const fail = code => { throw Object.assign(new Error(code), { code }) }
const operationId = source => `communication-${createHash('sha256').update(source).digest('hex')}`
const humanSendIntent = input => JSON.stringify([input.conversationId, input.text, input.clientCreatedAt, input.mentions ?? [], input.replyToMessageId ?? null, input.membershipEpoch ?? null])

export class CommunicationRuntime {
  constructor(rt, settings, credential, toolDefinitions) {
    communicationUrl(settings.url)
    if (!Array.isArray(settings.publishedBotIds ?? []) || (settings.publishedBotIds ?? []).some(id => !rt.botOf(id))) fail('BOT_NOT_FOUND')
    if (typeof (settings.humanDisplayName ?? 'You') !== 'string' || !(settings.humanDisplayName ?? 'You').trim()) fail('INVALID_CONFIG')
    if (settings.rotateTokens !== undefined && (!Number.isSafeInteger(settings.rotateTokens) || settings.rotateTokens <= 0)) fail('INVALID_CONFIG')
    if (!Number.isSafeInteger(settings.contextHistoryBytes ?? 131072) || (settings.contextHistoryBytes ?? 131072) < 1024
      || (settings.contextHistoryBytes ?? 131072) > 131072) fail('INVALID_CONFIG')
    this.rt = rt
    this.ctx = rt.ctx
    this.settings = settings
    this.queue = new CommunicationQueue(settings.dataPath ?? join(rt.home, 'communication.sqlite'), { instanceId: settings.instanceId, maxPending: settings.maxPending ?? 1000 })
    try { this.human = this.queue.localPrincipal('human', 'local-user', settings.humanDisplayName ?? 'You', settings.credentialKey ? 'local-user' : undefined) }
    catch (error) { this.queue.close(); throw error }
    this.bots = new Map()
    for (const id of settings.publishedBotIds ?? []) {
      const bot = rt.botOf(id)
      if (!bot) fail('BOT_NOT_FOUND')
      this.bots.set(id, this.queue.localPrincipal('bot', id, bot.name))
    }
    this.tools = toolDefinitions
    this.owners = new Map()
    this.scoped = new WeakSet()
    this.disposers = []
    this.contacts = []
    this.deliveryStates = new Map()
    this.statusOffset = 0
    this.conversations = new Map()
    this.errors = new Map()
    this.attempted = new Set()
    this.resumedTurns = new Set()
    this.everReconciled = false
    this.closed = false
    this.processing = Promise.resolve()
    for (const binding of this.queue.bindings()) for (const id of binding.sessionIds) this.owners.set(id, binding)
    this.transport = new CommunicationTransport(this.queue, { url: settings.url, credential,
      beforeReceive: delivery => this.ctx.parallel('ds-bot/communication-checkpoint', { point: 'before-receive',
        conversationId: delivery.conversationId, messageId: delivery.messageId, deliveryId: delivery.deliveryId }),
      afterReceive: delivery => this.ctx.parallel('ds-bot/communication-checkpoint', { point: 'after-receive',
        conversationId: delivery.conversationId, messageId: delivery.messageId, deliveryId: delivery.deliveryId }),
      onConnect: async welcome => {
        await this.registerLocalIdentities()
        if (welcome?.capabilities?.includes('principal-publication')) await this.transport.request('principal.publication', { principalIds: [...this.bots.values()].map(bot => bot.principalId) })
        this.lastConnectedAt = new Date().toISOString()
        this.transportError = null
      },
      onChange: async () => {
        this.everReconciled = true
        this.contacts = await this.transport.request('contacts.list')
        for (const principal of this.bots.values()) {
          const name = this.rt.botOf(principal.localRef)?.name
          if (!name || name === principal.displayName) continue
          const updated = await this.transport.request('principal.register', { localId: principal.localId, kind: 'bot', displayName: name })
          principal.displayName = updated.displayName
          this.contacts = this.contacts.map(contact => contact.principalId === principal.principalId ? { ...contact, ...updated } : contact)
        }
        try { await syncBotAvatars(this); this.avatarError = null }
        catch (error) { this.avatarError = error.code ?? 'AVATAR_SYNC_FAILED' }
        const authorized = new Set(this.queue.memberships().map(member => member.conversationId))
        for (const id of this.conversations.keys()) if (!authorized.has(id)) this.conversations.delete(id)
        for (const member of this.queue.memberships()) {
          if (this.conversations.get(member.conversationId)?.membershipVersion === member.membershipVersion
            && Date.now() - (this.profileRefreshedAt?.get(member.conversationId) ?? 0) < 5000) continue
          try {
            await this.refreshConversation(member.conversationId)
          } catch (error) { if (!['NOT_A_MEMBER', 'MEMBERSHIP_REVOKED','CONTACT_REQUIRED'].includes(error.code)) throw error }
        }
        // Directory renames do not change group membership versions.
        const directory = new Map(this.contacts.map(contact => [contact.principalId, contact]))
        for (const [id, info] of this.conversations) this.conversations.set(id, { ...info, members: info.members.map(member => {
          const contact = directory.get(member.principalId)
          return contact ? { ...member, displayName: contact.displayName, instanceLabel: contact.instanceLabel, avatar: contact.avatar } : member
        }) })
        const sent = this.queue.outboxFor(this.human.principalId).filter(item => item.type === 'message.publish' && item.state === 'accepted')
        for (let i = 0; i < Math.min(5, sent.length); i += 1) {
          const item = sent[(this.statusOffset + i) % sent.length]
          try { this.deliveryStates.set(item.id, await this.transport.request('message.status', { principalId: this.human.principalId, messageId: item.id })) }
          catch (error) { if (!['NOT_A_MEMBER', 'MEMBERSHIP_REVOKED', 'FORBIDDEN'].includes(error.code)) throw error; this.deliveryStates.delete(item.id) }
        }
        this.statusOffset += 5
        if (settings.autoAcceptBotInvites) await this.acceptBotInvites()
        this.processing = this.processing.catch(() => {}).then(() => this.process())
        await this.processing
        this.transportError = null
      },
      onError: error => { this.transportError = error.code },
    })
    this.installHooks()
    this.transport.start({ pollMs: settings.pollMs ?? 500 })
  }
  async registerLocalIdentities() {
    for (const principal of [this.human, ...this.bots.values()]) {
      const name = principal.kind === 'bot' ? this.rt.botOf(principal.localRef)?.name : this.settings.humanDisplayName ?? 'You'
      if (!name) continue
      principal.displayName = name
      const registered = await this.transport.request('principal.register', { localId: principal.localId, kind: principal.kind, displayName: name })
      principal.displayName = registered.displayName
    }
  }
  async acceptBotInvites() {
    const ids = new Set([...this.bots.values()].map(bot => bot.principalId))
    for (const invite of this.queue.invites().filter(item => ids.has(item.principalId))) {
      const id = operationId(`accept:${invite.inviteId}`)
      if (this.queue.outboxStatus(id)?.state === 'failed') continue
      try { await this.operation(invite.principalId, 'group.accept', { inviteId: invite.inviteId }, id) }
      catch (error) { if (this.queue.outboxStatus(id)?.state !== 'failed') throw error }
    }
  }
  actorForSession(sessionId) {
    const botId = this.owners.get(sessionId)?.localBotRef ?? this.rt.selfOf(sessionId)
    const actor = this.bots.get(botId)
    if (!actor || !this.rt.botOf(botId)) fail('BOT_NOT_PUBLISHED')
    return actor
  }
  async toolSource(exec) {
    return (await CommunicationRuntime.prototype.toolProvenance.call(this, exec)).sourceKey
  }
  async toolProvenance(exec) {
    if (!exec.callId || !exec.agent?.id) fail('UNSUPPORTED_CAPABILITY')
    await this.ctx.sessions.flush(exec.agent.session)
    const { events } = await this.ctx.sessionController.inspect(exec.agent.id, AbortSignal.timeout(15000))
    const event = events.findLast(event => event.type === 'assistant/message' && event.data.message.content.some(block =>
      block.type === 'tool-call' && block.id === (exec.rootCallId ?? exec.callId)))
    if (!event?.data.message.id) fail('TOOL_SOURCE_UNKNOWN')
    const sourceKey = JSON.stringify(['tool', exec.agent.id, event.seq, event.data.message.id, exec.callId])
    const binding = this.owners?.get(exec.agent.id)
    if (!binding) return { sourceKey }
    let turn
    const inputs = []
    for (const record of events) {
      if (record.seq > event.seq) break
      if (record.type === 'turn/start') turn = record.data.turn
      if (record.type === 'user/message' && (record.data.turn ?? turn) === event.data.turn
        && !isCommunicationContext(record.data.source)) inputs.push(record.data.source)
    }
    if (!inputs.length) fail('COMMUNICATION_INPUT_SOURCE_UNKNOWN')
    const deliveries = inputs.map(source => sourceDelivery(this.queue, binding, source))
    const input = deliveries.at(-1)
    return { sourceKey, causationDeliveryId: input.deliveryId, replyToMessageId: input.messageId }
  }
  member(principalId, conversationId, epoch) {
    if (!this.everReconciled) fail('AUTHORIZATION_PENDING')
    const member = this.queue.memberships().find(item => item.principalId === principalId && item.conversationId === conversationId)
    if (!member) fail('NOT_A_MEMBER')
    if (epoch !== undefined && member.membershipEpoch !== epoch) fail('MEMBERSHIP_REVOKED')
    return member
  }
  async authorize(binding) {
    if (!this.transport.connected) fail('COMMUNICATION_AUTHORIZATION_UNKNOWN')
    return this.transport.request('conversation.authorize', { conversationId: binding.conversationId,
      principalId: binding.recipientPrincipalId, membershipEpoch: binding.membershipEpoch })
  }
  installHooks() {
    this.workInputs ??= new Map()
    this.workSteps ??= new Map()
    this.workEvents ??= Promise.resolve()
    this.disposers.push(this.ctx.on('agent/created', ({ agent }) => { if (this.owners.has(agent.id)) this.scope(agent) }))
    const recordWork = (sessionId, owner, event, staged) => {
      this.workEvents = this.workEvents.catch(() => {}).then(async () => {
        try {
          const { events } = await this.ctx.sessionController.inspect(sessionId, AbortSignal.timeout(15000))
          const actual = startedSources(events, event).map(source => sourceDelivery(this.queue, owner, source))
          const allowed = new Set(staged.map(source => sourceDelivery(this.queue, owner, source).deliveryId))
          for (const delivery of actual) if (allowed.has(delivery.deliveryId)) this.queue.aiStarted(delivery.deliveryId)
        } catch { this.errors.set(owner.id, 'WORK_START_NOT_RECORDED') }
      })
    }
    this.disposers.push(this.ctx.on('session/event', (session, event) => {
      const owner = this.owners.get(session?.id)
      if (!owner) return
      if (event.type === 'turn/end') { this.workInputs.delete(session.id); this.workSteps.delete(session.id) }
      if (!['step/start', 'user/message'].includes(event.type) || !this.transport?.welcome?.capabilities?.includes('bot-work-events')) return
      if (event.type === 'step/start') this.workSteps.set(session.id, event)
      const staged = this.workInputs.get(session.id), step = this.workSteps.get(session.id)
      if (staged && step) recordWork(session.id, owner, step, staged)
    }))
    this.disposers.push(this.ctx.on('agent/pre-step', async ({ agent, messages }, next) => {
      const owner = this.owners.get(agent.id)
      if (!owner) return next()
      this.workInputs.delete(agent.id)
      await this.authorize(owner)
      if (!hasCommunicationPreset(this.ctx.get('agentPresets'), agent)) fail('COMMUNICATION_SESSION_MIGRATION_REQUIRED')
      try {
        communicationInputs(this.queue, owner, messages)
        const decision = await next()
        if (decision.kind !== 'enter') return decision
        const inputs = communicationInputs(this.queue, owner, decision.messages)
        if (this.transport?.welcome?.capabilities?.includes('bot-work-events')) {
          const staged = inputs.map(input => input.source)
          this.workInputs.set(agent.id, staged)
          const step = this.workSteps.get(agent.id)
          if (step) recordWork(agent.id, owner, step, staged)
        }
        return { ...decision, messages: inputs }
      }
      catch (error) {
        if (error.code !== 'COMMUNICATION_INPUT_SOURCE_UNKNOWN') throw error
        this.errors.set(owner.id, error.code ?? 'COMMUNICATION_INPUT_SOURCE_UNKNOWN')
        for (const delivery of this.queue.pendingAi().filter(item => item.conversationId === owner.conversationId && item.recipientPrincipalId === owner.recipientPrincipalId && item.membershipEpoch === owner.membershipEpoch)) {
          this.queue.aiState(delivery.deliveryId, 'injection_unknown', { reason: 'COMMUNICATION_INPUT_SOURCE_UNKNOWN' })
        }
        throw error
      }
    }))
    this.disposers.push(this.ctx.systemPrompt.section({ name: 'ds-bot-communication', order: 640, interpolate: false,
      text: context => {
        const binding = this.owners.get(context?.agent?.id)
        if (!binding) return ''
        const bot = this.rt.botOf(binding.localBotRef)
        const member = this.queue.memberships().find(item => item.conversationId === binding.conversationId && item.principalId === binding.recipientPrincipalId && item.membershipEpoch === binding.membershipEpoch)
        return communicationPrompt(bot, binding, member, { ...this.conversations.get(binding.conversationId), localUserPrincipalId: this.human.principalId })
      } }))
  }
  scope(agent) {
    if (this.scoped.has(agent)) return
    const tools = this.tools.filter(tool => !OUTSIDE_CONVERSATION_TOOLS.has(tool.name))
    const communicationNames = new Set(tools.map(tool => tool.name))
    for (const tool of tools) this.disposers.push(agent.ctx.tools.register(tool))
    this.disposers.push(agent.ctx.on('system-prompt/assemble', async (_assembly, _context, next) => {
      await this.isolateWorkspace(agent)
      const assembled = await next()
      return { ...assembled, tools: assembled.tools.filter(tool => communicationNames.has(tool.name)),
        sections: assembled.sections.filter(section => ['deployment:persona-prefix', 'ds-bot-communication'].includes(section.name)
          || section.name.startsWith('tool:') && communicationNames.has(section.name.slice(5))) }
    }))
    this.disposers.push(agent.ctx.on('tools/execute', async (exec, next) => {
      if (!communicationNames.has(exec.name)) fail('COMMUNICATION_TOOL_NOT_ALLOWED')
      return next()
    }))
    this.scoped.add(agent)
  }
  async isolateWorkspace(agent) {
    const binding = this.owners.get(agent.id)
    if (!binding) fail('COMMUNICATION_WORKSPACE_UNAVAILABLE')
    const cwd = join(this.rt.home, 'communication-workspaces', binding.id)
    await mkdir(cwd, { recursive: true })
    const folders = this.ctx.get?.('workingDirectory')
    if (typeof folders?.get !== 'function' || typeof folders?.set !== 'function') fail('COMMUNICATION_WORKSPACE_UNAVAILABLE')
    if (folders.get(agent.session) !== cwd) await folders.set(agent, cwd, AbortSignal.timeout(15000))
    return cwd
  }
  async operation(principalId, type, payload, id = randomUUID()) {
    payload = Object.fromEntries(Object.entries(payload).filter(([,value]) => value !== undefined))
    const saved = this.queue.intent(id)
    if (saved) {
      if (saved.type !== type) fail('MESSAGE_ID_CONFLICT')
      payload = { ...saved.payload, ...payload }
    } else if (payload.conversationId && type !== 'group.reclaim') {
      const member = this.member(principalId, payload.conversationId, payload.membershipEpoch)
      payload = { ...payload, membershipEpoch: member.membershipEpoch,
        ...(['group.invite','group.remove','group.routing','group.dissolve'].includes(type) && payload.expectedVersion === undefined ? { expectedVersion: member.membershipVersion } : {}) }
    }
    const input = { ...payload, principalId, operationId: id }
    this.queue.enqueueOperation(type, input)
    const old = this.queue.outboxStatus(id)
    if (old.state === 'accepted') return old.result
    if (!this.transport.connected) return { operationId: id, status: 'queued' }
    let result
    try { result = await this.transport.request(type, input) } catch (error) {
      if (!['CONNECTION_LOST', 'REQUEST_TIMEOUT', 'STORAGE_UNAVAILABLE', 'BACKPRESSURE', 'STALE_CONNECTION'].includes(error.code)) this.queue.rejected(id, error.code ?? 'INVALID_RESPONSE')
      throw error
    }
    this.queue.accepted(id, result)
    const affected = payload.conversationId ?? result.conversationId
    if (affected) this.conversations.delete(affected)
    try {
      this.queue.applyMemberships(await this.transport.request('memberships.list'))
      if (affected) await this.refreshConversation(affected)
    } catch (error) {
      // The operation is already committed; a projection refresh cannot undo its ACK.
      this.lastError = error.code ?? 'COMMUNICATION_UNAVAILABLE'
    }
    return result
  }
  async refreshConversation(conversationId) {
    const member = this.queue.memberships().find(item => item.conversationId === conversationId)
    if (!member) { this.conversations.delete(conversationId); return }
    const info = await this.transport.request('conversation.members', { conversationId, principalId: member.principalId, membershipEpoch: member.membershipEpoch })
    const current = this.queue.memberships().find(item => item.conversationId === conversationId && item.principalId === member.principalId && item.membershipEpoch === member.membershipEpoch)
    if (!current) return
    if ((this.conversations.get(conversationId)?.membershipVersion ?? 0) <= info.membershipVersion) {
      this.conversations.set(conversationId, info)
      this.profileRefreshedAt ??= new Map()
      this.profileRefreshedAt.set(conversationId, Date.now())
    }
  }
  message(principalId, conversationId, { text, mentions = [], replyToMessageId = null, responseToDeliveryId, causationDeliveryId, membershipEpoch, messageId = randomUUID(), clientCreatedAt = new Date().toISOString(), attachments, files } = {}) {
    if (attachments || files) fail('UNSUPPORTED_CONTENT')
    if (typeof text !== 'string') fail('INVALID_REQUEST')
    const info = this.conversations?.get(conversationId), members = info?.members
    const contacts = members ? members.map(member => ({ ...this.contacts.find(contact => contact.principalId === member.principalId), ...member })) : this.contacts
    // Without a current participant snapshot, an @all expansion cannot be scoped safely.
    const all = mentionSpans(text.replace(/^[\t ]*>[^\n]*/gm, line => ' '.repeat(line.length)), []).some(span => span.all)
    if (all && (!members || info.membershipVersion !== this.member(principalId, conversationId, membershipEpoch).membershipVersion)) fail('AUTHORIZATION_PENDING')
    return { protocol: PROTOCOL, type: 'message.publish', messageId, conversationId,
      author: { principalId, homeInstanceId: this.queue.instanceId, kind: principalId.startsWith('human:') ? 'human' : 'bot' },
      clientCreatedAt, content: { format: 'markdown', text },
      mentions: communicationMentions(text, contacts, mentions), replyToMessageId, ...(responseToDeliveryId ? { responseToDeliveryId } : {}),
      ...(causationDeliveryId ? { causationDeliveryId } : {}),
      membershipEpoch: membershipEpoch ?? this.member(principalId, conversationId).membershipEpoch }
  }
  sendHuman(input) {
    if (typeof input.messageId !== 'string' || typeof input.clientCreatedAt !== 'string') fail('INVALID_REQUEST')
    if (input.responseToDeliveryId !== undefined || input.causationDeliveryId !== undefined) fail('INVALID_REQUEST')
    if (input.attachments || input.files) fail('UNSUPPORTED_CONTENT')
    const saved = this.queue.intent(input.messageId)
    if (saved) {
      if (saved.type !== 'message.publish' || saved.payload.author?.principalId !== this.human.principalId) fail('MESSAGE_ID_CONFLICT')
      const original = this.queue.humanIntent?.(input.messageId)
      if (original !== undefined) {
        if (original !== humanSendIntent(input)) fail('MESSAGE_ID_CONFLICT')
        return { messageId: input.messageId, conversationId: input.conversationId, status: this.queue.outboxStatus(input.messageId).state }
      }
      if (input.conversationId !== saved.payload.conversationId || input.text !== saved.payload.content?.text
        || input.clientCreatedAt !== saved.payload.clientCreatedAt || (input.replyToMessageId ?? null) !== saved.payload.replyToMessageId
        || input.membershipEpoch !== undefined && input.membershipEpoch !== saved.payload.membershipEpoch) fail('MESSAGE_ID_CONFLICT')
      const literal = input.text.replace(/^[\t ]*>[^\n]*/gm, line => ' '.repeat(line.length))
      // Older journals cannot distinguish selected IDs from names expanded by the directory.
      if (saved.payload.mentions?.length || input.mentions?.length || mentionSpans(literal, [], { unknown: true }).length) fail('LEGACY_RECONCILIATION_REQUIRED')
      return {messageId:input.messageId,conversationId:input.conversationId,status:this.queue.outboxStatus(input.messageId).state}
    }
    const member = this.member(this.human.principalId, input.conversationId, input.membershipEpoch)
    if (member.kind === 'group' && member.speakingMode !== 'speak') fail('SPEAKING_FORBIDDEN')
    const message = this.message(this.human.principalId, input.conversationId, input)
    this.queue.enqueueMessage(message, humanSendIntent(input))
    return { messageId: message.messageId, conversationId: message.conversationId, status: this.queue.outboxStatus(message.messageId).state }
  }
  async sendBot(actor, input, exec) {
    if (!exec.callId || !exec.agent?.id) fail('UNSUPPORTED_CAPABILITY')
    const sourceKey = exec.communicationSource
    if (!sourceKey) fail('TOOL_SOURCE_UNKNOWN')
    let conversationId = input.conversationId ?? this.owners.get(exec.agent.id)?.conversationId
    if (input.contactPrincipalId) {
      const opened = await this.operation(actor.principalId, 'dm.open', { otherPrincipalId: input.contactPrincipalId }, operationId(`${sourceKey}:dm`))
      if (!opened.conversationId) fail('CONVERSATION_PENDING')
      conversationId = opened.conversationId
    }
    if (!conversationId) fail('CONVERSATION_REQUIRED')
    const member = this.member(actor.principalId, conversationId, exec.communicationBinding?.membershipEpoch ?? input.membershipEpoch)
    if (member.kind === 'group' && member.speakingMode !== 'active') fail('PASSIVE_REPLY_ONLY')
    const causal = exec.communicationCausation
    if (exec.communicationBinding && !causal?.causationDeliveryId) fail('COMMUNICATION_INPUT_SOURCE_UNKNOWN')
    const replyToMessageId = input.replyToMessageId ?? causal?.replyToMessageId ?? null
    const output = { sourceKey, conversationId, parts: [{ part: 0, text: input.text }], mentions: input.mentions ?? [], replyToMessageId }
    const [messageId] = this.queue.commitExports(`tool:${exec.agent.id}`, [output], [], () => this.message(actor.principalId, conversationId, { ...input, replyToMessageId,
      responseToDeliveryId: undefined, causationDeliveryId: causal?.causationDeliveryId, membershipEpoch: member.membershipEpoch }))
    return { messageId, conversationId, status: this.queue.outboxStatus(messageId).state }
  }
  history(principalId, input) {
    const member = this.member(principalId, input.conversationId, input.membershipEpoch)
    const events = this.queue.view(input.conversationId, principalId, member.membershipEpoch, { after: input.after ?? 0,
      before: input.before, limit: input.limit ?? 50, latest: input.latest ?? true })
    return { conversationId: input.conversationId, membershipEpoch: member.membershipEpoch, joinSeq: member.joinSeq,
      watermark: this.queue.cursor(input.conversationId, principalId, member.membershipEpoch), events }
  }
  async members(principalId, input) {
    const member = this.member(principalId, input.conversationId, input.membershipEpoch)
    return this.transport.request('conversation.members', { conversationId: input.conversationId, principalId, membershipEpoch: member.membershipEpoch })
  }
  markRead(input) {
    const member = this.member(this.human.principalId, input.conversationId)
    this.queue.markView(input.conversationId, this.human.principalId, member.membershipEpoch, input.seq, { humanRead: true })
    return { status: 'humanRead', conversationId: input.conversationId, seq: input.seq }
  }
  snapshot() {
    const memberships = this.everReconciled ? this.queue.memberships().filter(member => member.principalId === this.human.principalId) : []
    const managementUrl = safeManagementUrl(this.transport.welcome?.managementUrl)
    return { enabled: true, connected: this.transport.connected, reconciled: this.everReconciled, instanceId: this.queue.instanceId, humanPrincipalId: this.human.principalId,
      hubUrl: this.settings.url, hubId: this.settings.hubId ?? this.transport.welcome?.hubId ?? null,
      managementUrl, managementAvailable: managementUrl !== null,
      lastConnectedAt: this.lastConnectedAt ?? null, error: this.transportError ?? this.lastError ?? null, avatarError: this.avatarError ?? null, contacts: this.contacts,
      limits: this.queue.limits,
      localBots: [...this.bots.values()].map(bot => ({ principalId: bot.principalId, displayName: this.rt.botOf(bot.localRef)?.name ?? bot.displayName })),
      conversations: memberships.map(member => ({ ...member, info: this.conversations.get(member.conversationId) ?? null,
        lastMessage: conversationSummary(this.queue.lastMessage(member.conversationId, member.principalId, member.membershipEpoch),
          [...this.contacts, ...(this.conversations.get(member.conversationId)?.members ?? [])]),
        unread: this.queue.unread(member.conversationId, member.principalId, member.membershipEpoch) })),
      recoverableOwnership: this.queue.recoverableOwnership(this.human.principalId),
      invites: this.queue.invites(), outbox: this.queue.outboxFor(this.human.principalId).map(item => ({ ...item, deliveries: this.deliveryStates.get(item.id) ?? [] })),
      errors: [...this.errors].flatMap(([bindingId,code]) => {
        const binding = this.queue.bindings().find(item => item.id === bindingId)
        return binding && memberships.some(member => member.conversationId === binding.conversationId) ? [{ bindingId, conversationId: binding.conversationId, principalId: binding.recipientPrincipalId, code }] : []
      }),
      exportFailures: this.queue.exportFailures().filter(item => memberships.some(member => member.conversationId === item.conversationId)) }
  }
  async ensureSession(binding, bot, { fresh = false } = {}) {
    const ref = await this.rt.desiredModel(bot)
    if (!ref) fail('MODEL_UNAVAILABLE')
    if (binding.sessionIds.length && !fresh) {
      const resolved = await this.ctx.sessionController.resolveAgent(binding.sessionIds.at(-1))
      if ('error' in resolved) fail('SESSION_UNAVAILABLE')
      if (!hasCommunicationPreset(this.ctx.get('agentPresets'), resolved.agent)) {
        const { events } = await this.ctx.sessionController.inspect(resolved.agent.id, AbortSignal.timeout(15000))
        if (!legacySessionSettled(this.queue, binding, resolved.agent, events)) fail('COMMUNICATION_SESSION_MIGRATION_REQUIRED')
        fresh = true
      }
    }
    if (fresh || !binding.sessionIds.length) {
      const cwd = join(this.rt.home, 'communication-workspaces', binding.id)
      await mkdir(cwd, { recursive: true })
      const { sessionId } = await this.ctx.sessionController.create({ cwd, agentPreset: COMMUNICATION_PRESET })
      this.queue.addBindingSession(binding.id, sessionId)
      binding.sessionIds.push(sessionId)
    }
    for (const id of binding.sessionIds) this.owners.set(id, binding)
    const sessionId = binding.sessionIds.at(-1)
    const resolved = await this.ctx.sessionController.resolveAgent(sessionId)
    if ('error' in resolved) fail('SESSION_UNAVAILABLE')
    if (!hasCommunicationPreset(this.ctx.get('agentPresets'), resolved.agent)) fail('COMMUNICATION_PRESET_UNAVAILABLE')
    this.scope(resolved.agent)
    await this.isolateWorkspace(resolved.agent)
    const effort = await this.rt.desiredEffort(bot, ref)
    await this.ctx.sessionController.selectModel({ sessionId, ...splitRef(ref), ...(effort === undefined ? {} : { reasoningEffort: effort }) })
    return resolved.agent
  }
  async needsSegment(agent, bot) {
    if (agent.status !== 'idle' || agent.inbox.nextTurn.length || agent.inbox.nextStep.length) return false
    const meter = this.ctx.get('tokenMeter')?.measure(agent.session)
    if (!meter) return false
    const ref = await this.rt.desiredModel(bot)
    const { provider, model } = splitRef(ref)
    const info = await this.ctx.llm.resolveModelInfo(provider, model)
    const window = info.context?.contextWindow
    if (!Number.isFinite(window)) return false
    const threshold = Math.min(this.settings.rotateTokens ?? Infinity, Math.max(1, window - (info.defaultMaxTokens ?? 0)) * 0.45)
    return meter.totalTokens >= threshold
  }
  source(delivery) { return { kind: SOURCE_KIND, form: 'relay', summary: 'Communication message', deliveryId: delivery.deliveryId,
    messageId: delivery.messageId, conversationId: delivery.conversationId, recipientPrincipalId: delivery.recipientPrincipalId, membershipEpoch: delivery.membershipEpoch,
    authorPrincipalId: delivery.event.message.author.principalId, authorKind: delivery.event.message.author.kind } }
  inputText(delivery, binding, emptySession) {
    const member = this.member(delivery.recipientPrincipalId, delivery.conversationId)
    const events = this.queue.view(delivery.conversationId, delivery.recipientPrincipalId, delivery.membershipEpoch,
      { after: emptySession ? member.joinSeq - 1 : binding.contextSeq, before: delivery.event.conversationSeq - 1, latest: true, limit: 100 })
    const format = event => {
      if (event.type !== 'message') return JSON.stringify({ type: event.type, conversationSeq: event.conversationSeq })
      const person = this.contacts.find(contact => contact.principalId === event.message.author.principalId)
        ?? this.conversations?.get(delivery.conversationId)?.members.find(member => member.principalId === event.message.author.principalId)
      return JSON.stringify({ messageId: event.message.messageId, author: event.message.author,
        displayName: person?.displayName ?? event.message.author.principalId, instanceLabel: person?.instanceLabel,
        content: event.message.content, mentions: event.message.mentions, replyToMessageId: event.message.replyToMessageId,
        ...(event.causality ? { causality: event.causality } : {}),
        ...(event.dispatchSuppressed ? { dispatchSuppressed: event.dispatchSuppressed } : {}) })
    }
    const history = []
    let bytes = 0
    for (const event of [...events].reverse()) {
      const text = format(event), size = Buffer.byteLength(text)
      if (bytes + size > (this.settings.contextHistoryBytes ?? 131072)) break
      history.unshift(text); bytes += size
    }
    return ['[Communication delivery]', `Conversation: ${delivery.conversationId}`, `Recipient: ${delivery.recipientPrincipalId}`,
      `Message ID: ${delivery.messageId}`, 'Earlier authorized canonical context only (not new requests):',
      events.length > history.length ? 'Some earlier context is omitted here; read_communication_history can retrieve authorized events.' : '',
      ...history, 'Current author and message metadata:', format(delivery.event), 'Current message:', delivery.event.message.content.text].filter(Boolean).join('\n')
  }
  async consume(delivery) {
    if (delivery.mapping?.reason === 'COMMUNICATION_INPUT_SOURCE_UNKNOWN') fail('COMMUNICATION_INPUT_SOURCE_UNKNOWN')
    const principal = [...this.bots.values()].find(bot => bot.principalId === delivery.recipientPrincipalId)
    const bot = principal && this.rt.botOf(principal.localRef)
    if (!bot) fail('RECIPIENT_UNAVAILABLE')
    const binding = this.queue.binding(delivery.conversationId, delivery.recipientPrincipalId, delivery.membershipEpoch, bot.id)
    await this.ctx.parallel('ds-bot/communication-checkpoint', { point: 'before-injection', deliveryId: delivery.deliveryId, messageId: delivery.messageId,
      conversationId: delivery.conversationId, bindingId: binding.id })
    let agent = await this.ensureSession(binding, bot)
    await this.authorize(binding)
    const source = this.source(delivery)
    let sessions = await inspectBinding(this.ctx.sessionController, binding, AbortSignal.timeout(15000))
    let input = reconcileInput(sessions, source)
    if (input.status === 'admitted') {
      this.queue.aiState(delivery.deliveryId, 'accepted', { sessionId: input.sessionId, messageId: input.messageId, seq: input.seq })
      this.queue.contextApplied(binding.id, delivery.event.conversationSeq)
      return
    }
    if (input.status === 'canceled') { this.errors.set(binding.id, 'INPUT_CANCELED'); return }
    if (input.status === 'queued') {
      if (agent.status === 'idle' && !this.attempted.has(delivery.deliveryId)) {
        this.attempted.add(delivery.deliveryId)
        await resumePendingInput(this.ctx, binding, source, createUserMessage, AbortSignal.timeout(15000))
      }
      return
    }
    const recovered = await recoverBinding(this.ctx, binding, source, AbortSignal.timeout(15000))
    input = recovered.input
    if (input.status !== 'not_admitted') {
      if (delivery.state !== 'pending') this.queue.aiState(delivery.deliveryId, 'injection_unknown', { reason: input.reason ?? input.status })
      return
    }
    const previous = recovered.sessions.find(session => session.sessionId === agent.id)
    if (previous?.events.some(event => event.type === 'user/message') && await this.needsSegment(agent, bot)) {
      await this.export(binding)
      agent = await this.ensureSession(binding, bot, { fresh: true })
      recovered.sessions = await inspectBinding(this.ctx.sessionController, binding, AbortSignal.timeout(15000))
    }
    this.queue.aiState(delivery.deliveryId, 'injecting')
    this.attempted.add(delivery.deliveryId)
    sessions = recovered.sessions
    const current = sessions.find(session => session.sessionId === agent.id)
    const emptySession = !current?.events.some(event => event.type === 'user/message')
    agent.followup(createUserMessage({ source, content: [{ type: 'text', text: this.inputText(delivery, binding, emptySession) }] }))
    await this.ctx.sessions.flush(agent.session)
    await this.ctx.parallel('ds-bot/communication-checkpoint', { point: 'after-injection', deliveryId: delivery.deliveryId, messageId: delivery.messageId,
      conversationId: delivery.conversationId, bindingId: binding.id, sessionId: agent.id })
  }
  async recoverInterrupted(binding) {
    try { this.queue.member(binding.conversationId, binding.recipientPrincipalId, binding.membershipEpoch) } catch { return }
    const inspected = await inspectBinding(this.ctx.sessionController, binding, AbortSignal.timeout(15000)), sessions = []
    for (const session of inspected) {
      const resolved = await this.ctx.sessionController.resolveAgent(session.sessionId)
      if ('error' in resolved) fail('SESSION_UNAVAILABLE')
      if (hasCommunicationPreset(this.ctx.get('agentPresets'), resolved.agent)) sessions.push(session)
      else if (!legacySessionSettled(this.queue, binding, resolved.agent, session.events)) fail('COMMUNICATION_SESSION_MIGRATION_REQUIRED')
    }
    for (const { source, sessionId } of interruptedInputs(sessions, binding)) {
        const row = this.queue.db.prepare('SELECT body,revoked FROM inbox WHERE delivery_id=?').get(source.deliveryId)
        if (!row || row.revoked) continue
        const delivery = JSON.parse(row.body)
        if (delivery.messageId !== source.messageId || delivery.membershipEpoch !== binding.membershipEpoch) continue
        await this.authorize(binding)
        const resolved = await this.ctx.sessionController.resolveAgent(sessionId)
        if ('error' in resolved) fail('SESSION_UNAVAILABLE')
        if (!hasCommunicationPreset(this.ctx.get('agentPresets'), resolved.agent)) fail('COMMUNICATION_SESSION_MIGRATION_REQUIRED')
        this.scope(resolved.agent)
        await this.isolateWorkspace(resolved.agent)
        const result = await resumeInterruptedInput(this.ctx, { ...binding, sessionIds: sessions.map(session => session.sessionId) }, source, createUserMessage, this.resumedTurns, AbortSignal.timeout(15000))
        if (result.resumed) return
    }
  }
  async cancelRevoked() {
    for (const delivery of this.queue.revokedAi()) {
      const binding = this.queue.bindings().find(item => item.conversationId === delivery.conversationId
        && item.recipientPrincipalId === delivery.recipientPrincipalId && item.membershipEpoch === delivery.membershipEpoch)
      if (!binding?.sessionIds.length) { this.queue.revocationResult(delivery.deliveryId, { status: 'not_injected' }); continue }
      const source = this.source(delivery)
      const input = reconcileInput(await inspectBinding(this.ctx.sessionController, binding, AbortSignal.timeout(15000)), source)
      if (input.status === 'queued') {
        await this.ctx.sessionController.updateQueue({ sessionId: input.sessionId, itemId: input.messageId, action: { kind: 'remove' } })
        const resolved = await this.ctx.sessionController.resolveAgent(input.sessionId)
        if ('error' in resolved) fail('SESSION_UNAVAILABLE')
        await this.ctx.sessions.flush(resolved.agent.session)
        this.queue.revocationResult(delivery.deliveryId, { status: 'queued_input_canceled' })
      } else if (['admitted', 'canceled'].includes(input.status)) this.queue.revocationResult(delivery.deliveryId, { status: input.status })
      else if (input.status === 'absent') {
        const recovered = await recoverBinding(this.ctx, binding, source, AbortSignal.timeout(15000))
        if (recovered.input.status === 'not_admitted') this.queue.revocationResult(delivery.deliveryId, { status: 'not_admitted' })
      }
    }
  }
  async export(binding) {
    const principal = this.bots.get(binding.localBotRef)
    if (!principal) return
    try { this.queue.member(binding.conversationId, binding.recipientPrincipalId, binding.membershipEpoch) } catch { return }
    const safeIds = new Set()
    for (const id of binding.sessionIds) {
      const resolved = await this.ctx.sessionController.resolveAgent(id)
      if ('error' in resolved) fail('EXPORT_UNKNOWN')
      if (!hasCommunicationPreset(this.ctx.get('agentPresets'), resolved.agent)) {
        const { events } = await this.ctx.sessionController.inspect(id, AbortSignal.timeout(15000))
        if (!legacySessionSettled(this.queue, binding, resolved.agent, events)) fail('COMMUNICATION_SESSION_MIGRATION_REQUIRED')
        continue
      }
      safeIds.add(id)
      this.scope(resolved.agent)
      await this.ctx.sessions.flush(resolved.agent.session)
    }
    const sessions = (await inspectBinding(this.ctx.sessionController, binding, AbortSignal.timeout(15000))).filter(s => safeIds.has(s.sessionId))
    if (this.transport?.welcome?.capabilities?.includes('bot-work-events')) {
      for (const session of sessions) for (const step of session.events.filter(event => event.type === 'step/start')) {
        try {
          const deliveries = startedSources(session.events, step).map(source => sourceDelivery(this.queue, binding, source))
          for (const delivery of deliveries) this.queue.aiStarted(delivery.deliveryId)
        } catch { this.errors.set(binding.id, 'WORK_START_NOT_RECORDED') }
      }
    }
    for (const output of completedOutputs(sessions, binding, { recoverSettled: true })) {
      if (this.queue.db.prepare('SELECT 1 FROM exports WHERE source_key=?').get(output.sourceKey)) continue
      const input = sourceDelivery(this.queue, binding, output.inputSource)
      const text = output.parts.map(part => part.text).join('\n')
      await this.ctx.parallel('ds-bot/communication-checkpoint', { point: 'before-export', conversationId: binding.conversationId,
        bindingId: binding.id, sessionId: output.sessionId, sourceKey: output.sourceKey })
      this.queue.commitExports(binding.id, [output], [{ sessionId: output.sessionId, seq: output.seq }], () => this.message(principal.principalId, binding.conversationId,
        { text, replyToMessageId: input.messageId,
          responseToDeliveryId: input.deliveryId, membershipEpoch: binding.membershipEpoch }))
      await this.ctx.parallel('ds-bot/communication-checkpoint', { point: 'after-export', conversationId: binding.conversationId,
        bindingId: binding.id, sessionId: output.sessionId, sourceKey: output.sourceKey })
    }
  }
  async process() {
    if (this.closed) return
    if (this.rt.readOnly() !== undefined) fail('COMMUNICATION_READ_ONLY')
    await this.cancelRevoked()
    for (const binding of this.queue.bindings()) {
      try { await this.export(binding); await this.recoverInterrupted(binding) } catch (error) { this.errors.set(binding.id, error.code ?? 'RECOVERY_UNKNOWN') }
    }
    const seen = new Set()
    for (const delivery of this.queue.pendingAi()) {
      const key = JSON.stringify([delivery.conversationId, delivery.recipientPrincipalId, delivery.membershipEpoch])
      if (seen.has(key)) continue
      seen.add(key)
      try { await this.consume(delivery) } catch (error) {
        const binding = this.queue.bindings().find(item => item.conversationId === delivery.conversationId && item.recipientPrincipalId === delivery.recipientPrincipalId && item.membershipEpoch === delivery.membershipEpoch)
        if (binding) this.errors.set(binding.id, error.code ?? 'INJECTION_UNKNOWN')
        else this.lastError = error.code ?? 'INJECTION_UNKNOWN'
      }
    }
    for (const binding of this.queue.bindings()) {
      try {
        await this.export(binding)
        if (!['INPUT_CANCELED','COMMUNICATION_SESSION_MIGRATION_REQUIRED','COMMUNICATION_INPUT_SOURCE_UNKNOWN'].includes(this.errors.get(binding.id))) this.errors.delete(binding.id)
        const failed = this.queue.exportFailures().find(item => item.bindingId === binding.id)
        if (failed) this.errors.set(binding.id, failed.code ?? 'EXPORT_REJECTED')
      } catch (error) { this.errors.set(binding.id, error.code ?? 'EXPORT_UNKNOWN') }
    }
    if (this.lastError === 'BACKPRESSURE' && this.queue.pendingAi().length < this.queue.maxPending) this.lastError = null
  }
  async close() {
    this.closed = true
    this.transport.stop()
    await this.transport.opening?.catch(() => {})
    await this.transport.pumping?.catch(() => {})
    await this.processing.catch(() => {})
    await this.workEvents?.catch(() => {})
    for (const dispose of this.disposers.reverse()) if (typeof dispose === 'function') dispose()
    this.queue.close()
  }
}
