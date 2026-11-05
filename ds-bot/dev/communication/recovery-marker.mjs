// Only the isolated probe and Hub fixture use this synthetic checkpoint channel.
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync, renameSync } from 'node:fs'
import { join } from 'node:path'

export const recoveryMarkerPath = (home, conversationId) => join(home, `communication-recovery-${createHash('sha256').update(conversationId).digest('hex').slice(0, 24)}.json`)
export function recordRecoveryAssembly(home, marker, phase) {
  if (!['queued', 'assembling', 'settled'].includes(phase)) throw new Error('Invalid recovery assembly phase')
  const path = recoveryMarkerPath(home, marker.conversationId), temporary = path + '.tmp'
  writeFileSync(temporary, JSON.stringify({ ...marker, phase }), { mode: 0o600 }); renameSync(temporary, path)
}

export function recordRecoveryNotice(home, session, event) {
  if (event.type !== 'agent/inbox/spliced') return null
  let marker
  for (const message of event.data?.inserted ?? []) {
    const source = message.source
    if (source?.kind !== 'ds-bot-communication-recovery' || source.form !== 'notice'
      || ![session.id, message.id, source.conversationId, source.forDeliveryId, source.forMessageId].every(value => typeof value === 'string' && value.length > 0)
      || !Number.isSafeInteger(event.seq)) continue
    marker = { sessionId: session.id, noticeId: message.id, seq: event.seq, conversationId: source.conversationId,
      deliveryId: source.forDeliveryId, messageId: source.forMessageId }
    recordRecoveryAssembly(home, marker, 'queued')
  }
  return marker ?? null
}

export function matchingRecoveryNotice(path, expected) {
  let marker
  try { marker = JSON.parse(readFileSync(path, 'utf8')) } catch { return null }
  if (!marker || marker.phase !== 'assembling' || !Number.isSafeInteger(marker.seq) || ![marker.sessionId, marker.noticeId].every(value => typeof value === 'string' && value.length > 0)
    || ['conversationId', 'deliveryId', 'messageId'].some(key => marker[key] !== expected[key])) return null
  return marker
}
