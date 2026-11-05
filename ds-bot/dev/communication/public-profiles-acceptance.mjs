// Actual isolated DSH A/B + plugin + Hub; local deterministic Mock only.
import assert from 'node:assert/strict'
import { randomUUID, createHash } from 'node:crypto'
import { createServer } from 'node:net'
import { existsSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { LocalTopology, until } from './local-topology.mjs'

const nonce = randomUUID().slice(0, 8)
const ports = [3261, 3262, 8961, 8962, 3290]
const topology = new LocalTopology({ prefix: `public-profiles-${nonce}`, webPort: ports[0], mockPort: ports[2], hubPort: ports[4] })
const output = join(topology.root, `${topology.prefix}-acceptance.json`)
const plugin = resolve(import.meta.dirname, '../..')
const evidence = { status: 'RUNNING', transport: 'same-machine loopback', model: 'local deterministic Mock', cases: [],
  uncovered: ['real OpenAI/vault', 'physical cross-machine network', 'GUI rendering', 'automatic expert consultation (not implemented)'] }
const save = () => writeFileSync(output, JSON.stringify(evidence, null, 2) + '\n')
const record = id => { evidence.cases.push({ id, status: 'PASS' }); save(); console.log(`PASS ${id}`) }
const idlePort = port => new Promise((resolvePort, reject) => {
  const server = createServer()
  server.once('error', () => reject(new Error('ISOLATED_PORT_UNAVAILABLE')))
  server.listen(port, '127.0.0.1', () => server.close(resolvePort))
})
const owner = process.env.DSBOT_COMMUNICATION_OWNER_PID
process.env.DSBOT_COMMUNICATION_OWNER_PID = String(process.pid)
const bench = topology.bench.bind(topology)
topology.bench = (peer, action, extra = {}) => bench(peer, action, { ...extra, DSBOT_COMMUNICATION_OWNER_PID: String(process.pid) })
const startPeer = topology.startPeer.bind(topology)
topology.startPeer = (peer, extra = {}, options) => startPeer(peer, {
  DSBOT_COMMUNICATION_CONFIG: JSON.stringify({ enabled: true, url: topology.url, instanceId: peer.instanceId,
    publishedBotIds: peer.publicationIds ?? [peer.botId], humanDisplayName: `Person ${peer.id.toUpperCase()}`, pollMs: 150 }),
  ...extra,
}, options)
const team = peer => peer.client.request('/api/bot', { endpoint: 'state' })
const changeBot = (peer, payload) => peer.client.request('/api/bot', { endpoint: 'update-bot', payload })
const remoteContact = async (peer, id) => (await peer.api({ endpoint: 'state' })).contacts.find(item => item.principalId === id)
const profile = (headline, summary, expertise) => ({ headline, summary, expertise, languages: ['English', '中文'] })
const humanProfile = profile('Testing coordinator', 'Buddy coordinates synthetic test coverage.', ['Test strategy', 'Regression planning'])
const browserProfile = profile('Browser test specialist', 'Synthetic end-to-end browser test support.', ['Playwright', 'Browser regression'])
const apiProfile = profile('API test specialist', 'Synthetic API contract and load test support.', ['API contracts', 'Load testing'])
const deadline = setTimeout(() => { console.error('PROFILE_ACCEPTANCE_DEADLINE'); void topology.close().finally(() => process.exit(1)) }, 10 * 60 * 1000)

try {
  for (const port of ports) await idlePort(port)
  for (const peer of topology.peers) assert.equal(existsSync(join(topology.root, '..', `.dsh-test-${peer.name}`)), false)
  save()
  await topology.initialize()
  const [a, b] = topology.peers
  for (const peer of topology.peers) {
    assert.equal(realpathSync(join(peer.home, 'profiles/communication-test/node_modules/ds-bot')), realpathSync(plugin))
    assert.ok((await team(peer)).bots.some(item => item.id === peer.botId))
    assert.ok((await peer.api({ endpoint: 'state' })).reconciled)
  }
  evidence.environment = { profiles: topology.peers.map(peer => peer.name), ports,
    dshVersion: JSON.parse(readFileSync(join(plugin, 'dev/harness/package.json'), 'utf8')).dependencies['@deepseek-ai/dsh'],
    pluginSourceHash: createHash('sha256').update(['src/host/federation/public-profiles.js', 'src/host/federation/avatars.js', 'src/host/roster.js']
      .map(path => readFileSync(join(plugin, path))).join('\n')).digest('hex') }
  record('two-real-DSH-hosts-load-current-worktree-plugin')

  await topology.operation(b, 'profile-human', { displayName: 'Buddy' })
  const original = await b.api({ endpoint: 'human-profile-info' })
  assert.equal(original.principalId, b.human)
  const saveHuman = { endpoint: 'profile-human-info', operationId: randomUUID(), expectedVersion: original.publicProfile.version, profile: humanProfile }
  await b.api(saveHuman)
  const buddy = await until(async () => {
    const contact = await remoteContact(a, b.human)
    return contact?.displayName === 'Buddy' && contact.publicProfile?.headline === humanProfile.headline && contact
  }, 'other real DSH sees Buddy public profile')
  assert.equal(buddy.publicProfile.summary, humanProfile.summary)
  assert.deepEqual(buddy.publicProfile.expertise, humanProfile.expertise)
  assert.equal(buddy.publicProfile.version, original.publicProfile.version + 1)
  record('Human-CAS-profile-propagates-to-other-DSH')

  let humanConflict = false
  try { await b.api({ ...saveHuman, operationId: randomUUID(), profile: { ...humanProfile, headline: 'Stale overwrite must fail' } }) }
  catch (error) { humanConflict = error.code === 'PUBLIC_PROFILE_VERSION_CONFLICT' }
  assert.equal(humanConflict, true)
  assert.equal((await b.api({ endpoint: 'human-profile-info' })).publicProfile.headline, humanProfile.headline)
  await assert.rejects(() => b.api({ ...saveHuman, operationId: randomUUID(), expectedVersion: buddy.publicProfile.version, principalId: a.human }), error => error.code === 'AUTHOR_MISMATCH')
  record('Human-stale-write-and-caller-identity-injection-rejected')

  const first = (await team(b)).bots.find(item => item.id === b.botId)
  await changeBot(b, { id: b.botId, expectedProfileRevision: first.publicProfile?.revision ?? 0, publicProfile: browserProfile })
  const extra = await b.client.request('/api/bot', { endpoint: 'create-bot', payload: { name: 'API tester', role: 'API testing', instructions: 'Use only synthetic test fixtures.', model: 'deepseek-official/deepseek-v4-pro' } })
  assert.ok(extra.id)
  await changeBot(b, { id: extra.id, expectedProfileRevision: 0, publicProfile: apiProfile })
  b.publicationIds = [b.botId, extra.id]
  await topology.bench(b, 'stop')
  await topology.startPeer(b)
  const remoteBots = await until(async () => {
    const contacts = (await a.api({ endpoint: 'state' })).contacts
    const bots = contacts.filter(item => item.homeInstanceId === b.instanceId && item.kind === 'bot')
    return bots.length === 2 && bots.some(item => item.publicProfile?.headline === browserProfile.headline)
      && bots.some(item => item.publicProfile?.headline === apiProfile.headline) && bots
  }, 'two distinct Bot profiles synchronized after actual host restart')
  for (const bot of remoteBots) assert.equal(bot.ownerPrincipalId, b.human)
  const remoteBrowser = remoteBots.find(item => item.principalId === b.bot)
  const remoteApi = remoteBots.find(item => item.principalId !== b.bot)
  assert.deepEqual(remoteBrowser.publicProfile.expertise, browserProfile.expertise)
  assert.deepEqual(remoteApi.publicProfile.expertise, apiProfile.expertise)
  assert.ok(!remoteBrowser.publicProfile.expertise.includes('Test strategy'))
  assert.equal((await b.api({ endpoint: 'human-profile-info' })).publicProfile.headline, humanProfile.headline)
  record('two-published-Bots-keep-independent-skills-and-canonical-owner')

  let botConflict = false
  try { await changeBot(b, { id: b.botId, expectedProfileRevision: 0, publicProfile: { ...browserProfile, headline: 'Stale Bot overwrite' } }) }
  catch { botConflict = true }
  assert.equal(botConflict, true)
  assert.equal((await team(b)).bots.find(item => item.id === b.botId).publicProfile.headline, browserProfile.headline)
  record('Bot-local-revision-conflict-does-not-overwrite')

  const dm = (await topology.operation(a, 'dm', { otherPrincipalId: b.bot })).conversationId
  const echo = `profile-smoke-${nonce}`
  await topology.send(a, dm, `COMM-ECHO ${echo}`)
  await until(() => topology.hasText(a, dm, `Communication reply ${echo}`), 'actual DSH Agent loop reaches local Mock and exports its reply', 60000)
  record('real-DSH-plugin-Hub-DM-uses-local-Mock')

  const remoteVersion = remoteBrowser.publicProfile.version
  const beforeReconnect = (await b.api({ endpoint: 'state' })).lastConnectedAt
  await topology.hub('disconnect', { instanceId: b.instanceId })
  await until(async () => {
    const state = await b.api({ endpoint: 'state' })
    return state.connected && state.reconciled && state.lastConnectedAt !== beforeReconnect
  }, 'B establishes a new reconciled connection')
  await until(async () => (await remoteContact(a, b.bot))?.publicProfile?.version === remoteVersion, 'profile survives reconnection')
  await topology.bench(b, 'stop')
  await topology.startPeer(b)
  const ownBots = (await team(b)).bots
  assert.equal(ownBots.find(item => item.id === b.botId).publicProfile.headline, browserProfile.headline)
  assert.equal(ownBots.find(item => item.id === extra.id).publicProfile.headline, apiProfile.headline)
  const savedBuddy = await b.api({ endpoint: 'human-profile-info' })
  assert.equal(savedBuddy.publicProfile.version, buddy.publicProfile.version)
  assert.equal((await remoteContact(b, b.bot)).publicProfile.version, remoteVersion)
  await until(async () => (await remoteContact(a, b.bot))?.publicProfile?.version === remoteVersion, 'restart does not resubmit a confirmed Bot revision')
  record('disconnect-and-restart-preserve-profiles-without-extra-version')
  evidence.status = 'PASS'
} catch (error) {
  evidence.status = 'FAIL'
  evidence.error = error.message
  process.exitCode = 1
} finally {
  clearTimeout(deadline)
  await topology.close()
  const unreleased = []
  for (const port of ports) {
    try { await until(async () => { try { await idlePort(port); return true } catch { return false } }, 'owned port releases', 15000) }
    catch { unreleased.push(port) }
  }
  evidence.cleanup = { portsReleased: unreleased.length === 0 }
  if (unreleased.length) { evidence.status = 'FAIL'; evidence.cleanup.unreleasedPorts = unreleased; process.exitCode = 1 }
  if (owner === undefined) delete process.env.DSBOT_COMMUNICATION_OWNER_PID
  else process.env.DSBOT_COMMUNICATION_OWNER_PID = owner
  save()
  console.log(JSON.stringify(evidence, null, 2))
}
