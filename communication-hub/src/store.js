import { DatabaseSync } from 'node:sqlite'
import { randomUUID } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { CAPABILITIES, DEFAULT_LIMITS, PROTOCOL, CommunicationError, hash, identifier, normalizeMessage, requireThat, responseBytes } from './protocol.js'

export class HubStore {
  constructor(path, { limits = {}, beforeCommit } = {}) {
    this.limits = { ...DEFAULT_LIMITS, ...limits }
    for (const value of Object.values(this.limits)) requireThat(Number.isSafeInteger(value) && value > 0, 'INVALID_CONFIG')
    this.beforeCommit = beforeCommit
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true })
    this.db = new DatabaseSync(path)
    const version=this.db.prepare('PRAGMA user_version').get().user_version
    if(version>2){this.db.close();throw new CommunicationError('SCHEMA_VERSION_UNSUPPORTED')}
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS schema_version (version INTEGER PRIMARY KEY);
      INSERT OR IGNORE INTO schema_version VALUES (1);
      CREATE TABLE IF NOT EXISTS instances (id TEXT PRIMARY KEY, epoch INTEGER NOT NULL DEFAULT 0, label TEXT NOT NULL, trusted INTEGER NOT NULL DEFAULT 1, pairing_revision INTEGER NOT NULL DEFAULT 1);
      CREATE TABLE IF NOT EXISTS principals (id TEXT PRIMARY KEY, instance_id TEXT NOT NULL REFERENCES instances(id), kind TEXT NOT NULL, local_id TEXT NOT NULL, name TEXT NOT NULL, UNIQUE(instance_id,kind,local_id));
      CREATE TABLE IF NOT EXISTS conversations (id TEXT PRIMARY KEY, kind TEXT NOT NULL, dm_key TEXT UNIQUE, title TEXT NOT NULL, seq INTEGER NOT NULL DEFAULT 0, version INTEGER NOT NULL DEFAULT 1, routing_mode TEXT NOT NULL, admin_bot TEXT);
      CREATE TABLE IF NOT EXISTS memberships (conversation_id TEXT NOT NULL REFERENCES conversations(id), principal_id TEXT NOT NULL REFERENCES principals(id), epoch TEXT NOT NULL, join_seq INTEGER NOT NULL, active INTEGER NOT NULL, manager INTEGER NOT NULL, PRIMARY KEY(conversation_id,principal_id));
      CREATE TABLE IF NOT EXISTS events (conversation_id TEXT NOT NULL REFERENCES conversations(id), seq INTEGER NOT NULL, id TEXT NOT NULL UNIQUE, type TEXT NOT NULL, body TEXT NOT NULL, PRIMARY KEY(conversation_id,seq));
      CREATE TABLE IF NOT EXISTS messages (id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL REFERENCES conversations(id), seq INTEGER NOT NULL, hash TEXT NOT NULL, author_id TEXT NOT NULL, body TEXT NOT NULL, accepted_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS deliveries (id TEXT PRIMARY KEY, message_id TEXT NOT NULL REFERENCES messages(id), recipient_id TEXT NOT NULL REFERENCES principals(id), membership_epoch TEXT NOT NULL, routing_version INTEGER NOT NULL, notify INTEGER NOT NULL, ai INTEGER NOT NULL, stored INTEGER NOT NULL DEFAULT 0, applied INTEGER NOT NULL DEFAULT 0, human_read INTEGER NOT NULL DEFAULT 0, ai_accepted INTEGER NOT NULL DEFAULT 0, revoked INTEGER NOT NULL DEFAULT 0, UNIQUE(message_id,recipient_id));
      CREATE INDEX IF NOT EXISTS pending_recipient ON deliveries(recipient_id,stored,revoked);
      CREATE TABLE IF NOT EXISTS operations (id TEXT PRIMARY KEY, instance_id TEXT NOT NULL, hash TEXT NOT NULL, result TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS invites (id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL REFERENCES conversations(id), principal_id TEXT NOT NULL REFERENCES principals(id), inviter_id TEXT NOT NULL REFERENCES principals(id), active INTEGER NOT NULL DEFAULT 1);
      CREATE TABLE IF NOT EXISTS cursors (conversation_id TEXT NOT NULL, principal_id TEXT NOT NULL, membership_epoch TEXT NOT NULL, seq INTEGER NOT NULL, PRIMARY KEY(conversation_id,principal_id,membership_epoch));
      CREATE TABLE IF NOT EXISTS instance_addresses (instance_id TEXT PRIMARY KEY REFERENCES instances(id), address TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS principal_preferences (principal_id TEXT PRIMARY KEY REFERENCES principals(id), display_name TEXT NOT NULL);
      `)
    if(version<2)this.transaction(()=>{
      this.db.exec(`ALTER TABLE conversations ADD COLUMN owner_id TEXT;
        ALTER TABLE conversations ADD COLUMN closed INTEGER NOT NULL DEFAULT 0;
        ALTER TABLE memberships ADD COLUMN role TEXT NOT NULL DEFAULT 'member';
        ALTER TABLE memberships ADD COLUMN speaking_mode TEXT NOT NULL DEFAULT 'readOnly';
        UPDATE memberships SET role=CASE WHEN manager=1 THEN 'admin' ELSE 'member' END,
          speaking_mode=CASE WHEN principal_id IN (SELECT id FROM principals WHERE kind='bot') THEN 'active' ELSE 'speak' END;
        UPDATE conversations SET owner_id=(SELECT principal_id FROM memberships WHERE conversation_id=conversations.id AND active=1 AND manager=1 ORDER BY join_seq,principal_id LIMIT 1) WHERE kind='group';
        UPDATE conversations SET closed=1 WHERE id IN (SELECT conversation_id FROM events WHERE type='conversation.dissolved');
        UPDATE memberships SET role='owner' WHERE principal_id=(SELECT owner_id FROM conversations WHERE id=conversation_id);
        CREATE TABLE responses (delivery_id TEXT PRIMARY KEY REFERENCES deliveries(id),message_id TEXT NOT NULL UNIQUE REFERENCES messages(id));
        INSERT OR IGNORE INTO responses SELECT d.id,m.id FROM deliveries d JOIN messages m ON d.recipient_id=m.author_id
          AND d.message_id=json_extract(m.body,'$.replyToMessageId') AND d.ai=1 ORDER BY m.seq;
        INSERT OR IGNORE INTO schema_version VALUES (2); PRAGMA user_version=2;`)
    })
    requireThat(this.db.prepare('SELECT max(version) version FROM schema_version').get().version === 2, 'SCHEMA_VERSION_UNSUPPORTED')
  }
  close() { this.db.close() }
  transaction(work) {
    this.db.exec('BEGIN IMMEDIATE')
    try { const result = work(); this.beforeCommit?.(); this.db.exec('COMMIT'); return result }
    catch (error) { this.db.exec('ROLLBACK'); throw error }
  }
  connect(instanceId, label, capabilities) {
    identifier(instanceId)
    requireThat(!instanceId.includes(':')&&instanceId.length<=100, 'INVALID_REQUEST')
    requireThat(Array.isArray(capabilities)&&CAPABILITIES.every(capability => capabilities.includes(capability)), 'UNSUPPORTED_CAPABILITY')
    return this.transaction(() => {
      requireThat(this.db.prepare('SELECT trusted FROM instances WHERE id=?').get(instanceId)?.trusted!==0,'UNAUTHENTICATED')
      this.db.prepare('INSERT INTO instances(id,label) VALUES (?,?) ON CONFLICT(id) DO UPDATE SET label=excluded.label').run(instanceId, String(label ?? instanceId).slice(0,256))
      this.db.prepare('UPDATE instances SET epoch=epoch+1 WHERE id=?').run(instanceId)
      return { instanceId, epoch: this.db.prepare('SELECT epoch FROM instances WHERE id=?').get(instanceId).epoch,
        protocol: PROTOCOL, capabilities: CAPABILITIES, limits: this.limits }
    })
  }
  configurePeer(instanceId,label,revision=1) {
    identifier(instanceId)
    requireThat(!instanceId.includes(':')&&instanceId.length<=100,'INVALID_CONFIG')
    requireThat(Number.isSafeInteger(revision)&&revision>0,'INVALID_CONFIG')
    return this.transaction(()=>{
      const old=this.db.prepare('SELECT pairing_revision FROM instances WHERE id=?').get(instanceId)
      requireThat(!old||revision>=old.pairing_revision,'STALE_PAIRING_REVISION')
      if(!old)this.db.prepare('INSERT INTO instances(id,label,pairing_revision) VALUES (?,?,?)').run(instanceId,String(label??instanceId).slice(0,256),revision)
      else if(revision>old.pairing_revision)this.db.prepare('UPDATE instances SET trusted=1,epoch=epoch+1,pairing_revision=?,label=? WHERE id=?').run(revision,String(label??instanceId).slice(0,256),instanceId)
    })
  }
  check(auth) {
    const instance=auth&&this.db.prepare('SELECT epoch,trusted FROM instances WHERE id=?').get(auth.instanceId)
    requireThat(instance?.trusted===1,'UNAUTHENTICATED')
    requireThat(instance.epoch===auth.epoch, 'STALE_CONNECTION')
  }
  principal(auth, principalId) {
    this.check(auth)
    const row = this.db.prepare('SELECT * FROM principals WHERE id=?').get(principalId)
    requireThat(row && row.instance_id === auth.instanceId, 'AUTHOR_MISMATCH')
    return { principalId: row.id, homeInstanceId: row.instance_id, kind: row.kind }
  }
  register(auth, { localId, kind, displayName }) {
    this.check(auth); identifier(localId)
    requireThat(!localId.includes(':')&&localId.length<=100, 'INVALID_REQUEST')
    requireThat(['human','bot'].includes(kind) && typeof displayName === 'string' && displayName.trim() && displayName.length <= 256, 'INVALID_REQUEST')
    const principalId = `${kind}:${auth.instanceId}:${localId}`
    return this.transaction(() => {
      // Legacy Humans retain their identities, history and authority; only new identities are limited.
      const existing=this.db.prepare('SELECT 1 FROM principals WHERE id=?').get(principalId)
      requireThat(existing || kind !== 'human' || !this.db.prepare("SELECT 1 FROM principals WHERE instance_id=? AND kind='human'").get(auth.instanceId),'HUMAN_ALREADY_REGISTERED')
      displayName=this.db.prepare('SELECT display_name FROM principal_preferences WHERE principal_id=?').get(principalId)?.display_name??displayName
      requireThat(existing||this.db.prepare('SELECT count(*) count FROM principals').get().count<this.limits.maxPrincipals,'DIRECTORY_FULL')
      this.db.prepare('INSERT INTO principals VALUES (?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name').run(principalId,auth.instanceId,kind,localId,displayName)
      return { principalId, homeInstanceId: auth.instanceId, kind, displayName }
    })
  }
  contacts(auth) {
    this.check(auth)
    return this.db.prepare('SELECT p.id principalId,p.instance_id homeInstanceId,p.kind,coalesce(n.display_name,p.name) displayName,i.label instanceLabel,a.address ipAddress FROM principals p JOIN instances i ON i.id=p.instance_id LEFT JOIN instance_addresses a ON a.instance_id=i.id LEFT JOIN principal_preferences n ON n.principal_id=p.id WHERE i.trusted=1 ORDER BY p.id').all()
  }
  observeAddress(auth,address) {
    this.check(auth)
    this.db.prepare('INSERT INTO instance_addresses VALUES (?,?) ON CONFLICT(instance_id) DO UPDATE SET address=excluded.address').run(auth.instanceId,address)
  }
  renameHuman(auth,input) {
    const principal=this.principal(auth,input.principalId)
    requireThat(principal.kind==='human'&&typeof input.displayName==='string'&&input.displayName.trim()&&input.displayName.length<=256,'INVALID_REQUEST')
    return this.transaction(()=>{
      this.db.prepare('INSERT INTO principal_preferences VALUES (?,?) ON CONFLICT(principal_id) DO UPDATE SET display_name=excluded.display_name').run(principal.principalId,input.displayName.trim())
      this.db.prepare('UPDATE principals SET name=? WHERE id=?').run(input.displayName.trim(),principal.principalId)
      return {principalId:principal.principalId,displayName:input.displayName.trim()}
    })
  }
  member(auth, conversationId, principalId, epoch) {
    this.principal(auth, principalId)
    const row = this.db.prepare('SELECT * FROM memberships WHERE conversation_id=? AND principal_id=?').get(conversationId,principalId)
    requireThat(row?.active, 'NOT_A_MEMBER')
    requireThat(['owner','admin','member'].includes(row.role),'FORBIDDEN')
    requireThat(!epoch || epoch === row.epoch, 'MEMBERSHIP_REVOKED')
    return row
  }
  actorMembership(auth,input) {
    requireThat(typeof input.membershipEpoch==='string','MEMBERSHIP_EPOCH_REQUIRED')
    identifier(input.membershipEpoch)
    const member=this.member(auth,input.conversationId,input.principalId,input.membershipEpoch)
    if(input.expectedVersion!==undefined)requireThat(input.expectedVersion===this.db.prepare('SELECT version FROM conversations WHERE id=?').get(input.conversationId).version,'GROUP_VERSION_CONFLICT')
    return member
  }
  syncValue(member,watermark,events) { return {conversationId:member.conversation_id,principalId:member.principal_id,membershipEpoch:member.epoch,joinSeq:member.join_seq,watermark,events} }
  event(conversationId, type, data, id = randomUUID()) {
    this.db.prepare('UPDATE conversations SET seq=seq+1 WHERE id=?').run(conversationId)
    const seq = this.db.prepare('SELECT seq FROM conversations WHERE id=?').get(conversationId).seq
    const body = { ...data, conversationId, conversationSeq: seq, eventId: id, type }
    this.db.prepare('INSERT INTO events VALUES (?,?,?,?,?)').run(conversationId,seq,id,type,JSON.stringify(body))
    return body
  }
  operation(auth, operationId, input, work) {
    this.check(auth); identifier(operationId)
    return this.transaction(() => {
      const digest = hash(input), old = this.db.prepare('SELECT * FROM operations WHERE id=?').get(operationId)
      if (old) { requireThat(old.instance_id === auth.instanceId && old.hash === digest, 'OPERATION_ID_CONFLICT'); return JSON.parse(old.result) }
      const result = work()
      this.db.prepare('INSERT INTO operations VALUES (?,?,?,?)').run(operationId,auth.instanceId,digest,JSON.stringify(result))
      return result
    })
  }
  requireMembershipCapacity(principalId) {
    const instance=this.db.prepare('SELECT instance_id FROM principals WHERE id=?').get(principalId)?.instance_id
    const count=this.db.prepare('SELECT count(*) count FROM memberships m JOIN principals p ON p.id=m.principal_id WHERE p.instance_id=?').get(instance).count
    requireThat(count<this.limits.maxMembershipsPerInstance,'MEMBERSHIP_LIMIT')
  }
  createDm(auth, input) {
    const author = this.principal(auth,input.principalId)
    identifier(input.otherPrincipalId)
    requireThat(author.principalId !== input.otherPrincipalId && this.db.prepare('SELECT p.id FROM principals p JOIN instances i ON i.id=p.instance_id WHERE p.id=? AND i.trusted=1').get(input.otherPrincipalId), 'INVALID_REQUEST')
    return this.operation(auth,input.operationId,input,() => {
      const members = [author.principalId,input.otherPrincipalId].sort(), key = JSON.stringify(members)
      const old = this.db.prepare('SELECT id FROM conversations WHERE dm_key=?').get(key)
      if (old) {
        for(const principalId of members){
          const member=this.db.prepare('SELECT active FROM memberships WHERE conversation_id=? AND principal_id=?').get(old.id,principalId)
          if(member?.active)continue
          const epoch=randomUUID(),event=this.event(old.id,'membership.restored',{principalId,membershipEpoch:epoch})
          this.db.prepare('UPDATE memberships SET active=1,epoch=?,join_seq=? WHERE conversation_id=? AND principal_id=?').run(epoch,event.conversationSeq,old.id,principalId)
          this.db.prepare('UPDATE conversations SET version=version+1 WHERE id=?').run(old.id)
        }
        return { conversationId: old.id }
      }
      const id = randomUUID()
      this.db.prepare('INSERT INTO conversations(id,kind,dm_key,title,routing_mode) VALUES (?,?,?,?,?)').run(id,'dm',key,'Private message','mentionsOnly')
      for (const principalId of members) { this.requireMembershipCapacity(principalId); this.db.prepare("INSERT INTO memberships(conversation_id,principal_id,epoch,join_seq,active,manager,speaking_mode) VALUES (?,?,?,?,1,0,?)").run(id,principalId,randomUUID(),1,principalId.startsWith('bot:')?'active':'speak') }
      this.event(id,'conversation.created',{ kind:'dm', members })
      return { conversationId:id }
    })
  }
  createGroup(auth, input) {
    this.principal(auth,input.principalId)
    requireThat(typeof input.title === 'string' && input.title.trim() && input.title.length <= 256,'INVALID_REQUEST')
    return this.operation(auth,input.operationId,input,() => {
      const id=randomUUID()
      this.requireMembershipCapacity(input.principalId)
      this.db.prepare('INSERT INTO conversations(id,kind,title,routing_mode,owner_id) VALUES (?,?,?,?,?)').run(id,'group',input.title,'mentionsOnly',input.principalId)
      this.db.prepare("INSERT INTO memberships(conversation_id,principal_id,epoch,join_seq,active,manager,role,speaking_mode) VALUES (?,?,?,?,1,1,'owner',?)").run(id,input.principalId,randomUUID(),1,input.principalId.startsWith('bot:')?'active':'speak')
      this.event(id,'conversation.created',{kind:'group',title:input.title,members:[input.principalId]})
      return {conversationId:id}
    })
  }
  invite(auth,input) {
    return this.operation(auth,input.operationId,input,()=>{
      requireThat(['owner','admin'].includes(this.actorMembership(auth,input).role),'FORBIDDEN')
      requireThat(this.db.prepare('SELECT kind FROM conversations WHERE id=?').get(input.conversationId).kind==='group','INVALID_REQUEST')
      requireThat(this.db.prepare('SELECT p.id FROM principals p JOIN instances i ON i.id=p.instance_id WHERE p.id=? AND i.trusted=1').get(input.inviteePrincipalId),'UNKNOWN_PRINCIPAL')
      const old=this.db.prepare('SELECT id FROM invites WHERE conversation_id=? AND principal_id=? AND active=1').get(input.conversationId,input.inviteePrincipalId)
      if(old)return {inviteId:old.id}
      const instance=this.db.prepare('SELECT instance_id FROM principals WHERE id=?').get(input.inviteePrincipalId).instance_id
      const pending=this.db.prepare('SELECT count(*) count FROM invites i JOIN principals p ON p.id=i.principal_id WHERE p.instance_id=? AND i.active=1').get(instance).count
      requireThat(pending<this.limits.maxPendingInvitesPerInstance,'INVITE_LIMIT')
      const id=randomUUID()
      this.db.prepare('INSERT INTO invites(id,conversation_id,principal_id,inviter_id) VALUES (?,?,?,?)').run(id,input.conversationId,input.inviteePrincipalId,input.principalId)
      return {inviteId:id}
    })
  }
  accept(auth,input) {
    this.principal(auth,input.principalId)
    return this.operation(auth,input.operationId,input,()=>{
      const invite=this.db.prepare('SELECT * FROM invites WHERE id=?').get(input.inviteId)
      requireThat(invite?.principal_id===input.principalId,'FORBIDDEN')
      const current=this.db.prepare('SELECT * FROM memberships WHERE conversation_id=? AND principal_id=?').get(invite.conversation_id,input.principalId)
      if(current?.active)return {conversationId:invite.conversation_id,membershipEpoch:current.epoch,joinSeq:current.join_seq}
      requireThat(invite.active,'INVITE_REVOKED')
      requireThat(this.db.prepare('SELECT owner_id FROM conversations WHERE id=?').get(invite.conversation_id).owner_id!==input.principalId,'OWNER_RECLAIM_REQUIRED')
      if(!current)this.requireMembershipCapacity(input.principalId)
      const inviter=this.db.prepare('SELECT active,role FROM memberships WHERE conversation_id=? AND principal_id=?').get(invite.conversation_id,invite.inviter_id)
      requireThat(inviter?.active&&['owner','admin'].includes(inviter.role),'INVITE_REVOKED')
      const count=this.db.prepare('SELECT count(*) count FROM memberships WHERE conversation_id=? AND active=1').get(invite.conversation_id).count
      const absentOwner=this.db.prepare('SELECT 1 FROM conversations c JOIN memberships m ON m.conversation_id=c.id AND m.principal_id=c.owner_id WHERE c.id=? AND m.active=0').get(invite.conversation_id)
      requireThat(count<this.limits.maxMembers-Number(Boolean(absentOwner)),'MEMBER_LIMIT')
      const epoch=randomUUID()
      const event=this.event(invite.conversation_id,'membership.joined',{principalId:input.principalId,membershipEpoch:epoch})
      this.db.prepare("INSERT INTO memberships(conversation_id,principal_id,epoch,join_seq,active,manager,role,speaking_mode) VALUES (?,?,?,?,1,0,'member',?) ON CONFLICT(conversation_id,principal_id) DO UPDATE SET epoch=excluded.epoch,join_seq=excluded.join_seq,active=1,manager=0,role='member',speaking_mode=excluded.speaking_mode").run(invite.conversation_id,input.principalId,epoch,event.conversationSeq,input.principalId.startsWith('bot:')?'passive':'readOnly')
      this.db.prepare('UPDATE conversations SET version=version+1 WHERE id=?').run(invite.conversation_id)
      this.db.prepare('UPDATE invites SET active=0 WHERE id=?').run(invite.id)
      return {conversationId:invite.conversation_id,membershipEpoch:epoch,joinSeq:event.conversationSeq}
    })
  }
  remove(auth,input) {
    this.principal(auth,input.principalId)
    return this.operation(auth,input.operationId,input,()=>{
      const caller=this.actorMembership(auth,input)
      requireThat(input.targetPrincipalId===input.principalId||['owner','admin'].includes(caller.role),'FORBIDDEN')
      requireThat(this.db.prepare('SELECT kind FROM conversations WHERE id=?').get(input.conversationId).kind==='group','INVALID_REQUEST')
      const member=this.db.prepare('SELECT * FROM memberships WHERE conversation_id=? AND principal_id=?').get(input.conversationId,input.targetPrincipalId)
      if(!member?.active){
        const changed=this.db.prepare('UPDATE invites SET active=0 WHERE conversation_id=? AND principal_id=? AND active=1').run(input.conversationId,input.targetPrincipalId).changes
        if(changed){this.db.prepare('UPDATE conversations SET version=version+1 WHERE id=?').run(input.conversationId);this.event(input.conversationId,'invitation.revoked',{principalId:input.targetPrincipalId})}
        return {revoked:true}
      }
      requireThat(member.role!=='owner','OWNER_TRANSFER_REQUIRED')
      requireThat(input.targetPrincipalId===input.principalId||caller.role==='owner'||member.role==='member','FORBIDDEN')
      this.db.prepare('UPDATE memberships SET active=0 WHERE conversation_id=? AND principal_id=?').run(input.conversationId,input.targetPrincipalId)
      this.db.prepare('UPDATE deliveries SET revoked=1 WHERE recipient_id=? AND membership_epoch=? AND ai_accepted=0').run(input.targetPrincipalId,member.epoch)
      this.db.prepare('UPDATE conversations SET version=version+1,routing_mode=CASE WHEN admin_bot=? THEN ? ELSE routing_mode END,admin_bot=CASE WHEN admin_bot=? THEN NULL ELSE admin_bot END WHERE id=?').run(input.targetPrincipalId,'mentionsOnly',input.targetPrincipalId,input.conversationId)
      this.db.prepare('UPDATE invites SET active=0 WHERE conversation_id=? AND (principal_id=? OR inviter_id=?)').run(input.conversationId,input.targetPrincipalId,input.targetPrincipalId)
      this.event(input.conversationId,'membership.removed',{principalId:input.targetPrincipalId,membershipEpoch:member.epoch})
      return {revoked:true}
    })
  }
  routing(auth,input) {
    return this.operation(auth,input.operationId,input,()=>{
      requireThat(['owner','admin'].includes(this.actorMembership(auth,input).role),'FORBIDDEN')
      requireThat(['admin','mentionsOnly'].includes(input.mode),'INVALID_REQUEST')
      requireThat(this.db.prepare('SELECT kind FROM conversations WHERE id=?').get(input.conversationId).kind==='group','INVALID_REQUEST')
      if(input.mode==='admin'){
        const bot=this.db.prepare('SELECT p.kind FROM memberships m JOIN principals p ON p.id=m.principal_id WHERE m.conversation_id=? AND m.principal_id=? AND m.active=1').get(input.conversationId,input.adminBotPrincipalId)
        requireThat(bot?.kind==='bot','INVALID_ADMIN')
      }
      this.db.prepare('UPDATE conversations SET version=version+1,routing_mode=?,admin_bot=? WHERE id=?').run(input.mode,input.mode==='admin'?input.adminBotPrincipalId:null,input.conversationId)
      this.event(input.conversationId,'routing.changed',{mode:input.mode,adminBotPrincipalId:input.mode==='admin'?input.adminBotPrincipalId:null})
      return {updated:true}
    })
  }
  groupActor(auth,input) {
    const caller=this.actorMembership(auth,input)
    const group=this.db.prepare('SELECT * FROM conversations WHERE id=?').get(input.conversationId)
    requireThat(group.kind==='group'&&!group.closed,'INVALID_REQUEST')
    requireThat(Number.isSafeInteger(input.expectedVersion)&&input.expectedVersion===group.version,'GROUP_VERSION_CONFLICT')
    return {caller,group}
  }
  configureGroup(auth,input) {
    return this.operation(auth,input.operationId,input,()=>{
      const {caller}=this.groupActor(auth,input)
      requireThat(['owner','admin'].includes(caller.role),'FORBIDDEN')
      requireThat(typeof input.title==='string'&&input.title.trim()&&input.title.length<=256,'INVALID_REQUEST')
      this.db.prepare('UPDATE conversations SET title=?,version=version+1 WHERE id=?').run(input.title.trim(),input.conversationId)
      this.event(input.conversationId,'conversation.renamed',{title:input.title.trim()})
      return {conversationId:input.conversationId,title:input.title.trim(),updated:true}
    })
  }
  policy(auth,input) {
    return this.operation(auth,input.operationId,input,()=>{
      const {caller}=this.groupActor(auth,input)
      const target=this.db.prepare('SELECT m.*,p.kind FROM memberships m JOIN principals p ON p.id=m.principal_id WHERE m.conversation_id=? AND m.principal_id=? AND m.active=1').get(input.conversationId,input.targetPrincipalId)
      requireThat(target,'NOT_A_MEMBER')
      requireThat(caller.role==='owner'||caller.role==='admin'&&target.role==='member'&&input.role===undefined,'FORBIDDEN')
      const role=input.role??target.role,mode=input.speakingMode??target.speaking_mode
      requireThat(target.role!=='owner'||role==='owner','OWNER_TRANSFER_REQUIRED')
      requireThat(role===target.role||['member','admin'].includes(role),'INVALID_ROLE')
      requireThat(target.role==='owner'||role!=='owner','OWNER_TRANSFER_REQUIRED')
      requireThat((target.kind==='human'?['readOnly','speak']:['passive','active']).includes(mode),'INVALID_SPEAKING_MODE')
      this.db.prepare('UPDATE memberships SET role=?,manager=?,speaking_mode=? WHERE conversation_id=? AND principal_id=?').run(role,Number(role!=='member'),mode,input.conversationId,input.targetPrincipalId)
      this.db.prepare('UPDATE conversations SET version=version+1 WHERE id=?').run(input.conversationId)
      if(role==='member'&&target.role==='admin')this.db.prepare('UPDATE invites SET active=0 WHERE conversation_id=? AND inviter_id=?').run(input.conversationId,input.targetPrincipalId)
      this.event(input.conversationId,'membership.policy',{principalId:input.targetPrincipalId,role,speakingMode:mode})
      return {updated:true,membershipVersion:input.expectedVersion+1}
    })
  }
  transfer(auth,input) {
    return this.operation(auth,input.operationId,input,()=>{
      const {caller,group}=this.groupActor(auth,input)
      requireThat(caller.role==='owner'&&group.owner_id===input.principalId,'FORBIDDEN')
      requireThat(input.targetPrincipalId!==input.principalId,'INVALID_REQUEST')
      requireThat(this.db.prepare('SELECT 1 FROM memberships WHERE conversation_id=? AND principal_id=? AND active=1').get(input.conversationId,input.targetPrincipalId),'NOT_A_MEMBER')
      this.db.prepare("UPDATE memberships SET role=CASE WHEN principal_id=? THEN 'owner' ELSE 'admin' END,manager=1 WHERE conversation_id=? AND principal_id IN (?,?)").run(input.targetPrincipalId,input.conversationId,input.principalId,input.targetPrincipalId)
      this.db.prepare('UPDATE conversations SET owner_id=?,version=version+1 WHERE id=?').run(input.targetPrincipalId,input.conversationId)
      this.event(input.conversationId,'ownership.transferred',{previousOwnerPrincipalId:input.principalId,ownerPrincipalId:input.targetPrincipalId})
      return {ownerPrincipalId:input.targetPrincipalId,membershipVersion:input.expectedVersion+1}
    })
  }
  reclaim(auth,input) {
    this.principal(auth,input.principalId)
    return this.operation(auth,input.operationId,input,()=>{
      const group=this.db.prepare('SELECT * FROM conversations WHERE id=?').get(input.conversationId)
      requireThat(group?.kind==='group'&&!group.closed&&group.owner_id===input.principalId,'FORBIDDEN')
      requireThat(Number.isSafeInteger(input.expectedVersion)&&input.expectedVersion===group.version,'GROUP_VERSION_CONFLICT')
      const previous=this.db.prepare('SELECT * FROM memberships WHERE conversation_id=? AND principal_id=?').get(input.conversationId,input.principalId)
      requireThat(previous&&!previous.active,'INVALID_REQUEST')
      requireThat(this.db.prepare('SELECT count(*) n FROM memberships WHERE conversation_id=? AND active=1').get(input.conversationId).n<this.limits.maxMembers,'MEMBER_LIMIT')
      const epoch=randomUUID(),event=this.event(input.conversationId,'ownership.reclaimed',{principalId:input.principalId,membershipEpoch:epoch})
      this.db.prepare("UPDATE memberships SET active=1,epoch=?,join_seq=?,role='owner',manager=1,speaking_mode=? WHERE conversation_id=? AND principal_id=?").run(epoch,event.conversationSeq,input.principalId.startsWith('bot:')?'passive':'readOnly',input.conversationId,input.principalId)
      this.db.prepare('UPDATE conversations SET version=version+1 WHERE id=?').run(input.conversationId)
      return {conversationId:input.conversationId,membershipEpoch:epoch,joinSeq:event.conversationSeq}
    })
  }
  dissolve(auth,input) {
    this.principal(auth,input.principalId)
    return this.operation(auth,input.operationId,input,()=>{
      requireThat(this.actorMembership(auth,input).role==='owner','FORBIDDEN')
      requireThat(this.db.prepare('SELECT kind FROM conversations WHERE id=?').get(input.conversationId).kind==='group','INVALID_REQUEST')
      this.event(input.conversationId,'conversation.dissolved',{principalId:input.principalId})
      this.db.prepare('UPDATE memberships SET active=0 WHERE conversation_id=?').run(input.conversationId)
      this.db.prepare('UPDATE deliveries SET revoked=1 WHERE message_id IN (SELECT id FROM messages WHERE conversation_id=?) AND ai_accepted=0').run(input.conversationId)
      this.db.prepare('UPDATE invites SET active=0 WHERE conversation_id=?').run(input.conversationId)
      this.db.prepare('UPDATE conversations SET version=version+1,routing_mode=?,admin_bot=NULL,closed=1 WHERE id=?').run('mentionsOnly',input.conversationId)
      return {conversationId:input.conversationId,dissolved:true}
    })
  }
  revokeInstance(instanceId) {
    return this.transaction(()=>{
      this.db.prepare('UPDATE instances SET trusted=0 WHERE id=?').run(instanceId)
      const members=this.db.prepare('SELECT m.* FROM memberships m JOIN principals p ON p.id=m.principal_id WHERE p.instance_id=? AND m.active=1').all(instanceId)
      for(const member of members){
        this.db.prepare('UPDATE memberships SET active=0 WHERE conversation_id=? AND principal_id=?').run(member.conversation_id,member.principal_id)
        this.db.prepare('UPDATE deliveries SET revoked=1 WHERE recipient_id=? AND membership_epoch=? AND ai_accepted=0').run(member.principal_id,member.epoch)
        this.db.prepare('UPDATE conversations SET version=version+1,routing_mode=CASE WHEN admin_bot=? THEN ? ELSE routing_mode END,admin_bot=CASE WHEN admin_bot=? THEN NULL ELSE admin_bot END WHERE id=?').run(member.principal_id,'mentionsOnly',member.principal_id,member.conversation_id)
        this.db.prepare('UPDATE invites SET active=0 WHERE conversation_id=? AND (principal_id=? OR inviter_id=?)').run(member.conversation_id,member.principal_id,member.principal_id)
        this.event(member.conversation_id,'membership.removed',{principalId:member.principal_id,membershipEpoch:member.epoch,reason:'trustRevoked'})
      }
      return {revoked:true}
    })
  }
  publish(auth,input) {
    const author=this.principal(auth,input.author?.principalId)
    const message=normalizeMessage(input,author,this.limits)
    return this.transaction(()=>{
      const digest=hash(message), old=this.db.prepare('SELECT * FROM messages WHERE id=?').get(message.messageId)
      if(old){ requireThat(old.hash===digest&&old.author_id===author.principalId,'MESSAGE_ID_CONFLICT'); return this.accepted(old) }
      requireThat(typeof message.membershipEpoch==='string','MEMBERSHIP_EPOCH_REQUIRED')
      const sender=this.member(auth,message.conversationId,author.principalId,message.membershipEpoch)
      requireThat(!this.db.prepare('SELECT 1 FROM events WHERE id=?').get(message.messageId),'MESSAGE_ID_CONFLICT')
      const conversation=this.db.prepare('SELECT * FROM conversations WHERE id=?').get(message.conversationId)
      if(conversation.kind==='group'){
        requireThat(['owner','admin','member'].includes(sender.role),'FORBIDDEN')
        requireThat(author.kind==='human'?sender.speaking_mode==='speak':['passive','active'].includes(sender.speaking_mode),'SPEAKING_FORBIDDEN')
        requireThat(author.kind!=='bot'||sender.speaking_mode!=='passive'||message.responseToDeliveryId,'PASSIVE_REPLY_REQUIRED')
      }
      if(message.responseToDeliveryId){
        const delivery=this.db.prepare('SELECT d.*,m.conversation_id FROM deliveries d JOIN messages m ON m.id=d.message_id WHERE d.id=?').get(message.responseToDeliveryId)
        requireThat(author.kind==='bot'&&delivery?.ai===1&&delivery.stored===1&&!delivery.revoked&&delivery.recipient_id===author.principalId
          &&delivery.membership_epoch===sender.epoch&&delivery.conversation_id===message.conversationId&&delivery.message_id===message.replyToMessageId,'INVALID_RESPONSE_GRANT')
        requireThat(!this.db.prepare('SELECT 1 FROM responses WHERE delivery_id=?').get(delivery.id),'RESPONSE_ALREADY_SENT')
      }
      const members=this.db.prepare('SELECT m.*,p.kind FROM memberships m JOIN principals p ON p.id=m.principal_id WHERE conversation_id=? AND active=1').all(message.conversationId)
      for(const mention of message.mentions) requireThat(members.some(member=>member.principal_id===mention.principalId),'UNKNOWN_MENTION')
      if(message.replyToMessageId){
        const parent=this.db.prepare('SELECT conversation_id,seq FROM messages WHERE id=?').get(message.replyToMessageId)
        requireThat(parent?.conversation_id===message.conversationId&&parent.seq>=sender.join_seq,'INVALID_REPLY_TARGET')
      }
      const pending=this.db.prepare('SELECT count(*) count FROM deliveries WHERE stored=0 AND revoked=0').get().count
      requireThat(pending+members.length<=this.limits.maxPendingDeliveries,'STORAGE_UNAVAILABLE','Pending delivery capacity reached')
      const acceptedAt=new Date().toISOString()
      const event={message,serverAcceptedAt:acceptedAt,payloadHash:digest,conversationId:message.conversationId,conversationSeq:conversation.seq+1,eventId:message.messageId,type:'message'}
      const deliveries=members.map(member=>{
        const mentioned=message.mentions.some(mention=>mention.principalId===member.principal_id)
        const mayReceiveAi=conversation.kind==='dm'||['passive','active'].includes(member.speaking_mode)
        const ai=member.kind==='bot'&&mayReceiveAi&&(conversation.kind==='dm'?member.principal_id!==author.principalId:author.kind==='bot'&&sender.speaking_mode==='passive'?false:
          mentioned||(!message.mentions.length&&author.kind==='human'&&conversation.routing_mode==='admin'&&conversation.admin_bot===member.principal_id))
        return {deliveryId:randomUUID(),messageId:message.messageId,conversationId:message.conversationId,recipientPrincipalId:member.principal_id,membershipEpoch:member.epoch,routingVersion:conversation.version,notify:member.kind==='human'&&member.principal_id!==author.principalId,ai:Boolean(ai),event}
      })
      for(let index=0;index<members.length;index++){
        requireThat(responseBytes(this.syncValue(members[index],Number.MAX_SAFE_INTEGER,[event]))<=this.limits.maxEnvelopeBytes
          &&responseBytes([deliveries[index]])<=this.limits.maxEnvelopeBytes,'PAYLOAD_TOO_LARGE')
      }
      this.event(message.conversationId,'message',{message,serverAcceptedAt:acceptedAt,payloadHash:digest},message.messageId)
      this.db.prepare('INSERT INTO messages VALUES (?,?,?,?,?,?,?)').run(message.messageId,message.conversationId,event.conversationSeq,digest,author.principalId,JSON.stringify(message),acceptedAt)
      if(message.responseToDeliveryId)this.db.prepare('INSERT INTO responses VALUES (?,?)').run(message.responseToDeliveryId,message.messageId)
      for(const delivery of deliveries){
        this.db.prepare('INSERT INTO deliveries(id,message_id,recipient_id,membership_epoch,routing_version,notify,ai) VALUES (?,?,?,?,?,?,?)').run(delivery.deliveryId,message.messageId,delivery.recipientPrincipalId,delivery.membershipEpoch,conversation.version,Number(delivery.notify),Number(delivery.ai))
      }
      return this.accepted(this.db.prepare('SELECT * FROM messages WHERE id=?').get(message.messageId))
    })
  }
  accepted(row) { return {messageId:row.id,conversationId:row.conversation_id,conversationSeq:row.seq,payloadHash:row.hash,serverAcceptedAt:row.accepted_at,status:'hubAccepted'} }
  memberships(auth) {
    this.check(auth)
    const members=this.db.prepare('SELECT m.*,c.title,c.kind,c.version,c.routing_mode,c.admin_bot,c.owner_id,c.closed,c.seq FROM memberships m JOIN principals p ON p.id=m.principal_id JOIN conversations c ON c.id=m.conversation_id WHERE p.instance_id=?').all(auth.instanceId)
    const invites=this.db.prepare('SELECT i.id inviteId,i.conversation_id conversationId,i.principal_id principalId,c.title FROM invites i JOIN principals p ON p.id=i.principal_id JOIN conversations c ON c.id=i.conversation_id WHERE p.instance_id=? AND i.active=1').all(auth.instanceId)
    return {memberships:members.map(m=>({conversationId:m.conversation_id,principalId:m.principal_id,membershipEpoch:m.epoch,joinSeq:m.join_seq,active:Boolean(m.active),manager:Boolean(m.manager),role:m.role,speakingMode:m.speaking_mode,ownerPrincipalId:m.owner_id,dissolved:Boolean(m.closed),title:m.title,kind:m.kind,membershipVersion:m.version,routingMode:m.routing_mode,adminBotPrincipalId:m.admin_bot,watermark:m.seq})),invites}
  }
  sync(auth,input) {
    const member=this.member(auth,input.conversationId,input.principalId,input.membershipEpoch)
    requireThat(Number.isSafeInteger(input.after)&&input.after>=0,'INVALID_REQUEST')
    requireThat(input.limit===undefined||Number.isSafeInteger(input.limit)&&input.limit>0,'INVALID_REQUEST')
    const after=Math.max(input.after,member.join_seq-1), limit=Math.min(Math.max(input.limit??100,1),500)
    const events=[]
    const watermark=this.db.prepare('SELECT seq FROM conversations WHERE id=?').get(input.conversationId).seq
    requireThat(input.after<=watermark,'HISTORY_GAP')
    let bytes=responseBytes(this.syncValue(member,watermark,events))
    for(const row of this.db.prepare('SELECT body FROM events WHERE conversation_id=? AND seq>? ORDER BY seq LIMIT ?').iterate(input.conversationId,after,limit)){
      const size=Buffer.byteLength(row.body)+(events.length?1:0)
      if(bytes+size>this.limits.maxEnvelopeBytes){requireThat(events.length>0,'PAYLOAD_TOO_LARGE');break}
      bytes+=size;events.push(JSON.parse(row.body))
    }
    return this.syncValue(member,watermark,events)
  }
  authorize(auth,input) {
    const member=this.member(auth,input.conversationId,input.principalId,input.membershipEpoch)
    return {conversationId:member.conversation_id,principalId:member.principal_id,membershipEpoch:member.epoch,joinSeq:member.join_seq,role:member.role,speakingMode:member.speaking_mode}
  }
  members(auth,input) {
    this.member(auth,input.conversationId,input.principalId,input.membershipEpoch)
    const conversation=this.db.prepare('SELECT title,kind,version,routing_mode,admin_bot,owner_id FROM conversations WHERE id=?').get(input.conversationId)
    const members=this.db.prepare('SELECT p.id principalId,p.kind,p.name displayName,p.instance_id homeInstanceId,i.label instanceLabel,m.manager,m.role,m.speaking_mode speakingMode FROM memberships m JOIN principals p ON p.id=m.principal_id JOIN instances i ON i.id=p.instance_id WHERE m.conversation_id=? AND m.active=1 ORDER BY p.id').all(input.conversationId)
    return {conversationId:input.conversationId,title:conversation.title,kind:conversation.kind,membershipVersion:conversation.version,routingMode:conversation.routing_mode,adminBotPrincipalId:conversation.admin_bot,ownerPrincipalId:conversation.owner_id,members}
  }
  acknowledgeCursor(auth,input) {
    const member=this.member(auth,input.conversationId,input.principalId,input.membershipEpoch)
    const watermark=this.db.prepare('SELECT seq FROM conversations WHERE id=?').get(input.conversationId).seq
    requireThat(Number.isSafeInteger(input.seq)&&input.seq>=member.join_seq-1&&input.seq<=watermark,'HISTORY_GAP')
    return this.transaction(()=>{
      this.db.prepare('INSERT INTO cursors VALUES (?,?,?,?) ON CONFLICT(conversation_id,principal_id,membership_epoch) DO UPDATE SET seq=max(seq,excluded.seq)').run(input.conversationId,input.principalId,member.epoch,input.seq)
      return {seq:this.db.prepare('SELECT seq FROM cursors WHERE conversation_id=? AND principal_id=? AND membership_epoch=?').get(input.conversationId,input.principalId,member.epoch).seq}
    })
  }
  pending(auth) {
    this.check(auth)
    const deliveries=[]
    let bytes=responseBytes(deliveries)
    for(const row of this.db.prepare(`SELECT d.*,m.conversation_id,m.seq,e.body FROM deliveries d JOIN principals p ON p.id=d.recipient_id JOIN messages m ON m.id=d.message_id JOIN events e ON e.id=d.message_id JOIN memberships member ON member.conversation_id=m.conversation_id AND member.principal_id=d.recipient_id WHERE p.instance_id=? AND d.stored=0 AND d.revoked=0 AND member.active=1 AND member.epoch=d.membership_epoch ORDER BY m.conversation_id,m.seq LIMIT 500`).iterate(auth.instanceId)){
      const delivery={deliveryId:row.id,messageId:row.message_id,conversationId:row.conversation_id,recipientPrincipalId:row.recipient_id,membershipEpoch:row.membership_epoch,routingVersion:row.routing_version,notify:Boolean(row.notify),ai:Boolean(row.ai),event:JSON.parse(row.body)}
      const size=Buffer.byteLength(JSON.stringify(delivery))+(deliveries.length?1:0)
      if(bytes+size>this.limits.maxEnvelopeBytes){requireThat(deliveries.length>0,'PAYLOAD_TOO_LARGE');break}
      bytes+=size;deliveries.push(delivery)
    }
    return deliveries
  }
  receipt(auth,input) {
    this.check(auth)
    return this.transaction(()=>{
      const row=this.db.prepare('SELECT d.*,p.instance_id,p.kind,m.conversation_id FROM deliveries d JOIN principals p ON p.id=d.recipient_id JOIN messages m ON m.id=d.message_id WHERE d.id=?').get(input.deliveryId)
      requireThat(row&&row.instance_id===auth.instanceId&&row.recipient_id===input.principalId,'FORBIDDEN')
      requireThat(!row.revoked,'MEMBERSHIP_REVOKED')
      requireThat(input.membershipEpoch===row.membership_epoch,'MEMBERSHIP_REVOKED')
      this.member(auth,row.conversation_id,row.recipient_id,input.membershipEpoch)
      const columns={targetStored:'stored',uiApplied:'applied',humanRead:'human_read',aiAccepted:'ai_accepted'}
      const column=Object.hasOwn(columns,input.status)?columns[input.status]:null
      requireThat(column,'INVALID_REQUEST')
      requireThat(input.status!=='humanRead'||row.kind==='human','INVALID_RECEIPT')
      requireThat(input.status!=='aiAccepted'||row.ai===1,'INVALID_RECEIPT')
      requireThat(input.status==='targetStored'||row.stored===1,'RECEIPT_OUT_OF_ORDER')
      this.db.prepare(`UPDATE deliveries SET ${column}=1 WHERE id=?`).run(row.id)
      return {deliveryId:row.id,status:input.status}
    })
  }
  deliveryStatus(auth,input) {
    const author=this.principal(auth,input.principalId)
    const message=this.db.prepare('SELECT * FROM messages WHERE id=? AND author_id=?').get(input.messageId,author.principalId)
    requireThat(message,'FORBIDDEN')
    requireThat(message.seq>=this.member(auth,message.conversation_id,author.principalId).join_seq,'FORBIDDEN')
    return this.db.prepare("SELECT id deliveryId,recipient_id recipientPrincipalId,membership_epoch membershipEpoch,notify,ai,stored targetStored,applied uiApplied,human_read humanRead,ai_accepted aiAccepted,revoked,CASE WHEN revoked=1 THEN 'permission_revoked' ELSE NULL END rejectionReason FROM deliveries WHERE message_id=?").all(message.id)
  }
}
