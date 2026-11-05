import { DatabaseSync } from 'node:sqlite'
import { lstatSync } from 'node:fs'
import { resolve, parse, join } from 'node:path'

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

export function acquireDatabaseLock(path, { reset = false } = {}) {
  if (path === ':memory:') return { close() {} }
  const lockPath = safeFile(`${safeFile(path)}.lock`)
  for (const suffix of ['-journal', '-wal', '-shm']) safeFile(lockPath + suffix)
  let db
  try {
    db = new DatabaseSync(lockPath)
    // SQLite's OS locks survive commits in EXCLUSIVE mode and vanish on process exit.
    // Never unlink this empty coordination database: that would split the lock domain.
    db.exec('PRAGMA busy_timeout=0; PRAGMA locking_mode=EXCLUSIVE; BEGIN EXCLUSIVE; COMMIT;')
    if (!reset && db.prepare('PRAGMA user_version').get().user_version !== 0) throw resetError('HUB_RESET_INCOMPLETE')
    let closed = false
    return {
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
