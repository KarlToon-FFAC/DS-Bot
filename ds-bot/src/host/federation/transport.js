import { randomUUID } from 'node:crypto'

const PROTOCOL = 'dsbot-communication/1'
const CAPABILITIES = ['text', 'markdown', 'mentions', 'group', 'dm', 'reply', 'history', 'group-policy', 'membership-epoch', 'explicit-bot-activation']
const BOUNDED_COLLABORATION = 'bounded-bot-collaboration'
const outboxCapacity = Symbol('outbox-capacity')
const transient = new Set(['CONNECTION_LOST', 'REQUEST_TIMEOUT', 'STORAGE_UNAVAILABLE', 'BACKPRESSURE', 'HISTORY_GAP'])
const errorWith = (code, message = code) => Object.assign(new Error(message), { code })

export function communicationUrl(url) {
  const target = new URL(url)
  if (!['ws:', 'wss:'].includes(target.protocol) || target.protocol === 'ws:' && !['127.0.0.1', '[::1]'].includes(target.hostname)) throw errorWith('TLS_REQUIRED')
  if (target.username || target.password || target.search || target.hash) throw errorWith('INVALID_CONFIG')
  return target.href
}

export class CommunicationTransport {
  constructor(queue, { url, credential, requestTimeout = 15000, onConnect, onChange, onError, beforeReceive, afterReceive } = {}) {
    this.queue = queue
    this.url = communicationUrl(url)
    this.credential = credential
    this.requestTimeout = requestTimeout
    this.onChange = onChange
    this.onConnect = onConnect
    this.onError = onError
    this.beforeReceive = beforeReceive
    this.afterReceive = afterReceive
    this.requests = new Map()
    this.socket = null
    this.connected = false
    this.running = false
    this.timer = null
    this.opening = null
    this.pumping = null
    this.fenced = false
  }
  async connect() {
    if (this.fenced) throw errorWith('STALE_CONNECTION')
    if (this.connected) return
    if (this.opening) return this.opening
    this.opening = this.open().finally(() => { this.opening = null })
    return this.opening
  }
  async open() {
    const credential = typeof this.credential === 'function' ? await this.credential() : this.credential
    const socket = credential?.socketFactory ? await credential.socketFactory() : new WebSocket(this.url)
    this.socket = socket
    socket.addEventListener('message', event => {
      try {
        const response = JSON.parse(event.data)
        const pending = this.requests.get(response.id)
        if (!pending) return
        clearTimeout(pending.timeout); this.requests.delete(response.id)
        if (response.ok) pending.resolve(response.value)
        else {
          if (response.error?.code === 'STALE_CONNECTION') { this.fenced = true; this.connected = false; this.queue.disconnected(); socket.close() }
          pending.reject(errorWith(response.error?.code ?? 'INVALID_RESPONSE', response.error?.message))
        }
      } catch { this.onError?.({ code: 'INVALID_RESPONSE' }) }
    })
    socket.addEventListener('close', () => {
      if (this.socket === socket) { this.connected = false; this.queue.disconnected() }
      for (const [id, pending] of this.requests) {
        if (pending.socket !== socket) continue
        clearTimeout(pending.timeout); pending.reject(errorWith('CONNECTION_LOST')); this.requests.delete(id)
      }
    })
    if (socket.readyState !== WebSocket.OPEN) await new Promise((resolve, reject) => {
      const deadline = setTimeout(() => { socket.close(); reject(errorWith('REQUEST_TIMEOUT')) }, this.requestTimeout)
      socket.addEventListener('open', () => { clearTimeout(deadline); resolve() }, { once: true })
      socket.addEventListener('error', () => { clearTimeout(deadline); reject(errorWith('CONNECTION_LOST')) }, { once: true })
      socket.addEventListener('close', () => { clearTimeout(deadline); reject(errorWith('CONNECTION_LOST')) }, { once: true })
    })
    try {
      const capabilities = [...CAPABILITIES, BOUNDED_COLLABORATION]
      const welcome = typeof credential?.authenticate === 'function'
        ? await credential.authenticate((type, payload) => this.send(type, payload), capabilities)
        : await this.send('hello', { instanceId: this.queue.instanceId, credential, capabilities })
      if (!welcome.capabilities?.includes('explicit-bot-activation')) throw errorWith('EXPLICIT_ACTIVATION_REQUIRED')
      if (welcome.protocol !== PROTOCOL || welcome.instanceId !== this.queue.instanceId || !CAPABILITIES.every(value => welcome.capabilities?.includes(value))) throw errorWith('UNSUPPORTED_CAPABILITY')
      if (!welcome.capabilities.includes(BOUNDED_COLLABORATION)) throw errorWith('BOUNDED_COLLABORATION_REQUIRED')
      this.welcome = welcome
      this.queue.setLimits(welcome.limits)
      this.connected = true
      await this.onConnect?.(welcome)
      return welcome
    } catch (error) { this.connected = false; this.queue.disconnected(); socket.close(); throw error }
  }
  send(type, payload) {
    const socket = this.socket
    if (!socket || socket.readyState !== WebSocket.OPEN) return Promise.reject(errorWith('CONNECTION_LOST'))
    const id = randomUUID(), frame = JSON.stringify({ protocol: PROTOCOL, id, type, payload })
    if (this.welcome && Buffer.byteLength(frame) > this.welcome.limits.maxEnvelopeBytes) return Promise.reject(errorWith('PAYLOAD_TOO_LARGE'))
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => { this.requests.delete(id); reject(errorWith('REQUEST_TIMEOUT')) }, this.requestTimeout)
      this.requests.set(id, { socket, resolve, reject, timeout })
      try { socket.send(frame) } catch { clearTimeout(timeout); this.requests.delete(id); reject(errorWith('CONNECTION_LOST')) }
    })
  }
  request(type, payload = {}) {
    if (!this.connected) return Promise.reject(errorWith('CONNECTION_LOST'))
    return this.send(type, payload)
  }
  pump() {
    if (this.pumping) return this.pumping
    this.pumping = this.synchronize().finally(() => { this.pumping = null })
    return this.pumping
  }
  async synchronize() {
    if (!this.connected) throw errorWith('CONNECTION_LOST')
    let deferredError
    for (const item of this.queue.pendingOutbox()) {
      try {
        if (item.type === 'message.publish') this.queue.validateMessage(item.payload)
        this.queue.accepted(item.id, await this.request(item.type, item.payload))
      }
      catch (error) {
        if (['STORAGE_UNAVAILABLE', 'BACKPRESSURE'].includes(error.code)) { deferredError ??= error; continue }
        if (transient.has(error.code) || error.code === 'STALE_CONNECTION') throw error
        this.queue.rejected(item.id, error.code ?? 'INVALID_RESPONSE')
      }
    }
    this.queue.applyMemberships(await this.request('memberships.list'))
    for (const member of this.queue.memberships()) {
      let after = this.queue.cursor(member.conversationId, member.principalId, member.membershipEpoch)
      if (after > member.watermark) throw errorWith('HISTORY_GAP')
      while (after < member.watermark) {
        const page = await this.request('conversation.sync', { conversationId: member.conversationId, principalId: member.principalId,
          membershipEpoch: member.membershipEpoch, after, limit: 100 })
        const next = this.queue.applySync(page)
        if (next <= after) throw errorWith('HISTORY_GAP')
        after = next
      }
    }
    for (const delivery of await this.request('deliveries.pull')) {
      try { await this.beforeReceive?.(delivery); this.queue.receive(delivery); await this.afterReceive?.(delivery) } catch (error) {
        if (error.code !== 'BACKPRESSURE') throw error
        this.onError?.(error)
        break
      }
    }
    for (const member of this.queue.memberships()) {
      await this.request('conversation.ack', { conversationId: member.conversationId, principalId: member.principalId,
        membershipEpoch: member.membershipEpoch, seq: this.queue.cursor(member.conversationId, member.principalId, member.membershipEpoch) })
    }
    for (const receipt of this.queue.pendingReceipts()) {
      try { await this.request('delivery.receipt', receipt.payload); this.queue.receiptAccepted(receipt.id) }
      catch (error) {
        if (transient.has(error.code) || error.code === 'STALE_CONNECTION') throw error
        this.queue.receiptRejected(receipt.id, error.code ?? 'INVALID_RESPONSE')
      }
    }
    await this.onChange?.()
    if (deferredError) { deferredError[outboxCapacity] = true; throw deferredError }
  }
  start({ pollMs = 500 } = {}) {
    if (this.running) return
    this.running = true
    let failures = 0
    const iterate = async () => {
      if (!this.running) return
      let delay = pollMs
      try { await this.connect(); await this.pump(); failures = 0 }
      catch (error) {
        failures += 1
        if (error[outboxCapacity] && this.connected && this.socket?.readyState === WebSocket.OPEN) {
          this.onError?.({ code: error.code })
          delay = Math.min(5000, Math.max(250, pollMs) * 2 ** Math.min(failures - 1, 5))
        } else {
          this.queue.disconnected()
          this.connected = false
          this.socket?.close()
          this.onError?.({ code: error.code ?? 'CONNECTION_LOST' })
          if (!transient.has(error.code)) { this.running = false; return }
          delay = Math.min(30000, 250 * 2 ** Math.min(failures, 7)) * (0.75 + Math.random() * 0.5)
        }
      }
      if (this.running) this.timer = setTimeout(() => { void iterate() }, delay)
    }
    void iterate()
  }
  stop() {
    this.running = false
    clearTimeout(this.timer)
    this.connected = false
    this.queue.disconnected()
    this.socket?.close()
  }
}
