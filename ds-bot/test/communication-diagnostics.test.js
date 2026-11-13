import assert from 'node:assert/strict'
import { test } from 'node:test'
import { EventEmitter } from 'node:events'
import { recordHubTls } from '../src/host/federation/tls-observation.js'
import { communicationError } from '../src/shared/communication-diagnostics.js'
import { diagnoseCommunication, communicationDiagnoseTool, communicationAvailabilityPrompt, loadedCommunicationSettings } from '../src/host/federation/diagnostics.js'
import { legacyCredential } from '../src/host/federation/legacy-credential.js'
import { CommunicationOnboarding, connectHubSocket } from '../src/host/federation/onboarding.js'
import { install } from '../src/host/communication.js'
import { CommunicationRuntime } from '../src/host/federation/runtime.js'
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
  assert.match(error.nextActions.join(' '), /Contacts > Published Bots/)
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

test('disabled feature diagnostics never query a closed runtime while a saved-only configuration waits for reload', async () => {
  const {rt,state} = fixture({enabled:true,publishedBotIds:['local-bot']})
  rt.remoteHubFeatureSettings=()=>({enabled:false,withdrawalPending:true})
  state.runtime={closed:true,queue:new Proxy({},{get(){assert.fail('closed queue must not be read')}}),transport:{connected:false},bots:new Map([['local-bot',{}]])}
  const value=await diagnoseCommunication(rt,state,{sessionId:'own-chat'})
  assert.equal(value.enabled,false);assert.equal(value.connected,false)
  assert.equal(value.error.code,'REMOTE_HUB_DISABLED')
  assert.equal(value.publication.executingBot.published,false)
  assert.equal(value.tools.communication,'not-registered');assert.deepEqual(value.tools.expectedNames,[])
  assert.equal(value.lists.contacts.state,'disabled')
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
  const key = 'DSBOT_COMMUNICATION_DIAGNOSTICS_TEST', secret = 'test-synthetic-private-value'.repeat(3)
  const { rt, state } = fixture({ enabled: true, credentialEnv: key })
  const env = { [key]: secret }
  state.credentialObserved = true
  state.legacy = legacyCredential(rt, state.settings, env)
  const value = await diagnoseCommunication(rt, state)
  assert.equal(value.environment.credential.observedAtPluginActivation, true)
  assert.equal(value.environment.credential.presentInCurrentProcess, false)
  assert.equal(value.environment.credential.hostLeaseAvailable, true)
  assert.equal(value.environment.extraCa, undefined)
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


test('an initial onChange failure cannot turn unsynchronized empty caches into known zero counts', async () => {
  const { rt, state } = fixture({ enabled: true, url: 'ws://127.0.0.1:3190/communication', publishedBotIds: [] })
  rt.home = '/synthetic-owned-diagnostics'
  rt.ctx.on = () => () => {}
  rt.ctx.systemPrompt = { section: () => () => {} }
  const start = CommunicationTransport.prototype.start
  CommunicationTransport.prototype.start = () => {}
  let runtime
  try {
    runtime = new CommunicationRuntime(rt, { ...state.settings, dataPath: ':memory:' }, () => 'synthetic-private-credential', [])
    state.runtime = runtime
    runtime.transport.request = async () => { throw Object.assign(Error('synthetic directory failure'), { code: 'CONNECTION_LOST' }) }
    await assert.rejects(runtime.transport.onChange(), { code: 'CONNECTION_LOST' })
    assert.equal(runtime.everReconciled, false, 'a failed initial directory read must not mark the runtime reconciled')
    assert.equal(runtime.transport.lastSynchronizedAt, undefined)
    const result = await diagnoseCommunication(rt, state)
    assert.equal(result.synchronization.initialSyncComplete, false)
    assert.equal(result.lists.contacts.count, null)
    assert.equal(result.lists.contacts.state, 'not-synchronized')
    assert.equal(runtime.snapshot().listState, 'not-synchronized')
  } finally { CommunicationTransport.prototype.start = start; await runtime?.close() }
})


test('diagnose reports the observed Hub-scoped trust source without inferring trust from a signing-record reference', async () => {
  const { rt, state } = fixture({ enabled: true, url: 'wss://hub.example.test/communication', credentialKey: 'ds-bot/communication-test' })
  state.runtime = { bots: new Map(), contacts: [], transport: { connected: true, socket: {} } }
  assert.equal((await diagnoseCommunication(rt, state)).tls.trustSource, 'not-observed')
  assert.equal((await diagnoseCommunication(rt, state)).tls.verification, 'not-confirmed')
  recordHubTls(state.runtime.transport.socket, { secure: true, scopedCa: true })
  const value = await diagnoseCommunication(rt, state)
  assert.equal(value.tls.trustSource, 'hub-scoped-ca')
  assert.equal(value.tls.verification, 'verified-for-observed-handshake')
  assert.equal(value.tls.observedHandshake.currentConnection, true)
  assert.doesNotMatch(JSON.stringify(value), /NODE_EXTRA_CA_CERTS|caPem|privateKey/)
  state.runtime.transport.connected = false
  const cached = await diagnoseCommunication(rt, state)
  assert.equal(cached.tls.verification, 'not-confirmed')
  assert.equal(cached.tls.observedHandshake.currentConnection, false)
})


test('diagnose never invents a standard endpoint when a legacy custom path was not safe to disclose', async () => {
  const { rt, state } = fixture({ enabled: true, url: 'wss://hub.example.test/PRIVATE_CUSTOM_PATH' })
  const value = await diagnoseCommunication(rt, state)
  assert.equal(value.hub.url, null)
  assert.doesNotMatch(JSON.stringify(value), /PRIVATE_CUSTOM_PATH/)
})

test('coalesced publication-generation changes are pending reload even when the selected Bot list is unchanged',async()=>{
 const {rt,state}=fixture({enabled:true,publishedBotIds:['local-bot'],publicationGenerations:{'local-bot':'old'}})
 rt.config.communication.publicationGenerations['local-bot']='withdrawn-then-republished'
 const result=await diagnoseCommunication(rt,state)
 assert.equal(result.configuration.reloadRequired,true)
 assert.deepEqual(result.configuration.changedKeys,['publicationGenerations'])
})

test('Bot-scoped local API requests fail explicitly before using a not-yet-loaded publication',async()=>{
 let route
 const rt={config:{remoteHubEnabled:true,communication:{enabled:false,publishedBotIds:[]}},teamTools:[],ctx:{effect:fn=>fn(),connection:{fetch:{register:value=>{route=value;return ()=>{}}}}}}
 install(rt)
 rt.config.communication={...rt.config.communication,publishedBotIds:['new-bot']}
 for(const endpoint of ['relationship-memory','save-relationship-memory','bot-dm-history']){
  const response=await route.fetch(new Request('http://127.0.0.1/api/communication',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({endpoint,localBotId:'new-bot',conversationId:'conversation',membershipEpoch:'old'})}))
  const result=await response.json()
  assert.equal(result.ok,false);assert.equal(result.error.code,'PUBLICATION_RELOAD_REQUIRED');assert.equal(result.error.reloadRequired,true)
 }
})


test('a saved-only publication edit blocks every Bot-scoped API until actual runtime reload, even when memory options stay unchanged',async()=>{
 let route
 const communication={enabled:false,hubId:'hub-a',url:'wss://synthetic.example.test/communication',instanceId:'a',publishedBotIds:[]}
 let saved={communication:structuredClone(communication)}
 const worker={id:'worker',name:'Worker'}
 const rt={config:{communication:structuredClone(communication)},state:{bots:{worker}},botOf:id=>id==='worker'?worker:undefined,teamTools:[],ctx:{effect:fn=>fn(),configEditor:{
  entries:()=>[{options:{name:'ds-bot'}}],edit:async(_entry,change)=>{saved=change(structuredClone(saved))}},connection:{fetch:{register:value=>{route=value;return ()=>{}}}}}}
 const applied=loadedCommunicationSettings(rt.config.communication)
 install(rt)
 const result=await new CommunicationOnboarding(rt).handle('publish-bots',{localBotIds:['worker']},{human:true})
 assert.equal(result.reloadReason,'publication');assert.equal(result.publicationStatus,'saved-pending-reload')
 assert.deepEqual(rt.config.communication.publishedBotIds,[],'public editor saved without mutating loaded options')
 const call=async body=>(await route.fetch(new Request('http://127.0.0.1/api/communication',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)}))).json()
 for(const endpoint of ['relationship-memory','save-relationship-memory','forget-relationship-memory','bot-dm-history','bot-dm-reference','set-conversation-archived']){
  const denied=await call({endpoint,localBotId:'worker',conversationId:'old',membershipEpoch:'old'})
  assert.equal(denied.error.code,'PUBLICATION_RELOAD_REQUIRED',endpoint)
  assert.equal(denied.error.reloadReason,'publication');assert.equal(denied.error.reloadRequired,true)
 }
 const state=(await call({endpoint:'state'})).value
 assert.equal(state.reloadRequired,true);assert.equal(state.reloadReason,'publication')
 const diagnostic=await diagnoseCommunication(rt,{settings:applied,toolNames:[]})
 assert.deepEqual(diagnostic.configuration.changedKeys,['publishedBotIds'])
 assert.equal(diagnostic.publication.state,'saved-pending-reload')
 rt.config=saved;install(rt)
 const loaded=(await call({endpoint:'state'})).value
 assert.equal(loaded.reloadRequired,false);assert.equal(loaded.reloadReason,null)
})

test('failed publication writes do not manufacture a pending save receipt',async()=>{
 const worker={id:'worker',name:'Worker'},rt={config:{communication:{enabled:true,url:'wss://synthetic.example.test/communication',instanceId:'a',publishedBotIds:[]}},state:{bots:{worker}},botOf:()=>worker,ctx:{configEditor:{entries:()=>[{options:{name:'ds-bot'}}],edit:async(_entry,change)=>{change(structuredClone(rt.config));throw Object.assign(new Error('private storage error'),{code:'STORAGE_UNAVAILABLE'})}}}}
 await assert.rejects(new CommunicationOnboarding(rt).handle('publish-bots',{localBotIds:['worker']},{human:true}),{code:'STORAGE_UNAVAILABLE'})
 assert.equal(rt.pendingCommunicationPublication,undefined)
})

test('saved-only hide and republish remains pending even when the original Bot selection returns',async()=>{
 const {recordPublicationSave,publicationReloadRequired,pendingPublication}=await import('../src/host/federation/publication-state.js')
 const applied={hubId:'one',url:'wss://one.example.test/communication',instanceId:'a',publishedBotIds:['worker']}
 const rt={config:{communication:structuredClone(applied)}}
 recordPublicationSave(rt,{...applied,publishedBotIds:[],publicationGenerations:{worker:'new-lifetime'}})
 recordPublicationSave(rt,{...applied,publicationGenerations:{worker:'new-lifetime'}})
 assert.equal(publicationReloadRequired(rt,applied),true)
 assert.equal(pendingPublication(rt,applied).publicationGenerations.worker,'new-lifetime')
 const loaded={...applied,publicationGenerations:{worker:'new-lifetime'}}
 rt.config.communication=loaded
 assert.equal(publicationReloadRequired(rt,loaded),false)
 rt.config.communication={...applied,hubId:'two',url:'wss://two.example.test/communication'}
 assert.equal(publicationReloadRequired(rt,applied),false,'a pending receipt cannot cross a Hub selection')
})

test('Hub-scoped memory and history errors explain their local alternatives without registering remote Skill copies', async () => {
  const {rt} = fixture({enabled: true, publishedBotIds: []})
  rt.config.remoteHubEnabled = true
  rt.teamTools = []
  rt.ctx.effect = () => {}
  install(rt)
  assert.equal(rt.teamTools.some(tool => ['read_own_skill','save_own_skill'].includes(tool.name)), false)
  for (const [name, args, alternative] of [
    ['read_own_remote_history', {}, 'read_own_chat'],
    ['read_communication_relationships', {conversationId: 'group'}, 'recall/remember/forget'],
    ['remember_communication_relationship', {conversationId: 'group', subjectKind: 'self', topic: 'expertise', text: 'Review', sourceMessageId: 'source'}, 'save_capability'],
  ]) {
    const tool = rt.teamTools.find(tool => tool.name === name)
    const result = JSON.parse(await tool.execute(args, {name, agent: {id: 'own-chat'}}))
    assert.equal(result.ok, false)
    assert.match(result.error.scopeHint, new RegExp(alternative))
    assert.match(result.error.nextActions[0], /do not require Hub publication/)
    assert.notEqual(result.error.code, 'INVALID_REQUEST', 'the underlying remote error remains visible')
  }
})
