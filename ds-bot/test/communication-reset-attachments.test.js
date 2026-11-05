import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, link, rm, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createHash } from 'node:crypto'
import { zstdCompressSync } from 'node:zlib'
import { planFederationAttachments, validateAttachmentFile, revalidateFederationAttachmentPlan } from '../src/host/federation/reset-attachments.js'

async function fixture(t) {
  const home = await mkdtemp(join(tmpdir(), 'dsbot-attachment-reset-'))
  t.after(() => rm(home, { recursive: true, force: true }))
  const sessionsRoot = join(home, 'sessions'), remote = join(sessionsRoot, 'project', 'remote'), local = join(sessionsRoot, 'project', 'local')
  await mkdir(remote, { recursive: true }); await mkdir(local, { recursive: true })
  const options = { sessionsRoot, remoteSessionDirectories: [remote], attachmentDshHome: home, provider: '@deepseek-ai/dsh-attachment-local' }
  const object = async (text, kind = 'file') => {
    const bytes = Buffer.from(text), digest = createHash('sha256').update(bytes).digest('hex')
    const path = join(home, 'attachments', 'v1', kind === 'file' ? 'file-objects' : 'objects', digest.slice(0, 2), digest)
    await mkdir(join(path, '..'), { recursive: true }); await writeFile(path, bytes)
    const ref = { attachmentId: `sha256:${digest}`, bytes: bytes.length, name: 'sample.txt', ...(kind === 'image' ? { mediaType: 'image/png', width: 1, height: 1 } : {}) }
    const alias = join(home, 'attachments', 'v1', 'files', digest.slice(0, 2), digest, ref.name)
    if (kind === 'file') { await mkdir(join(alias, '..'), { recursive: true }); await link(path, alias) }
    return { kind, attachment: ref, path, alias }
  }
  const journal = async (directory, refs, version = 4, compressed = false) => {
    const header = { type: 'session', id: directory === remote ? 'remote' : 'local', version, createdAt: 1, isSeeded: false, delegationDepth: 0, cwd: home }
    const message = { role: 'user', id: 'message-1', content: refs.map(ref => ({ type: ref.kind, attachment: ref.attachment })) }
    if (version < 2) { delete header.isSeeded }
    const events = refs.length ? [{ type: 'user/message', seq: 0, time: 1, data: message }] : []
    const text = [header, ...events].map(row => JSON.stringify(row)).join('\n') + '\n'
    const filename = version === 0 ? 'session.jsonl' : `session.v${version}.jsonl`
    await writeFile(join(directory, filename + (compressed ? '.zstd' : '')), compressed ? zstdCompressSync(text) : text)
  }
  return { home, remote, local, object, journal, options }
}

test('exclusive image/file objects and aliases are planned; shared ordinary bytes remain; request cache is regenerable', async t => {
  const f = await fixture(t), exclusive = await f.object('exclusive'), shared = await f.object('shared'), image = await f.object('image', 'image')
  await f.journal(f.remote, [exclusive, shared, image], 4, true); await f.journal(f.local, [shared])
  const cache = join(f.home, 'cache', 'attachments', 'request-images'); await mkdir(cache, { recursive: true }); await writeFile(join(cache, 'variant'), 'cached image')
  const plan = await planFederationAttachments(f.options)
  assert.equal(plan.exclusiveObjects, 2); assert.equal(plan.sharedObjects, 1)
  assert.deepEqual(plan.files.map(file => file.path).sort(), [exclusive.path, exclusive.alias, image.path].sort())
  assert.deepEqual(plan.trees, [cache])
  for (const file of plan.files) { assert.equal(await validateAttachmentFile(file), true); await rm(file.path) }
  assert.equal(await readFile(shared.path, 'utf8'), 'shared'); assert.equal(await readFile(shared.alias, 'utf8'), 'shared')
})

test('unknown orphan objects and outside hardlinks block before any deletion', async t => {
  const f = await fixture(t), object = await f.object('orphan')
  await f.journal(f.remote, []); await f.journal(f.local, [])
  await assert.rejects(planFederationAttachments(f.options), { code: 'RESET_ATTACHMENT_OWNERSHIP_UNPROVEN' })
  await f.journal(f.remote, [object]); await link(object.path, join(f.home, 'outside'))
  await assert.rejects(planFederationAttachments(f.options), { code: 'RESET_ATTACHMENT_EXTERNAL_HARDLINK' })
  assert.equal(await readFile(object.path, 'utf8'), 'orphan')
})

test('unsupported provider and corrupt ordinary logs fail closed', async t => {
  const f = await fixture(t)
  await assert.rejects(planFederationAttachments({ ...f.options, provider: 'custom' }), { code: 'RESET_ATTACHMENT_PROVIDER_UNSUPPORTED' })
  await writeFile(join(f.local, 'session.v4.jsonl'), 'broken\n')
  await assert.rejects(planFederationAttachments(f.options), { code: 'RESET_ATTACHMENT_INVALID_SESSION' })
})

for (const version of [0, 1, 2, 3, 4]) test(`public catalog scans generation ${version} without guessing its physical layout`, async t => {
  const f = await fixture(t); await f.journal(f.remote, [], version, version % 2 === 0)
  const plan = await planFederationAttachments(f.options)
  assert.equal(plan.exclusiveObjects, 0)
})

test('shared bytes retain only ordinary aliases, removing remote-only display filenames', async t => {
  const f = await fixture(t), shared = await f.object('shared bytes, different aliases')
  const alias = join(shared.alias, '..', 'remote-secret-name.txt')
  await link(shared.path, alias)
  const remoteRef = { ...shared, attachment: { ...shared.attachment, name: 'remote-secret-name.txt' } }
  await f.journal(f.remote, [remoteRef]); await f.journal(f.local, [shared])
  const plan = await planFederationAttachments(f.options)
  assert.equal(plan.sharedObjects, 1)
  assert.deepEqual(plan.files.map(file => file.path), [alias])
  assert.equal(await validateAttachmentFile(plan.files[0]), true)
})

test('never-materialized session root is empty, but unknown attachments still block with exact path', async t => {
  const f = await fixture(t)
  await rm(f.options.sessionsRoot, { recursive: true })
  const plan = await planFederationAttachments({ ...f.options, remoteSessionDirectories: [] })
  assert.equal(plan.files.length, 0)
  const orphan = await f.object('unwritten remote or unknown ordinary upload')
  await assert.rejects(planFederationAttachments({ ...f.options, remoteSessionDirectories: [] }), error => error.code === 'RESET_ATTACHMENT_OWNERSHIP_UNPROVEN' && [orphan.path, orphan.alias].includes(error.target))
})

test('corrupt compressed journal blocks with its exact path', async t => {
  const f = await fixture(t), path = join(f.local, 'session.v4.jsonl.zstd')
  await writeFile(path, 'not zstd')
  await assert.rejects(planFederationAttachments(f.options), error => error.code === 'RESET_ATTACHMENT_SESSION_UNSUPPORTED' && error.target === path)
})

for (const compressed of [false, true]) test(`crash retry rejects a newly retained ${compressed ? 'zstd' : 'raw'} reference before erasing its bytes`, async t => {
  const f = await fixture(t), object = await f.object('remote becomes ordinary after crash')
  await f.journal(f.remote, [object])
  const attachmentPlan = await planFederationAttachments(f.options)
  await rm(f.remote, { recursive: true })
  await f.journal(f.local, [object], 4, compressed)
  const path = join(f.local, 'session.v4.jsonl' + (compressed ? '.zstd' : ''))
  await assert.rejects(revalidateFederationAttachmentPlan({ ...f.options, attachmentPlan }), error => error.code === 'RESET_ATTACHMENT_CHANGED_OWNERSHIP' && error.target === path)
  assert.equal(await readFile(object.path, 'utf8'), 'remote becomes ordinary after crash')
  assert.equal(await readFile(object.alias, 'utf8'), 'remote becomes ordinary after crash')
})

test('unchanged crash retry succeeds after remote journals were erased without treating saved objects as orphans', async t => {
  const f = await fixture(t), object = await f.object('pending exclusive remote data')
  await f.journal(f.remote, [object]); await f.journal(f.local, [])
  const attachmentPlan = await planFederationAttachments(f.options)
  await rm(f.remote, { recursive: true })
  assert.deepEqual(await revalidateFederationAttachmentPlan({ ...f.options, attachmentPlan }), { valid: true })
  assert.equal(await readFile(object.path, 'utf8'), 'pending exclusive remote data')
})

test('crash retry rejects opaque retained digest mentions and malformed new ordinary generations', async t => {
  const f = await fixture(t), object = await f.object('remote attachment')
  await f.journal(f.remote, [object])
  const attachmentPlan = await planFederationAttachments(f.options)
  await rm(f.remote, { recursive: true })
  await f.journal(f.local, [])
  const path = join(f.local, 'session.v4.jsonl')
  const header = await readFile(path, 'utf8')
  await writeFile(path, header + JSON.stringify({ type: 'user/message', seq: 0, time: 1, data: { role: 'user', id: 'opaque-mention', content: [{ type: 'text', text: object.attachment.attachmentId }] } }) + '\n')
  await assert.rejects(revalidateFederationAttachmentPlan({ ...f.options, attachmentPlan }), error => error.code === 'RESET_ATTACHMENT_CHANGED_OWNERSHIP' && error.target === path)
  await writeFile(path, 'malformed new ordinary log\n')
  await assert.rejects(revalidateFederationAttachmentPlan({ ...f.options, attachmentPlan }), error => error.code === 'RESET_ATTACHMENT_CHANGED_OWNERSHIP' && error.target === path)
})

test('retry does not trust a saved digest key that disagrees with its physical deletion path', async t => {
  const f = await fixture(t), object = await f.object('manifest identity')
  await f.journal(f.remote, [object])
  const attachmentPlan = await planFederationAttachments(f.options)
  attachmentPlan.files[0].key = 'file:' + '0'.repeat(64)
  await assert.rejects(revalidateFederationAttachmentPlan({ ...f.options, attachmentPlan }), { code: 'RESET_INVALID_MANIFEST' })
  assert.equal(await readFile(object.path, 'utf8'), 'manifest identity')
})
