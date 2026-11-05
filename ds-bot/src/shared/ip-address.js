// Address labels are not identities. Ports do not distinguish IP notes; a bare
// IPv6 address is never split at its last colon as if it contained a port.
export function normalizeIpAddress(value) {
  if (typeof value !== 'string' || value.length > 128) return null
  let address = value.trim(), port
  const bracket = /^\[([^\]]+)\](?::([0-9]+))?$/.exec(address)
  if (bracket) { address = bracket[1]; port = bracket[2] }
  else {
    const ipv4Port = /^([0-9.]+):([0-9]+)$/.exec(address)
    if (ipv4Port) { address = ipv4Port[1]; port = ipv4Port[2] }
  }
  if (port !== undefined && (!/^[0-9]{1,5}$/.test(port) || Number(port) < 1 || Number(port) > 65535)) return null
  if (/^(?:0|[1-9][0-9]{0,2})(?:\.(?:0|[1-9][0-9]{0,2})){3}$/.test(address)) {
    return address.split('.').every(part => Number(part) <= 255) && !bracket ? address : null
  }
  if (!address.includes(':') || !/^[0-9a-fA-F:.]+$/.test(address)) return null
  try {
    const canonical = new URL(`http://[${address}]/`).hostname.slice(1, -1)
    const mapped = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(canonical)
    if (mapped) return mapped.slice(1).flatMap(part => { const word = parseInt(part, 16); return [word >> 8, word & 255] }).join('.')
    return canonical
  } catch { return null }
}
