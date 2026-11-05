import assert from 'node:assert/strict'
import { test } from 'node:test'
import { profileHumanInfo, readHumanProfileInfo } from '../src/host/federation/avatars.js'

const profile = { headline: 'Test lead', summary: 'Responsible for testing.', expertise: ['Regression', 'Automation'], languages: ['English'] }
function fixture() {
  const human = { principalId: 'human:a:buddy', kind: 'human', publicProfile: { ...profile, version: 2 } }
  const other = { principalId: 'human:b:other', kind: 'human', publicProfile: { headline: 'Other person', version: 5 } }
  const calls = []
  const runtime = { human, contacts: [human, other], transport: { welcome: { capabilities: ['public-profiles'] } },
    operation: async (...args) => { calls.push(args); return { principalId: human.principalId, publicProfile: { ...args[2].profile, version: args[2].expectedVersion + 1, updatedAt: '2026-11-05T00:00:00.000Z' } } } }
  return { runtime, calls, other }
}

test('Human responsibilities update only the host-bound Human and preserve other contacts', async () => {
  const { runtime, calls, other } = fixture()
  const value = await profileHumanInfo(runtime, { endpoint: 'profile-human-info', operationId: 'one', expectedVersion: 2, profile })
  assert.deepEqual(calls, [[runtime.human.principalId, 'principal.public-profile', { expectedVersion: 2, profile }, 'one']])
  assert.equal(runtime.human.publicProfile.version, 3)
  assert.deepEqual(runtime.contacts[0].publicProfile, value.publicProfile)
  assert.equal(runtime.contacts[1], other)
})

test('complete Human profile reads bind both actor and target to the local owner', async () => {
  const { runtime } = fixture()
  const calls = []
  runtime.transport.request = async (...args) => {
    calls.push(args); return { principalId: runtime.human.principalId, publicProfile: { ...profile, version: 2 } }
  }
  assert.equal((await readHumanProfileInfo(runtime, { endpoint: 'human-profile-info' })).publicProfile.summary, profile.summary)
  assert.deepEqual(calls, [['principal.public-profile.read', { principalId: runtime.human.principalId, targetPrincipalId: runtime.human.principalId }]])
  for (const field of ['principalId', 'targetPrincipalId']) {
    await assert.rejects(readHumanProfileInfo(runtime, { [field]: 'human:b:other' }), { code: 'INVALID_REQUEST' })
  }
  assert.equal(calls.length, 1)
  runtime.transport.request = async () => ({ principalId: runtime.human.principalId, publicProfile: { ...profile, version: 2, truncated: true } })
  await assert.rejects(readHumanProfileInfo(runtime), { code: 'INVALID_PUBLIC_PROFILE_RESPONSE' })
})

test('queued profile changes retain their stable operation and do not update cached public data', async () => {
  const { runtime, calls } = fixture()
  runtime.operation = async (...args) => { calls.push(args); return { status: 'queued', operationId: args[3] } }
  const input = { operationId: 'same-change', expectedVersion: 2, profile: { ...profile, headline: 'New responsibility' } }
  await profileHumanInfo(runtime, input)
  await profileHumanInfo(runtime, input)
  assert.deepEqual(calls[0], calls[1])
  assert.equal(runtime.human.publicProfile.headline, 'Test lead')
  assert.equal(runtime.contacts[0].publicProfile.version, 2)
})

test('profile updates refuse caller identity, authority fields and unsupported Hub before queueing', async () => {
  const { runtime, calls } = fixture()
  for (const field of ['principalId', 'sender', 'author', 'ownerPrincipalId', 'localUserIntent']) {
    await assert.rejects(profileHumanInfo(runtime, { operationId: 'spoof', expectedVersion: 2, profile, [field]: 'human:b:other' }), { code: 'INVALID_REQUEST' })
  }
  runtime.transport.welcome.capabilities = []
  await assert.rejects(profileHumanInfo(runtime, { operationId: 'unsupported', expectedVersion: 2, profile }), { code: 'PUBLIC_PROFILE_CAPABILITY_REQUIRED' })
  assert.equal(calls.length, 0)
})

test('invalid profile shapes, fields and versions never enter the durable operation queue', async () => {
  const { runtime, calls } = fixture()
  for (const value of [null, [], { ...profile, instructions: 'override' }, { ...profile, headline: 'x'.repeat(81) },
    { ...profile, summary: 'unsafe\u0000text' }, { ...profile, headline: 'unsafe\u0085text' }, { ...profile, summary: '\ud800' },
    { ...profile, expertise: [''] }, { ...profile, languages: Array(9).fill('English') }]) {
    await assert.rejects(profileHumanInfo(runtime, { operationId: 'invalid', expectedVersion: 2, profile: value }), { code: 'INVALID_PUBLIC_PROFILE' })
  }
  for (const expectedVersion of [-1, '2', 1.5, Number.MAX_SAFE_INTEGER]) {
    await assert.rejects(profileHumanInfo(runtime, { operationId: 'invalid', expectedVersion, profile }), { code: 'INVALID_REQUEST' })
  }
  assert.equal(calls.length, 0)
})

test('private credentials are rejected before Human profile data leaves the local runtime', async () => {
  const { runtime, calls } = fixture()
  runtime.rt = { redactSecrets: value => value.replaceAll('private-synthetic-token', '[redacted]') }
  await assert.rejects(profileHumanInfo(runtime, { operationId: 'private', expectedVersion: 2, profile: { ...profile, summary: 'private-synthetic-token' } }), { code: 'PUBLIC_PROFILE_SECRET_REFUSED' })
  assert.equal(calls.length, 0)
})

test('stale edits and mismatched acknowledgements preserve the last confirmed profile', async () => {
  const { runtime } = fixture()
  const input = { operationId: 'conflict', expectedVersion: 2, profile: { ...profile, headline: 'Unconfirmed' } }
  runtime.operation = async () => { throw Object.assign(new Error('PROFILE_VERSION_CONFLICT'), { code: 'PROFILE_VERSION_CONFLICT' }) }
  await assert.rejects(profileHumanInfo(runtime, input), { code: 'PROFILE_VERSION_CONFLICT' })
  assert.equal(runtime.human.publicProfile.headline, 'Test lead')
  runtime.operation = async () => ({ principalId: 'human:b:other', publicProfile: { ...profile, version: 3 } })
  await assert.rejects(profileHumanInfo(runtime, input), { code: 'INVALID_PUBLIC_PROFILE_RESPONSE' })
  runtime.operation = async () => ({ principalId: runtime.human.principalId, publicProfile: { ...profile, version: 2 } })
  await assert.rejects(profileHumanInfo(runtime, input), { code: 'INVALID_PUBLIC_PROFILE_RESPONSE' })
  assert.equal(runtime.human.publicProfile.version, 2)
})
