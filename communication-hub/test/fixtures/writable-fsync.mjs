import assert from 'node:assert/strict'
import fs from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'

const flush = fs.fsyncSync
let fileFlushes = 0
fs.fsyncSync = fd => {
  if (fs.fstatSync(fd).isFile()) {
    const byte = Buffer.alloc(1)
    assert.equal(fs.readSync(fd, byte, 0, 1, 0), 1)
    // Enforce FlushFileBuffers' write-access requirement on every test platform.
    fs.writeSync(fd, byte, 0, 1, 0)
    fileFlushes++
  }
  return flush(fd)
}
syncBuiltinESMExports()
process.once('exit', code => {
  if (code === 0) assert.ok(fileFlushes > 0, 'reset must durably flush the replacement configuration')
})
