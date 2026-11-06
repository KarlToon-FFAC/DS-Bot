import { lstat } from 'node:fs/promises'
import { dirname } from 'node:path'

export async function assertResetAncestors(path, reject) {
  // realpath may change case or expand DOS short names without traversing a link.
  // Inspect each ancestor instead, including ancestors of unmaterialized targets.
  for (let ancestor = path; ; ancestor = dirname(ancestor)) {
    try {
      if ((await lstat(ancestor)).isSymbolicLink()) reject(path)
    } catch (error) { if (error.code !== 'ENOENT') throw error }
    if (dirname(ancestor) === ancestor) return
  }
}
