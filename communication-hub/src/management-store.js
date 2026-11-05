import { createHash, createPublicKey, randomBytes, randomUUID, verify } from 'node:crypto'
import { identifier, requireThat, hash } from './protocol.js'
import { signedHubCode } from './hub-code.js'
import { deleteDevice } from './delete-device.js'

const digest = value => createHash('sha256').update(value).digest('hex')
const day = 86400000
export const enrollmentTranscript = challenge => JSON.stringify(['dsbot-enrollment/1', challenge.hubId, challenge.purpose,
  challenge.challengeId, challenge.nonce, challenge.requestId ?? '', challenge.instanceId ?? '', challenge.expiresAt])
export function hubCode(hubId, url) {
  const parsed = new URL(url)
  requireThat(parsed.protocol === 'wss:' || parsed.protocol === 'ws:' && ['127.0.0.1', '[::1]'].includes(parsed.hostname), 'TLS_REQUIRED')
  requireThat(!parsed.username && !parsed.password && !parsed.search && !parsed.hash && parsed.pathname === '/communication', 'INVALID_CONFIG')
  return `dsbot-hub:1:${Buffer.from(JSON.stringify({ hubId, url: parsed.href })).toString('base64url')}`
}

// All durable enrollment and consent state shares the Hub transaction boundary.
export class HubManagement {
  constructor(store, { now = Date.now, url, maxPendingJoins = 64, pairingTrust } = {}) {
    this.store = store; this.db = store.db; this.now = now; this.url = url; this.maxPendingJoins = maxPendingJoins
    this.challenges = new Map()
    this.pairingTrust = pairingTrust
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS hub_management (key TEXT PRIMARY KEY,value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS hub_join_requests (id TEXT PRIMARY KEY,public_key TEXT NOT NULL,label TEXT NOT NULL,status TEXT NOT NULL,created_at INTEGER NOT NULL,expires_at INTEGER NOT NULL,version INTEGER NOT NULL DEFAULT 1,instance_id TEXT);
      CREATE TABLE IF NOT EXISTS hub_enrolled_peers (instance_id TEXT PRIMARY KEY REFERENCES instances(id),public_key TEXT NOT NULL UNIQUE,revision INTEGER NOT NULL DEFAULT 1);
      CREATE TABLE IF NOT EXISTS hub_user_codes (principal_id TEXT PRIMARY KEY REFERENCES principals(id),code TEXT NOT NULL UNIQUE,code_hash TEXT NOT NULL UNIQUE);
      CREATE TABLE IF NOT EXISTS hub_code_tombstones (code_hash TEXT PRIMARY KEY);
      CREATE TABLE IF NOT EXISTS hub_contact_requests (id TEXT PRIMARY KEY,sender TEXT NOT NULL REFERENCES principals(id),target TEXT REFERENCES principals(id),scope TEXT NOT NULL,status TEXT NOT NULL,expires_at INTEGER NOT NULL,version INTEGER NOT NULL DEFAULT 1);
      CREATE TABLE IF NOT EXISTS hub_contacts (pair TEXT PRIMARY KEY,left_id TEXT NOT NULL,right_id TEXT NOT NULL,left_scope TEXT NOT NULL,right_scope TEXT NOT NULL,active INTEGER NOT NULL,epoch TEXT NOT NULL,version INTEGER NOT NULL DEFAULT 1);
      CREATE TABLE IF NOT EXISTS hub_management_operations (id TEXT PRIMARY KEY,actor TEXT NOT NULL,hash TEXT NOT NULL,result TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS hub_rate_limits (key TEXT PRIMARY KEY,window INTEGER NOT NULL,count INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS hub_admin_audit (id INTEGER PRIMARY KEY,at INTEGER NOT NULL,action TEXT NOT NULL,subject TEXT NOT NULL);
    `)
    this.db.prepare('INSERT OR IGNORE INTO hub_management VALUES (?,?)').run('hubId', randomUUID())
    this.hubId = this.db.prepare('SELECT value FROM hub_management WHERE key=?').get('hubId').value
  }
  info() { return { hubId: this.hubId, ...(this.url ? { url: this.url, code: this.pairingTrust
    ? signedHubCode(this.hubId, this.url, { ...this.pairingTrust, now: this.now() }) : hubCode(this.hubId, this.url) } : {}) } }
  rate(key, limit = 20, windowMs = 60000) {
    const window = Math.floor(this.now() / windowMs) * windowMs, id = digest(key)
    this.db.prepare('DELETE FROM hub_rate_limits WHERE window<?').run(this.now() - 2 * day)
    this.db.prepare('INSERT INTO hub_rate_limits VALUES (?,?,1) ON CONFLICT(key) DO UPDATE SET count=CASE WHEN window=excluded.window THEN count+1 ELSE 1 END,window=excluded.window').run(id, window)
    requireThat(this.db.prepare('SELECT count FROM hub_rate_limits WHERE key=?').get(id).count <= limit, 'RATE_LIMITED')
  }
  cleanup() {
    this.db.prepare("UPDATE hub_join_requests SET status='expired',version=version+1 WHERE status='pending' AND expires_at<=?").run(this.now())
    this.db.prepare("UPDATE hub_contact_requests SET status='expired',version=version+1 WHERE status='pending' AND expires_at<=?").run(this.now())
    for (const [id, challenge] of this.challenges) if (challenge.expiresAt <= this.now()) this.challenges.delete(id)
  }
  peer(instanceId) { return this.db.prepare('SELECT * FROM hub_enrolled_peers WHERE instance_id=?').get(instanceId) }
  challenge(binding, input, address = 'local') {
    this.cleanup(); this.rate('challenge:global', 300); this.rate(`challenge:${address}`, 30)
    requireThat(['join', 'status', 'cancel', 'login', 'leave', 'leave-status'].includes(input.purpose), 'INVALID_REQUEST')
    requireThat(this.challenges.size < 512, 'JOIN_LIMIT')
    let publicKey, requestId, instanceId, authRevision
    if (input.purpose === 'join') {
      requireThat(typeof input.publicKey === 'string' && input.publicKey.length <= 2048, 'INVALID_REQUEST')
      let key
      try { key = createPublicKey(input.publicKey) } catch { requireThat(false, 'INVALID_REQUEST') }
      requireThat(key.asymmetricKeyType === 'ed25519', 'INVALID_REQUEST')
      publicKey = key.export({ type: 'spki', format: 'pem' }).toString()
      requireThat(!this.db.prepare('SELECT 1 FROM hub_enrolled_peers WHERE public_key=?').get(publicKey), 'ALREADY_ENROLLED')
      requestId = randomUUID()
    } else if (['login','leave','leave-status'].includes(input.purpose)) {
      instanceId = identifier(input.instanceId)
      const peer = this.peer(instanceId)
      requireThat(peer && (input.purpose!=='login'||this.db.prepare('SELECT trusted FROM instances WHERE id=?').get(instanceId)?.trusted === 1), 'UNAUTHENTICATED')
      publicKey = peer.public_key
      authRevision = peer.revision
    } else {
      requestId = identifier(input.requestId)
      const request = this.db.prepare('SELECT public_key FROM hub_join_requests WHERE id=?').get(requestId)
      requireThat(request, 'JOIN_NOT_FOUND'); publicKey = request.public_key
    }
    const value = { challengeId: randomUUID(), nonce: randomBytes(32).toString('base64url'), hubId: this.hubId,
      purpose: input.purpose, ...(requestId ? { requestId } : {}), ...(instanceId ? { instanceId } : {}), expiresAt: this.now() + 60000 }
    this.challenges.set(value.challengeId, { ...value, binding, publicKey, authRevision })
    return value
  }
  forget(binding) { for (const [id, item] of this.challenges) if (item.binding === binding) this.challenges.delete(id) }
  prove(binding, input) {
    const item = this.challenges.get(input.challengeId)
    requireThat(item && item.binding === binding, 'UNAUTHENTICATED')
    this.challenges.delete(input.challengeId)
    requireThat(item.expiresAt > this.now(), 'CHALLENGE_EXPIRED')
    requireThat(typeof input.signature === 'string' && input.signature.length <= 128 && /^[A-Za-z0-9_-]+$/.test(input.signature), 'UNAUTHENTICATED')
    requireThat(verify(null, Buffer.from(enrollmentTranscript(item)), item.publicKey, Buffer.from(input.signature, 'base64url')), 'UNAUTHENTICATED')
    this.cleanup()
    if (['login','leave','leave-status'].includes(item.purpose)) {
      const peer = this.peer(item.instanceId)
      requireThat(peer?.public_key === item.publicKey && peer.revision === item.authRevision, 'UNAUTHENTICATED')
      const row = this.db.prepare('SELECT label,trusted FROM instances WHERE id=?').get(item.instanceId)
      if(item.purpose!=='login'){
        requireThat(row,'UNAUTHENTICATED')
        if(item.purpose==='leave'&&row.trusted===1){
          requireThat(!this.db.prepare('SELECT 1 FROM conversations c JOIN principals p ON p.id=c.owner_id WHERE p.instance_id=? AND c.closed=0').get(item.instanceId),'OWNER_TRANSFER_REQUIRED')
          this.revoke(item.instanceId)
          this.audit('instance.leave',item.instanceId)
        }
        return {instanceId:item.instanceId,left:item.purpose==='leave'||row.trusted===0}
      }
      requireThat(row?.trusted === 1, 'UNAUTHENTICATED')
      return { instanceId: item.instanceId, label: row.label }
    }
    if (item.purpose === 'join') {
      requireThat(typeof input.displayName === 'string' && input.displayName.trim() && input.displayName.length <= 100, 'INVALID_REQUEST')
      return this.store.transaction(() => {
        requireThat(!this.db.prepare('SELECT 1 FROM hub_enrolled_peers WHERE public_key=?').get(item.publicKey), 'ALREADY_ENROLLED')
        const old = this.db.prepare("SELECT id FROM hub_join_requests WHERE public_key=? AND status='pending'").get(item.publicKey)
        requireThat(!old, 'JOIN_ALREADY_PENDING')
        requireThat(this.db.prepare("SELECT count(*) n FROM hub_join_requests WHERE status='pending'").get().n < this.maxPendingJoins, 'JOIN_LIMIT')
        this.db.prepare('INSERT INTO hub_join_requests(id,public_key,label,status,created_at,expires_at) VALUES (?,?,?,?,?,?)').run(item.requestId, item.publicKey, input.displayName.trim(), 'pending', this.now(), this.now() + day)
        return { requestId: item.requestId, status: 'pending' }
      })
    }
    if (item.purpose === 'cancel') this.db.prepare("UPDATE hub_join_requests SET status='cancelled',version=version+1 WHERE id=? AND status='pending'").run(item.requestId)
    const row = this.db.prepare('SELECT * FROM hub_join_requests WHERE id=?').get(item.requestId)
    return { requestId: row.id, status: row.status, ...(row.instance_id ? { instanceId: row.instance_id } : {}) }
  }
  joins() {
    this.cleanup()
    return this.db.prepare('SELECT id requestId,label,status,created_at createdAt,expires_at expiresAt,version,instance_id instanceId,public_key FROM hub_join_requests ORDER BY created_at DESC LIMIT 200').all()
      .map(({ public_key, ...row }) => ({ ...row, fingerprint: digest(public_key) }))
  }
  audit(action, subject) { this.db.prepare('INSERT INTO hub_admin_audit(at,action,subject) VALUES (?,?,?)').run(this.now(), action, subject) }
  decide(input) {
    this.cleanup(); identifier(input.requestId)
    requireThat(['approve', 'reject'].includes(input.action), 'INVALID_REQUEST')
    return this.store.transaction(() => {
      const row = this.db.prepare('SELECT * FROM hub_join_requests WHERE id=?').get(input.requestId)
      requireThat(row && row.status === 'pending' && row.version === input.expectedVersion, 'JOIN_VERSION_CONFLICT')
      if (input.action === 'reject') {
        this.db.prepare("UPDATE hub_join_requests SET status='rejected',version=version+1 WHERE id=?").run(row.id)
        this.audit('join.reject', row.id); return { requestId: row.id, status: 'rejected' }
      }
      const id = randomUUID()
      requireThat(this.store.activePrincipalCount() < this.store.limits.maxPrincipals, 'DIRECTORY_FULL')
      requireThat(!this.db.prepare('SELECT 1 FROM hub_enrolled_peers WHERE public_key=?').get(row.public_key), 'ALREADY_ENROLLED')
      this.db.prepare('INSERT INTO instances(id,label) VALUES (?,?)').run(id, row.label)
      this.db.prepare('INSERT INTO hub_enrolled_peers(instance_id,public_key) VALUES (?,?)').run(id, row.public_key)
      const principalId = `human:${id}:local-user`
      this.db.prepare('INSERT INTO principals VALUES (?,?,?,?,?)').run(principalId, id, 'human', 'local-user', row.label)
      this.ensureCode(principalId)
      this.db.prepare("UPDATE hub_join_requests SET status='approved',instance_id=?,version=version+1 WHERE id=?").run(id, row.id)
      this.audit('join.approve', id)
      return { requestId: row.id, status: 'approved', instanceId: id }
    })
  }
  instances() { return this.db.prepare('SELECT i.id instanceId,i.label,i.trusted,i.pairing_revision pairingRevision,p.revision,coalesce(n.version,0) nameVersion FROM instances i LEFT JOIN hub_enrolled_peers p ON p.instance_id=i.id LEFT JOIN hub_instance_names n ON n.instance_id=i.id ORDER BY i.id').all().map(instance => ({ ...instance, connected: this.isInstanceConnected?.(instance.instanceId) === true, ownedSharedGroups: this.db.prepare("SELECT c.id conversationId,c.title,c.version FROM conversations c JOIN principals owner ON owner.id=c.owner_id WHERE owner.instance_id=? AND c.kind='group' AND c.closed=0 AND EXISTS (SELECT 1 FROM memberships m JOIN principals p ON p.id=m.principal_id WHERE m.conversation_id=c.id AND p.instance_id<>?) ORDER BY c.id").all(instance.instanceId, instance.instanceId) })) }
  rename(input) {
    requireThat(input && typeof input === 'object' && !Array.isArray(input) && Object.keys(input).every(key => ['instanceId', 'label', 'expectedNameVersion'].includes(key)), 'INVALID_REQUEST')
    identifier(input.instanceId)
    requireThat(typeof input.label === 'string' && input.label.trim().length > 0 && input.label.length <= 100 && !/[\u0000-\u001f\u007f]/.test(input.label), 'INVALID_REQUEST')
    requireThat(Number.isSafeInteger(input.expectedNameVersion) && input.expectedNameVersion >= 0, 'INVALID_REQUEST')
    return this.store.transaction(() => {
      const row = this.db.prepare('SELECT i.id,coalesce(n.version,0) version FROM instances i LEFT JOIN hub_instance_names n ON n.instance_id=i.id WHERE i.id=?').get(input.instanceId)
      requireThat(row, 'INSTANCE_NOT_FOUND')
      requireThat(row.version === input.expectedNameVersion, 'INSTANCE_NAME_VERSION_CONFLICT')
      const label = input.label.trim(), version = row.version + 1
      this.db.prepare('INSERT INTO hub_instance_names VALUES (?,?,?) ON CONFLICT(instance_id) DO UPDATE SET label=excluded.label,version=excluded.version').run(row.id, label, version)
      this.db.prepare('UPDATE instances SET label=? WHERE id=?').run(label, row.id)
      this.audit('admin.instance.rename', row.id)
      return { instanceId: row.id, label, nameVersion: version }
    })
  }
  revoke(instanceId) { identifier(instanceId); const result = this.store.revokeInstance(instanceId); this.audit('instance.revoke', instanceId); return result }
  delete(input) { return deleteDevice(this, input) }
  repair(input) {
    identifier(input.instanceId)
    requireThat(Object.keys(input).every(key => ['instanceId', 'expectedRevision'].includes(key)), 'INVALID_REQUEST')
    requireThat(Number.isSafeInteger(input.expectedRevision) && input.expectedRevision > 0, 'INVALID_REQUEST')
    return this.store.transaction(() => {
      const row = this.db.prepare('SELECT i.trusted,i.pairing_revision,p.revision FROM instances i JOIN hub_enrolled_peers p ON p.instance_id=i.id WHERE i.id=?').get(input.instanceId)
      requireThat(row && row.trusted === 0 && row.revision === input.expectedRevision && row.pairing_revision === input.expectedRevision, 'PAIRING_REVISION_CONFLICT')
      const ownCount=this.db.prepare('SELECT count(*) n FROM principals WHERE instance_id=?').get(input.instanceId).n
      requireThat(this.store.activePrincipalCount()+ownCount<=this.store.limits.maxPrincipals,'DIRECTORY_FULL')
      // Same update as configurePeer, inside this transaction's revision CAS.
      // Authentication retains the previously proved key; no membership is restored.
      this.db.prepare('UPDATE instances SET trusted=1,epoch=epoch+1,pairing_revision=pairing_revision+1 WHERE id=?').run(input.instanceId)
      this.db.prepare('UPDATE hub_enrolled_peers SET revision=revision+1 WHERE instance_id=?').run(input.instanceId)
      this.audit('instance.repair', input.instanceId)
      return { instanceId: input.instanceId, pairingRevision: input.expectedRevision + 1, trusted: true }
    })
  }
  human(auth, principalId) { const p = this.store.principal(auth, principalId); requireThat(p.kind === 'human', 'HUMAN_REQUIRED'); return p }
  ensureCode(principalId) {
    let row = this.db.prepare('SELECT code FROM hub_user_codes WHERE principal_id=?').get(principalId)
    if (!row) {
      let code
      do { code = randomBytes(12).toString('hex').toUpperCase().match(/.{1,4}/g).join('-') }
      while (this.db.prepare('SELECT 1 FROM hub_code_tombstones WHERE code_hash=?').get(digest(code)) || this.db.prepare('SELECT 1 FROM hub_user_codes WHERE code_hash=?').get(digest(code)))
      this.db.prepare('INSERT INTO hub_user_codes VALUES (?,?,?)').run(principalId, code, digest(code)); row = { code }
    }
    return row.code
  }
  code(auth, input) { this.human(auth, input.principalId); return { userCode: this.ensureCode(input.principalId), hubId: this.hubId } }
  rotateCode(auth, input) {
    return this.op(auth, { ...input, action: 'rotate-code' }, () => {
      const old = this.db.prepare('SELECT code_hash FROM hub_user_codes WHERE principal_id=?').get(input.principalId)
      if (old) this.db.prepare('INSERT OR IGNORE INTO hub_code_tombstones VALUES (?)').run(old.code_hash)
      this.db.prepare('DELETE FROM hub_user_codes WHERE principal_id=?').run(input.principalId)
      return { userCode: this.ensureCode(input.principalId), hubId: this.hubId }
    })
  }
  scope(auth, ids = []) {
    requireThat(Array.isArray(ids) && ids.length <= this.store.limits.maxPrincipals && new Set(ids).size === ids.length, 'INVALID_REQUEST')
    for (const id of ids) requireThat(this.store.principal(auth, identifier(id)).kind === 'bot', 'INVALID_REQUEST')
    return JSON.stringify([...ids].sort())
  }
  op(auth, input, work) {
    identifier(input.operationId); this.human(auth, input.principalId)
    return this.store.transaction(() => {
      const old = this.db.prepare('SELECT * FROM hub_management_operations WHERE id=?').get(input.operationId), fingerprint = hash(input)
      if (old) { requireThat(old.actor === input.principalId && old.hash === fingerprint, 'OPERATION_ID_CONFLICT'); return JSON.parse(old.result) }
      const result = work()
      this.db.prepare('INSERT INTO hub_management_operations VALUES (?,?,?,?)').run(input.operationId, input.principalId, fingerprint, JSON.stringify(result))
      return result
    })
  }
  requestContact(auth, input) {
    requireThat(typeof input.userCode === 'string' && input.userCode.length <= 64, 'INVALID_REQUEST')
    return this.op(auth, input, () => {
      this.rate('contact:global', 100); this.rate(`contact:${auth.instanceId}`, 10)
      const scope = this.scope(auth, input.botPrincipalIds)
      this.cleanup()
      // A private rejection must not reveal itself by freeing a sender-visible slot.
      requireThat(this.db.prepare("SELECT count(*) n FROM hub_contact_requests WHERE sender=? AND (status='pending' OR (status='rejected' AND expires_at>?))").get(input.principalId, this.now()).n < 20, 'CONTACT_LIMIT')
      const code = input.userCode.toUpperCase().replace(/[^A-F0-9]/g, '').match(/.{1,4}/g)?.join('-') ?? ''
      const found = this.db.prepare('SELECT principal_id FROM hub_user_codes WHERE code_hash=?').get(digest(code))?.principal_id
      let target = found && found !== input.principalId && !found.startsWith(`human:${auth.instanceId}:`) ? found : null
      if (target) {
        try { this.rate(`contact-target:${target}`, 30, day) }
        catch (error) { if (error.code !== 'RATE_LIMITED') throw error; target = null }
      }
      this.db.prepare('INSERT INTO hub_contact_requests(id,sender,target,scope,status,expires_at) VALUES (?,?,?,?,?,?)').run(input.operationId, input.principalId, target, scope, 'pending', this.now() + day)
      return { requestId: input.operationId, status: 'pending' }
    })
  }
  contactRequestState(row, principalId) {
    if (row.sender !== principalId) return { status: row.status, version: row.version }
    const status = row.status === 'rejected' ? row.expires_at <= this.now() ? 'expired' : 'pending' : row.status
    // Sender versions track visible transitions, so a private rejection cannot be
    // inferred from a version change or prevent cancellation of the visible request.
    return { status, version: status === 'pending' ? 1 : 2 }
  }
  contactRequests(auth, input) {
    this.human(auth, input.principalId); this.cleanup()
    return this.db.prepare('SELECT * FROM hub_contact_requests WHERE sender=? OR target=? ORDER BY rowid DESC LIMIT 100').all(input.principalId, input.principalId).map(row => ({
      requestId: row.id, direction: row.target === input.principalId ? 'incoming' : 'outgoing',
      ...this.contactRequestState(row, input.principalId), expiresAt: row.expires_at,
      ...(row.target === input.principalId ? { senderPrincipalId: row.sender, senderName: this.db.prepare('SELECT name FROM principals WHERE id=?').get(row.sender).name } : {}),
    }))
  }
  cancelContactRequests(left, right, except = '') {
    this.db.prepare("UPDATE hub_contact_requests SET status='cancelled',version=version+1 WHERE (status='pending' OR (status='rejected' AND expires_at>?)) AND id<>? AND ((sender=? AND target=?) OR (sender=? AND target=?))")
      .run(this.now(), except, left, right, right, left)
  }
  respondContact(auth, input, action) {
    requireThat(['accept', 'reject', 'cancel'].includes(action), 'INVALID_REQUEST')
    return this.op(auth, { ...input, action }, () => {
      const scope = action === 'accept' ? this.scope(auth, input.botPrincipalIds) : '[]'
      this.cleanup()
      const row = this.db.prepare('SELECT * FROM hub_contact_requests WHERE id=?').get(input.requestId)
      const state = row && this.contactRequestState(row, input.principalId)
      requireThat(state?.status === 'pending' && state.version === input.expectedVersion, 'CONTACT_VERSION_CONFLICT')
      requireThat(action === 'cancel' ? row.sender === input.principalId : row.target === input.principalId, 'FORBIDDEN')
      if (action === 'accept') {
        const senderInstance = this.db.prepare('SELECT instance_id FROM principals WHERE id=?').get(row.sender)?.instance_id
        requireThat(this.db.prepare('SELECT trusted FROM instances WHERE id=?').get(senderInstance)?.trusted === 1, 'CONTACT_UNAVAILABLE')
        const pair = [row.sender, row.target].sort(), leftScope = pair[0] === row.sender ? row.scope : scope, rightScope = pair[1] === row.target ? scope : row.scope
        const previous = this.db.prepare('SELECT * FROM hub_contacts WHERE pair=?').get(JSON.stringify(pair))
        if (previous?.active) this.fenceDms(previous, 'contact.changed')
        this.db.prepare('INSERT INTO hub_contacts VALUES (?,?,?,?,?,1,?,1) ON CONFLICT(pair) DO UPDATE SET left_scope=excluded.left_scope,right_scope=excluded.right_scope,active=1,epoch=excluded.epoch,version=version+1').run(JSON.stringify(pair), ...pair, leftScope, rightScope, randomUUID())
        // Concurrent older requests must not silently replace an established scope.
        this.cancelContactRequests(row.sender, row.target, row.id)
      }
      this.db.prepare('UPDATE hub_contact_requests SET status=?,version=version+1 WHERE id=?').run(action === 'accept' ? 'accepted' : action === 'reject' ? 'rejected' : 'cancelled', row.id)
      return { requestId: row.id, status: action === 'accept' ? 'accepted' : action === 'reject' ? 'rejected' : 'cancelled' }
    })
  }
  revokeContact(auth, input) {
    return this.op(auth, input, () => {
      this.cleanup()
      const pair = [input.principalId, identifier(input.otherHumanPrincipalId)].sort()
      const row = this.db.prepare('SELECT * FROM hub_contacts WHERE pair=?').get(JSON.stringify(pair))
      requireThat(row && row.active && row.version === input.expectedVersion, 'CONTACT_VERSION_CONFLICT')
      this.db.prepare('UPDATE hub_contacts SET active=0,epoch=?,version=version+1 WHERE pair=?').run(randomUUID(), row.pair)
      this.fenceDms(row, 'contact.revoked')
      this.cancelContactRequests(...pair)
      return { revoked: true }
    })
  }
  fenceDms(relation, reason) {
    const left = JSON.stringify([relation.left_id, ...JSON.parse(relation.left_scope)]), right = JSON.stringify([relation.right_id, ...JSON.parse(relation.right_scope)])
    const conversations = this.db.prepare(`SELECT c.id FROM conversations c WHERE c.kind='dm'
      AND EXISTS(SELECT 1 FROM memberships m WHERE m.conversation_id=c.id AND m.principal_id IN (SELECT value FROM json_each(?)))
      AND EXISTS(SELECT 1 FROM memberships m WHERE m.conversation_id=c.id AND m.principal_id IN (SELECT value FROM json_each(?)))`).all(left, right)
    for (const { id } of conversations) {
      this.db.prepare('UPDATE deliveries SET revoked=1 WHERE ai_accepted=0 AND message_id IN (SELECT id FROM messages WHERE conversation_id=?)').run(id)
      for (const member of this.db.prepare('SELECT principal_id FROM memberships WHERE conversation_id=?').all(id)) {
        this.db.prepare('UPDATE memberships SET epoch=? WHERE conversation_id=? AND principal_id=?').run(randomUUID(), id, member.principal_id)
      }
      this.db.prepare('UPDATE conversations SET version=version+1 WHERE id=?').run(id)
      this.store.event(id, 'conversation.contactChanged', { reason })
    }
  }
  owner(principalId) {
    const principal = this.db.prepare('SELECT id,kind,instance_id FROM principals WHERE id=?').get(principalId)
    if (principal?.kind === 'human') return principal.id
    return principal && this.db.prepare("SELECT id FROM principals WHERE instance_id=? AND kind='human' ORDER BY id LIMIT 1").get(principal.instance_id)?.id
  }
  canContact(actorId, targetId) {
    const actor = this.db.prepare('SELECT * FROM principals WHERE id=?').get(actorId), target = this.db.prepare('SELECT * FROM principals WHERE id=?').get(targetId)
    if (!actor || !target) return false
    if (actor.instance_id === target.instance_id) return true
    const a = this.owner(actorId), b = this.owner(targetId)
    const row = a && b && this.db.prepare('SELECT * FROM hub_contacts WHERE pair=?').get(JSON.stringify([a, b].sort()))
    if (!row) return !this.peer(actor.instance_id) && !this.peer(target.instance_id)
    if (!row.active) return false
    const permits = id => { const human = this.owner(id); return id === human || JSON.parse(human === row.left_id ? row.left_scope : row.right_scope).includes(id) }
    return permits(actorId) && permits(targetId)
  }
  filterDirectory(auth, rows, principalId) {
    this.store.check(auth)
    if (principalId !== undefined) this.store.principal(auth, principalId)
    const actors = principalId !== undefined ? [{ id: principalId }] : this.db.prepare('SELECT id FROM principals WHERE instance_id=?').all(auth.instanceId)
    return rows.filter(row => actors.some(actor => this.canContact(actor.id, row.principalId)))
  }
  assertContact(auth, actorId, targetId) { this.store.principal(auth, actorId); requireThat(this.canContact(actorId, targetId), 'CONTACT_REQUIRED') }
  assertDm(conversationId) {
    const c = this.db.prepare('SELECT kind FROM conversations WHERE id=?').get(conversationId)
    if (c?.kind !== 'dm') return
    const ids = this.db.prepare('SELECT principal_id FROM memberships WHERE conversation_id=?').all(conversationId).map(m => m.principal_id)
    requireThat(ids.length === 2 && this.canContact(...ids), 'CONTACT_REQUIRED')
  }
  relations(auth, input) {
    this.human(auth, input.principalId)
    return this.db.prepare('SELECT * FROM hub_contacts WHERE left_id=? OR right_id=?').all(input.principalId, input.principalId).map(row => ({ otherHumanPrincipalId: row.left_id === input.principalId ? row.right_id : row.left_id, active: Boolean(row.active), version: row.version, contactEpoch: row.epoch, botPrincipalIds: JSON.parse(row.left_id === input.principalId ? row.left_scope : row.right_scope) }))
  }
}
