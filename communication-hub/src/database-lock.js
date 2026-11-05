import { DatabaseSync } from 'node:sqlite'
import { lstatSync, existsSync, statSync } from 'node:fs'
import { resolve, parse, join } from 'node:path'
import { pathToFileURL } from 'node:url'

export function resetError(code) { return Object.assign(new Error(code), { code }) }

// Refuse aliases, including parent-directory links, before opening or deleting files.
export function safeFile(path) {
  const absolute = resolve(path), root = parse(absolute).root
  let current = root
  for (const part of absolute.slice(root.length).split(/[\\/]/).filter(Boolean)) {
    current = join(current, part)
    let stat
    try { stat = lstatSync(current) } catch (error) { if (error.code === 'ENOENT') continue; throw error }
    if (stat.isSymbolicLink() || current !== absolute && !stat.isDirectory() || current === absolute && (!stat.isFile() || stat.nlink !== 1)) throw resetError('UNSAFE_DATABASE_PATH')
  }
  return absolute
}

function coordinationState(db) {
  const version = db.prepare('PRAGMA user_version').get().user_version
  if (![0, 1].includes(version) || db.prepare('SELECT 1 FROM sqlite_schema LIMIT 1').get()
    || db.prepare('PRAGMA application_id').get().application_id !== 0
    || db.prepare('PRAGMA page_count').get().page_count > 1) throw resetError('INVALID_HUB_LOCK')
  return { pending: version === 1 }
}

// This probe must not replay journals, checkpoint WAL, or create a missing file.
export function inspectDatabaseLock(path) {
  const lockPath = safeFile(`${safeFile(path)}.lock`)
  for (const suffix of ['-journal', '-wal', '-shm']) {
    const sidecar = safeFile(lockPath + suffix)
    // Our coordination database never uses WAL, so these cannot prove ownership.
    if (suffix !== '-journal' && existsSync(sidecar) && statSync(sidecar).size) throw resetError('INVALID_HUB_LOCK')
  }
  if (!existsSync(lockPath)) {
    if (['-journal', '-wal', '-shm'].some(suffix => existsSync(lockPath + suffix))) throw resetError('INVALID_HUB_LOCK')
    return { exists: false, pending: false }
  }
  let db
  try {
    db = new DatabaseSync(pathToFileURL(lockPath).href + '?immutable=1', { readOnly: true })
    return { exists: true, ...coordinationState(db) }
  } catch { throw resetError('INVALID_HUB_LOCK') }
  finally { db?.close() }
}

export function acquireDatabaseLock(path, { reset = false } = {}) {
  if (path === ':memory:') return { close() {} }
  const lockPath = safeFile(`${safeFile(path)}.lock`)
  for (const suffix of ['-journal', '-wal', '-shm']) safeFile(lockPath + suffix)
  inspectDatabaseLock(path)
  let db
  try {
    db = new DatabaseSync(lockPath)
    // SQLite's OS locks survive commits in EXCLUSIVE mode and vanish on process exit.
    // Never unlink this empty coordination database: that would split the lock domain.
    db.exec('PRAGMA busy_timeout=0; PRAGMA locking_mode=EXCLUSIVE; BEGIN EXCLUSIVE; COMMIT;')
    const { pending } = coordinationState(db)
    if (!reset && pending) throw resetError('HUB_RESET_INCOMPLETE')
    let closed = false
    return {
      pending,
      beginReset() { db.exec('PRAGMA user_version=1') },
      finishReset() { db.exec('PRAGMA user_version=0') },
      close() { if (!closed) { closed = true; db.close() } },
    }
  } catch (error) {
    db?.close()
    if (error.errcode === 5 || error.errcode === 6) throw resetError('HUB_ACTIVE_STOP_REQUIRED')
    throw error
  }
}
