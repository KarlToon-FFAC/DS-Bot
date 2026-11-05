import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { workspaceDomainSpec } from '@deepseek-ai/dsh-workspace'
import { projectionCacheDomainSpec } from '@deepseek-ai/dsh-session-projection-cache'
import { planFederationDerived, applyFederationDerived } from '../src/host/federation/reset-derived.js'

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'dsbot-derived-reset-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const storageRoot = join(root, 'storages'), remoteWorkspaceRoot = join(root, 'bot', 'communication-workspaces')
  await mkdir(storageRoot)
  const options = { storageRoot, remoteWorkspaceRoot, remoteSessionIds: ['remote-session'], provider: 'json' }
  const ordinary = { path: join(root, 'ordinary'), title: 'Keep ordinary', sessionIds: ['local-session', 'remote-session'], createdAt: '2026-11-05T00:00:00.000Z', updatedAt: '2026-11-05T00:00:00.000Z' }
  const remote = { ...ordinary, path: join(remoteWorkspaceRoot, 'binding'), title: 'Erase remote', sessionIds: ['remote-session'] }
  const workspace = { unit: { name: 'workspace', version: workspaceDomainSpec.version }, global: { initialized: true, workspaceIds: ['local-workspace', 'remote-workspace'], defaultWorkspaceId: 'remote-workspace', archivedSessionIds: ['remote-session'], pinnedSessionIds: ['local-session'] }, tables: { workspaces: { 'local-workspace': ordinary, 'remote-workspace': remote } } }
  const workspacePath = join(storageRoot, 'workspace.json')
  await writeFile(workspacePath, JSON.stringify(workspace))
  const sessions = join(storageRoot, 'session_projcache', 'sessions'); await mkdir(sessions, { recursive: true })
  const checkpoint = cwd => ({ version: projectionCacheDomainSpec.version, record: { identity: { createdAt: 1, cwd, formatVersion: 4, isSeeded: false, inheritedEventCount: 0 }, rows: { title: { ver: 1, seq: -1, val: { text: cwd } } } } })
  const remoteCache = join(sessions, 'remote-session.json'), localCache = join(sessions, 'local-session.json')
  await writeFile(remoteCache, JSON.stringify(checkpoint(remote.path))); await writeFile(localCache, JSON.stringify(checkpoint(ordinary.path)))
  return { root, options, workspace, workspacePath, remoteCache, localCache, checkpoint }
}

test('read-only plan and public domain cleanup remove only remote cache/membership/archive/workspace state', async t => {
  const f = await fixture(t), before = await readFile(f.workspacePath, 'utf8'), localBefore = await readFile(f.localCache, 'utf8')
  const plan = await planFederationDerived(f.options)
  assert.equal(await readFile(f.workspacePath, 'utf8'), before)
  assert.deepEqual(plan.projectionSessionIds, ['remote-session']); assert.deepEqual(plan.workspaceDeletes, ['remote-workspace'])
  assert.deepEqual(await applyFederationDerived(plan), { projectionRecordsDeleted: 1, workspacesDeleted: 1, workspacesUpdated: 1 })
  assert.equal(await readFile(f.localCache, 'utf8'), localBefore)
  await assert.rejects(readFile(f.remoteCache), { code: 'ENOENT' })
  const after = JSON.parse(await readFile(f.workspacePath, 'utf8'))
  assert.deepEqual(after.global.workspaceIds, ['local-workspace']); assert.equal(after.global.defaultWorkspaceId, undefined)
  assert.deepEqual(after.global.archivedSessionIds, []); assert.deepEqual(after.global.pinnedSessionIds, ['local-session'])
  assert.deepEqual(after.tables.workspaces['local-workspace'].sessionIds, ['local-session'])
  assert.equal(after.tables.workspaces['local-workspace'].title, 'Keep ordinary')
  assert.deepEqual(await applyFederationDerived(await planFederationDerived(f.options)), { projectionRecordsDeleted: 0, workspacesDeleted: 0, workspacesUpdated: 0 })
})

test('malformed/legacy/backup cache and pending workspace mutation reject without writes or new backups', async t => {
  const f = await fixture(t), before = await readFile(f.workspacePath, 'utf8'), original = await readFile(f.remoteCache, 'utf8')
  for (const text of ['broken json', JSON.stringify({ version: 999, record: {} }), JSON.stringify({ version: projectionCacheDomainSpec.version, record: {} })]) {
    await writeFile(f.remoteCache, text)
    await assert.rejects(planFederationDerived(f.options), { code: 'RESET_DERIVED_PROVIDER_UNSUPPORTED' })
    assert.equal(await readFile(f.remoteCache, 'utf8'), text)
    assert.equal((await readdir(join(f.remoteCache, '..'))).some(name => name.includes('.bak')), false)
    assert.equal(await readFile(f.workspacePath, 'utf8'), before)
  }
  await writeFile(f.remoteCache, original)
  for (const path of [join(f.options.storageRoot, 'session_projcache.json'), f.remoteCache + '.bak.123', f.workspacePath + '.bak.123']) {
    await writeFile(path, 'legacy copy')
    await assert.rejects(planFederationDerived(f.options), { code: 'RESET_DERIVED_PROVIDER_UNSUPPORTED' }); await rm(path)
  }
  f.workspace.global.pendingMutation = { operation: 'delete', workspaceId: 'remote-workspace' }
  await writeFile(f.workspacePath, JSON.stringify(f.workspace))
  await assert.rejects(planFederationDerived(f.options), { code: 'RESET_DERIVED_PROVIDER_UNSUPPORTED' })
})

test('a recreated ordinary projection with an old remote id is never deleted', async t => {
  const f = await fixture(t)
  await writeFile(f.remoteCache, JSON.stringify(f.checkpoint(join(f.root, 'ordinary-new'))))
  const before = await readFile(f.remoteCache, 'utf8')
  await assert.rejects(planFederationDerived(f.options), { code: 'RESET_DERIVED_OWNERSHIP_UNPROVEN', target: f.remoteCache })
  assert.equal(await readFile(f.remoteCache, 'utf8'), before)
})

test('an empty unmaterialized store stays absent through plan and apply', async t => {
  const f = await fixture(t); await rm(f.options.storageRoot, { recursive: true })
  const plan = await planFederationDerived(f.options)
  await applyFederationDerived(plan)
  await assert.rejects(readdir(f.options.storageRoot), { code: 'ENOENT' })
})

test('saved remote workspace deletion witnesses reconcile a crash between table deletion and global rewrite', async t => {
  const f = await fixture(t), plan = await planFederationDerived(f.options)
  delete f.workspace.tables.workspaces['remote-workspace']
  await writeFile(f.workspacePath, JSON.stringify(f.workspace))
  await assert.rejects(planFederationDerived(f.options), { code: 'RESET_DERIVED_PROVIDER_UNSUPPORTED' })
  const resumed = await planFederationDerived({ ...f.options, pendingWorkspaceDeletes: plan.workspaceDeletionWitnesses })
  await applyFederationDerived(resumed)
  assert.deepEqual(JSON.parse(await readFile(f.workspacePath, 'utf8')).global.workspaceIds, ['local-workspace'])
})

test('pending workspace witness cannot remove a recreated ordinary workspace or accept duplicate witnesses', async t => {
  const f = await fixture(t), plan = await planFederationDerived(f.options)
  f.workspace.tables.workspaces['remote-workspace'].path = join(f.root, 'new-ordinary-workspace')
  f.workspace.tables.workspaces['remote-workspace'].sessionIds = ['new-ordinary-session']
  const text = JSON.stringify(f.workspace); await writeFile(f.workspacePath, text)
  const options = { ...f.options, pendingWorkspaceDeletes: plan.workspaceDeletionWitnesses }
  await assert.rejects(planFederationDerived(options), { code: 'RESET_DERIVED_OWNERSHIP_UNPROVEN', target: f.workspacePath })
  await assert.rejects(planFederationDerived({ ...options, pendingWorkspaceDeletes: [...plan.workspaceDeletionWitnesses, ...plan.workspaceDeletionWitnesses] }), { code: 'RESET_DERIVED_PROVIDER_UNSUPPORTED' })
  assert.equal(await readFile(f.workspacePath, 'utf8'), text)
})

test('remote checkpoint witnesses must still match the recorded cwd and lifecycle', async t => {
  const f = await fixture(t), row = JSON.parse(await readFile(f.remoteCache, 'utf8')).record
  const options = { ...f.options, remoteSessionWitnesses: [{ id: 'remote-session', cwd: row.identity.cwd, createdAt: row.identity.createdAt }] }
  assert.deepEqual((await planFederationDerived(options)).projectionSessionIds, ['remote-session'])
  await assert.rejects(planFederationDerived({ ...options, remoteSessionWitnesses: [{ ...options.remoteSessionWitnesses[0], createdAt: 2 }] }), { code: 'RESET_DERIVED_OWNERSHIP_UNPROVEN' })
  await assert.rejects(planFederationDerived({ ...options, remoteSessionWitnesses: [{ ...options.remoteSessionWitnesses[0], cwd: join(f.options.remoteWorkspaceRoot, 'different-binding') }] }), { code: 'RESET_DERIVED_OWNERSHIP_UNPROVEN' })
})

test('apply rejects intervening ordinary storage edits before opening a public backend', async t => {
  const f = await fixture(t), plan = await planFederationDerived(f.options)
  f.workspace.tables.workspaces['local-workspace'].title = 'New ordinary edit'
  const text = JSON.stringify(f.workspace); await writeFile(f.workspacePath, text)
  await assert.rejects(applyFederationDerived(plan), { code: 'RESET_DERIVED_PROVIDER_UNSUPPORTED' })
  assert.equal(await readFile(f.workspacePath, 'utf8'), text)
  assert.ok(await readFile(f.remoteCache))
})


test('orphan remote-looking cache or workspace records cannot be silently retained as a successful reset', async t => {
  const f = await fixture(t), original = await readFile(f.workspacePath, 'utf8')
  const orphan = join(f.remoteCache, '..', 'unbound-remote.json')
  await writeFile(orphan, JSON.stringify(f.checkpoint(join(f.options.remoteWorkspaceRoot, 'unknown-binding'))))
  await assert.rejects(planFederationDerived(f.options), { code: 'RESET_DERIVED_OWNERSHIP_UNPROVEN', target: orphan })
  assert.equal(await readFile(f.workspacePath, 'utf8'), original)
  await rm(orphan)
  f.workspace.tables.workspaces['remote-workspace'].sessionIds.push('unbound-remote')
  const changed = JSON.stringify(f.workspace); await writeFile(f.workspacePath, changed)
  await assert.rejects(planFederationDerived(f.options), { code: 'RESET_DERIVED_OWNERSHIP_UNPROVEN', target: f.workspacePath })
  assert.equal(await readFile(f.workspacePath, 'utf8'), changed)
})

test('an ordinary deleted default registration retains its initialization identity during remote cleanup and retry', async t => {
  const f = await fixture(t)
  f.workspace.global.defaultWorkspaceId = 'formerly-registered-ordinary-default'
  await writeFile(f.workspacePath, JSON.stringify(f.workspace))
  const plan = await planFederationDerived(f.options)
  assert.deepEqual(plan.workspaceDeletes, ['remote-workspace'])
  await applyFederationDerived(plan)
  const after = JSON.parse(await readFile(f.workspacePath, 'utf8'))
  assert.equal(after.global.defaultWorkspaceId, 'formerly-registered-ordinary-default')
  assert.equal(after.global.initialized, true)
  assert.deepEqual(after.global.workspaceIds, ['local-workspace'])
  const beforeRetry = await readFile(f.workspacePath, 'utf8')
  const retry = await planFederationDerived(f.options)
  assert.equal(retry.globalUpdate, false)
  await applyFederationDerived(retry)
  assert.equal(await readFile(f.workspacePath, 'utf8'), beforeRetry)
})

test('only an exact remote deletion witness clears an orphan default identity', async t => {
  const f = await fixture(t), remotePath = f.workspace.tables.workspaces['remote-workspace'].path
  delete f.workspace.tables.workspaces['remote-workspace']
  f.workspace.global.workspaceIds = ['local-workspace']
  await writeFile(f.workspacePath, JSON.stringify(f.workspace))
  // Its name alone proves nothing: a registration may legitimately have been deleted.
  const unproven = await planFederationDerived(f.options)
  assert.deepEqual(unproven.workspaceDeletes, [])
  const proven = await planFederationDerived({ ...f.options, pendingWorkspaceDeletes: [{ id: 'remote-workspace', path: remotePath }] })
  assert.deepEqual(proven.workspaceDeletes, ['remote-workspace'])
  await applyFederationDerived(proven)
  const after = JSON.parse(await readFile(f.workspacePath, 'utf8'))
  assert.equal(after.global.defaultWorkspaceId, undefined)
  assert.equal(after.global.initialized, true)
  assert.deepEqual(after.global.workspaceIds, ['local-workspace'])
})

test('a valid orphan default identity does not excuse workspace order drift', async t => {
  const f = await fixture(t)
  f.workspace.global.defaultWorkspaceId = 'old-default'
  f.workspace.global.workspaceIds.push('unproven-missing-registration')
  const missing = JSON.stringify(f.workspace); await writeFile(f.workspacePath, missing)
  await assert.rejects(planFederationDerived(f.options), { code: 'RESET_DERIVED_PROVIDER_UNSUPPORTED', target: f.workspacePath })
  assert.equal(await readFile(f.workspacePath, 'utf8'), missing)
  f.workspace.global.workspaceIds = ['remote-workspace']
  const unordered = JSON.stringify(f.workspace); await writeFile(f.workspacePath, unordered)
  await assert.rejects(planFederationDerived(f.options), { code: 'RESET_DERIVED_PROVIDER_UNSUPPORTED', target: f.workspacePath })
  assert.equal(await readFile(f.workspacePath, 'utf8'), unordered)
})
