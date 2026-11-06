import { isIP } from 'node:net'
import { caFixture } from './hub-ca-fixture.mjs'
import { signedHubCode } from '../../../communication-hub/src/hub-code.js'
import { decodeHubCode } from '../../src/host/federation/onboarding.js'

let fixture, authority
const leaves = new Map()
export function testHubCode(hub) {
  if (!fixture) {
    fixture = caFixture(); authority = fixture.ca('test-root')
    process.once('exit', () => fixture.close())
  }
  const host = new URL(hub.url).hostname.replace(/^\[|\]$/g, '')
  if (!leaves.has(host)) leaves.set(host, fixture.leaf('leaf-' + leaves.size, authority, (isIP(host) ? 'IP:' : 'DNS:') + host))
  const leaf = leaves.get(host)
  const code = signedHubCode(hub.hubId, hub.url, { caPem: authority.pem, certificatePem: leaf.cert, privateKey: leaf.key })
  const body = JSON.parse(Buffer.from(code.slice('dsbot-hub:2:'.length), 'base64url'))
  for (const [key, value] of Object.entries(hub)) if (!['hubId', 'url'].includes(key)) body[key] = value
  return 'dsbot-hub:2:' + Buffer.from(JSON.stringify(body)).toString('base64url')
}
export function testHubInput(hub) {
  const hubCode = testHubCode(hub), reviewed = decodeHubCode(hubCode, { allowLoopback: true })
  return { hubCode, confirmedHubId: hub.hubId, confirmedUrl: hub.url, confirmedTrustFingerprint: reviewed.trustFingerprint }
}
