import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, sign, randomUUID } from 'node:crypto'
import { lookup } from 'node:dns/promises'
import { BlockList, isIP } from 'node:net'
import { credentialKey, parseCredentialKey } from '@deepseek-ai/dsh-credentials'

const PROTOCOL = 'dsbot-communication/1'
const RECORD_TYPE = 'dsbot-communication-signing-key'
const PREFIX = 'dsbot-hub:1:'
const MAX_CHALLENGE_MS = 65000
const statuses = new Set(['pending', 'approved', 'rejected', 'cancelled', 'expired'])
const fail = code => { throw Object.assign(new Error(code), { code }) }
const configFailureCode = cause => {
  const message = typeof cause?.message === 'string' ? cause.message : ''
  if (/^Configuration for "[^"\r\n]+" is overridden by a home patch or command-line overlay$/.test(message)) return 'CONFIG_EDIT_OVERLAID'
  if (['Configuration entry is no longer available', 'Configuration entry changed during reload'].includes(message)) return 'CONFIG_EDIT_ENTRY_CHANGED'
  if (message === 'Configuration plugin is no longer active') return 'CONFIG_EDIT_NOT_ACTIVE'
  if (message === 'Profile patch must be a YAML sequence') return 'CONFIG_EDIT_INVALID_DOCUMENT'
  return 'COMMUNICATION_CONFIG_WRITE_FAILED'
}
const phase = async (code, work) => {
  try { return await work() }
  catch (cause) {
    if (code === 'COMMUNICATION_CONFIG_WRITE_FAILED') code = configFailureCode(cause)
    const failureCode = typeof cause?.code === 'string' ? cause.code : code
    throw Object.assign(new Error(failureCode, { cause }), { code: failureCode, phase: code })
  }
}
const serviceOf = (ctx, name, code) => {
  try { return typeof ctx.get === 'function' ? ctx.get(name) : ctx[name] }
  catch (cause) { throw Object.assign(new Error(code, { cause }), { code }) }
}
const identifier = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value)
const forbiddenV4 = new BlockList(), forbiddenV6 = new BlockList()
for (const [address, prefix] of [['0.0.0.0', 8], ['100.100.100.200', 32], ['127.0.0.0', 8], ['169.254.0.0', 16], ['224.0.0.0', 4], ['240.0.0.0', 4]]) forbiddenV4.addSubnet(address, prefix, 'ipv4')
for (const [address, prefix] of [['::', 128], ['::1', 128], ['::ffff:0:0', 96], ['fe80::', 10], ['fec0::', 10], ['ff00::', 8], ['2001::', 32], ['2002::', 16]]) forbiddenV6.addSubnet(address, prefix, 'ipv6')
const loopback = host => ['127.0.0.1', '::1'].includes(host)

export function validateHubUrl(value, { allowLoopback = false } = {}) {
  if (typeof value !== 'string' || value.length > 2048) fail('INVALID_HUB_CODE')
  let url
  try { url = new URL(value) } catch { fail('INVALID_HUB_CODE') }
  const host = url.hostname.replace(/^\[|\]$/g, '')
  if (url.username || url.password || url.search || url.hash || url.pathname !== '/communication'
    || !host || host.endsWith('.') || /[%\\]/.test(host)) fail('INVALID_HUB_CODE')
  if (url.protocol !== 'wss:' && !(allowLoopback && url.protocol === 'ws:' && loopback(host))) fail('TLS_REQUIRED')
  if (!allowLoopback && (loopback(host) || host.toLowerCase() === 'localhost' || host.toLowerCase().endsWith('.localhost'))) fail('HUB_ADDRESS_FORBIDDEN')
  if (isIP(host) && !permittedAddress(host, allowLoopback)) fail('HUB_ADDRESS_FORBIDDEN')
  return url.href
}

function permittedAddress(address, allowLoopback) {
  if (allowLoopback && loopback(address)) return true
  const family = isIP(address)
  return family === 4 ? !forbiddenV4.check(address, 'ipv4') : family === 6 && !forbiddenV6.check(address, 'ipv6')
}

export function decodeHubCode(code, options) {
  if (typeof code !== 'string' || code.length > 4096 || !code.startsWith(PREFIX)) fail('INVALID_HUB_CODE')
  const encoded = code.slice(PREFIX.length)
  if (!/^[A-Za-z0-9_-]+$/.test(encoded)) fail('INVALID_HUB_CODE')
  let body
  try {
    const bytes = Buffer.from(encoded, 'base64url')
    if (bytes.toString('base64url') !== encoded) fail('INVALID_HUB_CODE')
    body = JSON.parse(bytes.toString('utf8'))
  } catch { fail('INVALID_HUB_CODE') }
  if (!body || Array.isArray(body) || Object.keys(body).sort().join(',') !== 'hubId,url' || !identifier(body.hubId)) fail('INVALID_HUB_CODE')
  return { version: 1, hubId: body.hubId, url: validateHubUrl(body.url, options) }
}

export const communicationCredentialKey = hubId => {
  if (!identifier(hubId)) fail('INVALID_HUB_CODE')
  return credentialKey('ds-bot', `communication-${createHash('sha256').update(hubId).digest('hex').slice(0, 32)}`)
}

const credentialsOf = ctx => {
  // Optional services use the public lookup. Reading ctx.credentials first
  // throws in a real Cordis consumer that did not declare a required injection.
  const credentials = serviceOf(ctx, 'credentials', 'CREDENTIAL_STORAGE_UNAVAILABLE')
  if (!credentials?.readRecord || !credentials?.modifyRecord || !credentials?.describeRecord) fail('CREDENTIAL_STORAGE_UNAVAILABLE')
  return {
    readRecord: key => phase('COMMUNICATION_CREDENTIAL_READ_FAILED', () => credentials.readRecord(key)),
    describeRecord: key => phase('COMMUNICATION_CREDENTIAL_DESCRIBE_FAILED', () => credentials.describeRecord(key)),
    modifyRecord: (key, mutate) => phase('COMMUNICATION_CREDENTIAL_WRITE_FAILED', () => credentials.modifyRecord(key, mutate)),
    listRecords: typeof credentials.listRecords === 'function' ? () => phase('COMMUNICATION_CREDENTIAL_LIST_FAILED', () => credentials.listRecords()) : undefined,
  }
}
const contextOf = value => value.ctx ?? value
function checkedRecord(record, hub, { instanceId } = {}) {
  const value = record?.kind === 'grant' && record.payload
  if (!value || value.type !== RECORD_TYPE || value.version !== 1 || value.hubId !== hub.hubId || value.url !== hub.url
    || typeof value.publicKey !== 'string' || typeof value.privateKey !== 'string'
    || instanceId !== undefined && value.instanceId !== instanceId) fail('COMMUNICATION_CREDENTIAL_MISMATCH')
  return value
}
function checkChallenge(challenge, expected, now = Date.now()) {
  if (!challenge || challenge.hubId !== expected.hubId || challenge.purpose !== expected.purpose
    || !identifier(challenge.challengeId) || typeof challenge.nonce !== 'string' || !/^[A-Za-z0-9_-]{16,256}$/.test(challenge.nonce)
    || !Number.isSafeInteger(challenge.expiresAt) || challenge.expiresAt <= now || challenge.expiresAt > now + MAX_CHALLENGE_MS
    || expected.requestId !== undefined && challenge.requestId !== expected.requestId
    || expected.instanceId !== undefined && challenge.instanceId !== expected.instanceId
    || expected.purpose === 'join' && !identifier(challenge.requestId)) fail('INVALID_ENROLLMENT_CHALLENGE')
  return challenge
}
export const enrollmentSigningText = challenge => JSON.stringify(['dsbot-enrollment/1', challenge.hubId, challenge.purpose,
  challenge.challengeId, challenge.nonce, challenge.requestId ?? '', challenge.instanceId ?? '', challenge.expiresAt])

function signature(record, challenge) {
  try {
    const privateKey = createPrivateKey(record.privateKey)
    if (privateKey.asymmetricKeyType !== 'ed25519' || createPublicKey(privateKey).export({ type: 'spki', format: 'pem' }) !== record.publicKey) fail('COMMUNICATION_CREDENTIAL_MISMATCH')
    return sign(null, Buffer.from(enrollmentSigningText(challenge)), privateKey).toString('base64url')
  } catch { fail('COMMUNICATION_CREDENTIAL_MISMATCH') }
}

export function communicationAuthentication(rtOrCtx, key, hub) {
  const ctx = contextOf(rtOrCtx)
  if (key !== communicationCredentialKey(hub.hubId)) fail('COMMUNICATION_CREDENTIAL_MISMATCH')
  return async (send, capabilities) => {
    const record = checkedRecord(await credentialsOf(ctx).readRecord(parseCredentialKey(key)), hub, { instanceId: hub.instanceId })
    if (record.status !== 'approved' || !identifier(hub.instanceId)) fail('COMMUNICATION_NOT_APPROVED')
    const challenge = checkChallenge(await send('enrollment.challenge', { purpose: 'login', instanceId: hub.instanceId, publicKey: record.publicKey }),
      { hubId: hub.hubId, purpose: 'login', instanceId: hub.instanceId })
    return send('enrollment.prove', { challengeId: challenge.challengeId, signature: signature(record, challenge), capabilities })
  }
}

// The DNS result used for the handshake is checked once and pinned. TLS still
// verifies the original hostname; redirects and proxy environment discovery are disabled.
export async function connectHubSocket(url, { allowLoopback = false, resolve = lookup, timeoutMs = 15000, socketClass } = {}) {
  url = validateHubUrl(url, { allowLoopback })
  const host = new URL(url).hostname.replace(/^\[|\]$/g, '')
  let addresses
  let dnsTimer
  try { addresses = isIP(host) ? [{ address: host, family: isIP(host) }] : await Promise.race([
    resolve(host, { all: true, verbatim: true }),
    new Promise((_, reject) => { dnsTimer = setTimeout(() => reject(new Error('HUB_UNREACHABLE')), timeoutMs) }),
  ]) }
  catch { fail('HUB_UNREACHABLE') }
  finally { clearTimeout(dnsTimer) }
  if (!Array.isArray(addresses) || !addresses.length || addresses.some(item => !permittedAddress(item.address, allowLoopback) || item.family !== isIP(item.address))) fail('HUB_ADDRESS_FORBIDDEN')
  addresses = addresses.map(item => ({ address: item.address, family: item.family }))
  const WebSocket = socketClass ?? (await import('ws')).default
  const socket = new WebSocket(url, { followRedirects: false, rejectUnauthorized: true, minVersion: 'TLSv1.2', perMessageDeflate: false,
    maxPayload: 131072, handshakeTimeout: timeoutMs,
    lookup: (_hostname, options, callback) => {
      const chosen = options.family ? addresses.filter(item => item.family === options.family) : addresses
      if (!chosen.length) return callback(Object.assign(new Error('HUB_UNREACHABLE'), { code: 'HUB_UNREACHABLE' }))
      return options.all ? callback(null, chosen) : callback(null, chosen[0].address, chosen[0].family)
    } })
  socket.on('error', () => {})
  await new Promise((resolveOpen, reject) => {
    let settled = false
    const finish = (ok, code = 'HUB_UNREACHABLE') => {
      if (settled) return
      settled = true; clearTimeout(timer)
      socket.off('error', failure); socket.off('close', failure); socket.off('open', success)
      if (ok) resolveOpen()
      else { socket.terminate(); reject(Object.assign(new Error(code), { code })) }
    }
    const failure = error => finish(false, ({
      DEPTH_ZERO_SELF_SIGNED_CERT: 'HUB_TLS_UNTRUSTED', SELF_SIGNED_CERT_IN_CHAIN: 'HUB_TLS_UNTRUSTED',
      UNABLE_TO_VERIFY_LEAF_SIGNATURE: 'HUB_TLS_UNTRUSTED', UNABLE_TO_GET_ISSUER_CERT_LOCALLY: 'HUB_TLS_UNTRUSTED',
      CERT_HAS_EXPIRED: 'HUB_TLS_CERT_EXPIRED', CERT_NOT_YET_VALID: 'HUB_TLS_CERT_TIME_INVALID',
      ERR_TLS_CERT_ALTNAME_INVALID: 'HUB_TLS_HOSTNAME_MISMATCH', ECONNREFUSED: 'HUB_CONNECTION_REFUSED', ETIMEDOUT: 'HUB_CONNECTION_TIMEOUT',
    })[error?.code] ?? 'HUB_UNREACHABLE')
    const success = () => finish(true), timer = setTimeout(() => finish(false, 'HUB_CONNECTION_TIMEOUT'), timeoutMs)
    socket.once('error', failure); socket.once('close', failure); socket.once('open', success)
  })
  return socket
}

export async function openEnrollmentSocket(url, options = {}) {
  const socket = await connectHubSocket(url, options), timeoutMs = options.timeoutMs ?? 15000
  const pending = new Map()
  const close = () => { for (const call of pending.values()) { clearTimeout(call.timer); call.reject(Object.assign(new Error('CONNECTION_LOST'), { code: 'CONNECTION_LOST' })) }; pending.clear(); socket.close() }
  socket.on('close', close)
  socket.on('message', (data, binary) => {
    let response
    try { if (binary) return close(); response = JSON.parse(data.toString('utf8')) } catch { return close() }
    const call = pending.get(response?.id)
    if (!call) return
    clearTimeout(call.timer); pending.delete(response.id)
    if (response.ok === true) call.resolve(response.value)
    else call.reject(Object.assign(new Error('ENROLLMENT_REQUEST_FAILED'), { code: /^[A-Z][A-Z0-9_]{0,63}$/.test(response.error?.code ?? '') ? response.error.code : 'INVALID_RESPONSE' }))
  })
  return { close, request(type, payload) {
    if (socket.readyState !== 1) return Promise.reject(Object.assign(new Error('CONNECTION_LOST'), { code: 'CONNECTION_LOST' }))
    const id = randomUUID()
    return new Promise((resolveRequest, reject) => {
      const timer = setTimeout(() => { pending.delete(id); reject(Object.assign(new Error('REQUEST_TIMEOUT'), { code: 'REQUEST_TIMEOUT' })); socket.close() }, timeoutMs)
      pending.set(id, { resolve: resolveRequest, reject, timer })
      try { socket.send(JSON.stringify({ protocol: PROTOCOL, id, type, payload })) }
      catch { clearTimeout(timer); pending.delete(id); reject(Object.assign(new Error('CONNECTION_LOST'), { code: 'CONNECTION_LOST' })) }
    })
  } }
}

export const communicationStorageStatus = Object.freeze({ kind: 'dsh-credential-record', defaultProvider: 'owner-acl-plaintext',
  encryptedByDefault: false, agentIsolation: false, explanation: 'The default DSH provider stores plaintext protected by your OS account permissions. Tools running as the same OS user can read it. Other providers may offer different protection.' })
const safeStatus = record => ({ hubId: record.hubId, url: record.url, requestId: record.requestId ?? null,
  instanceId: record.instanceId ?? null, status: record.status, displayName: record.displayName, credentialKey: communicationCredentialKey(record.hubId), storage: communicationStorageStatus })
const operation = value => { if (!identifier(value)) fail('OPERATION_ID_REQUIRED'); return value }
const version = value => { if (!Number.isSafeInteger(value) || value < 1) fail('INVALID_REQUEST'); return value }

export class CommunicationOnboarding {
  constructor(rt, { allowLoopback = false, connect = openEnrollmentSocket } = {}) {
    this.rt = rt
    this.ctx = rt.ctx
    this.allowLoopback = allowLoopback
    this.connect = connect
    this.tail = Promise.resolve()
  }
  handle(action, input = {}, authority) {
    if (authority?.human !== true || authority?.agent || !input || typeof input !== 'object' || Array.isArray(input)) return Promise.reject(Object.assign(new Error('HUMAN_REQUIRED'), { code: 'HUMAN_REQUIRED' }))
    if (['principalId', 'sender', 'author', 'privateKey', 'publicKey', 'credentialKey', 'allowLoopback'].some(key => Object.hasOwn(input, key))) return Promise.reject(Object.assign(new Error('AUTHOR_MISMATCH'), { code: 'AUTHOR_MISMATCH' }))
    const next = this.tail.catch(() => {}).then(() => this.dispatch(action, input))
    this.tail = next
    return next
  }
  async dispatch(action, input) {
    if (action === 'decode-hub-code') return decodeHubCode(input.hubCode, { allowLoopback: this.allowLoopback })
    if (action === 'join') return this.join(input)
    if (action === 'status' || action === 'cancel') return this.enrollment(action, input)
    if (action === 'storage') return this.storage(input)
    if (action === 'available-bots') return this.availableBots()
    if (action === 'publish-bots') return this.publishBots(input)
    return this.contact(action, input)
  }
  availableBots() {
    const bots = Object.values(this.rt.state?.bots ?? {}).filter(bot => bot && this.rt.botOf(bot.id) === bot).map(bot => ({
      id: bot.id, name: bot.name, role: bot.role ?? '', private: bot.private === true,
      ...(typeof bot.color === 'string' ? { color: bot.color } : {}),
      ...(typeof bot.avatar?.shape === 'string' ? { avatar: { shape: bot.avatar.shape } } : {}),
    }))
    const owned = new Set(bots.map(bot => bot.id))
    return { bots, publishedBotIds: (this.rt.config.communication?.publishedBotIds ?? []).filter(id => owned.has(id)) }
  }
  checkedBotIds(ids) {
    if (!Array.isArray(ids) || ids.length > 100 || new Set(ids).size !== ids.length
      || ids.some(id => !identifier(id) || !this.rt.botOf(id))) fail('INVALID_BOT_SCOPE')
    return [...ids]
  }
  // Public configuration edits use the normal Loader reload. The runtime then
  // reconciles publication with the Hub; no Bot identity or history is replaced.
  async publishBots(input) {
    const ids = this.checkedBotIds(input.localBotIds), configured = this.rt.config.communication
    const instanceId = configured?.instanceId ?? this.rt.communication?.queue?.instanceId
    if (!configured?.url || !instanceId) fail('COMMUNICATION_NOT_CONFIGURED')
    const editor = serviceOf(this.ctx, 'configEditor', 'CONFIG_EDITOR_UNAVAILABLE')
    if (!editor?.entries || !editor?.edit) fail('CONFIG_EDITOR_UNAVAILABLE')
    const entries = editor.entries().filter(entry => entry.options?.name === 'ds-bot')
    if (entries.length !== 1) fail('CONFIG_ENTRY_UNAVAILABLE')
    await phase('COMMUNICATION_CONFIG_WRITE_FAILED', () => editor.edit(entries[0], current => {
      const latest = current.communication
      if (!latest?.url || !(latest.instanceId ?? this.rt.communication?.queue?.instanceId)) fail('COMMUNICATION_NOT_CONFIGURED')
      if (['url', 'instanceId', 'hubId', 'credentialKey', 'credentialEnv'].some(name => latest[name] !== configured[name])) fail('COMMUNICATION_PAIRING_CONFLICT')
      if (!latest.instanceId && this.rt.communication?.queue?.instanceId !== instanceId) fail('COMMUNICATION_PAIRING_CONFLICT')
      const publishedBotIds = this.checkedBotIds(ids)
      return { ...current, communication: { ...latest, publishedBotIds } }
    }))
    return { publishedBotIds: ids, reloadRequired: true }
  }
  async storage(input) {
    const hubId = input.hubId ?? this.rt.config.communication?.hubId
    if (!hubId) {
      const credentials = credentialsOf(this.ctx), enrollments = []
      if (credentials.listRecords) for (const entry of await credentials.listRecords()) {
        if (entry.kind !== 'grant' || !/^ds-bot\/communication-[a-f0-9]{32}$/.test(entry.key)) continue
        const record = await credentials.readRecord(entry.key), value = record?.payload
        if (record?.kind !== 'grant' || value?.type !== RECORD_TYPE || !identifier(value.hubId) || communicationCredentialKey(value.hubId) !== entry.key) continue
        enrollments.push(safeStatus(value))
      }
      return { configured: enrollments.length > 0, storage: communicationStorageStatus, enrollments }
    }
    const key = communicationCredentialKey(hubId), credentials = credentialsOf(this.ctx)
    const info = await credentials.describeRecord(key)
    if (!info.configured) return { configured: false, writable: info.writable, storage: communicationStorageStatus }
    const record = await credentials.readRecord(key)
    if (record?.kind !== 'grant' || record.payload?.type !== RECORD_TYPE || record.payload.hubId !== hubId) fail('COMMUNICATION_CREDENTIAL_MISMATCH')
    return { configured: true, writable: info.writable, ...safeStatus(record.payload) }
  }
  conflict(hub, instanceId, current = this.rt.config) {
    const old = current.communication ?? {}
    if (old.url && old.url !== hub.url || old.hubId && old.hubId !== hub.hubId || old.instanceId && old.instanceId !== instanceId) fail('COMMUNICATION_PAIRING_CONFLICT')
  }
  async join(input) {
    const hub = decodeHubCode(input.hubCode, { allowLoopback: this.allowLoopback })
    if (input.confirmedHubId !== hub.hubId || input.confirmedUrl !== hub.url) fail('HUB_CONFIRMATION_REQUIRED')
    if (typeof input.displayName !== 'string' || !input.displayName.trim() || input.displayName.length > 100) fail('INVALID_REQUEST')
    const key = communicationCredentialKey(hub.hubId), credentials = credentialsOf(this.ctx)
    const existing = await credentials.readRecord(key)
    const previous = existing ? checkedRecord(existing, hub) : null
    this.conflict(hub, previous?.instanceId)
    if (previous?.requestId && !['rejected', 'cancelled', 'expired'].includes(previous.status)) {
      try { return await this.enrollment('status', { hubId: hub.hubId }) }
      catch (error) { if (error.code !== 'JOIN_NOT_FOUND') throw error }
    }
    const info = await credentials.describeRecord(key)
    if (!info.writable) fail('CREDENTIAL_STORAGE_READ_ONLY')
    await credentials.modifyRecord(key, current => {
      if (current) { checkedRecord(current, hub); return undefined }
      const pair = generateKeyPairSync('ed25519', { publicKeyEncoding: { type: 'spki', format: 'pem' }, privateKeyEncoding: { type: 'pkcs8', format: 'pem' } })
      return { kind: 'grant', payload: { type: RECORD_TYPE, version: 1, hubId: hub.hubId, url: hub.url,
        publicKey: pair.publicKey, privateKey: pair.privateKey, displayName: input.displayName.trim(), status: 'prepared', createdAt: Date.now() } }
    })
    const record = checkedRecord(await credentials.readRecord(key), hub)
    const socket = await phase('ENROLLMENT_CONNECT_FAILED', () => this.connect(hub.url, { allowLoopback: this.allowLoopback }))
    try {
      const challenge = checkChallenge(await phase('ENROLLMENT_CHALLENGE_FAILED', () => socket.request('enrollment.challenge', { purpose: 'join', publicKey: record.publicKey })), { hubId: hub.hubId, purpose: 'join' })
      await this.update(key, hub, value => ({ ...value, requestId: challenge.requestId, status: 'prepared' }))
      const result = await phase('ENROLLMENT_PROOF_FAILED', () => socket.request('enrollment.prove', { challengeId: challenge.challengeId, signature: signature(record, challenge), displayName: input.displayName.trim() }))
      return this.result(key, hub, challenge.requestId, result)
    } finally { socket.close() }
  }
  async enrollment(purpose, input) {
    const hubId = input.hubId ?? this.rt.config.communication?.hubId
    const key = communicationCredentialKey(hubId), credentials = credentialsOf(this.ctx)
    const stored = await credentials.readRecord(key)
    const hub = { hubId, url: stored?.payload?.url }
    validateHubUrl(hub.url, { allowLoopback: this.allowLoopback })
    const record = checkedRecord(stored, hub)
    if (!identifier(record.requestId)) fail('JOIN_NOT_SUBMITTED')
    const socket = await phase('ENROLLMENT_CONNECT_FAILED', () => this.connect(hub.url, { allowLoopback: this.allowLoopback }))
    try {
      const challenge = checkChallenge(await phase('ENROLLMENT_CHALLENGE_FAILED', () => socket.request('enrollment.challenge', { purpose, requestId: record.requestId, publicKey: record.publicKey })), { hubId, purpose, requestId: record.requestId })
      const result = await phase('ENROLLMENT_PROOF_FAILED', () => socket.request('enrollment.prove', { challengeId: challenge.challengeId, signature: signature(record, challenge) }))
      return this.result(key, hub, record.requestId, result)
    } finally { socket.close() }
  }
  async update(key, hub, change) {
    await credentialsOf(this.ctx).modifyRecord(key, current => ({ kind: 'grant', payload: change(checkedRecord(current, hub)) }))
  }
  async result(key, hub, requestId, result) {
    if (!result || result.requestId !== requestId || !statuses.has(result.status) || result.status === 'approved' && !identifier(result.instanceId)) fail('INVALID_ENROLLMENT_RESPONSE')
    if (result.status === 'approved') this.conflict(hub, result.instanceId)
    await this.update(key, hub, value => {
      if (value.requestId !== requestId) fail('ENROLLMENT_CONFLICT')
      if (value.instanceId && result.instanceId && value.instanceId !== result.instanceId) fail('COMMUNICATION_PAIRING_CONFLICT')
      return { ...value, status: result.status, ...(result.instanceId ? { instanceId: result.instanceId } : {}) }
    })
    const record = checkedRecord(await credentialsOf(this.ctx).readRecord(key), hub)
    if (result.status === 'approved') await this.configure(hub, result.instanceId, key, record.displayName)
    return safeStatus(record)
  }
  async configure(hub, instanceId, key, displayName) {
    this.conflict(hub, instanceId)
    const configured = this.rt.config.communication
    if (configured?.enabled === true && configured.hubId === hub.hubId && configured.url === hub.url
      && configured.instanceId === instanceId && configured.credentialKey === key && configured.humanDisplayName != null) return
    const editor = serviceOf(this.ctx, 'configEditor', 'CONFIG_EDITOR_UNAVAILABLE')
    if (!editor?.entries || !editor?.edit) fail('CONFIG_EDITOR_UNAVAILABLE')
    const entries = editor.entries().filter(entry => entry.options?.name === 'ds-bot')
    if (entries.length !== 1) fail('CONFIG_ENTRY_UNAVAILABLE')
    await phase('COMMUNICATION_CONFIG_WRITE_FAILED', () => editor.edit(entries[0], current => {
      this.conflict(hub, instanceId, current)
      return { ...current, communication: { ...current.communication, enabled: true, hubId: hub.hubId, url: hub.url, instanceId,
        credentialKey: key, humanDisplayName: current.communication?.humanDisplayName ?? displayName,
        publishedBotIds: current.communication?.publishedBotIds ?? [] } }
    }))
  }
  async contact(action, input) {
    const comm = this.rt.communication
    if (!comm?.transport?.connected || !comm.human?.principalId) fail('COMMUNICATION_UNAVAILABLE')
    const principalId = comm.human.principalId
    const botPrincipalIds = () => {
      if (!Array.isArray(input.localBotIds ?? []) || (input.localBotIds ?? []).length > 100) fail('INVALID_BOT_SCOPE')
      return [...new Set((input.localBotIds ?? []).map(id => {
        const bot = comm.bots.get(id)
        if (!bot || !this.rt.botOf(id)) fail('INVALID_BOT_SCOPE')
        return bot.principalId
      }))]
    }
    const mutations = new Set(['contact-request', 'contact-accept', 'contact-reject', 'contact-cancel', 'contact-revoke', 'rotate-user-code'])
    const operationId = mutations.has(action) ? operation(input.operationId) : undefined
    let type, payload = { principalId }
    switch (action) {
      case 'user-code': type = 'contact.code'; break
      case 'rotate-user-code': type = 'contact.code.rotate'; payload = { ...payload, operationId }; break
      case 'contact-requests': type = 'contact.requests'; break
      case 'contact-relations': type = 'contact.relations'; break
      case 'contact-request':
        if (typeof input.userCode !== 'string' || input.userCode.length > 4096 || !input.userCode) fail('INVALID_REQUEST')
        type = 'contact.request'; payload = { ...payload, operationId, userCode: input.userCode, botPrincipalIds: botPrincipalIds() }; break
      case 'contact-accept': case 'contact-reject': case 'contact-cancel':
        if (!identifier(input.requestId)) fail('INVALID_REQUEST')
        type = `contact.${action.slice(8)}`; payload = { ...payload, operationId, requestId: input.requestId, expectedVersion: version(input.expectedVersion),
          ...(action === 'contact-accept' ? { botPrincipalIds: botPrincipalIds() } : {}) }; break
      case 'contact-revoke':
        if (typeof input.otherHumanPrincipalId !== 'string' || !/^human:[A-Za-z0-9_-]+:[A-Za-z0-9_-]+$/.test(input.otherHumanPrincipalId)) fail('INVALID_REQUEST')
        type = 'contact.revoke'; payload = { ...payload, operationId, otherHumanPrincipalId: input.otherHumanPrincipalId, expectedVersion: version(input.expectedVersion) }; break
      default: fail('UNKNOWN_OPERATION')
    }
    return comm.transport.request(type, payload)
  }
}
