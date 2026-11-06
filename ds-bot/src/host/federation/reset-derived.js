import { lstat, readdir, readFile } from 'node:fs/promises'
import { resolve, isAbsolute, relative, join, basename } from 'node:path'
import { assertResetAncestors } from './reset-path.js'
import { createHash } from 'node:crypto'
import { Context } from '@deepseek-ai/cordis'
import Storage from '@deepseek-ai/dsh-storage'
import * as Json from '@deepseek-ai/dsh-storage-json'
import * as Domains from '@deepseek-ai/dsh-storage-domain'
import { workspaceDomainSpec, workspaceDomainState, workspaceRecord } from '@deepseek-ai/dsh-workspace'
import { projectionCacheDomainSpec, checkpointRecord } from '@deepseek-ai/dsh-session-projection-cache'

const fail = target => { throw Object.assign(new Error('RESET_DERIVED_PROVIDER_UNSUPPORTED'), { code: 'RESET_DERIVED_PROVIDER_UNSUPPORTED', ...(target ? { target } : {}) }) }
const inside = (root, path) => { const rel = relative(root, path); return rel && !rel.startsWith('..') && !isAbsolute(rel) }
const ownershipFail = target => { throw Object.assign(new Error('RESET_DERIVED_OWNERSHIP_UNPROVEN'), { code: 'RESET_DERIVED_OWNERSHIP_UNPROVEN', target }) }
const plain = value => value && typeof value === 'object' && !Array.isArray(value)
const keys = (value, allowed) => plain(value) && Object.keys(value).every(key => allowed.includes(key))
async function checked(path, directory, optional = false) {
  if (typeof path !== 'string' || !isAbsolute(path) || resolve(path) !== path) fail(path)
  let stat
  try { stat = await lstat(path) } catch (error) { if (error.code !== 'ENOENT' || !optional) fail(path) }
  if (stat && (stat.isSymbolicLink() || (directory ? !stat.isDirectory() : !stat.isFile() || stat.nlink !== 1))) fail(path)
  try { await assertResetAncestors(path, fail) } catch { fail(path) }
  return stat
}
async function readDocument(path, fingerprints) {
  await checked(path, false)
  const text = await readFile(path, 'utf8')
  fingerprints.push({ path, sha256: createHash('sha256').update(text).digest('hex') })
  try { return JSON.parse(text) } catch { fail(path) }
}
function validate(schema, value, path) { const result = schema.safeParse(value); if (!result.success) fail(path); return result.data }

export async function planFederationDerived({ storageRoot, remoteSessionIds, remoteWorkspaceRoot, provider, remoteSessionWitnesses = [], pendingWorkspaceDeletes = [] } = {}) {
  if (provider !== 'json' || !Array.isArray(remoteSessionIds) || remoteSessionIds.some(id => typeof id !== 'string' || !/^[A-Za-z0-9_-]+$/.test(id))) fail(storageRoot)
  await checked(remoteWorkspaceRoot, true, true)
  if (basename(remoteWorkspaceRoot) !== 'communication-workspaces') fail(remoteWorkspaceRoot)
  if (!Array.isArray(remoteSessionWitnesses) || !Array.isArray(pendingWorkspaceDeletes)) fail(storageRoot)
  for (const witness of pendingWorkspaceDeletes) if (!witness || typeof witness.id !== 'string' || !/^[A-Za-z0-9_-]+$/.test(witness.id) || typeof witness.path !== 'string' || !isAbsolute(witness.path) || resolve(witness.path) !== witness.path || !inside(remoteWorkspaceRoot, witness.path)) fail(storageRoot)
  for (const witness of remoteSessionWitnesses) if (!witness || typeof witness.id !== 'string' || !remoteSessionIds.includes(witness.id) || typeof witness.cwd !== 'string' || !isAbsolute(witness.cwd) || resolve(witness.cwd) !== witness.cwd || !inside(remoteWorkspaceRoot, witness.cwd) || witness.createdAt !== undefined && !Number.isFinite(witness.createdAt)) fail(storageRoot)
  if (new Set(pendingWorkspaceDeletes.map(row => row.id)).size !== pendingWorkspaceDeletes.length || new Set(remoteSessionWitnesses.map(row => row.id)).size !== remoteSessionWitnesses.length) fail(storageRoot)
  const pendingIds = new Set(pendingWorkspaceDeletes.map(row => row.id))
  const options = { storageRoot, remoteSessionIds: [...new Set(remoteSessionIds)], remoteWorkspaceRoot, provider, remoteSessionWitnesses, pendingWorkspaceDeletes }, ids = new Set(options.remoteSessionIds)
  const fingerprints = [], workspaceDeletes = [], workspaceUpdates = [], projectionSessionIds = []
  const workspaceDeletionWitnesses = [...pendingWorkspaceDeletes]
  const result = { options, fingerprints, workspaceDeletes, workspaceUpdates, workspaceDeletionWitnesses, projectionSessionIds, globalUpdate: false }
  if (!(await checked(storageRoot, true, true))) return result
  for (const name of await readdir(storageRoot)) {
    if ((name.startsWith('workspace') || name.startsWith('session_projcache') || name.startsWith('.workspace') || name.startsWith('.session_projcache')) && !['workspace.json', 'session_projcache'].includes(name)) fail(join(storageRoot, name))
  }
  const workspacePath = join(storageRoot, 'workspace.json')
  if (await checked(workspacePath, false, true)) {
    const doc = await readDocument(workspacePath, fingerprints)
    if (!keys(doc, ['unit', 'global', 'tables']) || !keys(doc.unit, ['name', 'version']) || doc.unit.name !== workspaceDomainSpec.name || doc.unit.version !== workspaceDomainSpec.version
      || !keys(doc.tables, ['workspaces']) || !plain(doc.tables.workspaces)) fail(workspacePath)
    const state = doc.global === null ? workspaceDomainSpec.global.initial : validate(workspaceDomainState.strict(), doc.global, workspacePath)
    if (state.pendingMutation) fail(workspacePath)
    // The default identity outlives its deleted registration (public workspace lifecycle).
    // Only registry order, not that initialization marker, must name current records.
    const records = Object.entries(doc.tables.workspaces)
    if (new Set(state.workspaceIds).size !== state.workspaceIds.length || records.some(([id]) => !/^[A-Za-z0-9_-]+$/.test(id) || !state.workspaceIds.includes(id))
      || state.workspaceIds.some(id => !Object.hasOwn(doc.tables.workspaces, id) && !pendingIds.has(id))) fail(workspacePath)
    for (const [id, raw] of records) {
      const row = validate(workspaceRecord.strict(), raw, workspacePath)
      const deletedWitness = pendingWorkspaceDeletes.find(witness => witness.id === id)
      if (deletedWitness && deletedWitness.path !== row.path) ownershipFail(workspacePath)
      if (!isAbsolute(row.path) || resolve(row.path) !== row.path) fail(workspacePath)
      const remaining = row.sessionIds.filter(session => !ids.has(session))
      if ((row.path === remoteWorkspaceRoot || inside(remoteWorkspaceRoot, row.path)) && remaining.length) ownershipFail(workspacePath)
      if (inside(remoteWorkspaceRoot, row.path) && !remaining.length) {
        workspaceDeletes.push(id)
        if (!pendingIds.has(id)) workspaceDeletionWitnesses.push({ id, path: row.path })
      }
      else if (remaining.length !== row.sessionIds.length) workspaceUpdates.push(id)
    }
    for (const id of pendingIds) if (!Object.hasOwn(doc.tables.workspaces, id) && (state.workspaceIds.includes(id) || state.defaultWorkspaceId === id)) workspaceDeletes.push(id)
    result.globalUpdate = workspaceDeletes.length > 0 || [...state.archivedSessionIds, ...state.pinnedSessionIds].some(id => ids.has(id))
  }
  const cacheRoot = join(storageRoot, 'session_projcache')
  if (await checked(cacheRoot, true, true)) {
    for (const name of await readdir(cacheRoot)) if (name !== 'sessions') fail(join(cacheRoot, name))
    const sessions = join(cacheRoot, 'sessions')
    if (await checked(sessions, true, true)) for (const name of await readdir(sessions)) {
      if (!/^[A-Za-z0-9_-]+\.json$/.test(name)) fail(join(sessions, name))
      const path = join(sessions, name), doc = await readDocument(path, fingerprints)
      if (!keys(doc, ['version', 'record']) || ![projectionCacheDomainSpec.version, ...projectionCacheDomainSpec.compatibleVersions].includes(doc.version)) fail(path)
      const row = validate(checkpointRecord, doc.record, path), id = name.slice(0, -5)
      if (!ids.has(id) && (row.identity.cwd === remoteWorkspaceRoot || typeof row.identity.cwd === 'string' && inside(remoteWorkspaceRoot, row.identity.cwd))) ownershipFail(path)
      if (ids.has(id)) {
        if (typeof row.identity.cwd !== 'string' || !isAbsolute(row.identity.cwd) || resolve(row.identity.cwd) !== row.identity.cwd || !inside(remoteWorkspaceRoot, row.identity.cwd)) ownershipFail(path)
        const witness = remoteSessionWitnesses.find(witness => witness.id === id)
        if (remoteSessionWitnesses.length && !witness || witness && (row.identity.cwd !== witness.cwd || witness.createdAt !== undefined && row.identity.createdAt !== witness.createdAt)) ownershipFail(path)
        projectionSessionIds.push(id)
      }
    }
  }
  fingerprints.sort((a, b) => a.path.localeCompare(b.path))
  return result
}

export async function applyFederationDerived(plan) {
  // Reopening a domain must never silently migrate, skip, back up, or overwrite new ordinary data.
  const fresh = await planFederationDerived(plan.options)
  if (JSON.stringify(fresh) !== JSON.stringify(plan)) fail(plan.options.storageRoot)
  const summary = { projectionRecordsDeleted: plan.projectionSessionIds.length, workspacesDeleted: plan.workspaceDeletes.length, workspacesUpdated: plan.workspaceUpdates.length }
  if (!plan.projectionSessionIds.length && !plan.workspaceDeletes.length && !plan.workspaceUpdates.length && !plan.globalUpdate) return summary
  const root = new Context()
  try {
    await root.plugin(Storage)
    await root.plugin(Json, { root: plan.options.storageRoot })
    await root.plugin(Domains, { backend: 'json' })
    await root.plugin({ name: 'ds-bot-reset-derived', inject: ['storageDomain'], async apply(ctx) {
      const domains = []
      try {
        if (plan.projectionSessionIds.length) {
          const spec = { ...projectionCacheDomainSpec }; delete spec.invalidRecords
          const domain = await ctx.storageDomain.open(spec); domains.push(domain)
          for (const id of plan.projectionSessionIds) await domain.table('sessions').delete(id)
        }
        if (plan.workspaceDeletes.length || plan.workspaceUpdates.length || plan.globalUpdate) {
          const domain = await ctx.storageDomain.open(workspaceDomainSpec); domains.push(domain)
          const table = domain.table('workspaces'), ids = new Set(plan.options.remoteSessionIds), deleted = new Set(plan.workspaceDeletes)
          for (const id of plan.workspaceUpdates) await table.update(id, row => ({ ...row, sessionIds: row.sessionIds.filter(session => !ids.has(session)) }))
          for (const id of plan.workspaceDeletes) await table.delete(id)
          if (plan.globalUpdate) {
            const state = domain.global.get(), next = { ...state, workspaceIds: state.workspaceIds.filter(id => !deleted.has(id)), archivedSessionIds: state.archivedSessionIds.filter(id => !ids.has(id)), pinnedSessionIds: state.pinnedSessionIds.filter(id => !ids.has(id)) }
            if (deleted.has(next.defaultWorkspaceId)) delete next.defaultWorkspaceId
            await domain.global.set(next)
          }
        }
      } finally { for (const domain of domains.reverse()) await domain.close() }
    } })
    return summary
  } finally { await root.fiber.dispose() }
}
