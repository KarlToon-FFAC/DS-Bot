import { defineTool } from '@deepseek-ai/dsh-tools'
import { parseCredentialKey } from '@deepseek-ai/dsh-credentials'
import { output } from '../tools.js'
import { communicationError } from '../../shared/communication-diagnostics.js'

const configKeys = ['enabled', 'hubId', 'url', 'instanceId', 'credentialKey', 'credentialEnv', 'publishedBotIds', 'localMemory', 'pollMs', 'contextHistoryBytes', 'rotateTokens', 'maxPending', 'autoAcceptBotInvites']
export const loadedCommunicationSettings = settings => Object.fromEntries(configKeys.map(key => [key,
  Array.isArray(settings[key]) ? [...settings[key]] : settings[key]]))
const safeId = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value) ? value : null
const safeUrl = value => {
  try {
    const url = new URL(value)
    if (!['ws:', 'wss:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) return null
    return `${url.protocol}//${url.host}/communication`
  } catch { return null }
}
const currentBot = (rt, sessionId) => {
  const botId = rt.chatOwners?.get(sessionId)
  if (!botId || !rt.botOf(botId) || rt.groupOwners?.has(sessionId) || rt.communication?.owners?.has(sessionId)) return undefined
  return rt.botOf(botId)
}
export const communicationReloadRequired = (rt, applied) => configKeys.some(key => JSON.stringify(rt.config.communication?.[key]) !== JSON.stringify(applied[key]))
const currentError = (state, comm) => state.startupError ?? comm?.transportError ?? comm?.lastError ?? null
const conversationCount = queue => typeof queue?.memberships === 'function' ? new Set(queue.memberships().map(member => member.conversationId)).size : null
const count = (value, fn) => typeof value?.[fn] === 'function' ? value[fn]().length : null

// A local metadata snapshot, never a connection attempt, environment dump or credential read.
export async function diagnoseCommunication(rt, state, { sessionId, agent } = {}) {
  const comm = state.runtime, applied = state.settings, configured = rt.config.communication ?? {}
  const connected = comm?.transport?.connected === true, reconciled = comm?.everReconciled === true
  const errorCode = currentError(state, comm), error = errorCode ? communicationError({ code: errorCode }) : null
  const changedKeys = configKeys.filter(key => JSON.stringify(configured[key]) !== JSON.stringify(applied[key]))
  const bot = currentBot(rt, sessionId)
  const publishedIds = [...(comm?.bots?.keys() ?? applied.publishedBotIds ?? [])].filter(id => rt.botOf?.(id))
  const credentialEnv = applied.credentialEnv ?? 'DSBOT_COMMUNICATION_CREDENTIAL'
  const envName = /^DSBOT_COMMUNICATION_[A-Z0-9_]+$/.test(credentialEnv) ? credentialEnv : null
  let credential = { mode: applied.credentialKey ? 'signing-record' : 'legacy-environment', configured: Boolean(applied.credentialKey || applied.credentialEnv || state.credentialObserved || state.legacy?.status().available),
    availableToHost: applied.credentialKey ? null : state.legacy?.status().available === true }
  if (applied.credentialKey) {
    try {
      const service = rt.ctx.get?.('credentials') ?? rt.ctx.credentials
      if (typeof service?.describeRecord === 'function') {
        const info = await service.describeRecord(parseCredentialKey(applied.credentialKey))
        credential = { ...credential, recordPresent: info.configured === true, writable: typeof info.writable === 'boolean' ? info.writable : null,
          availableToHost: connected ? true : null }
      }
    } catch (cause) { credential.error = communicationError(cause) }
  }
  const listsKnown = Boolean(comm?.transport?.lastSynchronizedAt)
  const listStatus = knownCount => ({ count: listsKnown ? knownCount : null,
    state: !applied.enabled ? 'disabled' : !comm ? 'not-started' : !listsKnown ? 'not-synchronized' : connected ? 'authorized-snapshot' : 'cached-snapshot',
    why: !listsKnown ? 'No completed initial synchronization is known. An empty local list does not prove absence on the Hub.'
      : connected ? 'Counts describe the last locally synchronized authorized view, not every Hub identity.' : 'The last synchronized view may be stale while disconnected.' })
  const definitions = state.toolNames ?? []
  let registeredNames = null
  if (agent && typeof rt.ctx.tools?.schemas === 'function') {
    try {
      const expected = new Set([...definitions, 'communication_diagnose'])
      registeredNames = rt.ctx.tools.schemas(agent).map(tool => tool.name).filter(name => expected.has(name))
    } catch {}
  }
  return {
    enabled: applied.enabled === true, connected, runtimeStarted: Boolean(comm),
    hub: { hubId: safeId(applied.hubId ?? comm?.transport?.welcome?.hubId), url: safeUrl(applied.url), instanceId: safeId(comm?.queue?.instanceId ?? applied.instanceId) },
    configuration: { source: 'loaded-plugin-configuration', reloadRequired: changedKeys.length > 0, changedKeys,
      savedConfiguration: 'not-inspected', lastReloadAt: null, why: changedKeys.length ? 'Current in-memory settings differ from the loaded communication runtime. Wait for the supported host reload and recheck.' : 'No difference is known in this plugin instance. This does not prove that a disk edit, launcher environment or a different process has reloaded.' },
    publication: { localBotIds: publishedIds, executingBot: bot ? { localBotId: bot.id, displayName: bot.name, published: publishedIds.includes(bot.id) } : null,
      hubAcknowledgedAt: comm?.publicationSyncedAt ?? null,
      state: comm?.publicationSyncedAt ? connected ? 'acknowledged-on-connection' : 'last-acknowledgement-cached' : 'not-confirmed',
      why: 'Loaded publication enables a Bot identity; it does not grant contact consent, group membership or execution privileges. A previous Hub acknowledgement is not proof of current remote visibility.' },
    tools: { diagnose: 'local-own-chat-only', communication: applied.enabled ? 'enabled-with-identity-and-membership-checks' : 'not-registered',
      expectedNames: applied.enabled ? definitions : [], registeredNames,
      missingExpectedNames: registeredNames ? (applied.enabled ? definitions : []).filter(name => !registeredNames.includes(name)) : null,
      actualServedNames: null, scopeRefresh: rt.teamToolScopeStatus?.(sessionId) ?? null,
      why: 'Tools are scoped to each Session and may be filtered by its preset or host. The registry is not proof of model-facing presentation: PTC mode accepts only run_code as a native call and can reject direct calls to registered tools as UNKNOWN_TOOL. Configuration reload replaces plugin scopes. Only currently advertised tools are callable; diagnostics cannot prove a model saw a schema. Remote Sessions deliberately exclude local management and execution.',
      nextActions: ['If a tool is absent or reported unknown, inspect the current tool list, run diagnose in your own local Bot chat and refresh after reload. Never bypass the isolated remote preset or fall back to Human credentials for a Bot send.'] },
    synchronization: { reconciled, initialSyncComplete: listsKnown, inProgress: Boolean(comm?.transport?.pumping), lastCompletedAt: comm?.transport?.lastSynchronizedAt ?? null,
      lastConnectedAt: comm?.lastConnectedAt ?? null, transportRunning: comm?.transport?.running ?? false },
    tls: { required: applied.url ? safeUrl(applied.url)?.startsWith('wss:') ?? null : null,
      handshake: !applied.enabled ? 'not-started' : connected ? 'connected' : errorCode?.startsWith('HUB_TLS_') ? 'failed' : 'not-confirmed',
      verification: connected && applied.credentialKey && safeUrl(applied.url)?.startsWith('wss:') ? 'verified-by-scoped-or-system-trust' : 'not-confirmed',
      category: errorCode?.startsWith('HUB_TLS_') || errorCode === 'HUB_WEBSOCKET_HANDSHAKE_FAILED' ? error?.code : null,
      peerCertificate: 'not-inspected', why: 'No new handshake is performed by diagnose. Certificate metadata is not inferred from configuration or a prior connection. Keep TLS verification enabled.' },
    credential,
    environment: { credential: { name: envName, observedAtPluginActivation: state.credentialObserved === true,
      presentInCurrentProcess: envName ? Object.hasOwn(process.env, envName) : null,
      hostLeaseAvailable: applied.credentialKey ? null : state.legacy?.status().available === true,
      why: 'Legacy bootstrap credentials are consumed into a host-only process lease and removed from child environments. Absence after consumption is expected; a newly configured shell variable requires restarting the actual host process.' },
      extraCa: { presentInCurrentProcess: Object.hasOwn(process.env, 'NODE_EXTRA_CA_CERTS'), loadedAtProcessStart: 'unknown',
        why: 'Presence is metadata only. Node reads this variable when the process starts; a plugin reload does not prove that Node loaded the file. No path, certificate contents or credential value is returned.' } },
    lists: { contacts: listStatus(comm?.contacts?.length ?? 0), conversations: listStatus(conversationCount(comm?.queue)), invites: listStatus(count(comm?.queue, 'invites')) },
    error, nextActions: error?.nextActions ?? (!applied.enabled ? communicationError({ code: 'COMMUNICATION_NOT_CONFIGURED' }).nextActions
      : bot && !publishedIds.includes(bot.id) ? communicationError({ code: 'BOT_NOT_PUBLISHED' }).nextActions
        : !connected ? ['Check the Hub address, approval and error category. Restore the connection without deleting retained queues or disabling TLS.']
          : !listsKnown ? ['Wait for initial synchronization, then recheck before treating empty lists as authoritative.']
            : ['Resolve an authorized contact and send one message as the intended identity. Connection alone does not grant consent or publication.']),
  }
}

export function communicationDiagnoseTool(rt, getState) {
  return defineTool({ name: 'communication_diagnose', description: 'In your own local Bot chat, inspect Remote communication connection, loaded publication, tool scope, sync, TLS and credential/environment presence metadata. Works when disabled or unpublished. Read-only: no network request, secrets, file reads, reload or permission change. Unavailable to group and isolated remote Sessions.', parameters: {}, output,
    execute: async (_args, exec) => {
      try {
        if (!currentBot(rt, exec.agent?.id)) throw Object.assign(new Error('LOCAL_USER_SESSION_REQUIRED'), { code: 'LOCAL_USER_SESSION_REQUIRED' })
        await rt.load(); await rt.refresh()
        if (!currentBot(rt, exec.agent?.id)) throw Object.assign(new Error('LOCAL_USER_SESSION_REQUIRED'), { code: 'LOCAL_USER_SESSION_REQUIRED' })
        return JSON.stringify(await diagnoseCommunication(rt, getState(), { sessionId: exec.agent.id, agent: exec.agent }))
      } catch (error) { return JSON.stringify({ ok: false, error: communicationError(error) }) }
    } })
}

export function communicationAvailabilityPrompt(rt, state, context) {
  const bot = currentBot(rt, context?.agent?.id)
  if (!bot) return ''
  const enabled = state.settings.enabled === true
  const published = state.runtime ? state.runtime.bots.has(bot.id) : (state.settings.publishedBotIds ?? []).includes(bot.id)
  return `Remote communication availability: enabled=${enabled}, this Bot published=${published}, connected=${state.runtime?.transport.connected === true}. communication_diagnose is a read-only local own-chat tool even when disabled or unpublished. Communication send/read tools ${enabled ? 'remain gated by executing identity, connection and membership' : 'are not registered while disabled'}. A configuration reload may replace tool scopes. Follow the current native/PTC tool presentation; in PTC mode, a direct native call to a registered tool may be UNKNOWN_TOOL. Never call a name missing from the current tool list. If a tool disappears or is unknown, report that limitation, run communication_diagnose when available and recheck after reload. Do not retry through execution tools, Human credentials or a weaker remote preset.`
}
