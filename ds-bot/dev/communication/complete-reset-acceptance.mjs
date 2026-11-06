import WebSocket from 'ws'
import { caFixture } from '../../test/fixtures/hub-ca-fixture.mjs'
import { trustedHubFetch } from './trusted-hub-fetch.mjs'
// Real owned DSH profiles, public Human APIs, offline reset CLIs and deterministic Mock.
// Run serially: node ds-bot/dev/communication/complete-reset-acceptance.mjs [--keep-profiles]
import assert from 'node:assert/strict'
import { randomBytes, randomUUID, createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { createServer } from 'node:net'
import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync, lstatSync, rmSync } from 'node:fs'
import { basename, dirname, join, resolve, relative } from 'node:path'
import { zstdDecompressSync } from 'node:zlib'
import { DatabaseSync } from 'node:sqlite'
import { parse } from 'yaml'
import { LocalTopology, until } from './local-topology.mjs'
import { benchClient, repo } from './bench-client.mjs'
import { communicationCapabilities } from '../../src/host/federation/transport.js'

if (process.argv.includes('--help')) {
  console.log('Usage: node ds-bot/dev/communication/complete-reset-acceptance.mjs [--web-port 3235] [--mock-port 8935] [--hub-port 3239] [--keep-profiles]\nRun only in the reserved serial integration window. Creates fresh .dsh-test-hub-onboard-* profiles; never uses ~/.dsh. Evidence contains paths, counts and statuses only. Failed profiles are retained for diagnosis. Browser UI is not observed.')
  process.exit(0)
}
const options = { web: 3235, mock: 8935, hub: 3239, keep: false }
for (let i = 2; i < process.argv.length; i++) {
  const flag = process.argv[i]
  if (flag === '--keep-profiles') options.keep = true
  else {
    const key = { '--web-port': 'web', '--mock-port': 'mock', '--hub-port': 'hub' }[flag]
    assert.ok(key, 'Unknown acceptance argument')
    const value = Number(process.argv[++i]); assert.ok(Number.isInteger(value) && value >= 1024 && value < 65535)
    options[key] = value
  }
}
const ports = [options.web, options.web + 1, options.mock, options.mock + 1, options.hub]
assert.equal(new Set(ports).size, ports.length); assert.ok(!ports.includes(3080))
const nonce = randomUUID().slice(0, 8)
const topology = new LocalTopology({ prefix: `hub-onboard-${nonce}-complete-reset`, webPort: options.web, mockPort: options.mock, hubPort: options.hub })
const output = join(topology.root, `${topology.prefix}-acceptance.json`)
const hubConfig = join(topology.root, `${topology.prefix}-hub.json`)
const hubDatabase = join(topology.root, `${topology.prefix}-hub.sqlite`)
const certificates = caFixture(), authority = certificates.ca('reset-v2-root'), leaf = certificates.leaf('reset-v2-leaf', authority)
const origin = `https://127.0.0.1:${options.hub}`
topology.url = `wss://127.0.0.1:${options.hub}/communication`
const fetchHub = (url, options) => trustedHubFetch(url, options, authority.pem)
const adminPassword = randomBytes(24).toString('base64url'), staticCredential = randomBytes(32).toString('hex')
const staticInstance = `reset-static-${nonce}`
const environment = Object.fromEntries(Object.entries(process.env).filter(([key]) => ['PATH', 'HOME', 'USER', 'LANG', 'LC_ALL', 'TMPDIR', 'TMP', 'TEMP', 'SystemRoot'].includes(key)))
const evidence = { status: 'RUNNING', network: 'same-machine loopback', model: 'local deterministic Mock', cases: [],
  paths: { evidence: output, hubConfig, hubDatabase, clients: [] },
  coverage: { realBrowser: 'NOT_RUN', browserUnitTests: 'Run the separate communication browser reset unit suite; this script does not claim its result.' },
  uncovered: ['physical cross-machine/TLS deployment', 'real model behavior', 'real browser/cross-tab observation', 'multi-device legacy static contact migration', 'custom credential/session/attachment providers', 'retained multi-Hub namespaces beyond scopes materialized by this run'],
  secrets: 'No keys, credentials, codes, cookies, raw responses or DSH contents are included in evidence.' }
const save = () => writeFileSync(output, JSON.stringify(evidence, null, 2) + '\n', { mode: 0o600 })
const stage = value => { evidence.stage = value; save() }
const record = (id, detail = {}) => { evidence.cases.push({ id, status: 'PASS', ...detail }); save(); console.log(`PASS ${id}`) }
const fail = (code, target) => { throw Object.assign(new Error(code), { code, ...(target ? { target } : {}) }) }
const hash = value => createHash('sha256').update(value).digest('hex')
let hubProcess, adminCookie, csrf, shuttingDown = false, ownsHubFiles = false
const bench = topology.bench.bind(topology)
topology.bench = (peer, action, extra = {}) => bench(peer, action, { DSBOT_COMMUNICATION_OWNER_PID: String(process.pid), DSBOT_COMMUNICATION_ONBOARDING_FIXTURE: '1', DSBOT_COMMUNICATION_CONFIG: '', DSBOT_COMMUNICATION_CREDENTIAL: '', DSBOT_WEB_OPEN: '0', NODE_EXTRA_CA_CERTS: authority.cert, DSBOT_COMMUNICATION_TEST_CA_FILE:authority.cert, ...extra })

function files(root) {
  if (!existsSync(root)) return []
  return readdirSync(root, { withFileTypes: true }).flatMap(entry => {
    const path = join(root, entry.name)
    assert.ok(!entry.isSymbolicLink(), 'Owned data tree must not contain symlinks')
    return entry.isDirectory() ? files(path) : [path]
  })
}
function journals(peer) {
  return files(peer.paths.sessions).filter(path => /^session(?:\.v[1-9][0-9]*)?\.jsonl(?:\.zstd)?$/.test(basename(path))).map(path => {
    const bytes = readFileSync(path), text = (path.endsWith('.zstd') ? zstdDecompressSync(bytes) : bytes).toString('utf8')
    const rows = text.trimEnd().split('\n').map(line => JSON.parse(line))
    assert.equal(typeof rows[0].id, 'string'); assert.ok(Number.isInteger(rows[0].version))
    const prefix = join(peer.paths.home, 'communication-workspaces')
    const cwd = typeof rows[0].cwd === 'string' ? resolve(rows[0].cwd) : ''
    const remote = cwd.startsWith(prefix + (process.platform === 'win32' ? '\\' : '/'))
    return { path, directory: dirname(path), header: rows[0], rows, remote }
  })
}
function profileWithoutCommunication(value) {
  if (Array.isArray(value)) return value.map(profileWithoutCommunication)
  if (!value || typeof value !== 'object') return value
  const next = structuredClone(value)
  if ((next.id === 'bot' || next.name === 'ds-bot') && next.config) delete next.config.communication
  for (const key of ['insert', 'before', 'after']) if (next[key]) next[key] = profileWithoutCommunication(next[key])
  return next
}
function records(peer) { return existsSync(peer.paths.credentials) ? parse(readFileSync(peer.paths.credentials, 'utf8')).records ?? {} : {} }
function credentialRemainder(peer) {
  if (!existsSync(peer.paths.credentials)) return null
  const value = parse(readFileSync(peer.paths.credentials, 'utf8'))
  for (const key of Object.keys(value.records ?? {})) if (/^ds-bot\/communication-[a-f0-9]{32}$/.test(key)) delete value.records[key]
  return value
}
async function freePort(port) {
  await new Promise((accept, reject) => { const server = createServer(); server.once('error', () => reject(new Error('ACCEPTANCE_PORT_IN_USE'))); server.listen(port, '127.0.0.1', () => server.close(accept)) })
}
async function command(script, args, extra = {}, input) {
  return new Promise((accept, reject) => {
    const child = spawn(process.execPath, [script, ...args], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], env: { ...environment, ...extra } })
    child.stdin.end(input === undefined ? undefined : JSON.stringify(input))
    let stdout = '', stderr = ''
    const timer = setTimeout(() => { child.kill('SIGTERM'); reject(new Error('ACCEPTANCE_COMMAND_TIMEOUT')) }, 90000)
    child.stdout.on('data', value => { stdout += value }); child.stderr.on('data', value => { stderr += value })
    child.once('error', error => { clearTimeout(timer); reject(error) })
    child.once('exit', code => {
      clearTimeout(timer)
      try {
        const line = (code === 0 ? stdout : stderr).trim().split('\n').findLast(value => value.startsWith('{'))
        accept({ code, value: JSON.parse(line) })
      } catch { reject(new Error('ACCEPTANCE_CLI_INVALID_JSON')) }
    })
  })
}
async function startHub() {
  assert.ok(!hubProcess || hubProcess.exitCode !== null || hubProcess.signalCode !== null)
  hubProcess = spawn(process.execPath, [join(repo, 'communication-hub/src/cli.js'), hubConfig], { windowsHide: true, stdio: ['ignore', 'ignore', 'ignore'], env: { ...environment, DSBOT_RESET_TEST_ADMIN: adminPassword, DSBOT_RESET_TEST_STATIC: staticCredential, DSBOT_RESET_TEST_CERT: leaf.cert, DSBOT_RESET_TEST_KEY: leaf.key } })
  let spawnError
  hubProcess.once('error', error => { spawnError = error })
  await until(async () => {
    if (spawnError || hubProcess.exitCode !== null || hubProcess.signalCode !== null) fail('ACCEPTANCE_HUB_START_FAILED')
    try { const response = await fetchHub(origin + '/health', { signal: AbortSignal.timeout(2000) }); return response.ok } catch { return false }
  }, 'owned CLI Hub ready', 20000)
  const info = await (await fetchHub(origin + '/hub-info', { signal: AbortSignal.timeout(10000) })).json()
  assert.ok(info.hubId && info.code)
  return info
}
async function stopHub() {
  if (!hubProcess || hubProcess.exitCode !== null || hubProcess.signalCode !== null) return
  const child = hubProcess, exited = once(child, 'exit')
  child.kill('SIGTERM')
  const timer = setTimeout(() => child.kill('SIGKILL'), 15000)
  const [code, signal] = await exited; clearTimeout(timer)
  if (code !== 0 || signal) fail('ACCEPTANCE_HUB_NORMAL_STOP_FAILED')
}
async function admin(path, input = {}, session = { cookie: adminCookie, csrf }) {
  const response = await fetchHub(origin + '/admin/api/' + path, { method: 'POST', headers: { 'content-type': 'application/json', origin, ...(session.cookie ? { cookie: session.cookie, 'x-csrf-token': session.csrf } : {}) }, body: JSON.stringify(input), signal: AbortSignal.timeout(15000) })
  const result = await response.json()
  if (!result.ok) fail(result.error?.code ?? 'ACCEPTANCE_ADMIN_INVALID_RESPONSE')
  if (path === 'login') {
    adminCookie = response.headers.getSetCookie().map(value => value.split(';')[0]).join('; '); csrf = result.csrf
    assert.ok(adminCookie && csrf)
  }
  return result.value
}
async function rpc(type, payload) {
  const socket = new WebSocket(topology.url, {ca:authority.pem})
  try {
    await new Promise((accept, reject) => { socket.addEventListener('open', accept, { once: true }); socket.addEventListener('error', () => reject(new Error('ACCEPTANCE_SOCKET_FAILED')), { once: true }); setTimeout(() => reject(new Error('ACCEPTANCE_SOCKET_TIMEOUT')), 15000).unref() })
    return await new Promise((accept, reject) => {
      const id = randomUUID(), timer = setTimeout(() => reject(new Error('ACCEPTANCE_RPC_TIMEOUT')), 15000)
      socket.addEventListener('message', event => {
        const response = JSON.parse(event.data)
        if (response.id !== id) return
        clearTimeout(timer)
        if (response.ok) accept(response.value)
        else reject(Object.assign(new Error(response.error?.code), { code: response.error?.code }))
      })
      socket.send(JSON.stringify({ protocol: 'dsbot-communication/1', id, type, payload }))
    })
  } finally { socket.close() }
}
async function api(peer, endpoint, input = {}) {
  // This is an HTTP client, not a browser. Supply the current reset generation explicitly.
  const status = await peer.client.request('/api/communication', { endpoint: 'reset-status' })
  const response = await fetch(`http://127.0.0.1:${peer.web}/api/communication`, { method: 'POST', headers: { 'content-type': 'application/json', cookie: peer.cookie, 'x-dsbot-browser-epoch': status.browserEpoch ?? '' }, body: JSON.stringify({ endpoint, ...input }), signal: AbortSignal.timeout(60000) })
  const result = await response.json()
  if (!result.ok) fail(result.error?.code ?? 'ACCEPTANCE_API_INVALID_RESPONSE')
  return result.value
}
async function startPeer(peer, extra = {}) {
  await topology.bench(peer, 'start', extra)
  peer.client = await until(async () => { try { return await benchClient(peer.name, peer.web) } catch { return false } }, 'real DSH API ready', 45000)
  const login = readFileSync(join(peer.home, 'web.log'), 'utf8').match(new RegExp(`http://127\\.0\\.0\\.1:${peer.web}/\\?token=[^\\s]+`))?.[0]
  assert.ok(login)
  const response = await fetch(login, { redirect: 'manual', signal: AbortSignal.timeout(15000) })
  peer.cookie = response.headers.getSetCookie().map(value => value.split(';')[0]).join('; ')
  assert.ok(peer.cookie)
  peer.api = ({ endpoint, ...input }) => api(peer, endpoint, input)
  await until(async () => !(await peer.client.request('/api/bot', { endpoint: 'state' })).readOnly, 'normal Host owns local team', 75000)
}
async function connected(peer, hubId) {
  return until(async () => { const value = await api(peer, 'state'); return value.connected && value.reconciled && value.hubId === hubId && value }, 'enrolled selected Hub reconciled', 45000)
}
async function enroll(peer, info) {
  const held = await peer.client.request('/api/bot', { endpoint: 'state' })
  const reviewed = await api(peer, 'decode-hub-code', { hubCode: info.code })
  const pending = await api(peer, 'join-hub', { hubCode: info.code, confirmedHubId: reviewed.hubId, confirmedUrl: reviewed.url, confirmedTrustFingerprint: reviewed.trustFingerprint, displayName: `Reset test ${peer.id.toUpperCase()}` })
  assert.equal(pending.status, 'pending')
  const request = (await admin('state')).requests.find(value => value.requestId === pending.requestId)
  assert.equal(request?.status, 'pending')
  await admin('decide', { requestId: request.requestId, expectedVersion: request.version, action: 'approve' })
  assert.equal((await api(peer, 'hub-join-status', { hubId: info.hubId })).status, 'approved')
  const state = await connected(peer, info.hubId)
  const delta = await peer.client.request('/api/bot', { endpoint: 'state', payload: { since: held.revision, models: held.modelsKey, live: held.liveKey } })
  assert.equal(delta.revision, held.revision, 'Enrollment must not require a team edit to update the browser')
  assert.equal(delta.unchanged, true)
  assert.equal(delta.communicationEnabled, true)
  assert.equal(delta.communicationHubId, info.hubId)
  peer.instanceId = state.instanceId; peer.human = state.humanPrincipalId
  assert.equal((await api(peer, 'onboarding-storage', { hubId: info.hubId })).storage.kind, 'dsh-credential-record')
  return state
}
async function publish(peer) {
  await api(peer, 'publish-bots', { localBotIds: [peer.botId] })
  const state = await until(async () => {
    const value = await api(peer, 'state')
    if (!value.connected || !value.reconciled || value.localBots?.length !== 1) return false
    try { await api(peer, 'user-code'); return value } catch (error) { if (error.code === 'COMMUNICATION_UNAVAILABLE') return false; throw error }
  }, 'published Bot reconciled')
  peer.bot = state.localBots[0].principalId
}
async function contactAndGroup(label, attachments = []) {
  const [a, b] = topology.peers, code = await api(b, 'user-code')
  const request = await topology.operation(a, 'request-contact', { userCode: code.userCode })
  const incoming = await until(async () => (await api(b, 'contact-requests')).find(value => value.requestId === request.requestId && value.direction === 'incoming'), 'contact request received')
  await topology.operation(b, 'accept-contact', { requestId: incoming.requestId, expectedVersion: incoming.version })
  await until(async () => (await api(a, 'state')).contacts.some(value => value.principalId === b.bot) && (await api(b, 'state')).contacts.some(value => value.principalId === a.bot), 'mutual selected Bot consent')
  const cliEnv={DSBOT_REMOTE_URL:`http://127.0.0.1:${a.web}`,DSBOT_REMOTE_COOKIE:a.cookie}
  const created=await command(join(repo,'ds-bot/bin/dsbot-remote.mjs'),['create-group'],cliEnv,{title:`Reset ${label}`})
  assert.equal(created.code,0);assert.equal(created.value.ok,true)
  const conversationId=created.value.value.conversationId
  for(const inviteePrincipalId of [a.bot,b.bot]){
    const added=await command(join(repo,'ds-bot/bin/dsbot-remote.mjs'),['invite'],cliEnv,{conversationId,inviteePrincipalId})
    assert.equal(added.code,0);assert.equal(added.value.value.joined,true)
  }
  for(const peer of [a,b])await until(async()=>{const snapshot=await api(peer,'state');return snapshot.conversations.some(item=>item.conversationId===conversationId)&&!snapshot.invites.some(item=>item.conversationId===conversationId)},'CLI-created group appears on both real DSH instances without invitation acceptance',45000)
  record(`cli-created-group-${label}-visible-on-both-devices-without-acceptance`)
  assert.ok(!(await api(a,'state')).invites.some(item=>item.conversationId===conversationId&&item.principalId===a.bot),'The local Bot joins without an invitation acceptance step')
  const tag = `${label}-${nonce}`, sent = await topology.send(a, conversationId, `COMM-ECHO ${tag}`, [b.bot], { attachments })
  const reply = await until(async () => (await topology.history(a, conversationId)).events.find(event => event.message?.author.principalId === b.bot && event.message.content.text === `Communication reply ${tag}`)?.message, 'actual remote DSH Mock reply', 60000)
  assert.ok(reply.responseToDeliveryId)
  return { conversationId, inputId: sent.messageId, replyId: reply.messageId }
}
function pathsFor(peer) {
  const profile = join(peer.home, 'profiles/communication-test')
  const paths = { dshHome: peer.home, home: join(peer.home, 'bot'), profiles: [join(profile, 'cordis.yml'), join(profile, 'cordis.patch.yml'), join(peer.home, 'bench.patch.yml')], credentials: join(peer.home, '.credentials.yaml'), sessions: join(peer.home, 'sessions'), attachmentsHome: peer.home, storageRoot: join(peer.home, 'storages') }
  for (const path of paths.profiles) assert.ok(lstatSync(path).isFile(), 'Actual bench profile required')
  if (existsSync(paths.credentials)) assert.ok(lstatSync(paths.credentials).isFile(), 'Actual local credential store must be a file')
  assert.ok(lstatSync(paths.sessions).isDirectory(), 'Actual materialized DSH session root required')
  assert.ok(lstatSync(paths.storageRoot).isDirectory(), 'Actual default JSON storage provider root required')
  return paths
}
function resetArguments(peer, confirm) {
  const p = peer.paths
  return ['--home', p.home, ...p.profiles.flatMap(path => ['--profile', path]), '--credentials', p.credentials, '--sessions', p.sessions, '--attachments-home', p.attachmentsHome, '--storage-root', p.storageRoot, ...(confirm ? ['--confirm', 'ERASE-ALL-FEDERATION-DATA'] : [])]
}
async function clientReset(peer, confirm = false) {
  const result = await command(join(repo, 'ds-bot/bin/dsbot-reset.mjs'), resetArguments(peer, confirm), { DSH_HOME: peer.home, DSH_HARNESS: join(repo, 'ds-bot/dev/harness') })
  if (result.code !== 0) {
    assert.equal(result.value.ok, false); assert.equal(result.value.incomplete, true)
    evidence.incomplete = { code: result.value.error?.code ?? 'RESET_FAILED', ...(result.value.error?.target ? { target: result.value.error.target } : {}) }; save()
    fail(result.value.error?.code ?? 'RESET_FAILED', result.value.error?.target)
  }
  return result.value
}
function snapshot(peer) {
  const logs = journals(peer), remoteDirectories = [...new Set(logs.filter(value => value.remote).map(value => value.directory))]
  const ordinaryFiles = files(peer.paths.sessions).filter(path => !remoteDirectories.includes(dirname(path)))
  const remoteIds = [...new Set(logs.filter(value => value.remote).map(value => value.header.id))]
  const workspacePath = join(peer.paths.storageRoot, 'workspace.json')
  const workspace = JSON.parse(readFileSync(workspacePath, 'utf8'))
  const projectionRoot = join(peer.paths.storageRoot, 'session_projcache/sessions')
  const remoteProjections = remoteIds.map(id => join(projectionRoot, id + '.json')).filter(existsSync)
  const ordinaryProjections = files(projectionRoot).filter(path => !remoteProjections.includes(path)).map(path => ({ path, digest: hash(readFileSync(path)) }))
  return { state: hash(readFileSync(join(peer.paths.home, 'state.json'))), profiles: peer.paths.profiles.map(path => ({ path, digest: hash(readFileSync(path)), value: profileWithoutCommunication(parse(readFileSync(path, 'utf8'))) })), credentials: credentialRemainder(peer), credentialDigest: existsSync(peer.paths.credentials) ? hash(readFileSync(peer.paths.credentials)) : null, remoteDirectories, remoteIds, workspace, remoteProjections, ordinaryProjections, storageFiles: files(peer.paths.storageRoot).map(path => ({ path, digest: hash(readFileSync(path)) })),
    ordinary: ordinaryFiles.map(path => ({ path, digest: hash(readFileSync(path)) })), attachments: files(join(peer.home, 'attachments/v1')).map(path => ({ path, digest: hash(readFileSync(path)) })) }
}
function preserved(peer, before) {
  assert.equal(hash(readFileSync(join(peer.paths.home, 'state.json'))), before.state, 'Local Bot state must remain byte-identical')
  for (const item of before.ordinary) assert.equal(hash(readFileSync(item.path)), item.digest, 'Ordinary DSH files must remain byte-identical')
  for (const item of before.profiles) assert.deepEqual(profileWithoutCommunication(parse(readFileSync(item.path, 'utf8'))), item.value, 'Non-communication profile configuration must remain')
  assert.deepEqual(credentialRemainder(peer), before.credentials, 'Unrelated credentials must remain')
}

function derivedErased(peer, before) {
  for (const path of before.remoteProjections) assert.equal(existsSync(path), false, 'Remote Session projection must be erased')
  for (const item of before.ordinaryProjections) assert.equal(hash(readFileSync(item.path)), item.digest, 'Ordinary projection must remain byte-identical')
  const workspacePath = join(peer.paths.storageRoot, 'workspace.json'), after = JSON.parse(readFileSync(workspacePath, 'utf8'))
  const remoteRoot = join(peer.paths.home, 'communication-workspaces')
  const insideRemote = path => typeof path === 'string' && path.startsWith(remoteRoot + (process.platform === 'win32' ? '\\' : '/'))
  for (const [id, row] of Object.entries(before.workspace.tables.workspaces)) {
    if (insideRemote(row.path)) assert.equal(after.tables.workspaces[id], undefined, 'Remote Workspace registration must be erased')
    else assert.deepEqual(after.tables.workspaces[id], { ...row, sessionIds: row.sessionIds.filter(session => !before.remoteIds.includes(session)) }, 'Ordinary Workspace registration must remain')
  }
  for (const path of files(peer.paths.storageRoot).filter(path => path.endsWith('.json'))) {
    const text = readFileSync(path, 'utf8')
    for (const id of before.remoteIds) if (text.includes(id)) fail('ACCEPTANCE_REMOTE_DERIVED_RESIDUE', path)
    if (text.includes(remoteRoot) || text.includes(remoteRoot.replaceAll('\\', '\\\\'))) fail('ACCEPTANCE_REMOTE_DERIVED_RESIDUE', path)
  }
}

async function legacyStaticPrelude(peer) {
  stage('existing normal profile starts with legacy static pairing')
  await topology.bench(peer, 'stop')
  const settings = { enabled: true, url: topology.url, instanceId: staticInstance, publishedBotIds: [peer.botId], humanDisplayName: 'Legacy static test', pollMs: 150 }
  await startPeer(peer, { DSBOT_COMMUNICATION_ONBOARDING_FIXTURE: '', DSBOT_COMMUNICATION_CONFIG: JSON.stringify(settings), DSBOT_COMMUNICATION_CREDENTIAL: staticCredential })
  const state = await until(async () => {
    const value = await api(peer, 'state')
    return value.connected && value.reconciled && value.instanceId === staticInstance && value.localBots.length === 1 && value
  }, 'actual legacy static DSH connection reconciled', 45000)
  peer.instanceId = state.instanceId; peer.human = state.humanPrincipalId; peer.bot = state.localBots[0].principalId
  const group = await topology.group('Legacy static before reset', [peer.bot], { allowSpeaking: false })
  const input = await topology.send(peer, group, `COMM-ECHO legacy-static-${nonce}`, [peer.bot])
  await until(() => topology.hasText(peer, group, `Communication reply legacy-static-${nonce}`), 'legacy static real DSH Mock reply', 60000)
  await topology.bench(peer, 'stop')
  peer.paths = pathsFor(peer)
  const before = snapshot(peer)
  assert.ok(before.remoteProjections.length > 0, 'Actual legacy static projection cache materialized')
  assert.ok(journals(peer).some(value => value.remote && JSON.stringify(value.rows).includes(input.messageId)), 'Legacy static Host created a real communication Session')
  const dry = await clientReset(peer)
  assert.equal(dry.dryRun, true); assert.ok(dry.configurationFiles > 0)
  for (const item of [...before.profiles, ...before.storageFiles]) assert.equal(hash(readFileSync(item.path)), item.digest, 'Legacy dry run must not mutate profile or derived state')
  const erased = await clientReset(peer, true)
  assert.equal(erased.erased, true)
  assert.ok(erased.clearLaunchEnvironment.includes('DSBOT_COMMUNICATION_CREDENTIAL'))
  assert.equal(existsSync(join(peer.paths.home, 'communication.sqlite')), false)
  assert.equal(existsSync(join(peer.paths.home, 'communication-workspaces')), false)
  assert.ok(before.remoteDirectories.every(path => !existsSync(path)))
  preserved(peer, before); derivedErased(peer, before)
  // The CLI cannot erase a parent's environment. This restart explicitly removes the static launch inputs.
  await startPeer(peer)
  assert.equal((await api(peer, 'onboarding-storage')).configured, false)
  assert.equal((await api(peer, 'state')).enabled, false)
  assert.equal((await peer.client.request('/api/bot', { endpoint: 'state' })).mainBotId, peer.botId)
  record('real-legacy-static-DSH-group-Mock-reply-reset-and-same-profile-unconfigured-restart', { launchCredentialClearedByFixture: true })
}

async function stopAll() {
  if (shuttingDown) return
  shuttingDown = true
  const errors = []
  for (const peer of topology.peers) if (peer.owned && existsSync(peer.home)) try { await topology.bench(peer, 'stop') } catch { errors.push('HOST_STOP_FAILED') }
  try { await stopHub() } catch { errors.push('HUB_STOP_FAILED') }
  for (const port of ports) try { await freePort(port) } catch { errors.push(`PORT_NOT_RELEASED_${port}`) }
  evidence.portsReleased = !errors.some(value => value.startsWith('PORT_NOT_RELEASED_'))
  evidence.shutdown = errors.length ? errors : 'owned processes stopped'
  if (errors.length) { evidence.status = 'FAIL'; process.exitCode = 1 }
}
const deadline = setTimeout(() => { evidence.status = 'FAIL'; evidence.error = 'ACCEPTANCE_DEADLINE'; void stopAll().finally(() => { save(); process.exit(1) }) }, 12 * 60 * 1000)
try {
  stage('reserve isolated ports and fresh owned roots')
  for (const port of ports) await freePort(port)
  for (const peer of topology.peers) { peer.home = join(repo, `.dsh-test-${peer.name}`); assert.equal(existsSync(peer.home), false, 'Acceptance cannot reuse a pre-existing profile') }
  assert.equal(existsSync(hubConfig), false); assert.equal(existsSync(hubDatabase), false)
  writeFileSync(hubConfig, JSON.stringify({ databasePath: basename(hubDatabase), host: '127.0.0.1', port: options.hub, peers: [{ instanceId: staticInstance, credentialEnv: 'DSBOT_RESET_TEST_STATIC' }], tls: {certificateEnv:'DSBOT_RESET_TEST_CERT',privateKeyEnv:'DSBOT_RESET_TEST_KEY'}, management: { enabled: true, pairingCaFile:authority.cert, adminPasswordEnv: 'DSBOT_RESET_TEST_ADMIN', url: topology.url } }, null, 2) + '\n', { mode: 0o600, flag: 'wx' })
  ownsHubFiles = true
  for (const peer of topology.peers) peer.owned = true
  const oldHub = await startHub()
  await admin('login', { password: adminPassword })
  const oldAdminSession = { cookie: adminCookie, csrf }
  assert.equal((await rpc('hello', { instanceId: staticInstance, credential: staticCredential, capabilities: communicationCapabilities() })).hubId, oldHub.hubId)
  for (const peer of topology.peers) {
    stage(`old enrollment and ordinary local chat: ${peer.id}`)
    await startPeer(peer)
    const team = await peer.client.request('/api/bot', { endpoint: 'state' }); peer.botId = team.mainBotId
    await peer.client.request('/api/bot', { endpoint: 'update-bot', payload: { id: peer.botId, name: `Retained local ${peer.id}`, model: 'deepseek-official/deepseek-v4-pro' } })
    await peer.client.request('/api/bot', { endpoint: 'send', payload: { sessionId: peer.botId, text: `ordinary-reset-canary-${nonce}-${peer.id}` } })
    await until(async () => { const metrics = await peer.client.api({ operation: 'metrics' }); return metrics.chiefEvents > 0 && metrics.chiefStatus === 'idle' && metrics.chiefPending === 0 }, 'ordinary local chat settled', 45000)
    if (peer.id === 'a') await legacyStaticPrelude(peer)
    await enroll(peer, oldHub); await publish(peer)
    peer.old = { instanceId: peer.instanceId, human: peer.human, bot: peer.bot, userCode: (await api(peer, 'user-code')).userCode }
  }
  const bytes = Buffer.from(`Synthetic remote-only attachment ${nonce}`)
  const attachment = { name: `remote-reset-${nonce}.txt`, mime: 'text/plain', size: bytes.length, data: bytes.toString('base64'), sha256: hash(bytes) }
  stage('old contact group remote attachment and actual DSH reply')
  const oldGroup = await contactAndGroup('before-reset', [attachment])
  record('old-enrolled-DSH-contact-group-attachment-and-Mock-reply')
  for (const peer of topology.peers) {
    await topology.bench(peer, 'stop')
    peer.paths = pathsFor(peer); evidence.paths.clients.push({ peer: peer.id, ...peer.paths })
    const key = `ds-bot/communication-${hash(oldHub.hubId).slice(0, 32)}`
    const recordValue = records(peer)[key]; assert.ok(recordValue?.payload?.publicKey)
    peer.old.publicKey = recordValue.payload.publicKey
    peer.before = snapshot(peer)
    const logs = journals(peer)
    assert.ok(logs.some(value => !value.remote && JSON.stringify(value.rows).includes(`ordinary-reset-canary-${nonce}-${peer.id}`)), 'Real ordinary local DSH journal materialized')
    if (peer.id === 'b') {
      assert.ok(logs.some(value => value.remote && JSON.stringify(value.rows).includes(oldGroup.inputId)), 'Remote input was admitted into a real DSH journal')
      assert.ok(peer.before.attachments.length > 0, 'Real DSH attachment objects materialized')
      assert.ok(peer.before.remoteProjections.length > 0, 'Real DSH projection cache materialized')
    }
  }
  record('normal-Host-stop-and-exact-runtime-paths-verified')
  stage('unknown attachment ownership must fail before mutation')
  const target = topology.peers[1], orphanBytes = Buffer.from(`Deliberate unreferenced fixture ${nonce}`), digest = hash(orphanBytes)
  const orphan = join(target.home, 'attachments/v1/file-objects', digest.slice(0, 2), digest)
  assert.equal(existsSync(orphan), false); mkdirSync(dirname(orphan), { recursive: true }); writeFileSync(orphan, orphanBytes)
  const blocked = await command(join(repo, 'ds-bot/bin/dsbot-reset.mjs'), resetArguments(target, true), { DSH_HOME: target.home, DSH_HARNESS: join(repo, 'ds-bot/dev/harness') })
  assert.notEqual(blocked.code, 0); assert.equal(blocked.value.incomplete, true)
  if (blocked.value.error?.code !== 'RESET_ATTACHMENT_OWNERSHIP_UNPROVEN' || blocked.value.error?.target !== orphan) {
    evidence.incomplete = { code: blocked.value.error?.code ?? 'RESET_FAILED', target: blocked.value.error?.target }; save()
    fail(blocked.value.error?.code ?? 'RESET_FAILED', blocked.value.error?.target)
  }
  assert.ok(existsSync(orphan)); assert.ok(target.before.remoteDirectories.every(existsSync)); preserved(target, target.before)
  // Only remove the deliberate, byte-verified test orphan. Never discard real unresolved residue.
  assert.equal(hash(readFileSync(orphan)), digest); rmSync(orphan)
  record('unproven-orphan-reports-incomplete-without-erasing-state')
  for (const peer of topology.peers) {
    stage(`plain reset CLI dry-run and confirmed erasure: ${peer.id}`)
    const dry = await clientReset(peer)
    assert.equal(dry.dryRun, true); assert.ok(dry.pairingRecords > 0)
    assert.equal(hash(readFileSync(peer.paths.credentials)), peer.before.credentialDigest, 'Dry run cannot change credentials')
    for (const item of [...peer.before.profiles, ...peer.before.storageFiles]) assert.equal(hash(readFileSync(item.path)), item.digest, 'Dry run cannot change profile or derived state bytes')
    assert.ok(peer.before.remoteDirectories.every(existsSync)); preserved(peer, peer.before)
    const erased = await clientReset(peer, true)
    assert.equal(erased.erased, true); assert.equal(erased.dryRun, false); assert.equal(erased.browserCleanupPending, true)
    if (peer.id === 'b') assert.ok(erased.exclusiveAttachmentObjects > 0)
    assert.equal(existsSync(join(peer.paths.home, 'communication.sqlite')), false)
    assert.equal(existsSync(join(peer.paths.home, 'communication-hubs')), false)
    assert.equal(existsSync(join(peer.paths.home, 'communication-workspaces')), false)
    assert.ok(peer.before.remoteDirectories.every(path => !existsSync(path)))
    assert.equal(journals(peer).some(value => value.remote), false)
    assert.equal(Object.keys(records(peer)).some(key => key.startsWith('ds-bot/communication-')), false)
    assert.equal(files(join(peer.home, 'attachments/v1')).length, 0, 'All attachment bytes in this fixture are remote-only')
    for (const path of peer.paths.profiles) assert.deepEqual(parse(readFileSync(path, 'utf8')), profileWithoutCommunication(parse(readFileSync(path, 'utf8'))))
    preserved(peer, peer.before); derivedErased(peer, peer.before)
    const empty = await clientReset(peer)
    for (const field of ['configurationFiles', 'pairingRecords', 'queueFiles', 'remoteDirectories', 'attachmentFiles', 'attachmentAliasFiles', 'projectionRecords', 'remoteWorkspaceRecords', 'workspaceSessionAccounts', 'temporaryFiles']) assert.equal(empty[field], 0, `Confirmed reset must leave no ${field}`)
    record(`client-${peer.id}-all-materialized-federation-data-erased-local-data-preserved`, { exclusiveAttachmentObjects: erased.exclusiveAttachmentObjects, erasedRemoteDirectories: peer.before.remoteDirectories.length, erasedProjectionRecords: peer.before.remoteProjections.length })
  }
  stage('normal Hub shutdown and offline CLI reset of actual config')
  await stopHub()
  const reset = await command(join(repo, 'communication-hub/src/reset-cli.js'), ['--config', hubConfig, '--confirm', 'DELETE ALL HUB DATA'])
  assert.equal(reset.code, 0); assert.equal(reset.value.ok, true); assert.equal(reset.value.value.staticPeersRemoved, 1)
  assert.equal(reset.value.value.backupCreated, false)
  for (const suffix of ['', '-wal', '-shm', '-journal']) assert.equal(existsSync(hubDatabase + suffix), false)
  assert.deepEqual(JSON.parse(readFileSync(hubConfig, 'utf8')).peers, [])
  const freshHub = await startHub()
  assert.notEqual(freshHub.hubId, oldHub.hubId); assert.notEqual(freshHub.code, oldHub.code)
  await assert.rejects(admin('state', {}, oldAdminSession), { code: 'UNAUTHENTICATED' })
  await assert.rejects(rpc('hello', { instanceId: staticInstance, credential: staticCredential, capabilities: communicationCapabilities() }), { code: 'UNAUTHENTICATED' })
  for (const peer of topology.peers) await assert.rejects(rpc('enrollment.challenge', { purpose: 'login', instanceId: peer.old.instanceId, publicKey: peer.old.publicKey }), { code: 'UNAUTHENTICATED' })
  await admin('login', { password: adminPassword })
  const emptyHub = await admin('state'); assert.equal(emptyHub.instances.length, 0); assert.equal(emptyHub.requests.length, 0)
  const db = new DatabaseSync(hubDatabase, { readOnly: true })
  try {
    for (const table of ['principals', 'conversations', 'messages', 'deliveries', 'responses', 'operations', 'hub_enrolled_peers', 'hub_join_requests']) assert.equal(db.prepare(`SELECT count(*) n FROM ${table}`).get().n, 0, `Reset Hub table ${table} must be empty`)
  } finally { db.close() }
  record('new-Hub-identity-empty-data-and-old-admin-static-enrolled-authentication-denied')
  for (const peer of topology.peers) {
    await startPeer(peer)
    const storage = await api(peer, 'onboarding-storage')
    assert.equal(storage.configured, false); assert.equal(storage.enrollments.length, 0); assert.equal(storage.selectedHub, null)
    const cli = await command(join(repo, 'ds-bot/bin/dsbot-remote.mjs'), ['state'], { DSBOT_REMOTE_URL: `http://127.0.0.1:${peer.web}`, DSBOT_REMOTE_COOKIE: peer.cookie })
    assert.equal(cli.code, 0); assert.equal(cli.value.ok, true); assert.equal(cli.value.value.enabled, false)
    assert.deepEqual(cli.value.request, { endpoint: 'state' })
  }
  record('actual-Node-remote-CLI-reconciles-reset-generation-without-reenrollment')
  stage('old Hub code rejected by public Human API')
  const a = topology.peers[0], reviewedOld = await api(a, 'decode-hub-code', { hubCode: oldHub.code })
  await assert.rejects(api(a, 'join-hub', { hubCode: oldHub.code, confirmedHubId: reviewedOld.hubId, confirmedUrl: reviewedOld.url, confirmedTrustFingerprint: reviewedOld.trustFingerprint, displayName: 'Stale code must not enroll' }), { code: 'INVALID_ENROLLMENT_CHALLENGE' })
  assert.equal((await admin('state')).requests.length, 0)
  // A failed enrollment prepares a local key by design; erase that attempted state too.
  await topology.bench(a, 'stop'); await clientReset(a, true); await startPeer(a)
  assert.equal((await api(a, 'onboarding-storage')).configured, false)
  record('old-Hub-code-cannot-enroll-and-failed-attempt-reset-again')
  for (const peer of topology.peers) {
    stage(`same existing profile new approved identity: ${peer.id}`)
    const clean = await enroll(peer, freshHub)
    assert.notEqual(clean.instanceId, peer.old.instanceId); assert.notEqual(clean.humanPrincipalId, peer.old.human)
    assert.equal(clean.conversations.length, 0); assert.equal(clean.outbox.length, 0); assert.equal(clean.localBots.length, 0)
    assert.ok(!clean.contacts.some(value => [peer.old.bot, peer.old.human].includes(value.principalId)))
    assert.notEqual((await api(peer, 'user-code')).userCode, peer.old.userCode)
    await publish(peer); assert.notEqual(peer.bot, peer.old.bot)
    const team = JSON.parse(readFileSync(join(peer.paths.home, 'state.json'), 'utf8'))
    assert.ok(team.bots[peer.botId]); assert.equal(team.bots[peer.botId].name, `Retained local ${peer.id}`)
    assert.equal(team.bots[peer.botId].model, 'deepseek-official/deepseek-v4-pro')
    await assert.rejects(api(peer, 'history', { conversationId: oldGroup.conversationId, limit: 100 }), error => ['NOT_MEMBER', 'NOT_A_MEMBER', 'MEMBERSHIP_REVOKED', 'FORBIDDEN', 'MEMBERSHIP_EPOCH_REQUIRED', 'CONVERSATION_NOT_FOUND'].includes(error.code))
  }
  stage('fresh contact and group execute a new real DSH Mock reply')
  const freshGroup = await contactAndGroup('after-reset')
  assert.notEqual(freshGroup.conversationId, oldGroup.conversationId)
  record('same-profiles-new-enrollment-contact-group-and-real-DSH-Mock-reply')
  stage('real Agent-created group and persistent Bot-to-Bot conversation carrier')
  const [sender,recipient]=topology.peers,agentGroupTitle=`Agent group ${nonce}`,dmTag=`bot-dm-${nonce}`
  await sender.client.request('/api/bot',{endpoint:'send',payload:{sessionId:sender.botId,text:`COMM-CREATE-GROUP ${agentGroupTitle}`}})
  const agentGroup=await until(async()=>(await api(sender,'state')).conversations.find(item=>item.title===agentGroupTitle),'Agent-created group appears in local Human conversation list',60000)
  assert.equal(agentGroup.ownerPrincipalId,sender.bot)
  assert.ok(agentGroup.info.members.some(person=>person.principalId===sender.human))
  record('real-agent-created-group-includes-its-human-owner')
  await sender.client.request('/api/bot',{endpoint:'send',payload:{sessionId:sender.botId,text:`COMM-SEND ${recipient.bot} ${dmTag}`}})
  let dm=await until(async()=>(await api(sender,'state')).botConversations.find(item=>item.info.members.some(person=>person.principalId===recipient.bot)),'Bot DM record appears separately from Human conversations',60000)
  await until(async()=>(await api(sender,'bot-dm-history',{conversationId:dm.conversationId,localBotId:sender.botId,membershipEpoch:dm.membershipEpoch})).events.some(event=>event.message?.content.text===`Communication reply ${dmTag}`),'actual remote Mock reply is retained in the Bot DM record',60000)
  await assert.rejects(api(sender,'history',{conversationId:dm.conversationId}),{code:'NOT_A_MEMBER'})
  assert.ok(!(await api(sender,'state')).conversations.some(item=>item.conversationId===dm.conversationId))
  record('bot-dm-record-holds-real-mock-messages-without-human-membership')
  await topology.bench(sender,'stop');await startPeer(sender)
  dm=await until(async()=>(await api(sender,'state')).botConversations.find(item=>item.conversationId===dm.conversationId),'Bot DM record survives Host restart',45000)
  const archive=await command(join(repo,'ds-bot/bin/dsbot-remote.mjs'),['bot-dm-history'],{DSBOT_REMOTE_URL:`http://127.0.0.1:${sender.web}`,DSBOT_REMOTE_COOKIE:sender.cookie},{conversationId:dm.conversationId,localBotId:sender.botId,membershipEpoch:dm.membershipEpoch})
  assert.equal(archive.code,0);assert.ok(archive.value.value.events.some(event=>event.message?.content.text===`Communication reply ${dmTag}`))
  record('bot-dm-record-survives-host-restart-and-is-readable-through-real-cli')
  for (const peer of topology.peers) {
    await topology.bench(peer, 'stop')
    assert.ok(journals(peer).some(value => !value.remote && JSON.stringify(value.rows).includes(`ordinary-reset-canary-${nonce}-${peer.id}`)), 'Ordinary local chat remains readable after reconnect')
    assert.ok(peer.before.remoteDirectories.every(path => !existsSync(path)))
  }
  evidence.status = 'PASS'
} catch (error) {
  evidence.status = 'FAIL'; evidence.error = /^[A-Z_]+$/.test(error.code ?? '') ? error.code : 'ACCEPTANCE_FAILED'
  if (error.target && typeof error.target === 'string') evidence.target = error.target
  evidence.failureLocation = error.stack?.match(/complete-reset-acceptance\.mjs:[0-9]+:[0-9]+/)?.[0]
  process.exitCode = 1
} finally {
  clearTimeout(deadline)
  await stopAll()
  if (!options.keep && evidence.status === 'PASS' && evidence.shutdown === 'owned processes stopped') {
    for (const peer of topology.peers) if (peer.owned) {
      assert.equal(dirname(resolve(peer.home)), repo); assert.ok(basename(peer.home).startsWith(`.dsh-test-hub-onboard-${nonce}-complete-reset`))
      rmSync(peer.home, { recursive: true, force: true })
    }
    if (ownsHubFiles) for (const path of [hubConfig, hubDatabase, ...['-wal', '-shm', '-journal'].map(suffix => hubDatabase + suffix)]) rmSync(path, { force: true })
    evidence.ownedArtifactsRemoved = true
  } else { evidence.ownedArtifactsRemoved = false; evidence.retainedReason = options.keep ? 'explicit keep-profiles' : 'failed acceptance retained for diagnosis; no residual cleanup claimed' }
  save()
  console.log(`Evidence ${relative(repo, output)}`)
  certificates.close()
}
