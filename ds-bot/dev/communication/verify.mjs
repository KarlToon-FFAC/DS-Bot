// P0 API probe, not a Hub or the final federated acceptance suite.
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'

const root = resolve(import.meta.dirname, '../../..')
const mode = process.argv[2] ?? 'initial'
if (!['initial', 'recovery'].includes(mode)) throw new Error('usage: node dev/communication/verify.mjs [initial|recovery]')
const reportFile = join(root, '.dsh-test-tools', 'p0-probe.json')
const calls = name => {
  try { return readFileSync(join(root, `.dsh-test-communication-${name}`, 'mock.jsonl'), 'utf8').trim().split('\n').filter(Boolean).length } catch (error) {
    if (error.code === 'ENOENT') return 0
    throw error
  }
}
async function client(name, port) {
  const log = readFileSync(join(root, `.dsh-test-communication-${name}`, 'web.log'), 'utf8')
  const url = log.match(new RegExp(`http://127\\.0\\.0\\.1:${port}/\\?token=[^\\s]+`))?.[0]
  assert.ok(url, 'isolated bench must have a login URL')
  const response = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(15000) })
  const cookie = response.headers.getSetCookie().map(value => value.split(';')[0]).join('; ')
  assert.ok(cookie, 'login must return its port-specific cookie')
  const teamResponse = await fetch(`http://127.0.0.1:${port}/api/bot`, {
    method: 'POST', headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({ endpoint: 'state' }), signal: AbortSignal.timeout(15000),
  })
  const team = await teamResponse.json()
  assert.equal(team.ok, true, 'real DS-Bot state must be available')
  assert.ok(team.value.bots.some(bot => bot.id === team.value.mainBotId && bot.name === 'Chief'))
  const api = async body => {
    const result = await fetch(`http://127.0.0.1:${port}/api/communication-probe`, {
      method: 'POST', headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify(body), signal: AbortSignal.timeout(60000),
    })
    const data = await result.json()
    assert.equal(data.ok, true, data.error)
    return data.value
  }
  const identity = await api({ operation: 'identity' })
  assert.equal(identity.botId, team.value.mainBotId, 'probe must bind the actual local Chief')
  return { api, identity }
}
const [a, b] = await Promise.all([client('a', 3101), client('b', 3102)])
assert.notEqual(a.identity.instanceId, b.identity.instanceId)
assert.notEqual(a.identity.humanId, b.identity.humanId)
assert.notEqual(a.identity.botId, b.identity.botId)
assert.equal(a.identity.displayName, b.identity.displayName)

if (mode === 'initial') {
  const runId = `p0-${randomUUID()}`
  const conversationId = `${runId}-a-k`
  const binding = await b.api({ operation: 'bind', conversationId })
  const other = await b.api({ operation: 'bind', conversationId: `${runId}-group` })
  assert.notEqual(binding.sessionIds[0], other.sessionIds[0])
  const input = { conversationId, messageId: `${runId}-message`, deliveryId: `${runId}-delivery`, text: `hello ${runId}` }
  await b.api({ operation: 'send', ...input })
  await b.api({ operation: 'wait', conversationId })
  const first = await b.api({ operation: 'inspect', ...input })
  assert.equal(first.input.status, 'admitted')
  assert.equal(first.outputs.length, 1, 'one completed final reply must be durably inspectable')
  assert.ok(first.outputs[0].parts.length)
  assert.equal(first.outputs[0].conversationId, conversationId)
  const beforeReplay = calls('b')
  assert.equal((await b.api({ operation: 'send', ...input })).status, 'admitted')
  await b.api({ operation: 'wait', conversationId })
  assert.equal(calls('b'), beforeReplay, 'retry must not call the model')
  const unrelated = await b.api({ operation: 'inspect', ...input, conversationId: other.conversationId })
  assert.equal(unrelated.input.status, 'absent')
  assert.equal(unrelated.outputs.length, 0)

  const steering = { ...input, conversationId: other.conversationId,
    messageId: `${runId}-steer-message`, deliveryId: `${runId}-steer-delivery`, text: `steer ${runId}` }
  await b.api({ operation: 'send', mode: 'steer', ...steering })
  await b.api({ operation: 'wait', conversationId: other.conversationId })
  assert.equal((await b.api({ operation: 'inspect', ...steering })).input.status, 'admitted')
  assert.deepEqual(await b.api({ operation: 'inspect', ...input }), first,
    'steering another conversation must not change the original receipt or reply')

  // Retain the earlier segment in the binding and inspect its reply from the new segment.
  const segmented = await b.api({ operation: 'segment', conversationId })
  assert.equal(segmented.sessionIds.length, 2)
  const afterSegment = await b.api({ operation: 'inspect', ...input })
  assert.deepEqual(afterSegment, first)

  const queued = { conversationId: `${runId}-queued`, messageId: `${runId}-queued-message`, deliveryId: `${runId}-queued-delivery`, text: 'queued without waking' }
  await a.api({ operation: 'bind', conversationId: queued.conversationId })
  const beforeQueue = calls('a')
  assert.equal((await a.api({ operation: 'send', mode: 'queue', ...queued })).status, 'queued')
  assert.equal(calls('a'), beforeQueue, 'durable queue insertion must not wake a model')
  const report = { runId, platform: process.platform, node: process.version, dsh: '0.2.1-rc.4',
    a: a.identity, b: b.identity, input, queued, first, counts: { a: calls('a'), b: calls('b') },
    initial: 'PASS', recovery: 'NOT_RUN', network: 'loopback', hub: 'NOT_IMPLEMENTED' }
  writeFileSync(reportFile, JSON.stringify(report, null, 2) + '\n')
  console.log('PASS P0: two independent DSH identities; exact Session/source receipt; duplicate retry; durable final output; prior-segment scan; queue without model wake.')
  console.log('Stop and restart both benches with the same data, then run verify.mjs recovery.')
} else {
  const report = JSON.parse(readFileSync(reportFile, 'utf8'))
  assert.deepEqual(a.identity, report.a)
  assert.deepEqual(b.identity, report.b)
  assert.deepEqual(await b.api({ operation: 'inspect', ...report.input }), report.first)
  const queued = await a.api({ operation: 'inspect', ...report.queued })
  assert.equal(queued.input.status, 'queued', 'cold history must retain pending input after process loss')
  assert.deepEqual({ a: calls('a'), b: calls('b') }, report.counts, 'cold inspection must not activate models')
  report.recovery = 'PASS'
  writeFileSync(reportFile, JSON.stringify(report, null, 2) + '\n')
  console.log('PASS P0 recovery: same identities, admitted input and stable final output after process restart; original pending inbox preserved; zero additional model calls.')
}
