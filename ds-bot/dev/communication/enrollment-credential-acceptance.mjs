// Real WSS Hub plus the public DSH file credential provider; owned fixtures only.
import assert from 'node:assert/strict'
import {mkdtemp,rm} from 'node:fs/promises'
import {join} from 'node:path'
import {tmpdir} from 'node:os'
import {randomUUID} from 'node:crypto'
import {Context} from '@deepseek-ai/cordis'
import LocalCredentials from '@deepseek-ai/dsh-credentials-local'
import {startHub} from '../../../communication-hub/src/server.js'
import {CommunicationOnboarding,decodeHubCode,communicationCredentialKey,communicationAuthentication,openEnrollmentSocket} from '../../src/host/federation/onboarding.js'
import {communicationCapabilities} from '../../src/host/federation/transport.js'
import {caFixture} from '../../test/fixtures/hub-ca-fixture.mjs'

const dir=await mkdtemp(join(tmpdir(),'.dsh-test-enrollment-acceptance-')),certs=caFixture(),root=new Context()
let hub
try {
 const ca=certs.ca('root'),leaf=certs.leaf('leaf',ca)
 hub=await startHub({databasePath:join(dir,'hub.sqlite'),port:0,tls:leaf,management:{enabled:true,password:randomUUID(),pairingCa:ca.pem}})
 hub.management.setEnrollmentPolicy({autoApprove:true,expectedVersion:1})
 await root.plugin(LocalCredentials,{path:join(dir,'.credentials.yaml'),watch:false})
 const credentials=root.get('credentials'),info=hub.management.info(),review=decodeHubCode(info.code,{allowLoopback:true})
 const input={hubCode:info.code,confirmedHubId:info.hubId,confirmedUrl:hub.url,confirmedTrustFingerprint:review.trustFingerprint,displayName:'Recovery fixture'}
 const key=communicationCredentialKey(info.hubId)
 const rt={config:{},ctx:{credentials,configEditor:{entries:()=>[{options:{name:'ds-bot'}}],edit:async(_entry,change)=>{rt.config=change(rt.config)}}}}
 // Reproduce the exact old failure after the Hub has automatically approved.
 rt.ctx.credentials={readRecord:key=>credentials.readRecord(key),describeRecord:key=>credentials.describeRecord(key),modifyRecord:(key,change)=>credentials.modifyRecord(key,async current=>{
  const next=await change(current)
  return next?.payload.status==='approved'?{...next,payload:{...next.payload,remoteMissing:undefined}}:next
 })}
 await assert.rejects(new CommunicationOnboarding(rt,{allowLoopback:true}).handle('join',input,{human:true}),{code:'COMMUNICATION_CREDENTIAL_WRITE_FAILED'})
 assert.equal((await credentials.readRecord(key)).payload.status,'prepared')
 assert.equal(hub.management.joins().length,1)
 assert.equal(hub.management.joins()[0].status,'approved')
 console.log('PASS real provider reproduces approved Hub / prepared client split')
 rt.ctx.credentials=credentials
 const upgraded=new CommunicationOnboarding(rt,{allowLoopback:true})
 const before=(await upgraded.handle('storage',{}, {human:true})).enrollments[0]
 const recovered=await upgraded.handle('reconcile-enrollment',{}, {human:true})
 assert.equal(recovered.status,'approved');assert.equal(recovered.requestId,before.requestId);assert.equal(recovered.identityFingerprint,before.identityFingerprint)
 assert.equal(rt.config.communication.enabled,true)
 assert.equal(hub.management.joins().length,1)
 const socket=await openEnrollmentSocket(hub.url,{allowLoopback:true,hubId:info.hubId,trust:review.trust})
 try {
  const welcome=await communicationAuthentication(rt,key,rt.config.communication)(socket.request,communicationCapabilities())
  assert.equal(welcome.instanceId,recovered.instanceId)
 }finally{socket.close()}
 assert.equal(Object.hasOwn((await credentials.readRecord(key)).payload,'remoteMissing'),false)
 console.log('PASS upgraded status reconciliation preserves identity, creates no duplicate device and authenticates')
 // A fresh join must also complete without entering the old split state.
 await credentials.deleteRecord(key);rt.config={}
 const fresh=await new CommunicationOnboarding(rt,{allowLoopback:true}).handle('join',{...input,displayName:'Fresh fixture'},{human:true})
 assert.equal(fresh.status,'approved');assert.equal(rt.config.communication.enabled,true)
 assert.equal(hub.management.joins().length,2)
 console.log('PASS fresh automatic admission persists the approved grant')
}finally{await root.fiber.dispose();await hub?.close();certs.close();await rm(dir,{recursive:true,force:true})}
