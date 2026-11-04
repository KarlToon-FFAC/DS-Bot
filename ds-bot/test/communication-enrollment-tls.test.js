import assert from 'node:assert/strict'
import { test } from 'node:test'
import { fork, execFileSync } from 'node:child_process'
import { once } from 'node:events'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname, delimiter, resolve, basename } from 'node:path'
import { fileURLToPath } from 'node:url'
import { startHub } from '../../communication-hub/src/server.js'

const openssl = (process.env.PATH ?? '').split(delimiter).flatMap(path => [join(path, process.platform === 'win32' ? 'openssl.exe' : 'openssl'), join(dirname(path), 'usr/bin/openssl.exe')]).find(path => existsSync(path))
async function client(url, ca) {
  const env = { ...process.env, DSBOT_TEST_TLS_URL: url }
  delete env.NODE_TLS_REJECT_UNAUTHORIZED; delete env.NODE_EXTRA_CA_CERTS
  if (ca) env.NODE_EXTRA_CA_CERTS = ca
  const child = fork(fileURLToPath(new URL('./fixtures/enrollment-tls-client.mjs', import.meta.url)), [], { execArgv: ['--import', new URL('./harness-resolve.mjs', import.meta.url).href], env, windowsHide: true, stdio: ['ignore', 'ignore', 'pipe', 'ipc'] })
  let diagnostic = ''
  child.stderr.on('data', bytes => { diagnostic += bytes })
  const timer = setTimeout(() => child.kill(), 10000)
  try {
    const answer = once(child, 'message'), ended = once(child, 'exit')
    const [result] = await Promise.race([answer, ended.then(() => { throw Error(diagnostic.match(/\bERR_[A-Z0-9_]+\b/)?.[0] ?? 'OWNED_TLS_CHILD_EXIT_BEFORE_RESULT') })])
    await ended; return result
  }
  finally { clearTimeout(timer); if (child.exitCode === null && child.signalCode === null) child.kill() }
}

test('actual enrollment WSS reports untrusted CA, accepts process-start extra CA and still rejects a trusted hostname mismatch', { skip: !openssl, timeout: 30000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), 'dsbot-enrollment-tls-'))
  let hub
  const cert = (name, san) => {
    const certificate = join(root, `${name}.pem`), key = join(root, `${name}.key`)
    execFileSync(openssl, ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-sha256', '-days', '1', '-subj', '/CN=synthetic-enrollment-test', '-addext', `subjectAltName=${san}`, '-keyout', key, '-out', certificate], { stdio: 'ignore', windowsHide: true, timeout: 10000 })
    return { certificate, tls: { cert: readFileSync(certificate), key: readFileSync(key) } }
  }
  try {
    const peers = [{ instanceId: 'synthetic-test-instance', credential: 'synthetic-test-pairing-credential-only' }]
    const valid = cert('valid', 'IP:127.0.0.1')
    hub = await startHub({ databasePath: ':memory:', port: 0, peers, tls: valid.tls })
    assert.deepEqual(await client(hub.url), { connected: false, code: 'HUB_TLS_UNTRUSTED' })
    assert.deepEqual(await client(hub.url, valid.certificate), { connected: true })
    await hub.close(); hub = null
    const mismatch = cert('wrong-host', 'DNS:localhost')
    hub = await startHub({ databasePath: ':memory:', port: 0, peers, tls: mismatch.tls })
    assert.deepEqual(await client(hub.url, mismatch.certificate), { connected: false, code: 'HUB_TLS_HOSTNAME_MISMATCH' })
  } finally {
    await hub?.close()
    assert.equal(dirname(resolve(root)), resolve(tmpdir())); assert.ok(basename(root).startsWith('dsbot-enrollment-tls-'))
    rmSync(root, { recursive: true, force: true })
  }
})
