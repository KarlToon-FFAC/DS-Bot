import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createServer } from 'node:http'
import { Readable } from 'node:stream'
import { readFile, writeFile, unlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID,createHash } from 'node:crypto'
import { prepare, execute, main, help } from '../bin/dsbot-remote.mjs'
import { install, remotePackagePaths } from '../src/host/prompt.js'

const requests = {
  'work-approval-settings': {}, 'set-work-approval': {remoteWorkApproval:'ask'},
  'use-published-contact-bots': {otherHumanPrincipalId:'human:b:owner',expectedVersion:1},
  'set-conversation-archived':{conversationId:'private',membershipEpoch:'epoch',archived:true,expectedScope:'synthetic-local-scope'},
  'bot-dm-history':{conversationId:'private',localBotId:'worker',membershipEpoch:'epoch',limit:10},
  'bot-dm-reference':{conversationId:'private',localBotId:'worker',membershipEpoch:'epoch',messageId:'one'},
  'participant-profile':{conversationId:'group',membershipEpoch:'epoch',targetPrincipalId:'bot:b:expert'},
  'answer-work-approval': {id:'approval-test',choice:'reject',expectedScope:'local-scope'},
  state: {}, diagnose: {}, contacts: {}, conversations: {}, invites: {}, outbox: {}, members: { conversationId: 'group' },
  history: { conversationId: 'group', after: 1, before: 20, limit: 10, latest: false, membershipEpoch: 'epoch' },
  thread: { conversationId: 'group', messageId: 'message', after: 1, limit: 20, watermark: 10, membershipEpoch: 'epoch' },
  reference: { conversationId: 'group', messageId: 'message' }, read: { conversationId: 'group', seq: 5 },
  send: { conversationId: 'group', text: 'Hello @all', mentions: ['bot:a:id'], replyToMessageId: 'previous' },
  dm: { otherPrincipalId: 'human:a:id' }, 'create-group': { title: 'Group' },
  invite: { conversationId: 'group', inviteePrincipalId: 'bot:a:id', expectedVersion: 2, membershipEpoch: 'epoch' },
  accept: { inviteId: 'invite', recipientPrincipalId: 'bot:local:id' },
  remove: { conversationId: 'group', targetPrincipalId: 'bot:a:id' }, leave: { conversationId: 'group' },
  routing: { conversationId: 'group', mode: 'admin', adminBotPrincipalId: 'bot:a:id' },
  policy: { conversationId: 'group', targetPrincipalId: 'bot:a:id', expectedVersion: 2, speakingMode: 'active', role: 'admin' },
  transfer: { conversationId: 'group', targetPrincipalId: 'bot:a:id', expectedVersion: 2 },
  dissolve: { conversationId: 'group' },
  'configure-group': { conversationId: 'group', expectedVersion: 2, title: 'New name' }, 'rename-human': { displayName: 'Human' },
  'profile-human': { displayName: 'Human', avatar: { image: 'data:image/png;base64,iVBORw0KGgo=' } },
  avatar: { principalId: 'human:a:id', revision: 'a'.repeat(64) },
  'decode-hub-code': { hubCode: 'synthetic-hub-code' },
  'join-hub': { hubCode: 'synthetic-hub-code', displayName: 'Person', confirmedHubId: 'hub-test', confirmedUrl: 'wss://hub.example.test/communication' },
  'update-hub-trust': {hubCode:'synthetic-code',confirmedHubId:'hub-test',confirmedUrl:'wss://hub.example.test/communication',confirmedTrustFingerprint:'a'.repeat(64)},
  'disconnect-hub': {hubId:'hub-test'},
  'leave-hub':{hubId:'hub-test',confirmedUrl:'wss://hub.example.test/communication',confirmLeave:true},
  'hub-leave-status':{hubId:'hub-test',confirmedUrl:'wss://hub.example.test/communication'},
  'forget-hub':{hubId:'hub-test',confirmedUrl:'wss://hub.example.test/communication',confirmForget:true,deleteLocalHistory:false},
  'switch-hub': {hubCode:'synthetic-code',displayName:'Person',expectedCurrentHubId:'old-hub',confirmedHubId:'hub-test',confirmedUrl:'wss://hub.example.test/communication'},
  'resume-hub': {hubId:'hub-test',confirmedUrl:'wss://hub.example.test/communication',confirmResume:true},
  'onboarding-storage': { hubId: 'hub-test' }, 'hub-join-status': { hubId: 'hub-test' }, 'cancel-hub-join': { hubId: 'hub-test' },
  'user-code': {}, 'rotate-user-code': {}, 'request-contact': { userCode: 'synthetic-user-code', localBotIds: [] },
  'contact-requests': {}, 'contact-relations': {},
  'accept-contact': { requestId: 'request-test', expectedVersion: 1, localBotIds: ['worker'] },
  'reject-contact': { requestId: 'request-test', expectedVersion: 1 }, 'cancel-contact': { requestId: 'request-test', expectedVersion: 1 },
  'revoke-contact': { otherHumanPrincipalId: 'human:a:id', expectedVersion: 1 },
  'available-bots': {}, 'publish-bots': { localBotIds: ['worker'] },
  'relationship-memory': { localBotId: 'worker', conversationId: 'group', membershipEpoch: 'epoch' },
  'save-relationship-memory': { localBotId: 'worker', conversationId: 'group', membershipEpoch: 'epoch', subjectKind: 'group', topic: 'purpose', text: 'GroupX is the project development team.' },
  'forget-relationship-memory': { localBotId: 'worker', conversationId: 'group', membershipEpoch: 'epoch', id: 'a'.repeat(64) },
  'save-settings': { conversationId: 'group', expectedVersion: 2, membershipEpoch: 'epoch', title: 'Planning',
    routing: { mode: 'admin', adminBotPrincipalId: 'bot:a:id' },
    policies: [{ targetPrincipalId: 'bot:a:id', role: 'admin', speakingMode: 'active' }, { targetPrincipalId: 'human:a:id', speakingMode: 'speak' }] },
}
const capture = () => { let value = ''; return { write: chunk => { value += chunk }, get value() { return value } } }

test('file-only CLI sends validate bytes, preserve complete retry intent and never read a supplied path',async()=>{
 const bytes=Buffer.from('synthetic CLI file'),attachment={name:'note.txt',mime:'text/plain',size:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex'),data:bytes.toString('base64')}
 const input={conversationId:'group',text:'',attachments:[attachment]}
 const prepared=prepare('send',input)
 assert.deepEqual(prepared.request.attachments,[attachment])
 assert.deepEqual(prepare('retry',prepared.request).request,prepared.request)
 for(const extra of [{...attachment,data:'BAD'},{...attachment,path:'D:/private'},{...attachment,name:'../private'}])assert.throws(()=>prepare('send',{...input,attachments:[extra]}),{code:'INVALID_FIELD_attachments'})
})
async function mock(t, handler) {
  const server = createServer(async (req, res) => {
    let raw = ''
    for await (const chunk of req) raw += chunk
    await handler(req, res, JSON.parse(raw))
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve) }))
  return `http://127.0.0.1:${server.address().port}`
}

test('every CLI operation reaches its real local API endpoint and retains all supported fields', async t => {
  assert.deepEqual(Object.keys(requests).sort(),Object.keys(JSON.parse(help()).operations).sort(),'new commands require a real endpoint contract case')
  const seen = []
  const url = await mock(t, (req, res, body) => {
    assert.equal(req.url, '/api/communication')
    assert.equal(req.headers.cookie, 'test-session=synthetic')
    seen.push(body)
    res.setHeader('content-type', 'application/json')
    res.end(JSON.stringify({ ok: true, value: body.endpoint === 'state' ? { contacts: ['contact'], conversations: ['conversation'], invites: ['invite'], outbox: ['intent'] } : { accepted: body.endpoint } }))
  })
  for (const [operation, input] of Object.entries(requests)) {
    const prepared = prepare(operation, input)
    const result = await execute(prepared, { url, cookie: 'test-session=synthetic' })
    assert.equal(result.ok, true)
    assert.deepEqual(seen.at(-1), prepared.request)
    for (const [key, value] of Object.entries(input)) assert.deepEqual(result.request[key], value)
    if (operation === 'contacts') assert.deepEqual(result.value, ['contact'])
    if (operation === 'members') assert.deepEqual(result.value, { accepted: 'members' })
    if (operation === 'leave') assert.equal(result.request.targetPrincipalId, undefined)
  }
  assert.equal(seen.length, Object.keys(requests).length)
})

test('uncertain response preserves generated operation/message IDs for safe retry without automatic resend', async t => {
  let calls = 0
  const url = await mock(t, (_req, res) => { calls++; res.destroy() })
  for (const operation of ['send', 'create-group', 'leave', 'save-settings', 'profile-human', 'rotate-user-code', 'request-contact', 'accept-contact', 'reject-contact', 'cancel-contact', 'revoke-contact', 'join-hub', 'cancel-hub-join', 'publish-bots']) {
    const prepared = prepare(operation, requests[operation])
    const before = calls
    await assert.rejects(execute(prepared, { url, cookie: 'synthetic' }), error => {
      assert.equal(error.exitCode, 5)
      assert.deepEqual(error.request, prepared.request)
      assert.deepEqual(prepare('retry', error.request).request, prepared.request)
      return true
    })
    assert.equal(calls, before + 1)
  }
  assert.throws(() => prepare('retry', { endpoint: 'send', ...requests.send }), { code: 'RETRY_REQUIRES_ORIGINAL_ID' })
  assert.throws(() => prepare('retry', { endpoint: 'create-group', title: 'x' }), { code: 'RETRY_REQUIRES_ORIGINAL_ID' })
})

test('enrollment/contact/publication CLI requires explicit confirmations, scoped Bot IDs and current decision versions', async t => {
  const names = ['decode-hub-code', 'join-hub', 'onboarding-storage', 'hub-join-status', 'cancel-hub-join', 'user-code',
    'rotate-user-code', 'request-contact', 'contact-requests', 'contact-relations', 'accept-contact', 'reject-contact', 'cancel-contact', 'revoke-contact', 'available-bots', 'publish-bots']
  for (const name of names) {
    for (const field of ['actor', 'credential', 'cookie', 'privateKey', 'credentialRecord', 'sender']) {
      assert.throws(() => prepare(name, { ...requests[name], [field]: 'spoof' }))
    }
    assert.ok(JSON.parse(help()).operations[name])
  }
  for (const field of ['confirmedHubId', 'confirmedUrl', 'displayName', 'hubCode']) {
    const input = { ...requests['join-hub'] }; delete input[field]
    assert.throws(() => prepare('join-hub', input), { code: 'MISSING_REQUIRED_FIELD' })
  }
  for (const name of ['accept-contact', 'reject-contact', 'cancel-contact', 'revoke-contact']) {
    const input = { ...requests[name] }; delete input.expectedVersion
    assert.throws(() => prepare(name, input), { code: 'MISSING_REQUIRED_FIELD' })
    assert.throws(() => prepare(name, { ...requests[name], expectedVersion: -1 }))
  }
  for (const name of ['request-contact', 'accept-contact', 'publish-bots']) {
    for (const localBotIds of ['worker', [1], [''], ['worker', 'worker'], Array.from({ length: 101 }, (_, i) => String(i))]) {
      assert.throws(() => prepare(name, { ...requests[name], localBotIds }))
    }
    assert.deepEqual(prepare(name, { ...requests[name], localBotIds: [] }).request.localBotIds, [])
  }
  assert.deepEqual(prepare('onboarding-storage').request, { endpoint: 'onboarding-storage' })
  for (const name of ['join-hub', 'cancel-hub-join', 'publish-bots']) assert.equal(prepare(name, requests[name]).request.operationId, undefined)
  let count = 0
  const url = await mock(t, (_req, res, request) => {
    count++
    assert.deepEqual(request.localBotIds, [])
    assert.match(request.operationId, /^[a-f0-9-]{36}$/)
    res.end(JSON.stringify({ ok: true, value: { accepted: true } }))
  })
  const stdout = capture(), stderr = capture()
  assert.equal(await main(['request-contact'], { DSBOT_REMOTE_URL: url, DSBOT_REMOTE_COOKIE: 'human=synthetic' },
    Readable.from([JSON.stringify(requests['request-contact'])]), stdout, stderr), 0)
  assert.deepEqual(JSON.parse(stdout.value).value, { accepted: true })
  assert.equal(count, 1)
  assert.equal(stderr.value, '')
})

test('Human profile and public avatar use strict image/revision schemas without identity overrides', async t => {
  const profile = requests['profile-human']
  assert.equal(prepare('profile-human', { avatar: null }).request.avatar, null)
  assert.throws(() => prepare('profile-human', {}), { code: 'PROFILE_CHANGE_REQUIRED' })
  assert.throws(() => prepare('profile-human', { operationId: 'id' }), { code: 'PROFILE_CHANGE_REQUIRED' })
  for (const field of ['actor', 'sender', 'principalId', 'homeInstanceId']) {
    assert.throws(() => prepare('profile-human', { ...profile, [field]: 'spoof' }))
    assert.throws(() => prepare('profile-human', { avatar: { ...profile.avatar, [field]: 'spoof' } }))
  }
  for (const avatar of [{}, [], 'default', { image: 'http://example.invalid/photo.png' }, { image: 'C:\\photo.png' },
    { image: 'data:image/svg+xml;base64,PHN2Zz4=' }, { image: 'data:image/png;base64,AAAA' }, { image: profile.avatar.image + '=' },
    { image: 'data:image/png;base64,' + 'A'.repeat(160000) }]) {
    assert.throws(() => prepare('profile-human', { avatar }), { code: 'INVALID_FIELD_avatar' })
  }
  assert.equal(prepare('profile-human', { displayName: '中'.repeat(256) }).request.displayName.length, 256)
  assert.throws(() => prepare('profile-human', { displayName: '中'.repeat(257) }), { code: 'INVALID_FIELD_displayName' })
  const boundary = 'data:image/png;base64,' + Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), Buffer.alloc(119974)]).toString('base64')
  assert.equal(boundary.length, 159998)
  assert.equal(prepare('profile-human', { avatar: { image: boundary } }).request.avatar.image, boundary)
  for (const revision of [1, '', 'A'.repeat(64), 'a'.repeat(63)]) assert.throws(() => prepare('avatar', { ...requests.avatar, revision }))
  const url = await mock(t, (_req, res, request) => {
    assert.equal(request.endpoint, 'avatar')
    assert.deepEqual(request, { ...requests.avatar, endpoint: 'avatar' })
    res.end(JSON.stringify({ ok: true, value: { image: profile.avatar.image } }))
  })
  const stdout = capture(), stderr = capture()
  assert.equal(await main(['avatar'], { DSBOT_REMOTE_URL: url, DSBOT_REMOTE_COOKIE: 'human=synthetic' },
    Readable.from([JSON.stringify(requests.avatar)]), stdout, stderr), 0)
  assert.equal(JSON.parse(stdout.value).value.image, profile.avatar.image)
  assert.equal(stderr.value, '')
})

test('atomic settings validates every nested field and rejects empty/ambiguous policy changes before send', () => {
  const settings = requests['save-settings']
  for (const field of ['actor', 'author', 'sender', 'principalId', 'homeInstanceId', 'credential', '__proto__']) {
    const routing = JSON.parse(JSON.stringify({ mode: 'mentionsOnly' }).replace('}', `,"${field}":"spoof"}`))
    const policy = JSON.parse(JSON.stringify({ targetPrincipalId: 'bot:a:id', role: 'member' }).replace('}', `,"${field}":"spoof"}`))
    assert.throws(() => prepare('save-settings', { ...settings, routing }), { code: 'INVALID_FIELD_routing' })
    assert.throws(() => prepare('save-settings', { ...settings, policies: [policy] }), { code: 'INVALID_FIELD_policies' })
    assert.throws(() => prepare('save-settings', { ...settings, [field]: 'spoof' }))
  }
  for (const policies of [null, {}, [null], [{ targetPrincipalId: 'bot:a:id' }], [{ role: 'admin' }],
    [{ targetPrincipalId: 'bot:a:id', speakingMode: 'broadcast' }], [{ targetPrincipalId: 'bot:a:id', role: 'owner' }]]) {
    assert.throws(() => prepare('save-settings', { ...settings, policies }), { code: 'INVALID_FIELD_policies' })
  }
  for (const routing of [null, [], {}, { mode: 'broadcast' }, { mode: 'admin', adminBotPrincipalId: 1 }]) {
    assert.throws(() => prepare('save-settings', { ...settings, routing }), { code: 'INVALID_FIELD_routing' })
  }
  assert.throws(() => prepare('save-settings', { conversationId: 'group', expectedVersion: 2, policies: [] }), { code: 'SETTINGS_CHANGE_REQUIRED' })
  assert.throws(() => prepare('save-settings', { ...settings, policies: [settings.policies[0], settings.policies[0]] }), { code: 'DUPLICATE_POLICY_TARGET' })
  assert.throws(() => prepare('save-settings', { ...settings, expectedVersion: undefined }), { code: 'INVALID_FIELD_expectedVersion' })
  assert.throws(() => prepare('retry', { endpoint: 'save-settings', ...settings }), { code: 'RETRY_REQUIRES_ORIGINAL_ID' })
  const titleOnly = prepare('save-settings', { conversationId: 'group', expectedVersion: 2, title: 'New name', policies: [] })
  assert.equal(titleOnly.request.title, 'New name')
  const schema = JSON.parse(help('save-settings')).operations['save-settings']
  assert.deepEqual(schema.required, ['conversationId', 'expectedVersion'])
  assert.deepEqual(schema.fields.policies.items.required, ['targetPrincipalId'])
})

test('atomic settings real JSON stdin sends one complete Human request and returns its stable retry identity', async t => {
  let count = 0
  const url = await mock(t, (req, res, request) => {
    count++
    assert.equal(req.url, '/api/communication')
    assert.equal(request.endpoint, 'save-settings')
    for (const [key, value] of Object.entries(requests['save-settings'])) assert.deepEqual(request[key], value)
    assert.match(request.operationId, /^[0-9a-f-]{36}$/)
    res.end(JSON.stringify({ ok: true, value: { version: 3 } }))
  })
  const stdout = capture(), stderr = capture()
  assert.equal(await main(['save-settings', '--json'], { DSBOT_REMOTE_URL: url, DSBOT_REMOTE_COOKIE: 'human=synthetic' },
    Readable.from([JSON.stringify(requests['save-settings'])]), stdout, stderr), 0)
  assert.equal(count, 1)
  assert.equal(stderr.value, '')
  const result = JSON.parse(stdout.value)
  assert.equal(result.value.version, 3)
  assert.deepEqual(prepare('retry', result.request).request, result.request)
})

test('invalid fields, spoofed actors, missing fields and invalid enum/version fail before network', () => {
  for (const author of ['author', 'sender', 'senderId', 'principalId', 'homeInstanceId', 'responseToDeliveryId', 'cookie']) {
    assert.throws(() => prepare('send', { ...requests.send, [author]: 'spoof' }))
  }
  for (const [operation, input] of [['send', {}], ['state', []], ['unknown', {}], ['history', { conversationId: 'g', limit: 0 }],
    ['policy', { conversationId: 'g', targetPrincipalId: 'p', expectedVersion: 0 }],
    ['routing', { conversationId: 'g', mode: 'broadcast' }], ['read', { conversationId: 'g', seq: -1 }],
    ['transfer', { ...requests.transfer, expectedVersion: 1.5 }], ['send', { ...requests.send, clientCreatedAt: 'invalid' }]]) {
    assert.throws(() => prepare(operation, input))
  }
})

test('only explicit loopback origins receive cookies, redirect and auth failures never follow or leak', async () => {
  let calls = 0
  const fetchImpl = async () => { calls++; return new Response('', { status: 302, headers: { location: 'http://elsewhere.invalid' } }) }
  for (const url of ['https://example.com', 'http://localhost.evil', 'file:///tmp/local', 'http://user:password@localhost', 'http://localhost/?token=x', 'http://localhost/path']) {
    await assert.rejects(execute(prepare('state'), { url, cookie: 'synthetic', fetchImpl }), { exitCode: 3 })
  }
  assert.equal(calls, 0)
  await assert.rejects(execute(prepare('state'), { url: 'http://localhost', cookie: 'synthetic', fetchImpl }), { code: 'REDIRECT_REFUSED', exitCode: 3 })
  assert.equal(calls, 1)
  await assert.rejects(execute(prepare('state'), { url: 'http://localhost', cookie: 'bad\nheader', fetchImpl }), { code: 'SESSION_COOKIE_REQUIRED' })
})

test('API denials and ambiguous HTTP, timeout, JSON responses return stable bounded errors', async () => {
  for (const [response, code, exitCode] of [[new Response('', { status: 401 }), 'AUTHENTICATION_REJECTED', 3],
    [new Response('', { status: 503 }), 'HTTP_FAILURE_UNCERTAIN', 5], [new Response('not json'), 'NETWORK_OUTCOME_UNCERTAIN', 5],
    [Response.json({}), 'INVALID_RESPONSE_UNCERTAIN', 5], [Response.json({ ok: false, error: { code: 'NOT_MEMBER' } }), 'NOT_MEMBER', 4],
    [Response.json({ ok: false, error: { code: 'REQUEST_TIMEOUT' } }), 'REQUEST_TIMEOUT', 5]]) {
    await assert.rejects(execute(prepare('state'), { url: 'http://localhost', cookie: 'synthetic', fetchImpl: async () => response }), { code, exitCode })
  }
  await assert.rejects(execute(prepare('send', requests.send), { url: 'http://localhost', cookie: 'synthetic',
    fetchImpl: async (_url, options) => { assert.ok(options.signal); assert.equal(options.redirect, 'manual'); throw new Error('synthetic-secret') } }),
  { code: 'NETWORK_OUTCOME_UNCERTAIN', exitCode: 5 })
})

test('real stdin CLI contract separates stderr errors, validates config and redacts authentication', async t => {
  const cookie = 'test-session=never-print-this'
  const url = await mock(t, (_req, res) => { res.end(JSON.stringify({ ok: true, value: { maliciousEcho: cookie } })) })
  const stdout = capture(), stderr = capture()
  assert.equal(await main(['send', '--json'], { DSBOT_REMOTE_URL: url, DSBOT_REMOTE_COOKIE: cookie }, Readable.from([JSON.stringify(requests.send)]), stdout, stderr), 0)
  assert.doesNotMatch(stdout.value, /never-print-this/)
  assert.match(stdout.value, /REDACTED/)
  assert.equal(stderr.value, '')
  const bad = capture(), good = capture()
  assert.equal(await main(['send'], {}, Readable.from(['{bad']), good, bad), 2)
  assert.equal(good.value, '')
  assert.equal(JSON.parse(bad.value).error.code, 'INVALID_JSON')
  const missing = capture()
  assert.equal(await main(['state'], {}, Readable.from([]), capture(), missing), 3)
  assert.doesNotMatch(missing.value, /never-print-this/)
  assert.equal(await main(['state', '--cookie', cookie], {}, Readable.from([]), capture(), capture()), 2)
})

test('installed package includes executable and complete skill registered using the public DSH contract', async () => {
  const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url)))
  assert.equal(pkg.bin['dsbot-remote'], './bin/dsbot-remote.mjs')
  assert.ok(pkg.files.includes('bin/') && pkg.files.includes('skills/'))
  let skill
  install({ ctx: { inject: (_deps, callback) => callback({ skills: { register: value => { if (value.name === 'dsbot-remote') skill = value; return () => {} } } }), effect: () => {} } })
  assert.equal(skill.name, 'dsbot-remote')
  assert.equal(skill.source, 'bundled')
  assert.equal(skill.content.includes('---\nname:'), false)
  for (const operation of Object.keys(requests)) assert.ok(skill.content.includes(operation), operation)
  assert.equal(JSON.parse(help()).operations.members.required[0], 'conversationId')
  assert.ok((await readFile(skill.path, 'utf8')).startsWith('---'))
})

test('new-machine pairing guide is offline, unauthenticated, non-secret and includes both operator roles', async () => {
  for (const operation of ['pairing-guide', 'setup-guide']) {
    const output = capture(), error = capture()
    const unreadableInput = { isTTY: false, [Symbol.asyncIterator]: () => { throw new Error('must not read stdin') } }
    assert.equal(await main([operation], {}, unreadableInput, output, error), 0)
    const guide = JSON.parse(output.value).value
    assert.equal(guide.hubPeerToAppend.instanceId, guide.clientCommunication.instanceId)
    assert.equal(guide.hubPeerToAppend.credentialEnv, 'DSBOT_HUB_NEW_MACHINE_CREDENTIAL')
    assert.equal(guide.clientCommunication.credentialEnv, 'DSBOT_COMMUNICATION_CREDENTIAL')
    assert.ok(guide.clientCommunication.url.startsWith('wss://'))
    assert.ok(guide.steps.some(step => step.includes('four exact distinct principals')))
    assert.ok(guide.codeJoin.some(step => step.includes('confirmedHubId,confirmedUrl')))
    assert.ok(guide.codeJoin.some(step => step.includes('Invalid or rotated codes fail')))
    assert.doesNotMatch(JSON.stringify(guide), /no self-service pairing API exists/)
    assert.equal(error.value, '')
  }
})

test('packaged Electron skill and external Node CLI resolve outside asar while preserving source paths', async () => {
  const paths = remotePackagePaths(new URL('../fixtures/app.asar/node_modules/ds-bot/src/host/prompt.js', import.meta.url))
  assert.match(paths.cli, /app\.asar\.unpacked[\\/]node_modules[\\/]ds-bot[\\/]bin[\\/]dsbot-remote\.mjs$/)
  assert.match(paths.skill, /app\.asar\.unpacked[\\/]node_modules[\\/]ds-bot[\\/]skills[\\/]dsbot-remote[\\/]SKILL\.md$/)
  const builder = await readFile(new URL('../../app/electron-builder.yml', import.meta.url), 'utf8')
  for (const path of ['node_modules/ds-bot/office.js', 'node_modules/ds-bot/bin/**', 'node_modules/ds-bot/skills/**']) assert.ok(builder.includes(path))
  assert.ok((await readFile(remotePackagePaths().skill, 'utf8')).includes('Remote communication'))
})

test('only the explicitly named config is read and process authentication overrides that config', async t => {
  const seen = []
  const url = await mock(t, (req, res) => { seen.push(req.headers.cookie); res.end(JSON.stringify({ ok: true, value: {} })) })
  const path = join(tmpdir(), `dsbot-remote-${randomUUID()}.json`)
  await writeFile(path, JSON.stringify({ url, cookie: 'explicit-config=synthetic' }), { mode: 0o600 })
  t.after(() => unlink(path))
  for (const env of [{}, { DSBOT_REMOTE_COOKIE: 'process-env=synthetic' }]) {
    assert.equal(await main(['state', '--config', path], env, Readable.from([]), capture(), capture()), 0)
  }
  assert.deepEqual(seen, ['explicit-config=synthetic', 'process-env=synthetic'])
  assert.equal(await main(['state', '--config', path + '.missing'], {}, Readable.from([]), capture(), capture()), 3)
})

test('removed ownership recovery cannot be prepared or retried by CLI', () => {
  assert.throws(() => prepare('reclaim', { conversationId: 'old', expectedVersion: 2 }), /INVALID_OPERATION_OR_INPUT/)
  assert.throws(() => prepare('retry', { endpoint: 'reclaim', conversationId: 'old', expectedVersion: 2, operationId: 'old' }), /INVALID_OPERATION_OR_INPUT/)
})

test('CLI reconciles only a definite local reset-generation gate once with the exact original intent', async t => {
  const epoch = '00000000-0000-4000-8000-000000000001', seen = []
  const url = await mock(t, (req, res, body) => {
    seen.push(body)
    res.setHeader('content-type', 'application/json')
    if (body.endpoint === 'reset-status') return res.end(JSON.stringify({ ok: true, value: { pending: false, browserEpoch: epoch } }))
    if (req.headers['x-dsbot-browser-epoch'] !== epoch) return res.end(JSON.stringify({ ok: false, error: { code: 'COMMUNICATION_BROWSER_RESET_REQUIRED' } }))
    res.end(JSON.stringify({ ok: true, value: { accepted: true } }))
  })
  const prepared = prepare('send', requests.send), result = await execute(prepared, { url, cookie: 'synthetic-reset-cookie' })
  assert.equal(result.value.accepted, true)
  assert.equal(seen.length, 3); assert.deepEqual(seen[0], seen[2]); assert.deepEqual(seen[1], { endpoint: 'reset-status' })
  assert.deepEqual(result.request, prepared.request)
})

test('CLI never loops through a second reset-generation rejection or sends while reset is incomplete', async t => {
  let pending = true, count = 0
  const url = await mock(t, (_req, res, body) => {
    count++; res.setHeader('content-type', 'application/json')
    res.end(JSON.stringify(body.endpoint === 'reset-status' ? { ok: true, value: { pending, browserEpoch: '00000000-0000-4000-8000-000000000001' } } : { ok: false, error: { code: 'COMMUNICATION_BROWSER_RESET_REQUIRED' } }))
  })
  const prepared = prepare('send', requests.send)
  await assert.rejects(execute(prepared, { url, cookie: 'synthetic-reset-cookie' }), { code: 'COMMUNICATION_RESET_INCOMPLETE', exitCode: 4 })
  assert.equal(count, 2)
  pending = false; count = 0
  await assert.rejects(execute(prepared, { url, cookie: 'synthetic-reset-cookie' }), { code: 'COMMUNICATION_BROWSER_RESET_REQUIRED', exitCode: 4 })
  assert.equal(count, 3)
})

test('help describes native Bot ids and the string-to-object mention boundary beside each operation',()=>{
 const publish=JSON.parse(help('publish-bots'))
 assert.match(publish.version,/^V\d+\.\d+\.\d+$/)
 assert.match(publish.operations['publish-bots'].fieldDescriptions.localBotIds,/available-bots.*session-/)
 assert.match(JSON.parse(help('bot-dm-history')).operations['bot-dm-history'].fieldDescriptions.localBotId,/Not a global/)
 assert.match(JSON.parse(help('send')).operations.send.fieldDescriptions.mentions,/protocol \{principalId\}/)
})
