import { caFixture } from './fixtures/hub-ca-fixture.mjs'
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink, link, readdir } from 'node:fs/promises'
import { tmpdir, hostname } from 'node:os'
import { join } from 'node:path'
import { zstdCompressSync } from 'node:zlib'
import { DatabaseSync } from 'node:sqlite'
import { fileURLToPath } from 'node:url'
import fsPromises from 'node:fs/promises'
import { syncBuiltinESMExports } from 'node:module'
import { parse } from 'yaml'
import { resetFederation, RESET_CONFIRMATION, federationResetStatus } from '../src/host/federation/reset.js'

test('canonical path spelling changes do not prevent safe dry-run and erasure', async t => {
  const f = await fixture(t), nativeRealpath = fsPromises.realpath
  t.mock.method(fsPromises, 'realpath', async (...args) => {
    const value = await nativeRealpath(...args)
    return typeof value === 'string' && value.startsWith(f.root) ? value.toUpperCase() : value
  })
  syncBuiltinESMExports()
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports() })
  assert.notEqual(await fsPromises.realpath(f.home), f.home)
  const before = await snapshot(f.root)
  const dry = await resetFederation({ ...f.options, confirm: undefined })
  assert.equal(dry.dryRun, true)
  assert.deepEqual(await snapshot(f.root), before)
  assert.equal((await resetFederation(f.options)).erased, true)
  assert.equal((await resetFederation({ ...f.options, confirm: undefined })).queueFiles, 0)
})

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
    db.exec('CREATE TABLE bindings (id TEXT,sessions TEXT); CREATE TABLE outbox (id TEXT,type TEXT,payload TEXT,hash TEXT); CREATE TABLE metadata (key TEXT,value TEXT); CREATE TABLE inbox (delivery_id TEXT,message_id TEXT,conversation_id TEXT,principal_id TEXT);')
    db.prepare('INSERT INTO bindings VALUES (?,?)').run(binding, '["remote-one"]')
    db.prepare('INSERT INTO outbox(payload) VALUES (?)').run('synthetic pending old message')
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
    options: { home, profiles: [profile], credentials, sessions, attachmentsHome: root, storageRoot: join(root, 'storages'), confirm: RESET_CONFIRMATION } }
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

for (const step of ['manifest', 'profiles', 'credentials', 'derived', 'journals', 'attachments']) test(`interruption after ${step} remains blocked and can be fully retried without restoring old data`, async t => {
  const f = await fixture(t)
  await assert.rejects(resetFederation({ ...f.options, afterStep: value => { if (value === step) throw new Error('synthetic interruption') } }), /synthetic interruption/)
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
  await symlink(f.ordinary, target, process.platform === 'win32' ? 'junction' : 'dir')
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
  const args = [fileURLToPath(new URL('../bin/dsbot-reset.mjs', import.meta.url)), '--home', f.home, '--profile', f.profile,
    '--credentials', f.credentials, '--sessions', f.sessions, '--attachments-home', f.root, '--storage-root', f.options.storageRoot]
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
  const { CommunicationOnboarding, openEnrollmentSocket, communicationAuthentication, communicationQueueSettings, decodeHubCode } = await import('../src/host/federation/onboarding.js')
  const { CommunicationQueue } = await import('../src/host/federation/queue-store.js')
  const f = await fixture(t), databasePath = join(f.root, 'hub.sqlite'), configPath = join(f.root, 'hub.json')
  await writeFile(configPath, JSON.stringify({ databasePath, peers: [{ instanceId: 'old-static-client', credentialEnv: 'OLD_STATIC_TEST' }], management: { enabled: true } }))
  const oldStore = new HubStore(databasePath), oldManagement = new HubManagement(oldStore), oldHubId = oldManagement.hubId
  oldStore.configurePeer('old-static-client', 'Old synthetic client'); oldStore.close()
  resetHub({ configPath, confirmation: HUB_CONFIRMATION })
  await resetFederation(f.options)
  const certificates = caFixture(); t.after(() => certificates.close())
  const rootCA = certificates.ca('reset-root'), leaf = certificates.leaf('reset-leaf', rootCA)
  const hub = await startHub({ databasePath, host: '127.0.0.1', port: 0, peers: [], tls: {cert:leaf.cert,key:leaf.key}, management: { enabled: true, pairingCa:rootCA.pem, password: 'synthetic-test-password-123' } })
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
  const fresh = { hubId: hub.management.hubId, url: hub.url }, hubCode = hub.management.info().code, reviewed = decodeHubCode(hubCode, {allowLoopback:true})
  const joined = await onboarding.handle('join', { hubCode, confirmedTrustFingerprint: reviewed.trustFingerprint, confirmedHubId: fresh.hubId, confirmedUrl: fresh.url, displayName: 'Fresh synthetic client' }, { human: true })
  assert.equal(joined.status, 'pending')
  hub.management.decide({ requestId: joined.requestId, action: 'approve', expectedVersion: 1 })
  const approved = await onboarding.handle('status', { hubId: fresh.hubId }, { human: true })
  assert.equal(approved.status, 'approved'); assert.equal(rt.config.communication.hubId, fresh.hubId)
  assert.equal(rt.config.communication.credentialEnv, undefined)
  const socket = await openEnrollmentSocket(fresh.url, { allowLoopback: true, trust: reviewed.trust, hubId: fresh.hubId })
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
  await assert.rejects(resetFederation({ ...f.options, afterStep: step => { if (step === 'journals') throw new Error('synthetic power loss') } }), /synthetic power loss/)
  assert.equal(await readFile(object, 'utf8'), bytes.toString())
  assert.equal((await federationResetStatus(f.home)).pending, true)
  const result = await resetFederation(f.options)
  assert.equal(result.erased, true); assert.equal(result.exclusiveAttachmentObjects, 1)
  await assert.rejects(readFile(object), { code: 'ENOENT' }); await assert.rejects(readFile(alias), { code: 'ENOENT' })
})

test('a foreign SQLite database at a communication path is not erased', async t => {
  const f = await fixture(t)
  await rm(f.queues[0]); const db = new DatabaseSync(f.queues[0]); db.exec('CREATE TABLE ordinary (value TEXT); INSERT INTO ordinary VALUES (\'preserve\')'); db.close()
  const before = await readFile(f.queues[0]), config = await readFile(f.profile, 'utf8')
  await assert.rejects(resetFederation(f.options), { code: 'RESET_NOT_A_COMMUNICATION_DATABASE', target: f.queues[0] })
  assert.deepEqual(await readFile(f.queues[0]), before); assert.equal(await readFile(f.profile, 'utf8'), config)
})

// Orphan sidecars have no schema evidence unless a durable interrupted-reset plan owns them.
test('unproven queue sidecars without a main database are not silently removed', async t => {
  const f = await fixture(t)
  await rm(f.queues[0]); await writeFile(f.queues[0] + '-wal', 'foreign-or-unproven')
  const before = await readFile(f.profile)
  await assert.rejects(resetFederation(f.options), { code: 'RESET_QUEUE_OWNERSHIP_UNPROVEN', target: f.queues[0] })
  assert.equal(await readFile(f.queues[0] + '-wal', 'utf8'), 'foreign-or-unproven')
  assert.deepEqual(await readFile(f.profile), before)
})


test('protected ordinary Sessions and configuration inputs cannot overlap whole-tree erase targets', async t => {
  const f = await fixture(t), before = await readFile(f.profile), credentialBefore = await readFile(f.credentials)
  const nested = join(f.home, 'communication-workspaces', 'ordinary-sessions')
  await mkdir(join(nested, 'project', 'ordinary'), { recursive: true })
  const ordinary = join(nested, 'project', 'ordinary', 'session.v4.jsonl')
  const bytes = JSON.stringify({ type: 'session', version: 4, id: 'ordinary', cwd: f.root, createdAt: 1, isSeeded: false, delegationDepth: 0 }) + '\n'
  await writeFile(ordinary, bytes)
  for (const options of [
    { ...f.options, sessions: nested },
    { ...f.options, attachmentsHome: join(f.home, 'communication-workspaces') },
    { ...f.options, profiles: [join(f.home, 'communication-workspaces', 'profile.yml')] },
    { ...f.options, credentials: f.profile },
    { ...f.options, sessions: f.root },
  ]) await assert.rejects(resetFederation(options), { code: 'RESET_PROTECTED_PATH_OVERLAP' })
  assert.equal(await readFile(ordinary, 'utf8'), bytes)
  assert.deepEqual(await readFile(f.profile), before); assert.deepEqual(await readFile(f.credentials), credentialBefore)
  assert.ok(!(await readdir(f.home)).includes('communication-reset.pending.json'))
})

test('pending reset refuses a remote Session directory replaced by an ordinary journal', async t => {
  const f = await fixture(t)
  await assert.rejects(resetFederation({ ...f.options, afterStep: step => { if (step === 'manifest') throw new Error('synthetic interruption') } }), /synthetic interruption/)
  const text = JSON.stringify({ type: 'session', version: 4, id: 'new-ordinary', cwd: f.root, createdAt: 1, isSeeded: false, delegationDepth: 0 }) + '\n'
  await rm(f.remote, { recursive: true }); await mkdir(f.remote)
  await writeFile(join(f.remote, 'session.v4.jsonl'), text)
  await assert.rejects(resetFederation(f.options), { code: 'RESET_SESSION_CHANGED_OWNERSHIP', target: f.remote })
  assert.equal(await readFile(join(f.remote, 'session.v4.jsonl'), 'utf8'), text)
  assert.equal((await federationResetStatus(f.home)).pending, true)
})


test('legacy Bot/group fallback IDs and archived ordinary segments are protected', async t => {
  for (const state of [
    { bots: { 'remote-one': { name: 'legacy Bot' } } },
    { rooms: { 'remote-one': { id: 'remote-one' } } },
    { privateArchives: [{ id: 'remote-one', segments: [{ sessionId: 'remote-old' }] }] },
    { rooms: { ordinary: { id: 'ordinary', segments: { bot: [{ sessionId: 'remote-one' }] } } } },
  ]) {
    const f = await fixture(t), path = join(f.home, 'state.json')
    const text = JSON.stringify(state); await writeFile(path, text)
    await assert.rejects(resetFederation(f.options), { code: 'RESET_LOCAL_SESSION_CONFLICT' })
    assert.equal(await readFile(path, 'utf8'), text)
    assert.ok((await readFile(f.credentials, 'utf8')).includes('synthetic-erased-key'))
  }
})

test('pending reset refuses a new remote-looking identity at a prior Session directory', async t => {
  const f = await fixture(t)
  await assert.rejects(resetFederation({ ...f.options, afterStep: step => { if (step === 'manifest') throw new Error('synthetic interruption') } }), /synthetic interruption/)
  await rm(f.remote, { recursive: true }); await mkdir(f.remote)
  const text = JSON.stringify({ type: 'session', version: 4, id: 'another-remote', cwd: join(f.home, 'communication-workspaces', 'binding-remote'), agentPreset: 'ds-bot-communication', createdAt: 1, isSeeded: false, delegationDepth: 0 }) + '\n'
  await writeFile(join(f.remote, 'session.v4.jsonl'), text)
  await assert.rejects(resetFederation(f.options), { code: 'RESET_SESSION_CHANGED_OWNERSHIP', target: f.remote })
  assert.equal(await readFile(join(f.remote, 'session.v4.jsonl'), 'utf8'), text)
})

test('complete CLI removes actual public JSON projection/workspace residue and preserves ordinary records', async t => {
  const { spawnSync } = await import('node:child_process')
  const { workspaceDomainSpec } = await import('@deepseek-ai/dsh-workspace')
  const { projectionCacheDomainSpec } = await import('@deepseek-ai/dsh-session-projection-cache')
  const f = await fixture(t), root = f.options.storageRoot, cache = join(root, 'session_projcache', 'sessions')
  await mkdir(cache, { recursive: true })
  const cwd = join(f.home, 'communication-workspaces', 'binding-remote')
  const record = (path, ids) => ({ path, title: path, sessionIds: ids, createdAt: '2026-11-05T00:00:00.000Z', updatedAt: '2026-11-05T00:00:00.000Z' })
  const workspacePath = join(root, 'workspace.json')
  await writeFile(workspacePath, JSON.stringify({ unit: { name: 'workspace', version: workspaceDomainSpec.version }, global: { initialized: true, workspaceIds: ['ordinary-workspace', 'remote-workspace'], archivedSessionIds: ['remote-one'], pinnedSessionIds: ['local-ordinary'] }, tables: { workspaces: { 'ordinary-workspace': record(f.root, ['local-ordinary', 'remote-one']), 'remote-workspace': record(cwd, ['remote-one']) } } }))
  const checkpoint = cwd => JSON.stringify({ version: projectionCacheDomainSpec.version, record: { identity: { createdAt: 1, cwd, formatVersion: 4, isSeeded: false, inheritedEventCount: 0 }, rows: { title: { ver: 1, seq: -1, val: { text: cwd } } } } })
  const ordinary = checkpoint(f.root)
  await writeFile(join(cache, 'remote-one.json'), checkpoint(cwd)); await writeFile(join(cache, 'local-ordinary.json'), ordinary)
  const args = [fileURLToPath(new URL('../bin/dsbot-reset.mjs', import.meta.url)), '--home', f.home, '--profile', f.profile, '--credentials', f.credentials, '--sessions', f.sessions, '--attachments-home', f.root, '--storage-root', root]
  const before = await readFile(workspacePath)
  const dry = spawnSync(process.execPath, args, { encoding: 'utf8', env: process.env })
  assert.equal(dry.status, 0, dry.stderr); assert.equal(JSON.parse(dry.stdout).projectionRecords, 1)
  assert.deepEqual(await readFile(workspacePath), before)
  const erased = spawnSync(process.execPath, [...args, '--confirm', RESET_CONFIRMATION], { encoding: 'utf8', env: process.env })
  assert.equal(erased.status, 0, erased.stderr)
  await assert.rejects(readFile(join(cache, 'remote-one.json')), { code: 'ENOENT' })
  assert.equal(await readFile(join(cache, 'local-ordinary.json'), 'utf8'), ordinary)
  const after = JSON.parse(await readFile(workspacePath, 'utf8'))
  assert.deepEqual(after.global.workspaceIds, ['ordinary-workspace']); assert.deepEqual(after.global.archivedSessionIds, [])
  assert.deepEqual(after.global.pinnedSessionIds, ['local-ordinary'])
  assert.deepEqual(after.tables.workspaces['ordinary-workspace'].sessionIds, ['local-ordinary'])
  assert.equal(after.tables.workspaces['remote-workspace'], undefined)
})

test('persistent search, custom derived routes and unresolved includes fail before any client mutation', async t => {
  const f = await fixture(t), original = await readFile(f.profile, 'utf8'), credentials = await readFile(f.credentials)
  for (const [suffix, code] of [
    ['- id: session-query-sqlite\n  config:\n    path: /explicit/persistent-search.sqlite\n    openAt: never\n', 'RESET_DERIVED_QUERY_INDEX_UNSUPPORTED'],
    ['- id: storage-json\n  config:\n    root: /unverified/other-store\n', 'RESET_DERIVED_PROVIDER_UNSUPPORTED'],
    ['- id: storage-domain\n  config:\n    backend: sqlite\n', 'RESET_DERIVED_PROVIDER_UNSUPPORTED'],
    ['- name: cordis:include\n  config:\n    path: /unverified/more.yml\n', 'RESET_PROFILE_INCLUDE_UNSUPPORTED'],
  ]) {
    const text = original + suffix; await writeFile(f.profile, text)
    await assert.rejects(resetFederation(f.options), { code, target: f.profile })
    assert.equal(await readFile(f.profile, 'utf8'), text); assert.deepEqual(await readFile(f.credentials), credentials)
    assert.equal((await federationResetStatus(f.home)).pending, false)
  }
})

test('a crash after fsync before manifest rename leaves no recovery temp after a confirmed rerun', async t => {
  const f = await fixture(t)
  let temporary
  await assert.rejects(resetFederation({ ...f.options, afterAtomicTemp: ({ path, temporaryPath }) => {
    if (path.endsWith('communication-reset.pending.json')) { temporary = temporaryPath; throw new Error('synthetic pre-rename power loss') }
  } }), /synthetic pre-rename power loss/)
  assert.ok(temporary)
  assert.equal((await federationResetStatus(f.home)).pending, false)
  const before = await readFile(temporary)
  assert.ok(!before.toString().includes('synthetic-erased-key'))
  const dry = await resetFederation({ ...f.options, confirm: undefined })
  assert.equal(dry.temporaryFiles, 1); assert.deepEqual(await readFile(temporary), before)
  const result = await resetFederation(f.options)
  assert.equal(result.erased, true)
  await assert.rejects(readFile(temporary), { code: 'ENOENT' })
  assert.ok(!(await readdir(f.home)).some(name => name.startsWith('communication-reset.pending.json.reset-')))
})

test('old cleaned profile, credential and epoch temps are precisely removed, but unknown contents block with no erasure', async t => {
  const f = await fixture(t)
  await assert.rejects(resetFederation({ ...f.options, afterStep: step => { if (step === 'credentials') throw new Error('synthetic interrupted reset') } }), /synthetic interrupted reset/)
  const suffix = '.reset-00000000-0000-4000-8000-000000000001'
  const paths = [f.profile + suffix, f.credentials + suffix, join(f.home, 'communication-browser-epoch') + suffix]
  await writeFile(paths[0], await readFile(f.profile)); await writeFile(paths[1], await readFile(f.credentials)); await writeFile(paths[2], '00000000-0000-4000-8000-000000000002')
  const result = await resetFederation(f.options)
  assert.equal(result.temporaryFiles, 3)
  for (const path of paths) await assert.rejects(readFile(path), { code: 'ENOENT' })
  const g = await fixture(t), unknown = join(g.home, 'communication-reset.pending.json') + suffix
  await writeFile(unknown, 'unproven foreign contents')
  const profile = await readFile(g.profile)
  await assert.rejects(resetFederation(g.options), { code: 'RESET_TEMP_OWNERSHIP_UNPROVEN', target: unknown })
  assert.equal(await readFile(unknown, 'utf8'), 'unproven foreign contents'); assert.deepEqual(await readFile(g.profile), profile)
  assert.equal((await federationResetStatus(g.home)).pending, false)
})

async function snapshot(root) {
  const files = []
  const visit = async path => {
    for (const entry of await readdir(path, { withFileTypes: true })) {
      const child = join(path, entry.name)
      files.push([child, entry.isDirectory() ? 'directory' : (await readFile(child)).toString('base64')])
      if (entry.isDirectory()) await visit(child)
    }
  }
  await visit(root)
  return files.sort(([left], [right]) => left.localeCompare(right))
}

test('reset-shaped explicit profiles are protected inputs, never disposable temporary files', async t => {
  for (const credentialTarget of [false, true]) {
    const f = await fixture(t), alias = (credentialTarget ? f.credentials : f.profile) + '.reset-00000000-0000-4000-8000-000000000001'
    const text = '- id: model\n  config:\n    model: keep-me\n'
    await writeFile(f.profile, text); await writeFile(alias, text)
    const before = await snapshot(f.root)
    for (const confirm of [undefined, RESET_CONFIRMATION]) {
      await assert.rejects(resetFederation({ ...f.options, profiles: [f.profile, alias], confirm }), { code: 'RESET_PROTECTED_PATH_OVERLAP', target: alias })
      assert.deepEqual(await snapshot(f.root), before)
    }
  }
})

test('unmaterialized credentials in a missing parent have no temporary files and need no invented directory', async t => {
  const f = await fixture(t), credentials = join(f.root, 'never-materialized', 'nested', '.credentials.yaml')
  await rm(f.credentials)
  const options = { ...f.options, credentials }, before = await snapshot(f.root)
  const dry = await resetFederation({ ...options, confirm: undefined })
  assert.equal(dry.temporaryFiles, 0); assert.deepEqual(await snapshot(f.root), before)
  assert.equal((await resetFederation(options)).erased, true)
  await assert.rejects(readdir(join(f.root, 'never-materialized')), { code: 'ENOENT' })
})

test('a missing credential parent does not bypass an unsafe existing ancestor', async t => {
  const f = await fixture(t), alias = join(f.root, 'linked-home')
  await symlink(f.home, alias, process.platform === 'win32' ? 'junction' : 'dir')
  await assert.rejects(resetFederation({ ...f.options, credentials: join(alias, 'absent', '.credentials.yaml') }), { code: 'RESET_UNSAFE_PATH' })
  assert.equal((await federationResetStatus(f.home)).pending, false)
})

test('explicit credential and attachment providers must match the offline targets before any mutation', async t => {
  const f = await fixture(t), original = await readFile(f.profile, 'utf8')
  const attachment = 'RESET_ATTACHMENT_PROVIDER_UNSUPPORTED', credential = 'RESET_CREDENTIAL_PROVIDER_UNSUPPORTED'
  for (const [suffix, code] of [
    ['- id: attachment-local\n  config:\n    dshHome: /actual/other-attachments\n', attachment],
    ['- name: \'@deepseek-ai/dsh-attachment-local\'\n  config:\n    dshHome: !expr process.env.DSH_HOME\n', attachment],
    ['- id: attachment-local\n  name: custom-attachment-provider\n', attachment],
    ['- name: \'@deepseek-ai/dsh-attachment-remote\'\n', attachment],
    ['- id: credentials\n  config:\n    path: /actual/other-credentials.yaml\n', credential],
    ['- name: \'@deepseek-ai/dsh-credentials-local\'\n  config:\n    dshHome: /actual/other-home\n', credential],
    ['- id: credentials\n  config:\n    path: !expr process.env.CREDENTIAL_PATH\n', credential],
    ['- id: credentials\n  config:\n    dshHome: relative-home\n', credential],
    ['- id: credentials\n  name: custom-credential-provider\n', credential],
    ['- name: \'@deepseek-ai/dsh-credentials-remote\'\n', credential],
  ]) {
    await writeFile(f.profile, original + suffix)
    const before = await snapshot(f.root)
    for (const confirm of [undefined, RESET_CONFIRMATION]) {
      await assert.rejects(resetFederation({ ...f.options, confirm }), { code, target: f.profile })
      assert.deepEqual(await snapshot(f.root), before)
    }
  }
})

test('matching explicit attachment and credential paths support the documented path-over-home precedence', async t => {
  for (const ignoredHome of ['/unused/explicit-home', 'relative-home', '!expr process.env.IGNORED_TEST_HOME']) {
    const f = await fixture(t)
    await writeFile(f.profile, await readFile(f.profile, 'utf8') + `- id: attachment-local\n  name: '@deepseek-ai/dsh-attachment-local'\n  config:\n    dshHome: ${JSON.stringify(f.root)}\n- id: credentials\n  config:\n    dshHome: ${ignoredHome}\n    path: ${JSON.stringify(f.credentials)}\n`)
    const before = await snapshot(f.root)
    assert.equal((await resetFederation({ ...f.options, confirm: undefined })).dryRun, true)
    assert.deepEqual(await snapshot(f.root), before)
    assert.equal((await resetFederation(f.options)).erased, true)
  }
  const g = await fixture(t)
  await writeFile(g.profile, await readFile(g.profile, 'utf8') + `- id: credentials\n  config:\n    dshHome: ${JSON.stringify(g.root)}\n`)
  assert.equal((await resetFederation(g.options)).erased, true)
})

test('empty decoy CLI targets cannot leave explicitly configured real attachment or credential stores behind', async t => {
  const f = await fixture(t), original = await readFile(f.profile, 'utf8'), decoy = join(f.root, 'empty-decoy')
  await mkdir(decoy)
  await writeFile(f.profile, original + `- id: attachment-local\n  config:\n    dshHome: ${JSON.stringify(f.root)}\n- id: credentials\n  config:\n    path: ${JSON.stringify(f.credentials)}\n`)
  const before = await snapshot(f.root)
  for (const [overrides, code] of [[{ attachmentsHome: decoy }, 'RESET_ATTACHMENT_PROVIDER_UNSUPPORTED'], [{ credentials: join(decoy, '.credentials.yaml') }, 'RESET_CREDENTIAL_PROVIDER_UNSUPPORTED']]) {
    for (const confirm of [undefined, RESET_CONFIRMATION]) {
      await assert.rejects(resetFederation({ ...f.options, ...overrides, confirm }), { code, target: f.profile })
      assert.deepEqual(await snapshot(f.root), before)
    }
  }
})
