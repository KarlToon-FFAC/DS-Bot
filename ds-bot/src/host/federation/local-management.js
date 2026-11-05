import { createHash } from 'node:crypto'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { output } from '../tools.js'
import { communicationError } from '../../shared/communication-diagnostics.js'

const fail = code => { throw Object.assign(new Error(code), { code }) }
export const LOCAL_MANAGEMENT_TOOLS = new Set(['manage_communication_contacts', 'list_communication_bots', 'publish_communication_bots', 'communication_diagnose'])
const contextSources = new Set(['agent-instructions', 'working-directory', 'runtime-context', 'skill-catalog', 'time-context',
  'ds-bot-time-context', 'user-approval', 'model-selection', 'ptc-mode', 'compact-checkpoint'])

// Publication grants a remote identity, not permission to help the local owner.
// Derive delegation from the host journal, never a tool argument or quoted text.
export async function localManagementAuthority(rt, exec) {
  const sessionId = exec.agent?.id, botId = rt.chatOwners?.get(sessionId)
  if (!botId || !rt.botOf(botId) || rt.groupOwners?.has(sessionId) || rt.communication?.owners?.has(sessionId)) fail('LOCAL_USER_SESSION_REQUIRED')
  if (!exec.callId) fail('TOOL_SOURCE_UNKNOWN')
  await rt.ctx.sessions.flush(exec.agent.session)
  const { events } = await rt.ctx.sessionController.inspect(sessionId, AbortSignal.timeout(15000))
  const call = events.findLast(event => event.type === 'assistant/message' && event.data.message.content.some(block => block.type === 'tool-call'
    && block.id === (exec.rootCallId ?? exec.callId) && (exec.rootCallId && exec.rootCallId !== exec.callId || block.name === exec.name)))
  if (!call?.data.message.id) fail('TOOL_SOURCE_UNKNOWN')
  let turn, source
  for (const event of events) {
    if (event.seq > call.seq) break
    if (event.type === 'turn/start') { turn = event.data.turn; source = undefined }
    if (event.type === 'user/message' && !contextSources.has(event.data.source?.kind)) source = { seq: event.seq, turn: event.data.turn ?? turn, value: event.data.source }
  }
  if (!source || source.turn !== (call.data.turn ?? turn) || !['user', 'user-question-reply'].includes(source.value?.kind)) fail('LOCAL_USER_AUTHORIZATION_REQUIRED')
  return { botId, sourceKey: JSON.stringify(['local-management', sessionId, call.seq, call.data.message.id, exec.callId]),
    userIntentId: createHash('sha256').update(JSON.stringify(['local-user-input', sessionId, source.seq])).digest('hex') }
}

function managementGuard(rt, exec) {
  const pairing = () => JSON.stringify(['enabled', 'url', 'hubId', 'instanceId', 'credentialKey', 'credentialEnv'].map(key => rt.config.communication?.[key] ?? null))
  const expected = pairing(), comm = rt.communication, principalId = comm?.human?.principalId
  return () => {
    if (exec.signal?.aborted) fail('LOCAL_MANAGEMENT_CANCELLED')
    if (rt.readOnly?.() !== undefined) fail('COMMUNICATION_READ_ONLY')
    if (pairing() !== expected || rt.communication !== comm || comm?.closed || comm?.human?.principalId !== principalId) fail('COMMUNICATION_PAIRING_CONFLICT')
  }
}

async function approveManagement(rt, exec, details) {
  const approval = rt.ctx.get?.('approval')
  if (!approval?.request || !exec.agent?.session) fail('LOCAL_MANAGEMENT_APPROVAL_UNAVAILABLE')
  const reason = `Allow this Remote management change for the local owner? ${JSON.stringify(details)}`
  const outcome = await approval.request({ agent: exec.agent, toolName: exec.name, callId: exec.callId, reason,
    ...(exec.signal ? { signal: exec.signal } : {}) })
  if (outcome !== 'allowed-once') fail(outcome === 'rejected' ? 'LOCAL_MANAGEMENT_REJECTED'
    : outcome === 'cancelled' ? 'LOCAL_MANAGEMENT_CANCELLED' : 'LOCAL_MANAGEMENT_APPROVAL_UNAVAILABLE')
  if (exec.signal?.aborted) fail('LOCAL_MANAGEMENT_CANCELLED')
  if (rt.readOnly?.() !== undefined) fail('COMMUNICATION_READ_ONLY')
}

export function localManagementTools(rt, { ensure, enrollment }) {
  const execute = work => async (args, exec) => {
    try {
      await rt.load(); await rt.refresh()
      if (rt.readOnly?.() !== undefined) fail('COMMUNICATION_READ_ONLY')
      const authority = await localManagementAuthority(rt, exec)
      if (!args || typeof args !== 'object' || Array.isArray(args)) fail('INVALID_REQUEST')
      if (['principalId', 'sender', 'author', 'privateKey', 'publicKey', 'credentialKey', 'allowLoopback'].some(key => Object.hasOwn(args, key))) fail('AUTHOR_MISMATCH')
      return JSON.stringify(await work(structuredClone(args), authority, exec))
    } catch (error) { return JSON.stringify({ ok: false, error: communicationError(error),
      ...(typeof error.operationId === 'string' ? { operationId: error.operationId } : {}) }) }
  }
  return [
    defineTool({ name: 'manage_communication_contacts',
      description: 'In your own local chat, help the authenticated local user manage their Remote contacts, even if you are unpublished. Only perform the action and Bot scope the user requested; mutations require a native approval for that exact change. Contact consent acts for the local owner, never as your Bot or a remote participant. Use exact IDs and latest versions. Preserve operationId when retrying an uncertain change. This does not send messages or change Hub access.',
      parameters: { action: { type: 'string', required: true, enum: ['list', 'requests', 'relations', 'user-code', 'rotate-user-code', 'request', 'accept', 'reject', 'cancel', 'revoke'] },
        operationId: { type: 'string', description: 'Stable unique ID for one contact change; retain it after uncertainty' },
        userCode: { type: 'string' }, requestId: { type: 'string' }, expectedVersion: { type: 'integer' },
        otherHumanPrincipalId: { type: 'string' }, localBotIds: { type: 'array', items: { type: 'string' }, description: 'Exact published local Bot IDs the user explicitly chose to share; defaults to none' } }, output,
      execute: execute(async ({ action, ...input }, authority, exec) => {
        const actions = { requests: 'contact-requests', relations: 'contact-relations', 'user-code': 'user-code', 'rotate-user-code': 'rotate-user-code',
          request: 'contact-request', accept: 'contact-accept', reject: 'contact-reject', cancel: 'contact-cancel', revoke: 'contact-revoke' }
        if (action !== 'list' && !Object.hasOwn(actions, action)) fail('UNKNOWN_OPERATION')
        if (Object.keys(input).some(key => !['operationId', 'userCode', 'requestId', 'expectedVersion', 'otherHumanPrincipalId', 'localBotIds'].includes(key))) fail('INVALID_REQUEST')
        const comm = await ensure()
        if (rt.communication !== comm) fail('COMMUNICATION_PAIRING_CONFLICT')
        const guard = managementGuard(rt, exec)
        if (action === 'list') return { scope: 'local-user', contacts: await comm.transport.request('contacts.list', { principalId: comm.human.principalId }) }
        if (['request', 'accept', 'reject', 'cancel', 'revoke', 'rotate-user-code'].includes(action)) {
          input.operationId ??= `contact-${createHash('sha256').update(authority.sourceKey).digest('hex')}`
          await approveManagement(rt, exec, { action, hub: comm.settings.url, ...input })
          guard()
        }
        try { return await (await enrollment()).handle(actions[action], input, { human: true, beforeDispatch: guard }) }
        catch (error) { if (input.operationId) error.operationId = input.operationId; throw error }
      }) }),
    defineTool({ name: 'list_communication_bots', description: 'In your own local chat, list local Bot IDs and their Remote publication settings for the authenticated local user. Publication is not required to use this management tool. Creating or editing Bots still uses create_bot/update_bot with their existing Main Bot and self-management permissions.',
      parameters: {}, output, execute: execute(async () => (await enrollment()).handle('available-bots', {}, { human: true })) }),
    defineTool({ name: 'publish_communication_bots', description: 'In your own local chat, set the exact local Bot publication list the authenticated local user requested, after native approval for that exact list. This replaces the list; [] withdraws every Bot. Read list_communication_bots first and retain every Bot the user did not ask to withdraw. Publication exposes identity, not private chats or memory. The host reloads before Remote publication takes effect. This does not accept contacts or grant group/Hub authority.',
      parameters: { localBotIds: { type: 'array', required: true, items: { type: 'string' } } }, output,
      execute: execute(async (args, _authority, exec) => {
        const manager = await enrollment(), ids = manager.checkedBotIds(args.localBotIds)
        const configured = rt.config.communication, expectedPublishedBotIds = [...(configured?.publishedBotIds ?? [])], guard = managementGuard(rt, exec)
        await approveManagement(rt, exec, { action: 'publish-bots', hub: configured?.url,
          publishedBots: ids.map(id => ({ id, name: rt.botOf(id).name })), replaces: expectedPublishedBotIds })
        guard()
        return manager.handle('publish-bots', { localBotIds: ids, expectedPublishedBotIds }, { human: true, beforeDispatch: guard })
      }) }),
  ]
}
