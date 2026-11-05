import assert from 'node:assert/strict'
import { test } from 'node:test'
import { randomUUID, randomBytes } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { HubStore } from '../src/store.js'
import { HubManagement } from '../src/management-store.js'
import { startHub } from '../src/server.js'
import { CAPABILITIES, normalizePublicProfile, responseBytes } from '../src/protocol.js'
import { avatarRevision } from '../src/avatars.js'
import { CommunicationQueue } from '../../ds-bot/src/host/federation/queue-store.js'
import { CommunicationTransport } from '../../ds-bot/src/host/federation/transport.js'

const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aV2kAAAAASUVORK5CYII='
const profile = { headline: '测试负责人', summary: '负责测试与回归验收', expertise: ['测试', 'QA'], languages: ['中文'] }
const update = (principalId, expectedVersion = 0, value = profile) => ({ principalId, operationId: randomUUID(), expectedVersion, profile: value })

function fixture(t, disk = false) {
  const directory = disk && mkdtempSync(join(tmpdir(), 'dsbot-public-profile-'))
  const f = { path: directory ? join(directory, 'hub.sqlite') : ':memory:' }
  f.store = new HubStore(f.path)
  t.after(() => { f.store.close(); if (directory) rmSync(directory, { recursive: true, force: true }) })
  f.a = f.store.connect('a', 'Device A', CAPABILITIES)
  f.b = f.store.connect('b', 'Device B', CAPABILITIES)
  f.human = f.store.register(f.a, { kind: 'human', localId: 'owner', displayName: 'Buddy' }).principalId
  f.bot = f.store.register(f.a, { kind: 'bot', localId: 'tester', displayName: 'Tester' }).principalId
  f.other = f.store.register(f.b, { kind: 'human', localId: 'owner', displayName: 'Other' }).principalId
  return f
}

test('Human and Bot profiles persist with CAS, exact retries and no identity/publication side effects', t => {
  const f = fixture(t, true), humanInput = update(f.human), botInput = update(f.bot)
  const humanResult = f.store.updatePublicProfile(f.a, humanInput)
  assert.equal(humanResult.publicProfile.version, 1)
  assert.equal(humanResult.publicProfile.summary, profile.summary)
  f.store.updatePublicProfile(f.a, botInput)
  f.store.syncPublication(f.a, { principalIds: [] })
  const newer = f.store.updatePublicProfile(f.a, update(f.human, 1, { ...profile, headline: '质量负责人' }))
  assert.equal(newer.publicProfile.version, 2)
  assert.throws(() => f.store.updatePublicProfile(f.a, update(f.human)), { code: 'PUBLIC_PROFILE_VERSION_CONFLICT' })
  f.store.close(); f.store = new HubStore(f.path)
  assert.deepEqual(f.store.updatePublicProfile(f.a, humanInput), humanResult)
  assert.equal(f.store.publicProfileOf(f.human).version, 2)
  assert.equal(f.store.publicProfileOf(f.bot).headline, profile.headline)
  assert.equal(f.store.isPublished(f.bot), false)
  assert.equal(f.store.contacts(f.a).find(person => person.principalId === f.human).displayName, 'Buddy')
  assert.throws(() => f.store.updatePublicProfile(f.a, { ...humanInput, profile: {} }), { code: 'OPERATION_ID_CONFLICT' })
  const cleared = f.store.updatePublicProfile(f.a, update(f.human, 2, {})).publicProfile
  assert.equal(cleared.headline, ''); assert.deepEqual(cleared.expertise, []); assert.equal(cleared.version, 3)
})

test('profile edits reject foreign identities, stale connections, invalid fields and malformed text', t => {
  const f = fixture(t)
  assert.throws(() => f.store.updatePublicProfile(f.b, update(f.human)), { code: 'AUTHOR_MISMATCH' })
  assert.throws(() => f.store.updatePublicProfile({ ...f.a, epoch: 0 }, update(f.bot)), { code: 'STALE_CONNECTION' })
  assert.throws(() => f.store.updatePublicProfile(f.a, { ...update(f.bot), kind: 'human' }), { code: 'INVALID_REQUEST' })
  assert.throws(() => f.store.updatePublicProfile(f.a, update(f.bot, -1)), { code: 'INVALID_REQUEST' })
  for (const value of [{ instructions: 'hidden' }, { headline: 'x'.repeat(81) }, { summary: '\u0000' }, { headline: '\ud800' },
    { expertise: [''] }, { expertise: Array(13).fill('QA') }, { languages: Array(9).fill('en') }, { headline: [] }, { summary: 3 }]) {
    assert.throws(() => f.store.updatePublicProfile(f.a, update(f.bot, 0, value)), { code: 'INVALID_PUBLIC_PROFILE' })
  }
  assert.equal(f.store.updatePublicProfile(f.a, update(f.bot, 0, { headline: '😀'.repeat(80) })).publicProfile.headline.length, 160)
  assert.deepEqual(normalizePublicProfile({ summary: ' line one\nline two ', expertise: [' QA ', 'QA'] }),
    { headline: '', summary: 'line one\nline two', expertise: ['QA'], languages: [] })
})

test('profile writes roll back atomically and schema 4 migrates without copying names into public text', t => {
  const f = fixture(t, true)
  f.store.db.exec('DROP TABLE principal_public_profiles; DELETE FROM schema_version WHERE version=5; PRAGMA user_version=4')
  f.store.close(); f.store = new HubStore(f.path)
  assert.equal(f.store.db.prepare('PRAGMA user_version').get().user_version, 5)
  assert.deepEqual(f.store.publicProfileOf(f.human), { headline: '', summary: '', expertise: [], languages: [], version: 0, updatedAt: null })
  const input = update(f.human)
  f.store.beforeCommit = () => { throw new Error('synthetic commit failure') }
  assert.throws(() => f.store.updatePublicProfile(f.a, input), /synthetic commit failure/)
  assert.equal(f.store.publicProfileOf(f.human).version, 0)
  f.store.beforeCommit = undefined
  assert.equal(f.store.updatePublicProfile(f.a, input).publicProfile.version, 1)
})

test('authorized contacts and conversation members carry profiles without exposing a hidden canonical owner', t => {
  const f = fixture(t)
  f.store.updatePublicProfile(f.a, update(f.bot))
  f.store.directoryFilter = (_auth, rows) => rows.filter(person => person.principalId === f.bot)
  const contacts = f.store.contacts(f.b)
  assert.equal(contacts[0].publicProfile.headline, profile.headline)
  assert.equal(contacts[0].ownerPrincipalId, null)
  const group = f.store.createGroup(f.b, { principalId: f.other, title: 'No owner present', operationId: randomUUID() })
  const ownMembership = f.store.memberships(f.b).memberships.find(row => row.conversationId === group.conversationId)
  const invited = f.store.invite(f.b, { principalId: f.other, conversationId: group.conversationId,
    inviteePrincipalId: f.bot, membershipEpoch: ownMembership.membershipEpoch, expectedVersion: ownMembership.membershipVersion, operationId: randomUUID() })
  f.store.accept(f.a, { principalId: f.bot, inviteId: invited.inviteId, operationId: randomUUID() })
  const member = f.store.members(f.b, { principalId: f.other, conversationId: group.conversationId })
    .members.find(person => person.principalId === f.bot)
  assert.equal(member.ownerPrincipalId, null); assert.equal(member.publicProfile.version, 1)
  assert.equal(f.store.readPublicProfile(f.b, { principalId: f.other, targetPrincipalId: f.bot }).publicProfile.headline, profile.headline)
  f.store.remove(f.b, { principalId: f.other, conversationId: group.conversationId, targetPrincipalId: f.bot,
    membershipEpoch: ownMembership.membershipEpoch, expectedVersion: f.store.members(f.b, { principalId: f.other, conversationId: group.conversationId }).membershipVersion, operationId: randomUUID() })
  f.store.directoryFilter = () => []
  assert.throws(() => f.store.readPublicProfile(f.b, { principalId: f.other, targetPrincipalId: f.bot }), { code: 'FORBIDDEN' })
  assert.equal(f.store.readPublicProfile(f.a, { principalId: f.human, targetPrincipalId: f.bot }).publicProfile.version, 1)
  assert.throws(() => f.store.readPublicProfile(f.b, { principalId: f.human, targetPrincipalId: f.bot }), { code: 'AUTHOR_MISMATCH' })
  const management = new HubManagement(f.store)
  const participant = management.participants().find(person => person.principalId === f.bot)
  assert.equal(participant.ownerPrincipalId, f.human)
  f.store.syncPublication(f.a, { principalIds: [] })
  assert.equal(management.participants().some(person => person.principalId === f.bot), false)
  assert.equal(management.participants().some(person => person.principalId === f.human), true)
  for (const row of management.participants()) assert.deepEqual(Object.keys(row).sort(),
    ['avatar','connected','displayName','homeInstanceId','instanceLabel','kind','ownerPrincipalId','principalId','publicProfile','published','trusted'].sort())
})

test('directory and member profile summaries obey the complete envelope budget; full authorized reads retain all text', t => {
  const f = fixture(t), description = '测试😀'.repeat(250)
  const value = { ...profile, summary: description, expertise: Array.from({ length: 12 }, (_, index) => '技能'.repeat(15) + index) }
  const group = f.store.createGroup(f.a, { principalId: f.human, title: 'Profile budget', operationId: randomUUID() })
  for (let index = 0; index < 10; index += 1) {
    const bot = f.store.register(f.a, { localId: 'extra-' + index, kind: 'bot', displayName: 'Specialist ' + index }).principalId
    f.store.updatePublicProfile(f.a, update(bot, 0, value))
    const member = f.store.memberships(f.a).memberships.find(row => row.principalId === f.human)
    const invite = f.store.invite(f.a, { principalId: f.human, conversationId: group.conversationId,
      membershipEpoch: member.membershipEpoch, expectedVersion: member.membershipVersion, inviteePrincipalId: bot, operationId: randomUUID() })
    f.store.accept(f.a, { principalId: bot, inviteId: invite.inviteId, operationId: randomUUID() })
  }
  f.store.limits.maxEnvelopeBytes = 8192
  const contacts = f.store.contacts(f.a), members = f.store.members(f.a, { principalId: f.human, conversationId: group.conversationId })
  assert.ok(responseBytes(contacts) <= 8192); assert.ok(responseBytes(members) <= 8192)
  assert.equal(contacts.length, 13); assert.equal(members.members.length, 11)
  const summary = contacts.find(person => person.principalId.endsWith(':extra-0')).publicProfile
  assert.equal(summary.truncated, true); assert.equal(summary.version, 1); assert.notEqual(summary.summary, description)
  const full = f.store.readPublicProfile(f.a, { principalId: f.human, targetPrincipalId: 'bot:a:extra-0' }).publicProfile
  assert.equal(full.summary, description); assert.equal(full.truncated, undefined); assert.equal(full.expertise.length, 12)
  const management = new HubManagement(f.store)
  assert.equal(management.participants().find(person => person.principalId.endsWith(':extra-0')).publicProfile.summary, description)
})

test('real profile RPC updates admin participants; admin avatar reads require separate administrator authentication', async t => {
  const credential = randomBytes(32).toString('hex'), otherCredential = randomBytes(32).toString('hex')
  const password = 'synthetic-test-profile-administrator-password'
  const hub = await startHub({ databasePath: ':memory:', port: 0,
    peers: [{ instanceId: 'a', credential }, { instanceId: 'b', credential: otherCredential }], management: { enabled: true, password } })
  const queue = new CommunicationQueue(':memory:', { instanceId: 'a' })
  const transport = new CommunicationTransport(queue, { url: hub.url, credential })
  t.after(async () => { transport.stop(); queue.close(); await hub.close() })
  await transport.connect()
  assert.ok(transport.welcome.capabilities.includes('public-profiles'))
  const person = await transport.request('principal.register', { kind: 'human', localId: 'owner', displayName: 'Buddy' })
  await transport.request('principal.public-profile', update(person.principalId))
  assert.equal((await transport.request('principal.public-profile.read', { principalId: person.principalId, targetPrincipalId: person.principalId })).publicProfile.summary, profile.summary)
  const auth = hub.store.connect('a', 'Device A', CAPABILITIES)
  const imageRevision = avatarRevision(png), uploadId = randomUUID()
  hub.store.avatarBegin(auth, { principalId: person.principalId, imageRevision, uploadId, totalLength: png.length })
  hub.store.avatarChunk(auth, { principalId: person.principalId, uploadId, offset: 0, data: png })
  hub.store.profile(auth, { principalId: person.principalId, operationId: randomUUID(), avatar: { imageRevision }, uploadId })
  const base = new URL('/admin/api/', hub.managementUrl)
  const admin = (action, payload = {}, authorization) => fetch(new URL(action, base), { method: 'POST',
    headers: { 'content-type': 'application/json', ...(authorization ? { authorization: 'Bearer ' + authorization } : {}) }, body: JSON.stringify(payload) })
  assert.equal((await admin('state')).status, 401)
  const state = await (await admin('state', {}, password)).json()
  const participant = state.value.participants.find(row => row.principalId === person.principalId)
  assert.equal(participant.publicProfile.headline, profile.headline); assert.equal(participant.avatar.imageRevision, imageRevision)
  assert.equal((await admin('avatar', { principalId: person.principalId, imageRevision }, credential)).status, 401)
  const first = await (await admin('avatar', { principalId: person.principalId, imageRevision, limit: 30 }, password)).json()
  assert.equal(first.value.data, png.slice(0, 30)); assert.equal(first.value.done, false)
  const invalid = await (await admin('avatar', { principalId: person.principalId, imageRevision: '0'.repeat(64) }, password)).json()
  assert.equal(invalid.error.code, 'AVATAR_REVISION_MISMATCH')
  const second = hub.store.connect('b', 'Device B', CAPABILITIES)
  hub.store.directoryFilter = () => []
  assert.throws(() => hub.store.avatarRead(second, { principalId: person.principalId, imageRevision }), { code: 'FORBIDDEN' })
  assert.equal((await admin('public-profile', update(person.principalId), password)).status, 400)
})
