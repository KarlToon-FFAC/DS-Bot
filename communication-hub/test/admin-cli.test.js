import assert from 'node:assert/strict'
import {test} from 'node:test'
import {createServer} from 'node:http'
import {Readable} from 'node:stream'
import {generateKeyPairSync,sign} from 'node:crypto'
import {startHub} from '../src/server.js'
import {enrollmentTranscript} from '../src/management-store.js'
import {execute,prepare,main,help} from '../src/admin-cli.js'

test('operator CLI covers Hub state/code, enrollment decisions, names, revoke/repair and session revocation with authoritative versions',async t=>{
 const password='synthetic-admin-cli-test-password',hub=await startHub({databasePath:':memory:',port:0,management:{enabled:true,password}});t.after(()=>hub.close())
 const options={url:`http://127.0.0.1:${hub.port}/admin/`,password},run=(op,input={})=>execute(prepare(op,input),options)
 const pending=name=>{const pair=generateKeyPairSync('ed25519'),challenge=hub.management.challenge('synthetic-client',{purpose:'join',publicKey:pair.publicKey.export({type:'spki',format:'pem'}).toString()});return hub.management.prove('synthetic-client',{challengeId:challenge.challengeId,signature:sign(null,Buffer.from(enrollmentTranscript(challenge)),pair.privateKey).toString('base64url'),displayName:name})}
 const one=pending('CLI device'),request=(await run('state')).requests.find(item=>item.requestId===one.requestId)
 const approved=await run('approve',{requestId:request.requestId,expectedVersion:request.version})
 const instance=(await run('state')).instances.find(item=>item.instanceId===approved.instanceId)
 assert.ok(instance)
 await assert.rejects(run('rename',{instanceId:instance.instanceId,label:'stale',expectedNameVersion:instance.nameVersion+1}),{code:'INSTANCE_NAME_VERSION_CONFLICT'})
 await run('rename',{instanceId:instance.instanceId,label:'Renamed CLI device',expectedNameVersion:instance.nameVersion})
 assert.equal((await run('state')).instances.find(item=>item.instanceId===instance.instanceId).label,'Renamed CLI device')
 const code=await run('hub-code');assert.ok(code.code.startsWith('dsbot-hub:1:'));assert.equal(code.hubId,hub.management.hubId)
 await run('revoke',{instanceId:instance.instanceId})
 const revoked=(await run('state')).instances.find(item=>item.instanceId===instance.instanceId);assert.equal(Boolean(revoked.trusted),false)
 await run('repair',{instanceId:instance.instanceId,expectedRevision:revoked.revision})
 assert.equal(Boolean((await run('state')).instances.find(item=>item.instanceId===instance.instanceId).trusted),true)
 const two=pending('Rejected CLI device'),next=(await run('state')).requests.find(item=>item.requestId===two.requestId)
 await run('reject',{requestId:next.requestId,expectedVersion:next.version})
 assert.equal((await run('state')).requests.find(item=>item.requestId===two.requestId).status,'rejected')
 await run('revoke-sessions')
 await assert.rejects(execute(prepare('state'),{...options,password:'wrong-synthetic-admin-password'}),{code:'UNAUTHENTICATED'})
 assert.equal(Object.keys(JSON.parse(help()).operations).length,8)
})

test('CLI keeps administrator credentials out of arguments/output, consumes private env and never follows redirects',async t=>{
 const password='synthetic-private-admin-cli-password'
 const server=createServer((req,res)=>{if(req.url==='/admin/api/state'){res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({ok:true,value:{reflected:password}}))}else{res.writeHead(302,{location:'https://untrusted.example.test/'});res.end()}})
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise(resolve=>server.close(resolve)))
 const url=`http://127.0.0.1:${server.address().port}`,env={DSBOT_HUB_ADMIN_URL:url,DSBOT_HUB_ADMIN_PASSWORD:password};let output='',error=''
 const status=await main(['state','--json'],env,Readable.from(['{}']),{write:value=>output+=value},{write:value=>error+=value})
 assert.equal(status,0);assert.equal(error,'');assert.equal(output.includes(password),false);assert.equal(output.includes('[REDACTED]'),true);assert.equal(env.DSBOT_HUB_ADMIN_PASSWORD,undefined)
 await assert.rejects(execute(prepare('revoke',{instanceId:'test'}),{url,password}),{code:'REDIRECT_REFUSED'})
 await assert.rejects(execute(prepare('state'),{url:'http://remote.example.test/',password}),{code:'TLS_REQUIRED'})
 for(const input of [{password},{instanceId:'x',expectedNameVersion:1,label:'x',password}])assert.throws(()=>prepare('rename',input),{code:'INVALID_REQUEST'})
 const rejected=await main(['state','--password',password],{},Readable.from([]),{write(){}},{write:value=>{assert.equal(value.includes(password),false)}})
 assert.equal(rejected,2)
})
