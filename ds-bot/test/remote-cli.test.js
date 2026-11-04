import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createServer } from 'node:http'
import { Readable } from 'node:stream'
import { readFile, writeFile, unlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { prepare, execute, main, help } from '../bin/dsbot-remote.mjs'
import { install, remotePackagePaths } from '../src/host/prompt.js'

const requests = {
  state: {}, contacts: {}, conversations: {}, invites: {}, outbox: {}, members: { conversationId: 'group' },
  history: { conversationId: 'group', after: 1, before: 20, limit: 10, latest: false, membershipEpoch: 'epoch' },
  reference: { conversationId: 'group', messageId: 'message' }, read: { conversationId: 'group', seq: 5 },
  send: { conversationId: 'group', text: 'Hello @all', mentions: ['bot:a:id'], replyToMessageId: 'previous' },
  dm: { otherPrincipalId: 'human:a:id' }, 'create-group': { title: 'Group' },
  invite: { conversationId: 'group', inviteePrincipalId: 'bot:a:id', expectedVersion: 2, membershipEpoch: 'epoch' },
  accept: { inviteId: 'invite', recipientPrincipalId: 'bot:local:id' },
  remove: { conversationId: 'group', targetPrincipalId: 'bot:a:id' }, leave: { conversationId: 'group' },
  routing: { conversationId: 'group', mode: 'admin', adminBotPrincipalId: 'bot:a:id' },
  policy: { conversationId: 'group', targetPrincipalId: 'bot:a:id', expectedVersion: 2, speakingMode: 'active', role: 'admin' },
  transfer: { conversationId: 'group', targetPrincipalId: 'bot:a:id', expectedVersion: 2 },
  reclaim: { conversationId: 'group', expectedVersion: 2 }, dissolve: { conversationId: 'group' },
  'configure-group': { conversationId: 'group', expectedVersion: 2, title: 'New name' }, 'rename-human': { displayName: 'Human' },
}
const capture = () => { let value = ''; return { write: chunk => { value += chunk }, get value() { return value } } }
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
  for (const operation of ['send', 'create-group', 'leave']) {
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
