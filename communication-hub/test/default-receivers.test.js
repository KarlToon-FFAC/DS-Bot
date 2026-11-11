import assert from 'node:assert/strict'
import {test} from 'node:test'
import {randomUUID} from 'node:crypto'
import {mkdtempSync,rmSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {HubStore} from '../src/store.js'
import {CAPABILITIES,PROTOCOL} from '../src/protocol.js'

const op=input=>({operationId:randomUUID(),...input})
function fixture(t,path=':memory:'){
 const f={store:new HubStore(path)}
 t.after(()=>f.store.close())
 f.a=f.store.connect('a','A',CAPABILITIES);f.b=f.store.connect('b','B',CAPABILITIES)
 f.H=f.store.register(f.a,{localId:'human',kind:'human',displayName:'Owner A'}).principalId
 f.J=f.store.register(f.b,{localId:'human',kind:'human',displayName:'Owner B'}).principalId
 for(const [key,auth] of [['A',f.a],['B',f.b],['C',f.a]])f[key]=f.store.register(auth,{localId:key,kind:'bot',displayName:key}).principalId
 f.group=f.store.createGroup(f.a,op({principalId:f.H,title:'Multiple defaults'})).conversationId
 f.auth=id=>id.split(':')[1]==='a'?f.a:f.b
 f.member=id=>f.store.memberships(f.auth(id)).memberships.find(m=>m.conversationId===f.group&&m.principalId===id)
 f.join=id=>{const invite=f.store.invite(f.a,op({principalId:f.H,conversationId:f.group,membershipEpoch:f.member(f.H).membershipEpoch,inviteePrincipalId:id}));f.store.accept(f.auth(id),op({principalId:id,inviteId:invite.inviteId}))}
 for(const id of [f.A,f.B,f.C])f.join(id)
 f.input=extra=>op({principalId:f.H,conversationId:f.group,membershipEpoch:f.member(f.H).membershipEpoch,expectedVersion:f.member(f.H).membershipVersion,...extra})
 f.route=ids=>f.store.routing(f.a,f.input({mode:'admin',defaultBotPrincipalIds:ids}))
 f.defaults=()=>f.member(f.H).defaultBotPrincipalIds
 f.send=(id,extra={})=>f.store.publish(f.auth(id),{protocol:PROTOCOL,type:'message.publish',messageId:randomUUID(),conversationId:f.group,
  author:{principalId:id,homeInstanceId:id.split(':')[1],kind:id.split(':')[0]},membershipEpoch:f.member(id).membershipEpoch,clientCreatedAt:new Date().toISOString(),content:{format:'text',text:'Default receiver probe'},mentions:[],replyToMessageId:null,...extra,...(id.startsWith('bot:')?{activationTargets:extra.activationTargets??[]}: {})})
 f.ai=sent=>f.store.db.prepare('SELECT recipient_id FROM deliveries WHERE message_id=? AND ai=1 ORDER BY recipient_id').all(sent.messageId).map(r=>r.recipient_id)
 return f
}

test('all selected passive Bots receive a plain Human message, with mentions/replies overriding defaults and no answer storm',t=>{
 const f=fixture(t),earlier=f.send(f.H);assert.deepEqual(f.ai(earlier),[])
 f.route([f.B,f.A,f.A]);assert.deepEqual(f.ai(earlier),[],'changing defaults never reactivates history')
 assert.deepEqual(f.defaults(),[f.A,f.B])
 assert.deepEqual(f.store.members(f.b,{conversationId:f.group,principalId:f.B,membershipEpoch:f.member(f.B).membershipEpoch}).defaultBotPrincipalIds,[f.A,f.B])
 const message=f.send(f.H);assert.deepEqual(f.ai(message),[f.A,f.B])
 for(const bot of [f.A,f.B]){
  const grant=f.store.pending(f.auth(bot)).find(d=>d.messageId===message.messageId&&d.recipientPrincipalId===bot)
  f.store.receipt(f.auth(bot),{deliveryId:grant.deliveryId,principalId:bot,membershipEpoch:grant.membershipEpoch,status:'targetStored'})
  const reply=f.send(bot,{replyToMessageId:message.messageId,responseToDeliveryId:grant.deliveryId})
  assert.deepEqual(f.ai(reply),[])
  if(bot===f.A)assert.deepEqual(f.ai(f.send(f.H,{replyToMessageId:reply.messageId})),[f.A])
 }
 assert.deepEqual(f.ai(f.send(f.H,{mentions:[{principalId:f.C}]})),[f.C])
 f.store.routing(f.a,f.input({mode:'mentionsOnly',defaultBotPrincipalIds:[]}))
 assert.deepEqual(f.ai(f.send(f.H)),[])
})

test('invalid multi-selection and stale/unauthorized atomic edits roll back title, policy, routing and version',t=>{
 const f=fixture(t);f.route([f.A,f.B]);const version=f.member(f.H).membershipVersion
 for(const ids of [[],[f.A,'bot:missing:unknown'],[f.A,f.H],Array(65).fill(f.A),[f.A,{}]]){
  assert.throws(()=>f.store.settings(f.a,f.input({title:'Must not save',routing:{mode:'admin',defaultBotPrincipalIds:ids},policies:[{targetPrincipalId:f.A,speakingMode:'active'}]})))
  assert.deepEqual(f.defaults(),[f.A,f.B]);assert.equal(f.member(f.H).title,'Multiple defaults');assert.equal(f.member(f.H).membershipVersion,version);assert.equal(f.member(f.A).speakingMode,'passive')
 }
 assert.throws(()=>f.store.routing(f.b,op({principalId:f.J,conversationId:f.group,membershipEpoch:f.member(f.J).membershipEpoch,mode:'admin',defaultBotPrincipalIds:[f.B]})),{code:'FORBIDDEN'})
 const stale=f.input({routing:{mode:'admin',defaultBotPrincipalIds:[f.A,f.C]}})
 f.route([f.B,f.C]);assert.throws(()=>f.store.settings(f.a,stale),{code:'GROUP_VERSION_CONFLICT'})
 assert.deepEqual(f.defaults(),[f.B,f.C].sort())
 const save=f.input({title:'Saved atomically',routing:{mode:'admin',defaultBotPrincipalIds:[f.A,f.C]},policies:[{targetPrincipalId:f.C,speakingMode:'active'}]})
 const result=f.store.settings(f.a,save);assert.deepEqual(f.store.settings(f.a,save),result)
 assert.deepEqual(f.defaults(),[f.A,f.C]);assert.equal(f.member(f.H).membershipVersion,save.expectedVersion+1)
})

test('leaving, retirement, owner removal and trust revocation prune only affected defaults without reviving a rejoined identity',t=>{
 for(const action of ['leave','retire','remove-owner','revoke']){
  const f=fixture(t);f.route([f.A,f.B])
  if(action==='leave')f.store.remove(f.b,op({principalId:f.B,targetPrincipalId:f.B,conversationId:f.group,membershipEpoch:f.member(f.B).membershipEpoch}))
  if(action==='retire')f.store.syncPublication(f.b,{principalIds:[]})
  if(action==='remove-owner')f.store.remove(f.a,f.input({targetPrincipalId:f.J}))
  if(action==='revoke')f.store.revokeInstance('b')
  assert.deepEqual(f.defaults(),[f.A],action);assert.equal(f.member(f.H).routingMode,'admin')
  if(action==='leave'){f.join(f.B);assert.deepEqual(f.defaults(),[f.A])}
  f.store.remove(f.a,f.input({targetPrincipalId:f.A}));assert.deepEqual(f.defaults(),[]);assert.equal(f.member(f.H).routingMode,'mentionsOnly')
 }
})

test('legacy singleton and multiple defaults survive database reopen without a destructive migration',t=>{
 const dir=mkdtempSync(join(tmpdir(),'hub-default-bots-'))
 const f=fixture(t,join(dir,'hub.sqlite'));t.after(()=>rmSync(dir,{recursive:true,force:true}))
 f.store.routing(f.a,f.input({mode:'admin',adminBotPrincipalId:f.B}))
 // Model an existing v6 database before the additive column was introduced.
 f.store.db.exec('ALTER TABLE conversations DROP COLUMN default_bots');f.store.close();f.store=new HubStore(join(dir,'hub.sqlite'))
 assert.deepEqual(f.defaults(),[f.B])
 f.route([f.A,f.B]);f.store.close();f.store=new HubStore(join(dir,'hub.sqlite'))
 assert.deepEqual(f.defaults(),[f.A,f.B])
 f.store.dissolve(f.a,f.input({}));assert.deepEqual(f.defaults(),[])
})
