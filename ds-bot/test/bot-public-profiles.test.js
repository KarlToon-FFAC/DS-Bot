import assert from 'node:assert/strict'
import { test } from 'node:test'
import { randomUUID } from 'node:crypto'
import { HubStore } from '../../communication-hub/src/store.js'
import { CAPABILITIES, HUB_CAPABILITIES } from '../../communication-hub/src/protocol.js'
import { CommunicationQueue } from '../src/host/federation/queue-store.js'
import { cleanPublicProfile, profileContent, syncBotPublicProfiles } from '../src/host/federation/public-profiles.js'

const testing = { headline: 'Testing expert', summary: 'I review test plans and investigate failures.', expertise: ['testing', 'regression'], languages: ['English'] }
function fixture(t) {
  const store = new HubStore(':memory:'), queue = new CommunicationQueue(':memory:', { instanceId: 'profiles' })
  t.after(() => { queue.close(); store.close() })
  const auth = store.connect('profiles', 'Profiles', CAPABILITIES)
  const human = store.register(auth, { kind: 'human', localId: 'human', displayName: 'Buddy' })
  const principal = store.register(auth, { kind: 'bot', localId: 'bot', displayName: 'Tester' })
  const native = { id: 'local-bot', instructions: 'Private instructions must stay local.', publicProfile: { ...testing, revision: 1 } }
  const calls = [], reads = []
  const runtime = { queue, human, bots: new Map([[native.id, { ...principal, localRef: native.id }]]), contacts: store.contacts(auth),
    rt: { botOf: id => id === native.id ? native : undefined }, transport: { welcome: { capabilities: HUB_CAPABILITIES }, request: async (type, input) => {
      reads.push({ type, input }); return store.readPublicProfile(auth, input)
    } }, operation: async (principalId, type, input, operationId) => {
      calls.push({ principalId, type, input, operationId })
      return store.updatePublicProfile(auth, { principalId, ...input, operationId })
    } }
  return { store, queue, auth, human, principal, native, runtime, calls, reads }
}

test('public fields validate before publication and refuse likely or configured secrets', () => {
  assert.deepEqual(cleanPublicProfile({ ...testing, headline: ' Testing expert ', expertise: ['testing', 'testing'] }), { ...testing, expertise: ['testing'] })
  for (const profile of [null, [], { ...testing, instructions: 'private' }, { ...testing, expertise: [''] }, { ...testing, headline: 'x'.repeat(81) }, { ...testing, languages: ['en\nzh'] }]) {
    assert.throws(() => cleanPublicProfile(profile), { code: 'INVALID_PUBLIC_PROFILE' })
  }
  assert.throws(() => cleanPublicProfile({ ...testing, summary: 'password: hunter2' }), { code: 'PUBLIC_PROFILE_SECRET_REFUSED' })
  assert.throws(() => cleanPublicProfile(testing, { redactSecrets: () => '[REDACTED]' }), { code: 'PUBLIC_PROFILE_SECRET_REFUSED' })
})

test('native Bot profiles sync independently of instructions, names and publication, then remain idempotent', async t => {
  const { store, auth, human, principal, native, runtime, calls } = fixture(t)
  await syncBotPublicProfiles(runtime)
  assert.equal(calls.length, 1)
  assert.equal(calls[0].type, 'principal.public-profile')
  assert.deepEqual(calls[0].input, { expectedVersion: 0, profile: testing })
  assert.equal(store.publicProfileOf(principal.principalId).version, 1)
  assert.deepEqual(profileContent(store.publicProfileOf(principal.principalId)), testing)
  assert.equal(store.publicProfileOf(human.principalId).version, 0)
  assert.equal(store.isPublished(principal.principalId), true)
  assert.equal(store.contacts(auth).find(person => person.principalId === principal.principalId).displayName, 'Tester')
  assert.equal(JSON.stringify(calls).includes(native.instructions), false)
  runtime.contacts = store.contacts(auth)
  await syncBotPublicProfiles(runtime)
  assert.equal(calls.length, 1)
  native.publicProfile = { ...testing, headline: 'Browser testing expert', revision: 2 }
  await syncBotPublicProfiles(runtime)
  assert.equal(calls[1].input.expectedVersion, 1)
  assert.equal(store.publicProfileOf(principal.principalId).version, 2)
  assert.notEqual(calls[0].operationId, calls[1].operationId)
})

test('queued profile replays the same operation after restart before a newer local edit', async t => {
  const { store, auth, principal, native, runtime, calls, queue } = fixture(t)
  const submit = runtime.operation
  runtime.operation = async (...args) => { calls.push(args); return { status: 'queued' } }
  await syncBotPublicProfiles(runtime)
  const pending = JSON.parse(queue.db.prepare('SELECT value FROM metadata WHERE key=?').get(`bot-public-profile:${principal.principalId}`).value)
  native.publicProfile = { ...testing, headline: 'Regression expert', revision: 2 }
  const restarted = { ...runtime, contacts: store.contacts(auth), operation: submit }
  await syncBotPublicProfiles(restarted)
  assert.equal(calls[1].operationId, pending.operationId)
  assert.deepEqual(calls[1].input, { expectedVersion: 0, profile: testing })
  assert.equal(calls[2].input.expectedVersion, 1)
  assert.equal(store.publicProfileOf(principal.principalId).headline, 'Regression expert')
  assert.equal(store.publicProfileOf(principal.principalId).version, 2)
})

test('a remote concurrent edit is preserved until a deliberate new local revision', async t => {
  const { store, auth, principal, native, runtime, calls } = fixture(t)
  await syncBotPublicProfiles(runtime)
  store.updatePublicProfile(auth, { principalId: principal.principalId, operationId: randomUUID(), expectedVersion: 1, profile: { ...testing, headline: 'Edited on another device' } })
  runtime.contacts = store.contacts(auth)
  await assert.rejects(syncBotPublicProfiles(runtime), { code: 'PUBLIC_PROFILE_VERSION_CONFLICT' })
  assert.equal(calls.length, 1)
  assert.equal(store.publicProfileOf(principal.principalId).headline, 'Edited on another device')
  native.publicProfile = { ...testing, headline: 'Confirmed local edit', revision: 2 }
  await syncBotPublicProfiles(runtime)
  assert.equal(calls[1].input.expectedVersion, 2)
  assert.equal(store.publicProfileOf(principal.principalId).headline, 'Confirmed local edit')
})

test('truncated directories fetch the full owned profile and confirmed versions avoid repeated reads', async t => {
  const { store, principal, runtime, calls, reads } = fixture(t)
  runtime.contacts = runtime.contacts.map(person => person.principalId === principal.principalId ? { ...person, publicProfile: { version: 0, truncated: true } } : person)
  await syncBotPublicProfiles(runtime)
  assert.equal(reads.length, 1)
  assert.deepEqual(reads[0], { type: 'principal.public-profile.read', input: { principalId: principal.principalId, targetPrincipalId: principal.principalId } })
  runtime.contacts = runtime.contacts.map(person => person.principalId === principal.principalId ? { ...person, publicProfile: { version: store.publicProfileOf(principal.principalId).version, truncated: true } } : person)
  await syncBotPublicProfiles(runtime)
  assert.equal(calls.length, 1)
  assert.equal(reads.length, 1)
})

test('one conflicting Bot does not block other profiles and unsupported Hubs retain local data', async t => {
  const { store, auth, native, runtime, calls } = fixture(t)
  await syncBotPublicProfiles(runtime)
  const other = store.register(auth, { kind: 'bot', localId: 'second', displayName: 'Second' })
  runtime.bots.set('second', { ...other, localRef: 'second' })
  runtime.rt.botOf = id => id === native.id ? native : { publicProfile: { ...testing, revision: 1 } }
  runtime.contacts = store.contacts(auth)
  const first = runtime.contacts.find(person => person.principalId === runtime.bots.get(native.id).principalId)
  first.publicProfile = { ...testing, headline: 'Changed remotely', version: 5 }
  await assert.rejects(syncBotPublicProfiles(runtime), { code: 'PUBLIC_PROFILE_VERSION_CONFLICT' })
  assert.equal(store.publicProfileOf(other.principalId).version, 1)
  const before = calls.length
  runtime.transport.welcome.capabilities = CAPABILITIES
  await syncBotPublicProfiles(runtime)
  assert.equal(calls.length, before)
  assert.equal(native.publicProfile.headline, testing.headline)
})
