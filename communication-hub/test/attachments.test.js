import assert from 'node:assert/strict'
import {test} from 'node:test'
import {randomUUID,createHash} from 'node:crypto'
import {readFileSync} from 'node:fs'
import {HubStore} from '../src/store.js'
import {HUB_CAPABILITIES,PROTOCOL} from '../src/protocol.js'
const binary=(data=Buffer.from('private synthetic document'))=>({name:'report.txt',mime:'text/plain',size:data.length,data:data.toString('base64'),sha256:createHash('sha256').update(data).digest('hex')})
test('standalone Hub and packaged plugin have identical bounded attachment validators',()=>{
 assert.equal(readFileSync(new URL('../src/attachments.js',import.meta.url),'utf8'),readFileSync(new URL('../../ds-bot/src/shared/communication-attachments.js',import.meta.url),'utf8'))
})
test('attachment publication preserves exact idempotency and membership authorization, rejects legacy peers and malformed bytes',t=>{
 const store=new HubStore(':memory:');t.after(()=>store.close())
 const a=store.connect('a','A',HUB_CAPABILITIES),b=store.connect('b','B',HUB_CAPABILITIES),c=store.connect('c','C',HUB_CAPABILITIES)
 const principal=(auth,id)=>store.register(auth,{localId:id,kind:'human',displayName:id}).principalId
 const A=principal(a,'A'),B=principal(b,'B'),C=principal(c,'C')
 const group=store.createGroup(a,{principalId:A,title:'Synthetic files',operationId:randomUUID()}).conversationId
 const owner=()=>store.memberships(a).memberships.find(m=>m.conversationId===group)
 const invitation=store.invite(a,{principalId:A,conversationId:group,membershipEpoch:owner().membershipEpoch,inviteePrincipalId:B,operationId:randomUUID()})
 store.accept(b,{principalId:B,inviteId:invitation.inviteId,operationId:randomUUID()})
 const member=store.memberships(b).memberships.find(m=>m.conversationId===group)
 const message={protocol:PROTOCOL,type:'message.publish',messageId:randomUUID(),conversationId:group,author:{principalId:A,kind:'human',homeInstanceId:'a'},content:{format:'markdown',text:''},attachments:[binary()],mentions:[],replyToMessageId:null,clientCreatedAt:new Date().toISOString(),membershipEpoch:owner().membershipEpoch}
 const accepted=store.publish(a,message);assert.deepEqual(store.publish(a,message),accepted)
 const history=store.sync(b,{principalId:B,conversationId:group,membershipEpoch:member.membershipEpoch,after:0})
 assert.deepEqual(history.events.find(e=>e.message?.messageId===message.messageId).message.attachments,message.attachments)
 assert.throws(()=>store.sync(c,{principalId:C,conversationId:group,after:0}),{code:'NOT_A_MEMBER'})
 assert.throws(()=>store.publish(a,{...message,attachments:[binary(Buffer.from('changed'))]}),{code:'MESSAGE_ID_CONFLICT'})
 assert.throws(()=>store.publish(a,{...message,messageId:randomUUID(),attachments:[{...binary(),sha256:'0'.repeat(64)}]}),{code:'ATTACHMENT_INTEGRITY_FAILED'})
 assert.throws(()=>store.publish(b,{...message,messageId:randomUUID(),author:{principalId:B,kind:'human',homeInstanceId:'b'},membershipEpoch:member.membershipEpoch}),{code:'SPEAKING_FORBIDDEN'})
 assert.throws(()=>store.connect('b','B',HUB_CAPABILITIES.filter(v=>v!=='inline-attachments-v1')),{code:'ATTACHMENT_CAPABILITY_REQUIRED'})
 store.remove(a,{principalId:A,conversationId:group,membershipEpoch:owner().membershipEpoch,targetPrincipalId:B,operationId:randomUUID()})
 assert.throws(()=>store.sync(b,{principalId:B,conversationId:group,membershipEpoch:member.membershipEpoch,after:0}),{code:'NOT_A_MEMBER'})
})
test('new sender explicitly refuses attachments to an old recipient; text remains usable',t=>{
 const store=new HubStore(':memory:');t.after(()=>store.close())
 const a=store.connect('a','A',HUB_CAPABILITIES),b=store.connect('b','B',HUB_CAPABILITIES.filter(v=>v!=='inline-attachments-v1'))
 const A=store.register(a,{localId:'A',kind:'human',displayName:'A'}).principalId,B=store.register(b,{localId:'B',kind:'human',displayName:'B'}).principalId
 const dm=store.createDm(a,{principalId:A,otherPrincipalId:B,operationId:randomUUID()}).conversationId
 const epoch=store.memberships(a).memberships.find(m=>m.conversationId===dm).membershipEpoch
 const input={protocol:PROTOCOL,type:'message.publish',messageId:randomUUID(),conversationId:dm,author:{principalId:A,kind:'human',homeInstanceId:'a'},content:{format:'markdown',text:'text works'},attachments:[binary()],mentions:[],replyToMessageId:null,clientCreatedAt:new Date().toISOString(),membershipEpoch:epoch}
 assert.throws(()=>store.publish(a,input),{code:'ATTACHMENT_CAPABILITY_REQUIRED'})
 delete input.attachments;assert.equal(store.publish(a,input).status,'hubAccepted')
})
