import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { normalizeIpAddress } from '../src/shared/ip-address.js'
import { CommunicationQueue } from '../src/host/federation/queue-store.js'
import { CommunicationRuntime } from '../src/host/federation/runtime.js'
import { CommunicationTransport } from '../src/host/federation/transport.js'
import { contactLabels, contactsByAddress } from '../src/client/communication-model.js'
import { communicationError } from '../src/shared/communication-diagnostics.js'

test('IP notes canonicalize literal IPv4/IPv6 and valid ports without guessing IPv6 ports or resolving hostnames', () => {
  for (const [input, output] of [
    [' 192.0.2.1 ', '192.0.2.1'], ['192.0.2.1:3190', '192.0.2.1'],
    ['2001:0DB8:0:0:0:0:0:1', '2001:db8::1'], ['[2001:db8::1]:65535', '2001:db8::1'], ['[::1]', '::1'],
    ['2001:db8::1:3190', '2001:db8::1:3190'], ['::ffff:192.0.2.1', '192.0.2.1'], ['[::ffff:c000:201]:80', '192.0.2.1'],
  ]) assert.equal(normalizeIpAddress(input), output, input)
  for (const input of [undefined, {}, '', 'localhost', 'example.com:80', 'https://192.0.2.1', '127.1', '0x7f000001', '192.000.2.1',
    '192.0.2.256', '192.0.2.1:0', '192.0.2.1:65536', '[::1]:-1', '[::1]:abc', '[192.0.2.1]:80', 'fe80::1%eth0', ':::', '192.0.2.1\nother']) {
    assert.equal(normalizeIpAddress(input), null, String(input))
  }
})

test('local notes survive reopening and migrate additively without outbox, sharing, identity or other Hub changes', () => {
  const home = mkdtempSync(join(tmpdir(), 'dsbot-ip-notes-'))
  let queue, other
  try {
    const path = join(home, 'hub-a.sqlite')
    queue = new CommunicationQueue(path, { instanceId: 'a' })
    const person = queue.localPrincipal('human', 'owner', 'Owner')
    queue.enqueueOperation('dm.open', { principalId: person.principalId, operationId: 'retained', otherPrincipalId: 'human:b:owner' })
    const pending = queue.pendingOutbox()
    queue.db.exec('DROP TABLE local_address_notes')
    queue.close(); queue = new CommunicationQueue(path)
    assert.deepEqual(queue.addressNotes(), {})
    queue.setAddressNote({ address: '192.0.2.1:3000', note: ' Office NAT 办公室 ' })
    queue.setAddressNote({ address: '[2001:0DB8::1]:443', note: '<img src=x onerror=alert(1)>' })
    queue.close(); queue = new CommunicationQueue(path)
    assert.deepEqual(queue.addressNotes(), { '192.0.2.1': 'Office NAT 办公室', '2001:db8::1': '<img src=x onerror=alert(1)>' })
    queue.setAddressNote({ address: '::ffff:c000:201', note: 'Renamed' })
    assert.equal(queue.addressNotes()['192.0.2.1'], 'Renamed')
    assert.deepEqual(queue.pendingOutbox(), pending)
    assert.equal(queue.localPrincipal('human', 'owner', 'Owner').principalId, person.principalId)
    other = new CommunicationQueue(join(home, 'hub-b.sqlite'), { instanceId: 'a' })
    assert.deepEqual(other.addressNotes(), {})
    queue.setAddressNote({ address: '192.0.2.1', note: '  ' })
    queue.close(); queue = new CommunicationQueue(path)
    assert.equal(queue.addressNotes()['192.0.2.1'], undefined)
    assert.equal(other.addressNotes()['192.0.2.1'], undefined)
  } finally { queue?.close(); other?.close(); rmSync(home, { recursive: true, force: true }) }
})

test('note validation, entry limits and rollback preserve previous local state and safe diagnostic codes', () => {
  let crash = false
  const queue = new CommunicationQueue(':memory:', { beforeCommit: () => { if (crash) throw new Error('simulated') } })
  try {
    queue.setAddressNote({ address: '192.0.2.1', note: 'Original' })
    for (const note of [undefined, 3, 'x'.repeat(161), 'line\nbreak', 'hidden\u202e', 'null\0']) assert.throws(() => queue.setAddressNote({ address: '192.0.2.1', note }), { code: 'INVALID_IP_NOTE' })
    assert.throws(() => queue.setAddressNote({ address: 'example.com', note: 'Private' }), { code: 'INVALID_IP_ADDRESS' })
    crash = true
    assert.throws(() => queue.setAddressNote({ address: '192.0.2.1', note: 'Lost' }), /simulated/)
    assert.equal(queue.addressNotes()['192.0.2.1'], 'Original')
    crash = false
    for (let index = 1; index < 256; index++) queue.setAddressNote({ address: `198.51.100.${index}`, note: String(index) })
    assert.throws(() => queue.setAddressNote({ address: '203.0.113.1', note: 'Extra' }), { code: 'IP_NOTE_LIMIT' })
    queue.setAddressNote({ address: '192.0.2.1', note: 'Can still edit' })
    queue.setAddressNote({ address: '192.0.2.1', note: '' })
    queue.setAddressNote({ address: '203.0.113.1', note: 'Now allowed' })
    assert.equal(Object.keys(queue.addressNotes()).length, 256)
    for (const code of ['INVALID_IP_ADDRESS', 'INVALID_IP_NOTE', 'IP_NOTE_LIMIT']) {
      const error = communicationError({ code, message: 'Private note' })
      assert.equal(error.code, code); assert.doesNotMatch(JSON.stringify(error), /Private note/)
    }
  } finally { queue.close() }
})

test('local address note UI state never mutates contacts or publishes to the Hub and rejects stale Hub/read-only writes', async () => {
  const start = CommunicationTransport.prototype.start
  CommunicationTransport.prototype.start = () => {}
  let runtime, readOnly
  try {
    runtime = new CommunicationRuntime({ home: tmpdir(), botOf: () => undefined, readOnly: () => readOnly,
      ctx: { on: () => () => {}, systemPrompt: { section: () => () => {} } } },
    { url: 'ws://127.0.0.1:3190/communication', hubId: 'hub-a', instanceId: 'a', dataPath: ':memory:', publishedBotIds: [] }, 'synthetic', [])
    runtime.transport.request = async () => assert.fail('IP notes are never Hub operations')
    const contacts = [{ principalId: 'human:b:owner', homeInstanceId: 'b', instanceLabel: 'Remote', displayName: 'Owner', kind: 'human', ipAddress: '192.0.2.1' },
      { principalId: 'human:c:owner', homeInstanceId: 'c', instanceLabel: 'Remote', displayName: 'Owner', kind: 'human', ipAddress: '::ffff:c000:201' }]
    runtime.contacts = structuredClone(contacts)
    const labels = contactLabels(contacts), expectedScope = runtime.addressNotesScope()
    runtime.setAddressNote({ expectedScope, address: '192.0.2.1:443', note: 'NAT label' })
    assert.equal(runtime.snapshot().addressNotes['192.0.2.1'], 'NAT label')
    assert.deepEqual(runtime.contacts, contacts)
    assert.deepEqual(contactLabels(runtime.contacts), labels)
    const groups = contactsByAddress(runtime.contacts, runtime.snapshot().addressNotes)
    assert.equal(groups.length, 1); assert.equal(groups[0].instances.length, 2); assert.equal(groups[0].note, 'NAT label')
    assert.deepEqual(runtime.queue.pendingOutbox(), [])
    assert.throws(() => runtime.setAddressNote({ expectedScope: expectedScope + 'old', address: '192.0.2.1', note: 'Stale' }), { code: 'HUB_SELECTION_CHANGED' })
    readOnly = 'locked'
    assert.throws(() => runtime.setAddressNote({ expectedScope, address: '192.0.2.1', note: 'Blocked' }), { code: 'COMMUNICATION_READ_ONLY' })
    assert.equal(runtime.queue.addressNotes()['192.0.2.1'], 'NAT label')
  } finally { if (runtime) await runtime.close(); CommunicationTransport.prototype.start = start }
})
