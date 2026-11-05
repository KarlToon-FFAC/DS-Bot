// Fresh independent DSH hosts, real loopback Hub and deterministic Mock only.
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { startHub } from '../../../communication-hub/src/server.js'
import { LocalTopology, until } from './local-topology.mjs'

const nonce = randomUUID().slice(0, 8)
const topology = new LocalTopology({ prefix: `contact-race-${nonce}`, webPort: 3261, mockPort: 8961, hubPort: 3293 })
const evidence = { status: 'RUNNING', base: 'd61b42a', network: 'same-machine loopback', model: 'deterministic local Mock', cases: [] }
const output = join(topology.root, `${topology.prefix}-acceptance.json`)
const record = id => { evidence.cases.push({ id, status: 'PASS' }); console.log(`PASS ${id}`) }
let hub, armed = false, held
const sockets = new Map()
topology.startHub = async () => {
  hub = await startHub({ databasePath: join(topology.root, `${topology.prefix}-hub.sqlite`), port: topology.hubPort,
    peers: topology.peers.map(peer => ({ instanceId: peer.instanceId, credential: peer.credential })),
    beforeResponse: ({ type, value, socket }) => {
      if (type === 'hello') sockets.set(value.instanceId, socket)
      if (armed && type === 'memberships.list' && value.memberships.some(member => member.principalId === topology.peers[0].human)) {
        armed = false
        // Hold one already computed snapshot until the other real client revokes.
        const send = socket.send
        socket.send = function (...args) { socket.send = send; held = { release: () => send.apply(socket, args) } }
      }
    } })
}
topology.stopHub = async () => { await hub?.close(); hub = null }
const trust = () => hub.store.db.prepare('SELECT id,trusted,epoch FROM instances ORDER BY id').all()
const consent = async (a, b) => {
  const { userCode } = await b.api({ endpoint: 'user-code' })
  const request = await topology.operation(a, 'request-contact', { userCode, localBotIds: [a.botId] })
  const incoming = (await b.api({ endpoint: 'contact-requests' })).find(item => item.requestId === request.requestId)
  await topology.operation(b, 'accept-contact', { requestId: request.requestId, expectedVersion: incoming.version, localBotIds: [b.botId] })
  return (await b.api({ endpoint: 'contact-relations' })).find(item => item.otherHumanPrincipalId === a.human && item.active)
}
const deadline = setTimeout(() => { console.error('Owned contact acceptance deadline'); void topology.close().finally(() => process.exit(1)) }, 8 * 60 * 1000)
try {
  await topology.initialize()
  const [a, b] = topology.peers
  const relation = await consent(a, b)
  const dm = (await topology.operation(b, 'dm', { otherPrincipalId: a.human })).conversationId
  const group = await topology.group('Group survives contact removal', [b.human, a.bot, b.bot])
  await topology.send(b, dm, `Human history ${nonce}`)
  await until(() => topology.hasText(a, dm, `Human history ${nonce}`), 'initial Human DM history')
  await topology.send(b, group, `COMM-ECHO before-${nonce}`, [a.bot])
  await until(() => topology.hasText(b, group, `Communication reply before-${nonce}`), 'actual Mock group reply before removal')
  record('two-independent-DSH-hosts-and-real-Mock-reply')
  const beforeTrust = trust(), before = await a.api({ endpoint: 'state' })
  armed = true
  await until(() => held, 'old A membership snapshot held')
  await topology.operation(b, 'revoke-contact', { otherHumanPrincipalId: a.human, expectedVersion: relation.version })
  held.release(); held = null
  await until(async () => {
    const state = await a.api({ endpoint: 'state' })
    return state.connected && !state.error && !state.contacts.some(person => person.principalId === b.human)
  }, 'contact removal refresh without stopping transport')
  assert.deepEqual(trust(), beforeTrust)
  assert.equal((await a.api({ endpoint: 'state' })).lastConnectedAt, before.lastConnectedAt, 'the existing socket remains authenticated')
  assert.equal((await b.api({ endpoint: 'state' })).connected, true)
  record('contact-revoke-racing-old-snapshot-keeps-both-devices-trusted-and-connected')
  const denied = await topology.send(a, dm, `Must not publish ${nonce}`)
  await until(async () => (await a.api({ endpoint: 'state' })).outbox.some(item => item.id === denied.messageId && item.state === 'failed' && ['MEMBERSHIP_REVOKED','CONTACT_REQUIRED'].includes(item.error)), 'removed contact cannot receive a new DM')
  assert.equal(hub.store.db.prepare('SELECT count(*) n FROM messages WHERE id=?').get(denied.messageId).n, 0)
  await topology.send(b, group, `COMM-ECHO after-${nonce}`, [a.bot])
  await until(() => topology.hasText(b, group, `Communication reply after-${nonce}`), 'unrelated group and original Bot keep working')
  record('denied-DM-stays-failed-while-existing-group-continues-real-Mock-work')
  const connectedAt = (await a.api({ endpoint: 'state' })).lastConnectedAt
  sockets.get(a.instanceId).close(1001, 'Synthetic network recovery')
  await until(async () => {
    const state = await a.api({ endpoint: 'state' })
    return state.connected && !state.error && state.lastConnectedAt !== connectedAt
  }, 'ordinary network reconnect after contact revocation')
  assert.equal((await a.api({ endpoint: 'state' })).humanPrincipalId, a.human)
  record('ordinary-network-reconnect-retains-device-identity-without-restoring-contact')
  await topology.bench(a, 'stop')
  await topology.startPeer(a)
  const restarted = await a.api({ endpoint: 'state' })
  assert.equal(restarted.connected, true)
  assert.equal(restarted.humanPrincipalId, a.human)
  assert.equal(restarted.contacts.some(person => person.principalId === b.human), false)
  assert.equal((await topology.history(a, dm)).events.some(event => event.message?.content.text === `Human history ${nonce}`), true)
  record('normal-host-restart-retains-history-and-revoked-contact-state')
  hub.revoke(a.instanceId)
  await until(async () => {
    const state = await a.api({ endpoint: 'state' })
    return !state.connected && state.error === 'UNAUTHENTICATED'
  }, 'actual synthetic device trust revocation remains terminal')
  assert.equal((await b.api({ endpoint: 'state' })).connected, true)
  record('actual-device-revocation-remains-terminal-and-does-not-affect-other-device')
  evidence.status = 'PASS'
} catch (error) { evidence.status = 'FAIL'; evidence.error = error.message; console.error(error.stack); process.exitCode = 1 }
finally { clearTimeout(deadline); held?.release(); await topology.close(); writeFileSync(output, JSON.stringify(evidence, null, 2)); console.log(JSON.stringify(evidence, null, 2)) }
