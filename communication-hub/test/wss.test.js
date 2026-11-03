import assert from 'node:assert/strict'
import {test} from 'node:test'
import {randomBytes} from 'node:crypto'
import {fork,execFileSync} from 'node:child_process'
import {once} from 'node:events'
import {existsSync,mkdtempSync,readFileSync,rmSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join,dirname,resolve,delimiter} from 'node:path'
import {fileURLToPath} from 'node:url'
import {startHub} from '../src/server.js'
const candidates=(process.env.PATH??'').split(delimiter).flatMap(path=>[join(path,process.platform==='win32'?'openssl.exe':'openssl'),join(dirname(path),'usr','bin','openssl.exe')])
const openssl=candidates.find(path=>existsSync(path))
async function client(url,credentials,ca){
  const env={...process.env,DSBOT_WSS_TEST_INPUT:JSON.stringify({url,credentials})}
  delete env.NODE_TLS_REJECT_UNAUTHORIZED;delete env.NODE_EXTRA_CA_CERTS
  if(ca)env.NODE_EXTRA_CA_CERTS=ca
  const child=fork(fileURLToPath(new URL('./fixtures/wss-client.mjs',import.meta.url)),[],{windowsHide:true,env,stdio:['ignore','ignore','ignore','ipc']})
  const deadline=setTimeout(()=>child.kill(),15000)
  try{const answer=once(child,'message'),ended=once(child,'exit');const[result]=await answer;await ended;return result}
  finally{clearTimeout(deadline);if(child.exitCode===null&&child.signalCode===null)child.kill()}
}
test('production WSS transport uses trusted certificate validation, rejects untrusted/hostname-invalid TLS and delivers one canonical DM',
 {skip:!openssl,timeout:30000},async()=>{
  const root=mkdtempSync(join(tmpdir(),'dsbot-wss-')),credentials=[randomBytes(32).toString('hex'),randomBytes(32).toString('hex')]
  const peers=credentials.map((credential,index)=>({instanceId:index?'b':'a',credential}))
  let hub
  const certificate=(name,san)=>{
    const cert=join(root,`${name}.pem`),key=join(root,`${name}.key`)
    execFileSync(openssl,['req','-x509','-newkey','rsa:2048','-nodes','-sha256','-days','1','-subj','/CN=dsbot-synthetic-test',
      '-addext',`subjectAltName=${san}`,'-keyout',key,'-out',cert],{stdio:'ignore',windowsHide:true,timeout:10000})
    return {cert,key,tls:{cert:readFileSync(cert),key:readFileSync(key)}}
  }
  try{
    const valid=certificate('valid','IP:127.0.0.1')
    hub=await startHub({databasePath:join(root,'hub.sqlite'),port:0,peers,tls:valid.tls})
    assert.equal((await client(hub.url,credentials)).connected,false,'a self-signed certificate is not silently trusted')
    const trusted=await client(hub.url,credentials,valid.cert)
    assert.equal(trusted.connected,true,JSON.stringify(trusted));assert.equal(trusted.canonicalMessages,1)
    assert.equal((await client(hub.url,['wrong-synthetic-credential-value-123456',credentials[1]],valid.cert)).connected,false,'TLS does not bypass peer authentication')
    await hub.close();hub=null
    const mismatch=certificate('wrong-host','DNS:localhost')
    hub=await startHub({databasePath:join(root,'mismatch.sqlite'),port:0,peers,tls:mismatch.tls})
    assert.equal((await client(hub.url,credentials,mismatch.cert)).connected,false,'trusted CA still requires the correct server hostname')
  }finally{
    await hub?.close()
    assert.equal(dirname(resolve(root)),resolve(tmpdir()));assert.ok(root.includes('dsbot-wss-'))
    rmSync(root,{recursive:true,force:true})
  }
})
