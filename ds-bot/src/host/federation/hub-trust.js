import { createHash, verify, X509Certificate } from 'node:crypto'
import { isIP } from 'node:net'

const fail = code => { throw Object.assign(new Error(code), { code }) }
const digest = value => createHash('sha256').update(value).digest('hex')
const MAX_AGE = 7 * 86400000
const certificates = value => {
  if (typeof value !== 'string' || value.length > 20000) fail('INVALID_HUB_TRUST')
  const blocks = value.match(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g) ?? []
  if (!blocks.length || blocks.length > 8 || value.replace(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g, '').trim()) fail('INVALID_HUB_TRUST')
  try { return blocks.map(pem => new X509Certificate(pem)) } catch { fail('INVALID_HUB_TRUST') }
}
const valid = (cert, now) => {
  if (!(Date.parse(cert.validFrom) <= now && now < Date.parse(cert.validTo))) fail('HUB_TRUST_EXPIRED')
}
export function trustRoots(caPem, now = Date.now()) {
  const roots = certificates(caPem)
  if (roots.length > 4) fail('INVALID_HUB_TRUST')
  for (const cert of roots) {
    valid(cert, now)
    if (!cert.ca || !cert.checkIssued(cert) || !cert.verify(cert.publicKey)) fail('INVALID_HUB_TRUST')
  }
  return roots
}
export const trustFingerprint = roots => digest(roots.map(cert => digest(cert.raw)).sort().join(':'))
export function scopedTrust(value, hub, now = Date.now()) {
  if (!value || value.hubId !== hub.hubId || value.url !== hub.url) fail('HUB_TRUST_BINDING_MISMATCH')
  const roots = trustRoots(value.caPem, now)
  if (value.fingerprint !== trustFingerprint(roots)) fail('INVALID_HUB_TRUST')
  return { hubId: hub.hubId, url: hub.url, caPem: roots.map(cert => cert.toString()).join('\n'), fingerprint: value.fingerprint }
}
export const hubCodeTranscript = body => JSON.stringify(['dsbot-hub:2', body.hubId, body.url, body.issuedAt, body.expiresAt, body.caPem, body.certificatePem])
export function verifyHubCode(body, now = Date.now()) {
  if (Object.keys(body).sort().join(',') !== 'caPem,certificatePem,expiresAt,hubId,issuedAt,signature,url') fail('INVALID_HUB_CODE')
  if (!Number.isSafeInteger(body.issuedAt) || !Number.isSafeInteger(body.expiresAt) || body.issuedAt > now + 60000
    || body.expiresAt <= now || body.expiresAt <= body.issuedAt || body.expiresAt - body.issuedAt > MAX_AGE) fail('HUB_CODE_EXPIRED')
  const roots = trustRoots(body.caPem, now), chain = certificates(body.certificatePem), leaf = chain[0]
  for (const cert of chain) valid(cert, now)
  if (body.expiresAt > Date.parse(leaf.validTo)) fail('HUB_CODE_EXPIRED')
  const host = new URL(body.url).hostname.replace(/^\[|\]$/g, '')
  if (!(isIP(host) ? leaf.checkIP(host) : leaf.checkHost(host, { subject: 'never' }))) fail('HUB_TLS_HOSTNAME_MISMATCH')
  const anchored = (cert, seen = new Set()) => {
    if (roots.some(root => root.raw.equals(cert.raw))) return true
    if (seen.has(cert.fingerprint256) || seen.size > 8) return false
    const next = new Set(seen).add(cert.fingerprint256)
    return [...chain.slice(1), ...roots].some(issuer => issuer.ca && cert.checkIssued(issuer) && cert.verify(issuer.publicKey) && anchored(issuer, next))
  }
  if (leaf.ca || !anchored(leaf)) fail('INVALID_HUB_TRUST')
  if (typeof body.signature !== 'string' || !/^[A-Za-z0-9_-]{32,2048}$/.test(body.signature)) fail('INVALID_HUB_CODE_SIGNATURE')
  if (Buffer.from(body.signature, 'base64url').toString('base64url') !== body.signature) fail('INVALID_HUB_CODE_SIGNATURE')
  const type = leaf.publicKey.asymmetricKeyType
  if (!['rsa', 'ec', 'ed25519', 'ed448'].includes(type) || type === 'rsa' && leaf.publicKey.asymmetricKeyDetails.modulusLength < 2048) fail('INVALID_HUB_TRUST')
  if (!verify(type.startsWith('ed') ? null : 'sha256', Buffer.from(hubCodeTranscript(body)), leaf.publicKey, Buffer.from(body.signature, 'base64url'))) fail('INVALID_HUB_CODE_SIGNATURE')
  return { hubId: body.hubId, url: body.url, caPem: roots.map(cert => cert.toString()).join('\n'), fingerprint: trustFingerprint(roots) }
}
