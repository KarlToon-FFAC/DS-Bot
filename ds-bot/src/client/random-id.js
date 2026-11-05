// getRandomValues is available on ordinary LAN HTTP origins; randomUUID is not.
export function randomId(source = globalThis.crypto) {
  try {
    if (typeof source?.randomUUID === 'function') return source.randomUUID()
    if (typeof source?.getRandomValues !== 'function') throw new Error()
    const bytes = source.getRandomValues(new Uint8Array(16))
    bytes[6] = (bytes[6] & 15) | 64
    bytes[8] = (bytes[8] & 63) | 128
    const hex = Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('')
    return `${hex.slice(0,8)}-${hex.slice(8,12)}-${hex.slice(12,16)}-${hex.slice(16,20)}-${hex.slice(20)}`
  } catch {
    throw Object.assign(new Error('Secure random identifiers are unavailable.'), { code: 'SECURE_RANDOM_UNAVAILABLE' })
  }
}
