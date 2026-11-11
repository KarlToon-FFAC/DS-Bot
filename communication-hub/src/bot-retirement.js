import { removeGroupReceivers } from './group-routing.js'

// Tombstones are permanent. Re-publishing requires a different principal ID.
export function retireBot(store, principalId) {
  if (store.retirementOf(principalId)) return
  const at = new Date().toISOString()
  store.db.prepare('INSERT INTO principal_retirements VALUES (?,?)').run(principalId, at)
  store.db.prepare('UPDATE invites SET active=0 WHERE principal_id=? OR inviter_id=?').run(principalId, principalId)
  store.db.prepare('UPDATE deliveries SET revoked=1 WHERE recipient_id=? OR message_id IN (SELECT id FROM messages WHERE author_id=?)').run(principalId, principalId)
  for (const member of store.db.prepare('SELECT m.*,c.kind FROM memberships m JOIN conversations c ON c.id=m.conversation_id WHERE m.principal_id=? AND m.active=1').all(principalId)) {
    const event = store.event(member.conversation_id, 'principal.retired', { principalId, retiredAt: at })
    store.db.prepare('INSERT OR IGNORE INTO retired_memberships VALUES (?,?,?,?)').run(member.conversation_id, principalId, member.epoch, event.conversationSeq)
    store.db.prepare('UPDATE memberships SET active=0,manager=0 WHERE conversation_id=? AND principal_id=?').run(member.conversation_id, principalId)
    store.db.prepare('UPDATE conversations SET version=version+1 WHERE id=?').run(member.conversation_id)
    removeGroupReceivers(store,member.conversation_id,[principalId])
    if (member.kind === 'dm') store.db.prepare('UPDATE deliveries SET revoked=1 WHERE message_id IN (SELECT id FROM messages WHERE conversation_id=?)').run(member.conversation_id)
  }
}
