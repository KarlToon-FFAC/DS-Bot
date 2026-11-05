import { resolve } from 'node:path'

// Host-only, process-lifetime leases. Never serialize these values or restore
// them to process.env: tools inherit neither the original nor a replacement.
const leases = new Map()
const forget = (scope, lease) => {
  if (leases.get(scope) !== lease) return
  lease.bytes.fill(0); leases.delete(scope)
}
export function legacyCredential(rt, settings, env = process.env) {
  const scope = typeof rt.home === 'string' && rt.home ? JSON.stringify([resolve(rt.dshHome ?? rt.home), resolve(rt.home)]) : null
  const key = settings.credentialEnv ?? 'DSBOT_COMMUNICATION_CREDENTIAL'
  const usable = settings.enabled && !settings.credentialKey && /^DSBOT_COMMUNICATION_[A-Z0-9_]+$/.test(key)
  const binding = JSON.stringify([settings.url ?? null, settings.instanceId ?? null, settings.dataPath ?? null, key])
  const previous = scope && leases.get(scope)
  if (previous && (!usable || previous.binding !== binding)) forget(scope, previous)
  const supplied = settings.enabled && /^DSBOT_COMMUNICATION_[A-Z0-9_]+$/.test(key) ? env[key] : undefined
  if (supplied !== undefined) delete env[key]
  if (!usable) return undefined
  if (supplied !== undefined && (typeof supplied !== 'string' || supplied.length < 32)) {
    if (scope && leases.has(scope)) forget(scope, leases.get(scope))
    return undefined
  }
  let lease = scope && leases.get(scope)
  if (supplied !== undefined) {
    if (lease) forget(scope, lease)
    lease = { binding, bytes: Buffer.from(supplied) }
    if (scope) {
      leases.set(scope, lease)
    }
  }
  if (!lease) return undefined
  return {
    status() { return { available: lease.bytes.some(byte => byte !== 0) } },
    read() {
      if (!lease.bytes.some(byte => byte !== 0)) throw Object.assign(new Error('CREDENTIAL_UNAVAILABLE'), { code: 'CREDENTIAL_UNAVAILABLE' })
      return lease.bytes.toString()
    },
    invalidate() { if (scope) forget(scope, lease); else lease.bytes.fill(0) },
  }
}
