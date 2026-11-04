import assert from 'node:assert/strict'
import { test } from 'node:test'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { HubStore } from '../src/store.js'
import { CAPABILITIES, responseBytes } from '../src/protocol.js'
import { AVATAR_CHUNK_LENGTH, avatarRevision } from '../src/avatars.js'

const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aV2kAAAAASUVORK5CYII='
const largePng = `data:image/png;base64,${Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),Buffer.alloc(119972)]).toString('base64')}`

function fixture(t, disk = false) {
  const dir = disk && mkdtempSync(join(tmpdir(), 'dsbot-avatar-'))
  const f = { path: dir ? join(dir, 'hub.sqlite') : ':memory:' }
  f.store = new HubStore(f.path)
  t.after(() => { f.store.close(); if (dir) rmSync(dir, { recursive: true, force: true }) })
  f.a = f.store.connect('a', 'A', CAPABILITIES); f.b = f.store.connect('b', 'B', CAPABILITIES)
  f.H = f.store.register(f.a, { localId: 'user', kind: 'human', displayName: 'Configured Human' }).principalId
  f.B = f.store.register(f.b, { localId: 'worker', kind: 'bot', displayName: 'Worker', avatar: { seed: 'local-bot-id', shape: 'round', color: 'deepseek' } }).principalId
  f.begin = (image, principalId = f.H, auth = f.a, uploadId = randomUUID()) => {
    const imageRevision = avatarRevision(image)
    const input = { principalId, uploadId, imageRevision, totalLength: image.length }
    f.store.avatarBegin(auth, input)
    return input
  }
  f.upload = (image, principalId = f.H, auth = f.a) => {
    const input = f.begin(image, principalId, auth)
    for (let offset = 0; offset < image.length; offset += AVATAR_CHUNK_LENGTH) f.store.avatarChunk(auth, { principalId, uploadId: input.uploadId, offset, data: image.slice(offset, offset + AVATAR_CHUNK_LENGTH) })
    return input
  }
  f.commit = (input, extra = {}, auth = f.a) => f.store.profile(auth, { operationId: randomUUID(), principalId: input.principalId, avatar: { imageRevision: input.imageRevision }, uploadId: input.uploadId, ...extra })
  return f
}

test('Bot descriptors preserve native seed, shape and color; old registration and Human rename preserve committed custom avatars', t => {
  const f = fixture(t)
  assert.deepEqual(f.store.contacts(f.a).find(p => p.principalId === f.B).avatar, { seed: 'local-bot-id', shape: 'round', color: 'deepseek', imageRevision: null })
  const upload = f.upload(png)
  f.commit(upload, { displayName: 'Custom Human' })
  f.store.renameHuman(f.a, { principalId: f.H, displayName: 'Renamed' })
  f.store.register(f.a, { localId: 'user', kind: 'human', displayName: 'New configured default' })
  const person = f.store.contacts(f.b).find(p => p.principalId === f.H)
  assert.equal(person.displayName, 'Renamed'); assert.equal(person.avatar.imageRevision, upload.imageRevision)
  const reset = f.store.profile(f.a, { operationId: randomUUID(), principalId: f.H, displayName: null })
  assert.equal(reset.displayName, 'New configured default'); assert.equal(reset.avatar.imageRevision, upload.imageRevision)
  const removed = f.store.profile(f.a, { operationId: randomUUID(), principalId: f.H, avatar: null })
  assert.equal(removed.avatar.imageRevision, null)
  assert.equal(f.store.db.prepare('SELECT image FROM principal_avatar WHERE principal_id=?').get(f.H).image, null)
})

test('partial staged uploads never expose a new avatar; full profile commit is atomic, durable and idempotent after cleanup', t => {
  const f = fixture(t, true), upload = f.begin(largePng)
  const first = { principalId: f.H, uploadId: upload.uploadId, offset: 0, data: largePng.slice(0, AVATAR_CHUNK_LENGTH) }
  const offset = f.store.avatarChunk(f.a, first).nextOffset
  assert.equal(offset, AVATAR_CHUNK_LENGTH); assert.deepEqual(f.store.avatarChunk(f.a, first), { uploadId: upload.uploadId, nextOffset: offset, complete: false })
  assert.equal(f.store.avatarOf(f.H).imageRevision, null)
  assert.throws(() => f.commit(upload, { displayName: 'Not committed' }), { code: 'AVATAR_UPLOAD_INCOMPLETE' })
  assert.equal(f.store.contacts(f.a).find(p => p.principalId === f.H).displayName, 'Configured Human')
  f.store.close(); f.store = new HubStore(f.path)
  assert.equal(f.store.avatarBegin(f.a, upload).nextOffset, offset)
  for (let at = offset; at < largePng.length; at += AVATAR_CHUNK_LENGTH) f.store.avatarChunk(f.a, { principalId: f.H, uploadId: upload.uploadId, offset: at, data: largePng.slice(at, at + AVATAR_CHUNK_LENGTH) })
  const input = { operationId: randomUUID(), principalId: f.H, displayName: 'Committed', avatar: { imageRevision: upload.imageRevision }, uploadId: upload.uploadId }
  f.store.beforeCommit = () => { throw new Error('synthetic profile failure') }
  assert.throws(() => f.store.profile(f.a, input), /synthetic profile failure/)
  assert.equal(f.store.avatarOf(f.H).imageRevision, null)
  assert.equal(f.store.db.prepare('SELECT count(*) n FROM avatar_uploads').get().n, 1)
  f.store.beforeCommit = undefined
  const result = f.store.profile(f.a, input)
  assert.equal(result.displayName, 'Committed'); assert.equal(result.avatar.imageRevision, upload.imageRevision)
  assert.equal(f.store.db.prepare('SELECT count(*) n FROM avatar_uploads').get().n, 0)
  f.store.close(); f.store = new HubStore(f.path)
  assert.deepEqual(f.store.profile(f.a, input), result)
  assert.equal(f.store.avatarBegin(f.a, upload).nextOffset, largePng.length)
  assert.throws(() => f.store.profile(f.a, { ...input, displayName: 'Changed same operation' }), { code: 'OPERATION_ID_CONFLICT' })
})

test('every upload mutation is owner scoped and current-connection scoped; one pending upload per principal remains bounded', t => {
  const f = fixture(t), upload = f.begin(png)
  const chunk = { principalId: f.H, uploadId: upload.uploadId, offset: 0, data: png }
  assert.throws(() => f.store.avatarBegin(f.b, upload), { code: 'AUTHOR_MISMATCH' })
  assert.throws(() => f.store.avatarChunk(f.b, chunk), { code: 'AUTHOR_MISMATCH' })
  assert.throws(() => f.commit(upload, {}, f.b), { code: 'AUTHOR_MISMATCH' })
  assert.throws(() => f.store.avatarChunk({ instanceId: 'a', epoch: 0 }, chunk), { code: 'STALE_CONNECTION' })
  assert.throws(() => f.store.avatarBegin(f.a, { ...upload, totalLength: 160001 }), { code: 'INVALID_AVATAR_UPLOAD' })
  assert.throws(() => f.store.avatarChunk(f.a, { ...chunk, data: 'a'.repeat(32769) }), { code: 'INVALID_AVATAR_CHUNK' })
  assert.throws(() => f.store.avatarChunk(f.a, { ...chunk, offset: 1, data: 'a' }), { code: 'AVATAR_UPLOAD_OFFSET' })
  const newer = f.begin(png)
  assert.equal(f.store.db.prepare('SELECT count(*) n FROM avatar_uploads WHERE principal_id=?').get(f.H).n, 1)
  assert.throws(() => f.store.avatarChunk(f.a, chunk), { code: 'AVATAR_UPLOAD_MISMATCH' })
  f.store.avatarChunk(f.a, { ...chunk, uploadId: newer.uploadId })
  assert.throws(() => f.store.avatarChunk(f.a, { ...chunk, uploadId: newer.uploadId, data: png.replace('png', 'gif') }), { code: 'AVATAR_UPLOAD_CONFLICT' })
})

test('only bounded raster data URLs with matching hashes commit; markup, remote URLs and unsafe descriptors fail closed', t => {
  const f = fixture(t)
  for (const image of ['https://example.test/avatar.png', 'data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=', 'data:image/png;base64,PHN2Zz48L3N2Zz4=', 'data:text/html;base64,PHNjcmlwdD4=']) {
    const upload = f.upload(image)
    assert.throws(() => f.commit(upload), { code: 'INVALID_AVATAR_IMAGE' })
    assert.equal(f.store.avatarOf(f.H).imageRevision, null)
  }
  const upload = f.upload(png)
  f.store.db.prepare('UPDATE avatar_uploads SET data=? WHERE principal_id=?').run(png.replace('png', 'gif'), f.H)
  assert.throws(() => f.commit(upload), { code: 'AVATAR_REVISION_MISMATCH' })
  for (const avatar of [{ shape: '<svg>' }, { color: 'url(https://example.test/a)' }, { image: png }, { seed: 'bad\nseed' }, { imageRevision: 'https://example.test/a' }]) {
    assert.throws(() => f.store.profile(f.a, { operationId: randomUUID(), principalId: f.H, avatar }), { code: 'INVALID_AVATAR' })
  }
})

test('directory/member responses omit images and chunks retain revision identity and envelope bounds', t => {
  const f = fixture(t), upload = f.upload(largePng, f.B, f.b)
  f.commit(upload, {}, f.b)
  const group = f.store.createGroup(f.a, { operationId: randomUUID(), principalId: f.H, title: 'Avatar group' }).conversationId
  const owner = f.store.memberships(f.a).memberships.find(m => m.conversationId === group)
  const invite = f.store.invite(f.a, { operationId: randomUUID(), conversationId: group, principalId: f.H, membershipEpoch: owner.membershipEpoch, inviteePrincipalId: f.B })
  f.store.accept(f.b, { operationId: randomUUID(), principalId: f.B, inviteId: invite.inviteId })
  const contacts = f.store.contacts(f.a), members = f.store.members(f.b, { conversationId: group, principalId: f.B })
  assert.ok(!JSON.stringify(contacts).includes('data:image')); assert.ok(!JSON.stringify(members).includes('data:image'))
  assert.equal(members.members.find(p => p.principalId === f.B).avatar.imageRevision, upload.imageRevision)
  assert.throws(() => f.store.settings(f.b, { operationId: randomUUID(), principalId: f.B, conversationId: group, membershipEpoch: f.store.memberships(f.b).memberships[0].membershipEpoch, expectedVersion: members.membershipVersion, title: 'Forbidden' }), { code: 'FORBIDDEN' })
  let image = '', offset = 0
  do {
    const chunk = f.store.avatarRead(f.a, { principalId: f.B, imageRevision: upload.imageRevision, offset })
    assert.ok(chunk.data.length <= 32768); assert.ok(responseBytes(chunk) < f.store.limits.maxEnvelopeBytes)
    image += chunk.data; offset = chunk.nextOffset
  } while (offset < largePng.length)
  assert.equal(image, largePng)
  assert.throws(() => f.store.avatarRead(f.a, { principalId: f.B, imageRevision: '0'.repeat(64) }), { code: 'AVATAR_REVISION_MISMATCH' })
  assert.throws(() => f.store.avatarRead(f.a, { principalId: f.B, imageRevision: upload.imageRevision, limit: 32769 }), { code: 'INVALID_AVATAR_CHUNK' })
})

test('read authorization is checked for each chunk and allows current shared-group members without contact visibility', t => {
  const f = fixture(t), upload = f.upload(png, f.B, f.b)
  f.commit(upload, {}, f.b)
  f.store.canReadPrincipalAvatar = () => false
  const read = () => f.store.avatarRead(f.a, { principalId: f.B, imageRevision: upload.imageRevision })
  assert.throws(read, { code: 'FORBIDDEN' })
  const group = f.store.createGroup(f.a, { operationId: randomUUID(), principalId: f.H, title: 'Shared' }).conversationId
  const scope = () => f.store.memberships(f.a).memberships.find(m => m.conversationId === group)
  const invite = f.store.invite(f.a, { operationId: randomUUID(), principalId: f.H, conversationId: group, membershipEpoch: scope().membershipEpoch, inviteePrincipalId: f.B })
  f.store.accept(f.b, { operationId: randomUUID(), principalId: f.B, inviteId: invite.inviteId })
  assert.equal(read().data, png)
  f.store.remove(f.a, { operationId: randomUUID(), principalId: f.H, conversationId: group, membershipEpoch: scope().membershipEpoch, targetPrincipalId: f.B })
  assert.throws(read, { code: 'FORBIDDEN' })
  f.store.canReadPrincipalAvatar = () => true
  assert.equal(read().data, png)
  f.store.revokeInstance('b')
  assert.throws(read, { code: 'UNKNOWN_PRINCIPAL' })
})
