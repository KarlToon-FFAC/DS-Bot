import assert from 'node:assert/strict'
import {test} from 'node:test'
import {createHash,randomUUID} from 'node:crypto'
import {CommunicationQueue} from '../src/host/federation/queue-store.js'
import {normalizeAttachments,MAX_ATTACHMENT_BYTES} from '../src/shared/communication-attachments.js'

export const file=(data=Buffer.from('synthetic file'),name='note.txt',mime='text/plain')=>({name,mime,size:data.length,sha256:createHash('sha256').update(data).digest('hex'),data:data.toString('base64')})
test('bounded attachment descriptors preserve bytes and reject path, markup image, digest and aggregate violations',()=>{
 const one=file();assert.deepEqual(normalizeAttachments([one]),[one])
 for(const value of [{...one,name:'../secret'},{...one,data:'AAAA'},{...one,sha256:'0'.repeat(64)},{...one,url:'https://bad.invalid'},file(Buffer.from('<svg/>'),'x.svg','image/svg+xml')])assert.throws(()=>normalizeAttachments([value]))
 const full=file(Buffer.alloc(MAX_ATTACHMENT_BYTES));assert.equal(normalizeAttachments([full])[0].size,MAX_ATTACHMENT_BYTES)
 assert.throws(()=>normalizeAttachments([full,one]),{code:'ATTACHMENT_TOO_LARGE'})
 assert.throws(()=>normalizeAttachments(Array(5).fill(one)),{code:'INVALID_ATTACHMENT'})
 const png=Buffer.alloc(24);Buffer.from([137,80,78,71,13,10,26,10]).copy(png);png.writeUInt32BE(9000,16);png.writeUInt32BE(9000,20)
 assert.throws(()=>normalizeAttachments([file(png,'bomb.png','image/png')]),{code:'INVALID_ATTACHMENT_IMAGE'})
})
test('offline queue retains attachments atomically with stable message identity and rejects changed retry bytes',t=>{
 const queue=new CommunicationQueue(':memory:',{instanceId:'a'});t.after(()=>queue.close())
 const human=queue.localPrincipal('human','owner','Owner')
 const payload={protocol:'dsbot-communication/1',type:'message.publish',messageId:randomUUID(),conversationId:'group',author:{...human,homeInstanceId:'a',kind:'human'},content:{format:'markdown',text:''},attachments:[file()],mentions:[],replyToMessageId:null,clientCreatedAt:new Date().toISOString()}
 queue.enqueueMessage(payload);queue.enqueueMessage(payload)
 assert.deepEqual(queue.pendingOutbox()[0].payload.attachments,payload.attachments)
 assert.throws(()=>queue.enqueueMessage({...payload,attachments:[file(Buffer.from('changed'))]}),{code:'MESSAGE_ID_CONFLICT'})
})
