// Host-only facts about a socket created by our verified TLS path. No trust
// payload, certificate bytes, environment values or filesystem paths are kept.
const observations = new WeakMap()
export function recordHubTls(socket, { secure, scopedCa }) {
  observations.set(socket, Object.freeze({ secure, trustSource: secure ? scopedCa ? 'hub-scoped-ca' : 'node-default-trust' : 'loopback-plaintext',
    verification: secure ? 'verified-for-observed-handshake' : 'not-applicable', observedAt: new Date().toISOString() }))
}
export function hubTlsObservation(socket) {
  const value = socket && observations.get(socket)
  return value ? { ...value } : null
}
