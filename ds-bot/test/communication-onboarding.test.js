import { testHubCode, testHubInput } from './fixtures/v2-hub-code.mjs'
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { verify, generateKeyPairSync } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { Context } from '@deepseek-ai/cordis'
import { CommunicationOnboarding, communicationAuthentication, communicationCredentialKey, communicationStorageStatus, communicationSocket, completeCommunicationWithdrawal,
  connectHubSocket, decodeHubCode, enrollmentSigningText, openEnrollmentSocket, validateHubUrl } from '../src/host/federation/onboarding.js'

const hub = { hubId: 'hub-isolated-test', url: 'wss://192.168.1.20:3190/communication' }
const hubCode = testHubCode
const joinInput = { ...testHubInput(hub), displayName: 'Isolated device' }
const human = { human: true }
const clone = value => value === undefined ? undefined : structuredClone(value)

function fixture({ current = {}, failSave = 0, challengeChange, responseStatus = 'pending' } = {}) {
  const records = new Map(), calls = [], configWrites = []
  let saves = 0, sockets = 0, closed = 0, writable = true
  const key = communicationCredentialKey(hub.hubId)
  const credentials = {
    readRecord: async name => clone(records.get(name)),
    listRecords: async () => [...records].map(([key, record]) => ({ key, kind: record.kind })),
    describeRecord: async name => ({ configured: records.has(name), kind: records.has(name) ? 'grant' : undefined, writable }),
    modifyRecord: async (name, change) => {
      saves++
      if (saves === failSave) throw Object.assign(new Error('synthetic storage failure'), { code: 'STORAGE_UNAVAILABLE' })
      const next = await change(clone(records.get(name)))
      if (next !== undefined) records.set(name, clone(next))
    },
  }
  const rt = { config: clone(current), ctx: { credentials, configEditor: {
    entries: () => [{ options: { name: 'ds-bot', id: 'bot' } }],
    edit: async (_entry, change) => { const next = change(clone(rt.config)); configWrites.push(clone(next)); rt.config = next },
  } } }
  const connect = async () => {
    sockets++
    assert.ok(records.get(key)?.payload.privateKey, 'private key must be durably stored before opening a connection')
    let challenge
    return { close: () => { closed++ }, request: async (type, payload) => {
      calls.push({ type, payload: clone(payload) })
      if (type === 'enrollment.challenge') {
        challenge = { challengeId: `challenge-${sockets}`, nonce: 'N'.repeat(32), hubId: hub.hubId, purpose: payload.purpose,
          ...(payload.purpose === 'login' ? { instanceId: payload.instanceId } : { requestId: payload.requestId ?? `request-${sockets}` }), expiresAt: Date.now() + 60000 }
        challengeChange?.(challenge)
        return clone(challenge)
      }
      assert.equal(type, 'enrollment.prove')
      if (challenge.purpose === 'join') assert.equal(records.get(key).payload.requestId, challenge.requestId, 'request identity must be stored before proof can leave')
      assert.equal(verify(null, Buffer.from(enrollmentSigningText(challenge)), records.get(key).payload.publicKey, Buffer.from(payload.signature, 'base64url')), true)
      if (challenge.purpose === 'login') return { instanceId: challenge.instanceId, capabilities: payload.capabilities }
      const status = challenge.purpose === 'cancel' ? 'cancelled' : responseStatus
      return { requestId: challenge.requestId, status, ...(status === 'approved' ? { instanceId: 'isolated-instance' } : {}) }
    } }
  }
  const onboarding = new CommunicationOnboarding(rt, { connect })
  return { onboarding, rt, records, calls, key, configWrites, connect, get sockets() { return sockets }, get closed() { return closed },
    get saves() { return saves }, setWritable: value => { writable = value } }
}

test('Hub codes identify version, exact endpoint and Hub; private LAN WSS is allowed, unsafe schemes and metadata are rejected', () => {
  assert.equal(decodeHubCode(hubCode(hub)).version, 2)
  for (const url of ['ws://192.168.1.20/communication', 'https://example.com/communication', 'wss://u:p@example.com/communication',
    'wss://example.com/communication?secret=no', 'wss://example.com/communication#fragment', 'wss://example.com/elsewhere',
    'wss://169.254.169.254/communication', 'wss://100.100.100.200/communication', 'wss://[fe80::1]/communication',
    'wss://[::ffff:127.0.0.1]/communication', 'wss://localhost/communication', 'wss://0.0.0.0/communication']) {
    assert.throws(() => validateHubUrl(url))
  }
  for (const code of ['dsbot-hub:2:abc', hubCode({ ...hub, credential: 'not allowed' }), hubCode({ ...hub, hubId: '' })]) assert.throws(() => decodeHubCode(code), { code: 'INVALID_HUB_CODE' })
  assert.throws(() => validateHubUrl('ws://127.0.0.1:3190/communication'), { code: 'TLS_REQUIRED' })
  assert.equal(validateHubUrl('ws://127.0.0.1:3190/communication', { allowLoopback: true }), 'ws://127.0.0.1:3190/communication')
})

test('DNS metadata or mixed safe/unsafe results are rejected before any socket exists', async () => {
  for (const addresses of [[{ address: '169.254.169.254', family: 4 }], [{ address: '192.168.1.20', family: 4 }, { address: '127.0.0.1', family: 4 }]]) {
    await assert.rejects(openEnrollmentSocket('wss://isolated.example/communication', { resolve: async () => addresses }), { code: 'HUB_ADDRESS_FORBIDDEN' })
  }
  await assert.rejects(openEnrollmentSocket('wss://isolated.example/communication', { resolve: async () => new Promise(() => {}), timeoutMs: 5 }), { code: 'HUB_UNREACHABLE' })
})

test('the shared socket pins validated DNS while retaining TLS verification, rejects redirects and bounds handshake time', async () => {
  const created = []
  class Socket extends EventEmitter {
    constructor(url, options) { super(); this.readyState = 0; this.url = url; this.options = options; created.push(this); queueMicrotask(() => { this.readyState = 1; this.emit('open') }) }
    close() { if (this.readyState === 3) return; this.readyState = 3; this.emit('close') }
    terminate() { this.close() }
    send(frame) { const request = JSON.parse(frame); queueMicrotask(() => this.emit('message', Buffer.from(JSON.stringify({ id: request.id, ok: true, value: { purpose: request.payload.purpose } })), false)) }
  }
  let lookups = 0
  const options = { socketClass: Socket, resolve: async () => { lookups++; return [{ address: '192.168.1.20', family: 4 }] } }
  const socket = await connectHubSocket('wss://isolated.example/communication', options)
  assert.equal(socket.readyState, 1)
  assert.equal(socket.url, 'wss://isolated.example/communication', 'TLS sees the original hostname')
  assert.equal(socket.options.rejectUnauthorized, true)
  assert.equal(socket.options.followRedirects, false)
  assert.equal(socket.options.minVersion, 'TLSv1.2')
  assert.equal(socket.options.maxPayload, 131072)
  socket.options.lookup('isolated.example', { all: true }, (error, values) => { assert.equal(error, null); assert.deepEqual(values, [{ address: '192.168.1.20', family: 4 }]) })
  socket.options.lookup('isolated.example', {}, (error, address, family) => { assert.equal(error, null); assert.equal(address, '192.168.1.20'); assert.equal(family, 4) })
  assert.equal(lookups, 1, 'the OS resolver is not called again for the handshake')
  socket.close()
  const rpc = await openEnrollmentSocket('wss://isolated.example/communication', options)
  assert.deepEqual(await rpc.request('enrollment.challenge', { purpose: 'join' }), { purpose: 'join' })
  assert.equal(created.at(-1).options.followRedirects, false, 'enrollment uses the exact shared connection path')
  rpc.close()
  class Stalled extends EventEmitter { terminate() { this.terminated = true } }
  await assert.rejects(connectHubSocket(hub.url, { socketClass: Stalled, timeoutMs: 5 }), { code: 'HUB_CONNECTION_TIMEOUT' })
})

test('enrollment distinguishes untrusted CA, hostname mismatch, expired TLS and refusal without exposing raw errors or disabling verification', async () => {
  for (const [failureCode, code] of [['DEPTH_ZERO_SELF_SIGNED_CERT', 'HUB_TLS_UNTRUSTED'], ['ERR_TLS_CERT_ALTNAME_INVALID', 'HUB_TLS_HOSTNAME_MISMATCH'], ['CERT_HAS_EXPIRED', 'HUB_TLS_CERT_EXPIRED'], ['ECONNREFUSED', 'HUB_CONNECTION_REFUSED']]) {
    let options
    class Failed extends EventEmitter {
      constructor(_url, value) { super(); options = value; queueMicrotask(() => this.emit('error', Object.assign(new Error('DO_NOT_DISPLAY_RAW_SOCKET_ERROR'), { code: failureCode }))) }
      terminate() {}
    }
    await assert.rejects(connectHubSocket(hub.url, { socketClass: Failed }), error => error.code === code && error.message === code)
    assert.equal(options.rejectUnauthorized, true); assert.equal(options.followRedirects, false)
  }
})

test('construction and unauthenticated or Bot calls cannot create a key, connect, or enroll', async () => {
  const f = fixture()
  assert.equal(f.saves, 0)
  for (const authority of [undefined, {}, { human: false }, { human: true, agent: {} }]) await assert.rejects(f.onboarding.handle('join', joinInput, authority), { code: 'HUMAN_REQUIRED' })
  for (const field of ['principalId', 'sender', 'privateKey', 'publicKey', 'credentialKey', 'allowLoopback']) await assert.rejects(f.onboarding.handle('join', { ...joinInput, [field]: 'spoof' }, human), { code: 'AUTHOR_MISMATCH' })
  await assert.rejects(f.onboarding.handle('join', { ...joinInput, confirmedUrl: 'wss://other.example/communication' }, human), { code: 'HUB_CONFIRMATION_REQUIRED' })
  assert.equal(f.saves, 0); assert.equal(f.sockets, 0)
})

test('explicit Human join persists the key and then request ID before proof; all returned views exclude private material', async () => {
  const f = fixture()
  const state = await f.onboarding.handle('join', joinInput, human)
  assert.equal(state.status, 'pending'); assert.equal(state.requestId, 'request-1'); assert.equal(f.closed, 1)
  assert.equal(f.records.get(f.key).kind, 'grant')
  const serialized = JSON.stringify([state, await f.onboarding.handle('storage', { hubId: hub.hubId }, human)])
  assert.equal(serialized.includes(f.records.get(f.key).payload.privateKey), false)
  assert.equal(serialized.includes('PRIVATE KEY'), false)
  assert.equal(serialized.includes('publicKey'), false)
  assert.deepEqual(state.storage, communicationStorageStatus)
  assert.equal(state.storage.encryptedByDefault, false)
  assert.equal(state.storage.agentIsolation, false)
  assert.deepEqual(f.calls.map(call => call.type), ['enrollment.challenge', 'enrollment.prove'])
  assert.equal(f.configWrites.length, 0, 'pending approval must not activate communication')
  const restored = new CommunicationOnboarding(f.rt, { connect: f.connect })
  const recoveryView = await restored.handle('storage', {}, human)
  assert.deepEqual(recoveryView.enrollments.map(value => ({ hubId: value.hubId, status: value.status })), [{ hubId: hub.hubId, status: 'pending' }])
  assert.equal(JSON.stringify(recoveryView).includes('PRIVATE KEY'), false)
})

test('a storage failure before the first save creates no socket; a request-ID save failure sends no proof', async () => {
  const first = fixture({ failSave: 1 })
  await assert.rejects(first.onboarding.handle('join', joinInput, human), { code: 'STORAGE_UNAVAILABLE' })
  assert.equal(first.sockets, 0); assert.equal(first.records.size, 0)
  const second = fixture({ failSave: 2 })
  await assert.rejects(second.onboarding.handle('join', joinInput, human), { code: 'STORAGE_UNAVAILABLE' })
  assert.equal(second.calls.filter(call => call.type === 'enrollment.prove').length, 0)
  assert.equal(second.closed, 1)
  const readOnly = fixture(); readOnly.setWritable(false)
  await assert.rejects(readOnly.onboarding.handle('join', joinInput, human), { code: 'CREDENTIAL_STORAGE_READ_ONLY' })
  assert.equal(readOnly.sockets, 0)
})

test('wrong Hub, purpose, request, nonce or expiry challenges are refused without sending a signature', async () => {
  for (const change of [value => { value.hubId = 'other' }, value => { value.purpose = 'login' }, value => { delete value.requestId },
    value => { value.nonce = 'short' }, value => { value.expiresAt = Date.now() - 1 }, value => { value.expiresAt = Date.now() + 300000 }]) {
    const f = fixture({ challengeChange: change })
    await assert.rejects(f.onboarding.handle('join', joinInput, human), { code: 'INVALID_ENROLLMENT_CHALLENGE' })
    assert.equal(f.calls.filter(call => call.type === 'enrollment.prove').length, 0)
    assert.equal(f.closed, 1)
  }
})

test('pending status survives a new onboarding object and cancellation preserves the same signing identity', async () => {
  const f = fixture()
  await f.onboarding.handle('join', joinInput, human)
  const publicKey = f.records.get(f.key).payload.publicKey
  const restored = new CommunicationOnboarding(f.rt, { connect: f.connect })
  assert.equal((await restored.handle('status', { hubId: hub.hubId }, human)).status, 'pending')
  assert.equal((await restored.handle('cancel', { hubId: hub.hubId }, human)).status, 'cancelled')
  assert.equal(f.records.get(f.key).payload.publicKey, publicKey)
  assert.deepEqual(f.calls.filter(call => call.type === 'enrollment.challenge').map(call => call.payload.purpose), ['join', 'status', 'cancel'])
  await restored.handle('join', joinInput, human)
  assert.equal(f.records.get(f.key).payload.publicKey, publicKey, 'a new explicit join after cancellation reuses the device key')
})

test('approved join writes only nonsecret configuration through the public editor and preserves existing user settings', async () => {
  const f = fixture({ current: { name: 'team', custom: { unchanged: true }, communication: { pollMs: 321, publishedBotIds: ['known-bot'] } }, responseStatus: 'approved' })
  const state = await f.onboarding.handle('join', joinInput, human)
  assert.equal(state.status, 'approved')
  assert.equal(f.configWrites.length, 1)
  const config = f.configWrites[0]
  assert.deepEqual(config.custom, { unchanged: true })
  assert.deepEqual(config.communication.publishedBotIds, ['known-bot'])
  assert.equal(config.communication.pollMs, 321)
  assert.equal(config.communication.credentialKey, f.key)
  assert.equal(config.communication.instanceId, 'isolated-instance')
  assert.equal(config.communication.humanDisplayName, joinInput.displayName, 'the first Human registration uses the approved applicant name')
  assert.equal(JSON.stringify(config).includes('PRIVATE KEY'), false)
  assert.equal(Object.hasOwn(config.communication, 'privateKey'), false)
  assert.equal(Object.hasOwn(config.communication, 'credential'), false)
  await f.onboarding.handle('status', { hubId: hub.hubId }, human)
  assert.equal(f.configWrites.length, 1, 'status polling an already configured identity must not reload its plugin')
})

test('approved configuration preserves an existing Human name instead of replacing it with the applicant or default name', async () => {
  const f = fixture({ current: { communication: { humanDisplayName: 'Existing Human', publishedBotIds: [] } }, responseStatus: 'approved' })
  await f.onboarding.handle('join', joinInput, human)
  assert.equal(f.configWrites[0].communication.humanDisplayName, 'Existing Human')
})

test('an uncertain proof outcome is reconciled through the saved request identity instead of creating a second join', async () => {
  const f = fixture()
  let drop = true
  const connect = async (...args) => {
    const socket = await f.connect(...args)
    return { close: socket.close, request: async (type, payload) => {
      const value = await socket.request(type, payload)
      if (type === 'enrollment.prove' && drop) { drop = false; throw Object.assign(new Error('synthetic dropped response'), { code: 'CONNECTION_LOST' }) }
      return value
    } }
  }
  const onboarding = new CommunicationOnboarding(f.rt, { connect })
  await assert.rejects(onboarding.handle('join', joinInput, human), { code: 'CONNECTION_LOST' })
  const state = await onboarding.handle('join', joinInput, human)
  assert.equal(state.status, 'pending')
  assert.deepEqual(f.calls.filter(call => call.type === 'enrollment.challenge').map(call => call.payload.purpose), ['join', 'status'])
  assert.equal(state.requestId, 'request-1')
})

test('a proved absent pre-admission request permits a new explicit join without rotating the stored key', async () => {
  const f = fixture({ failSave: 2 })
  await assert.rejects(f.onboarding.handle('join', joinInput, human), { code: 'STORAGE_UNAVAILABLE' })
  // Simulate a durable request-ID checkpoint followed by process loss before proof.
  const publicKey = f.records.get(f.key).payload.publicKey
  await f.rt.ctx.credentials.modifyRecord(f.key, current => ({ ...current, payload: { ...current.payload, requestId: 'not-submitted' } }))
  const connect = async (...args) => {
    const socket = await f.connect(...args)
    return { close: socket.close, request: (type, payload) => {
      if (type === 'enrollment.challenge' && payload.purpose === 'status') return Promise.reject(Object.assign(new Error('synthetic absent proof'), { code: 'JOIN_NOT_FOUND' }))
      return socket.request(type, payload)
    } }
  }
  const onboarding = new CommunicationOnboarding(f.rt, { connect })
  const state = await onboarding.handle('join', joinInput, human)
  assert.equal(state.status, 'pending')
  assert.notEqual(state.requestId, 'not-submitted')
  assert.equal(f.records.get(f.key).payload.publicKey, publicKey)
})

test('existing pairing cannot be silently switched to a different Hub or instance', async () => {
  for (const communication of [{ hubId: 'other-hub' }, { url: 'wss://elsewhere.example/communication' }, { instanceId: 'existing-instance' }]) {
    const f = fixture({ current: { communication } })
    await assert.rejects(f.onboarding.handle('join', joinInput, human), { code: 'COMMUNICATION_PAIRING_CONFLICT' })
    assert.equal(f.saves, 0); assert.equal(f.sockets, 0)
  }
})

test('login authenticates with a freshly resolved bound record and never returns or sends its private key', async () => {
  const f = fixture({ responseStatus: 'approved' })
  await f.onboarding.handle('join', joinInput, human)
  const authenticate = communicationAuthentication(f.rt, f.key, { ...hub, instanceId: 'isolated-instance' })
  const socket = await f.connect()
  const welcome = await authenticate(socket.request, ['text', 'group-policy'])
  assert.deepEqual(welcome, { instanceId: 'isolated-instance', capabilities: ['text', 'group-policy'] })
  assert.equal(JSON.stringify(f.calls).includes('PRIVATE KEY'), false)
  await f.rt.ctx.credentials.modifyRecord(f.key, current => ({ ...current, payload: { ...current.payload, instanceId: 'changed-instance' } }))
  await assert.rejects(authenticate(socket.request, []), { code: 'COMMUNICATION_CREDENTIAL_MISMATCH' })
  socket.close()
})

test('paused signing credentials authenticate only for a scoped pending withdrawal and keep normal login paused', async () => {
  const f = fixture({ responseStatus: 'approved' })
  await f.onboarding.handle('join', joinInput, human)
  await f.rt.ctx.credentials.modifyRecord(f.key, current => ({...current,payload:{...current.payload,paused:true}}))
  const selected = {...hub,instanceId:'isolated-instance'}, socket = await f.connect()
  const ordinary = communicationAuthentication(f.rt,f.key,selected)
  const withdrawal = communicationAuthentication(f.rt,f.key,selected,{withdrawalOnly:true})
  const before = f.calls.length
  await assert.rejects(ordinary(socket.request,[]),{code:'HUB_PAUSED'})
  await assert.rejects(withdrawal(socket.request,[]),{code:'REMOTE_HUB_WITHDRAWAL_PENDING'})
  await assert.rejects(communicationSocket(f.rt,f.key,selected),{code:'HUB_PAUSED'})
  await assert.rejects(communicationSocket(f.rt,f.key,selected,{withdrawalOnly:true}),{code:'REMOTE_HUB_WITHDRAWAL_PENDING'})
  await assert.rejects(completeCommunicationWithdrawal(f.rt,f.key,selected),{code:'REMOTE_HUB_WITHDRAWAL_PENDING'})
  assert.equal(f.calls.length,before,'no challenge/proof without the pending same-Hub authority')
  f.rt.remoteHubCanWithdraw = candidate => candidate.hubId === selected.hubId && candidate.instanceId === selected.instanceId
  assert.equal((await withdrawal(socket.request,['text'])).instanceId,'isolated-instance')
  await f.rt.ctx.credentials.modifyRecord(f.key,current=>({...current,payload:{...current.payload,savedConfiguration:{...selected,publishedBotIds:['old']}}}))
  await completeCommunicationWithdrawal(f.rt,f.key,{...selected,publicationGenerations:{old:'retired'}})
  assert.deepEqual(f.records.get(f.key).payload.savedConfiguration.publishedBotIds,[])
  assert.equal(f.records.get(f.key).payload.savedConfiguration.publicationGenerations.old,'retired')
  f.rt.remoteHubCanWithdraw = () => false
  await assert.rejects(withdrawal(socket.request,[]),{code:'REMOTE_HUB_WITHDRAWAL_PENDING'})
  await assert.rejects(ordinary(socket.request,[]),{code:'HUB_PAUSED'})
  assert.equal(f.records.get(f.key).payload.paused,true,'cleanup does not resume the saved enrollment')
  socket.close()
})

test('a corrupted record or mismatched keypair fails without a proof', async () => {
  const f = fixture({ responseStatus: 'approved' })
  await f.onboarding.handle('join', joinInput, human)
  const pair = generateKeyPairSync('ed25519', { publicKeyEncoding: { type: 'spki', format: 'pem' }, privateKeyEncoding: { type: 'pkcs8', format: 'pem' } })
  await f.rt.ctx.credentials.modifyRecord(f.key, current => ({ ...current, payload: { ...current.payload, publicKey: pair.publicKey } }))
  const authenticate = communicationAuthentication(f.rt, f.key, { ...hub, instanceId: 'isolated-instance' })
  const socket = await f.connect(), proofs = f.calls.filter(call => call.type === 'enrollment.prove').length
  await assert.rejects(authenticate(socket.request, []), { code: 'COMMUNICATION_CREDENTIAL_MISMATCH' })
  assert.equal(f.calls.filter(call => call.type === 'enrollment.prove').length, proofs)
  socket.close()
})

test('contact enrollment derives the actual Human, uses published Bots by default and validates every explicit local Bot', async () => {
  const f = fixture(), calls = []
  f.rt.botOf = id => id === 'local-bot' ? { id } : undefined
  f.rt.communication = { human: { principalId: 'human:local:local-user' }, bots: new Map([['local-bot', { principalId: 'bot:local:local-bot' }]]),
    transport: { connected: true, welcome:{capabilities:['published-contact-scope','contact-consent-v2']}, request: async (type, payload) => { calls.push({ type, payload }); return { ok: true } } } }
  await f.onboarding.handle('contact-request', { operationId: 'request-op', userCode: 'synthetic-user-code' }, human)
  assert.deepEqual(calls.at(-1), { type: 'contact.request', payload: { principalId: 'human:local:local-user', operationId: 'request-op', userCode: 'synthetic-user-code', sharePublishedBots: true } })
  await f.onboarding.handle('contact-accept', { operationId: 'accept-op', requestId: 'request-id', expectedVersion: 1, localBotIds: ['local-bot', 'local-bot'] }, human)
  assert.deepEqual(calls.at(-1).payload.botPrincipalIds, ['bot:local:local-bot'])
  await f.onboarding.handle('contact-accept', { operationId: 'empty-local', requestId: 'request-id', expectedVersion: 1, localBotIds: [] }, human)
  assert.equal(calls.at(-1).payload.sharePublishedBots, true, 'empty local Bot IDs must follow published Bots rather than silently clear the contact scope')
  await f.onboarding.handle('contact-accept', { operationId: 'accept-empty', requestId: 'request-id', expectedVersion: 1, botPrincipalIds: ['bot:remote:other'] }, human)
  assert.equal(calls.at(-1).payload.sharePublishedBots, true, 'raw principal IDs cannot replace the published Bot policy')
  await assert.rejects(f.onboarding.handle('contact-accept', { operationId: 'bad', requestId: 'r', expectedVersion: 1, localBotIds: ['unknown'] }, human), { code: 'INVALID_BOT_SCOPE' })
  await assert.rejects(f.onboarding.handle('contact-request', { operationId: 'spoof', userCode: 'x', principalId: 'human:other:person' }, human), { code: 'AUTHOR_MISMATCH' })
  await assert.rejects(f.onboarding.handle('contact-reject', { operationId: 'reject', requestId: 'request-id' }, human), { code: 'INVALID_REQUEST' })
  for (const [action, type] of [['user-code', 'contact.code'], ['rotate-user-code', 'contact.code.rotate'], ['contact-requests', 'contact.requests'], ['contact-relations', 'contact.relations'],
    ['contact-reject', 'contact.reject'], ['contact-cancel', 'contact.cancel'], ['contact-revoke', 'contact.revoke']]) {
    await f.onboarding.handle(action, { operationId: 'mutation', requestId: 'request-id', expectedVersion: 1, otherHumanPrincipalId: 'human:other:local-user' }, human)
    assert.equal(calls.at(-1).type, type)
    assert.equal(calls.at(-1).payload.principalId, 'human:local:local-user')
  }
  assert.equal(f.saves, 0, 'contact operations never create device credentials')
  await f.onboarding.handle('contact-use-published-bots',{operationId:'repair',otherHumanPrincipalId:'human:other:local-user',expectedVersion:2},human)
  assert.equal(calls.at(-1).type,'contact.use-published-bots')
  f.rt.communication.transport.welcome.capabilities=[]
  const before=calls.length
  await assert.rejects(f.onboarding.handle('contact-request',{operationId:'old-hub',userCode:'synthetic-user-code'},human),{code:'CONTACT_CONSENT_UPGRADE_REQUIRED'})
  assert.equal(calls.length,before)
})

test('Human publication lists only local Bot metadata and updates the exact selection through the public configuration editor', async () => {
  const f = fixture({ current: { untouched: 'local', communication: { enabled: true, ...hub, instanceId: 'instance', credentialKey: 'reference',
    humanDisplayName: 'Person', publishedBotIds: ['bot-one'], pollMs: 555 } } })
  const one = { id: 'bot-one', name: 'One', role: 'Writer', instructions: 'private prompt', workDir: 'private path', avatar: { shape: 'circle', image: 'private image bytes' } }
  const two = { id: 'bot-two', name: 'Two', role: 'Reviewer', private: true, color: '#123456' }
  f.rt.state = { bots: { 'bot-one': one, 'bot-two': two } }
  f.rt.botOf = id => Object.hasOwn(f.rt.state.bots, id) ? f.rt.state.bots[id] : undefined
  const available = await f.onboarding.handle('available-bots', {}, human)
  assert.deepEqual(available, { bots: [{ id: 'bot-one', name: 'One', role: 'Writer', private: false, avatar: { shape: 'circle' } },
    { id: 'bot-two', name: 'Two', role: 'Reviewer', private: true, color: '#123456' }], publishedBotIds: ['bot-one'] })
  assert.equal(JSON.stringify(available).includes('private prompt'), false)
  assert.equal(JSON.stringify(available).includes('private image bytes'), false)
  const result = await f.onboarding.handle('publish-bots', { localBotIds: ['bot-two'] }, human)
  assert.deepEqual(result, { publishedBotIds: ['bot-two'], reloadRequired: true, reloadReason: 'publication', publicationStatus: 'saved-pending-reload' })
  assert.equal(f.configWrites.length, 1)
  assert.deepEqual(f.configWrites[0], { untouched: 'local', communication: { enabled: true, ...hub, instanceId: 'instance', credentialKey: 'reference',
    humanDisplayName: 'Person', publishedBotIds: ['bot-two'], pollMs: 555, publicationGenerations: { 'bot-one': f.configWrites[0].communication.publicationGenerations['bot-one'] } } })
  assert.match(f.configWrites[0].communication.publicationGenerations['bot-one'], /^[a-f0-9-]{36}$/)
  await f.onboarding.handle('publish-bots', { localBotIds: [] }, human)
  assert.deepEqual(f.configWrites.at(-1).communication.publishedBotIds, [])
  assert.equal(f.saves, 0, 'publishing never creates or changes device credentials')
  assert.equal(f.sockets, 0, 'the Loader and runtime own reconnection; publication does not create a side channel')
})

test('publication rejects unknown or duplicate local IDs, implicit empty selections and all non-Human actors', async () => {
  const f = fixture({ current: { communication: { ...hub, instanceId: 'instance' } } })
  f.rt.botOf = id => id === 'bot-one' ? { id } : undefined
  for (const ids of [undefined, null, ['unknown'], ['bot-one', 'bot-one'], ['human:remote:user'], [null]]) {
    await assert.rejects(f.onboarding.handle('publish-bots', { localBotIds: ids }, human), { code: 'INVALID_BOT_SCOPE' })
  }
  for (const action of ['available-bots', 'publish-bots']) {
    for (const authority of [undefined, { human: false }, { human: true, agent: { private: true } }]) {
      await assert.rejects(f.onboarding.handle(action, { localBotIds: ['bot-one'] }, authority), { code: 'HUMAN_REQUIRED' })
    }
  }
  assert.equal(f.configWrites.length, 0)
  f.rt.config.communication = {}
  await assert.rejects(f.onboarding.handle('publish-bots', { localBotIds: ['bot-one'] }, human), { code: 'COMMUNICATION_NOT_CONFIGURED' })
  assert.equal(f.configWrites.length, 0)
})

test('publication revalidates removed Bots and pairing changes at the serialized configuration commit', async () => {
  const f = fixture({ current: { communication: { ...hub, instanceId: 'instance' } } })
  let present = true
  f.rt.botOf = id => present && id === 'bot-one' ? { id } : undefined
  f.rt.ctx.configEditor.edit = async (_entry, change) => { present = false; change(f.rt.config) }
  await assert.rejects(f.onboarding.handle('publish-bots', { localBotIds: ['bot-one'] }, human), { code: 'INVALID_BOT_SCOPE' })
  present = true
  f.rt.ctx.configEditor.edit = async (_entry, change) => change({ communication: { ...hub, instanceId: 'different-instance' } })
  await assert.rejects(f.onboarding.handle('publish-bots', { localBotIds: ['bot-one'] }, human), { code: 'COMMUNICATION_PAIRING_CONFLICT' })
  assert.equal(f.configWrites.length, 0)
})

test('an existing legacy queue supplies its persisted instance identity without inserting or replacing it in configuration', async () => {
  const f = fixture({ current: { communication: { enabled: true, url: hub.url, credentialEnv: 'DSBOT_COMMUNICATION_TEST', pollMs: 700 } } })
  f.rt.communication = { queue: { instanceId: 'persisted-legacy-instance' } }
  f.rt.botOf = id => id === 'bot-one' ? { id } : undefined
  await f.onboarding.handle('publish-bots', { localBotIds: ['bot-one'] }, human)
  assert.deepEqual(f.configWrites[0].communication, { enabled: true, url: hub.url, credentialEnv: 'DSBOT_COMMUNICATION_TEST', pollMs: 700, publishedBotIds: ['bot-one'] })
  assert.equal(Object.hasOwn(f.configWrites[0].communication, 'instanceId'), false)
  f.rt.communication = undefined
  await assert.rejects(f.onboarding.handle('publish-bots', { localBotIds: ['bot-one'] }, human), { code: 'COMMUNICATION_NOT_CONFIGURED' })
})

test('real Cordis optional-service lookup enrolls and configures without undeclared direct credential or editor access', async () => {
  const f = fixture({ responseStatus: 'approved' }), root = new Context()
  const services = f.rt.ctx
  try {
    await root.plugin({ name: 'onboarding-test-services', apply(ctx) {
      ctx.provide('credentials', services.credentials)
      ctx.provide('configEditor', services.configEditor)
    } })
    let result
    await root.plugin({ name: 'onboarding-test-consumer', async apply(ctx) {
      assert.throws(() => ctx.credentials)
      assert.throws(() => ctx.configEditor)
      assert.ok(ctx.get('credentials'))
      f.rt.ctx = ctx
      result = await new CommunicationOnboarding(f.rt, { connect: f.connect }).handle('join', joinInput, human)
    } })
    assert.equal(result.status, 'approved')
    assert.equal(f.configWrites.length, 1)
    assert.equal(f.records.get(f.key).payload.status, 'approved')
  } finally { await root.fiber.dispose() }
})

test('unknown SDK failures retain their cause internally but expose only fixed phase codes', async () => {
  for (const [method, code] of [['readRecord', 'COMMUNICATION_CREDENTIAL_READ_FAILED'], ['describeRecord', 'COMMUNICATION_CREDENTIAL_DESCRIBE_FAILED'], ['modifyRecord', 'COMMUNICATION_CREDENTIAL_WRITE_FAILED']]) {
    const f = fixture(), cause = new TypeError('synthetic private diagnostic marker')
    f.rt.ctx.credentials[method] = async () => { throw cause }
    await assert.rejects(f.onboarding.handle('join', joinInput, human), error => error.code === code && error.message === code && error.cause === cause)
  }
  const f = fixture({ responseStatus: 'approved' }), cause = new TypeError('synthetic private editor marker')
  f.rt.ctx.configEditor.edit = async () => { throw cause }
  await assert.rejects(f.onboarding.handle('join', joinInput, human), error => error.code === 'COMMUNICATION_CONFIG_WRITE_FAILED'
    && error.message === error.code && error.cause === cause)
})

test('known public config-editor guards have fixed diagnostic codes without exposing raw entry names or values', async () => {
  for (const [message, code] of [
    ['Configuration for "synthetic-sensitive-entry" is overridden by a home patch or command-line overlay', 'CONFIG_EDIT_OVERLAID'],
    ['Configuration entry is no longer available', 'CONFIG_EDIT_ENTRY_CHANGED'],
    ['Configuration entry changed during reload', 'CONFIG_EDIT_ENTRY_CHANGED'],
    ['Configuration plugin is no longer active', 'CONFIG_EDIT_NOT_ACTIVE'],
    ['Profile patch must be a YAML sequence', 'CONFIG_EDIT_INVALID_DOCUMENT'],
    ['Unrecognized editor diagnostic with a synthetic private marker', 'COMMUNICATION_CONFIG_WRITE_FAILED'],
  ]) {
    const f = fixture({ responseStatus: 'approved' }), cause = new Error(message)
    f.rt.ctx.configEditor.edit = async () => { throw cause }
    await assert.rejects(f.onboarding.handle('join', joinInput, human), error => error.code === code && error.message === code && error.cause === cause)
    assert.equal(f.configWrites.length, 0)
  }
})


test('local memory settings default on, require the local Human and preserve other configuration', async () => {
  const f = fixture({ current: { untouched: 'local', communication: { enabled: true, ...hub, instanceId: 'instance', credentialKey: 'reference' } } })
  assert.deepEqual(await f.onboarding.handle('memory-settings', {}, human), { localMemory: true })
  await assert.rejects(f.onboarding.handle('set-memory-settings', { localMemory: false }, { human: true, agent: {} }), { code: 'HUMAN_REQUIRED' })
  await assert.rejects(f.onboarding.handle('set-memory-settings', { localMemory: 'false' }, human), { code: 'INVALID_CONFIG' })
  assert.deepEqual(await f.onboarding.handle('set-memory-settings', { localMemory: false }, human), { localMemory: false, reloadRequired: true })
  assert.equal(f.configWrites.at(-1).communication.localMemory, false)
  assert.equal(f.configWrites.at(-1).communication.credentialKey, 'reference')
  assert.equal(f.configWrites.at(-1).untouched, 'local')
  assert.equal(f.sockets, 0)
})

test('offline withdrawal and re-publication retain a changed generation even when the Loader coalesces edits',async()=>{
  const f=fixture({current:{communication:{...hub,instanceId:'instance',publishedBotIds:['worker']}}})
  f.rt.state={bots:{worker:{id:'worker',name:'Worker'}}};f.rt.botOf=id=>f.rt.state.bots[id]
  await f.onboarding.handle('publish-bots',{localBotIds:['worker']},human)
  assert.equal(f.rt.config.communication.publicationGenerations,undefined)
  await f.onboarding.handle('publish-bots',{localBotIds:[]},human)
  const generation=f.rt.config.communication.publicationGenerations.worker
  await f.onboarding.handle('publish-bots',{localBotIds:['worker']},human)
  assert.equal(f.rt.config.communication.publicationGenerations.worker,generation)
  await f.onboarding.handle('publish-bots',{localBotIds:[]},human)
  assert.notEqual(f.rt.config.communication.publicationGenerations.worker,generation)
})

test('remote confirmation is an explicit local-owner setting and does not change Bot sandbox permissions',async()=>{
 const f=fixture({current:{communication:{...hub,instanceId:'instance'}}})
 assert.deepEqual(await f.onboarding.handle('work-approval-settings',{},human),{remoteWorkApproval:'inherit'})
 await assert.rejects(f.onboarding.handle('set-work-approval',{remoteWorkApproval:'ask'},{human:false}),{code:'HUMAN_REQUIRED'})
 await assert.rejects(f.onboarding.handle('set-work-approval',{remoteWorkApproval:'allow-all'},human),{code:'INVALID_CONFIG'})
 assert.deepEqual(await f.onboarding.handle('set-work-approval',{remoteWorkApproval:'ask'},human),{remoteWorkApproval:'ask',reloadRequired:true})
 assert.equal(f.rt.config.communication.remoteWorkApproval,'ask')
 assert.equal(f.configWrites.length,1)
 await f.onboarding.handle('set-work-approval',{remoteWorkApproval:'inherit'},human)
 assert.equal(f.rt.config.communication.remoteWorkApproval,'inherit')
})

test('approved first enrollment promotes the local setup opt-in to an explicit profile flag without reviving it after a later disable', async () => {
 const f = fixture({current:{remoteHubEnabled:false},responseStatus:'approved'})
 f.rt.state = {prefs:{remoteHubSetupEnabled:true}}
 await f.onboarding.handle('join', joinInput, human)
 assert.equal(f.rt.config.remoteHubEnabled, true)
 assert.equal(f.rt.config.remoteHubProfileManaged, true)
 f.rt.config.remoteHubEnabled = false
 assert.equal(f.rt.config.communication.enabled, true)
 const {RemoteHubController} = await import('../src/host/federation/remote-hub.js')
 const controller = new RemoteHubController(f.rt)
 assert.equal(controller.status().enabled, false)
 delete f.rt.config.communication
 assert.equal(controller.status().enabled, false, 'removing Hub data must not revive a stale setup preference')
 await controller.close()
})

test('late first approval is serialized behind a pending local disable and cannot turn the feature back on', async () => {
 const f = fixture({responseStatus:'approved'})
 f.rt.state = {prefs:{remoteHubSetupEnabled:true}}
 f.rt.load = async () => {}; f.rt.refresh = async () => {}
 let release
 f.rt.save = () => new Promise(resolve => { release = resolve })
 const {RemoteHubController} = await import('../src/host/federation/remote-hub.js')
 const controller = new RemoteHubController(f.rt)
 f.rt.serializeRemoteHubSetup = work => controller.exclusive(work)
 const disabling = controller.set({enabled:false,expectedVersion:controller.status().version,confirmHideAllBots:true})
 while (!release) await new Promise(resolve => setTimeout(resolve, 1))
 const approval = f.onboarding.configure(hub, 'isolated-instance', f.key, 'Device')
 await new Promise(resolve => setTimeout(resolve, 5))
 assert.equal(f.configWrites.length, 0)
 release()
 assert.equal((await disabling).enabled, false)
 await approval
 assert.equal(f.rt.config.remoteHubEnabled, false)
 assert.equal(controller.status().enabled, false)
 await controller.close()
})

test('a stale setup opt-out cannot disable a configured Hub when the owner explicitly resumes it', async () => {
 const f = fixture({current:{remoteHubEnabled:true,communication:{...hub,enabled:false,instanceId:'isolated-instance'}}})
 f.rt.state = {prefs:{remoteHubSetupEnabled:false}}
 await f.onboarding.configure(hub, 'isolated-instance', f.key, 'Device')
 assert.equal(f.rt.config.remoteHubEnabled, true)
 assert.equal(f.rt.config.communication.enabled, true)
})

test('cancellation treats a confirmed missing request as settled, while network errors remain uncertain',async()=>{
 for(const code of ['JOIN_NOT_FOUND','CONNECTION_LOST']){
  const f=fixture();await f.onboarding.handle('join',joinInput,human)
  const original=f.records.get(f.key).payload.publicKey
  const api=new CommunicationOnboarding(f.rt,{connect:async()=>({close(){},request:async()=>{throw Object.assign(Error(code),{code})}})})
  if(code==='JOIN_NOT_FOUND'){
   const result=await api.handle('cancel',{hubId:hub.hubId},human)
   assert.equal(result.status,'cancelled');assert.equal(result.remoteMissing,'request')
  }else{
   await assert.rejects(api.handle('cancel',{hubId:hub.hubId},human),{code})
   assert.equal(f.records.get(f.key).payload.status,'pending')
  }
  assert.equal(f.records.get(f.key).payload.publicKey,original)
 }
})

test('lost approval and administrator deletion recover against the real Hub store after a client restart',async t=>{
 const {HubStore}=await import('../../communication-hub/src/store.js')
 const {HubManagement}=await import('../../communication-hub/src/management-store.js')
 for(const deleted of [false,true]){
  const store=new HubStore(':memory:');t.after(()=>store.close())
  const m=new HubManagement(store);m.hubId=hub.hubId
  const f=fixture();f.rt.ctx.credentials.deleteRecord=async key=>f.records.delete(key)
  let loseReply=true,approved,joinCalls=0
  const connect=async()=>{
   const socket={};let purpose
   return {close:()=>m.forget(socket),request:async(type,input)=>{
    if(type==='enrollment.challenge'){purpose=input.purpose;return m.challenge(socket,input)}
    const result=m.prove(socket,input)
    if(purpose==='join'){
     joinCalls++;approved=m.decide({requestId:result.requestId,expectedVersion:1,action:'approve'})
     if(loseReply){loseReply=false;throw Object.assign(Error('simulated lost approval reply'),{code:'CONNECTION_LOST'})}
    }
    return result
   }}
  }
  const first=new CommunicationOnboarding(f.rt,{connect})
  await assert.rejects(first.handle('join',joinInput,human),{code:'CONNECTION_LOST'})
  assert.equal(f.records.get(f.key).payload.status,'prepared')
  if(deleted){
   const instance=m.instances().find(i=>i.instanceId===approved.instanceId)
   m.delete({instanceId:instance.instanceId,expectedPairingRevision:instance.pairingRevision,expectedNameVersion:instance.nameVersion,ownedSharedGroups:[],confirmDelete:true})
  }
  const restarted=new CommunicationOnboarding(f.rt,{connect})
  if(deleted){
   await assert.rejects(restarted.handle('reconcile-enrollment',{},human),{code:'JOIN_NOT_FOUND'})
   const status=(await restarted.handle('storage',{},human)).enrollments[0]
   const cleanup={hubId:hub.hubId,confirmedUrl:hub.url,force:true,confirmForget:true,deleteLocalHistory:false,expectedIdentity:status.identityFingerprint}
   assert.equal((await restarted.handle('forget-hub',cleanup,human)).forgotten,true)
   assert.equal((await restarted.handle('forget-hub',cleanup,human)).alreadyForgotten,true)
   assert.equal(f.records.size,0)
  }else{
   assert.equal((await restarted.handle('reconcile-enrollment',{},human)).status,'approved')
   assert.equal(f.rt.config.communication.instanceId,approved.instanceId)
   assert.equal(f.rt.config.communication.enabled,true)
  }
  assert.equal(joinCalls,1,'status recovery never duplicates the application')
 }
})
