import { createPrivateKey, sign, X509Certificate } from 'node:crypto'
import { isIP } from 'node:net'
import { requireThat } from './protocol.js'

// Public CA material only; the existing TLS leaf key signs the distribution code.
export function signedHubCode(hubId, url, { caPem, certificatePem, privateKey, now = Date.now() }) {
  requireThat(typeof caPem === 'string' && caPem.length <= 20000 && typeof certificatePem === 'string' && certificatePem.length <= 20000, 'INVALID_CONFIG')
  for (const value of [caPem, certificatePem]) requireThat(value.match(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g)?.length
    && !value.replace(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g, '').trim(), 'INVALID_CONFIG')
  const leaf = new X509Certificate(certificatePem), key = createPrivateKey(privateKey)
  requireThat(leaf.checkPrivateKey(key), 'INVALID_CONFIG')
  const address = new URL(url), host = address.hostname.replace(/^\[|\]$/g, '')
  requireThat(address.protocol === 'wss:' && address.href === url && !address.username && !address.password && !address.search && !address.hash, 'INVALID_CONFIG')
  const parse = value => value.match(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g).map(pem => new X509Certificate(pem))
  const roots = parse(caPem), chain = parse(certificatePem)
  requireThat(roots.length <= 4 && chain.length <= 8 && !leaf.ca, 'INVALID_CONFIG')
  for (const cert of [...roots, ...chain]) requireThat(Date.parse(cert.validFrom) <= now && now < Date.parse(cert.validTo), 'INVALID_CONFIG')
  requireThat(roots.every(root => root.ca && root.checkIssued(root) && root.verify(root.publicKey)), 'INVALID_CONFIG')
  requireThat(isIP(host) ? leaf.checkIP(host) : leaf.checkHost(host, { subject: 'never' }), 'INVALID_CONFIG')
  const anchored = (cert, seen = new Set()) => {
    if (roots.some(root => root.raw.equals(cert.raw))) return true
    if (seen.has(cert.fingerprint256) || seen.size > 8) return false
    const next = new Set(seen).add(cert.fingerprint256)
    return [...chain.slice(1), ...roots].some(issuer => issuer.ca && cert.checkIssued(issuer) && cert.verify(issuer.publicKey) && anchored(issuer, next))
  }
  requireThat(anchored(leaf) && ['rsa','ec','ed25519','ed448'].includes(key.asymmetricKeyType)
    && (key.asymmetricKeyType !== 'rsa' || key.asymmetricKeyDetails.modulusLength >= 2048), 'INVALID_CONFIG')
  const body = { hubId, url, issuedAt: now, expiresAt: Math.min(now + 7 * 86400000, ...[...roots,...chain].map(cert => Date.parse(cert.validTo))), caPem, certificatePem }
  const transcript = JSON.stringify(['dsbot-hub:2', body.hubId, body.url, body.issuedAt, body.expiresAt, body.caPem, body.certificatePem])
  body.signature = sign(key.asymmetricKeyType.startsWith('ed') ? null : 'sha256', Buffer.from(transcript), key).toString('base64url')
  const code = `dsbot-hub:2:${Buffer.from(JSON.stringify(body)).toString('base64url')}`
  requireThat(code.length <= 65536, 'INVALID_CONFIG')
  return code
}
