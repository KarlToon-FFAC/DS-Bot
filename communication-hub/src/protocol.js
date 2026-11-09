import { createHash } from 'node:crypto'
import { normalizeAttachments, ATTACHMENT_CAPABILITY } from './attachments.js'

export const PROTOCOL = 'dsbot-communication/1'
export const CAPABILITIES = ['text', 'markdown', 'mentions', 'group', 'dm', 'reply', 'history', 'group-policy', 'membership-epoch', 'explicit-bot-activation', 'bot-input-updates']
export const HUB_CAPABILITIES = [...CAPABILITIES, 'bounded-bot-collaboration', 'principal-avatars', 'principal-publication', 'bot-publication-generations', 'public-profiles', 'published-contact-scope', 'contact-consent-v2', 'bot-work-events', 'state-invalidation', 'local-user-intent', 'proactive-bot-roots', ATTACHMENT_CAPABILITY]
export const DEFAULT_LIMITS = { maxTextBytes: 65536, maxEnvelopeBytes: 131072, maxMembers: 64, maxPendingDeliveries: 10000,
  maxPrincipals: 64, maxMembershipsPerInstance: 64, maxPendingInvitesPerInstance: 64, maxCausalDepth: 8, maxAiDeliveriesPerRoot: 32 }

export class CommunicationError extends Error {
  constructor(code, message = code, details) { super(message); this.code = code; this.details = details }
}
export function requireThat(condition, code, message = code, details) {
  if (!condition) throw new CommunicationError(code, message, details)
}
export function identifier(value) {
  requireThat(typeof value === 'string' && value.isWellFormed() && value.length > 0 && value.length <= 256 && [...value].every(character => character.codePointAt(0) > 32), 'INVALID_REQUEST')
  return value
}
export function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`
  return JSON.stringify(value)
}
export const hash = value => createHash('sha256').update(canonical(value)).digest('hex')
// The request ID is echoed into every response and can contain 256 BMP chars.
export const responseBytes = value => Buffer.byteLength(JSON.stringify({ id: '', ok: true, value })) + 256 * 3

export function normalizePublicProfile(input) {
  requireThat(input && typeof input === 'object' && !Array.isArray(input)
    && Object.keys(input).every(key => ['headline', 'summary', 'expertise', 'languages'].includes(key)), 'INVALID_PUBLIC_PROFILE')
  const text = (value, limit, multiline = false) => {
    requireThat(typeof value === 'string' && value.isWellFormed() && [...value].length <= limit
      && !(multiline ? /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/ : /[\u0000-\u001f\u007f-\u009f]/).test(value), 'INVALID_PUBLIC_PROFILE')
    return value.trim()
  }
  const list = (value, limit) => {
    requireThat(Array.isArray(value) && value.length <= limit, 'INVALID_PUBLIC_PROFILE')
    const items = value.map(item => text(item, 32))
    requireThat(items.every(Boolean), 'INVALID_PUBLIC_PROFILE')
    return [...new Set(items)]
  }
  const profile = { headline: text(input.headline ?? '', 80), summary: text(input.summary ?? '', 1000, true),
    expertise: list(input.expertise ?? [], 12), languages: list(input.languages ?? [], 8) }
  requireThat(Buffer.byteLength(JSON.stringify(profile)) <= 8192, 'INVALID_PUBLIC_PROFILE')
  return profile
}

export function normalizeMessage(input, author, limits) {
  requireThat(input?.protocol === PROTOCOL, 'PROTOCOL_VERSION_UNSUPPORTED')
  requireThat(input.type === 'message.publish', 'INVALID_REQUEST')
  identifier(input.messageId); identifier(input.conversationId)
  requireThat(input.author?.principalId === author.principalId && input.author.kind === author.kind
    && input.author.homeInstanceId === author.homeInstanceId, 'AUTHOR_MISMATCH')
  requireThat(input.content && ['text', 'markdown'].includes(input.content.format)
    && typeof input.content.text === 'string', 'UNSUPPORTED_CONTENT')
  requireThat(Object.keys(input.content).every(key => ['format', 'text'].includes(key))
    && !input.files, 'UNSUPPORTED_CONTENT')
  let attachments
  try { attachments = normalizeAttachments(input.attachments) } catch(error) { throw new CommunicationError(error.code) }
  const bytes = Buffer.byteLength(input.content.text, 'utf8')
  requireThat(bytes > 0 || attachments.length > 0, 'INVALID_REQUEST')
  requireThat(bytes <= limits.maxTextBytes, 'PAYLOAD_TOO_LARGE', 'Message exceeds the UTF-8 byte limit', { actualBytes: bytes, maxBytes: limits.maxTextBytes })
  requireThat(Array.isArray(input.mentions) && input.mentions.length <= limits.maxMembers, 'INVALID_REQUEST')
  const mentions = [...new Set(input.mentions.map(item => identifier(item?.principalId)))].sort().map(principalId => ({ principalId }))
  requireThat(author.kind === 'bot' || input.activationTargets === undefined, 'EXPLICIT_ACTIVATION_REQUIRED')
  let activationTargets
  if (author.kind === 'bot' && input.activationTargets !== undefined) {
    requireThat(Array.isArray(input.activationTargets), 'INVALID_REQUEST')
    requireThat(input.activationTargets.length <= limits.maxMembers, 'INVALID_REQUEST')
    activationTargets = [...new Set(input.activationTargets.map(item => identifier(item?.principalId)))].sort().map(principalId => ({ principalId }))
    requireThat(!activationTargets.length || input.content.text.trim().length > 0, 'EMPTY_HANDOFF')
  }
  requireThat(typeof input.clientCreatedAt === 'string' && input.clientCreatedAt.length <= 64 && Number.isFinite(Date.parse(input.clientCreatedAt)), 'INVALID_REQUEST')
  if (input.replyToMessageId !== null) identifier(input.replyToMessageId)
  if (input.responseToDeliveryId !== undefined) identifier(input.responseToDeliveryId)
  if (input.causationDeliveryId !== undefined) identifier(input.causationDeliveryId)
  if (input.localUserIntent !== undefined) {
    const intent = input.localUserIntent
    requireThat(author.kind === 'bot' && intent && typeof intent === 'object' && !Array.isArray(intent)
      && Object.keys(intent).length === 2 && Object.hasOwn(intent, 'principalId') && Object.hasOwn(intent, 'intentId')
      && !input.causationDeliveryId && !input.responseToDeliveryId && !input.updateForMessageId, 'INVALID_CAUSATION_GRANT')
    identifier(intent.principalId); identifier(intent.intentId)
  }
  requireThat(['causality','rootMessageId','parentMessageId','depth','dispatchSuppressed'].every(key => !Object.hasOwn(input,key)), 'INVALID_CAUSALITY')
  if (input.updateForMessageId !== undefined) {
    identifier(input.updateForMessageId); identifier(input.updateRecipientPrincipalId)
    requireThat(!input.responseToDeliveryId && !input.causationDeliveryId && !activationTargets?.length && !attachments.length, 'INVALID_INPUT_UPDATE')
    requireThat(input.replyToMessageId === input.updateForMessageId, 'INVALID_INPUT_UPDATE')
  } else requireThat(input.updateRecipientPrincipalId === undefined, 'INVALID_INPUT_UPDATE')
  if (input.inputUpdateIds !== undefined) requireThat(Array.isArray(input.inputUpdateIds) && input.inputUpdateIds.length <= 100 && input.inputUpdateIds.every(id => identifier(id)), 'INVALID_INPUT_UPDATE')
  if (input.membershipEpoch !== undefined) identifier(input.membershipEpoch)
  return { protocol: PROTOCOL, type: 'message.publish', messageId: input.messageId, conversationId: input.conversationId,
    author, clientCreatedAt: input.clientCreatedAt, content: { format: input.content.format, text: input.content.text }, mentions,
    ...(activationTargets === undefined ? {} : { activationTargets }),
    ...(attachments.length ? { attachments } : {}),
    ...(input.updateForMessageId ? { updateForMessageId: input.updateForMessageId, updateRecipientPrincipalId: input.updateRecipientPrincipalId } : {}),
    ...(input.inputUpdateIds ? { inputUpdateIds: [...new Set(input.inputUpdateIds)].sort() } : {}),
    replyToMessageId: input.replyToMessageId, ...(input.responseToDeliveryId === undefined ? {} : { responseToDeliveryId: input.responseToDeliveryId }),
    ...(input.causationDeliveryId === undefined ? {} : { causationDeliveryId: input.causationDeliveryId }),
    ...(input.localUserIntent === undefined ? {} : { localUserIntent: { principalId: input.localUserIntent.principalId, intentId: input.localUserIntent.intentId } }),
    ...(input.membershipEpoch === undefined ? {} : { membershipEpoch: input.membershipEpoch }) }
}
