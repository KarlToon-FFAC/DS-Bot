import { defineTool } from '@deepseek-ai/dsh-tools'
import { createHash } from 'node:crypto'
import { output } from './tools.js'
import { assertConversationToolScope } from './federation/tool-scope.js'
import { communicationPreset, hasCommunicationPreset } from './federation/session-scope.js'

const fail = code => { throw Object.assign(new Error(code), { code }) }
const toolOperation = (kind, exec) => {
  if (!exec.communicationSource) fail('TOOL_SOURCE_UNKNOWN')
  return `${kind}-${createHash('sha256').update(exec.communicationSource).digest('hex')}`
}

export function install(rt) {
  const settings = rt.config.communication
  if (!settings?.enabled) return
  const { ctx } = rt
  const key = settings.credentialEnv ?? 'DSBOT_COMMUNICATION_CREDENTIAL'
  const credential = /^DSBOT_COMMUNICATION_[A-Z0-9_]+$/.test(key) ? process.env[key] : undefined
  // This reference belongs only to the communication host, not to model tools.
  if (credential) delete process.env[key]
  let runtime, starting, stopped = false, startupError, disposePreset
  const ensure = () => {
    starting ??= (async () => {
      await rt.load()
      await rt.refresh()
      if (stopped) fail('COMMUNICATION_STOPPED')
      if (!credential || credential.length < 32) fail('CREDENTIAL_UNAVAILABLE')
      if (rt.readOnly() !== undefined) fail('COMMUNICATION_READ_ONLY')
      const presets = ctx.get('agentPresets')
      if (!presets || typeof presets.register !== 'function') fail('COMMUNICATION_PRESET_UNAVAILABLE')
      if ((await presets.list()).some(preset => preset.id === communicationPreset.id)) fail('COMMUNICATION_PRESET_CONFLICT')
      disposePreset = await presets.register(communicationPreset)
      const { CommunicationRuntime } = await import('./federation/runtime.js')
      runtime = new CommunicationRuntime(rt, settings, credential, definitions)
      rt.communication = runtime
      return runtime
    })().catch(error => {
      startupError = error.code ?? 'COMMUNICATION_UNAVAILABLE'
      if (startupError === 'COMMUNICATION_READ_ONLY') starting = null
      throw error
    })
    return starting
  }
  const execute = work => async (args, exec) => {
    try {
      const comm = await ensure(), actor = comm.actorForSession(exec.agent?.id), communicationBinding = comm.owners.get(exec.agent?.id)
      assertConversationToolScope(communicationBinding, exec.name, args)
      if (communicationBinding) {
        if (!hasCommunicationPreset(ctx.get('agentPresets'), exec.agent)) fail('COMMUNICATION_SESSION_MIGRATION_REQUIRED')
        await comm.authorize(communicationBinding)
        comm.member(actor.principalId, communicationBinding.conversationId, communicationBinding.membershipEpoch)
        args = { ...args, membershipEpoch: communicationBinding.membershipEpoch }
      }
      const read = ['list_contacts', 'list_communication_conversations', 'read_communication_history', 'read_communication_members', 'read_communication_reference'].includes(exec.name)
      const communicationSource = read ? null : await comm.toolSource(exec)
      return JSON.stringify(await work(comm, actor, args, { ...exec, communicationSource, communicationBinding }))
    }
    catch (error) { return JSON.stringify({ ok: false, error: { code: error.code ?? 'COMMUNICATION_UNAVAILABLE' } }) }
  }
  const definitions = [
    defineTool({ name: 'list_contacts', description: 'List explicitly published Human and Bot contacts with exact global IDs and instance origins. Equal names are different contacts.', parameters: {}, output,
      execute: execute(comm => ({ contacts: comm.contacts })) }),
    defineTool({ name: 'list_communication_conversations', description: 'List only communication conversations and invitations authorized for your own Bot identity; original private chats are separate.', parameters: {}, output,
      execute: execute((comm, actor, _args, exec) => ({ conversations: comm.queue.memberships().filter(item => item.principalId === actor.principalId && (!exec.communicationBinding || item.conversationId === exec.communicationBinding.conversationId && item.membershipEpoch === exec.communicationBinding.membershipEpoch)),
        invites: exec.communicationBinding ? [] : comm.queue.invites().filter(item => item.principalId === actor.principalId), recoverableOwnership: exec.communicationBinding ? [] : comm.queue.recoverableOwnership(actor.principalId) })) }),
    defineTool({ name: 'send_contact_message', description: 'Send text to an exact published contact or communication conversation. Your actual executing Bot is the author. A contact opens its canonical DM. No attachments; never provide a sender identity.',
      parameters: { text: { type: 'string', required: true }, contactPrincipalId: { type: 'string' }, conversationId: { type: 'string' },
        mentions: { type: 'array', items: { type: 'string' }, description: 'Exact active recipient IDs, not display names' }, replyToMessageId: { type: 'string' } }, output,
      execute: execute((comm, actor, args, exec) => comm.sendBot(actor, args, exec)) }),
    defineTool({ name: 'read_communication_history', description: 'Read authorized canonical history from one communication conversation, without causing a new send or model delivery. Other chats and membership epochs are inaccessible.',
      parameters: { conversationId: { type: 'string', required: true }, after: { type: 'integer' }, before: { type: 'integer' }, limit: { type: 'integer' } }, output,
      execute: execute((comm, actor, args) => comm.history(actor.principalId, args)) }),
    defineTool({ name: 'create_communication_group', description: 'Create an explicit communication group as yourself. Other people/Bots join only through invitations and acceptance.',
      parameters: { title: { type: 'string', required: true } }, output,
      execute: execute((comm, actor, args, exec) => comm.operation(actor.principalId, 'group.create', { title: args.title }, toolOperation('group', exec))) }),
    defineTool({ name: 'read_communication_members', description: 'Read the current participants, exact IDs, group title, roles, speaking modes, receiving rule and membershipVersion of one authorized communication conversation.',
      parameters: { conversationId: { type: 'string', required: true } }, output,
      execute: execute((comm, actor, args) => comm.members(actor.principalId, args)) }),
    defineTool({ name: 'read_communication_reference', description: 'Read an authorized canonical message reference from the current membership epoch of one communication conversation.',
      parameters: { conversationId: { type: 'string', required: true }, messageId: { type: 'string', required: true } }, output,
      execute: execute((comm, actor, args) => {
        const member = comm.member(actor.principalId, args.conversationId, args.membershipEpoch)
        return comm.queue.reference(args.conversationId, actor.principalId, member.membershipEpoch, args.messageId)
      }) }),
    defineTool({ name: 'configure_communication_group', description: 'As group owner or admin, change the group title using the latest membershipVersion as expectedVersion.',
      parameters: { conversationId: { type: 'string', required: true }, title: { type: 'string', required: true }, expectedVersion: { type: 'integer', required: true } }, output,
      execute: execute((comm, actor, args, exec) => comm.operation(actor.principalId, 'group.configure', args, toolOperation('configure', exec))) }),
    defineTool({ name: 'invite_communication_member', description: 'Invite an exact published participant to a communication group you manage.',
      parameters: { conversationId: { type: 'string', required: true }, inviteePrincipalId: { type: 'string', required: true } }, output,
      execute: execute((comm, actor, args, exec) => comm.operation(actor.principalId, 'group.invite', args, toolOperation('invite', exec))) }),
    defineTool({ name: 'accept_communication_invite', description: 'Accept an invitation for your own Bot identity; it grants no access for the Human who owns you.',
      parameters: { inviteId: { type: 'string', required: true } }, output,
      execute: execute((comm, actor, args, exec) => comm.operation(actor.principalId, 'group.accept', args, toolOperation('accept', exec))) }),
    defineTool({ name: 'leave_communication_group', description: 'Leave a communication group as yourself, revoking pending deliveries under the old membership.',
      parameters: { conversationId: { type: 'string', required: true } }, output,
      execute: execute((comm, actor, args, exec) => comm.operation(actor.principalId, 'group.remove', { conversationId: args.conversationId, targetPrincipalId: actor.principalId, membershipEpoch: args.membershipEpoch }, toolOperation('leave', exec))) }),
    defineTool({ name: 'remove_communication_member', description: 'Remove a participant from a communication group you manage. A remote Main Bot label grants no management rights.',
      parameters: { conversationId: { type: 'string', required: true }, targetPrincipalId: { type: 'string', required: true } }, output,
      execute: execute((comm, actor, args, exec) => comm.operation(actor.principalId, 'group.remove', args, toolOperation('remove', exec))) }),
    defineTool({ name: 'set_communication_receiving_rule', description: 'Set the receiving rule of a communication group you manage. Human mentions notify people; Bot mentions dispatch exact recipients. Ordinary Bot replies do not broadcast.',
      parameters: { conversationId: { type: 'string', required: true }, mode: { type: 'string', enum: ['admin', 'mentionsOnly'], required: true }, adminBotPrincipalId: { type: 'string' } }, output,
      execute: execute((comm, actor, args, exec) => comm.operation(actor.principalId, 'group.routing', args, toolOperation('routing', exec))) }),
    defineTool({ name: 'end_communication_group', description: 'As the current group owner, end the group for every participant, revoking unfinished delivery. Admins cannot end a group. This differs from leaving it yourself.',
      parameters: { conversationId: { type: 'string', required: true } }, output,
      execute: execute((comm, actor, args, exec) => comm.operation(actor.principalId, 'group.dissolve', args, toolOperation('dissolve', exec))) }),
    defineTool({ name: 'set_communication_member_policy', description: 'Change a group member speaking mode. Only the owner appoints admins; admins manage ordinary members only. Use the latest membershipVersion as expectedVersion.',
      parameters: { conversationId: { type: 'string', required: true }, targetPrincipalId: { type: 'string', required: true }, expectedVersion: { type: 'integer', required: true },
        role: { type: 'string', enum: ['member','admin'] }, speakingMode: { type: 'string', enum: ['readOnly','speak','passive','active'] } }, output,
      execute: execute((comm, actor, args, exec) => comm.operation(actor.principalId, 'group.policy', args, toolOperation('policy', exec))) }),
    defineTool({ name: 'transfer_communication_ownership', description: 'As current owner, atomically transfer ownership to an active group participant; you become an admin. Names and Main Bot labels grant no ownership.',
      parameters: { conversationId: { type: 'string', required: true }, targetPrincipalId: { type: 'string', required: true }, expectedVersion: { type: 'integer', required: true } }, output,
      execute: execute((comm, actor, args, exec) => comm.operation(actor.principalId, 'group.transfer', args, toolOperation('transfer', exec))) }),
    defineTool({ name: 'reclaim_communication_ownership', description: 'After explicit instance re-pairing, restore only your own retained ownership as a fresh membership. It never takes over another owner or restores a dissolved group.',
      parameters: { conversationId: { type: 'string', required: true }, expectedVersion: { type: 'integer', required: true } }, output,
      execute: execute((comm, actor, args, exec) => comm.operation(actor.principalId, 'group.reclaim', args, toolOperation('reclaim', exec))) }),
  ]
  rt.teamTools.push(...definitions)
  ctx.effect(() => {
    let timer
    const start = async () => {
      try { await ensure(); startupError = null } catch (error) {
        rt.warn('ds-bot: communication startup failed (%s)', error.code ?? 'COMMUNICATION_UNAVAILABLE')
        if (!stopped && error.code === 'COMMUNICATION_READ_ONLY') timer = setTimeout(() => { void start() }, 5000)
      }
    }
    void start()
    return async () => { stopped = true; clearTimeout(timer); await starting?.catch(() => {}); await runtime?.close(); await disposePreset?.() }
  }, 'ds-bot: communication')
  ctx.effect(() => ctx.connection.fetch.register({ path: '/api/communication', methods: ['POST'], requestBody: 'buffered',
    fetch: async request => {
      try {
        const body = await request.json()
        if (!body || typeof body !== 'object' || Array.isArray(body)) fail('INVALID_REQUEST')
        if (['author', 'sender', 'senderId', 'principalId', 'homeInstanceId'].some(key => Object.hasOwn(body, key))) fail('AUTHOR_MISMATCH')
        if (body.endpoint === 'state' && startupError && startupError !== 'COMMUNICATION_READ_ONLY') return Response.json({ ok: true, value: { enabled: true, connected: false, error: startupError, conversations: [], contacts: [], invites: [], outbox: [] } })
        const comm = await ensure()
        let value
        switch (body.endpoint) {
          case 'state': value = comm.snapshot(); break
          case 'history': value = comm.history(comm.human.principalId, body); break
          case 'members': value = await comm.members(comm.human.principalId, body); break
          case 'reference': {
            const member = comm.member(comm.human.principalId, body.conversationId)
            value = comm.queue.reference(body.conversationId, comm.human.principalId, member.membershipEpoch, body.messageId)
            break
          }
          case 'read': value = comm.markRead(body); break
          case 'send': value = comm.sendHuman(body); break
          case 'rename-human': {
            value = await comm.transport.request('principal.rename',{principalId:comm.human.principalId,displayName:body.displayName})
            comm.human.displayName = value.displayName
            comm.contacts = comm.contacts.map(contact => contact.principalId === value.principalId ? { ...contact, displayName: value.displayName } : contact)
            break
          }
          case 'configure-group': value = await comm.operation(comm.human.principalId,'group.configure',{conversationId:body.conversationId,membershipEpoch:body.membershipEpoch,expectedVersion:body.expectedVersion,title:body.title},body.operationId); break
          case 'dm': value = await comm.operation(comm.human.principalId, 'dm.open', { otherPrincipalId: body.otherPrincipalId }, body.operationId); break
          case 'create-group': value = await comm.operation(comm.human.principalId, 'group.create', { title: body.title }, body.operationId); break
          case 'invite': value = await comm.operation(comm.human.principalId, 'group.invite', { membershipEpoch: body.membershipEpoch, expectedVersion: body.expectedVersion, conversationId: body.conversationId, inviteePrincipalId: body.inviteePrincipalId }, body.operationId); break
          case 'accept': {
            const target = body.recipientPrincipalId ?? comm.human.principalId
            if (target !== comm.human.principalId && ![...comm.bots.values()].some(bot => bot.principalId === target)) fail('AUTHOR_MISMATCH')
            value = await comm.operation(target, 'group.accept', { inviteId: body.inviteId }, body.operationId)
            break
          }
          case 'remove': value = await comm.operation(comm.human.principalId, 'group.remove', { membershipEpoch: body.membershipEpoch, expectedVersion: body.expectedVersion, conversationId: body.conversationId, targetPrincipalId: body.targetPrincipalId ?? comm.human.principalId }, body.operationId); break
          case 'routing': value = await comm.operation(comm.human.principalId, 'group.routing', { membershipEpoch: body.membershipEpoch, expectedVersion: body.expectedVersion, conversationId: body.conversationId, mode: body.mode, adminBotPrincipalId: body.adminBotPrincipalId }, body.operationId); break
          case 'dissolve': value = await comm.operation(comm.human.principalId, 'group.dissolve', { conversationId: body.conversationId }, body.operationId); break
          case 'policy': value = await comm.operation(comm.human.principalId, 'group.policy', { membershipEpoch: body.membershipEpoch, expectedVersion: body.expectedVersion, conversationId: body.conversationId, targetPrincipalId: body.targetPrincipalId,
            ...(body.role === undefined ? {} : { role: body.role }), ...(body.speakingMode === undefined ? {} : { speakingMode: body.speakingMode }) }, body.operationId); break
          case 'transfer': value = await comm.operation(comm.human.principalId, 'group.transfer', { membershipEpoch: body.membershipEpoch, expectedVersion: body.expectedVersion, conversationId: body.conversationId, targetPrincipalId: body.targetPrincipalId }, body.operationId); break
          case 'reclaim': value = await comm.operation(comm.human.principalId, 'group.reclaim', { conversationId: body.conversationId, expectedVersion: body.expectedVersion }, body.operationId); break
          default: fail('UNKNOWN_OPERATION')
        }
        return Response.json({ ok: true, value })
      } catch (error) { return Response.json({ ok: false, error: { code: error.code ?? 'COMMUNICATION_UNAVAILABLE', message: error.code ?? 'Communication is unavailable' } }) }
    } }), 'ds-bot: communication channel')
}
