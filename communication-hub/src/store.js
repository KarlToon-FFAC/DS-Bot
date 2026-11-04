import { DatabaseSync } from 'node:sqlite'
import { randomUUID } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { MAX_AVATAR_LENGTH, AVATAR_CHUNK_LENGTH, avatarRevision, validAvatarRevision, normalizeAvatar, validateAvatarImage } from './avatars.js'
import { CAPABILITIES, HUB_CAPABILITIES, DEFAULT_LIMITS, PROTOCOL, CommunicationError, hash, identifier, normalizeMessage, requireThat, responseBytes } from './protocol.js'

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
      CREATE TABLE IF NOT EXISTS hub_instance_names (instance_id TEXT PRIMARY KEY REFERENCES instances(id), label TEXT NOT NULL, version INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS principal_preferences (principal_id TEXT PRIMARY KEY REFERENCES principals(id), display_name TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS principal_profiles (principal_id TEXT PRIMARY KEY REFERENCES principals(id), default_name TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS principal_publication (principal_id TEXT PRIMARY KEY REFERENCES principals(id), published INTEGER NOT NULL CHECK(published IN (0,1)));
      CREATE TABLE IF NOT EXISTS principal_avatar (principal_id TEXT PRIMARY KEY REFERENCES principals(id), descriptor TEXT NOT NULL, image_revision TEXT, image TEXT);
      CREATE TABLE IF NOT EXISTS avatar_uploads (principal_id TEXT PRIMARY KEY REFERENCES principals(id), upload_id TEXT NOT NULL, revision TEXT NOT NULL, total_length INTEGER NOT NULL, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS causal_roots (id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL REFERENCES conversations(id), ai_deliveries INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS message_causality (message_id TEXT PRIMARY KEY REFERENCES messages(id), root_id TEXT NOT NULL REFERENCES causal_roots(id), parent_id TEXT, depth INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS causal_schema (version INTEGER PRIMARY KEY);
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
    if (!this.db.prepare('SELECT 1 FROM causal_schema WHERE version=1').get()) this.transaction(()=>{
      const latestHuman = new Map()
      for (const row of this.db.prepare('SELECT m.*,p.kind FROM messages m JOIN principals p ON p.id=m.author_id ORDER BY m.conversation_id,m.seq').all()) {
        const body = JSON.parse(row.body)
        if (row.kind === 'human') latestHuman.set(row.conversation_id,row.id)
        const deliveryId = body.responseToDeliveryId ?? body.causationDeliveryId
        const parent = deliveryId && this.db.prepare('SELECT message_id FROM deliveries WHERE id=?').get(deliveryId)?.message_id
        const ancestry = parent && this.db.prepare('SELECT * FROM message_causality WHERE message_id=?').get(parent)
        const root = row.kind === 'human' ? `message:${row.id}` : ancestry?.root_id ?? (latestHuman.has(row.conversation_id) ? `message:${latestHuman.get(row.conversation_id)}` : `genesis:${row.conversation_id}`)
        this.db.prepare('INSERT OR IGNORE INTO causal_roots(id,conversation_id) VALUES (?,?)').run(root,row.conversation_id)
        this.db.prepare('INSERT INTO message_causality VALUES (?,?,?,?)').run(row.id,root,ancestry ? parent : null,row.kind === 'human' ? 0 : ancestry ? ancestry.depth+1 : 1)
        const count = this.db.prepare('SELECT count(*) count FROM deliveries WHERE message_id=? AND ai=1').get(row.id).count
        this.db.prepare('UPDATE causal_roots SET ai_deliveries=ai_deliveries+? WHERE id=?').run(count,root)
      }
      this.db.prepare('INSERT INTO causal_schema VALUES (1)').run()
    })
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
      const named = this.db.prepare('SELECT label FROM hub_instance_names WHERE instance_id=?').get(instanceId)
      this.db.prepare('INSERT INTO instances(id,label) VALUES (?,?) ON CONFLICT(id) DO UPDATE SET label=excluded.label').run(instanceId, named?.label ?? String(label ?? instanceId).slice(0,256))
      this.db.prepare('UPDATE instances SET epoch=epoch+1 WHERE id=?').run(instanceId)
      return { instanceId, epoch: this.db.prepare('SELECT epoch FROM instances WHERE id=?').get(instanceId).epoch,
        protocol: PROTOCOL, capabilities: HUB_CAPABILITIES, limits: this.limits }
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
      else if(revision>old.pairing_revision){
        const named=this.db.prepare('SELECT label FROM hub_instance_names WHERE instance_id=?').get(instanceId)
        this.db.prepare('UPDATE instances SET trusted=1,epoch=epoch+1,pairing_revision=?,label=? WHERE id=?').run(revision,named?.label??String(label??instanceId).slice(0,256),instanceId)
      }
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
  register(auth, { localId, kind, displayName, avatar }) {
    this.check(auth); identifier(localId)
    requireThat(!localId.includes(':')&&localId.length<=100, 'INVALID_REQUEST')
    requireThat(['human','bot'].includes(kind) && typeof displayName === 'string' && displayName.trim() && displayName.length <= 256, 'INVALID_REQUEST')
    const principalId = `${kind}:${auth.instanceId}:${localId}`
    return this.transaction(() => {
      // Legacy Humans retain their identities, history and authority; only new identities are limited.
      const existing=this.db.prepare('SELECT 1 FROM principals WHERE id=?').get(principalId)
      requireThat(existing || kind !== 'human' || !this.db.prepare("SELECT 1 FROM principals WHERE instance_id=? AND kind='human'").get(auth.instanceId),'HUMAN_ALREADY_REGISTERED')
      const defaultName=displayName
      displayName=this.db.prepare('SELECT display_name FROM principal_preferences WHERE principal_id=?').get(principalId)?.display_name??displayName
      requireThat(existing||this.db.prepare('SELECT count(*) count FROM principals').get().count<this.limits.maxPrincipals,'DIRECTORY_FULL')
      this.db.prepare('INSERT INTO principals VALUES (?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name').run(principalId,auth.instanceId,kind,localId,displayName)
      if(kind==='bot')this.db.prepare('INSERT INTO principal_publication VALUES (?,1) ON CONFLICT(principal_id) DO UPDATE SET published=1').run(principalId)
      this.db.prepare('INSERT INTO principal_profiles VALUES (?,?) ON CONFLICT(principal_id) DO UPDATE SET default_name=excluded.default_name').run(principalId,defaultName)
      if(avatar!==undefined){
        requireThat(kind==='bot','INVALID_AVATAR')
        this.applyAvatar(principalId,avatar)
      }
      return { principalId, homeInstanceId: auth.instanceId, kind, displayName, avatar:this.avatarOf(principalId) }
    })
  }
  contacts(auth,input={}) {
    this.check(auth)
    if(input.principalId!==undefined)this.principal(auth,input.principalId)
    const rows=this.db.prepare("SELECT p.id principalId,p.instance_id homeInstanceId,p.kind,coalesce(n.display_name,p.name) displayName,i.label instanceLabel,a.address ipAddress FROM principals p JOIN instances i ON i.id=p.instance_id LEFT JOIN instance_addresses a ON a.instance_id=i.id LEFT JOIN principal_preferences n ON n.principal_id=p.id LEFT JOIN principal_publication pub ON pub.principal_id=p.id WHERE i.trusted=1 AND (p.kind<>'bot' OR coalesce(pub.published,1)=1) ORDER BY p.id").all().map(person=>({...person,avatar:this.avatarOf(person.principalId)}))
    return this.directoryFilter?this.directoryFilter(auth,rows,input.principalId):rows
  }
  isPublished(principalId) {
    const row=this.db.prepare('SELECT p.kind,coalesce(pub.published,1) published FROM principals p LEFT JOIN principal_publication pub ON pub.principal_id=p.id WHERE p.id=?').get(principalId)
    return Boolean(row&&(row.kind!=='bot'||row.published===1))
  }
  syncPublication(auth,input) {
    this.check(auth)
    requireThat(input&&Object.keys(input).every(key=>key==='principalIds')&&Array.isArray(input.principalIds)&&input.principalIds.length<=this.limits.maxPrincipals,'INVALID_REQUEST')
    const ids=[...new Set(input.principalIds.map(id=>identifier(id)))].sort()
    return this.transaction(()=>{
      for(const id of ids)requireThat(this.principal(auth,id).kind==='bot','INVALID_REQUEST')
      const selected=new Set(ids)
      for(const row of this.db.prepare("SELECT id FROM principals WHERE instance_id=? AND kind='bot'").all(auth.instanceId)){
        const published=selected.has(row.id)?1:0
        this.db.prepare('INSERT INTO principal_publication VALUES (?,?) ON CONFLICT(principal_id) DO UPDATE SET published=excluded.published').run(row.id,published)
        if(!published){
          this.db.prepare('UPDATE deliveries SET revoked=1 WHERE recipient_id=? AND ai=1 AND ai_accepted=0').run(row.id)
          for(const group of this.db.prepare("SELECT id FROM conversations WHERE admin_bot=? AND kind='group' AND closed=0").all(row.id)){
            this.db.prepare("UPDATE conversations SET admin_bot=NULL,routing_mode='mentionsOnly',version=version+1 WHERE id=?").run(group.id)
            this.event(group.id,'routing.changed',{mode:'mentionsOnly',adminBotPrincipalId:null,reason:'principalUnpublished'})
          }
        }
      }
      return {principalIds:ids}
    })
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
  avatarOf(principalId) {
    const row=this.db.prepare('SELECT descriptor FROM principal_avatar WHERE principal_id=?').get(principalId)
    return row ? JSON.parse(row.descriptor) : {seed:principalId,imageRevision:null}
  }
  avatarBegin(auth,input) {
    identifier(input.principalId);this.principal(auth,input.principalId);identifier(input.uploadId)
    requireThat(validAvatarRevision(input.imageRevision)&&Number.isSafeInteger(input.totalLength)&&input.totalLength>0&&input.totalLength<=MAX_AVATAR_LENGTH,'INVALID_AVATAR_UPLOAD')
    return this.transaction(()=>{
      const committed=this.db.prepare('SELECT image_revision,image FROM principal_avatar WHERE principal_id=?').get(input.principalId)
      if(committed?.image_revision===input.imageRevision&&committed.image){
        requireThat(committed.image.length===input.totalLength,'AVATAR_UPLOAD_CONFLICT')
        return {uploadId:input.uploadId,nextOffset:input.totalLength,complete:true}
      }
      const old=this.db.prepare('SELECT * FROM avatar_uploads WHERE principal_id=?').get(input.principalId)
      if(old?.upload_id===input.uploadId){
        requireThat(old.revision===input.imageRevision&&old.total_length===input.totalLength,'AVATAR_UPLOAD_CONFLICT')
        return {uploadId:input.uploadId,nextOffset:old.data.length,complete:old.data.length===old.total_length}
      }
      this.db.prepare('INSERT INTO avatar_uploads VALUES (?,?,?,?,?) ON CONFLICT(principal_id) DO UPDATE SET upload_id=excluded.upload_id,revision=excluded.revision,total_length=excluded.total_length,data=excluded.data').run(input.principalId,input.uploadId,input.imageRevision,input.totalLength,'')
      return {uploadId:input.uploadId,nextOffset:0,complete:false}
    })
  }
  avatarChunk(auth,input) {
    identifier(input.principalId);this.principal(auth,input.principalId);identifier(input.uploadId)
    requireThat(Number.isSafeInteger(input.offset)&&input.offset>=0&&typeof input.data==='string'&&input.data.length>0&&input.data.length<=AVATAR_CHUNK_LENGTH&&/^[\x20-\x7e]+$/.test(input.data),'INVALID_AVATAR_CHUNK')
    return this.transaction(()=>{
      const upload=this.db.prepare('SELECT * FROM avatar_uploads WHERE principal_id=?').get(input.principalId)
      requireThat(upload?.upload_id===input.uploadId,'AVATAR_UPLOAD_MISMATCH')
      requireThat(input.offset+input.data.length<=upload.total_length,'INVALID_AVATAR_CHUNK')
      if(input.offset<upload.data.length)requireThat(upload.data.slice(input.offset,input.offset+input.data.length)===input.data,'AVATAR_UPLOAD_CONFLICT')
      else{
        requireThat(input.offset===upload.data.length,'AVATAR_UPLOAD_OFFSET')
        this.db.prepare('UPDATE avatar_uploads SET data=data||? WHERE principal_id=?').run(input.data,input.principalId)
      }
      const nextOffset=input.offset<upload.data.length?upload.data.length:upload.data.length+input.data.length
      return {uploadId:input.uploadId,nextOffset,complete:nextOffset===upload.total_length}
    })
  }
  applyAvatar(principalId,input,uploadId) {
    const avatar=normalizeAvatar(input,this.avatarOf(principalId),principalId)
    const current=this.db.prepare('SELECT image_revision,image FROM principal_avatar WHERE principal_id=?').get(principalId)
    let image=null
    if(avatar.imageRevision!==null){
      if(current?.image_revision===avatar.imageRevision&&current.image)image=current.image
      else{
        const upload=this.db.prepare('SELECT * FROM avatar_uploads WHERE principal_id=?').get(principalId)
        requireThat(typeof uploadId==='string'&&upload?.upload_id===uploadId&&upload.revision===avatar.imageRevision,'AVATAR_UPLOAD_REQUIRED')
        requireThat(upload.data.length===upload.total_length,'AVATAR_UPLOAD_INCOMPLETE')
        requireThat(avatarRevision(upload.data)===avatar.imageRevision,'AVATAR_REVISION_MISMATCH')
        validateAvatarImage(upload.data);image=upload.data
      }
    }
    this.db.prepare('INSERT INTO principal_avatar VALUES (?,?,?,?) ON CONFLICT(principal_id) DO UPDATE SET descriptor=excluded.descriptor,image_revision=excluded.image_revision,image=excluded.image').run(principalId,JSON.stringify(avatar),avatar.imageRevision,image)
    if(uploadId!==undefined||input===null||Object.hasOwn(input,'imageRevision'))this.db.prepare('DELETE FROM avatar_uploads WHERE principal_id=?').run(principalId)
    return avatar
  }
  profile(auth,input) {
    return this.operation(auth,input.operationId,input,()=>{
      identifier(input.principalId)
      const principal=this.principal(auth,input.principalId)
      requireThat(Object.keys(input).every(key=>['principalId','operationId','displayName','avatar','uploadId'].includes(key))&&(input.displayName!==undefined||input.avatar!==undefined),'INVALID_REQUEST')
      if(input.displayName!==undefined){
        requireThat(principal.kind==='human'&&(input.displayName===null||typeof input.displayName==='string'&&input.displayName.trim()&&input.displayName.length<=256),'INVALID_REQUEST')
        let name
        if(input.displayName===null){
          name=this.db.prepare('SELECT default_name FROM principal_profiles WHERE principal_id=?').get(input.principalId)?.default_name
          requireThat(name,'PROFILE_DEFAULT_UNAVAILABLE')
          this.db.prepare('DELETE FROM principal_preferences WHERE principal_id=?').run(input.principalId)
        }else{
          name=input.displayName.trim()
          this.db.prepare('INSERT INTO principal_preferences VALUES (?,?) ON CONFLICT(principal_id) DO UPDATE SET display_name=excluded.display_name').run(input.principalId,name)
        }
        this.db.prepare('UPDATE principals SET name=? WHERE id=?').run(name,input.principalId)
      }
      const avatar=input.avatar===undefined?this.avatarOf(input.principalId):this.applyAvatar(input.principalId,input.avatar,input.uploadId)
      return {principalId:input.principalId,displayName:this.db.prepare('SELECT name FROM principals WHERE id=?').get(input.principalId).name,avatar}
    })
  }
  avatarRead(auth,input) {
    this.check(auth);identifier(input.principalId)
    const target=this.db.prepare('SELECT p.instance_id FROM principals p JOIN instances i ON i.id=p.instance_id WHERE p.id=? AND i.trusted=1').get(input.principalId)
    requireThat(target,'UNKNOWN_PRINCIPAL')
    const shared=this.db.prepare("SELECT 1 FROM memberships them JOIN conversations c ON c.id=them.conversation_id JOIN memberships us ON us.conversation_id=c.id JOIN principals p ON p.id=us.principal_id WHERE them.principal_id=? AND them.active=1 AND us.active=1 AND c.kind='group' AND c.closed=0 AND p.instance_id=? LIMIT 1").get(input.principalId,auth.instanceId)
    const visible=this.canReadPrincipalAvatar ? this.canReadPrincipalAvatar(auth,input.principalId) : this.contacts(auth).some(person=>person.principalId===input.principalId)
    requireThat(target.instance_id===auth.instanceId||shared||visible===true,'FORBIDDEN')
    requireThat(validAvatarRevision(input.imageRevision),'INVALID_AVATAR_REVISION')
    const offset=input.offset??0,limit=input.limit??AVATAR_CHUNK_LENGTH
    requireThat(Number.isSafeInteger(offset)&&offset>=0&&Number.isSafeInteger(limit)&&limit>0&&limit<=AVATAR_CHUNK_LENGTH,'INVALID_AVATAR_CHUNK')
    const row=this.db.prepare('SELECT image_revision,image FROM principal_avatar WHERE principal_id=?').get(input.principalId)
    requireThat(row?.image&&row.image_revision===input.imageRevision,'AVATAR_REVISION_MISMATCH')
    requireThat(offset<=row.image.length,'INVALID_AVATAR_CHUNK')
    const data=row.image.slice(offset,offset+limit),nextOffset=offset+data.length
    return {principalId:input.principalId,imageRevision:input.imageRevision,offset,data,totalLength:row.image.length,nextOffset,done:nextOffset===row.image.length}
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
      requireThat(this.isPublished(author.principalId)&&this.isPublished(input.otherPrincipalId),'BOT_NOT_PUBLISHED')
      this.contactPolicy?.(auth,author.principalId,input.otherPrincipalId)
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
      requireThat(this.isPublished(input.inviteePrincipalId),'BOT_NOT_PUBLISHED')
      this.contactPolicy?.(auth,input.principalId,input.inviteePrincipalId)
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
        requireThat(bot?.kind==='bot'&&this.isPublished(input.adminBotPrincipalId),'INVALID_ADMIN')
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
      const {target,role,mode}=this.memberPolicy(caller,input)
      this.db.prepare('UPDATE memberships SET role=?,manager=?,speaking_mode=? WHERE conversation_id=? AND principal_id=?').run(role,Number(role!=='member'),mode,input.conversationId,input.targetPrincipalId)
      this.db.prepare('UPDATE conversations SET version=version+1 WHERE id=?').run(input.conversationId)
      if(role==='member'&&target.role==='admin')this.db.prepare('UPDATE invites SET active=0 WHERE conversation_id=? AND inviter_id=?').run(input.conversationId,input.targetPrincipalId)
      this.event(input.conversationId,'membership.policy',{principalId:input.targetPrincipalId,role,speakingMode:mode})
      return {updated:true,membershipVersion:input.expectedVersion+1}
    })
  }
  memberPolicy(caller,input) {
    const target=this.db.prepare('SELECT m.*,p.kind FROM memberships m JOIN principals p ON p.id=m.principal_id WHERE m.conversation_id=? AND m.principal_id=? AND m.active=1').get(input.conversationId,input.targetPrincipalId)
    requireThat(target,'NOT_A_MEMBER')
    requireThat(caller.role==='owner'||caller.role==='admin'&&target.role==='member'&&input.role===undefined,'FORBIDDEN')
    const role=input.role??target.role,mode=input.speakingMode??target.speaking_mode
    requireThat(target.role!=='owner'||role==='owner','OWNER_TRANSFER_REQUIRED')
    requireThat(role===target.role||['member','admin'].includes(role),'INVALID_ROLE')
    requireThat(target.role==='owner'||role!=='owner','OWNER_TRANSFER_REQUIRED')
    requireThat((target.kind==='human'?['readOnly','speak']:['passive','active']).includes(mode),'INVALID_SPEAKING_MODE')
    return {target,role,mode}
  }
  settings(auth,input) {
    return this.operation(auth,input.operationId,input,()=>{
      const {caller,group}=this.groupActor(auth,input)
      requireThat(['owner','admin'].includes(caller.role),'FORBIDDEN')
      requireThat(Object.keys(input).every(key=>['conversationId','principalId','membershipEpoch','expectedVersion','operationId','title','routing','policies'].includes(key)),'INVALID_REQUEST')
      if(input.title!==undefined)requireThat(typeof input.title==='string'&&input.title.trim()&&input.title.length<=256,'INVALID_REQUEST')
      const routing=input.routing
      if(routing!==undefined){
        requireThat(routing&&typeof routing==='object'&&!Array.isArray(routing)&&Object.keys(routing).every(key=>['mode','adminBotPrincipalId'].includes(key))&&['admin','mentionsOnly'].includes(routing.mode),'INVALID_REQUEST')
        requireThat(routing.adminBotPrincipalId===undefined||routing.adminBotPrincipalId===null||typeof routing.adminBotPrincipalId==='string','INVALID_REQUEST')
        if(routing.mode==='admin')requireThat(typeof routing.adminBotPrincipalId==='string'&&this.db.prepare("SELECT 1 FROM memberships m JOIN principals p ON p.id=m.principal_id WHERE m.conversation_id=? AND m.principal_id=? AND m.active=1 AND p.kind='bot'").get(input.conversationId,routing.adminBotPrincipalId)&&this.isPublished(routing.adminBotPrincipalId),'INVALID_ADMIN')
      }
      requireThat(input.policies===undefined||Array.isArray(input.policies)&&input.policies.length<=this.limits.maxMembers,'INVALID_REQUEST')
      const policies=[],seen=new Set()
      for(const policy of input.policies??[]){
        requireThat(policy&&typeof policy==='object'&&!Array.isArray(policy)&&Object.keys(policy).every(key=>['targetPrincipalId','role','speakingMode'].includes(key))
          &&(policy.role!==undefined||policy.speakingMode!==undefined),'INVALID_REQUEST')
        identifier(policy.targetPrincipalId)
        requireThat(!seen.has(policy.targetPrincipalId),'INVALID_REQUEST');seen.add(policy.targetPrincipalId)
        requireThat(policy.role===undefined||['member','admin'].includes(policy.role),'INVALID_ROLE')
        requireThat(policy.speakingMode===undefined||typeof policy.speakingMode==='string','INVALID_SPEAKING_MODE')
        policies.push(this.memberPolicy(caller,{...policy,conversationId:input.conversationId}))
      }
      requireThat(input.title!==undefined||routing!==undefined||policies.length>0,'INVALID_REQUEST')
      this.db.prepare('UPDATE conversations SET title=?,routing_mode=?,admin_bot=?,version=version+1 WHERE id=?').run(input.title?.trim()??group.title,routing?.mode??group.routing_mode,
        routing ? routing.mode==='admin'?routing.adminBotPrincipalId:null : group.admin_bot,input.conversationId)
      const changed=[]
      for(const {target,role,mode} of policies){
        this.db.prepare('UPDATE memberships SET role=?,manager=?,speaking_mode=? WHERE conversation_id=? AND principal_id=?').run(role,Number(role!=='member'),mode,input.conversationId,target.principal_id)
        if(role==='member'&&target.role==='admin')this.db.prepare('UPDATE invites SET active=0 WHERE conversation_id=? AND inviter_id=?').run(input.conversationId,target.principal_id)
        changed.push({principalId:target.principal_id,role,speakingMode:mode})
      }
      this.event(input.conversationId,'group.settings.changed',{membershipVersion:group.version+1,...(input.title!==undefined?{title:input.title.trim()}:{}),
        ...(routing?{routing:{mode:routing.mode,adminBotPrincipalId:routing.mode==='admin'?routing.adminBotPrincipalId:null}}:{}),...(policies.length?{policies:changed}:{})})
      return {conversationId:input.conversationId,updated:true,membershipVersion:group.version+1}
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
      requireThat(!message.messageId.startsWith('bot-work-started:'),'MESSAGE_ID_CONFLICT')
      requireThat(this.isPublished(author.principalId),'BOT_NOT_PUBLISHED')
      this.dmPolicy?.(message.conversationId)
      requireThat(typeof message.membershipEpoch==='string','MEMBERSHIP_EPOCH_REQUIRED')
      const sender=this.member(auth,message.conversationId,author.principalId,message.membershipEpoch)
      requireThat(!this.db.prepare('SELECT 1 FROM events WHERE id=?').get(message.messageId),'MESSAGE_ID_CONFLICT')
      const conversation=this.db.prepare('SELECT * FROM conversations WHERE id=?').get(message.conversationId)
      if(conversation.kind==='dm')requireThat(!this.db.prepare("SELECT 1 FROM memberships m JOIN principals p ON p.id=m.principal_id JOIN principal_publication pub ON pub.principal_id=p.id WHERE m.conversation_id=? AND m.active=1 AND p.kind='bot' AND pub.published=0").get(message.conversationId),'BOT_NOT_PUBLISHED')
      if(conversation.kind==='group'){
        requireThat(['owner','admin','member'].includes(sender.role),'FORBIDDEN')
        requireThat(author.kind==='human'?sender.speaking_mode==='speak':['passive','active'].includes(sender.speaking_mode),'SPEAKING_FORBIDDEN')
        requireThat(author.kind!=='bot'||sender.speaking_mode!=='passive'||message.responseToDeliveryId,'PASSIVE_REPLY_REQUIRED')
      }
      let cause
      if(message.responseToDeliveryId || message.causationDeliveryId){
        requireThat(!message.responseToDeliveryId || !message.causationDeliveryId || message.responseToDeliveryId===message.causationDeliveryId,'INVALID_CAUSATION_GRANT')
        const delivery=this.db.prepare('SELECT d.*,m.conversation_id FROM deliveries d JOIN messages m ON m.id=d.message_id WHERE d.id=?').get(message.responseToDeliveryId ?? message.causationDeliveryId)
        requireThat(author.kind==='bot'&&delivery?.ai===1&&delivery.stored===1&&!delivery.revoked&&delivery.recipient_id===author.principalId
          &&delivery.membership_epoch===sender.epoch&&delivery.conversation_id===message.conversationId
          &&(!message.responseToDeliveryId || delivery.message_id===message.replyToMessageId),message.responseToDeliveryId?'INVALID_RESPONSE_GRANT':'INVALID_CAUSATION_GRANT')
        if(message.responseToDeliveryId)requireThat(!this.db.prepare('SELECT 1 FROM responses WHERE delivery_id=?').get(delivery.id),'RESPONSE_ALREADY_SENT')
        cause=delivery
      }
      const members=this.db.prepare('SELECT m.*,p.kind,coalesce(pub.published,1) published FROM memberships m JOIN principals p ON p.id=m.principal_id LEFT JOIN principal_publication pub ON pub.principal_id=p.id WHERE conversation_id=? AND active=1').all(message.conversationId)
      for(const mention of message.mentions) requireThat(members.some(member=>member.principal_id===mention.principalId),'UNKNOWN_MENTION')
      let replyBot
      if(message.replyToMessageId){
        const parent=this.db.prepare('SELECT m.conversation_id,m.seq,m.author_id,p.kind FROM messages m JOIN principals p ON p.id=m.author_id WHERE m.id=?').get(message.replyToMessageId)
        requireThat(parent?.conversation_id===message.conversationId&&parent.seq>=sender.join_seq,'INVALID_REPLY_TARGET')
        if(conversation.kind==='group'&&parent.kind==='bot'){
          const target=members.find(member=>member.principal_id===parent.author_id)
          requireThat(target&&parent.seq>=target.join_seq,'INVALID_REPLY_TARGET')
          if(!message.responseToDeliveryId)replyBot=target.principal_id
        }
      }
      let rootId, parentMessageId=null, depth=0
      if(author.kind==='human')rootId=`message:${message.messageId}`
      else if(cause){
        const parent=this.db.prepare('SELECT * FROM message_causality WHERE message_id=?').get(cause.message_id)
        requireThat(parent,'INVALID_CAUSATION_GRANT')
        rootId=parent.root_id;parentMessageId=cause.message_id;depth=parent.depth+1
      }else{
        const human=this.db.prepare("SELECT m.id FROM messages m JOIN principals p ON p.id=m.author_id WHERE m.conversation_id=? AND p.kind='human' ORDER BY m.seq DESC LIMIT 1").get(message.conversationId)
        rootId=human ? `message:${human.id}` : `genesis:${message.conversationId}`
        const incoming=this.db.prepare('SELECT c.message_id,c.depth FROM message_causality c JOIN messages m ON m.id=c.message_id JOIN deliveries d ON d.message_id=m.id WHERE c.root_id=? AND d.recipient_id=? AND d.membership_epoch=? AND d.ai=1 ORDER BY m.seq DESC LIMIT 1').get(rootId,author.principalId,sender.epoch)
        parentMessageId=incoming?.message_id ?? human?.id ?? null
        depth=(incoming?.depth ?? 0)+1
      }
      this.db.prepare('INSERT OR IGNORE INTO causal_roots(id,conversation_id) VALUES (?,?)').run(rootId,message.conversationId)
      const causality={rootMessageId:rootId.startsWith('message:')?rootId.slice(8):rootId,parentMessageId,depth}
      const pending=this.db.prepare('SELECT count(*) count FROM deliveries WHERE stored=0 AND revoked=0').get().count
      requireThat(pending+members.length<=this.limits.maxPendingDeliveries,'STORAGE_UNAVAILABLE','Pending delivery capacity reached')
      const acceptedAt=new Date().toISOString()
      const event={message,serverAcceptedAt:acceptedAt,payloadHash:digest,causality,conversationId:message.conversationId,conversationSeq:conversation.seq+1,eventId:message.messageId,type:'message'}
      const explicitBots=message.mentions.filter(mention=>members.some(member=>member.kind==='bot'&&member.principal_id===mention.principalId))
      const deliveries=members.map(member=>{
        const mentioned=message.mentions.some(mention=>mention.principalId===member.principal_id)
        const mayReceiveAi=conversation.kind==='dm'||['passive','active'].includes(member.speaking_mode)
        const ai=member.kind==='bot'&&member.published===1&&member.principal_id!==author.principalId&&mayReceiveAi&&(conversation.kind==='dm'?true:
          mentioned||(!explicitBots.length&&replyBot===member.principal_id)||(!replyBot&&!message.mentions.length&&author.kind==='human'&&conversation.routing_mode==='admin'&&conversation.admin_bot===member.principal_id))
        return {deliveryId:randomUUID(),messageId:message.messageId,conversationId:message.conversationId,recipientPrincipalId:member.principal_id,membershipEpoch:member.epoch,routingVersion:conversation.version,notify:member.kind==='human'&&member.principal_id!==author.principalId,ai:Boolean(ai),event}
      })
      const aiCount=deliveries.filter(delivery=>delivery.ai).length
      const used=this.db.prepare('SELECT ai_deliveries FROM causal_roots WHERE id=?').get(rootId).ai_deliveries
      if(aiCount && (depth>=this.limits.maxCausalDepth || used+aiCount>this.limits.maxAiDeliveriesPerRoot)){
        event.dispatchSuppressed='CAUSAL_LIMIT'
        for(const delivery of deliveries)delivery.ai=false
      }else this.db.prepare('UPDATE causal_roots SET ai_deliveries=ai_deliveries+? WHERE id=?').run(aiCount,rootId)
      for(let index=0;index<members.length;index++){
        requireThat(responseBytes(this.syncValue(members[index],Number.MAX_SAFE_INTEGER,[event]))<=this.limits.maxEnvelopeBytes
          &&responseBytes([deliveries[index]])<=this.limits.maxEnvelopeBytes,'PAYLOAD_TOO_LARGE')
      }
      this.event(message.conversationId,'message',{message,serverAcceptedAt:acceptedAt,payloadHash:digest,causality,...(event.dispatchSuppressed?{dispatchSuppressed:event.dispatchSuppressed}:{})},message.messageId)
      this.db.prepare('INSERT INTO messages VALUES (?,?,?,?,?,?,?)').run(message.messageId,message.conversationId,event.conversationSeq,digest,author.principalId,JSON.stringify(message),acceptedAt)
      this.db.prepare('INSERT INTO message_causality VALUES (?,?,?,?)').run(message.messageId,rootId,parentMessageId,depth)
      if(message.responseToDeliveryId)this.db.prepare('INSERT INTO responses VALUES (?,?)').run(message.responseToDeliveryId,message.messageId)
      for(const delivery of deliveries){
        this.db.prepare('INSERT INTO deliveries(id,message_id,recipient_id,membership_epoch,routing_version,notify,ai) VALUES (?,?,?,?,?,?,?)').run(delivery.deliveryId,message.messageId,delivery.recipientPrincipalId,delivery.membershipEpoch,conversation.version,Number(delivery.notify),Number(delivery.ai))
      }
      return this.accepted(this.db.prepare('SELECT * FROM messages WHERE id=?').get(message.messageId))
    })
  }
  accepted(row) {
    const event=JSON.parse(this.db.prepare('SELECT body FROM events WHERE id=?').get(row.id).body)
    return {messageId:row.id,conversationId:row.conversation_id,conversationSeq:row.seq,payloadHash:row.hash,serverAcceptedAt:row.accepted_at,status:'hubAccepted',
      ...(event.causality?{causality:event.causality}:{}),...(event.dispatchSuppressed?{dispatchSuppressed:event.dispatchSuppressed}:{})}
  }
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
    this.dmPolicy?.(input.conversationId)
    return {conversationId:member.conversation_id,principalId:member.principal_id,membershipEpoch:member.epoch,joinSeq:member.join_seq,role:member.role,speakingMode:member.speaking_mode}
  }
  members(auth,input) {
    this.member(auth,input.conversationId,input.principalId,input.membershipEpoch)
    this.dmPolicy?.(input.conversationId)
    const conversation=this.db.prepare('SELECT title,kind,version,routing_mode,admin_bot,owner_id FROM conversations WHERE id=?').get(input.conversationId)
    const members=this.db.prepare('SELECT p.id principalId,p.kind,p.name displayName,p.instance_id homeInstanceId,i.label instanceLabel,m.manager,m.role,m.speaking_mode speakingMode FROM memberships m JOIN principals p ON p.id=m.principal_id JOIN instances i ON i.id=p.instance_id WHERE m.conversation_id=? AND m.active=1 ORDER BY p.id').all(input.conversationId).map(person=>({...person,published:this.isPublished(person.principalId),avatar:this.avatarOf(person.principalId)}))
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
        try{this.dmPolicy?.(row.conversation_id)}catch(error){if(error.code==='CONTACT_REQUIRED')continue;throw error}
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
      if(input.status==='aiStarted'){
        requireThat(row.kind==='bot'&&row.ai===1,'INVALID_RECEIPT')
        requireThat(this.isPublished(row.recipient_id),'BOT_NOT_PUBLISHED')
        this.dmPolicy?.(row.conversation_id)
        requireThat(row.stored===1,'RECEIPT_OUT_OF_ORDER')
        const eventId=`bot-work-started:${row.id}`
        const old=this.db.prepare('SELECT type,body FROM events WHERE id=?').get(eventId)
        if(old){
          const event=JSON.parse(old.body)
          requireThat(old.type==='bot.work.started'&&event.deliveryId===row.id,'MESSAGE_ID_CONFLICT')
          return {deliveryId:row.id,status:input.status,eventId,conversationSeq:event.conversationSeq,serverStartedAt:event.serverStartedAt}
        }
        const serverStartedAt=new Date().toISOString()
        const event=this.event(row.conversation_id,'bot.work.started',{deliveryId:row.id,messageId:row.message_id,principalId:row.recipient_id,membershipEpoch:row.membership_epoch,serverStartedAt},eventId)
        this.db.prepare('UPDATE deliveries SET ai_accepted=1 WHERE id=?').run(row.id)
        return {deliveryId:row.id,status:input.status,eventId,conversationSeq:event.conversationSeq,serverStartedAt}
      }
      const columns={targetStored:'stored',uiApplied:'applied',humanRead:'human_read',aiAccepted:'ai_accepted'}
      const column=Object.hasOwn(columns,input.status)?columns[input.status]:null
      requireThat(column,'INVALID_REQUEST')
      requireThat(input.status!=='humanRead'||row.kind==='human','INVALID_RECEIPT')
      requireThat(input.status!=='aiAccepted'||row.ai===1,'INVALID_RECEIPT')
      if(input.status==='aiAccepted')this.dmPolicy?.(row.conversation_id)
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
