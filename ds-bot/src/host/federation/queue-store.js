import { DatabaseSync } from 'node:sqlite'
import { randomUUID, createHash } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { normalizeAttachments } from '../../shared/communication-attachments.js'

const canonical = value => Array.isArray(value) ? `[${value.map(canonical).join(',')}]`
  : value && typeof value === 'object' ? `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}` : JSON.stringify(value)
const digest = value => createHash('sha256').update(canonical(value)).digest('hex')
const fail = code => { throw Object.assign(new Error(code), { code }) }
const requireValue = (condition, code) => { if (!condition) fail(code) }

export class CommunicationQueue {
  constructor(path, { instanceId, maxPending = 1000, beforeCommit } = {}) {
    requireValue(instanceId === undefined || typeof instanceId === 'string' && instanceId.length > 0 && instanceId.length <= 100 && !instanceId.includes(':'), 'INVALID_CONFIG')
    requireValue(Number.isSafeInteger(maxPending) && maxPending > 0, 'INVALID_CONFIG')
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true })
    this.db = new DatabaseSync(path)
    const version = this.db.prepare('PRAGMA user_version').get().user_version
    if (version > 6) { this.db.close(); fail('SCHEMA_VERSION_UNSUPPORTED') }
    this.maxPending = maxPending
    this.beforeCommit = beforeCommit
    this.authorized = false
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS metadata (key TEXT PRIMARY KEY,value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS outbox (id TEXT PRIMARY KEY,type TEXT NOT NULL,payload TEXT NOT NULL,hash TEXT NOT NULL,state TEXT NOT NULL DEFAULT 'pending',result TEXT,error TEXT);
      CREATE TABLE IF NOT EXISTS memberships (conversation_id TEXT NOT NULL,principal_id TEXT NOT NULL,epoch TEXT NOT NULL,join_seq INTEGER NOT NULL,active INTEGER NOT NULL,body TEXT NOT NULL,PRIMARY KEY(conversation_id,principal_id));
      CREATE TABLE IF NOT EXISTS events (conversation_id TEXT NOT NULL,principal_id TEXT NOT NULL,epoch TEXT NOT NULL,seq INTEGER NOT NULL,event_id TEXT NOT NULL,hash TEXT NOT NULL,body TEXT NOT NULL,PRIMARY KEY(conversation_id,principal_id,epoch,seq));
      CREATE TABLE IF NOT EXISTS cursors (conversation_id TEXT NOT NULL,principal_id TEXT NOT NULL,epoch TEXT NOT NULL,seq INTEGER NOT NULL,PRIMARY KEY(conversation_id,principal_id,epoch));
      CREATE TABLE IF NOT EXISTS inbox (delivery_id TEXT PRIMARY KEY,message_id TEXT NOT NULL,conversation_id TEXT NOT NULL,principal_id TEXT NOT NULL,epoch TEXT NOT NULL,seq INTEGER NOT NULL,ai INTEGER NOT NULL,notify INTEGER NOT NULL,hash TEXT NOT NULL,body TEXT NOT NULL,ai_state TEXT NOT NULL DEFAULT 'pending',mapping TEXT,applied INTEGER NOT NULL DEFAULT 0,human_read INTEGER NOT NULL DEFAULT 0,revoked INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS receipts (id TEXT PRIMARY KEY,payload TEXT NOT NULL,state TEXT NOT NULL DEFAULT 'pending',error TEXT);
      CREATE TABLE IF NOT EXISTS exports (source_key TEXT PRIMARY KEY,binding_id TEXT NOT NULL,source_hash TEXT NOT NULL,message_id TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS completion_checks (delivery_id TEXT PRIMARY KEY,binding_id TEXT NOT NULL,session_id TEXT NOT NULL,turn INTEGER NOT NULL,draft_id TEXT UNIQUE,seq INTEGER NOT NULL,message_id TEXT NOT NULL,hash TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS outbound_decisions (source_key TEXT PRIMARY KEY,binding_id TEXT NOT NULL,delivery_id TEXT NOT NULL,outcome TEXT NOT NULL,metadata TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS outbound_decisions_delivery ON outbound_decisions(delivery_id,outcome);
      CREATE TABLE IF NOT EXISTS export_cursors (binding_id TEXT NOT NULL,session_id TEXT NOT NULL,seq INTEGER NOT NULL,PRIMARY KEY(binding_id,session_id));
      CREATE TABLE IF NOT EXISTS reply_targets (delivery_id TEXT PRIMARY KEY,binding_id TEXT NOT NULL,targets TEXT NOT NULL,source_key TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS tool_reply_completions (delivery_id TEXT PRIMARY KEY,binding_id TEXT NOT NULL,message_id TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS relationship_memory (scope TEXT NOT NULL,id TEXT NOT NULL,body TEXT NOT NULL,PRIMARY KEY(scope,id));
      DROP TABLE IF EXISTS local_address_notes;
      CREATE TABLE IF NOT EXISTS bot_publication_generations (local_ref TEXT PRIMARY KEY,generation TEXT);
      CREATE TABLE IF NOT EXISTS retired_local_bots (principal_id TEXT PRIMARY KEY,local_ref TEXT NOT NULL,local_id TEXT NOT NULL,name TEXT NOT NULL,retired_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS archived_conversations (conversation_id TEXT PRIMARY KEY);
      `)
    if (version < 2) {
      this.db.exec('BEGIN IMMEDIATE')
      try {
        this.db.exec(`CREATE TABLE IF NOT EXISTS local_principals (kind TEXT NOT NULL,local_ref TEXT NOT NULL,local_id TEXT NOT NULL UNIQUE,name TEXT NOT NULL,PRIMARY KEY(kind,local_ref));
          CREATE TABLE IF NOT EXISTS bindings (id TEXT PRIMARY KEY,conversation_id TEXT NOT NULL,principal_id TEXT NOT NULL,epoch TEXT NOT NULL,bot_ref TEXT NOT NULL,sessions TEXT NOT NULL,context_seq INTEGER NOT NULL DEFAULT 0,UNIQUE(conversation_id,principal_id,epoch));
          CREATE TABLE IF NOT EXISTS view_watermarks (conversation_id TEXT NOT NULL,principal_id TEXT NOT NULL,epoch TEXT NOT NULL,applied_seq INTEGER NOT NULL,read_seq INTEGER NOT NULL,PRIMARY KEY(conversation_id,principal_id,epoch));`)
        if (!this.db.prepare('PRAGMA table_info(inbox)').all().some(column => column.name === 'revocation_result')) this.db.exec('ALTER TABLE inbox ADD COLUMN revocation_result TEXT')
        this.db.exec('PRAGMA user_version=2; COMMIT')
      } catch (error) { this.db.exec('ROLLBACK'); this.db.close(); throw error }
    }
    if (version < 6) this.db.exec('PRAGMA user_version=6')
    const old = this.db.prepare('SELECT value FROM metadata WHERE key=?').get('instanceId')?.value
    if (old && instanceId && old !== instanceId) { this.db.close(); fail('INSTANCE_ID_MISMATCH') }
    this.instanceId = old ?? instanceId ?? randomUUID()
    requireValue(!this.instanceId.includes(':') && Number.isSafeInteger(maxPending) && maxPending > 0, 'INVALID_CONFIG')
    this.db.prepare('INSERT OR IGNORE INTO metadata VALUES (?,?)').run('instanceId', this.instanceId)
    if (!this.db.prepare("SELECT 1 FROM metadata WHERE key='explicit-output-v1'").get()) this.transaction(() => {
      this.db.exec(`UPDATE outbox SET state='failed',error='LEGACY_AUTO_EXPORT_QUARANTINED'
        WHERE state='pending' AND type='message.publish' AND json_extract(payload,'$.author.kind')='bot'
        AND json_extract(payload,'$.updateForMessageId') IS NULL
        AND NOT EXISTS(SELECT 1 FROM exports x WHERE x.message_id=outbox.id AND x.binding_id LIKE 'tool:%')`)
      this.db.prepare("INSERT INTO metadata VALUES ('explicit-output-v1','1')").run()
    })
    this.limits = JSON.parse(this.db.prepare('SELECT value FROM metadata WHERE key=?').get('limits')?.value ?? '{"maxTextBytes":65536,"maxEnvelopeBytes":131072}')
  }
  close() { this.authorized = false; this.db.close() }
  remoteHubWithdrawalComplete(id) { return this.db.prepare('SELECT value FROM metadata WHERE key=?').get('remote-hub-withdrawal')?.value === id }
  completeRemoteHubWithdrawal(id) {
    this.db.prepare('INSERT INTO metadata VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run('remote-hub-withdrawal', id)
  }
  archivedConversations() {
    return this.db.prepare('SELECT conversation_id FROM archived_conversations ORDER BY conversation_id').all().map(row => row.conversation_id)
  }
  setConversationArchived(conversationId, archived) {
    requireValue(typeof conversationId === 'string' && conversationId.length > 0 && conversationId.length <= 256 && typeof archived === 'boolean', 'INVALID_REQUEST')
    return this.transaction(() => {
      if (archived) this.db.prepare('INSERT OR IGNORE INTO archived_conversations VALUES (?)').run(conversationId)
      else this.db.prepare('DELETE FROM archived_conversations WHERE conversation_id=?').run(conversationId)
      return { archivedConversationIds: this.archivedConversations() }
    })
  }
  transaction(work) {
    this.db.exec('BEGIN IMMEDIATE')
    try { const value = work(); this.beforeCommit?.(); this.db.exec('COMMIT'); return value }
    catch (error) { this.db.exec('ROLLBACK'); throw error }
  }
  owns(principalId) { return typeof principalId === 'string' && ['human:', 'bot:'].some(prefix => principalId.startsWith(`${prefix}${this.instanceId}:`)) }
  localPrincipal(kind, localRef, displayName, assignedLocalId) {
    requireValue(['human', 'bot'].includes(kind) && typeof localRef === 'string' && displayName, 'INVALID_PRINCIPAL')
    requireValue(assignedLocalId === undefined || typeof assignedLocalId === 'string' && /^[A-Za-z0-9_-]{1,100}$/.test(assignedLocalId), 'INVALID_PRINCIPAL')
    return this.transaction(() => {
      const prior = this.db.prepare('SELECT local_id FROM local_principals WHERE kind=? AND local_ref=?').get(kind, localRef)
      requireValue(!prior || assignedLocalId === undefined || prior.local_id === assignedLocalId, 'PRINCIPAL_ID_MISMATCH')
      this.db.prepare('INSERT INTO local_principals VALUES (?,?,?,?) ON CONFLICT(kind,local_ref) DO UPDATE SET name=excluded.name').run(kind, localRef, assignedLocalId ?? randomUUID(), displayName)
      const row = this.db.prepare('SELECT * FROM local_principals WHERE kind=? AND local_ref=?').get(kind, localRef)
      return { principalId: `${kind}:${this.instanceId}:${row.local_id}`, localId: row.local_id, localRef, kind, displayName }
    })
  }
  reconcileBotPublications(bots, generations = {}) {
    requireValue(generations && typeof generations === 'object' && !Array.isArray(generations)
      && Object.values(generations).every(value => typeof value === 'string' && value.length > 0 && value.length <= 256), 'INVALID_CONFIG')
    return this.transaction(() => {
      const desired = new Map(bots.map(bot => [bot.id, bot]))
      for (const row of this.db.prepare("SELECT * FROM local_principals WHERE kind='bot'").all()) {
        const old = this.db.prepare('SELECT generation FROM bot_publication_generations WHERE local_ref=?').get(row.local_ref)?.generation ?? null
        if (desired.has(row.local_ref) && old === (generations[row.local_ref] ?? null)) continue
        const id = `bot:${this.instanceId}:${row.local_id}`
        this.db.prepare('INSERT OR IGNORE INTO retired_local_bots VALUES (?,?,?,?,?)').run(id, row.local_ref, row.local_id, row.name, new Date().toISOString())
        this.db.prepare("DELETE FROM local_principals WHERE kind='bot' AND local_ref=?").run(row.local_ref)
        this.db.prepare("UPDATE inbox SET revoked=1,ai_state='revoked' WHERE principal_id=?").run(id)
        this.db.prepare("UPDATE outbox SET state='failed',error='BOT_RETIRED' WHERE state='pending' AND (json_extract(payload,'$.author.principalId')=? OR json_extract(payload,'$.principalId')=?)").run(id, id)
      }
      for (const bot of bots) {
        this.db.prepare("INSERT INTO local_principals VALUES ('bot',?,?,?) ON CONFLICT(kind,local_ref) DO UPDATE SET name=excluded.name").run(bot.id, randomUUID(), bot.name)
        this.db.prepare('INSERT INTO bot_publication_generations VALUES (?,?) ON CONFLICT(local_ref) DO UPDATE SET generation=excluded.generation').run(bot.id, generations[bot.id] ?? null)
      }
      return bots.map(bot => {
        const row = this.db.prepare("SELECT local_id FROM local_principals WHERE kind='bot' AND local_ref=?").get(bot.id)
        return { principalId: `bot:${this.instanceId}:${row.local_id}`, localId: row.local_id, localRef: bot.id, kind: 'bot', displayName: bot.name }
      })
    })
  }
  retiredBots() {
    return this.db.prepare('SELECT * FROM retired_local_bots').all().map(row => ({ principalId: row.principal_id, localRef: row.local_ref, localId: row.local_id, displayName: row.name, kind: 'bot', retired: true, retiredAt: row.retired_at }))
  }
  isRetiredBot(principalId) { return Boolean(this.db.prepare('SELECT 1 FROM retired_local_bots WHERE principal_id=?').get(principalId)) }
  binding(conversationId, principalId, epoch, botRef) {
    this.member(conversationId, principalId, epoch)
    return this.transaction(() => {
      this.db.prepare('INSERT OR IGNORE INTO bindings(id,conversation_id,principal_id,epoch,bot_ref,sessions) VALUES (?,?,?,?,?,?)').run(randomUUID(), conversationId, principalId, epoch, botRef, '[]')
      return this.bindings().find(binding => binding.conversationId === conversationId && binding.recipientPrincipalId === principalId && binding.membershipEpoch === epoch)
    })
  }
  bindings() {
    return this.db.prepare('SELECT * FROM bindings').all().map(row => ({ id: row.id, conversationId: row.conversation_id,
      recipientPrincipalId: row.principal_id, membershipEpoch: row.epoch, localBotRef: row.bot_ref,
      sessionIds: JSON.parse(row.sessions), contextSeq: row.context_seq }))
  }
  addBindingSession(id, sessionId) {
    return this.transaction(() => {
      const row = this.db.prepare('SELECT sessions FROM bindings WHERE id=?').get(id)
      requireValue(row, 'UNKNOWN_BINDING')
      const sessions = JSON.parse(row.sessions)
      if (!sessions.includes(sessionId)) sessions.push(sessionId)
      this.db.prepare('UPDATE bindings SET sessions=? WHERE id=?').run(JSON.stringify(sessions), id)
    })
  }
  contextApplied(id, seq) { this.db.prepare('UPDATE bindings SET context_seq=max(context_seq,?) WHERE id=?').run(seq, id) }
  revokedAi() { return this.db.prepare("SELECT body FROM inbox WHERE ai=1 AND revoked=1 AND ai_state!='accepted' AND revocation_result IS NULL").all().map(row => JSON.parse(row.body)) }
  revocationResult(id, value) { this.db.prepare('UPDATE inbox SET revocation_result=? WHERE delivery_id=?').run(JSON.stringify(value), id) }
  outboxFor(principalId) {
    requireValue(this.owns(principalId), 'AUTHOR_MISMATCH')
    return this.db.prepare("SELECT id,type,payload,state,result,error FROM outbox WHERE json_extract(payload,'$.author.principalId')=? OR json_extract(payload,'$.principalId')=? ORDER BY rowid DESC LIMIT 100").all(principalId, principalId).map(row => {
      const payload = JSON.parse(row.payload)
      const result = row.result ? JSON.parse(row.result) : null
      return { id: row.id, type: row.type, conversationId: payload.conversationId ?? result?.conversationId ?? null,
        principalId: payload.author?.principalId ?? payload.principalId, membershipEpoch: payload.membershipEpoch ?? null, text: payload.content?.text,
        state: row.state, error: row.error, result }
    })
  }
  exportFailures() {
    return this.db.prepare(`SELECT e.binding_id bindingId,o.id messageId,o.error code,json_extract(o.payload,'$.conversationId') conversationId
      FROM exports e JOIN outbox o ON o.id=e.message_id WHERE o.state='failed' ORDER BY o.rowid DESC LIMIT 100`).all()
  }
  setLimits(limits) {
    requireValue(Number.isSafeInteger(limits.maxTextBytes) && limits.maxTextBytes > 0
      && Number.isSafeInteger(limits.maxEnvelopeBytes) && limits.maxEnvelopeBytes > 0, 'INVALID_CONFIG')
    this.db.prepare('INSERT INTO metadata VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run('limits', JSON.stringify(limits))
    this.limits = limits
  }
  validateMessage(payload) {
    requireValue(payload.protocol === 'dsbot-communication/1' && payload.type === 'message.publish', 'PROTOCOL_VERSION_UNSUPPORTED')
    requireValue(!this.isRetiredBot(payload.author?.principalId ?? ''), 'BOT_RETIRED')
    requireValue(this.owns(payload.author?.principalId) && payload.author.homeInstanceId === this.instanceId
      && payload.author.principalId.startsWith(`${payload.author.kind}:`), 'AUTHOR_MISMATCH')
    requireValue(['text', 'markdown'].includes(payload.content?.format) && typeof payload.content?.text === 'string'
      && Object.keys(payload.content).every(key => ['format', 'text'].includes(key)) && !payload.files, 'UNSUPPORTED_CONTENT')
    const attachments = normalizeAttachments(payload.attachments)
    const bytes = Buffer.byteLength(payload.content.text, 'utf8')
    requireValue((bytes > 0 || attachments.length > 0) && bytes <= this.limits.maxTextBytes && Buffer.byteLength(JSON.stringify(payload)) <= this.limits.maxEnvelopeBytes, 'PAYLOAD_TOO_LARGE')
  }
  enqueueInside(type, payload, id) {
    requireValue(typeof id === 'string' && id.length > 0, 'INVALID_REQUEST')
    const body = JSON.stringify(payload), hash = digest(payload)
    const old = this.db.prepare('SELECT hash FROM outbox WHERE id=?').get(id)
    if (old) { requireValue(old.hash === hash, 'MESSAGE_ID_CONFLICT'); return id }
    if (type === 'message.publish') this.validateMessage(payload)
    requireValue(this.db.prepare("SELECT count(*) count FROM outbox WHERE state='pending'").get().count < this.maxPending, 'OUTBOX_FULL')
    this.db.prepare('INSERT INTO outbox(id,type,payload,hash) VALUES (?,?,?,?)').run(id, type, body, hash)
    return id
  }
  enqueueMessage(payload, humanIntent) {
    requireValue(this.owns(payload.author?.principalId), 'AUTHOR_MISMATCH')
    return this.transaction(() => {
      const id = this.enqueueInside('message.publish', payload, payload.messageId)
      if (humanIntent !== undefined) this.db.prepare('INSERT INTO metadata VALUES (?,?) ON CONFLICT(key) DO NOTHING').run(`human-send:${id}`, humanIntent)
      return id
    })
  }
  humanIntent(id) { return this.db.prepare('SELECT value FROM metadata WHERE key=?').get(`human-send:${id}`)?.value }
  enqueueOperation(type, payload) { return this.transaction(() => this.enqueueInside(type, payload, payload.operationId)) }
  pendingOutbox() { return this.db.prepare("SELECT * FROM outbox WHERE state='pending' ORDER BY rowid").all().map(row => ({ id: row.id, type: row.type, payload: JSON.parse(row.payload) })) }
  intent(id) { const row=this.db.prepare('SELECT type,payload FROM outbox WHERE id=?').get(id);return row?{type:row.type,payload:JSON.parse(row.payload)}:null }
  outboxStatus(id) {
    const row = this.db.prepare('SELECT id,state,result,error FROM outbox WHERE id=?').get(id)
    return row ? { ...row, result: row.result ? JSON.parse(row.result) : null } : null
  }
  accepted(id, result) {
    return this.transaction(() => {
      const row = this.db.prepare('SELECT type FROM outbox WHERE id=?').get(id)
      requireValue(row && (row.type !== 'message.publish' || result.messageId === id), 'INVALID_RECEIPT')
      this.db.prepare("UPDATE outbox SET state='accepted',result=?,error=NULL WHERE id=?").run(JSON.stringify(result), id)
      this.db.prepare("UPDATE outbound_decisions SET outcome='sent' WHERE json_extract(metadata,'$.messageId')=? AND outcome='pending'").run(id)
    })
  }
  rejected(id, code) { this.db.prepare("UPDATE outbox SET state='failed',error=? WHERE id=?").run(code, id) }
  applyMemberships(snapshot) {
    this.authorized = false
    this.transaction(() => {
      this.db.prepare('UPDATE memberships SET active=0').run()
      for (const member of snapshot.memberships) {
        requireValue(this.owns(member.principalId), 'AUTHOR_MISMATCH')
        requireValue(typeof member.membershipEpoch === 'string' && Number.isSafeInteger(member.joinSeq) && member.joinSeq > 0, 'INVALID_MEMBERSHIP')
        this.db.prepare('INSERT INTO memberships VALUES (?,?,?,?,?,?) ON CONFLICT(conversation_id,principal_id) DO UPDATE SET epoch=excluded.epoch,join_seq=excluded.join_seq,active=excluded.active,body=excluded.body').run(member.conversationId, member.principalId, member.membershipEpoch, member.joinSeq, Number(member.active), JSON.stringify(member))
        this.db.prepare('INSERT OR IGNORE INTO cursors VALUES (?,?,?,?)').run(member.conversationId, member.principalId, member.membershipEpoch, member.joinSeq - 1)
        this.db.prepare('INSERT OR IGNORE INTO view_watermarks VALUES (?,?,?,?,?)').run(member.conversationId, member.principalId, member.membershipEpoch, member.joinSeq - 1, member.joinSeq - 1)
      }
      for (const invite of snapshot.invites ?? []) requireValue(this.owns(invite.principalId), 'AUTHOR_MISMATCH')
      this.db.prepare('INSERT INTO metadata VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run('invites', JSON.stringify(snapshot.invites ?? []))
      this.db.prepare(`UPDATE inbox SET revoked=1,ai_state=CASE WHEN ai_state='accepted' THEN ai_state ELSE 'revoked' END WHERE NOT EXISTS (SELECT 1 FROM memberships m WHERE m.conversation_id=inbox.conversation_id AND m.principal_id=inbox.principal_id AND m.epoch=inbox.epoch AND m.active=1 AND coalesce(json_extract(m.body,'$.retiredPeer'),0)=0 AND coalesce(json_extract(m.body,'$.retired'),0)=0)`).run()
    })
    this.authorized = true
  }
  disconnected() { this.authorized = false }
  memberships() { return this.db.prepare('SELECT body FROM memberships WHERE active=1').all().map(row => JSON.parse(row.body)) }
  invites() { return JSON.parse(this.db.prepare('SELECT value FROM metadata WHERE key=?').get('invites')?.value ?? '[]') }
  member(conversationId, principalId, epoch) {
    requireValue(this.owns(principalId), 'AUTHOR_MISMATCH')
    const member = this.db.prepare('SELECT * FROM memberships WHERE conversation_id=? AND principal_id=?').get(conversationId, principalId)
    requireValue(member?.active && member.epoch === epoch, 'MEMBERSHIP_REVOKED')
    return member
  }
  insertEvent(member, event) {
    if(event.message?.attachments!==undefined)normalizeAttachments(event.message.attachments)
    requireValue(event.conversationId === member.conversation_id && Number.isSafeInteger(event.conversationSeq)
      && event.conversationSeq >= member.join_seq && typeof event.eventId === 'string', 'INVALID_EVENT')
    const hash = digest(event), old = this.db.prepare('SELECT hash,event_id FROM events WHERE conversation_id=? AND principal_id=? AND epoch=? AND seq=?').get(member.conversation_id, member.principal_id, member.epoch, event.conversationSeq)
    if (old) { requireValue(old.hash === hash && old.event_id === event.eventId, 'EVENT_CONFLICT'); return }
    this.db.prepare('INSERT INTO events VALUES (?,?,?,?,?,?,?)').run(member.conversation_id, member.principal_id, member.epoch, event.conversationSeq, event.eventId, hash, JSON.stringify(event))
  }
  advance(member) {
    let seq = this.cursor(member.conversation_id, member.principal_id, member.epoch)
    const query = this.db.prepare('SELECT 1 FROM events WHERE conversation_id=? AND principal_id=? AND epoch=? AND seq=?')
    while (query.get(member.conversation_id, member.principal_id, member.epoch, seq + 1)) seq += 1
    this.db.prepare('UPDATE cursors SET seq=? WHERE conversation_id=? AND principal_id=? AND epoch=?').run(seq, member.conversation_id, member.principal_id, member.epoch)
    return seq
  }
  cursor(conversationId, principalId, epoch) { return this.db.prepare('SELECT seq FROM cursors WHERE conversation_id=? AND principal_id=? AND epoch=?').get(conversationId, principalId, epoch)?.seq ?? 0 }
  applySync(input) {
    return this.transaction(() => {
      const member = this.member(input.conversationId, input.principalId, input.membershipEpoch)
      requireValue(input.joinSeq === member.join_seq, 'HISTORY_GAP')
      for (const event of input.events) this.insertEvent(member, event)
      return this.advance(member)
    })
  }
  receiptInside(delivery, status) {
    const payload = { deliveryId: delivery.deliveryId, principalId: delivery.recipientPrincipalId, membershipEpoch: delivery.membershipEpoch, status }
    this.db.prepare('INSERT OR IGNORE INTO receipts(id,payload) VALUES (?,?)').run(JSON.stringify([delivery.deliveryId, status]), JSON.stringify(payload))
  }
  receive(delivery) {
    return this.transaction(() => {
      const member = this.member(delivery.conversationId, delivery.recipientPrincipalId, delivery.membershipEpoch)
      requireValue(delivery.event?.message?.messageId === delivery.messageId, 'INVALID_EVENT')
      const hash = digest(delivery), old = this.db.prepare('SELECT hash FROM inbox WHERE delivery_id=?').get(delivery.deliveryId)
      if (old) requireValue(old.hash === hash, 'DELIVERY_ID_CONFLICT')
      else {
        if (delivery.ai) requireValue(this.db.prepare("SELECT count(*) n FROM inbox WHERE ai=1 AND revoked=0 AND ai_state!='accepted'").get().n < this.maxPending, 'BACKPRESSURE')
        this.insertEvent(member, delivery.event)
        this.db.prepare('INSERT INTO inbox(delivery_id,message_id,conversation_id,principal_id,epoch,seq,ai,notify,hash,body) VALUES (?,?,?,?,?,?,?,?,?,?)').run(delivery.deliveryId, delivery.messageId, delivery.conversationId, delivery.recipientPrincipalId, delivery.membershipEpoch, delivery.event.conversationSeq, Number(delivery.ai), Number(delivery.notify), hash, JSON.stringify(delivery))
      }
      this.receiptInside(delivery, 'targetStored')
      const view = this.db.prepare('SELECT applied_seq,read_seq FROM view_watermarks WHERE conversation_id=? AND principal_id=? AND epoch=?').get(member.conversation_id, member.principal_id, member.epoch)
      if (view?.applied_seq >= delivery.event.conversationSeq) this.receiptInside(delivery, 'uiApplied')
      if (view?.read_seq >= delivery.event.conversationSeq && delivery.recipientPrincipalId.startsWith('human:')) this.receiptInside(delivery, 'humanRead')
      return this.advance(member)
    })
  }
  pendingReceipts() { return this.db.prepare("SELECT id,payload FROM receipts WHERE state='pending' ORDER BY rowid").all().map(row => ({ id: row.id, payload: JSON.parse(row.payload) })) }
  receiptAccepted(id) { this.db.prepare("UPDATE receipts SET state='accepted',error=NULL WHERE id=?").run(id) }
  receiptRejected(id, code) { this.db.prepare("UPDATE receipts SET state='failed',error=? WHERE id=?").run(code, id) }
  view(conversationId, principalId, epoch, { after = 0, before, limit = 100, latest = false } = {}) {
    this.member(conversationId, principalId, epoch)
    const upper = Math.min(before ?? Infinity, this.cursor(conversationId, principalId, epoch))
    requireValue(Number.isSafeInteger(after) && after >= 0 && Number.isSafeInteger(limit) && limit > 0 && limit <= 500, 'INVALID_CURSOR')
    const events = this.db.prepare(`SELECT body FROM events WHERE conversation_id=? AND principal_id=? AND epoch=? AND seq>? AND seq<=? ORDER BY seq ${latest ? 'DESC' : 'ASC'} LIMIT ?`).all(conversationId, principalId, epoch, after, upper, limit).map(row => JSON.parse(row.body))
    return latest ? events.reverse() : events
  }
  historyEdges(conversationId,principalId,epoch,events) {
    const member=this.member(conversationId,principalId,epoch),cursor=this.cursor(conversationId,principalId,epoch)
    const exists=(operator,seq)=>Boolean(this.db.prepare(`SELECT 1 FROM events WHERE conversation_id=? AND principal_id=? AND epoch=? AND seq>=? AND seq<=? AND seq${operator}? LIMIT 1`).get(conversationId,principalId,epoch,member.join_seq,cursor,seq))
    const first=events[0]?.conversationSeq,last=events.at(-1)?.conversationSeq
    return {hasEarlier:first!==undefined&&exists('<',first),hasLater:last!==undefined&&exists('>',last),nextBefore:first===undefined?null:first-1,nextAfter:last??null}
  }
  lastMessage(conversationId, principalId, epoch) {
    const member = this.member(conversationId, principalId, epoch)
    const row = this.db.prepare("SELECT body FROM events WHERE conversation_id=? AND principal_id=? AND epoch=? AND seq>=? AND seq<=? AND json_extract(body,'$.type')='message' ORDER BY seq DESC LIMIT 1")
      .get(conversationId, principalId, epoch, member.join_seq, this.cursor(conversationId, principalId, epoch))
    return row ? JSON.parse(row.body) : null
  }
  reference(conversationId, principalId, epoch, messageId) {
    this.member(conversationId, principalId, epoch)
    requireValue(typeof messageId === 'string', 'INVALID_REQUEST')
    const row = this.db.prepare("SELECT body FROM events WHERE conversation_id=? AND principal_id=? AND epoch=? AND seq<=? AND json_extract(body,'$.message.messageId')=?").get(
      conversationId, principalId, epoch, this.cursor(conversationId, principalId, epoch), messageId)
    requireValue(row, 'REFERENCE_NOT_AVAILABLE')
    return JSON.parse(row.body)
  }
  thread(conversationId, principalId, epoch, messageId, { after = 0, limit = 50, watermark } = {}) {
    const member = this.member(conversationId, principalId, epoch)
    requireValue(typeof messageId === 'string' && messageId.length > 0, 'INVALID_REQUEST')
    requireValue(Number.isSafeInteger(after) && after >= 0 && Number.isSafeInteger(limit) && limit > 0 && limit <= 100, 'INVALID_CURSOR')
    const cursor = this.cursor(conversationId, principalId, epoch)
    requireValue(watermark === undefined || Number.isSafeInteger(watermark) && watermark >= member.join_seq - 1 && watermark <= cursor, 'INVALID_CURSOR')
    const upper = watermark ?? cursor
    // Reply ancestry is a view of authorized canonical messages, not Bot causal
    // ancestry. Scope every recursive edge before following it; UNION ends cycles.
    const visible = `SELECT body,seq,json_extract(body,'$.message.messageId') id,json_extract(body,'$.message.replyToMessageId') parent FROM events WHERE conversation_id=? AND principal_id=? AND epoch=? AND seq>=? AND seq<=? AND json_extract(body,'$.type')='message'`
    const scope = [conversationId, principalId, epoch, member.join_seq, upper]
    const root = this.db.prepare(`WITH RECURSIVE visible AS (${visible}), ancestors AS (SELECT * FROM visible WHERE id=? UNION SELECT v.* FROM visible v JOIN ancestors a ON v.id=a.parent) SELECT * FROM ancestors ORDER BY seq LIMIT 1`).get(...scope, messageId)
    requireValue(root, 'REFERENCE_NOT_AVAILABLE')
    const rows = this.db.prepare(`WITH RECURSIVE visible AS (${visible}), descendants AS (SELECT * FROM visible WHERE id=? UNION SELECT v.* FROM visible v JOIN descendants d ON v.parent=d.id) SELECT body,seq FROM descendants WHERE seq>? ORDER BY seq LIMIT ?`).all(...scope, root.id, after, limit + 1)
    const events = rows.slice(0, limit).map(row => JSON.parse(row.body))
    const parentAvailable = !root.parent || Boolean(this.db.prepare(`WITH visible AS (${visible}) SELECT 1 FROM visible WHERE id=?`).get(...scope, root.parent))
    return { conversationId, membershipEpoch: epoch, messageId, rootMessageId: root.id, watermark: upper,
      earlierUnavailable: !parentAvailable, events, hasMore: rows.length > limit, nextAfter: events.at(-1)?.conversationSeq ?? after }
  }
  markView(conversationId, principalId, epoch, seq, { humanRead = false } = {}) {
    const member = this.member(conversationId, principalId, epoch)
    requireValue(Number.isSafeInteger(seq) && seq >= member.join_seq - 1 && seq <= this.cursor(conversationId, principalId, epoch), 'HISTORY_GAP')
    requireValue(!humanRead || principalId.startsWith('human:'), 'INVALID_RECEIPT')
    return this.transaction(() => {
      this.db.prepare('UPDATE view_watermarks SET applied_seq=max(applied_seq,?),read_seq=max(read_seq,?) WHERE conversation_id=? AND principal_id=? AND epoch=?').run(seq, humanRead ? seq : member.join_seq - 1, conversationId, principalId, epoch)
      for (const row of this.db.prepare('SELECT body,delivery_id FROM inbox WHERE conversation_id=? AND principal_id=? AND epoch=? AND seq<=? AND revoked=0').all(conversationId, principalId, epoch, seq)) {
        const delivery = JSON.parse(row.body)
        this.db.prepare('UPDATE inbox SET applied=1,human_read=max(human_read,?) WHERE delivery_id=?').run(Number(humanRead), row.delivery_id)
        this.receiptInside(delivery, 'uiApplied')
        if (humanRead) this.receiptInside(delivery, 'humanRead')
      }
    })
  }
  botDmReadKey(conversationId, principalId, epoch) { return `bot-dm-read:${JSON.stringify([conversationId,principalId,epoch])}` }
  botDmUnread(conversationId, principalId, epoch) {
    const member = this.member(conversationId, principalId, epoch)
    const read = Number(this.db.prepare('SELECT value FROM metadata WHERE key=?').get(this.botDmReadKey(conversationId,principalId,epoch))?.value ?? member.join_seq - 1)
    return this.db.prepare("SELECT count(*) count FROM events WHERE conversation_id=? AND principal_id=? AND epoch=? AND seq>? AND seq>=? AND seq<=? AND json_extract(body,'$.type')='message'").get(conversationId,principalId,epoch,read,member.join_seq,this.cursor(conversationId,principalId,epoch)).count
  }
  markBotDmRead(conversationId, principalId, epoch, seq) {
    const member = this.member(conversationId,principalId,epoch)
    requireValue(Number.isSafeInteger(seq) && seq >= member.join_seq - 1 && seq <= this.cursor(conversationId,principalId,epoch), 'HISTORY_GAP')
    this.db.prepare('INSERT INTO metadata VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=CAST(max(CAST(metadata.value AS INTEGER),CAST(excluded.value AS INTEGER)) AS TEXT)').run(this.botDmReadKey(conversationId,principalId,epoch),String(seq))
  }
  unread(conversationId, principalId, epoch) {
    this.member(conversationId, principalId, epoch)
    const read = this.db.prepare('SELECT read_seq FROM view_watermarks WHERE conversation_id=? AND principal_id=? AND epoch=?').get(conversationId, principalId, epoch)?.read_seq ?? 0
    return this.db.prepare("SELECT count(*) count FROM events WHERE conversation_id=? AND principal_id=? AND epoch=? AND seq>? AND seq<=? AND json_extract(body,'$.type')='message' AND json_extract(body,'$.message.author.principalId')!=?").get(conversationId, principalId, epoch, read, this.cursor(conversationId, principalId, epoch), principalId).count
  }
  pendingAi() {
    if (!this.authorized) return []
    return this.db.prepare(`SELECT i.body,i.ai_state,i.mapping FROM inbox i JOIN memberships m ON m.conversation_id=i.conversation_id AND m.principal_id=i.principal_id AND m.epoch=i.epoch JOIN cursors c ON c.conversation_id=i.conversation_id AND c.principal_id=i.principal_id AND c.epoch=i.epoch WHERE i.ai=1 AND i.revoked=0 AND i.ai_state NOT IN ('accepted','revoked') AND m.active=1 AND c.seq>=i.seq ORDER BY i.conversation_id,i.seq`).all().map(row => ({ ...JSON.parse(row.body), state: row.ai_state, mapping: row.mapping ? JSON.parse(row.mapping) : null }))
  }
  inputUpdates(binding, parentDeliveryId) {
    if (!this.authorized) return []
    const rows = this.db.prepare("SELECT * FROM inbox WHERE conversation_id=? AND principal_id=? AND epoch=? AND revoked=0 AND json_extract(body,'$.event.message.updateRecipientPrincipalId')=principal_id ORDER BY seq").all(binding.conversationId,binding.recipientPrincipalId,binding.membershipEpoch)
    return rows.flatMap(row => {
      const delivery=JSON.parse(row.body), message=delivery.event.message
      if(this.cursor(row.conversation_id,row.principal_id,row.epoch)<row.seq)return []
      const parent=this.db.prepare('SELECT delivery_id,mapping FROM inbox WHERE message_id=? AND principal_id=? AND epoch=? AND ai=1 AND revoked=0').get(message.updateForMessageId,row.principal_id,row.epoch)
      if(!parent || parentDeliveryId && parent.delivery_id!==parentDeliveryId)return []
      return [{...delivery,state:row.ai_state,mapping:row.mapping?JSON.parse(row.mapping):null,parentDeliveryId:parent.delivery_id,parentMapping:parent.mapping?JSON.parse(parent.mapping):null}]
    })
  }
  updateState(delivery, state, mapping) {
    requireValue(['injecting','accepted'].includes(state),'INVALID_AI_STATE')
    return this.transaction(()=>{
      const row=this.db.prepare('SELECT * FROM inbox WHERE delivery_id=?').get(delivery.deliveryId)
      requireValue(this.authorized && row && !row.revoked && !row.ai,'MEMBERSHIP_REVOKED')
      this.member(row.conversation_id,row.principal_id,row.epoch)
      const stored=JSON.parse(row.body)
      requireValue(stored.event?.message?.updateRecipientPrincipalId===row.principal_id && stored.event.message.updateForMessageId,'INVALID_INPUT_UPDATE')
      requireValue(state!=='accepted' || mapping?.sessionId && mapping.messageId && Number.isSafeInteger(mapping.seq),'INVALID_AI_MAPPING')
      if(row.ai_state==='accepted'){requireValue(row.mapping===JSON.stringify(mapping),'AI_MAPPING_CONFLICT');return}
      this.db.prepare('UPDATE inbox SET ai_state=?,mapping=? WHERE delivery_id=?').run(state,mapping?JSON.stringify(mapping):null,delivery.deliveryId)
      if(state==='accepted')this.receiptInside(stored,'updateRead')
    })
  }
  aiState(deliveryId, state, mapping = null) {
    requireValue(['injecting', 'injection_unknown', 'accepted'].includes(state), 'INVALID_AI_STATE')
    return this.transaction(() => {
      const row = this.db.prepare('SELECT * FROM inbox WHERE delivery_id=?').get(deliveryId)
      requireValue(this.authorized && row?.ai && !row.revoked, 'MEMBERSHIP_REVOKED')
      this.member(row.conversation_id, row.principal_id, row.epoch)
      requireValue(row.ai_state !== 'accepted' || state === 'accepted', 'INVALID_AI_STATE')
      requireValue(state !== 'accepted' || mapping?.sessionId && mapping.messageId && Number.isSafeInteger(mapping.seq), 'INVALID_AI_MAPPING')
      if (row.ai_state === 'accepted') { requireValue(row.mapping === JSON.stringify(mapping), 'AI_MAPPING_CONFLICT'); return }
      this.db.prepare('UPDATE inbox SET ai_state=?,mapping=? WHERE delivery_id=?').run(state, mapping ? JSON.stringify(mapping) : null, deliveryId)
      if (state === 'accepted') this.receiptInside(JSON.parse(row.body), 'aiAccepted')
    })
  }
  aiStarted(deliveryId) {
    return this.transaction(() => {
      const row = this.db.prepare('SELECT * FROM inbox WHERE delivery_id=?').get(deliveryId)
      requireValue(this.authorized && row?.ai && !row.revoked && row.principal_id.startsWith('bot:'), 'MEMBERSHIP_REVOKED')
      this.member(row.conversation_id, row.principal_id, row.epoch)
      requireValue(this.cursor(row.conversation_id, row.principal_id, row.epoch) >= row.seq, 'HISTORY_GAP')
      this.receiptInside(JSON.parse(row.body), 'aiStarted')
    })
  }
  applied(deliveryId, { humanRead = false } = {}) {
    return this.transaction(() => {
      const row = this.db.prepare('SELECT * FROM inbox WHERE delivery_id=?').get(deliveryId)
      requireValue(row && !row.revoked, 'MEMBERSHIP_REVOKED')
      this.member(row.conversation_id, row.principal_id, row.epoch)
      requireValue(this.cursor(row.conversation_id, row.principal_id, row.epoch) >= row.seq, 'HISTORY_GAP')
      requireValue(!humanRead || row.principal_id.startsWith('human:'), 'INVALID_RECEIPT')
      this.db.prepare('UPDATE inbox SET applied=1,human_read=max(human_read,?) WHERE delivery_id=?').run(Number(humanRead), deliveryId)
      const delivery = JSON.parse(row.body)
      this.receiptInside(delivery, 'uiApplied')
      if (humanRead) this.receiptInside(delivery, 'humanRead')
    })
  }
  replyTargets(bindingId, deliveryId) {
    const row = this.db.prepare('SELECT * FROM reply_targets WHERE delivery_id=?').get(deliveryId)
    requireValue(!row || row.binding_id === bindingId, 'CONVERSATION_SCOPE_MISMATCH')
    return row ? JSON.parse(row.targets) : []
  }
  stageReplyTargets(bindingId, deliveryId, targets, sourceKey) {
    return this.transaction(() => {
      const row = this.db.prepare('SELECT * FROM reply_targets WHERE delivery_id=?').get(deliveryId)
      const value = JSON.stringify(targets)
      if (row) { requireValue(row.binding_id === bindingId && row.targets === value, 'HANDOFF_ALREADY_SET'); return }
      requireValue(!this.db.prepare("SELECT 1 FROM outbox WHERE type='message.publish' AND json_extract(payload,'$.responseToDeliveryId')=?").get(deliveryId), 'RESPONSE_ALREADY_SENT')
      this.db.prepare('INSERT INTO reply_targets VALUES (?,?,?,?)').run(deliveryId, bindingId, value, sourceKey)
    })
  }
  completedToolReply(bindingId,deliveryId) {
    const row=this.db.prepare('SELECT * FROM tool_reply_completions WHERE delivery_id=?').get(deliveryId)
    requireValue(!row||row.binding_id===bindingId,'CONVERSATION_SCOPE_MISMATCH')
    return row?.message_id
  }
  recordDecision(binding, delivery, sourceKey, outcome, metadata = {}) {
    return this.transaction(() => {
      const old = this.db.prepare('SELECT * FROM outbound_decisions WHERE source_key=?').get(sourceKey)
      requireValue(!old || old.binding_id === binding.id && old.delivery_id === delivery.deliveryId, 'CONVERSATION_SCOPE_MISMATCH')
      this.db.prepare('INSERT INTO outbound_decisions VALUES (?,?,?,?,?) ON CONFLICT(source_key) DO UPDATE SET outcome=excluded.outcome,metadata=excluded.metadata')
        .run(sourceKey,binding.id,delivery.deliveryId,outcome,JSON.stringify({createdAt:old ? JSON.parse(old.metadata).createdAt : new Date().toISOString(),conversationId:binding.conversationId,principalId:binding.recipientPrincipalId,membershipEpoch:binding.membershipEpoch,...metadata}))
      if (outcome === 'no_reply') this.receiptInside(delivery,'noReply')
      return {status:outcome,sendsMessage:false}
    })
  }
  routingAudit(limit = 50) {
    requireValue(Number.isSafeInteger(limit) && limit >= 1 && limit <= 200, 'INVALID_REQUEST')
    const decisions = this.db.prepare('SELECT * FROM outbound_decisions ORDER BY rowid DESC LIMIT ?').all(limit).map(row => {
      const metadata = JSON.parse(row.metadata)
      const intent = metadata.messageId && this.db.prepare('SELECT state,error FROM outbox WHERE id=?').get(metadata.messageId)
      const receipt = row.outcome === 'no_reply' && this.db.prepare('SELECT state,error FROM receipts WHERE id=?').get(JSON.stringify([row.delivery_id,'noReply']))
      return {decisionId:row.source_key,bindingId:row.binding_id,sourceDeliveryId:row.delivery_id,outcome:row.outcome,...metadata,
        ...(intent ? {transport:{state:intent.state,error:intent.error}} : {}),...(receipt ? {controlReceipt:{state:receipt.state,error:receipt.error}} : {})}
    })
    const quarantined = this.db.prepare("SELECT id,error FROM outbox WHERE error='LEGACY_AUTO_EXPORT_QUARANTINED' ORDER BY rowid DESC LIMIT ?").all(limit)
    return {decisions,quarantined}
  }
  replyDeclined(deliveryId) { return Boolean(this.db.prepare("SELECT 1 FROM outbound_decisions WHERE delivery_id=? AND outcome='no_reply'").get(deliveryId)) }
  completeFinalExport(bindingId,deliveryId,output) {
    const messageId=this.completedToolReply(bindingId,deliveryId)
    requireValue(messageId && this.outboxStatus(messageId).state==='accepted','RESPONSE_NOT_ACCEPTED')
    return this.commitExports(bindingId,[output],[{sessionId:output.sessionId,seq:output.seq}],undefined,{completedDeliveryId:deliveryId})
  }
  commitExports(bindingId, outputs, positions, makeMessage, completion) {
    return this.transaction(() => {
      const ids = []
      for (const output of outputs) {
        const hash = digest(output), old = this.db.prepare('SELECT binding_id,source_hash,message_id FROM exports WHERE source_key=?').get(output.sourceKey)
        if (old) { requireValue(old.binding_id === bindingId && old.source_hash === hash, 'EXPORT_SOURCE_CONFLICT'); ids.push(old.message_id); continue }
          if(completion?.completedDeliveryId){
            const messageId=this.completedToolReply(bindingId,completion.completedDeliveryId)
            requireValue(messageId,'RESPONSE_NOT_COMPLETED')
            this.db.prepare('INSERT INTO exports VALUES (?,?,?,?)').run(output.sourceKey,bindingId,hash,messageId)
            ids.push(messageId);continue
          }
        const message = makeMessage(output)
        requireValue(this.owns(message.author?.principalId), 'AUTHOR_MISMATCH')
          if(completion?.deliveryId){
            requireValue(!this.completedToolReply(completion.bindingId,completion.deliveryId),'RESPONSE_ALREADY_SENT')
            requireValue(completion.explicit || !this.db.prepare('SELECT 1 FROM reply_targets WHERE delivery_id=?').get(completion.deliveryId),'HANDOFF_ALREADY_SET')
            this.db.prepare('INSERT INTO tool_reply_completions VALUES (?,?,?)').run(completion.deliveryId,completion.bindingId,message.messageId)
          }
        this.enqueueInside('message.publish', message, message.messageId)
        this.db.prepare('INSERT INTO exports VALUES (?,?,?,?)').run(output.sourceKey, bindingId, hash, message.messageId)
        ids.push(message.messageId)
      }
      for (const position of positions) {
        requireValue(Number.isSafeInteger(position.seq) && position.seq >= 0, 'INVALID_CURSOR')
        this.db.prepare('INSERT INTO export_cursors VALUES (?,?,?) ON CONFLICT(binding_id,session_id) DO UPDATE SET seq=max(seq,excluded.seq)').run(bindingId, position.sessionId, position.seq)
      }
      return ids
    })
  }
}
