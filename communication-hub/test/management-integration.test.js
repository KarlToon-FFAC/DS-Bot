import assert from 'node:assert/strict'
import { test } from 'node:test'
import { generateKeyPairSync, randomUUID, sign } from 'node:crypto'
import WebSocket from 'ws'
import { startHub } from '../src/server.js'
import { CAPABILITIES, PROTOCOL } from '../src/protocol.js'
import { enrollmentTranscript } from '../src/management-store.js'

async function client(url) {
  const socket = new WebSocket(url), calls = new Map()
  socket.on('error', () => {})
  socket.on('message', raw => {
    const result = JSON.parse(raw.toString()), call = calls.get(result.id)
    if (!call) return
    calls.delete(result.id); clearTimeout(call.timer)
    if (result.ok) call.resolve(result.value)
    else call.reject(Object.assign(new Error(result.error.code), { code: result.error.code }))
  })
  socket.on('close', () => { for (const call of calls.values()) { clearTimeout(call.timer); call.reject(new Error('CONNECTION_LOST')) }; calls.clear() })
  await new Promise((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject) })
  return { close: () => socket.terminate(), request: (type, payload) => new Promise((resolve, reject) => {
    const id = randomUUID(), timer = setTimeout(() => { calls.delete(id); reject(new Error('TIMEOUT')) }, 3000)
    calls.set(id, { resolve, reject, timer }); socket.send(JSON.stringify({ protocol: PROTOCOL, id, type, payload }))
  }) }
}

test('actual HTTP approval, signed socket login, Human assignment and scoped contacts are integrated', async t => {
  const hub = await startHub({ databasePath: ':memory:', peers: [], port: 0, management: { enabled: true, password: 'mock-administrator-password-for-local-test' } })
  t.after(() => hub.close())
  const origin = `http://127.0.0.1:${hub.port}`
  const info = await (await fetch(origin + '/hub-info')).json()
  assert.ok(info.code.startsWith('dsbot-hub:1:'))
  const loginResponse = await fetch(origin + '/admin/api/login', { method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify({ password: 'mock-administrator-password-for-local-test' }) })
  const { csrf } = await loginResponse.json(), cookie = loginResponse.headers.getSetCookie()[0].split(';')[0]
  const admin = async (action, input) => {
    const response = await fetch(origin + '/admin/api/' + action, { method: 'POST', headers: { origin, cookie, 'x-csrf-token': csrf, 'content-type': 'application/json' }, body: JSON.stringify(input) })
    const result = await response.json(); assert.equal(result.ok, true, result.error?.code); return result.value
  }
  const enrolled = []
  for (const name of ['Alice', 'Bob']) {
    const pair = generateKeyPairSync('ed25519'), publicKey = pair.publicKey.export({ format: 'pem', type: 'spki' })
    const pending = await client(hub.url); t.after(pending.close)
    const challenge = await pending.request('enrollment.challenge', { purpose: 'join', publicKey })
    const proof = sign(null, Buffer.from(enrollmentTranscript(challenge)), pair.privateKey).toString('base64url')
    const requested = await pending.request('enrollment.prove', { challengeId: challenge.challengeId, signature: proof, displayName: name })
    const row = (await admin('state', {})).requests.find(item => item.requestId === requested.requestId)
    const approved = await admin('decide', { requestId: row.requestId, expectedVersion: row.version, action: 'approve' })
    pending.close()
    const signed = await client(hub.url); t.after(signed.close)
    const auth = await signed.request('enrollment.challenge', { purpose: 'login', instanceId: approved.instanceId })
    const welcome = await signed.request('enrollment.prove', { challengeId: auth.challengeId, signature: sign(null, Buffer.from(enrollmentTranscript(auth)), pair.privateKey).toString('base64url'), capabilities: CAPABILITIES })
    assert.equal(welcome.hubId, info.hubId)
    const human = await signed.request('principal.register', { localId: 'local-user', kind: 'human', displayName: name })
    assert.equal(human.principalId, `human:${welcome.instanceId}:local-user`)
    enrolled.push({ signed, human: human.principalId, instanceId: welcome.instanceId })
  }
  const [a, b] = enrolled
  assert.deepEqual((await a.signed.request('contacts.list', {})).map(item => item.principalId), [a.human])
  await assert.rejects(a.signed.request('dm.open', { principalId: a.human, otherPrincipalId: b.human, operationId: randomUUID() }), { code: 'CONTACT_REQUIRED' })
  const code = await b.signed.request('contact.code', { principalId: b.human })
  await a.signed.request('contact.request', { principalId: a.human, userCode: code.userCode, operationId: randomUUID(), botPrincipalIds: [] })
  const incoming = (await b.signed.request('contact.requests', { principalId: b.human })).find(item => item.direction === 'incoming')
  await b.signed.request('contact.accept', { principalId: b.human, requestId: incoming.requestId, expectedVersion: incoming.version, operationId: randomUUID(), botPrincipalIds: [] })
  assert.equal((await a.signed.request('contacts.list', {})).length, 2)
  assert.ok((await a.signed.request('dm.open', { principalId: a.human, otherPrincipalId: b.human, operationId: randomUUID() })).conversationId)
  await assert.rejects(a.signed.request('contacts.list', { principalId: b.human }), { code: 'AUTHOR_MISMATCH' })
})
