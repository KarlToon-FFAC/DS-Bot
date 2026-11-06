import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink, lstat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { checkedPath } from '../src/host/federation/reset.js'
import { planFederationDerived } from '../src/host/federation/reset-derived.js'
import { planFederationAttachments } from '../src/host/federation/reset-attachments.js'

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'dsbot-reset-path-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const data = join(root, 'data'), alias = join(root, 'alias')
  await mkdir(data)
  const sentinel = join(data, 'keep.txt'); await writeFile(sentinel, 'ordinary data')
  return { root, data, alias, sentinel }
}

test('reset rejects linked ancestors of existing and missing targets without touching their data', async t => {
  const f = await fixture(t)
  await symlink(f.root, f.alias, process.platform === 'win32' ? 'junction' : 'dir')
  await assert.rejects(checkedPath(join(f.alias, 'data', 'keep.txt'), 'file'), { code: 'RESET_UNSAFE_PATH' })
  await assert.rejects(checkedPath(join(f.alias, 'missing', 'credentials.yaml'), 'file', true), { code: 'RESET_UNSAFE_PATH' })
  await assert.rejects(planFederationDerived({
    storageRoot: join(f.alias, 'data'), remoteWorkspaceRoot: join(f.root, 'communication-workspaces'),
    remoteSessionIds: [], provider: 'json',
  }), { code: 'RESET_DERIVED_PROVIDER_UNSUPPORTED' })
  await assert.rejects(planFederationAttachments({
    sessionsRoot: f.data, attachmentDshHome: join(f.alias, 'data'),
    remoteSessionDirectories: [], provider: '@deepseek-ai/dsh-attachment-local',
  }), { code: 'RESET_ATTACHMENT_UNSAFE_PATH' })
  assert.equal(await readFile(f.sentinel, 'utf8'), 'ordinary data')
})

test('Windows path spelling variants are accepted when they name an ordinary directory', { skip: process.platform !== 'win32' }, async t => {
  const f = await fixture(t), variant = f.data.toUpperCase()
  try { await lstat(variant) } catch (error) {
    if (error.code === 'ENOENT') { t.skip('directory has case-sensitive names'); return }
    throw error
  }
  assert.equal((await checkedPath(variant, 'directory')).isDirectory(), true)
  assert.equal(await checkedPath(join(variant, 'missing', 'credentials.yaml'), 'file', true), null)
  assert.equal(await readFile(f.sentinel, 'utf8'), 'ordinary data')
})
