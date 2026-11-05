import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createServer } from 'node:http'
import { Readable } from 'node:stream'
import { readFile } from 'node:fs/promises'
import { main, prepareTeam } from '../bin/dsbot-team.mjs'
import { execute } from '../bin/dsbot-remote.mjs'
import { install } from '../src/host/prompt.js'
import { MEMORY_LIMITS } from '../src/shared/memory-limits.js'

const capture = () => { let value = ''; return { write: chunk => { value += chunk }, get value() { return value } } }
async function mock(t, handler) {
  const server = createServer(async (req, res) => {
    let raw = ''
    for await (const chunk of req) raw += chunk
    handler(req, res, JSON.parse(raw))
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve) }))
  return `http://127.0.0.1:${server.address().port}`
}

test('team CLI uses only the authenticated Human local API; workspace fields and read-only memory flags are exact', async t => {
  const seen = []
  const url = await mock(t, (req, res, request) => {
    assert.equal(req.url, '/api/bot')
    assert.equal(req.headers.cookie, 'human-session=synthetic')
    seen.push(request)
    res.end(JSON.stringify({ ok: true, value: { actualActor: 'Human' } }))
  })
  for (const [operation, input] of [['state', {}], ['set-workspace', { id: 'bot-local-id', workDir: 'D:/example' }],
    ['set-workspace', { id: 'bot-local-id', workDir: '' }], ['memory-view', { botId: 'bot-local-id' }], ['memory-view', { roomId: 'group-local-id' }]]) {
    const stdout = capture(), stderr = capture()
    assert.equal(await main([operation, '--json'], { DSBOT_TEAM_URL: url, DSBOT_TEAM_COOKIE: 'human-session=synthetic' }, Readable.from([JSON.stringify(input)]), stdout, stderr), 0)
    assert.deepEqual(seen.at(-1), prepareTeam(operation, input).request)
    assert.equal(JSON.parse(stdout.value).value.actualActor, 'Human')
    assert.equal(stderr.value, '')
  }
  assert.deepEqual(seen[1], { endpoint: 'update-bot', payload: { id: 'bot-local-id', workDir: 'D:/example' } })
  assert.equal(seen[3].payload.summarize, false)
  assert.equal(seen[3].payload.regenerate, false)
})

test('team CLI refuses actor injection, target confusion, model and permission changes before request', () => {
  for (const key of ['actorId', 'actor', 'sender', 'author', 'principalId', 'permission', 'model', 'private', 'cookie']) {
    assert.throws(() => prepareTeam('set-workspace', { id: 'b', workDir: '', [key]: 'spoof' }), { code: 'INVALID_FIELD' })
  }
  for (const input of [{}, { botId: 'b', roomId: 'g' }, { botId: 'b', summarize: true }]) assert.throws(() => prepareTeam('memory-view', input))
  for (const input of [{ id: 'b' }, { workDir: 'D:/example' }, { id: 'b', workDir: null }]) assert.throws(() => prepareTeam('set-workspace', input))
})

test('team CLI shares destination/redirect/timeout protection and reports uncertainty without resending or echoing auth', async t => {
  const cookie = 'team-session=never-print-this'
  let calls = 0
  const url = await mock(t, (_req, res) => { calls++; res.destroy() })
  const stdout = capture(), stderr = capture()
  assert.equal(await main(['set-workspace'], { DSBOT_TEAM_URL: url, DSBOT_TEAM_COOKIE: cookie },
    Readable.from(['{"id":"bot","workDir":"D:/example"}']), stdout, stderr), 5)
  assert.equal(calls, 1)
  assert.equal(stdout.value, '')
  assert.doesNotMatch(stderr.value, /never-print-this/)
  assert.deepEqual(JSON.parse(stderr.value).request, { endpoint: 'update-bot', payload: { id: 'bot', workDir: 'D:/example' } })
  for (const value of ['https://other-machine.invalid', 'http://localhost/other-path']) {
    assert.equal(await main(['state'], { DSBOT_TEAM_URL: value, DSBOT_TEAM_COOKIE: cookie }, Readable.from([]), capture(), capture()), 3)
  }
  await assert.rejects(execute(prepareTeam('state'), { url, cookie, apiPath: '/api/arbitrary' }), { code: 'LOCAL_API_REQUIRED' })
})

test('team memory capacity is offline and preserves all non-main limits and the historic Unicode measure', async () => {
  const stdout = capture()
  const unreadableInput = { [Symbol.asyncIterator]: () => { throw new Error('must remain offline') } }
  assert.equal(await main(['memory-capacity'], {}, unreadableInput, stdout, capture()), 0)
  const value = JSON.parse(stdout.value).value
  assert.deepEqual(value.limits, MEMORY_LIMITS)
  assert.deepEqual(value.limits, { entry: 300, main: 10000, topic: 16000, topics: 40 })
  assert.match(value.measure, /UTF-16/)
})

test('team CLI and Skill are shipped, discovered via the public registry, and external Node shared limits are unpacked', async () => {
  const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
  assert.equal(pkg.bin['dsbot-team'], './bin/dsbot-team.mjs')
  const skills = new Map()
  install({ ctx: { inject: (_deps, callback) => callback({ skills: { register: value => { skills.set(value.name, value); return () => {} } } }), effect: () => {} } })
  const skill = skills.get('dsbot-team')
  assert.ok(skill)
  assert.match(skill.content, /10,000/)
  assert.match(skill.content, /16,000/)
  assert.match(skill.content, /authenticated local Human only/)
  const builder = await readFile(new URL('../../app/electron-builder.yml', import.meta.url), 'utf8')
  assert.ok(builder.includes('node_modules/ds-bot/src/shared/memory-limits.js'))
  assert.ok(skills.has('dsbot-remote'))
})
