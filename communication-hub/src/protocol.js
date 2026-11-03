import { createHash } from 'node:crypto'

export const PROTOCOL = 'dsbot-communication/1'
export const CAPABILITIES = ['text', 'markdown', 'mentions', 'group', 'dm', 'reply', 'history', 'group-policy', 'membership-epoch']
export const DEFAULT_LIMITS = { maxTextBytes: 65536, maxEnvelopeBytes: 131072, maxMembers: 64, maxPendingDeliveries: 10000,
  maxPrincipals: 64, maxMembershipsPerInstance: 64, maxPendingInvitesPerInstance: 64 }

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

export function normalizeMessage(input, author, limits) {
  requireThat(input?.protocol === PROTOCOL, 'PROTOCOL_VERSION_UNSUPPORTED')
  requireThat(input.type === 'message.publish', 'INVALID_REQUEST')
  identifier(input.messageId); identifier(input.conversationId)
  requireThat(input.author?.principalId === author.principalId && input.author.kind === author.kind
    && input.author.homeInstanceId === author.homeInstanceId, 'AUTHOR_MISMATCH')
  requireThat(input.content && ['text', 'markdown'].includes(input.content.format)
    && typeof input.content.text === 'string', 'UNSUPPORTED_CONTENT')
  requireThat(Object.keys(input.content).every(key => ['format', 'text'].includes(key))
    && !input.attachments && !input.files, 'UNSUPPORTED_CONTENT')
  const bytes = Buffer.byteLength(input.content.text, 'utf8')
  requireThat(bytes > 0, 'INVALID_REQUEST')
  requireThat(bytes <= limits.maxTextBytes, 'PAYLOAD_TOO_LARGE', 'Message exceeds the UTF-8 byte limit', { actualBytes: bytes, maxBytes: limits.maxTextBytes })
  requireThat(Array.isArray(input.mentions) && input.mentions.length <= limits.maxMembers, 'INVALID_REQUEST')
  const mentions = [...new Set(input.mentions.map(item => identifier(item?.principalId)))].sort().map(principalId => ({ principalId }))
  requireThat(typeof input.clientCreatedAt === 'string' && input.clientCreatedAt.length <= 64 && Number.isFinite(Date.parse(input.clientCreatedAt)), 'INVALID_REQUEST')
  if (input.replyToMessageId !== null) identifier(input.replyToMessageId)
  if (input.responseToDeliveryId !== undefined) identifier(input.responseToDeliveryId)
  if (input.membershipEpoch !== undefined) identifier(input.membershipEpoch)
  return { protocol: PROTOCOL, type: 'message.publish', messageId: input.messageId, conversationId: input.conversationId,
    author, clientCreatedAt: input.clientCreatedAt, content: { format: input.content.format, text: input.content.text }, mentions,
    replyToMessageId: input.replyToMessageId, ...(input.responseToDeliveryId === undefined ? {} : { responseToDeliveryId: input.responseToDeliveryId }),
    ...(input.membershipEpoch === undefined ? {} : { membershipEpoch: input.membershipEpoch }) }
}
