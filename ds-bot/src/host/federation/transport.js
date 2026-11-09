import { communicationCompatibility } from '../../shared/communication-version.js'
import { randomUUID } from 'node:crypto'
import { AsyncLocalStorage } from 'node:async_hooks'
import { ATTACHMENT_CAPABILITY } from '../../shared/communication-attachments.js'

const PROTOCOL = 'dsbot-communication/1'
const CAPABILITIES = ['text', 'markdown', 'mentions', 'group', 'dm', 'reply', 'history', 'group-policy', 'membership-epoch', 'explicit-bot-activation', 'bot-input-updates']
const STATE_INVALIDATION = 'state-invalidation'
const BOUNDED_COLLABORATION = 'bounded-bot-collaboration'
export const communicationCapabilities = () => [...CAPABILITIES, BOUNDED_COLLABORATION, ATTACHMENT_CAPABILITY, STATE_INVALIDATION]
const outboxCapacity = Symbol('outbox-capacity')
const membershipChanged = Symbol('membership-changed')
const transient = new Set(['CONNECTION_LOST', 'REQUEST_TIMEOUT', 'HUB_CONNECTION_REFUSED', 'HUB_CONNECTION_TIMEOUT', 'HUB_UNREACHABLE', 'STORAGE_UNAVAILABLE', 'BACKPRESSURE', 'HISTORY_GAP'])
const localConnectionFailures = new WeakSet()
export const isLocalConnectionFailure = error => localConnectionFailures.has(error)
const errorWith = (code, message = code) => Object.assign(new Error(message), { code })
const connectionLost = () => { const error = errorWith('CONNECTION_LOST'); localConnectionFailures.add(error); return error }

export function communicationUrl(url) {
  const target = new URL(url)
  if (!['ws:', 'wss:'].includes(target.protocol) || target.protocol === 'ws:' && !['127.0.0.1', '[::1]'].includes(target.hostname)) throw errorWith('TLS_REQUIRED')
  if (target.username || target.password || target.search || target.hash) throw errorWith('INVALID_CONFIG')
  return target.href
}

export class CommunicationTransport {
  constructor(queue, { url, credential, requestTimeout = 15000, onConnect, onChange, onError, onInvalidate, beforeReceive, afterReceive } = {}) {
    this.queue = queue
    this.url = communicationUrl(url)
    this.credential = credential
    this.requestTimeout = requestTimeout
    this.onChange = onChange
    this.onConnect = onConnect
    this.onError = onError
    this.onInvalidate = onInvalidate
    this.beforeReceive = beforeReceive
    this.afterReceive = afterReceive
    this.requests = new Map()
    this.context = new AsyncLocalStorage()
    this.socket = null
    this.connected = false
    this.running = false
    this.timer = null
    this.opening = null
    this.pumping = null
    this.fenced = false
    this.generation = 0
    this.runGeneration = 0
    this.state = 'idle'
    this.events = []
    this.hints = 0
    this.reconnects = 0
    this.lastError = null
    this.lastDisconnectedAt = null
    this.wakePending = false
  }
  async connect() {
    if (this.fenced) throw errorWith('STALE_CONNECTION')
    if (this.connected) return
    if (this.opening) return this.opening
    const opening = this.open().finally(() => { if (this.opening === opening) this.opening = null })
    this.opening = opening
    return opening
  }
  record(event, code) {
    this.events.push({ at: new Date().toISOString(), event, generation: this.generation,
      ...(typeof code === 'string' && /^[A-Z_]{1,80}$/.test(code) ? { code } : {}) })
    if (this.events.length > 32) this.events.shift()
  }
  transition(state) {
    if (this.state === state) return
    this.state = state
    this.record(state)
  }
  assertCurrent(generation, socket = this.socket) {
    if (generation !== this.generation || socket !== this.socket) throw connectionLost()
  }
  disconnect(socket = this.socket, close = true) {
    if (socket === this.socket) {
      this.connected = false
      this.queue.disconnected()
      this.lastDisconnectedAt = new Date().toISOString()
    }
    for (const [id, pending] of this.requests) {
      if (pending.socket !== socket) continue
      clearTimeout(pending.timeout)
      pending.reject(connectionLost())
      this.requests.delete(id)
    }
    if (close) socket?.close()
  }
  async open() {
    const generation = ++this.generation
    this.transition('connecting')
    this.welcome = null
    this.compatibility = communicationCompatibility()
    let socket
    try {
      const credential = typeof this.credential === 'function' ? await this.credential() : this.credential
      this.assertCurrent(generation)
      socket = credential?.socketFactory ? await credential.socketFactory() : new WebSocket(this.url)
      if (generation !== this.generation) { socket.close(); throw connectionLost() }
      this.socket = socket
      socket.addEventListener('message', event => {
        if (generation !== this.generation || this.socket !== socket) return
        try {
          const response = JSON.parse(event.data)
          if (response.type === 'state.invalidate' && response.protocol === PROTOCOL && !response.id) {
            if (!this.connected || !this.welcome?.capabilities?.includes(STATE_INVALIDATION)) return
            this.hints += 1
            this.onInvalidate?.(response.scope === 'messages' ? 'messages' : 'directory')
            this.wake()
            return
          }
          const pending = this.requests.get(response.id)
          if (!pending || pending.socket !== socket) return
          clearTimeout(pending.timeout); this.requests.delete(response.id)
          if (response.ok) pending.resolve(response.value)
          else {
            const code = response.error?.code ?? 'INVALID_RESPONSE'
            if (code === 'STALE_CONNECTION') { this.fenced = true; this.transition('fenced'); this.disconnect(socket) }
            pending.reject(errorWith(code, response.error?.message))
          }
        } catch { this.onError?.({ code: 'INVALID_RESPONSE' }) }
      })
      socket.addEventListener('close', () => {
        if (generation !== this.generation || this.socket !== socket) return
        this.disconnect(socket, false)
        if (!this.fenced) this.transition('disconnected')
        this.wake()
      })
      if (socket.readyState !== WebSocket.OPEN) await new Promise((resolve, reject) => {
        const deadline = setTimeout(() => { cleanup(); socket.close(); reject(errorWith('REQUEST_TIMEOUT')) }, this.requestTimeout)
        const opened = () => { cleanup(); resolve() }
        const failed = () => { cleanup(); reject(connectionLost()) }
        const cleanup = () => {
          clearTimeout(deadline)
          socket.removeEventListener('open', opened)
          socket.removeEventListener('error', failed)
          socket.removeEventListener('close', failed)
        }
        socket.addEventListener('open', opened, { once: true })
        socket.addEventListener('error', failed, { once: true })
        socket.addEventListener('close', failed, { once: true })
      })
      this.assertCurrent(generation, socket)
      this.transition('authenticating')
      const send = (type, payload) => this.send(type, payload, socket, generation)
      const capabilities = communicationCapabilities()
      const welcome = typeof credential?.authenticate === 'function'
        ? await credential.authenticate(send, capabilities)
        : await send('hello', { instanceId: this.queue.instanceId, credential, capabilities })
      this.assertCurrent(generation, socket)
      this.compatibility = communicationCompatibility(welcome)
      if (!welcome.capabilities?.includes('explicit-bot-activation')) throw errorWith('EXPLICIT_ACTIVATION_REQUIRED')
      if (welcome.protocol !== PROTOCOL || welcome.instanceId !== this.queue.instanceId || !CAPABILITIES.every(value => welcome.capabilities?.includes(value))) throw errorWith('UNSUPPORTED_CAPABILITY')
      if (!welcome.capabilities.includes(BOUNDED_COLLABORATION)) throw errorWith('BOUNDED_COLLABORATION_REQUIRED')
      this.welcome = welcome
      this.queue.setLimits(welcome.limits)
      this.connected = true
      this.transition('synchronizing')
      this.reconnects += 1
      await this.context.run(generation, () => this.onConnect?.(welcome))
      this.assertCurrent(generation, socket)
      return welcome
    } catch (error) {
      if (generation === this.generation) { this.compatibility = communicationCompatibility({ communicationVersion: this.compatibility?.hubVersion }, error.code); this.transition(this.fenced ? 'fenced' : 'disconnected'); this.disconnect(socket) }
      else socket?.close()
      throw error
    }
  }
  send(type, payload, socket = this.socket, generation = this.generation) {
    if (generation !== this.generation || socket !== this.socket) return Promise.reject(connectionLost())
    if (!socket || socket.readyState !== WebSocket.OPEN) return Promise.reject(connectionLost())
    const id = randomUUID(), frame = JSON.stringify({ protocol: PROTOCOL, id, type, payload })
    if (this.welcome && Buffer.byteLength(frame) > this.welcome.limits.maxEnvelopeBytes) return Promise.reject(errorWith('PAYLOAD_TOO_LARGE'))
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => { this.requests.delete(id); reject(errorWith('REQUEST_TIMEOUT')) }, this.requestTimeout)
      this.requests.set(id, { socket, resolve, reject, timeout })
      try { socket.send(frame) } catch { clearTimeout(timeout); this.requests.delete(id); reject(connectionLost()) }
    })
  }
  request(type, payload = {}) {
    const owner = this.context.getStore()
    if (owner !== undefined && owner !== this.generation) return Promise.reject(connectionLost())
    if (!this.connected) return Promise.reject(connectionLost())
    const generation = this.generation, socket = this.socket
    return this.send(type, payload, socket, generation).then(value => { this.assertCurrent(generation, socket); return value })
  }
  pump() {
    if (this.pumping) return this.pumping
    const pumping = this.context.run(this.generation, () => this.synchronize()).finally(() => { if (this.pumping === pumping) this.pumping = null })
    this.pumping = pumping
    return pumping
  }
  async synchronize() {
    if (!this.connected) throw connectionLost()
    const generation = this.generation
    const current = () => { if (generation !== this.generation || !this.connected) throw connectionLost() }
    if (this.state !== 'ready') this.transition?.('synchronizing')
    // Recovery may retain both receipts. Hub storage must precede proof of model read,
    // and both must precede publication of a final covering that supplement.
    for (const receipt of this.queue.pendingReceipts().filter(item=>['targetStored','updateRead'].includes(item.payload.status))
      .sort((a,b)=>Number(a.payload.status==='updateRead')-Number(b.payload.status==='updateRead'))) {
      try { await this.request('delivery.receipt',receipt.payload);this.queue.receiptAccepted(receipt.id) }
      catch(error){ if(transient.has(error.code)||error.code==='STALE_CONNECTION')throw error;this.queue.receiptRejected(receipt.id,error.code??'INVALID_RESPONSE') }
    }
    let deferredError
    for (const item of this.queue.pendingOutbox()) {
      try {
        // Upgrades must not replay removed ownership recovery against an older Hub.
        if (item.type === 'group.reclaim') throw errorWith('UNKNOWN_OPERATION')
        if (item.type === 'message.publish') {
          this.queue.validateMessage(item.payload)
          if(item.payload.attachments?.length&&!this.welcome.capabilities.includes(ATTACHMENT_CAPABILITY))throw errorWith('ATTACHMENT_CAPABILITY_REQUIRED')
          if(item.payload.localUserIntent&&!this.welcome.capabilities.includes('local-user-intent'))throw errorWith('UNSUPPORTED_CAPABILITY')
          const message=item.payload
          if(message.author?.kind==='bot'&&!message.replyToMessageId&&!message.responseToDeliveryId&&!message.causationDeliveryId&&!message.localUserIntent&&!message.updateForMessageId
            &&!this.welcome.capabilities.includes('proactive-bot-roots'))throw errorWith('PROACTIVE_ROOT_CAPABILITY_REQUIRED')
        }
        this.queue.accepted(item.id, await this.request(item.type, item.payload))
      }
      catch (error) {
        if (['STORAGE_UNAVAILABLE', 'BACKPRESSURE'].includes(error.code)) { deferredError ??= error; continue }
        if (transient.has(error.code) || error.code === 'STALE_CONNECTION') throw error
        this.queue.rejected(item.id, error.code ?? 'INVALID_RESPONSE')
      }
    }
    const scopeFailure = error => {
      // Both a Hub response and a local projection can race a newer membership.
      if (['NOT_A_MEMBER', 'MEMBERSHIP_REVOKED', 'CONTACT_REQUIRED'].includes(error.code)) {
        this.queue.disconnected()
        error[membershipChanged] = true
      }
      return error
    }
    const requestMembership = async (type, payload) => {
      try { return await this.request(type, payload) }
      catch (error) { throw scopeFailure(error) }
    }
    this.queue.applyMemberships(await this.request('memberships.list'))
    for (const member of this.queue.memberships()) {
      let after = this.queue.cursor(member.conversationId, member.principalId, member.membershipEpoch)
      if (after > member.watermark) throw errorWith('HISTORY_GAP')
      while (after < member.watermark) {
        const page = await requestMembership('conversation.sync', { conversationId: member.conversationId, principalId: member.principalId,
          membershipEpoch: member.membershipEpoch, after, limit: 100 })
        let next
        try { next = this.queue.applySync(page) } catch (error) { throw scopeFailure(error) }
        if (next <= after) throw errorWith('HISTORY_GAP')
        after = next
      }
    }
    for (const delivery of await this.request('deliveries.pull')) {
      try { await this.beforeReceive?.(delivery); current(); this.queue.receive(delivery); await this.afterReceive?.(delivery); current() } catch (error) {
        if (error.code !== 'BACKPRESSURE') throw scopeFailure(error)
        this.onError?.(error)
        break
      }
    }
    for (const member of this.queue.memberships()) {
      await requestMembership('conversation.ack', { conversationId: member.conversationId, principalId: member.principalId,
        membershipEpoch: member.membershipEpoch, seq: this.queue.cursor(member.conversationId, member.principalId, member.membershipEpoch) })
    }
    for (const receipt of this.queue.pendingReceipts()) {
      try { await this.request('delivery.receipt', receipt.payload); this.queue.receiptAccepted(receipt.id) }
      catch (error) {
        if (transient.has(error.code) || error.code === 'STALE_CONNECTION') throw error
        this.queue.receiptRejected(receipt.id, error.code ?? 'INVALID_RESPONSE')
      }
    }
    current()
    await this.onChange?.()
    current()
    if (deferredError) { deferredError[outboxCapacity] = true; throw deferredError }
    this.lastSynchronizedAt = new Date().toISOString()
    this.transition?.('ready')
    this.lastError = null
  }
  wake() {
    if (!this.running) return
    this.wakePending = true
    if (!this.iterating && this.iterate) {
      clearTimeout(this.timer)
      this.timer = setTimeout(this.iterate, Math.max(0, (this.retryAt ?? 0) - Date.now()))
    }
  }
  diagnostics() {
    return { state: this.state, compatibility: this.compatibility, generation: this.generation, connections: this.reconnects, invalidations: this.hints,
      pendingRequests: this.requests.size, lastError: this.lastError, lastDisconnectedAt: this.lastDisconnectedAt,
      lastSynchronizedAt: this.lastSynchronizedAt ?? null, recentEvents: this.events.map(event => ({ ...event })) }
  }
  start({ pollMs = 500 } = {}) {
    if (this.running) return
    this.running = true
    const run = ++this.runGeneration
    let failures = 0
    const iterate = async () => {
      if (!this.running || run !== this.runGeneration) return
      this.iterating = true
      this.wakePending = false
      let delay = pollMs
      try {
        await this.connect()
        if (!this.running || run !== this.runGeneration) return
        await this.pump()
        failures = 0
        this.retryAt = 0
      }
      catch (error) {
        if (!this.running || run !== this.runGeneration) return
        this.lastError = error.code ?? 'CONNECTION_LOST'
        this.record('failure', this.lastError)
        failures += 1
        if ((error[outboxCapacity] || error[membershipChanged]) && this.connected && this.socket?.readyState === WebSocket.OPEN) {
          this.onError?.({ code: error.code })
          delay = Math.min(5000, Math.max(250, pollMs) * 2 ** Math.min(failures - 1, 5))
        } else {
          this.disconnect()
          this.onError?.({ code: error.code ?? 'CONNECTION_LOST' })
          if (!transient.has(error.code)) { this.running = false; this.transition(this.fenced ? 'fenced' : 'blocked'); return }
          this.transition('backoff')
          this.wakePending = false
          delay = Math.min(30000, 250 * 2 ** Math.min(failures, 7)) * (0.75 + Math.random() * 0.5)
        }
        this.retryAt = Date.now() + delay
        this.wakePending = false
      } finally { if (run === this.runGeneration) this.iterating = false }
      if (this.running && run === this.runGeneration) this.timer = setTimeout(() => { void iterate() }, this.wakePending ? 0 : delay)
    }
    this.iterate = () => { void iterate() }
    void iterate()
  }
  reconnect({ pollMs = 500 } = {}) {
    this.stop()
    this.start({ pollMs })
    return { reconnectRequested: true, restartRequired: false }
  }
  stop() {
    this.running = false
    clearTimeout(this.timer)
    this.runGeneration += 1
    this.generation += 1
    this.iterating = false
    this.opening = null
    this.pumping = null
    this.transition('stopped')
    this.retryAt = 0
    this.disconnect()
  }
}
