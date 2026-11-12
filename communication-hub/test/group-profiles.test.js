import assert from 'node:assert/strict'
import {test} from 'node:test'
import {randomUUID} from 'node:crypto'
import {mkdtempSync,rmSync} from 'node:fs'
import {join} from 'node:path'
import {tmpdir} from 'node:os'
import {ScopedStore} from './fixtures/scoped-store.mjs'
import {CAPABILITIES} from '../src/protocol.js'
import {avatarRevision} from '../src/avatars.js'
const image='data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jG0cAAAAASUVORK5CYII='
function fixture(t){
 const dir=mkdtempSync(join(tmpdir(),'group-profiles-')),path=join(dir,'hub.sqlite')
 const f={store:new ScopedStore(path)};t.after(()=>{f.store.close();rmSync(dir,{recursive:true,force:true})})
 const s=f.store;f.a=s.connect('a','A',CAPABILITIES);f.b=s.connect('b','B',CAPABILITIES)
 f.owner=s.register(f.a,{localId:'owner',kind:'human',displayName:'Owner'}).principalId
 f.admin=s.register(f.b,{localId:'owner',kind:'human',displayName:'Remote'}).principalId
 f.bot=s.register(f.b,{localId:'bot',kind:'bot',displayName:'Worker'}).principalId
 f.create=()=>s.createGroup(f.a,{principalId:f.owner,title:'Group',operationId:randomUUID()}).conversationId
 f.group=f.create()
 f.join=(group,id,auth)=>{const inv=s.invite(f.a,{conversationId:group,principalId:f.owner,inviteePrincipalId:id,operationId:randomUUID()});s.accept(auth,{principalId:id,inviteId:inv.inviteId,operationId:randomUUID()})}
 f.join(f.group,f.admin,f.b);f.join(f.group,f.bot,f.b)
 f.input=(extra={},id=f.owner,group=f.group)=>{const m=f.store.db.prepare('SELECT epoch FROM memberships WHERE conversation_id=? AND principal_id=?').get(group,id);return {conversationId:group,principalId:id,membershipEpoch:m?.epoch,expectedVersion:f.store.db.prepare('SELECT version FROM conversations WHERE id=?').get(group).version,operationId:randomUUID(),...extra}}
 f.reopen=()=>{f.store.close();f.store=new ScopedStore(path)}
 return f
}
test('group avatars enforce manager/version checks, survive restart, invalidate readers and restore defaults',t=>{
 const f=fixture(t),s=f.store
 assert.throws(()=>s.setGroupAvatar(f.b,f.input({image},f.bot)),{code:'FORBIDDEN'})
 const input=f.input({image}),result=s.setGroupAvatar(f.a,input)
 assert.deepEqual(s.setGroupAvatar(f.a,input),result)
 assert.equal(result.avatar.imageRevision,avatarRevision(image))
 assert.throws(()=>s.setGroupAvatar(f.a,{...input,operationId:randomUUID()}),{code:'GROUP_VERSION_CONFLICT'})
 assert.equal(s.members(f.b,f.input({},f.bot)).avatar.imageRevision,result.avatar.imageRevision)
 assert.equal(s.readGroupAvatar(f.b,f.input({revision:result.avatar.imageRevision},f.bot)).image,image)
 assert.throws(()=>s.setGroupAvatar(f.a,f.input({image:'data:image/svg+xml;base64,PHN2Zz4='})),{code:'INVALID_AVATAR_IMAGE'})
 assert.throws(()=>s.setGroupAvatar(f.a,f.input({image:'x'.repeat(32769)})),{code:'INVALID_AVATAR_IMAGE'})
 f.reopen();assert.equal(f.store.readGroupAvatar(f.b,f.input({revision:result.avatar.imageRevision},f.bot)).image,image)
 f.store.setGroupAvatar(f.a,f.input({image:null}))
 assert.equal(f.store.members(f.a,f.input()).avatar.imageRevision,null)
 assert.throws(()=>f.store.readGroupAvatar(f.b,f.input({revision:result.avatar.imageRevision},f.bot)),{code:'AVATAR_NOT_FOUND'})
})
test('group identities are independent per group, readable by Bots, editable by admins and never permission grants',t=>{
 const f=fixture(t),s=f.store,second=f.create();f.join(second,f.admin,f.b);f.join(second,f.bot,f.b)
 const update=(title,group=f.group,actor=f.owner,auth=f.a)=>s.setGroupIdentity(auth,f.input({targetPrincipalId:f.bot,identity:title+'\nCollect progress'},actor,group))
 assert.throws(()=>update('Owner',f.group,f.bot,f.b),{code:'FORBIDDEN'})
 update('Leader');update('Developer',second)
 const read=group=>s.readGroupIdentity(f.b,f.input({targetPrincipalId:f.bot},f.bot,group)).identity
 assert.equal(read(f.group),'Leader\nCollect progress');assert.equal(read(second),'Developer\nCollect progress')
 const member=s.members(f.b,f.input({},f.bot)).members.find(p=>p.principalId===f.bot)
 assert.equal(member.groupIdentity,'Leader\nCollect progress');assert.equal(member.role,'member');assert.equal(member.displayName,'Worker')
 assert.equal(s.publicProfileOf(f.bot).headline,'')
 s.policy(f.a,f.input({targetPrincipalId:f.admin,role:'admin'}))
 update('QA',f.group,f.admin,f.b);assert.equal(read(f.group),'QA\nCollect progress')
 assert.throws(()=>s.setGroupIdentity(f.a,f.input({targetPrincipalId:f.bot,identity:'x'.repeat(4001)})),{code:'INVALID_GROUP_IDENTITY'})
 assert.throws(()=>s.setGroupIdentity(f.a,f.input({targetPrincipalId:f.bot,identity:{description:'Not a string'}})),{code:'INVALID_GROUP_IDENTITY'})
 const old=f.input({targetPrincipalId:f.bot},f.bot)
 s.remove(f.a,f.input({targetPrincipalId:f.bot}));assert.throws(()=>s.readGroupIdentity(f.b,old),{code:'NOT_A_MEMBER'})
 f.join(f.group,f.bot,f.b);assert.equal(read(f.group),'')
 assert.equal(read(second),'Developer\nCollect progress')
 f.reopen();assert.equal(f.store.readGroupIdentity(f.b,f.input({targetPrincipalId:f.bot},f.bot,second)).identity,'Developer\nCollect progress')
})

test('large multiline identities use marked summaries in bounded member lists and remain fully readable only to members',t=>{
 const f=fixture(t),s=f.store,identity='职责说明\n'+ '协作'.repeat(1997)
 for(const targetPrincipalId of [f.owner,f.admin,f.bot])s.setGroupIdentity(f.a,f.input({targetPrincipalId,identity}))
 s.limits.maxEnvelopeBytes=24000
 const info=s.members(f.b,f.input({},f.bot)),person=info.members.find(p=>p.principalId===f.bot)
 assert.equal(person.groupIdentityTruncated,true)
 assert.ok(person.groupIdentity.length<identity.length)
 assert.ok(Buffer.byteLength(JSON.stringify(info))<24000)
 assert.equal(s.readGroupIdentity(f.b,f.input({targetPrincipalId:f.owner},f.bot)).identity,identity)
 const outsiderGroup=f.create()
 assert.throws(()=>s.readGroupIdentity(f.b,{conversationId:outsiderGroup,principalId:f.bot,targetPrincipalId:f.owner,membershipEpoch:'not-a-member'}),{code:'NOT_A_MEMBER'})
})
