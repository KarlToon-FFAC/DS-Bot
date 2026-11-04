import { createHash, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto'
import { requireThat } from './protocol.js'
import { managementPage } from './management-ui.js'

const digest = value => createHash('sha256').update(value).digest('hex')
const same = (a, b) => typeof a === 'string' && typeof b === 'string' && timingSafeEqual(createHash('sha256').update(a).digest(), createHash('sha256').update(b).digest())
export function initializeAdmin(management, password) {
  requireThat(typeof password === 'string' && password.length >= 16 && password.length <= 1024, 'INVALID_ADMIN_PASSWORD')
  const salt = randomBytes(16).toString('hex'), verifier = scryptSync(password, salt, 32).toString('hex')
  management.db.prepare('INSERT INTO hub_management VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run('adminVerifier', JSON.stringify({ salt, verifier }))
  management.audit('admin.initialize', 'local')
}
export function createManagementHttp(management, { password, origin, onRevoke = id => management.revoke(id) } = {}) {
  requireThat(typeof origin === 'string' && ['http:', 'https:'].includes(new URL(origin).protocol) && new URL(origin).origin === origin, 'INVALID_CONFIG')
  requireThat(origin.startsWith('https:') || ['127.0.0.1', '[::1]'].includes(new URL(origin).hostname), 'TLS_REQUIRED')
  const secure = origin.startsWith('https:'), sessions = new Map()
  let verifier
  if (password !== undefined) {
    requireThat(typeof password === 'string' && password.length >= 16 && password.length <= 1024, 'INVALID_ADMIN_PASSWORD')
    const salt = randomBytes(16).toString('hex'); verifier = { salt, verifier: scryptSync(password, salt, 32).toString('hex') }
  } else {
    const saved = management.db.prepare('SELECT value FROM hub_management WHERE key=?').get('adminVerifier')
    if (saved) verifier = JSON.parse(saved.value)
  }
  const check = value => typeof value === 'string' && value.length <= 1024 && same(scryptSync(value, verifier.salt, 32).toString('hex'), verifier.verifier)
  const cookie = token => `dsbot_hub_admin=${token}; Path=/admin; HttpOnly; SameSite=Strict; Max-Age=900${secure ? '; Secure' : ''}`
  const headers = { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer',
    'content-security-policy': "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'" }
  const send = (res, status, value, extra = {}) => { res.writeHead(status, { ...headers, 'content-type': 'application/json', ...extra }); res.end(JSON.stringify(value)) }
  const body = async req => {
    requireThat((req.headers['content-type'] ?? '').split(';')[0] === 'application/json', 'INVALID_REQUEST')
    let size = 0, chunks = []
    for await (const chunk of req) { size += chunk.length; requireThat(size <= 8192, 'PAYLOAD_TOO_LARGE'); chunks.push(chunk) }
    let value
    try { value = JSON.parse(Buffer.concat(chunks).toString('utf8')) } catch { requireThat(false, 'INVALID_REQUEST') }
    requireThat(value && typeof value === 'object' && !Array.isArray(value), 'INVALID_REQUEST'); return value
  }
  const handler = async (req, res) => {
    const path = (req.url ?? '').split('?')[0]
    if (path === '/hub-info' && req.method === 'GET') { send(res, 200, management.info()); return true }
    if (!path.startsWith('/admin')) return false
    if (!verifier) { send(res, 404, { error: 'MANAGEMENT_DISABLED' }); return true }
    try {
      const expectedHost = new URL(origin).host
      requireThat(req.headers.host === expectedHost, 'ORIGIN_REJECTED')
      const requestOrigin = req.headers.origin
      if (requestOrigin !== undefined) requireThat(requestOrigin === origin, 'ORIGIN_REJECTED')
      if (['/admin', '/admin/'].includes(path) && req.method === 'GET') {
        res.writeHead(200, { ...headers, 'content-type': 'text/html; charset=utf-8' }); res.end(managementPage); return true
      }
      if (path === '/admin/app.js' && req.method === 'GET') {
        res.writeHead(200, { ...headers, 'content-type': 'text/javascript; charset=utf-8' }); res.end((await import('./management-ui.js')).managementScript); return true
      }
      requireThat(req.method === 'POST', 'INVALID_REQUEST')
      for (const [key, session] of sessions) if (session.expires <= management.now()) sessions.delete(key)
      const address = req.socket.remoteAddress ?? 'unknown'
      if (path === '/admin/api/login') {
        requireThat(requestOrigin === origin, 'ORIGIN_REJECTED')
        management.rate('admin-login:global', 30); management.rate(`admin-login:${address}`, 5)
        const input = await body(req); requireThat(check(input.password), 'UNAUTHENTICATED')
        requireThat(sessions.size < 64, 'RATE_LIMITED')
        const token = randomBytes(32).toString('base64url'), csrf = randomBytes(32).toString('base64url')
        sessions.set(digest(token), { csrf, expires: management.now() + 900000 })
        send(res, 200, { ok: true, csrf }, { 'set-cookie': cookie(token) }); return true
      }
      const bearer = /^Bearer ([^\s]+)$/.exec(req.headers.authorization ?? '')?.[1]
      let session
      if (bearer) {
        management.rate('admin-bearer:global', 100)
        management.rate(`admin-bearer:${address}`, 30)
        requireThat(check(bearer), 'UNAUTHENTICATED')
      } else {
        const token = /(?:^|;\s*)dsbot_hub_admin=([^;]+)/.exec(req.headers.cookie ?? '')?.[1]
        session = token && sessions.get(digest(token))
        requireThat(session && requestOrigin === origin && same(req.headers['x-csrf-token'], session.csrf), 'UNAUTHENTICATED')
      }
      const input = await body(req)
      let value
      if (path === '/admin/api/logout') {
        if (session) for (const [key, s] of sessions) if (s === session) sessions.delete(key)
        send(res, 200, { ok: true }, { 'set-cookie': cookie('') + '; Max-Age=0' }); return true
      }
      if (path === '/admin/api/state') value = { ...management.info(), requests: management.joins(), instances: management.instances() }
      else if (path === '/admin/api/decide') value = management.decide(input)
      else if (path === '/admin/api/revoke') { value = await onRevoke(input.instanceId); management.audit('admin.instance.revoke', input.instanceId) }
      else if (path === '/admin/api/repair') value = management.repair(input)
      else if (path === '/admin/api/rename') value = management.rename(input)
      else requireThat(false, 'UNKNOWN_OPERATION')
      send(res, 200, { ok: true, value })
    } catch (error) {
      const code = ['INVALID_REQUEST', 'UNAUTHENTICATED', 'ORIGIN_REJECTED', 'RATE_LIMITED', 'PAYLOAD_TOO_LARGE', 'JOIN_VERSION_CONFLICT', 'PAIRING_REVISION_CONFLICT', 'INSTANCE_NOT_FOUND', 'INSTANCE_NAME_VERSION_CONFLICT', 'UNKNOWN_OPERATION', 'ALREADY_ENROLLED', 'DIRECTORY_FULL'].includes(error.code) ? error.code : 'MANAGEMENT_UNAVAILABLE'
      send(res, code === 'RATE_LIMITED' ? 429 : code === 'UNAUTHENTICATED' ? 401 : 400, { ok: false, error: { code } })
    }
    return true
  }
  return { handle: handler, close() { sessions.clear() }, enabled: Boolean(verifier) }
}
