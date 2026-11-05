// Real isolated DSH A/B, Hub and deterministic Mock. No production credentials.
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { createServer } from 'node:net'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { LocalTopology, until } from './local-topology.mjs'
import { recoveryMarkerPath } from './recovery-marker.mjs'

const nonce = randomUUID().slice(0, 8), topology = new LocalTopology({ prefix: `recovery-rpc-${nonce}`, webPort: 3271, mockPort: 8971, hubPort: 3273 })
const selected = process.argv.find(value => value.startsWith('--case='))?.slice(7)
const names = selected ? [selected] : ['reconnect', 'revoked', 'new-epoch', 'user-cancel', 'model-error']
for (const name of names) assert.ok(['reconnect', 'revoked', 'new-epoch', 'user-cancel', 'model-error'].includes(name))
const evidence = { status: 'RUNNING', baseline: 'da47b17 plus test-only fixture changes', platform: process.platform,
  network: 'independent DSH A/B and persistent Hub on loopback', model: 'local deterministic Mock only', cases: [] }
const output = join(topology.root, `${topology.prefix}-acceptance.json`), proofs = new Map()
const save = () => writeFileSync(output, JSON.stringify(evidence, null, 2))
const callsFor = (peer, sessionId) => readFileSync(join(peer.home, 'mock.jsonl'), 'utf8').split('\n').filter(Boolean).map(JSON.parse).filter(call => call.session === sessionId)
const callCount = (peer, sessionId) => callsFor(peer, sessionId).length
const inspect = (peer, conversationId) => peer.client.api({ operation: 'production-state', conversationId })
const originalInputs = (state, messageId) => state.sessions.flatMap(session => session.events).filter(event => event.type === 'user/message'
  && event.data.source?.kind === 'ds-bot-communication' && event.data.source.messageId === messageId)
const ends = state => state.sessions.flatMap(session => session.events).filter(event => event.type === 'turn/end').map(event => ({ turn: event.data.turn, kind: event.data.reason?.kind }))
const localRow = (peer, sql, ...args) => { const db = topology.db(peer); try { return db.prepare(sql).get(...args) } finally { db.close() } }
const epoch = (peer, conversationId) => localRow(peer, 'SELECT epoch FROM memberships WHERE conversation_id=? AND principal_id=?', conversationId, peer.bot)?.epoch
const identity = peer => ({ instanceId: peer.instanceId, human: peer.human, bot: peer.bot })
const bench = topology.bench.bind(topology)
topology.bench = (peer, action, extra = {}) => bench(peer, action, { ...extra, DSBOT_COMMUNICATION_OWNER_PID: String(process.pid), DSBOT_WEB_OPEN: '0' })
const free = port => new Promise((resolve, reject) => { const server = createServer(); server.once('error', reject); server.listen(port, '127.0.0.1', () => server.close(resolve)) })
const deadline = setTimeout(() => { console.error('Recovery prompt RPC acceptance deadline exceeded'); void topology.close().finally(() => process.exit(1)) }, 15 * 60 * 1000)

async function reconnectAndReconcile(peer) {
  const previous = (await topology.hub('stats')).instances.find(row => row.id === peer.instanceId).epoch
  await topology.hub('disconnect', { instanceId: peer.instanceId })
  await until(async () => (await topology.hub('stats')).instances.find(row => row.id === peer.instanceId).epoch > previous, 'fresh connection after explicit socket loss')
  await until(async () => { const state = await peer.api({ endpoint: 'state' }); return state.connected && state.transport?.state === 'ready' }, 'new connection finishes canonical reconciliation')
}

async function run(name) {
  const [a, b] = topology.peers, beforeIdentity = identity(b)
  const conversationId = await topology.group(`Prompt RPC ${name} ${nonce}`, [b.bot])
  const membershipEpoch = await until(() => epoch(b, conversationId), 'recipient projects the current membership epoch')
  const membershipVersion = JSON.parse(localRow(b, 'SELECT body FROM memberships WHERE conversation_id=? AND principal_id=?', conversationId, b.bot).body).membershipVersion
  if (name === 'model-error') {
    const sent = await topology.send(a, conversationId, `COMM-MODEL-ERROR model-error-${nonce}`, [b.bot])
    const settled = await until(async () => { const state = await inspect(b, conversationId); return ends(state).some(end => end.kind === 'error' || end.kind === 'failed') && state }, 'an actual Mock provider request rejects and ends the turn')
    const sessionId = settled.sessions[0].sessionId, calls = callCount(b, sessionId)
    const requestHeaders = settled.sessions.flatMap(session => session.events).filter(event => event.type === 'request/header').map(event => event.seq)
    assert.ok(requestHeaders.length > 0, 'the error occurred after a real DSH model request header, not local admission')
    assert.equal(calls, 1); assert.equal(callsFor(b, sessionId).filter(call => call.fail === true).length, 1)
    assert.equal(settled.exports.length, 0)
    await reconnectAndReconcile(b); await reconnectAndReconcile(b)
    await topology.bench(b, 'stop'); await topology.startPeer(b)
    assert.equal(callCount(b, sessionId), calls, 'a provider error must not become a transport retry')
    assert.equal(originalInputs(await inspect(b, conversationId), sent.messageId).length, 1)
    return { originalMessageId: sent.messageId, conversationId, requestHeaders, providerErrorRequests: 1, modelRequests: calls, retryRequests: 0, terminalKinds: ends(settled) }
  }

  await b.client.api({ operation: 'production-hold', point: 'after-injection', conversationId })
  const tag = `rpc-${name}-${nonce}`, sent = await topology.send(a, conversationId, `COMM-DELAY-ECHO 5000 ${tag}`, [b.bot])
  const admitted = await until(async () => {
    const state = await inspect(b, conversationId), session = state.sessions[0]
    return state.checkpoints.some(point => point.point === 'after-injection') && originalInputs(state, sent.messageId).length === 1
      && session && callCount(b, session.sessionId) === 1 && state
  }, 'original input is admitted with exactly one Mock attempt in flight')
  const sessionId = admitted.sessions[0].sessionId, deliveryId = admitted.inbox.find(row => row.ai).delivery_id
  assert.equal(admitted.exports.length, 0)
  await topology.bench(b, 'stop')
  const markerPath = recoveryMarkerPath(b.home, conversationId)
  assert.equal(existsSync(markerPath), false, 'no old notice may select the fault window')
  await topology.hub('arm', { point: 'recovery-prompt-rpc', principalId: b.bot, conversationId, deliveryId, messageId: sent.messageId, markerPath, remaining: name === 'reconnect' ? 2 : 1, faultIndex: 1 })
  await topology.startPeer(b, {}, { allowOffline: true })
  const fault = await until(() => {
    try { const value = JSON.parse(readFileSync(join(topology.root, `${topology.prefix}-hub-checkpoint.json`), 'utf8')); return value.point === 'recovery-prompt-rpc' && value.messageId === sent.messageId && value.faultIndex === 1 && value }
    catch { return false }
  }, 'a real recovery notice is followed by an in-flight prompt membership RPC')
  assert.equal(fault.deliveryId, deliveryId); assert.equal(fault.sessionId, sessionId)
  assert.equal(fault.rpcType, 'conversation.members'); assert.equal(fault.socketOpen, true); assert.equal(fault.responseSent, false)
  assert.equal(fault.phase, 'assembling', 'the exact recovered Session is still inside the public prompt assembly waterfall')
  const faults = [fault]
  proofs.set(name, { conversationId, originalMessageId: sent.messageId, deliveryId, membershipEpoch, sessionId, faults })
  const held = await inspect(b, conversationId)
  assert.ok(ends(held).some(end => end.kind === 'interrupted'), 'the original loss is interrupted, never a user cancellation')
  assert.ok(held.sessions.flatMap(session => session.events).some(event => event.seq === fault.seq && event.type === 'agent/inbox/spliced'
    && event.data.inserted.some(message => message.id === fault.noticeId && message.source?.forDeliveryId === deliveryId)), 'marker is backed by the actual public Session journal')
  assert.equal(callCount(b, sessionId), 1, 'the failed recovery has not called the model')

  if (name === 'user-cancel') {
    assert.equal((await b.client.api({ operation: 'production-cancel', conversationId, sessionId })).cancellationRequested, true)
  }
  if (name === 'revoked' || name === 'new-epoch') {
    await topology.operation(a, 'remove', { conversationId, targetPrincipalId: b.bot })
    if (name === 'new-epoch') {
      const invite = await topology.operation(a, 'invite', { conversationId, inviteePrincipalId: b.bot })
      // The test IPC uses the same canonical store acceptance API with the current
      // synthetic recipient auth; no production permission or Session is patched.
      await topology.hub('accept-scoped-invite', { instanceId: b.instanceId, principalId: b.bot, inviteId: invite.inviteId })
      const current = await until(async () => { const member = (await a.api({ endpoint: 'state' })).conversations.find(row => row.conversationId === conversationId); return member?.membershipVersion >= membershipVersion + 2 && member.info?.members.some(row => row.principalId === b.bot) && member.info.membershipVersion === member.membershipVersion && member }, 'owner observes the fresh canonical membership')
      await topology.operation(a, 'policy', { conversationId, targetPrincipalId: b.bot, expectedVersion: current.membershipVersion, speakingMode: 'active' })
    }
  }
  await topology.hub('disconnect-prompt-rpc')

  if (name === 'reconnect') {
    const second = await until(() => {
      try { const value = JSON.parse(readFileSync(join(topology.root, `${topology.prefix}-hub-checkpoint.json`), 'utf8')); return value.point === 'recovery-prompt-rpc' && value.messageId === sent.messageId && value.faultIndex === 2 && value }
      catch { return false }
    }, 'a second distinct recovery notice reaches the same exact pre-request fault window')
    assert.notEqual(second.noticeId, fault.noticeId)
    assert.equal(second.sessionId, sessionId); assert.equal(second.deliveryId, deliveryId)
    assert.equal(second.phase, 'assembling'); assert.equal(second.socketOpen, true); assert.equal(second.responseSent, false)
    const twiceHeld = await inspect(b, conversationId)
    assert.ok(twiceHeld.sessions.flatMap(session => session.events).some(event => event.seq === second.seq && event.type === 'agent/inbox/spliced'
      && event.data.inserted.some(message => message.id === second.noticeId && message.source?.forDeliveryId === deliveryId)))
    assert.equal(callCount(b, sessionId), 1, 'neither failed prompt authorization attempt may call the model')
    faults.push(second); save()
    await topology.hub('disconnect-prompt-rpc')
    await until(() => topology.hasText(a, conversationId, `Communication reply ${tag}`), 'authorization-only recovery failure leaves a future legitimate resume available', 60000)
    const restored = await inspect(b, conversationId)
    assert.equal(originalInputs(restored, sent.messageId).length, 1)
    assert.equal(restored.exports.length, 1)
    const finalMessageId = restored.exports[0].message_id
    assert.equal((await topology.history(a, conversationId)).events.filter(event => event.message?.content.text === `Communication reply ${tag}`).length, 1)
    assert.equal(callCount(b, sessionId), 2, 'one lost original request and one successful resumed request')
    await topology.bench(b, 'stop'); await topology.startPeer(b)
    await reconnectAndReconcile(b)
    const reopened = await inspect(b, conversationId)
    assert.deepEqual(reopened.exports.map(row => row.message_id), [finalMessageId])
    assert.equal(originalInputs(reopened, sent.messageId).length, 1); assert.equal(callCount(b, sessionId), 2)
    assert.equal(epoch(b, conversationId), membershipEpoch); assert.deepEqual(identity(b), beforeIdentity)
    return { conversationId, originalMessageId: sent.messageId, deliveryId, membershipEpoch, finalMessageId, logicalInputs: 1, finalMessages: 1, modelRequests: 2, faults, terminalKinds: ends(reopened) }
  }

  await until(async () => {
    const state = await inspect(b, conversationId)
    if (name === 'user-cancel') return ends(state).some(end => ['aborted', 'cancelled'].includes(end.kind)) && state
    return state.inbox.some(row => row.delivery_id === deliveryId && row.revoked) && state
  }, 'explicit cancellation or revoked original scope becomes terminal')
  await reconnectAndReconcile(b); await reconnectAndReconcile(b)
  await topology.bench(b, 'stop'); await topology.startPeer(b)
  const terminal = await inspect(b, conversationId)
  assert.equal(callCount(b, sessionId), 1, 'forbidden recovery never reaches a model request')
  assert.equal(terminal.exports.length, 0); assert.equal(originalInputs(terminal, sent.messageId).length, 1)
  if (name === 'new-epoch') assert.notEqual(epoch(b, conversationId), membershipEpoch)
  assert.deepEqual(identity(b), beforeIdentity)
  const stats = await topology.hub('stats')
  assert.equal(stats.messages.filter(row => row.conversation_id === conversationId && row.author_id === b.bot).length, 0)
  let freshScopeControl
  if (name === 'new-epoch') {
    const fresh = await topology.send(a, conversationId, `COMM-ECHO fresh-epoch-${nonce}`, [b.bot])
    await until(() => topology.hasText(a, conversationId, `Communication reply fresh-epoch-${nonce}`), 'a new explicitly authorized input still works in the fresh epoch')
    assert.equal(callCount(b, sessionId), 1, 'the fresh epoch never reuses the old Session')
    freshScopeControl = { messageId: fresh.messageId, replyCount: (await topology.history(a, conversationId)).events.filter(event => event.message?.content.text === `Communication reply fresh-epoch-${nonce}`).length }
    assert.equal(freshScopeControl.replyCount, 1)
  }
  return { ...(freshScopeControl ? { freshScopeControl } : {}), conversationId, originalMessageId: sent.messageId, deliveryId, originalMembershipEpoch: membershipEpoch, logicalInputs: 1, finalMessages: 0, modelRequests: 1, faults, terminalKinds: ends(terminal) }
}

try {
  for (const port of [3271, 3272, 3273, 8971, 8972]) await free(port)
  await topology.initialize()
  for (const name of names) {
    try { const detail = await run(name); evidence.cases.push({ id: name, status: 'PASS', ...detail }); console.log(`PASS ${name}`) }
    catch (error) { evidence.cases.push({ id: name, status: 'FAIL', ...proofs.get(name), error: error.code ?? error.message }); console.error(`FAIL ${name}: ${error.code ?? error.message}`); process.exitCode = 1 }
    save()
  }
  evidence.status = evidence.cases.every(row => row.status === 'PASS') ? 'PASS' : 'FAIL'
} catch (error) { evidence.status = 'FAIL'; evidence.error = error.code ?? error.message; process.exitCode = 1 }
finally { clearTimeout(deadline); await topology.close(); evidence.ownedProcessesStopped = true; save(); console.log(`Evidence: .dsh-test-tools/${topology.prefix}-acceptance.json`) }
