import {test} from 'node:test'
import assert from 'node:assert/strict'
import {randomUUID} from 'node:crypto'
import {HubStore} from '../src/store.js'
import {CAPABILITIES} from '../src/protocol.js'
import {mkdtempSync,rmSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {once} from 'node:events'
import {WebSocket} from 'ws'
import {startHub} from '../src/server.js'
import {PROTOCOL} from '../src/protocol.js'
function fixture(t){const store=new HubStore(':memory:');t.after(()=>store.close());const a=store.connect('a','A',CAPABILITIES),b=store.connect('b','B',CAPABILITIES);const add=(auth,localId,kind='human')=>store.register(auth,{localId,kind,displayName:localId}).principalId;return{store,a,b,A:add(a,'A'),B:add(b,'B'),K:add(b,'K','bot')}}
test('authenticated observed IP changes do not change identities or merge shared-IP Humans',t=>{
  const {store,a,b,A,B}=fixture(t)
  store.observeAddress(a,'127.0.0.1');store.observeAddress(b,'127.0.0.1')
  assert.equal(store.contacts(a).filter(p=>p.kind==='human').length,2)
  store.observeAddress(b,'192.0.2.2')
  assert.equal(store.contacts(a).find(p=>p.principalId===B).ipAddress,'192.0.2.2')
  assert.equal(store.contacts(a).find(p=>p.principalId===A).ipAddress,'127.0.0.1')
  assert.throws(()=>store.observeAddress({instanceId:'a',epoch:0},'spoof'),/STALE_CONNECTION/)
})
test('Human rename is owner-scoped, survives re-registration and refuses extra Human identities',t=>{
  const {store,a,b,A,B,K}=fixture(t)
  assert.throws(()=>store.register(a,{localId:'another',kind:'human',displayName:'Other'}),/HUMAN_ALREADY_REGISTERED/)
  assert.throws(()=>store.renameHuman(b,{principalId:A,displayName:'Impostor'}),/AUTHOR_MISMATCH/)
  assert.throws(()=>store.renameHuman(b,{principalId:K,displayName:'Human'}),/INVALID_REQUEST/)
  store.renameHuman(a,{principalId:A,displayName:'New name'})
  store.register(a,{localId:'A',kind:'human',displayName:'Old config'})
  assert.equal(store.contacts(b).find(p=>p.principalId===A).displayName,'New name')
  assert.equal(store.contacts(a).find(p=>p.principalId===B).displayName,'B')
})
test('group name changes require current membership, owner/admin authority and current version',t=>{
  const {store,a,b,A,B}=fixture(t)
  const group=store.createGroup(a,{operationId:randomUUID(),principalId:A,title:'Before'}).conversationId
  const own=store.memberships(a).memberships.find(m=>m.conversationId===group)
  const input={operationId:randomUUID(),conversationId:group,principalId:A,membershipEpoch:own.membershipEpoch,expectedVersion:own.membershipVersion,title:'After'}
  assert.throws(()=>store.configureGroup(b,{...input,operationId:randomUUID(),principalId:B}),/NOT_A_MEMBER/)
  assert.equal(store.configureGroup(a,input).title,'After')
  assert.equal(store.configureGroup(a,input).title,'After')
  assert.throws(()=>store.configureGroup(a,{...input,operationId:randomUUID(),title:'Stale'}),/GROUP_VERSION_CONFLICT/)
  assert.equal(store.memberships(a).memberships[0].title,'After')
})

test('legacy multiple Humans survive restart and re-registration without identity or ownership transfer',t=>{
  const dir=mkdtempSync(join(tmpdir(),'dsbot-legacy-humans-')),path=join(dir,'hub.sqlite')
  let store=new HubStore(path),a=store.connect('a','A',CAPABILITIES)
  t.after(()=>{store.close();rmSync(dir,{recursive:true,force:true})})
  const A=store.register(a,{localId:'first',kind:'human',displayName:'First'}).principalId
  const B='human:a:legacy'
  store.db.prepare('INSERT INTO principals VALUES (?,?,?,?,?)').run(B,'a','human','legacy','Legacy')
  const group=store.createGroup(a,{operationId:randomUUID(),principalId:B,title:'Legacy owned'}).conversationId
  store.renameHuman(a,{principalId:B,displayName:'Retained name'})
  store.close();store=new HubStore(path);a=store.connect('a','A',CAPABILITIES)
  for(const localId of ['first','legacy'])store.register(a,{localId,kind:'human',displayName:'Configuration name'})
  assert.equal(store.contacts(a).filter(p=>p.kind==='human').length,2)
  assert.equal(store.contacts(a).find(p=>p.principalId===B).displayName,'Retained name')
  const member=store.memberships(a).memberships.find(m=>m.conversationId===group)
  assert.equal(member.principalId,B);assert.equal(member.ownerPrincipalId,B)
  assert.throws(()=>store.members(a,{conversationId:group,principalId:A}),/NOT_A_MEMBER/)
  assert.throws(()=>store.register(a,{localId:'third',kind:'human',displayName:'Third'}),/HUMAN_ALREADY_REGISTERED/)
})

test('failed rename rolls back preferences and directory name together',t=>{
  const {store,a,A}=fixture(t)
  store.beforeCommit=()=>{throw new Error('synthetic commit failure')}
  assert.throws(()=>store.renameHuman(a,{principalId:A,displayName:'Uncommitted'}),/synthetic commit failure/)
  assert.equal(store.contacts(a).find(p=>p.principalId===A).displayName,'A')
  assert.equal(store.db.prepare('SELECT count(*) count FROM principal_preferences').get().count,0)
})

test('admin can rename while members, old epochs and removed admins cannot; retries stay idempotent',t=>{
  const {store,a,b,A,B}=fixture(t)
  const group=store.createGroup(a,{operationId:randomUUID(),principalId:A,title:'Group'}).conversationId
  const own=()=>store.memberships(a).memberships.find(m=>m.conversationId===group)
  const invite=store.invite(a,{operationId:randomUUID(),conversationId:group,principalId:A,membershipEpoch:own().membershipEpoch,inviteePrincipalId:B})
  store.accept(b,{operationId:randomUUID(),principalId:B,inviteId:invite.inviteId})
  const theirs=()=>store.memberships(b).memberships.find(m=>m.conversationId===group)
  const input=()=>({operationId:randomUUID(),principalId:B,conversationId:group,membershipEpoch:theirs().membershipEpoch,expectedVersion:theirs().membershipVersion,title:'Admin name'})
  assert.throws(()=>store.configureGroup(b,input()),/FORBIDDEN/)
  store.policy(a,{operationId:randomUUID(),conversationId:group,principalId:A,membershipEpoch:own().membershipEpoch,expectedVersion:own().membershipVersion,targetPrincipalId:B,role:'admin'})
  assert.throws(()=>store.configureGroup(b,{...input(),membershipEpoch:'old'}),/MEMBERSHIP_REVOKED/)
  const rename=input();store.configureGroup(b,rename)
  assert.equal(store.members(b,{conversationId:group,principalId:B}).title,'Admin name')
  store.remove(a,{operationId:randomUUID(),conversationId:group,principalId:A,membershipEpoch:own().membershipEpoch,targetPrincipalId:B})
  assert.equal(store.configureGroup(b,rename).updated,true)
  assert.throws(()=>store.configureGroup(b,{...rename,operationId:randomUUID()}),/NOT_A_MEMBER/)
})

test('socket address overrides forwarded and claimed IPs while same-IP peers cannot impersonate each other',async()=>{
  const peers=['a','b'].map(instanceId=>({instanceId,credential:`synthetic-test-${instanceId}-credential-value`}))
  const hub=await startHub({databasePath:':memory:',port:0,peers}),sockets=[]
  const request=async(socket,type,payload)=>{
    const reply=once(socket,'message')
    socket.send(JSON.stringify({protocol:PROTOCOL,id:randomUUID(),type,payload}))
    return JSON.parse((await reply)[0].toString())
  }
  try{
    for(const peer of peers){
      const socket=new WebSocket(hub.url,{headers:{'X-Forwarded-For':'203.0.113.99'}});sockets.push(socket)
      await once(socket,'open')
      assert.equal((await request(socket,'hello',{...peer,capabilities:CAPABILITIES,ipAddress:'203.0.113.88'})).ok,true)
      assert.equal((await request(socket,'principal.register',{localId:'user',kind:'human',displayName:'Same name'})).ok,true)
    }
    const directory=(await request(sockets[0],'contacts.list',{})).value
    assert.equal(directory.length,2)
    assert.ok(directory.every(person=>person.ipAddress==='127.0.0.1'))
    assert.deepEqual(directory.map(person=>person.homeInstanceId),['a','b'])
    assert.equal((await request(sockets[1],'principal.rename',{principalId:'human:a:user',displayName:'Spoof'})).error.code,'AUTHOR_MISMATCH')
  }finally{for(const socket of sockets)socket.terminate();await hub.close()}
})
