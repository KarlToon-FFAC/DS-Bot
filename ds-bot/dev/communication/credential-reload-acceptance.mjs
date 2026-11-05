import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import { createServer } from 'node:net'
import { existsSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { LocalTopology, until } from './local-topology.mjs'
import { repo, benchClient } from './bench-client.mjs'

const { parse, stringify } = createRequire(new URL('../harness/package.json', import.meta.url))('yaml')
const nonce = randomUUID().slice(0, 8), topology = new LocalTopology({ prefix: `hub-onboard-${nonce}-credential-reload`, webPort: 3241, mockPort: 8911, hubPort: 3243 })
const ports = [3241, 3242, 8911, 8912, 3243], output = join(topology.root, `${topology.prefix}-acceptance.json`)
const evidence = { status: 'RUNNING', scope: 'actual same-machine DSH A/B, real Hub, local deterministic Mock', cases: [] }
const save = () => writeFileSync(output, JSON.stringify(evidence, null, 2))
const record = id => { evidence.cases.push({ id, status: 'PASS' }); save(); console.log(`PASS ${id}`) }
const free = port => new Promise((done, reject) => { const server = createServer(); server.once('error', reject); server.listen(port, '127.0.0.1', () => server.close(done)) })
const owner = process.env.DSBOT_COMMUNICATION_OWNER_PID
process.env.DSBOT_COMMUNICATION_OWNER_PID = String(process.pid)
const bench = topology.bench.bind(topology)
topology.bench = (peer, action, extra = {}) => { evidence.stage = `${peer.id}:${action}:configured=${Boolean(peer.configured)}`; save(); return bench(peer, action, { DSBOT_COMMUNICATION_OWNER_PID: String(process.pid), DSBOT_COMMUNICATION_ONBOARDING_FIXTURE: '1', DSBOT_WEB_OPEN: '0', ...extra }) }
// The public Config Editor must own the plugin entry, not a CLI overlay. Only
// this fresh disposable profile is initialized; no DSH code or user data changes.
topology.startPeer = async peer => {
  if (!peer.configured) {
    const patch = join(peer.home, 'profiles/communication-test/cordis.patch.yml')
    const old = existsSync(patch) ? readFileSync(patch, 'utf8') : ''
    const communication = { enabled: true, url: topology.url, instanceId: peer.instanceId, publishedBotIds: [peer.botId], humanDisplayName: `Person ${peer.id.toUpperCase()}`, pollMs: 150 }
    const entries = parse(old) ?? []
    assert.ok(Array.isArray(entries)); assert.equal(entries.filter(entry => entry.id === 'bot').length, 1)
    const entry = entries.find(item => item.id === 'bot'); entry.config = { ...entry.config, communication }
    writeFileSync(patch, stringify(entries))
    peer.configured = true
  }
  await topology.bench(peer, 'start', { DSBOT_COMMUNICATION_CONFIG: '', DSBOT_COMMUNICATION_CREDENTIAL: peer.credential })
  peer.client = await benchClient(peer.name, peer.web); peer.api = body => peer.client.request('/api/communication', body)
  await until(async () => { const state = await peer.api({ endpoint: 'state' }); return state.connected && state.reconciled }, 'configured legacy peer connects')
}
const epoch = async peer => (await topology.hub('stats')).instances.find(item => item.id === peer.instanceId).epoch
const reloaded = async (peer, before) => until(async () => {
  const state = await peer.api({ endpoint: 'state' })
  return state.connected && state.reconciled && state.error !== 'CREDENTIAL_UNAVAILABLE' && await epoch(peer) > before
}, 'public configuration edit reactivates and reconnects same legacy instance', 60000)
let owns = false
const deadline = setTimeout(() => { console.error('Test deadline'); void topology.close().finally(() => process.exit(1)) }, 12 * 60 * 1000)
try {
  for (const port of ports) await free(port)
  for (const peer of topology.peers) assert.equal(existsSync(join(repo, `.dsh-test-${peer.name}`)), false)
  owns = true; await topology.initialize()
  const [a, b] = topology.peers, group = await topology.group(`Reload ${nonce}`, [b.human])
  const initial = await topology.send(a, group, `Before reload ${nonce}`)
  await until(() => topology.hasText(b, group, initial.text), 'initial canonical message delivered')
  const human = a.human, version = (await a.api({ endpoint: 'members', conversationId: group })).membershipVersion
  for (const ids of [[], [a.botId]]) {
    const before = await epoch(a)
    await a.api({ endpoint: 'publish-bots', localBotIds: ids })
    await reloaded(a, before)
    assert.equal((await a.api({ endpoint: 'state' })).humanPrincipalId, human)
  }
  record('two-real-configEditor-reloads-reconnect-after-bootstrap-environment-consumed')
  assert.equal((await a.api({ endpoint: 'members', conversationId: group })).membershipVersion, version)
  const after = await topology.send(b, group, `After reload ${nonce}`)
  await until(() => topology.hasText(a, group, after.text), 'bidirectional messages work after reload')
  assert.ok(await topology.hasText(a, group, initial.text))
  record('same-Human-membership-and-canonical-history-survive-reload-with-bidirectional-messaging')
  const before = await epoch(a)
  await topology.bench(a, 'stop'); await topology.startPeer(a)
  assert.ok(await epoch(a) > before)
  assert.equal((await a.api({ endpoint: 'state' })).humanPrincipalId, human)
  assert.ok(await topology.hasText(a, group, initial.text)); assert.ok(await topology.hasText(a, group, after.text))
  record('new-process-requires-normal-launcher-bootstrap-and-retains-existing-identity-history')
  evidence.status = 'PASS'; save()
} catch (error) {
  evidence.status = 'FAIL'; evidence.error = error.message
  evidence.startupDiagnostics = topology.peers.map(peer => {
    const text = ['web.log', 'web.err'].map(name => { try { return readFileSync(join(repo, `.dsh-test-${peer.name}`, name), 'utf8') } catch { return '' } }).join('\n')
    return { peer: peer.id, codes: [...new Set(text.match(/\b(?:ERR_[A-Z0-9_]+|[A-Z_]+_UNAVAILABLE|INVALID_CONFIG|YAMLParseError|YAMLException)\b/g) ?? [])], duplicateEntry: /duplicate.*(?:id|key)|same.*id/i.test(text), yamlIssue: /YAML|[Yy]aml/.test(text), errors: text.split('\n').filter(line => /(?:Error:|TypeError|SyntaxError|ReferenceError|error |failed |Cannot )/.test(line)).slice(-5).map(line => line.replaceAll(peer.credential ?? 'never-a-real-credential', '[redacted]').replace(/https?:\/\/\S+/g, '[URL redacted]').replace(/[A-Za-z0-9_.+/=-]{24,}/g, '[redacted]').slice(0, 240)) }
  })
  console.error(error.message); console.log(JSON.stringify(evidence.startupDiagnostics)); process.exitCode = 1
}
finally {
  clearTimeout(deadline); if (owns) await topology.close()
  for (const port of ports) await free(port)
  for (const peer of topology.peers) { if (!peer.home) continue; const target = resolve(peer.home); assert.equal(dirname(target), repo); assert.equal(target, join(repo, `.dsh-test-${peer.name}`)); assert.ok(peer.name.startsWith(`hub-onboard-${nonce}-credential-reload`)); rmSync(target, { recursive: true, force: true }) }
  if (owner === undefined) delete process.env.DSBOT_COMMUNICATION_OWNER_PID; else process.env.DSBOT_COMMUNICATION_OWNER_PID = owner
  evidence.cleanedUp = true; evidence.temporaryProfilesDeleted = true; save()
}
