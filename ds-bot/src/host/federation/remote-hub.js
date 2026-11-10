import { createHash, randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { remoteHubConfigured, remoteHubEnabled } from '../../shared/remote-hub.js'
import { CommunicationQueue } from './queue-store.js'
import { CommunicationTransport } from './transport.js'
import { recordPublicationSave } from './publication-state.js'
import { configFailureCode } from './config-errors.js'
import { communicationError } from '../../shared/communication-diagnostics.js'

const fail = code => { throw Object.assign(new Error(code), { code }) }
const scope = hub => JSON.stringify(['hubId','url','instanceId','credentialKey','credentialEnv','dataPath'].map(key => hub?.[key]))
const withdrawalId = hub => createHash('sha256').update(JSON.stringify([scope(hub),hub?.remoteHubWithdrawalId ?? [hub?.publicationGenerations,hub?.publishedBotIds]])).digest('hex')
const version = config => createHash('sha256').update(JSON.stringify([config.remoteHubEnabled, remoteHubEnabled(config), scope(config.communication),
  config.communication?.enabled, [...(config.communication?.publishedBotIds ?? [])].sort(),
  Object.entries(config.communication?.publicationGenerations ?? {}).sort(), config.communication?.remoteHubWithdrawalPending === true, config.communication?.remoteHubWithdrawalId])).digest('hex')
const service = (rt, name) => rt.ctx.get ? rt.ctx.get(name) : rt.ctx[name]

export class RemoteHubController {
  constructor(rt, { legacy, allowLoopback = false, onQuiesce = async () => {}, onResume = () => {} } = {}) {
    this.rt = rt; this.legacy = legacy; this.allowLoopback = allowLoopback
    this.onQuiesce = onQuiesce; this.onResume = onResume; this.tail = Promise.resolve()
    this.appliedEnabled = remoteHubEnabled(rt.config); this.closed = false; this.failures = 0
  }
  config() { return this.savedConfig ?? this.rt.config }
  status() {
    const config = this.config()
    return { enabled: remoteHubEnabled(config), configured: remoteHubConfigured(config), version: version(config),
      inferredFromExistingHub: config.remoteHubEnabled === undefined && remoteHubConfigured(config),
      publishedBotCount: config.communication?.publishedBotIds?.length ?? 0,
      withdrawalPending: this.completedWithdrawal !== withdrawalId(config.communication) && (config.communication?.remoteHubWithdrawalPending === true || !remoteHubEnabled(config) && remoteHubConfigured(config) && (config.communication?.publishedBotIds?.length ?? 0) > 0),
      withdrawalError: this.error ?? null, reloadRequired: Boolean(this.savedConfig) || remoteHubEnabled(config) !== this.appliedEnabled }
  }
  canWithdraw(hub) {
    const current = this.config().communication
    return this.status().withdrawalPending && (!this.status().enabled || current?.publishedBotIds?.length === 0) && scope(current) === scope(hub) && withdrawalId(current) === withdrawalId(hub)
  }
  editor() {
    let editor
    try { editor = service(this.rt, 'configEditor') } catch { fail('CONFIG_EDITOR_UNAVAILABLE') }
    if (!editor?.entries || !editor.edit) fail('CONFIG_EDITOR_UNAVAILABLE')
    const entries = editor.entries().filter(entry => entry.options?.name === 'ds-bot')
    if (entries.length !== 1) fail('CONFIG_ENTRY_UNAVAILABLE')
    return { editor, entry: entries[0] }
  }
  set(input) {
    const next = this.tail.catch(() => {}).then(() => this.change(input))
    this.tail = next; return next
  }
  async change(input) {
    if (Object.keys(input).some(key => !['endpoint','enabled','expectedVersion','confirmHideAllBots'].includes(key))) fail('INVALID_REQUEST')
    if (typeof input.enabled !== 'boolean' || typeof input.expectedVersion !== 'string') fail('INVALID_REQUEST')
    await this.rt.load(); await this.rt.refresh()
    if (this.rt.readOnly?.() !== undefined) fail('COMMUNICATION_READ_ONLY')
    if (input.expectedVersion !== this.status().version) fail('REMOTE_HUB_SETTINGS_CHANGED')
    if (this.status().enabled && !input.enabled && input.confirmHideAllBots !== true) fail('REMOTE_HUB_DISABLE_CONFIRMATION_REQUIRED')
    const {editor,entry} = this.editor()
    let saved
    try { await editor.edit(entry, current => {
      if (this.closed) fail('COMMUNICATION_STOPPED')
      if (this.rt.readOnly?.() !== undefined) fail('COMMUNICATION_READ_ONLY')
      if (version(current) !== input.expectedVersion) fail('REMOTE_HUB_SETTINGS_CHANGED')
      if (remoteHubEnabled(current) && !input.enabled && input.confirmHideAllBots !== true) fail('REMOTE_HUB_DISABLE_CONFIRMATION_REQUIRED')
      saved = { ...current, remoteHubEnabled: input.enabled }
      if ((!input.enabled || this.status().withdrawalPending || !remoteHubEnabled(current)) && current.communication) {
        const generations = { ...current.communication.publicationGenerations }
        for (const id of current.communication.publishedBotIds ?? []) generations[id] = randomUUID()
        saved.communication = { ...current.communication, publishedBotIds: [], publicationGenerations: generations,
          remoteHubWithdrawalId: !input.enabled ? randomUUID() : current.communication.remoteHubWithdrawalId,
          remoteHubWithdrawalPending: !input.enabled ? remoteHubConfigured(current) : this.status().withdrawalPending }
      } else if (current.communication && !this.status().withdrawalPending) {
        saved.communication = {...current.communication, remoteHubWithdrawalPending:false}
      }
      return saved
    }) } catch (cause) {
      const known = communicationError(cause).code
      const code = known === 'COMMUNICATION_UNAVAILABLE' ? configFailureCode(cause) : known
      throw Object.assign(new Error(code, { cause }), { code, phase: 'COMMUNICATION_CONFIG_WRITE_FAILED' })
    }
    if (!saved) fail('CONFIG_ENTRY_UNAVAILABLE')
    this.savedConfig = saved
    if (!input.enabled && saved.communication) recordPublicationSave(this.rt, saved.communication)
    void this.apply().catch(() => {})
    return { ...this.status(), reloadRequired: true }
  }
  assertAvailable() {
    const status = this.status()
    if (!status.enabled) fail('REMOTE_HUB_DISABLED')
    if (status.withdrawalPending) fail('REMOTE_HUB_WITHDRAWAL_PENDING')
    if (!this.appliedEnabled || this.savedConfig) fail('REMOTE_HUB_RELOAD_REQUIRED')
  }
  async apply() {
    if (this.closed) return
    const status = this.status()
    if (!status.enabled || status.withdrawalPending) await this.onQuiesce()
    if (this.closed) return
    if (status.withdrawalPending) this.wake()
    else if (status.enabled && this.appliedEnabled && !this.savedConfig) this.onResume()
  }
  wake() {
    if (this.closed || this.running) return
    clearTimeout(this.timer)
    this.running = this.withdraw().then(() => { this.error = null; this.failures = 0 }, error => {
      if (!this.closed) { this.error = /^[A-Z_]{1,80}$/.test(error.code ?? '') ? error.code : 'COMMUNICATION_UNAVAILABLE'; this.failures += 1 }
    }).finally(() => {
      this.running = null
      if (this.closed) return
      if (this.status().withdrawalPending) this.timer = setTimeout(() => this.wake(), Math.min(30000, 1000 * 2 ** Math.min(this.failures, 5)))
      else if (this.status().enabled && this.appliedEnabled && !this.savedConfig) this.onResume()
    })
  }
  async withdraw() {
    const hub = this.config().communication
    if (!this.status().withdrawalPending) return
    if (!this.canWithdraw(hub)) fail('REMOTE_HUB_SETTINGS_CHANGED')
    await this.rt.load(); await this.rt.refresh()
    if (this.rt.readOnly?.() !== undefined) fail('COMMUNICATION_READ_ONLY')
    const {communicationQueueSettings,communicationAuthentication,communicationSocket,completeCommunicationWithdrawal} = await import('./onboarding.js')
    const queueSettings = hub.credentialKey ? await communicationQueueSettings(this.rt, hub.credentialKey, hub) : {}
    if (this.closed || !this.canWithdraw(hub)) return
    if (this.rt.readOnly?.() !== undefined) fail('COMMUNICATION_READ_ONLY')
    const queue = new CommunicationQueue(queueSettings.dataPath ?? hub.dataPath ?? join(this.rt.home,'communication.sqlite'), { instanceId: hub.instanceId })
    let transport
    const intent = withdrawalId(hub)
    try {
      if (queue.remoteHubWithdrawalComplete(intent)) { this.completedWithdrawal = intent; return }
      queue.reconcileBotPublications([], hub.publicationGenerations)
      const credential = hub.credentialKey ? {
        authenticate: communicationAuthentication(this.rt,hub.credentialKey,hub,{withdrawalOnly:true}),
        socketFactory: () => communicationSocket(this.rt,hub.credentialKey,hub,{allowLoopback:this.allowLoopback,withdrawalOnly:true}),
      } : this.legacy?.read
      if (!credential) fail('CREDENTIAL_UNAVAILABLE')
      transport = new CommunicationTransport(queue,{url:hub.url,credential})
      this.transport = transport
      const welcome = await transport.connect()
      if (!welcome.capabilities?.includes('bot-publication-generations')) fail('BOT_PUBLICATION_MIGRATION_REQUIRED')
      if (this.closed || !this.canWithdraw(hub)) fail('REMOTE_HUB_SETTINGS_CHANGED')
      await transport.request('principal.publication',{principalIds:[]})
      if (this.closed || !this.canWithdraw(hub)) return
      if (hub.credentialKey) await completeCommunicationWithdrawal(this.rt,hub.credentialKey,hub)
      queue.completeRemoteHubWithdrawal(intent)
      this.completedWithdrawal = intent
    } finally { transport?.stop(); this.transport = null; queue.close() }
  }
  async close() {
    this.closed = true; clearTimeout(this.timer); this.transport?.stop()
    // A ConfigEditor reload may dispose this scope while its own save is pending.
  }
}
