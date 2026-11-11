export const MULTI_BOT_ROUTING_CAPABILITY = 'multi-bot-default-receivers'
const fail = code => { throw Object.assign(new Error(code), {code}) }
const routeOf = (type, payload) => type === 'group.routing' ? payload : type === 'group.settings' ? payload.routing : undefined

export function usesDefaultBotList(type, payload) {
  return routeOf(type,payload)?.defaultBotPrincipalIds !== undefined
}

export function groupRoutingPayload(type, payload) {
  const route = routeOf(type,payload)
  if (route?.defaultBotPrincipalIds === undefined) return payload
  if (!['admin','mentionsOnly'].includes(route.mode)) fail('INVALID_REQUEST')
  const list = route.defaultBotPrincipalIds
  if (!Array.isArray(list) || list.length > 64 || list.some(id => typeof id !== 'string' || !id)) fail('INVALID_REQUEST')
  const ids = [...new Set(list)].sort()
  if (route.adminBotPrincipalId != null && (ids.length !== 1 || ids[0] !== route.adminBotPrincipalId)) fail('INVALID_REQUEST')
  if (route.mode === 'admin' && !ids.length) fail('INVALID_ADMIN')
  if (route.mode === 'mentionsOnly' && ids.length) fail('INVALID_REQUEST')
  const normalized = {...Object.fromEntries(Object.entries(route).filter(([,value])=>value !== undefined)),defaultBotPrincipalIds:ids}
  // Singleton/disabled settings use the existing wire shape even on newer Hubs,
  // so an uncertain operation keeps the same payload across capability changes.
  if (ids.length <= 1) {
    delete normalized.defaultBotPrincipalIds
    normalized.adminBotPrincipalId = ids[0] ?? null
  }
  return type === 'group.settings' ? {...payload,routing:normalized} : normalized
}
