import { writeFileSync } from 'node:fs'
import { CommunicationQueue } from '../../src/host/federation/queue-store.js'

const [path,marker,point,messageId]=process.argv.slice(2)
const queue=new CommunicationQueue(path,{instanceId:'atomic'})
const output={sourceKey:'durable-assistant-event',conversationId:'conversation',parts:[{part:0,text:'whole final response'}]}
const makeMessage=()=>({protocol:'dsbot-communication/1',type:'message.publish',messageId,conversationId:'conversation',
  author:{principalId:'bot:atomic:recipient',homeInstanceId:'atomic',kind:'bot'},clientCreatedAt:'2026-11-03T00:00:00.000Z',
  content:{format:'markdown',text:'whole final response'},mentions:[],replyToMessageId:null})
const block=()=>{writeFileSync(marker,JSON.stringify({point,messageId}));Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0)}
if(point==='before-commit')queue.beforeCommit=block
queue.commitExports('binding',[output],[{sessionId:'retained-session',seq:7}],makeMessage)
if(point==='after-commit')block()
throw new Error('Fault fixture unexpectedly returned')
