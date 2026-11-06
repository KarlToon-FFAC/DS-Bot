import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { hubCode } from '../src/management-store.js'
import { startHub } from '../src/server.js'
import { execute, prepare } from '../src/admin-cli.js'
import { caFixture, openssl } from '../../ds-bot/test/fixtures/hub-ca-fixture.mjs'

test('address-only Hub codes cannot be generated, even for loopback', () => {
  assert.throws(() => hubCode('unmigrated', 'wss://127.0.0.1:3190/communication'), {code:'HUB_V2_MIGRATION_REQUIRED'})
  assert.throws(() => hubCode('unmigrated', 'ws://127.0.0.1:3190/communication'), {code:'TLS_REQUIRED'})
})

test('deployment CLI refuses missing v2 prerequisites before touching retained data', t => {
  const root = mkdtempSync(join(tmpdir(), 'dsbot-v2-required-'))
  t.after(() => rmSync(root, {recursive:true,force:true}))
  const config = join(root, 'hub.json'), database = join(root, 'hub.sqlite')
  writeFileSync(database, 'retained-test-state')
  const management={enabled:true,url:'wss://127.0.0.1:3190/communication',pairingCaFile:'test-ca.pem'}
  const tls={certificateEnv:'DSBOT_TEST_V2_CERT',privateKeyEnv:'DSBOT_TEST_V2_KEY'}
  for (const entry of [
    {management:{enabled:true}},
    {management:{enabled:true,url:management.url}},
    {management},
    {management,tls},
    {management,tls,env:{DSBOT_TEST_V2_CERT:'synthetic-test-cert',DSBOT_TEST_V2_KEY:'synthetic-test-key'}},
  ]) {
    const {env={},...settings}=entry
    writeFileSync(config, JSON.stringify({databasePath:'hub.sqlite',...settings}))
    const before = readFileSync(config)
    const result = spawnSync(process.execPath, [fileURLToPath(new URL('../src/cli.js', import.meta.url)),config], {encoding:'utf8',timeout:10000,env:{PATH:process.env.PATH,SystemRoot:process.env.SystemRoot,...env}})
    assert.equal(result.error, undefined)
    assert.equal(result.status, 1)
    assert.match(result.stderr, /HUB_V2_MIGRATION_REQUIRED/)
    assert.equal(readFileSync(database,'utf8'),'retained-test-state')
    assert.deepEqual(readFileSync(config),before)
    assert.equal(existsSync(database+'.lock'),false)
  }
})

test('real WSS management requires a public CA and the operator CLI returns only signed v2 codes', {skip:!openssl}, async t => {
  const certificates=caFixture(); t.after(()=>certificates.close())
  const root=certificates.ca('v2-root'),leaf=certificates.leaf('v2-leaf',root)
  const password='synthetic-test-v2-administrator-password', tls={cert:leaf.cert,key:leaf.key}
  await assert.rejects(startHub({databasePath:':memory:',port:0,tls,management:{enabled:true,password}}),{code:'HUB_V2_MIGRATION_REQUIRED'})
  const hub=await startHub({databasePath:':memory:',port:0,tls,management:{enabled:true,password,pairingCa:root.pem}})
  t.after(()=>hub.close())
  const result=await execute(prepare('hub-code'),{url:hub.managementUrl,password,caFile:root.cert})
  assert.match(result.code,/^dsbot-hub:2:/)
  assert.equal(result.hubId,hub.management.hubId)
})
