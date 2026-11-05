import assert from 'node:assert/strict'
import { test } from 'node:test'
import { generateKeyPairSync, randomUUID, sign } from 'node:crypto'
import WebSocket from 'ws'
import { startHub } from '../src/server.js'
import { CAPABILITIES, PROTOCOL } from '../src/protocol.js'
import { enrollmentTranscript } from '../src/management-store.js'

async function client(url) {
  const socket = new WebSocket(url), calls = new Map()
  socket.on('error', () => {})
  socket.on('message', raw => {
    const result = JSON.parse(raw.toString()), call = calls.get(result.id)
    if (!call) return
    calls.delete(result.id); clearTimeout(call.timer)
    if (result.ok) call.resolve(result.value)
    else call.reject(Object.assign(new Error(result.error.code), { code: result.error.code }))
  })
  socket.on('close', () => { for (const call of calls.values()) { clearTimeout(call.timer); call.reject(new Error('CONNECTION_LOST')) }; calls.clear() })
  await new Promise((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject) })
  return { close: () => socket.terminate(), request: (type, payload) => new Promise((resolve, reject) => {
    if(socket.readyState!==WebSocket.OPEN){reject(new Error('CONNECTION_LOST'));return}
    const id = randomUUID(), timer = setTimeout(() => { calls.delete(id); reject(new Error('TIMEOUT')) }, 3000)
    calls.set(id, { resolve, reject, timer }); socket.send(JSON.stringify({ protocol: PROTOCOL, id, type, payload }))
  }) }
}

test('actual HTTP approval, signed socket login, Human assignment and scoped contacts are integrated', async t => {
  const hub = await startHub({ databasePath: ':memory:', peers: [], port: 0, management: { enabled: true, password: 'mock-administrator-password-for-local-test' } })
  t.after(() => hub.close())
  const origin = `http://127.0.0.1:${hub.port}`
  const info = await (await fetch(origin + '/hub-info')).json()
  assert.ok(info.code.startsWith('dsbot-hub:1:'))
  const loginResponse = await fetch(origin + '/admin/api/login', { method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify({ password: 'mock-administrator-password-for-local-test' }) })
  const { csrf } = await loginResponse.json(), cookie = loginResponse.headers.getSetCookie()[0].split(';')[0]
  const admin = async (action, input) => {
    const response = await fetch(origin + '/admin/api/' + action, { method: 'POST', headers: { origin, cookie, 'x-csrf-token': csrf, 'content-type': 'application/json' }, body: JSON.stringify(input) })
    const result = await response.json(); assert.equal(result.ok, true, result.error?.code); return result.value
  }
  const enrolled = []
  for (const name of ['Alice', 'Bob']) {
    const pair = generateKeyPairSync('ed25519'), publicKey = pair.publicKey.export({ format: 'pem', type: 'spki' })
    const pending = await client(hub.url); t.after(pending.close)
    const challenge = await pending.request('enrollment.challenge', { purpose: 'join', publicKey })
    const proof = sign(null, Buffer.from(enrollmentTranscript(challenge)), pair.privateKey).toString('base64url')
    const requested = await pending.request('enrollment.prove', { challengeId: challenge.challengeId, signature: proof, displayName: name })
    const row = (await admin('state', {})).requests.find(item => item.requestId === requested.requestId)
    const approved = await admin('decide', { requestId: row.requestId, expectedVersion: row.version, action: 'approve' })
    pending.close()
    const signed = await client(hub.url); t.after(signed.close)
    const auth = await signed.request('enrollment.challenge', { purpose: 'login', instanceId: approved.instanceId })
    const welcome = await signed.request('enrollment.prove', { challengeId: auth.challengeId, signature: sign(null, Buffer.from(enrollmentTranscript(auth)), pair.privateKey).toString('base64url'), capabilities: CAPABILITIES })
    assert.equal(welcome.hubId, info.hubId)
    const human = await signed.request('principal.register', { localId: 'local-user', kind: 'human', displayName: name })
    assert.equal(human.principalId, `human:${welcome.instanceId}:local-user`)
    enrolled.push({ signed, human: human.principalId, instanceId: welcome.instanceId })
  }
  const [a, b] = enrolled
  assert.deepEqual((await a.signed.request('contacts.list', {})).map(item => item.principalId), [a.human])
  await assert.rejects(a.signed.request('dm.open', { principalId: a.human, otherPrincipalId: b.human, operationId: randomUUID() }), { code: 'CONTACT_REQUIRED' })
  const code = await b.signed.request('contact.code', { principalId: b.human })
  await a.signed.request('contact.request', { principalId: a.human, userCode: code.userCode, operationId: randomUUID(), botPrincipalIds: [] })
  const incoming = (await b.signed.request('contact.requests', { principalId: b.human })).find(item => item.direction === 'incoming')
  await b.signed.request('contact.accept', { principalId: b.human, requestId: incoming.requestId, expectedVersion: incoming.version, operationId: randomUUID(), botPrincipalIds: [] })
  assert.equal((await a.signed.request('contacts.list', {})).length, 2)
  assert.ok((await a.signed.request('dm.open', { principalId: a.human, otherPrincipalId: b.human, operationId: randomUUID() })).conversationId)
  await assert.rejects(a.signed.request('contacts.list', { principalId: b.human }), { code: 'AUTHOR_MISMATCH' })
})

test('real socket departure survives a lost response, preserves history and releases only live quota',async t=>{
  let loseLeaveResponse=true
  const hub=await startHub({databasePath:':memory:',peers:[],port:0,limits:{maxPrincipals:2},management:{enabled:true,password:'mock-lifecycle-administrator'},
    beforeResponse:({type,value,socket})=>{
      if(type==='enrollment.prove'&&value?.left&&loseLeaveResponse){loseLeaveResponse=false;socket.terminate();return false}
    }})
  t.after(()=>hub.close())
  const origin=`http://127.0.0.1:${hub.port}`
  const login=await fetch(origin+'/admin/api/login',{method:'POST',headers:{origin,'content-type':'application/json'},body:JSON.stringify({password:'mock-lifecycle-administrator'})})
  const {csrf}=await login.json(),cookie=login.headers.getSetCookie()[0].split(';')[0]
  const admin=async(action,input={})=>{
    const response=await fetch(origin+'/admin/api/'+action,{method:'POST',headers:{origin,cookie,'x-csrf-token':csrf,'content-type':'application/json'},body:JSON.stringify(input)})
    const result=await response.json()
    if(!result.ok)throw Object.assign(Error(result.error.code),{code:result.error.code})
    return result.value
  }
  const enroll=async label=>{
    const pair=generateKeyPairSync('ed25519'),socket=await client(hub.url);t.after(socket.close)
    const publicKey=pair.publicKey.export({format:'pem',type:'spki'})
    const challenge=await socket.request('enrollment.challenge',{purpose:'join',publicKey})
    const request=await socket.request('enrollment.prove',{challengeId:challenge.challengeId,signature:sign(null,Buffer.from(enrollmentTranscript(challenge)),pair.privateKey).toString('base64url'),displayName:label})
    const approved=await admin('decide',{requestId:request.requestId,expectedVersion:1,action:'approve'})
    return {pair,instanceId:approved.instanceId,human:`human:${approved.instanceId}:local-user`}
  }
  const prove=async(device,purpose,key=device.pair)=>{
    const socket=await client(hub.url);t.after(socket.close)
    const challenge=await socket.request('enrollment.challenge',{purpose,instanceId:device.instanceId})
    const value=await socket.request('enrollment.prove',{challengeId:challenge.challengeId,signature:sign(null,Buffer.from(enrollmentTranscript(challenge)),key.privateKey).toString('base64url'),...(purpose==='login'?{capabilities:CAPABILITIES}:{})})
    return {socket,value}
  }
  const a=await enroll('Synthetic A'),b=await enroll('Synthetic B')
  await assert.rejects(admin('revoke',{instanceId:'no-such-instance'}),{code:'INSTANCE_NOT_FOUND'})
  const active=await prove(a,'login')
  const group=await active.socket.request('group.create',{principalId:a.human,title:'Retained owner group',operationId:randomUUID()})
  await assert.rejects(prove(a,'leave',b.pair),{code:'UNAUTHENTICATED'})
  await assert.rejects(prove(a,'leave'),{code:'OWNER_TRANSFER_REQUIRED'})
  const membership=hub.store.db.prepare('SELECT epoch FROM memberships WHERE conversation_id=? AND principal_id=?').get(group.conversationId,a.human)
  await active.socket.request('group.dissolve',{principalId:a.human,conversationId:group.conversationId,membershipEpoch:membership.epoch,operationId:randomUUID()})
  await assert.rejects(prove(a,'leave'),/CONNECTION_LOST/)
  assert.equal((await prove(a,'leave-status')).value.left,true,'read-only signed proof reconciles the committed departure')
  await assert.rejects(active.socket.request('contacts.list',{}),error=>error.code==='UNAUTHENTICATED'||error.message==='CONNECTION_LOST')
  await assert.rejects(prove(a,'login'),{code:'UNAUTHENTICATED'})
  const c=await enroll('Synthetic C')
  assert.equal(hub.store.activePrincipalCount(),2)
  assert.equal(hub.store.db.prepare('SELECT count(*) n FROM principals').get().n,3,'historical identities survive capacity release')
  assert.ok(hub.store.db.prepare('SELECT 1 FROM conversations WHERE id=?').get(group.conversationId))
  await assert.rejects(admin('repair',{instanceId:a.instanceId,expectedRevision:1}),{code:'DIRECTORY_FULL'})
  const denied=await fetch(origin+'/admin/api/revoke',{method:'POST',headers:{origin,'content-type':'application/json'},body:JSON.stringify({instanceId:b.instanceId})})
  assert.equal(denied.status,401,'a normal device has no administrator removal authority')
  await admin('revoke',{instanceId:c.instanceId})
  await admin('repair',{instanceId:a.instanceId,expectedRevision:1})
  assert.equal((await prove(a,'leave-status')).value.left,false,'same-key administrator repair is separately provable')
  await prove(a,'login')
  assert.equal(hub.store.db.prepare('SELECT active FROM memberships WHERE conversation_id=? AND principal_id=?').get(group.conversationId,a.human).active,0,'repair does not restore old group rights')
})

test('native password form supports browser autofill, safe session reload, logout and revocation',async t=>{
  const hub=await startHub({databasePath:':memory:',port:0,management:{enabled:true,password:'mock-native-form-password-only'}});t.after(()=>hub.close())
  const origin=`http://127.0.0.1:${hub.port}`
  const pageResponse=await fetch(origin+'/admin/'),page=await pageResponse.text()
  assert.equal(pageResponse.headers.get('referrer-policy'),'same-origin','native same-origin form must retain its Origin; external referrers remain suppressed')
  assert.match(page,/<form[^>]*method="post"[^>]*action="\/admin\/login"[^>]*autocomplete="on"/)
  assert.match(page,/name="username"[^>]*autocomplete="username"/)
  assert.match(page,/name="password"[^>]*autocomplete="current-password"/)
  const script=await(await fetch(origin+'/admin/app.js')).text();assert.doesNotMatch(script,/localStorage|sessionStorage|password\.value/)
  const login=async()=>{
    const response=await fetch(origin+'/admin/login',{method:'POST',redirect:'manual',headers:{origin,'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams({username:'admin',password:'mock-native-form-password-only'})})
    assert.equal(response.status,303);assert.equal(response.headers.get('location'),'/admin/')
    const header=response.headers.getSetCookie()[0];assert.match(header,/HttpOnly; SameSite=Strict; Max-Age=900/)
    assert.equal(await response.text(),'');return header.split(';')[0]
  }
  const request=(cookie,action,input={},csrf,requestOrigin=origin)=>fetch(origin+'/admin/api/'+action,{method:'POST',headers:{origin:requestOrigin,cookie,'content-type':'application/json',...(csrf?{'x-csrf-token':csrf}:{})},body:JSON.stringify(input)})
  const a=await login(),b=await login()
  const failure=await fetch(origin+'/admin/login',{method:'POST',headers:{origin,'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams({username:'admin',password:'mock-wrong-synthetic-password'})})
  assert.equal(failure.status,401);assert.match(await failure.text(),/Sign-in failed/)
  const session=await(await request(a,'session')).json();assert.equal(session.ok,true);assert.ok(session.csrf)
  assert.equal((await request(a,'state')).status,401,'session bootstrap never removes mutation CSRF checks')
  assert.equal((await request(a,'session',{},undefined,'https://untrusted.example')).status,400)
  assert.equal((await request(a,'state',{},session.csrf)).status,200)
  assert.equal((await request(a,'sessions/revoke',{},session.csrf)).status,200)
  assert.equal((await request(a,'session')).status,401);assert.equal((await request(b,'session')).status,401)
  const c=await login(),active=await(await request(c,'session')).json()
  const logout=await request(c,'logout',{},active.csrf);assert.equal(logout.status,200);assert.match(logout.headers.get('set-cookie'),/Max-Age=0/)
  assert.equal((await request(c,'session')).status,401)
})

test('changing the administrator verifier revokes existing sessions without weakening login checks',async t=>{
  const {initializeAdmin}=await import('../src/management-http.js')
  const hub=await startHub({databasePath:':memory:',port:0,management:{enabled:true,password:'mock-original-admin-password'}});t.after(()=>hub.close())
  const origin=`http://127.0.0.1:${hub.port}`
  const login=password=>fetch(origin+'/admin/api/login',{method:'POST',headers:{origin,'content-type':'application/json'},body:JSON.stringify({password})})
  const original=await login('mock-original-admin-password'),cookie=original.headers.getSetCookie()[0].split(';')[0]
  initializeAdmin(hub.management,'mock-rotated-admin-password')
  const expired=await fetch(origin+'/admin/api/session',{method:'POST',headers:{origin,cookie,'content-type':'application/json'},body:'{}'})
  assert.equal(expired.status,401)
  assert.equal((await login('mock-original-admin-password')).status,401)
  assert.equal((await login('mock-rotated-admin-password')).status,200)
})
