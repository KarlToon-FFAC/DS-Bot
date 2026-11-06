import { DatabaseSync } from 'node:sqlite'
import { readFileSync, readSync, writeFileSync, renameSync, unlinkSync, openSync, closeSync, fsyncSync, statSync, mkdirSync, existsSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { pathToFileURL } from 'node:url'
import { acquireDatabaseLock, inspectDatabaseLock, safeFile, resetError } from './database-lock.js'

export const RESET_CONFIRMATION = 'DELETE ALL HUB DATA'
const suffixes = ['', '-wal', '-shm', '-journal']

export function resetHub({ configPath, confirmation, beforeStep } = {}) {
  if (confirmation !== RESET_CONFIRMATION) throw resetError('RESET_CONFIRMATION_REQUIRED')
  if (typeof configPath !== 'string' || !configPath.trim()) throw resetError('EXPLICIT_CONFIG_REQUIRED')
  const path = safeFile(configPath)
  const config = JSON.parse(readFileSync(path, 'utf8'))
  if (!config || typeof config !== 'object' || Array.isArray(config) || typeof config.databasePath !== 'string' || !config.databasePath.trim() || config.databasePath === ':memory:') throw resetError('INVALID_CONFIG')
  const databasePath = resolve(dirname(path), config.databasePath)
  const targets = suffixes.map(suffix => safeFile(databasePath + suffix))
  const temporary = safeFile(path + '.reset-tmp')
  if ([...targets, databasePath + '.lock', databasePath + '.lock-journal'].includes(path) || targets.includes(temporary)) throw resetError('UNSAFE_DATABASE_PATH')
  // A mistaken config must not turn this command into an arbitrary file remover.
  try {
    const fd = openSync(databasePath, 'r')
    try {
      const header = Buffer.alloc(16); readSync(fd, header, 0, 16, 0)
      if (statSync(databasePath).size && header.toString() !== 'SQLite format 3\0') throw resetError('INVALID_DATABASE_FILE')
    } finally { closeSync(fd) }
  } catch (error) { if (error.code !== 'ENOENT') throw error }
  // An orphan WAL/journal is not evidence that this path belongs to a Hub.
  const orphanSidecars = (!existsSync(databasePath) || statSync(databasePath).size === 0) && targets.slice(1).some(target => existsSync(target))
  if (orphanSidecars && !inspectDatabaseLock(databasePath).pending) throw Object.assign(resetError('RESET_QUEUE_OWNERSHIP_UNPROVEN'), { target: databasePath })
  mkdirSync(dirname(databasePath), { recursive: true })
  const lock = acquireDatabaseLock(databasePath, { reset: true })
  try {
    if (orphanSidecars && !lock.pending) throw Object.assign(resetError('RESET_QUEUE_OWNERSHIP_UNPROVEN'), { target: databasePath })
    // A correct SQLite header alone does not prove that this is a Hub database.
    if (existsSync(databasePath) && statSync(databasePath).size) {
      const signature = { instances: ['id', 'epoch', 'trusted', 'pairing_revision'], principals: ['id', 'instance_id', 'kind', 'local_id'],
        conversations: ['id', 'kind', 'dm_key', 'seq'], messages: ['id', 'conversation_id', 'author_id', 'body'],
        deliveries: ['id', 'message_id', 'recipient_id', 'membership_epoch'], operations: ['id', 'instance_id', 'hash', 'result'], schema_version: ['version'] }
      const verify = path => {
        const db = new DatabaseSync(path, { readOnly: true })
        try {
          for (const [table, expected] of Object.entries(signature)) {
            const columns = new Set(db.prepare(`PRAGMA table_info("${table}")`).all().map(column => column.name))
            if (expected.some(name => !columns.has(name))) throw resetError('NOT_A_HUB_DATABASE')
          }
        } finally { db.close() }
      }
      // A closed Hub may leave corrupt/stale sidecars. Immutable inspection proves
      // the main file without replaying those. Fresh schema can still live in WAL.
      try { verify(pathToFileURL(databasePath).href + '?immutable=1') }
      catch {
        try { verify(databasePath) }
        catch { throw Object.assign(resetError('NOT_A_HUB_DATABASE'), { target: databasePath }) }
      }
    }
    lock.beginReset()
    beforeStep?.('config')
    const next = { ...config, peers: [] }
    const contents = JSON.stringify(next, null, 2) + '\n'
    if (existsSync(temporary) && readFileSync(temporary, 'utf8') !== contents) throw resetError('RESET_TEMP_CONFLICT')
    writeFileSync(temporary, contents, { mode: statSync(path).mode & 0o777 })
    // Windows FlushFileBuffers requires write access to the file handle.
    const fd = openSync(temporary, 'r+'); try { fsyncSync(fd) } finally { closeSync(fd) }
    renameSync(temporary, path)
    for (const target of targets) {
      beforeStep?.(target)
      safeFile(target)
      try { unlinkSync(target) } catch (error) { if (error.code !== 'ENOENT') throw error }
    }
    // Persist directory entries before clearing the interrupted-reset fence.
    if (process.platform !== 'win32') for (const directory of new Set([dirname(path), dirname(databasePath)])) {
      const fd = openSync(directory, 'r'); try { fsyncSync(fd) } finally { closeSync(fd) }
    }
    lock.finishReset()
    return { reset: true, databasePath, staticPeersRemoved: Array.isArray(config.peers) ? config.peers.length : 0, backupCreated: false, formerPeerCredentialEnvironments: [...new Set((config.peers ?? []).map(peer => peer.credentialEnv).filter(name => typeof name === 'string' && /^[A-Z][A-Z0-9_]*$/.test(name)))] }
  } finally { lock.close() }
}
