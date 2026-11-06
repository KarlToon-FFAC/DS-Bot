import { createHash } from 'node:crypto'
import { looksSecret } from '../memory.js'

const fail = code => { throw Object.assign(new Error(code), { code }) }
const fields = ['headline', 'summary', 'expertise', 'languages']
const hasControl = (value, multiline = false) => [...value].some(character => {
  const point = character.codePointAt(0)
  return point >= 127 && point <= 159 || point < 32 && !(multiline && [9, 10, 13].includes(point))
})
export const profileContent = profile => ({ headline: profile?.headline ?? '', summary: profile?.summary ?? '',
  expertise: profile?.expertise ?? [], languages: profile?.languages ?? [] })

export function cleanPublicProfile(input, rt) {
  if (!input || typeof input !== 'object' || Array.isArray(input)
    || Object.keys(input).some(key => !fields.includes(key))) fail('INVALID_PUBLIC_PROFILE')
  const profile = profileContent(input)
  for (const [key, limit] of [['headline', 80], ['summary', 1000]]) {
    if (typeof profile[key] !== 'string' || !profile[key].isWellFormed() || [...profile[key]].length > limit
      || hasControl(profile[key], key === 'summary')) fail('INVALID_PUBLIC_PROFILE')
    profile[key] = profile[key].trim()
  }
  for (const [key, limit] of [['expertise', 12], ['languages', 8]]) {
    if (!Array.isArray(profile[key]) || profile[key].length > limit
      || profile[key].some(value => typeof value !== 'string' || !value.isWellFormed() || !value.trim()
        || [...value].length > 32 || hasControl(value))) fail('INVALID_PUBLIC_PROFILE')
    profile[key] = [...new Set(profile[key].map(value => value.trim()))]
  }
  const text = JSON.stringify(profile)
  if (Buffer.byteLength(text) > 8192) fail('INVALID_PUBLIC_PROFILE')
  if (looksSecret(text) || (rt?.redactSecrets?.(text) ?? text) !== text) fail('PUBLIC_PROFILE_SECRET_REFUSED')
  return profile
}

export async function syncBotPublicProfiles(runtime) {
  if (!runtime.transport.welcome?.capabilities?.includes('public-profiles')) return
  let firstError
  for (const principal of runtime.bots.values()) {
    try { await syncBotPublicProfile(runtime, principal) }
    catch (error) { firstError ??= error }
  }
  if (firstError) throw firstError
}

async function syncBotPublicProfile(runtime, principal) {
  const bot = runtime.rt.botOf(principal.localRef)
  if (!bot?.publicProfile) return
  const profile = cleanPublicProfile(profileContent(bot.publicProfile), runtime.rt)
  const fingerprint = JSON.stringify(profile), revision = bot.publicProfile.revision
  if (!Number.isSafeInteger(revision) || revision < 1) fail('INVALID_PUBLIC_PROFILE')
  const db = runtime.queue.db, key = `bot-public-profile:${principal.principalId}`
  let saved = JSON.parse(db.prepare('SELECT value FROM metadata WHERE key=?').get(key)?.value ?? 'null')
  const keep = value => db.prepare('INSERT INTO metadata VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, JSON.stringify(value))
  let remote = runtime.contacts.find(contact => contact.principalId === principal.principalId)?.publicProfile
  const receive = (result) => {
    if (result.principalId !== principal.principalId || !Number.isSafeInteger(result.publicProfile?.version)
      || result.publicProfile.version < 0 || result.publicProfile.truncated) fail('INVALID_PUBLIC_PROFILE_RESPONSE')
    cleanPublicProfile(profileContent(result.publicProfile), runtime.rt)
    remote = result.publicProfile
    runtime.contacts = runtime.contacts.map(contact => contact.principalId === principal.principalId ? { ...contact, publicProfile: remote } : contact)
  }
  const submit = async () => {
    try {
      const result = await runtime.operation(principal.principalId, 'principal.public-profile', {
        expectedVersion: saved.expectedVersion, profile: saved.profile,
      }, saved.operationId)
      if (result.status === 'queued') return false
      if (result.publicProfile?.version !== saved.expectedVersion + 1) fail('INVALID_PUBLIC_PROFILE_RESPONSE')
      receive(result)
      saved = { revision: saved.revision, fingerprint: saved.fingerprint, confirmedVersion: remote.version }
      keep(saved)
      return true
    } catch (error) {
      if (!['CONNECTION_LOST', 'REQUEST_TIMEOUT', 'STORAGE_UNAVAILABLE', 'BACKPRESSURE', 'STALE_CONNECTION'].includes(error.code)) keep({ ...saved, error: error.code ?? 'PUBLIC_PROFILE_SYNC_FAILED' })
      throw error
    }
  }
  // Resolve older durable work before a newer local edit can replace its sync marker.
  if (saved?.operationId && !saved.error && saved.confirmedVersion === undefined && !await submit()) return
  if (saved?.revision === revision && saved.fingerprint === fingerprint && saved.confirmedVersion === remote?.version) return
  if (!remote || remote.truncated) receive(await runtime.transport.request('principal.public-profile.read', {
    principalId: principal.principalId, targetPrincipalId: principal.principalId,
  }))
  if (JSON.stringify(profileContent(remote)) === fingerprint) {
    keep({ revision, fingerprint, confirmedVersion: remote.version })
    return
  }
  if (saved?.revision === revision && (saved.error || saved.confirmedVersion !== undefined)) fail(saved.error ?? 'PUBLIC_PROFILE_VERSION_CONFLICT')
  const expectedVersion = remote.version
  const operationId = 'bot-profile-' + createHash('sha256').update(JSON.stringify([principal.principalId, revision, fingerprint, expectedVersion])).digest('hex')
  saved = { revision, fingerprint, expectedVersion, profile, operationId }
  keep(saved)
  await submit()
}
