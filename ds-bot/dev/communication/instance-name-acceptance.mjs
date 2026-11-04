import assert from 'node:assert/strict'
import { fork } from 'node:child_process'
import { createServer } from 'node:net'
import { randomUUID } from 'node:crypto'
import { existsSync, writeFileSync, rmSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { LocalTopology, until } from './local-topology.mjs'
import { repo } from './bench-client.mjs'

const nonce = randomUUID().slice(0, 8), topology = new LocalTopology({ prefix: `instance-names-${nonce}`, webPort: 3231, mockPort: 8901, hubPort: 3233 })
const ports = [3231, 3232, 8901, 8902, 3233], live = process.argv.includes('--live-for-browser')
const output = join(topology.root, `${topology.prefix}-acceptance.json`), evidence = { status: 'RUNNING', model: 'local deterministic Mock', network: 'same-machine loopback', cases: [] }
const save = () => writeFileSync(output, JSON.stringify(evidence, null, 2))
const record = id => { evidence.cases.push({ id, status: 'PASS' }); save(); console.log(`PASS ${id}`) }
const free = port => new Promise((done, reject) => { const server = createServer(); server.once('error', reject); server.listen(port, '127.0.0.1', () => server.close(done)) })
const previousOwner = process.env.DSBOT_COMMUNICATION_OWNER_PID
process.env.DSBOT_COMMUNICATION_OWNER_PID = String(process.pid)
const bench = topology.bench.bind(topology)
topology.bench = (peer, action, extra = {}) => bench(peer, action, { DSBOT_COMMUNICATION_OWNER_PID: String(process.pid), DSBOT_WEB_OPEN: '0', ...extra })
topology.startHub = async () => {
  const child = fork(join(import.meta.dirname, 'instance-name-hub-fixture.mjs'), [join(topology.root, `${topology.prefix}-hub.sqlite`), String(topology.hubPort)], {
    windowsHide: true, stdio: ['ignore', 'ignore', 'ignore', 'ipc'], env: { ...process.env, DSBOT_TEST_PEERS: JSON.stringify(topology.peers.map(peer => ({ instanceId: peer.instanceId, instanceLabel: `Original ${peer.id.toUpperCase()}`, credential: peer.credential }))) } })
  topology.child = child
  await new Promise((done, reject) => { const timer = setTimeout(() => reject(Error('Owned Hub startup timeout')), 15000); child.once('message', value => { clearTimeout(timer); if (value.type === 'ready') done(); else reject(Error('Hub not ready')) }); child.once('exit', () => { clearTimeout(timer); reject(Error('Owned Hub exited')) }) })
}
const admin = async (action, input = {}, authenticated = true) => {
  const response = await fetch(`http://127.0.0.1:3233/admin/api/${action}`, { method: 'POST', redirect: 'error', headers: { 'content-type': 'application/json', ...(authenticated ? { authorization: 'Bearer synthetic-test-instance-name-admin-password' } : {}) }, body: JSON.stringify(input), signal: AbortSignal.timeout(10000) })
  return { status: response.status, body: await response.json() }
}
let owns = false, readyPath, ready
const deadline = setTimeout(() => { console.error('Test deadline'); void topology.close().finally(() => process.exit(1)) }, 12 * 60 * 1000)
try {
  for (const port of ports) await free(port)
  for (const peer of topology.peers) assert.equal(existsSync(join(repo, `.dsh-test-${peer.name}`)), false)
  owns = true; await topology.initialize()
  const [a, b] = topology.peers
  const group = await topology.group(`Name sync ${nonce}`, [a.bot, b.human, b.bot])
  const message = await topology.send(a, group, `Synthetic stable identity ${nonce}`)
  await until(() => topology.hasText(b, group, message.text), 'B has canonical message')
  const before = await a.api({ endpoint: 'members', conversationId: group })
  const history = (await topology.history(a, group)).events.filter(event => event.type === 'message')
  const rename = { instanceId: b.instanceId, label: `Renamed office ${nonce}`, expectedNameVersion: 0 }
  assert.equal((await admin('rename', rename, false)).status, 401)
  assert.equal((await admin('state')).body.value.instances.find(item => item.instanceId === b.instanceId).label, 'Original B')
  record('unauthenticated-admin-rename-denied-without-mutation')
  assert.equal((await admin('rename', rename)).status, 200)
  for (const peer of topology.peers) await until(async () => (await peer.api({ endpoint: 'state' })).contacts.filter(person => person.homeInstanceId === b.instanceId).every(person => person.instanceLabel === rename.label), 'connected client metadata rename')
  await until(async () => (await a.api({ endpoint: 'state' })).conversations.find(item => item.conversationId === group)?.info.members.filter(person => person.homeInstanceId === b.instanceId).every(person => person.instanceLabel === rename.label), 'group-scoped metadata rename')
  const after = await a.api({ endpoint: 'members', conversationId: group })
  assert.equal(after.membershipVersion, before.membershipVersion)
  assert.deepEqual(after.members.map(({ instanceLabel: _label, ...person }) => person), before.members.map(({ instanceLabel: _label, ...person }) => person))
  assert.deepEqual((await topology.history(a, group)).events.filter(event => event.type === 'message'), history)
  assert.equal((await admin('rename', rename)).body.error.code, 'INSTANCE_NAME_VERSION_CONFLICT')
  record('online-client-directory-and-members-update-without-identity-history-or-permission-change')
  await topology.stopHub(); await topology.startHub()
  for (const peer of topology.peers) await until(async () => { const state = await peer.api({ endpoint: 'state' }); return state.connected && state.contacts.find(person => person.principalId === b.human)?.instanceLabel === rename.label }, 'DSH reconnect after persisted Hub restart')
  assert.equal((await admin('state')).body.value.instances.find(item => item.instanceId === b.instanceId).nameVersion, 1)
  assert.deepEqual((await topology.history(a, group)).events.filter(event => event.type === 'message'), history)
  record('Hub-restart-and-static-reconnect-preserve-name-version-and-canonical-history')
  evidence.status = 'PASS'; save()
  if (live) {
    clearTimeout(deadline)
    readyPath = join(topology.root, `${topology.prefix}-browser-ready.json`)
    ready = { status: 'READY', expiresAt: new Date(Date.now() + 12 * 60 * 1000).toISOString(), managementUrl: 'http://127.0.0.1:3233/admin/', groupConversationId: group, renamedInstanceId: b.instanceId, expectedLabel: rename.label,
      profiles: topology.peers.map(peer => ({ url: `http://127.0.0.1:${peer.web}/`, name: peer.name })), stopFile: join(topology.root, `${topology.prefix}-browser-stop`) }
    writeFileSync(readyPath, JSON.stringify(ready, null, 2)); console.log(`BROWSER_READY .dsh-test-tools/${topology.prefix}-browser-ready.json`)
    while (!existsSync(ready.stopFile) && Date.now() < Date.parse(ready.expiresAt)) await new Promise(done => setTimeout(done, 500))
  }
} catch (error) { evidence.status = 'FAIL'; evidence.error = error.message; console.error(error.message); process.exitCode = 1 }
finally {
  clearTimeout(deadline); if (owns) await topology.close()
  for (const port of ports) await free(port)
  for (const peer of topology.peers) { if (!peer.home) continue; const target = resolve(peer.home); assert.equal(dirname(target), repo); assert.equal(target, join(repo, `.dsh-test-${peer.name}`)); assert.ok(peer.name.startsWith(`instance-names-${nonce}`)); rmSync(target, { recursive: true, force: true }) }
  if (previousOwner === undefined) delete process.env.DSBOT_COMMUNICATION_OWNER_PID; else process.env.DSBOT_COMMUNICATION_OWNER_PID = previousOwner
  if (readyPath) writeFileSync(readyPath, JSON.stringify({ ...ready, status: 'STOPPED' }, null, 2))
  evidence.cleanedUp = true; evidence.temporaryProfilesDeleted = true; save()
}
