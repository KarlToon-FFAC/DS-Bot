import { createHash } from 'node:crypto'
import { requireThat } from './protocol.js'

export const MAX_AVATAR_LENGTH = 160000
export const AVATAR_CHUNK_LENGTH = 32768
const COLORS = new Set('deepseek blue violet orange green magenta cyan red yellow brown gray black aurora charcoal graphite rose sky tangerine cobalt'.split(' '))
export const avatarRevision = image => createHash('sha256').update(image).digest('hex')
export const validAvatarRevision = revision => typeof revision === 'string' && /^[a-f0-9]{64}$/.test(revision)

export function normalizeAvatar(input, current, seed) {
  if (input === null) return { seed, imageRevision: null }
  requireThat(input && typeof input === 'object' && !Array.isArray(input)
    && Object.keys(input).every(key => ['seed','shape','color','imageRevision'].includes(key)), 'INVALID_AVATAR')
  const avatar = { ...current, ...input }
  requireThat(typeof avatar.seed === 'string' && avatar.seed.isWellFormed() && avatar.seed.length > 0 && avatar.seed.length <= 256
    && !/[\u0000-\u001f\u007f]/.test(avatar.seed), 'INVALID_AVATAR')
  requireThat(avatar.shape === undefined || typeof avatar.shape === 'string' && /^[a-z][\w-]{0,31}$/.test(avatar.shape), 'INVALID_AVATAR')
  requireThat(avatar.color === undefined || typeof avatar.color === 'string' && (COLORS.has(avatar.color) || /^#[a-f0-9]{6}$/i.test(avatar.color)), 'INVALID_AVATAR')
  requireThat(avatar.imageRevision === null || validAvatarRevision(avatar.imageRevision), 'INVALID_AVATAR')
  return avatar
}

export function validateAvatarImage(image) {
  requireThat(typeof image === 'string' && image.length <= MAX_AVATAR_LENGTH, 'INVALID_AVATAR_IMAGE')
  const match = /^data:image\/(png|jpeg|webp|gif);base64,([A-Za-z0-9+/]+={0,2})$/.exec(image)
  requireThat(match, 'INVALID_AVATAR_IMAGE')
  const bytes = Buffer.from(match[2], 'base64')
  requireThat(bytes.toString('base64') === match[2], 'INVALID_AVATAR_IMAGE')
  const valid = match[1] === 'png' ? bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))
    : match[1] === 'jpeg' ? bytes.length >= 3 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255
      : match[1] === 'gif' ? ['GIF87a','GIF89a'].includes(bytes.subarray(0,6).toString('ascii'))
        : bytes.length >= 12 && bytes.subarray(0,4).toString('ascii') === 'RIFF' && bytes.subarray(8,12).toString('ascii') === 'WEBP'
  requireThat(valid, 'INVALID_AVATAR_IMAGE')
}
