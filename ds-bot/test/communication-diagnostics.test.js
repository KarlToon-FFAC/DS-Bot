import assert from 'node:assert/strict'
import { test } from 'node:test'
import { EventEmitter } from 'node:events'
import { communicationError } from '../src/shared/communication-diagnostics.js'
import { diagnoseCommunication, communicationDiagnoseTool, communicationAvailabilityPrompt, loadedCommunicationSettings } from '../src/host/federation/diagnostics.js'
import { legacyCredential } from '../src/host/federation/legacy-credential.js'
import { connectHubSocket } from '../src/host/federation/onboarding.js'
import { install } from '../src/host/communication.js'
import { CommunicationTransport } from '../src/host/federation/transport.js'

const fixture = settings => {
  const bot = { id: 'local-bot', name: 'Local Helper' }
  const rt = { config: { communication: { ...settings } }, ctx: {}, botOf: id => id === bot.id ? bot : undefined,
    chatOwners: new Map([['own-chat', bot.id]]), groupOwners: new Map([['group-chat', bot.id]]),
    load: async () => {}, refresh: async () => {} }
  return { rt, bot, state: { settings: loadedCommunicationSettings(settings ?? {}), toolNames: ['list_contacts', 'send_contact_message'] } }
}

test('structured errors identify the unpublished actor and give safe why, next actions and reload guidance', () => {
  const error = communicationError({ code: 'BOT_NOT_PUBLISHED', message: 'SECRET', cause: { privateKey: 'SECRET' } }, { bot: { id: 'local-bot', name: 'Local Helper' } })
  assert.equal(error.subject.localBotId, 'local-bot')
  assert.match(error.why, /executing Bot/)
  assert.match(error.nextActions.join(' '), /Personal settings > Published Bots/)
  assert.match(error.nextActions.join(' '), /reload/)
  assert.ok(error.docsHint)
  assert.doesNotMatch(JSON.stringify(error), /SECRET/)
  const unknown = communicationError({ code: 'SECRET_CODE', message: 'SECRET', phase: 'SECRET_PHASE' })
  assert.equal(unknown.code, 'COMMUNICATION_UNAVAILABLE')
  assert.doesNotMatch(JSON.stringify(unknown), /SECRET/)
})

test('integrated management and relationship failures retain only exact public codes and descriptions', () => {
  for (const code of ['LOCAL_MANAGEMENT_REJECTED', 'LOCAL_MANAGEMENT_CANCELLED', 'LOCAL_MANAGEMENT_APPROVAL_UNAVAILABLE',
    'LOCAL_USER_AUTHORIZATION_REQUIRED', 'PUBLICATION_CHANGED', 'INVALID_RELATIONSHIP_MEMORY', 'MEMBERSHIP_EPOCH_REQUIRED', 'RELATIONSHIP_MEMORY_FULL',
    'RELATIONSHIP_SECRET_REFUSED', 'RELATIONSHIP_SHARING_CONFIRMATION_REQUIRED', 'RELATIONSHIP_SOURCE_REQUIRED', 'RELATIONSHIP_SUBJECT_NOT_VISIBLE']) {
    const value = communicationError({ code, message: 'PRIVATE_EXCEPTION_MESSAGE', cause: 'PRIVATE_EXCEPTION_CAUSE' })
    assert.equal(value.code, code)
    assert.notEqual(value.message, 'The communication operation could not be completed.')
    assert.doesNotMatch(JSON.stringify(value), /PRIVATE_EXCEPTION/)
  }
  const value = communicationError({ code: 'LOCAL_MANAGEMENT_REJECTED_PRIVATE_EXCEPTION', message: 'PRIVATE_EXCEPTION_MESSAGE' })
  assert.equal(value.code, 'COMMUNICATION_UNAVAILABLE')
  assert.doesNotMatch(JSON.stringify(value), /PRIVATE_EXCEPTION/)
})

test('unconfigured diagnose is available only in own local chat and never creates a connection', async () => {
  const { rt, state } = fixture({ enabled: false })
  const tool = communicationDiagnoseTool(rt, () => state)
  for (const id of ['group-chat', 'remote-chat', 'unknown']) {
    const result = JSON.parse(await tool.execute({}, { agent: { id } }))
    assert.equal(result.error.code, 'LOCAL_USER_SESSION_REQUIRED')
    assert.equal(result.enabled, undefined)
  }
  const result = JSON.parse(await tool.execute({}, { agent: { id: 'own-chat' } }))
  assert.equal(result.enabled, false)
  assert.equal(result.connected, false)
  assert.equal(result.tools.communication, 'not-registered')
  assert.deepEqual(result.tools.expectedNames, [])
  assert.equal(result.lists.contacts.state, 'disabled')
  assert.equal(result.lists.contacts.count, null)
  assert.equal(rt.communication, undefined)
  assert.equal(communicationAvailabilityPrompt(rt, state, { agent: { id: 'group-chat' } }), '')
  assert.match(communicationAvailabilityPrompt(rt, state, { agent: { id: 'own-chat' } }), /missing from the current tool list/)
})

test('diagnose distinguishes unknown, cached and synchronized emptiness, scoped publication, sync and TLS facts', async () => {
  const { rt, state } = fixture({ enabled: true, url: 'wss://hub.example.test/communication', hubId: 'hub', instanceId: 'instance', publishedBotIds: ['local-bot'] })
  let value = await diagnoseCommunication(rt, state, { sessionId: 'own-chat' })
  assert.equal(value.publication.executingBot.published, true)
  assert.equal(value.publication.state, 'not-confirmed')
  assert.equal(value.lists.contacts.count, null)
  assert.equal(value.tls.verification, 'not-confirmed')
  state.runtime = { bots: new Map([['local-bot', {}]]), queue: { instanceId: 'instance', memberships: () => [], invites: () => [] }, contacts: [],
    transport: { connected: true, running: true, lastSynchronizedAt: '2026-11-05T00:00:00.000Z' }, everReconciled: true, publicationSyncedAt: '2026-11-05T00:00:00.000Z' }
  value = await diagnoseCommunication(rt, state, { sessionId: 'own-chat' })
  assert.equal(value.lists.contacts.count, 0)
  assert.equal(value.lists.contacts.state, 'authorized-snapshot')
  assert.equal(value.synchronization.lastCompletedAt, state.runtime.transport.lastSynchronizedAt)
  assert.equal(value.tls.peerCertificate, 'not-inspected')
  assert.equal(value.tls.verification, 'not-confirmed', 'legacy transport trust cannot be inferred from a connected flag')
  state.runtime.transport.connected = false
  state.runtime.transportError = 'HUB_TLS_HOSTNAME_MISMATCH'
  value = await diagnoseCommunication(rt, state)
  assert.equal(value.lists.contacts.state, 'cached-snapshot')
  assert.equal(value.tls.handshake, 'failed')
  assert.equal(value.error.code, 'HUB_TLS_HOSTNAME_MISMATCH')
})

test('environment metadata distinguishes consumed private host lease from current process presence and invalidation', async () => {
  const key = 'DSBOT_COMMUNICATION_DIAGNOSTICS_TEST', secret = 'synthetic-private-value'.repeat(3)
  const { rt, state } = fixture({ enabled: true, credentialEnv: key })
  const env = { [key]: secret }
  state.credentialObserved = true
  state.legacy = legacyCredential(rt, state.settings, env)
  const value = await diagnoseCommunication(rt, state)
  assert.equal(value.environment.credential.observedAtPluginActivation, true)
  assert.equal(value.environment.credential.presentInCurrentProcess, false)
  assert.equal(value.environment.credential.hostLeaseAvailable, true)
  assert.equal(value.environment.extraCa.loadedAtProcessStart, 'unknown')
  assert.doesNotMatch(JSON.stringify(value), new RegExp(secret))
  state.legacy.invalidate()
  assert.equal((await diagnoseCommunication(rt, state)).credential.availableToHost, false)
})

test('only credential record metadata is queried, never secret payloads or private environment values', async () => {
  const { rt, state } = fixture({ enabled: true, credentialKey: 'ds-bot/communication-test', url: 'wss://private:SECRET@hub.example.test/communication?SECRET' })
  let read = 0, describe = 0
  rt.ctx.get = () => ({ readRecord: () => { read++; throw Error('SECRET') }, describeRecord: () => { describe++; return { configured: true, writable: false, privateKey: 'SECRET' } } })
  const value = await diagnoseCommunication(rt, state)
  assert.equal(read, 0); assert.equal(describe, 1)
  assert.equal(value.credential.recordPresent, true)
  assert.equal(value.credential.availableToHost, null, 'record presence does not prove valid authentication')
  assert.equal(value.hub.url, null)
  assert.doesNotMatch(JSON.stringify(value), /SECRET/)
})

test('reloadRequired is evidence-based and does not claim that external files or launch environments were loaded', async () => {
  const { rt, state } = fixture({ enabled: true, publishedBotIds: [] })
  assert.equal((await diagnoseCommunication(rt, state)).configuration.reloadRequired, false)
  rt.config.communication.publishedBotIds.push('local-bot')
  const value = await diagnoseCommunication(rt, state)
  assert.equal(value.configuration.reloadRequired, true)
  assert.deepEqual(value.configuration.changedKeys, ['publishedBotIds'])
  assert.equal(value.publication.executingBot, null)
  assert.equal(value.configuration.savedConfiguration, 'not-inspected')
})

test('authenticated local diagnose HTTP route works without ensure and rejects identity injection', async () => {
  let route, load = 0
  const rt = { config: {}, teamTools: [], load: async () => { load++ }, refresh: async () => {}, ctx: {
    effect: fn => fn(), connection: { fetch: { register: value => { route = value; return () => {} } } } } }
  install(rt)
  const call = async input => (await route.fetch(new Request('http://127.0.0.1/api/communication', { method: 'POST', body: JSON.stringify(input) }))).json()
  const result = await call({ endpoint: 'diagnose' })
  assert.equal(result.ok, true); assert.equal(result.value.runtimeStarted, false); assert.equal(load, 1)
  assert.equal((await call({ endpoint: 'diagnose', principalId: 'forged' })).error.code, 'AUTHOR_MISMATCH')
})

test('secure handshake errors distinguish certificate, TLS protocol and WebSocket upgrade failures without leaking raw errors', async () => {
  for (const [native, expected] of [['ERR_SSL_WRONG_VERSION_NUMBER', 'HUB_TLS_HANDSHAKE_FAILED'], ['CERT_HAS_EXPIRED', 'HUB_TLS_CERT_EXPIRED'], ['ERR_TLS_CERT_ALTNAME_INVALID', 'HUB_TLS_HOSTNAME_MISMATCH'], ['unexpected-response', 'HUB_WEBSOCKET_HANDSHAKE_FAILED']]) {
    class Socket extends EventEmitter {
      constructor() { super(); queueMicrotask(() => native === 'unexpected-response' ? this.emit(native, {}, { statusCode: 403 }) : this.emit('error', Object.assign(new Error('SECRET'), { code: native }))) }
      terminate() {}
    }
    await assert.rejects(connectHubSocket('wss://hub.example.test/communication', { resolve: async () => [{ address: '203.0.113.8', family: 4 }], socketClass: Socket }), { code: expected })
  }
})

test('transport marks synchronization complete only after a fully successful authorized pump', async () => {
  const queue = { pendingReceipts: () => [], pendingOutbox: () => [], applyMemberships() {}, memberships: () => [] }
  const transport = new CommunicationTransport(queue, { url: 'ws://127.0.0.1/communication', onChange: async () => {} })
  transport.connected = true
  transport.request = async () => []
  await transport.pump()
  assert.ok(Number.isFinite(Date.parse(transport.lastSynchronizedAt)))
  const prior = transport.lastSynchronizedAt
  transport.onChange = () => { throw Object.assign(new Error('fail'), { code: 'CONNECTION_LOST' }) }
  await assert.rejects(transport.pump(), { code: 'CONNECTION_LOST' })
  assert.equal(transport.lastSynchronizedAt, prior)
})

test('diagnose reports the actual scoped registry without equating registration with native model presentation', async () => {
  const { rt, state } = fixture({ enabled: true })
  const agent = { id: 'own-chat' }
  rt.ctx.tools = { schemas: scope => { assert.equal(scope, agent); return [{ name: 'communication_diagnose' }, { name: 'list_contacts' }, { name: 'secret_other_tool' }] } }
  const value = await diagnoseCommunication(rt, state, { sessionId: agent.id, agent })
  assert.deepEqual(value.tools.registeredNames, ['communication_diagnose', 'list_contacts'])
  assert.deepEqual(value.tools.missingExpectedNames, ['send_contact_message'])
  assert.equal(value.tools.actualServedNames, null)
  assert.match(value.tools.why, /PTC.*UNKNOWN_TOOL/)
  assert.doesNotMatch(JSON.stringify(value), /secret_other_tool/)
})
