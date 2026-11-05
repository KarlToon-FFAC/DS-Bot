import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync, symlinkSync, linkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import { once } from 'node:events'
import { HubStore } from '../src/store.js'
import { HubManagement } from '../src/management-store.js'
import { resetHub, RESET_CONFIRMATION } from '../src/reset.js'
import { main } from '../src/reset-cli.js'

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'dsbot-reset-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const configPath = join(root, 'config.json'), databasePath = join(root, 'hub.sqlite')
  const config = { databasePath: './hub.sqlite', host: '127.0.0.1', port: 3190, tls: { certificateEnv: 'CERT', privateKeyEnv: 'KEY' }, management: { enabled: true, adminPasswordEnv: 'PASSWORD' }, peers: [{ instanceId: 'old-device', credentialEnv: 'OLD_SECRET' }] }
  writeFileSync(configPath, JSON.stringify(config))
  return { root, configPath, databasePath, config, reset: options => resetHub({ configPath, confirmation: RESET_CONFIRMATION, ...options }) }
}

test('reset removes every data table, static credentials and sidecar; restart creates a new identity', t => {
  const f = fixture(t), store = new HubStore(f.databasePath), management = new HubManagement(store)
  const oldHubId = management.hubId
  // Populate every table with a recognizable row, regardless of future schema additions.
  store.db.exec('PRAGMA foreign_keys=OFF')
  const tables = store.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all()
  for (const { name } of tables) {
    if (store.db.prepare(`SELECT count(*) n FROM "${name}"`).get().n) continue
    const columns = store.db.prepare(`PRAGMA table_info("${name}")`).all()
    const values = columns.map(c => c.type === 'INTEGER' ? 1 : 'synthetic-old-data')
    store.db.prepare(`INSERT INTO "${name}" VALUES (${columns.map(() => '?').join(',')})`).run(...values)
  }
  store.close()
  for (const suffix of ['-wal', '-shm', '-journal']) writeFileSync(f.databasePath + suffix, 'synthetic residue')
  assert.equal(f.reset().backupCreated, false)
  for (const suffix of ['', '-wal', '-shm', '-journal']) assert.equal(existsSync(f.databasePath + suffix), false)
  assert.deepEqual(JSON.parse(readFileSync(f.configPath)), { ...f.config, peers: [] })
  const clean = new HubStore(f.databasePath), fresh = new HubManagement(clean)
  t.after(() => clean.close())
  assert.notEqual(fresh.hubId, oldHubId)
  for (const { name } of tables) {
    if (['schema_version', 'causal_schema', 'hub_management'].includes(name)) continue
    assert.equal(clean.db.prepare(`SELECT count(*) n FROM "${name}"`).get().n, 0, name)
  }
  assert.deepEqual(clean.db.prepare('SELECT key FROM hub_management').all().map(row => row.key), ['hubId'])
})

test('an active store refuses reset and duplicate opens without changing config', t => {
  const f = fixture(t), store = new HubStore(f.databasePath)
  try {
    assert.throws(() => f.reset(), { code: 'HUB_ACTIVE_STOP_REQUIRED' })
    assert.throws(() => new HubStore(f.databasePath), { code: 'HUB_ACTIVE_STOP_REQUIRED' })
    assert.deepEqual(JSON.parse(readFileSync(f.configPath)), f.config)
  } finally { store.close() }
  f.reset()
})

test('interrupted reset blocks startup, can be rerun, leaves no recovery marker after success', t => {
  const f = fixture(t), store = new HubStore(f.databasePath); store.close()
  assert.throws(() => f.reset({ beforeStep: step => { if (step === f.databasePath) throw Error('injected interruption') } }), /injected/)
  assert.throws(() => new HubStore(f.databasePath), { code: 'HUB_RESET_INCOMPLETE' })
  f.reset(); f.reset()
  const fresh = new HubStore(f.databasePath); fresh.close()
})

test('confirmation and explicit path are mandatory and non-database files are preserved', t => {
  const f = fixture(t)
  assert.throws(() => resetHub({ configPath: f.configPath }), { code: 'RESET_CONFIRMATION_REQUIRED' })
  assert.throws(() => resetHub({ confirmation: RESET_CONFIRMATION }), { code: 'EXPLICIT_CONFIG_REQUIRED' })
  writeFileSync(f.databasePath, 'important non-database file')
  assert.throws(() => f.reset(), { code: 'INVALID_DATABASE_FILE' })
  assert.equal(readFileSync(f.databasePath, 'utf8'), 'important non-database file')
  const out = { write() {} }
  assert.equal(main([], out, out), 2)
  assert.equal(main(['--config', f.configPath, '--confirm', 'yes'], out, out), 2)
})

test('symlinks, hardlinks and directory targets fail closed without touching destination', t => {
  const f = fixture(t), other = join(f.root, 'other')
  writeFileSync(other, 'must remain')
  symlinkSync(other, f.databasePath)
  assert.throws(() => f.reset(), { code: 'UNSAFE_DATABASE_PATH' }); rmSync(f.databasePath)
  linkSync(other, f.databasePath)
  assert.throws(() => f.reset(), { code: 'UNSAFE_DATABASE_PATH' }); rmSync(f.databasePath)
  symlinkSync(other, f.databasePath + '-wal')
  assert.throws(() => f.reset(), { code: 'UNSAFE_DATABASE_PATH' })
  assert.equal(readFileSync(other, 'utf8'), 'must remain')
})

test('OS releases the process lock on a crash; reset succeeds in another process', async t => {
  const f = fixture(t)
  const storeUrl = new URL('../src/store.js', import.meta.url).href
  const child = spawn(process.execPath, ['--input-type=module', '-e', `import {HubStore} from ${JSON.stringify(storeUrl)}; new HubStore(${JSON.stringify(f.databasePath)});console.log('ready');setInterval(()=>{},1000)`], { stdio: ['ignore', 'pipe', 'pipe'] })
  t.after(() => { if (child.exitCode === null) child.kill('SIGKILL') })
  await once(child.stdout, 'data')
  const cli = new URL('../src/reset-cli.js', import.meta.url)
  const blocked = spawnSync(process.execPath, [cli.pathname, '--config', f.configPath, '--confirm', RESET_CONFIRMATION], { encoding: 'utf8' })
  assert.equal(blocked.status, 2); assert.match(blocked.stderr, /HUB_ACTIVE_STOP_REQUIRED/)
  child.kill('SIGKILL'); await once(child, 'exit')
  const result = spawnSync(process.execPath, [cli.pathname, '--config', f.configPath, '--confirm', RESET_CONFIRMATION], { encoding: 'utf8' })
  assert.equal(result.status, 0, result.stderr)
  assert.equal(existsSync(f.databasePath), false)
})

test('a listening Hub refuses reset, then resets after normal shutdown', async t => {
  const { startHub } = await import('../src/server.js')
  const f = fixture(t)
  const hub = await startHub({ databasePath: f.databasePath, port: 0, peers: [{ instanceId: 'synthetic-peer', credential: 'x'.repeat(32) }] })
  try { assert.throws(() => f.reset(), { code: 'HUB_ACTIVE_STOP_REQUIRED' }) }
  finally { await hub.close() }
  f.reset()
  const fresh = await startHub({ databasePath: f.databasePath, port: 0, management: { enabled: true, password: 'synthetic-password-32-characters-long' } })
  try {
    assert.equal(fresh.store.db.prepare('SELECT count(*) n FROM instances').get().n, 0)
    assert.equal(fresh.store.db.prepare('SELECT count(*) n FROM hub_enrolled_peers').get().n, 0)
  } finally { await fresh.close() }
})

test('failed Hub startup releases its lock rather than blocking a reset', async t => {
  const { startHub } = await import('../src/server.js')
  const f = fixture(t)
  await assert.rejects(startHub({ databasePath: f.databasePath, port: 0, tls: { key: 'invalid synthetic key', cert: 'invalid synthetic cert' }, peers: [{ instanceId: 'synthetic-peer', credential: 'x'.repeat(32) }] }))
  assert.equal(f.reset().reset, true)
})

test('a different valid SQLite database is never erased or reconfigured', async t => {
  const f = fixture(t), db = new (await import('node:sqlite')).DatabaseSync(f.databasePath)
  db.exec('CREATE TABLE personal_notes (text TEXT); INSERT INTO personal_notes VALUES (\'must remain\')'); db.close()
  const before = readFileSync(f.databasePath), config = readFileSync(f.configPath)
  assert.throws(() => f.reset(), { code: 'NOT_A_HUB_DATABASE' })
  assert.deepEqual(readFileSync(f.databasePath), before); assert.deepEqual(readFileSync(f.configPath), config)
})
