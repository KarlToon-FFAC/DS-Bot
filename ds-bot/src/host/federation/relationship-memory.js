import { createHash } from 'node:crypto'
import { looksSecret } from '../memory.js'

export const RELATIONSHIP_TOPICS = ['identity', 'organization', 'expertise', 'collaboration-role', 'purpose', 'collaboration-guidance']
const fail = code => { throw Object.assign(new Error(code), { code }) }
const checked = (condition, code = 'INVALID_RELATIONSHIP_MEMORY') => { if (!condition) fail(code) }
const bounded = value => typeof value === 'string' && value.trim().length > 0 && value.length <= 512
const key = (...parts) => JSON.stringify(parts)
const MAX_ENTRIES = 32
const MAX_LEARNED_ENTRIES = 24

// This store is local to the communication queue. Nothing here is a Hub policy,
// a grant of authority, or a copy of another Bot's memory.
export class RelationshipMemory {
  constructor(queue, settings) {
    this.queue = queue
    this.hub = key(settings.queueScope ?? 'legacy', queue.instanceId, settings.hubId ?? null, new URL(settings.url).href)
  }
  scope(binding) {
    checked(this.queue.owns(binding.recipientPrincipalId) && binding.recipientPrincipalId.startsWith('bot:'), 'AUTHOR_MISMATCH')
    checked((binding.conversationId === undefined && binding.membershipEpoch === undefined)
      || bounded(binding.conversationId) && bounded(binding.membershipEpoch))
    return key(this.hub, binding.recipientPrincipalId, binding.conversationId ?? '', binding.membershipEpoch ?? '')
  }
  subject(binding, info, input) {
    checked(['self', 'contact', 'group'].includes(input.subjectKind))
    if (input.subjectKind === 'self') {
      checked(input.subjectPrincipalId === undefined || input.subjectPrincipalId === binding.recipientPrincipalId)
      return binding.recipientPrincipalId
    }
    if (input.subjectKind === 'group') {
      checked(binding.conversationId !== undefined && info.kind === 'group' && input.subjectPrincipalId === undefined)
      return binding.conversationId
    }
    checked(bounded(input.subjectPrincipalId) && input.subjectPrincipalId !== binding.recipientPrincipalId
      && info.members?.some(member => member.principalId === input.subjectPrincipalId), 'RELATIONSHIP_SUBJECT_NOT_VISIBLE')
    return input.subjectPrincipalId
  }
  save(binding, info, input, source, status) {
    checked(bounded(input.text) && RELATIONSHIP_TOPICS.includes(input.topic))
    checked(!looksSecret(input.text), 'RELATIONSHIP_SECRET_REFUSED')
    const scope = this.scope(binding), subjectId = this.subject(binding, info, input)
    const body = { subjectKind: input.subjectKind, subjectId, topic: input.topic, text: input.text.trim(), status, source }
    const id = createHash('sha256').update(key(scope, body)).digest('hex')
    return this.queue.transaction(() => {
      const prior = this.queue.db.prepare('SELECT body FROM relationship_memory WHERE scope=? AND id=?').get(scope, id)
      if (prior) return JSON.parse(prior.body)
      checked(this.queue.db.prepare('SELECT count(*) n FROM relationship_memory WHERE scope=?').get(scope).n < MAX_ENTRIES, 'RELATIONSHIP_MEMORY_FULL')
      if (status !== 'local-confirmed') checked(this.queue.db.prepare("SELECT count(*) n FROM relationship_memory WHERE scope=? AND json_extract(body,'$.status')!='local-confirmed'").get(scope).n < MAX_LEARNED_ENTRIES, 'RELATIONSHIP_MEMORY_FULL')
      let sourceVersionUncertain = false
      if (source.kind === 'message') {
        const member = JSON.parse(this.queue.member(binding.conversationId, binding.recipientPrincipalId, binding.membershipEpoch).body)
        sourceVersionUncertain = member.membershipVersion !== info.membershipVersion
          || this.queue.cursor(binding.conversationId, binding.recipientPrincipalId, binding.membershipEpoch) < (member.watermark ?? 0)
      }
      const entry = { id, ...body, recordedAt: new Date().toISOString(),
        ...(binding.conversationId !== undefined ? { observedMembershipVersion: info.membershipVersion } : {}),
        ...(sourceVersionUncertain ? { sourceVersionUncertain: true } : {}) }
      this.queue.db.prepare('INSERT INTO relationship_memory(scope,id,body) VALUES (?,?,?)').run(scope, id, JSON.stringify(entry))
      return entry
    })
  }
  remember(binding, info, input, event) {
    checked(binding.conversationId !== undefined)
    checked(Object.keys(input).every(field => ['conversationId', 'membershipEpoch', 'subjectKind', 'subjectPrincipalId', 'topic', 'text', 'sourceMessageId', 'confidence'].includes(field)))
    checked(input.confidence === undefined || ['reported', 'inferred'].includes(input.confidence))
    checked(event?.type === 'message' && event.conversationId === binding.conversationId
      && event.message?.messageId === input.sourceMessageId, 'RELATIONSHIP_SOURCE_REQUIRED')
    return this.save(binding, info, input, { kind: 'message', conversationId: binding.conversationId,
      membershipEpoch: binding.membershipEpoch, messageId: event.message.messageId,
      authorPrincipalId: event.message.author.principalId, conversationSeq: event.conversationSeq }, input.confidence ?? 'reported')
  }
  seed(binding, info, input, localUserPrincipalId) {
    checked(binding.conversationId !== undefined || input.shareAcrossConversations === true, 'RELATIONSHIP_SHARING_CONFIRMATION_REQUIRED')
    return this.save(binding, info, input, { kind: 'local-user', authorPrincipalId: localUserPrincipalId,
      audience: binding.conversationId === undefined ? 'current-and-future-conversations-in-this-hub' : 'this-conversation-epoch' }, 'local-confirmed')
  }
  entries(binding) {
    return this.queue.db.prepare('SELECT body FROM relationship_memory WHERE scope=? ORDER BY rowid DESC').all(this.scope(binding)).map(row => JSON.parse(row.body))
  }
  read(binding, info = {}) {
    const visible = entry => entry.subjectKind !== 'contact' || info.members?.some(member => member.principalId === entry.subjectId)
    const profile = { recipientPrincipalId: binding.recipientPrincipalId }
    const entries = binding.conversationId === undefined ? this.entries(profile)
      : [...this.entries(binding), ...this.entries(profile)]
    const changeSeq = binding.conversationId === undefined ? 0 : this.queue.db.prepare(`SELECT max(seq) seq FROM events
      WHERE conversation_id=? AND principal_id=? AND epoch=? AND seq<=? AND json_extract(body,'$.type') IN
      ('membership.joined','membership.removed','membership.restored','membership.policy','ownership.transferred','ownership.reclaimed','routing.changed','group.settings.changed','conversation.renamed','conversation.dissolved')`)
      .get(binding.conversationId, binding.recipientPrincipalId, binding.membershipEpoch,
        this.queue.cursor(binding.conversationId, binding.recipientPrincipalId, binding.membershipEpoch)).seq ?? 0
    return entries.filter(visible).map(entry => ({ ...entry,
      ...(entry.observedMembershipVersion !== undefined ? { needsReview: Boolean(entry.sourceVersionUncertain)
        || entry.observedMembershipVersion !== info.membershipVersion
        || entry.source.kind === 'message' && entry.source.conversationSeq < changeSeq } : {}) }))
  }
  forget(binding, id) {
    checked(typeof id === 'string' && /^[a-f0-9]{64}$/.test(id))
    return this.queue.transaction(() => ({ removed: this.queue.db.prepare('DELETE FROM relationship_memory WHERE scope=? AND id=?').run(this.scope(binding), id).changes > 0 }))
  }
}

export function relationshipMemoryContext(memory, binding, info = {}) {
  const participants = (info.members ?? []).slice(0, 32).map(member => ({ principalId: member.principalId,
    displayName: member.displayName, homeInstanceId: member.principalId.split(':')[1],
    instanceLabel: member.instanceLabel, kind: member.kind, groupRole: member.role }))
  const entries = [], available = memory.read(binding, info).sort((a, b) => Number(b.status === 'local-confirmed') - Number(a.status === 'local-confirmed'))
  let length = 0
  for (const entry of available) {
    const size = JSON.stringify(entry).length
    if (length + size > 24000) break
    entries.push(entry); length += size
  }
  return { conversation: { conversationId: binding.conversationId, kind: info.kind, title: info.title, membershipVersion: info.membershipVersion },
    participants, omittedParticipants: Math.max(0, (info.members?.length ?? 0) - participants.length),
    entries, omittedEntries: available.length - entries.length }
}
