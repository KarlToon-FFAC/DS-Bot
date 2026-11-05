// Real isolated DSH A/B and Hub, using only the local deterministic Mock.
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { LocalTopology } from './local-topology.mjs'

const topology = new LocalTopology({ prefix: `ipnotes-${randomUUID().slice(0, 8)}`, webPort: 3171, mockPort: 8871, hubPort: 3195 })
const evidence = { status: 'RUNNING', network: 'same-machine loopback', model: 'local deterministic Mock', cases: [] }
const output = join(topology.root, `${topology.prefix}-acceptance.json`)
const record = id => { evidence.cases.push({ id, status: 'PASS' }); console.log(`PASS ${id}`) }
const owner = process.env.DSBOT_COMMUNICATION_OWNER_PID
process.env.DSBOT_COMMUNICATION_OWNER_PID = String(process.pid)
const deadline = setTimeout(() => { void topology.close().finally(() => process.exit(1)) }, 5 * 60 * 1000)
const modelLog = peer => {
  try { return readFileSync(join(peer.home, 'mock.jsonl'), 'utf8') }
  catch (error) { if (error.code === 'ENOENT') return ''; throw error }
}
try {
  await topology.initialize()
  const [a, b] = topology.peers
  const initial = await a.api({ endpoint: 'state' }), remote = await b.api({ endpoint: 'state' })
  const note = 'Private local label ' + randomUUID().slice(0, 8)
  const save = (address, text, expectedScope = initial.addressNotesScope) => a.api({ endpoint: 'set-address-note', address, note: text, expectedScope })
  await save('192.0.2.1:443', note)
  await save('[2001:0DB8::1]:3190', 'IPv6 label')
  const saved = await a.api({ endpoint: 'state' })
  assert.equal(saved.addressNotes['192.0.2.1'], note)
  assert.equal(saved.addressNotes['2001:db8::1'], 'IPv6 label')
  assert.deepEqual(saved.contacts, initial.contacts)
  assert.deepEqual(saved.outbox, initial.outbox)
  assert.deepEqual((await b.api({ endpoint: 'state' })).addressNotes, remote.addressNotes)
  assert.equal(JSON.stringify(await topology.hub('stats')).includes(note), false)
  assert.ok(topology.peers.every(peer => !modelLog(peer).includes(note)))
  record('authenticated-local-save-with-no-Hub-peer-outbox-or-model-leak')
  await assert.rejects(save('example.com', 'Invalid'), /valid IPv4 or IPv6/)
  await assert.rejects(save('192.0.2.1', 'Old scope', initial.addressNotesScope + '-old'), /selected Hub changed/i)
  assert.equal((await a.api({ endpoint: 'state' })).addressNotes['192.0.2.1'], note)
  record('invalid-address-and-stale-Hub-scope-rejected')
  await topology.bench(a, 'stop'); await topology.startPeer(a)
  assert.equal((await a.api({ endpoint: 'state' })).addressNotes['192.0.2.1'], note)
  await save('::ffff:c000:201', 'Updated')
  assert.equal((await a.api({ endpoint: 'state' })).addressNotes['192.0.2.1'], 'Updated')
  await save('192.0.2.1', '')
  await topology.bench(a, 'stop'); await topology.startPeer(a)
  const final = await a.api({ endpoint: 'state' })
  assert.equal(final.addressNotes['192.0.2.1'], undefined)
  assert.equal(final.addressNotes['2001:db8::1'], 'IPv6 label')
  assert.deepEqual(final.contacts, initial.contacts)
  assert.ok(topology.peers.every(peer => !modelLog(peer).includes(note)))
  record('real-host-restart-edit-normalization-and-durable-clear')
  evidence.status = 'PASS'
} catch (error) { evidence.status = 'FAIL'; evidence.error = error.message; process.exitCode = 1 }
finally {
  clearTimeout(deadline); await topology.close()
  if (owner === undefined) delete process.env.DSBOT_COMMUNICATION_OWNER_PID
  else process.env.DSBOT_COMMUNICATION_OWNER_PID = owner
  writeFileSync(output, JSON.stringify(evidence, null, 2) + '\n')
  console.log(JSON.stringify(evidence, null, 2))
}
