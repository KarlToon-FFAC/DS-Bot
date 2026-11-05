import { createHash, randomUUID } from 'node:crypto'
import { avatarBytes } from '../avatar.js'
import { MAX_AVATAR_IMAGE } from '../constants.js'
import { cleanPublicProfile } from './public-profiles.js'

const fail = code => { throw Object.assign(new Error(code), { code }) }
const hash = value => createHash('sha256').update(value).digest('hex')
const capable = runtime => runtime.transport.welcome?.capabilities?.includes('principal-avatars')
const descriptor = value => ({ seed: value?.seed ?? null, shape: value?.shape ?? null, color: value?.color ?? null, imageRevision: value?.imageRevision ?? null })
const imageData = value => {
  if (typeof value !== 'string' || value.length > MAX_AVATAR_IMAGE) fail('INVALID_AVATAR')
  try { return avatarBytes(value).url } catch { fail('INVALID_AVATAR') }
}

async function stage(runtime, principalId, image, operationId) {
  const imageRevision = hash(image), uploadId = hash(JSON.stringify([principalId, operationId, imageRevision]))
  const initial = await runtime.transport.request('principal.avatar.begin', { principalId, uploadId, imageRevision, totalLength: image.length })
  let offset = initial.nextOffset
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > image.length) fail('INVALID_AVATAR_RESPONSE')
  while (offset < image.length) {
    const data = image.slice(offset, offset + 32768)
    const next = await runtime.transport.request('principal.avatar.chunk', { principalId, uploadId, offset, data })
    if (next.nextOffset !== offset + data.length) fail('INVALID_AVATAR_RESPONSE')
    offset = next.nextOffset
  }
  return { imageRevision, uploadId }
}

export async function profileHuman(runtime, input) {
  if (!capable(runtime)) fail('AVATAR_CAPABILITY_REQUIRED')
  if (typeof input.operationId !== 'string' || !input.operationId || input.displayName === undefined && input.avatar === undefined) fail('INVALID_REQUEST')
  const principalId = runtime.human.principalId
  const payload = { ...(input.displayName === undefined ? {} : { displayName: input.displayName }) }
  if (input.avatar === null) payload.avatar = null
  else if (input.avatar !== undefined) {
    if (!input.avatar || typeof input.avatar !== 'object' || Array.isArray(input.avatar)
      || Object.keys(input.avatar).some(key => key !== 'image')) fail('INVALID_AVATAR')
    const image = imageData(input.avatar.image)
    const staged = await stage(runtime, principalId, image, input.operationId)
    payload.avatar = { imageRevision: staged.imageRevision }
    payload.uploadId = staged.uploadId
  }
  const result = await runtime.operation(principalId, 'principal.profile', payload, input.operationId)
  if (result.status !== 'queued') {
    if (result.displayName) runtime.human.displayName = result.displayName
    runtime.contacts = runtime.contacts.map(contact => contact.principalId === principalId ? { ...contact, ...result } : contact)
  }
  return result
}

const invalidProfileText = (value, multiline = false) => typeof value !== 'string' || !value.isWellFormed() || [...value].some(character => {
  const code = character.codePointAt(0)
  return code < 32 && (!multiline || ![9, 10, 13].includes(code)) || code >= 127 && code <= 159
})
function validatePublicProfile(profile) {
  if (!profile || typeof profile !== 'object' || Array.isArray(profile)
    || Object.keys(profile).some(key => !['headline', 'summary', 'expertise', 'languages', 'version', 'updatedAt', 'truncated'].includes(key))) fail('INVALID_PUBLIC_PROFILE_RESPONSE')
  for (const [key, limit] of [['headline', 80], ['summary', 1000]]) {
    const value = profile[key]
    if (invalidProfileText(value, key === 'summary') || [...value].length > limit) fail('INVALID_PUBLIC_PROFILE_RESPONSE')
  }
  for (const [key, count] of [['expertise', 12], ['languages', 8]]) {
    if (!Array.isArray(profile[key]) || profile[key].length > count
      || profile[key].some(value => invalidProfileText(value) || !value.trim() || [...value].length > 32)) fail('INVALID_PUBLIC_PROFILE_RESPONSE')
  }
  if (profile.truncated === true || !Number.isSafeInteger(profile.version) || profile.version < 0) fail('INVALID_PUBLIC_PROFILE_RESPONSE')
}

export async function readHumanProfileInfo(runtime, input = {}) {
  if (!runtime.transport.welcome?.capabilities?.includes('public-profiles')) fail('PUBLIC_PROFILE_CAPABILITY_REQUIRED')
  if (Object.keys(input).some(key => key !== 'endpoint')) fail('INVALID_REQUEST')
  const principalId = runtime.human.principalId
  const result = await runtime.transport.request('principal.public-profile.read', { principalId, targetPrincipalId: principalId })
  if (result?.principalId !== principalId) fail('INVALID_PUBLIC_PROFILE_RESPONSE')
  validatePublicProfile(result.publicProfile)
  return result
}

export async function profileHumanInfo(runtime, input) {
  if (!runtime.transport.welcome?.capabilities?.includes('public-profiles')) fail('PUBLIC_PROFILE_CAPABILITY_REQUIRED')
  if (Object.keys(input).some(key => !['endpoint', 'operationId', 'expectedVersion', 'profile'].includes(key))) fail('INVALID_REQUEST')
  if (typeof input.operationId !== 'string' || !input.operationId || input.operationId.length > 256
    || !Number.isSafeInteger(input.expectedVersion) || input.expectedVersion < 0 || input.expectedVersion === Number.MAX_SAFE_INTEGER) fail('INVALID_REQUEST')
  const profile = cleanPublicProfile(input.profile, runtime.rt)
  const principalId = runtime.human.principalId
  const result = await runtime.operation(principalId, 'principal.public-profile', {
    expectedVersion: input.expectedVersion, profile,
  }, input.operationId)
  if (result?.status !== 'queued') {
    if (result?.principalId !== principalId || !result.publicProfile
      || result.publicProfile.version !== input.expectedVersion + 1) fail('INVALID_PUBLIC_PROFILE_RESPONSE')
    validatePublicProfile(result.publicProfile)
    runtime.human.publicProfile = result.publicProfile
    runtime.contacts = runtime.contacts.map(contact => contact.principalId === principalId ? { ...contact, publicProfile: result.publicProfile } : contact)
  }
  return result
}

export async function syncBotAvatars(runtime) {
  if (!capable(runtime)) return
  runtime.avatarPublications ??= new Map()
  for (const principal of runtime.bots.values()) {
    const bot = runtime.rt.botOf(principal.localRef)
    if (!bot) continue
    const image = bot.avatar?.image ? imageData(bot.avatar.image) : null
    const avatar = { seed: String(bot.id), ...(bot.avatar?.shape ? { shape: bot.avatar.shape } : {}),
      ...(bot.color ? { color: bot.color } : {}), imageRevision: image ? hash(image) : null }
    const fingerprint = JSON.stringify(descriptor(avatar))
    const current = runtime.contacts.find(contact => contact.principalId === principal.principalId)?.avatar
    if (JSON.stringify(descriptor(current)) === fingerprint) { runtime.avatarPublications.delete(principal.principalId); continue }
    let pending = runtime.avatarPublications.get(principal.principalId)
    if (pending?.fingerprint !== fingerprint) {
      pending = { fingerprint, operationId: randomUUID() }
      runtime.avatarPublications.set(principal.principalId, pending)
    }
    const payload = { avatar }
    if (image) payload.uploadId = (await stage(runtime, principal.principalId, image, pending.operationId)).uploadId
    const result = await runtime.operation(principal.principalId, 'principal.profile', payload, pending.operationId)
    if (result.status !== 'queued') runtime.contacts = runtime.contacts.map(contact => contact.principalId === principal.principalId ? { ...contact, ...result } : contact)
  }
}

export async function readPrincipalAvatar(runtime, input) {
  if (!capable(runtime)) fail('AVATAR_CAPABILITY_REQUIRED')
  if (typeof input.principalId !== 'string' || !/^[a-f0-9]{64}$/.test(input.revision ?? '')) fail('INVALID_REQUEST')
  let image = '', offset = 0, totalLength
  do {
    const part = await runtime.transport.request('principal.avatar.read', { principalId: input.principalId, imageRevision: input.revision, offset, limit: 32768 })
    if (part.principalId !== input.principalId || part.imageRevision !== input.revision || part.offset !== offset
      || typeof part.data !== 'string' || part.data.length > 32768 || !Number.isSafeInteger(part.totalLength)
      || part.totalLength < 1 || part.totalLength > MAX_AVATAR_IMAGE || totalLength !== undefined && part.totalLength !== totalLength
      || part.nextOffset !== offset + part.data.length || part.nextOffset > part.totalLength) fail('INVALID_AVATAR_RESPONSE')
    totalLength = part.totalLength
    image += part.data; offset = part.nextOffset
    if (part.done !== (offset === totalLength) || offset < totalLength && !part.data.length) fail('INVALID_AVATAR_RESPONSE')
  } while (offset < totalLength)
  if (hash(image) !== input.revision) fail('INVALID_AVATAR_RESPONSE')
  return { principalId: input.principalId, revision: input.revision, image: imageData(image) }
}
