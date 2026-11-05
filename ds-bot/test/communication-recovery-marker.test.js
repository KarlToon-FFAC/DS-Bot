import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { matchingRecoveryNotice, recordRecoveryNotice, recordRecoveryAssembly, recoveryMarkerPath } from '../dev/communication/recovery-marker.mjs'

test('test-only recovery marker comes from the exact host notice and matches one original input', t => {
  const home = mkdtempSync(join(tmpdir(), 'dsbot-recovery-marker-'))
  t.after(() => rmSync(home, { recursive: true, force: true }))
  const source = { kind: 'ds-bot-communication-recovery', form: 'notice', conversationId: '../not-a-path', forDeliveryId: 'delivery', forMessageId: 'message' }
  const event = { type: 'agent/inbox/spliced', seq: 12, data: { inserted: [{ id: 'notice', source }] } }
  const path = recoveryMarkerPath(home, source.conversationId)
  assert.equal(dirname(path), home)
  const marker = recordRecoveryNotice(home, { id: 'session' }, event)
  assert.deepEqual(marker, { sessionId: 'session', noticeId: 'notice', seq: 12, conversationId: source.conversationId, deliveryId: 'delivery', messageId: 'message' })
  assert.equal(matchingRecoveryNotice(path, marker), null, 'a notice alone does not prove prompt assembly')
  recordRecoveryAssembly(home, marker, 'assembling')
  assert.deepEqual(matchingRecoveryNotice(path, marker), { ...marker, phase: 'assembling' })
  for (const changed of [{ messageId: 'different' }, { deliveryId: 'different' }, { conversationId: 'different' }]) assert.equal(matchingRecoveryNotice(path, { ...marker, ...changed }), null)
  assert.equal(recordRecoveryNotice(home, { id: 'session' }, { ...event, data: { inserted: [{ id: 'forged', source: { ...source, kind: 'user' } }] } }), null)
  assert.equal(matchingRecoveryNotice(path + '.absent', marker), null)
  recordRecoveryAssembly(home, marker, 'settled')
  assert.equal(matchingRecoveryNotice(path, marker), null, 'a later routine membership read cannot select the fault')
})
