import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createHash, randomUUID } from 'node:crypto'
import { HubStore } from '../../communication-hub/src/store.js'
import { CAPABILITIES, HUB_CAPABILITIES } from '../../communication-hub/src/protocol.js'
import { profileHuman, readPrincipalAvatar, syncBotAvatars } from '../src/host/federation/avatars.js'

const image = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jG0cAAAAASUVORK5CYII='
const revision = value => createHash('sha256').update(value).digest('hex')
function fixture(t) {
  const store = new HubStore(':memory:')
  t.after(() => store.close())
  const auth = store.connect('avatar-adapter', 'Adapter', CAPABILITIES)
  const human = store.register(auth, { kind: 'human', localId: 'person', displayName: 'Person' })
  const bot = store.register(auth, { kind: 'bot', localId: 'bot', displayName: 'Bot' })
  const calls = []
  const runtime = { human, bots: new Map([['native-bot', { ...bot, localRef: 'native-bot' }]]), contacts: store.contacts(auth),
    transport: { welcome: { capabilities: HUB_CAPABILITIES }, request: async (type, payload) => {
      calls.push({ type, payload })
      return store[{ 'principal.avatar.begin': 'avatarBegin', 'principal.avatar.chunk': 'avatarChunk', 'principal.avatar.read': 'avatarRead' }[type]](auth, payload)
    } }, operation: async (principalId, _type, payload, operationId) => store.profile(auth, { principalId, ...payload, operationId }) }
  return { store, auth, human, bot, runtime, calls }
}

test('Human profile commits shared safe image/name, reads exact revision and resets without exposing image in directory', async t => {
  const { store, auth, human, runtime } = fixture(t)
  const operationId = randomUUID()
  const input = { operationId, displayName: 'Renamed', avatar: { image } }
  const saved = await profileHuman(runtime, input)
  assert.equal(saved.displayName, 'Renamed')
  assert.equal(saved.avatar.imageRevision, revision(image))
  assert.deepEqual(await profileHuman(runtime, input), saved)
  assert.equal((await readPrincipalAvatar(runtime, { principalId: human.principalId, revision: revision(image) })).image, image)
  assert.equal(JSON.stringify(store.contacts(auth)).includes(image), false)
  await profileHuman(runtime, { operationId: randomUUID(), avatar: null })
  assert.equal(store.contacts(auth).find(person => person.principalId === human.principalId).avatar.imageRevision, null)
  await assert.rejects(readPrincipalAvatar(runtime, { principalId: human.principalId, revision: revision(image) }))
})

test('Bot synchronization preserves native seed/look/image and a later change can return to an earlier look', async t => {
  const { store, auth, bot, runtime, calls } = fixture(t)
  const native = { id: 'native-bot', avatar: { shape: 'star', image }, color: '#123456' }
  runtime.rt = { botOf: () => native }
  await syncBotAvatars(runtime)
  let current = store.contacts(auth).find(person => person.principalId === bot.principalId).avatar
  assert.deepEqual(current, { seed: 'native-bot', shape: 'star', color: '#123456', imageRevision: revision(image) })
  const before = calls.length
  await syncBotAvatars(runtime)
  assert.equal(calls.length, before)
  native.avatar.shape = 'whale'
  await syncBotAvatars(runtime)
  native.avatar.shape = 'star'
  await syncBotAvatars(runtime)
  current = store.contacts(auth).find(person => person.principalId === bot.principalId).avatar
  assert.equal(current.shape, 'star')
  delete native.avatar.image
  await syncBotAvatars(runtime)
  assert.equal(store.contacts(auth).find(person => person.principalId === bot.principalId).avatar.imageRevision, null)
})

test('unsupported Hub or unsafe avatar fails before any upload or profile mutation', async t => {
  const { runtime, calls } = fixture(t)
  await assert.rejects(profileHuman(runtime, { operationId: randomUUID(), avatar: { image: 'https://example.test/avatar.png' } }), { code: 'INVALID_AVATAR' })
  await assert.rejects(profileHuman(runtime, { operationId: randomUUID(), avatar: { image, actor: 'other' } }), { code: 'INVALID_AVATAR' })
  assert.equal(calls.length, 0)
  runtime.transport.welcome.capabilities = CAPABILITIES
  await assert.rejects(profileHuman(runtime, { operationId: randomUUID(), displayName: 'No partial rename', avatar: { image } }), { code: 'AVATAR_CAPABILITY_REQUIRED' })
  assert.equal(calls.length, 0)
})
