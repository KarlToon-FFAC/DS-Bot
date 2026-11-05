import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, delimiter, dirname, join, resolve } from 'node:path'

export const openssl = (process.env.PATH ?? '').split(delimiter).flatMap(path => [join(path, process.platform === 'win32' ? 'openssl.exe' : 'openssl'), join(dirname(path), 'usr/bin/openssl.exe')]).find(path => existsSync(path))
export function caFixture() {
  const root = mkdtempSync(join(tmpdir(), 'dsbot-scoped-ca-'))
  const run = args => execFileSync(openssl, args, { stdio: 'ignore', windowsHide: true, timeout: 15000 })
  const ca = name => {
    const cert = join(root, `${name}.pem`), key = join(root, `${name}.key`)
    run(['req','-x509','-newkey','rsa:2048','-nodes','-sha256','-days','2','-subj',`/CN=synthetic-${name}`,'-addext','basicConstraints=critical,CA:TRUE','-keyout',key,'-out',cert])
    return { cert, key, pem: readFileSync(cert, 'utf8') }
  }
  const leaf = (name, authority, san = 'IP:127.0.0.1') => {
    const cert = join(root, `${name}.pem`), key = join(root, `${name}.key`), csr = join(root, `${name}.csr`), ext = join(root, `${name}.ext`)
    writeFileSync(ext, `basicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\nsubjectAltName=${san}\n`)
    run(['req','-new','-newkey','rsa:2048','-nodes','-sha256','-subj',`/CN=synthetic-${name}`,'-keyout',key,'-out',csr])
    run(['x509','-req','-in',csr,'-CA',authority.cert,'-CAkey',authority.key,'-CAcreateserial','-out',cert,'-days','1','-sha256','-extfile',ext])
    return { cert: readFileSync(cert, 'utf8'), key: readFileSync(key, 'utf8') }
  }
  return { root, ca, leaf, close() {
    if (dirname(resolve(root)) !== resolve(tmpdir()) || !basename(root).startsWith('dsbot-scoped-ca-')) throw Error('UNSAFE_FIXTURE_PATH')
    rmSync(root, { recursive: true, force: true })
  } }
}
