import { identifier, requireThat } from './protocol.js'

function references(value, ids) {
  if (typeof value === 'string') {
    if (ids.has(value)) return true
    // Contact pair keys are JSON arrays inside operation results.
    if (value.startsWith('[')) { try { return references(JSON.parse(value), ids) } catch { return false } }
    return false
  }
  if (Array.isArray(value)) return value.some(item => references(item, ids))
  return value && typeof value === 'object' && Object.values(value).some(item => references(item, ids))
}

// Caller is the separately authenticated administrator, never a group member.
export function deleteDevice(management, input) {
  requireThat(input && typeof input === 'object' && !Array.isArray(input)
    && Object.keys(input).every(key => ['instanceId', 'expectedPairingRevision', 'expectedNameVersion', 'ownedSharedGroups', 'confirmDelete'].includes(key)), 'INVALID_REQUEST')
  const id = identifier(input.instanceId)
  requireThat(input.confirmDelete === true && Number.isSafeInteger(input.expectedPairingRevision) && input.expectedPairingRevision > 0
    && Number.isSafeInteger(input.expectedNameVersion) && input.expectedNameVersion >= 0, 'DEVICE_DELETE_CONFIRMATION_REQUIRED')
  requireThat(Array.isArray(input.ownedSharedGroups) && input.ownedSharedGroups.every(group => group && typeof group === 'object' && !Array.isArray(group)
    && Object.keys(group).sort().join(',') === 'conversationId,version' && typeof group.conversationId === 'string' && Number.isSafeInteger(group.version) && group.version > 0), 'INVALID_REQUEST')
  const { db, store } = management
  let deletedKey, deletedRequests = new Set()
  const result = store.transaction(() => {
    const row = db.prepare('SELECT i.pairing_revision,coalesce(n.version,0) name_version FROM instances i LEFT JOIN hub_instance_names n ON n.instance_id=i.id WHERE i.id=?').get(id)
    if (!row) return { instanceId: id, deleted: true, alreadyDeleted: true }
    requireThat(row.pairing_revision === input.expectedPairingRevision && row.name_version === input.expectedNameVersion, 'DEVICE_DELETE_VERSION_CONFLICT')
    requireThat(!management.isConfiguredPeer?.(id), 'STATIC_PEER_REMOVAL_REQUIRED')
    deletedKey = management.peer(id)?.public_key
    const principalIds = db.prepare('SELECT id FROM principals WHERE instance_id=?').all(id).map(p => p.id)
    const principals = new Set(principalIds)
    const conversations = db.prepare('SELECT * FROM conversations').all().filter(c => principals.has(c.owner_id) || principals.has(c.admin_bot)
      || db.prepare('SELECT 1 FROM memberships WHERE conversation_id=? AND principal_id IN (SELECT id FROM principals WHERE instance_id=?)').get(c.id, id))
    const deletedConversations = new Set(), sharedConversations = []
    for (const conversation of conversations) {
      const shared = db.prepare('SELECT 1 FROM memberships m JOIN principals p ON p.id=m.principal_id WHERE m.conversation_id=? AND p.instance_id<>?').get(conversation.id, id)
      if (conversation.kind === 'dm' || !shared) deletedConversations.add(conversation.id)
      else {
        sharedConversations.push(conversation)
      }
    }
    const ownedSharedGroups = sharedConversations.filter(c => !c.closed && principals.has(c.owner_id)).map(c => ({ conversationId: c.id, version: c.version })).sort((a, b) => a.conversationId.localeCompare(b.conversationId))
    requireThat(JSON.stringify(input.ownedSharedGroups.map(group => ({ conversationId: group.conversationId, version: group.version })).sort((a, b) => a.conversationId.localeCompare(b.conversationId))) === JSON.stringify(ownedSharedGroups), 'DEVICE_DELETE_GROUPS_CHANGED')
    const requests = db.prepare('SELECT id FROM hub_join_requests WHERE instance_id=? OR public_key=(SELECT public_key FROM hub_enrolled_peers WHERE instance_id=?)').all(id, id)
    deletedRequests = new Set(requests.map(request => request.id))
    const contactRequests = db.prepare('SELECT id FROM hub_contact_requests WHERE sender IN (SELECT id FROM principals WHERE instance_id=?) OR target IN (SELECT id FROM principals WHERE instance_id=?)').all(id, id)
    const removedIds = new Set([id, ...principalIds, ...deletedConversations, ...requests.map(r => r.id), ...contactRequests.map(r => r.id)])
    const messages = db.prepare('SELECT id,conversation_id FROM messages').all().filter(m => deletedConversations.has(m.conversation_id))
    const messageIds = new Set(messages.map(m => m.id))
    const deliveries = db.prepare('SELECT id,message_id,recipient_id FROM deliveries').all().filter(d => messageIds.has(d.message_id) || principals.has(d.recipient_id))
    const drop = (table, column, value) => db.prepare(`DELETE FROM ${table} WHERE ${column}=?`).run(value)
    for (const delivery of deliveries) {
      drop('responses', 'delivery_id', delivery.id)
      drop('input_updates', 'parent_delivery_id', delivery.id)
    }
    for (const message of messages) {
      drop('responses', 'message_id', message.id)
      drop('input_updates', 'message_id', message.id)
      drop('message_causality', 'message_id', message.id)
      drop('bot_dispatches', 'cause_key', message.id)
    }
    for (const delivery of deliveries) drop('deliveries', 'id', delivery.id)
    for (const message of messages) drop('messages', 'id', message.id)
    for (const conversationId of deletedConversations) {
      const roots = db.prepare('SELECT id FROM causal_roots WHERE conversation_id=?').all(conversationId)
      for (const root of roots) { removedIds.add(root.id); drop('bot_dispatches', 'cause_key', root.id) }
      for (const table of ['events', 'invites', 'memberships', 'cursors', 'causal_roots']) drop(table, 'conversation_id', conversationId)
      drop('conversations', 'id', conversationId)
    }
    for (const conversation of sharedConversations) {
      if (principals.has(conversation.owner_id) && !conversation.closed) {
        db.prepare('UPDATE memberships SET active=0 WHERE conversation_id=?').run(conversation.id)
        db.prepare('UPDATE deliveries SET revoked=1 WHERE message_id IN (SELECT id FROM messages WHERE conversation_id=?) AND ai_accepted=0').run(conversation.id)
        db.prepare('UPDATE invites SET active=0 WHERE conversation_id=?').run(conversation.id)
        db.prepare("UPDATE conversations SET closed=1,admin_bot=NULL,routing_mode='mentionsOnly' WHERE id=?").run(conversation.id)
        store.event(conversation.id, 'conversation.dissolved', { reason: 'ownerDeviceDeleted' })
      }
      db.prepare("UPDATE conversations SET version=version+1,owner_id=CASE WHEN owner_id IN (SELECT id FROM principals WHERE instance_id=?) THEN NULL ELSE owner_id END,routing_mode=CASE WHEN admin_bot IN (SELECT id FROM principals WHERE instance_id=?) THEN 'mentionsOnly' ELSE routing_mode END,admin_bot=CASE WHEN admin_bot IN (SELECT id FROM principals WHERE instance_id=?) THEN NULL ELSE admin_bot END WHERE id=?").run(id, id, id, conversation.id)
      for (const member of db.prepare('SELECT * FROM memberships WHERE conversation_id=? AND principal_id IN (SELECT id FROM principals WHERE instance_id=?)').all(conversation.id, id)) {
        store.event(conversation.id, 'membership.removed', { principalId: member.principal_id, membershipEpoch: member.epoch, reason: 'deviceDeleted' })
      }
      if (principals.has(conversation.admin_bot)) store.event(conversation.id, 'routing.changed', { mode: 'mentionsOnly', adminBotPrincipalId: null, reason: 'deviceDeleted' })
    }
    for (const principalId of principalIds) {
      for (const column of ['principal_id', 'inviter_id']) drop('invites', column, principalId)
      for (const table of ['memberships', 'cursors', 'principal_preferences', 'principal_profiles', 'principal_publication', 'principal_avatar', 'avatar_uploads', 'hub_user_codes']) drop(table, 'principal_id', principalId)
      for (const column of ['sender', 'target']) drop('hub_contact_requests', column, principalId)
      for (const column of ['left_id', 'right_id']) drop('hub_contacts', column, principalId)
      drop('input_updates', 'recipient_id', principalId)
      for (const column of ['author_id', 'target_id']) drop('bot_dispatches', column, principalId)
    }
    for (const message of messages) removedIds.add(message.id)
    for (const delivery of deliveries) removedIds.add(delivery.id)
    for (const table of ['operations', 'hub_management_operations']) {
      for (const operation of db.prepare(`SELECT * FROM ${table}`).all()) {
        if (operation.instance_id === id || principals.has(operation.actor) || references(JSON.parse(operation.result), removedIds)) drop(table, 'id', operation.id)
      }
    }
    for (const subject of removedIds) drop('hub_admin_audit', 'subject', subject)
    for (const request of requests) drop('hub_join_requests', 'id', request.id)
    for (const table of ['hub_enrolled_peers', 'instance_features', 'instance_addresses', 'hub_instance_names']) drop(table, 'instance_id', id)
    drop('principals', 'instance_id', id)
    drop('instances', 'id', id)
    return { instanceId: id, deleted: true, principalsDeleted: principalIds.length, conversationsDeleted: deletedConversations.size, sharedGroupsRetained: sharedConversations.length, sharedGroupsClosed: ownedSharedGroups.length }
  })
  // Only invalidate in-memory proofs after the durable transaction succeeds.
  for (const [challengeId, challenge] of management.challenges) if (challenge.instanceId === id || deletedRequests.has(challenge.requestId) || deletedKey && challenge.publicKey === deletedKey) management.challenges.delete(challengeId)
  return result
}
