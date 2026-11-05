import { readFileSync, readSync, writeFileSync, renameSync, unlinkSync, openSync, closeSync, fsyncSync, statSync, mkdirSync, existsSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { acquireDatabaseLock, safeFile, resetError } from './database-lock.js'

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
  mkdirSync(dirname(databasePath), { recursive: true })
  const lock = acquireDatabaseLock(databasePath, { reset: true })
  try {
    lock.beginReset()
    beforeStep?.('config')
    const next = { ...config, peers: [] }
    const contents = JSON.stringify(next, null, 2) + '\n'
    if (existsSync(temporary) && readFileSync(temporary, 'utf8') !== contents) throw resetError('RESET_TEMP_CONFLICT')
    writeFileSync(temporary, contents, { mode: statSync(path).mode & 0o777 })
    const fd = openSync(temporary, 'r'); try { fsyncSync(fd) } finally { closeSync(fd) }
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
