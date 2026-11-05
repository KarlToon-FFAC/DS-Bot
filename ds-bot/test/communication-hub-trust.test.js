import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createServer } from 'node:https'
import { WebSocketServer } from 'ws'
import { decodeHubCode, connectHubSocket, CommunicationOnboarding, communicationCredentialKey } from '../src/host/federation/onboarding.js'
import { signedHubCode } from '../../communication-hub/src/hub-code.js'
import { caFixture, openssl } from './fixtures/hub-ca-fixture.mjs'
import { scopedTrust } from '../src/host/federation/hub-trust.js'

async function server(tls, port = 0) {
  const http = createServer(tls), ws = new WebSocketServer({ server: http })
  await new Promise((resolve, reject) => { http.once('error', reject); http.listen(port, '127.0.0.1', resolve) })
  return { port: http.address().port, url: `wss://127.0.0.1:${http.address().port}/communication`, async close() {
    for (const client of ws.clients) client.terminate()
    await new Promise(resolve => ws.close(resolve)); await new Promise(resolve => http.close(resolve))
  } }
}
const tamper = (code, change) => {
  const body = JSON.parse(Buffer.from(code.slice('dsbot-hub:2:'.length), 'base64url'))
  change(body); return 'dsbot-hub:2:' + Buffer.from(JSON.stringify(body)).toString('base64url')
}

test('signed Hub code binds CA, endpoint, identity, signature and lifetime; legacy stays strict', { skip: !openssl, timeout: 60000 }, () => {
  const f = caFixture()
  try {
    const root = f.ca('root'), leaf = f.leaf('leaf', root), url = 'wss://127.0.0.1:3199/communication'
    const code = signedHubCode('hub-test', url, { caPem: root.pem, certificatePem: leaf.cert, privateKey: leaf.key })
    const decoded = decodeHubCode(code, { allowLoopback: true })
    assert.equal(decoded.version, 2); assert.equal(decoded.trust.hubId, 'hub-test'); assert.match(decoded.trustFingerprint, /^[a-f0-9]{64}$/)
    assert.throws(() => scopedTrust(decoded.trust, decoded, Date.now()+3*86400000), {code:'HUB_TRUST_EXPIRED'})
    assert.throws(() => decodeHubCode(tamper(code, body => { body.extra='unsupported' }),{allowLoopback:true}),{code:'INVALID_HUB_CODE'})
    for (const change of [body => { body.hubId = 'other' }, body => { body.url = url.replace('3199','3200') }, body => { body.signature = 'x'.repeat(128) }]) {
      assert.throws(() => decodeHubCode(tamper(code, change), { allowLoopback: true }), { code: 'INVALID_HUB_CODE_SIGNATURE' })
    }
    assert.throws(() => decodeHubCode(tamper(code, body => { body.expiresAt = Date.now()-1 }), { allowLoopback: true }), { code: 'HUB_CODE_EXPIRED' })
    assert.throws(() => decodeHubCode(tamper(code, body => { body.caPem = f.ca('wrong').pem }), { allowLoopback: true }), { code: 'INVALID_HUB_TRUST' })
    const mismatch = f.leaf('mismatch', root, 'DNS:localhost')
    assert.throws(() => signedHubCode('hub-test', url, { caPem: root.pem, certificatePem: mismatch.cert, privateKey: mismatch.key }), { code: 'INVALID_CONFIG' })
    assert.throws(() => signedHubCode('hub-test', url, { caPem: leaf.key, certificatePem: leaf.cert, privateKey: leaf.key }), { code: 'INVALID_CONFIG' })
    const legacy = 'dsbot-hub:1:' + Buffer.from(JSON.stringify({hubId:'hub-test',url})).toString('base64url')
    assert.equal(decodeHubCode(legacy, {allowLoopback:true}).trust, undefined)
  } finally { f.close() }
})

test('real WSS uses only scoped CA without environment setup, survives leaf renewal and requires explicit CA rotation', { skip: !openssl, timeout: 60000 }, async () => {
  const f = caFixture(); let live
  try {
    const a = f.ca('a'), b = f.ca('b'), leaf = f.leaf('leaf-a', a)
    live = await server(leaf)
    const url = live.url, port = live.port
    const info = decodeHubCode(signedHubCode('hub-test', url, {caPem:a.pem,certificatePem:leaf.cert,privateKey:leaf.key}), {allowLoopback:true})
    const connect = trust => connectHubSocket(url, {allowLoopback:true,hubId:'hub-test',trust})
    await assert.rejects(connect(), {code:'HUB_TLS_UNTRUSTED'})
    ;(await connect(info.trust)).close()
    await assert.rejects(connect({...info.trust,hubId:'other'}), {code:'HUB_TRUST_BINDING_MISMATCH'})
    await live.close();live = await server(f.leaf('renewed-a',a),port)
    ;(await connect(structuredClone(info.trust))).close()
    await live.close();const replacement=f.leaf('leaf-b',b);live=await server(replacement,port)
    await assert.rejects(connect(info.trust), {code:'HUB_TLS_UNTRUSTED'})
    const rotated=decodeHubCode(signedHubCode('hub-test',url,{caPem:b.pem,certificatePem:replacement.cert,privateKey:replacement.key}),{allowLoopback:true})
    ;(await connect(rotated.trust)).close()
    await live.close();live=await server(f.leaf('wrong-host',b,'DNS:localhost'),port)
    await assert.rejects(connect(rotated.trust),{code:'HUB_TLS_HOSTNAME_MISMATCH'})
  } finally {await live?.close();f.close()}
})

test('trust update verifies Hub challenge before saving, retains device identity and cannot be invoked by a Bot', { skip: !openssl, timeout: 60000 }, async () => {
  const f=caFixture()
  try {
    const root=f.ca('rotation'),leaf=f.leaf('rotation-leaf',root),url='wss://127.0.0.1:3199/communication',hubId='hub-test'
    const code=signedHubCode(hubId,url,{caPem:root.pem,certificatePem:leaf.cert,privateKey:leaf.key}),decoded=decodeHubCode(code,{allowLoopback:true})
    let record={kind:'grant',payload:{type:'dsbot-communication-signing-key',version:1,hubId,url,publicKey:'synthetic-existing-public',privateKey:'synthetic-existing-private',requestId:'request',instanceId:'instance',status:'approved'}}
    const rt={config:{communication:{hubId,url,instanceId:'instance'}},ctx:{credentials:{describeRecord:async()=>({configured:true,writable:true}),readRecord:async()=>structuredClone(record),modifyRecord:async(_key,mutate)=>{record=mutate(structuredClone(record))}}}}
    let repliesHub=hubId,calls=0
    const onboarding=new CommunicationOnboarding(rt,{allowLoopback:true,connect:async(_url,options)=>{assert.equal(options.trust.fingerprint,decoded.trustFingerprint);return {close(){},request:async(type,input)=>{calls++;assert.equal(type,'enrollment.challenge');return {hubId:repliesHub,purpose:input.purpose,instanceId:'instance',challengeId:'challenge',nonce:'abcdefghijklmnop',expiresAt:Date.now()+30000}}}}})
    const input={hubCode:code,confirmedHubId:hubId,confirmedUrl:url,confirmedTrustFingerprint:decoded.trustFingerprint}
    await assert.rejects(onboarding.handle('join',{...input,confirmedTrustFingerprint:undefined,displayName:'Synthetic'},{human:true}),{code:'HUB_CONFIRMATION_REQUIRED'})
    assert.equal(calls,0,'trust confirmation failure never contacts the Hub')
    await assert.rejects(onboarding.handle('update-hub-trust',input,{human:true,agent:{}}),{code:'HUMAN_REQUIRED'})
    repliesHub='forged';await assert.rejects(onboarding.handle('update-hub-trust',input,{human:true}),{code:'INVALID_ENROLLMENT_CHALLENGE'})
    assert.equal(record.payload.trust,undefined)
    repliesHub=hubId;const result=await onboarding.handle('update-hub-trust',input,{human:true})
    assert.equal(record.payload.version,2,'older clients reject scoped records rather than reverting to ambient TLS')
    assert.equal(record.payload.privateKey,'synthetic-existing-private');assert.equal(result.instanceId,'instance');assert.equal(result.trustFingerprint,decoded.trustFingerprint)
    assert.equal(calls,2);assert.equal(result.credentialKey,communicationCredentialKey(hubId));assert.doesNotMatch(JSON.stringify(result),/privateKey|synthetic-existing-private/)
  } finally {f.close()}
})
