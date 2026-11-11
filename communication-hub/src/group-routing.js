import { identifier, requireThat } from './protocol.js'

export function defaultReceivingBots(group) {
  if (group.routing_mode !== 'admin') return []
  const saved = group.default_bots == null ? [] : JSON.parse(group.default_bots)
  // Older Hubs can still edit the legacy singleton field on an existing database.
  return saved.length && saved[0] === group.admin_bot ? saved : group.admin_bot ? [group.admin_bot] : []
}

export function normalizeGroupRouting(store, conversationId, input) {
  requireThat(input && typeof input === 'object' && !Array.isArray(input)
    && Object.keys(input).every(key => ['mode','adminBotPrincipalId','defaultBotPrincipalIds'].includes(key))
    && ['admin','mentionsOnly'].includes(input.mode), 'INVALID_REQUEST')
  requireThat(input.adminBotPrincipalId === undefined || input.adminBotPrincipalId === null || typeof input.adminBotPrincipalId === 'string', 'INVALID_REQUEST')
  const plural = input.defaultBotPrincipalIds !== undefined
  if (plural) requireThat(Array.isArray(input.defaultBotPrincipalIds) && input.defaultBotPrincipalIds.length <= store.limits.maxMembers, 'INVALID_REQUEST')
  const ids = plural ? [...new Set(input.defaultBotPrincipalIds.map(identifier))].sort() : input.mode === 'admin' && input.adminBotPrincipalId ? [identifier(input.adminBotPrincipalId)] : []
  if (plural && input.adminBotPrincipalId != null) requireThat(ids.length === 1 && ids[0] === input.adminBotPrincipalId, 'INVALID_REQUEST')
  if (input.mode === 'mentionsOnly') requireThat(!plural || ids.length === 0, 'INVALID_REQUEST')
  else {
    requireThat(ids.length > 0, 'INVALID_ADMIN')
    for (const id of ids) requireThat(store.db.prepare(`SELECT 1 FROM memberships m JOIN principals p ON p.id=m.principal_id
      WHERE m.conversation_id=? AND m.principal_id=? AND m.active=1 AND p.kind='bot' AND m.speaking_mode IN ('passive','active')`).get(conversationId,id) && store.isPublished(id), 'INVALID_ADMIN')
  }
  return {mode:input.mode,defaultBotPrincipalIds:input.mode === 'admin' ? ids : [],adminBotPrincipalId:input.mode === 'admin' ? ids[0] : null}
}

export function writeGroupRouting(store, conversationId, routing) {
  store.db.prepare('UPDATE conversations SET routing_mode=?,admin_bot=?,default_bots=? WHERE id=?')
    .run(routing.mode,routing.defaultBotPrincipalIds[0] ?? null,JSON.stringify(routing.defaultBotPrincipalIds),conversationId)
}

export function removeGroupReceivers(store, conversationId, principalIds) {
  const group = store.db.prepare('SELECT * FROM conversations WHERE id=?').get(conversationId)
  const before = defaultReceivingBots(group), removed = new Set(principalIds)
  const ids = before.filter(id => !removed.has(id))
  if (ids.length === before.length) return null
  const routing = {mode:ids.length ? 'admin' : 'mentionsOnly',defaultBotPrincipalIds:ids,adminBotPrincipalId:ids[0] ?? null}
  writeGroupRouting(store,conversationId,routing)
  return routing
}
