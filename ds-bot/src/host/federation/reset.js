// Offline maintenance only. No Hub request, enrollment, or recovery is attempted.
import { createReadStream } from 'node:fs'
import { lstat, realpath, readdir, readFile, open, rename, rm, rmdir } from 'node:fs/promises'
import { dirname, join, resolve, isAbsolute, relative, basename } from 'node:path'
import { hostname } from 'node:os'
import { randomUUID, createHash } from 'node:crypto'
import { createZstdDecompress } from 'node:zlib'
import { DatabaseSync } from 'node:sqlite'
import { parseDocument, isMap, isSeq } from 'yaml'
import { homeLock, pidAlive } from '../home-lock.js'

export const RESET_CONFIRMATION = 'ERASE-ALL-FEDERATION-DATA'
const fail = (code, target) => { throw Object.assign(new Error(code), { code, ...(target ? { target } : {}) }) }
const recordKey = /^ds-bot\/communication-[a-f0-9]{32}$/
const scopeName = /^hub-[a-f0-9]{32}(?:-[a-f0-9]{16})?$/
const markerName = 'communication-reset.pending.json'
const epochName = 'communication-browser-epoch'
const inside = (root, path) => { const value = relative(root, path); return value && !value.startsWith('..') && !isAbsolute(value) }

async function info(path) {
  try { return await lstat(path) } catch (error) { if (error.code === 'ENOENT') return null; throw error }
}
export async function checkedPath(path, kind, optional = false) {
  if (typeof path !== 'string' || !isAbsolute(path) || resolve(path) !== path) fail('RESET_ABSOLUTE_PATH_REQUIRED', typeof path === 'string' ? path : undefined)
  const value = await info(path)
  if (!value && !optional) fail('RESET_PATH_MISSING', path)
  if (value?.isSymbolicLink() || value?.nlink > 1 && kind === 'file' || value && (kind === 'file' ? !value.isFile() : !value.isDirectory())) fail('RESET_UNSAFE_PATH', path)
  // Check every existing ancestor, including the missing-file case.
  let parent = value ? path : dirname(path)
  while (!(await info(parent))) parent = dirname(parent)
  if (await realpath(parent) !== parent) fail('RESET_UNSAFE_PATH', path)
  return value
}
async function syncDirectory(path) {
  if (process.platform === 'win32') return
  while (!(await info(path))) path = dirname(path)
  const directory = await open(path, 'r'); try { await directory.sync() } finally { await directory.close() }
}
async function pruneEmptyParents(path, boundary) {
  while (inside(boundary, path)) {
    if (await checkedPath(path, 'directory', true)) {
      try { await rmdir(path) }
      catch (error) { if (['ENOTEMPTY', 'EEXIST'].includes(error.code)) return; if (error.code !== 'ENOENT') throw error }
      await syncDirectory(dirname(path))
    }
    path = dirname(path)
  }
}
async function atomicWrite(path, text, afterAtomicTemp) {
  await checkedPath(path, 'file', true)
  const temp = `${path}.reset-${randomUUID()}`
  const file = await open(temp, 'wx', 0o600)
  try { await file.writeFile(text); await file.sync() } finally { await file.close() }
  await afterAtomicTemp?.({ path, temporaryPath: temp })
  try {
    await rename(temp, path)
    if (process.platform !== 'win32') { const directory = await open(dirname(path), 'r'); try { await directory.sync() } finally { await directory.close() } }
  } finally { await rm(temp, { force: true }) }
}
function yamlDocument(text) {
  const doc = parseDocument(text)
  if (doc.errors.length) fail('RESET_INVALID_YAML')
  return doc
}
function stripProfile(doc, envNames, path) {
  if (!isSeq(doc.contents)) fail('RESET_PROFILE_NOT_PATCH_SEQUENCE')
  let count = 0
  const visit = node => {
    if (isSeq(node)) { for (const child of node.items) visit(child); return }
    if (!isMap(node)) return
    const bot = node.get('id') === 'bot' || node.get('name') === 'ds-bot'
    if (bot) {
      const config = node.get('config', true)
      if (config !== undefined && !isMap(config)) fail('RESET_INVALID_BOT_CONFIG')
      const comm = config?.get('communication', true)
      if (comm !== undefined) {
        if (!isMap(comm)) fail('RESET_INVALID_COMMUNICATION_CONFIG')
        const env = comm.get('credentialEnv') ?? 'DSBOT_COMMUNICATION_CREDENTIAL'
        if (typeof env !== 'string' || !/^DSBOT_COMMUNICATION_[A-Z0-9_]+$/.test(env)) fail('RESET_INVALID_LEGACY_CREDENTIAL')
        envNames.add(env)
        // An arbitrary queue path cannot safely be guessed or silently retained.
        if (comm.has('dataPath')) fail('RESET_CUSTOM_QUEUE_PATH_UNSUPPORTED', path)
        config.delete('communication'); count++
      }
    }
    // insert rows can contain Bot entries; other plugin configs are not traversed.
    for (const key of ['insert', 'before', 'after']) if (node.has(key)) visit(node.get(key, true))
  }
  visit(doc.contents)
  return count
}
function validateProviderConfiguration(doc, path, options) {
  const unsupported = code => fail(code, path)
  const literal = node => node && !node.tag ? node.value : undefined
  const visit = node => {
    if (isSeq(node)) { for (const row of node.items) visit(row); return }
    if (!isMap(node)) return
    const id = node.get('id'), name = node.get('name'), config = node.get('config', true)
    if (name === 'cordis:include') unsupported('RESET_PROFILE_INCLUDE_UNSUPPORTED')
    if (isMap(config)) {
      const selected = (short, packageName = short) => id === short || name === '@deepseek-ai/dsh-' + packageName
      if (selected('session-query-sqlite') && config.has('path') && literal(config.get('path', true)) !== ':memory:') unsupported('RESET_DERIVED_QUERY_INDEX_UNSUPPORTED')
      if (selected('storage-json') && config.has('root') && literal(config.get('root', true)) !== options.storageRoot) unsupported('RESET_DERIVED_PROVIDER_UNSUPPORTED')
      if (selected('storage-domain')) {
        if (config.has('backend') && literal(config.get('backend', true)) !== 'json') unsupported('RESET_DERIVED_PROVIDER_UNSUPPORTED')
        const routes = config.get('routes', true)
        if (routes !== undefined && !isMap(routes)) unsupported('RESET_DERIVED_PROVIDER_UNSUPPORTED')
        for (const key of ['workspace', 'session_projcache']) if (routes?.has(key) && literal(routes.get(key, true)) !== 'json') unsupported('RESET_DERIVED_PROVIDER_UNSUPPORTED')
      }
      if ((selected('session-persistence', 'session-persistence-jsonl') || selected('session-persistence-jsonl')) && config.has('root') && literal(config.get('root', true)) !== options.sessions) unsupported('RESET_SESSION_PROVIDER_UNSUPPORTED')
    }
    if (typeof name === 'string' && name.startsWith('@deepseek-ai/dsh-session-persistence-') && name !== '@deepseek-ai/dsh-session-persistence-jsonl') unsupported('RESET_SESSION_PROVIDER_UNSUPPORTED')
    for (const pair of node.items) if (isMap(pair.value) || isSeq(pair.value)) visit(pair.value)
  }
  visit(doc.contents)
}
async function firstHeader(path) {
  const source = createReadStream(path), decoded = path.endsWith('.zstd') ? source.pipe(createZstdDecompress()) : source
  let text = ''
  try {
    for await (const bytes of decoded) {
      text += bytes.toString('utf8')
      const newline = text.indexOf('\n')
      if (newline >= 0) {
        let header
        try { header = JSON.parse(text.slice(0, newline)) } catch { fail('RESET_SESSION_HEADER_INVALID', path) }
        // The public JSONL format stores the physical header as its first row.
        if (!header || typeof header.id !== 'string' || !Number.isInteger(header.version)) fail('RESET_SESSION_HEADER_INVALID', path)
        return header
      }
      if (text.length > 1048576) fail('RESET_SESSION_HEADER_INVALID', path)
    }
    fail('RESET_SESSION_HEADER_INVALID', path)
  } finally { decoded.destroy(); source.destroy() }
}
function localSessions(value, result = new Set()) {
  if (!value || typeof value !== 'object') return result
  for (const [key, child] of Object.entries(value)) {
    if (['bots', 'rooms'].includes(key) && child && typeof child === 'object' && !Array.isArray(child)) {
      for (const [id, record] of Object.entries(child)) {
        result.add(id)
        if (record && typeof record.id === 'string') result.add(record.id)
      }
    } else if (key === 'privateArchives' && Array.isArray(child)) {
      for (const record of child) if (record && typeof record.id === 'string') result.add(record.id)
    }
    if (key === 'sessions' && child && typeof child === 'object') { for (const id of Object.values(child)) if (typeof id === 'string') result.add(id); localSessions(child, result) }
    else if (key === 'sessionId' && typeof child === 'string') result.add(child)
    else if (key === 'sessionIds' && Array.isArray(child)) { for (const id of child) if (typeof id === 'string') result.add(id) }
    else localSessions(child, result)
  }
  return result
}
async function sessionTargets(root, home, bindingSessions, localIds) {
  const targets = [], workspaceRoot = join(home, 'communication-workspaces')
  if (!(await checkedPath(root, 'directory', true))) {
    if (bindingSessions.size) fail('RESET_SESSION_ROOT_MISSING', root)
    return targets
  }
  for (const project of await readdir(root, { withFileTypes: true })) {
    const projectPath = join(root, project.name)
    await checkedPath(projectPath, 'directory')
    for (const session of await readdir(projectPath, { withFileTypes: true })) {
      const path = join(projectPath, session.name)
      await checkedPath(path, 'directory')
      const logs = (await readdir(path)).filter(name => /^session(?:\.v[1-9][0-9]*)?\.jsonl(?:\.zstd)?$/.test(name))
      let target = false, ordinary = false
      for (const log of logs) {
        await checkedPath(join(path, log), 'file')
        const header = await firstHeader(join(path, log))
        const cwd = typeof header.cwd === 'string' ? resolve(header.cwd) : null
        const remote = cwd && inside(workspaceRoot, cwd)
        if (bindingSessions.has(header.id) && (!remote || bindingSessions.get(header.id) !== cwd)) fail('RESET_SESSION_OWNERSHIP_UNPROVEN', path)
        if (remote) {
          if (!bindingSessions.has(header.id) && header.agentPreset !== 'ds-bot-communication') fail('RESET_SESSION_OWNERSHIP_UNPROVEN', path)
          if (localIds.has(header.id)) fail('RESET_LOCAL_SESSION_CONFLICT', path)
          if (header.agentPreset && header.agentPreset !== 'ds-bot-communication') fail('RESET_SESSION_OWNERSHIP_UNPROVEN', path)
          target = true
        } else ordinary = true
      }
      if (target && ordinary) fail('RESET_SESSION_OWNERSHIP_UNPROVEN', path)
      if (target) targets.push(path)
    }
  }
  // A never-materialized Session may have no file. No journal then exists to erase.
  return targets
}
async function sessionWitnesses(paths) {
  const witnesses = {}
  for (const path of paths) {
    const logs = (await readdir(path)).filter(name => /^session(?:\.v[1-9][0-9]*)?\.jsonl(?:\.zstd)?$/.test(name))
    witnesses[path] = []
    for (const file of logs) {
      const header = await firstHeader(join(path, file))
      witnesses[path].push({ file, id: header.id, cwd: header.cwd, createdAt: header.createdAt, formatVersion: header.version, ...(header.agentPreset ? { agentPreset: header.agentPreset } : {}) })
    }
  }
  return witnesses
}
async function validatePendingSessionWitnesses(pending, sessions) {
  const paths = pending.trees.filter(path => inside(sessions, path))
  if (!pending.sessionWitnesses || typeof pending.sessionWitnesses !== 'object') fail('RESET_INVALID_MANIFEST')
  for (const path of paths) {
    const prior = pending.sessionWitnesses[path]
    if (!Array.isArray(prior) || !prior.length || prior.some(row => !row || typeof row.file !== 'string' || !/^session(?:\.v[1-9][0-9]*)?\.jsonl(?:\.zstd)?$/.test(row.file) || typeof row.id !== 'string' || typeof row.cwd !== 'string')) fail('RESET_INVALID_MANIFEST', path)
    if (!(await info(path))) continue
    await checkedPath(path, 'directory')
    const current = (await sessionWitnesses([path]))[path]
    for (const row of current) if (!prior.some(old => old.file === row.file && old.id === row.id && old.cwd === row.cwd && old.createdAt === row.createdAt && old.formatVersion === row.formatVersion && old.agentPreset === row.agentPreset)) fail('RESET_SESSION_CHANGED_OWNERSHIP', path)
  }
}
async function readPlan(options, pending) {
  const { home, profiles, credentials, sessions, attachmentsHome, storageRoot } = options
  if (!Array.isArray(profiles) || !profiles.length) fail('RESET_PROFILE_REQUIRED')
  await checkedPath(home, 'directory')
  await checkedPath(attachmentsHome, 'directory')
  await checkedPath(storageRoot, 'directory', true)
  const envNames = new Set(pending?.envNames ?? []), profileWrites = [], profileContents = new Map()
  for (const path of new Set(profiles)) {
    await checkedPath(path, 'file')
    const original = await readFile(path, 'utf8'), doc = yamlDocument(original)
    validateProviderConfiguration(doc, path, options)
    const count = stripProfile(doc, envNames, path)
    profileContents.set(path, doc.toString())
    if (count) profileWrites.push({ path, text: doc.toString() })
  }
  await checkedPath(credentials, 'file', true)
  let credentialText, recordCount = 0
  if (await info(credentials)) {
    const doc = yamlDocument(await readFile(credentials, 'utf8'))
    if (!isMap(doc.contents) || doc.get('version') !== 1) fail('RESET_CREDENTIAL_PROVIDER_UNSUPPORTED')
    const records = doc.get('records', true), refs = doc.get('refs', true)
    if (records !== undefined && !isMap(records) || refs !== undefined && !isMap(refs)) fail('RESET_INVALID_CREDENTIAL_STORE')
    for (const pair of [...(records?.items ?? [])]) {
      const key = pair.key?.value
      if (typeof key === 'string' && recordKey.test(key)) { records.delete(key); recordCount++ }
    }
    for (const name of envNames) refs?.delete(name)
    credentialText = doc.toString()
  }
  const queueFiles = [], trees = [], bindingSessions = new Map()
  const collectQueue = async path => {
    for (const suffix of ['', '-wal', '-shm', '-journal']) {
      if (await checkedPath(path + suffix, 'file', true)) queueFiles.push(path + suffix)
    }
    if (!(await info(path))) {
      if (queueFiles.some(file => file.startsWith(path + '-') && !pending?.files?.includes(file))) fail('RESET_QUEUE_OWNERSHIP_UNPROVEN', path)
      return
    }
    const db = new DatabaseSync(path, { readOnly: true })
    try {
      const signature = { metadata: ['key', 'value'], outbox: ['id', 'type', 'payload', 'hash'], inbox: ['delivery_id', 'message_id', 'conversation_id', 'principal_id'] }
      for (const [table, expected] of Object.entries(signature)) {
        const columns = new Set(db.prepare(`PRAGMA table_info("${table}")`).all().map(column => column.name))
        if (expected.some(name => !columns.has(name))) fail('RESET_NOT_A_COMMUNICATION_DATABASE', path)
      }
      if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='bindings'").get()) return
      for (const row of db.prepare('SELECT id,sessions FROM bindings').all()) {
        if (typeof row.id !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(row.id)) fail('RESET_INVALID_BINDING')
        const ids = JSON.parse(row.sessions)
        if (!Array.isArray(ids) || ids.some(id => typeof id !== 'string')) fail('RESET_INVALID_BINDING')
        for (const id of ids) {
          const cwd = join(home, 'communication-workspaces', row.id)
          if (bindingSessions.has(id) && bindingSessions.get(id) !== cwd) fail('RESET_SESSION_OWNERSHIP_UNPROVEN', path)
          bindingSessions.set(id, cwd)
        }
      }
    } finally { db.close() }
  }
  await collectQueue(join(home, 'communication.sqlite'))
  const hubs = join(home, 'communication-hubs')
  if (await checkedPath(hubs, 'directory', true)) {
    for (const entry of await readdir(hubs)) {
      if (!scopeName.test(entry)) fail('RESET_UNKNOWN_HUB_SCOPE')
      const path = join(hubs, entry)
      await checkedPath(path, 'directory'); await collectQueue(join(path, 'communication.sqlite'))
    }
    trees.push(hubs)
  }
  const workspaces = join(home, 'communication-workspaces')
  if (await checkedPath(workspaces, 'directory', true)) trees.push(workspaces)
  const stateFile = join(home, 'state.json')
  await checkedPath(stateFile, 'file', true)
  const localIds = await info(stateFile) ? localSessions(JSON.parse(await readFile(stateFile, 'utf8'))) : new Set()
  for (const id of [...bindingSessions.keys(), ...(pending?.remoteSessionIds ?? [])]) if (localIds.has(id)) fail('RESET_LOCAL_SESSION_CONFLICT', stateFile)
  const journals = await sessionTargets(sessions, home, bindingSessions, localIds)
  const witnesses = { ...(pending?.sessionWitnesses ?? {}), ...await sessionWitnesses(journals) }
  const remoteSessionIds = [...new Set([...bindingSessions.keys(), ...(pending?.remoteSessionIds ?? []), ...Object.values(witnesses).flat().map(row => row.id)])]
  const { planFederationDerived } = await import('./reset-derived.js')
  const derivedPlan = await planFederationDerived({ storageRoot, remoteSessionIds, remoteWorkspaceRoot: join(home, 'communication-workspaces'), provider: 'json', remoteSessionWitnesses: [...new Map(Object.values(witnesses).flat().map(row => [row.id, row])).values()], pendingWorkspaceDeletes: pending?.derivedWorkspaceDeletes ?? [] })
  const { planFederationAttachments } = await import('./reset-attachments.js')
  const attachmentPlan = pending?.attachmentPlan ?? await planFederationAttachments({ sessionsRoot: sessions, remoteSessionDirectories: journals, attachmentDshHome: attachmentsHome, provider: '@deepseek-ai/dsh-attachment-local' })
  return { version: 1, home, profiles, credentials, sessions, sessionWitnesses: witnesses, remoteSessionIds, derivedPlan, profileContents, profileWrites, credentialText, recordCount,
    envNames: [...envNames], attachmentPlan, files: queueFiles, trees: [...journals, ...trees] }
}
async function validateTree(path) {
  if (!(await checkedPath(path, 'directory', true))) return
  for (const entry of await readdir(path, { withFileTypes: true })) {
    const child = join(path, entry.name)
    await checkedPath(child, entry.isDirectory() ? 'directory' : 'file')
    if (entry.isDirectory()) await validateTree(child)
  }
}
async function resetTemporaryFiles(options, plan) {
  const marker = join(options.home, markerName), epoch = join(options.home, epochName)
  const targets = [...new Set([...options.profiles, options.credentials, marker, epoch])], result = []
  const manifestKeys = new Set(['version', 'home', 'options', 'files', 'trees', 'derivedWorkspaceDeletes', 'remoteSessionIds', 'sessionWitnesses', 'envNames', 'attachmentPlan'])
  for (const target of targets) {
    for (const name of await readdir(dirname(target))) {
      const prefix = basename(target) + '.reset-'
      if (!name.startsWith(prefix) || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(name.slice(prefix.length))) continue
      const path = join(dirname(target), name), stat = await checkedPath(path, 'file'), text = await readFile(path, 'utf8')
      let owned = false
      if (target === marker) {
        try {
          const value = JSON.parse(text)
          owned = value && value.version === 1 && value.home === options.home && Object.keys(value).every(key => manifestKeys.has(key))
            && JSON.stringify(value.options) === JSON.stringify({ profiles: options.profiles, credentials: options.credentials, sessions: options.sessions, attachmentsHome: options.attachmentsHome, storageRoot: options.storageRoot })
            && Array.isArray(value.files) && Array.isArray(value.trees) && Array.isArray(value.remoteSessionIds) && Array.isArray(value.envNames) && value.attachmentPlan && value.sessionWitnesses
        } catch { /* An unproven temporary file is a blocker, never guessed disposable. */ }
      } else if (target === epoch) owned = /^[0-9a-f-]{36}$/.test(text)
      else owned = text === (target === options.credentials ? plan.credentialText : plan.profileContents.get(target))
      if (!owned) fail('RESET_TEMP_OWNERSHIP_UNPROVEN', path)
      result.push({ path, dev: stat.dev, ino: stat.ino, sha256: createHash('sha256').update(text).digest('hex') })
    }
  }
  return result
}
async function eraseResetTemporaryFile(target) {
  const stat = await checkedPath(target.path, 'file', true)
  if (!stat) return
  if (stat.dev !== target.dev || stat.ino !== target.ino || createHash('sha256').update(await readFile(target.path)).digest('hex') !== target.sha256) fail('RESET_TEMP_CHANGED', target.path)
  await rm(target.path); await syncDirectory(dirname(target.path))
}
function protectResetInputs(options, trees = [], files = []) {
  const { home, sessions, attachmentsHome, storageRoot, credentials, profiles } = options
  const protectedFiles = [...new Set(profiles ?? []), credentials]
  const roots = [home, sessions, attachmentsHome, storageRoot]
  for (const path of [...roots, ...protectedFiles]) if (typeof path !== 'string' || !isAbsolute(path) || resolve(path) !== path) fail('RESET_ABSOLUTE_PATH_REQUIRED', typeof path === 'string' ? path : undefined)
  if (protectedFiles.length !== new Set(protectedFiles).size) fail('RESET_PROTECTED_PATH_OVERLAP', credentials)
  const permanent = ['state.json', 'state.lock', markerName, epochName].map(name => join(home, name))
  for (const path of protectedFiles) if (permanent.includes(path)) fail('RESET_PROTECTED_PATH_OVERLAP', path)
  const dedicated = [join(home, 'communication-hubs'), join(home, 'communication-workspaces')]
  const cache = join(attachmentsHome, 'cache', 'attachments', 'request-images')
  const contains = (root, path) => root === path || inside(root, path)
  for (const tree of [...dedicated, cache, ...trees]) {
    for (const path of [...protectedFiles, home, sessions, attachmentsHome, storageRoot]) if (contains(tree, path)) fail('RESET_PROTECTED_PATH_OVERLAP', path)
  }
  // A Sessions root that contains a dedicated whole-tree target would otherwise
  // lose ordinary journals even when those were not selected as remote Sessions.
  for (const tree of [...dedicated, cache]) if (contains(sessions, tree)) fail('RESET_PROTECTED_PATH_OVERLAP', sessions)
  const attachmentRoot = join(attachmentsHome, 'attachments', 'v1')
  if (contains(attachmentRoot, sessions) || contains(sessions, attachmentRoot) || contains(sessions, storageRoot) || contains(storageRoot, sessions) || contains(attachmentRoot, storageRoot) || contains(storageRoot, attachmentRoot)) fail('RESET_PROTECTED_PATH_OVERLAP', sessions)
  for (const path of protectedFiles) if (files.includes(path) || contains(attachmentRoot, path)) fail('RESET_PROTECTED_PATH_OVERLAP', path)
}
export async function resetFederation(options) {
  const { home } = options
  await checkedPath(home, 'directory')
  protectResetInputs(options)
  const lockPath = join(home, 'state.lock')
  await checkedPath(lockPath, 'file', true)
  if (await info(lockPath)) {
    let holder
    try { holder = JSON.parse(await readFile(lockPath, 'utf8')) } catch { fail('RESET_HOST_MUST_STOP') }
    if (holder.host !== hostname() || !Number.isSafeInteger(holder.pid) || pidAlive(holder.pid)) fail('RESET_HOST_MUST_STOP')
  }
  const lock = homeLock(lockPath)
  if (lock.claim() !== undefined || !lock.owns()) { lock.release(); fail('RESET_HOST_MUST_STOP') }
  try {
    const marker = join(home, markerName)
    await checkedPath(marker, 'file', true)
    // The manifest holds paths/IDs only, never old configuration or credentials.
    const pending = await info(marker) ? JSON.parse(await readFile(marker, 'utf8')) : null
    if (pending && (pending.version !== 1 || pending.home !== home
      || JSON.stringify(pending.options) !== JSON.stringify({ profiles: options.profiles, credentials: options.credentials, sessions: options.sessions, attachmentsHome: options.attachmentsHome, storageRoot: options.storageRoot }))) fail('RESET_PENDING_OPTIONS_CHANGED')
    if (pending) {
      if (!Array.isArray(pending.files) || !Array.isArray(pending.trees) || !Array.isArray(pending.envNames)
        || !Array.isArray(pending.remoteSessionIds) || pending.remoteSessionIds.some(id => typeof id !== 'string')
        || pending.envNames.some(name => !/^DSBOT_COMMUNICATION_[A-Z0-9_]+$/.test(name))
        || pending.files.some(path => typeof path !== 'string' || !inside(home, path) || !/(?:^|[\\/])communication\.sqlite(?:-wal|-shm|-journal)?$/.test(path))
        || pending.trees.some(path => typeof path !== 'string' || ![join(home, 'communication-hubs'), join(home, 'communication-workspaces')].includes(path)
          && !(inside(options.sessions, path) && relative(options.sessions, path).split(/[\\/]/).length === 2))) fail('RESET_INVALID_MANIFEST')
    }
    if (pending?.attachmentPlan) {
      const base = join(options.attachmentsHome, 'attachments', 'v1')
      if (!Array.isArray(pending.attachmentPlan.files) || !Array.isArray(pending.attachmentPlan.trees)
        || pending.attachmentPlan.files.some(target => !target || typeof target.path !== 'string'
          || !['objects', 'file-objects', 'files'].some(name => inside(join(base, name), target.path))
          || !/^(?:image|file):[a-f0-9]{64}$/.test(target.key) || !Number.isSafeInteger(target.dev) || !Number.isSafeInteger(target.ino) || !Number.isSafeInteger(target.links))
        || pending.attachmentPlan.trees.some(path => path !== join(options.attachmentsHome, 'cache', 'attachments', 'request-images'))) fail('RESET_INVALID_MANIFEST')
    }
    if (pending) await validatePendingSessionWitnesses(pending, options.sessions)
    const plan = await readPlan(options, pending)
    const { validateAttachmentFile, revalidateFederationAttachmentPlan } = await import('./reset-attachments.js')
    if (pending) {
      const previousRemote = pending.trees.filter(path => inside(options.sessions, path))
      await revalidateFederationAttachmentPlan({ sessionsRoot: options.sessions,
        remoteSessionDirectories: [...new Set([...plan.trees.filter(path => inside(options.sessions, path)), ...previousRemote])], attachmentPlan: plan.attachmentPlan })
    }
    for (const target of plan.attachmentPlan.files) await validateAttachmentFile(target)
    for (const path of plan.attachmentPlan.trees) await validateTree(path)
    if (pending) {
      plan.files = [...new Set([...plan.files, ...pending.files])]
      plan.trees = [...new Set([...plan.trees, ...pending.trees])]
    }
    protectResetInputs(options, [...plan.trees, ...plan.attachmentPlan.trees], [...plan.files, ...plan.attachmentPlan.files.map(target => target.path)])
    for (const path of plan.files) await checkedPath(path, 'file', true)
    for (const path of plan.trees) await validateTree(path)
    const temporaryFiles = await resetTemporaryFiles(options, plan)
    const summary = { temporaryFiles: temporaryFiles.length, dryRun: options.confirm !== RESET_CONFIRMATION, configurationFiles: plan.profileWrites.length,
      pairingRecords: plan.recordCount, attachmentFiles: plan.attachmentPlan.files.length, attachmentAliasFiles: plan.attachmentPlan.files.filter(file => file.aliasName).length, projectionRecords: plan.derivedPlan.projectionSessionIds.length, remoteWorkspaceRecords: plan.derivedPlan.workspaceDeletes.length, workspaceSessionAccounts: plan.derivedPlan.workspaceUpdates.length, exclusiveAttachmentObjects: plan.attachmentPlan.exclusiveObjects, sharedAttachmentObjectsPreservedForOrdinarySessions: plan.attachmentPlan.sharedObjects, queueFiles: plan.files.length, remoteDirectories: plan.trees.length,
      browserCleanupPending: true, serverResetRequired: true, irreversible: true, profileCoverage: 'supplied-files-only', backend: 'local-yaml-and-jsonl' }
    if (summary.dryRun) return summary
    if (!lock.owns()) fail('RESET_HOST_MUST_STOP')
    await atomicWrite(marker, JSON.stringify({ version: 1, home, options: { profiles: options.profiles, credentials: options.credentials, sessions: options.sessions, attachmentsHome: options.attachmentsHome, storageRoot: options.storageRoot }, files: plan.files, trees: plan.trees, derivedWorkspaceDeletes: plan.derivedPlan.workspaceDeletionWitnesses, remoteSessionIds: plan.remoteSessionIds, sessionWitnesses: plan.sessionWitnesses, envNames: plan.envNames, attachmentPlan: plan.attachmentPlan }), options.afterAtomicTemp)
    await options.afterStep?.('manifest')
    for (const item of plan.profileWrites) await atomicWrite(item.path, item.text, options.afterAtomicTemp)
    await options.afterStep?.('profiles')
    if (plan.credentialText !== undefined) await atomicWrite(options.credentials, plan.credentialText, options.afterAtomicTemp)
    await options.afterStep?.('credentials')
    const { applyFederationDerived } = await import('./reset-derived.js')
    await applyFederationDerived(plan.derivedPlan)
    await options.afterStep?.('derived')
    // Erase journals first. Queue bindings remain available if cleanup is interrupted.
    for (const path of plan.trees) {
      if (!lock.owns()) fail('RESET_HOST_MUST_STOP')
      await validateTree(path); await rm(path, { recursive: true, force: true }); await syncDirectory(dirname(path))
      if (inside(options.sessions, path)) await pruneEmptyParents(dirname(path), options.sessions)
    }
    await options.afterStep?.('journals')
    for (const target of plan.attachmentPlan.files) {
      if (!lock.owns()) fail('RESET_HOST_MUST_STOP')
      if (await validateAttachmentFile(target)) { await rm(target.path); await syncDirectory(dirname(target.path)) }
      await pruneEmptyParents(dirname(target.path), join(options.attachmentsHome, 'attachments', 'v1'))
    }
    for (const path of plan.attachmentPlan.trees) { await validateTree(path); await rm(path, { recursive: true, force: true }); await syncDirectory(dirname(path)) }
    await options.afterStep?.('attachments')
    for (const path of plan.files) {
      if (!lock.owns()) fail('RESET_HOST_MUST_STOP')
      await checkedPath(path, 'file', true); await rm(path, { force: true }); await syncDirectory(dirname(path))
    }
    await atomicWrite(join(home, epochName), randomUUID(), options.afterAtomicTemp)
    for (const temporary of temporaryFiles) await eraseResetTemporaryFile(temporary)
    await rm(marker); await syncDirectory(home)
    return { ...summary, dryRun: false, erased: true, complete: false,
      clearLaunchEnvironment: plan.envNames, launchEnvironmentCleanupPending: plan.envNames.length > 0, browserCleanup: 'Open and refresh every browser origin/tab connected to this client; each browser clears only its own communication storage.' }
  } finally { lock.release() }
}

export async function federationResetStatus(home) {
  const pending = Boolean(await info(join(home, markerName)))
  let epoch = null
  try { epoch = (await readFile(join(home, epochName), 'utf8')).trim() } catch (error) { if (error.code !== 'ENOENT') throw error }
  return { pending, browserEpoch: epoch }
}
