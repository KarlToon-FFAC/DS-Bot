import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink, link, readdir } from 'node:fs/promises'
import { tmpdir, hostname } from 'node:os'
import { join } from 'node:path'
import { zstdCompressSync } from 'node:zlib'
import { DatabaseSync } from 'node:sqlite'
import { parse } from 'yaml'
import { resetFederation, RESET_CONFIRMATION, federationResetStatus } from '../src/host/federation/reset.js'

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'dsbot-reset-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const home = join(root, 'bot'), sessions = join(root, 'sessions'), credentials = join(root, '.credentials.yaml'), profile = join(root, 'profile.yml')
  await mkdir(home); await mkdir(sessions)
  await writeFile(profile, '# local settings\n- id: bot\n  config:\n    theme: dark\n    communication:\n      enabled: true\n      url: wss://old.example/communication\n      credentialEnv: DSBOT_COMMUNICATION_TEST\n- id: model\n  config:\n    model: keep-me\n')
  await writeFile(credentials, 'version: 1\nrefs:\n  OPENAI_API_KEY: synthetic-retained-model-value\n  DSBOT_COMMUNICATION_TEST: synthetic-old-static-value\nrecords:\n  ds-bot/communication-0123456789abcdef0123456789abcdef:\n    kind: grant\n    payload: { type: dsbot-communication-signing-key, privateKey: synthetic-erased-key }\n  another/plugin:\n    kind: grant\n    payload: { value: preserve }\n')
  const state = { bots: { test: { sessionId: 'local-ordinary', name: 'Local Bot' } }, rooms: { ordinary: { sessions: { test: 'local-group' }, parts: [{ sessionId: 'local-past' }] } } }
  await writeFile(join(home, 'state.json'), JSON.stringify(state))
  const binding = 'binding-remote', cwd = join(home, 'communication-workspaces', binding)
  await mkdir(cwd, { recursive: true }); await writeFile(join(cwd, 'remote-output.txt'), 'remote only')
  const queues = [join(home, 'communication.sqlite'), join(home, 'communication-hubs', 'hub-' + 'a'.repeat(32), 'communication.sqlite'), join(home, 'communication-hubs', 'hub-' + 'b'.repeat(32) + '-' + 'c'.repeat(16), 'communication.sqlite')]
  for (const path of queues) {
    await mkdir(join(path, '..'), { recursive: true })
    const db = new DatabaseSync(path)
    db.exec('CREATE TABLE bindings (id TEXT,sessions TEXT); CREATE TABLE outbox (payload TEXT);')
    db.prepare('INSERT INTO bindings VALUES (?,?)').run(binding, '["remote-one"]')
    db.prepare('INSERT INTO outbox VALUES (?)').run('synthetic pending old message')
    db.close()
  }
  const journal = async (id, directory, preset, compressed = false) => {
    const path = join(sessions, '--project--', id); await mkdir(path, { recursive: true })
    const header = { type: 'session', id, version: 4, createdAt: 1, isSeeded: false, delegationDepth: 0, cwd: directory, ...(preset ? { agentPreset: preset } : {}) }
    const text = JSON.stringify(header) + '\n'
    await writeFile(join(path, 'session.v4.jsonl' + (compressed ? '.zstd' : '')), compressed ? zstdCompressSync(text) : text)
    return path
  }
  const remote = await journal('remote-one', cwd, 'ds-bot-communication', true)
  await writeFile(join(remote, 'session.v4.jsonl'), JSON.stringify({ type: 'session', id: 'remote-one', version: 4, cwd, createdAt: 1, isSeeded: false, delegationDepth: 0, agentPreset: 'ds-bot-communication' }) + '\n')
  const orphan = await journal('remote-orphan', cwd, 'ds-bot-communication')
  const ordinary = await journal('local-ordinary', join(root, 'work'), null)
  await journal('local-group', join(root, 'work'), null)
  return { root, home, sessions, credentials, profile, queues, remote, orphan, ordinary, journal,
    options: { home, profiles: [profile], credentials, sessions, attachmentsHome: root, confirm: RESET_CONFIRMATION } }
}

test('complete client reset erases every Hub scope/static pairing/journal generation but preserves ordinary state and credentials', async t => {
  const f = await fixture(t), before = await readFile(join(f.home, 'state.json'), 'utf8')
  const result = await resetFederation(f.options)
  assert.equal(result.erased, true); assert.equal(result.browserCleanupPending, true)
  const config = parse(await readFile(f.profile, 'utf8'))
  assert.equal(config[0].config.communication, undefined); assert.equal(config[0].config.theme, 'dark'); assert.equal(config[1].config.model, 'keep-me')
  const credentials = parse(await readFile(f.credentials, 'utf8'))
  assert.equal(credentials.refs.OPENAI_API_KEY, 'synthetic-retained-model-value'); assert.equal(credentials.refs.DSBOT_COMMUNICATION_TEST, undefined)
  assert.deepEqual(Object.keys(credentials.records), ['another/plugin'])
  assert.equal(await readFile(join(f.home, 'state.json'), 'utf8'), before)
  for (const path of [...f.queues, f.remote, f.orphan, join(f.home, 'communication-workspaces'), join(f.home, 'communication-hubs')]) await assert.rejects(readFile(path), { code: 'ENOENT' })
  assert.ok((await readdir(f.ordinary)).length)
  assert.equal((await federationResetStatus(f.home)).pending, false)
  assert.match((await federationResetStatus(f.home)).browserEpoch, /^[0-9a-f-]{36}$/)
  const again = await resetFederation(f.options); assert.equal(again.erased, true)
})

test('dry run does not erase, reconfigure or rotate browser epoch', async t => {
  const f = await fixture(t), credentials = await readFile(f.credentials, 'utf8')
  const result = await resetFederation({ ...f.options, confirm: undefined })
  assert.equal(result.dryRun, true); assert.equal(result.pairingRecords, 1)
  assert.equal(await readFile(f.credentials, 'utf8'), credentials)
  assert.ok((await readFile(f.profile, 'utf8')).includes('communication:'))
  assert.equal((await federationResetStatus(f.home)).browserEpoch, null)
})

for (const step of ['manifest', 'profiles', 'credentials', 'journals', 'attachments']) test(`interruption after ${step} remains blocked and can be fully retried without restoring old data`, async t => {
  const f = await fixture(t)
  await assert.rejects(resetFederation({ ...f.options, afterStep: value => { if (value === step) throw new Error('synthetic interruption') } }))
  assert.equal((await federationResetStatus(f.home)).pending, true)
  const manifest = await readFile(join(f.home, 'communication-reset.pending.json'), 'utf8')
  assert.ok(!manifest.includes('synthetic-erased-key')); assert.ok(!manifest.includes('synthetic-old-static-value'))
  assert.equal((await resetFederation(f.options)).erased, true)
  assert.equal(parse(await readFile(f.credentials, 'utf8')).refs.DSBOT_COMMUNICATION_TEST, undefined)
})

test('active local or unknown remote Host lock is rejected before erasing', async t => {
  const f = await fixture(t)
  for (const holder of [{ pid: process.pid, host: hostname() }, { pid: 1, host: 'unverified-other-computer' }]) {
    await writeFile(join(f.home, 'state.lock'), JSON.stringify(holder))
    await assert.rejects(resetFederation(f.options), { code: 'RESET_HOST_MUST_STOP' })
  }
  assert.ok((await readFile(f.credentials, 'utf8')).includes('synthetic-erased-key'))
})

test('symlink/hardlink and local Session ownership conflicts fail before any erase', async t => {
  const f = await fixture(t), target = join(f.home, 'communication-workspaces', 'outside-link')
  await symlink(f.ordinary, target)
  await assert.rejects(resetFederation(f.options), { code: 'RESET_UNSAFE_PATH' }); await rm(target)
  const alias = join(f.root, 'credential-alias'); await link(f.credentials, alias)
  await assert.rejects(resetFederation(f.options), { code: 'RESET_UNSAFE_PATH' }); await rm(alias)
  await f.journal('local-ordinary', join(f.home, 'communication-workspaces', 'binding-remote'), 'ds-bot-communication')
  await assert.rejects(resetFederation(f.options), { code: 'RESET_LOCAL_SESSION_CONFLICT' })
  assert.ok((await readFile(f.credentials, 'utf8')).includes('synthetic-erased-key'))
})

test('custom queue path and unknown Hub scope cannot silently leave residue', async t => {
  const f = await fixture(t), original = await readFile(f.profile, 'utf8')
  await writeFile(f.profile, original.replace('enabled: true', 'dataPath: /unverified/external.sqlite\n      enabled: true'))
  await assert.rejects(resetFederation(f.options), { code: 'RESET_CUSTOM_QUEUE_PATH_UNSUPPORTED' }); await writeFile(f.profile, original)
  await mkdir(join(f.home, 'communication-hubs', 'unknown-scope'))
  await assert.rejects(resetFederation(f.options), { code: 'RESET_UNKNOWN_HUB_SCOPE' })
})

test('ordinary unbound Session inside a communication workspace is not inferred to be disposable', async t => {
  const f = await fixture(t)
  await f.journal('ordinary-opened-in-workspace', join(f.home, 'communication-workspaces', 'binding-remote'), null)
  await assert.rejects(resetFederation(f.options), { code: 'RESET_SESSION_OWNERSHIP_UNPROVEN' })
  assert.ok((await readFile(f.credentials, 'utf8')).includes('synthetic-erased-key'))
})

test('ordinary group sessions map and historical parts are protected even inside a remote directory', async t => {
  for (const id of ['local-group', 'local-past']) {
    const f = await fixture(t)
    await f.journal(id, join(f.home, 'communication-workspaces', 'binding-remote'), 'ds-bot-communication')
    await assert.rejects(resetFederation(f.options), { code: 'RESET_LOCAL_SESSION_CONFLICT' })
  }
})

test('plain offline CLI resolves only public SDK exports and reports dry-run and confirmed erasure', async t => {
  const { spawnSync } = await import('node:child_process')
  const f = await fixture(t)
  const args = [new URL('../bin/dsbot-reset.mjs', import.meta.url).pathname, '--home', f.home, '--profile', f.profile,
    '--credentials', f.credentials, '--sessions', f.sessions, '--attachments-home', f.root]
  const dry = spawnSync(process.execPath, args, { encoding: 'utf8', env: process.env })
  assert.equal(dry.status, 0, dry.stderr); assert.equal(JSON.parse(dry.stdout).dryRun, true)
  const erased = spawnSync(process.execPath, [...args, '--confirm', RESET_CONFIRMATION], { encoding: 'utf8', env: process.env })
  assert.equal(erased.status, 0, erased.stderr); assert.equal(JSON.parse(erased.stdout).erased, true)
  assert.equal(JSON.parse(erased.stdout).browserCleanupPending, true)
  assert.ok(!erased.stdout.includes('synthetic-erased-key'))
})

test('resetting old static configuration and Hub enables fresh code enrollment, approval and new isolated queue', async t => {
  const { HubStore } = await import('../../communication-hub/src/store.js')
  const { HubManagement } = await import('../../communication-hub/src/management-store.js')
  const { startHub } = await import('../../communication-hub/src/server.js')
  const { resetHub, RESET_CONFIRMATION: HUB_CONFIRMATION } = await import('../../communication-hub/src/reset.js')
  const { CommunicationOnboarding, openEnrollmentSocket, communicationAuthentication, communicationQueueSettings } = await import('../src/host/federation/onboarding.js')
  const { CommunicationQueue } = await import('../src/host/federation/queue-store.js')
  const f = await fixture(t), databasePath = join(f.root, 'hub.sqlite'), configPath = join(f.root, 'hub.json')
  await writeFile(configPath, JSON.stringify({ databasePath, peers: [{ instanceId: 'old-static-client', credentialEnv: 'OLD_STATIC_TEST' }], management: { enabled: true } }))
  const oldStore = new HubStore(databasePath), oldManagement = new HubManagement(oldStore), oldHubId = oldManagement.hubId
  oldStore.configurePeer('old-static-client', 'Old synthetic client'); oldStore.close()
  resetHub({ configPath, confirmation: HUB_CONFIRMATION })
  await resetFederation(f.options)
  const hub = await startHub({ databasePath, host: '127.0.0.1', port: 0, peers: [], management: { enabled: true, password: 'synthetic-test-password-123' } })
  t.after(() => hub.close())
  assert.notEqual(hub.management.hubId, oldHubId)
  assert.equal(hub.store.db.prepare('SELECT count(*) n FROM instances').get().n, 0)
  const config = parse(await readFile(f.profile, 'utf8'))[0].config, records = new Map(Object.entries(parse(await readFile(f.credentials, 'utf8')).records))
  const rt = { home: f.home, config, ctx: { credentials: {
    readRecord: async key => structuredClone(records.get(key)),
    listRecords: async () => [...records].map(([key, record]) => ({ key, kind: record.kind })),
    describeRecord: async key => ({ configured: records.has(key), writable: true }),
    modifyRecord: async (key, update) => { const next = await update(structuredClone(records.get(key))); if (next !== undefined) records.set(key, next) },
  }, configEditor: { entries: () => [{ options: { name: 'ds-bot', id: 'bot' } }], edit: async (_entry, update) => { rt.config = update(structuredClone(rt.config)) } } } }
  const onboarding = new CommunicationOnboarding(rt, { allowLoopback: true })
  const fresh = { hubId: hub.management.hubId, url: hub.url }, hubCode = 'dsbot-hub:1:' + Buffer.from(JSON.stringify(fresh)).toString('base64url')
  const joined = await onboarding.handle('join', { hubCode, confirmedHubId: fresh.hubId, confirmedUrl: fresh.url, displayName: 'Fresh synthetic client' }, { human: true })
  assert.equal(joined.status, 'pending')
  hub.management.decide({ requestId: joined.requestId, action: 'approve', expectedVersion: 1 })
  const approved = await onboarding.handle('status', { hubId: fresh.hubId }, { human: true })
  assert.equal(approved.status, 'approved'); assert.equal(rt.config.communication.hubId, fresh.hubId)
  assert.equal(rt.config.communication.credentialEnv, undefined)
  const socket = await openEnrollmentSocket(fresh.url, { allowLoopback: true })
  try {
    const auth = communicationAuthentication(rt, rt.config.communication.credentialKey, rt.config.communication)
    const welcome = await auth((type, payload) => socket.request(type, payload), (await import('../src/host/federation/transport.js')).communicationCapabilities())
    assert.equal(welcome.instanceId, approved.instanceId)
  } finally { socket.close() }
  const settings = await communicationQueueSettings(rt, rt.config.communication.credentialKey, rt.config.communication)
  const queue = new CommunicationQueue(settings.dataPath, { instanceId: approved.instanceId })
  try { assert.equal(queue.db.prepare('SELECT count(*) n FROM outbox').get().n, 0); assert.equal(queue.bindings().length, 0) } finally { queue.close() }
  assert.equal(hub.store.db.prepare('SELECT count(*) n FROM conversations').get().n, 0)
  assert.equal(hub.store.db.prepare('SELECT count(*) n FROM messages').get().n, 0)
})

test('a reset interrupted after journal erasure still deletes proven exclusive attachment objects and aliases on retry', async t => {
  const { createHash } = await import('node:crypto')
  const f = await fixture(t), bytes = Buffer.from('synthetic exclusive remote attachment'), digest = createHash('sha256').update(bytes).digest('hex')
  const object = join(f.root, 'attachments', 'v1', 'file-objects', digest.slice(0, 2), digest)
  const alias = join(f.root, 'attachments', 'v1', 'files', digest.slice(0, 2), digest, 'remote.txt')
  await mkdir(join(object, '..'), { recursive: true }); await writeFile(object, bytes)
  await mkdir(join(alias, '..'), { recursive: true }); await link(object, alias)
  const header = { type: 'session', id: 'remote-one', version: 4, createdAt: 1, isSeeded: false, delegationDepth: 0,
    cwd: join(f.home, 'communication-workspaces', 'binding-remote'), agentPreset: 'ds-bot-communication' }
  const event = { type: 'user/message', seq: 0, time: 1, data: { role: 'user', id: 'synthetic-message', content: [{ type: 'file', attachment: { attachmentId: 'sha256:' + digest, bytes: bytes.length, name: 'remote.txt' } }] } }
  await writeFile(join(f.remote, 'session.v4.jsonl.zstd'), zstdCompressSync([header, event].map(row => JSON.stringify(row)).join('\n') + '\n'))
  await assert.rejects(resetFederation({ ...f.options, afterStep: step => { if (step === 'journals') throw new Error('synthetic power loss') } }))
  assert.equal(await readFile(object, 'utf8'), bytes.toString())
  assert.equal((await federationResetStatus(f.home)).pending, true)
  const result = await resetFederation(f.options)
  assert.equal(result.erased, true); assert.equal(result.exclusiveAttachmentObjects, 1)
  await assert.rejects(readFile(object), { code: 'ENOENT' }); await assert.rejects(readFile(alias), { code: 'ENOENT' })
})
