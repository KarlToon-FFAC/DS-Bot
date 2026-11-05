import { createReadStream } from 'node:fs'
import { lstat, readdir, realpath } from 'node:fs/promises'
import { resolve, dirname, join, isAbsolute, relative, basename } from 'node:path'
import { createHash } from 'node:crypto'
import { createZstdDecompress } from 'node:zlib'
import { createInterface } from 'node:readline'
import { createSessionFormatCatalogWithChildren, historicalSessionFormatCatalog, sessionFormatCatalog } from '@deepseek-ai/dsh-session-format-catalog'
import { historicalChildCatalogSource } from '@deepseek-ai/dsh-session-format-v3-to-v4'
import { sessionLogZipEntries, serializeSessionLog } from '@deepseek-ai/dsh-session-log-export'

const fail = (code, target) => { throw Object.assign(new Error(code), { code, ...(target ? { target } : {}) }) }
const digestPattern = /^[a-f0-9]{64}$/
async function checked(path, directory = false, optional = false) {
  if (!isAbsolute(path) || resolve(path) !== path) fail('RESET_ATTACHMENT_ABSOLUTE_PATH_REQUIRED', path)
  let stat
  try { stat = await lstat(path) } catch (error) { if (optional && error.code === 'ENOENT') return null; throw error }
  if (stat.isSymbolicLink() || (directory ? !stat.isDirectory() : !stat.isFile()) || await realpath(path) !== path) fail('RESET_ATTACHMENT_UNSAFE_PATH', path)
  return stat
}
async function walk(root, files = []) {
  if (!(await checked(root, true, true))) return files
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = join(root, entry.name)
    await checked(path, entry.isDirectory())
    if (entry.isDirectory()) await walk(path, files)
    else files.push(path)
  }
  return files
}
async function references(path, catalog = sessionFormatCatalog, artifactOnly = false) {
  const input = createReadStream(path), decoded = path.endsWith('.zstd') ? input.pipe(createZstdDecompress()) : input
  if (decoded !== input) input.once('error', error => decoded.destroy(error))
  const lines = createInterface({ input: decoded, crlfDelay: Infinity })
  let restore
  try {
    for await (const line of lines) {
      if (!line.trim()) fail('RESET_ATTACHMENT_INVALID_SESSION', path)
      let row
      try { row = JSON.parse(line) } catch { fail('RESET_ATTACHMENT_INVALID_SESSION', path) }
      if (!restore) restore = catalog.createRestore(row, { recovery: 'strict', validation: 'transformed' })
      else restore.decodeRow(row)
    }
    if (!restore) fail('RESET_ATTACHMENT_INVALID_SESSION', path)
    const artifact = restore.finish(), refs = new Map()
    if (artifactOnly) return artifact
    const add = (kind, ref) => {
      if (!/^sha256:[a-f0-9]{64}$/.test(ref.attachmentId)) fail('RESET_ATTACHMENT_PROVIDER_UNSUPPORTED')
      const key = `${kind}:${ref.attachmentId.slice(7)}`
      const entry = refs.get(key) ?? { kind, digest: ref.attachmentId.slice(7), names: new Set() }
      if (kind === 'file') {
        if (typeof ref.name !== 'string' || !ref.name || /[\\/]/.test(ref.name)) fail('RESET_ATTACHMENT_INVALID_REFERENCE')
        entry.names.add(ref.name)
      }
      refs.set(key, entry)
    }
    // Use the public exporter so opaque tool arguments/metadata are never mistaken for attachments.
    const attachments = {
      async readImage(ref) { add('image', ref); return { ref, data: new Uint8Array() } },
      async *readFileStream(ref) { add('file', ref); yield new Uint8Array() },
    }
    for await (const entry of sessionLogZipEntries({ attachments }, serializeSessionLog(artifact.header, artifact.events), artifact.header.id, false)) {
      if (entry.chunks) for await (const _chunk of entry.chunks) { /* exhaust the declared file reference */ }
    }
    return refs
  } catch (error) {
    if (error.code?.startsWith('RESET_')) throw error
    fail('RESET_ATTACHMENT_SESSION_UNSUPPORTED', path)
  } finally { lines.close(); decoded.destroy(); input.destroy() }
}

export async function validateAttachmentFile(target) {
  const stat = await checked(target.path, false, true)
  if (!stat) return false
  if (stat.dev !== target.dev || stat.ino !== target.ino || stat.nlink > target.links) fail('RESET_ATTACHMENT_CHANGED', target.path)
  return true
}

export async function planFederationAttachments({ sessionsRoot, remoteSessionDirectories, attachmentDshHome, provider } = {}) {
  if (provider !== '@deepseek-ai/dsh-attachment-local') fail('RESET_ATTACHMENT_PROVIDER_UNSUPPORTED')
  await checked(sessionsRoot, true, true); await checked(attachmentDshHome, true)
  if (!Array.isArray(remoteSessionDirectories)) fail('RESET_ATTACHMENT_INVALID_TARGETS')
  const targets = new Set(remoteSessionDirectories), remote = new Map(), retained = new Map()
  for (const path of targets) { await checked(path, true, true); if (!relative(sessionsRoot, path) || relative(sessionsRoot, path).startsWith('..') || isAbsolute(relative(sessionsRoot, path))) fail('RESET_ATTACHMENT_INVALID_TARGETS') }
  const logs = [], children = new Map(), possibleRetained = new Map()
  for (const path of await walk(sessionsRoot)) {
    const match = /^session(?:\.v([1-9][0-9]*))?\.jsonl(?:\.zstd)?$/.exec(basename(path))
    if (!match) continue
    const version = Number(match[1] ?? 0)
    if (version > 4) fail('RESET_ATTACHMENT_SESSION_UNSUPPORTED')
    const artifact = await references(path, version < 4 ? historicalSessionFormatCatalog : sessionFormatCatalog, true)
    logs.push({ path, id: artifact.header.id })
    // Opaque extension/tool payloads cannot authorize deletion or be assumed reference-free.
    if (!targets.has(dirname(path))) for (const digest of JSON.stringify(artifact.events).matchAll(/sha256:([a-f0-9]{64})/g)) possibleRetained.set(digest[1], path)
    if (artifact.header.parentSession) {
      const previous = children.get(artifact.header.id)
      if (!previous || previous.version < version) children.set(artifact.header.id, { version, parent: artifact.header.parentSession, source: historicalChildCatalogSource(artifact) })
    }
  }
  for (const { path, id } of logs) {
    const facts = [...children.values()].filter(child => child.parent === id).map(child => child.source)
    const destination = targets.has(dirname(path)) ? remote : retained
    for (const [key, ref] of await references(path, createSessionFormatCatalogWithChildren(facts))) {
      const previous = destination.get(key)
      if (previous) for (const name of ref.names) previous.names.add(name)
      else destination.set(key, ref)
    }
  }
  const base = join(attachmentDshHome, 'attachments', 'v1'), objects = [], known = new Map(), inodeLinks = new Map()
  const register = async (path, key) => {
    const stat = await checked(path)
    const inode = `${stat.dev}:${stat.ino}`
    inodeLinks.set(inode, (inodeLinks.get(inode) ?? 0) + 1)
    const object = { path, key, dev: stat.dev, ino: stat.ino, links: stat.nlink }
    objects.push(object); known.set(key, true)
    return object
  }
  for (const [directory, kind] of [['objects', 'image'], ['file-objects', 'file']]) {
    const root = join(base, directory)
    for (const path of await walk(root)) {
      const pieces = path.slice(root.length + 1).split(/[\\/]/), digest = pieces[1]
      if (pieces.length !== 2 || !digestPattern.test(digest) || pieces[0] !== digest.slice(0, 2)) fail('RESET_ATTACHMENT_LAYOUT_UNSUPPORTED', path)
      const hash = createHash('sha256'); for await (const chunk of createReadStream(path)) hash.update(chunk)
      if (hash.digest('hex') !== digest) fail('RESET_ATTACHMENT_CORRUPT_OBJECT', path)
      await register(path, `${kind}:${digest}`)
    }
  }
  const aliasesRoot = join(base, 'files')
  for (const path of await walk(aliasesRoot)) {
    const pieces = path.slice(aliasesRoot.length + 1).split(/[\\/]/), digest = pieces[1]
    if (pieces.length !== 3 || !digestPattern.test(digest) || pieces[0] !== digest.slice(0, 2)) fail('RESET_ATTACHMENT_LAYOUT_UNSUPPORTED', path)
    const canonical = objects.find(object => object.path === join(base, 'file-objects', pieces[0], digest))
    if (!canonical) fail('RESET_ATTACHMENT_OWNERSHIP_UNPROVEN', path)
    const alias = await register(path, `file:${digest}`)
    alias.aliasName = pieces[2]
    if (!remote.get(alias.key)?.names.has(alias.aliasName) && !retained.get(alias.key)?.names.has(alias.aliasName)) fail('RESET_ATTACHMENT_OWNERSHIP_UNPROVEN', path)
    if (canonical.dev !== alias.dev || canonical.ino !== alias.ino) fail('RESET_ATTACHMENT_UNSAFE_ALIAS', path)
  }
  for (const object of objects) {
    if (inodeLinks.get(`${object.dev}:${object.ino}`) !== object.links) fail('RESET_ATTACHMENT_EXTERNAL_HARDLINK', object.path)
    if (!remote.has(object.key) && !retained.has(object.key)) fail('RESET_ATTACHMENT_OWNERSHIP_UNPROVEN', object.path)
  }
  for (const key of [...remote.keys(), ...retained.keys()]) if (!known.has(key)) fail('RESET_ATTACHMENT_MISSING_OBJECT', join(base, key.startsWith('file:') ? 'file-objects' : 'objects', key.split(':')[1].slice(0, 2), key.split(':')[1]))
  if ((await walk(join(base, 'tmp'))).length) fail('RESET_ATTACHMENT_OWNERSHIP_UNPROVEN', join(base, 'tmp'))
  if (await checked(base, true, true)) for (const name of await readdir(base)) if (!['objects', 'file-objects', 'files', 'tmp'].includes(name)) fail('RESET_ATTACHMENT_LAYOUT_UNSUPPORTED', join(base, name))
  const cache = join(attachmentDshHome, 'cache', 'attachments', 'request-images'), cacheFiles = await walk(cache)
  for (const path of cacheFiles) if ((await checked(path)).nlink !== 1) fail('RESET_ATTACHMENT_EXTERNAL_HARDLINK', path)
  const exclusive = [...remote.keys()].filter(key => !retained.has(key))
  for (const key of exclusive) if (possibleRetained.has(key.split(':')[1])) fail('RESET_ATTACHMENT_OWNERSHIP_UNPROVEN', possibleRetained.get(key.split(':')[1]))
  return { files: objects.filter(object => object.aliasName ? remote.get(object.key)?.names.has(object.aliasName) && !retained.get(object.key)?.names.has(object.aliasName) : exclusive.includes(object.key)), trees: await checked(cache, true, true) ? [cache] : [],
    exclusiveObjects: exclusive.length, sharedObjects: [...remote.keys()].filter(key => retained.has(key)).length }
}
