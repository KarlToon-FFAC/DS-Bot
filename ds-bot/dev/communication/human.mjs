// Feed a real persisted mock-Bot reply into the test-only Human projection.
// No Hub is involved; this verifies the destination adapter boundary in P0.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { benchClient, modelCalls, repo } from './bench-client.mjs'

const faults = JSON.parse(readFileSync(join(repo, '.dsh-test-tools/p0-faults.json'), 'utf8'))
const output = faults.cases.find(value => value.point === 'after-output')?.reconciled?.outputs[0]
assert.ok(output, 'Run the after-output fault probe successfully first')
const { api } = await benchClient('communication-a', 3101)
const before = await api({ operation: 'metrics' })
const calls = modelCalls('communication-a')
const sourceId = createHash('sha256').update(output.sourceKey).digest('hex')
const results = []
for (const conversationId of ['p0-group', 'p0-dm']) {
  const message = { conversationId, messageId: `${sourceId}-${conversationId}`,
    text: output.parts.map(part => part.text).join('\n'),
    author: { principalId: output.recipientPrincipalId, displayName: 'Chief', instanceLabel: 'Instance B' } }
  const view = await api({ operation: 'project', ...message })
  const duplicate = await api({ operation: 'project', ...message })
  assert.deepEqual(duplicate, view)
  const projected = view.messages.filter(value => value.messageId === message.messageId)
  assert.equal(projected.length, 1)
  assert.equal(projected[0].authorPrincipalId, output.recipientPrincipalId)
  assert.equal(projected[0].recipientPrincipalId, before.humanPrincipalId)
  assert.equal(projected[0].text, message.text)
  assert.ok(view.unread > 0, 'Human must have a notification')
  await api({ operation: 'view-read', conversationId })
  const read = await api({ operation: 'view' })
  assert.equal(read.views[conversationId].unread, 0)
  results.push({ conversationId, messageId: message.messageId, sourceKey: output.sourceKey, status: 'PASS' })
}
assert.deepEqual(await api({ operation: 'metrics' }), before)
assert.equal(modelCalls('communication-a'), calls, 'Human projection/read must not wake the local Chief')
writeFileSync(join(repo, '.dsh-test-tools/p0-human.json'), JSON.stringify({ runId: faults.runId, status: 'PASS', cases: results,
  unchangedChiefEvents: before.chiefEvents, additionalModelCalls: 0, scope: 'real DSH, test-only Human projection; no Hub' }, null, 2) + '\n')
console.log('PASS P0 Human boundary: real Bot final reply projects once to group and DM with source identity and unread/read; no Chief input or model call.')
