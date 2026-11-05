// Real isolated DSH A/B + Hub, local deterministic Mock only. No external models.
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { createServer } from 'node:net'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { LocalTopology, until } from './local-topology.mjs'

const nonce = randomUUID().slice(0, 8)
const topology = new LocalTopology({ prefix: `relationships-${nonce}`, webPort: 3161, mockPort: 8861, hubPort: 3193 })
const output = join(topology.root, `${topology.prefix}-acceptance.json`)
const evidence = { status: 'RUNNING', network: 'same-machine loopback', model: 'local deterministic Mock', cases: [],
  uncovered: ['real-model soft collaboration guidance', 'physical cross-machine network', 'GUI editor (not implemented)'] }
const save = () => writeFileSync(output, JSON.stringify(evidence, null, 2))
const record = id => { evidence.cases.push({ id, status: 'PASS' }); save(); console.log(`PASS ${id}`) }
const owner = process.env.DSBOT_COMMUNICATION_OWNER_PID
process.env.DSBOT_COMMUNICATION_OWNER_PID = String(process.pid)
const bench = topology.bench.bind(topology)
topology.bench = (peer, action, extra = {}) => bench(peer, action, { ...extra, DSBOT_COMMUNICATION_OWNER_PID: String(process.pid) })
const epoch = (peer, conversationId) => {
  const db = topology.db(peer)
  try { return db.prepare('SELECT epoch FROM memberships WHERE conversation_id=? AND principal_id=? AND active=1').get(conversationId, peer.bot)?.epoch }
  finally { db.close() }
}
const recall = (peer, conversationId) => peer.api({ endpoint: 'relationship-memory', localBotId: peer.botId, conversationId, membershipEpoch: epoch(peer, conversationId) })
async function command(sender, recipient, conversationId, action, value) {
  const tag = randomUUID().slice(0, 8)
  await topology.send(sender, conversationId, `COMM-RELATIONSHIP ${action} ${tag} ${typeof value === 'string' ? value : JSON.stringify(value)}`, [recipient.bot])
  return { tag, response: await until(async () => {
    const events = (await topology.history(sender, conversationId)).events
    return events.find(event => event.message?.author.principalId === recipient.bot && event.message.content.text.includes(tag))?.message.content.text
  }, `relationship ${action} finishes`, 60000) }
}
const deadline = setTimeout(() => { console.error('Acceptance hard deadline exceeded'); void topology.close().finally(() => process.exit(1)) }, 10 * 60 * 1000)
try {
  for (const port of [3161, 3162, 8861, 8862, 3193]) await new Promise((resolve, reject) => {
    const server = createServer(); server.once('error', () => reject(new Error('Required isolated port occupied')))
    server.listen(port, '127.0.0.1', () => server.close(resolve))
  })
  for (const peer of topology.peers) assert.equal(existsSync(join(topology.root, '..', `.dsh-test-${peer.name}`)), false)
  await topology.initialize()
  const [a, b] = topology.peers
  const group = await topology.group('GroupX development team', [a.bot, b.bot])
  const other = await topology.group('Independent GroupY', [a.bot, b.bot])
  const fact = `A is the XX specialist ${nonce}`
  await command(a, b, group, 'SAVE', { conversationId: group, subjectKind: 'contact', subjectPrincipalId: a.bot, topic: 'expertise', text: fact })
  const entry = (await recall(b, group)).entries.find(entry => entry.text === fact)
  assert.ok(entry)
  assert.equal(entry.status, 'reported')
  assert.equal(entry.source.authorPrincipalId, a.human)
  assert.ok(entry.source.messageId)
  const read = await command(a, b, group, 'READ', { conversationId: group })
  assert.ok(read.response.includes(fact))
  record('model-tool-canonical-source-and-recall')

  assert.match((await command(a, b, group, 'PROMPT', fact)).response, /PRESENT$/)
  assert.match((await command(a, b, other, 'PROMPT', fact)).response, /ABSENT$/)
  assert.deepEqual((await recall(a, group)).entries, [])
  record('actual-prompt-group-and-Bot-isolation')

  const profile = `Remote organization profile ${nonce}`
  await b.api({ endpoint: 'save-relationship-memory', localBotId: b.botId, subjectKind: 'self', topic: 'organization', text: profile, shareAcrossConversations: true })
  assert.match((await command(a, b, other, 'PROMPT', profile)).response, /PRESENT$/)
  await topology.bench(b, 'stop'); await topology.startPeer(b)
  assert.ok((await recall(b, group)).entries.some(item => item.id === entry.id && item.text === fact))
  assert.match((await command(a, b, group, 'PROMPT', fact)).response, /PRESENT$/)
  record('explicit-local-profile-and-storage-restart')

  const oldEpoch = epoch(b, group)
  await topology.operation(a, 'remove', { conversationId: group, targetPrincipalId: b.bot })
  const invite = await topology.operation(a, 'invite', { conversationId: group, inviteePrincipalId: b.bot })
  await topology.operation(b, 'accept', { inviteId: invite.inviteId, recipientPrincipalId: b.bot })
  await until(() => epoch(b, group) && epoch(b, group) !== oldEpoch, 'fresh Bot membership epoch')
  assert.equal((await recall(b, group)).entries.some(entry => entry.text === fact), false)
  assert.equal((await recall(b, group)).entries.some(entry => entry.text === profile), true)
  record('rejoin-excludes-old-epoch-retains-explicit-profile')

  const log = readFileSync(join(b.home, 'mock.jsonl'), 'utf8').split('\n').filter(Boolean).map(JSON.parse)
  const scoped = log.filter(call => call.communicationBoundary?.isolated)
  assert.ok(scoped.some(call => call.toolNames?.includes('remember_communication_relationship')))
  assert.ok(scoped.every(call => !call.toolNames.some(name => ['bash','read_file','remember','create_bot'].includes(name))))
  record('actual-isolated-tool-view-keeps-local-tools-unavailable')
  evidence.status = 'PASS'
} catch (error) { evidence.status = 'FAIL'; evidence.error = error.message; process.exitCode = 1 }
finally {
  clearTimeout(deadline)
  await topology.close()
  if (owner === undefined) delete process.env.DSBOT_COMMUNICATION_OWNER_PID
  else process.env.DSBOT_COMMUNICATION_OWNER_PID = owner
  save()
  console.log(JSON.stringify(evidence, null, 2))
}
